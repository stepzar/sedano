import { join } from 'node:path'
import type {
  SubagentStatus,
  TimelineEvent,
  TokenUsage,
  TokenUsageField,
  ToolStatBreakdown,
} from '@shared'
import { markUnreported, realModel } from '@shared'
import { claudeSubagentsDir, claudeTranscriptPath, CLAUDE_HOME } from '../../paths.ts'
import { Transport, type PollResult } from '../../transport.ts'
import { LineSplitter } from '../lines.ts'

const TOOL_RESULT_LIMIT = 12_000

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * A Claude usage block, with the counters it never published left unknown.
 *
 * Two things the captured runs settled. The thinking counter does not live where
 * this used to look for it: every real block (stream frame, transcript record
 * and `result` alike) carries it as `output_tokens_details.thinking_tokens`, and
 * `reasoning_output_tokens` has never once appeared — so a turn that spent 1,270
 * thinking tokens reported "0 reasoning", which is this app stating a
 * measurement it did not take. And `0` was the answer for *every* counter the
 * block omitted, which is the same untruth in the four other places; a counter
 * nobody reported is tagged unreported instead, exactly as the Command Code
 * driver already does, and the UI says nothing rather than zero.
 */
export function normalizeUsage(u: any): TokenUsage | undefined {
  if (!u || typeof u !== 'object') return undefined
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const has = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
  // The CLI nests it; the flat names are kept for the shapes older CLIs wrote.
  const thinking = u.output_tokens_details?.thinking_tokens ?? u.reasoning_output_tokens ?? u.reasoning_tokens
  const usage: TokenUsage = {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
    reasoning: num(thinking),
  }
  if (!usage.input && !usage.output && !usage.cacheRead && !usage.cacheWrite) return undefined
  const unreported: TokenUsageField[] = []
  if (!has(u.input_tokens)) unreported.push('input')
  if (!has(u.output_tokens)) unreported.push('output')
  if (!has(u.cache_read_input_tokens)) unreported.push('cacheRead')
  if (!has(u.cache_creation_input_tokens)) unreported.push('cacheWrite')
  if (!has(thinking)) unreported.push('reasoning')
  return markUnreported(usage, unreported)
}

export function summarizeTool(name: string, input: any): string {
  if (!input || typeof input !== 'object') return ''
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = (input as Record<string, unknown>)[key]
      if (typeof value === 'string' && value) return value
    }
    return ''
  }
  switch (name) {
    case 'Bash':
    case 'shell':
      return pick('command').split('\n')[0]!.slice(0, 200)
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return pick('file_path', 'path', 'notebook_path')
    case 'Glob':
    case 'Grep':
      return pick('pattern')
    case 'WebFetch':
      return pick('url')
    case 'WebSearch':
      return pick('query')
    case 'Task':
    case 'Agent':
      return pick('description', 'subagent_type')
    // A skill's whole identity is its name, and it is the one key the default
    // branch below never looked at — so the card rendered the bare word "Skill"
    // and a clock, saying nothing about what was launched.
    case 'Skill':
      return pick('skill', 'name', 'command')
    case 'AskUserQuestion': {
      // The harness asks through this tool, and its questions are the whole
      // point of the card: without a case here the head was blank.
      const questions = (input as { questions?: Array<{ question?: string }> }).questions ?? []
      const first = questions[0]?.question ?? ''
      if (!first) return 'Question'
      return questions.length > 1 ? `${first} (+${questions.length - 1})` : first
    }
    default:
      return pick('path', 'file_path', 'command', 'query', 'pattern', 'url', 'description').slice(0, 200)
  }
}

function textOf(content: unknown, limit = TOOL_RESULT_LIMIT): { text: string; truncated: boolean } {
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    text = content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          const p = part as Record<string, any>
          if (typeof p.text === 'string') return p.text
          if (p.type === 'image') return '[image]'
          // `ToolSearch` answers with one `tool_reference` per tool it found and
          // no prose at all, so returning nothing here rendered a search that
          // succeeded as a result card with nothing in it — the name is the
          // whole answer.
          if (p.type === 'tool_reference') return typeof p.tool_name === 'string' ? p.tool_name : ''
          if (p.type === 'tool_use') return ''
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  } else if (content != null) text = JSON.stringify(content, null, 1)
  if (text.length > limit) return { text: text.slice(0, limit), truncated: true }
  return { text, truncated: false }
}

const INSPECT_TOOLS = new Set(['Read', 'NotebookRead'])
const SEARCH_TOOLS = new Set(['Glob', 'Grep', 'WebSearch', 'WebFetch'])
const BASH_TOOLS = new Set(['Bash', 'shell', 'run_terminal_command'])

const PREVIEW_LIMIT = 2400

/**
 * Turn a file-writing tool result into a card our UI can render.
 *
 * The harness gives us a real unified diff in `structuredPatch`, so the +N/-M
 * counts are counted, never guessed; `oldString`/`newString` and `content` are
 * fallbacks for shapes that arrive without one.
 */
export function fileChangeFrom(
  result: any,
): { path: string; change: 'create' | 'edit'; added: number; removed: number; preview: string } | null {
  if (!result || typeof result !== 'object' || typeof result.filePath !== 'string') return null
  const path = result.filePath
  const hunks: any[] = Array.isArray(result.structuredPatch) ? result.structuredPatch : []
  let added = 0
  let removed = 0
  const previewLines: string[] = []

  for (const hunk of hunks) {
    const lines: string[] = Array.isArray(hunk?.lines) ? hunk.lines : []
    previewLines.push(`@@ -${hunk?.oldStart ?? 0},${hunk?.oldLines ?? 0} +${hunk?.newStart ?? 0},${hunk?.newLines ?? 0} @@`)
    for (const line of lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
      previewLines.push(line)
    }
  }

  if (added === 0 && removed === 0) {
    if (typeof result.newString === 'string') {
      added = result.newString ? result.newString.split('\n').length : 0
      const oldString = typeof result.oldString === 'string' ? result.oldString : ''
      removed = oldString ? oldString.split('\n').length : 0
      // Only when there was one: an edit result without `oldString` threw here,
      // and a throw in the transcript poller's timer takes the server down.
      if (oldString) previewLines.push(...oldString.split('\n').slice(0, 40).map((l: string) => `-${l}`))
      previewLines.push(...result.newString.split('\n').slice(0, 80).map((l: string) => `+${l}`))
    } else if (typeof result.content === 'string') {
      added = result.content ? result.content.split('\n').length : 0
      previewLines.push(...result.content.split('\n').slice(0, 120).map((l: string) => `+${l}`))
    }
  }

  const preview = previewLines.join('\n').slice(0, PREVIEW_LIMIT)
  return {
    path,
    change: result.type === 'create' ? 'create' : 'edit',
    added,
    removed,
    preview,
  }
}

/** Tools whose arguments describe the whole change they make to one file. */
const FILE_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit'])

const lineCount = (text: unknown): number => (typeof text === 'string' && text ? text.split('\n').length : 0)

