import type {
  AuthClientMetadata,
  AuthEnvironmentScope,
  AuthGrantScope,
  AuthPairingCredentialResult,
  ServerAuthSessionMethod,
  AuthSessionId,
} from "@t3tools/contracts";
import { EnvironmentHttpCommonError } from "@t3tools/contracts";
import type { EnvironmentHttpCommonError as EnvironmentHttpCommonErrorType } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClientError } from "effect/http";

import {
  layerRemoteHttpClient,
  makeEnvironmentHttpApiGroupClient,
} from "@t3tools/client-runtime/rpc";
import * as Option from "effect/Option";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readPrimaryEnvironmentId } from "../../state/environments";
import { environmentSession } from "../../state/session";

type AuthApiClient = Effect.Success<ReturnType<typeof makeEnvironmentHttpApiGroupClient<"auth">>>;

/**
 * Access management acts on the user's workspace over its own connection: the page is served
 * by the O3 instance, a different origin with no session for these routes.
 */
function runWorkspaceAuthRequest<A, E>(
  request: (
    client: AuthApiClient,
    headers: { readonly authorization?: string },
  ) => Effect.Effect<A, E>,
): Promise<A> {
  const environmentId = readPrimaryEnvironmentId();
  const prepared =
    environmentId === null
      ? null
      : Option.getOrNull(
          appAtomRegistry.get(environmentSession.preparedConnectionValueAtom(environmentId)),
        );
  if (prepared === null) {
    return Promise.reject(new Error("Your workspace isn't connected yet."));
  }
  const headers =
    prepared.httpAuthorization === null
      ? {}
      : { authorization: `Bearer ${prepared.httpAuthorization.token}` };
  return Effect.runPromise(
    makeEnvironmentHttpApiGroupClient(prepared.httpBaseUrl, "auth").pipe(
      Effect.flatMap((client) => request(client, headers)),
      Effect.provide(layerRemoteHttpClient(globalThis.fetch)),
    ),
  );
}

const PrimaryEnvironmentRequestOperation = Schema.Literals([
  "create-pairing-credential",
  "list-pairing-links",
  "revoke-pairing-link",
  "list-client-sessions",
  "revoke-client-session",
  "revoke-other-client-sessions",
]);
type PrimaryEnvironmentRequestOperation = typeof PrimaryEnvironmentRequestOperation.Type;

export class PrimaryEnvironmentRequestError extends Schema.TaggedError<PrimaryEnvironmentRequestError>()(
  "PrimaryEnvironmentRequestError",
  {
    operation: PrimaryEnvironmentRequestOperation,
    status: Schema.Number,
    pairingLinkId: Schema.optional(Schema.String),
    sessionId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  static fromCause(input: {
    readonly operation: PrimaryEnvironmentRequestOperation;
    readonly cause: unknown;
    readonly pairingLinkId?: string;
    readonly sessionId?: string;
  }): PrimaryEnvironmentRequestError {
    const status = readHttpApiStatus(input.cause) ?? 500;
    return new PrimaryEnvironmentRequestError({
      operation: input.operation,
      status,
      ...(input.pairingLinkId !== undefined ? { pairingLinkId: input.pairingLinkId } : {}),
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      cause: input.cause,
    });
  }

  override get message(): string {
    return `Primary environment request failed during ${this.operation} (HTTP ${this.status}).`;
  }
}

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

export interface ServerPairingLinkRecord {
  readonly id: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly subject: string;
  readonly label?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ServerClientSessionRecord {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly method: ServerAuthSessionMethod;
  readonly client: AuthClientMetadata;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lastConnectedAt: string | null;
  readonly connected: boolean;
  readonly current: boolean;
}

function readHttpApiStatus(error: unknown): number | null {
  if (isEnvironmentHttpCommonError(error)) {
    return readEnvironmentHttpErrorStatus(error);
  }
  return HttpClientError.isHttpClientError(error) && error.response !== undefined
    ? error.response.status
    : null;
}

function readEnvironmentHttpErrorStatus(error: EnvironmentHttpCommonErrorType): number {
  switch (error._tag) {
    case "EnvironmentRequestInvalidError":
      return 400;
    case "EnvironmentAuthInvalidError":
      return 401;
    case "EnvironmentScopeRequiredError":
    case "EnvironmentOperationForbiddenError":
      return 403;
    case "EnvironmentResourceNotFoundError":
      return 404;
    case "EnvironmentInternalError":
      return 500;
  }
}

export async function createServerPairingCredential(input?: {
  readonly label?: string;
  readonly scopes?: ReadonlyArray<AuthGrantScope>;
}): Promise<AuthPairingCredentialResult> {
  const trimmedLabel = input?.label?.trim();
  try {
    return await runWorkspaceAuthRequest((client, headers) =>
      client.pairingCredential({
        headers,
        payload: {
          ...(trimmedLabel ? { label: trimmedLabel } : {}),
          ...(input?.scopes ? { scopes: input.scopes } : {}),
        },
      }),
    );
  } catch (error) {
    throw PrimaryEnvironmentRequestError.fromCause({
      operation: "create-pairing-credential",
      cause: error,
    });
  }
}

export async function revokeServerPairingLink(id: string): Promise<void> {
  try {
    await runWorkspaceAuthRequest((client, headers) =>
      client.revokePairingLink({ headers, payload: { id } }),
    );
  } catch (error) {
    throw PrimaryEnvironmentRequestError.fromCause({
      operation: "revoke-pairing-link",
      pairingLinkId: id,
      cause: error,
    });
  }
}

export async function revokeServerClientSession(sessionId: AuthSessionId): Promise<void> {
  try {
    await runWorkspaceAuthRequest((client, headers) =>
      client.revokeClient({ headers, payload: { sessionId } }),
    );
  } catch (error) {
    throw PrimaryEnvironmentRequestError.fromCause({
      operation: "revoke-client-session",
      sessionId,
      cause: error,
    });
  }
}

export async function revokeOtherServerClientSessions(): Promise<number> {
  try {
    const result = await runWorkspaceAuthRequest((client, headers) =>
      client.revokeOtherClients({ headers }),
    );
    return result.revokedCount;
  } catch (error) {
    throw PrimaryEnvironmentRequestError.fromCause({
      operation: "revoke-other-client-sessions",
      cause: error,
    });
  }
}
