# One interface for every harness

How sedano shows what an agent is doing, and the rule that keeps every harness —
the ones wired today and the ones added later — coming out the same shape.

## The rule

A harness is a **source of signals**, not a special case in the interface. Every
thing the UI knows how to draw is a normalized event in
`packages/shared/src/events.ts`, and the only job of a driver is to translate its
own protocol into those events. When a harness cannot produce a signal, the UI
must not grow a branch for it — the card is simply absent, which reads as "this
harness does not report that".

The four signals, and what each harness does with them today:

| | claude | acp (opencode · codex · gemini · grok) | commandcode | terminal |
|---|---|---|---|---|
| **Questions / approvals** | `can_use_tool` control request → question card, answered | `session/request_permission` **and** `elicitation/create` → question card, answered | none in the stream | none (raw pane) |
| **Subagents** | `subagent_start` / `subagent_end` + `agentId` sidechain | none reported | none reported | none |
| **Tokens** | in · out · cache read/write · reasoning · window · cost | in · out (window from the model) | in · out · cache read/write | none |
| **End of turn** | `result` event | `result` event | `result` event | none (a shell has no turns) |

## Questions: one card, two protocols

The mechanism is deliberately protocol-agnostic:

1. A driver that is *asked* something emits a `tool` event named
   `AskUserQuestion`, whose `input.questions[].options[]` carry `{ id?, label,
   description }` and whose `toolId` is the id the answer must quote.
2. The UI draws the card (`QuestionBlock`) and, while no `tool_result` has
   arrived, offers the options as buttons.
3. Clicking one sends `{ t: 'answer_question', sessionId, toolId, optionId }`.
4. The driver turns that back into its own protocol's reply, and emits a
   `tool_result` so the card shows what was chosen.

Where each side hooks in:

- **claude** (`apps/server/src/harnesses/claude/session.ts`): the CLI is started
  with `--permission-prompt-tool stdio`, which is what makes it *ask* instead of
  deciding silently; `handleStreamLine` reads `control_request` →
  `handleControlRequest` emits the card, and `answerQuestion` writes the
  `control_response` (`{ behavior: 'allow' | 'deny' }`).
- **acp** (`apps/server/src/harnesses/acp/driver.ts`): `onRequest` for
  `session/request_permission` is handed the JSON-RPC id (the client passes it),
  the agent's own options become the card's options, and `answerQuestion`
  resolves the pending promise so `AcpClient.respond` writes the outcome.
- **acp, the protocol's own question**: the client advertises
  `clientCapabilities.elicitation = { form: {} }` at `initialize`, which is what
  makes an agent ask *us* (`elicitation/create`) instead of deciding alone — the
  protocol forbids asking for a mode the client has not advertised. A form whose
  schema is a question (a single choice through `oneOf`/`enum`, or a boolean)
  becomes the same card, and the answer goes back as
  `{ action: 'accept', content: { field: value } }`. Forms this card cannot draw
  (free text, numbers, several fields at once) are declined with a reason rather
  than half-rendered, and URL mode is not advertised at all: it is an out-of-band
  browser flow, which is a different feature.

  This is the piece that makes questions work **for any ACP agent**, present or
  future, without a line per harness. `session/request_permission` stays separate
  on purpose — permission is a security decision, a question is information —
  and both arrive as the same card because the user's answer is the same shape.

Policy, identical for both: `plan` refuses, `acceptEdits` / `auto` /
`bypassPermissions` answer without asking (choosing them said not to ask), and
`manual` / `default` **ask** — the modes that mean "ask me" are the only ones
that interrupt.

`AskUserQuestion` itself, when claude asks permission to run *that tool*, is
declined with a reason: answering its questions needs the CLI's dialog channel
(`request_user_dialog` plus an `initialize` declaring which dialog kinds this
client can render), which is not wired. The reason asks the model to put the
questions in prose instead — which the composer can answer.

## Tokens: one ledger

All drivers report through `DriverHooks.usage` and the shared `Meter`
(`apps/server/src/metrics.ts`), so the status bar and the context ring are the
same code for every harness. `contextWindow` is the one field only some
harnesses report, and the manager fills it from the model
(`guessContextWindow`) when a driver does not — so the ring fills for the ACP
agents too instead of staying empty.

`costUsd` and `reasoning` cannot be filled centrally: they are read per protocol
where the driver parses its usage, and are left at zero where the protocol does
not carry them.

