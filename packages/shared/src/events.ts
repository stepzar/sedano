/**
 * Normalized domain model.
 *
 * Every harness (claude, codex, gemini, grok, opencode) is translated into this
 * shape. The UI only ever sees these types, so adding a harness never touches
 * the UI layer.
 */

export type HarnessId =
  | 'claude'
  | 'commandcode'
  | 'codex'
  | 'gemini'
  | 'grok'
  | 'opencode'
  | 'freebuff'
  | 'shell'

export const HARNESS_LABEL: Record<HarnessId, string> = {
  claude: 'Claude Code',
  commandcode: 'Command Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  grok: 'Grok',
  opencode: 'Opencode',
  freebuff: 'Freebuff',
  shell: 'Shell',
}

export type SessionStatus = 'starting' | 'idle' | 'running' | 'stopped' | 'error'

/** Durable execution-ledger state for a user prompt. */
export type PromptDelivery = 'accepted' | 'queued' | 'starting' | 'delivered' | 'cancelled' | 'failed'

/** Semantic lifecycle of a persisted turn. */
export type TurnStatus = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled'

/** Ownership of an actor's writer/control plane. */
export type ActorOwnership = 'provider' | 'sedano'

/** Durable lifecycle of a main or child actor. */
export type ActorStatus = 'starting' | 'running' | 'completed' | 'failed' | 'cancelled'
export type SessionKind = 'agent' | 'terminal'
export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'auto'
  | 'manual'
  | 'plan'
  | 'bypassPermissions'

/**
 * Reasoning effort, as named by the harness that exposes it.
 *
 * This deliberately is not a closed union. ACP agents publish their own
 * config-option values and new providers already use names such as `minimal`
 * and `ultra`; making sedano's type the authority would force every new level
 * through an app release before the protocol value could even be retained.
 */
export type EffortLevel = string

/** Legacy/default CLI values; capability-aware pickers use each model's list. */
export const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

/** The counters a harness may report. */
export type TokenUsageField = 'input' | 'output' | 'cacheRead' | 'cacheWrite' | 'reasoning'

export const TOKEN_USAGE_FIELDS: TokenUsageField[] = [
  'input',
  'output',
  'cacheRead',
  'cacheWrite',
  'reasoning',
]

export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  /**
   * Counters the protocol never reported.
   *
   * The numbers above stay numbers — every consumer sums them and a sum needs a
   * number — but a zero nobody vouched for is not a fact, and printing "0 cache"
   * for a harness that simply does not publish cache tokens states one. A field
   * listed here is unknown: read it through `usageValue`, which answers `null`,
   * and say nothing rather than say zero. Absent means the old meaning: nobody
   * recorded what was and was not reported (every event persisted before this
   * field existed), so the numbers are taken at face value.
   */
  unreported?: TokenUsageField[]
}

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

/** The value of one counter, or `null` when the protocol did not report it. */
export function usageValue(
  usage: TokenUsage | null | undefined,
  field: TokenUsageField,
): number | null {
  if (!usage) return null
  if (usage.unreported?.includes(field)) return null
  return usage[field]
}

/**
 * Tag the counters a harness left out, so the difference between "zero tokens"
 * and "this protocol does not say" survives into the UI.
 */
export function markUnreported(usage: TokenUsage, fields: TokenUsageField[]): TokenUsage {
  if (!fields.length) return usage
  const merged = new Set([...(usage.unreported ?? []), ...fields])
  return { ...usage, unreported: [...merged] }
}

export function addUsage(a: TokenUsage, b: Partial<TokenUsage> | null | undefined): TokenUsage {
  if (!b) return a
  // A counter stays unknown only while nothing has reported it: the moment one
  // side carries a real number the sum means something, so the tag is dropped.
  const unreported = (a.unreported ?? []).filter(
    (field) => b[field] === undefined || b.unreported?.includes(field),
  )
  const sum: TokenUsage = {
    input: a.input + (b.input ?? 0),
    output: a.output + (b.output ?? 0),
    cacheRead: a.cacheRead + (b.cacheRead ?? 0),
    cacheWrite: a.cacheWrite + (b.cacheWrite ?? 0),
    reasoning: a.reasoning + (b.reasoning ?? 0),
  }
  return unreported.length ? { ...sum, unreported } : sum
}

