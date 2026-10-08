#!/usr/bin/env bun
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Ack, SessionEvent } from '@shared'

const home = mkdtempSync(join(tmpdir(), 'sedano-db-test-'))
process.env.SEDANO_HOME = home

const legacy = new Database(join(home, 'sedano.db'), { create: true })
legacy.exec(`
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    at INTEGER NOT NULL,
    agent_id TEXT,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX events_by_session ON events(session_id, seq);
  -- A sessions table from before archiving existed (no \`archived\` column).
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, harness TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'agent',
    title TEXT NOT NULL DEFAULT '', cwd TEXT NOT NULL DEFAULT '', host TEXT, model TEXT,
    status TEXT NOT NULL DEFAULT 'idle', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    native_id TEXT, transcript_path TEXT, resume_hint TEXT, pinned INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO sessions (id, harness, cwd, created_at, updated_at, native_id)
    VALUES ('legacy-session', 'claude', '/work', 1, 1, 'native-legacy');
`)
legacy.query(
  'INSERT INTO events (id, session_id, seq, at, agent_id, kind, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
).run('legacy', 'session-a', 1, 1, null, 'user', JSON.stringify({ k: 'user', text: 'legacy' }))
legacy.close()

const db = await import('../apps/server/src/db.ts')
const failures: string[] = []
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const event = (sessionId: string, id: string, seq: number): SessionEvent => ({
  id,
  sessionId,
  seq,
  at: seq,
  ev: { k: 'assistant', text: `${sessionId}:${seq}` },
})

db.insertEvent(event('session-a', 'shared-native-id', 2))
db.insertEvent(event('session-b', 'shared-native-id', 1))
check('event ids are scoped to their session', db.loadEvents('session-b').length === 1, db.loadEvents('session-b'))
check('legacy events survive the migration', db.loadEvents('session-a').some((item) => item.id === 'legacy'))

for (let seq = 3; seq <= 3005; seq += 1) db.insertEvent(event('session-a', `event-${seq}`, seq))
const recent = db.loadEvents('session-a', 3000)
check('the replay returns the requested limit', recent.length === 3000, recent.length)
check('the replay starts at the recent boundary', recent[0]?.seq === 6, recent[0]?.seq)
check('the replay includes the newest event', recent.at(-1)?.seq === 3005, recent.at(-1)?.seq)
check('the replay remains ascending', recent.every((item, index) => index === 0 || recent[index - 1]!.seq < item.seq))

/* Execution Ledger v2: command claims are atomic and terminal results stick. */
const freshClaim = db.claimCommand('cmd-1', 'input', 'fingerprint-a', 'session-a', 10)
check('a command id is claimed once', freshClaim.state === 'new', freshClaim)
check(
  'the same command retry observes pending',
  db.claimCommand('cmd-1', 'input', 'fingerprint-a', 'session-a', 11).state === 'pending',
)
check(
  'reusing a command id for another request is a conflict',
  db.claimCommand('cmd-1', 'input', 'fingerprint-b', 'session-a', 12).state === 'conflict',
)
const ack: Ack = { t: 'ack', cid: 'cmd-1', ok: true, sessionId: 'session-a' }
check('the first command completion wins', db.completeCommand('cmd-1', ack, 13))
check('a terminal command cannot be completed twice', !db.completeCommand('cmd-1', ack, 14))
const completedClaim = db.claimCommand('cmd-1', 'input', 'fingerprint-a', 'session-a', 15)
check(
  'a completed retry returns its exact durable ack',
  completedClaim.state === 'completed' && JSON.stringify(completedClaim.ack) === JSON.stringify(ack),
  completedClaim,
)

