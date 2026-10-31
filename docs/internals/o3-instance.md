# O3 instances

An O3 instance (`t3 instance serve`, [apps/server/src/instance](../../apps/server/src/instance))
is a control plane above ordinary T3 servers. It owns accounts, the admin API, and one Docker
workspace per user. Each workspace runs an unmodified `t3 serve`. Clients reach workspaces
directly; the instance never proxies their traffic. See the [admin guide](../user/instance-admin.md)
for deployment.

## Each workspace is its own tailnet device

A workspace joins the tailnet with a single-use, tagged auth key that the instance mints, and
serves O3 Code through Tailscale Serve under its own `ts.net` name. That gives every workspace a
separate HTTPS origin, so HTML renders, previews, and guest pages from one user's workspace cannot
act as another user or as an admin who opens them. A shared proxy hostname would lose that
isolation. Do not route workspaces through the instance's origin.

Tailscale runs in kernel mode (`NET_ADMIN`, `/dev/net/tun`) so tools inside the workspace reach
the tailnet like any device, and so the workspace can reach the instance to check sign-ins.
Userspace mode would need a proxy for every outbound tailnet connection.

## Two tokens, two audiences

Sign-in returns an instance session (`o3s_`), accepted only by `/o3/api`. The client then mints a
workspace token (`o3w_`) bound to the user's workspace and to the session that minted it, and
saves it as an ordinary bearer credential for that environment. A workspace never receives an
instance session, so a token that leaks inside a workspace (for example to a prompt-injected agent)
cannot call admin APIs. Both are rows in the reused [SessionStore](../../apps/server/src/auth/SessionStore.ts),
told apart by subject (`o3-user:` and `o3-ws:<user>:<session>`), which gives listing, expiry, and
revocation for free. Revoking a session ends the workspace tokens minted from it because
introspection checks the parent session.

## Workspaces check tokens with the instance

[O3Authority](../../apps/server/src/auth/O3Authority.ts) handles `o3w_` bearers in the workspace's
`EnvironmentAuth`. It introspects the token with the instance, proving itself with a per-workspace
secret the instance injects at container creation, and maps the token to a local shadow session.
Everything downstream (WebSocket tickets, scope checks, signed asset URLs, the sessions list) keeps
working because it only ever sees a normal session.

Results are trusted for 30 seconds, and known tokens are rechecked on that interval because a live
socket makes no new requests. That bounds how long a revoked user keeps access. A brief instance
outage keeps recently validated sessions alive for five minutes rather than disconnecting everyone;
an unreachable instance maps to a server error, not an invalid credential, so clients retry instead
of discarding their token.

## The instance reuses the T3 server

The instance is a mode of the `t3` binary, not a separate app: it reuses the SQLite setup and
migrations, `SessionStore`, the static web route, CORS, and Tailscale Serve. Its own tables live
beside the T3 tables under a separate migration history (`o3_instance_migrations`), so the T3
migration list stays the only one that decides T3 schema.

Docker is reached through its Engine API over the unix socket
([DockerEngine](../../apps/server/src/instance/DockerEngine.ts)), and every workspace operation for a
user is serialized. The database records intent (`provisioning`, `starting`, `stopped`); a reconcile
loop compares it with `docker inspect` and probes workspaces that are not yet confirmed running.

## Clients

The web app is served by the instance and the desktop app connects to it; both treat the user's
workspace as the primary environment, registered as a saved bearer environment whose connection id
starts with `o3:` ([account.ts](../../packages/client-runtime/src/instance/account.ts)). There is
never an environment on the user's own machine, so code that needs local files, the desktop
preview browser, or local media checks `localEnvironmentIdAtom`, which is always empty, not the
primary.
