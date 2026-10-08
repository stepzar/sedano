import type { TokenUsage, TokenUsageField, ToolStatus } from '@shared'
import { noteProtocol } from '../coverage.ts'
import { HARNESS_LABEL, emptyUsage, markUnreported, resultOutcomeFor } from '@shared'
import type { CreateOptions, Driver, DriverHooks, FailureContext, SendResult } from '../types.ts'
import { formatFailure } from '../types.ts'
import { LineSplitter } from '../lines.ts'
import {
  DurableTail,
  Transport,
  clearDurableState,
  durableAlive,
  durableDestroy,
  durableExit,
  durableLaunch,
  durableStderr,
  durableTag,
  readDurableState,
  shq,
  writeDurableState,
  type DurableRecord,
  type DurableState,
} from '../../transport.ts'
import { effortsForCommandCodeModel, rememberCommandCodeEfforts } from './efforts.ts'

/**
 * Command Code driver.
 *
 * `cmd` has a headless mode that streams NDJSON (`-p --output-format json`): one
 * `event` frame per step, then a final `result` frame. Unlike Claude, each turn
 * is its own process, and the conversation is continued with `--resume <id>` —
 * so a turn is a spawn, not a message on a long-lived pipe. That actually makes
 * model/effort/approval changes free: they are just flags on the next turn.
 *
 * The frame shapes here were read from a real run, not guessed:
 *   run_start · turn_start · message_start · thinking_{start,delta,end} ·
 *   text_delta · model_request_{start,end} · tool_{queued,running,completed} ·
 *   message_end · turn_end · run_end · result
 */
type Proc = ReturnType<typeof Bun.spawn>

const MAX_STDERR = 600

/** The four counters Command Code publishes, and the domain field each one is. */
const USAGE_KEYS: Array<[TokenUsageField, string]> = [
  ['input', 'inputTokens'],
  ['output', 'outputTokens'],
  ['cacheRead', 'cacheReadTokens'],
  ['cacheWrite', 'cacheWriteTokens'],
]

/**
 * A usage block, with the counters this CLI never publishes named as unknown.
 *
 * Every captured `usage` block carries exactly the four keys above and nothing
 * else — there is no reasoning counter anywhere in the protocol — so filling
 * `reasoning` with `0` was this driver stating a measurement nobody took, which
 * is the one thing `TokenUsage.unreported` exists to prevent. A key that is
 * genuinely missing from a block is marked the same way rather than defaulted.
 */
function usageFrom(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const u = raw as Record<string, unknown>
  const usage = emptyUsage()
  // Reasoning is not "missing from this block": the protocol has no such field.
  const unreported: TokenUsageField[] = ['reasoning']
  for (const [field, key] of USAGE_KEYS) {
    const value = u[key]
    if (typeof value === 'number' && Number.isFinite(value)) usage[field] = value
    else unreported.push(field)
  }
  // The CLI's `inputTokens` is the whole prompt, cache included (AI SDK
  // `inputTokens`, with the cache reads and writes as its details): kept as it
  // came, "Fresh input" and "From cache" counted the cached part twice.
  usage.input = Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite)
  return markUnreported(usage, unreported)
}

/** Text out of an ACP-style content list, or a plain string. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (part && typeof part === 'object') {
        const p = part as Record<string, unknown>
        if (typeof p.text === 'string') return p.text
        if (typeof p.thinking === 'string') return p.thinking
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function textOnly(content: unknown): string {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : ''
  return content
    .map((part) => {
      if (part && typeof part === 'object') {
        const p = part as Record<string, unknown>
        if (p.type === 'text' && typeof p.text === 'string') return p.text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * How a person reopens this conversation themselves — on the machine it ran on.
 *
 * A remote session's hint used to be `cmd -p --resume <id> "…"`: a session id
 * that only exists over there, next to a command that would run here, with a
 * headless flag and an ellipsis nobody can type. Over ssh the whole thing is
 * quoted as one remote command, the way the claude driver already does it.
 *
 * Pure, so it can be checked without opening a connection.
 */
export function resumeCommand(cwd: string, sessionId: string, host: string | null): string {
  const local = `cd ${cwd} && cmd --resume ${sessionId}`
  return host ? `ssh ${host} ${shq(local)}` : local
}

/**
 * Whatever the CLI put in an error field, without losing it.
 *
 * Its errors are structured (`{message, stack, …}` from its own `toError`), and
 * `String(object)` turned every one of them into `[object Object]` — the one
 * text a person cannot act on. A string stays a string; anything else is kept
 * as JSON so nothing is thrown away.
 */
function errorText(raw: unknown, fallback: string): string {
  if (typeof raw === 'string' && raw.trim()) return raw
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>
    const message = typeof record.message === 'string' ? record.message : ''
    const rest = JSON.stringify(raw)
    if (message && rest !== `{"message":${JSON.stringify(message)}}`) return `${message}\n${rest}`
    if (message) return message
    return rest
  }
  return fallback
}