/* Prompt identity, FIFO ordering and monotone lifecycle. */
const firstPrompt = db.acceptPrompt({
  id: 'prompt-1',
  sessionId: 'session-a',
  commandId: 'cmd-1',
  at: 20,
})
const secondPrompt = db.acceptPrompt({ id: 'prompt-2', sessionId: 'session-a', at: 21 })
check('accepted prompts get stable FIFO ordinals', firstPrompt.ordinal === 1 && secondPrompt.ordinal === 2, [firstPrompt, secondPrompt])
db.acceptPrompt({ id: 'prompt-1', sessionId: 'session-a', userEventId: 'user-1', at: 22 })
check('a retry enriches but does not duplicate a prompt', db.listPrompts('session-a').length === 2)
check('prompt correlations can be learned later', db.getPrompt('prompt-1')?.userEventId === 'user-1')
db.advancePrompt('prompt-1', 'queued', { at: 23 })
db.advancePrompt('prompt-1', 'accepted', { at: 24 })
check('a stale prompt update cannot move lifecycle backward', db.getPrompt('prompt-1')?.state === 'queued')
db.advancePrompt('prompt-1', 'cancelled', { reason: 'stopped', at: 25 })
db.advancePrompt('prompt-1', 'delivered', { at: 26 })
check('a terminal prompt cannot change terminal outcome', db.getPrompt('prompt-1')?.state === 'cancelled')
check('only non-terminal prompts are recoverable', db.recoverablePrompts('session-a').map((p) => p.id).join() === 'prompt-2')

const queuedPayload = db.enqueuePrompt('session-a', 'later', undefined, 'prompt-2', 27)
check('the payload queue keeps the durable prompt identity', queuedPayload.promptId === 'prompt-2', queuedPayload)
check('the prompt identity survives a queue reload', db.loadPromptQueue('session-a')[0]?.promptId === 'prompt-2', db.loadPromptQueue('session-a'))
db.removeQueuedPrompt('session-a', queuedPayload.id)

/* Turn ownership and the actor barrier are durable invariants. */
const turn = db.startTurn({
  id: 'turn-1',
  sessionId: 'session-a',
  promptId: 'prompt-2',
  runToken: 'run-owner',
  startedAt: 30,
})
check('a turn persists its run owner', turn.runToken === 'run-owner', turn)
check('another run token cannot advance the turn', !db.advanceTurn('turn-1', 'stale-run', 'running', null, 31))
check('the owner can mark the turn running', db.advanceTurn('turn-1', 'run-owner', 'running', null, 32))
db.upsertActor({
  sessionId: 'session-a',
  id: 'actor-child',
  turnId: 'turn-1',
  parentActorId: null,
  spawnEventId: 'spawn-1',
  ownership: 'provider',
  provider: 'test',
  title: 'child',
  description: 'does work',
  model: null,
  status: 'running',
  at: 33,
})
check('an active actor blocks terminalizing its turn', !db.advanceTurn('turn-1', 'run-owner', 'completed', 'ok', 34))
db.upsertActor({
  sessionId: 'session-a',
  id: 'actor-child',
  turnId: 'turn-1',
  parentActorId: 'actor-main',
  spawnEventId: 'spawn-1',
  ownership: 'provider',
  provider: 'test',
  title: 'child enriched',
  description: 'done',
  model: 'model-1',
  status: 'completed',
  at: 35,
})
db.upsertActor({
  sessionId: 'session-a',
  id: 'actor-child',
  turnId: 'turn-1',
  parentActorId: null,
  spawnEventId: null,
  ownership: 'provider',
  provider: 'test',
  title: '',
  description: '',
  model: null,
  status: 'running',
  at: 36,
})
const actor = db.getActor('session-a', 'actor-child')
check('actor upserts preserve learned identity', actor?.parentActorId === 'actor-main' && actor.model === 'model-1', actor)
check('a late actor update cannot reopen a terminal actor', actor?.status === 'completed', actor)
check('a turn settles after every actor is terminal', db.advanceTurn('turn-1', 'run-owner', 'completed', 'ok', 37))
check(
  'turn outcome and native subtype are stored separately',
  db.getTurn('turn-1')?.outcome === 'completed' && db.getTurn('turn-1')?.subtype === 'ok',
  db.getTurn('turn-1'),
)

