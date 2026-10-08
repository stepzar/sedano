/**
 * The demo's server, running in the page.
 *
 * It speaks the real wire protocol (`packages/shared/src/wire.ts`) to the real
 * store, so every screen of the app works unchanged: sessions, turns, the
 * prompt queue, questions and permissions, terminals, shared tabs. What it does
 * not have is a machine — the turns are scripts (`scripts.ts`) played back
 * with realistic timing, and the files, harnesses and limits are invented
 * (`data.ts`). Nothing is persisted: a reload starts the same tour again.
 */
import type {
  AckError,
  AttachmentRef,
  ClientMsg,
  HarnessId,
  HostStatus,
  LimitSnapshot,
  MachineColorId,
  OpenTab,
  PermissionMode,
  RequestOption,
  ServerMsg,
  SessionEvent,
  SessionMetrics,
  SessionSummary,
  TimelineEvent,
  TokenUsage,
  TurnRecord,
  VoiceStatus,
} from '@shared'
import { applyTabOp, asMachineColorId, asTabOp, emptyMetrics } from '@shared'
import {
  ACME_API,
  ACME_WEB,
  capabilities,
  contextWindowFor,
  defaultModel,
  homeFor,
  limits,
  projects,
  voiceStatus,
} from './data.ts'
import {
  SEED_CSV,
  SEED_EXPLAIN,
  SEED_FLAKY,
  SEED_RATE_LIMIT,
  SEED_RUNBOOK,
  SEED_THEME,
  permissionMoment,
  questionMoment,
  scriptFor,
  type Moment,
  type SeedTurn,
  type Step,
} from './scripts.ts'
import { DemoShell } from './terminal.ts'

export interface DemoClient {
  send(msg: ServerMsg): void
  subscribed: Set<string>
}

interface Queued {
  promptId: string
  turnId: string
  text: string
  attachments?: AttachmentRef[]
}

interface Run {
  turnId: string
  cancelled: boolean
  /** Questions waiting on the visitor, by request id. */
  waiting: Map<string, { options: RequestOption[]; resolve: (optionId: string) => void; reject: () => void }>
  startedAt: number
  firstTokenAt: number | null
  outputTokens: number
  replyEventId: string | null
  lastReply: string
  activeAgents: number
}

interface Entry {
  summary: SessionSummary
  events: SessionEvent[]
  turns: Map<string, TurnRecord>
  queue: Queued[]
  run: Run | null
  shell: DemoShell | null
  /** Metrics are published at most this often while streaming. */
  lastMetricsAt: number
}

/** Thrown out of a script when the turn is interrupted or stopped. */
class Cancelled extends Error {}

/** How a script is being played: live to the visitor, or instantly into the seeded history. */
interface Play {
  entry: Entry
  run: Run
  live: boolean
  /** Virtual time for the seeded history; unused when live. */
  clock: { at: number }
  answers?: Record<string, string>
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const jitter = (min: number, max: number) => min + Math.random() * (max - min)

const ACP: ReadonlySet<HarnessId> = new Set(['codex', 'gemini', 'opencode', 'grok'])

function approxTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4))
}

function relative(cwd: string, path: string): string {
  return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
}

export class DemoServer {
  private clients = new Set<DemoClient>()
  private sessions = new Map<string, Entry>()
  private tabs: OpenTab[] = []
  private seq = 0
  private machineColors: Record<string, MachineColorId> = {}
  private enabledHosts = new Set<string>()
  private reached = new Map<string, HostStatus>()
  private hiddenHarnesses = new Set<string>()
  private voice: VoiceStatus = voiceStatus()
  private readers = { claude: true, commandcode: true }
  /** Archived sessions, kept whole so Import Sessions can bring them back. */
  private archived = new Map<string, Entry>()
  /** Commands already answered, so a replayed command is answered the same way. */
  private acks = new Map<string, Omit<Extract<ServerMsg, { t: 'ack' }>, 't' | 'cid'>>()
  readonly ready: Promise<void>

  constructor() {
    this.ready = this.seed()
  }

  /* ---------------------------------------------------------------- */
  /* Connections                                                       */
  /* ---------------------------------------------------------------- */

  connect(client: DemoClient): void {
    this.clients.add(client)
    client.send({
      t: 'hello',
      sessions: this.listSessions(),
      limits: this.limits(),
      projects: projects(Date.now()),
      machineColors: { ...this.machineColors },
      tabs: this.tabs,
    })
  }

  disconnect(client: DemoClient): void {
    this.clients.delete(client)
  }

  private broadcast(msg: ServerMsg): void {
    for (const client of this.clients) client.send(msg)
  }

  private toSubscribers(sessionId: string, msg: ServerMsg): void {
    for (const client of this.clients) if (client.subscribed.has(sessionId)) client.send(msg)
  }

  private limits(): LimitSnapshot[] {
    return limits(Date.now(), this.readers)
  }

  listSessions(): SessionSummary[] {
    return [...this.sessions.values()].map((entry) => entry.summary)
  }

  /* ---------------------------------------------------------------- */
  /* HTTP-side state (see http.ts)                                     */
  /* ---------------------------------------------------------------- */

  caps(host: string | null) {
    return capabilities(host, {
      enabledHosts: this.enabledHosts,
      reached: this.reached,
      hidden: this.hiddenHarnesses,
      voice: this.voice,
    })
  }

  setHost(host: string, enabled: boolean): void {
    if (enabled) this.enabledHosts.add(host)
    else this.enabledHosts.delete(host)
    this.broadcast({ t: 'caps', caps: this.caps(null) })
  }

  checkHost(host: string): HostStatus {
    const status: HostStatus = {
      host,
      enabled: this.enabledHosts.has(host),
      reach: 'ok',
      detail: 'Pretend-reachable: the demo has no network, so every host answers.',
      checkedAt: Date.now(),
    }
    this.reached.set(host, status)
    return status
  }

  setVoice(configured: VoiceStatus['configured']): VoiceStatus {
    this.voice = voiceStatus(configured)
    this.broadcast({ t: 'caps', caps: this.caps(null) })
    return this.voice
  }

  usageReaders() {
    return this.readers
  }