/** A one-line summary for the tool card, from whichever argument is the subject. */
function summarizeTool(name: string, input: unknown): string {
  const obj = (input ?? {}) as Record<string, unknown>
  // `skill`/`name` first: a skill call carries nothing else worth reading, and
  // leaving it out is what reduced the card to the tool's own name. The captured
  // `/cost` run shows the real key is `name` — `activate_skill` is called with
  // `{"name":"costi","arguments":""}` — so a list that only knew `skill` printed
  // a bare "activate_skill" for the one call whose whole meaning is which skill.
  const first = ['skill', 'name', 'path', 'file_path', 'pattern', 'command', 'query', 'url']
    .map((key) => obj[key])
    .find((value) => typeof value === 'string' && value)
  return first ? `${name} ${String(first)}` : name
}

export class CommandCodeDriver implements Driver {
  private stopped = false
  private interrupted = false
  /**
   * The turn's process, which is not a child of this one.
   *
   * Command Code runs one process per turn and reads its prompt to end-of-input,
   * so the turn is launched detached with the prompt already written into a file
   * for its stdin (see `durableLaunch`'s one-shot mode) and its NDJSON going to a
   * log. Closing sedano mid-turn therefore costs nothing: the CLI keeps working,
   * and the next server picks the log up at the byte it had reached.
   */
  private record: DurableRecord | null = null
  private tail: DurableTail | null = null
  /** How far into the turn's output we have read, and what is on disk. */
  private offset = 0
  private lines = new LineSplitter()
  private busy = false
  private readonly queue: string[] = []
  /** Resolves the current caller once its prompt crosses the durable boundary. */
  private delivery: ((result: SendResult) => void) | null = null
  private nativeId: string | null
  private model: string | null
  private effort: string | null
  private permissionMode: string
  private thinking = ''
  private text = ''
  /** Guards against emitting the same answer twice (deltas + final frame). */
  private textEmitted = false
  /**
   * The model the CLI says it ran, from `model_request_end`.
   *
   * `this.model` is what was asked for — often nothing at all, because the
   * default comes from Command Code's own config — so an answer labelled with it
   * was labelled with a blank or with an alias the CLI resolved elsewhere.
   */
  private effectiveModel: string | null = null
  /** The window the CLI stated (`compaction_outcome.contextLimit`), 0 until it has. */
  private reportedWindow = 0
  /** The run's own stop reason, as `run_end` reported it. */
  private stopReason: string | null = null
  /** Set once the native `run_end` has been seen, so the end is not inferred. */
  private runEnded = false
  /** Said once per session: headless Command Code cannot ask the person anything. */
  private modeNoted = false
  /**
   * The failure this run already reported, so it is not reported twice.
   *
   * A failing run says so in `run_error` *and* in its `result` line, and both
   * carry the same reason: reporting each one printed every failure twice and
   * left the turn deciding between "error" and "idle" afterwards.
   */
  private reportedError: string | null = null
  /**
   * What each tool call is, so its card can be rewritten as its state changes.
   *
   * The card is one event with a stable id (`tool:<toolCallId>`), so a later
   * frame enriches the row already in the timeline instead of adding a second
   * one — but only the `tool_queued` frame carries the name and the input, and
   * every later frame has to put them back.
   */
  private readonly toolCalls = new Map<string, { name: string; input: unknown }>()
  /** Retry reasons already reported this run, so a back-off storm is one line. */
  private readonly retriesNoted = new Set<string>()
  /** Where the binary runs: this machine, or a host over SSH. */
  private readonly transport: Transport

  constructor(
    private readonly opts: CreateOptions,
    private readonly hooks: DriverHooks,
    private readonly bin: string,
    /** The installed CLI's context window per model id (see `parseCommandCodeContextDocs`). */
    private readonly contextWindows: Map<string, number> = new Map(),
  ) {
    this.transport = new Transport(opts.host)
    this.nativeId = opts.nativeId
    this.model = opts.model
    this.effort = opts.effort
    this.permissionMode = opts.permissionMode
  }

  /**
   * The value that was actually thrown by the last attempt, when one was.
   *
   * A message is what the retry heuristics read; the object is what says where
   * the failure came from (see `attempt`).
   */
  private failureRaw: unknown = null

  /** Who and what to name in a failure, filled in once for every call site. */
  private get failureContext(): FailureContext {
    return { harness: HARNESS_LABEL.commandcode, bin: this.bin, host: this.opts.host }
  }

  get alive(): boolean {
    return !this.stopped
  }

