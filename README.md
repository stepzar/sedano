# Sedano

One app to rule all your coding agents, on this Mac or any server you own.

[Website and live demo](https://sedano-fawn.vercel.app) · [Docs](https://sedano-fawn.vercel.app/docs/) · [Download](https://sedano-fawn.vercel.app/download/)

Claude Code, Command Code and the ACP agents (codex, gemini, grok, opencode) all
run as their own process with their own protocol, their own flags and their own
idea of what a session is. sedano drives them through one normalized event
domain, so a conversation, a tool call, a question and a turn boundary look the
same wherever they came from — and a capability one harness does not have is
absent rather than faked. Terminal tabs run real `tmux` sessions, locally or on
an SSH host you enabled, so the work survives closing the app.

```bash
bun install
bun run install:app    # build and install /Applications/Sedano.app (daily use)
bun run dev            # development copy: UI on :5174 (HMR), API on 127.0.0.1:7789
bun run desktop:dev    # the development copy inside a native "Sedano Dev" window
```

`bun run dev` starts both; `SEDANO_UI_PORT` and `SEDANO_DEV_PORT` move them. Without
vite, `bun run build:ui && bun run start` serves the built bundle from the API
port alone. State is one SQLite file per instance: `~/.sedano` for the installed
app, `~/.sedano-dev` for development (`SEDANO_DEV_HOME` moves it) — see
[Install & update](#install--update).
The UI hot-reloads, but the API deliberately does not: restarting its process
interrupts live ACP turns on every machine. Restart the API manually when you
change backend code, after active work finishes. For isolated backend development
with no active sessions, set `SEDANO_WATCH_SERVER=1` or run `bun run dev:server:watch`.

**Prerequisites.** Bun for everything. A vendor CLI only for the harnesses you
actually want — nothing is bundled, and a harness whose binary is missing says
so in the picker instead of failing at launch. Rust and the Tauri CLI only for
the desktop shell. Chrome only for the browser checks.

## What is genuinely supported

Read [docs/capabilities.md](docs/capabilities.md) for the cell-by-cell answer,
including what each harness cannot do. In short:

- **Claude Code** — native adapter over `stream-json`, plus a tailer on the
  JSONL transcript. It is the only harness that shows subagents while they work,
  because it is the only one that publishes their internals: the stream reports a
  task started and then nothing for minutes, while the harness writes the
  complete inner transcript to
  `~/.claude/projects/<slug>/<session>/subagents/agent-<id>.jsonl`. Permission
  requests and its native `AskUserQuestion` both become a card you answer.
- **ACP agents** (`codex-acp`, `gemini --acp`, `grok agent stdio`,
  `opencode acp`) — one long-lived process per session, so your next message
  continues the same conversation, and the model list comes from the agent
  instead of from a table in this repo. `session/request_permission` and
  `elicitation/create` become the same card.
- **Command Code** — headless NDJSON, one process per turn, resumed on the next.
  It cannot ask you anything: a headless `cmd -p` run denies what is risky and
  answers its own questions, so no "ask me" mode is offered and the transcript
  says why once, in words.
- **Freebuff** — terminal UI only (no print mode, no JSON, no ACP), so choosing
  it opens the terminal tab it actually is. A chat that never fills up would be
  a lie.
- **Terminal tabs** — `tmux` on this machine or on a host from `~/.ssh/config`.
  Output streams from `pipe-pane`, input goes through `send-keys`, and a snapshot
  replays the current screen when you reopen the tab.

**SSH hosts are opt-in.** The candidates are the literal `Host` aliases in
`~/.ssh/config`; sedano uses only the ones you tick in Settings. That list is the
allowlist, checked at every endpoint, session and transport, so a destination
nobody enabled never becomes an `ssh` argument.

**Unknown is not zero.** A harness that publishes no cost shows no price, not
`$0.0000`; a context ring with no reported window is marked unknown, and one
whose window is inferred from the model name reads as "about". Counters a
protocol never reported come back as unknown rather than as a confident zero.

**A prompt is never lost.** Send one while a turn is running and it is queued, on
disk, and sent at the start of the next turn — the count is in the session
summary, so the composer can say so. A stop clears the queue. A command the
server refuses hands your text back instead of swallowing it.

**Live limits, where a harness has them.** Claude Code emits `rate_limit_event`
on every turn, so the bars update from the session itself with no credentials
involved; the OAuth usage endpoint and the Codex rollout buckets are fallbacks,
and there are readers for Command Code and opencode. Gemini, Grok and Freebuff
have no usage API and the panel says exactly that.

**Tokens per second that mean something.** Claude Code reports real incremental
counts while it thinks (`system/thinking_tokens` carries
`estimated_tokens_delta`); text deltas fall back to a chars-per-token estimate.
Both feed a rolling window, alongside time-to-first-token.

**Dictation.** The microphone in the composer records and the server transcribes
locally with `whisper-cli` (whisper.cpp, model from `~/.cache/whisper-cpp`), or
through any OpenAI-compatible `/v1/audio/transcriptions` endpoint, which is how
NVIDIA Parakeet is served. Nothing leaves the machine.

**No open folders.** A workspace registry, auto-populated from `~/Projects`, the
Claude/Codex/Grok session stores and `~/.ssh/config`, plus `⌘K` to jump anywhere
and a rail that groups sessions by workspace.

**Models and harness updates.** At startup and at least once a day while open,
sedano checks installed harnesses on this computer and every enabled SSH host in
the background. Model lists and release checks are cached across restarts; this
automatic pass does not install software. The model menu has **Refresh models &
version** for a single harness, and Settings → Machines has **Refresh models &
versions** and **Update all available** for every machine. Installation is always
an explicit action. npm-managed tools update in their own installation prefix
(including nvm), and update failures remain visible beside the control.
Every picker derives its effort options from that machine's model catalog:
an explicit list, IDs such as `model[high]`, or an explicit "no effort" answer.
Unknown capabilities stay disabled. A stale effort saved for another model is
not sent when starting or transferring a session.

### Limits and gaps

- Subagent cards exist for Claude only. No other wired harness publishes such a
  signal, and none is invented for them.
- Command Code cannot take an image through its headless pipe, and cannot ask you
  anything.
- The reasoning effort a model accepts differs per model. Command Code's CLI is
  asked, and when it refuses, the effort is downgraded or dropped with a note.
- Claude's `dontAsk` permission mode is not selectable: the shared domain does
  not model it.
- ACP resume hints are best-effort. Grok's is a label rather than a command, and
  none of them is prefixed with `ssh` for a remote session.
- Still not done: the Piagent CLI, and the agent bus (one MCP endpoint injected
  into every session so agents can message each other).

## Design language

Deliberately quiet: one accent, hairlines instead of borders, two surface levels,
a 4px spacing grid and a single type scale for the interface.

| Token group | Values |
|---|---|
| Accent | neutral ink `#0d0d0d` (light) / `#ececec` (dark) — chroma 0, asserted by `check:ui` |
| Surfaces | `--bg` `--surface` `--surface-2` `--surface-3` `--sunken` |
| Text | `--fg` `--fg-2` `--fg-mute` `--fg-faint` |
| Radii | 4 / 6 / 8 / 11 / 14 px |
| Type | system UI stack, `--ui-font-size` (chrome) vs `--content-font-size` (conversation) |
| Motion | 130ms, `cubic-bezier(.22,.61,.36,1)`, disabled under `prefers-reduced-motion` |

Achromatic on purpose: surfaces and the accent carry no hue, and the only tinted
tokens left are semantic (`--ok`, `--warn`, `--err`, `--info`) plus the
running-state dot. Everything is a CSS variable in `apps/ui/src/styles.css`, so a
theme is a token override — no rebuild, no CSS-in-JS.

One popover primitive draws every menu in the app, and there is no native
`<select>` left anywhere (`check:ui` asserts that), because a control you cannot
style is a second design language. Contrast is enforced rather than eyeballed:
`bun run check:contrast` walks the rendered app and the gallery in both themes
and fails if any text/background pair drops below its floor.

`/preview.html` is a dev-only gallery that renders the transcript from fixtures —
live subagent, patches, diffs, thinking, a running turn — plus every primitive,
in either theme:

```
http://localhost:5174/preview.html?theme=dark
```

Useful for design work and for reviewing a change without burning any quota.

## Architecture

```
apps/server        Bun HTTP + WS server, SQLite store, one process
  harnesses/       adapters and drivers: claude, commandcode, acp/*, terminal
  usage/           quota readers: claude, codex, commandcode, opencode
apps/ui            React 19 + Vite, one WebSocket to the server
apps/desktop       Tauri shell: attaches to a running server or starts the sidecar
packages/shared    the normalized event + wire types (the only contract)
```

The UI only ever sees normalized events from `packages/shared`, so adding a
harness means writing an adapter that emits `DriverHooks` — no UI changes. Every
driver runs against a `Transport` bound to a host or to this machine, so nothing
branches on local versus remote.

The server binds `127.0.0.1` and checks `Origin` on every `/api/*` call and on
the WebSocket upgrade, so a random page in your browser cannot drive it; CORS is
allowed for `tauri://localhost` and local dev origins.

Longer version: [docs/architecture.md](docs/architecture.md), and
[docs/agent-signals.md](docs/agent-signals.md) for the rule that keeps every
harness coming out the same shape.

## Verifying

```bash
bun run check:all      # every hermetic gate, then a summary
```

The gates run anywhere: no account, no network, no vendor CLI, no tmux, no ssh
host, and each gets its own temporary store and its own free port — so this is
safe to run while a dev server is up. The smokes that need a logged-in CLI, tmux
or a real host are deliberately outside it and are named at the end of the run
instead. Which gate proves what, and how to run the smokes:
[docs/testing.md](docs/testing.md). Before a release:
[docs/release-checklist.md](docs/release-checklist.md).

## Desktop

```bash
bun run sidecar        # bun build --compile → the server as one binary
bun run desktop:dev    # Tauri dev window ("Sedano Dev")
bun run desktop:build  # .app + .dmg (bundles the sidecar)
```

The shell attaches to a server already on its port only when `/api/health`
says it is the same kind of Sedano with the same store; otherwise it starts its
own (the bundled sidecar, or the source in dev). A port held by *another* Sedano
is refused with a dialog instead of shown in the wrong window. Whatever the
shell starts, it stops on quit (durable agents keep running).

## Install & update

The installed app is for daily use; the repo is for developing it. They never
share a port, a store or a window:

| | installed app | development copy |
|---|---|---|
| started by | `/Applications/Sedano.app` | `bun run dev`, `dev:server`, `desktop:dev` |
| API port | 7788 | 7789 (`SEDANO_DEV_PORT`) |
| data | `~/.sedano` | `~/.sedano-dev` (`SEDANO_DEV_HOME`) |
| bundle id / window | `app.sedano.desktop`, "Sedano" | `app.sedano.desktop.dev`, "Sedano Dev" |
| remote access, paired devices, tailscale serve | yes | read-only, changes refused |

`~/.sedano` holds everything real: `sedano.db` (sessions), `agents/` and
`durable/` (agents that outlive the server), `remote.json` (remote mode and
paired devices), `tailscale/` (the dedicated tailscaled), dictation models,
`server.log`.

```bash
bun run install:app               # install, or update to the current checkout
bun run install:app --rollback    # back to the build before (Sedano.app.previous)
```

`install:app` builds the UI, the sidecar and the release `.app` (no dmg),
quits the running Sedano through its normal quit (the server gets SIGTERM;
durable agents keep running and are picked up again), swaps the new bundle into
`/Applications` by rename, keeps the old one as `Sedano.app.previous`, clears
quarantine and relaunches. Unchanged UI or server code is not rebuilt (content
hash), and cargo is incremental, so an update is seconds, not minutes. It
prints timings per step. If port 7788 is held by something else (an old
`bun run dev` on the real store), it installs but does not launch, and says so.

## Keyboard

| | |
|---|---|
| `⌘K` | jump to workspace / session / action |
| `⌘D` | new agent tab — the inline launchpad |
| `⌘T` | new terminal tab on the machine you are looking at |
| `⌘W` | close the current tab |
| `⌘1`…`⌘9` | jump to that tab in the strip |
| `⌘B` | sidebar |
| `⌘,` | settings (sections on the left, search across every row) |
| `⌘+` `⌘−` | conversation text |
| `⌥⌘+` `⌥⌘−` | interface text |
| `esc` | close the overlay, or interrupt the running turn |

A new agent tab is not a dialog: `⌘D` adds a tab and fills it with a launchpad —
one text field and every setting as a chip under it (workspace, harness, model,
effort, approvals). The tab is selected immediately and is named from your first
message; a terminal is named from what it runs.

## Supported platforms

macOS on Apple Silicon is the only supported platform today: the desktop app,
the installer and the remote mode are built and tested there. Linux and Windows
are not supported yet. The server and the hermetic test suite run on Linux in
CI, but no Linux or Windows app is built or released.

## Trademarks

Claude, Claude Code, Codex, Gemini, Grok, opencode, Command Code, Freebuff,
Tailscale and all other product names, logos and brands mentioned here are the
property of their respective owners, and are used only to identify the tools
Sedano works with. Sedano is an independent project, not affiliated with or
endorsed by any of them.

## License

Sedano is licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE)
for third-party attributions.
