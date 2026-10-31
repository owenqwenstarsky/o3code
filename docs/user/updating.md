# Updating O3 Code

## Your workspace

Your administrator upgrades workspaces to new O3 Code releases; see
[Run an O3 instance](./instance-admin.md#defaults-upgrades-and-the-audit-log). An
upgrade restarts your workspace, which interrupts running agents and terminal
commands. Your projects, threads, settings, and agent sign-ins stay.

**Settings → Maintenance → Continue threads after restarts** is on by default.
It resumes supported active threads after an upgrade, crash, or workspace
restart. Terminal commands may still be interrupted, and threads without saved provider resume state need a new message.
A thread that finished its turn to wait on a subagent, a background task, or a
command or monitor the agent said it was waiting on is woken and told that this work
stopped. Other background shells and monitors, such as a dev server and its
watchdog, do not wake it; the thread learns about them with your next message.
A thread is not resumed while it waits for your approval, answer, or secret, or
while it is archived, snoozed, or settled. After three automatic resumes in a row,
the thread waits for your next message.

## When versions don't match

An app and a workspace must speak the same protocol. If they do not, the connection is refused
rather than running half-upgraded, with a notice saying which side is behind. Update the desktop
app, or ask your administrator to upgrade your workspace, then reconnect.

## The desktop app

When a newer desktop app is available, the update button at the bottom of the sidebar installs it
and restarts the app. If you built the app from source, build it again; see
[Get started](./install.md#desktop-app). The web app always matches your instance.

## Update providers

**Settings → Providers** shows provider updates for the selected environment.
**Update all** updates every outdated provider at once. Hover it to see which providers it will update. Providers that only
offer a manual update command are not included.

After a successful provider CLI update, O3 Code refreshes model discovery for
every enabled instance of that provider using its own configuration. Connected
clients receive the refreshed catalogs automatically. Provider update checks
must be enabled to download the latest O3 Code model catalog.

Provider updates do not restart running chats. An existing session can keep
using the previous CLI until it ends. If discovery fails, check the provider
status and refresh it again.