/**
 * A file change reconstructed from the tool call itself.
 *
 * A subagent's sidechain transcript carries no `toolUseResult` — the structured
 * patch `fileChangeFrom` counts from only exists in the main transcript — so
 * nothing a subagent wrote ever became a card. Its `Write`/`Edit`/`MultiEdit`
 * arguments still say exactly what was replaced with what, which is enough for
 * honest line counts and a preview; the event says so with `source: 'input'`.
 * Whether a `Write` created or replaced the file is only known from its result
 * line, which is why that text is passed in.
 */
export function fileChangeFromInput(
  name: string,
  input: any,
  resultText: string,
): { path: string; change: 'create' | 'edit'; added: number; removed: number; preview: string } | null {
  if (!FILE_EDIT_TOOLS.has(name) || !input || typeof input.file_path !== 'string') return null
  const edits: Array<{ old_string?: unknown; new_string?: unknown }> =
    name === 'MultiEdit' ? (Array.isArray(input.edits) ? input.edits : []) : name === 'Edit' ? [input] : []
  const previewLines: string[] = []
  let added = 0
  let removed = 0
  if (name === 'Write') {
    added = lineCount(input.content)
    if (typeof input.content === 'string') previewLines.push(...input.content.split('\n').slice(0, 120).map((l: string) => `+${l}`))
  }
  for (const edit of edits) {
    added += lineCount(edit.new_string)
    removed += lineCount(edit.old_string)
    if (typeof edit.old_string === 'string' && edit.old_string) previewLines.push(...edit.old_string.split('\n').slice(0, 40).map((l) => `-${l}`))
    if (typeof edit.new_string === 'string' && edit.new_string) previewLines.push(...edit.new_string.split('\n').slice(0, 80).map((l) => `+${l}`))
  }
  const created = name === 'Write' && /\bcreated\b/i.test(resultText)
  return {
    path: input.file_path,
    change: created ? 'create' : 'edit',
    added,
    removed,
    preview: previewLines.join('\n').slice(0, PREVIEW_LIMIT),
  }
}

function mapToolStats(stats: any): ToolStatBreakdown | undefined {
  if (!stats || typeof stats !== 'object') return undefined
  return {
    read: Number(stats.readCount ?? 0),
    search: Number(stats.searchCount ?? 0),
    bash: Number(stats.bashCount ?? 0),
    edit: Number(stats.editFileCount ?? 0),
    other: Number(stats.otherToolCount ?? 0),
    linesAdded: Number(stats.linesAdded ?? 0),
    linesRemoved: Number(stats.linesRemoved ?? 0),
  }
}

interface TaskNotification {
  agentId: string
  toolId: string
  status: string
  durationMs: number
  toolUses: number
  result: string
  /** The one-line summary a background shell's notice carries. */
  summary: string
  /**
   * Every task the notice is about. Usually one; a resumed CLI reports every
   * agent the previous process left unfinished in one notice ("stopped").
   */
  agentIds: string[]
}

/**
 * The harness' own completion notice for a background agent.
 *
 * It arrives inside a record's text (a `queue-operation` when it fires, a
 * `user` record when the parent is handed it), never as a record of its own, so
 * it has to be read out of the text. The shape is the harness':
 *
 * ```
 * <task-notification>
 * <task-id>…</task-id><tool-use-id>…</tool-use-id><status>completed</status>
 * <result>…</result>
 * <usage><subagent_tokens>…</subagent_tokens><tool_uses>1</tool_uses><duration_ms>…</duration_ms></usage>
 * </task-notification>
 * ```
 */
function taskNotification(rec: any): TaskNotification | null {
  const text = recordText(rec)
  if (!text.includes('<task-notification>')) return null
  const field = (name: string): string =>
    new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim() ?? ''
  const agentId = field('task-id')
  const toolId = field('tool-use-id')
  if (!agentId && !toolId) return null
  const agentIds = [...text.matchAll(/<task-id>([\s\S]*?)<\/task-id>/g)].map((match) => match[1]!.trim()).filter(Boolean)
  return {
    agentIds,
    agentId,
    toolId,
    status: field('status'),
    durationMs: Number(field('duration_ms')) || 0,
    toolUses: Number(field('tool_uses')) || 0,
    result: field('result'),
    summary: field('summary'),
  }
}

/* ------------------------------------------------------------------ */
/* Local (slash) commands                                              */
/* ------------------------------------------------------------------ */

/**
 * A slash command the CLI ran by itself, as it writes it down.
 *
 * Claude Code handles `/status`, `/model`, `/mcp` and the rest locally: no model
 * turn happens, and what it records is two records in a row, tagged prose rather
 * than structure. The invocation:
 *
 * ```
 * {"type":"system","subtype":"local_command","content":
 *   "<command-name>/status</command-name>\n<command-message>status</command-message>\n<command-args>…</command-args>"}
 * ```
 *
 * and then, when the command printed anything, its output:
 *
 * ```
 * {"type":"system","subtype":"local_command","content":
 *   "<local-command-stdout>43 MCP server(s): 11 connected…</local-command-stdout>"}
 * ```
 *
 * Older CLIs (and the SDK entrypoint on some versions) write the same tags in a
 * `user` record with string content instead, which is why both are read here —
 * the CLI's own docs describe a slash invocation as "`user` entries whose
 * content contains `<command-name>`", and the shape in this machine's
 * transcripts (2.1.257+) is the `system` one. Both were unreadable: the system
 * pair printed the subtype's name, twice, and the user shape printed raw XML.
 *
 * `<local-command-stderr>` is the same thing for a command that failed; the CLI
 * pairs the two tags in one regex of its own.
 */
interface LocalCommand {
  name: string
  args: string
}

function tagOf(text: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text)
  return match ? (match[1] ?? '') : null
}

function localCommandCall(text: string): LocalCommand | null {
  const name = tagOf(text, 'command-name')
  if (name === null) return null
  const trimmed = name.trim()
  if (!trimmed) return null
  return { name: trimmed.startsWith('/') ? trimmed : `/${trimmed}`, args: (tagOf(text, 'command-args') ?? '').trim() }
}

/**
 * Escape sequences a terminal reads and a transcript pane does not.
 *
 * A local command prints for a TTY — the CLI's own compact notice arrives
 * wrapped in `ESC[2m … ESC[22m` — and those bytes are noise once the text is put
 * in a card. Only the escape is removed; every character it was dressing up is
 * kept exactly as it was.
 */
function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
}

function localCommandOutput(text: string): { text: string; isError: boolean } | null {
  const out = tagOf(text, 'local-command-stdout')
  if (out !== null) return { text: stripAnsi(out).trim(), isError: false }
  const err = tagOf(text, 'local-command-stderr')
  if (err !== null) return { text: stripAnsi(err).trim(), isError: true }
  return null
}

/** The prose of a record, wherever the harness put it this time. */
function recordText(rec: any): string {
  if (typeof rec?.content === 'string') return rec.content
  const content = rec?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block: any) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block: any) => String(block.text))
    .join('\n')
}

function mapSubagentStatus(status: unknown): SubagentStatus {
  switch (status) {
    case 'completed':
    case 'success':
      return 'done'
    case 'error':
    case 'failed':
      return 'error'
    case 'stopped':
    case 'killed':
      return 'stopped'
    // An agent that has just been launched is running, and the domain has a
    // word for that. A captured `Agent` call comes back `async_launched` — the
    // agent had not done anything yet, let alone finished — and this answered
    // "done" for it, so the one state that mattered was the one it could not
    // say. `provisional` kept the spinner alive despite the status rather than
    // because of it.
    case 'async_launched':
    case 'in_progress':
    case 'running':
      return 'running'
    default:
      return 'done'
  }
}

