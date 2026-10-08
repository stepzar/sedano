#!/usr/bin/env bun
/**
 * Runs the UI's render-tree builder against versioned fixtures, so subagent
 * nesting and the "premature completion" handling are checked without a browser
 * and without the machine's own store.
 *
 * It used to read `~/.sedano/sedano.db`: on a clean checkout there was nothing
 * to assert, and on a used machine the assertions changed with the history. The
 * fixtures in `scripts/fixtures/transcripts.ts` carry their own expected output,
 * so this is now a test rather than a report.
 *
 *   bun scripts/view-test.ts
 */
import type { SessionEvent } from '@shared'
import { buildRows, buildTurns, isGroup, reuseTurns } from '../apps/ui/src/view.ts'
import { TRANSCRIPT_FIXTURES } from './fixtures/transcripts.ts'

const failures: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) return
  failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

for (const fixture of TRANSCRIPT_FIXTURES) {
  const where = `${fixture.id}:`
  const tree = buildRows(fixture.events)
  const groups = tree.filter(isGroup)

  console.log(`\n=== ${fixture.id} (${fixture.events.length} events) — ${fixture.note} ===`)

  check(`${where} subagent card count`, groups.length === fixture.expect.groups, {
    got: groups.length,
    want: fixture.expect.groups,
  })

  const provisional = groups.filter((group) => Boolean(group.end?.provisional))
  check(`${where} provisional completion count`, provisional.length === fixture.expect.provisionalGroups, {
    got: provisional.map((group) => group.toolId),
    want: fixture.expect.provisionalGroups,
  })

  // Every sidechain event must end up inside its card: one left at top level is
  // a subagent's work rendered as if the main loop had done it.
  const strayAgentEvents = tree.filter((row): row is SessionEvent => !isGroup(row) && Boolean(row.agentId))
  check(`${where} no sidechain event left at top level`, strayAgentEvents.length === 0, strayAgentEvents.map((row) => row.id))

  for (const group of groups) {
    const end = group.end
    const running = !end || Boolean(end.provisional)
    console.log(
      `  subagent ${group.agentId.slice(0, 12).padEnd(13)} tool=${group.toolId.slice(0, 14).padEnd(15)} ` +
        `events=${String(group.events.length).padStart(2)} endSeq=${group.endSeq} ` +
        `status=${end ? end.status : '-'} provisional=${Boolean(end?.provisional)} running=${running}`,
    )
    // An empty completion row that precedes its own sidechain work must be
    // treated as provisional, otherwise a working subagent looks finished.
    const hadLaterWork = group.events.some((e) => e.seq > group.endSeq)
    const emptyRow = Boolean(end) && end!.toolUses === 0 && end!.durationMs === 0 && !end!.usage && !end!.result
    check(`${where} empty completion row before its own work is provisional`, !(emptyRow && hadLaterWork && !running), group.toolId)
  }

  // A session read from disk is not running. If any turn still looks live, every
  // crash and every interrupted turn leaves a spinner on screen forever — which
  // is exactly what a stale "thinking…" was.
  const stopped = buildTurns(tree, { live: false })
  check(`${where} turn count`, stopped.length === fixture.expect.turns, {
    got: stopped.length,
    want: fixture.expect.turns,
  })
  const stillLive = stopped.filter((turn) => turn.running)
  check(`${where} no turn looks live on a stopped session`, stillLive.length === 0, stillLive.length)

  const live = buildTurns(tree, { live: true })
  check(`${where} liveness does not change the turn structure`, live.length === stopped.length, {
    live: live.length,
    stopped: stopped.length,
  })

  const runningLive = live
    .flatMap((turn) => turn.rows)
    .filter((row) => isGroup(row) && (!row.end || Boolean(row.end.provisional)))
  check(`${where} cards still waiting on their agent while live`, runningLive.length === fixture.expect.runningGroupsWhenLive, {
    got: runningLive.length,
    want: fixture.expect.runningGroupsWhenLive,
  })
}

