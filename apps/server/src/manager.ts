import type {
  AckError,
  ActorRecord,
  ActorStatus,
  AttachmentRef,
  EffortLevel,
  HarnessId,
  HarnessUpdateInfo,
  NewSessionRequest,
  PermissionMode,
  SessionEvent,
  SessionMetrics,
  ConfigureResult,
  PendingOptions,
  PromptDelivery,
  PromptRecord,
  SendResult,
  SessionStatus,
  SessionSummary,
  TimelineEvent,
  TurnPhase,
  TurnRecord,
  TurnStatus,
  TokenUsage,
  ResultOutcome,
} from '@shared'
import { emptyMetrics, isDocument, isPlaceholderModel, realModel, resultOutcomeOf, splitDocuments, versionNumber, withDocuments } from '@shared'
import { broadcast, broadcastSession } from './bus.ts'
import { attachmentText, deleteAttachment, deleteAttachments } from './attachments.ts'
import * as db from './db.ts'
import { Meter } from './metrics.ts'
import {
  HARNESS_CATALOG,
  getAdapter,
  getAdapterFor,
  isHarnessEnabled,
  permissionModesFor,
  setHarnessEnabled as storeHarnessEnabled,
  wiredHarnesses,
} from './harnesses/registry.ts'
import { commandsFor } from './harnesses/commands.ts'
import { modelTakesImages } from './harnesses/model-images.ts'
import { applyHarnessUpdate, checkHarnessUpdate } from './harnesses/updates.ts'
import type { HarnessInfo } from '@shared'
import type { Adapter, CreateOptions, Driver, DriverHooks, TerminalScreen } from './harnesses/types.ts'
import { presetList, terminalTitle } from './harnesses/terminal/presets.ts'
import { killTerminalSession } from './harnesses/terminal/driver.ts'
import { loadCachedModels } from './harnesses/acp/driver.ts'
import {
  Transport,
  clearDurableState,
  durableAlive,
  durableDestroy,
  listDurableStates,
  readDurableState,
  stopAllTails,
} from './transport.ts'
import { claudeTranscriptPath } from './paths.ts'
import { resolveVoice } from './transcribe.ts'
import { unhandledEvents } from './harnesses/coverage.ts'
import { refreshCoverage } from './harnesses/coverage/sync.ts'
import { sshHosts } from './projects.ts'
import { allHosts, assertAuthorizedHost, isAuthorizedHost, sshConfigHosts } from './hosts.ts'
import { publishLimits } from './usage/index.ts'
import type { Capabilities, HostStatus } from '@shared'
import { isRemoteError } from './transport.ts'
import { forgetTab } from './tabs.ts'

interface Entry {
  summary: SessionSummary
  meter: Meter
  driver: Driver | null
  opts: CreateOptions
  seq: number
  /**
   * The turns this process has seen, oldest first, with the moment each began.
   *
   * An event is filed under the last turn that had already started when it
   * happened, which is what keeps a transcript line or a sidechain event that
   * arrives after the next prompt in the turn that actually produced it. Bounded
   * because only recent turns can still receive late events.
   */
  turns: Array<{ id: string; startedAt: number; runToken: string; resultSeen: boolean; resultOutcome?: ResultOutcome }>
  /** The last turn view published per turn id, so an unchanged one is not resent. */
  turnViews: Map<string, string>
  /** Turns a mid-turn prompt took over, waiting only on their own agents. */
  continuedTurns: Set<string>
  /** Which turn each child agent was spawned in, so all its work stays there. */
  agentTurns: Map<string, string>
  /** Whether the last turn is still open: no result or status boundary yet. */
  turnOpen: boolean
  /** Parent sidechain per child agent, learned from normalized spawn events. */
  agentParents: Map<string, string>
  lastFlush: number
  /** When the meter's reading was last written down (see `saveMetrics`). */
  lastMetricsSave: number
  /**
   * Whether the context window being measured against was inferred from the
   * model name rather than reported by the harness. Kept here because the meter
   * is only told a number, and the difference is about where that number came
   * from (see the `usage` hook and `SessionMetrics.contextWindowInferred`).
   */
  contextWindowInferred: boolean
  /**
   * The lifecycle token of this entry: bumped by every stop and every delete.
   *
   * A spawn, a driver and every callback a driver will ever make are stamped
   * with the generation they were started for, and anything carrying an old one
   * is ignored. Without it a handshake that finished after a delete assigned its
   * driver to a session that no longer existed and persisted the row back into
   * the database, and a callback from a process already stopped could still move
   * the session's status.
   */
  generation: number
  /**
   * In-flight spawn, shared so concurrent senders do not race a second one, and
   * scoped to the generation that asked for it: after a stop, the next prompt
   * must start a process, not join the one that was just cancelled.
   */
  spawn: { generation: number; promise: Promise<Driver | null> } | null
  /**
   * Cancellation for the spawn in flight. The adapter contract has no signal
   * yet, so this cannot abort the handshake itself; it records that nobody wants
   * the result any more, and a driver that arrives after it is stopped on the
   * spot instead of being kept (see `ensureDriver`).
   */
  spawnAbort: AbortController | null
  /**
   * The terminal status this generation has already reached, if any. See
   * `setStatus`: it is what makes `stopped` and `error` final.
   */
  terminalStatus: SessionStatus | null
  /**
   * Whether a prompt is with the harness right now. Not derived from `status`,
   * because there is a window between handing a prompt over and the harness
   * saying it started in which a second prompt would otherwise look sendable.
   */
  turnActive: boolean
  /**
   * The provider's main loop has gone idle, but one or more child actors still
   * own work in this turn.  The turn remains live until the last child settles;
   * otherwise the UI says "Worked" and drains the next prompt while a subagent
   * is still changing the workspace.
   */
  providerSettledTurnId: string | null
  /**
   * Prompts accepted while a turn was running, oldest first. Mirrors the
   * `prompt_queue` table so the queue survives a restart of this process.
   */
  queue: Array<db.QueuedPrompt & { promptId?: string; turnId?: string; commandId?: string }>
  /**
   * The per-session operation chain: every asynchronous mutation of this entry
   * runs on it, so a send and a drain cannot interleave halfway through a spawn.
   */
  chain: Promise<unknown>
  /**
   * Model / effort / approval mode the user asked for and the harness has not
   * applied yet. Kept apart from `summary` on purpose: the summary is what is in
   * effect, and writing a requested value into it is how the app came to report a
   * model the agent had refused. See `setSessionOptions` and `commitPending`.
   */
  pending: PendingOptions | null
  /**
   * The grace period an interrupt is given before the stop is finished here.
   * See `interruptSession`: an interrupt is a request the harness may never
   * answer, and a turn that outlives its own process is a turn nobody can end.
   */
  interruptTimer: ReturnType<typeof setTimeout> | null
  /**
   * Geometry the client asked for. Kept because the first resize of a restored
   * terminal tab arrives before anything is attached, and a dropped resize left
   * the pane at the driver's default 100×30 while the terminal on screen was
   * bigger — the replayed screen then stopped halfway down with the cursor in
   * the middle of nothing.
   */
  termSize?: { cols: number; rows: number }
  /**
   * The next process for this session is one that is already running.
   *
   * Set for exactly one creation, by the reattach path, after the machine the
   * session runs on has confirmed the process is still there. Consumed by
   * `ensureDriver`, because a driver that cannot find it must fall back to
   * starting one — and every later spawn is an ordinary spawn.
   */
  attach: boolean
  /**
   * Questions the harness was blocked on when the last server went away, handed
   * to the driver of a reattach so it can let the agent go (see `CreateOptions`).
   */
  pendingRequests: string[]
}

/**
 * The execution-ledger store is deliberately consumed through this narrow
 * structural adapter.  It lets the manager keep working against databases
 * created by pre-ledger builds while the migration is rolling out, and keeps
 * the DB implementation free to use its own row types.  The ledger agent's
 * public methods use the object forms below; the fallback calls are only for
 * the short compatibility window with an older local DB module.
 */
type LedgerStore = {
  acceptPrompt?: (record: PromptRecord) => unknown
  getPrompt?: (id: string) => unknown
  listPrompts?: (sessionId: string) => unknown[]
  updatePrompt?: (id: string, patch: Partial<PromptRecord>) => unknown
  startTurn?: (record: TurnRecord) => unknown
  getTurn?: (id: string) => unknown
  updateTurn?: (id: string, patch: Partial<TurnRecord>) => unknown
  advanceTurn?: (id: string, runToken: string, state: TurnStatus, subtype?: string | null, at?: number) => unknown
  upsertActor?: (record: ActorRecord) => unknown
  getActor?: (sessionId: string, id: string) => unknown
  listActors?: (sessionId: string) => unknown[]
  hasActiveActors?: (sessionId: string, turnId?: string) => boolean
  recoverablePrompts?: (sessionId?: string) => unknown[]
}

const ledger = db as unknown as LedgerStore

function ledgerPrompt(record: PromptRecord): void {
  try {
    ledger.acceptPrompt?.(record)
  } catch {
    // A server using the pre-ledger DB remains usable; its prompt_queue/events
    // are still authoritative until the migration is installed.
  }
}

function updateLedgerPrompt(id: string, patch: Partial<PromptRecord>): void {
  try {
    ledger.updatePrompt?.(id, patch)
  } catch {
    // Compatibility fallback: lifecycle broadcasts/events still tell clients.
  }
}

function existingLedgerPrompt(id: string): Partial<PromptRecord> | null {
  try {
    const row = ledger.getPrompt?.(id)
    if (!row || typeof row !== 'object') return null
    const value = row as Record<string, unknown>
    return ((value.prompt ?? value.record ?? value) as Partial<PromptRecord>) ?? null
  } catch {
    return null
  }
}

function ledgerTurn(record: TurnRecord): void {
  try {
    ledger.startTurn?.(record)
  } catch {
    // See ledgerPrompt: old databases have no turn table yet.
  }
}

function updateLedgerTurn(id: string, patch: Partial<TurnRecord>): boolean {
  try {
    const turn = entryTurnFor(id)
    const lifecycle = { ...patch, ...(turn ? { runToken: turn.runToken } : {}) }
    if (ledger.updateTurn) return ledger.updateTurn(id, lifecycle) !== false
    if (ledger.advanceTurn && lifecycle.status && lifecycle.status !== 'starting') {
      return ledger.advanceTurn(id, lifecycle.runToken ?? '', lifecycle.status, lifecycle.subtype ?? null, lifecycle.endedAt ?? Date.now()) !== false
    }
    return true
  } catch {
    return false
  }
}

function entryTurnFor(id: string): { runToken: string } | null {
  for (const entry of entries.values()) {
    const turn = entry.turns.find((item) => item.id === id)
    if (turn) return turn
  }
  return null
}

function ledgerActor(record: ActorRecord): void {
  try {
    ledger.upsertActor?.(record)
  } catch {
    // Actor lifecycle is additive and must not break provider output.
  }
}

function promptFrame(entry: Entry, prompt: PromptRecord): void {
  if (!isLive(entry)) return
  broadcastSession(entry.summary.id, { t: 'prompt', sessionId: entry.summary.id, prompt })
}

/** Rewrite the canonical user event as its durable delivery state advances. */
function updatePromptEvent(
  entry: Entry,
  promptId: string,
  delivery: PromptDelivery,
  turnId?: string | null,
  cancel?: { by: 'user' | 'server'; reason: string },
): void {
  // By identity, not by scanning the recent window: this runs several times per
  // prompt, parsing 3000 payloads each time froze the loop on long sessions, and
  // a queued prompt that sat behind a turn of more than 3000 events fell out of
  // the window and was never marked delivered or cancelled.
  const previous = db.getEvent(entry.summary.id, `prompt:${promptId}`)
  if (!previous || previous.ev.k !== 'user') return
  emit(
    entry,
    {
      ...previous.ev,
      promptId,
      delivery,
      ...(cancel ? { cancelledBy: cancel.by, cancelReason: cancel.reason } : {}),
    },
    previous.id,
    Date.now(),
    previous.agentId,
    previous.parentEventId,
    previous.parentAgentId,
    turnId ?? previous.turnId,
  )
}

/**
 * A ledger turn as the wire carries it: the row plus the phase the ledger
 * decides (see docs/architecture.md, "Turn state"). This is the only place a
 * turn's state is derived, for every harness; drivers only report facts.
 */
function turnView(row: db.TurnRow, facts: db.TurnFacts | undefined): TurnRecord {
  const active = facts?.activeAgents ?? 0
  const phase: TurnPhase =
    row.state === 'completed'
      ? 'completed'
      : row.state === 'cancelled'
        ? 'stopped'
        : row.state === 'failed'
          ? 'failed'
          : active > 0 && facts?.resultEventId
            ? 'waiting_agents'
            : 'running'
  return {
    id: row.id,
    sessionId: row.sessionId,
    runToken: row.runToken,
    status: row.state,
    promptId: row.promptId,
    startedAt: row.startedAt,
    endedAt: row.completedAt,
    outcome: row.outcome,
    subtype: row.subtype,
    phase,
    activeAgents: active,
    cutOffAgents: facts?.cutOffAgents ?? 0,
    resultEventId: facts?.resultEventId ?? null,
    replyEventId: facts?.replyEventId ?? null,
  }
}

/** Every ledger turn of a session, for the subscribe snapshot. */
export function turnViews(sessionId: string): TurnRecord[] {
  try {
    const facts = db.turnFacts(sessionId)
    return db.listTurns(sessionId).map((row) => turnView(row, facts.get(row.id)))
  } catch {
    return []
  }
}

/**
 * Publish a turn's view if it changed. Called after every write that can move
 * a turn — its row, one of its actors, a main result or reply — so a client
 * sees each transition exactly once, whichever harness caused it.
 */
function publishTurn(entry: Entry, turnId: string | null | undefined): void {
  if (!turnId || !isLive(entry)) return
  const row = db.getTurn(turnId)
  if (!row || row.sessionId !== entry.summary.id) return
  const turn = turnView(row, db.turnFacts(entry.summary.id, turnId).get(turnId))
  const fingerprint = JSON.stringify(turn)
  if (entry.turnViews.get(turnId) === fingerprint) return
  entry.turnViews.set(turnId, fingerprint)
  if (entry.turnViews.size > TURN_MEMORY * 2) entry.turnViews.delete(entry.turnViews.keys().next().value as string)
  broadcastSession(entry.summary.id, { t: 'turn', sessionId: entry.summary.id, turn })
}

/** Kept for its call sites: the record passed in only names the turn. */
function turnFrame(entry: Entry, turn: Pick<TurnRecord, 'id'> & Partial<TurnRecord>): void {
  publishTurn(entry, turn.id)
}

function actorFrame(entry: Entry, actor: ActorRecord): void {
  if (!isLive(entry)) return
  broadcastSession(entry.summary.id, { t: 'actor', sessionId: entry.summary.id, actor })
  publishTurn(entry, actor.turnId)
}

function updateMainActor(entry: Entry, status: ActorStatus, at = Date.now()): void {
  const actor: ActorRecord = {
    id: `main:${entry.summary.id}`,
    sessionId: entry.summary.id,
    turnId: entry.turns.at(-1)?.id ?? null,
    ownership: 'sedano',
    provider: entry.summary.harness,
    status,
    updatedAt: at,
  }
  ledgerActor(actor)
  actorFrame(entry, actor)
}

function promptState(
  entry: Entry,
  id: string,
  delivery: PromptDelivery,
  turnId: string | null,
  commandId?: string,
  error?: string | null,
  createdAt = Date.now(),
): PromptRecord {
  return {
    id,
    sessionId: entry.summary.id,
    ...(commandId ? { commandId } : {}),
    turnId,
    delivery,
    createdAt,
    updatedAt: Date.now(),
    ...(error !== undefined ? { error } : {}),
  }
}

function recoverableQueue(sessionId: string): Array<db.QueuedPrompt & { promptId?: string; turnId?: string; commandId?: string }> {
  const legacy = db.loadPromptQueue(sessionId) as Array<db.QueuedPrompt & { promptId?: string; turnId?: string; commandId?: string }>
  const recover = ledger.recoverablePrompts
  if (!recover) return legacy
  try {
    const rows = (recover(sessionId) as Array<Record<string, unknown>>).filter(
      (row) => String(row.state ?? row.delivery ?? '') === 'queued',
    )
    if (!Array.isArray(rows) || !rows.length) return legacy
    return legacy.map((old, index) => {
      const promptId = old.promptId
      const row = (promptId ? rows.find((candidate) => candidate.id === promptId) : undefined) ?? rows[index]
      return {
        ...old,
        ...(typeof row?.id === 'string' ? { promptId: row.id } : {}),
        ...(typeof row?.turnId === 'string' ? { turnId: row.turnId } : {}),
        ...(typeof row?.commandId === 'string' ? { commandId: row.commandId } : {}),
      }
    })
  } catch {
    return legacy
  }
}

const entries = new Map<string, Entry>()

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function defaultPermissionMode(): PermissionMode {
  return 'acceptEdits'
}

/**
 * Titles must mean something. Older builds stored the workspace folder name for
 * every session, which is why a sidebar full of tabs all read "sedano"; a
 * stored title that is only the folder name is treated as "no title yet" and
 * replaced by the first thing the user actually asked for.
 */
function normalizeTitle(title: string | null, cwd: string): string {
  const value = (title ?? '').trim()
  if (!value) return ''
  const folder = cwd.split('/').filter(Boolean).pop() ?? ''
  if (value === cwd || value === folder) return ''
  return value
}

function summaryFromRow(row: db.SessionRow): SessionSummary {
  const userTitle = row.title_source === 'user'
  // A name the user typed is theirs even when it happens to be the folder name.
  const summaryTitle = userTitle ? row.title : normalizeTitle(row.title, row.cwd)
  return {
    id: row.id,
    harness: row.harness,
    kind: row.kind === 'terminal' ? 'terminal' : 'agent',
    title: summaryTitle,
    titleSource: userTitle ? 'user' : 'auto',
    parentSessionId: row.parent_session_id ?? null,
    preset: row.preset ?? null,
    cwd: row.cwd,
    host: row.host,
    // A row written before placeholders were refused can still be carrying one
    // (`<synthetic>` is what Claude Code stamps on the messages it writes
    // itself). Healing it on the way out of the database is what stops a session
    // poisoned once from staying poisoned for the rest of its life: it reads as
    // "no model reported yet", and the next thing the harness says replaces it.
    model: realModel(row.model),
    status: 'stopped',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nativeId: row.native_id,
    transcriptPath: row.transcript_path,
    resumeHint: row.resume_hint,
    permissionMode: (row.permission_mode as PermissionMode) || defaultPermissionMode(),
    effort: (row.effort as EffortLevel) || null,
    gitBranch: row.git_branch,
    pinned: row.pinned === 1,
    started: row.started === 1 || (row.kind !== 'terminal' && Boolean(summaryTitle)),
    metrics: emptyMetrics(),
  }
}