const SUBAGENT_TOOLS = new Set(['Task', 'Agent'])

/* ------------------------------------------------------------------ */
/* Byte-offset line tailer (handles split multi-byte sequences)        */
/* ------------------------------------------------------------------ */

class LineTailer {
  private offset = 0
  private lines = new LineSplitter()
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  /** Polls in a row that found nothing new (see `nextDelay`). */
  private idlePolls = 0

  constructor(
    private readonly transport: Transport,
    private readonly path: string,
    private readonly onLine: (line: string) => void,
    private readonly intervalMs = 120,
    /**
     * How far an idle file's polling may slow down. Equal to `intervalMs` means
     * never: the main transcript keeps its latency.
     */
    private readonly maxIntervalMs = intervalMs,
  ) {}

  start(): void {
    this.tick()
    if (this.inFlight) void this.inFlight.then(() => this.schedule())
    else this.schedule()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  private schedule(): void {
    if (this.stopped) return
    this.timer = setTimeout(() => {
      this.tick()
      // A remote poll still out is waited for, never overlapped: two in flight
      // would both read from the same offset and deliver the same lines twice.
      if (this.inFlight) void this.inFlight.then(() => this.schedule())
      else this.schedule()
    }, this.nextDelay())
  }

  /**
   * A finished subagent's transcript is still polled for as long as the session
   * lives, and on a host every poll is a synchronous ssh round trip on the event
   * loop — a session that had spawned a dozen agents spent most of its time
   * asking about files that would never change again. After a while of nothing
   * new the interval doubles up to the cap, and any growth resets it (an agent
   * that is resumed later is picked up within one capped interval).
   */
  private nextDelay(): number {
    if (this.maxIntervalMs <= this.intervalMs || this.idlePolls < IDLE_POLLS_BEFORE_BACKOFF) return this.intervalMs
    const doublings = Math.min(8, Math.floor((this.idlePolls - IDLE_POLLS_BEFORE_BACKOFF) / 4) + 1)
    return Math.min(this.maxIntervalMs, this.intervalMs * 2 ** doublings)
  }

  /**
   * One poll. Locally a read is a syscall and stays synchronous; on a host it is
   * an ssh round trip, which used to run synchronously on the event loop every
   * half second per transcript — so it is awaited there, and the next poll is
   * only scheduled once this one has answered (see `schedule`).
   */
  private tick(): void {
    if (this.stopped) return
    try {
      if (!this.transport.remote) {
        this.apply(this.transport.poll(this.path, this.offset, POLL_SLICE_BYTES), () =>
          this.transport.poll(this.path, 0, POLL_SLICE_BYTES),
        )
        return
      }
    } catch (error) {
      // This runs off a timer, where anything thrown ends the whole server.
      console.error('[claude] transcript poll failed:', error)
      return
    }
    this.inFlight = this.pollRemote()
      .catch((error) => console.error('[claude] transcript poll failed:', error))
      .finally(() => {
        this.inFlight = null
      })
  }

  private inFlight: Promise<void> | null = null

  private async pollRemote(): Promise<void> {
    const offset = this.offset
    let polled = await this.transport.pollAsync(this.path, offset, POLL_SLICE_BYTES)
    if (this.stopped || this.offset !== offset) return
    if (polled && polled.size < offset) polled = await this.transport.pollAsync(this.path, 0, POLL_SLICE_BYTES)
    if (this.stopped) return
    this.apply(polled, null)
  }

  /**
   * Act on one poll. `again` re-reads from zero after a truncation; the remote
   * path does that itself before calling, so it passes null.
   */
  private apply(first: PollResult | null, again: (() => PollResult | null) | null): void {
    let polled = first
    if (!polled) return
    if (polled.size < this.offset) {
      // The file was replaced (a reused session id starts a fresh transcript):
      // read it again from the beginning.
      this.offset = 0
      this.lines = new LineSplitter()
      if (again) polled = again()
      if (!polled) return
    }
    if (!polled.bytes.length) {
      this.offset = polled.size
      this.idlePolls += 1
      return
    }
    this.idlePolls = 0
    this.offset = polled.size
    for (const line of this.lines.push(polled.bytes)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        this.onLine(trimmed)
      } catch (error) {
        // One record this reader mishandles costs that record, not the rest of
        // the transcript (and not the server: this is a timer callback).
        console.error('[claude] could not handle a transcript record:', error)
      }
    }
  }
}

/**
 * The most one poll reads. A long transcript opened for the first time is read
 * in slices, one per tick, instead of as one read of everything.
 */
const POLL_SLICE_BYTES = 4 * 1024 * 1024

/** Roughly five seconds of an unchanged file, locally, before polling slows. */
const IDLE_POLLS_BEFORE_BACKOFF = 40

/* ------------------------------------------------------------------ */
/* Transcript reader                                                   */
/* ------------------------------------------------------------------ */

/**
 * What is known about one subagent, assembled from every source that says so.
 *
 * Three of them, and *not one is complete on its own* — which is why this is a
 * record that gets filled in rather than an event that gets published three
 * times:
 *
 *   `system/task_started` on the live stream  everything, atomically, at once
 *   the `Agent` tool_use block in the transcript  the prompt, but no agent id
 *   `subagents/agent-<id>.meta.json`             the agent id, but no prompt
 *
 * A real capture showed what publishing each of them separately does: both
 * transcript sources write under the same event id, so the store upserts and
 * the last one wins — and the winner was whichever the pollers happened to
 * reach first. Either the card ended up with `agentId: ""`, which is the field
 * attribution is keyed on, or it ended up with `prompt: ""`, which is the only
 * record of what the agent was actually asked to do.
 */
export interface SubagentMeta {
  agentId: string
  agentType: string
  description: string
  toolUseId: string
  depth: number
  prompt?: string
  /** The dated id the runtime resolved the agent onto, when it says. */
  model?: string
  /** The sidechain whose Task/Agent tool launched this child. */
  parentAgentId?: string
  /** Stable id of the Task/Agent tool event that launched this child. */
  parentEventId?: string
  /** The spawn call's own timestamp, from the transcript. */
  spawnedAt?: number
}

export interface TranscriptSink {
  event(
    ev: TimelineEvent,
    id: string,
    at: number,
    agentId?: string,
    causal?: { parentEventId?: string; parentAgentId?: string },
  ): void
  /**
   * `messageId` is the API's own id for the message this usage belongs to.
   * The same message is reported several times over — once per content block,
   * on the stream *and* in the transcript — and it is the only thing that tells
   * a re-report from a second message. See `ClaudeDriver.creditUsage`.
   */
  usage(usage: TokenUsage, at: number, messageId?: string): void
  title(title: string): void
  /** Returns true when the driver already echoed this user message. */
  claimUserEcho?(text: string): boolean
  /** Passing facts the transcript reveals: branch, approval mode. */
  meta?(meta: { gitBranch?: string | null; permissionMode?: string | null }): void
}