  setUsageReader(id: string, on: boolean): void {
    if (id !== 'claude' && id !== 'commandcode') throw new Error(`no account reader called ${id}`)
    this.readers = { ...this.readers, [id]: on }
    this.broadcast({ t: 'limits', limits: this.limits() })
  }

  archive(sessionId: string): boolean {
    const entry = this.sessions.get(sessionId)
    if (!entry) return false
    if (entry.run) this.stop(entry)
    this.sessions.delete(sessionId)
    this.archived.set(sessionId, entry)
    this.applyTabs({ op: 'close', id: sessionId })
    this.broadcast({ t: 'session_removed', id: sessionId })
    return true
  }

  unarchive(sessionId: string): SessionSummary | null {
    const entry = this.archived.get(sessionId)
    if (!entry) return null
    this.archived.delete(sessionId)
    this.sessions.set(sessionId, entry)
    this.broadcast({ t: 'session', session: entry.summary })
    return entry.summary
  }

  importScan(cwd: string) {
    const now = Date.now()
    const archived = [...this.archived.values()]
      .filter((entry) => entry.summary.cwd === cwd)
      .map((entry) => ({
        harness: entry.summary.harness,
        source: 'archived' as const,
        sessionId: entry.summary.id,
        nativeId: entry.summary.nativeId,
        title: entry.summary.title,
        updatedAt: entry.summary.updatedAt,
      }))
    const native = cwd === ACME_API
      ? [
          { harness: 'claude' as const, nativeId: 'b81f02c4-demo-native-1', title: 'Investigate slow /api/users query', updatedAt: now - 6 * 86_400_000 },
          { harness: 'codex' as const, nativeId: 'thr_demo_native_2', title: 'Bump bun and fix the lockfile', updatedAt: now - 11 * 86_400_000 },
          { harness: 'gemini' as const, nativeId: 'gem-demo-native-3', title: 'Summarise last week’s incidents', updatedAt: now - 15 * 86_400_000 },
        ].filter((item) => !this.listSessions().some((session) => session.nativeId === item.nativeId))
      : []
    return {
      cwd,
      host: null,
      sessions: [...archived, ...native.map((item) => ({ ...item, source: 'native' as const }))].sort((a, b) => b.updatedAt - a.updatedAt),
      errors: [],
      notes: ['This is the demo: the conversations listed here are invented.'],
    }
  }

  async importNative(harness: HarnessId, nativeId: string, cwd: string): Promise<SessionSummary> {
    const titles: Record<string, string> = {
      'b81f02c4-demo-native-1': 'Investigate slow /api/users query',
      thr_demo_native_2: 'Bump bun and fix the lockfile',
      'gem-demo-native-3': 'Summarise last week’s incidents',
    }
    const title = titles[nativeId] ?? 'Imported conversation'
    const entry = this.createEntry({ harness, cwd, title, nativeId, updatedAt: Date.now() })
    await this.seedTurns(entry, [{ prompt: title, steps: scriptFor('explain') }], Date.now() - 6 * 86_400_000)
    this.broadcast({ t: 'session', session: entry.summary })
    return entry.summary
  }

  /* ---------------------------------------------------------------- */
  /* The socket                                                        */
  /* ---------------------------------------------------------------- */

  async receive(client: DemoClient, msg: ClientMsg): Promise<void> {
    const cid = 'cid' in msg ? msg.cid : undefined
    if (cid && this.acks.has(cid)) {
      client.send({ t: 'ack', cid, ...this.acks.get(cid)! })
      return
    }
    let outcome: Omit<Extract<ServerMsg, { t: 'ack' }>, 't' | 'cid'> | undefined
    try {
      outcome = await this.run(client, msg)
    } catch (error) {
      outcome = { ok: false, error: 'failed', detail: error instanceof Error ? error.message : String(error) }
    }
    if (cid && outcome) {
      this.acks.set(cid, outcome)
      client.send({ t: 'ack', cid, ...outcome })
    }
  }

