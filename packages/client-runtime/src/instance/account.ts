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
/** Marks the saved environments an instance registered as this user's workspaces. */
export const INSTANCE_WORKSPACE_CONNECTION_PREFIX = "o3:";
/** The user's default workspace, which clients treat as the home environment. */
export const INSTANCE_DEFAULT_WORKSPACE_CONNECTION_PREFIX = `${INSTANCE_WORKSPACE_CONNECTION_PREFIX}default:`;
const workspaceConnectionId = (environmentId: EnvironmentId, isDefault: boolean) =>
  `${isDefault ? INSTANCE_DEFAULT_WORKSPACE_CONNECTION_PREFIX : INSTANCE_WORKSPACE_CONNECTION_PREFIX}${environmentId}`;
// Workspace tokens last a week; re-mint once fewer than five days remain.
const WORKSPACE_TOKEN_REFRESH_MARGIN_MS = 5 * 24 * 60 * 60 * 1000;

/** A workspace this client registered as an environment. */
export const StoredInstanceWorkspace = Schema.Struct({
  workspaceId: Schema.String,
  environmentId: EnvironmentId,
  /** Where it was registered; a recreated workspace can come back elsewhere. */
  httpBaseUrl: Schema.String,
  tokenExpiresAt: Schema.String,
  isDefault: Schema.Boolean,
});
export type StoredInstanceWorkspace = typeof StoredInstanceWorkspace.Type;

