import { recognizeRemoteWith } from "@t3tools/source-control-core/shared/definition";
import { describe, expect, it } from "vite-plus/test";

import { definition } from "./definition.ts";

describe("Gitea hosts", () => {
  it("claims gitea.com and Gitea hostnames, leaving other servers to their logins", () => {
    for (const host of ["gitea.com", "git.gitea.example.test"]) {
      expect(recognizeRemoteWith(definition, `http://${host}:3000/team/repo.git`)).toEqual({
        kind: "gitea",
        name: "Gitea",
        baseUrl: `http://${host}:3000`,
      });
      expect(
        definition.parseChangeRequestUrl(new URL(`https://${host}/team/repo/pulls/7`)),
      ).toMatchObject({ host, repository: "team/repo", number: 7 });
    }
    for (const host of ["codeberg.org", "forgejo.example.test", "git.example.test"]) {
      expect(recognizeRemoteWith(definition, `https://${host}/team/repo.git`), host).toBeNull();
      expect(
        definition.parseChangeRequestUrl(new URL(`https://${host}/team/repo/pulls/7`)),
        host,
      ).toBeNull();
    }
  });
});

describe("Gitea commands", () => {
  it("checks out by pull request URL and recognises gt's own commands", () => {
    expect(
      definition.checkoutCommand({
        number: 7,
        headBranch: "feature",
        repositoryUrl: "https://gitea.com/team/it's",
      }),
    ).toBe("gt pr checkout 'https://gitea.com/team/it'\\''s/pulls/7'");
    expect(definition.checkoutCommandArgument("gt pr co 7")).toBe("7");
    expect(definition.checkoutCommandArgument("tea pr checkout 7")).toBeNull();
    expect(definition.changeRequestCloseCommand.test("gt pr merge 7 --squash")).toBe(true);
    expect(definition.changeRequestCloseCommand.test("gt pr view 7")).toBe(false);
  });
});
