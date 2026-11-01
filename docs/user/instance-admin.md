# Run an O3 instance

An O3 instance hosts O3 Code for your organization on one Linux server. People
sign in with an email and password and work in workspaces: containers with
projects, a terminal, and coding agents. A workspace can be one person's or
shared by a team. Every workspace
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
role, then either a new workspace with the tools to install, such as Claude
Code, Codex, or Cursor CLI, or existing workspaces to add them to. O3 Code
shows a temporary password once; share it privately. The new user signs in from
the web app at the instance address or from the desktop app, chooses their own
password, and opens their workspace. A new workspace's first start installs its
tools and can take a few minutes.

People sign in to their coding agents from inside a workspace, in
**Settings → Providers** or the terminal. Those sign-ins stay in that
workspace, and everyone on it uses them.

From a user's page you can:

- reset their password, which signs them out everywhere,
- disable them, which signs them out and stops the workspaces nobody else
  active is on, keeping their files,
- add them to a workspace, remove them from one, or change their default,
- sign out individual devices,
- delete them. Their workspaces and files stay; any left with nobody active
  are stopped.

## Workspaces and members

**Settings → Admin → Workspaces** lists every workspace and who is on it. Each
is a separate container with its own files, tailnet address, tools, resource
limits, and agent sign-ins. Choose **New workspace** to create one, give it a
name such as "Frontend", and pick its members. Its tailnet address is built
from that name, like `o3-frontend`, and doesn't change if you rename it later.

Everyone on a workspace shares it: the same projects, threads, terminal, files,
and agent sign-ins. Give people separate workspaces when they shouldn't see
each other's work. Use **Add member** and **Remove** on a workspace to change
who's on it. Someone you remove loses access within about 30 seconds. A
workspace left with nobody active on it stops but keeps its files; adding
someone starts it again.

A user's first workspace is their default, the one their apps open first. Use
**Make default** on their page to change it. The apps list every workspace
they're on, and they can restart each one from **Settings → Account**.

From a workspace you can also:

- start, stop, restart, or recreate it,
- change its tools or resource limits, which recreates it,
- read its recent logs,
- delete it, optionally with its files.

**Recreate** replaces the container but keeps the workspace's home folder, so
projects, settings, and agent sign-ins survive. Software installed outside the
home folder does not.

## Share agent sign-ins between workspaces

**Settings → Admin → Sign-in sync** links workspaces so they share their
Claude Code, Codex, Grok, and OpenCode sign-ins, and nothing else: settings,
history, projects, API keys, and GitHub stay separate. Create a group, then add
workspaces to it, or pick a group from a workspace's **Sign-in sync** row on
the Workspaces page. A workspace can be in one group at a time.

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

Everything lives in Docker volumes: `deploy_instance-data` (Compose prefixes it with the
project name, `deploy` by default) for accounts and settings,
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
