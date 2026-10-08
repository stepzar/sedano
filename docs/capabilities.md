# What each harness can actually do

Every row here was read off the code that implements it, not off a vendor page.
Where a cell says no, it means sedano does not do it today — either the protocol
has no way to express it, or the adapter does not translate it. An honest no is
the point of this table: a picker that offers a capability the driver will not
honour is a promise the session cannot keep.

The sources, so a cell can be checked rather than believed:
`apps/server/src/harnesses/registry.ts` (`permissionModesFor`), the adapter and
driver of each harness under `apps/server/src/harnesses/`,
`apps/server/src/harnesses/model-images.ts`, and the normalized domain in
`packages/shared/src/events.ts`.

## The matrix

| | Claude Code | Command Code | ACP agents (codex · gemini · grok · opencode) | Freebuff | Terminal tab |
|---|---|---|---|---|---|
| **Protocol** | `claude -p --output-format stream-json` over stdio, plus a tailer on the JSONL transcript | `cmd -p --output-format json`, one process per turn | ACP over stdio, one long-lived agent process per session | none — TUI only | `tmux`, locally or over ssh |
| **Model selection** | the CLI's own aliases (`opus[1m]`, `opus`, `sonnet`, `haiku`, `fable[1m]`), sent as `--model` | whatever `cmd --list-models` reports on the machine the session runs on, sent as `--model` | whatever the agent reports at handshake, set with `session/set_config_option`; grok also takes `-m` at spawn | n/a | n/a |
| **Reasoning effort** | `--effort <level>` | `--effort <level>`, dropped or downgraded when the CLI refuses it for that model | the `thought_level` config option when the agent publishes one; grok takes `--reasoning-effort` at spawn | n/a | n/a |
| **Permission modes** | `default`, `acceptEdits`, `auto`, `manual`, `plan`, `bypassPermissions` | `default`, `acceptEdits`, `plan`, `bypassPermissions` | `default`, `acceptEdits`, `plan`, `bypassPermissions` | n/a | none |
| **Images** | yes | no — its headless mode takes a text prompt | what the agent said at its handshake; assumed yes until it says otherwise | n/a | n/a |
| **Subagent visibility** | yes — the only one | no | no | n/a | n/a |
| **Interactive questions** | yes — permission requests and the native `AskUserQuestion` | **no** | yes — `session/request_permission` and `elicitation/create` | n/a | n/a (a shell asks you directly) |
| **Resume** | `--resume <uuid>` | `--resume <session-id>` | only when the agent advertises `loadSession`; then `session/load` | n/a | the tmux session outlives the app |
| **Remote / SSH** | yes | yes | yes | yes (it is a terminal tab) | yes |

