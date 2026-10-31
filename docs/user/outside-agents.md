# Outside agents

Agents that O3 Code did not start can work with your workspace through its MCP
server. They can read projects and threads, start and message threads, and
check which providers and models are available. This covers Claude Code or
Codex in your own terminal, and other agents that support MCP. Each agent signs
in once, and you choose what it may do.

## Get the MCP URL

The MCP URL is your workspace's address followed by `/mcp`. **Settings → Account**
shows the address:

```text
https://o3-<name>.<tailnet>.ts.net/mcp
```

Agents on devices in your tailnet, such as Claude Code or Codex on your laptop,
can reach it. Hosted agents, such as ChatGPT or a bot running in the cloud,
cannot, unless your administrator exposes your workspace some other way.

## Approve a sign-in

The first time an agent connects, it opens a sign-in page on your workspace. The
page names the agent and where its access goes. For an agent on your computer,
approval returns to a `localhost` address on the computer that opened the page.
For a hosted agent, approval goes to that service, and anyone who runs that
service gets the access.

Only approve a sign-in you just started. To approve, enter a pairing code from
**Settings → Sharing & access**, or from `t3 auth pairing create` in a workspace
terminal.

Then choose what the agent may do:

- **Read only** is the default. The agent can read projects and threads and see
  the available providers and models. It cannot change anything.
- **Supervised** through **Full access** also let it start, message and stop
  threads in every project. A thread it starts or steers cannot run with more
  permissions than the mode you chose.

## Claude Code

```sh
claude mcp add --transport http t3 https://<workspace-address>/mcp
claude mcp login t3
```

`claude mcp login` opens the sign-in page in your browser. On a machine
without a browser, add `--no-browser`, open the printed URL elsewhere, and
paste the final URL back when asked. `claude mcp list` shows `t3` as connected
once you approve.

## Codex

```sh
codex mcp add t3 --url https://<workspace-address>/mcp
codex mcp login t3
```

`codex mcp login --no-browser` prints the sign-in URL instead of opening it.
`codex mcp list` shows `t3` with OAuth once you approve.

## Other agents and bots

Any agent that supports remote MCP servers over HTTP with OAuth can connect. Give
it the MCP URL and choose OAuth, and the agent finds the sign-in settings itself.
Agents without OAuth support cannot connect.

## Scripts in your workspace

In a workspace terminal, `t3 thread` uses the same tools without a sign-in:

```sh
id=$(t3 thread start . "Find why the tests are slow")
t3 thread send "$id" "Now fix it" --wait
t3 thread show "$id"
t3 thread list
```

`.` means the project that contains the current folder; a project id also
works. A new thread uses the project's default model and permission mode, and
runs in the project folder unless you pass `--worktree <base-branch>`. `send`
never interrupts: a busy thread gets the message as its next turn. Pass `-` as
the message to read it from stdin.

`--wait` prints the agent's reply. It exits 1 when the run fails or stops, and
2 when the agent waits for an answer you give in the app. Add `--json` for a
result that always includes the thread id.

## Remove an agent

Approved agents appear under **Settings → Sharing & access** like other clients.
Revoke one there to cut off its access immediately. A sign-in lasts 30 days;
after that the agent asks you to approve it again.