// Harnesses do not agree on casing or naming. A described Command Code `agent`
// and a Codex `spawnAgent` are real cards; an empty `task {}` is only a generic
// tool call and must not create the blank duplicate card users saw.
const spawnEvents: SessionEvent[] = [
  {
    id: 'cmd-agent', sessionId: 'spawn-shapes', seq: 1, at: 1,
    ev: { k: 'tool', toolId: 'cmd-agent', name: 'agent', input: { description: 'Ping example.com', prompt: 'Run ping.' }, summary: 'agent' },
  },
  {
    id: 'codex-agent', sessionId: 'spawn-shapes', seq: 2, at: 2,
    ev: { k: 'tool', toolId: 'codex-agent', name: 'spawnAgent', input: { prompt: '[BRIEF]\nPing cloudflare.com and report.' }, summary: 'spawnAgent' },
  },
  {
    id: 'empty-task', sessionId: 'spawn-shapes', seq: 3, at: 3,
    ev: { k: 'tool', toolId: 'empty-task', name: 'task', input: {}, summary: 'task' },
  },
]
const spawnRows = buildRows(spawnEvents)
const spawnGroups = spawnRows.filter(isGroup)
check('described lowercase and Codex spawn calls become subagent cards', spawnGroups.length === 2, spawnGroups)
check('Codex brief becomes a readable description', spawnGroups[1]?.start.description === 'Ping cloudflare.com and report.')
check('an empty generic task stays a tool row', spawnRows.some((row) => !isGroup(row) && row.id === 'empty-task'))

const nestedActors: SessionEvent[] = [
  {
    id: 'spawn-parent', sessionId: 'nested', seq: 1, at: 1, turnId: 'turn-nested',
    ev: { k: 'tool', toolId: 'spawn-parent', name: 'Task', input: { description: 'Parent', prompt: 'Delegate once.' }, summary: 'Parent' },
  },
  {
    id: 'parent-start', sessionId: 'nested', seq: 2, at: 2, turnId: 'turn-nested', agentId: 'parent', parentEventId: 'spawn-parent',
    ev: { k: 'subagent_start', toolId: 'spawn-parent', agentId: 'parent', agentType: 'general-purpose', description: 'Parent', prompt: 'Delegate once.', depth: 1 },
  },
  {
    id: 'spawn-child', sessionId: 'nested', seq: 3, at: 3, turnId: 'turn-nested', agentId: 'parent',
    ev: { k: 'tool', toolId: 'spawn-child', name: 'Task', input: { description: 'Child', prompt: 'Inspect the file.' }, summary: 'Child' },
  },
  {
    id: 'child-start', sessionId: 'nested', seq: 4, at: 4, turnId: 'turn-nested', agentId: 'child', parentAgentId: 'parent', parentEventId: 'spawn-child',
    ev: { k: 'subagent_start', toolId: 'spawn-child', agentId: 'child', agentType: 'explorer', description: 'Child', prompt: 'Inspect the file.', depth: 2 },
  },
  {
    id: 'child-answer', sessionId: 'nested', seq: 5, at: 5, turnId: 'turn-nested', agentId: 'child', parentAgentId: 'parent',
    ev: { k: 'assistant', text: 'Found it.' },
  },
]
const nestedRows = buildRows(nestedActors)
const nestedRoot = nestedRows.filter(isGroup)
check('a provider child is not flattened beside its parent', nestedRoot.length === 1, nestedRoot)
check('the parent owns exactly one nested child card', nestedRoot[0]?.children.length === 1, nestedRoot[0])
check('the nested child keeps its own events', nestedRoot[0]?.children[0]?.events.some((event) => event.id === 'child-answer') === true)
const nestedTurn = buildTurns(nestedRows, { live: true })[0]
check('turn statistics count both parent and nested child', nestedTurn?.stats.agents === 2, nestedTurn?.stats)

const emptyDiscovery: SessionEvent[] = [
  {
    id: 'empty-start', sessionId: 'empty-discovery', seq: 1, at: 1,
    ev: {
      k: 'subagent_start', toolId: 'empty-agent-tool', agentId: 'empty-agent',
      agentType: 'agent', description: '', prompt: '', depth: 1,
    },
  },
  {
    id: 'empty-end', sessionId: 'empty-discovery', seq: 2, at: 2,
    ev: {
      k: 'subagent_end', toolId: 'empty-agent-tool', agentId: 'empty-agent', status: 'done',
      durationMs: 0, toolUses: 0, result: '',
    },
  },
]
check(
  'an identity-less discovery frame does not create a blank duplicate card',
  buildRows(emptyDiscovery).filter(isGroup).length === 0,
)
const failedDiscovery: SessionEvent[] = [
  {
    id: 'failed-end', sessionId: 'failed-discovery', seq: 1, at: 1,
    ev: {
      k: 'subagent_end', toolId: 'failed-agent-tool', agentId: 'failed-agent', status: 'error',
      durationMs: 0, toolUses: 0, result: '',
    },
  },
]
const failedDiscoveryGroup = buildRows(failedDiscovery).filter(isGroup)[0]
check('a metadata-less failed task is retained as failure evidence', Boolean(failedDiscoveryGroup))
check(
  'a metadata-less failed task gets a truthful description',
  failedDiscoveryGroup?.start.description === 'Task failed; details unavailable',
  failedDiscoveryGroup?.start,
)

