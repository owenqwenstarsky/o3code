// @effect-diagnostics nodeBuiltinImport:off -- Effect's Crypto has no synchronous sha256 for cache keys.
import * as NodeCrypto from "node:crypto";

import { AuthStandardClientScopes, type AuthSessionId } from "@t3tools/contracts";
import {
  INSTANCE_API_PREFIX,
  INSTANCE_WORKSPACE_TOKEN_PREFIX,
  InstanceIntrospectResult,
  STATIC_WORKSPACE_ID,
} from "@t3tools/contracts/instance";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as SessionStore from "./SessionStore.ts";

/** How long a validated workspace token is trusted before asking the instance again. */
const RECHECK_AFTER_MS = 30_000;
/** How long a known session survives an unreachable instance. */
const OUTAGE_GRACE_MS = 5 * 60_000;
const INTROSPECT_TIMEOUT_MS = 10_000;

export class O3AuthorityError extends Schema.TaggedError<O3AuthorityError>()("O3AuthorityError", {
  reason: Schema.Literals(["disabled", "inactive", "unreachable"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return `O3 instance authorization failed (${this.reason}): ${this.detail}`;
  }
}

export interface O3AuthoritySession {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly expiresAt: DateTime.DateTime;
}

interface CachedSession extends O3AuthoritySession {
  readonly token: string;
  readonly checkedAtMs: number;
  readonly lastSuccessMs: number;
}

/**
 * A workspace managed by an O3 instance accepts the instance's workspace tokens.
 * Each token maps to a local shadow session so tickets, scopes and revocation
 * reuse the environment's own session machinery.
 */
export class O3Authority extends Context.Service<
  O3Authority,
  {
    readonly enabled: boolean;
    readonly authenticate: (token: string) => Effect.Effect<O3AuthoritySession, O3AuthorityError>;
  }
>()("t3/auth/O3Authority") {}

export const isWorkspaceToken = (token: string) =>
  token.startsWith(INSTANCE_WORKSPACE_TOKEN_PREFIX);

const decodeIntrospection = Schema.decodeUnknownEffect(InstanceIntrospectResult);

const tokenKey = (token: string) =>
  NodeCrypto.createHash("sha256").update(token).digest("base64url");

const O3AuthorityConfig = Config.all({
  instanceUrl: Config.String("T3CODE_O3_INSTANCE_URL").pipe(Config.option),
  workspaceId: Config.String("T3CODE_O3_WORKSPACE_ID").pipe(Config.option),
  secret: Config.Redacted("T3CODE_O3_WORKSPACE_SECRET").pipe(Config.option),
});

export const make = Effect.gen(function* () {
  const config = yield* O3AuthorityConfig;
  const sessions = yield* SessionStore.SessionStore;
  if (
    Option.isNone(config.instanceUrl) ||
    Option.isNone(config.workspaceId) ||
    Option.isNone(config.secret)
  ) {
    return O3Authority.of({
      enabled: false,
      authenticate: Effect.fn("O3Authority.authenticate")(function* () {
        return yield* new O3AuthorityError({
          reason: "disabled",
          detail: "This environment is not managed by an O3 instance.",
        });
      }),
    });
  }
  const introspectUrl = `${config.instanceUrl.value.replace(/\/+$/, "")}${INSTANCE_API_PREFIX}/internal/introspect`;
  const workspaceId = config.workspaceId.value;
  const http = yield* HttpClient.HttpClient;
  const credential = `${workspaceId}:${Redacted.value(config.secret.value)}`;
  const cache = yield* Ref.make(new Map<string, CachedSession>());

  const introspect = (token: string) =>
    HttpClientRequest.post(introspectUrl).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${credential}`),
      HttpClientRequest.bodyJson({ token }),
      Effect.flatMap((request) => http.execute(request)),
      Effect.filterOrFail(
        (response) => response.status === 200,
        (response) => `The instance answered ${response.status}.`,
      ),
      Effect.flatMap((response) => response.json),
      Effect.flatMap(decodeIntrospection),
      Effect.timeout(Duration.millis(INTROSPECT_TIMEOUT_MS)),
      Effect.mapError(
        (cause) => new O3AuthorityError({ reason: "unreachable", detail: String(cause) }),
      ),
      Effect.withSpan("O3Authority.introspect"),
    );

  const forget = (key: string, entry: CachedSession) =>
    Ref.update(cache, (current) => {
      const next = new Map(current);
      next.delete(key);
      return next;
    }).pipe(Effect.andThen(sessions.revoke(entry.sessionId)), Effect.ignore);

  const remember = (key: string, entry: CachedSession) =>
    Ref.update(cache, (current) => new Map(current).set(key, entry));

  const validate = Effect.fn("O3Authority.validate")(function* (token: string) {
    const key = tokenKey(token);
    const now = yield* Clock.currentTimeMillis;
    const cached = (yield* Ref.get(cache)).get(key);
    // The token's own expiry holds whatever the cache or an unreachable instance would allow.
    if (cached && cached.expiresAt.epochMilliseconds <= now) {
      yield* forget(key, cached);
      return yield* new O3AuthorityError({
        reason: "inactive",
        detail: "This workspace token has expired.",
      });
    }
    if (cached && now - cached.checkedAtMs < RECHECK_AFTER_MS) return cached;

    const result = yield* introspect(token).pipe(Effect.result);
    if (result._tag === "Failure") {
      if (cached && now - cached.lastSuccessMs < OUTAGE_GRACE_MS) {
        yield* Effect.logWarning("O3 instance unreachable; keeping a recently validated session.", {
          detail: result.failure.detail,
        });
        return cached;
      }
      return yield* result.failure;
    }
    const introspection = result.success;
    if (
      !introspection.active ||
      // The instance's static dev runtime is one server standing in for every workspace.
      (workspaceId !== STATIC_WORKSPACE_ID && introspection.workspaceId !== workspaceId)
    ) {
      if (cached) yield* forget(key, cached);
      return yield* new O3AuthorityError({
        reason: "inactive",
        detail: "The instance no longer accepts this workspace token.",
      });
    }
    if (cached) {
      const refreshed = { ...cached, checkedAtMs: now, lastSuccessMs: now };
      yield* remember(key, refreshed);
      return refreshed;
    }
    const expiresAt = DateTime.makeUnsafe(introspection.expiresAt);
    const issued = yield* sessions
      .issue({
        subject: `o3:${introspection.userId}`,
        method: "bearer-access-token",
        scopes: AuthStandardClientScopes,
        ttl: Duration.millis(Math.max(1_000, expiresAt.epochMilliseconds - now)),
        client: {
          label: introspection.label ?? "O3 Code",
          deviceType: "desktop",
        },
      })
      .pipe(
        Effect.mapError(
          (cause) => new O3AuthorityError({ reason: "unreachable", detail: cause.message }),
        ),
      );
    const entry: CachedSession = {
      token,
      sessionId: issued.sessionId,
      subject: `o3:${introspection.userId}`,
      expiresAt: issued.expiresAt,
      checkedAtMs: now,
      lastSuccessMs: now,
    };
    yield* remember(key, entry);
    return entry;
  });

  // Live sockets make no new requests, so revocation is noticed by rechecking known tokens.
  yield* Ref.get(cache).pipe(
    Effect.flatMap((entries) =>
      Effect.forEach([...entries.values()], (entry) => validate(entry.token).pipe(Effect.ignore), {
        concurrency: 4,
        discard: true,
      }),
    ),
    Effect.repeat(Schedule.spaced(Duration.millis(RECHECK_AFTER_MS))),
    Effect.forkScoped,
  );

  return O3Authority.of({
    enabled: true,
    authenticate: Effect.fn("O3Authority.authenticate")(function* (token: string) {
      const entry = yield* validate(token);
      return { sessionId: entry.sessionId, subject: entry.subject, expiresAt: entry.expiresAt };
    }),
  });
});

export const layer = Layer.effect(O3Authority, make).pipe(Layer.provide(FetchHttpClient.layer));