/** Rebuild the actor links a durable driver may keep emitting after restart. */
function restoredAgentParents(sessionId: string): Map<string, string> {
  const parents = new Map<string, string>()
  // Only the spawn rows: this runs for every stored session at boot, and
  // parsing each one's last 3000 payloads to find a handful of spawns made
  // startup cost grow with the size of the whole history.
  for (const event of db.loadEventsOfKind(sessionId, 'subagent_start')) {
    if (event.ev.k === 'subagent_start' && event.ev.agentId && event.parentAgentId) {
      parents.set(event.ev.agentId, event.parentAgentId)
    }
  }
  return parents
}

/**
 * Whether this entry is still the session it claims to be.
 *
 * A deleted session is removed from `entries`, but the work it started is not
 * removed from the event loop: a handshake still in flight, a driver callback
 * already queued. Every write about a session goes through this, so the last
 * word of a session that no longer exists cannot put its row back.
 */
function isLive(entry: Entry): boolean {
  return entries.get(entry.summary.id) === entry
}

/** Still the same session *and* still the same lifecycle (see `Entry.generation`). */
function isCurrent(entry: Entry, generation: number): boolean {
  return isLive(entry) && entry.generation === generation
}

/**
 * Start a new lifecycle for this entry: whatever was running for the old one is
 * disowned. Used by stop and delete, which are the two moments the user says the
 * current process is no longer the one they want.
 */
function newGeneration(entry: Entry): number {
  entry.generation += 1
  entry.spawnAbort?.abort()
  entry.spawnAbort = null
  entry.spawn = null
  entry.terminalStatus = null
  entry.turnActive = false
  entry.providerSettledTurnId = null
  return entry.generation
}

/**
 * The only place a session's status changes, and the whole policy about it.
 *
 * Two rules. A callback from an older generation is ignored outright: the
 * process it speaks for is one the user already replaced. And within a
 * generation `stopped` and `error` are final — a harness that reports its exit
 * after we stopped it turned a stop into an error, and a driver that kept
 * talking after a failed turn turned an error back into `idle`, so the session
 * looked ready when nothing had recovered. A new turn on a finished session
 * clears the terminal state explicitly (see `deliver`), which is the only way
 * out of it: the manager knows it is starting work, a late callback does not.
 */
function setStatus(entry: Entry, generation: number, status: SessionStatus): void {
  if (!isCurrent(entry, generation)) return
  if (entry.terminalStatus) return
  if (status === 'stopped' || status === 'error') entry.terminalStatus = status
  entry.summary.status = status
  publishSession(entry)
}

/* ------------------------------------------------------------------ */
/* Requested options, and the moment they become real                  */
/* ------------------------------------------------------------------ */

/** Model, effort and approval mode the next process should run with. */
function wantedOptions(entry: Entry): Required<PendingOptions> {
  return {
    model: entry.pending?.model !== undefined ? entry.pending.model : entry.summary.model,
    effort: entry.pending?.effort !== undefined ? entry.pending.effort : entry.summary.effort,
    permissionMode:
      entry.pending?.permissionMode !== undefined
        ? entry.pending.permissionMode
        : entry.summary.permissionMode,
  }
}

/**
 * A requested option has become the truth: write it into the summary.
 *
 * Called from the one place that can honestly say so — a process that has just
 * been started with these values, so they are what the session is running — and,
 * for the model, from the driver's own confirmation. Everything still pending
 * stays pending: a value the harness has not acknowledged is not a value the
 * summary may claim.
 */
function commitPending(
  entry: Entry,
  applied: Required<PendingOptions>,
  modelBeforeSpawn: string | null,
): void {
  // The handshake happens *inside* the spawn this commit closes, so by now the
  // agent may already have named the model it is actually running — an ACP agent
  // asked for no particular model answers with its own default, and that answer
  // is the truth. Writing the request back over it is how a freshly started ACP
  // session came back reading "no model" the instant it connected. The driver's
  // word wins whenever it spoke; only an unanswered request is committed.
  const reported = entry.summary.model !== modelBeforeSpawn
  if (!reported) entry.summary.model = applied.model
  entry.summary.effort = applied.effort
  entry.summary.permissionMode = applied.permissionMode
  entry.opts = { ...entry.opts, ...applied, model: entry.summary.model }
  entry.pending = null
  delete entry.summary.pendingOptions
}

function persist(entry: Entry): void {
  if (!isLive(entry)) return
  db.upsertSession({
    id: entry.summary.id,
    harness: entry.summary.harness,
    kind: entry.summary.kind,
    title: entry.summary.title,
    cwd: entry.summary.cwd,
    host: entry.summary.host,
    // Belt and braces with `summaryFromRow`: whatever reaches the summary, a
    // placeholder never becomes a stored model, so a restart cannot resurrect
    // one that slipped past every guard in front of this.
    model: realModel(entry.summary.model),
    status: entry.summary.status,
    createdAt: entry.summary.createdAt,
    updatedAt: entry.summary.updatedAt,
    nativeId: entry.summary.nativeId,
    transcriptPath: entry.summary.transcriptPath,
    resumeHint: entry.summary.resumeHint,
    permissionMode: entry.summary.permissionMode,
    effort: entry.summary.effort,
    gitBranch: entry.summary.gitBranch,
    preset: entry.summary.preset,
    pinned: entry.summary.pinned ? 1 : 0,
    started: entry.summary.started,
    titleSource: entry.summary.titleSource === 'user' ? 'user' : 'auto',
    parentSessionId: entry.summary.parentSessionId ?? null,
  })
}

/**
 * The meter's reading, plus the one thing the meter cannot know: whether the
 * window it is measuring against was given to us or inferred from the model (see
 * the `usage` hook). Every publish goes through here, so no path can broadcast
 * an inferred window dressed up as a reported one.
 */
function snapshotOf(entry: Entry): SessionMetrics {
  const metrics = entry.meter.snapshot()
  return { ...metrics, contextWindowInferred: metrics.contextReported === true && entry.contextWindowInferred }
}

function publishSession(entry: Entry): void {
  if (!isLive(entry)) return
  entry.summary.metrics = snapshotOf(entry)
  entry.summary.updatedAt = Date.now()
  // The queue is part of what the session is: published from one place so no
  // path can broadcast a session whose waiting prompts are invisible.
  entry.summary.queuedPrompts = entry.queue.length
  persist(entry)
  broadcast({ t: 'session', session: entry.summary })
}

/**
 * The meter's reading, kept across restarts.
 *
 * Nothing else remembers it: a restored session started from an empty meter,
 * so a Codex, Opencode or Command Code chat read "not reported" with no totals
 * until its next turn ended — none of them re-reads its history on attach
 * (Claude does, and rebuilds from that instead, see `usageReplay`).
 */
const METRICS_KEY = (id: string) => `metrics:${id}`
const METRICS_SAVE_MS = 2_000

function saveMetrics(entry: Entry, force = false): void {
  if (!isLive(entry)) return
  const now = Date.now()
  if (!force && now - entry.lastMetricsSave < METRICS_SAVE_MS) return
  entry.lastMetricsSave = now
  db.kvSet(METRICS_KEY(entry.summary.id), JSON.stringify(snapshotOf(entry)))
}

function restoreMetrics(entry: Entry): void {
  const raw = db.kvGet(METRICS_KEY(entry.summary.id))
  if (!raw) return
  try {
    const saved = JSON.parse(raw) as Partial<SessionMetrics>
    entry.meter.seed(saved)
    entry.contextWindowInferred = saved.contextWindowInferred === true
  } catch {
    // An unreadable reading is no reading: the session starts from zero.
  }
}

function flushMetrics(entry: Entry, force = false): void {
  const now = Date.now()
  if (!force && now - entry.lastFlush < 150) return
  entry.lastFlush = now
  entry.summary.metrics = snapshotOf(entry)
  broadcastSession(entry.summary.id, {
    t: 'metrics',
    sessionId: entry.summary.id,
    metrics: entry.summary.metrics,
  })
}

/* ------------------------------------------------------------------ */
/* Event pipeline                                                      */
/* ------------------------------------------------------------------ */

/** How many turns can still receive a late event. */
const TURN_MEMORY = 64

/**
 * Open a turn: the user's prompt has been accepted and everything the harness
 * does from here belongs to it. Called when the prompt is taken, not when the
 * harness gets round to announcing a turn, because the prompt is the boundary the
 * user drew and the announcement can arrive after the first events of the turn.
 */
function startTurn(
  entry: Entry,
  at = Date.now(),
  id: string = crypto.randomUUID(),
  promptId: string | null = null,
  commandId?: string,
): string {
  const persisted = db.getTurn(id)
  if (persisted && persisted.sessionId !== entry.summary.id) {
    throw new Error(`turn ${id} belongs to another session`)
  }
  const runToken = persisted?.runToken ?? crypto.randomUUID()
  const startedAt = persisted?.startedAt ?? at
  const prior = entry.turns.find((turn) => turn.id === id)
  if (prior) {
    prior.startedAt = startedAt
    prior.runToken = runToken
  } else {
    const resultSeen = Boolean(persisted) && db.loadEvents(entry.summary.id, 3000).some((event) =>
      event.turnId === id && event.ev.k === 'result' && !event.agentId,
    )
    entry.turns.push({ id, startedAt, runToken, resultSeen })
  }
  if (entry.turns.length > TURN_MEMORY) entry.turns.splice(0, entry.turns.length - TURN_MEMORY)
  entry.turnOpen = true
  const turn: TurnRecord = {
    id,
    sessionId: entry.summary.id,
    runToken,
    status: 'starting',
    promptId,
    startedAt,
  }
  ledgerTurn(turn)
  turnFrame(entry, turn)
  if (promptId) updateLedgerPrompt(promptId, { turnId: id, delivery: 'starting', updatedAt: Date.now() })
  return id
}

/**
 * Close a non-durable turn the previous server left open.
 *
 * A server restart tears down stdio-backed agents (ACP in particular). Their
 * events are already safely in our database, but there is no process left that
 * can send the final `result`. Leaving the turn without that boundary made the
 * client infer a one-second stop from whichever row it happened to see last and
 * hid the several minutes of work that preceded it.
 *
 * Durable drivers are deliberately excluded: `reattach` will pick their output
 * stream back up and let the harness provide its own real result. For everything
 * else, the last persisted event is the honest lower bound for the duration and
 * an explicit restart result is better than a turn that appears to vanish.
 */
function closeInterruptedTurn(entry: Entry, storedStatus: SessionStatus): void {
  if (storedStatus !== 'running' && storedStatus !== 'starting') return
  if (readDurableState(entry.summary.id)) return
  const lastAt = reopenLastTurn(entry)
  if (lastAt === null) return
  closeOpenTurn(
    entry,
    'server_restart',
    'the server restarted before the harness returned a final response',
    'interrupted',
    lastAt,
  )
  publishSession(entry)
}

/**
 * Reopen the last prompted turn if it never got its main `result`, under its
 * original identity so whatever closes it groups with the work it closes rather
 * than becoming a new turn. Returns the time of its last event (the honest
 * lower bound for its duration), or null when there is nothing open.
 */
function reopenLastTurn(entry: Entry): number | null {
  const events = db.loadEvents(entry.summary.id, 3000)
  const user = [...events].reverse().find(
    (event) => event.ev.k === 'user'
      && event.turnId
      && event.ev.delivery !== 'queued'
      && event.ev.delivery !== 'cancelled'
      && event.ev.delivery !== 'failed',
  )
  if (!user?.turnId) return null
  const turn = events.filter((event) => event.turnId === user.turnId)
  if (turn.some((event) => event.ev.k === 'result' && !event.agentId)) return null
  const lastAt = turn.reduce((latest, event) => Math.max(latest, event.at), user.at)
  startTurn(entry, user.at, user.turnId)
  return lastAt
}

/**
 * The turn an event belongs to: the last one that had already begun when the
 * event happened.
 *
 * Time is the only thing every harness agrees on here — an event carries when it
 * occurred (a transcript line brings its own timestamp) — so an event that
 * predates the current turn is an event of the previous one, however late it
 * reaches us. Nothing before the first turn gets an id at all: a session restored
 * from disk, a system line at spawn, an error before any prompt belong to no turn,
 * and saying so is better than filing them under the next one.
 */
function turnIdFor(entry: Entry, at: number): string | undefined {
  for (let index = entry.turns.length - 1; index >= 0; index -= 1) {
    const turn = entry.turns[index]!
    if (turn.startedAt <= at) return turn.id
  }
  return undefined
}

/**
 * Reopen the last turn for a harness that carries on after its result.
 *
 * Only a turn whose main result this process has seen: that is the turn the
 * wake-up belongs to (events are filed under it by time anyway). A completed
 * ledger row goes back to `running`; one still waiting on children was never
 * closed. Returns false when there is nothing to reopen, and the caller starts
 * a fresh turn as before.
 */
function reopenSettledTurn(entry: Entry): boolean {
  const current = entry.turns.at(-1)
  if (!current?.resultSeen) return false
  const at = Date.now()
  const persisted = db.getTurn(current.id)
  if (persisted && persisted.state !== 'completed' && persisted.state !== 'running' && persisted.state !== 'starting') {
    return false
  }
  if (persisted?.state === 'completed' && !db.reopenTurn(current.id, current.runToken, at)) return false
  current.resultSeen = false
  entry.turnOpen = true
  entry.providerSettledTurnId = null
  turnFrame(entry, {
    id: current.id,
    sessionId: entry.summary.id,
    runToken: current.runToken,
    status: 'running',
    startedAt: current.startedAt,
  })
  return true
}

/** The harness reported the end of its turn: later events start a new one. */
function endTurn(entry: Entry): void {
  entry.turnOpen = false
}

function updateCurrentTurn(
  entry: Entry,
  status: TurnStatus,
  outcome: TurnRecord['outcome'] = null,
  subtype: string | null = null,
  endedAt = Date.now(),
): boolean {
  const current = entry.turns.at(-1)
  if (!current) return false
  const turn: TurnRecord = {
    id: current.id,
    sessionId: entry.summary.id,
    runToken: current.runToken,
    status,
    startedAt: current.startedAt,
    endedAt,
    outcome,
    subtype,
  }
  const updated = updateLedgerTurn(current.id, {
    runToken: current.runToken,
    status,
    endedAt,
    outcome,
    subtype,
    updatedAt: endedAt,
  } as Partial<TurnRecord>)
  if (!updated) return false
  turnFrame(entry, turn)
  return true
}

/**
 * Supply the boundary a harness failed to supply.
 *
 * `status` is a lifecycle fact, while `result` is the transcript boundary the
 * client uses for duration and grouping. Most harnesses send both, but a process
 * exit, a broken stream or an explicit stop can only send the first. Keeping the
 * fallback here makes every driver behave the same and uses the manager's turn
 * clock instead of the timestamp of an arbitrary last row.
 */
function closeOpenTurn(
  entry: Entry,
  subtype: string,
  text: string,
  outcome: 'completed' | 'interrupted' | 'failed',
  at = Date.now(),
): void {
  if (!entry.turnOpen) return
  const turn = entry.turns.at(-1)
  const startedAt = turn?.startedAt ?? at
  emit(
    entry,
    {
      k: 'result',
      outcome,
      subtype,
      text,
      durationMs: Math.max(0, at - startedAt),
      costUsd: 0,
      costReported: false,
    },
    `local:result:${turn?.id ?? crypto.randomUUID()}`,
    at,
  )
  const status: TurnStatus = outcome === 'completed' ? 'completed' : outcome === 'interrupted' ? 'cancelled' : 'failed'
  updateCurrentTurn(entry, status, outcome, subtype, at)
}

function finishActiveActors(entry: Entry, status: Extract<ActorStatus, 'failed' | 'cancelled'>, at = Date.now()): void {
  const turnId = entry.turns.at(-1)?.id
  if (!turnId) return
  for (const actor of db.listActors(entry.summary.id, turnId)) {
    if (actor.status !== 'starting' && actor.status !== 'running') continue
    const record: ActorRecord = {
      id: actor.id,
      sessionId: actor.sessionId,
      turnId: actor.turnId,
      parentActorId: actor.parentActorId,
      spawnEventId: actor.spawnEventId,
      ownership: actor.ownership,
      provider: actor.provider,
      title: actor.title,
      description: actor.description,
      model: actor.model,
      status,
      updatedAt: at,
    }
    ledgerActor(record)
    actorFrame(entry, record)
  }
}

/**
 * End, on the record, every agent that died with its process.
 *
 * A subagent lives inside the harness process. When a stop (or a crash, or a
 * restart) takes that process down, the agent goes with it — but nothing ever
 * said so: its last word was a provisional "running" row, and the UI could not
 * tell an agent that was cut off from a background one still working. Each one
 * gets a real `subagent_end` with status `stopped`, under the turn it belongs
 * to, and its ledger row is closed. `alive` keeps agents that may still be
 * running (see `reconcileHistory`).
 */
/**
 * The moment an agent cut off by a stop, a crash or a restart is recorded as
 * ending: its last own activity, never earlier than its launch, and never
 * later than the moment the stop happened.
 */
function stoppedAt(sessionId: string, agentId: string, startedAt: number, stoppedAt: number): number {
  const last = agentId ? db.lastAgentActivity(sessionId, agentId) : null
  const floor = startedAt > 0 ? startedAt : stoppedAt
  return Math.min(stoppedAt, Math.max(floor, last ?? floor))
}