  private async run(client: DemoClient, msg: ClientMsg): Promise<Omit<Extract<ServerMsg, { t: 'ack' }>, 't' | 'cid'> | undefined> {
    const fail = (error: AckError, detail: string) => ({ ok: false, error, detail })
    const gone = () => fail('gone', 'that session no longer exists')
    switch (msg.t) {
      case 'subscribe': {
        client.subscribed.add(msg.sessionId)
        const entry = this.sessions.get(msg.sessionId)
        if (!entry) return
        client.send({
          t: 'timeline',
          sessionId: entry.summary.id,
          events: entry.events,
          cursor: entry.events.at(-1)?.seq ?? 0,
          turns: [...entry.turns.values()],
        })
        client.send({ t: 'session', session: entry.summary })
        return
      }
      case 'unsubscribe': {
        client.subscribed.delete(msg.sessionId)
        return
      }
      case 'new_session': {
        const { req } = msg
        const terminal = req.kind === 'terminal'
        const entry = this.createEntry({
          id: req.id,
          harness: terminal ? 'shell' : req.harness,
          kind: terminal ? 'terminal' : 'agent',
          cwd: req.cwd || homeFor(req.host ?? null),
          host: req.host ?? null,
          model: terminal ? null : (req.model ?? defaultModel(req.harness)),
          effort: req.effort ?? null,
          permissionMode: req.permissionMode ?? 'default',
          preset: req.preset ?? null,
          parentSessionId: req.parentSessionId ?? null,
          title: terminal ? terminalTitle(req.preset ?? '', req.cwd || homeFor(req.host ?? null), req.host ?? null) : titleOf(req.prompt),
          status: terminal ? 'running' : 'idle',
          started: false,
        })
        if (terminal) entry.shell = new DemoShell(entry.summary.cwd, entry.summary.host, req.preset ?? '')
        client.subscribed.add(entry.summary.id)
        client.send({ t: 'timeline', sessionId: entry.summary.id, events: [], cursor: 0, turns: [] })
        this.broadcast({ t: 'session', session: entry.summary })
        if (req.prompt || req.attachments?.length) {
          const promptId = `prompt:${msg.cid ?? crypto.randomUUID()}`
          const turnId = this.deliver(entry, req.prompt ?? '', req.attachments, promptId)
          return { ok: true, sessionId: entry.summary.id, promptId, turnId }
        }
        return { ok: true, sessionId: entry.summary.id }
      }
      case 'input': {
        const entry = this.sessions.get(msg.sessionId)
        if (!entry) return gone()
        const promptId = `prompt:${msg.cid ?? crypto.randomUUID()}`
        if (entry.run || entry.queue.length) {
          const turnId = this.enqueue(entry, msg.text, msg.attachments, promptId)
          return { ok: true, sessionId: entry.summary.id, promptId, turnId }
        }
        const turnId = this.deliver(entry, msg.text, msg.attachments, promptId)
        return { ok: true, sessionId: entry.summary.id, promptId, turnId }
      }
      case 'cancel_prompt': {
        const entry = this.sessions.get(msg.sessionId)
        if (!entry) return gone()
        const index = entry.queue.findIndex((queued) => queued.promptId === msg.promptId)
        if (index < 0) return fail('not_pending', 'that prompt is no longer queued')
        const [queued] = entry.queue.splice(index, 1)
        this.rewritePrompt(entry, queued!, 'cancelled', { cancelledBy: 'user', cancelReason: 'cancelled by user' })
        this.publishSession(entry)
        return { ok: true, sessionId: entry.summary.id, promptId: msg.promptId }
      }
      case 'interrupt': {
        const entry = this.sessions.get(msg.sessionId)
        if (!entry) return gone()
        this.interrupt(entry)
        return { ok: true, sessionId: entry.summary.id }
      }
      case 'stop': {
        const entry = this.sessions.get(msg.sessionId)
        if (!entry) return gone()
        this.stop(entry)
        return { ok: true, sessionId: entry.summary.id }
      }
      case 'answer_question': {
        const entry = this.sessions.get(msg.sessionId)
        if (!entry) return gone()
        const waiting = entry.run?.waiting.get(msg.toolId)
        if (!waiting) return fail('not_pending', 'that question is not waiting for an answer')
        if (!waiting.options.some((option) => option.id === msg.optionId)) {
          return fail('failed', 'that option was not offered by the agent')
        }
        entry.run!.waiting.delete(msg.toolId)
        // Answered after the ack, the way a real driver takes it.
        setTimeout(() => waiting.resolve(msg.optionId), 0)
        return { ok: true, sessionId: entry.summary.id }
      }
      case 'rename_session': {
        const entry = this.sessions.get(msg.sessionId)
        if (!entry) return gone()
        entry.summary = { ...entry.summary, title: msg.title.trim().slice(0, 200) || entry.summary.title, titleSource: 'user' }
        this.publishSession(entry)
        return { ok: true, sessionId: entry.summary.id }
      }
      case 'pin_session': {
        const entry = this.sessions.get(msg.sessionId)
        if (!entry) return gone()
        entry.summary = { ...entry.summary, pinned: msg.pinned }
        this.publishSession(entry)
        return { ok: true, sessionId: entry.summary.id }
      }
      case 'set_session_parent': {
        const entry = this.sessions.get(msg.sessionId)
        if (!entry) return gone()
        entry.summary = { ...entry.summary, parentSessionId: msg.parentSessionId }
        this.publishSession(entry)
        return { ok: true, sessionId: entry.summary.id }
      }
      case 'set_session_options': {
        const entry = this.sessions.get(msg.sessionId)
        if (!entry) return gone()
        if (entry.run) {
          return fail('busy', 'stop the running turn before changing model, effort or approvals — the change needs a fresh process')
        }
        const patch: Partial<SessionSummary> = {}
        if (msg.model !== undefined) patch.model = msg.model
        if (msg.effort !== undefined) patch.effort = msg.effort
        if (msg.permissionMode !== undefined) patch.permissionMode = msg.permissionMode as PermissionMode
        entry.summary = { ...entry.summary, ...patch }
        if (patch.model !== undefined) {
          entry.summary.metrics = { ...entry.summary.metrics, contextWindow: contextWindowFor(entry.summary.model) }
        }
        this.publishSession(entry)
        return { ok: true, sessionId: entry.summary.id }
      }
      case 'delete_session': {
        const entry = this.sessions.get(msg.sessionId)
        if (entry) {
          if (entry.run) this.stop(entry)
          this.sessions.delete(msg.sessionId)
          this.broadcast({ t: 'session_removed', id: msg.sessionId })
          this.applyTabs({ op: 'close', id: msg.sessionId })
          // A docked terminal goes with the agent it belongs to.
          for (const child of [...this.sessions.values()]) {
            if (child.summary.parentSessionId === msg.sessionId) {
              this.sessions.delete(child.summary.id)
              this.broadcast({ t: 'session_removed', id: child.summary.id })
            }
          }
        }
        return { ok: true, sessionId: msg.sessionId }
      }
      case 'refresh_limits': {
        this.broadcast({ t: 'limits', limits: this.limits() })
        if (msg.force) client.send({ t: 'toast', level: 'success', text: 'Limits refreshed: claude, codex, commandcode' })
        return
      }
      case 'list_projects': {
        client.send({ t: 'projects', projects: projects(Date.now()) })
        return
      }
      case 'list_caps': {
        // A beat of latency, as a real scan has: the pickers show their loading state.
        await sleep(120)
        client.send({ t: 'caps', caps: this.caps(msg.host ?? null) })
        return
      }
      case 'set_harness_enabled': {
        const key = `${msg.host ?? ''}:${msg.harness}`
        if (msg.enabled) this.hiddenHarnesses.delete(key)
        else this.hiddenHarnesses.add(key)
        this.broadcast({ t: 'caps', caps: this.caps(msg.host ?? null) })
        return { ok: true }
      }
      case 'set_machine_color': {
        const key = msg.host ?? ''
        const color = msg.color === null ? null : asMachineColorId(msg.color)
        if (msg.color && !color) return fail('rejected', `"${msg.color}" is not a machine colour`)
        if (color) this.machineColors = { ...this.machineColors, [key]: color }
        else {
          const { [key]: _removed, ...rest } = this.machineColors
          this.machineColors = rest
        }
        this.broadcast({ t: 'machine_colors', colors: { ...this.machineColors } })
        return { ok: true }
      }
      case 'tabs': {
        const op = asTabOp(msg.op)
        if (!op) return fail('rejected', 'that is not a tab change')
        this.applyTabs(op, msg.cid)
        return { ok: true }
      }
      case 'term_input': {
        const entry = this.sessions.get(msg.sessionId)
        if (!entry?.shell) return
        if (!entry.summary.started) {
          entry.summary = { ...entry.summary, started: true }
          this.publishSession(entry)
        }
        entry.shell.input(msg.data, (data, offset) => this.toSubscribers(entry.summary.id, { t: 'term', sessionId: entry.summary.id, data, offset }))
        return
      }
      case 'term_resize': {
        this.sessions.get(msg.sessionId)?.shell?.resize(msg.cols, msg.rows)
        return
      }
      case 'term_snapshot': {
        const shell = this.sessions.get(msg.sessionId)?.shell
        if (!shell) return
        client.send({ t: 'term', sessionId: msg.sessionId, data: shell.screen(), snapshot: true, offset: shell.offset })
        return
      }
    }
  }

