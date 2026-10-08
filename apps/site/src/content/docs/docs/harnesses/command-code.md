---
title: Command Code
description: How Sedano runs Command Code headless, one process per turn, why it never asks questions, and how its credits are read.
sidebar:
  order: 7
---

## How it is launched

One process per turn, resumed on the next:

```bash
cmd -p --output-format json --skip-onboarding --trust \
  [--resume <session-id>] [--model <id>] [--effort <level>] \
  <permission flags>
```

Approval modes map onto the CLI's own flags:

| Sedano | Command Code |
|---|---|
| `plan` | `--permission-mode plan` |
| `default` | `--permission-mode standard` |
| `acceptEdits` | `--permission-mode auto-accept` |
| `bypassPermissions` | `--yolo` |

The process runs as a [durable agent](/docs/getting-started/concepts/#durable-agents).

## Supported

- **Models:** whatever `cmd --list-models` reports on the machine the session
  runs on.
- **Effort:** `--effort`. When the CLI refuses a level for a model, Sedano
  downgrades or drops it and says so in the transcript.
- **Resume**, SSH hosts.
- **Tokens:** input, output, cache read and write.

## Not supported

- **Questions.** A headless `cmd -p` run denies what is risky and answers its
  own questions with the first option. Nothing reaches Sedano, so there is no
  "ask me" mode. A session saved with `manual` by an older build runs as
  `standard`, and the transcript says so once.
- **Images.** The headless mode takes a text prompt. Paste images in its own
  terminal UI instead.
- Subagent cards. Mid-turn input (prompts wait in the queue).

## Usage limits

Sedano reads the API key that `cmd login` wrote to `~/.commandcode/auth.json` and
asks Command Code's account API for credits and the 5-hour and weekly windows,
the same numbers its own `/usage` view shows. See
[Limits and usage](/docs/settings/limits/).

## Install

```bash
npm install -g command-code
cmd login
```
