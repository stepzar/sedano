---
title: Architecture
description: How Sedano is built - the server, UI, desktop shell and shared event types, the adapter and driver contract, transports, the socket and storage.
sidebar:
  order: 2
---

Four pieces, one contract between them.

```
apps/server        Bun HTTP + WebSocket server, SQLite store, one process
  harnesses/       adapters and drivers: claude, commandcode, acp/*, terminal
  usage/           quota readers: claude, codex, commandcode, opencode
apps/ui            React 19 + Vite, one WebSocket to the server
apps/desktop       Tauri shell: attaches to a running server or starts the sidecar
packages/shared    the normalized event and wire types, the only contract
```

## The normalized domain

`packages/shared/src/events.ts` is the whole vocabulary. A session event is one
of `user`, `assistant`, `thinking`, `tool`, `tool_result`, `file_change`,
`subagent_start`, `subagent_end`, `request`, `system`, `result`, `error`.
Nothing else reaches the UI.

Events are keyed by `(session_id, id)`, because harness-native ids are only
unique inside their own harness. A turn id is attached when the event is stored,
so a late transcript line still belongs to the turn that caused it.

The UI imports only from `packages/shared`, never from the server. If a harness
cannot produce a signal, the card is absent instead of the UI growing a branch
per vendor.

## Adapters and drivers

Defined in `apps/server/src/harnesses/types.ts`:

- An **Adapter** is what a harness is: id, label, whether it is installed
  (`detect`), which models it offers on a machine, whether it can take images,
  and how to start a session (`create`). It is registered in `registry.ts`.
- A **Driver** is one live session: `send`, `interrupt`, `configure`, `stop`,
  and only where the protocol has them `answerQuestion`, `write`, `resize`,
  `snapshot`, `destroy`. It reports everything through **DriverHooks**
  (`event`, `delta`, `status`, `usage`, `tokens`, `nativeId`, `limits`, and so
  on). Translating its protocol into those calls is its entire job.

The ACP agents share one driver and one client; a new ACP agent is a row in
`ACP_AGENTS`. Claude Code and Command Code have their own drivers because their
protocols are their own.

`permissionModesFor` in `registry.ts` is the single source for which approval
modes a harness has. The server publishes it and the picker offers exactly that.

Model, effort and approval mode are requests a harness can refuse. The manager
keeps them as pending until the harness confirms them or a process is started
with them, so what the UI shows as in effect is in effect.

## Transport and hosts

Every driver runs against a `Transport` bound to a host, or to this machine.
Spawning, reading transcripts, listing directories and resolving binaries all
go through it, so drivers never branch on local versus remote. Remote work uses
the system `ssh` with `BatchMode=yes`. Failures are kinds (`unreachable`,
`timeout`, `not_found`, `permission`, `command_failed`), never an empty result.
`assertAuthorizedHost` is the single gate for the host allowlist.

## The socket

One WebSocket carries everything (`packages/shared/src/wire.ts`). Mutating
commands carry a `cid`, kept across retries, so a command replayed after a
reconnect is recognised instead of carried out twice; this survives a server
restart. The server answers each with an ack (`ok`, or `busy`, `gone`,
`unsupported`, `rejected`, `not_pending`, `failed`), and the UI acts on the
ack, not on the click. Terminal keystrokes carry no `cid` on purpose.

## Turn state

The manager decides a turn's state from the turn ledger, the same way for every
harness. Drivers only report facts.

```
running ──► waiting_agents ──► completed
   │  ▲            │
   │  └────────────┘  (a background agent woke the main loop)
   ├──► stopped       user stop, interrupt
   └──► failed        harness error, delivery failure
```

A turn cannot complete while one of its child agents is still running.

## Storage

One SQLite file, `~/.sedano/sedano.db` (`SEDANO_HOME` overrides the directory,
which is how every test isolates itself). Tables: `sessions`, `events`,
`prompt_queue`, `requests`, `attachments`, `limits`, `kv`, plus the execution
ledger `commands`, `prompts`, `turns`, `actors`. Migrations run at open, in a
transaction, and are idempotent. There is no schema version number.

## Remote access

The server only binds `127.0.0.1`. A phone reaches it through `tailscale serve`.
Every request is classified before routing as local (loopback Host, no proxy
headers), remote (remote mode on, the exact tailnet name, the allowed login) or
forbidden. Remote requests need a device token. See
[Security notes](/docs/remote/security/).

The full version, with the reasoning behind each rule, is
[docs/architecture.md](https://github.com/stepzar/sedano/blob/master/docs/architecture.md)
in the repository.