/**
 * Reads a Claude Code session transcript, plus the `subagents/` sidecars.
 *
 * The transcript is the authoritative source of committed timeline events: it
 * is the only place where a subagent's internal thinking/tool calls land, which
 * is exactly the visibility that stream-json does not provide.
 */
export class ClaudeTranscriptReader {
  private readonly transcriptPath: string
  private readonly subagentsDir: string
  private mainTailer: LineTailer | null = null
  private readonly tails = new Map<string, LineTailer>()
  private readonly metas = new Map<string, SubagentMeta>()
  private readonly toolIdByAgent = new Map<string, string>()
  private readonly agentIdByToolId = new Map<string, string>()
  /** The last card published per spawn call, so an unchanged one is not resent. */
  private readonly announced = new Map<string, string>()
  /** Agents whose completion already carried real metrics (see `onTaskNotification`). */
  private readonly completed = new Set<string>()
  /**
   * Recent tool calls by id — name, input and when they were made — for what
   * only their result can complete: a subagent's file change, a call's
   * duration, whether a background task was a shell. Bounded, oldest first.
   */
  private readonly toolCalls = new Map<string, { name: string; input: unknown; at: number }>()
  /** Background shell task ids (`bXXXX`) to the Bash call that started them. */
  private readonly backgroundShells = new Map<string, string>()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private subagentTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private startedTranscript = false
  private startedSubagents = false
  private metaSent = false
  /**
   * Every poll over SSH is a round trip, so remote sessions are checked far less
   * often than local ones. Locally a read is microseconds; over a network it is
   * tens of milliseconds of process and connection work.
   */
  private readonly lineInterval: number
  private readonly bootstrapInterval: number
  private readonly scanInterval: number
  /** The slowest an idle subagent transcript is polled (see `LineTailer`). */
  private readonly idleLineInterval: number

  constructor(
    private readonly transport: Transport,
    cwd: string,
    sessionId: string,
    private readonly sink: TranscriptSink,
    root: string = CLAUDE_HOME,
  ) {
    this.transcriptPath = claudeTranscriptPath(cwd, sessionId, root)
    this.subagentsDir = claudeSubagentsDir(cwd, sessionId, root)
    this.lineInterval = transport.remote ? 500 : 120
    this.bootstrapInterval = transport.remote ? 1200 : 250
    this.scanInterval = transport.remote ? 1200 : 300
    this.idleLineInterval = transport.remote ? 8000 : 2000
  }

  start(): void {
    this.bootstrap()
    this.pollTimer = setInterval(() => this.bootstrap(), this.bootstrapInterval)
  }

  stop(): void {
    this.stopped = true
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    if (this.subagentTimer) clearInterval(this.subagentTimer)
    this.subagentTimer = null
    this.mainTailer?.stop()
    for (const tail of this.tails.values()) tail.stop()
    this.tails.clear()
  }

  /**
   * Pick up the transcript and the subagent folder as soon as they appear.
   *
   * Off a timer, and over ssh `exists` throws when the host cannot be asked —
   * which, uncaught in a timer, is the whole server exiting. A host that blipped
   * is simply asked again on the next tick.
   */
  private bootstrap(): void {
    if (this.stopped) return
    if (this.transport.remote) {
      // Asked asynchronously on a host, one question at a time: an interval
      // tick that lands while the last answer is still on its way is skipped.
      if (this.bootstrapping) return
      this.bootstrapping = true
      void (async () => {
        const transcript = !this.startedTranscript && (await this.transport.existsAsync(this.transcriptPath))
        const subagents = !this.startedSubagents && (await this.transport.existsAsync(this.subagentsDir))
        if (!this.stopped) this.bootstrapWith(transcript, subagents)
      })()
        .catch((error) => console.error('[claude] transcript bootstrap failed:', error))
        .finally(() => {
          this.bootstrapping = false
        })
      return
    }
    try {
      this.bootstrapWith(
        !this.startedTranscript && this.transport.exists(this.transcriptPath),
        !this.startedSubagents && this.transport.exists(this.subagentsDir),
      )
    } catch (error) {
      console.error('[claude] transcript bootstrap failed:', error)
    }
  }

  private bootstrapping = false
  private scanning = false

