# Architecture

Four pieces, one contract between them.

```
apps/server        Bun HTTP + WebSocket server, SQLite store, one process
  harnesses/       adapters and drivers: claude, commandcode, acp/*, terminal
  usage/           quota readers: claude, codex, commandcode, opencode
apps/ui            React 19 + Vite, one WebSocket to the server
apps/desktop       Tauri shell: attaches to a running server or starts the sidecar
packages/shared    the normalized event and wire types — the only contract
```

## The normalized domain

`packages/shared/src/events.ts` is the whole vocabulary. A `SessionEvent` is
identity plus one `TimelineEvent`: `user`, `assistant`, `thinking`, `tool`,
`tool_result`, `file_change`, `subagent_start`, `subagent_end`, `request`,
`system`, `result`, `error`. Nothing else reaches the UI.

Identity is per session. An event is keyed by `(session_id, id)` in the database,
because harness-native ids are only unique inside their own harness and two
sessions resuming the same native conversation would otherwise overwrite each
other. `turnId` is attached when the event is persisted, not rebuilt from arrival
order: a transcript line or a sidechain event that lands after the next prompt
still belongs to the turn that caused it. `agentId`, `parentAgentId` and
`parentEventId` form the end-to-end actor graph. Claude sidechains propagate
these links and the UI renders the reported parent/child hierarchy without
guessing from arrival order. Adapters that do not expose causal links leave the
fields null; the UI keeps those actors flat rather than inventing a relationship.

Two rules run through the domain and are worth stating on their own.

**Unknown is not zero.** `TokenUsage.unreported` names counters a harness never
published and `usageValue` returns `null` for them; `costReported` and
`contextReported` are `false` when nothing was said. Printing `$0.0000` for a
subscription that publishes no price is a claim about the price.

**State is persisted where the session is.** A pending question used to live only
as a continuation inside the driver, so it died with the process and came back
after a restart as a card that looked clickable. The `requests` table holds the
lifecycle instead — `pending`, `answered`, `expired`, `cancelled` — and so does
the prompt queue, so a prompt the user was told is waiting is still waiting after
a crash. Current Claude and ACP drivers publish a first-class `request` event
with a stable id; answering, stopping or recovering rewrites that event in place
and closes the durable request row. Historical `AskUserQuestion` tool events are
still rendered and closed through their legacy `tool_result`, but new sessions
do not manufacture a tool call for a human decision.

## How a harness plugs in

Two objects, in `apps/server/src/harnesses/types.ts`.

An **Adapter** is what the harness is: its id and label, whether it is installed
(`detect`), which models it offers on a given machine (`models`, optionally
`refreshModels`), whether it can carry an image at all, and how to start a
session (`create`). It is registered in `registry.ts` and that is the only place
that has to know it exists.

A **Driver** is one live session: `send`, `interrupt`, `configure`, `stop`, and
— only where the protocol has them — `answerQuestion`, `write`, `resize`,
`snapshot`, `destroy`. It publishes everything it learns through **DriverHooks**:
`event`, `delta`, `status`, `model`, `usage`, `tokens`, `nativeId`, `resumeHint`,
`title`, `error`, `turnStarted`, `terminal`, `meta`, `limits`. Translating its
own protocol into those calls is the driver's entire job.

The ACP agents share one driver and one client; a new ACP agent is a row in
`ACP_AGENTS`, not a new adapter. Claude and Command Code have their own because
their protocols are their own: Claude's transcript is the only place subagent
internals exist, and Command Code's headless NDJSON is not ACP.

`configure` is asynchronous in effect, not in signature. Model, effort and
approval mode are CLI flags or a protocol exchange the agent can refuse, so the
manager records the request in `SessionSummary.pendingOptions` and only moves it
into the summary when the harness has confirmed it or a process has been started
with it. What the UI shows as in effect is what is in effect.

## Why the UI only sees shared types

`apps/ui` imports from `@shared` and never from `apps/server`. That is not
tidiness: it is what keeps a harness difference from becoming a visual branch. If
a harness cannot produce a signal, the card is simply absent — which reads as
"this harness does not report that" — instead of the UI growing a special case
per vendor. Rendering remains provider-agnostic; registering a new harness still
requires catalog, capability and usage wiring until the registry itself becomes
fully dynamic.

Capabilities go the same way. `permissionModesFor` in `registry.ts` is the single
source for which approval modes a harness really has, the server publishes it on
`HarnessInfo.permissionModes`, and the picker offers exactly what it is given. A
table kept in the UI would go stale the first time a CLI changed its flags.
(`apps/ui/src/models.ts` still mirrors it as the fallback for a server too old to
send the field.)

