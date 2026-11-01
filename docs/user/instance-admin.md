# Run an O3 instance

An O3 instance hosts O3 Code for your organization on one Linux server. People
sign in with an email and password, and each person gets their own workspace:
a container with their projects, terminal, and coding agents. Every workspace
and the instance itself are devices on your Tailscale tailnet, so the apps reach
them directly and nothing is exposed to the internet.

## Before you start

- A Linux server with Docker and Docker Compose. Plan roughly 2 CPUs and 4 GB
  of memory per running workspace, plus disk for their projects. Resource limits
  are caps, not reservations, so the instance lets them add up to more than the
  server has; it works until the workspaces need it all at once.
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
   single-use key for each new workspace and to remove a deleted workspace's device.

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
- disable them, which signs them out and stops all their workspaces but keeps their files,
- start, stop, restart, or recreate a workspace,
- change a workspace's tools or resource limits, which recreates it,
- read a workspace's recent logs, and sign out individual devices,
- delete them with all their workspaces, optionally with their files.

**Recreate** replaces the container but keeps the workspace's home folder, so
projects, settings, and agent sign-ins survive. Software someone installed
outside their home folder does not.

## Give someone more workspaces

A user can have several workspaces, for example one per project. Each is a
separate container with its own files, tailnet address, tools, resource limits,
and agent sign-ins. On the user's page, choose **Add workspace** and give it a
name, such as "Frontend". Its tailnet address is built from the user's email
and that name, like `o3-alice-frontend`, and doesn't change if you rename the
workspace later.

The first workspace is the user's default, the one their apps open first. Use
**Make default** on another workspace to change it. The apps list every
running workspace, and the user can restart each one from **Settings →
Account**.

**Delete workspace** removes one workspace, optionally with its files. A user
always keeps at least one; to remove the last, delete the user.

## Share agent sign-ins between workspaces

**Settings → Admin → Sign-in sync** links workspaces so they share their
Claude Code, Codex, Grok, and OpenCode sign-ins, and nothing else: settings,
history, projects, API keys, and GitHub stay separate. Create a group, then add
workspaces from any user, or pick a group from a workspace's **Sign-in sync**
row on the user's page. A workspace can be in one group at a time.

Signing in or out in one workspace reaches the rest of the group within a few
seconds. A workspace that joins takes the group's sign-ins and keeps its own as
a `.o3-before-sync` file next to each one; if the group has none yet, the
joining workspace's sign-ins become the group's. Removing a workspace, or
deleting the group, leaves each workspace signed in with what it has.

Personal subscriptions may not allow sharing between people. Some agents
replace their sign-in when they refresh it, so two workspaces refreshing at the
same moment can occasionally sign one of them out; signing in again fixes it.
Workspaces need the workspace image from this release before they sync.

## Defaults, upgrades, and the audit log

**Settings → Admin → Tools & defaults** sets the tools and resource limits new
workspaces start with and the workspace image. After you build or pull a new image,
**Upgrade all** recreates every running workspace that uses an older one. Build
the instance and workspace images from the same release: workspaces added after
an upgrade need the matching workspace image.

**Settings → Admin → Audit log** records sign-ins, failed sign-ins, and every
admin action.

## Backups

Everything lives in Docker volumes: `instance-data` for accounts and settings,
and one `o3-home-<workspace id>` volume per workspace. A workspace created
before users could have several uses its user's id here. Back them up with your usual
volume backup tool. The `o3-tailscale-*` volumes only hold tailnet identities and
are recreated if lost.

## If you're locked out

Run these on the server:

```sh
docker compose exec instance t3 instance admin list
docker compose exec instance t3 instance admin reset-password --email you@example.com
```

`reset-password` prints a temporary password and re-enables the account.
