import type { AttachmentRef, EffortLevel, PermissionMode, TimelineEvent, TokenUsage } from '@shared'
import { HARNESS_LABEL, isPlaceholderModel, resultOutcomeFor, splitDocuments } from '@shared'
import type { CreateOptions, Driver, DriverHooks, FailureContext, SendResult } from '../types.ts'
import { formatFailure } from '../types.ts'
import { LineSplitter } from '../lines.ts'
import { ClaudeTranscriptReader, apiErrorLine, normalizeUsage, type TranscriptSink } from './transcripts.ts'
import { claudeStreamKey, noteProtocol } from '../coverage.ts'
import { attachmentBase64 } from '../../attachments.ts'
import { reportedContextWindow, resolveContextWindow } from '../../metrics.ts'
import { claudeConfigRoot, claudeTranscriptPath } from '../../paths.ts'
import {
  DurableTail,
  Transport,
  clearDurableState,
  durableAlive,
  durableDestroy,
  durableExit,
  durableStderr,
  durableTag,
  durableWrite,
  readDurableState,
  shq,
  writeDurableState,
  type DurableRecord,
  type DurableState,
} from '../../transport.ts'
import { durableLaunch } from '../../transport.ts'
import { acceptEditsMayApprove } from '../workspace-scope.ts'

const BASE_ARGS = [
  // Prompts reach this client over stdio instead of being decided by the CLI:
  // without it an "ask" is terminal (the CLI's own words), so a tool that needs
  // a decision was silently denied rather than shown.
  '--permission-prompt-tool',
  'stdio',
  '--print',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--include-partial-messages',
  '--verbose',
]

function permissionArgs(mode: CreateOptions['permissionMode']): string[] {
  if (mode === 'bypassPermissions') return ['--dangerously-skip-permissions']
  return ['--permission-mode', mode]
}

/**
 * The tools `acceptEdits` auto-approves, and nothing else.
 *
 * Claude Code documents the mode as "auto-accept file edits": the file-editing
 * tools, plus filesystem commands (`mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`,
 * `sed`) inside the working directory. Crucially it also documents that a call
 * which reaches the client at all is one the *mode already declined to approve*:
 * the CLI applies its own mode first, so a `can_use_tool` arriving in this mode
 * is a shell command, a network fetch, a path outside the workspace or a
 * question — exactly the things "accept edits" does not cover. Approving those
 * here was the mode approving everything under a name that promised edits.
 *
 * The list stays for the cases the CLI routes back to a prompt anyway (an `ask`
 * rule on an edit tool, a hook that defers one), where re-approving an edit is
 * what the chosen mode means. Everything else follows the mode's own rule and
 * is put to the person.
 *
 * Source: Claude Code docs, "Configure permissions" -> Accept edits mode.
 */
const ACCEPT_EDITS_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

