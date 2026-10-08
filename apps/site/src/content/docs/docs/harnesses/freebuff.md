---
title: Freebuff
description: Freebuff has only a terminal UI, so Sedano opens it as a tmux terminal tab instead of a chat.
sidebar:
  order: 8
---

Freebuff has no print mode, no JSON output and no ACP: only its terminal UI.
Choosing it opens a [terminal tab](/docs/harnesses/terminal/) running
`freebuff` in the workspace. A chat view that never receives anything would be
misleading, so there is none.

Two terminal presets exist:

- **Freebuff**: start a new session in this workspace.
- **Freebuff · continue**: `freebuff --continue`, pick up the last conversation
  in this workspace.

## What you get

Everything a terminal tab has: it runs in `tmux`, survives closing the app, and
works on SSH hosts.

## What you do not get

Model, effort and approval pickers, question cards, subagent cards, token
counts, turn states and usage limits (the panel says **No Usage API**).

## Install

```bash
npm install -g freebuff
```

When Sedano is launched from Finder it also looks for `freebuff` in your nvm
Node versions, newest first.
