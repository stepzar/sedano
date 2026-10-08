#!/usr/bin/env bun
/**
 * Turn boundaries: the events say which turn they belong to, and the timeline is
 * built from that rather than from arrival order.
 *
 * The bug this exists for is invisible in a screenshot: a transcript line or a
 * sidechain event that reaches the client after the next prompt was rendered
 * under that prompt, so the record said the agent had done work nobody asked it
 * for. Everything here is in memory — no database, no server, no browser.
 *
 *   bun scripts/turn-test.ts
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionEvent, TimelineEvent, TurnRecord } from '@shared'
import { buildRows, buildTurns, turnSpanMs, turnStartedAt } from '../apps/ui/src/view.ts'

const failures: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) return
  failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

let seq = 0
function event(ev: TimelineEvent, turnId?: string, extra: Partial<SessionEvent> = {}): SessionEvent {
  seq += 1
  return { id: `e${seq}`, sessionId: 's1', seq, at: 1_000 + seq, turnId, ev, ...extra }
}

const user = (text: string): TimelineEvent => ({ k: 'user', text })
const assistant = (text: string): TimelineEvent => ({ k: 'assistant', text })
const result = (): TimelineEvent => ({ k: 'result', subtype: 'success', text: '', durationMs: 10, costUsd: 0 })

/* ------------------------------------------------------------------ */
/* A late event of turn A, delivered after turn B has begun            */
/* ------------------------------------------------------------------ */

const A = 'turn-a'
const B = 'turn-b'

const interleaved: SessionEvent[] = [
  event(user('first prompt'), A),
  event(assistant('working on it'), A),
  event(result(), A),
  event(user('second prompt'), B),
  event(assistant('on the second'), B),
  // The transcript tailer catches up here: this belongs to the first turn and
  // arrives after the second one is already on screen.
  event(assistant('a line from the first turn'), A),
  event(result(), B),
]

{
  const turns = buildTurns(buildRows(interleaved), { live: false })
  check('two prompts make two turns', turns.length === 2, turns.length)
  const first = turns[0]!
  const second = turns[1]!
  check('turns keep their recorded id', first.turnId === A && second.turnId === B, [first.turnId, second.turnId])
  const lateInFirst = first.rows.some(
    (row) => 'ev' in row && row.ev.k === 'assistant' && row.ev.text === 'a line from the first turn',
  )
  const lateInSecond = second.rows.some(
    (row) => 'ev' in row && row.ev.k === 'assistant' && row.ev.text === 'a line from the first turn',
  )
  check('a late event of turn A stays in turn A', lateInFirst, first.rows.length)
  check('a late event of turn A never reaches turn B', !lateInSecond, second.rows.length)
}

/* ------------------------------------------------------------------ */
/* Legacy events, with no turn recorded at all                         */
/* ------------------------------------------------------------------ */

{
  seq = 0
  const legacy: SessionEvent[] = [
    event(user('first prompt')),
    event(assistant('answer one')),
    event(result()),
    event(user('second prompt')),
    event(assistant('answer two')),
    event(result()),
  ]
  const turns = buildTurns(buildRows(legacy), { live: false })
  check('legacy events still group by prompt', turns.length === 2, turns.length)
  check('legacy turns have no recorded id', turns.every((turn) => turn.turnId === undefined))
  check(
    'legacy work stays under its own prompt',
    turns[0]!.rows.some((row) => 'ev' in row && row.ev.k === 'assistant' && row.ev.text === 'answer one') &&
      turns[1]!.rows.some((row) => 'ev' in row && row.ev.k === 'assistant' && row.ev.text === 'answer two'),
  )
}

/* ------------------------------------------------------------------ */
/* A transcript that mixes both: old events, then turns with ids       */
/* ------------------------------------------------------------------ */

{
  seq = 0
  const mixed: SessionEvent[] = [
    event(user('old prompt')),
    event(assistant('old answer')),
    event(result()),
    event(user('new prompt'), A),
    event(assistant('new answer'), A),
    event(result(), A),
  ]
  const turns = buildTurns(buildRows(mixed), { live: false })
  check('a session upgraded mid-life keeps two turns', turns.length === 2, turns.length)
  check('the old turn stays heuristic', turns[0]!.turnId === undefined, turns[0]!.turnId)
  check('the new turn is keyed', turns[1]!.turnId === A, turns[1]!.turnId)
  check(
    'the old work does not leak into the new turn',
    turns[1]!.rows.every((row) => !('ev' in row) || row.ev.k !== 'assistant' || row.ev.text === 'new answer'),
  )
}

