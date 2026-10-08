# Testing

The suite is split in two, and the split is the whole point.

**Hermetic gates** run anywhere: no account, no network, no vendor CLI, no tmux,
no ssh host. Each gets its own temporary `SEDANO_HOME`, its own free port and,
where it needs a harness, a fake one built from `scripts/fixtures/`. They are
what `bun run check:all` runs, and a failure is a bug in this repo.

**Optional smokes** need something this repo cannot provide — a logged-in CLI and
quota to spend, a tmux binary, a real machine in `~/.ssh/config`. They prove
things a fixture cannot, and they are state-dependent: passing says the thing
worked against the world as it was at that moment. `check:all` names them at the
end instead of running them and blaming them.

```bash
bun run check:all     # every hermetic gate, then a summary
```

`check:all` (`scripts/lib/check-all.ts`) runs every gate even after one fails —
a baseline is worth more than an early exit — and prints an `ok`/`FAIL` line per
gate plus a verdict. It exits non-zero if any gate failed. Nothing it starts
touches `~/.sedano` or a port something else is listening on, so it is safe to
run while a dev server is up.

## The hermetic gates

In the order `check:all` runs them. The browser checks come last because they
serve the bundle `build:ui` produces.

| Gate | What it proves |
|---|---|
| `bun run typecheck` | `tsc --noEmit` over every package |
| `bun run check:view` | the render tree — subagent nesting and the provisional-completion handling — against versioned transcript fixtures |
| `bun run check:version` | every manifest carries the root `package.json` version (`tauri.conf.json` points at it), and every workflow pins the same bun, at least 1.2.4 |
| `bun run check:db-backup` | a release that changes the schema keeps the store it found as `sedano.db.bak-<previous version>`, the same release or an unchanged schema keeps nothing, only the last three are kept and a hand-made copy is never pruned |
| `bun run check:db` | the event-identity migration: a legacy `id PRIMARY KEY` database is rewritten to `(session_id, id)` and two sessions sharing a native id stay separate |
| `bun run check:turn` | turn boundaries: a late event of turn A stays in turn A after turn B has begun, and the legacy heuristic still covers events with no `turnId`; a queued turn's clock counts from the ledger's start, not from when its prompt was typed |
| `bun run check:files` | clickable files: which tool rows name a file and have anything to expand, which paths in a reply are links, and that the server only hands existing, non-executable regular files to `open` / `xdg-open` |
| `bun run check:resume` | a respawned Claude session leaves its history alone (times, turns, results), registers no old agent in the new turn, a stop ends the agents it cut off, a mid-turn prompt is sent at once and opens its own turn, and a boot repairs damage from older builds |
| `bun run check:replay` | recorded sessions (sanitized real ones and the protocol captures) replayed through the manager: turn phases, replies, cut-off agents, stable history — see “Replays” below |
| `bun run check:coverage` | every protocol type in each harness' published schema (Claude Agent SDK, ACP schema, Command Code bundle) is handled or knowingly ignored, the extractors are deterministic on small fixtures shaped like the pinned sources, and an unknown type seen live is recorded — see “Coverage” below |
| `bun run check:lifecycle` | spawn, stop and delete under races: a prompt sent mid-turn is queued rather than lost and its turn starts when the queue releases it, a failed spawn is not reported as sent, a stop during a slow handshake leaves no process and no resurrected session, and terminal states stay terminal |
| `bun run check:recovery` | pending questions, acks and attachment ownership: a question cannot be answered twice or after a restart, a mutating command is answered by id and a replay does not repeat it, an image always has an owner, and a text document reaches the harness inline while the stored message keeps it as an attachment |
| `bun run check:store` | the client store against the real socket messages: the streaming buffer is reconciled on reconnect, and the outbox does not drop a `new_session` that later commands depend on |
| `bun run check:claude` | the Claude driver against a fake `claude` that speaks the real `stream-json` control protocol: every `control_request` is answered, including subtypes we do not recognise, and a permission mode approves only what it says it approves |
| `bun run check:ssh` | the host allowlist and the transport against a fake `ssh`: a host that is not enabled is refused, an enabled but unreachable one errors instead of falling back, a cut poll neither duplicates nor loses bytes, and nothing is left running on the far side |
| `bun run check:usage-readers` | no stored credential is read or sent to a vendor for usage until that reader's switch is on (all off by default), and a reader that is off reads as off, never as zero usage |
| `bun run check:origin` | only the app's own origins reach the API, over HTTP and WebSocket; the dev UI's origin only in the dev copy |
| `bun run check:echo` | the message-duplication rule: one message sent never renders as two bubbles |
| `bun run check:acp` | the ACP driver against a fake agent: handshake, streamed turns, tool diffs, permissions, fs access, cancel, resume, per-vendor argv |
| `bun run check:cmd` | the Command Code driver against a fake `cmd`: NDJSON parsing, ordering, turn boundaries and `--resume` on the next turn |
| `bun run check:import` | archive hides a session without deleting it (not listed, not loaded at boot, tab dropped, running turn stopped) and unarchive brings it back whole; the import scan reads every harness store (Claude, Codex, Gemini, Opencode, Grok, Command Code fixtures in `scripts/fixtures/imports/`, under a temporary `HOME`) with clean titles, dedupe and no write; an ACP import renders the replayed history once, a Command Code import carries its history |
| `bun run check:manager` | the interrupt deadline: a stop finishes even when the harness never answers |
| `bun run build:ui` | the bundle the two browser checks serve |
| `bun run check:demo-isolated` | the website demo (`apps/ui/src/demo/`, a fake server in the page) is compiled out of the normal bundle — and present in `build:demo`, so the check cannot pass by finding nothing |
| `bun run check:csp` | the desktop CSP in `tauri.conf.json` lets the real bundle work and still refuses other sites, inline scripts and `eval` |
| `bun run check:contrast` | real WCAG ratios for every text/background pair, in both themes, app and gallery |
| `bun run check:ui` | the app in a real browser: no console errors, the transcript scrolls and is bounded, ⌘D opens the inline launchpad (never a modal) with its chips and its composer, both composers grow, reflow and shrink without a premature scrollbar, the folder picker walks, settings opens with a working search, the palette opens with ⌘K, light and dark are different surfaces, the accent is neutral, the two font scales are independent, no native `<select>` is left anywhere, an unreported cost or context reads as unknown rather than as zero, and the import popup opens from the composer and from a workspace menu, lists an archived session and restores it (Archive puts it back) |
| `bun run check:update-ui` | the app-update UI against a mocked Tauri bridge: no update UI in a browser tab; on desktop the pill offers the version, installs through the updater plugin, asks before restarting, and a failed check stays visible in the pill, Settings and a toast |
| `bun run check:demo` | the website demo built and served with nothing behind `/api`: seeded sessions, a streamed reply, a queued prompt, a permission allowed and one denied, a question answered, Esc, Settings changing theme and sidebar across a reload, limits, a terminal, `?session=`/`?theme=`/`?embed=`, and the phone layout — zero console errors and zero failed requests (screenshots in `/tmp/sedano-demo-qa/`) |

