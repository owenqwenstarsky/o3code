import { giteaFamilyDefinition, isGiteaHostname } from "./giteaFamilyDefinition.ts";
import { icon } from "./icon.ts";

const CHECKOUT_COMMAND = /^tea\s+(?:pr|pulls)\s+checkout\s+(.+)$/i;

export const definition = giteaFamilyDefinition({
  kind: "forgejo",
  label: "Forgejo",
  pickerLabel: "Forgejo / Gitea (legacy)",
  icon,
  searchKeywords: ["gitea", "tea", "codeberg", "legacy"],
  // Codeberg is the public Forgejo; any other server is self-hosted.
  publicHost: "codeberg.org",
  recognizesHostname: (hostname) =>
    hostname === "codeberg.org" || hostname.split(".").includes("forgejo"),
  // Gitea hosts belong to the Gitea integration; every other host's links keep this one.
  claimsLinkHostname: (hostname) => !isGiteaHostname(hostname),
  // Neither `fj` nor `tea` checks out by number.
  checkoutCommand: ({ number, repositoryUrl }) =>
    repositoryUrl
      ? `git fetch '${repositoryUrl.replaceAll("'", "'\\''")}' refs/pull/${number}/head && git checkout -B pulls/${number} FETCH_HEAD`
      : null,
  checkoutCommandArgument: (input) => CHECKOUT_COMMAND.exec(input)?.[1]?.trim() ?? null,
  changeRequestCloseCommand: /\b(?:tea\s+(?:pr|pulls)|fj\s+pr)\s+(?:merge|close)\b/u,
});