export interface SessionMetrics {
  /** Estimated output tokens/sec over a short rolling window (chars/4 heuristic). */
  tps: number
  /** Average tokens/sec since the current/last turn started. */
  tpsAvg: number
  /** Time to first token of the last turn, in ms. */
  lastTtftMs: number | null
  outputTokens: number
  inputTokens: number
  /** Input served from the prompt cache (much cheaper than fresh input). */
  cacheReadTokens: number
  /** Input written to the prompt cache. */
  cacheWriteTokens: number
  contextTokens: number
  contextWindow: number
  costUsd: number
  /**
   * Whether any harness actually reported a cost. Several bill a subscription
   * and publish nothing at all, and `$0.0000` is a claim about the price, not an
   * absence of one. `false` means "not said": show nothing. Absent keeps the old
   * meaning (unspecified), so a server or fixture that does not set it renders
   * exactly as before.
   */
  costReported?: boolean
  /** Same rule for the context ring: `false` means the harness never said. */
  contextReported?: boolean
  /**
   * Whether the window is a guess about the model rather than a number the
   * harness gave us.
   *
   * There are three honest states here, not two. Claude publishes its window;
   * the ACP agents publish none, and the server fills one in from the model name
   * on purpose, because a ring that only ever works for one harness is worse
   * than an approximate one everywhere (see `guessContextWindow`). But an
   * inferred window must not be drawn like a measured one: the occupancy is real
   * and the denominator is an assumption, so it reads as "about", not as fact.
   * `true` is that middle state — `contextReported` is still true, because there
   * *is* a window to draw with. Absent keeps the old meaning: not inferred.
   */
  contextWindowInferred?: boolean
  turnActive: boolean
}

export function emptyMetrics(): SessionMetrics {
  return {
    costReported: false,
    contextReported: false,
    contextWindowInferred: false,
    tps: 0,
    tpsAvg: 0,
    lastTtftMs: null,
    outputTokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    contextTokens: 0,
    contextWindow: 0,
    costUsd: 0,
    turnActive: false,
  }
}

/* ------------------------------------------------------------------ */
/* Timeline                                                            */
/* ------------------------------------------------------------------ */

export type SubagentStatus = 'running' | 'done' | 'error' | 'stopped'

/**
 * Where a tool call is in its life.
 *
 * A call and its result are two events, which says whether an answer has landed
 * but not why it has not: a call sitting in a harness' queue and a call already
 * executing look identical, and so do "finished" and "finished badly" until the
 * result is read. Harnesses that publish these states (Command Code's
 * `tool_queued`/`tool_running`/`tool_completed`, ACP's tool call updates) fill
 * this in; the rest leave it absent, which keeps meaning exactly what it meant
 * before: the pairing of call and result is all we know.
 */
export type ToolStatus = 'queued' | 'running' | 'completed' | 'error'

/**
 * What happens to a question the agent asked the user.
 *
 * A request is a piece of state, not a message: it is answered, or it dies with
 * the process that asked. Without this a pending question persisted before a
 * restart comes back as a card that still looks clickable, wired to a
 * continuation that no longer exists. `expired` is that case — the process is
 * gone, nobody can answer it now — and `cancelled` is a stop or an interrupt
 * closing it deliberately.
 */
export type RequestState = 'pending' | 'answered' | 'expired' | 'cancelled'

/** Permission to run something, or a plain question: the user answers both the same way. */
export type RequestKind = 'permission' | 'question'

export interface RequestOption {
  id: string
  label: string
  /** One line of explanation, when the harness offers one. */
  hint?: string
  /** How the option reads, so "Deny" is not painted like "Allow". */
  intent?: 'allow' | 'deny' | 'neutral'
}

export interface ToolStatBreakdown {
  read: number
  search: number
  bash: number
  edit: number
  other: number
  linesAdded: number
  linesRemoved: number
}

/**
 * A single renderable unit of a session timeline.
 *
 * `agentId` (attached to SessionEvent, not here) tells the UI that the event
 * belongs to a subagent sidechain rather than the main loop.
 */
/**
 * A file the user attached to a message, stored server-side: an image, or a
 * text document (a long paste, a dropped `.md`; see `documents.ts`).
 */
export interface AttachmentRef {
  id: string
  name: string
  mediaType: string
  /** Text documents only: how many lines the text has. */
  lines?: number
  /** Text documents only: the first few lines, so a chip needs no fetch. */
  preview?: string
}

