import { SourceControlProviderKind } from "@t3tools/contracts";

import type { ForgejoCommand } from "./ForgejoCli.ts";

/** What sets one Gitea-family integration apart above its CLI, which share the REST API. */
export interface GiteaFamilyFlavor {
  readonly kind: SourceControlProviderKind;
  /** The forge's name in messages. */
  readonly label: string;
  /** The CLI a failure is reported against when no command ran. */
  readonly command: ForgejoCommand;
  readonly unavailableRequirement: { readonly missing: string; readonly unauthenticated: string };
}

export const forgejoFlavor: GiteaFamilyFlavor = {
  kind: SourceControlProviderKind.make("forgejo"),
  label: "Forgejo",
  command: "tea",
  unavailableRequirement: {
    missing:
      "Install Forgejo CLI (`fj` 0.6 or later) from https://codeberg.org/forgejo-contrib/forgejo-cli, or Gitea CLI (`tea` 0.16 or later) from https://gitea.com/gitea/tea for Gitea before 28, to browse Forgejo pull requests. For Gitea 28 or later, use the Gitea integration with `gt`.",
    unauthenticated:
      "Authenticate your Forgejo or Gitea server with `fj --host <server-url> auth add-token` on the O3 Code server. If fj is missing or unconfigured for that server, use `tea login add`. A configured fj account must be repaired with fj.",
  },
};