  send(text: string): Promise<SendResult> {
    if (this.stopped) return Promise.resolve({ status: 'refused', reason: 'the driver has stopped' })
    // One process per turn: a second prompt waits its turn rather than opening a
    // second process on the same session.
    if (this.busy) {
      this.queue.push(text)
      return Promise.resolve({ status: 'queued' })
    }
    return new Promise<SendResult>((resolve) => {
      this.delivery = resolve
      void this.run(text).catch((error) => {
        this.settleDelivery({ status: 'refused', reason: error instanceof Error ? error.message : String(error) })
      })
    })
  }

  /** Settle exactly once: a prompt is either on disk for the CLI or still ours. */
  private settleDelivery(result: SendResult): void {
    const delivery = this.delivery
    this.delivery = null
    delivery?.(result)
  }

  /**
   * Ends `pump`'s wait on a stream that may never close. Set while a turn reads
   * its process; see `pump`.
   */
  private release: (() => void) | null = null

  interrupt(): void {
    this.interrupted = true
    this.kill()
  }

  stop(): void {
    this.stopped = true
    this.queue.length = 0
    this.settleDelivery({ status: 'refused', reason: 'the driver stopped before the prompt was delivered' })
    this.kill()
  }

  /**
   * Let go of the turn's process without ending it: this server is exiting, and
   * the next one reattaches at the offset already on disk (`saveState` writes
   * every advance). A prompt still waiting here was never handed to the CLI, so
   * it is refused rather than silently dropped.
   */
  detach(): void {
    if (this.stopped) return
    this.stopped = true
    this.queue.length = 0
    this.settleDelivery({ status: 'refused', reason: 'sedano is shutting down' })
    this.release?.()
    this.stopTail()
    this.record = null
  }