export type TimelineEvent =
  /** `attachments` is persisted so a replayed transcript still shows the images. */
  | {
      k: 'user'
      text: string
      attachments?: AttachmentRef[]
      /** Stable execution-ledger identity, present on newly accepted prompts. */
      promptId?: string
      /** Durable delivery state; absent on events written by older servers. */
      delivery?: PromptDelivery
      /** For a `cancelled` prompt: who cancelled it (see `PromptRecord.cancelledBy`). */
      cancelledBy?: 'user' | 'server'
      /** For a server cancel: why. */
      cancelReason?: string
    }
  | { k: 'assistant'; text: string; model?: string; usage?: TokenUsage }
  | {
      k: 'thinking'
      text: string
      /**
       * The harness produced reasoning it does not show (a redacted block, or a
       * signed block with the text withheld). `text` is empty; the UI can say
       * "reasoning hidden by the harness". At most one per message.
       */
      hidden?: boolean
    }
  | {
      k: 'tool'
      toolId: string
      name: string
      input: unknown
      summary: string
      /** Lifecycle, when the harness publishes one (see `ToolStatus`). */
      status?: ToolStatus
      /**
       * The protocol's own category of the call, when it has one (ACP `kind`:
       * read, edit, delete, move, search, execute, think, fetch, other).
       */
      kind?: string
      /** The files the call is about, when the protocol names them (ACP `locations`). */
      paths?: string[]
    }
  | {
      k: 'tool_result'
      toolId: string
      text: string
      isError: boolean
      truncated: boolean
      /** Process exit status, for a shell call whose harness reports one. */
      exitCode?: number
      /** Wall time from the call to its result, when both ends are timed. */
      durationMs?: number
      /** The harness stopped the command before it finished (a timeout, an interrupt). */
      interrupted?: boolean
      /** The call moved to the background under this task id (see `subagent_end.background`). */
      backgroundTaskId?: string
    }
  /** A file the agent wrote, with real line counts from the harness' patch. */
  | {
      k: 'file_change'
      toolId: string
      path: string
      change: 'create' | 'edit'
      added: number
      removed: number
      /** Unified-diff excerpt, bounded, for the expandable file card. */
      preview: string
      /**
       * Where the counts come from. `patch` (or absent): the harness' own
       * result. `input`: derived from the tool call's arguments because the
       * harness reported no result to count from (Claude subagent sidechains).
       * A subagent's change also carries `SessionEvent.agentId`.
       */
      source?: 'patch' | 'input'
    }
  | {
      k: 'subagent_start'
      toolId: string
      agentId: string
      agentType: string
      description: string
      prompt: string
      depth: number
      model?: string
      /**
       * When the spawn call was made, from the harness' own timestamp. The live
       * launch frame can be stored before the transcript line that made the
       * call, so a UI placing the card should order by this (and `toolId`, the
       * spawning call) rather than by arrival.
       */
      spawnedAt?: number
    }
  | {
      k: 'subagent_end'
      toolId: string
      agentId: string
      status: SubagentStatus
      durationMs: number
      usage?: TokenUsage
      toolUses: number
      tools?: ToolStatBreakdown
      result: string
      /**
       * True while the harness has only written an empty completion row (it
       * reports this before the real metrics land). The UI keeps the subagent
       * marked as running and the richer record replaces this one in place.
       */
      provisional?: boolean
      /**
       * Set when this is not a subagent at all but a background shell command
       * finishing (`toolId` is the Bash call that launched it, `agentId` its
       * task id). The UI shows it on that call rather than as an agent.
       */
      background?: 'bash'
      /** The background command's exit status, when the harness said it. */
      exitCode?: number
    }
  /**
   * Something the agent is waiting on the user for, with the state it is in.
   *
   * The server owns the lifecycle (a later phase wires it): it writes the event
   * `pending`, rewrites it `answered` with the choice once the driver has taken
   * the answer, and closes it `expired` or `cancelled` when the process that
   * asked is gone. The UI reads `state` and nothing else — only a `pending`
   * request is clickable, every other state is history.
   */
  | {
      k: 'request'
      /** Identifies the request when answering it (`answer_question.toolId`). */
      requestId: string
      kind: RequestKind
      title: string
      detail?: string
      options: RequestOption[]
      state: RequestState
      /** The chosen option, once `state` is `answered`. */
      answeredOptionId?: string
      /** Why it closed without an answer, for `expired`/`cancelled`. */
      closedReason?: string
      /** The tool call this permission is about, when it is about one. */
      toolId?: string
    }
  | {
      k: 'system'
      subtype: string
      text: string
      /**
       * Structured details behind `text`, when the harness gave any: for a
       * compaction `trigger`, `preTokens`, `postTokens`, `durationMs`; for an
       * API error or retry `status`, `message`, `attempt`, `maxRetries`,
       * `retryInMs`. Every key is optional; `text` stays the readable line.
       */
      detail?: Record<string, string | number | boolean>
    }
  | {
      k: 'result'
      /**
       * The provider-neutral meaning of this boundary. Optional for replaying
       * events written by older servers; new writers must always set it.
       * `subtype` remains the provider's raw stop/error reason.
       */
      outcome?: ResultOutcome
      subtype: string
      text: string
      usage?: TokenUsage
      durationMs: number
      costUsd: number
      /**
       * Whether the harness reported a cost at all. `false` means it did not, so
       * `costUsd` is a placeholder and no price is shown. Absent keeps the old
       * meaning for events written before this field existed.
       */
      costReported?: boolean
      /**
       * The final reply text the harness reported for this cycle, when it did.
       * Kept apart from `text`, which is the failure line and is empty on a
       * successful turn.
       */
      reply?: string
    }
  | { k: 'error'; text: string }

