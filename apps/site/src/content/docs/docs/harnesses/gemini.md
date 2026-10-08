---
title: Gemini CLI
description: How Sedano runs Gemini CLI over ACP, what is supported, and why it shows no usage limits.
sidebar:
  order: 4
---

## How it is launched

```bash
gemini --acp
```

One process per session. Gemini checks for updates and loads extensions before
it answers, so Sedano waits up to three minutes for the first handshake.

## Supported

- **Models and effort:** what the agent reports at handshake.
- **Approval modes:** `default`, `acceptEdits`, `plan`, `bypassPermissions`.
- **Questions:** permission requests and ACP elicitation forms become a card.
- **Images:** if the agent says it accepts them at handshake.
- **Resume:** when the agent advertises `loadSession`. The native resume hint is
  `gemini --resume`.
- **SSH hosts.**

## Not supported

- Subagent cards.
- Mid-turn input: a second prompt waits in the queue.
- Usage limits. Gemini CLI has no usage API, and the limits panel says
  **No Usage API**.

## Install

```bash
npm install -g @google/gemini-cli
gemini   # log in once
```
