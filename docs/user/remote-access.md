# Access and sharing

Your workspace runs on your organization's O3 instance and is reachable from any
device on your tailnet. You sign in to the instance, and it gives each device
access to your workspace.

## Your devices

**Settings → Account → Signed-in devices** lists every device signed in to your
account. Sign one out to end its access within a minute; changing your password
signs out all the others. Administrators can do the same from
**Settings → Admin → Users**.

## Guest links

[Guest links](./guest-links.md) let a coworker on your tailnet read one thread
and propose messages without an account.

## Browser in your workspace

Browser tabs belong to your workspace, so you and your agents see the same
tabs from any device. They stream from the workspace, agents keep using them
while no device is connected, and `localhost` addresses reach servers running
in your workspace.

The first tab downloads a headless Chrome, about 120 MB, into your workspace. It
is the same browser [HTML renders](html-renders.md) use, so it downloads only
once.

Agent tabs have separate storage and share a Chromium process. Take control before
typing into an agent's tab, then release control when you want the agent to
continue. Read-only connections can watch without changing the page.

While you have control, the tab works with your device: text the page copies or
cuts goes to your clipboard, a file picker on the page opens your device's
picker, and a finished download is offered for you to save. Popups such as
sign-in windows open as their own tabs. Downloads stay in the workspace until
the tab closes. Audio does not play on your device.

### Local servers

The browser lists ports held by processes your terminals and agents started.
O3 Code reads which process holds each port and never connects to it, so a
listed port opens as `http://localhost:<port>` and might not be a web page. For
an HTTPS server or a specific path, set the **Preview URL** on the project
script that starts it; O3 Code checks that address and opens it as written.

## Connect an outside agent

Claude Code, Codex, ChatGPT and other agents O3 Code did not start can drive
threads in your workspace through its MCP server. See
[outside agents](./outside-agents.md) for setup.

## Link another environment

Link two environments, such as your workspace and a server your team runs O3 Code
on, and agents on one can work on the other: launch, message, wait on and stop its threads, answer their
questions, and manage its queues, projects and scheduled tasks.

Linked environments is a beta. Turn it on for both machines in **Settings →
Labs**. While it is
off on either machine, agents start nothing over a link between them. A task
already running on the other machine still finishes, and if that machine has it
off, its result arrives once it is back on.

On the environment you will work from, open **Settings → Labs → Linked environments**,
choose **Link**, and enter the other environment's address. The list
holds the machines this app knows. If this
app is connected to that machine with a session that manages access there, it
makes the pairing code itself; otherwise paste one from that machine's
**Settings → Sharing & access**. From a terminal, use
`t3 environment link <address> --pairing-code <code> --access <mode>`.

You can also ask an agent to link a machine by name, such as "delegate this to
my vps". It shows a card in the thread where you pick the machine the same way
and the access, then approve.

- The access you pick is the most agents from this machine may do there. An
  agent also never gets more there than its own mode here.
- Threads a link starts are marked **From** and this machine's name there.
- A full-access link works there like that machine's own agents. Below full
  access, the link's agents can change only threads it started, not that
  machine's own threads, projects or settings, and they skip its project setup
  scripts.
- The link shows up in that machine's **Settings → Sharing & access** like any
  outside agent. Revoke it there to end it. **Forget** on this machine only
  removes it here.
- Links last 30 days. Link again with a new pairing code to renew one.

An agent can also hand a task to a linked machine with `delegate_task`: it runs
there as an ordinary thread, in the project with the same repository (or the
one `target.projectId` names), and this thread wakes with its result when it
ends, as for any delegated task. It keeps following the task across restarts.
If the other machine revokes the link, or the link is removed here, the task
fails with that reason.

## Manage access

**Settings → Sharing & access** lists the clients that can reach your workspace
directly, such as outside agents and linked environments, and lets you revoke
them. It also creates the one-time pairing codes that approve an outside agent.
Command-line management is available through `t3 auth --help` in a workspace
terminal.

Treat pairing codes and authorization codes as passwords. Do not include them in
screenshots, logs, or bug reports.
