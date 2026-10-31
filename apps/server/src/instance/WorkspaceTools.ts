import type { InstanceTool } from "@t3tools/contracts/instance";

/**
 * Tools an admin can choose per workspace. Each id has an install script at
 * `docker/workspace/tools/<id>.sh`, run as the workspace user on start.
 */
export const WORKSPACE_TOOLS: ReadonlyArray<InstanceTool> = [
  {
    id: "claude",
    label: "Claude Code",
    description: "Anthropic's coding agent. Sign in with `claude auth login`.",
    category: "agent",
  },
  {
    id: "codex",
    label: "Codex",
    description: "OpenAI's coding agent. Connect ChatGPT in Settings or run `codex login`.",
    category: "agent",
  },
  {
    id: "cursor",
    label: "Cursor CLI",
    description: "Cursor's agent CLI (`cursor-agent`). Sign in with `agent login`.",
    category: "agent",
  },
  {
    id: "grok",
    label: "Grok Build",
    description: "xAI's coding agent. Sign in with `grok login`.",
    category: "agent",
  },
  {
    id: "opencode",
    label: "OpenCode",
    description: "Open source coding agent. Sign in with `opencode auth login`.",
    category: "agent",
  },
  {
    id: "pi",
    label: "Pi",
    description: "Pi coding agent. Run `pi`, then `/login`.",
    category: "agent",
  },
  {
    id: "uv",
    label: "Python (uv)",
    description: "uv, the Python package and version manager.",
    category: "language",
  },
  {
    id: "bun",
    label: "Bun",
    description: "Bun JavaScript runtime and package manager.",
    category: "language",
  },
  {
    id: "rust",
    label: "Rust",
    description: "Rust toolchain via rustup.",
    category: "language",
  },
  {
    id: "go",
    label: "Go",
    description: "The Go toolchain.",
    category: "language",
  },
];

export const DEFAULT_TOOL_IDS: ReadonlyArray<string> = ["claude", "codex"];

const KNOWN_TOOL_IDS = new Set(WORKSPACE_TOOLS.map((tool) => tool.id));

export const unknownToolIds = (ids: ReadonlyArray<string>) =>
  ids.filter((id) => !KNOWN_TOOL_IDS.has(id));

/** Catalog order, without duplicates. */
export const normalizeToolIds = (ids: ReadonlyArray<string>) =>
  WORKSPACE_TOOLS.map((tool) => tool.id).filter((id) => ids.includes(id));