// A future prompt is visible as soon as it is accepted, but it must not steal
// liveness from the turn it is waiting behind. The same event later changes to
// delivered and becomes the active turn without creating a second bubble.
const queuedPrompts: SessionEvent[] = [
  {
    id: 'prompt:first', sessionId: 'prompt-ledger', seq: 1, at: 1, turnId: 'turn:first',
    ev: { k: 'user', text: 'First prompt', promptId: 'first', delivery: 'delivered' },
  },
  {
    id: 'prompt:second', sessionId: 'prompt-ledger', seq: 2, at: 2, turnId: 'turn:second',
    ev: { k: 'user', text: 'Second prompt', promptId: 'second', delivery: 'queued' },
  },
]
const queuedTurns = buildTurns(buildRows(queuedPrompts), { live: true })
check('a queued prompt is visible as its own future turn', queuedTurns.length === 2, queuedTurns)
check('the turn ahead of the queue remains live', queuedTurns[0]?.running === true, queuedTurns)
check('the queued prompt does not pretend to be running', queuedTurns[1]?.running === false, queuedTurns)
queuedPrompts[1] = {
  ...queuedPrompts[1]!,
  ev: { ...queuedPrompts[1]!.ev, delivery: 'delivered' } as SessionEvent['ev'],
}
const deliveredTurns = buildTurns(buildRows(queuedPrompts), { live: true })
check('delivery activates the same future turn', deliveredTurns[1]?.running === true, deliveredTurns)
check('delivery closes the previous live projection', deliveredTurns[0]?.running === false, deliveredTurns)

// Two actors that each name the other as parent must not send the tree walks
// into endless recursion (a stack overflow there blanked the window).
const cyclic: SessionEvent[] = ['a', 'b'].map((name, index) => ({
  id: `cycle-${name}`, sessionId: 'cycle', seq: index + 1, at: index + 1,
  parentAgentId: name === 'a' ? 'agent-b' : 'agent-a',
  ev: {
    k: 'subagent_start', toolId: `tool-${name}`, agentId: `agent-${name}`,
    agentType: 'Explore', description: `agent ${name}`, prompt: '', depth: 2,
  },
}))
let cyclicRows: ReturnType<typeof buildRows> = []
let cyclicRunning = false
try {
  cyclicRows = buildRows(cyclic)
  cyclicRunning = buildTurns(cyclicRows, { live: true }).some((turn) => turn.running)
} catch (error) {
  check('a parent cycle does not throw', false, String(error))
}
check('a parent cycle keeps both cards, flat', cyclicRows.filter(isGroup).length === 2, cyclicRows)
check('a parent cycle still reads as running', cyclicRunning)

// A rebuild after one new event keeps the finished turns' identity, so the
// memoised turn views only repaint the turn that moved.
{
  const base = queuedPrompts.slice(0, 1)
  const history: SessionEvent[] = [
    ...base,
    { id: 'reuse-reply', sessionId: base[0]!.sessionId, seq: 900, at: 900, turnId: base[0]!.turnId, ev: { k: 'assistant', text: 'done' } },
    { id: 'reuse-next', sessionId: base[0]!.sessionId, seq: 901, at: 901, turnId: 'reuse-turn-2', ev: { k: 'user', text: 'next' } },
  ]
  const first = buildTurns(buildRows(history), { live: true })
  const grown = [...history, { id: 'reuse-tool', sessionId: base[0]!.sessionId, seq: 902, at: 902, turnId: 'reuse-turn-2', ev: { k: 'tool', toolId: 'reuse-t', name: 'Bash', summary: 'ls' } } as SessionEvent]
  const second = reuseTurns(first, buildTurns(buildRows(grown), { live: true }))
  check('an untouched turn keeps its object', second[0] === first[0], { first: first[0]?.id, second: second[0]?.id })
  check('the turn that moved is a new object', second[1] !== first[1] && second[1]!.rows.length === 1, second[1])
  const answered = new Map([['reuse-t', { k: 'tool_result' }]])
  const again = reuseTurns(second, buildTurns(buildRows(grown), { live: true }), { before: new Map(), after: answered })
  check('a new tool result elsewhere refreshes the turn with the call', again[1] !== second[1] && again[0] === second[0])
}

