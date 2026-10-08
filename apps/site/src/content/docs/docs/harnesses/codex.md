---
title: Codex
description: How Sedano runs Codex through the codex-acp bridge, what is supported, and how Codex usage limits are read from local rollout files.
sidebar:
  order: 3
---

## How it is launched

Codex itself does not speak ACP. Sedano starts the ACP bridge, `codex-acp`, which
drives the Codex CLI. One bridge process lives for the whole session, so your
next message continues the same conversation.

## Supported

- **Models and effort:** the list the agent reports at handshake, set through
  ACP config options. The bridge takes its models from the Codex CLI, so both
  need to be current to see new models.
- **Approval modes:** `default`, `acceptEdits`, `plan`, `bypassPermissions`.
- **Questions:** `session/request_permission` and `elicitation/create` become
  a card.
- **Images:** if the agent says it accepts them at handshake.
- **Resume:** when the agent advertises `loadSession`. The native resume hint is
  `codex resume <id>`.
- **SSH hosts.**

## Not supported

- Subagent cards.
- Mid-turn input: a second prompt waits in the queue.
- A server restart interrupts a running turn (ACP agents are not durable).

## Usage limits

Read from the newest rollout files in `~/.codex/sessions` on this Mac. No
credentials and no network request are involved.

## Install

```bash
npm install -g @openai/codex @agentclientprotocol/codex-acp
codex   # log in once
```

The update check covers both packages; see
[Updating harness CLIs](/docs/updates/harness-clis/). A terminal tab can also
run the official Codex TUI (preset **Codex**).