  private applyTabs(op: Parameters<typeof applyTabOp>[1], cid?: string): void {
    this.tabs = applyTabOp(this.tabs, op)
    this.broadcast(cid ? { t: 'tabs', tabs: this.tabs, cid } : { t: 'tabs', tabs: this.tabs })
  }

  /* ---------------------------------------------------------------- */
  /* Sessions and events                                               */
  /* ---------------------------------------------------------------- */

  private createEntry(patch: Partial<SessionSummary> & { harness: HarnessId; cwd: string }): Entry {
    const now = Date.now()
    const id = patch.id ?? crypto.randomUUID()
    const model = patch.model === undefined ? defaultModel(patch.harness) : patch.model
    const summary: SessionSummary = {
      id,
      kind: 'agent',
      title: 'New session',
      preset: null,
      host: null,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      nativeId: null,
      transcriptPath: null,
      resumeHint: null,
      permissionMode: 'default',
      effort: null,
      gitBranch: 'main',
      pinned: false,
      started: true,
      queuedPrompts: 0,
      ...patch,
      model,
      metrics: { ...metricsFor(patch.harness, model), ...(patch.metrics ?? {}) },
    }
    if (summary.kind === 'agent' && !summary.nativeId) summary.nativeId = nativeIdFor(summary.harness, id)
    if (summary.kind === 'agent' && !summary.resumeHint) summary.resumeHint = resumeHintFor(summary.harness, summary.nativeId!)
    const entry: Entry = { summary, events: [], turns: new Map(), queue: [], run: null, shell: null, lastMetricsAt: 0 }
    this.sessions.set(id, entry)
    return entry
  }

  private publishSession(entry: Entry): void {
    entry.summary = { ...entry.summary, updatedAt: Date.now(), queuedPrompts: entry.queue.length }
    this.broadcast({ t: 'session', session: entry.summary })
  }

  /** Append an event, or rewrite one in place (same id keeps its place and turn). */
  private emit(
    entry: Entry,
    ev: TimelineEvent,
    opts: { id?: string; agentId?: string; turnId?: string; at?: number; live?: boolean } = {},
  ): SessionEvent {
    const id = opts.id ?? `demo:${++this.seq}`
    const index = entry.events.findIndex((event) => event.id === id)
    const previous = index >= 0 ? entry.events[index] : undefined
    const event: SessionEvent = {
      id,
      sessionId: entry.summary.id,
      seq: previous?.seq ?? ++this.seq,
      at: previous?.at ?? opts.at ?? Date.now(),
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      turnId: previous?.turnId ?? opts.turnId,
      ev,
    }
    if (previous) entry.events[index] = event
    else entry.events.push(event)
    if (opts.live !== false) this.toSubscribers(entry.summary.id, { t: 'event', sessionId: entry.summary.id, event })
    return event
  }

  private publishTurn(entry: Entry, turn: TurnRecord, live = true): void {
    entry.turns.set(turn.id, turn)
    if (live) this.toSubscribers(entry.summary.id, { t: 'turn', sessionId: entry.summary.id, turn })
  }

  private publishMetrics(entry: Entry, force = false): void {
    const now = Date.now()
    if (!force && now - entry.lastMetricsAt < 250) return
    entry.lastMetricsAt = now
    this.toSubscribers(entry.summary.id, { t: 'metrics', sessionId: entry.summary.id, metrics: entry.summary.metrics })
  }

  /* ---------------------------------------------------------------- */
  /* Turns                                                             */
  /* ---------------------------------------------------------------- */

  private enqueue(entry: Entry, text: string, attachments: AttachmentRef[] | undefined, promptId: string): string {
    const turnId = crypto.randomUUID()
    const queued: Queued = { promptId, turnId, text, attachments }
    entry.queue.push(queued)
    this.emit(entry, { k: 'user', text, ...(attachments?.length ? { attachments } : {}), promptId, delivery: 'queued' }, { id: promptId, turnId })
    this.publishSession(entry)
    return turnId
  }

  private rewritePrompt(
    entry: Entry,
    queued: Queued,
    delivery: 'starting' | 'delivered' | 'cancelled',
    extra: { cancelledBy?: 'user' | 'server'; cancelReason?: string } = {},
  ): void {
    this.emit(
      entry,
      { k: 'user', text: queued.text, ...(queued.attachments?.length ? { attachments: queued.attachments } : {}), promptId: queued.promptId, delivery, ...extra },
      { id: queued.promptId, turnId: queued.turnId },
    )
  }

