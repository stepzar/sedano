---
title: Grok
description: How Sedano runs the Grok CLI over ACP, which flags carry model and effort, and what is not supported.
sidebar:
  order: 5
---

## How it is launched

```bash
grok agent [-m <model>] [--reasoning-effort <level>] stdio
```

Model and effort are flags of `agent`, set when the process starts. It signs in
on first use.

## Supported

- **Models and effort:** what the agent reports, passed as flags at spawn.
- **Approval modes:** `default`, `acceptEdits`, `plan`, `bypassPermissions`.
- **Questions:** permission requests and ACP elicitation forms become a card.
- **Images:** if the agent says it accepts them at handshake.
- **Resume:** when the agent advertises `loadSession`.
- **SSH hosts.**

## Not supported

- Subagent cards.
- Mid-turn input: a second prompt waits in the queue.
- A usable resume command: the hint shown is the label `grok (ACP)`, not a
  command.
- Usage limits. Grok has no usage API, and the limits panel says
  **No Usage API**.

## Install and update

Install the Grok CLI following its vendor's instructions, so that `grok` is on
your path. Sedano checks for updates with `grok update --check` and updates with
`grok update`.
