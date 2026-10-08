import { Database } from 'bun:sqlite'
import { join } from 'node:path'
import { SEDANO_HOME, ensureDirs, makePrivate } from './paths.ts'
import { beginMigrationBackup } from './db-backup.ts'
import { SEDANO_VERSION } from './version.ts'
import type {
  Ack,
  ActorOwnership as SharedActorOwnership,
  ActorStatus as SharedActorStatus,
  AttachmentRef,
  EffortLevel,
  HarnessId,
  LimitSnapshot,
  MachineColorId,
  PromptDelivery,
  RequestKind,
  RequestState,
  SessionEvent,
  SessionStatus,
  TimelineEvent,
  TurnStatus,
} from '@shared'
import { asMachineColorId, machineColorKey } from '@shared'

export interface SessionRow {
  id: string
  harness: HarnessId
  kind: string
  title: string
  cwd: string
  host: string | null
  model: string | null
  status: SessionStatus
  created_at: number
  updated_at: number
  native_id: string | null
  transcript_path: string | null
  resume_hint: string | null
  permission_mode: string
  effort: string | null
  git_branch: string | null
  pinned: number
  started: number
  preset: string | null
  /** 'user' once the user named the session: no derived title may replace it. */
  title_source: string
  /** The agent session a docked terminal belongs to (see `SessionSummary.parentSessionId`). */
  parent_session_id: string | null
  /** 1 once the user archived it: kept whole, but not loaded or listed (see `loadSessions`). */
  archived: number
}

ensureDirs()
const db = new Database(join(SEDANO_HOME, 'sedano.db'), { create: true })
db.exec('PRAGMA journal_mode = WAL')
// The database and its WAL are created after `ensureDirs` tightened the store,
// with the default modes; they hold every conversation.
for (const file of ['sedano.db', 'sedano.db-wal', 'sedano.db-shm']) makePrivate(join(SEDANO_HOME, file))
db.exec('PRAGMA synchronous = NORMAL')
// Without it a second opener of this file (a check script, a sidecar started
// next to a dev server, the WAL checkpoint) turns into SQLITE_BUSY thrown from
// whatever write happened to collide — mid-event, mid-delete. A short wait is
// the better failure.
db.exec('PRAGMA busy_timeout = 3000')
// Every schema statement from here to `migrationBackup.finish()` at the end of
// this file is a migration: a release that changes the schema keeps a copy.
const migrationBackup = beginMigrationBackup(db, join(SEDANO_HOME, 'sedano.db'), SEDANO_VERSION)
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    harness TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'agent',
    title TEXT NOT NULL DEFAULT '',
    cwd TEXT NOT NULL DEFAULT '',
    host TEXT,
    model TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    native_id TEXT,
    transcript_path TEXT,
    resume_hint TEXT,
    permission_mode TEXT NOT NULL DEFAULT 'acceptEdits',
    effort TEXT,
    git_branch TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    preset TEXT,
    started INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    at INTEGER NOT NULL,
    agent_id TEXT,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS events_by_session ON events(session_id, seq);
  CREATE TABLE IF NOT EXISTS limits (
    harness TEXT PRIMARY KEY,
    snapshot TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kv (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );
`)

export interface SessionUpsert {
  started?: boolean
  id: string
  harness: HarnessId
  kind: string
  title: string
  cwd: string
  host: string | null
  model: string | null
  status: SessionStatus
  createdAt: number
  updatedAt: number
  nativeId: string | null
  transcriptPath: string | null
  resumeHint: string | null
  permissionMode: string
  effort: string | null
  gitBranch: string | null
  pinned: number
  preset?: string | null
  titleSource?: 'user' | 'auto'
  parentSessionId?: string | null
}

/** Add columns to databases created by an earlier build. */
function ensureColumn(table: string, column: string, definition: string): void {
  const existing = db.query<{ name: string }, []>(`PRAGMA table_info(${table})`).all()
  if (existing.some((entry) => entry.name === column)) return
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`)
}

ensureColumn('sessions', 'permission_mode', "permission_mode TEXT NOT NULL DEFAULT 'acceptEdits'")
ensureColumn('sessions', 'effort', 'effort TEXT')
ensureColumn('sessions', 'git_branch', 'git_branch TEXT')
ensureColumn('sessions', 'preset', 'preset TEXT')
ensureColumn('sessions', 'started', 'started INTEGER NOT NULL DEFAULT 0')
ensureColumn('sessions', 'title_source', "title_source TEXT NOT NULL DEFAULT 'auto'")
ensureColumn('sessions', 'parent_session_id', 'parent_session_id TEXT')
ensureColumn('sessions', 'archived', 'archived INTEGER NOT NULL DEFAULT 0')

function ensureSessionScopedEventIds(): void {
  const columns = db.query<{ name: string; pk: number }, []>('PRAGMA table_info(events)').all()
  const scoped = columns.find((column) => column.name === 'session_id')?.pk
  const id = columns.find((column) => column.name === 'id')?.pk
  if (scoped && id) return

  db.transaction(() => {
    db.exec('DROP INDEX IF EXISTS events_by_session')
    db.exec('ALTER TABLE events RENAME TO events_legacy')
    db.exec(`
      CREATE TABLE events (
        id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        at INTEGER NOT NULL,
        agent_id TEXT,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        PRIMARY KEY (session_id, id)
      )
    `)
    db.exec(`
      INSERT INTO events (id, session_id, seq, at, agent_id, kind, payload)
      SELECT id, session_id, seq, at, agent_id, kind, payload FROM events_legacy
    `)
    db.exec('DROP TABLE events_legacy')
    db.exec('CREATE INDEX events_by_session ON events(session_id, seq)')
  })()
}

ensureSessionScopedEventIds()

/**
 * Turn identity and parent links for events.
 *
 * Applied in one transaction so a database is never left holding half of them,
 * and as plain nullable columns so every historical row keeps loading: an event
 * written before turns existed has no turn, which is what `null` says, and the
 * UI falls back to its sequential heuristic for exactly those.
 */
function ensureEventTurnColumns(): void {
  db.transaction(() => {
    ensureColumn('events', 'turn_id', 'turn_id TEXT')
    ensureColumn('events', 'parent_event_id', 'parent_event_id TEXT')
    ensureColumn('events', 'parent_agent_id', 'parent_agent_id TEXT')
  })()
}

ensureEventTurnColumns()

/**
 * Prompts accepted while a turn was running, waiting for the next one.
 *
 * On disk, not in memory: a prompt the user was told is waiting must still be
 * waiting after a restart, and a queue that only lives in the process turns a
 * crash into silently swallowed work — which is the failure this table exists to
 * prevent. `id` is an autoincrement, so the order the user typed in is the order
 * they go out in and a prompt can be dropped by identity once it has actually
 * been handed over. Created after the schema literal above, so an existing
 * database gains it without being rebuilt.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS prompt_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    prompt_id TEXT,
    text TEXT NOT NULL,
    attachments TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS prompt_queue_by_session ON prompt_queue(session_id, id);
`)
ensureColumn('prompt_queue', 'prompt_id', 'prompt_id TEXT')
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS prompt_queue_by_prompt ON prompt_queue(prompt_id) WHERE prompt_id IS NOT NULL')

/**
 * Execution Ledger v2.
 *
 * These rows deliberately contain identity and lifecycle, not conversation
 * text. Events remain the canonical transcript; the ledger is the durable
 * answer to "was this command already run?" and "who still owns this turn?".
 * All tables are additive so an old database can open without a rewrite, and
 * all state constraints are also enforced by the mutation helpers below.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS commands (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    session_id TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'failed')),
    ack TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK ((state = 'pending' AND ack IS NULL) OR (state != 'pending' AND ack IS NOT NULL))
  );
  CREATE INDEX IF NOT EXISTS commands_by_session ON commands(session_id, created_at);
  CREATE INDEX IF NOT EXISTS commands_pending ON commands(state, created_at);

  CREATE TABLE IF NOT EXISTS prompts (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    command_id TEXT,
    user_event_id TEXT,
    turn_id TEXT,
    ordinal INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('accepted', 'queued', 'starting', 'delivered', 'cancelled', 'failed')),
    reason TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (session_id, ordinal)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS prompts_by_command
    ON prompts(command_id) WHERE command_id IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS prompts_by_user_event
    ON prompts(session_id, user_event_id) WHERE user_event_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS prompts_by_session ON prompts(session_id, ordinal);
  CREATE INDEX IF NOT EXISTS prompts_recoverable ON prompts(session_id, state, ordinal);

  CREATE TABLE IF NOT EXISTS turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    prompt_id TEXT,
    run_token TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('starting', 'running', 'completed', 'cancelled', 'failed')),
    outcome TEXT CHECK (outcome IN ('completed', 'interrupted', 'failed')),
    subtype TEXT,
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    UNIQUE (prompt_id),
    CHECK (
      (state IN ('starting', 'running') AND outcome IS NULL AND completed_at IS NULL)
      OR
      (state = 'completed' AND outcome = 'completed' AND completed_at IS NOT NULL)
      OR (state = 'cancelled' AND outcome = 'interrupted' AND completed_at IS NOT NULL)
      OR (state = 'failed' AND outcome = 'failed' AND completed_at IS NOT NULL)
    )
  );
  CREATE INDEX IF NOT EXISTS turns_by_session ON turns(session_id, started_at);
  CREATE INDEX IF NOT EXISTS turns_active ON turns(session_id, state, started_at);

  CREATE TABLE IF NOT EXISTS actors (
    session_id TEXT NOT NULL,
    id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    parent_actor_id TEXT,
    spawn_event_id TEXT,
    ownership TEXT NOT NULL CHECK (ownership IN ('provider', 'sedano')),
    provider TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    model TEXT,
    status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'completed', 'failed', 'cancelled')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (turn_id, id)
  );
  CREATE INDEX IF NOT EXISTS actors_by_turn ON actors(turn_id, created_at);
  CREATE INDEX IF NOT EXISTS actors_active ON actors(turn_id, status, created_at);
  CREATE INDEX IF NOT EXISTS actors_by_parent ON actors(session_id, parent_actor_id, created_at);
`)

// An intermediate development build may already have created `commands`
// without request identity. Keep opening that database; its old rows use the
// empty fingerprint and therefore fail closed against any non-empty replay.
ensureColumn('commands', 'fingerprint', "fingerprint TEXT NOT NULL DEFAULT ''")

/**
 * Early ledger prototypes scoped actors only by session. A main actor spans
 * many turns, so that key silently moved its old row to the new turn. Scope the
 * identity by turn instead: history stays intact and provider ids may repeat in
 * later turns without collision.
 */
