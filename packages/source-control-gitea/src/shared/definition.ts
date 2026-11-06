import {
  giteaFamilyDefinition,
  isGiteaHostname,
} from "@t3tools/source-control-forgejo/shared/giteaFamilyDefinition";

import { icon } from "./icon.ts";

const CHECKOUT_COMMAND = /^gt\s+pr\s+(?:checkout|co)\s+(.+)$/i;

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const definition = giteaFamilyDefinition({
  kind: "gitea",
  label: "Gitea",
  pickerLabel: "Gitea",
  icon,
  searchKeywords: ["gt", "gitea-cli"],
  publicHost: "gitea.com",
  recognizesHostname: isGiteaHostname,
  claimsLinkHostname: isGiteaHostname,
  // gt checks out a pull request by its URL, from any repository on a signed-in server.
  checkoutCommand: ({ number, repositoryUrl }) =>
    repositoryUrl ? `gt pr checkout ${quote(`${repositoryUrl}/pulls/${number}`)}` : null,
  checkoutCommandArgument: (input) => CHECKOUT_COMMAND.exec(input)?.[1]?.trim() ?? null,
  changeRequestCloseCommand: /\bgt\s+pr\s+(?:merge|close)\b/u,
});