  private kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    // Release first: whether the process dies is not something to wait on.
    this.release?.()
    void signal
    const record = this.record
    this.record = null
    this.tail?.stop()
    this.tail = null
    clearDurableState(this.opts.sessionId)
    // This is deliberately a real kill, not merely dropping our tail. The
    // process is detached precisely so closing Sedano does not kill it; an
    // explicit stop or delete is the opposite instruction.
    if (record) void durableDestroy(record)
  }

  configure(patch: Partial<Pick<CreateOptions, 'model' | 'effort' | 'permissionMode'>>): void {
    if (patch.model !== undefined) this.model = patch.model
    if (patch.effort !== undefined) this.effort = patch.effort
    if (patch.permissionMode !== undefined) this.permissionMode = patch.permissionMode
  }

  /* ---------------------------------------------------------------- */

  /**
   * The CLI's own modes: `standard`, `plan`, `auto-accept`, plus `--yolo`
   * (`cmd --help`).
   *
   * There is no interactive mode here to map "ask me" onto. A headless run
   * installs Command Code's `headlessInteraction`, whose `confirmTool` denies
   * anything that carries a risk and whose `askQuestion` answers itself with the
   * first option — it never reaches this client, and this protocol has no frame
   * for a permission request at all. So `manual` is not translated into a
   * fictitious equivalent: it runs as `standard`, and `noteManualMode` says
   * plainly what that means, once, instead of a card that will never appear.
   */
  private permissionArgs(): string[] {
    switch (this.permissionMode) {
      case 'plan':
        return ['--permission-mode', 'plan']
      case 'default':
      case 'manual':
        // Headless runs block writes and shell by default; "standard" says so.
        return ['--permission-mode', 'standard']
      case 'bypassPermissions':
        return ['--yolo']
      default:
        // acceptEdits / auto: let it get on with the work.
        return ['--permission-mode', 'auto-accept']
    }
  }

  /** Said once: "ask me" has nothing to ask with in this harness. */
  private noteManualMode(): void {
    if (this.modeNoted || this.permissionMode !== 'manual') return
    this.modeNoted = true
    this.hooks.event(
      {
        k: 'system',
        subtype: 'permission-mode',
        text: 'Command Code headless cannot ask before it acts — this run is its standard mode, which refuses what it would otherwise ask about. Use auto-accept or bypass to let it work, or its own terminal UI to be asked.',
      },
      { id: `local:mode:${crypto.randomUUID()}` },
    )
  }

  private learnSession(sessionId: unknown): void {
    if (typeof sessionId !== 'string' || !sessionId || sessionId === this.nativeId) return
    this.nativeId = sessionId
    this.hooks.nativeId(sessionId)
    this.hooks.resumeHint(resumeCommand(this.opts.cwd, sessionId, this.transport.remote ? this.opts.host : null))
  }

  private args(): string[] {
    const args = ['-p', '--output-format', 'json', '--skip-onboarding', '--trust']
    if (this.nativeId) args.push('--resume', this.nativeId)
    if (this.model) args.push('--model', this.model)
    // Never probe support by sacrificing a turn. Only send an effort when the
    // catalog declares it legal for this exact model.
    const supported = effortsForCommandCodeModel(this.model)
    if (this.effort && supported?.includes(this.effort)) {
      args.push('--effort', this.effort)
    }
    args.push(...this.permissionArgs())
    return args
  }

  /**
   * Commit the streamed text, falling back to a message body when a run was not
   * streamed. The fallback is ignored once this turn already produced an answer,
   * so the final `result` frame can never double the message.
   */
  private flushText(fallback = ''): void {
    const text = this.text.trim() || (this.textEmitted ? '' : fallback.trim())
    this.text = ''
    if (!text) return
    // Labelled with the model that produced it, when the CLI has said which.
    this.hooks.event({ k: 'assistant', text, model: this.effectiveModel ?? undefined })
    this.textEmitted = true
  }

  /**
   * Write (or rewrite) a tool card at the state the CLI just reported.
   *
   * Keyed by the call's own id so the row moves through `queued` → `running` →
   * `completed`/`error` in place. A frame about a call we never saw queued is
   * dropped rather than drawn as a nameless card.
   */
  private emitTool(toolId: string, status: ToolStatus): void {
    const call = this.toolCalls.get(toolId)
    if (!call) return
    this.hooks.event(
      {
        k: 'tool',
        toolId,
        name: call.name,
        input: call.input,
        summary: summarizeTool(call.name, call.input),
        status,
      },
      { id: `tool:${toolId}` },
    )
  }

  private get tag(): string {
    return durableTag(this.opts.sessionId)
  }

  /** Start consuming the append-only log, preserving a restart-safe byte offset. */
  private startTail(offset: number): void {
    const record = this.record
    if (!record) return
    this.tail?.stop()
    this.offset = offset
    this.lines = new LineSplitter()
    const tail = new DurableTail(record, offset, (bytes, next) => {
      // A stopped tail can still hand over what was in its pipe; those bytes
      // belong to a turn this driver has already moved on from.
      if (this.tail !== tail) return
      this.consume(bytes)
      // On a line boundary: an offset inside a line resumes, after a restart,
      // on half a JSON frame that is then dropped as unparseable.
      this.saveState(next - this.lines.pendingBytes)
    })
    this.tail = tail
    tail.start()
  }

  /** Act on every complete line in these bytes. */
  private consume(bytes: Uint8Array): void {
    for (const line of this.lines.push(bytes)) this.parseSafely(line)
  }

  /**
   * One frame, contained. The tail's reader treats a throw as a closed pipe and
   * stops reading for good, so a frame this code mishandles would otherwise
   * silence the rest of the turn.
   */
  private parseSafely(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    try {
      this.parseLine(trimmed)
    } catch (error) {
      console.error('[commandcode] could not handle a frame:', error)
    }
  }

  /**
   * Read whatever the log holds past what the live tail delivered, then the
   * last line even without its newline.
   *
   * The tail is a follower with a reconnect backoff, and over ssh it can be
   * seconds behind — or not running at all — when the process exits. The final
   * `result` frame is the one that matters most, so the end of a run is read off
   * the file itself rather than left to the tail's timing.
   */
  private drainLog(record: DurableRecord, from: number): void {
    try {
      const polled = this.transport.poll(`${record.base}.out`, from)
      if (polled?.bytes.length) this.consume(polled.bytes)
    } catch {
      /* the log is gone: what the tail delivered is all there is */
    }
    this.parseSafely(this.lines.flush())
  }

  private stopTail(): void {
    this.tail?.stop()
    this.tail = null
  }

  private saveState(offset: number, force = false): void {
    if (!this.record) return
    // Command Code emits compact, line-oriented frames. Persist every advance:
    // unlike a token-heavy stream this is a handful of writes per turn, and a
    // stale byte offset would replay an assistant delta after a restart with no
    // stable event id available to deduplicate it.
    if (!force && offset === this.offset) return
    this.offset = offset
    const state: DurableState = {
      ...this.record,
      sessionId: this.opts.sessionId,
      harness: 'commandcode',
      outOffset: offset,
      busy: this.busy,
    }
    writeDurableState(state)
  }

  /** Reconnect to an in-flight one-shot turn after the server has restarted. */
  async start(): Promise<void> {
    if (!this.opts.attach) return
    const state = readDurableState(this.opts.sessionId)
    if (!state || state.host !== this.opts.host || state.harness !== 'commandcode') return
    const alive = await durableAlive(state)
    if (alive === false) {
      // The turn finished while nobody was reading. Its answer is still in the
      // log past the stored offset, and this harness has no transcript to
      // recover it from — dropping the state here lost that answer for good.
      this.lines = new LineSplitter()
      this.drainLog(state, state.outOffset)
      clearDurableState(this.opts.sessionId)
      void durableDestroy(state)
      return
    }
    if (alive !== true) return
    this.record = state
    this.busy = state.busy
    this.startTail(state.outOffset)
    this.hooks.event({ k: 'system', subtype: 'reattached', text: 'reattached to the agent that kept running while sedano was closed' })
    if (!state.busy) {
      this.hooks.status('idle')
      return
    }
    this.hooks.turnStarted()
    this.hooks.status('running')
    void this.finishAttachedTurn(state)
  }

  private async waitForExit(record: DurableRecord): Promise<{ code: number | null; stderr: string } | null> {
    // Every question is a process here and an ssh round trip on a host, so a
    // host is asked less often; a turn is seconds long either way.
    const interval = record.host ? 1000 : 250
    while (this.record === record && !this.stopped && !this.interrupted) {
      const alive = await durableAlive(record)
      if (alive === false) break
      await Bun.sleep(interval)
    }
    if (this.record !== record || this.stopped || this.interrupted) return null
    // tail -F can be behind the process; its final frame is the authoritative
    // result, so the rest of the log is read before the exit code is considered.
    const delivered = this.tail?.offset ?? this.offset
    this.stopTail()
    this.drainLog(record, delivered)
    const result = { code: await durableExit(record), stderr: (await durableStderr(record, MAX_STDERR)).trim() }
    this.record = null
    clearDurableState(this.opts.sessionId)
    void durableDestroy(record)
    return result
  }

  private async finishAttachedTurn(record: DurableRecord): Promise<void> {
    const ended = await this.waitForExit(record)
    if (this.stopped) return
    // Released on every way out. It used to stay set after an interrupt, and a
    // driver that believes it is busy queues every later prompt forever.
    this.busy = false
    if (this.interrupted) {
      this.flushText()
      this.hooks.event({
        k: 'result',
        outcome: 'interrupted',
        subtype: 'cancelled',
        text: 'interrupted',
        durationMs: 0,
        costUsd: 0,
        costReported: false,
      })
      this.hooks.status('idle')
    } else if (ended && ended.code !== null && ended.code !== 0 && !this.runEnded) {
      this.reportFailure(`Command Code exited with code ${ended.code}${ended.stderr ? `\n${ended.stderr}` : ''}`)
    } else if (this.reportedError === null) {
      this.hooks.status('idle')
    }
    // Prompts sent while the reattached turn was running waited in the queue;
    // only `run()` drained it, so they were never sent.
    const next = this.queue.shift()
    if (next) this.runQueued(next)
  }

  /** A queued prompt, run off the caller's stack: a rejection here would take the server down. */
  private runQueued(text: string): void {
    void this.run(text).catch((error) => {
      console.error('[commandcode] queued prompt failed:', error)
      this.busy = false
    })
  }

  /** One detached process for one prompt: null when it worked, the reason when it did not. */
  private async attempt(text: string): Promise<string | null> {
    // Per process: a retry (see `run`) starts a new one, and the previous run's
    // boundary says nothing about it.
    this.runEnded = false
    this.failureRaw = null
    try {
      const record = await durableLaunch(
        this.opts.host,
        {
          tag: this.tag,
          bin: this.bin,
          args: this.args(),
          cwd: this.opts.cwd,
          env: { FORCE_COLOR: '0', NO_COLOR: '1' },
          input: text.endsWith('\n') ? text : `${text}\n`,
        },
        { fresh: true },
      )
      if (this.stopped || this.interrupted) {
        // Stopped or interrupted while the process was starting: `kill()` found
        // no record to end, so this one would run the whole turn unobserved and
        // its tail would print it after the "interrupted" result.
        void durableDestroy(record)
        return null
      }
      this.record = record
      // `durableLaunch` has written the prompt and started its detached process;
      // unlike a future turn result, this is a confirmed delivery boundary.
      this.settleDelivery({ status: 'delivered' })
      this.startTail(0)
      this.saveState(0, true)
      // There is intentionally no child `exited` promise here. The CLI is in
      // its own process group, possibly on another host; liveness plus the log
      // are the durable equivalent, and keep working across a server restart.
      const ended = await this.waitForExit(record)
      if (!ended) return null
      const { code, stderr: err } = ended
      // A run that reached its own `run_end` has already said how it went, and
      // the CLI exits non-zero for outcomes that are not failures (a turn cap
      // exits 8 after writing a perfectly good result). The native boundary wins
      // over the exit code.
      if (code !== null && code !== 0 && !this.runEnded) {
        // Kept from the front and on its own lines. A crash announces itself on
        // the first line and pads the rest with stack frames, so taking the last
        // 600 characters on one line was the one crop guaranteed to lose the
        // sentence a person needs and keep the part they cannot read.
        const printed = err.length > MAX_STDERR ? `${err.slice(0, MAX_STDERR)}\n… truncated` : err
        return `Command Code exited with code ${code}${printed ? `\n${printed}` : ''}`
      }
      return null
    } catch (err) {
      // The thrown value is kept as well as its message: a spawn that failed
      // because the host was unreachable carries the transport's own error kind,
      // and `String(err)` is where that distinction used to die — every remote
      // failure then read as though Command Code itself had refused.
      this.failureRaw = err
      return err instanceof Error ? err.message : String(err)
    } finally {}
  }

  private async run(text: string): Promise<void> {
    this.interrupted = false
    this.busy = true
    this.thinking = ''
    this.text = ''
    this.textEmitted = false
    this.stopReason = null
    this.runEnded = false
    this.reportedError = null
    // Per turn: tool ids are unique to their run, and a back-off already
    // reported in the last turn says nothing about this one.
    this.toolCalls.clear()
    this.retriesNoted.clear()
    this.noteManualMode()
    this.hooks.turnStarted()
    this.hooks.status('running')

    const startedAt = Date.now()
    let failure = await this.attempt(text)

    // The CLI refuses an effort it does not know and names the ones it does
    // ("Unknown effort \"medium\". Supported: low, high, max."). That is a better
    // answer than any table of ours, so it is learned, the turn is retried with a
    // level this model takes, and nobody sees the failure.
    const unknownEffort = failure ? /Unknown effort "[^"]*"\.\s*Supported:\s*([^.]+)\./.exec(failure) : null
    if (unknownEffort) {
      const supported = unknownEffort[1]!
        .split(',')
        .map((level) => level.trim())
        .filter(Boolean)
      const wanted = this.effort
      if (this.model) rememberCommandCodeEfforts(this.model, supported)
      this.effort = wanted && supported.includes(wanted) ? wanted : (supported[0] ?? null)
      if (this.effort !== wanted) {
        this.hooks.event(
          {
            k: 'system',
            subtype: 'effort-adjusted',
            text: `${this.model ?? 'This model'} takes ${supported.join(', ')} — continued with ${this.effort ?? 'no effort'}`,
          },
          { id: `local:effort:${crypto.randomUUID()}` },
        )
      }
      failure = await this.attempt(text)
    }

    if (failure && this.effort && /reasoning effort/i.test(failure)) {
      this.effort = null
      failure = await this.attempt(text)
    }

    if (failure) {
      this.settleDelivery({ status: 'refused', reason: failure })
    } else if (this.stopped && this.delivery) {
      this.settleDelivery({ status: 'refused', reason: 'the driver stopped before the prompt was delivered' })
    }

    this.busy = false

    if (this.stopped) return
    if (this.interrupted) {
      this.flushText()
      this.hooks.event({
        k: 'result',
        outcome: 'interrupted',
        subtype: 'cancelled',
        text: 'interrupted',
        durationMs: Date.now() - startedAt,
        // Killed mid-run: the CLI never wrote a result line, so there is no cost
        // and no usage to report. Zero is the required field, not a measurement,
        // and `costReported` is what keeps it from being read as a price.
        costUsd: 0,
        costReported: false,
      })
      this.hooks.status('idle')
    } else if (failure) {
      this.flushText()
      this.reportFailure(failure, this.failureRaw)
    } else if (this.reportedError === null) {
      this.hooks.status('idle')
    }
    // A run the CLI itself reported as failed stays failed: turning it back to
    // idle here is how an error became a session that looked ready to type into.

    const next = this.queue.shift()
    if (next && !this.stopped) this.runQueued(next)
  }

  private async pump(proc: Proc): Promise<void> {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    // The stream ending is what ends a turn, but the stream does not always end
    // when the process does: a CLI that leaves a child behind keeps this pipe
    // open, and a read that waits on it forever never lets the turn finish — the
    // session stayed "running" with nothing left to interrupt, so neither Esc nor
    // the stop button could do anything about it. `release` ends the wait the
    // moment the process is asked to die, whatever the pipe does afterwards.
    const released = new Promise<null>((resolve) => {
      this.release = () => resolve(null)
    })
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const chunk = await Promise.race([reader.read(), released])
        if (chunk === null) break
        const { done, value } = chunk
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let index = buffer.indexOf('\n')
        while (index !== -1) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (line) this.parseLine(line)
          index = buffer.indexOf('\n')
        }
        if (this.stopped) break
      }
      const rest = buffer.trim()
      if (rest) this.parseLine(rest)
    } catch {
      /* the stream ends when the process dies; run() reports the outcome */
    } finally {
      this.release = null
    }
  }

  private parseLine(line: string): void {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    const type = String(frame.type ?? '')
    noteProtocol('commandcode', 'commandcode', `frame:${type}`)
    if (type === 'event' && frame.event && typeof frame.event === 'object') {
      this.handleEvent(frame.event as Record<string, unknown>)
    } else if (type === 'result') {
      this.handleResult(frame)
    }
  }

  private handleEvent(ev: Record<string, unknown>): void {
    noteProtocol('commandcode', 'commandcode', `event:${String(ev.type ?? '')}`)
    switch (String(ev.type ?? '')) {
      case 'run_start': {
        this.learnSession(ev.sessionId)
        return
      }
      /*
       * The native boundaries. A Command Code run is several turns — one model
       * round each, `turn_start` … `turn_end` — inside one `run_start` …
       * `run_end`. They were inferred from the prose and the tool frames before,
       * which put an answer in the wrong place whenever a turn ended without a
       * `message_end` (a tool-only round, a stop hook, a cap).
       */
      case 'turn_start': {
        // A new round begins: whatever the previous one left uncommitted belongs
        // before it, not merged into what comes next.
        this.flushText()
        return
      }
      case 'turn_end': {
        this.flushText()
        return
      }
      case 'run_end': {
        const result = (ev.result ?? {}) as Record<string, unknown>
        this.runEnded = true
        this.stopReason = typeof result.stopReason === 'string' ? result.stopReason : null
        // The run's own final text, used only if nothing was streamed: this is
        // the authoritative end of the answer, and the `result` line that
        // follows repeats it.
        this.flushText(String(result.finalText ?? ''))
        return
      }
      case 'run_error': {
        this.runEnded = true
        this.stopReason = 'run_error'
        this.reportFailure(errorText(ev.error, 'Command Code failed the run'))
        return
      }
      case 'interrupted': {
        this.stopReason = 'interrupted'
        return
      }
      case 'text_delta': {
        const delta = String(ev.delta ?? '')
        if (!delta) return
        this.text += delta
        this.hooks.delta('main', 'text', delta)
        return
      }
      case 'thinking_delta': {
        const delta = String(ev.delta ?? '')
        if (!delta) return
        this.thinking += delta
        this.hooks.delta('main', 'thinking', delta)
        return
      }
      case 'thinking_end': {
        const text = this.thinking.trim()
        this.thinking = ''
        if (text) this.hooks.event({ k: 'thinking', text })
        return
      }
      case 'tool_queued': {
        const toolId = String(ev.toolCallId ?? crypto.randomUUID())
        const name = String(ev.toolName ?? 'tool')
        this.toolCalls.set(toolId, { name, input: ev.input })
        this.emitTool(toolId, 'queued')
        return
      }
      /*
       * Waiting and working are not the same card. The CLI publishes the whole
       * lifecycle — every captured run has `tool_running` between the queue and
       * the completion — and dropping the frame left three calls queued at once
       * looking exactly like three calls executing at once.
       */
      case 'tool_running': {
        this.emitTool(String(ev.toolCallId ?? ''), 'running')
        return
      }
      case 'tool_completed': {
        const toolId = String(ev.toolCallId ?? '')
        this.emitTool(toolId, 'completed')
        this.hooks.event({
          k: 'tool_result',
          toolId,
          text: textOf(ev.result),
          isError: false,
          truncated: false,
        })
        return
      }
      /*
       * The provider refused and the CLI is backing off. It says so, waits, and
       * says nothing else — a real run sat silent for twelve seconds here — so
       * the reason is passed through in the CLI's own words rather than left as
       * a gap the person has to guess at. Said once per distinct reason: a
       * retry storm is one line, not one line per attempt.
       */
      case 'api_retry': {
        const reason = errorText(ev.error, 'the model provider refused the request')
        if (this.retriesNoted.has(reason)) return
        this.retriesNoted.add(reason)
        const attempt = Number(ev.attempt)
        const prefix = Number.isFinite(attempt) && attempt > 0 ? `retry ${attempt}: ` : 'retrying: '
        this.hooks.event(
          { k: 'system', subtype: 'api-retry', text: `${prefix}${reason}` },
          { id: `local:retry:${crypto.randomUUID()}` },
        )
        return
      }
      /*
       * A failed call is its own frame, `tool_errored`, carrying the reason —
       * `tool_completed` never has one. Reading the error off `tool_completed`
       * meant every failure arrived as a success with its message flattened away.
       */
      case 'tool_errored': {
        const toolId = String(ev.toolCallId ?? '')
        this.emitTool(toolId, 'error')
        this.hooks.event({
          k: 'tool_result',
          toolId,
          text: errorText(ev.error, `${String(ev.toolName ?? 'the tool')} failed`),
          isError: true,
          truncated: false,
        })
        return
      }
      case 'tool_denied': {
        const toolId = String(ev.toolCallId ?? '')
        this.emitTool(toolId, 'error')
        this.hooks.event({
          k: 'tool_result',
          toolId,
          text: `${String(ev.toolName ?? 'tool')} was not allowed to run in this permission mode`,
          isError: true,
          truncated: false,
        })
        this.noteManualMode()
        return
      }
      case 'tool_hook_blocked': {
        const toolId = String(ev.toolCallId ?? '')
        this.emitTool(toolId, 'error')
        this.hooks.event({
          k: 'tool_result',
          toolId,
          text: errorText(ev.hookOutput, 'blocked by a pre-tool hook'),
          isError: true,
          truncated: false,
        })
        return
      }
      /*
       * Which model is answering. `model_request_start` carries it too, and it
       * is emitted before the response streams (`message_start` then
       * `model_request_start` in the CLI's own loop) — which is what lets the
       * answer be labelled with the model that produced it rather than with the
       * alias the picker asked for, or with nothing.
       */
      case 'model_request_start':
      case 'model_request_end': {
        if (typeof ev.model === 'string' && ev.model && ev.model !== this.effectiveModel) {
          this.effectiveModel = ev.model
          this.reportedWindow = 0
          this.hooks.model(ev.model)
        }
        // One model call's usage: its input is the conversation's size (the
        // CLI's own meter reads exactly this), unlike the run's summed total.
        const usage = ev.type === 'model_request_end' ? usageFrom(ev.usage) : null
        if (usage) {
          const catalog = this.contextWindows.get((this.effectiveModel ?? '').toLowerCase()) ?? 0
          const window = this.reportedWindow || catalog
          this.hooks.usage(usage, {
            perMessage: true,
            // The catalog is the CLI's own table, not a statement about this
            // session (a plan can cap it): shown as the estimate it is.
            ...(window ? { contextWindow: window, contextWindowInferred: !this.reportedWindow } : {}),
          })
        }
        return
      }
      case 'compaction_outcome': {
        // The only frame that states the window (`contextLimit`), and the size
        // the conversation was compacted to.
        const limit = Number(ev.contextLimit ?? 0)
        const after = Number(ev.tokensAfter ?? 0)
        if (limit > 0) this.reportedWindow = limit
        if (limit > 0 || after > 0) {
          this.hooks.usage({}, {
            ...(limit > 0 ? { contextWindow: limit } : {}),
            ...(after > 0 ? { contextTokens: after } : {}),
          })
        }
        return
      }
      case 'message_end': {
        // message_end always precedes the tool events of that message, so this is
        // the one right place to commit the prose the deltas streamed.
        this.flushText(textOnly(ev.content))
        return
      }
      default:
        return
    }
  }

  private handleResult(frame: Record<string, unknown>): void {
    this.learnSession(frame.sessionId)
    const usage = usageFrom(frame.usage)
    this.flushText(String(frame.finalText ?? ''))
    if (usage) this.hooks.usage(usage, { commitTurn: true })
    const subtype = String(frame.subtype ?? 'success')
    noteProtocol('commandcode', 'commandcode', `result:${subtype}`)
    const failure = subtype === 'success' ? '' : errorText(frame.error, 'Command Code reported an error')
    const rawSubtype =
      subtype === 'success' && this.stopReason && this.stopReason !== 'end_turn' ? this.stopReason : subtype
    this.hooks.event({
      k: 'result',
      outcome: resultOutcomeFor(rawSubtype, { isError: subtype === 'error' }),
      // The run's own stop reason when it is one worth saying: a run that hit a
      // token cap, a stop hook or an interrupt ended differently from one that
      // simply finished, and that difference was invisible before.
      subtype: rawSubtype,
      text: failure,
      usage: usage ?? undefined,
      durationMs: Number(frame.durationMs ?? 0),
      // Command Code's print result line carries no cost at all (see
      // `buildPrintResultLine` in its own CLI): this zero is the shared event's
      // required field, not a price, and `costReported: false` says so, so the
      // footer shows nothing rather than `$0.0000`.
      costUsd: 0,
      costReported: false,
    })
    if (subtype === 'error') {
      this.stopReason = 'run_error'
      this.reportFailure(failure)
    }
    // The result is the content boundary, not the process boundary. Publishing
    // `idle` here opened a short race while the detached wrapper was still
    // alive: a second prompt was accepted as a new manager turn, then queued by
    // this still-busy driver, while the UI and callers already saw it as done.
    // `run()` publishes idle after `waitForExit()` has observed the real exit.
  }

  /**
   * Report a failed run once, whichever frame said so first.
   *
   * The raw reason is what is remembered for the "once" test — two frames saying
   * the same thing must still be one card — and the reader is handed the
   * normalized version of it.
   */
  private reportFailure(message: string, raw: unknown = null): void {
    if (this.reportedError === message) return
    this.reportedError = message
    this.hooks.error(formatFailure(raw ?? message, this.failureContext))
    this.hooks.status('error')
  }
}