function stopLiveAgents(entry: Entry, alive: (actor: db.ActorRow) => boolean = () => false, at = Date.now()): void {
  for (const actor of db.listActors(entry.summary.id)) {
    if (actor.ownership !== 'provider') continue
    if (actor.status !== 'starting' && actor.status !== 'running') continue
    if (alive(actor)) continue
    const start = actor.spawnEventId ? db.getEvent(entry.summary.id, actor.spawnEventId) : null
    if (start?.ev.k === 'subagent_start') {
      // It ended when it was last heard from, not when we noticed: a restart
      // days later used to stamp "now" on it, and the card and its turn read
      // as having run for days.
      const endedAt = stoppedAt(entry.summary.id, actor.id, start.at, at)
      emit(
        entry,
        {
          k: 'subagent_end',
          toolId: start.ev.toolId,
          agentId: actor.id,
          status: 'stopped',
          durationMs: Math.max(0, endedAt - start.at),
          toolUses: 0,
          result: '',
        },
        `subagent_end:${start.ev.toolId}`,
        endedAt,
        actor.id,
        undefined,
        undefined,
        actor.turnId,
      )
    }
    // The emit closes the row of the turn it was filed under; a row without a
    // card (or filed elsewhere) is closed directly.
    ledgerActor({
      id: actor.id,
      sessionId: actor.sessionId,
      turnId: actor.turnId,
      parentActorId: actor.parentActorId,
      spawnEventId: actor.spawnEventId,
      ownership: actor.ownership,
      provider: actor.provider,
      title: actor.title,
      description: actor.description,
      model: actor.model,
      status: 'cancelled',
      updatedAt: at,
    })
  }
}

/**
 * Repair what an earlier build did to a session's history, once per boot.
 *
 * A respawned Claude driver re-read the whole transcript and its results reused
 * the ids of the first turn's results. That (1) rewrote old subagent cards with
 * the time of the re-read, (2) overwrote old turns' results with the new turn's
 * and filed them under the old turn, and (3) re-registered every old agent as a
 * `starting` actor of the new turn, which then waited on them forever. The
 * causes are fixed; this undoes the damage from the rows themselves and is
 * idempotent. What cannot be recovered: the original payload of an overwritten
 * result (only the stream ever carried it).
 */
function reconcileHistory(entry: Entry): void {
  const id = entry.summary.id
  const at = Date.now()
  try {
    db.repairSpawnTimes(id)
    db.repairResumedRuns(id, at)
    // A result that came after its turn had closed *and* after a later turn had
    // begun is that later turn's result filed under an old id: a cycle's result
    // always precedes the next prompt on the stream. (A wake-up cycle's result
    // after its own turn's close, with no newer turn yet, stays where it is.)
    const turns = db.listTurns(id)
    const byId = new Map(turns.map((turn) => [turn.id, turn]))
    for (const result of db.loadEventsOfKind(id, 'result')) {
      if (result.agentId || !result.turnId) continue
      const turn = byId.get(result.turnId)
      if (!turn?.completedAt || result.at <= turn.completedAt + 1000) continue
      const owner = [...turns].reverse().find((candidate) => candidate.startedAt <= result.at)
      if (owner && owner.id !== turn.id) db.setEventTurn(id, result.id, owner.id)
    }
    db.closeDuplicateActors(id, at)
    db.dropUnclaimedPromptEchoes(id)
    db.fileTurnlessEvents(id)
    // Agents older than the process now running cannot be running: they died
    // with the process they belonged to. Without a process, none can.
    const durable = readDurableState(id)
    stopLiveAgents(entry, (actor) => Boolean(durable && actor.createdAt >= durable.startedAt), at)
    // And a card whose ledger row was closed without a visible end (an older
    // build closed rows and wrote nothing) still reads "running": the agent is
    // gone, and the card says so now — with the same age rule.
    for (const { start, createdAt } of db.unfinishedAgentCards(id)) {
      if (durable && (createdAt ?? start.at) >= durable.startedAt) continue
      if (start.ev.k !== 'subagent_start') continue
      // What the last provisional row knew is kept: it is how far the agent got.
      const prior = db.getEvent(id, `subagent_end:${start.ev.toolId}`)
      const known = prior?.ev.k === 'subagent_end' ? prior.ev : null
      const endedAt = stoppedAt(id, start.ev.agentId, start.at, at)
      emit(
        entry,
        {
          k: 'subagent_end',
          toolId: start.ev.toolId,
          agentId: start.ev.agentId,
          status: 'stopped',
          durationMs: known?.durationMs || Math.max(0, endedAt - start.at),
          toolUses: known?.toolUses ?? 0,
          result: '',
        },
        `subagent_end:${start.ev.toolId}`,
        endedAt,
        start.ev.agentId,
        undefined,
        undefined,
        start.turnId,
      )
    }
    // A turn that has its main result and nothing left working is complete,
    // whatever state the row was left in — except the one a live process may
    // still be answering.
    const events = db.loadEventsOfKind(id, 'result')
    const busyTurn = durable?.busy ? turns.at(-1)?.id : undefined
    for (const turn of db.listTurns(id)) {
      if (turn.state !== 'starting' && turn.state !== 'running') continue
      if (turn.id === busyTurn || db.hasActiveActors(id, turn.id)) continue
      const last = events.filter((event) => event.turnId === turn.id && !event.agentId).at(-1)
      if (!last) continue
      db.advanceTurn(turn.id, turn.runToken, 'completed', 'end_turn', last.at)
    }
  } catch (err) {
    console.error(`sedano: could not reconcile the history of ${id}:`, err)
  }
}

/** Settle a clean provider boundary only after every child actor has settled. */
function settleCompletedTurn(entry: Entry, generation: number, at = Date.now()): boolean {
  if (!isCurrent(entry, generation)) return false
  const current = entry.turns.at(-1)
  if (!current) {
    entry.providerSettledTurnId = null
    entry.meter.endTurn()
    entry.turnActive = false
    setStatus(entry, generation, 'idle')
    return true
  }
  if (db.hasActiveActors(entry.summary.id, current.id)) {
    entry.providerSettledTurnId = current.id
    entry.turnActive = true
    setStatus(entry, generation, 'running')
    return false
  }

  entry.providerSettledTurnId = null
  entry.meter.endTurn()
  if (current.resultSeen) {
    // The harness' own word on how the turn ended: an interrupt answered with
    // an "interrupted" result is a stopped turn, on every harness, not a
    // completed one.
    const outcome = current.resultOutcome ?? 'completed'
    updateCurrentTurn(
      entry,
      outcome === 'interrupted' ? 'cancelled' : outcome === 'failed' ? 'failed' : 'completed',
      outcome,
      outcome === 'completed' ? 'end_turn' : outcome,
      at,
    )
  } else {
    closeOpenTurn(
      entry,
      'end_turn',
      'the harness finished without returning a result frame',
      'completed',
      at,
    )
  }
  endTurn(entry)
  disarmInterrupt(entry)
  entry.turnActive = false
  setStatus(entry, generation, 'idle')
  void drainQueue(entry, generation)
  return true
}

function emit(
  entry: Entry,
  ev: TimelineEvent,
  id?: string,
  at?: number,
  agentId?: string,
  parentEventId?: string,
  parentAgentId?: string,
  explicitTurnId?: string,
): void {
  // A session that has been deleted has no timeline to write to: an event from a
  // process still winding down must not recreate its rows.
  if (!isLive(entry)) return
  const when = at ?? Date.now()
  // Drivers only need to state the relationship once, on the spawn. From then
  // on every event attributed to that child carries the same parent, including
  // transcript lines that arrive through a different poller. Historical rows
  // simply keep these fields absent and remain valid replay input.
  const inheritedParentAgentId = parentAgentId ?? (agentId ? entry.agentParents.get(agentId) : undefined)
  // The row this may rewrite. A respawned driver re-reads the whole transcript,
  // so most of what it says on the way up is history: that history keeps the
  // turn it was filed under and the time it happened, and it is not news for
  // the actor ledger — re-registering it filed every old agent under the new
  // turn as `starting`, and the new turn could never settle.
  const stored = id ? db.getEvent(entry.summary.id, id) : null
  // A transcript copy of a prompt sedano delivered itself is not a second
  // message. The driver that sent it claims its own echoes, but only that
  // driver: a respawned or reattached one re-reads the whole transcript, and
  // every earlier prompt came back as a new bubble — with no turn, since it
  // predates everything the new process started. The prompt event is the one
  // truth, whichever driver is reading.
  // The harness saw the documents inline (see `withDocuments`); the prompt
  // event keeps only what was typed, so that is what the copy is matched on.
  if (!stored && ev.k === 'user' && id && !id.startsWith('prompt:') && db.isPromptEcho(entry.summary.id, splitDocuments(ev.text).text, when)) return
  // A re-read card can know less than the one stored (a sidecar without the
  // type, a spawn call without the resolved model): it may fill the card in,
  // never empty it.
  if (stored?.ev.k === 'subagent_start' && ev.k === 'subagent_start') ev = mergeSpawnCard(stored.ev, ev)
  const rewritesHistory = Boolean(stored && stored.turnId && stored.turnId !== entry.turns.at(-1)?.id)
  const payloadChanged = !stored || JSON.stringify(stored.ev) !== JSON.stringify(ev)
  const event: SessionEvent = {
    id: id ?? `${entry.summary.id}:auto:${entry.seq + 1}`,
    sessionId: entry.summary.id,
    seq: stored ? stored.seq : ++entry.seq,
    // Same rule as the store (see `db.insertEvent`): never later, except an ending.
    at: stored && ev.k !== 'subagent_end' ? Math.min(stored.at, when) : when,
    agentId,
    parentEventId,
    parentAgentId: inheritedParentAgentId,
    // A child agent's work — its sidechain and its end — belongs to the turn
    // that spawned it, however late it arrives: filing it by time put a
    // background agent's end into whatever turn was current by then, and the
    // spawning turn waited on it forever.
    // A stored row keeps the turn it was filed under — none included: an event
    // from before its session had a turn (the CLI's init line) does not join
    // whichever turn happens to be current when a respawn repeats it.
    turnId: stored ? stored.turnId : (explicitTurnId ?? spawnTurnOf(entry, ev, agentId, inheritedParentAgentId) ?? turnIdFor(entry, when)),
    ev,
  }
  if (ev.k === 'subagent_start' && ev.agentId && event.turnId) entry.agentTurns.set(ev.agentId, event.turnId)

  if (ev.k === 'subagent_start' && ev.agentId && inheritedParentAgentId) {
    entry.agentParents.set(ev.agentId, inheritedParentAgentId)
  }

  if (ev.k === 'subagent_start' && ev.agentId && !stored) {
    const actor: ActorRecord = {
      id: ev.agentId,
      sessionId: entry.summary.id,
      turnId: event.turnId ?? null,
      parentActorId: inheritedParentAgentId ?? null,
      spawnEventId: event.id,
      ownership: 'provider',
      provider: entry.summary.harness,
      title: ev.agentType,
      description: ev.description,
      model: ev.model ?? null,
      status: 'starting',
      updatedAt: when,
    }
    ledgerActor(actor)
    actorFrame(entry, actor)
  }
  // A background shell finishing is reported in the subagent shape, but it is
  // no actor: it never had a start, and a ledger row for it would be an agent
  // that never existed.
  if (ev.k === 'subagent_end' && ev.agentId && !ev.background && payloadChanged) {
    const status: ActorStatus = ev.status === 'done' ? 'completed' : ev.status === 'stopped' ? 'cancelled' : ev.status === 'running' ? 'running' : 'failed'
    const actor: ActorRecord = {
      id: ev.agentId,
      sessionId: entry.summary.id,
      turnId: event.turnId ?? null,
      parentActorId: entry.agentParents.get(ev.agentId) ?? null,
      ownership: 'provider',
      provider: entry.summary.harness,
      status,
      updatedAt: when,
    }
    ledgerActor(actor)
    actorFrame(entry, actor)
  }

  // A main result closes the provider's output stream, but not necessarily the
  // whole execution: provider-owned child actors may still be working. Keep
  // that distinction on the turn so the last child can settle it without
  // fabricating a second result.
  if (ev.k === 'result' && !agentId && !rewritesHistory) {
    const current = entry.turns.at(-1)
    if (current && event.turnId === current.id) {
      current.resultSeen = true
      current.resultOutcome = resultOutcomeOf(ev)
    }
    endTurn(entry)
  }
  const { changed, seq } = db.insertEvent(event)
  event.seq = seq
  // A main result or reply, or a child ending, can move the turn's phase.
  if (changed && ((!agentId && (ev.k === 'result' || ev.k === 'assistant')) || ev.k === 'subagent_end')) {
    publishTurn(entry, event.turnId)
  }

  // The tab is named after what the user first asked for, not after the folder.
  if (ev.k === 'user' && entry.summary.kind === 'agent' && !entry.summary.title) {
    // A message that is only a document is named after the document.
    const text = (splitDocuments(ev.text).text || ev.attachments?.find(isDocument)?.name || '').replace(/\s+/g, ' ').trim()
    if (text) entry.summary.title = text.length > 64 ? `${text.slice(0, 64)}…` : text
  }

  // The first message is what makes a session exist in the rail.
  if (ev.k === 'user' && entry.summary.kind === 'agent' && !entry.summary.started) {
    entry.summary.started = true
    publishSession(entry)
  }

  entry.summary.updatedAt = Date.now()

  recordOwnership(entry, event)

  if (changed) broadcastSession(entry.summary.id, { t: 'event', sessionId: entry.summary.id, event })
  flushMetrics(entry)

  if (ev.k === 'subagent_end' && ev.status !== 'running') settleTurnOf(entry, event.turnId, when)
  if (
    ev.k === 'subagent_end'
    && ev.status !== 'running'
    && entry.providerSettledTurnId
    && event.turnId === entry.providerSettledTurnId
    && !db.hasActiveActors(entry.summary.id, entry.providerSettledTurnId)
  ) {
    settleCompletedTurn(entry, entry.generation, when)
  }
}

/** The turn a child agent was spawned in, for its own events and its end. */
function spawnTurnOf(entry: Entry, ev: TimelineEvent, agentId: string | undefined, parentAgentId?: string): string | undefined {
  // A card is filed where its own call was made. An agent can run more than
  // once — a stopped one is resumed by a later `SendMessage`, under that call —
  // and each run belongs to the turn that started it, not to the agent's first.
  if (ev.k === 'subagent_start') {
    const call = db.getEvent(entry.summary.id, `tool:${ev.toolId}`)
    if (call?.turnId) return call.turnId
    // A child spawned inside another agent's run, before its call is stored.
    const parent = parentAgentId ?? entry.agentParents.get(ev.agentId)
    return parent ? entry.agentTurns.get(parent) : undefined
  }
  const child = ev.k === 'subagent_end' ? ev.agentId : agentId
  if (!child || (ev.k === 'subagent_end' && ev.background)) return undefined
  // An ending names its run's call: that card's turn, whichever run it is.
  const start = ev.k === 'subagent_end' && ev.toolId ? db.getEvent(entry.summary.id, `subagent_start:${ev.toolId}`) : null
  if (start?.turnId) return start.turnId
  // Sidechain lines follow the agent's latest run (the map is kept by every
  // card this process has seen or restored).
  const known = entry.agentTurns.get(child)
  if (known) return known
  // Only an ending is worth a lookup: sidechain lines are many.
  if (ev.k !== 'subagent_end') return undefined
  const turnId = db.spawnTurnOfAgent(entry.summary.id, child)
  if (turnId) entry.agentTurns.set(child, turnId)
  return turnId ?? undefined
}

type SpawnCard = Extract<TimelineEvent, { k: 'subagent_start' }>

function mergeSpawnCard(stored: SpawnCard, next: SpawnCard): SpawnCard {
  const spawnedAt = [stored.spawnedAt, next.spawnedAt].filter((value): value is number => typeof value === 'number')
  return {
    ...next,
    agentType: next.agentType && next.agentType !== 'agent' ? next.agentType : stored.agentType,
    description: next.description || stored.description,
    prompt: next.prompt || stored.prompt,
    ...(next.model || stored.model ? { model: next.model || stored.model } : {}),
    ...(spawnedAt.length ? { spawnedAt: Math.min(...spawnedAt) } : {}),
  }
}

/**
 * The tool call every harness asks its questions through today.
 *
 * Claude's permission prompts and its structured questions, and both of ACP's
 * request shapes, all reach the timeline under this name, so this is where a
 * request becomes visible to the server. When the drivers start emitting the
 * `k:'request'` event the domain already defines, that becomes the signal and
 * this name stops being load-bearing.
 */
const QUESTION_TOOL = 'AskUserQuestion'

/**
 * What an event says about things that outlive it: a question that is now
 * waiting on the user, an answer that closed one, and the images a message
 * carries.
 *
 * Kept out of the driver on purpose. A question's state used to live only in the
 * continuation that was waiting for it, so it died with the process and came
 * back after a restart as a card that looked clickable and was not; an image had
 * no owner at all, so nothing could ever delete it. Both are facts about the
 * session, so they are written where the session is.
 */
function recordOwnership(entry: Entry, event: SessionEvent): void {
  const id = entry.summary.id
  const ev = event.ev
  if (ev.k === 'request') {
    db.openRequest(id, ev.requestId, ev.kind, event.at)
    if (ev.state !== 'pending') {
      db.closeRequest(
        id,
        ev.requestId,
        ev.state,
        ev.state === 'answered' ? (ev.answeredOptionId ?? null) : null,
        event.at,
      )
    }
    return
  }
  if (ev.k === 'tool' && ev.name === QUESTION_TOOL) {
    db.openRequest(id, ev.toolId, null, event.at)
    return
  }
  if (ev.k === 'tool_result') {
    // A result is the answer landing. Only a pending request is closed, so a
    // result for an ordinary tool call changes nothing here.
    db.closeRequest(id, ev.toolId, 'answered', ev.text)
    return
  }
  if (ev.k === 'user' && ev.attachments?.length) {
    db.bindAttachments(ev.attachments.map((item) => item.id), id, event.id)
  }
}

/** The persisted native request event, if this is not a historical tool card. */
function nativeRequestEvent(entry: Entry, requestId: string): SessionEvent | undefined {
  const event = db.getEvent(entry.summary.id, `request:${requestId}`)
  return event?.ev.k === 'request' ? event : undefined
}

/** Rewrite one native request in place, keeping its original timeline position. */
function updateNativeRequest(
  entry: Entry,
  requestId: string,
  state: 'answered' | 'expired' | 'cancelled',
  optionId?: string,
  reason?: string,
): boolean {
  const event = nativeRequestEvent(entry, requestId)
  if (!event || event.ev.k !== 'request') return false
  emit(
    entry,
    {
      ...event.ev,
      state,
      ...(optionId ? { answeredOptionId: optionId } : {}),
      ...(reason ? { closedReason: reason } : {}),
    },
    event.id,
    Date.now(),
    event.agentId,
    event.parentEventId,
    event.parentAgentId,
    event.turnId,
  )
  return true
}