/** The three terminal meanings shared by every harness. */
export type ResultOutcome = 'completed' | 'interrupted' | 'failed'

/**
 * Map a provider's raw result reason to the small semantic vocabulary the UI
 * needs. This is only a compatibility bridge for old events and adapters that
 * expose a raw reason without a richer signal; current writers should set
 * `outcome` explicitly on the event they publish.
 */
export function resultOutcomeFor(
  // Rows written before `subtype` was required can lack it; no reason is the
  // ordinary ending, not a crash of the whole transcript.
  subtype: string | null | undefined,
  options: { isError?: boolean } = {},
): ResultOutcome {
  if (options.isError) return 'failed'
  const reason = (subtype ?? '').trim().toLowerCase()
  if (
    [
      'cancelled',
      'canceled',
      'interrupted',
      'aborted',
      'stopped',
      'server_restart',
      'user_abort',
    ].includes(reason)
  ) {
    return 'interrupted'
  }
  if (
    [
      'error',
      'failed',
      'failure',
      'run_error',
      'error_during_execution',
      'agent_exit',
      'crash',
      'exception',
      'server_error',
    ].includes(reason)
  ) {
    return 'failed'
  }
  return 'completed'
}

/** Resolve a result's semantic meaning, preserving compatibility with legacy rows. */
export function resultOutcomeOf(event: Extract<TimelineEvent, { k: 'result' }>): ResultOutcome {
  return event.outcome ?? resultOutcomeFor(event.subtype, { isError: Boolean(event.text) && event.subtype === 'error' })
}

export type TimelineEventKind = TimelineEvent['k']

export interface SessionEvent {
  /** Stable id used for dedupe (source uuid / tool id / synthetic key). */
  id: string
  sessionId: string
  seq: number
  at: number
  /** Set when the event comes from a subagent sidechain. */
  agentId?: string
  /**
   * The turn this event belongs to, decided when it was persisted.
   *
   * Turns used to be rebuilt by reading the transcript in order and starting a
   * new one at every user message, which makes the boundary a property of
   * arrival order rather than of the work: a transcript line or a sidechain
   * event that lands after the next prompt was filed under a prompt that did not
   * cause it. With the id attached at the source, a late event of turn A stays in
   * turn A no matter when it shows up. Absent on everything persisted before this
   * existed, and the sequential heuristic still covers those.
   */
  turnId?: string
  /**
   * The event that caused this one, where the protocol says so — a tool result
   * pointing at its call, a subagent's first event pointing at the spawn.
   */
  parentEventId?: string
  /**
   * The agent that spawned the one this event belongs to. `agentId` says which
   * sidechain an event is in; this says what that sidechain hangs off, which is
   * the only way to nest agents more than one level deep.
   */
  parentAgentId?: string
  ev: TimelineEvent
}

/* ------------------------------------------------------------------ */
/* Sessions / projects / limits                                        */
/* ------------------------------------------------------------------ */

/**
 * Whether a "model" a harness reported is a placeholder rather than a model.
 *
 * Claude Code fabricates assistant messages of its own — the reply to a slash
 * command, "No response requested.", an API error it turns into prose — and
 * stamps them `"model": "<synthetic>"`, which is the CLI's own sentinel for "no
 * model produced this" (the string is in the binary next to the very texts it
 * puts in those messages). Adopting it made the session claim to be running a
 * model that does not exist: it reached the rail, the summary, the stored row
 * and the picker, where it was offered as something you could switch to.
 *
 * The test is the shape, not the one string: a value wrapped in angle brackets
 * is a sentinel in every protocol that has ever used one, and no real model id
 * is spelled that way. Nothing is invented here beyond that — a sentinel we
 * have not seen still fails the same test for the same reason.
 */