/** What a client keeps to stay signed in to an O3 instance across restarts. */
export const StoredInstanceSession = Schema.Struct({
  url: Schema.String,
  name: Schema.String,
  sessionToken: Schema.String,
  userId: Schema.String,
  email: Schema.String,
  /** The registered workspaces, so refresh and sign-out can find their environments. */
  workspaces: Schema.optionalKey(Schema.Array(StoredInstanceWorkspace)),
  /** The one workspace environment older clients saved; read only to forget it. */
  environmentId: Schema.optionalKey(EnvironmentId),
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

/** The user's default workspace is not ready to connect, or is unreachable from this device. */
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
     * Mints a token for each running workspace and saves each as an environment, the default
     * marked as home. Fails only when the default workspace can't connect.
     */
    readonly connectWorkspaces: Effect.Effect<
      InstanceWorkspace,
      InstanceSignedOutError | InstanceUnreachableError | InstanceWorkspaceUnavailableError
    >;
    /**
     * Confirms the session and reconnects only when a token is close to expiring or the
     * workspaces changed: added, removed, moved, or a new default.
     */
    readonly refreshWorkspaces: Effect.Effect<
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

  const savedEnvironmentIds = (session: StoredInstanceSession) => [
    ...(session.workspaces ?? []).map((workspace) => workspace.environmentId),
    ...(session.environmentId === undefined ? [] : [session.environmentId]),
  ];

  const forgetEnvironments = (environmentIds: Iterable<EnvironmentId>) =>
    Effect.forEach(
      new Set(environmentIds),
      (environmentId) => registry.remove(environmentId).pipe(Effect.ignore),
      { discard: true },
    );

  const signOutLocally = Effect.gen(function* () {
    const current = yield* store.get;
    if (Option.isSome(current)) yield* forgetEnvironments(savedEnvironmentIds(current.value));
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

  const connectOne = Effect.fn("clientRuntime.instance.connectOne")(function* (
    session: StoredInstanceSession,
    workspace: InstanceWorkspace,
    taken: ReadonlySet<EnvironmentId>,
  ) {
    const httpBaseUrl = workspace.httpBaseUrl;
    if (workspace.status !== "running" || httpBaseUrl === null) {
      return yield* new InstanceWorkspaceUnavailableError({
        message: workspace.statusMessage ?? "Your workspace is starting.",
        workspace,
        reason: "not-ready",
      });
    }
    const issued = yield* call((client, headers) =>
      client.account.myWorkspaceToken({ headers, params: { workspaceId: workspace.id } }),
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
    // The instance's static dev runtime answers for every workspace from one server.
    if (taken.has(descriptor.environmentId)) return null;
    const connectionId = workspaceConnectionId(descriptor.environmentId, workspace.isDefault);
    const label = workspace.label.length > 0 ? workspace.label : `${session.name} workspace`;
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
    return {
      workspaceId: workspace.id,
      environmentId: descriptor.environmentId,
      httpBaseUrl,
      tokenExpiresAt: issued.expiresAt,
      isDefault: workspace.isDefault,
    } satisfies StoredInstanceWorkspace;
  });

  const connectWith = Effect.fn("clientRuntime.instance.connectWorkspaces")(function* (
    session: StoredInstanceSession,
    current: InstanceMe,
  ) {
    const defaultWorkspace = current.workspaces[0] ?? null;
    if (current.user.mustChangePassword) {
      return yield* new InstanceWorkspaceUnavailableError({
        message: "Choose a new password to open your workspace.",
        workspace: defaultWorkspace,
        reason: "password-change",
      });
    }
    if (defaultWorkspace === null) {
      return yield* new InstanceWorkspaceUnavailableError({
        message: "Your workspace is starting.",
        workspace: null,
        reason: "not-ready",
      });
    }
    const previous = session.workspaces ?? [];
    const connected: Array<StoredInstanceWorkspace> = [];
    let defaultError: InstanceWorkspaceUnavailableError | null = null;
    for (const workspace of current.workspaces) {
      const taken = new Set(connected.map((entry) => entry.environmentId));
      const result = yield* connectOne(session, workspace, taken).pipe(
        Effect.catchTags({
          InstanceWorkspaceUnavailableError: (error) => Effect.succeed(error),
        }),
      );
      if (result instanceof InstanceWorkspaceUnavailableError) {
        if (workspace.id === defaultWorkspace.id) defaultError = result;
        yield* Effect.logWarning("Couldn't connect a workspace.", {
          workspace: workspace.slug,
          reason: result.reason,
        });
      } else if (result !== null) {
        connected.push(result);
      }
    }
    // A workspace that couldn't connect this time keeps its saved environment, as one that stopped.
    const kept = previous.flatMap((entry) => {
      if (connected.some((done) => done.workspaceId === entry.workspaceId)) return [];
      const workspace = current.workspaces.find((candidate) => candidate.id === entry.workspaceId);
      return workspace === undefined ? [] : [{ ...entry, isDefault: workspace.isDefault }];
    });
    const next = [...connected, ...kept];
    const nextEnvironmentIds = new Set(next.map((entry) => entry.environmentId));
    yield* forgetEnvironments(
      savedEnvironmentIds(session).filter(
        (environmentId) => !nextEnvironmentIds.has(environmentId),
      ),
    );
    const { environmentId: _legacy, ...rest } = session;
    yield* store.set({ ...rest, workspaces: next });
    if (defaultError !== null) return yield* defaultError;
    return defaultWorkspace;
  });

  const connectWorkspaces = Effect.gen(function* () {
    const session = yield* requireSession;
    return yield* connectWith(session, yield* me);
  });

  const needsReconnect = (session: StoredInstanceSession, current: InstanceMe, now: number) => {
    const saved = session.workspaces ?? [];
    if (session.environmentId !== undefined) return true;
    if (saved.some((entry) => !current.workspaces.some((w) => w.id === entry.workspaceId))) {
      return true;
    }
    return current.workspaces.some((workspace) => {
      const entry = saved.find((candidate) => candidate.workspaceId === workspace.id);
      if (entry === undefined) {
        return workspace.status === "running" && workspace.httpBaseUrl !== null;
      }
      return (
        entry.isDefault !== workspace.isDefault ||
        (workspace.httpBaseUrl !== null && entry.httpBaseUrl !== workspace.httpBaseUrl) ||
        Date.parse(entry.tokenExpiresAt) - now <= WORKSPACE_TOKEN_REFRESH_MARGIN_MS
      );
    });
  };

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
      if (Option.isSome(previous)) yield* forgetEnvironments(savedEnvironmentIds(previous.value));
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
    connectWorkspaces,
    refreshWorkspaces: Effect.gen(function* () {
      const session = yield* requireSession;
      // Asking every time still notices a revoked session or a disabled account.
      const current = yield* me;
      if (!needsReconnect(session, current, yield* Clock.currentTimeMillis)) return;
      yield* connectWith(session, current).pipe(Effect.asVoid);
    }).pipe(Effect.withSpan("clientRuntime.instance.refreshWorkspaces")),
    signOut: Effect.gen(function* () {
      yield* call((client, headers) => client.account.logout({ headers })).pipe(Effect.ignore);
      yield* signOutLocally;
    }).pipe(Effect.withSpan("clientRuntime.instance.signOut")),
  });
});

export const layer = Layer.effect(InstanceAccount, make);
