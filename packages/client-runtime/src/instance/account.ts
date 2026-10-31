import { EnvironmentId } from "@t3tools/contracts";
import {
  type InstanceClientKind,
  type InstanceDescriptor,
  InstanceHttpApi,
  type InstanceLoginResult,
  type InstanceMe,
  type InstanceWorkspace,
} from "@t3tools/contracts/instance";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
} from "../connection/catalog.ts";
import { BearerConnectionTarget } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { fetchRemoteEnvironmentDescriptor } from "../environment/descriptor.ts";

const REQUEST_TIMEOUT = Duration.seconds(20);
/** Marks the saved environment an instance registered as this user's workspace. */
export const INSTANCE_WORKSPACE_CONNECTION_PREFIX = "o3:";
// Workspace tokens last a week; re-mint once fewer than five days remain.
const WORKSPACE_TOKEN_REFRESH_MARGIN_MS = 5 * 24 * 60 * 60 * 1000;

/** What a client keeps to stay signed in to an O3 instance across restarts. */
export const StoredInstanceSession = Schema.Struct({
  url: Schema.String,
  name: Schema.String,
  sessionToken: Schema.String,
  userId: Schema.String,
  email: Schema.String,
  /** The workspace environment this client registered, so sign-out can remove it. */
  environmentId: Schema.optionalKey(EnvironmentId),
  workspaceTokenExpiresAt: Schema.optionalKey(Schema.String),
});
export type StoredInstanceSession = typeof StoredInstanceSession.Type;

