---
title: Overview and capability matrix
description: Which coding-agent CLIs Sedano drives, how each is connected, and a cell-by-cell table of what each one supports.
sidebar:
  order: 1
  label: Overview
---

A **harness** is a coding-agent CLI that Sedano starts and talks to. Sedano
connects to each one through the most capable machine-readable interface the CLI
offers:

| Harness | Binary | How Sedano talks to it |
|---|---|---|
| [Claude Code](/docs/harnesses/claude-code/) | `claude` | native adapter over `stream-json`, plus its transcript files |
| [Codex](/docs/harnesses/codex/) | `codex-acp` | ACP, through the Codex ACP bridge |
| [Gemini CLI](/docs/harnesses/gemini/) | `gemini` | ACP (`gemini --acp`) |
| [Grok](/docs/harnesses/grok/) | `grok` | ACP (`grok agent stdio`) |
| [opencode](/docs/harnesses/opencode/) | `opencode` | ACP (`opencode acp`) |
| [Command Code](/docs/harnesses/command-code/) | `cmd` | headless NDJSON, one process per turn |
| [Freebuff](/docs/harnesses/freebuff/) | `freebuff` | none; opens as a terminal tab |
| [Terminal tab](/docs/harnesses/terminal/) | `tmux` | `tmux`, locally or over ssh |

ACP is the [Agent Client Protocol](https://agentclientprotocol.com). The four
ACP agents share one client in Sedano, so they behave alike.

## Capability matrix

Read off the code, not off vendor pages. "No" means Sedano does not do it today,
either because the protocol cannot express it or because the adapter does not
translate it.

| | Claude Code | Command Code | ACP agents |
|---|---|---|---|
| **Model selection** | the CLI's aliases, as `--model` | what `cmd --list-models` reports on that machine | what the agent reports at handshake |
| **Reasoning effort** | `--effort` | `--effort`, downgraded or dropped when the CLI refuses it | when the agent publishes a thought-level option; Grok via `--reasoning-effort` |
| **Approval modes** | `default`, `acceptEdits`, `auto`, `manual`, `plan`, `bypassPermissions` | `default`, `acceptEdits`, `plan`, `bypassPermissions` | `default`, `acceptEdits`, `plan`, `bypassPermissions` |
| **Images** | yes | no | what the agent says at handshake |
| **Subagent visibility** | yes | no | no |
| **Questions and approvals** | yes | no | yes |
| **Resume** | yes | yes | only if the agent supports `session/load` |
| **Mid-turn prompts** | sent at once | queued | queued |
| **Usage limits** | yes | yes | Codex and opencode only |
| **SSH hosts** | yes | yes | yes |

Freebuff and terminal tabs are left out of the table: both are `tmux` panes, so
none of these rows apply except SSH hosts, which both support. See
[Freebuff](/docs/harnesses/freebuff/) and [Terminal tabs](/docs/harnesses/terminal/).

On an SSH host the binary is resolved on that host and the process runs there,
only for hosts you enabled. See [SSH hosts](/docs/remote/ssh-hosts/).

## Notes on the cells

- **Images depend on the model too.** The harness sets a ceiling (Command
  Code's headless pipe carries text only) and each model answers for itself
  under it. The composer checks both before it accepts an image.
- **Subagents are Claude Code only** because it is the only harness that writes
  its subagents' work somewhere Sedano can read it. No other harness gets
  invented subagent cards.
- **`auto` and `manual` are only offered for Claude Code.** For the other
  harnesses they would behave exactly like `acceptEdits` and `default`, so the
  picker shows the four modes that differ.
- **Claude Code's `dontAsk` mode is not selectable.** Sedano's shared model of
  approval modes does not include it yet.
- **Resume commands.** Each session shows the native command to continue it
  outside Sedano. Grok's is only a label, and the ACP ones are not prefixed with
  `ssh <host>` for remote sessions.

## Showing and hiding harnesses

Every installed harness is offered by default. You can hide one per machine in
**Settings > Machines**; see [Harnesses and machines](/docs/settings/harnesses/).

## Not supported yet

The Piagent CLI, and an agent bus that would let sessions message each other.