  /** Start a turn now; returns its id. */
  private deliver(
    entry: Entry,
    text: string,
    attachments: AttachmentRef[] | undefined,
    promptId: string,
    turnId: string = crypto.randomUUID(),
    steps: Step[] = scriptFor(text),
  ): string {
    const queued: Queued = { promptId, turnId, text, attachments }
    const startedAt = Date.now()
    const run: Run = {
      turnId,
      cancelled: false,
      waiting: new Map(),
      startedAt,
      firstTokenAt: null,
      outputTokens: 0,
      replyEventId: null,
      lastReply: '',
      activeAgents: 0,
    }
    entry.run = run
    this.rewritePrompt(entry, queued, 'starting')
    this.publishTurn(entry, turnRecord(entry.summary.id, turnId, promptId, startedAt))
    const first = !entry.summary.started
    entry.summary = {
      ...entry.summary,
      status: 'running',
      started: true,
      title: first && entry.summary.titleSource !== 'user' ? titleOf(text) : entry.summary.title,
      metrics: { ...entry.summary.metrics, turnActive: true, tps: 0 },
    }
    this.publishSession(entry)
    void (async () => {
      await sleep(jitter(220, 380))
      if (run.cancelled) return
      this.rewritePrompt(entry, queued, 'delivered')
      const play: Play = { entry, run, live: true, clock: { at: startedAt } }
      try {
        await this.play(play, steps)
        this.finish(entry, run, 'completed')
      } catch (error) {
        if (!(error instanceof Cancelled)) {
          this.emit(entry, { k: 'error', text: error instanceof Error ? error.message : String(error) }, { turnId })
          this.finish(entry, run, 'failed')
        }
      }
    })()
    return turnId
  }

  private finish(entry: Entry, run: Run, outcome: 'completed' | 'interrupted' | 'failed', status: 'idle' | 'stopped' = 'idle'): void {
    if (entry.run !== run) return
    entry.run = null
    const endedAt = Date.now()
    const usage = usageOf(run.outputTokens)
    const costReported = entry.summary.harness === 'claude'
    const costUsd = costReported ? +(run.outputTokens * 0.000075 + 0.012).toFixed(4) : 0
    const result = this.emit(
      entry,
      {
        k: 'result',
        outcome,
        subtype: outcome === 'completed' ? 'success' : outcome === 'interrupted' ? 'interrupted' : 'error',
        text: outcome === 'completed' ? '' : outcome === 'interrupted' ? 'Interrupted — the turn was stopped before it finished' : 'The turn failed',
        usage,
        durationMs: endedAt - run.startedAt,
        costUsd,
        costReported,
        ...(outcome === 'completed' && run.lastReply ? { reply: run.lastReply } : {}),
      },
      { turnId: run.turnId },
    )
    const turn = entry.turns.get(run.turnId)
    if (turn) {
      this.publishTurn(entry, {
        ...turn,
        status: outcome === 'completed' ? 'completed' : outcome === 'interrupted' ? 'cancelled' : 'failed',
        endedAt,
        outcome,
        subtype: outcome === 'completed' ? 'success' : outcome,
        phase: outcome === 'completed' ? 'completed' : outcome === 'interrupted' ? 'stopped' : 'failed',
        activeAgents: 0,
        resultEventId: result.id,
        replyEventId: run.replyEventId,
      })
    }
    const metrics = entry.summary.metrics
    entry.summary = {
      ...entry.summary,
      status,
      metrics: {
        ...metrics,
        turnActive: false,
        tps: 0,
        lastTtftMs: run.firstTokenAt ? run.firstTokenAt - run.startedAt : metrics.lastTtftMs,
        costUsd: +(metrics.costUsd + costUsd).toFixed(4),
      },
    }
    this.publishMetrics(entry, true)
    this.publishSession(entry)
    if (outcome === 'completed' && entry.queue.length) {
      setTimeout(() => this.drain(entry), 450)
    }
  }

  private drain(entry: Entry): void {
    if (entry.run || !this.sessions.has(entry.summary.id)) return
    const next = entry.queue.shift()
    if (!next) return
    this.publishSession(entry)
    this.deliver(entry, next.text, next.attachments, next.promptId, next.turnId)
  }

  private discardQueue(entry: Entry, reason: string): void {
    if (!entry.queue.length) return
    const count = entry.queue.length
    for (const queued of entry.queue) this.rewritePrompt(entry, queued, 'cancelled', { cancelledBy: 'server', cancelReason: reason })
    entry.queue = []
    this.emit(entry, {
      k: 'system',
      subtype: 'queue-discarded',
      text: count === 1 ? `1 queued prompt was not sent: ${reason}` : `${count} queued prompts were not sent: ${reason}`,
    })
  }

  private closeQuestions(entry: Entry, run: Run, reason: string): void {
    for (const [requestId, waiting] of run.waiting) {
      const event = entry.events.find((item) => item.ev.k === 'request' && item.ev.requestId === requestId)
      if (event?.ev.k === 'request') this.emit(entry, { ...event.ev, state: 'cancelled', closedReason: reason }, { id: event.id })
      waiting.reject()
    }
    run.waiting.clear()
  }

  private interrupt(entry: Entry): void {
    const run = entry.run
    if (!run) return
    run.cancelled = true
    this.discardQueue(entry, 'the turn was interrupted')
    this.closeQuestions(entry, run, 'not answered — the turn was interrupted')
    this.finish(entry, run, 'interrupted')
  }

  private stop(entry: Entry): void {
    const run = entry.run
    if (run) {
      run.cancelled = true
      this.discardQueue(entry, 'the session was stopped')
      this.closeQuestions(entry, run, 'not answered — the session was stopped')
      this.finish(entry, run, 'interrupted', 'stopped')
      return
    }
    entry.summary = { ...entry.summary, status: 'stopped' }
    this.publishSession(entry)
  }

  /* ---------------------------------------------------------------- */
  /* Playing a script                                                  */
  /* ---------------------------------------------------------------- */

  private async wait(play: Play, ms: number): Promise<void> {
    if (!play.live) {
      play.clock.at += ms
      return
    }
    await sleep(ms)
    if (play.run.cancelled) throw new Cancelled()
  }

  private now(play: Play): number {
    return play.live ? Date.now() : play.clock.at
  }

  private event(play: Play, ev: TimelineEvent, opts: { id?: string; agentId?: string } = {}): SessionEvent {
    return this.emit(play.entry, ev, { ...opts, turnId: play.run.turnId, at: this.now(play), live: play.live })
  }

