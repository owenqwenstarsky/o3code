import { EnvironmentId, ProjectId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0 }));
const commands = vi.hoisted(() => ({ open: vi.fn(), write: vi.fn(), close: vi.fn() }));

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useRef: (current: unknown) => {
    const index = hooks.index++;
    return (hooks.values[index] ??= { current });
  },
  useState: (initial: () => unknown) => {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = initial();
    return [hooks.values[index], vi.fn()];
  },
  useInsertionEffect: (effect: () => void) => effect(),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../../state/terminal", () => ({ terminalEnvironment: commands }));
vi.mock("../../state/preview", () => ({ previewEnvironment: {} }));
vi.mock("../../previewStateStore", () => ({ isPreviewSupportedInRuntime: () => false }));
vi.mock("../../browser/openFileInPreview", () => ({ openUrlInPreview: vi.fn() }));
vi.mock("../../browser/browserTargetResolver", () => ({ resolveDiscoveredServerUrl: vi.fn() }));
vi.mock("../../lib/terminalCloseConfirm", () => ({ confirmTerminalClose: vi.fn() }));
vi.mock("../ui/toast", () => ({ stackedThreadToast: vi.fn(), toastManager: {} }));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => true }));
vi.mock("../../terminalUiStateStore", async (original) => {
  const actual = await original<typeof import("../../terminalUiStateStore")>();
  return {
    ...actual,
    useTerminalUiStateStore: (
      select: (state: ReturnType<typeof actual.useTerminalUiStateStore.getState>) => unknown,
    ) => select(actual.useTerminalUiStateStore.getState()),
  };
});
vi.mock("../../rightPanelStore", async (original) => {
  const actual = await original<typeof import("../../rightPanelStore")>();
  return {
    ...actual,
    useRightPanelStore: (
      select: (state: ReturnType<typeof actual.useRightPanelStore.getState>) => unknown,
    ) => select(actual.useRightPanelStore.getState()),
  };
});
vi.mock("../../composerDraftStore", async (original) => {
  const actual = await original<typeof import("../../composerDraftStore")>();
  return {
    ...actual,
    useComposerDraftStore: (
      select: (state: ReturnType<typeof actual.useComposerDraftStore.getState>) => unknown,
    ) => select(actual.useComposerDraftStore.getState()),
  };
});
vi.mock("../../state/entities", () => ({
  useQuietThreadShell: (ref: ScopedThreadRef) => ({ ...ref, projectId: "project" }),
  useProject: () => ({ workspaceRoot: "/project" }),
}));
vi.mock("../../state/terminalSessions", () => ({ useKnownTerminalSessions: () => [] }));
vi.mock("../../hooks/useLocalStorage", () => ({ useLocalStorage: () => [{}, vi.fn()] }));
vi.mock("../../lib/terminalFocus", () => ({
  focusActiveDrawerTerminal: vi.fn(),
  focusActivePanelTerminal: vi.fn(),
  focusTerminal: vi.fn(),
}));
vi.mock("../ChatView.logic", () => ({
  LAST_INVOKED_SCRIPT_BY_PROJECT_KEY: "scripts",
  LastInvokedScriptByProjectSchema: {},
}));

import { selectThreadTerminalUiState } from "../../terminalUiStateStore";
import { useChatTerminalActions } from "./useChatTerminalActions";

it("writes a script to its originating thread when selection changes while opening", async () => {
  hooks.values = [];
  commands.open.mockReset();
  commands.write.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  let finishOpen!: (result: ReturnType<typeof AsyncResult.success<void>>) => void;
  const opened = new Promise<ReturnType<typeof AsyncResult.success<void>>>((resolve) => {
    finishOpen = resolve;
  });
  commands.open.mockReturnValue(opened);
  const origin = { environmentId: EnvironmentId.make("a"), threadId: ThreadId.make("a") };
  const other = { environmentId: EnvironmentId.make("b"), threadId: ThreadId.make("b") };
  const render = (ref: ScopedThreadRef) => {
    hooks.index = 0;
    return useChatTerminalActions({
      environmentId: ref.environmentId,
      composerRef: { current: null },
      terminalUiState: selectThreadTerminalUiState({}, ref),
      activeThread: { worktreePath: null } as Parameters<
        typeof useChatTerminalActions
      >[0]["activeThread"],
      activeThreadId: ref.threadId,
      activeThreadRef: ref,
      activeProject: { id: ProjectId.make("project"), workspaceRoot: "/project" } as Parameters<
        typeof useChatTerminalActions
      >[0]["activeProject"],
      activeRightPanelSurface: null,
      runningTerminalIds: [],
      activeServerOrderedTerminalIds: [],
      activeTerminalLabelsById: new Map(),
      panelTerminalIds: new Set(),
      canReuseTerminal: false,
      gitCwd: "/project",
      setTerminalUiLaunchContext: vi.fn(),
      setThreadError: vi.fn(),
    });
  };

  const pending = render(origin).runProjectScriptStable(
    {
      id: "script",
      name: "Script",
      command: "echo origin",
      icon: "play",
      runOnWorktreeCreate: false,
    },
    { shellHistory: "preserve" },
  );
  render(other);
  finishOpen(AsyncResult.success(undefined));
  await pending;
  expect(commands.write).toHaveBeenCalledWith({
    environmentId: origin.environmentId,
    input: { threadId: origin.threadId, terminalId: expect.any(String), data: "echo origin\r" },
  });
});