/* A resumed agent: a new run in the same turn reopens its actor; history damaged
   by the old merge (run card before its own call, under the spawning turn) is repaired. */
{
  const s = 'session-resume'
  db.startTurn({ id: 'r-t1', sessionId: s, runToken: 'r1', startedAt: 100 })
  db.startTurn({ id: 'r-t2', sessionId: s, runToken: 'r2', startedAt: 500 })
  const base = { sessionId: s, id: 'w', ownership: 'provider' as const, provider: 'claude' }
  db.upsertActor({ ...base, turnId: 'r-t1', spawnEventId: 'subagent_start:spawn', status: 'completed', at: 110 })
  db.upsertActor({ ...base, turnId: 'r-t1', spawnEventId: 'subagent_start:again', status: 'starting', at: 300 })
  check('a new run of an ended agent in the same turn is live again', db.getActor(s, 'w', 'r-t1')?.status === 'starting', db.getActor(s, 'w', 'r-t1'))
  db.upsertActor({ ...base, turnId: 'r-t1', status: 'completed', at: 310 })

  const put = (id: string, seq: number, at: number, turnId: string, ev: SessionEvent['ev'], agentId?: string) =>
    db.insertEvent({ id, sessionId: s, seq, at, turnId, agentId, ev })
  put('tool:resume', 1, 600_000, 'r-t2', { k: 'tool', toolId: 'resume', name: 'SendMessage', input: {}, summary: '' })
  put('subagent_start:resume', 2, 105, 'r-t1', { k: 'subagent_start', toolId: 'resume', agentId: 'w', agentType: 'general-purpose', description: 'Worker', prompt: 'more', depth: 1 })
  put('w-line', 3, 650_000, 'r-t1', { k: 'assistant', text: 'second run' }, 'w')
  put('subagent_end:resume', 4, 700_000, 'r-t1', { k: 'subagent_end', toolId: 'resume', agentId: 'w', status: 'running', durationMs: 1, toolUses: 1, result: '', provisional: true }, 'w')
  check('a damaged resume is repaired', db.repairResumedRuns(s) === 1)
  const card = db.getEvent(s, 'subagent_start:resume')
  check('the run card moves to its call', card?.turnId === 'r-t2' && card.at === 600_000, card)
  check('its end and lines follow', db.getEvent(s, 'subagent_end:resume')?.turnId === 'r-t2' && db.getEvent(s, 'w-line')?.turnId === 'r-t2')
  check('the resuming turn waits on the run', db.hasActiveActors(s, 'r-t2'))
  check('a resumed run is not closed as a duplicate', db.closeDuplicateActors(s) === 0)
  check('the repair is idempotent', db.repairResumedRuns(s) === 0)
}

/* Archive: a flag on the row, set only by its own call. */
{
  check('a legacy session row is migrated unarchived', db.getSessionRow('legacy-session')?.archived === 0, db.getSessionRow('legacy-session'))
  check('an unarchived session is loaded', db.loadSessions().some((row) => row.id === 'legacy-session'))
  db.setSessionArchived('legacy-session', true)
  check('an archived session is not loaded', !db.loadSessions().some((row) => row.id === 'legacy-session'))
  check('an archived session is listed for its folder', db.archivedSessions('/work', null).map((row) => row.id).join() === 'legacy-session')
  check('an archived session is not listed for another machine', db.archivedSessions('/work', 'server').length === 0)
  db.upsertSession({
    id: 'legacy-session', harness: 'claude', kind: 'agent', title: 'late write', cwd: '/work', host: null, model: null,
    status: 'stopped', createdAt: 1, updatedAt: 2, nativeId: 'native-legacy', transcriptPath: null, resumeHint: null,
    permissionMode: 'acceptEdits', effort: null, gitBranch: null, pinned: 0,
  })
  check('a late upsert does not unarchive', db.getSessionRow('legacy-session')?.archived === 1)
  check('the native id is known as held by an archived session', db.nativeSessionIds().get('claude:native-legacy')?.archived === true)
  db.setSessionArchived('legacy-session', false)
  check('unarchiving loads it again', db.loadSessions().some((row) => row.id === 'legacy-session'))
}

const schema = new Database(join(home, 'sedano.db'))
const tables = schema.query<{ name: string }, []>(
  `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('commands', 'prompts', 'turns', 'actors') ORDER BY name`,
).all().map((row) => row.name)
check('the complete ledger schema is migrated idempotently', tables.join() === 'actors,commands,prompts,turns', tables)
schema.close()

rmSync(home, { recursive: true, force: true })
if (failures.length) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  process.exit(1)
}
console.log('db-test: PASSED')
