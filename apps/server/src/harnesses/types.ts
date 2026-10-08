import type {
  AttachmentRef,
  EffortLevel,
  HarnessId,
  LimitCredits,
  LimitWindow,
  PermissionMode,
  SessionStatus,
  TimelineEvent,
  TokenUsage,
} from '@shared'

/* ------------------------------------------------------------------ */
/* Failures, said in words                                             */
/* ------------------------------------------------------------------ */

/**
 * Who the failure belongs to.
 *
 * This is the question a person actually asks when something breaks — "is this
 * mine to fix?" — and it has four different answers with four different fixes.
 * A crash inside a vendor's Node wrapper is not the same event as a prompt the
 * model refused, and rendering both as the same red block is what made a stack
 * trace unreadable: not the trace, the absence of an answer to that question.
 *
 * `unknown` is a real value, not a gap to be filled with a guess. Saying "we
 * could not tell" is information; naming the wrong culprit is worse than saying
 * nothing, because the reader acts on it.
 */
export type FailureOrigin = 'agent' | 'wrapper' | 'transport' | 'sedano' | 'unknown'

/**
 * The shapes that actually occur, each derived from something a harness really
 * emits (see `scripts/error-test.ts`, which carries one captured sample per
 * shape and is where new ones are added).
 */
export type FailureShape =
  | 'crash'
  | 'broken_pipe'
  | 'ssh'
  | 'not_installed'
  | 'signed_out'
  | 'quota'
  | 'exited'
  | 'refused'
  | 'unknown'

export interface FailureContext {
  /** The harness as a person names it ("Gemini CLI"), never the internal id. */
  harness: string
  /** The binary sedano spawned, when the call site knows it. */
  bin?: string | null
  /** The machine it ran on; `null` is this computer. */
  host?: string | null
  /** What the call site already knows about the origin, when it knows anything. */
  origin?: FailureOrigin
  /** One clause of extra context the call site owns (`refused the model "x"`). */
  because?: string
}

export interface Failure {
  /** One paragraph, plain language: what broke, whose it is, what to do. */
  headline: string
  /** Everything we were handed, verbatim. Empty only when there was nothing. */
  detail: string
  origin: FailureOrigin
  shape: FailureShape
}

/**
 * How a normalized failure is carried in `{ k: 'error', text }`.
 *
 * The shared timeline event has one string and nothing else, and that is enough:
 * a headline paragraph, a blank line, then the raw report. It reads correctly in
 * a log, in a copy-paste and in a terminal, and the UI splits on the first blank
 * line to put the raw half behind a disclosure. An error that was never
 * normalized has no blank line, so it renders exactly as it always did — which
 * is what keeps every event persisted before this existed readable.
 */
export const FAILURE_SEPARATOR = '\n\n'

/** Whatever we were handed, as text, without inventing anything. */
function rawText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (value instanceof Error) {
    /*
     * The message, deliberately not the stack.
     *
     * An `Error` this server caught in its own `try` is a *result*, not a crash:
     * its stack describes our control flow, and printing it both drowns the one
     * useful sentence and — worse — makes the text look exactly like an uncaught
     * exception, so the classifier below would attribute our own tidy refusal to
     * a program crashing. A real crash reaches us as text a child process
     * printed, and that text keeps every frame it came with.
     */
    return value.message.trim()
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.message === 'string') return record.message.trim()
    try {
      return JSON.stringify(value)
    } catch {
      // A value that will not serialize still has a shape worth naming: saying
      // "[object Object]" is the one outcome this whole module exists to avoid.
      return Object.prototype.toString.call(value)
    }
  }
  return String(value)
}

/** The machine a person would name: "this machine", or the ssh alias. */
function machineOf(ctx: FailureContext): string {
  return ctx.host ? `“${ctx.host}”` : 'this machine'
}

