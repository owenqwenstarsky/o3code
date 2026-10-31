# Contributing

O3 Code is a fork of [T3 Code](https://github.com/pingdotgg/t3code). Contributions come from the
maintainers and the agents they direct, using the workflow below.

## Developer setup

See the [development runbook](docs/operations/development.md#first-checkout) for the initial checkout,
development commands, tests, and platform-specific desktop packaging prerequisites. Agents read
[AGENTS.md](AGENTS.md) first.

## Solve one underlying problem per PR

A PR that solves multiple independent problems should be split, even when each fix is useful. Count
the underlying problems, not the linked issues. Several reports may describe the same defect.

Include the contract, server, client, test, and documentation changes needed for that one problem.
Explain their relationship when it is not obvious. An adjacent cleanup, refactor, or second fix needs
its own PR unless it is necessary to solve the same problem.

Follow the [documentation rules](AGENTS.md#documentation). Keep internal docs for decisions and
hard-to-discover constraints. Update user guides when how to use a feature changes; skip descriptions
of obvious controls and cosmetic changes.

## Provide evidence for the changed behavior

Explain how you established the problem, how you checked the change, and what you observed. Give the
relevant reproduction steps, environment, focused test commands or manual checks, and their results.
State what you could not check. "Tests pass" alone does not show that the change works.

Match the evidence to the change. Use focused tests for behavior that can be tested and manual evidence
where appropriate. Run `vp run check:changed` before pushing; CI runs the full suites. Do not run
repo-wide checks just to satisfy this guide.

UI changes need clear before/after screenshots, plus a short recording when motion or timing matters.
Upload evidence to GitHub and link it in the PR. Never commit PR-only screenshots or recordings.

## Pull requests and automation

- Use a conventional commit title in plain language, such as `fix(web): new threads no longer spike CPU`.
- The [PR template](.github/pull_request_template.md) asks for the problem, the change, and the
  verification. If an agent did the work, end with the model and harness that did it.
- CI (`ci.yml`) must pass. Its single `Check` job is the one to require in branch protection.
- Claude reviews each non-draft PR once when it opens. Comment `@claude` on an issue or PR to ask
  for more work or another review. See [GitHub Actions](AGENTS.md#github-actions).
- Report bugs with the [bug report form](.github/ISSUE_TEMPLATE/bug_report.yml).
