import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render, stubGlobal } from "../../../test/render";

const state = vi.hoisted(() => ({
  projects: [] as EnvironmentProject[],
  routeParams: {} as Record<string, string>,
  preview: vi.fn(),
  openLink: vi.fn(async () => undefined),
  navigate: vi.fn(async (): Promise<void> => undefined),
  openScratchProject: vi.fn(async () => null),
}));

// One connected primary environment that can read pull requests.
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
  useRouter: (() => ({
    navigate: state.navigate,
    state: { matches: [{ params: state.routeParams }] },
  })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => "local" as EnvironmentId,
  usePrimaryEnvironment: (() => ({
    environmentId: "local",
    connection: { phase: "connected" },
    serverConfig: {},
  })) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const capabilities = { pullRequests: true, threadPullRequests: true };
  return {
    ...(await original()),
    environmentServerConfigsAtom: Atom.make(
      new Map([["local", { environment: { capabilities } }]]),
    ) as never,
  };
});
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  readProjects: () => state.projects,
  readThreadShell: (ref: { threadId: string }) =>
    ref.threadId === "thread" ? ({ projectId: "effect", worktreePath: null } as never) : null,
  readProject: () => state.projects[0] ?? null,
}));
vi.mock(import("../../hooks/useScratchProject"), async (original) => ({
  ...(await original()),
  useScratchProject: (() => ({
    scratchEnvironmentId: () => "local",
    openScratchProject: state.openScratchProject,
  })) as never,
}));

vi.mock("../../state/use-atom-query-runner", () => ({
  useAtomQueryRunner: () => state.preview,
}));
vi.mock("../../browser/useOpenLink", () => ({ useOpenLink: () => state.openLink }));
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "../../diffPanelStore";
import {
  selectActiveRightPanel,
  selectActiveRightPanelSurface,
  useRightPanelStore,
} from "../../rightPanelStore";
import { DesktopWebLinkCoordinator } from "./DesktopWebLinkCoordinator";

const environmentId = EnvironmentId.make("local");
const projectId = ProjectId.make("effect");
const project = {
  id: projectId,
  workspaceRoot: "/workspace/effect",
  environmentId,
  repositoryIdentity: {
    provider: "github",
    displayName: "Effect-TS/effect",
    canonicalKey: "github.com/effect-ts/effect",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "https://github.com/Effect-TS/effect.git",
    },
  },
} as EnvironmentProject;
const pullRequestUrl = "https://github.com/Effect-TS/effect/pull/9339";
const pullRequestView = {
  to: "/pull-requests",
  search: {
    involvement: "all",
    state: "all",
    repository: "effect-ts/effect",
    number: 9339,
    selectedHost: "github.com",
    selectedProjectId: projectId,
    selectedEnvironmentId: environmentId,
  },
};

function setup() {
  vi.clearAllMocks();
  state.projects = [];
  state.routeParams = {};
  state.preview
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ sources: [{ kind: "commit", headRef: sha }] }));
  useDiffPanelStore.setState({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
}

/** Mounts the coordinator behind a desktop bridge that hands over `urls` once the renderer is ready. */
async function mount(...urls: string[]) {
  let deliver: ((url: string) => void) | undefined;
  await using stack = new AsyncDisposableStack();
  stack.use(
    stubGlobal("desktopBridge", {
      getClientSettings: async () => null,
      webLinks: {
        onOpen: (listener: (url: string) => void) => {
          deliver = listener;
          return () => undefined;
        },
        setReady: async (ready: boolean) => {
          if (ready) for (const url of urls.splice(0)) deliver?.(url);
        },
      },
    }),
  );
  stack.use(
    await render(
      <AppAtomRegistryProvider>
        <DesktopWebLinkCoordinator />
      </AppAtomRegistryProvider>,
    ),
  );
  return stack.move();
}

it("opens a launch PR link in the PR view", async () => {
  setup();
  state.projects = [project];
  await using _coordinator = await mount(pullRequestUrl);
  await vi.waitFor(() => expect(state.navigate).toHaveBeenCalledExactlyOnceWith(pullRequestView));
  expect(state.openScratchProject).not.toHaveBeenCalled();
});

it("opens a PR link without a matching project in the browser", async () => {
  setup();
  await using _coordinator = await mount(pullRequestUrl);
  await vi.waitFor(() => expect(state.openScratchProject).toHaveBeenCalledOnce());
});

const sha = "a".repeat(40);
const commitUrl = `https://github.com/Effect-TS/effect/pull/9339/commits/${sha}`;
const threadRef = scopeThreadRef(environmentId, ThreadId.make("thread"));

it.each([
  ["github.com", "pull/9339/commits"],
  ["code.example.com:8443", "commit"],
])("opens a %s/%s commit in the active thread's Diff pane", async (host, path) => {
  setup();
  state.routeParams = { environmentId: "local", threadId: "thread" };
  state.projects = [
    {
      ...project,
      repositoryIdentity: {
        ...project.repositoryIdentity,
        canonicalKey: `${host}/effect-ts/effect`,
        locator: {
          ...project.repositoryIdentity?.locator,
          remoteUrl: `https://${host}/Effect-TS/effect.git`,
        },
      },
    } as EnvironmentProject,
  ];
  await using _coordinator = await mount(`https://${host}/Effect-TS/effect/${path}/${sha}`);
  await vi.waitFor(() => {
    expect(selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef)).toBe(
      "diff",
    );
  });
  expect(
    selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, threadRef),
  ).toMatchObject({ kind: "commit", sha });
  expect(state.preview).toHaveBeenCalledExactlyOnceWith({
    environmentId,
    input: expect.objectContaining({ cwd: "/workspace/effect", commitSha: sha }),
  });
  expect(state.navigate).not.toHaveBeenCalled();
  expect(state.openLink).not.toHaveBeenCalled();
});

it("opens a PR commit the workspace lacks in the thread's PR panel", async () => {
  setup();
  state.routeParams = { environmentId: "local", threadId: "thread" };
  state.projects = [project];
  state.preview.mockResolvedValueOnce(AsyncResult.success({ sources: [] }));
  await using _coordinator = await mount(commitUrl);
  await vi.waitFor(() =>
    expect(
      selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, threadRef),
    ).toMatchObject({ kind: "pull-request", repository: "effect-ts/effect", number: 9339 }),
  );
  expect(useDiffPanelStore.getState().byThreadKey).toEqual({});
  expect(state.openLink).not.toHaveBeenCalled();
});

it("opens a plain commit the workspace lacks like any other delivered link", async () => {
  setup();
  state.routeParams = { environmentId: "local", threadId: "thread" };
  state.projects = [project];
  state.preview.mockResolvedValueOnce(AsyncResult.success({ sources: [] }));
  const plainCommitUrl = `https://github.com/Effect-TS/effect/commit/${sha}`;
  await using _coordinator = await mount(plainCommitUrl);
  await vi.waitFor(() => expect(state.openScratchProject).toHaveBeenCalledOnce());
  // Handing it to the OS browser would loop when T3 Code is the default browser.
  expect(state.openLink).not.toHaveBeenCalled();
  expect(useDiffPanelStore.getState().byThreadKey).toEqual({});
  expect(useRightPanelStore.getState().byThreadKey).toEqual({});
});
