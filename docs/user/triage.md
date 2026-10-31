# Triage an issue

Triage lets your own coding agent investigate a O3 Code problem. The agent
reads the logs and state of your workspace, checks the O3 Code source for that
version, finds known issues, and can help you write a good GitHub issue. It asks
before it applies a fix or posts anything.

## In the app

Open the command palette and choose **Triage an issue**. A new thread with no
project opens, with the triage playbook linked in the message. Choose any
provider, describe what went wrong after the link, and send. O3 Code gets the
source for the server's version while you write.

Triage runs in your workspace, the environment of the thread or draft you have open. The agent
runs inside that O3 Code server, so it gives you any restart steps and does not do them itself.

## In a terminal

If triage does not work in the app, run this in a workspace terminal:

```sh
t3 triage
```

It starts Claude Code or Codex in your terminal with the same instructions.
