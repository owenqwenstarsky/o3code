import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import type { GiteaFamilyFlavor } from "@t3tools/source-control-forgejo/server/flavor";
import * as ForgejoPullRequestProvider from "@t3tools/source-control-forgejo/server/ForgejoPullRequestProvider";
import * as ForgejoSourceControlProvider from "@t3tools/source-control-forgejo/server/ForgejoSourceControlProvider";
import * as Effect from "effect/Effect";

import { definition } from "../shared/definition.ts";

import { discovery } from "./discovery.ts";
import * as GiteaCli from "./GiteaCli.ts";

// Gitea's REST API is the one Forgejo forked, so the Forgejo providers serve it over `gt`.
const flavor: GiteaFamilyFlavor = {
  kind: definition.kind,
  label: definition.label,
  command: "gt",
  unavailableRequirement: {
    missing:
      "Install Gitea CLI (`gt` 1.0 or later) from https://gitea.com/gitea/cli to browse Gitea pull requests. gt needs Gitea 28 or later; older servers use the Forgejo / Gitea (legacy) integration.",
    unauthenticated:
      "Authenticate your Gitea server with `gt auth login --host <server-url>` on the O3 Code server.",
  },
};

const makeInstance = Effect.all({
  sourceControl: ForgejoSourceControlProvider.makeFor(flavor),
  discovery: Effect.succeed(discovery),
  pullRequests: ForgejoPullRequestProvider.makeFor(flavor),
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, GiteaCli.layer),
});