/**
 * Close every question still waiting on this session, and say so in the
 * transcript.
 *
 * Two records, because they answer two different questions. The row is what the
 * server checks before accepting an answer; the `tool_result` is what the
 * transcript shows, and without it a replayed timeline still holds a question
 * with no answer under it — which is exactly the card that invited a click that
 * did nothing. The synthetic event has a deterministic id, so closing the same
 * request twice (a second restart, a stop after an expiry) rewrites one row
 * instead of stacking lines.
 */
function closePendingRequests(
  entry: Entry,
  state: 'expired' | 'cancelled',
  reason: string,
): string[] {
  const closed: string[] = []
  for (const row of db.pendingRequests(entry.summary.id)) {
    if (!db.closeRequest(entry.summary.id, row.toolId, state, null)) continue
    closed.push(row.toolId)
    // New sessions own a first-class request event. Historical sessions used an
    // AskUserQuestion tool call, so retain its closing result as a replay
    // compatibility path rather than rewriting old data into a new shape.
    if (!updateNativeRequest(entry, row.toolId, state, undefined, reason)) {
      emit(
        entry,
        { k: 'tool_result', toolId: row.toolId, text: reason, isError: false, truncated: false },
        `local:request:${state}:${row.toolId}`,
      )
    }
  }
  // Returned, because closing the *row* is only half of it: the agent that asked
  // may still be alive and blocked on the protocol request behind it, and the
  // driver that reattaches to it needs the ids to let it go.
  return closed
}

/**
 * The callbacks one driver gets, bound to the lifecycle it was started for.
 *
 * The generation is captured here rather than read when a callback fires,
 * because by then the entry may be on its third process: this is the one place
 * every driver callback passes through, so it is the one place that can tell a
 * living process from one the user already stopped. A callback of an old
 * generation is dropped in full — no event, no status, no persistence.
 */
function hooksFor(entry: Entry, generation: number): DriverHooks {
  const id = entry.summary.id
  const current = (): boolean => isCurrent(entry, generation)
  return {
    event: (ev, opts) => {
      if (!current()) return
      emit(
        entry,
        ev,
        opts?.id ?? (ev.k === 'request' ? `request:${ev.requestId}` : undefined),
        opts?.at,
        opts?.agentId,
        opts?.parentEventId,
        opts?.parentAgentId,
      )
    },

    delta: (key, kind, text, agentId) => {
      if (!current()) return
      entry.meter.addChars(text.length)
      // Which turn is being streamed, so the client can tell a buffer that
      // belongs to the turn on screen from one left over from the turn before.
      const turnId = turnIdFor(entry, Date.now())
      broadcastSession(id, { t: 'delta', sessionId: id, agentId, key, kind, text, ...(turnId ? { turnId } : {}) })
      flushMetrics(entry)
    },

    status: (status: SessionStatus) => {
      if (!current()) return
      // Already finished, for this lifecycle: nothing a late callback says can
      // reopen it (see `setStatus`), and nothing it says may release the queue.
      if (entry.terminalStatus) return
      // A cold adapter can announce that its handshake is idle before the
      // manager has delivered the already-accepted prompt. That is readiness,
      // not a turn result. Settling here writes a fake "end_turn" and the real
      // output is then filed under a second, promptless turn.
      if (status === 'idle' && entry.turnOpen && entry.turnActive && entry.spawn?.generation === generation && !entry.driver) {
        return
      }
      if (status === 'idle' || status === 'error' || status === 'stopped') {
        const at = Date.now()
        // Close the owner first. A clean provider boundary may still leave
        // provider-owned children active; those keep the turn and session live.
        const actorStatus: ActorStatus = status === 'idle' ? 'completed' : status === 'stopped' ? 'cancelled' : 'failed'
        const mainActor: ActorRecord = {
          id: `main:${entry.summary.id}`,
          sessionId: entry.summary.id,
          turnId: entry.turns.at(-1)?.id ?? null,
          ownership: 'sedano',
          provider: entry.summary.harness,
          status: actorStatus,
          updatedAt: at,
        }
        ledgerActor(mainActor)
        actorFrame(entry, mainActor)
        if (status === 'idle') {
          settleCompletedTurn(entry, generation, at)
          return
        }

        // A failed/stopped process cannot have living children after it. Mark
        // every actor terminal before closing the guarded turn so the durable
        // ledger and the UI reach the same state.
        // Every child agent died with the process, in this turn and in earlier
        // ones: each gets a real `stopped` end first (a cut-off agent, on every
        // harness), then the main actor's own row is closed.
        stopLiveAgents(entry, () => false, at)
        finishActiveActors(entry, status === 'stopped' ? 'cancelled' : 'failed', at)
        entry.meter.endTurn()
        if (entry.turnOpen) {
          closeOpenTurn(
            entry,
            status,
            `the harness ended in ${status} before returning a final response`,
            status === 'stopped' ? 'interrupted' : 'failed',
            at,
          )
        } else {
          updateCurrentTurn(
            entry,
            status === 'stopped' ? 'cancelled' : 'failed',
            status === 'stopped' ? 'interrupted' : 'failed',
            status,
            at,
          )
        }
        endTurn(entry)
        disarmInterrupt(entry)
        entry.turnActive = false
        entry.providerSettledTurnId = null
      }
      setStatus(entry, generation, status)
      // A turn that ended cleanly is what a queued prompt was waiting for. A turn
      // that ended badly is not: see `discardQueue` for why the queue goes with it.
      // A failed turn whose harness is still there is not a reason to drop what
      // the user queued behind it — the native CLIs run the next message after
      // an error too — so the queue moves on, and the failure stays on record in
      // its own turn. A harness that has gone takes the queue with it, said so.
      if (status === 'error' && entry.driver?.alive) void drainQueue(entry, generation)
      else if (status === 'error' || status === 'stopped') {
        discardQueue(entry, `the turn ended in ${status}`)
      }
    },

    model: (model) => {
      if (!current()) return
      // A sentinel is not a confirmation. Claude Code stamps the messages it
      // fabricates with `"model": "<synthetic>"`, and a driver that passes one
      // through — this hook is the one door every harness uses — would put it in
      // the summary, the stored row, the rail and the picker, where it was
      // offered as something you could switch to. The session keeps what it had;
      // "no model produced this" is not the name of a model.
      if (isPlaceholderModel(model)) return
      // A window stated for the previous model says nothing about this one: it
      // stands as an estimate until the harness states the new one.
      if (entry.summary.model && entry.summary.model !== model) entry.contextWindowInferred = true
      // The harness naming its own model is a confirmation, and the only one the
      // driver contract offers: whatever was requested, this is what is running.
      entry.summary.model = model
      entry.opts = { ...entry.opts, model }
      if (entry.pending?.model !== undefined) {
        const { model: _requested, ...rest } = entry.pending
        entry.pending = Object.keys(rest).length ? rest : null
        if (entry.pending) entry.summary.pendingOptions = entry.pending
        else delete entry.summary.pendingOptions
      }
      publishSession(entry)
    },

    usage: (usage: Partial<TokenUsage>, opts) => {
      if (!current()) return
      // A turn total is only ever the turn's closing number (see `commitTurn`);
      // a per-call report is also the conversation's size.
      if (opts?.perMessage) entry.meter.addUsage(usage)
      // The window comes from the driver, which knows where its harness states
      // one (claude's `modelUsage`, ACP's `usage_update.size`) or which table
      // its CLI divides by. No name-based guess is made here: one table for
      // every harness gave gpt-5.6-sol 258k on Command Code, where it has 1.05M,
      // and a harness that says nothing is shown as saying nothing.
      const window = opts?.contextWindow ?? 0
      const inferred = opts?.contextWindowInferred === true
      // A window is only worth publishing next to a size. A harness that reports
      // turn totals and never the conversation's size has not said how full it
      // is, and a window alone turned that silence into a ring.
      const measured = (opts?.contextTokens ?? 0) > 0 || entry.meter.hasContextTokens
      // A window the harness stated is not replaced by a guess made later.
      const keepStated = inferred && entry.meter.hasContextWindow && !entry.contextWindowInferred
      if (window && measured && !keepStated) {
        // Which of the two it is, recorded rather than smoothed over: the ring is
        // drawn differently for a window we inferred (see
        // `SessionMetrics.contextWindowInferred`).
        entry.contextWindowInferred = inferred
        // A harness that reports the conversation's own size (ACP's `usage_update`)
        // is believed over the arithmetic: it is the number it is working with.
        entry.meter.setContext(opts?.contextTokens ?? 0, window)
      } else if (opts?.contextTokens) {
        entry.meter.setContext(opts.contextTokens, 0)
      }
      // Being told `$0.00` is being told: a free turn has a price, and testing
      // the number for truthiness filed that answer under "never reported".
      if (opts?.costUsd !== undefined) entry.meter.addCost(opts.costUsd)
      if (opts?.commitTurn) entry.meter.commitTurn(usage)
      flushMetrics(entry, true)
      saveMetrics(entry, opts?.commitTurn === true)
    },

    usageReplay: () => {
      if (!current()) return
      entry.meter.resetTokens()
    },

    tokens: (count: number) => {
      if (!current()) return
      entry.meter.addTokens(count)
      flushMetrics(entry)
    },

    nativeId: (nativeId) => {
      if (!current()) return
      entry.summary.nativeId = nativeId
      entry.summary.transcriptPath =
        entry.summary.harness === 'claude' ? claudeTranscriptPath(entry.summary.cwd, nativeId) : null
      // Published, so it is written down the moment the harness says it: the
      // native id is how this session is reopened, and a crash before the next
      // unrelated event used to lose it.
      publishSession(entry)
    },

    resumeHint: (hint) => {
      if (!current()) return
      entry.summary.resumeHint = hint
      // Same reason as `nativeId`: the resume command is the session's way back.
      // It used to be set in memory only and saved by accident, if some later
      // event happened to persist the row before the process ended.
      publishSession(entry)
    },

    title: (title) => {
      if (!current()) return
      // A derived title (the first prompt, a transcript `summary` record) is a
      // guess. A respawned or reattached driver re-reads the whole transcript and
      // makes the same guess again, and it used to land on top of the name the
      // user gave the session — every restart undid every rename.
      if (entry.summary.titleSource === 'user') return
      entry.summary.title = title
      publishSession(entry)
    },

    error: (message) => {
      if (!current()) return
      entry.meter.endTurn()
      emit(entry, { k: 'error', text: message }, `error:${id}:${entry.seq + 1}`)
    },

    turnStarted: () => {
      if (!current()) return
      if (entry.terminalStatus) return
      entry.meter.beginTurn()
      // Normally the prompt already opened the turn (see `sendMessage`); this
      // covers a turn the harness starts on its own — a resumed session picking
      // up, a queued prompt the driver released — so its events still get an id.
      // A harness that wakes up after the turn's result (its background agents
      // finished) is still answering the same prompt: that turn is reopened
      // rather than a promptless one started, and its row closes again at the
      // real final result instead of at the last child's end.
      if (!entry.turnOpen && !reopenSettledTurn(entry)) startTurn(entry)
      // A deadline left over from an earlier interrupt belongs to the turn it
      // was asked to end, not to this one.
      disarmInterrupt(entry)
      entry.turnActive = true
      const mainActor: ActorRecord = {
        id: `main:${entry.summary.id}`,
        sessionId: entry.summary.id,
        turnId: entry.turns.at(-1)?.id ?? null,
        ownership: 'sedano',
        provider: entry.summary.harness,
        title: entry.summary.title || entry.summary.harness,
        model: entry.summary.model,
        status: 'running',
        updatedAt: Date.now(),
      }
      ledgerActor(mainActor)
      actorFrame(entry, mainActor)
      setStatus(entry, generation, 'running')
    },

    meta: (meta) => {
      if (!current()) return
      let changed = false
      if (meta.gitBranch && meta.gitBranch !== entry.summary.gitBranch) {
        entry.summary.gitBranch = meta.gitBranch === 'HEAD' ? 'detached HEAD' : meta.gitBranch
        changed = true
      }
      if (meta.permissionMode && entry.summary.permissionMode === defaultPermissionMode()) {
        // Only adopt what the harness reports while we are still on the default.
        entry.summary.permissionMode = meta.permissionMode as PermissionMode
        changed = true
      }
      if (changed) publishSession(entry)
    },

    terminal: (data, offset) => {
      broadcastSession(id, offset === undefined ? { t: 'term', sessionId: id, data } : { t: 'term', sessionId: id, data, offset })
    },

    processExited: () => {
      if (!current()) return
      stopLiveAgents(entry)
    },

    limits: (windows, meta) => {
      publishLimits({
        harness: entry.summary.harness,
        plan: meta.plan ?? null,
        windows,
        credits: meta.credits ?? null,
        updatedAt: Date.now(),
        error: meta.error ?? null,
      })
    },
  }
}

async function ensureDriver(entry: Entry): Promise<Driver | null> {
  if (entry.driver?.alive) return entry.driver
  const adapter = getAdapterFor(entry.summary.kind, entry.summary.harness)
  if (!adapter) return null
  const generation = entry.generation
  // A spawn already in flight is shared, so a second prompt typed while the
  // first is still starting waits for the same process instead of being lost —
  // but only within the lifecycle that asked for it: after a stop, joining the
  // cancelled spawn would hand the prompt to a process on its way out.
  if (entry.spawn?.generation === generation) return entry.spawn.promise

  const previous = entry.driver
  entry.driver = null
  const abort = new AbortController()
  entry.spawnAbort = abort
  const promise = (async (): Promise<Driver | null> => {
    try {
      // Reopening an existing native session keeps history and continues it.
      // A process is started with what the user last asked for, pending changes
      // included: this is the respawn that applies them, atomically, at the start
      // of the turn that needed it.
      const wanted = wantedOptions(entry)
      // Remembered because the handshake below can name the model itself, and
      // the commit afterwards must be able to tell that apart (see `commitPending`).
      const modelBeforeSpawn = entry.summary.model
      const opts: CreateOptions = {
        ...entry.opts,
        sessionId: entry.summary.id,
        nativeId: entry.summary.nativeId,
        preset: entry.summary.preset,
        ...wanted,
        ...(entry.attach ? { attach: true, pendingRequests: entry.pendingRequests } : {}),
        // Nothing stored yet for a native session: it was just imported, and
        // what the harness replays on reopening is its history.
        replayHistory: Boolean(entry.summary.nativeId) && db.maxSeq(entry.summary.id) === 0,
      }
      // One creation only: whatever happens next, the process this session gets
      // after it is one this server started.
      entry.attach = false
      entry.pendingRequests = []
      const driver = await adapter.create(opts, hooksFor(entry, generation))
      // A handshake can take seconds, and a stop or a delete during it is a
      // decision that was made before this process existed. Keeping the driver
      // here is what left a killed session with a live process behind it and put
      // a deleted session's row back in the database on the next publish, so the
      // process that nobody asked for any more is ended and nothing is published.
      if (abort.signal.aborted || !isCurrent(entry, generation)) {
        driver.stop()
        return null
      }
      entry.driver = driver
      // The process is up with those flags, so they are no longer a request.
      commitPending(entry, wanted, modelBeforeSpawn)
      publishSession(entry)
      return driver
    } catch (err) {
      if (!isCurrent(entry, generation)) return null
      const message = err instanceof Error ? err.message : String(err)
      // Provider catalogs can change between opening the picker and starting a
      // session. Keep the failure honest, but immediately replace the stale
      // choice list instead of leaving the next attempt to fail the same way.
      if (/\b(?:unknown|invalid|unsupported|not found)\b.{0,80}\bmodel\b|\bmodel\b.{0,80}\b(?:unknown|invalid|unsupported|not found)\b/i.test(message)) {
        const adapterForRefresh = getAdapter(entry.summary.harness)
        scheduleModelRefresh(entry.summary.host, entry.summary.harness, adapterForRefresh, true, true)
      }
      emit(entry, { k: 'error', text: `could not start ${entry.summary.harness}: ${message}` })
      setStatus(entry, generation, 'error')
      return null
    } finally {
      if (entry.spawn?.generation === generation) entry.spawn = null
      if (entry.spawnAbort === abort) entry.spawnAbort = null
      // A driver that is not alive still owns resources — a transcript reader,
      // a tmux tailer, a child process. Replacing it must release them.
      if (previous && previous !== entry.driver) previous.stop()
    }
  })()
  entry.spawn = { generation, promise }
  return promise
}

/* ------------------------------------------------------------------ */
/* Per-session serialization                                           */
/* ------------------------------------------------------------------ */

/**
 * Run one asynchronous operation on a session at a time.
 *
 * Sending, draining the queue and creating all await a spawn, and two of them
 * interleaved could each decide the session was free and each hand it a prompt.
 * A promise chain per entry is all this needs — no library, no lock object — and
 * the synchronous operations (stop, delete, interrupt, configure) do not join it:
 * they bump the generation instead, which is what makes whatever is already on
 * the chain harmless when it resumes.
 */