### The effort a model accepts is a property of that model

The same rule as images, and for a sharper reason: a harness **refuses the whole
run** when it is handed an effort it does not know (`Unknown effort "medium".
Supported: low, high, max.`), so offering the usual levels is how a picker breaks
a turn. Command Code publishes the list per model inside its own bundle; it is
mirrored in `harnesses/commandcode/efforts.ts`, plus whatever the CLI itself says
when it refuses — which the driver learns and retries from, so a model newer than
the mirror is corrected on first use instead of failing in front of someone.
`ModelInfo.efforts` carries it to the picker, and `[]` means "this model has no
adjustable effort", which is not the same as "nobody said".

### Where this comes from

Decided from the protocols' own sources, not from guesswork: the ACP
specification's elicitation chapter (`agentclientprotocol.com/protocol/v2/elicitation`,
stabilized 2026-07-22) for `elicitation/create`, its capability rules and the
three-action response; and `agentclientprotocol/codex-acp`, whose
`CodexApprovalHandler` / `CodexElicitationHandler` translate Codex's own
`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
`item/permissions/requestApproval` and MCP tool-call elicitations into
`requestPermission` on this side of the wire — which is why Codex asks us
through the permission path rather than the elicitation one.

## What each harness would need next

- **claude**: nothing for questions. Subagents already flow.
- **acp**: if an agent reports delegated work, map its spawn tool call onto
  `subagent_start` / `subagent_end` in `onNotification` — the events, the
  `agentId` slot, the grouping (`apps/ui/src/view.ts`) and the card already
  exist; only the translation is missing. Note the current hazard: a tool
  literally named `Task` / `Agent` with no matching start is dropped by
  `buildRows`, so a new mapping must emit the whole pair.
- **commandcode**: same as acp, from its NDJSON frames (`tool_queued` /
  `tool_completed`). No question channel has been observed in its stream.
- **terminal**: by design it has none of these. A shell reports bytes, not
  turns; inventing signals there would mean parsing the screen, which is a
  different project and not worth pretending about.

## Backlog: what the ACP audit found

An audit of the official protocol documentation against our client and driver
(`client.ts`, `driver.ts`) produced this list. Done in the same sitting:
cancelling now answers every pending permission/elicitation with `cancelled`
(the spec requires it, and an unanswered question left the agent blocked);
`usage_update` reaches the metrics, so the context ring and the cost fill in for
the ACP agents too; `current_mode_update` updates the mode a session claims;
a dismissed elicitation answers `cancel` rather than `decline`; a boolean form
answers with a real boolean; an un-advertised elicitation mode answers
`-32602`; `fs/write_text_file` answers `{}`; and a tool call without a `title`
no longer shows its `kind` as a name.

Fixed in the same pass, after the first four were written down:

1. **Model switching** is `session/set_config_option` with the model option's own
   id, learned when the session opens; the private `session/set_model` some
   agents accepted is tried only after it fails, so an older agent is not left
   behind.
2. **Images** are sent only when the handshake said the agent reads them
   (`promptCapabilities.image`), and the picker reads the same answer instead of
   claiming support at the harness level.
3. **`session/load`** answers with the same shape a new session does, and that
   answer is absorbed: a reopened tab no longer comes back claiming the wrong
   model. During the replay only the conversation is suppressed — commands, mode,
   model, usage and info updates are current, not history.
4. **Plans** replace the current plan (one row, one id) instead of stacking, and
   `pending`/`in_progress`/`completed` no longer look the same.

Still open, lower value and noted rather than done: validating the returned
`protocolVersion`; splitting messages on `messageId`; exact `-32601` codes;
`available_commands_update.input.hint`; reading the draft per-turn `usage`
sub-fields; validating `sessionId` on every update.

Deliberately not done: `terminal/*` (we advertise `terminal: false` honestly),
`session/list|delete|resume` (sedano owns its own store), `$/cancel_request`
(ignoring `$`-prefixed notifications is explicitly permitted).

## Adding a harness

1. Translate its protocol into the events above; never add a UI branch.
2. Report usage through `hooks.usage` (with `contextWindow` if the protocol has
   one) and emit a `result` event when a turn ends.
3. If it can ask, implement `answerQuestion` and emit the question card; if it
   cannot, leave both out and the interface stays honest.