/** Platform storage for the instance session; desktop encrypts it, web keeps it in IndexedDB. */
export class InstanceSessionStore extends Context.Service<
  InstanceSessionStore,
  {
    readonly get: Effect.Effect<Option.Option<StoredInstanceSession>>;
    readonly set: (session: StoredInstanceSession) => Effect.Effect<void>;
    readonly clear: Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/instance/account/InstanceSessionStore") {}

export class InstanceSignedOutError extends Data.TaggedError("InstanceSignedOutError")<{
  readonly message: string;
}> {}

export class InstanceUnreachableError extends Data.TaggedError("InstanceUnreachableError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/** The user's workspace is not ready to connect, or is unreachable from this device. */
export class InstanceWorkspaceUnavailableError extends Data.TaggedError(
  "InstanceWorkspaceUnavailableError",
)<{
  readonly message: string;
  readonly workspace: InstanceWorkspace | null;
  readonly reason: "password-change" | "not-ready" | "unreachable";
}> {}

const makeInstanceApiClient = (url: string) =>
  HttpApiClient.make(InstanceHttpApi, { baseUrl: url });
export type InstanceApiClient = Effect.Success<ReturnType<typeof makeInstanceApiClient>>;

/** `https://host` with no path; users type hostnames, so `https://` is assumed. */
export function normalizeInstanceUrl(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const url = new URL(withScheme);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Use an https:// address.");
  }
  return url.origin;
}

const errorMessage = (cause: unknown) => {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { readonly message: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return String(cause);
};

const isTagged = (cause: unknown, tag: string) =>
  typeof cause === "object" && cause !== null && "_tag" in cause && cause._tag === tag;

export class InstanceAccount extends Context.Service<
  InstanceAccount,
  {
    readonly describe: (url: string) => Effect.Effect<InstanceDescriptor, InstanceUnreachableError>;
    readonly signIn: (input: {
      readonly url: string;
      readonly email: string;
      readonly password: string;
      readonly clientKind: InstanceClientKind;
      readonly deviceLabel?: string;
    }) => Effect.Effect<InstanceLoginResult, InstanceUnreachableError | InstanceSignedOutError>;
    readonly session: Effect.Effect<Option.Option<StoredInstanceSession>>;
    /** Runs an authenticated instance request; a rejected session signs this client out. */
    readonly call: <A, E>(
      request: (
        client: InstanceApiClient,
        headers: { readonly authorization: string },
      ) => Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | InstanceSignedOutError | InstanceUnreachableError>;
    readonly me: Effect.Effect<InstanceMe, InstanceSignedOutError | InstanceUnreachableError>;
    /**
     * Mints a workspace token and saves the workspace as this client's environment. Called on
     * start and periodically, so the saved token never ages out while the session lives.
     */
    readonly connectWorkspace: Effect.Effect<
      InstanceWorkspace,
      InstanceSignedOutError | InstanceUnreachableError | InstanceWorkspaceUnavailableError
    >;
    /** Confirms the session and re-mints the workspace token only when it is close to expiring. */
    readonly refreshWorkspace: Effect.Effect<
      void,
      InstanceSignedOutError | InstanceUnreachableError | InstanceWorkspaceUnavailableError
    >;
    readonly signOut: Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/instance/account/InstanceAccount") {}

const make = Effect.gen(function* () {
  const store = yield* InstanceSessionStore;
  const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
  const httpClient = yield* HttpClient.HttpClient;

  const clientFor = (url: string) =>
    makeInstanceApiClient(url).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

  const unreachable = (url: string) => (cause: unknown) =>
    new InstanceUnreachableError({
      message: `Couldn't reach ${new URL(url).host}: ${errorMessage(cause)}`,
      cause,
    });

  const forgetWorkspace = (session: StoredInstanceSession) =>
    session.environmentId === undefined
      ? Effect.void
      : registry.remove(session.environmentId).pipe(Effect.ignore);

  const signOutLocally = Effect.gen(function* () {
    const current = yield* store.get;
    if (Option.isSome(current)) yield* forgetWorkspace(current.value);
    yield* store.clear;
  });

  const requireSession = store.get.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new InstanceSignedOutError({ message: "Sign in to your O3 instance." })),
        onSome: Effect.succeed,
      }),
    ),
  );

  const call = Effect.fn("clientRuntime.instance.call")(function* <A, E>(
    request: (
      client: InstanceApiClient,
      headers: { readonly authorization: string },
    ) => Effect.Effect<A, E>,
  ) {
    const session = yield* requireSession;
    const client = yield* clientFor(session.url);
    return yield* request(client, { authorization: `Bearer ${session.sessionToken}` }).pipe(
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () => Effect.fail(unreachable(session.url)("timed out")),
      }),
      Effect.catchIf(
        (cause) => isTagged(cause, "InstanceUnauthorizedError"),
        (cause) =>
          signOutLocally.pipe(
            Effect.andThen(
              Effect.fail(new InstanceSignedOutError({ message: errorMessage(cause) })),
            ),
          ),
      ),
    );
  });

  const toAccountError = (cause: unknown): InstanceSignedOutError | InstanceUnreachableError =>
    cause instanceof InstanceSignedOutError || cause instanceof InstanceUnreachableError
      ? cause
      : new InstanceUnreachableError({ message: errorMessage(cause), cause });

  const me = call((client, headers) => client.account.me({ headers })).pipe(
    Effect.mapError(toAccountError),
  );

  const connectWorkspace = Effect.gen(function* () {
    const session = yield* requireSession;
    const current = yield* me;
    if (current.user.mustChangePassword) {
      return yield* new InstanceWorkspaceUnavailableError({
        message: "Choose a new password to open your workspace.",
        workspace: current.workspace,
        reason: "password-change",
      });
    }
    const workspace = current.workspace;
    if (workspace === null || workspace.status !== "running" || workspace.httpBaseUrl === null) {
      return yield* new InstanceWorkspaceUnavailableError({
        message: workspace?.statusMessage ?? "Your workspace is starting.",
        workspace,
        reason: "not-ready",
      });
    }
    const issued = yield* call((client, headers) =>
      client.account.workspaceToken({ headers }),
    ).pipe(
      Effect.mapError((cause) =>
        isTagged(cause, "InstanceForbiddenError")
          ? new InstanceWorkspaceUnavailableError({
              message: errorMessage(cause),
              workspace,
              reason: "password-change",
            })
          : toAccountError(cause),
      ),
    );
    const httpBaseUrl = workspace.httpBaseUrl;
    const descriptor = yield* fetchRemoteEnvironmentDescriptor({ httpBaseUrl }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.mapError(
        (cause) =>
          new InstanceWorkspaceUnavailableError({
            message: `Your workspace at ${new URL(httpBaseUrl).host} isn't reachable from this device. Connect to Tailscale and try again. (${errorMessage(cause)})`,
            workspace,
            reason: "unreachable",
          }),
      ),
    );
    const connectionId = `${INSTANCE_WORKSPACE_CONNECTION_PREFIX}${descriptor.environmentId}`;
    const label = `${session.name} workspace`;
    yield* registry
      .register(
        new BearerConnectionRegistration({
          target: new BearerConnectionTarget({
            environmentId: descriptor.environmentId,
            label,
            connectionId,
          }),
          profile: new BearerConnectionProfile({
            connectionId,
            environmentId: descriptor.environmentId,
            label,
            httpBaseUrl,
            wsBaseUrl: workspace.wsBaseUrl ?? httpBaseUrl.replace(/^http/, "ws"),
          }),
          credential: new BearerConnectionCredential({ token: issued.token }),
        }),
      )
      .pipe(Effect.orDie);
    yield* registry.setEnabled(descriptor.environmentId, true).pipe(Effect.ignore);
    // A recreated workspace can come back as a new environment; drop the old entry.
    if (session.environmentId !== undefined && session.environmentId !== descriptor.environmentId) {
      yield* forgetWorkspace(session);
    }
    yield* store.set({
      ...session,
      environmentId: descriptor.environmentId,
      workspaceTokenExpiresAt: issued.expiresAt,
    });
    return workspace;
  }).pipe(Effect.withSpan("clientRuntime.instance.connectWorkspace"));

  return InstanceAccount.of({
    describe: Effect.fn("clientRuntime.instance.describe")(function* (rawUrl: string) {
      const url = yield* Effect.try({
        try: () => normalizeInstanceUrl(rawUrl),
        catch: (cause) => new InstanceUnreachableError({ message: errorMessage(cause), cause }),
      });
      const client = yield* clientFor(url);
      const descriptor = yield* client.public
        .descriptor()
        .pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.mapError(unreachable(url)));
      return descriptor;
    }),
    signIn: Effect.fn("clientRuntime.instance.signIn")(function* (input) {
      const url = yield* Effect.try({
        try: () => normalizeInstanceUrl(input.url),
        catch: (cause) => new InstanceUnreachableError({ message: errorMessage(cause), cause }),
      });
      const client = yield* clientFor(url);
      const descriptor = yield* client.public
        .descriptor()
        .pipe(Effect.timeout(REQUEST_TIMEOUT), Effect.mapError(unreachable(url)));
      const result = yield* client.public
        .login({
          payload: {
            email: input.email,
            password: input.password,
            clientKind: input.clientKind,
            ...(input.deviceLabel ? { deviceLabel: input.deviceLabel } : {}),
          },
        })
        .pipe(
          Effect.timeout(REQUEST_TIMEOUT),
          Effect.mapError((cause) =>
            isTagged(cause, "InstanceUnauthorizedError") ||
            isTagged(cause, "InstanceRateLimitedError") ||
            isTagged(cause, "InstanceBadRequestError")
              ? new InstanceSignedOutError({ message: errorMessage(cause) })
              : unreachable(url)(cause),
          ),
        );
      const previous = yield* store.get;
      if (Option.isSome(previous)) yield* forgetWorkspace(previous.value);
      yield* store.set({
        url,
        name: descriptor.name,
        sessionToken: result.sessionToken,
        userId: result.user.id,
        email: result.user.email,
      });
      return result;
    }),
    session: store.get,
    call,
    me,
    connectWorkspace,
    refreshWorkspace: Effect.gen(function* () {
      const session = yield* requireSession;
      const expiresAt =
        session.workspaceTokenExpiresAt === undefined
          ? 0
          : Date.parse(session.workspaceTokenExpiresAt);
      const now = yield* Clock.currentTimeMillis;
      if (
        session.environmentId !== undefined &&
        expiresAt - now > WORKSPACE_TOKEN_REFRESH_MARGIN_MS
      ) {
        // Still notices a revoked session or disabled account without touching the connection.
        yield* me;
        return;
      }
      yield* connectWorkspace;
    }).pipe(Effect.withSpan("clientRuntime.instance.refreshWorkspace")),
    signOut: Effect.gen(function* () {
      yield* call((client, headers) => client.account.logout({ headers })).pipe(Effect.ignore);
      yield* signOutLocally;
    }).pipe(Effect.withSpan("clientRuntime.instance.signOut")),
  });
});

export const layer = Layer.effect(InstanceAccount, make);