  private bootstrapWith(transcriptExists: boolean, subagentsExist: boolean): void {
    if (!this.startedTranscript && transcriptExists) {
      this.startedTranscript = true
      this.mainTailer = new LineTailer(
        this.transport,
        this.transcriptPath,
        (line) => this.onMainLine(line),
        this.lineInterval,
      )
      this.mainTailer.start()
    }
    if (!this.startedSubagents && subagentsExist) {
      this.startedSubagents = true
      this.scanSubagents()
      this.subagentTimer = setInterval(() => this.scanSubagents(), this.scanInterval)
    }
    // Both found: from here the subagent timer does the scanning. This timer
    // used to keep scanning as well, which doubled every directory listing — a
    // synchronous ssh round trip each on a host.
    if (this.startedTranscript && this.startedSubagents && this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  /** Register newly written subagent transcripts. */
  private scanSubagents(): void {
    if (this.stopped) return
    if (this.transport.remote) {
      if (this.scanning) return
      this.scanning = true
      void this.scanSubagentsRemote()
        .catch((error) => console.error('[claude] subagent scan failed:', error))
        .finally(() => {
          this.scanning = false
        })
      return
    }
    try {
      this.scanSubagentsOnce()
    } catch (error) {
      // A timer callback, like `bootstrap`: `readMeta` over ssh throws when the
      // host cannot be asked.
      console.error('[claude] subagent scan failed:', error)
    }
  }

  /** The same scan on a host: one listing and the new meta files, awaited. */
  private async scanSubagentsRemote(): Promise<void> {
    let names: string[]
    try {
      names = (await this.transport.listDirAsync(this.subagentsDir)).map((item) => item.name)
    } catch {
      return
    }
    const metas = new Map<string, string | null>()
    for (const name of names) {
      if (!name.endsWith('.meta.json')) continue
      const agentId = name.slice('agent-'.length, -'.meta.json'.length)
      if (this.metas.has(agentId)) continue
      metas.set(agentId, await this.transport.readTextAsync(this.metaPath(agentId)))
      if (this.stopped) return
    }
    if (!this.stopped) this.registerSubagents(names, (agentId) => metas.get(agentId) ?? null)
  }

  private scanSubagentsOnce(): void {
    let names: string[]
    try {
      names = this.transport.listDir(this.subagentsDir).map((item) => item.name)
    } catch {
      return
    }
    this.registerSubagents(names, (agentId) => this.transport.readText(this.metaPath(agentId)))
  }

  private metaPath(agentId: string): string {
    return join(this.subagentsDir, `agent-${agentId}.meta.json`)
  }

  private registerSubagents(names: string[], metaText: (agentId: string) => string | null): void {
    for (const name of names) {
      if (name.endsWith('.meta.json')) {
        const agentId = name.slice('agent-'.length, -'.meta.json'.length)
        if (this.metas.has(agentId)) continue
        this.readMeta(agentId, metaText(agentId))
      } else if (name.endsWith('.jsonl')) {
        const agentId = name.slice('agent-'.length, -'.jsonl'.length)
        if (this.tails.has(agentId)) continue
        const tail = new LineTailer(
          this.transport,
          join(this.subagentsDir, name),
          (line) => this.onSubagentLine(agentId, line),
          this.lineInterval,
          this.idleLineInterval,
        )
        this.tails.set(agentId, tail)
        tail.start()
      }
    }
  }

  /**
   * Fill in a background agent's completion from its notification.
   *
   * The metrics are the harness' own (`<usage><tool_uses>` / `<duration_ms>`),
   * so the card stops saying "Wrapping Up" and shows what the agent actually
   * did. A notification can repeat — the same agent can be resumed and stop
   * again — but it must never overwrite a completion that already carried real
   * metrics.
   */
  private onTaskNotification(notice: TaskNotification, at: number): void {
    const shellCall = this.backgroundShells.get(notice.agentId) ?? (
      this.toolCalls.get(notice.toolId)?.name === 'Bash' ? notice.toolId : undefined
    )
    if (shellCall !== undefined || BACKGROUND_SHELL_SUMMARY.test(notice.summary)) {
      this.onBackgroundShell(notice, shellCall || notice.toolId, at)
      return
    }
    const toolId = notice.toolId || this.toolIdByAgent.get(notice.agentId) || ''
    const key = toolId || notice.agentId
    if (!key || this.completed.has(key)) return
    // The XML notification has no task_type. Claude sends it for background
    // Bash too, so require an Agent/Task spawn already identified by the
    // transcript, sidecar or live task_started frame before making a card.
    if (!this.metas.has(toolId) && !this.metas.has(notice.agentId)) return
    this.sink.event(
      {
        k: 'subagent_end',
        toolId,
        agentId: notice.agentId,
        status: mapSubagentStatus(notice.status),
        durationMs: notice.durationMs,
        toolUses: notice.toolUses,
        result: notice.result,
      },
      toolId ? `subagent_end:${toolId}` : `subagent_end:${notice.agentId}`,
      at,
      notice.agentId || undefined,
    )
  }

  /**
   * A background shell command finishing.
   *
   * The CLI announces it with the same `<task-notification>` a background agent
   * gets, and it used to either vanish (no agent card to fill in) or come out as
   * an anonymous "agent" ending. It is a shell: tagged `background: 'bash'`,
   * keyed by the Bash call that launched it so the UI can show "bg → done" on
   * that call, and with the exit status the summary line states. No `agentId`
   * on the event itself: nothing here is a sidechain or an actor.
   */
  private onBackgroundShell(notice: TaskNotification, toolId: string, at: number): void {
    const exit = /exit code (-?\d+)/i.exec(notice.summary)
    const exitCode = exit ? Number(exit[1]) : undefined
    const status = exitCode !== undefined && exitCode !== 0 ? 'error' : mapSubagentStatus(notice.status)
    this.sink.event(
      {
        k: 'subagent_end',
        toolId,
        agentId: notice.agentId,
        status,
        durationMs: notice.durationMs,
        toolUses: 0,
        result: notice.summary || notice.result,
        background: 'bash',
        ...(exitCode !== undefined ? { exitCode } : {}),
      },
      `subagent_end:${toolId || notice.agentId}`,
      at,
    )
  }

  /**
   * Render a slash command the CLI ran by itself, or say this is not one.
   *
   * Returns true when the record has been dealt with, which is what keeps it
   * away from the `system` branch below — that branch's fallback turns an
   * unknown subtype into title case, so `local_command` came out as the word
   * "Local command" and the invocation and its output both rendered as that one
   * phrase. A `/status` in this app produced exactly two of them (see the
   * shapes documented on `localCommandCall`).
   *
   * Three record shapes reach here, all of them observed in real transcripts:
   *
   *   1. the invocation, tagged: `<command-name>` (+ `<command-message>`,
   *      `<command-args>`), as `system`/`local_command` or, on older CLIs, a
   *      `user` record whose content is that same string;
   *   2. the invocation, untagged: a `system`/`local_command` whose content is
   *      just what the person typed (`"/status"`), which is what 2.1.261 writes;
   *   3. the output: `<local-command-stdout>` (or `<local-command-stderr>`).
   *
   * The invocation is the person's own message, so it goes through the same
   * echo claim as any other: the driver already showed it the moment it was
   * typed, and the transcript twin is dropped rather than printed twice.
   */
  private handleLocalCommand(rec: any, at: number, agentId: string | undefined): boolean {
    const tagged = typeof rec?.message?.content === 'string' ? rec.message.content : null
    const isLocal = rec?.type === 'system' && rec?.subtype === 'local_command'
    const text = isLocal
      ? typeof rec.content === 'string'
        ? rec.content
        : ''
      : rec?.type === 'user' && tagged !== null && tagged.includes('<command-name>')
        ? tagged
        : null
    if (text === null) return false

    const output = localCommandOutput(text)
    if (output) {
      // Nothing printed is nothing to show — but the record is still ours, and
      // letting it fall through is what printed "Local command" for a command
      // that said nothing at all.
      if (output.text) {
        this.sink.event(
          {
            k: 'system',
            subtype: output.isError ? 'local_command_error' : 'local_command',
            text: output.text,
          },
          `${rec.uuid}:local:out`,
          at,
          agentId,
        )
      }
      return true
    }

    const call = localCommandCall(text)
    // An untagged record is the invocation written raw; a tagged one has to be
    // put back together from its parts, which is the only way the arguments
    // survive at all.
    const typed = call ? [call.name, call.args].filter(Boolean).join(' ') : stripAnsi(text).trim()
    if (!typed) return true
    if (this.sink.claimUserEcho?.(typed)) return true
    this.sink.event({ k: 'user', text: typed }, `${rec.uuid}:local:call`, at, agentId)
    return true
  }

  private readMeta(agentId: string, text: string | null): void {
    if (text === null) return
    let parsed: any
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    this.noteSubagent({
      agentId,
      agentType: String(parsed.agentType ?? 'agent'),
      description: String(parsed.description ?? ''),
      toolUseId: String(parsed.toolUseId ?? ''),
      depth: Number(parsed.spawnDepth ?? 1),
    }, true)
  }

  /**
   * Record what one source knows about a subagent, and republish the whole of
   * it.
   *
   * Every source routes through here — the live `system/task_started` frame the
   * driver hands over, the `Agent` tool call in the transcript, and the sidecar
   * meta file — so there is exactly one publisher and the card can only ever
   * gain detail. A field that arrives empty never overwrites one that arrived
   * filled: the sources are partial, not contradictory, and a later blank is
   * always silence rather than news.
   */
  noteSubagent(patch: Partial<SubagentMeta> & { toolUseId: string }, fromSidecar = false): void {
    if (!patch.toolUseId) return
    // What is known about this call. The spawn tool is seen before Claude mints
    // an agent id, so the call is looked up by its own id first — otherwise the
    // prompt/type already learned from the spawn call would be discarded.
    const call = this.metas.get(patch.toolUseId)
    const agentId = patch.agentId || call?.agentId || this.agentIdByToolId.get(patch.toolUseId) || ''
    // What is known about the agent, from any of its runs. An agent that
    // stopped can be resumed (`SendMessage` to it): the CLI then starts a new
    // run under the *resuming* call's id. That run is a card of its own — its
    // prompt is the message, its time the resume, its turn the one that sent
    // it — and only what describes the agent itself carries over. Merging it
    // into the first run filed the resumed work under the turn that spawned the
    // agent, at the spawn's time, so the turn that resumed it never waited.
    const agent = agentId ? this.metas.get(agentId) : undefined
    const known = call ?? (agent && (!agent.toolUseId || agent.toolUseId === patch.toolUseId) ? agent : undefined)
    const merged: SubagentMeta = {
      agentId,
      agentType: patch.agentType || known?.agentType || agent?.agentType || 'agent',
      description: patch.description || known?.description || agent?.description || '',
      toolUseId: patch.toolUseId,
      depth: patch.depth ?? known?.depth ?? agent?.depth ?? 1,
      prompt: patch.prompt || known?.prompt || '',
      model: patch.model || known?.model || agent?.model,
      parentAgentId: patch.parentAgentId || known?.parentAgentId || agent?.parentAgentId,
      parentEventId: patch.parentEventId || known?.parentEventId,
      spawnedAt: patch.spawnedAt ?? known?.spawnedAt,
    }
    this.metas.set(merged.toolUseId, merged)
    if (merged.agentId) {
      this.agentIdByToolId.set(merged.toolUseId, merged.agentId)
      // The agent's current run. A sidecar meta file always names the *first*
      // spawn, so it never takes that over from a resume already seen.
      const current = this.toolIdByAgent.get(merged.agentId)
      if (!current || current === merged.toolUseId || !fromSidecar) {
        this.metas.set(merged.agentId, merged)
        this.toolIdByAgent.set(merged.agentId, merged.toolUseId)
      }
    }
    this.announceSubagent(merged)
  }

  /**
   * Publish the subagent card, as completely as it is currently known.
   *
   * Always under the same event id, which the store upserts: a republish fills
   * the card in rather than stacking a second one beside it. Republishing an
   * unchanged card would be noise, so it is skipped.
   */
  private announceSubagent(meta: SubagentMeta): void {
    // A spawn call alone does not yet identify an actor, while a sidecar meta
    // file alone has no prompt. Publishing either half creates the anonymous,
    // empty cards that cannot be meaningfully expanded. The live task_started
    // frame is complete immediately; restored transcripts publish as soon as
    // their two partial records have merged.
    if (!meta.toolUseId || !meta.agentId || !meta.prompt?.trim()) return
    const fingerprint = JSON.stringify(meta)
    if (this.announced.get(meta.toolUseId) === fingerprint) return
    this.announced.set(meta.toolUseId, fingerprint)
    this.sink.event(
      {
        k: 'subagent_start',
        toolId: meta.toolUseId,
        agentId: meta.agentId,
        agentType: meta.agentType,
        description: meta.description,
        prompt: meta.prompt ?? '',
        depth: meta.depth,
        ...(meta.model ? { model: meta.model } : {}),
        ...(meta.spawnedAt ? { spawnedAt: meta.spawnedAt } : {}),
      },
      `subagent_start:${meta.toolUseId}`,
      // The spawn call's time once the transcript has told us, so a card first
      // published from the live launch frame moves to where it was spawned.
      meta.spawnedAt ?? Date.now(),
      undefined,
      {
        parentEventId: meta.parentEventId,
        parentAgentId: meta.parentAgentId,
      },
    )
  }

  private rememberToolCall(id: string, name: string, input: unknown, at: number): void {
    if (!id) return
    this.toolCalls.delete(id)
    this.toolCalls.set(id, { name, input, at })
    if (this.toolCalls.size > TOOL_CALL_MEMORY) this.toolCalls.delete(this.toolCalls.keys().next().value as string)
  }

  private onMainLine(line: string): void {
    let rec: any
    try {
      rec = JSON.parse(line)
    } catch {
      return
    }
    this.handleRecord(rec, undefined)
  }

  private onSubagentLine(agentId: string, line: string): void {
    let rec: any
    try {
      rec = JSON.parse(line)
    } catch {
      return
    }
    this.handleRecord(rec, agentId)
  }

  private handleRecord(rec: any, agentId: string | undefined): void {
    const at = Date.parse(rec?.timestamp ?? '') || Date.now()
    const type = rec?.type

    if (rec?.isMeta === true) return
    // The summary a compaction writes as a `user` record ("This session is
    // being continued…") is the CLI talking to itself, not a prompt; the
    // compact_boundary record is what the timeline shows.
    if (rec?.isCompactSummary === true || rec?.isVisibleInTranscriptOnly === true) return

    // A *background* agent writes nothing about its own end: its sidechain just
    // stops, and the harness reports the finish to the parent in a
    // `<task-notification>`. Nobody read it, so the card of a background agent
    // stayed "running" for as long as the session lived — and a card that never
    // finishes is what kept a spinner and a verb on a turn that was long over.
    const notice = taskNotification(rec)
    if (notice) {
      if (notice.agentIds.length > 1) {
        // One notice about several tasks names no call; each is resolved by its id.
        for (const agentId of notice.agentIds) this.onTaskNotification({ ...notice, agentId, toolId: '' }, at)
      } else {
        this.onTaskNotification(notice, at)
      }
      return
    }

    // A slash command the CLI ran itself. Its records are prose with tags in it,
    // not structure, and they arrive as `system` (or, on older CLIs, `user`)
    // records — so this has to come before either of those branches claims them.
    if (this.handleLocalCommand(rec, at, agentId)) return

    if (!this.metaSent && (typeof rec?.gitBranch === 'string' || typeof rec?.permissionMode === 'string')) {
      this.metaSent = true
      this.sink.meta?.({
        gitBranch: typeof rec.gitBranch === 'string' ? rec.gitBranch : null,
        permissionMode: typeof rec.permissionMode === 'string' ? rec.permissionMode : null,
      })
    }

    if (type === 'assistant') {
      const message = rec.message ?? {}
      const usage = normalizeUsage(message.usage)
      if (usage && agentId === undefined) {
        this.sink.usage(usage, at, typeof message.id === 'string' ? message.id : undefined)
      }
      const content = Array.isArray(message.content) ? message.content : []
      content.forEach((block: any, index: number) => {
        if (!block || typeof block !== 'object') return
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          this.sink.event(
            // `<synthetic>` is the CLI's mark for a message it wrote itself, not
            // a model: the event says nothing rather than name one (see
            // `isPlaceholderModel`).
            { k: 'assistant', text: block.text, model: realModel(message.model) ?? undefined },
            `${rec.uuid}:text:${index}`,
            at,
            agentId,
          )
        } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim()) {
          this.sink.event({ k: 'thinking', text: block.thinking }, `${rec.uuid}:thinking:${index}`, at, agentId)
        } else if (
          block.type === 'redacted_thinking' ||
          (block.type === 'thinking' && typeof block.thinking === 'string' && !block.thinking.trim())
        ) {
          // Reasoning happened and is not shown: Claude Code writes the block
          // with its text withheld (only the signature), or redacted outright.
          // One marker per message, keyed by the API message id, so the several
          // records a message is written as cannot stack markers.
          const key = typeof message.id === 'string' ? message.id : rec.uuid
          this.sink.event({ k: 'thinking', text: '', hidden: true }, `thinking:hidden:${key}`, at, agentId)
        } else if (block.type === 'tool_use') {
          const name = String(block.name ?? 'tool')
          this.rememberToolCall(String(block.id ?? ''), name, block.input, at)
          this.sink.event(
            {
              k: 'tool',
              toolId: String(block.id ?? ''),
              name,
              input: block.input ?? {},
              summary: summarizeTool(name, block.input),
            },
            `tool:${block.id}`,
            at,
            agentId,
          )
          if (SUBAGENT_TOOLS.has(name)) {
            // The spawn call knows the prompt and nothing about the agent it
            // started: the id is minted afterwards. It contributes what it has.
            this.noteSubagent({
              toolUseId: String(block.id ?? ''),
              agentType: typeof block.input?.subagent_type === 'string' ? block.input.subagent_type : undefined,
              description: typeof block.input?.description === 'string' ? block.input.description : undefined,
              prompt: typeof block.input?.prompt === 'string' ? block.input.prompt : undefined,
              model: typeof block.input?.model === 'string' ? block.input.model : undefined,
              parentAgentId: agentId,
              parentEventId: `tool:${block.id}`,
              spawnedAt: at,
            })
          }
        }
      })
      return
    }

    if (type === 'user') {
      const message = rec.message ?? {}
      const content = Array.isArray(message.content) ? message.content : []
      const toolResults = content.filter((c: any) => c && c.type === 'tool_result')
      const result = rec.toolUseResult

      // A stopped agent resumed by a message (`SendMessage` → "Resuming agent
      // …"): a new run of that agent, under this call. The live `task_started`
      // says the same; this is what a re-read transcript has instead of it.
      if (result && typeof result === 'object' && typeof result.resumedAgentId === 'string' && result.resumedAgentId) {
        const toolId = String(toolResults[0]?.tool_use_id ?? '')
        const call = this.toolCalls.get(toolId)
        const input = (call?.input ?? {}) as Record<string, unknown>
        if (toolId) {
          this.noteSubagent({
            toolUseId: toolId,
            agentId: result.resumedAgentId,
            prompt: typeof input.message === 'string' ? input.message : typeof input.summary === 'string' ? input.summary : undefined,
            parentAgentId: agentId,
            parentEventId: `tool:${toolId}`,
            spawnedAt: call?.at ?? at,
          })
        }
      }

      // A subagent finished: the parent record carries the final metrics.
      if (result && typeof result === 'object' && result.agentId) {
        const subAgentId = String(result.agentId)
        // The spawn call's own result names the tool, which is what the later
        // notification for a background agent carries too: key both rows by it
        // and the completion fills this one in instead of sitting beside it.
        const toolId = String(toolResults[0]?.tool_use_id ?? '') || this.toolIdByAgent.get(subAgentId) || ''
        // The spawn's own result is where the agent id and the model the runtime
        // actually resolved first appear together. `subagent_start.model` read
        // `input.model`, which a real `Agent` call never sends, so the card
        // never named a model at all; `resolvedModel` is the CLI's own answer.
        if (toolId) {
          this.noteSubagent({
            toolUseId: toolId,
            agentId: subAgentId,
            description: typeof result.description === 'string' ? result.description : undefined,
            prompt: typeof result.prompt === 'string' ? result.prompt : undefined,
            model: typeof result.resolvedModel === 'string' ? result.resolvedModel : undefined,
          })
        }
        const body = textOf(result.content)
        const usage = normalizeUsage(result.usage)
        const toolUses = Number(result.totalToolUseCount ?? 0)
        const durationMs = Number(result.totalDurationMs ?? 0)
        // A background subagent reports `async_launched` first, and the harness
        // may write an empty row before the real metrics: both are provisional,
        // so the UI never claims a working subagent is done.
        const provisional =
          result.status === 'async_launched' ||
          (toolUses === 0 && durationMs === 0 && !usage && !body.text)
        this.sink.event(
          {
            k: 'subagent_end',
            toolId,
            agentId: subAgentId,
            status: mapSubagentStatus(result.status),
            durationMs,
            usage,
            toolUses,
            tools: mapToolStats(result.toolStats),
            result: body.text,
            provisional: provisional || undefined,
          },
          toolId ? `subagent_end:${toolId}` : `subagent_end:${subAgentId}`,
          at,
          // The row lives in the parent transcript but belongs to the subagent.
          subAgentId,
        )
        if (!provisional) this.completed.add(toolId || subAgentId)
        return
      }

      // A file the agent wrote or edited: emit a card with counted line deltas.
      // A sidechain has no result to count from, so its change is rebuilt from
      // the call's own arguments (see `fileChangeFromInput`).
      let fileChange = fileChangeFrom(result)
      let fromInput = false
      if (!fileChange && toolResults.length === 1 && toolResults[0].is_error !== true) {
        const call = this.toolCalls.get(String(toolResults[0].tool_use_id ?? ''))
        if (call) {
          fileChange = fileChangeFromInput(call.name, call.input, textOf(toolResults[0].content).text)
          fromInput = fileChange !== null
        }
      }
      if (fileChange) {
        const toolId = toolResults[0]?.tool_use_id ?? `${rec.uuid}`
        this.sink.event(
          {
            k: 'file_change',
            toolId: String(toolId),
            path: fileChange.path,
            change: fileChange.change,
            added: fileChange.added,
            removed: fileChange.removed,
            preview: fileChange.preview,
            ...(fromInput ? { source: 'input' as const } : {}),
          },
          `file_change:${toolId}`,
          at,
          agentId,
        )
      }

      for (const tr of toolResults) {
        const body = textOf(tr.content)
        const toolUseId = String(tr.tool_use_id ?? '')
        const call = this.toolCalls.get(toolUseId)
        const extras = toolResultExtras(call, tr.is_error === true, body.text, toolResults.length === 1 ? result : null, at)
        if (extras.backgroundTaskId) {
          this.backgroundShells.set(extras.backgroundTaskId, toolUseId)
          if (this.backgroundShells.size > TOOL_CALL_MEMORY) {
            this.backgroundShells.delete(this.backgroundShells.keys().next().value as string)
          }
        }
        this.sink.event(
          {
            k: 'tool_result',
            toolId: toolUseId,
            text: body.text,
            isError: tr.is_error === true,
            truncated: body.truncated,
            ...extras,
          },
          `tool_result:${tr.tool_use_id}`,
          at,
          agentId,
        )
      }

      if (agentId !== undefined) return // the subagent prompt is on the Agent tool call

      const texts = content.filter((c: any) => c && c.type === 'text' && typeof c.text === 'string' && c.text.trim())
      texts.forEach((block: any, index: number) => {
        if (this.sink.claimUserEcho?.(String(block.text))) return
        this.sink.event({ k: 'user', text: block.text }, `${rec.uuid}:user:${index}`, at)
      })
      return
    }

    if (type === 'summary' && typeof rec.summary === 'string' && rec.summary.trim()) {
      this.sink.title(rec.summary.trim())
      return
    }

    if (type === 'system' && typeof rec.subtype === 'string') {
      // A retry notice is reported live by the stream (`api_retry`, see the
      // driver), with the same attempt and delay; showing this copy too printed
      // every retry twice. A final API error has no retry attempt and stays.
      if (rec.subtype === 'api_error' && typeof rec.retryAttempt === 'number') return
      const described = describeSystem(rec)
      // A system record with nothing to say is the harness reporting its own
      // bookkeeping. Printing the subtype name ("stop_hook_summary") next to the
      // label that already says it is noise, not information.
      if (!described) return
      const { text, detail } = described
      this.sink.event(
        { k: 'system', subtype: rec.subtype, text, ...(detail ? { detail } : {}) },
        `${rec.uuid}:system:${rec.subtype}`,
        at,
        agentId,
      )
      return
    }
  }
}