function runExclusive<T>(entry: Entry, operation: () => Promise<T>): Promise<T> {
  const run = entry.chain.then(operation, operation)
  entry.chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export function restore(): void {
  // The ACP agents' model lists live in the store: without this the picker is
  // empty after every restart until a session of that harness happens to run.
  loadCachedModels()
  const renames = db.ledgerRenames()
  for (const row of db.loadSessions()) loadEntry(row, renames.get(row.id))
  removeOrphanedChildren()
  sweepOrphanAgents()
}

/**
 * Bring one stored session into memory, stopped, the way a boot does. Shared
 * by `restore` and `unarchiveSession`: an unarchived session must come back
 * exactly as one that was never away.
 */
function loadEntry(row: db.SessionRow, renamed?: string): Entry {
  const summary = summaryFromRow(row)
  recoverRename(summary, renamed)
  // Sessions stored before titles meant anything get theirs from their own
  // transcript, so the rail is useful immediately after an upgrade.
  if (!summary.title && summary.kind === 'agent') {
    const first = db.loadEvents(summary.id, 200).find((event) => event.ev.k === 'user')
    if (first && first.ev.k === 'user') {
      const text = splitDocuments(first.ev.text).text.replace(/\s+/g, ' ').trim()
      if (text) summary.title = text.length > 64 ? `${text.slice(0, 64)}…` : text
    }
  }
  const entry: Entry = {
    summary,
    meter: new Meter(),
    driver: null,
    opts: {
      sessionId: summary.id,
      nativeId: summary.nativeId,
      cwd: summary.cwd,
      host: summary.host,
      model: summary.model,
      effort: summary.effort,
      permissionMode: summary.permissionMode,
    },
    seq: db.maxSeq(summary.id),
    // A restored session has no live turn: the turns it had are history in the
    // database, and the next prompt opens a fresh one.
    turns: [],
    turnOpen: false,
    agentParents: restoredAgentParents(summary.id),
    lastFlush: 0,
    lastMetricsSave: 0,
    contextWindowInferred: false,
    generation: 1,
    spawn: null,
    spawnAbort: null,
    terminalStatus: null,
    turnActive: false,
    providerSettledTurnId: null,
    // A prompt that was waiting when the server went down is still waiting: the
    // user was told it would be sent, and a restart is not an answer.
    queue: recoverableQueue(summary.id),
    chain: Promise.resolve(),
    pending: null,
    interruptTimer: null,
    attach: false,
    pendingRequests: [],
    turnViews: new Map(),
    continuedTurns: new Set(),
    agentTurns: new Map(),
  }
  // Nothing is attached yet: drivers are respawned lazily on the next message,
  // or reattached below when the agent they left behind is still working.
  summary.status = 'stopped'
  restoreMetrics(entry)
  summary.metrics = snapshotOf(entry)
  summary.queuedPrompts = entry.queue.length
  entries.set(summary.id, entry)
  reconcileHistory(entry)
  // Each agent's latest run, once the history is repaired: a resumed agent's
  // later lines belong to the turn that resumed it.
  const starts = db.loadEventsOfKind(summary.id, 'subagent_start').sort((a, b) => a.at - b.at || a.seq - b.seq)
  for (const start of starts) {
    if (start.ev.k === 'subagent_start' && start.ev.agentId && start.turnId) entry.agentTurns.set(start.ev.agentId, start.turnId)
  }
  seedLastTurn(entry)
  closeInterruptedTurn(entry, row.status)
  // A question that was waiting when this server went away cannot be answered
  // any more: the continuation that knew what each answer meant went with the
  // process that owned it. Saying so here is what stops a restored transcript
  // from offering a card whose buttons lead nowhere — and the ids travel on to
  // the reattach, which is what unblocks an agent still waiting for one.
  const closed = closePendingRequests(
    entry,
    'expired',
    'not answered — sedano restarted and the agent that asked was gone',
  )
  if (summary.kind === 'agent' && readDurableState(summary.id)) void reattach(entry, closed)
  return entry
}

/**
 * Give a session back the name the user gave it, when an earlier build lost it.
 *
 * Before titles had a source, every respawn and reattach re-derived the title
 * from the transcript and saved it over the rename. The rename commands are
 * still in the ledger with their title, so a session whose row is not marked as
 * user-named but has a rename on record takes the last one back. Idempotent: a
 * repaired row is marked `user` and is not looked at again.
 */
function recoverRename(summary: SessionSummary, renamed: string | undefined): void {
  if (summary.titleSource === 'user' || !renamed) return
  summary.title = renamed
  summary.titleSource = 'user'
  db.patchSession(summary.id, { title: renamed, title_source: 'user' })
  console.log(`sedano: restored the name "${renamed}" of session ${summary.id}`)
}

/**
 * A docked terminal belongs to its agent session and goes with it. The delete
 * takes it along (see `removeSession`); this is for one whose parent was
 * removed another way — by an older build, or while this one was down.
 */
function removeOrphanedChildren(): void {
  for (const entry of [...entries.values()]) {
    const parent = entry.summary.parentSessionId
    if (parent && !db.getSessionRow(parent)) removeSession(entry.summary.id)
  }
}

/**
 * Give a restored session its last ledger turn back.
 *
 * A restored entry used to start with no turns at all, so everything the next
 * few seconds said — the "reattached" note, the reattached process' own output,
 * a busy CLI announcing its turn — belonged to no turn, or to a brand new
 * promptless one. The last turn is where that work is, open if the ledger says
 * it has not ended and its main loop has not returned.
 */
function seedLastTurn(entry: Entry): void {
  // The recent turns, not only the last: a reattached or respawned process
  // re-reads its whole transcript, and a line from an hour ago belongs to the
  // turn that was running an hour ago — with only the last turn known, every
  // older line came back with no turn at all.
  const rows = db.listTurns(entry.summary.id).slice(-TURN_MEMORY)
  const last = rows.at(-1)
  if (!last) return
  const facts = db.turnFacts(entry.summary.id)
  for (const row of rows) {
    entry.turns.push({ id: row.id, startedAt: row.startedAt, runToken: row.runToken, resultSeen: Boolean(facts.get(row.id)?.resultEventId) })
  }
  const resultSeen = Boolean(facts.get(last.id)?.resultEventId)
  entry.turnOpen = (last.state === 'starting' || last.state === 'running') && !resultSeen
}

/**
 * Pick a session's agent back up, if it really is still working.
 *
 * The check comes first and it is a question put to the machine the agent runs
 * on, not an inference from the note on disk: a note outlives a crash, and a
 * session whose process is genuinely gone must be reported as gone rather than
 * shown as running forever. Only an answered "yes" leads to a driver; a "no"
 * cleans up, and a host that could not be reached is left alone for the next
 * prompt to sort out.
 */
async function reattach(entry: Entry, pendingRequests: string[]): Promise<void> {
  const state = readDurableState(entry.summary.id)
  if (!state) return
  const alive = await durableAlive(state)
  // A host that could not be asked is left alone, as promised above: clearing
  // the note here used to forget the only record of a process that may still
  // be running there, so neither a delete nor the orphan sweep could find it.
  if (alive === null) return
  if (alive === false && state.harness === 'commandcode' && isLive(entry)) {
    await recoverFinishedTurn(entry)
    return
  }
  if (alive === false) {
    // A process that ended while we were away. Claude's answer is in its own
    // transcript, so these files are the last thing it left on that machine.
    await durableDestroy(state)
    clearDurableState(entry.summary.id)
    if (!isLive(entry)) return
    // Its agents ended with it, and a turn it never finished ends here: the
    // turn would otherwise stay open (and waiting) for a process that is gone.
    stopLiveAgents(entry)
    if (entry.turnOpen) {
      closeOpenTurn(entry, 'server_restart', 'the agent process ended while sedano was closed', 'interrupted')
      endTurn(entry)
      publishSession(entry)
    }
    return
  }
  if (!isLive(entry)) return
  entry.attach = true
  entry.pendingRequests = pendingRequests
  const driver = await ensureDriver(entry)
  if (!driver || !isLive(entry)) return
  // A session that came back with no turn in flight is a session that can run
  // what was waiting: a prompt the user was told would be sent is still owed
  // them, and a restart is not an answer.
  if (!entry.turnActive) void drainQueue(entry, entry.generation)
}

/**
 * A Command Code turn that finished while sedano was closed.
 *
 * Its answer exists only in the log past the stored offset — this harness has
 * no transcript to rebuild it from — so the files must be read before they are
 * removed. The driver does both: created with `attach`, its `start()` drains
 * the log and then destroys it. The turn it answers is reopened first so the
 * recovered output is filed under the prompt that produced it.
 */
async function recoverFinishedTurn(entry: Entry): Promise<void> {
  const generation = entry.generation
  const lastAt = reopenLastTurn(entry)
  entry.attach = true
  const driver = await ensureDriver(entry)
  if (!isCurrent(entry, generation)) return
  if (!driver) {
    // Nothing could read the log (the CLI is gone from this machine, say): the
    // files are cleaned up rather than left for a reader that will never come.
    const state = readDurableState(entry.summary.id)
    if (state) {
      await durableDestroy(state)
      clearDurableState(entry.summary.id)
    }
  }
  const current = entry.turns.at(-1)
  if (current?.resultSeen) {
    // The process is gone, so nothing it owned is still working: the main actor
    // finished with its result, and any child it left marked live cannot be.
    // Without this the actor barrier kept the recovered turn "running" forever.
    updateMainActor(entry, 'completed')
    finishActiveActors(entry, 'cancelled')
    settleCompletedTurn(entry, generation)
    return
  }
  finishActiveActors(entry, 'cancelled')
  if (entry.turnOpen) {
    closeOpenTurn(
      entry,
      'server_restart',
      'the server restarted before the harness returned a final response',
      'interrupted',
      lastAt ?? Date.now(),
    )
    endTurn(entry)
  }
  publishSession(entry)
  if (!entry.turnActive) void drainQueue(entry, generation)
}

/**
 * Agents left behind by sessions that no longer exist.
 *
 * A delete takes its process with it, so in the ordinary course of things there
 * is nothing here. What this catches is the one case a delete cannot: this
 * server being killed between the two, and a database restored from before the
 * session was created. Either way the rule is the same — nothing detached may
 * outlive the session that owns it, because nothing would ever find it again.
 */
function sweepOrphanAgents(): void {
  for (const state of listDurableStates()) {
    // The database, not `entries`: only the most recent sessions are loaded
    // into memory (see `db.loadSessions`), and an older one that still owns a
    // detached agent is not an orphan — killing it would be a delete nobody asked for.
    if (entries.has(state.sessionId) || db.getSessionRow(state.sessionId)) continue
    void durableDestroy(state)
    clearDurableState(state.sessionId)
  }
}

export function listSessions(): SessionSummary[] {
  return [...entries.values()]
    .map((e) => e.summary)
    // Creation order, not last touch: the UI keeps sessions where they are, and
    // the two must not disagree about the order they hand out.
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return b.createdAt - a.createdAt
    })
}

export function getSession(id: string): SessionSummary | null {
  return entries.get(id)?.summary ?? null
}

export function loadSessionEvents(id: string, limit = 3000): SessionEvent[] {
  return db.loadEvents(id, limit)
}

/** Resolve a command left between acceptance and a durable delivery ack. */
export function failRecoveredPrompt(id: string, promptId: string, reason: string): boolean {
  const entry = entries.get(id)
  const prompt = db.getPrompt(promptId)
  if (!entry || !prompt || prompt.sessionId !== id) return false
  if (prompt.state !== 'accepted' && prompt.state !== 'starting') return false
  const at = Date.now()
  updateLedgerPrompt(promptId, { delivery: 'failed', error: reason, updatedAt: at })
  updatePromptEvent(entry, promptId, 'failed', prompt.turnId)
  promptFrame(entry, {
    id: prompt.id,
    sessionId: prompt.sessionId,
    commandId: prompt.commandId,
    userEventId: prompt.userEventId,
    turnId: prompt.turnId,
    delivery: 'failed',
    createdAt: prompt.createdAt,
    updatedAt: at,
    error: reason,
  })
  return true
}

export async function createSession(
  req: NewSessionRequest,
  options: { deferStart?: boolean } = {},
): Promise<SessionSummary> {
  // A TUI-only tool (Freebuff today) has nothing to stream, so asking for it as
  // an agent opens the terminal tab it really is, with its own preset. The user
  // picks it where they expect to; the app does not promise a chat it cannot fill.
  const tuiHarness = HARNESS_CATALOG.find((item) => item.id === req.harness && item.tui)
  const kind = tuiHarness ? 'terminal' : (req.kind ?? 'agent')
  const adapter = getAdapterFor(kind, req.harness)
  if (!adapter) throw new Error(`harness "${req.harness}" is not wired yet`)

  // The client may propose the id so its tab points at the session from the
  // first frame instead of waiting for the round trip. Asking twice for the same
  // id is the same request, not two sessions: a reconnect replays the outbox, and
  // minting a different id for the repeat forked a session nobody could see while
  // the client went on waiting for the id it had asked for.
  const proposed = req.id ?? ''
  if (proposed && entries.has(proposed)) return entries.get(proposed)!.summary
  // A docked terminal is part of the agent session it was opened from. Refused
  // up front for anything else: a child nobody can see would be a leak.
  const parentSessionId = req.parentSessionId ?? null
  if (parentSessionId) {
    if (kind !== 'terminal') throw new Error('only a terminal can be opened inside another session')
    if (entries.get(parentSessionId)?.summary.kind !== 'agent') throw new Error('the session this terminal belongs to no longer exists')
  }
  const id = /^[0-9a-f-]{36}$/i.test(proposed) ? proposed : crypto.randomUUID()
  const now = Date.now()
  const preset = kind === 'terminal' ? (req.preset || tuiHarness?.id || 'shell') : null
  const summary: SessionSummary = {
    id,
    harness: kind === 'terminal' ? 'shell' : req.harness,
    kind,
    // An agent tab is named after its first message; a terminal tab is named
    // after the command it runs, because that never changes.
    title: kind === 'terminal' ? terminalTitle(preset, req.cwd, req.host) : '',
    titleSource: 'auto',
    parentSessionId,
    preset,
    cwd: req.cwd,
    host: req.host ?? null,
    model: req.model ?? null,
    status: 'starting',
    createdAt: now,
    updatedAt: now,
    nativeId: req.nativeId ?? null,
    transcriptPath: null,
    resumeHint: null,
    permissionMode: req.permissionMode ?? defaultPermissionMode(),
    effort: req.effort ?? null,
    gitBranch: null,
    pinned: false,
    started: false,
    metrics: emptyMetrics(),
  }

  const entry: Entry = {
    summary,
    meter: new Meter(),
    driver: null,
    opts: {
      sessionId: id,
      nativeId: req.nativeId ?? null,
      cwd: req.cwd,
      host: req.host ?? null,
      model: req.model ?? null,
      effort: summary.effort,
      permissionMode: summary.permissionMode,
      preset,
    },
    seq: 0,
    turns: [],
    turnOpen: false,
    agentParents: new Map(),
    lastFlush: 0,
    lastMetricsSave: 0,
    contextWindowInferred: false,
    generation: 1,
    spawn: null,
    spawnAbort: null,
    terminalStatus: null,
    turnActive: false,
    providerSettledTurnId: null,
    queue: [],
    chain: Promise.resolve(),
    pending: null,
    interruptTimer: null,
    attach: false,
    pendingRequests: [],
    turnViews: new Map(),
    continuedTurns: new Set(),
    agentTurns: new Map(),
  }
  entries.set(id, entry)
  publishSession(entry)

  // A launch carrying its first prompt has to become observable before a cold
  // harness starts. The socket subscribes to the new id and then calls
  // `sendMessage`, whose `deliver` writes the user row before awaiting the
  // handshake. Starting here first inverted that order: during a slow or failed
  // handshake the composer was empty, but neither the prompt nor "Starting"
  // existed on screen. Empty tabs and terminal tabs still start eagerly.
  if (!options.deferStart) await ensureDriver(entry)

  // The first prompt is sent by the caller, after it has subscribed: otherwise
  // the very first events would be broadcast before anyone is listening.
  return entry.summary
}

/**
 * Send a prompt, or queue it behind the turn that is running.
 *
 * The answer is the point. This used to hand the prompt to a spawn nobody
 * awaited and report success immediately: when the spawn failed the prompt
 * evaporated, and the client had already been told it was on its way. Now every
 * outcome is named — sent, waiting, or refused with a reason — and the refusals
 * are the codes an `Ack` carries.
 */
export async function sendMessage(
  id: string,
  text: string,
  attachments?: AttachmentRef[],
  options: { promptId?: string; commandId?: string } = {},
): Promise<SendResult> {
  const entry = entries.get(id)
  if (!entry) return gone()
  const images = acceptedAttachments(entry, attachments)
  const promptId = options.promptId ?? crypto.randomUUID()
  const commandId = options.commandId
  return runExclusive(entry, async () => {
    if (!isLive(entry)) return gone()
    const existing = existingLedgerPrompt(promptId)
    if (existing?.delivery === 'delivered' || existing?.delivery === 'cancelled') {
      return existing.delivery === 'delivered'
        ? { ok: true, queued: false, promptId, ...(existing.turnId ? { turnId: existing.turnId } : {}) }
        : { ok: false, code: 'failed', detail: 'that prompt was already cancelled', promptId }
    }
    // A harness that takes input mid-turn gets it now, as its own CLI would:
    // the prompt opens its own turn at this moment (see docs/architecture.md,
    // "Turn state") and the turn it interrupted ends as `continued`.
    if (entry.turnActive && !entry.queue.length && entry.driver?.alive && entry.driver.midTurnInput) {
      const previous = entry.turns.at(-1)
      const sent = await deliver(entry, text, images, promptId, commandId)
      if (sent.ok && previous && previous.id !== entry.turns.at(-1)?.id) continueTurn(entry, previous)
      return sent
    }
    // Behind a running turn, or behind prompts already waiting: order is the
    // user's, so a prompt never overtakes one typed before it.
    if (entry.turnActive || entry.queue.length) {
      const queued = db.enqueuePrompt(entry.summary.id, text, images, promptId)
      const turnId = crypto.randomUUID()
      const prompt = promptState(entry, promptId, 'accepted', turnId, commandId)
      ledgerPrompt(prompt)
      emit(
        entry,
        { k: 'user', text, attachments: images?.length ? images : undefined, promptId, delivery: 'accepted' },
        `prompt:${promptId}`,
        prompt.createdAt,
        undefined,
        undefined,
        undefined,
        turnId,
      )
      promptFrame(entry, prompt)
      updateLedgerPrompt(promptId, { userEventId: `prompt:${promptId}`, turnId, delivery: 'queued', updatedAt: Date.now() })
      emit(
        entry,
        { k: 'user', text, attachments: images?.length ? images : undefined, promptId, delivery: 'queued' },
        `prompt:${promptId}`,
        prompt.createdAt,
        undefined,
        undefined,
        undefined,
        turnId,
      )
      entry.queue.push({ ...queued, promptId, turnId, ...(commandId ? { commandId } : {}) })
      promptFrame(entry, { ...prompt, delivery: 'queued', updatedAt: Date.now() })
      publishSession(entry)
      // Nothing is running (a queue restored from disk, a turn that ended while
      // this was waiting its turn on the chain): release the head now.
      if (!entry.turnActive) void drainQueue(entry, entry.generation)
      return { ok: true, queued: true, promptId, turnId }
    }
    // The failure is not announced here any more: it is the caller's answer, and
    // the socket turns it into an `Ack` for the client that asked (a client too
    // old to send a command id still gets a toast, from the same place). This
    // used to broadcast, so one user's refused prompt appeared on every screen.
    return deliver(entry, text, images, promptId, commandId)
  })
}