## Transport and hosts

Every driver runs against a `Transport` bound to a host, or to `null` for this
machine. Spawning a process, reading a transcript, listing a directory, resolving
a binary: all of it goes through that one object, so drivers never branch on
local versus remote. Remote work shells out to the system `ssh` client — the same
one a terminal tab uses — with `BatchMode=yes`, so it fails fast instead of
hanging on a prompt the server has no terminal for.

Failures are kinds, not absences: `unreachable`, `timeout`, `not_found`,
`permission`, `command_failed`. A dropped connection used to be indistinguishable
from an empty directory, which is how a remote file picker showed the local home.

Which hosts exist at all is an explicit opt-in. The candidates are the literal
`Host` aliases in `~/.ssh/config`; the ones sedano may use are the ones ticked in
Settings, stored in `~/.sedano/config.json`. `assertAuthorizedHost` is the single
gate, and every endpoint, session and transport passes through it.

## The socket

One WebSocket carries everything (`packages/shared/src/wire.ts`). Mutating
commands carry a `cid`, minted once when the user acts and kept across every
retry, so a command replayed after a reconnect is recognised rather than carried
out twice. The server answers each with an `Ack` — `ok`, or an error kind
(`busy`, `gone`, `unsupported`, `rejected`, `not_pending`, `failed`) and a line
for the user. The UI acts on that ack rather than on the click: a question card
moves to "answered" when the server says so, and a launch the server refuses
hands the typed text back to the composer instead of swallowing it. A
fire-and-forget mutation made a dropped command look exactly like a carried-out
one.

A `timeline` message carries a `cursor` — the `seq` of its last event — and the
client preserves live rows beyond that boundary while replacing the authoritative
prefix. This closes the snapshot/live race for the current single-epoch log; gap
catch-up and an explicit epoch are the next sync step.
Deltas carry the `turnId` they belong to, which is what keeps a buffer left over
from a dropped socket from being drawn under the next turn. Terminal keystrokes
deliberately carry no `cid`: they are the highest-frequency message on the
socket, and replaying one minutes later into whatever the shell is doing by then
is worse than losing it.

Command idempotency survives a server restart. `commands` claims a `cid` before
its side effect and stores the exact terminal ack; a replay returns that ack.
Prompt-producing commands also correlate a stable `promptId` and `turnId`. If a
crash leaves delivery ambiguous, the server fails closed instead of sending the
same prompt twice.

`Driver.send()` has an explicit asynchronous result (`accepted`, `delivered`,
`queued`, `refused`). ACP accepts immediately and reports the long-running turn
through hooks, so the manager lock is not held for the whole model response and
a later prompt can enter Sedano's durable queue.

## Remote access

The server only ever binds 127.0.0.1. A phone reaches it through `tailscale
serve`, which terminates HTTPS on a tailnet name and proxies to the loopback port
(tailnet-only; funnel is refused, and a request carrying
`Tailscale-Funnel-Request` is rejected). Remote mode is off by default and lives
in `~/.sedano/remote.json` (0600): `enabled`, `hostname` (manual override of the
tailnet name), `allowedLogin`, `tailscale.instance` (`app` or `dedicated`),
`tailscale.nodeName`, and the paired devices.

`remote.ts#classify` sorts every request before any route runs:

- **local** — loopback Host and no proxy headers (`X-Forwarded-*`, `Forwarded`,
  `Tailscale-*`). Exactly the old path: Origin allowlist, no token.
- **remote** — remote mode on, Host / `X-Forwarded-Host` equal to the one tailnet
  name (auto-detected from `tailscale status --json` → `Self.DNSName`, or the
  override), Origin absent or `https://<name>`, and `Tailscale-User-Login` equal
  to `allowedLogin` when one is set. Without a device token it can only reach the
  pairing page, `POST /api/remote/pair` and the install assets; everything else,
  WebSocket upgrade included, is 401.
- **forbidden** — anything else, including every proxied request while remote
  mode is off. DNS rebinding is refused as before.

A device token is 32 random bytes in a `__Host-` cookie (HttpOnly, Secure,
SameSite=Strict), stored only as a SHA-256 hash and compared in constant time.
It is issued once per one-time pairing code (8 characters, 5 minutes, 5 wrong
tries, 10 attempts a minute overall). Revoking a device, or any config change,
closes its live sockets so the upgrade is judged again. Managing remote mode is
local-only; a paired phone can use Sedano but cannot mint devices.