/**
 * Turn Claude's internal `system` records into something a person can read, or
 * nothing at all. The shapes come from the transcripts this app already reads:
 * `stop_hook_summary` carries `hookCount` / `hookInfos` / `hookErrors` /
 * `hookAdditionalContext` / `preventedContinuation`, and every run of the
 * configured hooks produces one — so the routine "2 hooks ran, no errors" case
 * is dropped and only what changed the turn is reported.
 */
function describeSystem(rec: Record<string, any>): { text: string; detail?: Record<string, string | number | boolean> } | null {
  const subtype = String(rec.subtype)

  if (subtype === 'compact_boundary') {
    const meta = (rec.compactMetadata ?? {}) as Record<string, unknown>
    const detail = pickDetail({
      trigger: meta.trigger,
      preTokens: meta.preTokens,
      postTokens: meta.postTokens,
      durationMs: meta.durationMs,
    })
    const tokens =
      typeof meta.preTokens === 'number' && typeof meta.postTokens === 'number'
        ? ` · ${meta.preTokens.toLocaleString('en-US')} → ${meta.postTokens.toLocaleString('en-US')} tokens`
        : ''
    return { text: `Conversation compacted${meta.trigger ? ` (${meta.trigger})` : ''}${tokens}`, detail }
  }

  if (subtype === 'api_error') return apiErrorLine(rec.error, rec)

  if (subtype === 'stop_hook_summary') {
    const infos: Array<{ command?: string; durationMs?: number }> = Array.isArray(rec.hookInfos)
      ? rec.hookInfos
      : []
    const count = Number(rec.hookCount ?? infos.length) || 0
    const errors = Array.isArray(rec.hookErrors) ? rec.hookErrors : []
    const context = Array.isArray(rec.hookAdditionalContext) ? rec.hookAdditionalContext : []
    const totalMs = infos.reduce((sum, info) => sum + (Number(info.durationMs) || 0), 0)
    const parts: string[] = []
    if (count) parts.push(`${count} hook${count === 1 ? '' : 's'} ran${totalMs ? ` in ${totalMs}ms` : ''}`)
    if (rec.preventedContinuation) parts.push('a hook stopped the turn')
    if (errors.length) {
      const first = errors[0] as { command?: string; stderr?: string; error?: string } | string
      const detail = typeof first === 'string' ? first : (first.stderr ?? first.error ?? first.command ?? '')
      parts.push(`${errors.length} reported an error${detail ? `: ${String(detail).trim().slice(0, 160)}` : ''}`)
    }
    if (context.length) parts.push(`${context.length} added context for the model`)
    if (rec.stopReason) parts.push(String(rec.stopReason))
    if (!parts.length) return null
    return { text: parts.join(' · ') }
  }

  if (subtype === 'init') {
    const model = String(rec.model ?? '')
    const where = String(rec.cwd ?? '')
    return { text: [model, where, rec.permissionMode ? String(rec.permissionMode) : ''].filter(Boolean).join(' · ') }
  }

  // Anything else: name it in words rather than print the raw token — and keep
  // the record's own line when it has one ("content"), which is the detail.
  const named = subtype.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
  const content = typeof rec.content === 'string' ? rec.content.trim() : ''
  return { text: content && content !== named ? `${named}: ${content.slice(0, 300)}` : named }
}

