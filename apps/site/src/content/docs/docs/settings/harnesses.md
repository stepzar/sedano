---
title: Harnesses and machines
description: How Sedano finds harness binaries, how to show or hide harnesses per machine, and the terminal presets.
sidebar:
  order: 2
---

## Settings > Machines

One card for **This Computer** and one per `Host` in `~/.ssh/config`. Each card
shows:

- whether the machine is reachable, with a button to scan it again;
- for SSH hosts, the switch that allows Sedano to use it (see
  [SSH hosts](/docs/remote/ssh-hosts/)) and a button to test the connection;
- the harnesses found there, with their version and update status;
- a switch per harness to offer it in the pickers or hide it;
- a colour for the machine, used to tell machines apart in tabs.

Hiding is per machine: hiding Gemini on this Mac does not hide it on a server.
A newly installed harness is offered automatically.

**Harness updates**, at the top of the section, is covered in
[Updating harness CLIs](/docs/updates/harness-clis/).

## How binaries are found

There is no field to type a path. Sedano looks the binary up by name
(`claude`, `cmd`, `codex-acp`, `gemini`, `grok`, `opencode`, `freebuff`, `tmux`).

An app opened from Finder does not get your shell's `PATH`, and Sedano does not
source `.zshrc`. It adds these directories to the search instead:

- `~/.local/bin`, `~/bin`, `~/.bun/bin`, `~/.volta/bin`, `~/.cargo/bin`,
  `~/.npm-global/bin`, pnpm's directories, `~/.asdf/shims`, `~/.mise/shims`;
- each vendor's own directory: `~/.claude/bin`, `~/.codex/bin`,
  `~/.commandcode/bin`, `~/.opencode/bin`, `~/.gemini/bin`, `~/.grok/bin`;
- every installed nvm Node version, newest first;
- `/opt/homebrew/bin`, `/usr/local/bin` and the system directories.

If your CLI lives elsewhere, put a symlink into `~/.local/bin`. After installing
something, use **Settings > Advanced > Installed software > Scan again**.

On an SSH host the binary is resolved on that host.

## Terminal presets

What a new terminal tab can start: Shell, Freebuff, Freebuff · continue, the
Claude Code TUI and the Codex TUI. A preset is offered only when its binary is
found. See [Terminal tabs](/docs/harnesses/terminal/).