  /** Count tokens and keep the meters moving while text streams. */
  private produce(play: Play, text: string): void {
    const { entry, run } = play
    const tokens = approxTokens(text)
    run.outputTokens += tokens
    if (run.firstTokenAt === null) run.firstTokenAt = this.now(play)
    const metrics = entry.summary.metrics
    entry.summary.metrics = {
      ...metrics,
      outputTokens: metrics.outputTokens + tokens,
      contextTokens: Math.min(metrics.contextWindow * 0.92, metrics.contextTokens + tokens * 3),
      tps: Math.round(jitter(38, 64) * 10) / 10,
      tpsAvg: Math.round(jitter(40, 48) * 10) / 10,
    }
    if (play.live) this.publishMetrics(entry)
  }

  private async stream(play: Play, kind: 'text' | 'thinking', text: string, agentId?: string): Promise<void> {
    if (!play.live) {
      this.produce(play, text)
      play.clock.at += text.length * 6
      return
    }
    const sessionId = play.entry.summary.id
    // Two to six words at a time, the way tokens arrive from a model.
    const pieces = text.match(/\S+\s*|\s+/g) ?? [text]
    let index = 0
    while (index < pieces.length) {
      const take = 2 + Math.floor(Math.random() * 4)
      const chunk = pieces.slice(index, index + take).join('')
      index += take
      this.toSubscribers(sessionId, {
        t: 'delta',
        sessionId,
        ...(agentId ? { agentId } : {}),
        key: agentId ?? 'main',
        kind,
        text: chunk,
        turnId: play.run.turnId,
      })
      this.produce(play, chunk)
      await this.wait(play, kind === 'thinking' ? jitter(28, 55) : jitter(32, 70))
    }
  }

  private toolEvent(play: Play, step: Extract<Step, { t: 'run' | 'read' | 'search' | 'edit' }>, toolId: string, status: 'running' | 'completed' | 'error' | null, agentId?: string): void {
    const { harness, cwd } = play.entry.summary
    const abs = (path: string) => (path.startsWith('/') ? path : `${cwd}/${path}`)
    let ev: Extract<TimelineEvent, { k: 'tool' }>
    if (harness === 'claude' || harness === 'commandcode') {
      const cmd = harness === 'commandcode'
      if (step.t === 'run') ev = { k: 'tool', toolId, name: cmd ? 'execute_command' : 'Bash', input: { command: step.command, description: step.command }, summary: step.command }
      else if (step.t === 'read') ev = { k: 'tool', toolId, name: cmd ? 'read_file' : 'Read', input: cmd ? { path: abs(step.path) } : { file_path: abs(step.path) }, summary: step.path }
      else if (step.t === 'search') ev = { k: 'tool', toolId, name: cmd ? 'grep' : 'Grep', input: { pattern: step.pattern, path: cwd }, summary: step.pattern }
      else {
        const name = step.change === 'create' ? (cmd ? 'write_file' : 'Write') : cmd ? 'edit_file' : 'Edit'
        ev = { k: 'tool', toolId, name, input: cmd ? { path: abs(step.path) } : { file_path: abs(step.path) }, summary: step.path }
      }
    } else {
      // ACP agents title each call and name its kind.
      if (step.t === 'run') ev = { k: 'tool', toolId, name: step.command, input: { command: step.command, cwd }, summary: step.command, kind: 'execute' }
      else if (step.t === 'read') ev = { k: 'tool', toolId, name: `Read ${step.path}`, input: { path: abs(step.path) }, summary: step.path, kind: 'read', paths: [abs(step.path)] }
      else if (step.t === 'search') ev = { k: 'tool', toolId, name: `Search ${step.pattern}`, input: { pattern: step.pattern, path: cwd }, summary: step.pattern, kind: 'search' }
      else ev = { k: 'tool', toolId, name: `Edit ${step.path}`, input: { path: abs(step.path) }, summary: step.path, kind: 'edit', paths: [abs(step.path)] }
    }
    if (status && (ACP.has(harness) || harness === 'commandcode')) ev.status = status
    this.event(play, ev, { id: toolId, agentId })
  }