/**
 * End a turn a mid-turn prompt took over. Its main loop now answers the new
 * turn, so the main actor's row for it closes; the turn itself completes as
 * `continued` — unless agents it started are still working, in which case it
 * waits on them and completes when the last one ends (see `settleTurnOf`).
 */
function continueTurn(entry: Entry, turn: { id: string; runToken: string }): void {
  const at = Date.now()
  ledgerActor({
    id: `main:${entry.summary.id}`,
    sessionId: entry.summary.id,
    turnId: turn.id,
    ownership: 'sedano',
    provider: entry.summary.harness,
    status: 'completed',
    updatedAt: at,
  })
  entry.continuedTurns.add(turn.id)
  settleTurnOf(entry, turn.id, at)
}

/**
 * Complete a turn that is no longer the current one once nothing in it is
 * working: a continued turn, or one whose last child ended after a newer turn
 * began. The current turn is settled by its own boundary, never here.
 */
function settleTurnOf(entry: Entry, turnId: string | null | undefined, at = Date.now()): void {
  if (!turnId || turnId === entry.turns.at(-1)?.id) return
  const row = db.getTurn(turnId)
  if (!row || (row.state !== 'starting' && row.state !== 'running')) return
  if (db.hasActiveActors(entry.summary.id, turnId)) return
  const continued = entry.continuedTurns.has(turnId)
  if (!continued && !db.turnFacts(entry.summary.id, turnId).get(turnId)?.resultEventId) return
  if (db.advanceTurn(turnId, row.runToken, 'completed', continued ? 'continued' : 'end_turn', at)) {
    entry.continuedTurns.delete(turnId)
    publishTurn(entry, turnId)
  }
}

function gone(): SendResult {
  return { ok: false, code: 'gone', detail: 'that session no longer exists' }
}

function failPromptDelivery(
  entry: Entry,
  prompt: PromptRecord,
  promptId: string,
  turnId: string,
  detail: string,
): SendResult {
  const at = Date.now()
  updateLedgerPrompt(promptId, { delivery: 'failed', turnId, error: detail, updatedAt: at })
  promptFrame(entry, { ...prompt, delivery: 'failed', turnId, error: detail, updatedAt: at })
  updatePromptEvent(entry, promptId, 'failed', turnId)
  finishActiveActors(entry, 'failed', at)
  closeOpenTurn(entry, 'delivery_failed', detail, 'failed', at)
  endTurn(entry)
  entry.meter.endTurn()
  entry.turnActive = false
  entry.providerSettledTurnId = null
  setStatus(entry, entry.generation, 'error')
  discardQueue(entry, 'the prompt could not be delivered')
  return { ok: false, code: 'failed', detail, promptId, turnId }
}

/**
 * Hand one prompt to the harness. Only ever called with no turn in flight, from
 * the session's own chain.
 */
async function deliver(
  entry: Entry,
  text: string,
  images: AttachmentRef[] | undefined,
  promptId: string = crypto.randomUUID(),
  commandId?: string,
  turnId?: string,
): Promise<SendResult> {
  const generation = entry.generation
  // A new turn is the manager knowingly starting work, which is the only thing
  // allowed to reopen a session that ended in `stopped` or `error` (see `setStatus`).
  entry.terminalStatus = null
  // The prompt is the turn's boundary, and it is drawn here — before the driver
  // is even awake — so the user event and everything the harness answers with
  // carry the same turn, while anything still trickling in from the turn before
  // keeps its own.
  const acceptedAt = Date.now()
  entry.providerSettledTurnId = null
  const prompt = promptState(entry, promptId, 'accepted', turnId ?? null, commandId, undefined, acceptedAt)
  ledgerPrompt(prompt)
  const activeTurnId = startTurn(entry, acceptedAt, turnId ?? crypto.randomUUID(), promptId, commandId)
  emit(
    entry,
    { k: 'user', text, attachments: images?.length ? images : undefined, promptId, delivery: 'accepted' },
    `prompt:${promptId}`,
    acceptedAt,
    undefined,
    undefined,
    undefined,
    activeTurnId,
  )
  promptFrame(entry, { ...prompt, turnId: activeTurnId, updatedAt: Date.now() })
  const mainActor: ActorRecord = {
    id: `main:${entry.summary.id}`,
    sessionId: entry.summary.id,
    turnId: activeTurnId,
    ownership: 'sedano',
    provider: entry.summary.harness,
    title: entry.summary.title || entry.summary.harness,
    model: entry.summary.model,
    status: 'starting',
    updatedAt: acceptedAt,
  }
  ledgerActor(mainActor)
  actorFrame(entry, mainActor)
  updateLedgerPrompt(promptId, { delivery: 'starting', turnId: activeTurnId, updatedAt: Date.now() })
  // The prompt belongs to the session from the moment Sedano accepts it, not
  // from the later moment a cold harness finishes its handshake. Persisting it
  // here makes `starting` a visible state beneath the user's actual message and
  // also preserves that message when the spawn fails. Drivers must not echo it
  // a second time; their job starts with `send` below.
  updatePromptEvent(entry, promptId, 'starting', activeTurnId)
  updateLedgerPrompt(promptId, { userEventId: `prompt:${promptId}`, turnId: activeTurnId, delivery: 'starting', updatedAt: Date.now() })
  promptFrame(entry, { ...prompt, delivery: 'starting', turnId: activeTurnId, updatedAt: Date.now() })
  entry.turnActive = true
  const driver = entry.driver?.alive ? entry.driver : await ensureDriver(entry)
  if (!isCurrent(entry, generation)) {
    // Stopped or deleted while the process was starting: `ensureDriver` has
    // already ended the driver it got, and the prompt was never sent.
    return gone()
  }
  if (!driver) {
    return failPromptDelivery(
      entry,
      prompt,
      promptId,
      activeTurnId,
      `${entry.summary.harness} could not be started — the message was not sent`,
    )
  }
  let delivery: { status: string; reason?: string }
  try {
    const { prompt: full, images: pictures } = harnessPrompt(text, images)
    delivery = await driver.send(full, pictures)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return failPromptDelivery(entry, prompt, promptId, activeTurnId, detail)
  }
  if (delivery.status === 'refused') {
    const detail = delivery.reason ?? 'the harness refused the prompt'
    return failPromptDelivery(entry, prompt, promptId, activeTurnId, detail)
  }
  updateLedgerPrompt(promptId, { delivery: 'delivered', turnId: activeTurnId, updatedAt: Date.now() })
  promptFrame(entry, {
    ...prompt,
    delivery: 'delivered',
    turnId: activeTurnId,
    updatedAt: Date.now(),
  })
  updatePromptEvent(entry, promptId, 'delivered', activeTurnId)
  return { ok: true, queued: false, promptId, turnId: activeTurnId }
}

/**
 * Release the oldest queued prompt, once the turn it was waiting for has ended
 * cleanly. One at a time: the next one waits for this turn exactly as it waited
 * for the last, which is the behaviour the native CLIs have.
 */
async function drainQueue(entry: Entry, generation: number): Promise<void> {
  if (!isCurrent(entry, generation) || !entry.queue.length || entry.turnActive) return
  await runExclusive(entry, async () => {
    if (!isCurrent(entry, generation) || entry.turnActive) return
    const next = entry.queue[0]
    if (!next) return
    // Taken off the queue before it is handed over: a prompt that is being sent
    // is no longer waiting, and a failure must not leave it to be sent twice.
    entry.queue.shift()
    db.removeQueuedPrompt(entry.summary.id, next.id)
    publishSession(entry)
    const result = await deliver(entry, next.text, next.attachments, next.promptId, next.commandId, next.turnId)
    if (!result.ok) broadcast({ t: 'toast', level: 'error', text: result.detail })
  })
}

/**
 * Drop everything still waiting, and say so in the transcript.
 *
 * One policy, for every harness: a queued prompt runs only after a turn that
 * ended on its own terms. A stop, a delete or a turn that failed all end the
 * queue with it — the user stopped this session, or the session is no longer in
 * a state anybody chose, and silently running the next prompt against it is the
 * one outcome nobody asked for. The count is written into the timeline because a
 * dropped prompt is a fact about what happened, and the transcript is where
 * facts about what happened live.
 */
function discardQueue(entry: Entry, reason: string): void {
  if (!entry.queue.length) return
  const count = entry.queue.length
  const cancelledAt = Date.now()
  for (const queued of entry.queue) {
    if (!queued.promptId) continue
    updateLedgerPrompt(queued.promptId, { delivery: 'cancelled', error: reason, updatedAt: cancelledAt })
    updatePromptEvent(entry, queued.promptId, 'cancelled', queued.turnId, { by: 'server', reason })
    promptFrame(entry, {
      ...promptState(entry, queued.promptId, 'cancelled', queued.turnId ?? null, queued.commandId, reason, queued.createdAt),
      updatedAt: cancelledAt,
      cancelledBy: 'server',
      cancelReason: reason,
    })
  }
  entry.queue = []
  db.clearPromptQueue(entry.summary.id)
  emit(
    entry,
    {
      k: 'system',
      subtype: 'queue-discarded',
      text:
        count === 1
          ? `1 queued prompt was not sent: ${reason}`
          : `${count} queued prompts were not sent: ${reason}`,
    },
    `local:queue:${crypto.randomUUID()}`,
  )
  publishSession(entry)
}

/**
 * What the harness is handed: every harness takes text, so each document goes
 * inline after the typed words, and only the pictures stay attachments.
 */
function harnessPrompt(text: string, attachments: AttachmentRef[] | undefined): { prompt: string; images: AttachmentRef[] | undefined } {
  if (!attachments?.some(isDocument)) return { prompt: text, images: attachments }
  const documents = attachments.filter(isDocument).map((ref) => ({ name: ref.name, text: attachmentText(ref.id) ?? '(this document is no longer available)' }))
  const images = attachments.filter((ref) => !isDocument(ref))
  return { prompt: withDocuments(text, documents), images: images.length ? images : undefined }
}

/**
 * The attachments a message keeps: every document, and the images the model
 * can actually read.
 */
function acceptedAttachments(entry: Entry, attachments?: AttachmentRef[]): AttachmentRef[] | undefined {
  const documents = attachments?.filter(isDocument) ?? []
  const images = acceptedImages(entry, attachments?.filter((ref) => !isDocument(ref)))
  const kept = [...(images ?? []), ...documents]
  return kept.length ? kept : undefined
}

/**
 * Images the model can actually read.
 *
 * Two questions, not one: whether the harness can carry an image at all, and
 * whether the model on this session can see it. A harness-wide flag refused a
 * screenshot on a vision model and promised one to a text-only model, and the
 * answer belongs to the model (see `model-images.ts`).
 */
function acceptedImages(entry: Entry, attachments?: AttachmentRef[]): AttachmentRef[] | undefined {
  if (!attachments?.length) return undefined
  /**
   * A refused image is never going anywhere: it is not on the message, so no
   * transcript will ever reference it, and leaving the file behind is how the
   * attachments directory filled up with pictures nothing could name.
   */
  const refuse = (text: string): undefined => {
    broadcast({ t: 'toast', level: 'error', text })
    for (const item of attachments) deleteAttachment(item.id)
    return undefined
  }
  const adapter = getAdapterFor(entry.summary.kind, entry.summary.harness)
  if (!adapter?.images) {
    return refuse(
      adapter?.imagesNote ?? `${entry.summary.harness} takes text only — the ${attachments.length === 1 ? 'image was' : 'images were'} not sent`,
    )
  }
  const model = entry.summary.model ?? ''
  if (modelTakesImages(model) === false) {
    return refuse(
      `${model} does not take images — switch model, or send the ${attachments.length === 1 ? 'image' : 'images'} another way`,
    )
  }
  return attachments
}

/* ------------------------------------------------------------------ */
/* Terminal tabs                                                       */
/* ------------------------------------------------------------------ */

/**
 * Terminal tabs reattach lazily, exactly like agent sessions respawn: if the
 * local tmux client is gone (app restart, killed process), the next keystroke,
 * resize or snapshot brings it back attached to the same host-side session.
 */
export async function attachTerminal(id: string): Promise<Driver | null> {
  const entry = entries.get(id)
  if (!entry || entry.summary.kind !== 'terminal') return null
  if (entry.driver?.alive) return entry.driver
  const driver = await ensureDriver(entry)
  // A resize that arrived while nothing was attached is applied here, so the
  // host-side pane is the size of the terminal about to display it.
  if (driver && entry.termSize) driver.resize?.(entry.termSize.cols, entry.termSize.rows)
  return driver
}

export function writeTerminal(id: string, data: string): void {
  const entry = entries.get(id)
  if (!entry) return
  // The first thing typed in a terminal is what makes it exist in the rail.
  const markStarted = () => {
    if (!entry.summary.started) {
      entry.summary.started = true
      publishSession(entry)
    }
  }
  if (!entry.driver?.alive) {
    void attachTerminal(id).then((driver) => {
      driver?.write?.(data)
      markStarted()
    })
    return
  }
  entry.driver.write?.(data)
  markStarted()
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const entry = entries.get(id)
  if (!entry) return
  entry.termSize = { cols, rows }
  if (!entry.driver?.alive) {
    void attachTerminal(id)
    return
  }
  entry.driver.resize?.(cols, rows)
}

/** The current screen and its cursor, so a freshly opened tab is not blank. */
export async function terminalSnapshot(id: string, history = false): Promise<TerminalScreen | null> {
  const entry = entries.get(id)
  if (!entry || entry.summary.kind !== 'terminal') return null
  const driver = entry.driver?.alive ? entry.driver : await attachTerminal(id)
  // The capture must happen at the size the client draws: a screen measured for
  // 100×30 replayed into a wider terminal stops early and leaves the cursor
  // floating. Resizing here is idempotent — tmux ignores a no-op.
  if (driver && entry.termSize) driver.resize?.(entry.termSize.cols, entry.termSize.rows)
  return (await driver?.snapshot?.(history)) ?? null
}

/**
 * What became of one answer.
 *
 * This used to be a boolean the caller threw away, which is how a click on a
 * question card of a restored session became a silent no-op: the driver was
 * gone, the answer went nowhere, and the UI said "answer sent". Every refusal
 * now has a reason, and the reasons are the codes an `Ack` carries.
 */
export type AnswerResult =
  | { ok: true }
  | { ok: false; code: Extract<AckError, 'gone' | 'not_pending' | 'failed'>; detail: string }

export type CancelPromptResult =
  | { ok: true; promptId: string }
  | { ok: false; code: Extract<AckError, 'gone' | 'not_pending' | 'failed'>; detail: string }

/** Cancel a prompt that is still waiting in the durable queue. */
export function cancelPrompt(id: string, promptId: string): CancelPromptResult {
  const entry = entries.get(id)
  if (!entry) return { ok: false, code: 'gone', detail: 'that session no longer exists' }
  const index = entry.queue.findIndex((prompt) => prompt.promptId === promptId)
  if (index < 0) {
    return { ok: false, code: 'not_pending', detail: 'that prompt is no longer queued' }
  }
  const [queued] = entry.queue.splice(index, 1)
  if (!queued) return { ok: false, code: 'not_pending', detail: 'that prompt is no longer queued' }
  db.removeQueuedPrompt(id, queued.id)
  const now = Date.now()
  updateLedgerPrompt(promptId, { delivery: 'cancelled', error: 'cancelled by user', updatedAt: now })
  updatePromptEvent(entry, promptId, 'cancelled', queued.turnId, { by: 'user', reason: 'cancelled by user' })
  promptFrame(entry, {
    ...promptState(entry, promptId, 'cancelled', queued.turnId ?? null, queued.commandId, 'cancelled by user', queued.createdAt),
    updatedAt: now,
    cancelledBy: 'user',
    cancelReason: 'cancelled by user',
  })
  publishSession(entry)
  return { ok: true, promptId }
}

/**
 * Hand the user's answer to the driver that asked, so the turn can continue.
 *
 * The stored request is the authority, not the driver's map: it is what survives
 * a restart, and it is what makes the second of two clients to answer the same
 * card be told so instead of answering twice.
 */
export function answerQuestion(id: string, toolId: string, optionId: string): AnswerResult {
  const entry = entries.get(id)
  if (!entry) return { ok: false, code: 'gone', detail: 'that session no longer exists' }
  const request = db.getRequest(id, toolId)
  if (!request) {
    return { ok: false, code: 'not_pending', detail: 'that question is not waiting for an answer' }
  }
  if (request.state !== 'pending') {
    return {
      ok: false,
      code: 'not_pending',
      detail:
        request.state === 'answered'
          ? 'that question has already been answered'
          : `that question was ${request.state} before it could be answered`,
    }
  }
  if (!entry.driver?.answerQuestion) {
    // Nothing is listening for the answer, so the request is closed rather than
    // left pending for a process that is never coming back.
    db.closeRequest(id, toolId, 'expired', null)
    const reason = 'not answered — the agent that asked is no longer running'
    if (!updateNativeRequest(entry, toolId, 'expired', undefined, reason)) {
      emit(
        entry,
        { k: 'tool_result', toolId, text: reason, isError: false, truncated: false },
        `local:request:expired:${toolId}`,
      )
    }
    return {
      ok: false,
      code: 'gone',
      detail: 'the agent that asked this question is no longer running',
    }
  }
  const native = nativeRequestEvent(entry, toolId)
  if (native?.ev.k === 'request' && !native.ev.options.some((option) => option.id === optionId)) {
    return { ok: false, code: 'failed', detail: 'that option was not offered by the agent' }
  }
  // Taken here, before the driver reports anything: the answer is accepted once,
  // and a second client clicking the same card is refused rather than sending a
  // second answer into a continuation that has already been resolved.
  db.closeRequest(id, toolId, 'answered', optionId)
  entry.driver.answerQuestion(toolId, optionId)
  updateNativeRequest(entry, toolId, 'answered', optionId)
  return { ok: true }
}

/**
 * How long an interrupt is given before the stop is finished here.
 *
 * Every harness's `interrupt()` is a request the other side may never answer:
 * Claude Code only resets its status on a later `result` frame, an ACP agent on
 * the cancelled prompt settling — a request sent with no timeout at all — and a
 * CLI whose stdout is held open by a child it left behind never ends its turn.
 * None of them can be trusted to come back, and the one thing a stop must do is
 * come back. The grace period is long enough that a harness which does answer is
 * the one that ends its own turn, and short enough that nobody waits on it.
 */
