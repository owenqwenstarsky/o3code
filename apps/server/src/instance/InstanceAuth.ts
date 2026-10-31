import { AuthSessionId } from "@t3tools/contracts";
import {
  INSTANCE_SESSION_TOKEN_PREFIX,
  INSTANCE_WORKSPACE_TOKEN_PREFIX,
  InstanceForbiddenError,
  type InstanceIntrospectResult,
  InstanceRateLimitedError,
  type InstanceSessionInfo,
  InstanceUnauthorizedError,
  type InstanceUser,
  type InstanceUserId,
  type InstanceClientKind,
} from "@t3tools/contracts/instance";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

import * as SessionStore from "../auth/SessionStore.ts";
import { deriveAuthClientMetadata } from "../auth/utils.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import { InstanceSettings } from "./InstanceSettings.ts";
import { InstanceStore, type InstanceStoreError, type UserRecord } from "./InstanceStore.ts";
import { STATIC_WORKSPACE_USER } from "./WorkspaceRuntime.ts";
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from "./Passwords.ts";

const USER_SUBJECT_PREFIX = "o3-user:";
const WORKSPACE_SUBJECT_PREFIX = "o3-ws:";
const WORKSPACE_TOKEN_TTL = Duration.days(7);

// Failed logins per window before refusing: per email (targeted guessing) and per IP (spraying).
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_EMAIL = 10;
const MAX_FAILURES_PER_IP = 50;

const userSubject = (userId: string) => `${USER_SUBJECT_PREFIX}${userId}`;
const workspaceSubject = (userId: string, parentSessionId: string) =>
  `${WORKSPACE_SUBJECT_PREFIX}${userId}:${parentSessionId}`;

const parseWorkspaceSubject = (subject: string) => {
  if (!subject.startsWith(WORKSPACE_SUBJECT_PREFIX)) return null;
  const [userId, parentSessionId] = subject.slice(WORKSPACE_SUBJECT_PREFIX.length).split(":");
  return userId && parentSessionId ? { userId, parentSessionId } : null;
};

const belongsToUser = (subject: string, userId: string) =>
  subject === userSubject(userId) || subject.startsWith(`${WORKSPACE_SUBJECT_PREFIX}${userId}:`);

export const toInstanceUser = (record: UserRecord): InstanceUser => ({
  id: record.userId,
  email: record.email,
  name: record.name,
  role: record.role,
  disabled: record.disabledAt !== null,
  mustChangePassword: record.mustChangePassword,
  createdAt: record.createdAt,
  lastLoginAt: record.lastLoginAt,
});

const unauthorized = (reason: InstanceUnauthorizedError["reason"], message: string) =>
  new InstanceUnauthorizedError({ reason, message });

export interface InstancePrincipalValue {
  readonly user: InstanceUser;
  readonly sessionId: string;
}

export class InstanceAuth extends Context.Service<
  InstanceAuth,
  {
    readonly login: (input: {
      readonly email: string;
      readonly password: string;
      readonly clientKind: InstanceClientKind;
      readonly deviceLabel: string | undefined;
      readonly request: HttpServerRequest.HttpServerRequest;
    }) => Effect.Effect<
      { readonly sessionToken: string; readonly expiresAt: string; readonly user: InstanceUser },
      InstanceUnauthorizedError | InstanceRateLimitedError | InstanceStoreError
    >;
    readonly authenticate: (
      authorization: string | undefined,
    ) => Effect.Effect<InstancePrincipalValue, InstanceUnauthorizedError | InstanceStoreError>;
    readonly logout: (sessionId: string, userId: string) => Effect.Effect<void>;
    readonly changePassword: (input: {
      readonly principal: InstancePrincipalValue;
      readonly currentPassword: string;
      readonly newPassword: string;
      readonly ipAddress: string | null;
    }) => Effect.Effect<
      InstanceUser,
      InstanceUnauthorizedError | InstanceRateLimitedError | InstanceStoreError
    >;
    readonly listSessions: (
      userId: string,
      currentSessionId: string | null,
    ) => Effect.Effect<ReadonlyArray<InstanceSessionInfo>>;
    /** Revokes one of the user's sessions and the workspace tokens minted from it. */
    readonly revokeSession: (userId: string, sessionId: string) => Effect.Effect<boolean>;
    readonly revokeAllForUser: (userId: string) => Effect.Effect<void>;
    readonly issueWorkspaceToken: (
      principal: InstancePrincipalValue,
    ) => Effect.Effect<
      { readonly token: string; readonly expiresAt: string },
      InstanceForbiddenError | InstanceUnauthorizedError
    >;
    readonly introspect: (input: {
      readonly token: string;
      readonly workspaceUserId: InstanceUserId;
    }) => Effect.Effect<InstanceIntrospectResult, InstanceStoreError>;
  }