export function isPlaceholderModel(model: string | null | undefined): boolean {
  if (!model) return false
  const value = model.trim()
  return value.startsWith('<') && value.endsWith('>')
}

/** The model, or `null` when what we were handed is a placeholder (see above). */
export function realModel(model: string | null | undefined): string | null {
  if (!model) return null
  return isPlaceholderModel(model) ? null : model
}

/** One model a harness can run, as offered by the picker. */
export interface ModelInfo {
  id: string
  label: string
  isDefault?: boolean
  /**
   * Whether this model takes image input. Absent means the catalog did not say,
   * and the harness's own answer (see `HarnessInfo.images`) is what counts —
   * which is the common case for a model id nobody here has heard of.
   */
  images?: boolean
  /**
   * The reasoning efforts this model accepts, when the harness publishes them.
   * `[]` means it has none, so no effort is sent at all. Absent means unknown;
   * a client must not invent values for it.
   */
  efforts?: string[]
}

/** A command the harness itself exposes, typed with a leading slash. */
export interface HarnessCommand {
  name: string
  description: string
  /** Where it comes from, so the menu can label a skill differently. */
  kind?: 'command' | 'skill'
}

/** Result of checking the external executable that provides an ACP harness. */
export interface HarnessUpdateInfo {
  status: 'current' | 'available' | 'unknown'
  installedVersion: string | null
  latestVersion: string | null
  /** A command the user may run; Sedano never installs software on selection. */
  updateCommand: string | null
  detail: string
  checkedAt: number
}

/** Everything the UI needs to build a picker, straight from the server. */
export interface HarnessInfo {
  id: HarnessId
  label: string
  note: string
  /** The binary looked up in PATH, so the UI can say exactly what to install. */
  bin: string
  /** An adapter exists in this build. */
  wired: boolean
  installed: boolean
  version: string | null
  models: ModelInfo[]
  /**
   * Why the model list is empty, when the harness was asked and could not
   * answer. Absent while a scan is in flight, or when there is nothing to say.
   */
  modelsNote?: string
  /** Present after this harness has been selected and its updater was checked. */
  update?: HarnessUpdateInfo
  /** The harness' own slash commands, for the `/` menu in the composer. */
  commands: HarnessCommand[]
  /**
   * Only a terminal UI exists, so this cannot be streamed as a chat. Picking it
   * in the agent list opens the terminal tab it actually is, instead of a
   * transcript that would never fill up.
   */
  tui?: boolean
  /**
   * Whether the harness can carry an image at all. This is *not* the whole
   * answer: whether an image reaches the model is a fact about the model (see
   * `ModelInfo.images`), which is why the composer asks about both. False here
   * means no model of this harness can be sent one, and `imagesNote` says why.
   */
  images: boolean
  /** One line explaining a harness that cannot take images, for the composer. */
  imagesNote?: string
  /**
   * The approval modes this harness actually has.
   *
   * They are not the same everywhere — Claude has six, the flag-driven CLIs have
   * four, and a terminal tab has none, because nothing approves anything on a
   * shell's behalf. The list belongs to the harness, so the server publishes it
   * and the picker offers exactly what it is given: a table kept in the UI is a
   * copy that goes stale the first time a CLI changes its flags, and offering a
   * mode a harness does not have is a promise the session cannot keep. Absent
   * from an older server, which is what tells a client to fall back.
   */
  permissionModes?: PermissionMode[]
  /**
   * Whether you want this harness offered on this machine.
   *
   * Detection and choice are two different answers and they were conflated:
   * `installed` says the binary is there, this says you want to see it. The
   * preference is per machine on purpose — the same CLI on a laptop and on a
   * server are two installations, with two accounts and two quotas — and it is
   * opt-*out*, so a newly installed harness shows up by itself.
   *
   * It is a preference about pickers and nothing else. A session already running
   * a harness you hid keeps running, keeps its models and its approval modes,
   * and can still be resumed: hiding a harness is not uninstalling it, and a
   * setting that silently killed work would be a much worse answer than a row in
   * a list. Absent from an older server, which means "offered", because that is
   * what every server before this field did.
   */
  enabled?: boolean
}

/** A command a terminal tab can be opened with. */
export interface PresetInfo {
  id: string
  label: string
  hint: string
  /** False when the binary is missing on this machine. */
  available: boolean
}

/** Which dictation engine you asked for; `auto` is "whichever is there". */
export type VoiceProvider = 'auto' | 'whisper-cli' | 'openai'