  private async play(play: Play, steps: Step[], agentId?: string): Promise<void> {
    const { entry, run } = play
    const { cwd, harness, model } = entry.summary
    const abs = (path: string) => (path.startsWith('/') ? path : `${cwd}/${path}`)
    for (const step of steps) {
      if (play.live && run.cancelled) throw new Cancelled()
      switch (step.t) {
        case 'pause':
          await this.wait(play, step.ms)
          break
        case 'system':
          this.event(play, { k: 'system', subtype: step.subtype, text: step.text }, { agentId })
          await this.wait(play, 200)
          break
        case 'think':
          await this.wait(play, jitter(250, 450))
          if (agentId) this.event(play, { k: 'thinking', text: step.text }, { agentId })
          else {
            await this.stream(play, 'thinking', step.text)
            this.event(play, { k: 'thinking', text: step.text })
          }
          break
        case 'say': {
          await this.wait(play, jitter(200, 400))
          if (!agentId) await this.stream(play, 'text', step.text)
          else this.produce(play, step.text)
          const event = this.event(play, { k: 'assistant', text: step.text, model: model ?? undefined, usage: usageOf(approxTokens(step.text)) }, { agentId })
          if (!agentId) {
            run.replyEventId = event.id
            run.lastReply = step.text
          }
          break
        }
        case 'run':
        case 'read':
        case 'search': {
          const toolId = `tool_${crypto.randomUUID().slice(0, 12)}`
          const started = this.now(play)
          this.toolEvent(play, step, toolId, 'running', agentId)
          const ms = step.t === 'run' ? (step.ms ?? 600) : jitter(250, 520)
          await this.wait(play, ms)
          const failed = step.t === 'run' && (step.exit ?? 0) !== 0
          this.event(
            play,
            {
              k: 'tool_result',
              toolId,
              text: step.output,
              isError: failed,
              truncated: false,
              ...(step.t === 'run' ? { exitCode: step.exit ?? 0 } : {}),
              durationMs: this.now(play) - started,
            },
            { agentId },
          )
          this.toolEvent(play, step, toolId, failed ? 'error' : 'completed', agentId)
          this.produce(play, step.output.slice(0, 200))
          break
        }
        case 'edit': {
          const toolId = `tool_${crypto.randomUUID().slice(0, 12)}`
          const started = this.now(play)
          await this.wait(play, jitter(200, 400))
          this.toolEvent(play, step, toolId, 'running', agentId)
          await this.wait(play, jitter(450, 800))
          this.event(
            play,
            { k: 'file_change', toolId, path: abs(step.path), change: step.change, added: step.added, removed: step.removed, preview: step.diff },
            { agentId },
          )
          this.event(
            play,
            {
              k: 'tool_result',
              toolId,
              text: step.change === 'create' ? `File created successfully at: ${abs(step.path)}` : `The file ${abs(step.path)} has been updated successfully.`,
              isError: false,
              truncated: false,
              durationMs: this.now(play) - started,
            },
            { agentId },
          )
          this.toolEvent(play, step, toolId, 'completed', agentId)
          this.produce(play, step.diff)
          break
        }
        case 'agent': {
          const toolId = `tool_${crypto.randomUUID().slice(0, 12)}`
          const childId = `agent-${crypto.randomUUID().slice(0, 8)}`
          const started = this.now(play)
          await this.wait(play, jitter(250, 450))
          this.event(play, {
            k: 'tool',
            toolId,
            name: harness === 'claude' ? 'Task' : 'task',
            input: { subagent_type: step.type, description: step.description, prompt: step.prompt },
            summary: `${step.type} · ${step.description}`,
          }, { id: toolId, agentId })
          this.event(play, {
            k: 'subagent_start',
            toolId,
            agentId: childId,
            agentType: step.type,
            description: step.description,
            prompt: step.prompt,
            depth: 1,
            ...(step.model ? { model: step.model } : {}),
            spawnedAt: started,
          }, { agentId })
          run.activeAgents += 1
          this.touchTurn(play)
          await this.play(play, step.steps, childId)
          const counts = { read: 0, search: 0, bash: 0, edit: 0, other: 0, linesAdded: 0, linesRemoved: 0 }
          for (const child of step.steps) {
            if (child.t === 'read') counts.read += 1
            else if (child.t === 'search') counts.search += 1
            else if (child.t === 'run') counts.bash += 1
            else if (child.t === 'edit') {
              counts.edit += 1
              counts.linesAdded += child.added
              counts.linesRemoved += child.removed
            }
          }
          await this.wait(play, 300)
          run.activeAgents -= 1
          this.event(play, {
            k: 'subagent_end',
            toolId,
            agentId: childId,
            status: 'done',
            durationMs: this.now(play) - started,
            usage: usageOf(approxTokens(step.result) + 900),
            toolUses: counts.read + counts.search + counts.bash + counts.edit,
            tools: counts,
            result: step.result,
          }, { agentId })
          this.touchTurn(play)
          break
        }
        case 'ask': {
          await this.wait(play, jitter(300, 500))
          const requestId = `req_${crypto.randomUUID().slice(0, 12)}`
          const pending: Extract<TimelineEvent, { k: 'request' }> = {
            k: 'request',
            requestId,
            kind: step.kind,
            title: step.title,
            ...(step.detail ? { detail: step.detail } : {}),
            options: step.options,
            state: 'pending',
          }
          const event = this.event(play, pending, { id: `request:${requestId}`, agentId })
          let choice: string
          if (play.live) {
            choice = await new Promise<string>((resolve, reject) => {
              run.waiting.set(requestId, { options: step.options, resolve, reject: () => reject(new Cancelled()) })
            })
            if (run.cancelled) throw new Cancelled()
          } else {
            choice = play.answers?.[step.title] ?? step.options[0]!.id
            play.clock.at += 9_000
          }
          this.emit(entry, { ...pending, state: 'answered', answeredOptionId: choice }, { id: event.id, live: play.live })
          await this.play(play, step.branches[choice] ?? [], agentId)
          break
        }
      }
    }
  }

  /** The turn's live agent count moved. */
  private touchTurn(play: Play): void {
    const turn = play.entry.turns.get(play.run.turnId)
    if (turn) this.publishTurn(play.entry, { ...turn, activeAgents: play.run.activeAgents }, play.live)
  }

  /* ---------------------------------------------------------------- */
  /* Seeded history                                                    */
  /* ---------------------------------------------------------------- */

  private async seedTurns(entry: Entry, turns: SeedTurn[], startAt: number): Promise<void> {
    let at = startAt
    for (const seed of turns) {
      const turnId = crypto.randomUUID()
      const promptId = `prompt:seed-${crypto.randomUUID()}`
      const run: Run = {
        turnId,
        cancelled: false,
        waiting: new Map(),
        startedAt: at,
        firstTokenAt: null,
        outputTokens: 0,
        replyEventId: null,
        lastReply: '',
        activeAgents: 0,
      }
      this.emit(entry, { k: 'user', text: seed.prompt, promptId, delivery: 'delivered' }, { id: promptId, turnId, at, live: false })
      const play: Play = { entry, run, live: false, clock: { at: at + 800 }, answers: seed.answers }
      await this.play(play, seed.steps)
      const endedAt = play.clock.at + 400
      const costReported = entry.summary.harness === 'claude'
      const costUsd = costReported ? +(run.outputTokens * 0.000075 + 0.012).toFixed(4) : 0
      const result = this.emit(
        entry,
        { k: 'result', outcome: 'completed', subtype: 'success', text: '', usage: usageOf(run.outputTokens), durationMs: endedAt - at, costUsd, costReported, reply: run.lastReply },
        { turnId, at: endedAt, live: false },
      )
      this.publishTurn(entry, {
        ...turnRecord(entry.summary.id, turnId, promptId, at),
        status: 'completed',
        endedAt,
        outcome: 'completed',
        subtype: 'success',
        phase: 'completed',
        resultEventId: result.id,
        replyEventId: run.replyEventId,
      }, false)
      entry.summary.metrics = { ...entry.summary.metrics, costUsd: +(entry.summary.metrics.costUsd + costUsd).toFixed(4), lastTtftMs: Math.round(jitter(600, 1400)) }
      at = endedAt + 4 * 60_000
    }
    entry.summary = { ...entry.summary, createdAt: startAt, updatedAt: at - 4 * 60_000, started: true }
  }

