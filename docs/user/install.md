# Get started

O3 Code runs coding agents in a workspace your organization hosts and lets you
control them from the web or desktop app. Your administrator gives you an account
on your organization's O3 instance. To run an instance, see
[Run an O3 instance](./instance-admin.md).

## Sign in

You need [Tailscale](https://tailscale.com/download) on your device, signed in to
your organization's tailnet.

- **Web:** open your instance's address, such as `https://o3.your-tailnet.ts.net`.
- **Desktop:** open the app and enter the instance's address.

Sign in with the email and temporary password your administrator gave you, then
choose your own password. The first time, your workspace may take a few minutes
to start while its tools install. You stay signed in until you sign out or the
sign-in expires, which your administrator sets.

If O3 Code says it can't reach your workspace, check that Tailscale is connected.

**Settings → Account** shows your workspace's status and lets you restart it,
change your password, and sign out other devices.

## Your workspace

Your workspace is a Linux container with your own home folder. Clone projects
into it from O3 Code or its terminal. Files, settings, and agent sign-ins in your
home folder survive restarts and upgrades. Software installed outside your home
folder, such as with `apt`, may not.

The `t3` command is available in workspace terminals; run `t3 --help` for project
and thread commands.

## Desktop app

This fork does not publish builds yet. Build the desktop app from source with
`vp` ([Install vp](https://github.com/owenqwenstarsky/o3code#install-vp)):

```bash
git clone https://github.com/owenqwenstarsky/o3code
cd o3code && vp i && vp run dist:desktop:artifact
```

## Providers

Your administrator chooses which coding agents are installed in your workspace.
Open **Settings → Providers** to enable one and sign in. Sign-ins and
configuration stay in your workspace, so every device you use sees them. To
install something your administrator didn't, run its installer in a workspace
terminal; installs in your home folder survive workspace restarts.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Choose **Sign in** under Settings → Providers → Cursor, or set `CURSOR_API_KEY` there.                                                                    |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from O3 Code's provider settings.                                                                                         |
| Pi          | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| Muse Code   | Install [Muse Code](https://dev.meta.ai/docs/muse-code) in a workspace terminal, run `muse login`, then enable it in Settings → Providers.                |
| fx          | Install [fx](https://fx.sh) with `curl -fsSL https://fx.sh/setup.sh \| bash`, then run `fx login`.                                                        |

Provider CLIs must be on your workspace's `PATH`. If O3 Code cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Codex connected through ChatGPT, Cursor, and Antigravity use their managed
runtimes without a `PATH` entry.

O3 Code warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
in a workspace terminal. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or the
CLI's own update command when O3 Code cannot tell. Update a CLI installed with
mise through mise. Cursor and Antigravity update with O3 Code. Homebrew installs
compare against the version Homebrew offers, which can trail the npm release by
a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, O3 Code does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), [Pi](./providers-pi.md),
[Muse Code](./providers-muse.md), and [fx](./providers-fx.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Access and sharing](./remote-access.md): devices, outside agents, and guests.
