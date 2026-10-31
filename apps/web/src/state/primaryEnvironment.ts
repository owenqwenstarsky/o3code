import { Atom } from "effect/reactivity";

import { INSTANCE_WORKSPACE_CONNECTION_PREFIX } from "@t3tools/client-runtime/instance";

import { environmentCatalog } from "../connection/catalog";

/** The user's home environment: their O3 workspace, which the instance registered. */
export const primaryEnvironmentIdAtom = Atom.make((get) => {
  for (const [environmentId, entry] of get(environmentCatalog.catalogValueAtom).entries) {
    if (
      entry.target._tag === "PrimaryConnectionTarget" ||
      (entry.target._tag === "BearerConnectionTarget" &&
        entry.target.connectionId.startsWith(INSTANCE_WORKSPACE_CONNECTION_PREFIX))
    ) {
      return environmentId;
    }
  }
  return null;
}).pipe(Atom.withLabel("web-primary-environment-id"));

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