/**
 * A Node stack trace, as a Node process prints one when nothing caught it.
 *
 * `node:internal/` frames are the giveaway and they are decisive: sedano's own
 * server runs on Bun, whose frames never carry that prefix, so a trace holding
 * them was printed by a Node process we spawned — a vendor's ACP wrapper — and
 * not by us. `    at file:line:col` frames alone are weaker evidence (Bun prints
 * those too), so they only count as a crash when a `Name: message` line opens
 * the text, which is what an uncaught exception looks like and what ordinary
 * logging does not.
 */
const NODE_INTERNAL_FRAME = /^\s+at .*\(?node:internal\//m
const STACK_FRAME = /^\s+at [\w$.<>[\]\s]+ ?\(?[^\s].*:\d+:\d+\)?$/m
const ERROR_HEADER = /^(?:Uncaught\s+)?(?:[A-Za-z_$][\w$]*)?Error(?::|\b)/m
const EXPLICIT_CRASH = /\buncaught(?:Exception)?\b|\bunhandled(?:Rejection| exception)\b/i

export function isCrashReport(text: string): boolean {
  if (!text) return false
  if (NODE_INTERNAL_FRAME.test(text)) return true
  if (EXPLICIT_CRASH.test(text) && STACK_FRAME.test(text)) return true
  return ERROR_HEADER.test(text) && STACK_FRAME.test(text)
}

/**
 * The `Name: message` an uncaught exception opens with, when it has one.
 *
 * Chatter is skipped rather than taken as the summary: a wrapper that printed a
 * deprecation notice five minutes before it died would otherwise have that
 * notice quoted as the cause, which is a wrong answer dressed as a precise one.
 */
function crashSummary(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('at ') || isStderrChatter(trimmed)) continue
    return trimmed.length > 160 ? `${trimmed.slice(0, 157)}…` : trimmed
  }
  return ''
}

/**
 * Lines a CLI prints on its way to working.
 *
 * stderr is not an error channel — it is the channel that is not stdout — and
 * every Node CLI in this app writes deprecation notices, npm chatter and its own
 * progress there. Promoting any of it to a red card taught the reader to ignore
 * red cards, which is how a real failure gets missed. Nothing matched here is
 * deleted: it stays in the driver's stderr tail and is carried, verbatim, in the
 * detail of whatever failure comes later.
 */
