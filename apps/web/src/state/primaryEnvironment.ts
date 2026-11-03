import type { EnvironmentId } from "@t3tools/contracts";
import type { ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";
import { Atom } from "effect/reactivity";

import {
  INSTANCE_DEFAULT_WORKSPACE_CONNECTION_PREFIX,
  INSTANCE_WORKSPACE_CONNECTION_PREFIX,
} from "@t3tools/client-runtime/instance";

import { environmentCatalog } from "../connection/catalog";

/**
 * The user's home environment: their default O3 workspace. Falls back to any workspace the
 * instance registered, for a catalog saved before the default was marked.
 */
export const primaryEnvironmentIdIn = (
  entries: Iterable<
    readonly [EnvironmentId, Pick<ConnectionCatalogEntry, "target" | "alternateRoutes">]
  >,
): EnvironmentId | null => {
  let fallback: EnvironmentId | null = null;
  for (const [environmentId, entry] of entries) {
    for (const { target } of [entry, ...(entry.alternateRoutes ?? [])]) {
      if (target._tag === "PrimaryConnectionTarget") return environmentId;
      const connectionId = target.connectionId;
      if (connectionId.startsWith(INSTANCE_DEFAULT_WORKSPACE_CONNECTION_PREFIX)) {
        return environmentId;
      }
      if (fallback === null && connectionId.startsWith(INSTANCE_WORKSPACE_CONNECTION_PREFIX)) {
        fallback = environmentId;
      }
    }
  }
  return fallback;
};

export const primaryEnvironmentIdAtom = Atom.make((get) =>
  primaryEnvironmentIdIn(get(environmentCatalog.catalogValueAtom).entries),
).pipe(Atom.withLabel("web-primary-environment-id"));

/**
 * An environment running on this device, whose files, browser and media this client can reach
 * directly. Workspaces run in the organization's containers, so there is none.
 */
export const localEnvironmentIdAtom = Atom.make((get) => {
  for (const [environmentId, entry] of get(environmentCatalog.catalogValueAtom).entries) {
    if (entry.target._tag === "PrimaryConnectionTarget") return environmentId;
  }
  return null;
}).pipe(Atom.withLabel("web-local-environment-id"));
