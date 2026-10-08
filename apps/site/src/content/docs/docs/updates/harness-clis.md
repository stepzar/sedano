---
title: Updating harness CLIs
description: How Sedano checks installed harness CLIs for new versions and models, on this Mac and on SSH hosts, and how an update is applied.
sidebar:
  order: 2
---

Sedano never installs anything on its own. It checks, and you decide.

## Automatic checks

At startup and at least once a day while open, Sedano checks the installed
harnesses on this Mac and on every enabled SSH host, in the background. It
refreshes model lists and compares installed versions with the latest releases.
Results are cached across restarts.

| Harness | Version check |
|---|---|
| Claude Code | `@anthropic-ai/claude-code` on npm |
| Codex | both `@agentclientprotocol/codex-acp` and `@openai/codex` on npm |
| Gemini CLI | `@google/gemini-cli` on npm |
| opencode | `opencode-ai` on npm |
| Command Code | `command-code` on npm |
| Freebuff | `freebuff` on npm |
| Grok | `grok update --check` |

Codex counts as outdated when either the bridge or the CLI is, because the
bridge takes its models from the CLI.

## Updating

- **One harness:** in the model menu, **Refresh models & version**.
- **Every machine:** **Settings > Machines > Harness updates** has **Refresh
  models & versions** and **Update all available** (with a confirmation).

How the update runs:

- Claude Code updates with `claude update`, Grok with `grok update`.
- npm-managed CLIs are updated in their own installation prefix, found from
  where the binary actually lives. This keeps an nvm install updating in nvm
  rather than in a system `/usr/local` that a GUI app might otherwise pick.
- opencode uses npm when it was installed with npm, `opencode upgrade`
  otherwise.

Each update has a 3-minute limit. Afterwards Sedano checks again, and an update
that did not take effect is reported as a failure next to the control instead
of being shown as done.

The commands are fixed on the server; the UI only sends which harness to update.

## When the check cannot answer

The status becomes **unknown**, with the reason: the CLI is not installed, its
version could not be read, `npm` is missing, the registry could not be reached,
or the installation that owns the binary could not be identified. Unknown is
not "up to date".