>()("t3/instance/InstanceAuth") {}

const make = Effect.gen(function* () {
  const store = yield* InstanceStore;
  const sessions = yield* SessionStore.SessionStore;
  const authSessions = yield* AuthSessions.AuthSessionRepository;
  const settings = yield* InstanceSettings;
  const failures = yield* Ref.make(new Map<string, ReadonlyArray<number>>());

  const recentFailures = (key: string, now: number) =>
    Ref.get(failures).pipe(
      Effect.map((map) => (map.get(key) ?? []).filter((at) => now - at < LOGIN_WINDOW_MS)),
    );

  const recordFailure = (keys: ReadonlyArray<string>, now: number) =>
    Ref.update(failures, (current) => {
      const next = new Map(current);
      for (const key of keys) {
        next.set(key, [...(next.get(key) ?? []).filter((at) => now - at < LOGIN_WINDOW_MS), now]);
      }
      // Bound memory under a spray of distinct emails.
      if (next.size > 10_000) {
        for (const [key, times] of next) {
          if (times.every((at) => now - at >= LOGIN_WINDOW_MS)) next.delete(key);
        }
      }
      return next;
    });

  const assertNotRateLimited = Effect.fn("InstanceAuth.assertNotRateLimited")(function* (
    emailKey: string,
    ipKey: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const byEmail = yield* recentFailures(emailKey, now);
    const byIp = yield* recentFailures(ipKey, now);
    const limited =
      byEmail.length >= MAX_FAILURES_PER_EMAIL
        ? byEmail
        : byIp.length >= MAX_FAILURES_PER_IP
          ? byIp
          : null;
    if (limited === null) return;
    const oldest = Math.min(...limited);
    return yield* new InstanceRateLimitedError({
      message: "Too many failed sign-in attempts. Try again later.",
      retryAfterSeconds: Math.max(1, Math.ceil((oldest + LOGIN_WINDOW_MS - now) / 1000)),
    });
  });

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const revokeMatching = (
    predicate: (session: { readonly subject: string; readonly sessionId: string }) => boolean,
  ) =>
    sessions.listActive().pipe(
      Effect.flatMap((active) =>
        Effect.forEach(active.filter(predicate), (session) => sessions.revoke(session.sessionId), {
          discard: true,
        }),
      ),
      Effect.catch((cause) => Effect.logError("Failed to revoke instance sessions.", { cause })),
    );

  const login: InstanceAuth["Service"]["login"] = Effect.fn("InstanceAuth.login")(
    function* (input) {
      const client = deriveAuthClientMetadata({
        request: input.request,
        presented: {
          ...(input.deviceLabel ? { label: input.deviceLabel } : {}),
          deviceType: input.clientKind === "cli" ? "bot" : "desktop",
        },
      });
      const emailKey = `email:${input.email.trim().toLowerCase()}`;
      const ipKey = `ip:${client.ipAddress ?? "unknown"}`;
      yield* assertNotRateLimited(emailKey, ipKey);

      const record = yield* store.findUserByEmail(input.email);
      const valid = yield* verifyPassword(
        input.password,
        Option.match(record, {
          onNone: () => DUMMY_PASSWORD_HASH,
          onSome: (user) => user.passwordHash,
        }),
      );
      if (Option.isNone(record) || !valid) {
        yield* recordFailure([emailKey, ipKey], yield* Clock.currentTimeMillis);
        yield* settings.audit({
          actorUserId: Option.isSome(record) ? record.value.userId : null,
          actorEmail: input.email,
          action: "auth.login_failed",
          ipAddress: client.ipAddress ?? null,
        });
        return yield* unauthorized("invalid_credentials", "Incorrect email or password.");
      }
      const user = record.value;
      if (user.disabledAt !== null) {
        return yield* unauthorized("account_disabled", "This account is disabled.");
      }

      const instanceSettings = yield* settings.get;
      const issued = yield* sessions
        .issue({
          subject: userSubject(user.userId),
          method: "bearer-access-token",
          scopes: [],
          ttl: Duration.days(instanceSettings.sessionTtlDays),
          client,
        })
        .pipe(Effect.orDie);
      const now = yield* nowIso;
      yield* store.updateUser(user.userId, { lastLoginAt: now }, now);
      yield* settings.audit({
        actorUserId: user.userId,
        actorEmail: user.email,
        action: "auth.login",
        detail: input.clientKind,
        ipAddress: client.ipAddress ?? null,
      });
      return {
        sessionToken: `${INSTANCE_SESSION_TOKEN_PREFIX}${issued.token}`,
        expiresAt: DateTime.formatIso(issued.expiresAt),
        user: toInstanceUser({ ...user, lastLoginAt: now }),
      };
    },
  );

  const authenticate: InstanceAuth["Service"]["authenticate"] = Effect.fn(
    "InstanceAuth.authenticate",
  )(function* (authorization) {
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";
    if (!token.startsWith(INSTANCE_SESSION_TOKEN_PREFIX)) {
      return yield* unauthorized("missing_credentials", "Sign in to continue.");
    }
    const verified = yield* sessions
      .verify(token.slice(INSTANCE_SESSION_TOKEN_PREFIX.length))
      .pipe(
        Effect.mapError(() =>
          unauthorized("session_expired", "Your session has ended. Sign in again."),
        ),
      );
    if (!verified.subject.startsWith(USER_SUBJECT_PREFIX)) {
      return yield* unauthorized("invalid_credentials", "This token is not an instance session.");
    }
    const record = yield* store.getUser(verified.subject.slice(USER_SUBJECT_PREFIX.length));
    if (Option.isNone(record)) {
      return yield* unauthorized("session_expired", "Your session has ended. Sign in again.");
    }
    if (record.value.disabledAt !== null) {
      return yield* unauthorized("account_disabled", "This account is disabled.");
    }
    return { user: toInstanceUser(record.value), sessionId: verified.sessionId };
  });

  const revokeSession: InstanceAuth["Service"]["revokeSession"] = (userId, sessionId) =>
    sessions.listActive().pipe(
      Effect.flatMap((active) => {
        const target = active.find(
          (session) => session.sessionId === sessionId && session.subject === userSubject(userId),
        );
        if (target === undefined) return Effect.succeed(false);
        return sessions
          .revoke(target.sessionId)
          .pipe(
            Effect.andThen(
              revokeMatching(({ subject }) => subject === workspaceSubject(userId, sessionId)),
            ),
            Effect.as(true),
          );
      }),
      Effect.catch((cause) =>
        Effect.logError("Failed to revoke instance session.", { cause }).pipe(Effect.as(false)),
      ),
    );

  return InstanceAuth.of({
    login,
    authenticate,
    logout: Effect.fn("InstanceAuth.logout")((sessionId, userId) =>
      revokeSession(userId, sessionId).pipe(Effect.asVoid),
    ),
    changePassword: Effect.fn("InstanceAuth.changePassword")(function* (input) {
      const emailKey = `email:${input.principal.user.email.toLowerCase()}`;
      const ipKey = `ip:${input.ipAddress ?? "unknown"}`;
      yield* assertNotRateLimited(emailKey, ipKey);
      const record = yield* store.getUser(input.principal.user.id);
      if (Option.isNone(record)) {
        return yield* unauthorized("session_expired", "Your session has ended. Sign in again.");
      }
      if (!(yield* verifyPassword(input.currentPassword, record.value.passwordHash))) {
        yield* recordFailure([emailKey, ipKey], yield* Clock.currentTimeMillis);
        return yield* unauthorized("invalid_credentials", "Your current password is incorrect.");
      }
      const now = yield* nowIso;
      const passwordHash = yield* hashPassword(input.newPassword).pipe(Effect.orDie);
      yield* store.updateUser(
        record.value.userId,
        { passwordHash, mustChangePassword: false },
        now,
      );
      // Other devices must sign in with the new password.
      const userId = record.value.userId;
      const currentSessionId = input.principal.sessionId;
      yield* revokeMatching(
        ({ subject, sessionId }) =>
          belongsToUser(subject, userId) &&
          sessionId !== currentSessionId &&
          subject !== workspaceSubject(userId, currentSessionId),
      );
      yield* settings.audit({
        actorUserId: record.value.userId,
        actorEmail: record.value.email,
        action: "auth.password_changed",
        ipAddress: input.ipAddress,
      });
      return toInstanceUser({
        ...record.value,
        passwordHash,
        mustChangePassword: false,
        updatedAt: now,
      });
    }),
    listSessions: Effect.fn("InstanceAuth.listSessions")((userId, currentSessionId) =>
      sessions.listActive().pipe(
        Effect.map((active) =>
          active
            .filter((session) => session.subject === userSubject(userId))
            .map((session): InstanceSessionInfo => ({
              id: session.sessionId,
              label: session.client.label ?? null,
              deviceType: session.client.deviceType,
              os: session.client.os ?? null,
              browser: session.client.browser ?? null,
              ipAddress: session.client.ipAddress ?? null,
              issuedAt: DateTime.formatIso(session.issuedAt),
              expiresAt: DateTime.formatIso(session.expiresAt),
              current: session.sessionId === currentSessionId,
            })),
        ),
        Effect.orElseSucceed(() => []),
      ),
    ),
    revokeSession,
    revokeAllForUser: Effect.fn("InstanceAuth.revokeAllForUser")((userId) =>
      revokeMatching(({ subject }) => belongsToUser(subject, userId)),
    ),
    issueWorkspaceToken: Effect.fn("InstanceAuth.issueWorkspaceToken")(function* (principal) {
      if (principal.user.mustChangePassword) {
        return yield* new InstanceForbiddenError({
          message: "Change your password before opening your workspace.",
        });
      }
      const parent = yield* authSessions
        .getById({ sessionId: AuthSessionId.make(principal.sessionId) })
        .pipe(Effect.orDie);
      if (Option.isNone(parent) || parent.value.revokedAt !== null) {
        return yield* unauthorized("session_expired", "Your session has ended. Sign in again.");
      }
      const now = yield* DateTime.now;
      const parentRemaining = Duration.millis(
        Math.max(0, parent.value.expiresAt.epochMilliseconds - now.epochMilliseconds),
      );
      const issued = yield* sessions
        .issue({
          subject: workspaceSubject(principal.user.id, principal.sessionId),
          method: "bearer-access-token",
          scopes: [],
          ttl: Duration.min(WORKSPACE_TOKEN_TTL, parentRemaining),
          client: { label: parent.value.client.label ?? "Workspace access", deviceType: "bot" },
        })
        .pipe(Effect.orDie);
      return {
        token: `${INSTANCE_WORKSPACE_TOKEN_PREFIX}${issued.token}`,
        expiresAt: DateTime.formatIso(issued.expiresAt),
      };
    }),
    introspect: Effect.fn("InstanceAuth.introspect")(function* ({ token, workspaceUserId }) {
      const inactive = { active: false } as const;
      if (!token.startsWith(INSTANCE_WORKSPACE_TOKEN_PREFIX)) return inactive;
      const verified = yield* sessions
        .verify(token.slice(INSTANCE_WORKSPACE_TOKEN_PREFIX.length))
        .pipe(Effect.option);
      if (Option.isNone(verified)) return inactive;
      const subject = parseWorkspaceSubject(verified.value.subject);
      // A token is only good at the workspace it was minted for.
      if (subject === null) return inactive;
      if (workspaceUserId !== STATIC_WORKSPACE_USER && subject.userId !== workspaceUserId) {
        return inactive;
      }
      const parent = yield* authSessions
        .getById({ sessionId: AuthSessionId.make(subject.parentSessionId) })
        .pipe(Effect.orDie);
      const now = yield* DateTime.now;
      if (
        Option.isNone(parent) ||
        parent.value.revokedAt !== null ||
        parent.value.expiresAt.epochMilliseconds <= now.epochMilliseconds
      ) {
        return inactive;
      }
      const record = yield* store.getUser(subject.userId);
      if (Option.isNone(record) || record.value.disabledAt !== null) return inactive;
      return {
        active: true,
        userId: record.value.userId,
        email: record.value.email,
        name: record.value.name,
        role: record.value.role,
        sessionId: verified.value.sessionId,
        expiresAt: verified.value.expiresAt
          ? DateTime.formatIso(verified.value.expiresAt)
          : DateTime.formatIso(parent.value.expiresAt),
        label: parent.value.client.label,
      } as const;
    }),
  });
});

export const layer = Layer.effect(InstanceAuth, make);