/** One whisper.cpp model file found on this machine. */
export interface VoiceModelFile {
  /** Absolute path, which is also what is sent to the engine. */
  path: string
  /** The file name, which is the only part worth reading. */
  label: string
  bytes: number
}

/** A model download in progress, or the one that just failed. */
export interface VoiceDownload {
  received: number
  total: number
  state: 'downloading' | 'verifying' | 'failed'
  error: string | null
}

/**
 * One official whisper.cpp model, whether or not it is on this machine yet.
 * `path` is set once it is downloaded; `download` while it is being fetched.
 */
export interface VoiceCatalogModel {
  /** File name on Hugging Face and on disk, e.g. `ggml-large-v3-turbo-q5_0.bin`. */
  file: string
  label: string
  bytes: number
  /** Speed and accuracy in a few words, for comparing before downloading. */
  hint: string
  multilingual: boolean
  recommended: boolean
  path: string | null
  download: VoiceDownload | null
}

/** How long the most recent transcription took, for comparing models. */
export interface VoiceLastRun {
  /** Model file name. */
  model: string
  ms: number
  audioSeconds: number
  at: number
}

/**
 * One dictation engine, as this machine actually has it.
 *
 * The selector used to offer three buttons and say nothing about any of them,
 * so picking one that is not installed looked identical to picking one that is.
 * Every field here exists to answer "why can I not use this": `ready` is the
 * verdict, `detail` is what was found, `missing` is what is not there, and
 * `install` is the exact command that would fix it — a line to run in a
 * terminal, never a button that pretends the app can do it.
 */
export interface VoiceEngine {
  id: 'whisper-cli' | 'openai'
  label: string
  ready: boolean
  detail: string
  /** What is missing, in one line. Null when the engine is usable. */
  missing: string | null
  /**
   * The command that installs what is missing, when there is one worth naming.
   * It is shown, not run: installing software is not something an app should do
   * behind a click, and a download nobody watched is not a feature.
   */
  install: string | null
  /** whisper.cpp only: the model files found on this machine. */
  models?: VoiceModelFile[]
  /** whisper.cpp only: the official models, downloaded or not. */
  catalog?: VoiceCatalogModel[]
  /** The local speech server only: the endpoint that answered, if one did. */
  endpoint?: string | null
}

export interface VoiceStatus {
  /** The engine a recording would actually go to, right now. */
  provider: 'whisper-cli' | 'openai' | 'none'
  model: string | null
  endpoint: string | null
  /** Spoken language hint passed to the model ('auto' to detect it). */
  language: string
  ready: boolean
  detail: string
  /**
   * What you chose, as opposed to what that choice resolved to.
   *
   * These are two different facts and the selector showed only the second one,
   * which is why clicking it appeared to do nothing: with `auto` selected and
   * whisper.cpp installed, `provider` reads `whisper-cli`, so the button that
   * lit up was never the button that was pressed. A control must show the value
   * it sets. Absent from an older server.
   */
  configured?: VoiceProvider
  /** Every engine this machine could use, whether or not it can today. */
  engines?: VoiceEngine[]
  /** The last transcription since the server started, if any. */
  lastRun?: VoiceLastRun | null
}

/**
 * An SSH destination, and whether we have actually reached it.
 *
 * `reach` is `null` until somebody asks — never a green dot nobody earned and
 * never a blank. When a check has run and failed, the kind is the transport's
 * own (`unreachable`, `timeout`, `not_found`, `permission`, `command_failed`),
 * because "could not connect" and "connected, and the command is missing" are
 * different problems with different fixes.
 */
export interface HostStatus {
  host: string
  /** In the allowlist: only these may ever be handed to `ssh`. */
  enabled: boolean
  reach: 'ok' | 'unreachable' | 'timeout' | 'not_found' | 'permission' | 'command_failed' | null
  /** What the check said, in one line. Null when nothing has been checked. */
  detail: string | null
  /** When the check ran, or null if it never has. */
  checkedAt: number | null
}

/**
 * The colour a machine is recognised by, and the small set you may choose from.
 *
 * Several machines' tabs are open at once and they look identical, so the
 * machine needs a mark you can read without reading. It is a *choice*, not a
 * hash of the host name: two servers you never confuse are allowed the same
 * colour, and the one you keep mixing up deserves the one that stands out.
 *
 * An **id**, never a hex, is what is stored and sent. A hex would be one value
 * for two backgrounds — the app has a light theme and a dark one, and a colour
 * legible on white is invisible on #191919 — so each id carries its own value
 * per theme, and Settings offers ids rather than a colour wheel nobody can aim
 * at both themes with. Both values clear 3:1 against every surface they are
 * drawn on, in both themes (see `scripts/machine-color-test.ts`).
 *
 * It lives in the shared domain because the server persists it and validates it
 * before it does: a client is free to send anything, and "whatever arrived" is
 * not a colour.
 */
