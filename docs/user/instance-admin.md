# Run an O3 instance

An O3 instance hosts O3 Code for your organization on one Linux server. People
sign in with an email and password, and each person gets their own workspace:
a container with their projects, terminal, and coding agents. Every workspace
and the instance itself are devices on your Tailscale tailnet, so the apps reach
them directly and nothing is exposed to the internet.

## Before you start

- A Linux server with Docker and Docker Compose. Plan roughly 2 CPUs and 4 GB
  of memory per active user, plus disk for their projects.
- A Tailscale tailnet with **HTTPS certificates** turned on (admin console →
  **DNS**). Workspaces serve O3 Code over HTTPS with their tailnet name.
- Everyone who uses O3 Code needs Tailscale on their device.

## Set up Tailscale

1. Merge [`deploy/tailscale-acl.hujson`](../../deploy/tailscale-acl.hujson) into
   your tailnet policy. It lets members reach the instance and workspaces over
   HTTPS, lets workspaces reach the instance, and keeps workspaces from
   reaching each other.
2. Create an **auth key** for the instance: one-off, pre-approved, tagged
   `tag:o3-instance`.
3. Create an **OAuth client** with the `auth_keys` and `devices:core` write
   scopes, allowed to use `tag:o3-workspace`. The instance uses it to create a
   single-use key for each new workspace and to remove a deleted user's device.

## Deploy

From a checkout of this repository on the server:

```sh
cd deploy
cp .env.example .env    # fill in the values below
docker compose --profile build-only build
docker compose up -d
```

| Setting                                              | What it does                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `O3_INSTANCE_NAME`                                   | Shown on the sign-in screen and in the apps.                                                                 |
| `O3_ADMIN_EMAIL`, `O3_ADMIN_PASSWORD`                | The first admin, created on the first start. They choose a new password when they sign in.                   |
| `O3_INSTANCE_TS_AUTHKEY`                             | Joins the instance to the tailnet as `o3` (change with `O3_INSTANCE_TS_HOSTNAME`). Only used the first time. |
| `O3_TS_OAUTH_CLIENT_ID`, `O3_TS_OAUTH_CLIENT_SECRET` | The OAuth client from step 3.                                                                                |
| `O3_WORKSPACE_IMAGE`                                 | The image each workspace runs.                                                                               |

The instance answers at `https://o3.<your-tailnet>.ts.net`. Open it in a browser
on your tailnet and sign in as the first admin.

## Add people

In the app, open **Settings → Admin → Users** and choose **Add user**. Pick a
role and the tools to install, such as Claude Code, Codex, or Cursor CLI. O3 Code
shows a temporary password once; share it privately. The new user signs in from
the web app at the instance address or from the desktop app, chooses their own
password, and their workspace starts. The first start installs their tools and
can take a few minutes.

People sign in to their coding agents from inside their workspace, in
**Settings → Providers** or the terminal. Those sign-ins stay in their workspace.

From a user's page you can:

- reset their password, which signs them out everywhere,
- disable them, which signs them out and stops their workspace but keeps their files,
- start, stop, restart, or recreate their workspace,
- change their tools or resource limits, which recreates the workspace,
- read the workspace's recent logs, and sign out individual devices,
- delete them, optionally with their files.

**Recreate** replaces the container but keeps the user's home folder, so
projects, settings, and agent sign-ins survive. Software someone installed
outside their home folder does not.

## Defaults, upgrades, and the audit log

**Settings → Admin → Tools & defaults** sets the tools and resource limits new
users start with and the workspace image. After you build or pull a new image,
**Upgrade all** recreates every running workspace that uses an older one.

**Settings → Admin → Audit log** records sign-ins, failed sign-ins, and every
admin action.

## Backups

Everything lives in Docker volumes: `instance-data` for accounts and settings,
and one `o3-home-<user id>` volume per workspace. Back them up with your usual
volume backup tool. The `o3-tailscale-*` volumes only hold tailnet identities and
are recreated if lost.

## If you're locked out

Run these on the server:

```sh
docker compose exec instance t3 instance admin list
docker compose exec instance t3 instance admin reset-password --email you@example.com
```

`reset-password` prints a temporary password and re-enables the account.