/** Only the scalar values a UI can show; absent and empty ones are dropped. */
function pickDetail(values: Record<string, unknown>): Record<string, string | number | boolean> | undefined {
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    else if (typeof value === 'boolean') out[key] = value
    else if (typeof value === 'string' && value.trim()) out[key] = value.trim().slice(0, 300)
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * One line for an API failure or retry, from either shape the CLI writes: the
 * transcript's `api_error` (`error.status`, `error.message`/`formatted`,
 * `retryAttempt`, `maxRetries`, `retryInMs`) and the stream's `api_retry`
 * (`attempt`, `max_retries`, `retry_delay_ms`, `error_status`, `error`).
 */
export function apiErrorLine(
  error: unknown,
  rec: Record<string, any>,
): { text: string; detail?: Record<string, string | number | boolean> } {
  const err = (error && typeof error === 'object' ? error : {}) as Record<string, any>
  const status = typeof err.status === 'number' ? err.status : typeof rec.error_status === 'number' ? rec.error_status : undefined
  const message = String(err.formatted ?? err.message ?? (typeof error === 'string' ? error : '') ?? '').trim()
  const attempt = rec.retryAttempt ?? rec.attempt
  const maxRetries = rec.maxRetries ?? rec.max_retries
  const retryInMs = rec.retryInMs ?? rec.retry_delay_ms
  const detail = pickDetail({ status, message, attempt, maxRetries, retryInMs })
  const head = `API error${status !== undefined ? ` ${status}` : ''}${message ? `: ${message.slice(0, 200)}` : ''}`
  const retry =
    typeof attempt === 'number'
      ? ` · retry ${attempt}${typeof maxRetries === 'number' ? `/${maxRetries}` : ''}${
          typeof retryInMs === 'number' ? ` in ${(retryInMs / 1000).toFixed(1)}s` : ''
        }`
      : ''
  return { text: head + retry, detail }
}