The browser checks need Chrome installed (`chromium.launch({ channel: 'chrome' })`
— no browser is downloaded). With no arguments they build their own world: a
temporary store seeded with the transcript fixtures, an API server on a free port
serving the built bundle, and a vite server for the gallery. Because the store is
known, a surface that is missing is a failure rather than a silent skip.

`check:contrast` has been seen to fail once and pass on the next run against the
same tree, reporting a gallery surface (`.diff-add`) that "never rendered" — it
reads the gallery before that surface is on screen. A single contrast failure
naming one missing surface is worth re-running before it is believed; a failure
that names a ratio is not.

They write screenshots to `.playwright-mcp/` — app light, dark and big font, the
palette, the launchpad, settings, and the gallery in both themes. Those are for a
human to look at; nothing asserts on the pixels.

## The optional smokes

None of these are gates. Each says at the top what it needs, and each will refuse
to run rather than pretend.

| Smoke | Needs | What it proves |
|---|---|---|
| `bun run check:smoke [cwd]` | the `claude` CLI, logged in — **it spends quota** | the whole pipeline against the real harness: deltas, transcript, subagent tree, metrics, limits. Runs against a temporary store, but the vendor config is the real one, because that is where the login is |
| `bun run check:term [ws] [cwd] [host]` | `tmux`; a host from `~/.ssh/config` for the remote half | keystrokes reach a real shell, output comes back, geometry is honoured, and the tmux session outlives the process. Point it at a host: every bug in this area so far lived in the ssh hop |
| `bun run check:term-ui [url]` | `tmux` and a server already running | xterm mounts, receives the shell's output and forwards typing back |
| `bun run check:ui` with `SEDANO_CHECK_OPTIONAL=1` | a vendor CLI reporting usage limits | the surfaces that only exist when something outside this repo does |
| `bun scripts/acp-probe.ts <agent> [flag]` | the agent installed and signed in | the ACP handshake and `session/new` against a real agent, without spending a token. This is how the client was verified against `opencode acp`, `codex-acp` and `gemini --acp` |

