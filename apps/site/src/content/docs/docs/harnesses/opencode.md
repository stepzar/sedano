---
title: opencode
description: How Sedano runs opencode over ACP, what is supported, and how its local spend is read with opencode stats.
sidebar:
  order: 6
---

## How it is launched

```bash
opencode acp
```

One process per session, so the conversation continues across messages.

## Supported

- **Models and effort:** what the agent reports at handshake (your configured
  providers).
- **Approval modes:** `default`, `acceptEdits`, `plan`, `bypassPermissions`.
- **Questions:** permission requests and ACP elicitation forms become a card.
- **Images:** if the agent says it accepts them at handshake.
- **Resume:** when the agent advertises `loadSession`. The native resume hint is
  `opencode --session <id>`.
- **SSH hosts.**

## Not supported

- Subagent cards.
- Mid-turn input: a second prompt waits in the queue.

## Usage

opencode has no subscription window: it bills the provider keys you configured.
Sedano runs `opencode stats` and shows the local spend figure. It is a spend
reading, not a quota.

## Install

```bash
npm install -g opencode-ai
```

opencode can also update itself with `opencode upgrade`; Sedano uses npm when the
binary belongs to an npm installation.