const INTERRUPT_GRACE_MS = 4000

function disarmInterrupt(entry: Entry): void {
  if (entry.interruptTimer) clearTimeout(entry.interruptTimer)
  entry.interruptTimer = null
}

/**
 * The stop the UI cannot be without.
 *
 * `interrupt()` asks the harness to end the turn; nothing guarantees it does.
 * When it does not, the turn is still `running` with the process gone, and both
 * the Esc key and the stop button go through `interruptSession` — which returned
 * as if it had done something while the session stayed stuck on "Working…" with
 * no way out. So the interrupt is given a deadline, and the stop is finished
 * here if the deadline passes: the interface must never outlive its own work.
 */
function armInterrupt(entry: Entry): void {
  const id = entry.summary.id
  disarmInterrupt(entry)
  entry.interruptTimer = setTimeout(() => {
    entry.interruptTimer = null
    // The session may have gone, or the turn may have ended the honest way and
    // a new one started: only the turn this interrupt was asked for is stopped.
    if (entries.get(id) !== entry || entry.summary.status !== 'running') return
    stopSession(id)
  }, INTERRUPT_GRACE_MS)
}

export function interruptSession(id: string): boolean {
  const entry = entries.get(id)
  if (!entry) return false
  // A turn is only ever ended by the driver running it. With no living driver
  // there is nothing left to ask, and a no-op the client cannot tell apart from
  // a stuck session is exactly what made this impossible to stop.
  if (!entry.driver?.alive) {
    stopSession(id)
    return true
  }
  // The same policy as a stop: the user asked for this turn to end, so the
  // prompts waiting behind it are not released when it does.
  discardQueue(entry, 'the turn was interrupted')
  // The turn the question belonged to is ending, so the question ends with it.
  closePendingRequests(entry, 'cancelled', 'not answered — the turn was interrupted')
  entry.driver.interrupt()
  armInterrupt(entry)
  return true
}

export function stopSession(id: string): boolean {
  const entry = entries.get(id)
  if (!entry) return false
  disarmInterrupt(entry)
  // A new lifecycle first: the driver being stopped, and any spawn still in
  // flight, belong to the old one from this line on. Whatever they say next —
  // an exit reported as an error, a handshake that finally completes — is about
  // a process the user has already replaced, and is ignored.
  const generation = newGeneration(entry)
  const driver = entry.driver
  entry.driver = null
  driver?.stop()
  entry.meter.endTurn()
  updateMainActor(entry, 'cancelled')
  // The process is gone, and every agent it was running went with it.
  stopLiveAgents(entry)
  closeOpenTurn(entry, 'stopped', 'the turn was stopped before the harness returned a final response', 'interrupted')
  // A turn whose main loop had returned but was waiting on its agents has no
  // open boundary to close — and its agents were just cut off, so it ends here
  // as stopped rather than waiting forever.
  const last = entry.turns.at(-1)
  const row = last ? db.getTurn(last.id) : null
  if (row && (row.state === 'starting' || row.state === 'running')) {
    updateCurrentTurn(entry, 'cancelled', 'interrupted', 'stopped')
  }
  endTurn(entry)
  // Stop means stop: the prompts waiting behind this turn are not run afterwards,
  // and a question nobody can answer any more is closed rather than left looking
  // live in the transcript.
  discardQueue(entry, 'the session was stopped')
  closePendingRequests(entry, 'cancelled', 'not answered — the session was stopped')
  setStatus(entry, generation, 'stopped')
  return true
}

/**
 * Ask for a different model / reasoning effort / approval mode.
 *
 * Asking is not having. These live in CLI flags or in a protocol exchange the
 * agent can refuse, so the request is recorded as *pending* and becomes the
 * session's truth only when something confirms it: the process that runs it was
 * started with it (a respawn on the next turn — `ensureDriver`), or the harness
 * names it itself (the `model` hook). Writing the request straight into the
 * summary is what made the app report a model the agent had rejected, and the
 * picker show a setting nothing was using.
 */
export function setSessionOptions(
  id: string,
  patch: { model?: string | null; effort?: EffortLevel | null; permissionMode?: PermissionMode },
): ConfigureResult {
  const entry = entries.get(id)
  if (!entry) return { ok: false, code: 'gone', detail: 'that session no longer exists' }
  // A prompt already with the harness settles the options of its own turn, even
  // in the moment before the harness has said it started: changing them under it
  // would report a configuration the running process is not using.
  if (entry.summary.status === 'running' || entry.turnActive) {
    // Returned, not broadcast: the refusal belongs to the client that asked, and
    // the socket delivers it there (see the `Ack` plumbing in `index.ts`).
    return {
      ok: false,
      code: 'busy',
      detail:
        'stop the running turn before changing model, effort or approvals — the change needs a fresh process',
    }
  }

  // A client that read a poisoned session before it was healed could ask for the
  // placeholder back as if it were a model. There is nothing to run under that
  // name, so the request is refused where it arrives rather than handed to a CLI
  // as `--model <synthetic>`.
  if (patch.model !== undefined && isPlaceholderModel(patch.model)) {
    // `failed` rather than `rejected`: `ConfigureResult` only carries three
    // codes and that shared type is not this change's to widen.
    return { ok: false, code: 'failed', detail: `${patch.model} is not a model` }
  }

  const pending: PendingOptions = { ...(entry.pending ?? {}) }
  if (patch.model !== undefined) pending.model = patch.model
  if (patch.effort !== undefined) pending.effort = patch.effort
  if (patch.permissionMode !== undefined) pending.permissionMode = patch.permissionMode
  entry.pending = pending
  entry.summary.pendingOptions = pending

  // The drivers drop their process for a change that needs one; whatever they do
  // with it, nothing here is committed until it is confirmed.
  const wasAlive = Boolean(entry.driver?.alive)
  entry.driver?.configure(patch)
  // A process ended for the change takes its questions with it. The durable
  // rows are closed here, not left for a click to discover: a pending card on a
  // killed agent is the dead button this lifecycle exists to prevent. A driver
  // that applied the change in place (ACP's set_model) still has its asker.
  if (wasAlive && !entry.driver?.alive) {
    closePendingRequests(entry, 'cancelled', 'not answered — the agent was restarted to apply new settings')
  }
  publishSession(entry)
  return { ok: true, pending: true }
}

export function renameSession(id: string, title: string): boolean {
  const entry = entries.get(id)
  if (!entry) return false
  const name = title.trim().slice(0, 200)
  // An empty name is not a name: the session keeps the one it has.
  if (!name) return true
  entry.summary.title = name
  entry.summary.titleSource = 'user'
  publishSession(entry)
  return true
}

/**
 * Make a terminal part of an agent session (see `SessionSummary.parentSessionId`).
 * Refused for anything but a terminal under an agent; asking again is a no-op.
 */
export function setSessionParent(id: string, parentId: string): { ok: true } | { ok: false; detail: string } {
  const entry = entries.get(id)
  const parent = entries.get(parentId)
  if (!entry || !parent) return { ok: false, detail: 'that session no longer exists' }
  if (entry.summary.kind !== 'terminal' || parent.summary.kind !== 'agent') {
    return { ok: false, detail: 'only a terminal can belong to an agent session' }
  }
  if (entry.summary.parentSessionId === parentId) return { ok: true }
  entry.summary.parentSessionId = parentId
  publishSession(entry)
  return { ok: true }
}

export function pinSession(id: string, pinned: boolean): boolean {
  const entry = entries.get(id)
  if (!entry) return false
  entry.summary.pinned = pinned
  publishSession(entry)
  return true
}

export function removeSession(id: string): boolean {
  const entry = entries.get(id)
  if (!entry) return false
  // The terminals docked in a session are part of it, and go with it.
  for (const child of [...entries.values()]) {
    if (child.summary.parentSessionId === id && child !== entry) removeSession(child.summary.id)
  }
  // A terminal session owns a tmux session on the host; deleting must take it
  // with us, or the shell stays alive with no tab pointing at it. Nothing has
  // attached to a restored session yet, so when there is no driver the name is
  // killed directly instead of being left behind.
  disarmInterrupt(entry)
  // Same reason as `stopSession`, and one more: a spawn that completes after this
  // used to assign its driver to the deleted entry, and the next publish wrote
  // the row back into the database — a session the user deleted reappearing on
  // the next restart. The generation is what makes that callback a no-op, and the
  // `isLive` guard on `persist`/`publishSession`/`emit` is what makes it harmless
  // even if it holds the entry.
  newGeneration(entry)
  if (entry.summary.kind === 'terminal' && !entry.driver) void killTerminalSession(id, entry.summary.host)
  else if (entry.driver?.destroy) entry.driver.destroy()
  else entry.driver?.stop()
  entry.driver = null
  // An agent session can own a detached process on its machine with nothing
  // attached to it — a session restored and never opened, a spawn that was still
  // in flight. The driver's own `stop` takes that process with it, so this is
  // the case where there is no driver to do it: the note on disk is the only
  // thing left that names the process, and a delete that only deleted the note
  // would leave a CLI running on somebody's server with nothing able to find it.
  const durable = entry.summary.kind === 'agent' ? readDurableState(id) : null
  if (durable) {
    void durableDestroy(durable)
    clearDurableState(id)
  }
  entry.queue = []
  entries.delete(id)
  // The rows go with the session, and the images they owned go with the rows:
  // a deleted session used to leave every picture it carried on disk, with
  // nothing left anywhere that could name them.
  deleteAttachments(db.deleteSession(id))
  db.kvDelete(METRICS_KEY(id))
  forgetTab(id)
  broadcast({ t: 'session_removed', id })
  return true
}

/**
 * Put a session away: out of the rail, the tabs and memory, with nothing
 * deleted — its rows stay in the store and the harness keeps its own
 * transcript, so `unarchiveSession` brings it back whole.
 *
 * A running session is stopped first, exactly as a stop from the UI would
 * (the prompts queued behind it are dropped, and say so): an agent working on
 * in a session nobody can see any more is the one outcome to avoid. The
 * terminals docked in it are archived with it, as a delete takes them along.
 */
export function archiveSession(id: string): boolean {
  const entry = entries.get(id)
  if (!entry) return false
  for (const child of [...entries.values()]) {
    if (child.summary.parentSessionId === id && child !== entry) archiveSession(child.summary.id)
  }
  if (entry.driver || entry.spawn) stopSession(id)
  // A process left detached with no driver attached (a restored session never
  // opened) has only the note on disk naming it; see `removeSession`.
  const durable = entry.summary.kind === 'agent' ? readDurableState(id) : null
  if (durable) {
    void durableDestroy(durable)
    clearDurableState(id)
  }
  saveMetrics(entry, true)
  persist(entry)
  // From here on nothing this entry still has in flight may write about it.
  newGeneration(entry)
  entries.delete(id)
  db.setSessionArchived(id, true)
  forgetTab(id)
  broadcast({ t: 'session_removed', id })
  return true
}

/** Bring an archived session (and the terminals docked in it) back. */
export function unarchiveSession(id: string): SessionSummary | null {
  const live = entries.get(id)
  if (live) return live.summary
  const row = db.getSessionRow(id)
  if (!row || row.archived !== 1) return null
  db.setSessionArchived(id, false)
  const entry = loadEntry({ ...row, archived: 0 }, db.ledgerRenames().get(id))
  publishSession(entry)
  for (const child of db.childSessions(id)) {
    if (child.archived !== 1) continue
    db.setSessionArchived(child.id, false)
    publishSession(loadEntry({ ...child, archived: 0 }))
  }
  return entry.summary
}

/** `harness:nativeId` of every conversation Sedano holds, archived or not. */
export function heldNativeIds(): Set<string> {
  const held = new Set(db.nativeSessionIds().keys())
  // A session whose row is not written yet (still starting) is held too.
  for (const entry of entries.values()) {
    if (entry.summary.nativeId) held.add(`${entry.summary.harness}:${entry.summary.nativeId}`)
  }
  return held
}

export interface NativeImport {
  harness: HarnessId
  nativeId: string
  cwd: string
  host: string | null
  /** The title the scan showed, until the harness names the session itself. */
  title?: string
  /**
   * History read from the native store, for a harness whose driver has no way
   * to replay it (Command Code). Claude and the ACP agents replay their own.
   */
  history?: Array<{ ev: TimelineEvent; at: number }>
}

/**
 * Open a harness-native conversation as a Sedano session that continues it.
 *
 * Idempotent on the native id: a conversation Sedano already holds is handed
 * back (unarchived if it was archived) instead of opened twice.
 */
export async function importNativeSession(req: NativeImport): Promise<SessionSummary> {
  const held = db.nativeSessionIds().get(`${req.harness}:${req.nativeId}`)
  if (held) {
    if (held.archived) {
      const restored = unarchiveSession(held.id)
      if (restored) return restored
    }
    const live = entries.get(held.id)
    if (live) return live.summary
    // Held but older than what a boot loads (see `db.loadSessions`): bring that
    // one into memory rather than open the conversation a second time.
    const row = db.getSessionRow(held.id)
    if (row && row.archived === 0) {
      const entry = loadEntry(row, db.ledgerRenames().get(row.id))
      publishSession(entry)
      return entry.summary
    }
  }
  const summary = await createSession(
    { harness: req.harness, kind: 'agent', cwd: req.cwd, host: req.host, nativeId: req.nativeId },
    { deferStart: true },
  )
  const entry = entries.get(summary.id)
  if (!entry) return summary
  if (req.title) summary.title = req.title.slice(0, 200)
  summary.started = true
  // With nothing to start, it rests like a restored session until the next prompt.
  if (req.history) summary.status = 'stopped'
  req.history?.forEach((item, index) => emit(entry, item.ev, `import:${index}`, item.at))
  publishSession(entry)
  // Claude re-reads its transcript and an ACP agent replays the conversation on
  // `session/load`: starting the driver now is what puts the history on screen.
  if (!req.history) {
    void ensureDriver(entry).catch((error) => console.error('sedano: import could not start the harness', error))
  }
  return summary
}

/**
 * Capabilities are asked for on every connect, every session and every host
 * change, and building them probes each harness binary. The cache is per
 * machine — the harnesses of a server are not the ones of this laptop — and a
 * short TTL keeps the probing from turning into a spawn storm when a client
 * reconnects; the answer only changes when software is installed.
 */
const capsCache = new Map<string, { at: number; value: Capabilities }>()
const CAPS_TTL = 20_000
/** A remote catalog costs an SSH round trip, so its answer is kept longer. */
const CAPS_TTL_REMOTE = 120_000

/**
 * Scans in flight, so callers who ask at the same moment share one round trip.
 * A client opening a machine asks from three places at once — the picker, the
 * composer and the connection itself — and each of those used to be its own SSH
 * handshake to the same host.
 */
const capsInFlight = new Map<string, Promise<Capabilities>>()
/** Bumped whenever the cache is dropped, so a scan that started before that
 * does not write its stale answer back into it. */
let capsGeneration = 0

export async function capabilities(host: string | null = null, force = false): Promise<Capabilities> {
  const key = host ?? ''
  const cached = capsCache.get(key)
  if (!force && cached && Date.now() - cached.at < (host ? CAPS_TTL_REMOTE : CAPS_TTL)) return cached.value
  const running = capsInFlight.get(key)
  if (running) return running

  const generation = capsGeneration
  const scan = (async (): Promise<Capabilities> => {
    try {
      const { harnesses, probeError } = await probeCatalog(host)
      const value: Capabilities = {
        host,
        probeError,
        harnesses,
        presets: presetList(),
        hosts: sshHosts(),
        availableHosts: sshConfigHosts(),
        hostStatus: hostStatusList(),
        voice: await resolveVoice(true),
        unhandledEvents: unhandledEvents(),
      }
      if (generation === capsGeneration) capsCache.set(key, { at: Date.now(), value })
      return value
    } finally {
      capsInFlight.delete(key)
    }
  })()
  capsInFlight.set(key, scan)
  return scan
}

/** Forget every catalog, e.g. after the set of enabled hosts changed. */
export function invalidateCapabilities(): void {
  capsCache.clear()
  capsGeneration += 1
}

/* ------------------------------------------------------------------ */
/* Host reachability                                                   */
/* ------------------------------------------------------------------ */

/**
 * What each check found, per host. Nothing is here until somebody asks: a
 * machine we never contacted is `null`, not "ok" and not "down", because the
 * only thing worse than no answer is an invented one.
 */
const hostChecks = new Map<string, { reach: NonNullable<HostStatus['reach']>; detail: string; at: number }>()

/** Every candidate in `~/.ssh/config`, with what we actually know about it. */
export function hostStatusList(): HostStatus[] {
  return sshConfigHosts().map((host) => {
    const seen = hostChecks.get(host)
    return {
      host,
      enabled: isAuthorizedHost(host),
      reach: seen?.reach ?? null,
      detail: seen?.detail ?? null,
      checkedAt: seen?.at ?? null,
    }
  })
}

/**
 * Ask one host whether it is there.
 *
 * The cheapest question that proves a working login shell — `true` costs no I/O
 * on the far side — through the very transport a session would use, so what is
 * being checked is the path that would actually be taken. The failure is kept as
 * the transport's own kind: a refused connection, a timeout, a login that is not
 * permitted and a command that failed are four different things to fix, and the
 * panel used to show all four as an absent row.
 *
 * Only for a host in the allowlist. Checking one that is not enabled would be
 * the allowlist's single gate with a hole in it — `assertAuthorizedHost` throws,
 * which is the intended answer.
 */
export function checkHost(host: string): HostStatus {
  assertAuthorizedHost(host)
  const at = Date.now()
  try {
    const reply = new Transport(host).execOrThrow('printf sedano-ok', { timeoutMs: 8000, retries: 1 })
    // A login shell that connects and prints something else is not a host we can
    // run a harness on, and saying "ok" for it would be the blank all over again.
    if (!reply.stdout.includes('sedano-ok')) {
      throw new Error(`connected, but the login shell answered "${reply.stdout.trim().slice(0, 80)}"`)
    }
    hostChecks.set(host, { reach: 'ok', detail: 'Answered over ssh', at })
  } catch (err) {
    const kind = isRemoteError(err) ? err.kind : 'command_failed'
    const detail = err instanceof Error ? err.message : String(err)
    hostChecks.set(host, { reach: kind, detail, at })
  }
  return hostStatusList().find((item) => item.host === host)!
}

