import {
  providerAuth,
  type SourceControlCliDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import * as ForgejoCli from "@t3tools/source-control-forgejo/server/ForgejoCli";

import { definition } from "../shared/definition.ts";
import { parseGiteaAuthStatus, parseGiteaLogins } from "./GiteaCli.ts";

const hostOf = (url: string) => ForgejoCli.parseForgejoRemote(url)?.host;

export const discovery = {
  type: "cli",
  kind: definition.kind,
  label: definition.label,
  executable: "gt",
  versionArgs: ["--version"],
  // Settings asks each server about its credential; routing reads the stored accounts only.
  authArgs: ["auth", "status", "--json", "--verify"],
  remoteRefinementArgs: () => ["auth", "status", "--json"],
  probeTimeoutMs: 15_000,
  parseAuth: (input) => {
    const rows = parseGiteaAuthStatus(input.stdout);
    const row = rows.find((entry) => entry.active && entry.credential_available) ?? rows[0];
    if (!row)
      return providerAuth({
        status: "unauthenticated",
        detail: "Run `gt auth login --host <server-url>` to sign in to a Gitea server.",
      });
    return row.credential_available && row.verified !== false
      ? providerAuth({ status: "authenticated", account: row.user, host: hostOf(row.host) })
      : providerAuth({
          status: "unauthenticated",
          host: hostOf(row.host),
          detail: row.error || `Sign in again with \`gt auth login --host ${row.host}\`.`,
        });
  },
  refineUnknownRemote: (input) => {
    const remote = ForgejoCli.parseForgejoRemote(input.context.remoteUrl);
    const login =
      remote &&
      ForgejoCli.matchForgejoLogin(
        parseGiteaLogins(input.auth.stdout),
        remote,
        input.context.requestedHost,
      );
    return login ? { kind: definition.kind, name: definition.label, baseUrl: login.url } : null;
  },
  installHint:
    "Install Gitea CLI (`gt` 1.0 or later, for Gitea 28 or later) with `brew install gitea-cli` or from https://gitea.com/gitea/cli, then run `gt auth login --host <server-url>` for each Gitea server.",
} satisfies SourceControlCliDiscoverySpec;