/* ------------------------------------------------------------------ */
/* Replay and live stream tell the same story                          */
/* ------------------------------------------------------------------ */

{
  // The replay is what the database hands back: ordered by seq. The live stream
  // is the order the client saw, with the late event at the end. Same turns.
  const replay = [...interleaved].sort((a, b) => a.seq - b.seq)
  const liveOrder = [
    ...interleaved.filter((item) => item.turnId !== A || item.seq <= 3),
    ...interleaved.filter((item) => item.turnId === A && item.seq > 3),
  ]
  const shape = (events: SessionEvent[]) =>
    buildTurns(buildRows(events), { live: false }).map((turn) => ({
      id: turn.turnId,
      user: turn.user?.text ?? null,
      rows: turn.rows.map((row) => ('ev' in row ? `${row.ev.k}:${row.id}` : `group:${row.toolId}`)).sort(),
    }))
  check('replay and live stream produce the same turns', JSON.stringify(shape(replay)) === JSON.stringify(shape(liveOrder)), {
    replay: shape(replay),
    live: shape(liveOrder),
  })
  const order = shape(replay)
  check('the turns come out in the order they were started', order[0]?.id === A && order[1]?.id === B, order.map((t) => t.id))
}

/* ------------------------------------------------------------------ */
/* Persistence: the turn survives a round trip through the database    */
/* ------------------------------------------------------------------ */

{
  const home = mkdtempSync(join(tmpdir(), 'sedano-turn-test-'))
  process.env.SEDANO_HOME = home
  const db = await import('../apps/server/src/db.ts')

  for (const item of interleaved) db.insertEvent(item)
  const loaded = db.loadEvents('s1')
  check('every event comes back', loaded.length === interleaved.length, loaded.length)
  check(
    'the stored turn is the one that was written',
    loaded.every((item, index) => item.turnId === interleaved[index]!.turnId),
    loaded.map((item) => item.turnId),
  )

  // An event with no turn stays without one: historical rows must keep loading.
  db.insertEvent({ id: 'legacy-1', sessionId: 's2', seq: 1, at: 1, ev: user('before turns existed') })
  const old = db.loadEvents('s2')
  check('an event with no turn loads with none', old.length === 1 && old[0]!.turnId === undefined, old)

  // An enrichment of an event already filed under turn A must not re-file it
  // under the turn that happens to be running when it lands.
  const enriched = { ...interleaved[1]!, turnId: B, ev: assistant('working on it, enriched') }
  db.insertEvent(enriched)
  const after = db.loadEvents('s1').find((item) => item.id === enriched.id)
  check('an enrichment cannot move an event to another turn', after?.turnId === A, after?.turnId)

  rmSync(home, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ */
/* A queued turn's clock starts when it ran, not when it was typed     */
/* ------------------------------------------------------------------ */

{
  // The prompt was typed at 1 000 behind a running turn; the queue released it
  // at 61 000. The clock must not open on a minute of waiting.
  const typedAt = 1_000
  const ranAt = 61_000
  const queuedTurn = buildTurns(buildRows([
    { id: 'q-user', sessionId: 's3', seq: 1, at: typedAt, turnId: 'q', ev: { k: 'user', text: 'queued', delivery: 'delivered' } },
    { id: 'q-reply', sessionId: 's3', seq: 2, at: ranAt + 4_000, turnId: 'q', ev: assistant('done') },
  ]))[0]!
  const record = { id: 'q', sessionId: 's3', runToken: 'r', status: 'running', startedAt: ranAt } as TurnRecord
  check('a queued turn starts when the ledger started it', turnStartedAt(queuedTurn, record) === ranAt, turnStartedAt(queuedTurn, record))
  check('a turn without a record starts at its prompt', turnStartedAt(queuedTurn, null) === typedAt, turnStartedAt(queuedTurn, null))
  check('its span excludes the wait', turnSpanMs(queuedTurn, record) === 4_000, turnSpanMs(queuedTurn, record))
  const early = { ...record, startedAt: typedAt - 500 }
  check('a ledger start before the prompt never moves the clock back', turnStartedAt(queuedTurn, early) === typedAt, turnStartedAt(queuedTurn, early))
}

if (failures.length) {
  console.log('--- failed checks ---')
  for (const failure of failures) console.log(`✗ ${failure}`)
  console.log(`\nturn-test: ${failures.length} FAILURES`)
  process.exit(1)
}
console.log('turn-test: PASSED')
process.exit(0)
