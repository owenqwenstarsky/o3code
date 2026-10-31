import {
  InstanceAccount,
  type InstanceApiClient,
  type InstanceSignedOutError,
  type InstanceUnreachableError,
} from "@t3tools/client-runtime/instance";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { InstanceUserId } from "@t3tools/contracts/instance";
import { redirect } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

type Headers = { readonly authorization: string };

const callInstance = <A, E>(
  request: (client: InstanceApiClient, headers: Headers) => Effect.Effect<A, E>,
) => InstanceAccount.pipe(Effect.flatMap((account) => account.call(request)));

const queryAtom = <A, E>(
  label: string,
  effect: Effect.Effect<A, E | InstanceSignedOutError | InstanceUnreachableError, InstanceAccount>,
) => connectionAtomRuntime.atom(effect).pipe(Atom.withLabel(`instance:${label}`));

export const instanceSessionAtom = queryAtom(
  "session",
  InstanceAccount.pipe(Effect.flatMap((account) => account.session)),
);

export const instanceMeAtom = queryAtom(
  "me",
  InstanceAccount.pipe(Effect.flatMap((account) => account.me)),
);

export const mySessionsAtom = queryAtom(
  "my-sessions",
  callInstance((client, headers) => client.account.sessions({ headers })),
);

export const adminOverviewAtom = queryAtom(
  "admin-overview",
  callInstance((client, headers) => client.admin.overview({ headers })),
);

export const adminUsersAtom = queryAtom(
  "admin-users",
  callInstance((client, headers) => client.admin.listUsers({ headers })),
);

export const adminUserAtom = Atom.family((userId: InstanceUserId) =>
  queryAtom(
    `admin-user:${userId}`,
    callInstance((client, headers) => client.admin.getUser({ headers, params: { userId } })),
  ),
);

export const adminUserSessionsAtom = Atom.family((userId: InstanceUserId) =>
  queryAtom(
    `admin-user-sessions:${userId}`,
    callInstance((client, headers) => client.admin.userSessions({ headers, params: { userId } })),
  ),
);

export const adminWorkspaceLogsAtom = Atom.family((userId: InstanceUserId) =>
  queryAtom(
    `admin-workspace-logs:${userId}`,
    callInstance((client, headers) => client.admin.workspaceLogs({ headers, params: { userId } })),
  ),
);

export const adminSettingsAtom = queryAtom(
  "admin-settings",
  callInstance((client, headers) => client.admin.settings({ headers })),
);

export const adminToolsAtom = queryAtom(
  "admin-tools",
  callInstance((client, headers) => client.admin.tools({ headers })),
);

export const adminAuditAtom = Atom.family((beforeId: number | null) =>
  queryAtom(
    `admin-audit:${beforeId ?? "latest"}`,
    callInstance((client, headers) =>
      client.admin.audit({
        headers,
        query: beforeId === null ? { limit: 50 } : { limit: 50, beforeId },
      }),
    ),
  ),
);

function describeInstanceError(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { readonly message: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message;
  }
  return "The O3 instance request failed.";
}

/** Route guard for admin pages; the instance enforces the same rule on every admin request. */
export async function requireInstanceAdmin() {
  const me = await runInstance(InstanceAccount.pipe(Effect.flatMap((account) => account.me))).catch(
    () => null,
  );
  if (me?.user.role !== "admin") throw redirect({ to: "/settings/account", replace: true });
}

export const readInstanceSession = () =>
  runInstance(InstanceAccount.pipe(Effect.flatMap((account) => account.session)));

/** Runs an account effect for an event handler; rejects with a message suitable for the UI. */
export async function runInstance<A, E>(effect: Effect.Effect<A, E, InstanceAccount>): Promise<A> {
  const result = await executeAtomQuery(
    appAtomRegistry,
    connectionAtomRuntime.atom(effect).pipe(Atom.withLabel("instance:request")),
    { reportFailure: false },
  );
  if (result._tag === "Success") return result.value;
  throw new Error(describeInstanceError(squashAtomCommandFailure(result)));
}

/** Runs one authenticated instance request for an event handler. */
export function instanceRequest<A, E>(
  request: (client: InstanceApiClient, headers: Headers) => Effect.Effect<A, E>,
): Promise<A> {
  return runInstance(callInstance(request));
}