/** The files an edit tool's input names (`file_path`, or `notebook_path`). */
function editedPaths(input: Record<string, unknown>): string[] {
  return ['file_path', 'notebook_path']
    .map((key) => input[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
}

/** What a permission request is asking for, in one line under the option. */
function summarizeRequest(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const rec = input as Record<string, unknown>
  for (const key of ['command', 'file_path', 'path', 'pattern', 'url', 'query']) {
    const value = rec[key]
    if (typeof value === 'string' && value) return value.slice(0, 160)
  }
  return ''
}

/** Pasted images, as the content blocks the Anthropic message format expects. */
function imageBlocks(attachments: AttachmentRef[] | undefined): unknown[] {
  if (!attachments?.length) return []
  return attachments.flatMap((attachment) => {
    const image = attachmentBase64(attachment.id)
    if (!image) return []
    return [{ type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } }]
  })
}

/** Minimal shape we need from a piped stdin. */
interface WriteSink {
  write(chunk: string): unknown
  flush(): unknown
}

/** Whitespace is not what makes two messages the same message. */
export function normalizeMessage(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * The UI shows your message the moment you send it, and the harness writes the
 * same message into its transcript a beat later. Both would render, so the
 * local copy is remembered here and the transcript twin claims (and consumes)
 * it. Bounded, because a long session must not grow this forever.
 */
export class UserEchoes {
  private items: string[] = []

  constructor(private readonly limit = 20) {}

  remember(text: string): void {
    this.items.push(normalizeMessage(text))
    if (this.items.length > this.limit) this.items.shift()
  }

  /**
   * True when this text is one we already showed locally.
   *
   * Deliberately does *not* consume the entry: the local event is always the
   * user's message, so every transcript twin of it is a duplicate — and Claude
   * can write more than one (a resume replays the record). Consuming it left the
   * later twin unclaimed, which re-printed the previous prompt as a new turn.
   */
  claim(text: string): boolean {
    return this.items.includes(normalizeMessage(text))
  }

  get size(): number {
    return this.items.length
  }
}

/**
 * Drives one Claude Code session.
 *
 * Two independent inputs are merged:
 *  - the long-lived `stream-json` process, used for token-level deltas and for
 *    knowing when a turn starts and ends;
 *  - the on-disk transcript, which is the authoritative timeline and the only
 *    place where subagent internals are visible.
 *
 * If the CLI process dies, the transcript keeps flowing and the next message
 * transparently respawns the process with `--resume`, so a session never gets
 * permanently stuck.
 */
export class ClaudeDriver implements Driver, TranscriptSink {
  /** Claude Code's own session id: reused when reopening, generated when new. */
  uuid!: string
  private resume: boolean
  alive = true
  /** Claude Code queues stdin messages that arrive mid-turn (`queue-operation`, `absorbed_mid_turn`). */
  readonly midTurnInput = true

  /**
   * The detached process this session is driving, and the stream it reads.
   *
   * There is no child process here any more — that is the point. The CLI runs
   * under `nohup` in a process group of its own on the machine the session
   * belongs to, with a fifo for stdin and a log for stdout (see `durableLaunch`),
   * so closing a tab or closing sedano leaves it working. What lives in this
   * object is only the *view* of it: where the log has been read to, and how to
   * write the next line.
   */
  private record: DurableRecord | null = null
  private tail: DurableTail | null = null
  private reader: ClaudeTranscriptReader | null = null
  private echoes = new UserEchoes()
  private lines = new LineSplitter()
  private stopped = false
  private exiting = false
  /**
   * Everything that touches the detached process runs on this chain, in order.
   *
   * A pipe made ordering free: a write either landed or the process was gone.
   * A fifo does not — every write is a round trip to the machine the agent runs
   * on — so two prompts issued a millisecond apart could otherwise arrive the
   * wrong way round, and an interrupt could overtake the turn it was meant to
   * end. One promise chain is all this needs.
   */
  private chain: Promise<unknown> = Promise.resolve()
  /** Prompt writes waiting for the FIFO/launch chain. */
  private pendingWrites = 0
  /** Watches the detached process, since there is no `proc.exited` to await. */
  private liveness: ReturnType<typeof setInterval> | null = null
  /** Bumped by every launch, so an old watcher cannot report the new one's death. */
  private incarnation = 0
  /**
   * Bumped by `stop` and `configure`, so a launch that was still starting when
   * either ran can tell that the process it just started is already stale.
   */
  private launchEpoch = 0
  /** A liveness question is in flight; over ssh one can outlast the interval. */
  private checkingLiveness = false
  /** Written down every time it moves, so a restart resumes where we stopped. */
  private lastSaved = 0
  /** How far the log has been acted on, on a line boundary; ahead of `lastSaved` between throttled saves. */
  private consumed = 0
  private turns = 0
  private titleSet = false
  private readonly startedAt = Date.now()
  /** Distinguishes this driver's ids from an earlier driver's on the same conversation. */
  private readonly runId = crypto.randomUUID().slice(0, 8)
  /** Set while the user's last message has not been acknowledged by the CLI. */
  private lastUserText: string | null = null
  /** Images of that message, so a recovery resend carries them too. */
  private lastAttachments: AttachmentRef[] | null = null
  private turnPending = false
  /** Guards against resuming a conversation the CLI no longer has. */
  private recoveryTried = false
  /** Permission requests waiting for the person, keyed by the CLI's request id. */
  /**
   * Permission and question control requests waiting on a person.
   *
   * `cancel` is the other way out. The CLI blocks on a `control_request` until
   * something answers it, so killing or interrupting the process while these
   * sit here left it waiting on a reply that could never come — and left the
   * continuations in this map outliving the process that owned them.
   */
  private readonly questions = new Map<string, { resolve(choice: string): void; cancel(): void }>()
  /** Where this session runs: this machine, or a host over SSH. */
  private readonly transport: Transport
  /** Claude Code's config root on that machine, for transcript and subagents. */
  private readonly root: string
  /**
   * The model the CLI says it is running, learned from its own stream.
   *
   * Never `opts.model`: that is an alias somebody picked ("sonnet", "opus"), and
   * the runtime resolves it to a dated id that may not even be the same family —
   * so a context window guessed from the alias described a different model than
   * the one answering. Null until the CLI says, and a window guessed from null
   * is zero, which the UI reads as "unknown" rather than inventing one.
   *
   * Never a placeholder either: see `adoptModel`.
   */
  private reportedModel: string | null = null
  /**
   * The window the CLI itself reported for the running model (`modelUsage` in
   * a `result` frame). Null until a turn has ended, and reset when the model
   * changes: until then the window is an estimate, and published as one.
   */
  private reportedWindow: number | null = null
  /** Output already charged per API message id (see `creditUsage`). */
  private readonly countedMessages = new Map<string, number>()
  /** Subagents whose real completion has landed; a progress frame must not undo it. */
  private readonly finishedSubagents = new Set<string>()
  /** The best metrics any provisional row has carried, per subagent. */
  private readonly provisionalSubagents = new Map<string, { toolUses: number; durationMs: number }>()
  /**
   * Background work this process started (`system/task_started`), by task id.
   * A process with a background shell, or a subagent that has not reported its
   * end, is never recycled: ending it would end that work too.
   */
  private readonly startedTasks = new Map<string, { agent: boolean; key: string }>()
  private recycleTimer: ReturnType<typeof setTimeout> | null = null
  /** Whether the shell claude runs in is root, asked once, or null while unknown. */
  private rootUser: boolean | null = null
  private rootNoted = false

  constructor(
    private opts: CreateOptions,
    private readonly hooks: DriverHooks,
    private readonly bin: string,
  ) {
    this.transport = new Transport(opts.host)
    this.root = claudeConfigRoot(this.transport)
    this.resume = this.opts.nativeId !== null
    this.uuid = this.opts.nativeId ?? crypto.randomUUID()
  }

  /** Who and what to name in a failure, filled in once for every call site. */
  private get failureContext(): FailureContext {
    return { harness: HARNESS_LABEL.claude, bin: this.bin, host: this.opts.host }
  }

  /** Names this session's stream files and pid on the machine it runs on. */
  private get tag(): string {
    return durableTag(this.opts.sessionId)
  }

  async start(): Promise<void> {
    // Reattaching to a process that is still working, rather than starting a
    // new one. This is the whole point of the durable launch: the turn that was
    // in flight when sedano went away has kept running, and what it produced in
    // the meantime is still in its log, waiting at a byte offset we wrote down.
    if (this.opts.attach && (await this.attachDurable())) return
    // A stored id is only worth resuming while its transcript is still there:
    // otherwise the CLI exits with "No conversation found", which used to show
    // up as a scary error instead of a fresh session. The transcript is on the
    // machine the session runs on, so the check is too.
    if (this.resume && !(await this.transport.existsAsync(claudeTranscriptPath(this.opts.cwd, this.uuid, this.root)))) {
      this.resume = false
      this.recoveryTried = true
      this.uuid = crypto.randomUUID()
    }
    this.attachReader()
    // Asked once, before the first launch: the answer decides whether claude has
    // to be told it is in a sandbox (see `runsAsRoot`).
    await this.runsAsRoot()
    await this.launch(this.resume)
  }

  /**
   * Pick up a process that outlived this server, or say honestly that there is
   * none.
   *
   * Three things have to be true and each of them is checked rather than
   * assumed: there is a note about a process, the machine it names still has it
   * running, and the conversation it belongs to is the one this session is for.
   * Anything else returns false, the note is torn up, and the caller starts a
   * process the ordinary way — a session whose agent really died must never come
   * back reading "running".
   */
  private async attachDurable(): Promise<boolean> {
    const state = readDurableState(this.opts.sessionId)
    if (!state || state.host !== this.opts.host) return false
    const alive = await durableAlive(state)
    if (alive !== true) {
      // `null` is "could not ask", and it is treated as "not there" *here* on
      // purpose: an attach has to end in a session that works, and the ordinary
      // path below starts a fresh process that reopens the same conversation
      // with `--resume`. Nothing is lost by it, whereas waiting for a host that
      // may be down for an hour would leave the session unusable.
      if (alive === false) await durableDestroy(state)
      clearDurableState(this.opts.sessionId)
      return false
    }
    this.record = state
    this.resume = true
    this.attachReader()
    // From the offset, never from zero: everything before it has already been
    // seen, published and stored, and replaying it would print the last turn a
    // second time.
    this.startTail(state.outOffset)
    this.watchLiveness()
    this.alive = true
    this.hooks.event({
      k: 'system',
      subtype: 'reattached',
      text: 'reattached to the agent that kept running while sedano was closed',
    })
    // A turn that was with the agent is still with it: the status has to say so,
    // or a prompt typed now would be sent into a busy process.
    if (state.busy) {
      this.turnPending = true
      this.hooks.turnStarted()
    } else {
      this.hooks.status('idle')
    }
    // Any question the agent asked while nobody was listening is one it is still
    // blocked on. The continuations that knew what each answer meant died with
    // the old process, so the honest move is to let the CLI go: a refusal it can
    // act on beats a request that will never be answered.
    for (const requestId of this.opts.pendingRequests ?? []) {
      this.respondControl(requestId, {
        behavior: 'deny',
        message: 'sedano restarted before this was answered',
        interrupt: false,
      })
    }
    return true
  }

  private attachReader(replaysHistory = true): void {
    this.hooks.nativeId(this.uuid)
    const hint = `cd ${this.opts.cwd} && claude --resume ${this.uuid}`
    this.hooks.resumeHint(this.transport.remote ? `ssh ${this.opts.host} ${shq(hint)}` : hint)
    // The reader starts at the top of the transcript: every message's usage is
    // about to be charged again.
    if (replaysHistory) {
      this.countedMessages.clear()
      this.hooks.usageReplay?.()
    }
    this.reader = new ClaudeTranscriptReader(this.transport, this.opts.cwd, this.uuid, this, this.root)
    this.reader.start()
  }

  /* ---------------- TranscriptSink ---------------- */

  event(
    ev: TimelineEvent,
    id: string,
    at: number,
    agentId?: string,
    causal?: { parentEventId?: string; parentAgentId?: string },
  ): void {
    if (ev.k === 'subagent_end') {
      const key = ev.toolId || ev.agentId
      // A subagent that has really finished, with the harness' own final
      // metrics. Remembered so a `task_progress` frame still in flight cannot
      // overwrite it with a snapshot from before the end.
      if (!ev.provisional) this.finishedSubagents.add(key)
      else if (!this.keepProvisional(key, ev.toolUses, ev.durationMs)) return
    }
    if (ev.k === 'user' && !this.titleSet) {
      const text = splitDocuments(ev.text).text.replace(/\s+/g, ' ').trim()
      if (text) {
        this.titleSet = true
        this.hooks.title(text.length > 72 ? `${text.slice(0, 72)}…` : text)
      }
    }
    this.hooks.event(ev, { id, at, agentId, ...causal })
  }

  usage(usage: TokenUsage, at: number, messageId?: string): void {
    this.creditUsage(usage, messageId)
    void at
  }

  /**
   * Charge one message's tokens to the meter, once.
   *
   * A captured run settled how many times the CLI reports the same numbers: for
   * a two-block message, *four*. The stream writes an `assistant` frame per
   * content block, and the transcript writes a record per content block, and
   * every one of them repeats the whole message's usage — the same
   * `msg_011CfJ91SxKjsADnraoC283p`, the same 15,271 cache-read tokens, four
   * times. `SessionMeter.addUsage` accumulates, so a session's input, cache-read
   * and cache-write readouts were roughly four times what the CLI had actually
   * reported: 176,860 cache-read tokens for a turn whose own result frame said
   * 44,215.
   *
   * The API's message id is what tells a re-report from a second message, so it
   * is charged the first time and ignored afterwards. A block with no id at all
   * is still charged — dropping a number because it arrived unlabelled would
   * trade an over-count for an under-count.
   *
   * The output counter is the exception that proves the rule: the stream reports
   * it while the message is still being written (3, then 98 once it is done), so
   * the first report of a message is an undercount. It is not corrected here —
   * the turn's `result` frame carries the authoritative total and `commitTurn`
   * is what the output readout is built from.
   */
  private creditUsage(usage: TokenUsage, messageId?: string): void {
    if (messageId) {
      const charged = this.countedMessages.get(messageId)
      if (charged !== undefined) {
        // A re-report: its input was charged already. Only output that grew
        // since (the stream's 3 becoming the transcript's 305) is added.
        if (usage.output > charged) {
          this.countedMessages.set(messageId, usage.output)
          this.hooks.usage({ output: usage.output - charged }, { perMessage: true })
        }
        return
      }
      this.countedMessages.set(messageId, usage.output)
      // A long session must not grow this forever; the repeats all arrive within
      // one message of each other, so a short memory is enough.
      if (this.countedMessages.size > 64) {
        this.countedMessages.delete(this.countedMessages.keys().next().value as string)
      }
    }
    const contextTokens = usage.input + usage.cacheRead + usage.cacheWrite
    this.hooks.usage(usage, {
      perMessage: true,
      ...(contextTokens > 0 ? this.windowOpts(contextTokens) : {}),
    })
  }

  /** The window to publish: the CLI's own when it has said, else an estimate marked as one. */
  private windowOpts(contextTokens: number): { contextWindow?: number; contextWindowInferred?: boolean } {
    if (this.reportedWindow) return { contextWindow: this.reportedWindow }
    const estimate = resolveContextWindow(this.reportedModel, this.opts.model, contextTokens)
    return estimate ? { contextWindow: estimate, contextWindowInferred: true } : {}
  }

  title(title: string): void {
    this.hooks.title(title)
  }

  meta(meta: { gitBranch?: string | null; permissionMode?: string | null }): void {
    this.hooks.meta(meta)
  }

  /** The driver echoes the user's own message, so drop the transcript twin. */
  claimUserEcho(text: string): boolean {
    return this.echoes.claim(text)
  }

  /* ---------------- Process ---------------- */

  private args(resume: boolean): string[] {
    return [
      ...BASE_ARGS,
      ...(resume ? ['--resume', this.uuid] : ['--session-id', this.uuid]),
      ...(this.opts.model ? ['--model', this.opts.model] : []),
      ...(this.opts.effort ? ['--effort', this.opts.effort] : []),
      ...permissionArgs(this.opts.permissionMode),
    ]
  }

  /**
   * Model, effort and approval mode are CLI flags: apply them by dropping the
   * current process. The conversation is kept because the next message is sent
   * with `--resume`, so nothing is lost by the restart.
   */
  configure(patch: {
    model?: string | null
    effort?: EffortLevel | null
    permissionMode?: PermissionMode
  }): void {
    if (patch.model !== undefined) this.opts = { ...this.opts, model: patch.model }
    if (patch.effort !== undefined) this.opts = { ...this.opts, effort: patch.effort }
    if (patch.permissionMode !== undefined) this.opts = { ...this.opts, permissionMode: patch.permissionMode }
    this.launchEpoch += 1
    this.cancelRecycle()
    if (!this.alive) return
    // Refused while the CLI can still read it, exactly as `stop` does: the
    // continuation of a question this process asked has nobody to answer after
    // the kill below, and leaving it set kept a card that looked clickable.
    this.dropQuestions()
    this.exiting = true
    this.alive = false
    this.stopLiveness()
    this.stopTail()
    // Really ended, not merely disowned. A detached process does not die when
    // this object stops listening to it, so a settings change that only dropped
    // its handle would leave the old CLI running on the machine for good — with
    // the next launch writing into the same log from byte zero underneath it.
    const record = this.record
    this.record = null
    clearDurableState(this.opts.sessionId)
    if (record) void durableDestroy(record)
  }

  /**
   * True when claude runs as root, which it refuses to do with
   * `--dangerously-skip-permissions` unless it is told it is in a sandbox:
   * "cannot be used with root/sudo privileges for security reasons". A server
   * where the only user is root is the normal case for a VPS, and picking Bypass
   * All there is exactly what this is for, so the check is answered rather than
   * fought: `IS_SANDBOX=1` is what claude's own documentation asks for in a
   * container, and the transcript says so instead of the turn failing.
   */
  private async runsAsRoot(): Promise<boolean> {
    if (this.rootUser !== null) return this.rootUser
    if (!this.transport.remote) {
      this.rootUser = typeof process.getuid === 'function' && process.getuid() === 0
    } else {
      try {
        this.rootUser = (await this.transport.execAsync('id -u')).stdout.trim() === '0'
      } catch {
        this.rootUser = false
      }
    }
    return this.rootUser
  }

  /**
   * Start the CLI detached, and read its log from the beginning of that log.
   *
   * Every launch is a fresh stream: the log is truncated, the offset goes back
   * to zero and the note on disk is rewritten, so there is exactly one
   * interpretation of "byte 4096 of this session's output" at any moment.
   */
  private async launch(resume: boolean): Promise<void> {
    this.exiting = false
    const bypassing = this.opts.permissionMode === 'bypassPermissions'
    const sandbox = bypassing && this.rootUser === true
    this.stopTail()
    this.incarnation += 1
    const epoch = this.launchEpoch
    const record = await durableLaunch(
      this.opts.host,
      {
        tag: this.tag,
        bin: this.bin,
        args: this.args(resume),
        cwd: this.opts.cwd,
        env: { FORCE_COLOR: '0', NO_COLOR: '1', ...(sandbox ? { IS_SANDBOX: '1' } : {}) },
      },
      { fresh: true },
    )
    if (this.stopped || epoch !== this.launchEpoch) {
      // `stop()` or `configure()` ran while this process was starting. Adopting
      // it would leave a CLI running after a stop (with a tail and a liveness
      // watch nobody will ever clear), or running with the settings that were
      // just replaced — so it is ended, and a configure gets a fresh launch.
      void durableDestroy(record)
      if (this.stopped) throw new Error('the driver has stopped')
      return this.launch(resume)
    }
    this.record = record
    this.lines = new LineSplitter()
    // A new process has started nothing yet; the old one's tasks died with it.
    this.startedTasks.clear()
    this.saveState(0)
    this.startTail(0)
    this.watchLiveness()
    this.alive = true
    if (sandbox && !this.rootNoted) {
      this.rootNoted = true
      this.hooks.event(
        {
          k: 'system',
          subtype: 'bypass-as-root',
          text: `running as root — claude needs IS_SANDBOX=1 to skip permissions, so that is what it is being told`,
        },
        { id: `local:root:${crypto.randomUUID()}` },
      )
    }
  }

  /* ---------------- the detached process, seen from here ---------------- */

  /**
   * Read the CLI's output log from `offset` on, one protocol line at a time.
   *
   * Byte offsets rather than "whatever arrives from now on", because this is
   * also the reattach path: after a restart the log already holds everything
   * that happened while nobody was looking, and the offset is the only thing
   * that says where "already seen" ends and "missed" begins.
   */
  private startTail(offset: number): void {
    if (!this.record) return
    this.lastSaved = offset
    this.consumed = offset
    const tail = new DurableTail(this.record, offset, (bytes, at) => {
      // A stopped tail can still hand over what was already in its pipe; after a
      // relaunch those are the old process' bytes, and fed into the new stream
      // they would corrupt its first line.
      if (this.tail !== tail) return
      for (const line of this.lines.push(bytes)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          this.handleStreamLine(trimmed)
        } catch (error) {
          // One frame this code could not handle must not end the stream: the
          // tail's reader treats a throw as a closed pipe and stops reading for
          // good, which left the session "running" with nothing arriving.
          console.error('[claude] could not handle a stream line:', error)
        }
      }
      // Recorded *after* the lines have been acted on: a note written first
      // would skip whatever this server died in the middle of handling, and a
      // skipped `result` frame is a turn that never ends. And on a line
      // boundary: an offset inside a line resumes on half a JSON message.
      this.consumed = at - this.lines.pendingBytes
      this.saveState(this.consumed)
      this.scheduleRecycle()
    })
    this.tail = tail
    tail.start()
  }

  private stopTail(): void {
    this.tail?.stop()
    this.tail = null
  }

  /**
   * Keep the log from growing for the life of the session.
   *
   * With `--include-partial-messages` every token is a line in `.out`, and a
   * process that lives for hours leaves a log of many megabytes — which the
   * next reattach and every tail restart have to seek through. Truncating it in
   * place is not safe (a byte the CLI writes between the size check and the
   * truncate is lost, and the offsets saved so far would point past the end).
   * Starting a new process is: every launch is `fresh`, so its log starts
   * empty, and `--resume` carries the conversation over from the transcript.
   *
   * So a process whose log has passed the threshold is ended once it has been
   * quiet for a while with nothing in flight — no turn, no question, no write,
   * no half-read line, no background task. It is the `configure` path without a
   * settings change: the session stays idle, and the next prompt respawns.
   */
  private scheduleRecycle(): void {
    if (this.consumed < RECYCLE_LOG_BYTES) return
    this.cancelRecycle()
    this.recycleTimer = setTimeout(() => {
      this.recycleTimer = null
      this.recycleIfIdle()
    }, RECYCLE_QUIET_MS)
  }

  private cancelRecycle(): void {
    if (this.recycleTimer) clearTimeout(this.recycleTimer)
    this.recycleTimer = null
  }

  private recycleIfIdle(): boolean {
    const record = this.record
    if (!record || !this.alive || this.stopped || this.exiting) return false
    if (this.turnPending || this.pendingWrites > 0 || this.questions.size > 0) return false
    if (this.lines.pendingBytes > 0 || this.consumed < RECYCLE_LOG_BYTES) return false
    for (const task of this.startedTasks.values()) {
      // A background shell reports no end on this stream, so it blocks for good.
      if (!task.agent || !this.finishedSubagents.has(task.key)) return false
    }
    this.exiting = true
    this.alive = false
    this.resume = true
    this.stopLiveness()
    this.stopTail()
    this.record = null
    clearDurableState(this.opts.sessionId)
    void durableDestroy(record)
    return true
  }

  /**
   * Write the note that lets the next server find this process again.
   *
   * Throttled, because the offset moves with every token of a streamed reply and
   * this is a file write; flushed the moment anything else about the session
   * changes, so what is on disk is never more than a fraction of a second — or
   * one `AGENT_STATE_MS` — behind. The cost of being late is a few lines read
   * twice after a hard crash, and every event that matters carries a stable id,
   * so a line read twice is a row rewritten rather than a row added.
   */
  private saveState(offset: number, force = false): void {
    if (!this.record) return
    if (!force && offset - this.lastSaved < AGENT_STATE_BYTES && Date.now() - this.lastSavedAt < AGENT_STATE_MS) return
    this.lastSaved = offset
    this.lastSavedAt = Date.now()
    const state: DurableState = {
      ...this.record,
      sessionId: this.opts.sessionId,
      harness: 'claude',
      outOffset: offset,
      busy: this.turnPending,
    }
    writeDurableState(state)
  }

  private lastSavedAt = 0

  /**
   * Notice the agent going away, since there is no child process to await.
   *
   * The wrapper writes the CLI's exit status down as its last act, so this asks
   * two questions rather than one: is it still there, and if not, how did it
   * end? Losing that distinction would make every death look the same — a
   * conversation the CLI could not resume, a crash worth reporting and a clean
   * finish all reduced to silence.
   */
  private watchLiveness(): void {
    if (this.liveness) clearInterval(this.liveness)
    const incarnation = this.incarnation
    this.liveness = setInterval(() => {
      void this.checkLiveness(incarnation)
    }, LIVENESS_MS)
  }

  private async checkLiveness(incarnation: number): Promise<void> {
    if (this.checkingLiveness) return
    this.checkingLiveness = true
    try {
      await this.checkLivenessOnce(incarnation)
    } catch (error) {
      // This runs off a timer, where a rejection nobody handles takes the whole
      // server down — and the recovery below relaunches over ssh, which can fail.
      if (this.stopped) return
      this.hooks.error(formatFailure(error, { ...this.failureContext, because: 'could not reopen this conversation' }))
      this.hooks.status('error')
    } finally {
      this.checkingLiveness = false
    }
  }

  private async checkLivenessOnce(incarnation: number): Promise<void> {
    const record = this.record
    if (!record || this.stopped || this.exiting) return
    const alive = await durableAlive(record)
    // `null` is "could not ask", which is not an answer: a host that blipped
    // says nothing about a process still running on it, and reporting that as a
    // death is how a working session gets declared dead.
    if (alive !== false) return
    if (this.incarnation !== incarnation || this.record !== record) return
    // A last look at the log before it is declared over: the `result` frame of
    // the final turn is often written microseconds before the process exits, and
    // the tail's next poll would never come.
    await Bun.sleep(LIVENESS_DRAIN_MS)
    if (this.incarnation !== incarnation || this.stopped || this.exiting) return
    this.alive = false
    this.stopLiveness()
    this.stopTail()
    // Its agents died with it, even on a clean exit or a kill that left no status.
    this.hooks.processExited?.()
    const code = await durableExit(record)
    // A prompt sent while this was being asked relaunches the CLI (the process
    // was no longer `alive`): the new one's turn is not this one's to report on.
    if (this.incarnation !== incarnation || this.stopped) return
    this.saveState(this.consumed, true)
    if (code === 0 || code === null) {
      this.hooks.status('idle')
      return
    }
    const detail = (await durableStderr(record)).trim()
    if (this.incarnation !== incarnation || this.stopped) return
    if (await this.recoverFromMissingSession(detail)) return
    this.hooks.error(
      formatFailure(`claude exited with code ${code}${detail ? `\n${detail}` : ''}`, this.failureContext),
    )
    this.hooks.status('error')
  }

  private stopLiveness(): void {
    if (this.liveness) clearInterval(this.liveness)
    this.liveness = null
  }

  /**
   * The stored conversation can disappear (transcript cleaned up, session made
   * in another directory, fresh machine). The CLI then refuses to resume — and
   * the message that triggered the resume would be lost. Recovery: start a fresh
   * conversation with a new id and resend it, so the user never sees a dead end.
   */
  private async recoverFromMissingSession(stderr: string): Promise<boolean> {
    if (this.recoveryTried) return false
    if (!/No conversation found|No session found|session not found|not found with session ID/i.test(stderr)) {
      return false
    }
    this.recoveryTried = true
    this.reader?.stop()
    this.uuid = crypto.randomUUID()
    this.resume = false
    // A new, empty conversation: nothing is re-read, the totals so far stand.
    this.attachReader(false)
    this.hooks.event({
      k: 'system',
      subtype: 'recover',
      text: 'the previous conversation is gone — started a fresh one and kept your message',
    })
    await this.launch(false)
    const text = this.lastUserText
    if (this.turnPending && text) await this.writeTurn(text, false, this.lastAttachments ?? undefined)
    return true
  }

  private handleStreamLine(line: string): void {
    let rec: any
    try {
      rec = JSON.parse(line)
    } catch {
      return
    }
    // The coverage contract: a frame type the mapping does not know is recorded.
    const coverageKey = claudeStreamKey(rec)
    if (coverageKey) noteProtocol('claude', 'claude', coverageKey)

    // The CLI asks before it runs something and waits for the answer: this is
    // the one path that must not fall through to the end of the function.
    if (rec.type === 'control_request') {
      this.handleControlRequest(rec as Record<string, unknown>)
      return
    }

    if (rec.type === 'system' && rec.subtype === 'init') {
      const model = this.adoptModel(rec.model)
      this.hooks.event(
        {
          k: 'system',
          subtype: 'init',
          text: `${model || this.reportedModel || 'claude'} · ${this.opts.cwd}${rec.permissionMode ? ` · ${rec.permissionMode}` : ''}`,
        },
        { id: `system:init:${this.uuid}`, at: this.startedAt },
      )
      return
    }

    if (rec.type === 'system' && rec.subtype === 'thinking_tokens') {
      // Claude Code does not stream thinking text in print mode, but it does
      // report real incremental token counts: the best possible tokens/sec feed.
      const delta = Number(rec.estimated_tokens_delta ?? 0)
      if (delta > 0) this.hooks.tokens(delta)
      return
    }

    // Output after the cycle's result, with nothing sent: the CLI woke up by
    // itself — a background agent or shell finished and it carries on. That is
    // work, so it is announced as such; before, the session sat "idle" (and
    // released queued prompts into a busy CLI) while the model was answering.
    // Main loop only: a background subagent's own frames carry the spawning
    // call in `parent_tool_use_id` and keep arriving after the result, and
    // those are the agent working, not the main loop waking.
    if (
      (rec.type === 'stream_event' || rec.type === 'assistant')
      && !rec.parent_tool_use_id
      && !this.turnPending
      && !this.exiting
      && !this.stopped
    ) {
      this.turnPending = true
      this.cancelRecycle()
      this.hooks.turnStarted()
      this.hooks.status('running')
    }

    if (rec.type === 'stream_event') {
      const event = rec.event
      const index = event?.index ?? 0
      if (event?.type === 'content_block_delta') {
        const delta = event.delta
        if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
          this.hooks.delta(`main:${index}`, 'text', delta.text)
        } else if (
          delta?.type === 'thinking_delta' &&
          typeof delta.thinking === 'string' &&
          delta.thinking
        ) {
          this.hooks.delta(`main:${index}`, 'thinking', delta.thinking)
        }
      }
      return
    }

    // A subagent's own messages (`parent_tool_use_id`): its context is its own
    // conversation, not this one — a background agent at 104k was drawn as the
    // main chat's size while the main chat held 45k — and its model can be a
    // different one. The transcript reader skips sidechains for the same reason.
    if (rec.type === 'assistant' && rec.parent_tool_use_id) return

    if (rec.type === 'assistant') {
      // Every assistant message names the model that produced it, which is the
      // resolved one — `--model sonnet` comes back as a dated id, and a session
      // can be moved onto a different model mid-run (a fallback, /model) — with
      // the one exception the CLI fabricated itself (`adoptModel`).
      this.adoptModel(rec.message?.model)
      // A synthetic message carries an all-zero usage block, and `normalizeUsage`
      // already answers `undefined` for one: nothing was spent because no model
      // ran, and adding zeros would be a measurement nobody took.
      const usage = normalizeUsage(rec.message?.usage)
      if (usage) {
        this.creditUsage(usage, typeof rec.message?.id === 'string' ? rec.message.id : undefined)
      }
      return
    }

    if (rec.type === 'system' && rec.subtype === 'status') {
      return
    }

    // The CLI retrying a failed API call, live: attempt n of max, the delay and
    // why. The transcript's copy of the same notice is skipped (see the reader),
    // so this is the one line per retry.
    if (rec.type === 'system' && rec.subtype === 'api_retry') {
      const { text, detail } = apiErrorLine(rec.error, rec)
      this.hooks.event(
        { k: 'system', subtype: 'api_retry', text, ...(detail ? { detail } : {}) },
        { id: `api_retry:${crypto.randomUUID()}`, at: Date.now() },
      )
      return
    }

    // A subagent was launched. This one frame carries everything the card needs
    // — the agent id, the spawn call it belongs to, its type, its depth and the
    // prompt it was given — atomically, the instant it happens. The transcript
    // says the same thing eventually, across two files that arrive separately
    // and neither of which is complete on its own, so this is both the fastest
    // and the only source that cannot be read half-written.
    if (rec.type === 'system' && rec.subtype === 'task_started') {
      const taskId = String(rec.task_id ?? '')
      const agent = rec.task_type === 'local_agent' || Boolean(rec.subagent_type)
      if (taskId) this.startedTasks.set(taskId, { agent, key: String(rec.tool_use_id ?? '') || taskId })
      // Claude uses the same task lifecycle for background Bash commands.
      // Only a local_agent has a subagent transcript/card; treating local_bash
      // as one created anonymous "failed" agents with no expandable work.
      if (rec.task_type !== 'local_agent' && !rec.subagent_type) return
      const toolUseId = String(rec.tool_use_id ?? '')
      if (toolUseId) {
        this.reader?.noteSubagent({
          toolUseId,
          agentId: String(rec.task_id ?? ''),
          agentType: typeof rec.subagent_type === 'string' ? rec.subagent_type : undefined,
          description: typeof rec.description === 'string' ? rec.description : undefined,
          prompt: typeof rec.prompt === 'string' ? rec.prompt : undefined,
          depth: typeof rec.spawn_depth === 'number' ? rec.spawn_depth : undefined,
        })
      }
      return
    }

    // A running subagent, reporting on itself. Nothing else does: a background
    // agent's sidechain says nothing about its own progress, and its completion
    // notice only arrives when it is over — so without this the card sat on the
    // empty launch row for the whole of the agent's life.
    if (rec.type === 'system' && rec.subtype === 'task_progress') {
      if (!rec.subagent_type) return
      this.reportSubagentProgress(rec)
      return
    }

    if (rec.type === 'rate_limit_event') {
      this.handleRateLimit(rec.rate_limit_info ?? {})
      return
    }

    if (rec.type === 'result') {
      const usage = normalizeUsage(rec.usage)
      const window = reportedContextWindow(rec.modelUsage, this.reportedModel)
      if (window) this.reportedWindow = window
      // A result without `total_cost_usd` (a subscription run) has not told us
      // the turn was free: it has not told us anything, so no cost is added.
      const cost = typeof rec.total_cost_usd === 'number' ? rec.total_cost_usd : null
      this.turns += 1
      // The result's usage is the turn's calls summed. Every one of those
      // messages was charged already (`creditUsage`), so the meter only falls
      // back to this total for a turn whose messages it never saw.
      this.hooks.usage(usage ?? {}, {
        ...(cost === null ? {} : { costUsd: cost }),
        // Only alongside a usage the CLI actually reported. A turn that ran no
        // model — a slash command handled locally — ends with an all-zero usage
        // block, and publishing the model's window there told the readout that
        // the context had been measured, so "not reported" became "0 of 200k".
        ...(usage ? this.windowOpts(0) : {}),
        commitTurn: true,
      })
      const subtype = String(rec.subtype ?? 'success')
      const text = typeof rec.result === 'string' ? rec.result : ''
      const outcome = resultOutcomeFor(subtype, { isError: Boolean(rec.is_error) })
      // The turn landed: stop treating the last message as pending.
      this.turnPending = false
      this.lastUserText = null
      this.lastAttachments = null
      this.hooks.event(
        {
          k: 'result',
          outcome,
          subtype,
          text: rec.is_error ? text || 'turn failed' : '',
          // The cycle's final reply, as the CLI reports it: what lets the UI
          // confirm the answer of the last cycle without guessing from rows.
          ...(!rec.is_error && text ? { reply: text } : {}),
          usage,
          durationMs: Number(rec.duration_ms ?? 0),
          // The field is required by the shared event, so a turn the CLI priced
          // at nothing and a turn it never priced would look the same number;
          // `costReported` is what tells them apart.
          costUsd: cost ?? 0,
          costReported: cost !== null,
        },
        // Unique across processes, not only within this one. `this.turns` starts
        // again at zero in every driver, so a respawned session's first result
        // was `result:<conversation>:1` — the id of the *first turn's* result —
        // and overwrote it in place, taking the new turn's result with it. The
        // CLI's own frame uuid is the identity when it sends one.
        { id: typeof rec.uuid === 'string' && rec.uuid ? `result:${rec.uuid}` : `result:${this.uuid}:${this.runId}:${this.turns}`, at: Date.now() },
      )
      this.hooks.status(outcome === 'failed' ? 'error' : 'idle')
      return
    }
  }

  /**
   * Take the model the CLI named, unless it did not name one.
   *
   * Claude Code stamps the messages it writes itself — the reply to a slash
   * command, "No response requested.", an API error turned into prose — with
   * `"model": "<synthetic>"`. That is a sentinel saying *no model produced
   * this*, and publishing it replaced the model the session is really running
   * with a string that is not a model at all, everywhere it is shown. The
   * session keeps what it had; a placeholder tells us nothing, and nothing is
   * what it is worth.
   *
   * Returns the model now in force, or null while the CLI has named none.
   */
  private adoptModel(value: unknown): string | null {
    const model = typeof value === 'string' ? value.trim() : ''
    if (!model || isPlaceholderModel(model)) return this.reportedModel
    if (model === this.reportedModel) return model
    // Another model has another window: the one reported for the old is void.
    if (this.reportedModel) this.reportedWindow = null
    this.reportedModel = model
    this.hooks.model(model)
    return model
  }

  /**
   * Whether a provisional subagent row is worth publishing over the last one.
   *
   * Two sources describe a subagent that has not finished, and they do not
   * arrive in the order they were written: the launch row (`async_launched`,
   * no metrics, out of the transcript, behind a 120ms poller) and the progress
   * frame (real `tool_uses` and `duration_ms`, off the live stream). Both write
   * under the same event id, so whichever lands last is what the card shows —
   * and in a real capture that was the launch row, which put a card that had
   * reported "1 tool, 1.6s" back to "0 tools, 0ms".
   *
   * A provisional row therefore only replaces another provisional row when it
   * knows at least as much. The finished row is not subject to this: it is the
   * truth and it always wins.
   */
  private keepProvisional(key: string, toolUses: number, durationMs: number): boolean {
    if (!key) return true
    const best = this.provisionalSubagents.get(key)
    if (best && toolUses < best.toolUses && durationMs < best.durationMs) return false
    this.provisionalSubagents.set(key, {
      toolUses: Math.max(toolUses, best?.toolUses ?? 0),
      durationMs: Math.max(durationMs, best?.durationMs ?? 0),
    })
    return true
  }

  /**
   * A running subagent's own progress, as the CLI reports it.
   *
   * `task_progress` carries real counters — `tool_uses`, `duration_ms` and the
   * name of the tool the agent is on right now — for an agent that has not
   * finished. There is no progress event in the shared domain, and inventing one
   * here would be inventing protocol; what there *is* is `subagent_end`'s
   * `provisional` flag, which exists for precisely this ("the UI keeps the
   * subagent marked as running and the richer record replaces this one in
   * place"). So the row is written under the same id, marked provisional and
   * with the status the agent is honestly in — `running` — and a real ending
   * overwrites it later.
   *
   * `total_tokens` is deliberately not published as usage: it is one number for
   * a whole sidechain, and `TokenUsage` wants input, output, cache read and
   * cache write kept apart. Spreading one total across four counters, or
   * filing it under any single one, would be stating a measurement nobody took.
   */
  private reportSubagentProgress(rec: Record<string, any>): void {
    const toolId = String(rec.tool_use_id ?? '')
    const agentId = String(rec.task_id ?? '')
    const key = toolId || agentId
    if (!key || this.finishedSubagents.has(key)) return
    const usage = (rec.usage ?? {}) as Record<string, unknown>
    // Through `event`, not `hooks.event`: that is where a provisional row is
    // weighed against the last one, and a row published around it would neither
    // be weighed nor counted (which is exactly what let the launch row
    // overwrite this one).
    this.event(
      {
        k: 'subagent_end',
        toolId,
        agentId,
        status: 'running',
        durationMs: typeof usage.duration_ms === 'number' ? usage.duration_ms : 0,
        toolUses: typeof usage.tool_uses === 'number' ? usage.tool_uses : 0,
        // What it is doing, not what it produced: the agent has produced nothing
        // yet, and putting a running commentary in `result` would read as one.
        result: '',
        provisional: true,
      },
      `subagent_end:${key}`,
      Date.now(),
      agentId || undefined,
    )
  }

  /**
   * `rate_limit_event` carries the same numbers as `/usage`: utilisation as a
   * fraction (0.26 = 26%) plus reset timestamps.
   */
  private handleRateLimit(info: any): void {
    const unified = info?.unifiedWindows ?? {}
    const entries = Object.entries<any>(unified).filter(([, value]) => value && typeof value.utilization === 'number')
    const asFraction = entries.length > 0 && entries.every(([, value]) => value.utilization <= 1)
    const labelFor = (key: string) => {
      if (key === 'five_hour') return { label: '5h', minutes: 300 }
      if (key === 'seven_day') return { label: '7d', minutes: 10_080 }
      if (key === 'monthly') return { label: 'monthly', minutes: 43_200 }
      return { label: key.replace(/_/g, ' '), minutes: 0 }
    }

    const windows = entries.map(([key, value]) => {
      const { label, minutes } = labelFor(key)
      const used = asFraction ? value.utilization * 100 : value.utilization
      return {
        label,
        usedPercent: Math.max(0, Math.min(100, used)),
        windowMinutes: minutes,
        resetsAt:
          typeof value.resetsAt === 'number'
            ? value.resetsAt < 1e12
              ? value.resetsAt * 1000
              : value.resetsAt
            : null,
      }
    })

    if (windows.length === 0 && typeof info?.rateLimitType === 'string') {
      const { label, minutes } = labelFor(info.rateLimitType)
      windows.push({
        label,
        usedPercent: 0,
        windowMinutes: minutes,
        resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : null,
      })
    }

    this.hooks.limits(windows, {
      plan: null,
      credits: {
        hasCredits: info?.overageStatus === 'allowed',
        unlimited: false,
        balance: null,
      },
      error:
        info?.overageDisabledReason && info.overageDisabledReason !== null
          ? String(info.overageDisabledReason).replace(/_/g, ' ')
          : null,
    })
  }

  /* ---------------- Driver ---------------- */

  send(text: string, attachments?: AttachmentRef[]): Promise<SendResult> {
    if (this.stopped) return Promise.resolve({ status: 'refused', reason: 'the driver has stopped' })
    this.cancelRecycle()
    this.echoes.remember(text)

    this.hooks.turnStarted()
    this.hooks.status('running')

    const queued = this.pendingWrites > 0
    this.pendingWrites += 1
    const delivery = this.enqueue(() => this.writeTurn(text, true, attachments)).finally(() => {
      this.pendingWrites -= 1
    })
    return queued ? Promise.resolve({ status: 'queued' }) : delivery
  }

  /** Everything that touches the detached process, in the order it was asked for. */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.chain.then(operation, operation)
    this.chain = queued.catch(() => undefined)
    return queued
  }

  /** Write the turn to the detached process, relaunching it with `--resume` first if needed. */
  private async writeTurn(text: string, remember: boolean, attachments?: AttachmentRef[]): Promise<SendResult> {
    if (this.stopped) return { status: 'refused', reason: 'the driver has stopped' }
    if (remember) {
      this.lastUserText = text
      this.lastAttachments = attachments ?? null
      this.turnPending = true
      this.saveState(this.lastSaved, true)
    }

    const payload = `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }, ...imageBlocks(attachments)] },
      parent_tool_use_id: null,
      session_id: this.uuid,
    })}\n`

    if (this.record && this.alive && (await durableWrite(this.record, payload))) return { status: 'delivered' }

    try {
      await this.launch(this.resume)
      if (!(await durableWrite(this.record!, payload))) {
        throw new Error('the agent was started but would not take the message')
      }
      return { status: 'delivered' }
    } catch (err) {
      // A stop that landed mid-launch is not a failure to tell anybody about.
      if (this.stopped) return { status: 'refused', reason: 'the driver has stopped' }
      this.hooks.error(formatFailure(err, { ...this.failureContext, because: 'could not reopen this conversation' }))
      this.hooks.status('error')
      return { status: 'refused', reason: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * A request from the CLI: it is blocked until a control_response comes back.
   *
   * *Every* one gets an answer. The CLI can ask for far more than permission —
   * `hook_callback`, `mcp_message`, `elicitation`, `request_user_dialog`,
   * `oauth_token_refresh` and more, and the list grows with its versions — and a
   * request this client simply ignored left the CLI waiting forever on a reply
   * that was never coming, which is a session that has hung for good. A subtype
   * we do not implement is answered with the CLI's own "not supported in this
   * context" error, which is a real answer: the CLI unblocks and carries on
   * without that capability.
   */
  private handleControlRequest(rec: Record<string, unknown>): void {
    const request = (rec.request ?? {}) as Record<string, unknown>
    const requestId = String(rec.request_id ?? '')
    const subtype = String(request.subtype ?? '')
    if (!requestId) return
    if (subtype !== 'can_use_tool') {
      this.refuseControl(requestId, subtype || 'this request')
      return
    }

    const tool = String(request.tool_name ?? 'tool')
    const input = (request.input ?? {}) as Record<string, unknown>
    const mode = this.opts.permissionMode

    const reply = (response: Record<string, unknown>) => this.respondControl(requestId, response)
    const allow = () => reply({ behavior: 'allow', updatedInput: input })
    const deny = (message: string) => reply({ behavior: 'deny', message, interrupt: false })

    if (tool === 'AskUserQuestion') {
      this.askStructuredQuestion(requestId, input)
      return
    }

    if (mode === 'plan') {
      this.hooks.event({ k: 'system', subtype: 'permission', text: `plan-only session: refused “${tool}”` })
      deny('this session is in plan mode, which must not run tools')
      return
    }

    // Bypass was chosen to skip every prompt, and the CLI was started with
    // `--dangerously-skip-permissions` to match; nothing else auto-approves.
    if (mode === 'bypassPermissions') {
      allow()
      return
    }

    // `acceptEdits` accepts edits. The CLI has already applied the mode by the
    // time this arrives, so a Bash command, a fetch or an unrecognised tool is
    // precisely what the mode did *not* approve — it goes to the person, the way
    // the native mode says it should.
    // Only inside the session's folder, though: the CLI routes an edit back
    // here when it is outside its own workspace too, and that is not what the
    // mode promised to accept.
    if (mode === 'acceptEdits' && ACCEPT_EDITS_TOOLS.has(tool)) {
      void acceptEditsMayApprove(this.transport, this.opts.cwd, { isEdit: true, paths: editedPaths(input) }).then(
        (inside) => (inside ? allow() : this.askToolPermission(requestId, tool, input, allow, deny)),
      )
      return
    }

    this.askToolPermission(requestId, tool, input, allow, deny)
  }

  /** A tool the mode does not cover, put to the person as a request card. */
  private askToolPermission(
    requestId: string,
    tool: string,
    input: Record<string, unknown>,
    allow: () => void,
    deny: (message: string) => void,
  ): void {
    // The card's options carry no ids, so what comes back is the label the
    // person clicked ("Allow" / "Deny").
    this.questions.set(requestId, {
      resolve: (choice) => (choice.toLowerCase() === 'deny' ? deny('declined in sedano') : allow()),
      // Nobody is going to answer now. A denial is the only reply that lets the
      // CLI unwind: an allow would run a tool the user just stopped.
      cancel: () => deny('the session was stopped before this was approved'),
    })
    this.hooks.event({
      k: 'request',
      requestId,
      kind: 'permission',
      title: `Run ${tool}?`,
      detail: summarizeRequest(input),
      options: [
        { id: 'Allow', label: 'Allow', intent: 'allow' },
        { id: 'Deny', label: 'Deny', hint: 'the turn continues without running it', intent: 'deny' },
      ],
      state: 'pending',
    })
  }

  /**
   * The native `AskUserQuestion`, kept as the structured request it is.
   *
   * Claude Code documents this as a real interactive request: the input carries
   * 1-4 questions, each with a header, 2-4 labelled options with descriptions,
   * and a `multiSelect` flag, and the answer goes back as
   * `{behavior:'allow', updatedInput:{questions, answers}}` where `answers` maps
   * each question's own text to the chosen option's label. Turning that into
   * system text (or into a fake permission with Allow/Deny) threw away the one
   * moment the model is actually waiting on the person.
   *
   * One card per question, because the only answer channel this build has is
   * `answer_question(toolId, optionId)` — one choice per card. The card ids are
   * `<request_id>#<index>`, so each question is answered on its own and the
   * reply goes back once all of them are in.
   *
   * FOLLOW-UP (phase 4b/2): the shared domain needs a first-class interactive
   * request that carries the whole question set, its `multiSelect` flag and the
   * option `preview` field, plus an answer message that can carry several
   * selections. Until then two things stay lossy and are deliberately not
   * faked here: a `multiSelect` question takes exactly one label, and an
   * option's `preview` is dropped. The free-text `response` field is not
   * offered at all — the composer answers in prose instead.
   */
  private askStructuredQuestion(requestId: string, input: Record<string, unknown>): void {
    const questions = Array.isArray(input.questions)
      ? (input.questions as Array<{
          question?: string
          header?: string
          multiSelect?: boolean
          options?: Array<{ label?: string; description?: string }>
        }>)
      : []
    const answerable = questions.filter((question) => (question.options ?? []).some((option) => option.label))
    if (!answerable.length) {
      // Malformed input is not a question, and guessing an answer would put
      // words in the person's mouth.
      this.respondControl(requestId, {
        behavior: 'deny',
        message: 'the AskUserQuestion input carried no answerable options',
        interrupt: false,
      })
      return
    }

    const answers: Record<string, string> = {}
    let outstanding = answerable.length
    // One control request, several cards: it is answered exactly once, whichever
    // way it ends, or the CLI would read a second response to a request it has
    // already moved on from.
    let settled = false
    const settle = (response: Record<string, unknown>) => {
      if (settled) return
      settled = true
      this.respondControl(requestId, response)
    }
    answerable.forEach((question, index) => {
      const toolId = `${requestId}#${index}`
      const text = question.question ?? question.header ?? 'Question'
      this.questions.set(toolId, {
        resolve: (label) => {
          answers[text] = label
          outstanding -= 1
          if (outstanding > 0) return
          // The tool needs its own questions back alongside the answers: that is
          // what the CLI reads to match each answer to the question it belongs to.
          settle({
            behavior: 'allow',
            updatedInput: { ...input, questions: input.questions, answers },
          })
        },
        // Half-answered is not answered: a question set the person never
        // finished is refused whole rather than sent back with gaps in it.
        cancel: () =>
          settle({
            behavior: 'deny',
            message: 'the session was stopped before the question was answered',
            interrupt: false,
          }),
      })
      this.hooks.event({
        k: 'request',
        requestId: toolId,
        kind: 'question',
        title: text,
        detail: question.header,
        // The agent's own options, with their descriptions. The id is the label
        // because the label is what the answer must carry back.
        options: (question.options ?? [])
          .filter((option) => option.label)
          .map((option) => ({
            id: option.label as string,
            label: option.label as string,
            hint: option.description,
            intent: 'neutral' as const,
          })),
        state: 'pending',
      })
    })
  }

  private respondControl(requestId: string, response: Record<string, unknown>): void {
    this.writeControl({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    })
  }

  /**
   * "I cannot do that", in the CLI's own words for a capability a client did not
   * register. An explicit refusal is what lets the CLI move on; silence is what
   * hangs it.
   */
  private refuseControl(requestId: string, subtype: string): void {
    this.writeControl({
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: requestId,
        error: `${subtype} is not supported in this context (sedano does not implement it)`,
      },
    })
  }

  /**
   * A line of protocol for the CLI, behind whatever is already on its way.
   *
   * On the chain, and not written straight out, for the reason the chain exists:
   * a permission answer that overtook the prompt it belongs to would be answering
   * a request the CLI has not made yet.
   */
  private writeControl(message: Record<string, unknown>): void {
    void this.enqueue(async () => {
      if (!this.record || !this.alive) return
      await durableWrite(this.record, `${JSON.stringify(message)}\n`)
    }).catch(() => undefined)
  }

  /** The UI's answer to a question this session is waiting on. */
  answerQuestion(toolId: string, optionId: string): void {
    const waiting = this.questions.get(toolId)
    if (!waiting) return
    this.questions.delete(toolId)
    waiting.resolve(optionId)
  }

  /**
   * Let go of every question still waiting.
   *
   * ACP's `interrupt()`/`stop()` have always done this and this one did not, so
   * a stop killed the process with its continuations still in the map and the
   * CLI still blocked on a control request nobody would ever answer.
   *
   * Only the process is unblocked here. The transcript side is the manager's:
   * `stopSession`/`interruptSession` close the stored request and emit the
   * terminal `tool_result` themselves, so a second one written from here would
   * put the same ending in the timeline twice.
   */
  private dropQuestions(): void {
    for (const [toolId, waiting] of this.questions) {
      this.questions.delete(toolId)
      waiting.cancel()
    }
  }

  interrupt(): void {
    // Before the interrupt itself: a CLI blocked on a permission is not reading
    // anything else, so the refusal has to go first for the interrupt to land.
    this.dropQuestions()
    this.writeControl({
      type: 'control_request',
      request_id: crypto.randomUUID(),
      request: { subtype: 'interrupt' },
    })
  }

  /**
   * Stop, which durability must never make impossible.
   *
   * The whole point of the detached launch is that closing a tab or closing
   * sedano leaves the agent working — so the one thing that must still end it is
   * the user asking. Nothing here is left to the operating system noticing a
   * pipe close: the process group is killed by name on the machine it runs on,
   * and the note that would let a later server find it is torn up, so a stopped
   * session cannot be reattached to by anything.
   */
  stop(): void {
    // While the CLI is still reading: a refusal written after the kill goes
    // nowhere, and the point is to let it unwind rather than wedge.
    this.dropQuestions()
    this.stopped = true
    this.launchEpoch += 1
    this.exiting = true
    this.alive = false
    this.cancelRecycle()
    this.reader?.stop()
    this.stopLiveness()
    this.stopTail()
    const record = this.record
    this.record = null
    // Only a note this driver owns. After a configure or a recycle the manager
    // starts the replacement driver *before* stopping this one, and clearing
    // unconditionally tore up the new process' note — a restart then could not
    // find it, and it ran on with nothing able to reattach to it or end it.
    if (record) {
      clearDurableState(this.opts.sessionId)
      void durableDestroy(record)
    }
  }

  /**
   * Let go of the agent without ending it: this server is exiting, and the next
   * one reattaches (see `attachDurable`).
   *
   * The note is written first and forced, with everything acted on so far — the
   * throttle can leave it a fraction of a second behind, and those bytes would
   * otherwise be read twice. Pending questions are left alone: the CLI stays
   * blocked on them, and the next server answers them from `pendingRequests`.
   */
  detach(): void {
    if (this.stopped) return
    this.cancelRecycle()
    this.saveState(this.consumed, true)
    this.stopped = true
    this.launchEpoch += 1
    this.exiting = true
    this.alive = false
    this.reader?.stop()
    this.stopLiveness()
    this.stopTail()
    this.record = null
  }
}

/**
 * How often the detached process is asked whether it is still there, and how
 * long its log is given to catch up once the answer is no.
 *
 * Four seconds matches the terminal driver's own liveness tick — often enough
 * that a crash is not a session that sits on "Working…", rare enough that a
 * hundred sessions are not a hundred ssh round trips a second. The drain is what
 * keeps the final `result` frame: it is written microseconds before the process
 * exits, and without a last look the turn would never be seen to end.
 */
const LIVENESS_MS = 4000
const LIVENESS_DRAIN_MS = 600

/**
 * How stale the note on disk is allowed to get: a fraction of a second, or a
 * page of output, whichever comes first. Both, because a streamed reply moves
 * the offset hundreds of times a second and a session sitting idle moves it not
 * at all.
 */
/** Recycle a quiet idle process once its stream log has passed this size. */
const RECYCLE_LOG_BYTES = Number(process.env.SEDANO_RECYCLE_LOG_BYTES ?? 8 * 1024 * 1024)
/** How long a process must have been quiet before it is recycled. */
const RECYCLE_QUIET_MS = Number(process.env.SEDANO_RECYCLE_QUIET_MS ?? 60_000)
const AGENT_STATE_MS = 400
const AGENT_STATE_BYTES = 16_384