  private async seed(): Promise<void> {
    const now = Date.now()
    const minute = 60_000
    const day = 86_400_000
    const make = async (
      id: string,
      patch: Partial<SessionSummary> & { harness: HarnessId; cwd: string; title: string },
      turns: SeedTurn[],
      startAt: number,
    ) => {
      const entry = this.createEntry({ id, ...patch })
      await this.seedTurns(entry, turns, startAt)
      return entry
    }
    await make('demo-claude', { harness: 'claude', cwd: ACME_API, title: 'Rate-limit POST /api/orders', model: 'claude-opus-4-6', effort: 'high', permissionMode: 'acceptEdits', gitBranch: 'feat/rate-limit', pinned: true }, SEED_RATE_LIMIT, now - 34 * minute)
    await make('demo-codex', { harness: 'codex', cwd: ACME_API, title: 'Stream the CSV importer', model: 'gpt-5.6-codex', effort: 'medium', gitBranch: 'fix/csv-oom' }, SEED_CSV, now - 95 * minute)
    await make('demo-gemini', { harness: 'gemini', cwd: ACME_API, title: 'Explain the auth middleware', model: 'gemini-3-pro' }, SEED_EXPLAIN, now - 4 * 60 * minute)
    await make('demo-opencode', { harness: 'opencode', cwd: ACME_API, title: 'Fix the flaky order-expiry test', model: 'opencode-zen/kimi-k2.7-code', permissionMode: 'default', gitBranch: 'fix/expiry-clock' }, SEED_FLAKY, now - 1.2 * day)
    await make('demo-cmd', { harness: 'commandcode', cwd: ACME_API, title: 'Write the deploy runbook', model: 'cmd-large', gitBranch: 'docs/runbook' }, SEED_RUNBOOK, now - 2.3 * day)
    await make('demo-web', { harness: 'claude', cwd: ACME_WEB, title: 'Dark mode toggle for the dashboard', model: 'claude-sonnet-4-6', effort: 'medium', gitBranch: 'feat/dark-mode' }, SEED_THEME, now - 3.1 * day)
    // The landing page's deep links: turns already waiting on a card.
    const waiting = (id: string, patch: Partial<SessionSummary> & { harness: HarnessId; cwd: string; title: string }, moment: Moment) => {
      const entry = this.createEntry({ id, ...patch, createdAt: now - 2 * minute })
      this.deliver(entry, moment.prompt, undefined, `prompt:seed-${id}`, undefined, moment.steps)
    }
    waiting('demo-question', { harness: 'claude', cwd: ACME_API, title: 'Cover the orders route with tests', model: 'claude-opus-4-6', effort: 'high', gitBranch: 'test/orders' }, questionMoment())
    waiting('demo-permission', { harness: 'codex', cwd: ACME_API, title: 'Upgrade zod to v4', model: 'gpt-5.6-codex', effort: 'medium', gitBranch: 'chore/zod-4' }, permissionMoment())
    const terminal = this.createEntry({
      id: 'demo-terminal',
      harness: 'shell',
      kind: 'terminal',
      cwd: ACME_API,
      title: terminalTitle('', ACME_API, null),
      model: null,
      status: 'running',
      started: true,
      updatedAt: now - 20 * minute,
      createdAt: now - 50 * minute,
    })
    terminal.shell = new DemoShell(ACME_API, null, '')
    this.tabs = [{ id: 'demo-claude' }, { id: 'demo-codex' }, { id: 'demo-opencode' }]
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** The real server's naming (see `terminalTitle` in the server's presets). */
function terminalTitle(preset: string, cwd: string, host: string | null): string {
  if (host) return `Terminal · ${host}`
  const where = cwd.split('/').filter(Boolean).pop() ?? cwd
  const labels: Record<string, string> = { 'claude-tui': 'Claude Code', 'codex-tui': 'Codex', freebuff: 'Freebuff' }
  return labels[preset] ? `Terminal · ${labels[preset]}` : `Terminal · Shell · ${where}`
}

function titleOf(prompt: string | undefined): string {
  const line = (prompt ?? '').trim().split('\n')[0] ?? ''
  if (!line) return 'New session'
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line
}

function usageOf(output: number): TokenUsage {
  return { input: 12_000 + output * 6, output, cacheRead: 48_000 + output * 10, cacheWrite: 900, reasoning: Math.round(output / 3) }
}

function turnRecord(sessionId: string, turnId: string, promptId: string, startedAt: number): TurnRecord {
  return {
    id: turnId,
    sessionId,
    runToken: crypto.randomUUID(),
    status: 'running',
    promptId,
    startedAt,
    endedAt: null,
    outcome: null,
    subtype: null,
    phase: 'running',
    activeAgents: 0,
    cutOffAgents: 0,
    resultEventId: null,
    replyEventId: null,
  }
}

function metricsFor(harness: HarnessId, model: string | null): SessionMetrics {
  const reportsContext = harness !== 'commandcode' && harness !== 'shell'
  return {
    ...emptyMetrics(),
    costReported: harness === 'claude',
    contextReported: reportsContext,
    contextWindowInferred: reportsContext && harness !== 'claude',
    contextWindow: reportsContext ? contextWindowFor(model) : 0,
    contextTokens: reportsContext ? 38_000 + Math.round(Math.random() * 40_000) : 0,
    inputTokens: 64_000,
    outputTokens: 2_400,
    cacheReadTokens: 210_000,
    cacheWriteTokens: 8_000,
    tpsAvg: 44.2,
  }
}

function nativeIdFor(harness: HarnessId, id: string): string {
  const tail = id.replace(/[^a-z0-9]/gi, '').slice(-12).padStart(12, '0')
  return harness === 'codex' ? `thr_${tail}` : `0f3c9a2e-41b7-4d6a-9e10-${tail}`
}

function resumeHintFor(harness: HarnessId, nativeId: string): string | null {
  switch (harness) {
    case 'claude':
      return `claude --resume ${nativeId}`
    case 'codex':
      return `codex resume ${nativeId}`
    case 'gemini':
      return `gemini --resume ${nativeId}`
    case 'opencode':
      return `opencode --session ${nativeId}`
    case 'commandcode':
      return `cmd --resume ${nativeId}`
    default:
      return null
  }
}