function ensureTurnScopedActorIds(): void {
  const columns = db.query<{ name: string; pk: number }, []>('PRAGMA table_info(actors)').all()
  const turnPk = columns.find((column) => column.name === 'turn_id')?.pk
  const idPk = columns.find((column) => column.name === 'id')?.pk
  if (turnPk === 1 && idPk === 2) return

  db.transaction(() => {
    db.exec('DROP INDEX IF EXISTS actors_by_turn')
    db.exec('DROP INDEX IF EXISTS actors_active')
    db.exec('DROP INDEX IF EXISTS actors_by_parent')
    db.exec('ALTER TABLE actors RENAME TO actors_legacy')
    db.exec(`
      CREATE TABLE actors (
        session_id TEXT NOT NULL,
        id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        parent_actor_id TEXT,
        spawn_event_id TEXT,
        ownership TEXT NOT NULL CHECK (ownership IN ('provider', 'sedano')),
        provider TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        model TEXT,
        status TEXT NOT NULL CHECK (status IN ('starting', 'running', 'completed', 'failed', 'cancelled')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (turn_id, id)
      )
    `)
    db.exec(`
      INSERT OR IGNORE INTO actors
        (session_id, id, turn_id, parent_actor_id, spawn_event_id, ownership, provider,
         title, description, model, status, created_at, updated_at)
      SELECT session_id, id, turn_id, parent_actor_id, spawn_event_id, ownership, provider,
         title, description, model, status, created_at, updated_at
      FROM actors_legacy
    `)
    db.exec('DROP TABLE actors_legacy')
    db.exec('CREATE INDEX actors_by_turn ON actors(turn_id, created_at)')
    db.exec('CREATE INDEX actors_active ON actors(turn_id, status, created_at)')
    db.exec('CREATE INDEX actors_by_parent ON actors(session_id, parent_actor_id, created_at)')
  })()
}

ensureTurnScopedActorIds()

/* ------------------------------------------------------------------ */
/* Execution Ledger v2                                                */
/* ------------------------------------------------------------------ */

export type CommandState = 'pending' | 'completed' | 'failed'
export type PromptState = PromptDelivery
export type TurnState = TurnStatus
export type TurnOutcome = 'completed' | 'interrupted' | 'failed'
export type ActorOwnership = SharedActorOwnership
export type ActorStatus = SharedActorStatus

export interface CommandRow {
  id: string
  kind: string
  fingerprint: string
  sessionId: string | null
  state: CommandState
  ack: Ack | null
  createdAt: number
  updatedAt: number
}

type RawCommand = {
  id: string
  kind: string
  fingerprint: string
  session_id: string | null
  state: CommandState
  ack: string | null
  created_at: number
  updated_at: number
}