/**
 * `checkHost` for the HTTP handler. The probe is a real ssh round trip with an
 * 8 s deadline and a retry, and the synchronous version froze the server for
 * all of it while a machine that was down failed to answer. The sync one stays
 * for the scripts that call it directly.
 */
export async function checkHostAsync(host: string): Promise<HostStatus> {
  assertAuthorizedHost(host)
  const at = Date.now()
  const reply = await new Transport(host).execAsync('printf sedano-ok', { timeoutMs: 8000, retries: 1 })
  if (reply.error) {
    hostChecks.set(host, { reach: reply.error.kind, detail: reply.error.message, at })
  } else if (!reply.stdout.includes('sedano-ok')) {
    hostChecks.set(host, {
      reach: 'command_failed',
      detail: `connected, but the login shell answered "${reply.stdout.trim().slice(0, 80)}"`,
      at,
    })
  } else {
    hostChecks.set(host, { reach: 'ok', detail: 'Answered over ssh', at })
  }
  return hostStatusList().find((item) => item.host === host)!
}

/* ------------------------------------------------------------------ */
/* Which harnesses you want offered                                    */
/* ------------------------------------------------------------------ */

/**
 * Show or hide one harness on one machine.
 *
 * The preference is the server's, so the catalogs built from it are stale the
 * moment it changes: dropping them here is what makes the next `caps` message
 * the truth rather than the answer from before the click.
 */
export function setHarnessEnabled(host: string | null, harness: HarnessId, enabled: boolean): void {
  if (host !== null) assertAuthorizedHost(host)
  storeHarnessEnabled(host, harness, enabled)
  invalidateCapabilities()
}

/** The catalog of one machine, without the reason a failed probe failed (see below). */
export async function harnessCatalog(host: string | null = null): Promise<HarnessInfo[]> {
  return (await probeCatalog(host)).harnesses
}

/**
 * Which harnesses exist on one machine.
 *
 * The binaries are looked up *there*, never here: a session opened from this
 * picker runs the harness its host has, with that machine's logins and limits,
 * so a CLI installed only on this laptop must not be offered for a server — and
 * one installed only on the server must be. The whole catalog is probed in one
 * round trip.
 *
 * An unreachable machine reports *why*: an empty list because ssh failed would
 * otherwise read as "nothing is installed there", which is a different answer.
 */
async function probeCatalog(host: string | null): Promise<{ harnesses: HarnessInfo[]; probeError: string | null }> {
  let bins = new Map<string, string | null>()
  let probeError: string | null = null
  try {
    // Asynchronous: on a host this is an ssh round trip, and the synchronous
    // probe froze every socket while a slow or dead machine was being asked.
    bins = await new Transport(host).whichAllAsync(HARNESS_CATALOG.map((item) => item.bin))
  } catch (err) {
    probeError = err instanceof Error ? err.message : String(err)
  }
  const out: HarnessInfo[] = []
  for (const item of HARNESS_CATALOG) {
    const adapter = getAdapter(item.id)
    const bin = bins.get(item.bin) ?? null
    // Version detection needs a local process, so on a host there is nothing to
    // run here: the harness reports its version once a session of it runs there,
    // and its model list belongs to that machine's account (see the adapters).
    let version: string | null = null
    if (adapter && !host) {
      const detected = await adapter.detect()
      // Each CLI words its version its own way; the pickers show the number.
      version = versionNumber(detected.version)
    }
    // The models of this machine's installation, never another machine's.
    const models = adapter ? adapter.models(host) : []
    const primeKey = `${host ?? ''}:${item.id}`
    scheduleModelRefresh(host, item.id, adapter, bin !== null)
    out.push({
      id: item.id,
      label: item.label,
      note: item.note,
      bin: item.bin,
      wired: Boolean(adapter),
      installed: bin !== null,
      version,
      models,
      ...(primeErrors.has(primeKey) ? { modelsNote: primeErrors.get(primeKey) } : {}),
      ...(harnessUpdates.has(primeKey) ? { update: harnessUpdates.get(primeKey) } : {}),
      commands: commandsFor(item.id),
      tui: item.tui,
      images: adapter?.images ?? false,
      ...(adapter?.imagesNote ? { imagesNote: adapter.imagesNote } : {}),
      // Published rather than assumed: the approval modes are a fact about this
      // harness, and the picker must offer the ones it really has (see
      // `permissionModesFor`, which is the single source).
      permissionModes: permissionModesFor(item.id),
      // What was found and what you want offered are two answers, and this is
      // the second one. It is published beside `installed` rather than filtering
      // the row out: a client still needs the models and approval modes of a
      // harness it is hiding, because a session may already be running it.
      enabled: isHarnessEnabled(host, item.id),
    })
  }
  return { harnesses: out, probeError }
}

/** Model-list probes currently in flight, per machine+harness. */
const priming = new Set<string>()
/** Why a machine's harness could not answer about its models, per machine+harness. */
const primeErrors = new Map<string, string>()
/** Successful probe times survive restarts alongside the cached model lists. */
const MODEL_REFRESH_KEY = 'model-refresh-at-v1'
const modelRefreshAt = (() => {
  try {
    const values = JSON.parse(db.kvGet(MODEL_REFRESH_KEY) ?? '{}') as Record<string, number>
    return new Map(Object.entries(values).filter(([, at]) => typeof at === 'number' && Number.isFinite(at)))
  } catch { return new Map<string, number>() }
})()
function rememberModelRefresh(key: string): void {
  modelRefreshAt.set(key, Date.now())
  db.kvSet(MODEL_REFRESH_KEY, JSON.stringify(Object.fromEntries(modelRefreshAt)))
}
const MODEL_REFRESH_MS = 24 * 60 * 60_000
const MODEL_ERROR_RETRY_MS = 15_000
/** Keep read-only update results across app restarts, not only across tab switches. */
const HARNESS_UPDATES_KEY = 'harness-updates-v1'
function savedHarnessUpdates(): Map<string, HarnessUpdateInfo> {
  try {
    const parsed = JSON.parse(db.kvGet(HARNESS_UPDATES_KEY) ?? '{}') as Record<string, HarnessUpdateInfo>
    return new Map(Object.entries(parsed).filter(([, value]) =>
      value && ['current', 'available', 'unknown'].includes(value.status) && typeof value.checkedAt === 'number'))
  } catch {
    return new Map()
  }
}
const harnessUpdates = savedHarnessUpdates()
function rememberHarnessUpdate(key: string, update: HarnessUpdateInfo): void {
  harnessUpdates.set(key, update)
  db.kvSet(HARNESS_UPDATES_KEY, JSON.stringify(Object.fromEntries(harnessUpdates)))
}

/**
 * Refresh a catalog without making the picker wait for an ACP handshake.
 *
 * Cached models answer immediately. A normal machine switch only rescans
 * installed binaries; it does not repeat an expensive model handshake. The
 * daily sweep or a manual refresh discovers new/renamed models.
 * ACP's `session/new` here carries no prompt, and Command Code only executes
 * `--list-models`; neither path consumes model tokens or triggers sign-in.
 */
function scheduleModelRefresh(
  host: string | null,
  id: HarnessId,
  adapter: Adapter | null,
  installed: boolean,
  recover = false,
): void {
  if (!adapter?.refreshModels || !installed) return
  const key = `${host ?? ''}:${id}`
  if (priming.has(key)) return
  const now = Date.now()
  const last = modelRefreshAt.get(key) ?? 0
  const minimum = recover ? 0 : primeErrors.has(key) ? MODEL_ERROR_RETRY_MS : MODEL_REFRESH_MS
  if (now - last < minimum) return
  priming.add(key)
  modelRefreshAt.set(key, now)
  primeErrors.delete(key)
  void (async () => {
    try {
      await adapter.refreshModels!(host)
      rememberModelRefresh(key)
    } catch (err) {
      primeErrors.set(key, err instanceof Error ? err.message : String(err))
    } finally {
      priming.delete(key)
      invalidateCapabilities()
    }
    // A failed catalog probe must not turn a harmless background refresh into
    // an unhandled rejection that takes every open session down with it.
    try {
      broadcast({ t: 'caps', caps: await capabilities(host) })
    } catch (err) {
      console.error(`sedano: cannot refresh ${key} capabilities:`, err)
    }
  })()
}

/** A manual, read-only refresh of one harness's models and release. */
export async function inspectHarness(
  host: string | null,
  id: HarnessId,
): Promise<{ caps: Capabilities; update: HarnessUpdateInfo | null }> {
  const catalog = HARNESS_CATALOG.find((item) => item.id === id)
  if (!catalog) throw new Error(`unknown harness: ${id}`)
  const adapter = getAdapter(id)
  const transport = new Transport(host)
  if (!(await transport.whichAllAsync([catalog.bin])).get(catalog.bin)) {
    throw new Error(`${catalog.label} is not installed on ${host ?? 'this machine'}`)
  }

  const key = `${host ?? ''}:${id}`
  const updatePromise = checkHarnessUpdate(host, id, true)
  if (adapter?.refreshModels) {
    try {
      await adapter.refreshModels(host)
      primeErrors.delete(key)
      rememberModelRefresh(key)
    } catch (error) {
      primeErrors.set(key, error instanceof Error ? error.message : String(error))
    }
  }
  const update = await updatePromise
  if (update) rememberHarnessUpdate(key, update)
  invalidateCapabilities()
  const caps = await capabilities(host, true)
  broadcast({ t: 'caps', caps })
  return { caps, update }
}

/** Update an adapter only after the user clicked Update, then rescan it. */
export async function updateHarness(
  host: string | null,
  id: HarnessId,
): Promise<{ caps: Capabilities; update: HarnessUpdateInfo | null }> {
  const catalog = HARNESS_CATALOG.find((item) => item.id === id)
  if (!catalog) throw new Error(`unknown harness: ${id}`)
  const result = await applyHarnessUpdate(host, id)
  if (result.status === 'unknown') throw new Error(result.detail)
  return inspectHarness(host, id)
}

/** One daily, read-only catalog sweep; a manual sweep may also install releases. */
export interface HarnessSyncStatus {
  running: boolean
  mode: 'check' | 'upgrade'
  startedAt: number | null
  finishedAt: number | null
  completed: number
  total: number
  failures: Array<{ machine: string; harness: string; detail: string }>
}

const HARNESS_SYNC_KEY = 'harness-sync-status-v1'
const HARNESS_DAILY_MS = 24 * 60 * 60_000
const savedSync = (() => {
  try { return JSON.parse(db.kvGet(HARNESS_SYNC_KEY) ?? '{}') as Partial<HarnessSyncStatus> }
  catch { return {} }
})()
let syncStatus: HarnessSyncStatus = {
  running: false,
  mode: savedSync.mode === 'upgrade' ? 'upgrade' : 'check',
  startedAt: savedSync.startedAt ?? null,
  finishedAt: savedSync.finishedAt ?? null,
  completed: savedSync.completed ?? 0,
  total: savedSync.total ?? 0,
  failures: Array.isArray(savedSync.failures) ? savedSync.failures : [],
}
let syncWork: Promise<void> | null = null
let queuedSync: 'check' | 'upgrade' | null = null

export function harnessSyncStatus(): HarnessSyncStatus & { queued: boolean } {
  return { ...syncStatus, failures: [...syncStatus.failures], queued: queuedSync !== null }
}

/** Non-blocking even over SSH: the caller gets status immediately. */
export function startHarnessSync(mode: 'check' | 'upgrade' = 'check', force = false): ReturnType<typeof harnessSyncStatus> {
  if (syncWork) {
    if (force) queuedSync = mode === 'upgrade' || queuedSync === 'upgrade' ? 'upgrade' : 'check'
    return harnessSyncStatus()
  }
  // The timer only asks whether a daily sweep is due. An explicit UI action
  // always bypasses this gate, including after a recent automatic check.
  if (!force && mode === 'check' && syncStatus.finishedAt &&
      syncStatus.failures.length === 0 && Date.now() - syncStatus.finishedAt < HARNESS_DAILY_MS) {
    return harnessSyncStatus()
  }
  const machines: Array<string | null> = [null, ...allHosts()]
  syncStatus = { running: true, mode, startedAt: Date.now(), finishedAt: null, completed: 0, total: 0, failures: [] }
  syncWork = (async () => {
    // Let the initiating HTTP request return before the first CLI/SSH probe.
    await Bun.sleep(0)
    for (const host of machines) {
      const machine = host ?? 'This Machine'
      let bins: Map<string, string | null>
      try {
        bins = await new Transport(host).whichAllAsync(HARNESS_CATALOG.map((item) => item.bin))
      } catch (error) {
        syncStatus.failures.push({ machine, harness: 'Catalog', detail: error instanceof Error ? error.message : String(error) })
        continue
      }
      const installed = HARNESS_CATALOG.filter((item) => bins.get(item.bin))
      syncStatus.total += installed.length
      // Two at a time keeps a remote host responsive while still overlapping a
      // model handshake with its registry check. Other machines never block UI.
      for (let index = 0; index < installed.length; index += 2) {
        await Promise.all(installed.slice(index, index + 2).map(async (item) => {
          const key = `${host ?? ''}:${item.id}`
          const adapter = getAdapter(item.id)
          const lastModel = modelRefreshAt.get(key) ?? 0
          const prior = harnessUpdates.get(key)
          const modelsDue = !priming.has(key) && (force || Date.now() - lastModel >= HARNESS_DAILY_MS)
          const updateDue = force || !prior || prior.status === 'unknown' || Date.now() - prior.checkedAt >= HARNESS_DAILY_MS
          try {
            const results = await Promise.allSettled([
              adapter?.refreshModels && modelsDue
                ? (async () => {
                    modelRefreshAt.set(key, Date.now())
                    await adapter.refreshModels!(host)
                    rememberModelRefresh(key)
                    primeErrors.delete(key)
                  })()
                : Promise.resolve(),
              updateDue ? checkHarnessUpdate(host, item.id, true) : Promise.resolve(prior ?? null),
            ])
            if (results[0]?.status === 'rejected') {
              const detail = String(results[0].reason)
              primeErrors.set(key, detail)
              syncStatus.failures.push({ machine, harness: item.label, detail: `Models: ${detail}` })
            }
            if (results[1]?.status === 'fulfilled' && results[1].value) {
              rememberHarnessUpdate(key, results[1].value)
              if (results[1].value.status === 'unknown') {
                syncStatus.failures.push({ machine, harness: item.label, detail: results[1].value.detail })
              }
              if (mode === 'upgrade' && results[1].value.status === 'available') {
                const updated = await applyHarnessUpdate(host, item.id)
                rememberHarnessUpdate(key, updated)
                if (updated.status !== 'current') throw new Error(updated.detail)
                if (adapter?.refreshModels) {
                  await adapter.refreshModels(host)
                  rememberModelRefresh(key)
                  primeErrors.delete(key)
                }
              }
            } else if (results[1]?.status === 'rejected') {
              throw results[1].reason
            }
          } catch (error) {
            syncStatus.failures.push({ machine, harness: item.label, detail: error instanceof Error ? error.message : String(error) })
          } finally {
            syncStatus.completed += 1
          }
        }))
      }
      // The coverage contract follows the installed versions of this machine.
      if (host === null) {
        const installedVersions = Object.fromEntries(
          installed.map((item) => [item.id, harnessUpdates.get(`:${item.id}`)?.installedVersion ?? null]),
        )
        await refreshCoverage(installedVersions).catch(() => undefined)
      }
      invalidateCapabilities()
      try { broadcast({ t: 'caps', caps: await capabilities(host) }) }
      catch (error) { syncStatus.failures.push({ machine, harness: 'Catalog', detail: String(error) }) }
    }
    syncStatus.running = false
    syncStatus.finishedAt = Date.now()
    db.kvSet(HARNESS_SYNC_KEY, JSON.stringify(syncStatus))
  })().catch((error: unknown) => {
    syncStatus.failures.push({ machine: 'Sedano', harness: 'Catalog', detail: error instanceof Error ? error.message : String(error) })
    syncStatus.running = false
    syncStatus.finishedAt = Date.now()
    db.kvSet(HARNESS_SYNC_KEY, JSON.stringify(syncStatus))
  }).finally(() => {
    syncWork = null
    const next = queuedSync
    queuedSync = null
    if (next) startHarnessSync(next, true)
  })
  return harnessSyncStatus()
}

export function wired(): HarnessId[] {
  return wiredHarnesses()
}

/** Keep the per-session metric readout alive while a turn is running. */
export function startMetricsTicker(intervalMs = 1000): void {
  if (metricsTicker) clearInterval(metricsTicker)
  metricsTicker = setInterval(() => {
    for (const entry of entries.values()) {
      if (entry.meter.isTurnActive) flushMetrics(entry, true)
    }
  }, intervalMs)
}

let metricsTicker: ReturnType<typeof setInterval> | null = null

/**
 * Release this server's hold on every session, for a process that is exiting.
 *
 * Not a stop. A durable agent is meant to outlive the server — the next one
 * reattaches to it — so only what reads it goes: its tail. Everything else is
 * owned by this process and ends with it anyway, so it is ended cleanly here
 * rather than left to notice a closed pipe: a terminal driver's stop is a
 * detach (tmux keeps the shell), a stdio agent's stop is its exit. The
 * generation is bumped first so nothing a driver says on the way out is
 * written down as the session's state.
 *
 * Bounded by `timeoutMs`: the desktop shell sends SIGKILL two seconds after
 * SIGTERM, and a shutdown that does not finish is a crash with extra steps.
 */
export async function shutdown(timeoutMs = 1000): Promise<void> {
  if (metricsTicker) clearInterval(metricsTicker)
  metricsTicker = null
  for (const entry of entries.values()) {
    disarmInterrupt(entry)
    // The last reading, whatever the throttle skipped: the next boot starts from it.
    if (entry.driver) saveMetrics(entry, true)
    newGeneration(entry)
    const driver = entry.driver
    if (!driver) continue
    try {
      // A durable driver lets go of its process without ending it; every other
      // driver owns nothing that should survive this process, so it stops.
      if (driver.detach) driver.detach()
      else driver.stop()
    } catch (err) {
      console.error(`sedano: could not release ${entry.summary.id} on shutdown:`, err)
    }
  }
  await stopAllTails(timeoutMs)
}