const CHATTER = [
  // `(node:48221) ExperimentalWarning: …`, `[DEP0040] DeprecationWarning: …`
  /^\(node:\d+\)/,
  /\b(?:Experimental|Deprecation|Buffer|MaxListeners)Warning\b/,
  /^\(Use `node --trace-/,
  /^npm (?:warn|notice|WARN)\b/i,
  /^(?:warn|warning|info|debug|trace|verbose|notice)\b[: ]/i,
  /^\[(?:warn|warning|info|debug|trace|verbose|notice)\]/i,
  // Progress and banners: a spinner frame, a download bar, a version line.
  /^[\s⠁-⣿·.\-=>]*\d+%/,
  /^(?:Downloading|Fetching|Installing|Compiling|Loading|Starting)\b/i,
]

/**
 * Whether one stderr line is chatter rather than a failure.
 *
 * Deliberately a per-line question: a wrapper prints its deprecation notice and
 * then, ten seconds later, dies. Judging the whole buffer would let the notice
 * hide the crash or the crash condemn the notice.
 */
export function isStderrChatter(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return true
  return CHATTER.some((pattern) => pattern.test(trimmed))
}

/** An object shaped like the transport's `RemoteError`, without importing it. */
const SSH_KINDS = ['unreachable', 'timeout', 'not_found', 'permission', 'command_failed'] as const
type SshKind = (typeof SSH_KINDS)[number]

function sshKindOf(value: unknown): { kind: SshKind; host: string | null; reason: string } | null {
  // Duck-typed on purpose: `types.ts` is the harness contract and importing the
  // transport here would tie every adapter to it for one `instanceof`.
  if (!value || typeof value !== 'object') return null
  const record = value as { name?: unknown; kind?: unknown; host?: unknown; reason?: unknown; message?: unknown }
  if (record.name !== 'RemoteError') return null
  if (typeof record.kind !== 'string' || !SSH_KINDS.includes(record.kind as SshKind)) return null
  return {
    kind: record.kind as SshKind,
    host: typeof record.host === 'string' ? record.host : null,
    reason: typeof record.reason === 'string' ? record.reason : String(record.message ?? ''),
  }
}

/**
 * What each transport kind means to the person reading it.
 *
 * The transport already made the distinction that matters (`unreachable` is not
 * `not_found`); all this does is stop it being thrown away one layer higher,
 * where every one of them used to read as "the agent failed".
 */
function sshHeadline(kind: SshKind, host: string, harness: string, alias: string | null): string {
  switch (kind) {
    case 'unreachable':
      // The alias unquoted inside the command: a line somebody is meant to
      // retype has to be a line that runs, and `ssh “lab”` is not one.
      return `Could not reach ${host} over SSH, so ${harness} never started there. Check the machine is up and that${alias ? ` \`ssh ${alias}\`` : ' the connection'} works from a terminal.`
    case 'timeout':
      return `${host} accepted the connection but did not answer in time, so ${harness} never started there. It may be loaded or the link may be slow — try again.`
    case 'not_found':
      return `${host} answered, but what sedano asked for is not on that machine. Nothing ran: this is a missing path or binary on ${host}, not a fault in ${harness}.`
    case 'permission':
      return `${host} refused on permission grounds. The connection worked, so this is what your account may touch on that machine.`
    case 'command_failed':
      return `The command sedano ran on ${host} failed. The connection was fine, so the failure is on that machine rather than in the link to it.`
  }
}

const NOT_INSTALLED = /\bENOENT\b|command not found|no such file or directory|is not recognized as/i
const SIGNED_OUT =
  /authentication required|not (?:logged|signed) in|unauthor(?:ised|ized)|\b401\b|invalid api key|no credentials|please (?:run )?[`'"]?\w+ login|requires? (?:a )?(?:sign.?in|log.?in)/i
const QUOTA = /\b429\b|rate.?limit|usage limit|quota|too many requests|overloaded|insufficient (?:credit|quota)/i
const BROKEN_PIPE = /\bEPIPE\b|\bECONNRESET\b|broken pipe|write after end|ERR_STREAM_(?:DESTROYED|WRITE_AFTER_END)|premature close/i
const EXITED = /exited (?:with code |\()(-?\d+|signal)/i

/**
 * Turn whatever a harness handed us into something a person can read, without
 * losing a character of it.
 *
 * Two halves, always: a headline that says what broke and whose it is, and the
 * raw report kept verbatim underneath. The headline is derived only from
 * evidence in the text — a `node:internal` frame, a transport kind, an exit
 * code. Where the evidence runs out the headline says so, which is the one
 * honest thing to print over a message nobody has recognised.
 */
export function describeFailure(raw: unknown, ctx: FailureContext): Failure {
  const text = rawText(raw)
  const harness = ctx.harness
  const machine = machineOf(ctx)
  const where = ctx.bin ? ` (\`${ctx.bin}\`)` : ''

  const ssh = sshKindOf(raw)
  if (ssh) {
    const host = ssh.host ? `“${ssh.host}”` : 'the remote machine'
    return {
      headline: sshHeadline(ssh.kind, host, harness, ssh.host),
      detail: text,
      origin: 'transport',
      shape: 'ssh',
    }
  }

  // A crash is evidence about *who*, a broken pipe is evidence about *what*, and
  // the two compose: the EPIPE dump that started this work is both. Origin is
  // decided first so the cause can be phrased with it.
  const crashed = isCrashReport(text)
  const fromWrapper = NODE_INTERNAL_FRAME.test(text)
  const origin: FailureOrigin = fromWrapper
    ? 'wrapper'
    : (ctx.origin ?? (crashed ? 'agent' : 'unknown'))
  const owner = fromWrapper
    ? `${harness}'s own command-line wrapper${where}`
    : `${harness}${where}`

  if (BROKEN_PIPE.test(text)) {
    return {
      headline: `${owner} closed its side of the connection while sedano was still writing to it — a broken pipe. The process had already gone away, so nothing you typed caused this${crashed ? '; the crash it printed on its way out is below' : ''}. Send your message again to start it back up.`,
      detail: text,
      origin: fromWrapper ? 'wrapper' : origin,
      shape: 'broken_pipe',
    }
  }

  if (crashed) {
    const summary = crashSummary(text)
    return {
      headline: `${owner} crashed with an internal error${summary ? ` — ${summary}` : ''}. This is a fault inside that program, not in your prompt or this session; the full stack trace is kept below. Send your message again to start it back up.`,
      detail: text,
      origin,
      shape: 'crash',
    }
  }

  if (NOT_INSTALLED.test(text)) {
    return {
      headline: `${harness} is not installed on ${machine}${ctx.bin ? ` — sedano looked for \`${ctx.bin}\` on the PATH and found nothing` : ''}. Install it there, then send your message again.`,
      detail: text,
      origin: 'sedano',
      shape: 'not_installed',
    }
  }

  if (SIGNED_OUT.test(text)) {
    return {
      headline: `${harness} is installed on ${machine} but nobody is signed in to it${ctx.bin ? ` — run \`${ctx.bin} login\` in a terminal` : ''}, then send your message again.`,
      detail: text,
      origin: 'agent',
      shape: 'signed_out',
    }
  }

  if (QUOTA.test(text)) {
    return {
      // Nothing is said about *when* it resets: the message rarely carries that,
      // and a reset time nobody published would be an invention.
      headline: `${harness} refused the request because its usage limit is spent. The session is fine — wait for the limit to come back, or switch to another harness for now.`,
      detail: text,
      origin: 'agent',
      shape: 'quota',
    }
  }

  if (ctx.because) {
    return {
      headline: `${harness} ${ctx.because}.`,
      detail: text,
      origin: ctx.origin ?? 'agent',
      shape: 'refused',
    }
  }

  const exited = EXITED.exec(text)
  if (exited) {
    return {
      headline: `${harness} stopped on its own${where} — it exited with code ${exited[1]} in the middle of the turn. Whatever it printed on its way out is below. Send your message again to start it back up.`,
      detail: text,
      origin: ctx.origin ?? 'agent',
      shape: 'exited',
    }
  }

  return {
    // The honest answer when the evidence runs out. It is deliberately not
    // dressed up as a diagnosis: the reader is told that nothing was recognised
    // and handed the whole report, rather than given a guess to act on.
    headline: `${harness} reported a failure that sedano does not recognise, so it is passed on exactly as it arrived. The full report is below.`,
    detail: text,
    origin: ctx.origin ?? 'unknown',
    shape: 'unknown',
  }
}

/**
 * The same thing as one string, in the shape `{ k: 'error', text }` carries:
 * headline, blank line, raw report. No detail means no separator, so a short
 * failure stays one line.
 */
export function formatFailure(raw: unknown, ctx: FailureContext): string {
  const failure = describeFailure(raw, ctx)
  if (!failure.detail) return failure.headline
  // A raw report the headline already quotes in full would be printed twice.
  if (failure.headline.includes(failure.detail)) return failure.headline
  return `${failure.headline}${FAILURE_SEPARATOR}${failure.detail}`
}

export interface ModelInfo {
  id: string
  label: string
  isDefault?: boolean
  /** Whether the model reads images; absent means the catalog did not say. */
  images?: boolean
  /** The efforts it accepts, `[]` for none, absent for unknown. */
  efforts?: string[]
}

/** Callbacks a driver uses to publish normalized state. */
export interface DriverHooks {
  event(
    ev: TimelineEvent,
    opts?: {
      id?: string
      at?: number
      agentId?: string
      /** The timeline event that directly caused this event, when known. */
      parentEventId?: string
      /** The agent that owns/spawned the sidechain this event belongs to. */
      parentAgentId?: string
    },
  ): void
  delta(key: string, kind: 'text' | 'thinking', text: string, agentId?: string): void
  status(status: SessionStatus): void
  model(model: string): void
  usage(
    usage: Partial<TokenUsage>,
    opts?: {
      contextWindow?: number;
      /** `contextWindow` is the driver's estimate, not a number the harness stated. */
      contextWindowInferred?: boolean;
      /** What the harness says the conversation occupies, when it says it. */
      contextTokens?: number;
      /**
       * `usage` is one model call's (its input is the conversation's size and its
       * output is that message's), not a turn's calls summed together.
       */
      perMessage?: boolean;
      costUsd?: number;
      commitTurn?: boolean;
    },
  ): void
  /** Authoritative incremental output tokens (used for live tokens/sec). */
  tokens(count: number): void
  /**
   * The driver is about to report the session's whole usage history again
   * (Claude re-reads its transcript on every attach): the counts are rebuilt
   * from it rather than added to what was saved before a restart.
   */
  usageReplay?(): void
  nativeId(id: string): void
  resumeHint(hint: string): void
  title(title: string): void
  error(message: string): void
  /** True when the turn has produced its first output. */
  turnStarted(): void
  /**
   * Raw terminal output for a terminal tab. Live only: never persisted.
   *
   * `offset` is how far into the pane's own output stream this chunk ends. It is
   * what keeps a replayed screen and the live stream from contradicting each
   * other: a chunk the screen already covers is not drawn again, and a screen
   * older than the chunks already drawn is not drawn at all.
   */
  terminal(data: string, offset?: number): void
  /** Cheap session facts the harness reveals in passing. */
  meta(meta: { gitBranch?: string | null; permissionMode?: string | null }): void
  /**
   * Live subscription limits reported by the harness itself while it runs.
   * This is the authoritative source: it needs no credentials of its own.
   */
  limits(windows: LimitWindow[], meta: { plan?: string | null; credits?: LimitCredits | null; error?: string | null }): void
  /**
   * The harness process is gone — whatever its exit status. Every child agent
   * lived inside it, so the manager ends them all (`stopped`) before the
   * status that follows settles the turn. Optional: a driver whose process
   * lives for one turn has nothing left running when it exits.
   */
  processExited?(): void
}

/**
 * A terminal screen as a client should draw it: the capture, escapes included,
 * and where the cursor sits in it.
 *
 * The cursor cannot be read off the capture. tmux pads every row to the width of
 * the pane and `capture-pane` drops the padding, so the text ends left of where
 * the cursor really is — a client that guesses puts its own cursor a cell early,
 * and the shell's next echo (a character, a backspace, then the line repainted,
 * which is how every ZLE writes) lands on a cell that belonged to the prompt.
 */
export interface TerminalScreen {
  screen: string
  cursor: { x: number; y: number } | null
  /** How much of the pane's output stream this screen accounts for. */
  offset: number
}

/**
 * The result of handing a prompt to a harness.
 *
 * This describes delivery rather than the eventual agent turn. `delivered`
 * reached a boundary that confirmed the write; `accepted` reached a live
 * streaming transport that has no per-message acknowledgement; `queued` is
 * owned by the driver but has not reached its native process yet. `refused`
 * means the driver did not take ownership, so callers may keep or retry it.
 * Expected delivery failures resolve as `refused`, rather than rejecting.
 */
export type SendResult =
  | { status: 'accepted' }
  | { status: 'delivered' }
  | { status: 'queued' }
  | { status: 'refused'; reason: string }

export interface Driver {
  readonly alive: boolean
  /**
   * The harness takes a new user message while a turn is running and folds it
   * into its work itself (Claude's stream-json input is queued by the CLI and
   * absorbed at its next opportunity, as the TUI does). The manager then sends
   * at once instead of holding the prompt in its own queue. Absent: queued.
   */
  readonly midTurnInput?: boolean
  /** `attachments` is ignored by drivers whose adapter does not set `images`. */
  send(text: string, attachments?: AttachmentRef[]): Promise<SendResult>
  interrupt(): void
  /**
   * Answer the question this session is waiting on, if it is waiting on one.
   * Optional: harnesses whose protocol cannot ask never implement it.
   */
  answerQuestion?(toolId: string, optionId: string): void
  stop(): void
  /**
   * Terminal drivers only: removing a session must take its tmux session too.
   * Optional, because for an agent driver stopping and deleting are the same.
   */
  destroy?(): void
  /**
   * Durable drivers only: let go of the process without ending it, for a server
   * that is exiting. Readers, tails and timers stop and the resume note is left
   * on disk (with the offset read so far), so the next server reattaches to the
   * agent that kept working. The opposite of `stop()`, which ends the agent.
   */
  detach?(): void
  /** Terminal drivers only; optional so agent drivers stay unchanged. */
  write?(data: string): void
  resize?(cols: number, rows: number): void
  snapshot?(history?: boolean): Promise<TerminalScreen>
  /**
   * Model, reasoning effort and approval mode are CLI flags, so a change only
   * takes effect on a fresh process. Drivers drop the current one and let the
   * next message respawn it, preserving history.
   */
  configure(patch: Partial<Pick<CreateOptions, 'model' | 'effort' | 'permissionMode'>>): void
}

export interface CreateOptions {
  /** Our own session key (used for storage and the wire protocol). */
  sessionId: string
  /** Harness-native session id; when set we reopen that session. */
  nativeId: string | null
  cwd: string
  host: string | null
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode
  /** Terminal tabs only: which command the tab runs (see presets.ts). */
  preset?: string | null
  /**
   * Pick up a process that is still running from before this server started,
   * instead of starting one.
   *
   * Set by the manager, for one creation only, when there is a note on disk
   * saying this session left an agent detached (see `durableLaunch`). A driver
   * that cannot reattach — or that looks and finds the process gone — simply
   * ignores it and starts the ordinary way, which is why this is a hint and not
   * a mode: the outcome must be a session that works either way.
   */
  attach?: boolean
  /**
   * Questions this session was still waiting on when the last server went away.
   *
   * A harness that asks over its protocol is *blocked* on the answer, and the
   * continuation that knew what each answer meant died with the old process. The
   * driver cannot answer them, but it can let the agent go — which is the
   * difference between a session that carries on and one wedged for good.
   */
  pendingRequests?: string[]
  /**
   * Render the conversation the harness replays when the native session is
   * reopened. Set by the manager only while Sedano holds no copy of it — an
   * imported session — so a normal reopen never prints its history twice.
   */
  replayHistory?: boolean
}

export interface DetectResult {
  available: boolean
  bin: string | null
  version: string | null
}

export interface Adapter {
  readonly id: HarnessId
  readonly label: string
  /**
   * The harness can carry an image at all. Whether a given model can *see* one
   * is a different question, answered per model (see `model-images.ts`); this is
   * the harness's own ceiling.
   */
  readonly images?: boolean
  /** Why the ceiling is zero, in one line the composer can show. */
  readonly imagesNote?: string
  detect(): Promise<DetectResult>
  /**
   * The models the agent on `host` can run (null host = this machine). A model
   * list belongs to one installation: an agent on a server has its own account
   * and its own access, so the answer must not be shared between machines.
   */
  models(host: string | null): ModelInfo[]
  /**
   * Optional: learn the model list from something other than a running session.
   * Called in the background when a picker is opened. Implementations must not
   * send a prompt or initiate authentication: discovery is allowed to be a
   * little stale, but it must never spend tokens or open a login flow.
   */
  refreshModels?(host: string | null): Promise<void>
  create(opts: CreateOptions, hooks: DriverHooks): Promise<Driver>
}