/** How many recent tool calls are remembered for their results. */
const TOOL_CALL_MEMORY = 500

/** A background shell's notice summary: `Background command "…" completed (exit code 0)`. */
const BACKGROUND_SHELL_SUMMARY = /^Background command\b/i

/**
 * What a tool result can say beyond its text: how long the call took (the
 * transcript times both ends), and for a shell its exit status, whether it was
 * cut short, and the task id it moved to the background under. Claude's Bash
 * result carries no exit code of its own on success; a failure's text starts
 * with `Exit code N`, which is the only place the number exists.
 */
function toolResultExtras(
  call: { name: string; at: number } | undefined,
  isError: boolean,
  text: string,
  result: any,
  at: number,
): { exitCode?: number; durationMs?: number; interrupted?: boolean; backgroundTaskId?: string } {
  const out: { exitCode?: number; durationMs?: number; interrupted?: boolean; backgroundTaskId?: string } = {}
  if (call && at >= call.at) out.durationMs = at - call.at
  if (call?.name !== 'Bash') return out
  const exit = isError ? /^Exit code (-?\d+)/.exec(text.trim()) : null
  if (exit) out.exitCode = Number(exit[1])
  if (result && typeof result === 'object') {
    if (result.interrupted === true) out.interrupted = true
    if (typeof result.backgroundTaskId === 'string' && result.backgroundTaskId) out.backgroundTaskId = result.backgroundTaskId
  }
  return out
}

export { INSPECT_TOOLS, SEARCH_TOOLS, BASH_TOOLS }
