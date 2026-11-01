import { SourceControlProviderKind, type VcsStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sourceControlClients } from "../sourceControlClients.ts";
import {
  buildMenuItems,
  getGitActionDisabledReason,
  resolveDefaultBranchActionDialogCopy,
  resolveQuickAction,
} from "./gitActions.ts";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/test",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  };
}

const gitLab = {
  sourceControlProvider: {
    kind: SourceControlProviderKind.make("gitlab"),
    name: "GitLab",
    baseUrl: "https://gitlab.com",
  },
};

const openPr = {
  number: 7,
  title: "Feature",
  url: "https://example.com/pr/7",
  baseRef: "main",
  headRef: "feature/test",
  state: "open" as const,
};

describe("git action copy", () => {
  it.each([
    { label: "PR", article: "a PR", overrides: {} },
    { label: "MR", article: "an MR", overrides: gitLab },
  ])("says $label for the ref's source control host", ({ label, article, overrides }) => {
    expect(resolveQuickAction(status({ ...overrides, aheadCount: 1 }), false).label).toBe(
      `Push & create ${label}`,
    );
    expect(
      resolveQuickAction(status({ ...overrides, hasWorkingTreeChanges: true }), false).label,
    ).toBe(`Commit, push & ${label}`);
    expect(resolveQuickAction(status({ ...overrides, pr: openPr }), false).label).toBe(
      `View ${label}`,
    );
    const [, , prItem] = buildMenuItems(status(overrides), false);
    expect(prItem?.label).toBe(`Create ${label}`);
    expect(
      getGitActionDisabledReason({
        item: prItem!,
        gitStatus: status(overrides),
        isBusy: false,
        hasOriginRemote: true,
      }),
    ).toBe(`No local commits to include in ${article}.`);
  });

  it("names the host's change request in the default-branch dialog", () => {
    const input = { action: "commit_push_pr", branchName: "main", includesCommit: true } as const;
    expect(
      resolveDefaultBranchActionDialogCopy({
        ...input,
        terminology: sourceControlClients.get("github").changeRequest,
      }).title,
    ).toBe("Commit, push & create PR from default branch?");
    expect(
      resolveDefaultBranchActionDialogCopy({
        ...input,
        terminology: sourceControlClients.get("gitlab").changeRequest,
      }).continueLabel,
    ).toBe("Commit, push & create MR");
  });
});
