import { SourceControlProviderKind } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import { describe, expect, it } from "vite-plus/test";

import { discovery } from "./discovery.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const status = (rows: ReadonlyArray<object>) =>
  TestSourceControlHost.processOutput(encodeJson(rows));
const account = {
  host: "https://code.example.test",
  user: "maria",
  active: true,
  credential_available: true,
};
const context = (remoteUrl: string) => ({
  provider: { kind: SourceControlProviderKind.make("unknown"), name: "Unknown", baseUrl: "" },
  remoteName: "origin",
  remoteUrl,
});

describe("Gitea discovery", () => {
  it("claims a server on any hostname once gt has an account there", () => {
    const auth = status([account]);
    expect(
      discovery.refineUnknownRemote({
        cwd: "/repo",
        auth,
        context: context("git@code.example.test:team/repo.git"),
      }),
    ).toEqual({ kind: "gitea", name: "Gitea", baseUrl: "https://code.example.test" });
    expect(
      discovery.refineUnknownRemote({
        cwd: "/repo",
        auth,
        context: context("https://other.test/team/repo.git"),
      }),
    ).toBeNull();
  });

  it("reports a credential the server rejected", () => {
    const auth = discovery.parseAuth(
      status([{ ...account, verified: false, error: "token expired" }]),
    );
    expect(auth.status).toBe("unauthenticated");
    expect(Option.getOrUndefined(auth.detail)).toBe("token expired");
    expect(discovery.parseAuth(status([{ ...account, verified: true }])).status).toBe(
      "authenticated",
    );
  });
});