// A prompt cancelled before delivery is not part of the conversation.
{
  const cancelled: SessionEvent[] = [
    { id: 'c-first', sessionId: 'c', seq: 1, at: 1, turnId: 'c-t1', ev: { k: 'user', text: 'first', delivery: 'delivered' } },
    { id: 'c-gone', sessionId: 'c', seq: 2, at: 2, turnId: 'c-t2', ev: { k: 'user', text: 'never mind', delivery: 'cancelled' } },
  ]
  const turns = buildTurns(buildRows(cancelled), { live: false })
  check('a prompt cancelled before delivery is not drawn', turns.length === 1 && turns[0]!.user?.text === 'first', turns.map((turn) => turn.user?.text))
}
{
  const base: SessionEvent = { id: 's-first', sessionId: 's', seq: 1, at: 1, turnId: 's-t1', ev: { k: 'user', text: 'first', delivery: 'delivered' } }
  const cancelled = (by: 'user' | 'server' | undefined): SessionEvent => ({
    id: 's-gone', sessionId: 's', seq: 2, at: 2, turnId: 's-t2',
    ev: { k: 'user', text: 'lost?', delivery: 'cancelled', ...(by ? { cancelledBy: by, cancelReason: 'the turn ahead failed' } : {}) },
  })
  const drawn = (by: 'user' | 'server' | undefined) => buildTurns(buildRows([base, cancelled(by)]), { live: false }).map((turn) => turn.user?.text)
  check('a prompt the user cancelled is not drawn', drawn('user').join() === 'first', drawn('user'))
  check('a prompt the server cancelled stays visible', drawn('server').join() === 'first,lost?', drawn('server'))
  check('an old cancelled prompt without the field stays hidden', drawn(undefined).join() === 'first', drawn(undefined))
  const kept = buildTurns(buildRows([base, cancelled('server')]), { live: false })[1]
  check('the kept prompt knows its event id, for Edit', kept?.userId === 's-gone', kept?.userId)
}

// A stopped agent resumed by `SendMessage` from a later turn is a run of its
// own: a card at the resuming call, in that turn, holding only the lines of that
// run, and running until its own end lands.
{
  const e = (seq: number, turnId: string, ev: SessionEvent['ev'], agentId?: string): SessionEvent =>
    ({ id: `r-${seq}`, sessionId: 'r', seq, at: seq * 1000, turnId, agentId, ev })
  const events: SessionEvent[] = [
    e(1, 't1', { k: 'user', text: 'spawn' }),
    e(2, 't1', { k: 'tool', toolId: 'spawn', name: 'Agent', input: { description: 'Worker', prompt: 'Do it.' }, summary: 'Worker' }),
    e(3, 't1', { k: 'subagent_start', toolId: 'spawn', agentId: 'w', agentType: 'general-purpose', description: 'Worker', prompt: 'Do it.', depth: 1 }),
    e(4, 't1', { k: 'assistant', text: 'first run' }, 'w'),
    e(5, 't1', { k: 'subagent_end', toolId: 'spawn', agentId: 'w', status: 'done', durationMs: 10, toolUses: 1, result: 'done' }, 'w'),
    e(6, 't2', { k: 'user', text: 'again' }),
    e(7, 't2', { k: 'tool', toolId: 'resume', name: 'SendMessage', input: { to: 'w', message: 'One more.' }, summary: 'w' }),
    e(8, 't2', { k: 'subagent_start', toolId: 'resume', agentId: 'w', agentType: 'general-purpose', description: 'Worker', prompt: 'One more.', depth: 1 }),
    e(9, 't2', { k: 'assistant', text: 'second run' }, 'w'),
    e(10, 't2', { k: 'subagent_end', toolId: 'resume', agentId: 'w', status: 'running', durationMs: 5, toolUses: 1, result: '', provisional: true }, 'w'),
  ]
  const groups = buildRows(events).filter(isGroup)
  const resumed = groups.find((group) => group.toolId === 'resume')
  check('a resumed agent gets a card per run', groups.length === 2, groups.map((group) => group.toolId))
  check('the resumed run is filed under the turn that resumed it', resumed?.turnId === 't2', resumed?.turnId)
  check('each run keeps only its own lines',
    resumed?.events.some((event) => event.id === 'r-9') === true && !resumed?.events.some((event) => event.id === 'r-4'),
    resumed?.events.map((event) => event.id))
  const turns = buildTurns(buildRows(events), { live: true })
  check('the resuming turn shows its agent running', turns[1]?.rows.some((row) => isGroup(row) && row.toolId === 'resume') === true, turns[1]?.rows)
}

if (failures.length) {
  console.log('\n--- failed checks ---')
  for (const failure of failures) console.log(`✗ ${failure}`)
  console.log(`\nview-test: ${failures.length} FAILURES`)
  process.exit(1)
}
console.log('\nview-test: PASSED')
process.exit(0)
