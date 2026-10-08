---
title: Terminal tabs
description: Terminal tabs are tmux sessions on this Mac or on an SSH host; they survive closing the app and replay the screen when reopened.
sidebar:
  order: 9
---

A terminal tab is a `tmux` session on the target machine, this Mac or an
enabled SSH host. Output streams from `tmux pipe-pane`, keystrokes go through
`tmux send-keys`, and reopening a tab replays the current screen. Because tmux
owns the shell, the work survives closing the tab, quitting the app, a crash or
the laptop sleeping.

`⌘T` opens one on the machine you are looking at. The launchpad offers presets:

| Preset | Runs |
|---|---|
| Shell | your login shell |
| Freebuff | `freebuff` |
| Freebuff · continue | `freebuff --continue` |
| Claude Code | the official `claude` terminal UI |
| Codex | the official `codex` terminal UI |

A preset is offered only when its binary is found. It only decides what tmux
starts the first time.

## Quick terminal

An agent session has a docked quick terminal (drag its top edge to resize). It
belongs to that session: it stays out of the sidebar and is deleted with it.

## Requirements

`tmux` on every machine where you open terminal tabs:

```bash
brew install tmux
```

Without it, opening a terminal tab fails with
`tmux not found: terminal tabs need tmux (brew install tmux)`.

## What a terminal tab is not

It has no turns, no approval modes, no question cards and no token counts. A
shell asks you directly.

## Closing versus deleting

Closing a tab leaves its tmux session running. Deleting the session in Sedano
kills it. Sedano's tmux sessions are named `sedano-<8 hex>`; it never touches a
tmux session you started yourself. You can attach to one from any terminal:

```bash
tmux ls
tmux attach -t sedano-1a2b3c4d
```