function toCommand(row: RawCommand): CommandRow {
  return {
    id: row.id,
    kind: row.kind,
    fingerprint: row.fingerprint,
    sessionId: row.session_id,
    state: row.state,
    ack: row.ack ? JSON.parse(row.ack) as Ack : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export type CommandClaim =
  | { state: 'new'; command: CommandRow }
  | { state: 'pending'; command: CommandRow }
  | { state: 'completed' | 'failed'; command: CommandRow; ack: Ack }
  | { state: 'conflict'; command: CommandRow }

/** Atomically reserve a command id before performing its side effect. */
export function claimCommand(
  id: string,
  kind: string,
  fingerprint: string,
  sessionId: string | null = null,
  at = Date.now(),
): CommandClaim {
  return db.transaction(() => {
    const inserted = db.query(
      `INSERT OR IGNORE INTO commands (id, kind, fingerprint, session_id, state, ack, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', NULL, ?, ?)`,
    ).run(id, kind, fingerprint, sessionId, at, at)
    let command = getCommand(id)
    if (!command) throw new Error(`command claim disappeared: ${id}`)
    if (inserted.changes > 0) return { state: 'new' as const, command }
    if (
      command.kind !== kind
      || command.fingerprint !== fingerprint
      || Boolean(command.sessionId && sessionId && command.sessionId !== sessionId)
    ) {
      return { state: 'conflict' as const, command }
    }
    if (command.state === 'pending') {
      db.query(
        `UPDATE commands SET session_id = COALESCE(session_id, ?), updated_at = MAX(updated_at, ?)
         WHERE id = ? AND state = 'pending'`,
      ).run(sessionId, at, id)
      command = getCommand(id) ?? command
      return { state: 'pending' as const, command }
    }
    if (!command.ack) throw new Error(`terminal command has no ack: ${id}`)
    return { state: command.state, command, ack: command.ack }
  })()
}

/** First terminal result wins; a retry or late completion cannot replace it. */
export function completeCommand(id: string, ack: Ack, at = Date.now()): boolean {
  if (ack.cid !== id) throw new Error(`ack ${ack.cid} does not belong to command ${id}`)
  const state: Exclude<CommandState, 'pending'> = ack.ok ? 'completed' : 'failed'
  return db.query(
    `UPDATE commands SET state = ?, ack = ?, session_id = COALESCE(session_id, ?), updated_at = ?
     WHERE id = ? AND state = 'pending'`,
  ).run(state, JSON.stringify(ack), ack.sessionId ?? null, at, id).changes > 0
}

/**
 * Settled commands are kept for replay, not forever. A replay comes from a
 * client reconnecting, which is seconds or minutes; a row per prompt carrying
 * the prompt's full text as its fingerprint made this the one table that grew
 * for the whole life of the install. Pending rows are never pruned: they are
 * what the fail-closed recovery reads.
 */
const COMMAND_RETENTION_MS = 30 * 24 * 60 * 60_000

export function pruneCommands(before = Date.now() - COMMAND_RETENTION_MS): number {
  return db.query("DELETE FROM commands WHERE state != 'pending' AND updated_at < ?").run(before).changes
}

pruneCommands()

export function getCommand(id: string): CommandRow | null {
  const row = db.query<RawCommand, [string]>('SELECT * FROM commands WHERE id = ?').get(id)
  return row ? toCommand(row) : null
}

export interface PromptRow {
  id: string
  sessionId: string
  commandId: string | null
  userEventId: string | null
  turnId: string | null
  ordinal: number
  state: PromptState
  reason: string | null
  createdAt: number
  updatedAt: number
}

type RawPrompt = {
  id: string
  session_id: string
  command_id: string | null
  user_event_id: string | null
  turn_id: string | null
  ordinal: number
  state: PromptState
  reason: string | null
  created_at: number
  updated_at: number
}

function toPrompt(row: RawPrompt): PromptRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    commandId: row.command_id,
    userEventId: row.user_event_id,
    turnId: row.turn_id,
    ordinal: row.ordinal,
    state: row.state,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface AcceptPromptInput {
  id: string
  sessionId: string
  commandId?: string | null
  userEventId?: string | null
  turnId?: string | null
  state?: PromptState
  /** Shared wire-model spelling accepted by the manager adapter. */
  delivery?: PromptState
  at?: number
  createdAt?: number
  updatedAt?: number
}

/** Allocate a stable FIFO position once. Re-accepting the same id is harmless. */
export function acceptPrompt(input: AcceptPromptInput): PromptRow {
  return db.transaction(() => {
    const at = input.at ?? input.createdAt ?? Date.now()
    const state = input.state ?? input.delivery ?? 'accepted'
    db.query(
      `INSERT OR IGNORE INTO prompts
         (id, session_id, command_id, user_event_id, turn_id, ordinal, state, reason, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, COALESCE(MAX(ordinal), 0) + 1, ?, NULL, ?, ?
       FROM prompts WHERE session_id = ?`,
    ).run(
      input.id,
      input.sessionId,
      input.commandId ?? null,
      input.userEventId ?? null,
      input.turnId ?? null,
      state,
      at,
      input.updatedAt ?? at,
      input.sessionId,
    )
    // Learn correlations that may only become known after acceptance, but never
    // move the prompt to another session or replace an established identity.
    db.query(
      `UPDATE prompts SET
         command_id = COALESCE(command_id, ?),
         user_event_id = COALESCE(user_event_id, ?),
         turn_id = COALESCE(turn_id, ?)
       WHERE id = ? AND session_id = ?`,
    ).run(input.commandId ?? null, input.userEventId ?? null, input.turnId ?? null, input.id, input.sessionId)
    const prompt = getPrompt(input.id)
    if (!prompt) throw new Error(`prompt acceptance conflicted with another identity: ${input.id}`)
    if (prompt.sessionId !== input.sessionId) {
      throw new Error(`prompt ${input.id} already belongs to session ${prompt.sessionId}`)
    }
    return prompt
  })()
}

export function getPrompt(id: string): PromptRow | null {
  const row = db.query<RawPrompt, [string]>('SELECT * FROM prompts WHERE id = ?').get(id)
  return row ? toPrompt(row) : null
}

export function listPrompts(sessionId: string): PromptRow[] {
  return db.query<RawPrompt, [string]>(
    'SELECT * FROM prompts WHERE session_id = ? ORDER BY ordinal ASC',
  ).all(sessionId).map(toPrompt)
}

export function recoverablePrompts(sessionId: string): PromptRow[] {
  return db.query<RawPrompt, [string]>(
    `SELECT * FROM prompts
     WHERE session_id = ? AND state IN ('accepted', 'queued', 'starting')
     ORDER BY ordinal ASC`,
  ).all(sessionId).map(toPrompt)
}

const promptRank: Record<PromptState, number> = {
  accepted: 0,
  queued: 1,
  starting: 2,
  delivered: 3,
  cancelled: 3,
  failed: 3,
}

export interface PromptAdvance {
  turnId?: string | null
  userEventId?: string | null
  reason?: string | null
  at?: number
}

/** Advance lifecycle and optionally enrich correlations; terminal states stick. */
export function advancePrompt(id: string, state: PromptState, patch: PromptAdvance = {}): PromptRow | null {
  const at = patch.at ?? Date.now()
  const rank = promptRank[state]
  db.query(
    `UPDATE prompts SET
       state = CASE
         WHEN CASE state
           WHEN 'accepted' THEN 0 WHEN 'queued' THEN 1 WHEN 'starting' THEN 2 ELSE 3 END < ?
         THEN ? ELSE state END,
       turn_id = COALESCE(turn_id, ?),
       user_event_id = COALESCE(user_event_id, ?),
       reason = CASE
         WHEN CASE state
           WHEN 'accepted' THEN 0 WHEN 'queued' THEN 1 WHEN 'starting' THEN 2 ELSE 3 END < ?
         THEN ? ELSE reason END,
       updated_at = CASE
         WHEN CASE state
           WHEN 'accepted' THEN 0 WHEN 'queued' THEN 1 WHEN 'starting' THEN 2 ELSE 3 END < ?
         THEN MAX(updated_at, ?) ELSE updated_at END
     WHERE id = ?`,
  ).run(
    rank, state,
    patch.turnId ?? null,
    patch.userEventId ?? null,
    rank, patch.reason ?? null,
    rank, at,
    id,
  )
  return getPrompt(id)
}

/** Object-form adapter used by the manager and wire projection. */
export function updatePrompt(
  id: string,
  patch: Partial<{ delivery: PromptState; state: PromptState; turnId: string | null; userEventId: string | null; error: string | null; reason: string | null; updatedAt: number }>,
): PromptRow | null {
  const existing = getPrompt(id)
  if (!existing) return null
  return advancePrompt(id, patch.state ?? patch.delivery ?? existing.state, {
    turnId: patch.turnId,
    userEventId: patch.userEventId,
    reason: patch.reason ?? patch.error,
    at: patch.updatedAt,
  })
}

export interface TurnRow {
  id: string
  sessionId: string
  promptId: string | null
  runToken: string
  state: TurnState
  outcome: TurnOutcome | null
  subtype: string | null
  startedAt: number
  updatedAt: number
  completedAt: number | null
}

type RawTurn = {
  id: string
  session_id: string
  prompt_id: string | null
  run_token: string
  state: TurnState
  outcome: TurnOutcome | null
  subtype: string | null
  started_at: number
  updated_at: number
  completed_at: number | null
}

function toTurn(row: RawTurn): TurnRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    promptId: row.prompt_id,
    runToken: row.run_token,
    state: row.state,
    outcome: row.outcome,
    subtype: row.subtype,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

export interface StartTurnInput {
  id: string
  sessionId: string
  promptId?: string | null
  runToken: string
  state?: TurnState
  /** Shared wire-model spelling accepted by the manager adapter. */
  status?: TurnState
  startedAt?: number
}

/** A turn's owner token is immutable: retries return the original row. */
export function startTurn(input: StartTurnInput): TurnRow {
  const at = input.startedAt ?? Date.now()
  db.query(
    `INSERT OR IGNORE INTO turns
       (id, session_id, prompt_id, run_token, state, outcome, subtype, started_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, 'starting', NULL, NULL, ?, ?, NULL)`,
  ).run(input.id, input.sessionId, input.promptId ?? null, input.runToken, at, at)
  const turn = getTurn(input.id)
  if (!turn) throw new Error(`turn start conflicted with another identity: ${input.id}`)
  if (turn.sessionId !== input.sessionId || turn.runToken !== input.runToken) {
    throw new Error(`turn ${input.id} is owned by another run`)
  }
  return turn
}

export function getTurn(id: string): TurnRow | null {
  const row = db.query<RawTurn, [string]>('SELECT * FROM turns WHERE id = ?').get(id)
  return row ? toTurn(row) : null
}

export function listTurns(sessionId: string): TurnRow[] {
  return db.query<RawTurn, [string]>(
    'SELECT * FROM turns WHERE session_id = ? ORDER BY started_at ASC',
  ).all(sessionId).map(toTurn)
}

/** Only the persisted owner token may advance or settle the turn. */
export function advanceTurn(
  id: string,
  runToken: string,
  state: Exclude<TurnState, 'starting'>,
  subtype: string | null = null,
  at = Date.now(),
): boolean {
  if (state === 'running') {
    return db.query(
      `UPDATE turns SET state = 'running', updated_at = MAX(updated_at, ?)
       WHERE id = ? AND run_token = ? AND state = 'starting'`,
    ).run(at, id, runToken).changes > 0
  }
  return db.transaction(() => {
    // A terminal turn while one of its actors is still active is a lie that the
    // UI cannot repair. Check and settle under the same write transaction.
    if (hasActiveActorsForTurn(id)) return false
    const outcome: TurnOutcome = state === 'cancelled' ? 'interrupted' : state
    return db.query(
      `UPDATE turns SET state = ?, outcome = ?, subtype = ?, completed_at = ?, updated_at = MAX(updated_at, ?)
       WHERE id = ? AND run_token = ? AND state IN ('starting', 'running')`,
    ).run(state, outcome, subtype, at, at, id, runToken).changes > 0
  })()
}

/**
 * Put a completed turn back to `running`, for the one case where the turn is
 * not over after all: the harness woke up by itself after its last child
 * finished (a background agent's result arriving) and is answering under the
 * same prompt. Only `completed` reopens — a cancelled or failed turn stays the
 * decision it was — and only under its own run token.
 */
export function reopenTurn(id: string, runToken: string, at = Date.now()): boolean {
  return db.query(
    `UPDATE turns SET state = 'running', outcome = NULL, subtype = NULL, completed_at = NULL,
       updated_at = MAX(updated_at, ?)
     WHERE id = ? AND run_token = ? AND state = 'completed'`,
  ).run(at, id, runToken).changes > 0
}

/**
 * Object-form lifecycle adapter. Supplying `runToken` is preferred; omitting it
 * uses the persisted owner for compatibility with the first manager migration.
 */
export function updateTurn(
  id: string,
  patch: Partial<{
    runToken: string
    state: TurnState
    status: TurnState
    subtype: string | null
    updatedAt: number
    endedAt: number | null
  }>,
): boolean {
  const turn = getTurn(id)
  if (!turn) return false
  const state = patch.state ?? patch.status
  if (!state || state === 'starting') return false
  return advanceTurn(
    id,
    patch.runToken ?? turn.runToken,
    state,
    patch.subtype ?? null,
    patch.endedAt ?? patch.updatedAt ?? Date.now(),
  )
}

export interface ActorRow {
  sessionId: string
  id: string
  turnId: string
  parentActorId: string | null
  spawnEventId: string | null
  ownership: ActorOwnership
  provider: string
  title: string
  description: string
  model: string | null
  status: ActorStatus
  createdAt: number
  updatedAt: number
}

type RawActor = {
  session_id: string
  id: string
  turn_id: string
  parent_actor_id: string | null
  spawn_event_id: string | null
  ownership: ActorOwnership
  provider: string
  title: string
  description: string
  model: string | null
  status: ActorStatus
  created_at: number
  updated_at: number
}

function toActor(row: RawActor): ActorRow {
  return {
    sessionId: row.session_id,
    id: row.id,
    turnId: row.turn_id,
    parentActorId: row.parent_actor_id,
    spawnEventId: row.spawn_event_id,
    ownership: row.ownership,
    provider: row.provider,
    title: row.title,
    description: row.description,
    model: row.model,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export interface ActorUpsert {
  sessionId: string
  id: string
  turnId: string | null
  parentActorId?: string | null
  spawnEventId?: string | null
  ownership: ActorOwnership
  provider: string
  title?: string
  description?: string
  model?: string | null
  status: ActorStatus
  at?: number
  updatedAt?: number
}

/**
 * Tool/stream echoes update one actor in place. Nullable correlations are only
 * learned, never erased, and a terminal actor cannot be reopened by a late
 * `running` frame — only by a new run of the same agent (a resumed agent,
 * spawned again by a different card in the same turn), which is live again.
 */
export function upsertActor(input: ActorUpsert): ActorRow {
  if (!input.turnId) throw new Error(`actor ${input.id} has no turn identity`)
  const at = input.at ?? input.updatedAt ?? Date.now()
  const newRun = `(excluded.spawn_event_id IS NOT NULL AND actors.spawn_event_id IS NOT NULL
         AND excluded.spawn_event_id != actors.spawn_event_id)`
  db.query(
    `INSERT INTO actors
       (session_id, id, turn_id, parent_actor_id, spawn_event_id, ownership, provider,
        title, description, model, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(turn_id, id) DO UPDATE SET
       parent_actor_id = COALESCE(actors.parent_actor_id, excluded.parent_actor_id),
       spawn_event_id = CASE WHEN ${newRun} THEN excluded.spawn_event_id ELSE COALESCE(actors.spawn_event_id, excluded.spawn_event_id) END,
       title = CASE WHEN excluded.title != '' THEN excluded.title ELSE actors.title END,
       description = CASE WHEN excluded.description != '' THEN excluded.description ELSE actors.description END,
       model = COALESCE(excluded.model, actors.model),
       status = CASE
         WHEN ${newRun} THEN excluded.status
         WHEN actors.status IN ('completed', 'failed', 'cancelled') THEN actors.status
         WHEN excluded.status IN ('completed', 'failed', 'cancelled') THEN excluded.status
         WHEN actors.status = 'starting' AND excluded.status = 'running' THEN 'running'
         ELSE actors.status END,
       updated_at = MAX(actors.updated_at, excluded.updated_at)
     WHERE actors.session_id = excluded.session_id
       AND actors.ownership = excluded.ownership
       AND actors.provider = excluded.provider`,
  ).run(
    input.sessionId,
    input.id,
    input.turnId,
    input.parentActorId ?? null,
    input.spawnEventId ?? null,
    input.ownership,
    input.provider,
    input.title ?? '',
    input.description ?? '',
    input.model ?? null,
    input.status,
    at,
    at,
  )
  const actor = getActor(input.sessionId, input.id, input.turnId)
  if (!actor) throw new Error(`actor upsert failed: ${input.id}`)
  if (actor.turnId !== input.turnId || actor.ownership !== input.ownership || actor.provider !== input.provider) {
    throw new Error(`actor ${input.id} conflicts with its persisted identity`)
  }
  return actor
}

export function getActor(sessionId: string, id: string, turnId?: string): ActorRow | null {
  const row = turnId
    ? db.query<RawActor, [string, string, string]>(
      'SELECT * FROM actors WHERE session_id = ? AND id = ? AND turn_id = ?',
    ).get(sessionId, id, turnId)
    : db.query<RawActor, [string, string]>(
      'SELECT * FROM actors WHERE session_id = ? AND id = ? ORDER BY updated_at DESC LIMIT 1',
    ).get(sessionId, id)
  return row ? toActor(row) : null
}

export function listActors(sessionId: string, turnId?: string): ActorRow[] {
  if (turnId) {
    return db.query<RawActor, [string, string]>(
      'SELECT * FROM actors WHERE session_id = ? AND turn_id = ? ORDER BY created_at ASC, id ASC',
    ).all(sessionId, turnId).map(toActor)
  }
  return db.query<RawActor, [string]>(
    'SELECT * FROM actors WHERE session_id = ? ORDER BY created_at ASC, id ASC',
  ).all(sessionId).map(toActor)
}

function hasActiveActorsForTurn(turnId: string): boolean {
  return Boolean(db.query<{ active: number }, [string]>(
    `SELECT 1 AS active FROM actors
     WHERE turn_id = ? AND status IN ('starting', 'running') LIMIT 1`,
  ).get(turnId))
}

export function hasActiveActors(sessionId: string, turnId?: string): boolean {
  if (turnId) {
    return Boolean(db.query<{ active: number }, [string, string]>(
      `SELECT 1 AS active FROM actors
       WHERE session_id = ? AND turn_id = ? AND status IN ('starting', 'running') LIMIT 1`,
    ).get(sessionId, turnId))
  }
  return Boolean(db.query<{ active: number }, [string]>(
    `SELECT 1 AS active FROM actors
     WHERE session_id = ? AND status IN ('starting', 'running') LIMIT 1`,
  ).get(sessionId))
}

/**
 * Questions an agent asked the user, and what became of each.
 *
 * The state of a request used to live only in the driver, as a continuation in a
 * `Map`. That is fine while the process runs and wrong the moment it does not:
 * after a restart the transcript still held a question with no answer, so the
 * card came back looking clickable, wired to a resolver that no longer existed —
 * clicking it did nothing, silently. The lifecycle is a fact about the session,
 * so it is stored with the session: `pending` until something closes it,
 * `answered` with the choice, `expired` when the process that asked is gone,
 * `cancelled` when a stop or an interrupt closed it deliberately.
 *
 * `tool_id` is the id the harness asked under, which is the id an answer names.
 * `kind` is nullable because today every harness asks through the same
 * `AskUserQuestion` tool call, which does not say whether it is a permission
 * prompt or a plain question: NULL is "we were not told", not a guess.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS requests (
    session_id TEXT NOT NULL,
    tool_id TEXT NOT NULL,
    kind TEXT,
    state TEXT NOT NULL,
    asked_at INTEGER NOT NULL,
    closed_at INTEGER,
    answer TEXT,
    PRIMARY KEY (session_id, tool_id)
  );
  CREATE INDEX IF NOT EXISTS requests_pending ON requests(session_id, state);
`)

/**
 * Who owns each pasted image.
 *
 * The bytes were written to disk and never spoken of again: no row, no owner, no
 * delete. An image pasted and then removed from the composer stayed forever, and
 * deleting a session left every image it carried on disk with nothing pointing
 * at it. A row with `session_id`/`event_id` still NULL is an upload nobody has
 * sent yet — deletable on request, and swept once it is old enough to be
 * abandoned — and binding it to the `user` event that carries it is what makes
 * deleting that session take its images with it.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    event_id TEXT,
    name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    extension TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS attachments_by_session ON attachments(session_id);
`)

/**
 * The colour each machine is recognised by, as one `kv` row.
 *
 * No table was added, because there is nothing to query: this is one small map
 * read whole on every read and written whole on every write, with no key to
 * join on and no row to select. `kv` is exactly that shape, and a
 * `machine_colors(host, color)` table would only be a second way to spell it
 * — plus a migration on every database that already exists. The row is created
 * on first write, so an existing database needs no migration at all and a
 * database that has never had one reads as "nobody has chosen" (see
 * `DEFAULT_MACHINE_COLOR`).
 */
const MACHINE_COLORS_KEY = 'machine.colors'

/**
 * Every machine's colour. Unreadable JSON, or an id we no longer offer, is
 * dropped rather than passed on: the default colour is a better answer than a
 * value nothing downstream can draw.
 */
export function machineColors(): Record<string, MachineColorId> {
  const raw = kvGet(MACHINE_COLORS_KEY)
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object') return {}
  const out: Record<string, MachineColorId> = {}
  for (const [host, value] of Object.entries(parsed as Record<string, unknown>)) {
    const colour = asMachineColorId(value)
    if (colour) out[host] = colour
  }
  return out
}

/**
 * Set (or clear) one machine's colour and answer with the whole map, which is
 * what the caller broadcasts. `null` removes the entry rather than storing a
 * "default" id, so "I never chose" and "I chose the one that happens to be the
 * default" stay the same fact — and a future change of default follows.
 */
export function setMachineColor(host: string | null, color: MachineColorId | null): Record<string, MachineColorId> {
  const colors = machineColors()
  const key = machineColorKey(host)
  if (color) colors[key] = color
  else delete colors[key]
  kvSet(MACHINE_COLORS_KEY, JSON.stringify(colors))
  return colors
}

export interface QueuedPrompt {
  id: number
  promptId?: string
  text: string
  /** Absent when the prompt carried no image, never an empty stand-in. */
  attachments?: AttachmentRef[]
  createdAt: number
}

export function enqueuePrompt(
  sessionId: string,
  text: string,
  attachments: AttachmentRef[] | undefined,
  promptId?: string,
  createdAt = Date.now(),
): QueuedPrompt {
  const row = db
    .query<{ id: number }, [string, string | null, string, string | null, number]>(
      `INSERT INTO prompt_queue (session_id, prompt_id, text, attachments, created_at) VALUES (?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(sessionId, promptId ?? null, text, attachments?.length ? JSON.stringify(attachments) : null, createdAt)
  return {
    id: row?.id ?? 0,
    ...(promptId ? { promptId } : {}),
    text,
    ...(attachments?.length ? { attachments } : {}),
    createdAt,
  }
}

export function loadPromptQueue(sessionId: string): QueuedPrompt[] {
  const rows = db
    .query<{ id: number; prompt_id: string | null; text: string; attachments: string | null; created_at: number }, [string]>(
      'SELECT id, prompt_id, text, attachments, created_at FROM prompt_queue WHERE session_id = ? ORDER BY id ASC',
    )
    .all(sessionId)
  return rows.map((row) => ({
    id: row.id,
    ...(row.prompt_id ? { promptId: row.prompt_id } : {}),
    text: row.text,
    ...(row.attachments ? { attachments: JSON.parse(row.attachments) as AttachmentRef[] } : {}),
    createdAt: row.created_at,
  }))
}

export function removeQueuedPrompt(sessionId: string, id: number): void {
  db.query('DELETE FROM prompt_queue WHERE session_id = ? AND id = ?').run(sessionId, id)
}

export function clearPromptQueue(sessionId: string): void {
  db.query('DELETE FROM prompt_queue WHERE session_id = ?').run(sessionId)
}

/* ------------------------------------------------------------------ */
/* Requests                                                            */
/* ------------------------------------------------------------------ */

export interface RequestRow {
  sessionId: string
  toolId: string
  /** Null when the harness did not say which kind of request this is. */
  kind: RequestKind | null
  state: RequestState
  askedAt: number
  closedAt: number | null
  answer: string | null
}

type RawRequest = {
  session_id: string
  tool_id: string
  kind: string | null
  state: string
  asked_at: number
  closed_at: number | null
  answer: string | null
}

function toRequest(row: RawRequest): RequestRow {
  return {
    sessionId: row.session_id,
    toolId: row.tool_id,
    kind: row.kind === 'question' || row.kind === 'permission' ? row.kind : null,
    state: row.state as RequestState,
    askedAt: row.asked_at,
    closedAt: row.closed_at,
    answer: row.answer,
  }
}

/**
 * Record that the agent is waiting on the user. `OR IGNORE`, because the event
 * that opens a request can be written more than once (a stream frame and the
 * transcript can both describe the same tool call) and the second telling must
 * not reopen a question that has already been answered.
 */
export function openRequest(
  sessionId: string,
  toolId: string,
  kind: RequestKind | null,
  askedAt = Date.now(),
): void {
  db.query(
    `INSERT OR IGNORE INTO requests (session_id, tool_id, kind, state, asked_at) VALUES (?, ?, ?, 'pending', ?)`,
  ).run(sessionId, toolId, kind, askedAt)
}

/**
 * Close a request. Only a `pending` one can be closed, so the first outcome to
 * arrive is the one that sticks: a second client answering, or a stop racing the
 * answer that was already taken, changes nothing and is told so by the `false`.
 */
export function closeRequest(
  sessionId: string,
  toolId: string,
  state: Exclude<RequestState, 'pending'>,
  answer: string | null = null,
  closedAt = Date.now(),
): boolean {
  const result = db
    .query(
      `UPDATE requests SET state = ?, answer = ?, closed_at = ?
       WHERE session_id = ? AND tool_id = ? AND state = 'pending'`,
    )
    .run(state, answer, closedAt, sessionId, toolId)
  return result.changes > 0
}

export function getRequest(sessionId: string, toolId: string): RequestRow | null {
  const row = db
    .query<RawRequest, [string, string]>('SELECT * FROM requests WHERE session_id = ? AND tool_id = ?')
    .get(sessionId, toolId)
  return row ? toRequest(row) : null
}

export function pendingRequests(sessionId: string): RequestRow[] {
  return db
    .query<RawRequest, [string]>(
      `SELECT * FROM requests WHERE session_id = ? AND state = 'pending' ORDER BY asked_at ASC`,
    )
    .all(sessionId)
    .map(toRequest)
}

/* ------------------------------------------------------------------ */
/* Attachments                                                         */
/* ------------------------------------------------------------------ */

export interface AttachmentRow {
  id: string
  sessionId: string | null
  eventId: string | null
  name: string
  mediaType: string
  extension: string
  bytes: number
  createdAt: number
}

type RawAttachment = {
  id: string
  session_id: string | null
  event_id: string | null
  name: string
  media_type: string
  extension: string
  bytes: number
  created_at: number
}

function toAttachment(row: RawAttachment): AttachmentRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    eventId: row.event_id,
    name: row.name,
    mediaType: row.media_type,
    extension: row.extension,
    bytes: row.bytes,
    createdAt: row.created_at,
  }
}

export function insertAttachment(row: Omit<AttachmentRow, 'sessionId' | 'eventId'>): void {
  db.query(
    `INSERT OR REPLACE INTO attachments (id, session_id, event_id, name, media_type, extension, bytes, created_at)
     VALUES (?, NULL, NULL, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.name, row.mediaType, row.extension, row.bytes, row.createdAt)
}

export function getAttachment(id: string): AttachmentRow | null {
  const row = db.query<RawAttachment, [string]>('SELECT * FROM attachments WHERE id = ?').get(id)
  return row ? toAttachment(row) : null
}

/**
 * Hand a set of uploads to the message that carries them. Only an unbound row is
 * claimed: the same image referenced again by a later event belongs to the first
 * message that sent it, and re-binding it would move it out from under that one.
 */
export function bindAttachments(ids: string[], sessionId: string, eventId: string): void {
  if (!ids.length) return
  const bind = db.query(
    'UPDATE attachments SET session_id = ?, event_id = ? WHERE id = ? AND session_id IS NULL',
  )
  db.transaction(() => {
    for (const id of ids) bind.run(sessionId, eventId, id)
  })()
}

export function deleteAttachmentRow(id: string): void {
  db.query('DELETE FROM attachments WHERE id = ?').run(id)
}

export function attachmentsOfSession(sessionId: string): AttachmentRow[] {
  return db
    .query<RawAttachment, [string]>('SELECT * FROM attachments WHERE session_id = ?')
    .all(sessionId)
    .map(toAttachment)
}

/** Uploads that were never sent and are old enough to be abandoned. */
export function staleUnboundAttachments(before: number): AttachmentRow[] {
  return db
    .query<RawAttachment, [number]>(
      'SELECT * FROM attachments WHERE session_id IS NULL AND created_at < ?',
    )
    .all(before)
    .map(toAttachment)
}

export function upsertSession(row: SessionUpsert): void {
  db.query(
    `INSERT INTO sessions (id, harness, kind, title, cwd, host, model, status, created_at, updated_at, native_id, transcript_path, resume_hint, permission_mode, effort, git_branch, pinned, preset, started, title_source, parent_session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       -- A name the user chose is only ever replaced by another one they chose:
       -- whatever the in-memory summary says, a derived title cannot win here.
       title = CASE WHEN sessions.title_source = 'user' AND excluded.title_source != 'user' THEN sessions.title ELSE excluded.title END,
       title_source = CASE WHEN sessions.title_source = 'user' THEN 'user' ELSE excluded.title_source END,
       parent_session_id = excluded.parent_session_id,
       model = excluded.model,
       status = excluded.status,
       updated_at = excluded.updated_at,
       native_id = excluded.native_id,
       transcript_path = excluded.transcript_path,
       resume_hint = excluded.resume_hint,
       permission_mode = excluded.permission_mode,
       effort = excluded.effort,
       git_branch = excluded.git_branch,
       preset = excluded.preset,
       pinned = excluded.pinned,
       started = excluded.started`,
   ).run(
     row.id,
     row.harness,
     row.kind,
     row.title,
     row.cwd,
     row.host,
     row.model,
     row.status,
     row.createdAt,
     row.updatedAt,
     row.nativeId,
     row.transcriptPath,
     row.resumeHint,
     row.permissionMode,
     row.effort,
     row.gitBranch,
     row.pinned,
     row.preset ?? null,
     row.started ? 1 : 0,
     row.titleSource ?? 'auto',
     row.parentSessionId ?? null,
   )
}

/**
 * The last name the user gave each session, from the command ledger.
 *
 * A rename is a durable command whose fingerprint carries the new title, and
 * the ledger outlives whatever an earlier build did to the session row. That
 * makes it the record to recover a lost rename from (see `manager.restore`).
 */
export function ledgerRenames(): Map<string, string> {
  const rows = db
    .query<{ session_id: string | null; fingerprint: string }, []>(
      `SELECT session_id, fingerprint FROM commands
       WHERE kind = 'rename_session' AND state = 'completed'
       ORDER BY created_at ASC, rowid ASC`,
    )
    .all()
  const titles = new Map<string, string>()
  for (const row of rows) {
    try {
      const msg = JSON.parse(row.fingerprint) as { sessionId?: unknown; title?: unknown }
      const id = typeof msg.sessionId === 'string' ? msg.sessionId : row.session_id
      if (id && typeof msg.title === 'string' && msg.title.trim()) titles.set(id, msg.title.slice(0, 200))
    } catch {
      /* a fingerprint that is not the message: nothing to recover from it */
    }
  }
  return titles
}

export type { EffortLevel }

export function patchSession(id: string, patch: Partial<Omit<SessionRow, 'id'>>): void {
  const keys = Object.keys(patch)
  if (!keys.length) return
  const sets = keys.map((k) => `${k} = ?`).join(', ')
  const values = keys.map((k) => (patch as Record<string, unknown>)[k] as never)
  db.query(`UPDATE sessions SET ${sets} WHERE id = ?`).run(...values, id)
}

/**
 * Erase a session and everything that belonged to it. The attachment ids come
 * back rather than being deleted from disk here: this module owns rows, not
 * files, and the caller is the one that can remove the bytes (see
 * `manager.removeSession`). Returning them is what keeps a deleted session from
 * leaving unreachable images behind.
 */
export function deleteSession(id: string): string[] {
  // One transaction: nine separate statements were nine commits, and a crash
  // between them left a session row whose events were already gone (or the
  // reverse), which the next boot restored as a half-deleted session.
  return db.transaction(() => deleteSessionRows(id))()
}

function deleteSessionRows(id: string): string[] {
  const attachments = db
    .query<{ id: string }, [string]>('SELECT id FROM attachments WHERE session_id = ?')
    .all(id)
    .map((row) => row.id)
  db.query('DELETE FROM events WHERE session_id = ?').run(id)
  // A queued prompt belongs to the session that was waiting to send it: leaving
  // it behind would hand it to whatever reuses the id next.
  db.query('DELETE FROM prompt_queue WHERE session_id = ?').run(id)
  db.query('DELETE FROM requests WHERE session_id = ?').run(id)
  db.query('DELETE FROM attachments WHERE session_id = ?').run(id)
  // Commands are intentionally retained: their durable ack prevents a replayed
  // delete/new-session/input command from producing its side effect again.
  // Conversation lifecycle rows, on the other hand, belong to this session.
  db.query('DELETE FROM actors WHERE session_id = ?').run(id)
  db.query('DELETE FROM turns WHERE session_id = ?').run(id)
  db.query('DELETE FROM prompts WHERE session_id = ?').run(id)
  db.query('DELETE FROM sessions WHERE id = ?').run(id)
  return attachments
}

export function loadSessions(limit = 300): SessionRow[] {
  return db
    // Stable order: `updated_at` moves every time a session is touched, so
    // ordering by it made the sidebar reshuffle whenever you opened something.
    // Archived sessions stay in the store but are not loaded: nothing lists,
    // restores a tab for or reattaches to them until they are unarchived.
    .query<SessionRow, [number]>(`SELECT * FROM sessions WHERE archived = 0 ORDER BY pinned DESC, created_at DESC LIMIT ?`)
    .all(limit)
}

/**
 * Archive or unarchive a session row. Deliberately not part of `upsertSession`:
 * the flag is only ever changed by this call, so a late write from a session
 * that was just archived cannot flip it back.
 */
export function setSessionArchived(id: string, archived: boolean): void {
  db.query('UPDATE sessions SET archived = ? WHERE id = ?').run(archived ? 1 : 0, id)
}

/** The archived agent sessions of one folder on one machine, newest first. */
export function archivedSessions(cwd: string, host: string | null): SessionRow[] {
  return db
    .query<SessionRow, [string, string | null]>(
      `SELECT * FROM sessions
       WHERE archived = 1 AND kind = 'agent' AND cwd = ? AND host IS ?
       ORDER BY updated_at DESC LIMIT 500`,
    )
    .all(cwd, host)
}

/** The sessions docked in another one (see `SessionRow.parent_session_id`). */
export function childSessions(parentId: string): SessionRow[] {
  return db.query<SessionRow, [string]>('SELECT * FROM sessions WHERE parent_session_id = ?').all(parentId)
}

/**
 * Every native conversation Sedano already holds, as `harness:nativeId`, with
 * whether the holder is archived. What an import scan dedupes against: the
 * whole table, not only the sessions loaded in memory.
 */
export function nativeSessionIds(): Map<string, { id: string; archived: boolean }> {
  const rows = db
    .query<{ id: string; harness: string; native_id: string; archived: number }, []>(
      `SELECT id, harness, native_id, archived FROM sessions WHERE native_id IS NOT NULL AND native_id != ''`,
    )
    .all()
  const held = new Map<string, { id: string; archived: boolean }>()
  for (const row of rows) {
    const key = `${row.harness}:${row.native_id}`
    // A live holder wins over an archived one: the conversation is on screen.
    if (held.get(key)?.archived === false) continue
    held.set(key, { id: row.id, archived: row.archived === 1 })
  }
  return held
}

export function getSessionRow(id: string): SessionRow | null {
  return db.query<SessionRow, [string]>('SELECT * FROM sessions WHERE id = ?').get(id) ?? null
}

/**
 * Insert an event. Returns true when it was new (so callers only broadcast
 * genuinely new events — the transcript tailer and the stream parser can both
 * observe the same turn).
 */
/**
 * Insert or refresh an event. Returns whether anything changed, so callers only
 * broadcast genuinely new state (the transcript and the stream parser can both
 * see the same turn).
 */
export function insertEvent(event: SessionEvent): { changed: boolean; seq: number } {
  const payload = JSON.stringify(event.ev)
  const existing = db
    .query<
      {
        payload: string
        seq: number
        turn_id: string | null
        parent_event_id: string | null
        parent_agent_id: string | null
      },
      [string, string]
    >(
      `SELECT payload, seq, turn_id, parent_event_id, parent_agent_id
       FROM events WHERE session_id = ? AND id = ?`,
    )
    .get(event.sessionId, event.id)
  if (existing) {
    if (existing.payload === payload) {
      // Same visible event content can still learn its structural identity: a
      // subagent meta file may announce a child before the parent's Task line
      // reveals the spawn edge. Persist and broadcast that enrichment even
      // though the TimelineEvent payload itself did not change.
      // Identity only: a turn is never learned by a repeat (see `manager.emit`).
      const learnsTurn = false
      const learnsParentEvent = !existing.parent_event_id && Boolean(event.parentEventId)
      const learnsParentAgent = !existing.parent_agent_id && Boolean(event.parentAgentId)
      if (learnsTurn || learnsParentEvent || learnsParentAgent) {
        db.query(
          `UPDATE events SET
             turn_id = COALESCE(turn_id, ?),
             parent_event_id = COALESCE(parent_event_id, ?),
             parent_agent_id = COALESCE(parent_agent_id, ?)
           WHERE session_id = ? AND id = ?`,
        ).run(
          event.turnId ?? null,
          event.parentEventId ?? null,
          event.parentAgentId ?? null,
          event.sessionId,
          event.id,
        )
        return { changed: learnsParentEvent || learnsParentAgent, seq: existing.seq }
      }
      return { changed: false, seq: existing.seq }
    }
    // Keep the original position in the timeline when enriching an event, and
    // keep the turn it was first filed under: an enrichment that arrives during
    // the next turn describes the old one, so `COALESCE` refuses to re-attribute
    // an event that already has a turn.
    db.query(
      // `kind` follows the payload, so a query by kind cannot see a stale one.
      // `at` never moves later: a rewrite (a delivery state, a card filled in, a
      // transcript re-read after a respawn) describes the event that already
      // happened, and stamping it "now" is how a turn from yesterday came to
      // read "Worked for 15h". An earlier time is a correction (the spawn call's
      // own timestamp) and is taken. Only an ending moves: a provisional
      // subagent end is replaced by the real one, later.
      `UPDATE events SET payload = ?, kind = ?,
         at = CASE WHEN ? = 'subagent_end' THEN ? ELSE MIN(at, ?) END, agent_id = ?,
         turn_id = COALESCE(turn_id, ?),
         parent_event_id = COALESCE(parent_event_id, ?),
         parent_agent_id = COALESCE(parent_agent_id, ?)
       WHERE session_id = ? AND id = ?`,
    ).run(
      payload,
      event.ev.k,
      event.ev.k,
      event.at,
      event.at,
      event.agentId ?? null,
      event.turnId ?? null,
      event.parentEventId ?? null,
      event.parentAgentId ?? null,
      event.sessionId,
      event.id,
    )
    return { changed: true, seq: existing.seq }
  }
  db.query(
    `INSERT INTO events (id, session_id, seq, at, agent_id, kind, payload, turn_id, parent_event_id, parent_agent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    event.id,
    event.sessionId,
    event.seq,
    event.at,
    event.agentId ?? null,
    event.ev.k,
    payload,
    event.turnId ?? null,
    event.parentEventId ?? null,
    event.parentAgentId ?? null,
  )
  return { changed: true, seq: event.seq }
}

export function loadEvents(sessionId: string, limit = 2000): SessionEvent[] {
  const rows = db
    .query<
      {
        id: string
        session_id: string
        seq: number
        at: number
        agent_id: string | null
        payload: string
        turn_id: string | null
        parent_event_id: string | null
        parent_agent_id: string | null
      },
      [string, number]
    >(`SELECT * FROM (
         SELECT * FROM events WHERE session_id = ? ORDER BY seq DESC LIMIT ?
       ) recent ORDER BY seq ASC`)
    .all(sessionId, limit)
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    seq: r.seq,
    at: r.at,
    agentId: r.agent_id ?? undefined,
    // Historical rows have no turn: left absent rather than invented, which is
    // what tells the UI to fall back to the sequential heuristic for them.
    turnId: r.turn_id ?? undefined,
    parentEventId: r.parent_event_id ?? undefined,
    parentAgentId: r.parent_agent_id ?? undefined,
    ev: JSON.parse(r.payload) as TimelineEvent,
  }))
}

/**
 * Read one event by its durable identity.
 *
 * Lifecycle updates (for example answering a request) must not depend on the
 * transcript window: a still-pending request can legitimately be older than
 * the last few thousand events in a long-running session.
 */
export function getEvent(sessionId: string, id: string): SessionEvent | null {
  const row = db
    .query<
      {
        id: string
        session_id: string
        seq: number
        at: number
        agent_id: string | null
        payload: string
        turn_id: string | null
        parent_event_id: string | null
        parent_agent_id: string | null
      },
      [string, string]
    >('SELECT * FROM events WHERE session_id = ? AND id = ?')
    .get(sessionId, id)
  if (!row) return null
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    at: row.at,
    agentId: row.agent_id ?? undefined,
    turnId: row.turn_id ?? undefined,
    parentEventId: row.parent_event_id ?? undefined,
    parentAgentId: row.parent_agent_id ?? undefined,
    ev: JSON.parse(row.payload) as TimelineEvent,
  }
}

/*
 * History repair, for damage an earlier build did (see `manager.reconcileHistory`).
 * Each one is idempotent: a second run finds nothing left to change.
 */

/**
 * Put a subagent card back at its spawn call. A re-read after a respawn
 * stamped these with the moment of the re-read; the spawning `tool:` row kept
 * its original time, and a start more than a minute after its own call is that
 * damage, not a real gap (the launch frame lands milliseconds after the call).
 */
export function repairSpawnTimes(sessionId: string): number {
  return db.query(
    `UPDATE events SET at = (
       SELECT t.at FROM events t
        WHERE t.session_id = events.session_id AND t.id = 'tool:' || json_extract(events.payload, '$.toolId')
     )
     WHERE session_id = ? AND kind = 'subagent_start' AND EXISTS (
       SELECT 1 FROM events t
        WHERE t.session_id = events.session_id AND t.id = 'tool:' || json_extract(events.payload, '$.toolId')
          AND t.at < events.at - 60000
     )`,
  ).run(sessionId).changes
}

/**
 * Put each run of a resumed agent back where it was started.
 *
 * A stopped agent resumed by `SendMessage` runs again under that call. Before
 * this was understood, the new run's card was merged into the agent's first
 * one: filed under the turn that spawned the agent and stamped with the spawn's
 * time — *before its own call*, which cannot happen — so the turn that resumed
 * it showed nothing working and never waited. Each such card, its end and the
 * run's own lines move to the call's turn and time, and that turn gets the
 * run's actor row, live or ended as its end says. Oldest resume first, so a
 * later run takes its own lines back. Idempotent: a repaired card is no longer
 * before its call.
 */
export function repairResumedRuns(sessionId: string, at = Date.now()): number {
  const cards = db
    .query<
      { id: string; tool: string; call_at: number; call_turn: string; payload: string },
      [string]
    >(
      `SELECT s.id, json_extract(s.payload, '$.toolId') AS tool, s.payload,
              t.at AS call_at, t.turn_id AS call_turn
         FROM events s
         JOIN events t ON t.session_id = s.session_id AND t.id = 'tool:' || json_extract(s.payload, '$.toolId')
        WHERE s.session_id = ? AND s.kind = 'subagent_start' AND t.turn_id IS NOT NULL AND t.at > s.at + 1000
        ORDER BY t.at ASC`,
    )
    .all(sessionId)
  if (!cards.length) return 0
  const harness = db.query<{ harness: string }, [string]>('SELECT harness FROM sessions WHERE id = ?').get(sessionId)?.harness ?? 'claude'
  db.transaction(() => {
    for (const card of cards) {
      const start = JSON.parse(card.payload) as Extract<TimelineEvent, { k: 'subagent_start' }>
      const agentId = start.agentId
      if (!agentId) continue
      db.query('UPDATE events SET at = ?, turn_id = ? WHERE session_id = ? AND id = ?').run(card.call_at, card.call_turn, sessionId, card.id)
      db.query('UPDATE events SET turn_id = ? WHERE session_id = ? AND id = ?').run(card.call_turn, sessionId, `subagent_end:${card.tool}`)
      db.query(
        `UPDATE events SET turn_id = ? WHERE session_id = ? AND agent_id = ? AND kind NOT IN ('subagent_start', 'subagent_end') AND at >= ?`,
      ).run(card.call_turn, sessionId, agentId, card.call_at)
      const end = getEvent(sessionId, `subagent_end:${card.tool}`)
      const ev = end?.ev.k === 'subagent_end' ? end.ev : null
      const status: ActorStatus = !ev || ev.provisional || ev.status === 'running'
        ? 'running'
        : ev.status === 'done' ? 'completed' : ev.status === 'stopped' ? 'cancelled' : 'failed'
      upsertActor({
        sessionId,
        id: agentId,
        turnId: card.call_turn,
        spawnEventId: card.id,
        ownership: 'provider',
        provider: harness,
        title: start.agentType,
        description: start.description,
        model: start.model ?? null,
        status,
        at: card.call_at || at,
      })
    }
  })()
  return cards.length
}

/**
 * Close live actor rows that are only a re-registration of an agent already
 * recorded under an earlier turn: the re-read filed every old agent under the
 * new turn as `starting`, and the new turn could never settle behind them.
 * A row spawned by a card of its own is not one of those: it is the agent
 * resumed by a later turn, a real new run.
 */
export function closeDuplicateActors(sessionId: string, at = Date.now()): number {
  return db.query(
    `UPDATE actors SET status = 'cancelled', updated_at = ?
      WHERE session_id = ? AND ownership = 'provider' AND status IN ('starting', 'running')
        AND EXISTS (
          SELECT 1 FROM actors older
           WHERE older.session_id = actors.session_id AND older.id = actors.id
             AND older.turn_id != actors.turn_id AND older.created_at < actors.created_at
             AND (actors.spawn_event_id IS NULL OR older.spawn_event_id IS NULL
                  OR older.spawn_event_id = actors.spawn_event_id)
        )`,
  ).run(at, sessionId).changes
}

/** What the events and actors of a session say about each of its turns. */
export interface TurnFacts {
  resultEventId: string | null
  replyEventId: string | null
  activeAgents: number
  cutOffAgents: number
}

/**
 * The facts behind each turn's phase, in four indexed queries per call rather
 * than per turn: the last main-loop result and reply, the child agents still
 * working, and the ones a stop cut off. `turnId` narrows it to one turn.
 */
export function turnFacts(sessionId: string, turnId?: string): Map<string, TurnFacts> {
  const facts = new Map<string, TurnFacts>()
  const of = (id: string): TurnFacts => {
    let found = facts.get(id)
    if (!found) facts.set(id, (found = { resultEventId: null, replyEventId: null, activeAgents: 0, cutOffAgents: 0 }))
    return found
  }
  const scope = turnId ? ' AND turn_id = ?' : ''
  const args = (turnId ? [sessionId, turnId] : [sessionId]) as [string] | [string, string]
  const marks = db
    .query<{ turn_id: string; id: string; kind: string }, typeof args>(
      `SELECT turn_id, id, kind FROM events
        WHERE session_id = ?${scope} AND turn_id IS NOT NULL AND agent_id IS NULL AND kind IN ('result', 'assistant')
        ORDER BY seq ASC`,
    )
    .all(...args)
  for (const mark of marks) {
    if (mark.kind === 'result') of(mark.turn_id).resultEventId = mark.id
    else of(mark.turn_id).replyEventId = mark.id
  }
  const cut = db
    .query<{ turn_id: string; n: number }, typeof args>(
      `SELECT turn_id, COUNT(*) AS n FROM events
        WHERE session_id = ?${scope} AND turn_id IS NOT NULL AND kind = 'subagent_end'
          AND json_extract(payload, '$.status') = 'stopped' AND json_extract(payload, '$.background') IS NULL
        GROUP BY turn_id`,
    )
    .all(...args)
  for (const row of cut) of(row.turn_id).cutOffAgents = row.n
  const active = db
    .query<{ turn_id: string; n: number }, typeof args>(
      `SELECT turn_id, COUNT(*) AS n FROM actors
        WHERE session_id = ?${scope} AND ownership = 'provider' AND status IN ('starting', 'running')
        GROUP BY turn_id`,
    )
    .all(...args)
  for (const row of active) of(row.turn_id).activeAgents = row.n
  return facts
}

/**
 * File events that carry no turn under the turn that was running when they
 * happened. Only from the first ledger turn on: an event from before turns
 * existed has no turn on purpose, and inventing one would rewrite old history.
 */
export function fileTurnlessEvents(sessionId: string): number {
  // A child agent's line belongs to the turn that started the run it is part
  // of: the latest card of that agent from before the line (a resumed agent
  // has one per run), or its first card.
  const children = db.query(
    `UPDATE events SET turn_id = (
       SELECT s.turn_id FROM events s
        WHERE s.session_id = events.session_id AND s.kind = 'subagent_start' AND s.turn_id IS NOT NULL
          AND json_extract(s.payload, '$.agentId') = events.agent_id
        ORDER BY CASE WHEN s.at <= events.at THEN 0 ELSE 1 END, CASE WHEN s.at <= events.at THEN -s.at ELSE s.at END
        LIMIT 1
     )
     WHERE session_id = ? AND turn_id IS NULL AND agent_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM events s
        WHERE s.session_id = events.session_id AND s.kind = 'subagent_start' AND s.turn_id IS NOT NULL
          AND json_extract(s.payload, '$.agentId') = events.agent_id
     )`,
  ).run(sessionId).changes
  return children + db.query(
    `UPDATE events SET turn_id = (
       SELECT t.id FROM turns t WHERE t.session_id = events.session_id AND t.started_at <= events.at
        ORDER BY t.started_at DESC LIMIT 1
     )
     WHERE session_id = ? AND turn_id IS NULL AND agent_id IS NULL
       AND at >= (SELECT MIN(started_at) FROM turns WHERE session_id = ?)`,
  ).run(sessionId, sessionId).changes
}

/**
 * Drop a transcript copy of a prompt that the prompt's own event already shows:
 * the driver that sent it had gone, so its echo was not claimed and the same
 * message rendered twice. Exact text, no turn, within a minute of the prompt.
 */
export function dropUnclaimedPromptEchoes(sessionId: string): number {
  return db.query(
    `DELETE FROM events
      WHERE session_id = ? AND kind = 'user' AND id NOT LIKE 'prompt:%'
        AND EXISTS (
          SELECT 1 FROM events p
           WHERE p.session_id = events.session_id AND p.kind = 'user' AND p.id LIKE 'prompt:%'
             AND json_extract(p.payload, '$.text') = json_extract(events.payload, '$.text')
             AND ABS(p.at - events.at) < 60000
        )`,
  ).run(sessionId).changes
}

/**
 * When an agent was last heard from: its latest own event with a real clock.
 *
 * The honest end of an agent that died with its process. Its completion rows
 * are left out (a stop written at recovery time is not activity), and so is a
 * zero or missing timestamp. Null when the agent never said anything itself.
 */
export function lastAgentActivity(sessionId: string, agentId: string): number | null {
  const row = db
    .query<{ at: number | null }, [string, string]>(
      `SELECT MAX(at) AS at FROM events
        WHERE session_id = ? AND agent_id = ? AND kind != 'subagent_end' AND at > 0`,
    )
    .get(sessionId, agentId)
  return row?.at ?? null
}

/**
 * Subagent cards whose agent never reported an end — no `subagent_end`, or only
 * a provisional "running" one — while no ledger row says the agent is still
 * working. Those agents are gone; the card is what still says otherwise.
 */
export function unfinishedAgentCards(sessionId: string): Array<{ start: SessionEvent; createdAt: number | null }> {
  const starts = loadEventsOfKind(sessionId, 'subagent_start')
  const out: Array<{ start: SessionEvent; createdAt: number | null }> = []
  for (const start of starts) {
    if (start.ev.k !== 'subagent_start') continue
    const end = getEvent(sessionId, `subagent_end:${start.ev.toolId}`)
    if (end?.ev.k === 'subagent_end' && end.ev.status !== 'running' && !end.ev.provisional) continue
    const rows = db
      .query<{ status: string; created_at: number }, [string, string]>(
        'SELECT status, created_at FROM actors WHERE session_id = ? AND id = ? ORDER BY created_at ASC',
      )
      .all(sessionId, start.ev.agentId)
    if (rows.some((row) => row.status === 'starting' || row.status === 'running')) continue
    out.push({ start, createdAt: rows[0]?.created_at ?? null })
  }
  return out
}

/** The turn a child agent's latest card (its current run) was filed under. */
export function spawnTurnOfAgent(sessionId: string, agentId: string): string | null {
  const row = db
    .query<{ turn_id: string | null }, [string, string]>(
      `SELECT turn_id FROM events WHERE session_id = ? AND kind = 'subagent_start'
         AND json_extract(payload, '$.agentId') = ? ORDER BY at DESC, seq DESC LIMIT 1`,
    )
    .get(sessionId, agentId)
  return row?.turn_id ?? null
}

/**
 * Whether a prompt event with this exact text was accepted within a minute of
 * `at` — i.e. whether a transcript `user` record is only the echo of a prompt
 * sedano itself delivered (see `manager.emit`).
 */
export function isPromptEcho(sessionId: string, text: string, at: number): boolean {
  return Boolean(
    db
      .query<{ one: number }, [string, string, number]>(
        `SELECT 1 AS one FROM events
          WHERE session_id = ? AND kind = 'user' AND id LIKE 'prompt:%'
            AND json_extract(payload, '$.text') = ? AND ABS(at - ?) < 60000
          LIMIT 1`,
      )
      .get(sessionId, text, at),
  )
}

/** Re-file one event under another turn (history repair only). */
export function setEventTurn(sessionId: string, id: string, turnId: string): void {
  db.query('UPDATE events SET turn_id = ? WHERE session_id = ? AND id = ?').run(turnId, sessionId, id)
}

/** Every event of one kind in a session, oldest first, without parsing the rest. */
export function loadEventsOfKind(sessionId: string, kind: TimelineEvent['k']): SessionEvent[] {
  const rows = db
    .query<
      {
        id: string
        session_id: string
        seq: number
        at: number
        agent_id: string | null
        payload: string
        turn_id: string | null
        parent_event_id: string | null
        parent_agent_id: string | null
      },
      [string, string]
    >('SELECT * FROM events WHERE session_id = ? AND kind = ? ORDER BY seq ASC')
    .all(sessionId, kind)
  return rows.map((row) => ({
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    at: row.at,
    agentId: row.agent_id ?? undefined,
    turnId: row.turn_id ?? undefined,
    parentEventId: row.parent_event_id ?? undefined,
    parentAgentId: row.parent_agent_id ?? undefined,
    ev: JSON.parse(row.payload) as TimelineEvent,
  }))
}

export function maxSeq(sessionId: string): number {
  const row = db
    .query<{ s: number | null }, [string]>('SELECT MAX(seq) AS s FROM events WHERE session_id = ?')
    .get(sessionId)
  return row?.s ?? 0
}

export function saveLimits(snapshot: LimitSnapshot): void {
  db.query(
    `INSERT INTO limits (harness, snapshot, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(harness) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at`,
  ).run(snapshot.harness, JSON.stringify(snapshot), snapshot.updatedAt)
}

export function loadLimits(): LimitSnapshot[] {
  const rows = db.query<{ snapshot: string }, []>('SELECT snapshot FROM limits').all()
  return rows.map((r) => JSON.parse(r.snapshot) as LimitSnapshot)
}

export function kvGet(key: string): string | null {
  const row = db.query<{ v: string }, [string]>('SELECT v FROM kv WHERE k = ?').get(key)
  return row?.v ?? null
}

export function kvSet(key: string, value: string): void {
  db.query(
    `INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
  ).run(key, value)
}

export function kvDelete(key: string): void {
  db.query('DELETE FROM kv WHERE k = ?').run(key)
}

/**
 * Close the store for a server that is exiting. Closing is what folds the WAL
 * back into the main file, so the next open does not start by replaying it.
 */
export function closeDb(): void {
  db.close()
}

// Last statement of the module: every migration above has run by now.
migrationBackup.finish()