`tailscale.ts` shells out to the CLI (`serve status/--bg/off`, `status`, `up`),
idempotently and never overwriting another `:443` handler. The `dedicated`
instance is a second `tailscaled --tun=userspace-networking` with its own
`--statedir`/`--socket` under `~/.sedano/tailscale`, run by a launchd agent
(`dev.sedano.tailscaled`) that only an explicit install writes — so the Mac can
stay on a work tailnet in Tailscale.app while Sedano is served on a personal one.
`check:remote` covers all of it against a fake CLI and a fake `launchctl`. User
guide: [remote.md](remote.md).

On the client, `remoteClient.ts` wraps `fetch` once: any `/api/*` answered 401,
or a socket closed with 4401, reloads the page so the server can show its pairing
page. `GET /api/remote/me` hides Settings → Remote access (`RemoteAccess.tsx`,
with a small inline QR encoder in `qr.ts`) on a paired phone. The phone layout is
one breakpoint (≤ 820px, `mobile.css` + `mobile.ts`): the rail becomes a drawer
with its own unsaved open state, the app is sized to the visual viewport so the
composer stays above the keyboard, and touch targets are 44px. `check:mobile-ui`
covers it in WebKit with iPhone 15 emulation. The quick terminal's height is
dragged from its top edge (`DockResizer`, kept in this window's localStorage);
`check:dock-resize-ui` covers it.

A quick-terminal shell is part of the agent session it was opened from: the
server stores it with `parentSessionId` (`sessions.parent_session_id`), so every
client keeps it out of the rail and puts it back in that session's dock, and
deleting the agent deletes it. A boot removes a child whose parent is gone; a
window that still remembers a parentless dock terminal from an older build hands
it over once with `set_session_parent`. `check:dock` covers it.

A session's title has a source (`sessions.title_source`). `user` is a rename and
always wins: derived titles (the first prompt, a Claude `summary` record, which a
respawned or reattached driver re-reads every time) only ever replace `auto`
ones. A boot restores a rename a row lost from the command ledger's last
completed `rename_session`. `check:resume` and `check:replay` cover it.

Open tabs are shared by every device on one server: the list and its order
(session tabs, and new-session tabs with their choices — `OpenTab` in
`wire.ts`) live in one `kv` row (`tabs.open`, `apps/server/src/tabs.ts`) and
come with `hello`. A client changes it with ordered, idempotent ops (`t: 'tabs'`:
open, close, move, replace, merge), applied by the same `applyTabOp`
(`packages/shared/src/tabs.ts`) on both ends: the server applies them in arrival
order (last writer wins) and broadcasts the list; the client shows the server's
list with its own unconfirmed ops (the `tabs` commands still in the outbox or in
flight) re-applied on top, so nothing flickers and a reconnect replays them.
Which tab is on screen, the drawer, appearance and composer text stay per
device; a device whose tab was closed elsewhere falls to its neighbour. A
deleted session leaves the list on the server; a boot drops tabs of sessions
that are gone. A device's tabs from before sharing are merged in once
(`sedano.tabs-migrated`); `localStorage` (`sedano.open-tabs`) is only a cache.
`check:tabs` and `check:tab-sync-ui` (desktop + iPhone against one server)
cover it.

Archiving is not deleting (`sessions.archived`). An archived session is stopped
first if it is running (its queued prompts are dropped, as a stop does), leaves
memory, the rail and the shared tabs, and a boot does not load it — but every
row stays, and so does the harness' own transcript. The terminals docked in it
go and come back with it. The import popup (`ImportSessions.tsx`, opened from a
workspace's right-click menu or the icon beside the composer's folder chip)
lists, per folder, the archived sessions and the conversations each harness
keeps in its own store that Sedano does not hold (deduped by `harness:nativeId`
against the whole table). `apps/server/src/imports.ts` scans those stores
read-only and bounded — heads and tails of files, at most 200 per harness,
Opencode's SQLite opened read-only — and only on this machine. Continue on an
archived row unarchives it; on a native row it opens a session with that
`nativeId`, so the next prompt resumes it. History comes from the harness:
Claude's transcript reader replays the file, an ACP agent replays the
conversation on `session/load` (the driver renders it only while the session
has no events — `CreateOptions.replayHistory` — so a normal reopen never prints
it twice), and Command Code, which cannot replay, gets its prompts and replies
read from its session file at import. Transfer… does the same and then opens
the transfer dialog on the result. `check:import` covers it against a seeded
temporary `HOME`.

## Storage

One SQLite file, `~/.sedano/sedano.db` (`SEDANO_HOME` overrides the directory,
which is how every test isolates itself). The conversation and support tables
are `sessions`, `events`, `prompt_queue`, `requests`, `attachments`, `limits`,
`kv`; the execution ledger adds `commands`, `prompts`, `turns`, `actors`.
Attachment bytes live next to it on disk, each with a row that owns it, so
deleting a session takes its images with it and an upload nobody ever sent is
swept.

The ledger stores identity and lifecycle, not a second transcript. A queued
payload stays in `prompt_queue` and carries its `prompt_id`; `prompts` records
its monotone state, `turns` owns an immutable run token, and `actors` records the
main/child barrier. A turn cannot become terminal while one of its actors is
still `starting` or `running`, which keeps session status, queue draining and
the transcript's “Working” state consistent.

Migrations run at open, in a transaction, and are idempotent: columns are added
if missing, and the `events` table is rebuilt once to move from `id PRIMARY KEY`
to `PRIMARY KEY (session_id, id)`. There is no schema version number and no
automatic backup — see the [release checklist](release-checklist.md).

## Turn state

A turn is one prompt and everything it caused. Its state is decided in one
place — the manager, from the turn ledger (`turns` + `actors`) — for every
harness, and sent on the wire as `TurnRecord.phase` (in the `timeline`
snapshot's `turns` and in a `turn` frame on every transition). Drivers only
report facts through their hooks; none of them decides a turn's state.

```
            prompt accepted
                  │
                  ▼
   ┌──────── running ◄──────────────┐  main loop working
   │              │ main result      │ CLI wakes up by itself
   │              ▼                  │ (a background agent came back)
   │      waiting_agents ────────────┘  main loop returned, child agents
   │              │ last child ends     still working
   │              ▼
   │          completed                 result outcome `completed`
   ├────────► stopped                   user stop, interrupt, or an
   │                                    `interrupted` result
   └────────► failed                    harness error, delivery failure,
                                        or a `failed` result
```

- **running → waiting_agents**: the main loop's `result` arrived while provider
  actors of the turn are `starting`/`running`.
- **waiting_agents → running**: the harness produced main-loop output again
  with nothing sent (a wake-up). The same turn is reopened; its ledger row goes
  back to `running` (`db.reopenTurn`) and closes again at the real final result.
- **→ completed | stopped | failed**: only when no actor of the turn is still
  active (`advanceTurn` refuses otherwise). The outcome is the harness' own
  result outcome; a turn without one gets a synthetic `result` from the manager.
- **Cut-off agents**: when the harness process ends (stop, crash, exit, restart
  with the process gone), every live child agent gets a `subagent_end` with
  status `stopped` and its actor row is closed. `cutOffAgents` counts them.
- **A prompt sent mid-turn** goes straight to a harness that takes mid-turn
  input (`Driver.midTurnInput`: Claude, whose CLI queues and absorbs it). It
  opens its own turn at that moment; the turn it interrupted completes as
  `continued` (subtype), or waits on its own agents first. Harnesses that cannot
  take input mid-turn get the prompt from the durable queue when the turn ends
  — also when it ends in failure, as long as the harness is still there. Only a
  stop, an interrupt or a harness that has gone cancels the queue, and each
  cancelled prompt says who cancelled it (`cancelledBy: 'user' | 'server'`,
  `cancelReason`).
- **Attribution**: an event is filed under the turn running when it happened;
  a child agent's work and its end are filed under the turn that spawned it;
  an agent resumed later (Claude: `SendMessage` to a stopped agent, which the
  CLI reports as a new `task_started` under that call) is a new run — its own
  card, actor row, work and end, filed under the turn that resumed it, which
  waits on it like on any child;
  a rewritten event keeps the turn and time it was first stored with.

Per harness:

| Harness | Reports | Degrades |
|---|---|---|
| Claude | result, child agents (stream + transcript), wake-ups, mid-turn input | — |
| Command Code | result per one-shot process | no child agents; mid-turn prompts queue |
| ACP (Codex, Gemini, OpenCode, Grok) | prompt response as the result | no child agents in the protocol, so never `waiting_agents`; mid-turn prompts queue (one prompt at a time per session) |
| Terminal | nothing: a terminal tab has no turns | no ledger turns at all |

## See also

- [Remote access](remote.md) — using Sedano from a phone over Tailscale.
- [Capabilities](capabilities.md) — what each harness actually supports.
- [One interface for every harness](agent-signals.md) — the signal rule, and how
  questions, subagents, tokens and turn boundaries are wired per harness.