The two terminal smokes create a namespaced `tmux` session and take it away
again, working from a before/after diff rather than a name pattern — every
terminal tab you opened yourself carries the same `sedano-<8 hex>` shape, and
matching the shape alone used to kill your own shells.

## Prerequisites

- **Bun.** Everything runs through it; there is no node build step.
- **Chrome**, for `check:ui` and `check:contrast`.
- **tmux**, for the terminal smokes only.
- **Rust and the Tauri CLI**, only to build or run the desktop shell.

Nothing in the hermetic set needs a vendor CLI, an account or a network.

## Replays: every reported bug becomes a trace

`bun run check:replay` (`scripts/replay-test.ts`) replays recorded sessions end
to end through the manager — a stand-in CLI (`scripts/fixtures/replay-player.ts`)
plays the stream on stdout and the transcript and subagent sidecars on disk,
cycle by cycle and with their relative timing, across respawns — and asserts
what a person sees: each turn's `phase`, its final reply, its cut-off agents,
that no turn is left working, and that no event already in the history changes
turn or time. Scenarios are the sanitized sessions in
`scripts/fixtures/replays/` plus every protocol capture in
`scripts/fixtures/traces/`, converted to one-turn replays. The ACP family has
no capture (capturing spends quota on a real account) and is covered by the
fake agent, labelled `synthetic:`.

When a user reports a state bug in a session:

1. Find the session's transcript (Claude: `~/.claude/projects/<slug>/<native id>.jsonl`,
   the native id is on the session) — read it, never edit it.
2. Build a sanitized replay; it keeps structure, ids, order and timing, and
   replaces every prompt, reply, tool input and output, path and branch name:

   ```bash
   bun scripts/replay-build.ts --transcript <file.jsonl> --name <harness>-<session>-<what> \
       --until <last line> [--crash-before <line of the prompt after a crash/restart>] \
       --note "what the user saw"
   ```

3. Open `scripts/fixtures/replays/<name>.replay.json` and set `expect` to what
   *should* have happened (the builder writes "completed with a reply" for
   every turn as a starting point). Check that nothing personal is left
   (`grep` for the user's name, paths, hostnames).
4. Run `bun scripts/replay-test.ts <name>` — it must fail on the bug — then fix
   the server until it passes, and keep the replay: it is the regression test.

## Coverage: nothing a harness sends goes unaccounted for

Each protocol sedano speaks has an **inventory** — every message and event type
it can emit — derived from the harness' own source of truth, never from our
drivers, and committed with the version it came from
(`apps/server/src/harnesses/coverage/<protocol>.inventory.json`):

| Protocol | Source | Notes |
|---|---|---|
| `claude` | `@anthropic-ai/claude-agent-sdk` → `sdk.d.ts`, the `SDKMessage` union | the stream-json contract; the on-disk transcript has no published schema and is covered by the runtime record below |
| `acp` | `@agentclientprotocol/sdk` → `schema/schema.json` | `session/update` variants, client-side methods, tool kinds and content, stop reasons — one schema for Codex, Gemini, OpenCode, Grok |
| `commandcode` | `command-code` → `dist/cli.mjs` | no schema exists; a deliberate superset scanned from the bundle |

Next to each is a hand-kept **mapping** (`<protocol>.mapping.json`): every key is
`handled` (and where — the gate checks the file exists and names the type, unless
the entry says the handling is `generic`) or `ignored` (and why).
`check:coverage` fails on any inventory key without an entry.

It stays current three ways:

- **Daily in CI** (`.github/workflows/coverage.yml`): derives the inventories of
  the *latest* published releases (`npm pack`, no install, no API key), runs the
  gate, and opens or updates one issue listing the new types and versions.
- **On this machine**: the hourly harness sweep re-derives the inventory for each
  installed version when it changes, and records every unmapped type.
- **Live**: every frame a driver receives is looked up in the mapping; an
  unmapped type is recorded once (kept across restarts), announced once as a
  notice, and listed in `Capabilities.unhandledEvents` / `GET /api/unhandled`
  for Settings → Unhandled events.

When a new type appears, map it (handle it, or say why it is ignored), then:

```bash
bun scripts/coverage/extract.ts --latest --write   # refresh the inventories
bun run check:coverage
```

`bun scripts/coverage/extract.ts --verify` re-derives the pinned versions and
compares them with the committed inventories (it needs the registry, so it runs
in the workflow, not in `check:all`).

