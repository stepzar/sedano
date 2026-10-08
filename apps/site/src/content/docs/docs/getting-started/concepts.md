---
title: Concepts
description: Sessions, turns, the prompt queue, durable agents, where Sedano stores its data, and why unknown values are never shown as zero.
sidebar:
  order: 4
---

## Sessions

A session is one conversation with one harness in one workspace, on one machine.
Sedano stores it with its own id and also records the harness's native id, so
the conversation can be resumed by the CLI itself. Each session shows a resume
command (for example `claude --resume <id>`), so it is never locked inside
Sedano.

A terminal tab is also a session, of a different kind: it has no turns, only a
`tmux` pane.

Archiving a session stops it if it is running and hides it from the sidebar and
the tabs. Nothing is deleted; it can be restored from the import picker.

## Turns

A turn is one prompt and everything it caused. Its state is one of:

| State | Meaning |
|---|---|
| `running` | the agent is working |
| `waiting_agents` | the main loop finished, but subagents it started are still working (Claude Code only) |
| `completed` | the harness reported a result |
| `stopped` | you stopped or interrupted it |
| `failed` | the harness reported an error, or the prompt could not be delivered |

The server decides the state from what the harness reports, the same way for
every harness.

## The prompt queue

A prompt sent while a turn is running is not lost. It is written to disk and
sent at the start of the next turn, and the composer shows how many are waiting.
A stop or interrupt clears the queue. If the server refuses a prompt, the text
goes back into the composer.

Claude Code takes input mid-turn, so there a second prompt opens its own turn at
once instead of waiting.

## Durable agents

Claude Code and Command Code sessions run as detached processes whose input and
output are files under `~/.sedano/agents`. Quitting the app or restarting the
server does not end them; the next server finds them again and catches up from
where it left off.

ACP agents (Codex, Gemini CLI, Grok, opencode) are child processes of the
server. Restarting the server interrupts their running turn.

Terminal tabs survive because `tmux` owns the shell.

## Where data lives

The installed app keeps everything in `~/.sedano`:

| Path | Contents |
|---|---|
| `sedano.db` | sessions, events, the prompt queue, pending questions, usage readings, settings (one SQLite file) |
| `attachments/` | images and documents you attached, each owned by a row so deleting a session deletes them |
| `agents/` | durable agent processes: pid, input fifo, output logs (on an SSH host, in that host's `~/.sedano/agents`) |
| `durable/` | how far the server has read each durable agent's output |
| `config.json` | the SSH hosts you enabled |
| `ssh/` | ssh connection-sharing sockets |
| `remote.json` | remote mode and paired devices (mode `0600`, device tokens stored as hashes) |
| `tailscale/` | the separate Tailscale instance used for remote access |
| `server.log` | the server's output when started by the app |

A development copy uses `~/.sedano-dev` instead. Harness credentials stay where
each CLI keeps them; Sedano does not copy them. See
[Data and backups](/docs/updates/data-and-backups/).

## Unknown is not zero

A value a harness never reported is shown as unknown, not as zero:

- A harness that publishes no cost shows no price, not `$0.0000`.
- A context ring with no reported window is marked unknown; one whose window is
  inferred from the model name reads as "about".
- Token counters a protocol never sent stay unknown.
- A capability a harness lacks is absent from the UI. Missing subagent cards on
  a non-Claude session mean "this harness does not report that", not "there
  were none".

The same rule applies to the [capability matrix](/docs/harnesses/overview/):
a "no" means Sedano does not do it today.