Every remote column means the same thing: the binary is resolved on the host and
the process runs there, over `ssh`, and only for a host you enabled (see
[Hosts](#hosts) below).

## The cells that need explaining

### Command Code has no interactive questions, and `manual` is not offered

A headless `cmd -p` run installs Command Code's own `headlessInteraction`: it
denies anything risky and answers a question with the first option, so nothing
ever reaches this client, and the NDJSON protocol has no frame for a permission
request at all. Offering an "ask me" mode there would have been a card that never
appears.

So `permissionModesFor('commandcode')` does not include `manual`, and
`CommandCodeDriver.permissionArgs` maps what is left onto the CLI's real flags:
`plan` → `--permission-mode plan`, `default` → `--permission-mode standard`,
`acceptEdits`/`auto` → `--permission-mode auto-accept`, `bypassPermissions` →
`--yolo`. A session stored with `manual` from an older build still runs — as
`standard` — and the transcript says so once, in words, rather than pretending.

### Claude has a mode sedano cannot select

`claude --permission-mode` accepts `dontAsk`, and the shared `PermissionMode`
union in `packages/shared/src/events.ts` does not have it. The union is what the
wire, the database and the picker all speak, so the mode is unreachable from
sedano even though the CLI would take it. Nothing is broken by this; it is simply
a capability of the harness that the domain does not model yet.

### `auto` and `manual` are aliases outside Claude

For the ACP agents the driver resolves `manual` exactly like `default` (both ask)
and `auto` exactly like `acceptEdits` (both approve). Two rows that changed
nothing, so they are not offered — `permissionModesFor` returns the four that are
distinct. Claude is the exception: it really does take all six on its command
line.

### Images are a fact about the model, not only about the harness

Two answers are combined. The harness has a ceiling (`Adapter.images`): Command
Code's is `false`, because its headless pipe carries text. Under that ceiling,
each model answers for itself (`model-images.ts`), from the catalog's own
wording, from the families whose support is documented, and from Command Code's
own list of text-only models. `undefined` there is a real answer — nobody said —
and the harness's ceiling is then what counts. The composer checks both before it
lets an image go.

### Subagents are Claude-only, and not by preference

Claude Code's `stream-json` does not forward subagent internals, but the harness
writes the complete inner transcript to
`~/.claude/projects/<slug>/<session>/subagents/agent-<id>.jsonl`, and
`claude/transcripts.ts` reads it — that is where `subagent_start` and
`subagent_end` come from. No other wired harness publishes such a signal, so no
other harness emits those events. The UI does not branch on this: the card is
simply absent, which reads as "this harness does not report that".

### Interactive questions travel as a tool call, not as `k:'request'`

`packages/shared/src/events.ts` defines a `k:'request'` timeline event with a
proper lifecycle (`pending` / `answered` / `expired` / `cancelled`). No driver
emits it yet. Today every harness that asks something emits a `tool` event named
`AskUserQuestion`, and `manager.ts` recognises that name (`QUESTION_TOOL`) to
open a row in the `requests` table. The lifecycle is real — the state is
persisted, a stop or an interrupt closes pending requests, and a restart expires
them, so a card that came back after a crash is history rather than a button that
does nothing — but the event shape is still the tool call. Read `RequestState`
as the domain sedano is moving to, not as what is on the wire.

### Resume hints are not all equally useful

`resumeHint` is the native command shown in the UI so a session is never trapped
inside sedano. Claude and Command Code compose theirs and prefix it with
`ssh <host>` when the session runs on one. The ACP driver returns
`opencode --session <id>`, `codex resume <id>` and `gemini --resume`; grok falls
through to the label `grok (ACP)`, which is not a command, and none of the ACP
hints are prefixed for a remote host.

## Hosts

A host is usable only when it is both a literal `Host` alias in `~/.ssh/config`
*and* ticked in Settings. That list is the allowlist, not a convenience:
`assertAuthorizedHost` is the single gate every API endpoint, session and
transport passes through, so `user@10.0.0.1` or a name a client invented never
becomes an `ssh` argument no matter how well-formed it looks. Patterns
(`Host *`, `Host !staging`) are not destinations and are not offered; `Include`
is expanded, with a depth bound.

## Usage and limits

There is a reader for Claude Code, Codex, Command Code and opencode
(`apps/server/src/usage/`). Gemini, Grok and Freebuff have nothing to read, and
the panel labels them "No Usage API" instead of leaving a gap the reader has to
interpret. A harness that reports its own limits while it runs wins over any
reader, because that reading needs no credentials of its own.

The Claude Code and Command Code readers send a stored credential to the vendor
(Claude Code's OAuth token to `api.anthropic.com/api/oauth/usage`, Command
Code's API key to `api.commandcode.ai`), so each is off until it is turned on in
Settings › Advanced › Account usage readers. Off, the panel says "Off — enable in
Settings", never a zero. Codex and opencode read local files and a local CLI and
need no switch.

Values nobody reported are not zeros. `TokenUsage.unreported` names the counters
a harness left out and `usageValue` answers `null` for them;
`SessionMetrics.costReported` and `contextReported` are `false` when the harness
never said, and the UI shows nothing rather than `$0.0000` or an empty ring.
`contextWindowInferred` is the third state: the occupancy is real, the
denominator is a guess from the model name, and it is drawn as "about".