export type MachineColorId =
  | 'slate'
  | 'teal'
  | 'indigo'
  | 'violet'
  | 'amber'
  | 'rose'
  | 'moss'
  | 'clay'

export interface MachineColor {
  id: MachineColorId
  /** The name shown beside the swatch — colour is never the only carrier. */
  label: string
  /** The value used on the light theme, and the one used on the dark theme. */
  light: string
  dark: string
}

export const MACHINE_COLORS: MachineColor[] = [
  { id: 'slate', label: 'Slate', light: '#4a5a68', dark: '#8fa6b8' },
  { id: 'teal', label: 'Teal', light: '#1f6b63', dark: '#5fbfb2' },
  { id: 'indigo', label: 'Indigo', light: '#3f51a8', dark: '#8f9ff0' },
  { id: 'violet', label: 'Violet', light: '#7a3f9e', dark: '#c08ae0' },
  { id: 'amber', label: 'Amber', light: '#8a5a06', dark: '#dba54a' },
  { id: 'rose', label: 'Rose', light: '#a83a58', dark: '#ef8fa6' },
  { id: 'moss', label: 'Moss', light: '#3f6b25', dark: '#8fc06a' },
  { id: 'clay', label: 'Clay', light: '#9c4a2a', dark: '#e0916d' },
]

/**
 * What a machine nobody has chosen a colour for looks like.
 *
 * Not "no colour": an unmarked tab beside marked ones reads as broken rather
 * than as undecided, and this computer is the machine most people never open
 * Settings for. Slate is the app's own neutral, so the default is the absence
 * of a decision rather than a decision made for you.
 */
export const DEFAULT_MACHINE_COLOR: MachineColorId = 'slate'

/**
 * The key a machine's colour is stored under: the empty string is this
 * computer, because `null` is not a key and the ssh aliases are validated
 * elsewhere to never be empty (see `assertSafeHost`).
 */
export const THIS_MACHINE_KEY = ''

export function machineColorKey(host: string | null | undefined): string {
  return host ?? THIS_MACHINE_KEY
}

/** The id if it is one we offer, otherwise null. Anything else is not a colour. */
export function asMachineColorId(value: unknown): MachineColorId | null {
  return MACHINE_COLORS.some((colour) => colour.id === value) ? (value as MachineColorId) : null
}

/** The colour a machine is drawn in, falling back to the default. */
export function machineColorOf(
  colors: Record<string, MachineColorId> | undefined,
  host: string | null | undefined,
): MachineColor {
  const chosen = asMachineColorId(colors?.[machineColorKey(host)]) ?? DEFAULT_MACHINE_COLOR
  return MACHINE_COLORS.find((colour) => colour.id === chosen) ?? MACHINE_COLORS[0]!
}

export interface Capabilities {
  /**
   * The machine the harnesses were probed on: `null` for this computer, or an
   * SSH host. `installed` is a fact about *that* machine, because that is where
   * a session started from this picker will run.
   */
  host: string | null
  /**
   * Why the harnesses could not be looked up, when they could not — an
   * unreachable server, a refused ssh. An empty list then means "we could not
   * see that machine", never "it has nothing installed".
   */
  probeError: string | null
  harnesses: HarnessInfo[]
  presets: PresetInfo[]
  /** The SSH hosts you enabled — the only ones offered anywhere in the app. */
  hosts: string[]
  /** Every host `~/.ssh/config` defines, so Settings can offer them to import. */
  availableHosts: string[]
  /**
   * Every candidate with what we know about it: enabled or not, and whether it
   * has ever answered. One row per `availableHosts` entry, so a machine that was
   * never contacted says so rather than showing an empty cell. Absent from an
   * older server.
   */
  hostStatus?: HostStatus[]
  voice: VoiceStatus
  /**
   * Protocol messages a harness sent that sedano has no mapping for (see
   * docs/testing.md, "Coverage"). Empty when every type seen is handled or
   * knowingly ignored; absent from an older server.
   */
  unhandledEvents?: UnhandledEvent[]
}

