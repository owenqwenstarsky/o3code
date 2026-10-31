# O3 Code

O3 Code is an "agent harness control surface" for teams. Your organization hosts it on one Linux
server, an O3 instance, and everyone gets their own workspace: a container with their projects,
terminal, and coding agents. People drive their workspace from the web app or the Electron desktop
app, from any device on the organization's Tailscale tailnet.

It is a fork of [T3 Code](https://github.com/pingdotgg/t3code), and keeps its focus: performant,
remote-ready, and truly open.

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google
Antigravity. Each person signs in to their own providers inside their workspace.

## Get started

- **Running O3 Code for your organization:** [Run an O3 instance](./docs/user/instance-admin.md).
- **Using it:** [Get started](./docs/user/install.md) covers signing in, your workspace, and
  connecting providers.

This fork does not publish releases or prebuilt images yet. Admins build the instance and workspace
images from this repository with Docker Compose, as the admin guide describes.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [FAQ](./docs/user/faq.md)
- [Access and sharing](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Source control integrations](./docs/user/source-control.md)
- [Connect Claude Code, Codex, and other agents over MCP](./docs/user/outside-agents.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## Development

### Install `vp`

O3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies and run

```bash
vp i
vp run dev:instance
```

`vp run dev:instance` runs an O3 instance and a stand-in workspace locally, without Docker or a
tailnet. See the [development runbook](./docs/operations/development.md).

Read [CONTRIBUTING.md](./CONTRIBUTING.md) and [AGENTS.md](./AGENTS.md) before opening a PR. Report
bugs and request features in [issues](https://github.com/owenqwenstarsky/o3code/issues).