/** One protocol type a harness emitted that sedano does not handle yet. */
export interface UnhandledEvent {
  /** `claude`, `acp` or `commandcode` — the protocol, not the harness id. */
  protocol: string
  /** The harness the message came from (`claude`, `codex`, `gemini`, …). */
  harness: string
  /** The inventory key, e.g. `stream:system/new_thing` or `update:new_update`. */
  key: string
  /** `live`: seen in a running session. `inventory`: new in an installed version's published schema. */
  source: 'live' | 'inventory'
  /** The harness version it was first seen with, when known. */
  version?: string | null
  firstSeen: number
  lastSeen: number
  count: number
}

export interface SessionSummary {
  id: string
  harness: HarnessId
  kind: SessionKind
  title: string
  /**
   * Where the title came from. `user` is a name the user gave the session: it
   * outlives restarts, respawns and transcript re-reads, and nothing derived (the
   * first prompt, a harness summary) replaces it. Absent from an older server.
   */
  titleSource?: 'user' | 'auto'
  /**
   * The agent session a docked terminal belongs to. Such a terminal is part of
   * that session, not a session of its own: it is never listed in the rail, and
   * it is deleted with its parent. Null (or absent) for everything else.
   */
  parentSessionId?: string | null
  /** Terminal tabs remember which command they were opened with. */
  preset: string | null
  cwd: string
  host: string | null
  model: string | null
  status: SessionStatus
  createdAt: number
  updatedAt: number
  /** Harness-native session id (claude uuid, codex thread id, ...). */
  nativeId: string | null
  /** Path of the native transcript, when the harness exposes one. */
  transcriptPath: string | null
  /** Native resume command, shown in the UI so a session is never lost. */
  resumeHint: string | null
  permissionMode: PermissionMode
  effort: EffortLevel | null
  /** Git branch the session started on, when the harness reports it. */
  gitBranch: string | null
  pinned: boolean
  /**
   * True once the session has a first message behind it (a prompt for an agent,
   * typed input for a terminal). Before that it only exists as a tab: the rail
   * lists work, not empty shells.
   */
  started: boolean
  /**
   * Prompts the server accepted while a turn was running and will send at the
   * start of the next one.
   *
   * A prompt typed mid-turn is not lost and is not sent either: it waits, the
   * way the native CLIs make it wait. The count is what lets the UI say so — a
   * composer that clears itself with nothing on screen to show for it is the
   * same silence this whole field exists to break. Absent when the server said
   * nothing about a queue (an older build), which is not the same as zero.
   */
  queuedPrompts?: number
  /**
   * What the user asked for and the harness has not applied yet.
   *
   * Model, reasoning effort and approval mode live in CLI flags or in a protocol
   * exchange the agent can refuse, so asking for one is not the same as having
   * it. The summary carries what is *in effect*; this carries what is on its way,
   * and a key disappears from here the moment the value above it becomes true —
   * the harness confirmed it, or the process that runs it was started with it.
   * Absent when nothing is waiting, which is the ordinary case.
   */
  pendingOptions?: PendingOptions
  metrics: SessionMetrics
}

/** Requested but not yet in effect (see `SessionSummary.pendingOptions`). */
export interface PendingOptions {
  model?: string | null
  effort?: EffortLevel | null
  permissionMode?: PermissionMode
}

export interface ProjectRef {
  path: string
  name: string
  /** Last activity timestamp seen across all harness stores. */
  lastUsed: number
  exists: boolean
  /** SSH config aliases available for remote workspaces. */
  hosts: string[]
  /** Harnesses that already have sessions in this project. */
  harnesses: HarnessId[]
}

export interface LimitWindow {
  /** 0..100 */
  usedPercent: number
  windowMinutes: number
  resetsAt: number | null
  label: string
}

export interface LimitCredits {
  hasCredits: boolean
  unlimited: boolean
  balance: string | null
}

export interface LimitSnapshot {
  harness: HarnessId
  plan: string | null
  windows: LimitWindow[]
  credits: LimitCredits | null
  updatedAt: number
  error: string | null
  /**
   * Set when the harness has no quota to read at all (it bills your own API key,
   * or exposes no endpoint): the panel explains the absence instead of leaving
   * the reader wondering why half the harnesses are missing.
   */
  note?: string | null
  /**
   * Set when reading this harness's account is switched off in Settings (it
   * would send a stored credential to the vendor). An unknown, not a zero.
   */
  off?: boolean
}

/** Human label for a rolling window expressed in minutes. */
export function windowLabel(minutes: number): string {
  if (minutes <= 0) return '?'
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}
