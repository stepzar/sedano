#!/usr/bin/env bun
/**
 * The three readings the redesigned transcript is built on, without a browser.
 *
 * `turnState` decides whether a turn is working, failed, interrupted or done — every visible
 * state signal reads it, so it is the one place a disagreement could start.
 * `splitWork` decides what belongs in the work block and what is the harness'
 * own bookkeeping. `toolSummary` is the repair for a tool call whose summary the
 * server never wrote, which is how the Skill card came to render as the bare
 * word "Skill" and a clock.
 *
 *   bun scripts/turn-view-test.ts
 */
import { resultOutcomeOf } from '@shared'
import type { SessionEvent, TimelineEvent } from '@shared'
import {
  buildRows,
  buildTurns,
  activeAgentsOf,
  compactCount,
  groupToolRuns,
  isToolRun,
  toolRunLine,
  toolRunParts,
  toolRunClass,
  firstLine,
  agentSpanMs,
  turnSpanMs,
  formatDuration,
  foldRepeats,
  ledgerState,
  readTurnWith,
  stateOf,
  cutOffAgents,
  turnFiles,
  isRoutineNotice,
  noticeLine,
  planItems,
  readTurn,
  splitWork,
  toolFacts,
  toolLine,
  toolSummary,
  toolLabel,
  toolTitle,
  turnState,
  turnSummary,
  turnWallMs,
} from '../apps/ui/src/view.ts'

const failures: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ok  ${label}`)
    return
  }
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  failures.push(label)
}

const T = 1_800_000_000_000
let seq = 0
function ev(payload: TimelineEvent, extra: { agentId?: string } = {}): SessionEvent {
  seq += 1
  return { id: `e${seq}`, sessionId: 's', seq, at: T + seq * 100, turnId: 't1', agentId: extra.agentId, ev: payload }
}

function turnsOf(events: SessionEvent[], live: boolean) {
  return buildTurns(buildRows(events), { live })
}

{
  seq = 0
  const rows = buildRows([
    ev({ k: 'user', text: 'go' }),
    ev({ k: 'tool', toolId: 'bash-1', name: 'Bash', input: { command: 'sleep 1 &' }, summary: 'sleep 1 &' }),
    ev({ k: 'subagent_end', toolId: 'bash-1', agentId: '', status: 'running', durationMs: 0, toolUses: 0, result: '', provisional: true }),
    ev({ k: 'subagent_end', toolId: 'bash-1', agentId: '', status: 'error', durationMs: 1000, toolUses: 0, result: 'failed' }),
  ])
  check('background Bash task notices do not become failed subagents', !rows.some((row) => 'kind' in row && row.kind === 'subagent'))
}

/* ---------------- turnState ---------------- */

console.log('\n=== turnState ===')

{
  seq = 0
  const events = [
    ev({ k: 'user', text: 'go' }),
    ev({ k: 'tool', toolId: 'a', name: 'Bash', input: { command: 'ls' }, summary: 'ls' }),
  ]
  const turn = turnsOf(events, true)[0]!
  check('a turn with no result, on a live session, is working', turnState(turn, true) === 'working', turnState(turn, true))
  // The session is what decides liveness: a harness that died mid-turn must not
  // leave a spinner behind for ever.
  check('the same turn on a dead session is not working', turnState(turn, false) !== 'working', turnState(turn, false))
}

{
  seq = 0
  const user = ev({ k: 'user', text: 'go' })
  const falseEnd = { ...ev({ k: 'result', subtype: 'end_turn', text: 'the harness finished without returning a result frame', durationMs: 2_000, costUsd: 0, costReported: false }), id: 'local:result:t1' }
  const work = { ...ev({ k: 'thinking', text: 'searching files' }), turnId: 't2' }
  const pending = turnsOf([user, falseEnd, work], true)
  check('legacy cold-start false result joins the real work into one turn', pending.length === 1 && pending[0]?.continuationTurnId === 't2', pending.map((turn) => turn.id))
  check('the repaired turn stays working until a real result', turnState(pending[0]!, true) === 'working')
  const realEnd = { ...ev({ k: 'result', subtype: 'end_turn', text: '', durationMs: 8_000, costUsd: 0, costReported: false }), turnId: 't2' }
  const finished = turnsOf([user, falseEnd, work, realEnd], true)
  check('the repaired turn has only the real duration', finished.length === 1 && finished[0]?.durationMs === 8_000, finished.map((turn) => turn.durationMs))
}

{
  seq = 0
  const events = [
    ev({ k: 'user', text: 'go' }),
    ev({ k: 'assistant', text: 'done' }),
    ev({ k: 'result', subtype: 'success', text: '', durationMs: 1_000, costUsd: 0, costReported: false }),
  ]
  const turn = turnsOf(events, true)[0]!
  check('a turn that ended in success is done', turnState(turn, true) === 'done', turnState(turn, true))
}

{
  seq = 0
  const events = [
    ev({ k: 'user', text: 'go' }),
    ev({ k: 'assistant', text: 'done' }),
    ev({ k: 'result', subtype: 'end_turn', text: '', durationMs: 1_000, costUsd: 0, costReported: false }),
  ]
  const turn = turnsOf(events, true)[0]!
  check('an ACP end_turn is a normal completion', turnState(turn, false) === 'done', turnState(turn, false))
  check('an ACP end_turn is routine bookkeeping', isRoutineNotice(events[2]!))
}

{
  seq = 0
  const events = [
    ev({ k: 'user', text: 'go' }),
    ev({ k: 'result', subtype: 'server_restart', text: 'server restarted', durationMs: 8_500, costUsd: 0, costReported: false }),
  ]
  const turn = turnsOf(events, false)[0]!
  check('a recovered server restart is visibly interrupted', turnState(turn, false) === 'interrupted', turnState(turn, false))
  check('a recovered server restart is not folded away', !isRoutineNotice(events[1]!))
}

{
  seq = 0
  const events = [
    ev({ k: 'user', text: 'go' }),
    ev({ k: 'result', subtype: 'error_during_execution', text: '', durationMs: 900, costUsd: 0, costReported: false }),
  ]
  const turn = turnsOf(events, true)[0]!
  check('a turn whose result was not a success is failed', turnState(turn, true) === 'failed', turnState(turn, true))
}

{
  seq = 0
  const completedWithProviderReason = ev({
    k: 'result',
    outcome: 'completed',
    subtype: 'max_tokens',
    text: '',
    durationMs: 1_000,
    costUsd: 0,
    costReported: false,
  })
  const interrupted = ev({
    k: 'result',
    outcome: 'interrupted',
    subtype: 'provider_specific_stop_reason',
    text: '',
    durationMs: 1_000,
    costUsd: 0,
    costReported: false,
  })
  check(
    'the semantic outcome wins over a non-standard provider reason',
    resultOutcomeOf(completedWithProviderReason.ev as Extract<TimelineEvent, { k: 'result' }>) === 'completed',
  )
  const semanticTurn = turnsOf([
    ev({ k: 'user', text: 'go' }),
    completedWithProviderReason,
  ], true)[0]!
  check('a semantically completed turn is done even when subtype is not success', turnState(semanticTurn, true) === 'done', turnState(semanticTurn, true))
  check(
    'a semantic interruption is not treated as a normal completion',
    resultOutcomeOf(interrupted.ev as Extract<TimelineEvent, { k: 'result' }>) === 'interrupted',
  )
  const interruptedTurn = turnsOf([
    ev({ k: 'user', text: 'stop' }),
    interrupted,
  ], false)[0]!
  check('an interrupted turn stays distinct from a failure', turnState(interruptedTurn, false) === 'interrupted', turnState(interruptedTurn, false))
}

{
  seq = 0
  const events = [
    ev({ k: 'user', text: 'go' }),
    ev({ k: 'tool', toolId: 'task1', name: 'Task', input: { description: 'run' }, summary: 'run' }),
    ev({
      k: 'subagent_start',
      toolId: 'task1',
      agentId: 'ag1',
      agentType: 'general-purpose',
      description: 'run',
      prompt: 'run',
      depth: 1,
    }),
    ev({
      k: 'subagent_end',
      toolId: 'task1',
      agentId: 'ag1',
      status: 'error',
      durationMs: 500,
      toolUses: 1,
      result: 'it blew up',
    }),
    ev({ k: 'result', subtype: 'success', text: '', durationMs: 2_000, costUsd: 0, costReported: false }),
  ]
  const turn = turnsOf(events, true)[0]!
  // The parent reported success after reading its agent's failure: the agent's
  // card says it failed, the turn does not. Failed is for an error the turn
  // ended on or a result that says so — nothing the model read and carried on from.
  check('a subagent that errored does not make its turn failed', turnState(turn, true) === 'done', turnState(turn, true))
}

/* ---------------- splitWork ---------------- */

console.log('\n=== splitWork ===')

{
  seq = 0
  const events = [
    ev({ k: 'system', subtype: 'init', text: 'model · /tmp/x · bypassPermissions' }),
    ev({ k: 'tool', toolId: 'a', name: 'Bash', input: { command: 'ls' }, summary: 'ls' }),
    ev({ k: 'system', subtype: 'stop_hook_summary', text: '2 hooks ran in 22ms' }),
    ev({ k: 'result', subtype: 'success', text: '', durationMs: 900, costUsd: 0, costReported: false }),
    ev({ k: 'system', subtype: 'stop_hook_summary', text: '1 hook ran in 4ms · a hook stopped the turn' }),
    ev({ k: 'result', subtype: 'error_during_execution', text: '', durationMs: 100, costUsd: 0, costReported: false }),
  ]
  const split = splitWork(buildRows(events))
  check('the init line becomes the turn context', split.context.length === 1, split.context.length)
  check('routine hook runs and successful results are folded away', split.notices.length === 2, {
    notices: split.notices.map((event) => event.ev.k),
  })
  // Two of the six rows are neither: the tool call and the two rows that are not
  // routine. Anything that went wrong must stay where it can be seen.
  check(
    'a hook that stopped the turn stays in plain sight',
    split.activity.some((row) => !('kind' in row) && row.ev.k === 'system' && /stopped the turn/.test(row.ev.text)),
    split.activity.length,
  )
  check(
    'a result that was not a success stays in plain sight',
    split.activity.some((row) => !('kind' in row) && row.ev.k === 'result' && row.ev.subtype !== 'success'),
    split.activity.length,
  )
  check('nothing is dropped', split.context.length + split.activity.length + split.notices.length === 6, {
    context: split.context.length,
    activity: split.activity.length,
    notices: split.notices.length,
  })
}

{
  seq = 0
  const hook = ev({ k: 'system', subtype: 'stop_hook_summary', text: '2 hooks ran in 22ms' })
  const noisy = ev({ k: 'system', subtype: 'stop_hook_summary', text: '2 hooks ran in 22ms · 1 reported an error: boom' })
  check('"2 hooks ran in 22ms" is routine', isRoutineNotice(hook))
  check('a hook that reported an error is not routine', !isRoutineNotice(noisy))
}

/* ---------------- toolSummary ---------------- */

console.log('\n=== toolSummary ===')

check(
  'a Skill call is named by the skill it runs',
  // This is the exact input the harness writes, and the server has no case for
  // it — so the card used to render as the word "Skill" and a clock.
  toolSummary({ name: 'Skill', summary: '', input: { skill: 'superpowers:brainstorming', args: 'x' } }) ===
    'superpowers:brainstorming',
  toolSummary({ name: 'Skill', summary: '', input: { skill: 'superpowers:brainstorming', args: 'x' } }),
)
check(
  'a summary the server wrote is never second-guessed',
  toolSummary({ name: 'Bash', summary: 'bun test', input: { command: 'rm -rf /' } }) === 'bun test',
)
check(
  'an input with no named key still yields its first string',
  toolSummary({ name: 'Weird', summary: '', input: { whatever: 'a value' } }) === 'a value',
)
check(
  'an input with nothing to say yields nothing, never JSON',
  toolSummary({ name: 'Weird', summary: '', input: { count: 3, nested: { a: 1 } } }) === '',
  toolSummary({ name: 'Weird', summary: '', input: { count: 3, nested: { a: 1 } } }),
)
check('only the first line of a multi-line value is used', toolSummary({ name: 'Bash', input: { command: 'a\nb' } }) === 'a')

/* ---------------- the display model ---------------- */

console.log('\n=== display model ===')

{
  // Claude streams the launch frame of an agent before the transcript line that
  // holds the spawn call and the text written just ahead of it. The card must
  // sit at its call, so that text is a note on the way, not the reply.
  seq = 0
  const events = [
    ev({ k: 'user', text: 'go' }),
    ev({ k: 'subagent_start', toolId: 'spawn', agentId: 'a1', agentType: 'Explore', description: 'look', prompt: 'look', depth: 1 }),
    ev({ k: 'assistant', text: 'I will send an agent to look first.' }),
    ev({ k: 'tool', toolId: 'spawn', name: 'Agent', input: { description: 'look', prompt: 'look' }, summary: 'look' }),
    ev({ k: 'subagent_end', toolId: 'spawn', agentId: 'a1', status: 'done', durationMs: 900, toolUses: 2, result: 'found it' }),
    ev({ k: 'assistant', text: 'It is in the config.' }),
    ev({ k: 'result', subtype: 'success', outcome: 'completed', text: '', durationMs: 50, costUsd: 0 }),
  ]
  const turn = turnsOf(events, false)[0]!
  const kinds = turn.rows.map((row) => ('kind' in row ? 'card' : row.ev.k))
  check('the agent card sits at its spawn call, after the note', kinds.indexOf('card') > kinds.indexOf('assistant'), kinds)
  const reading = readTurn(turn.rows)
  check('the note before the call is not the reply', reading.reply.map((row) => row.id).join() === events[5]!.id, reading.reply.map((row) => row.ev))
  // Wall time: the prompt to the last event, not the 50ms the result reported.
  check('duration is the wall time of the turn', turnWallMs(turn) === events[6]!.at - events[0]!.at, turnWallMs(turn))
}

{
  // Two model cycles: the first closes with prose, the model carries on when
  // its agent comes back, the second closes with the answer.
  seq = 0
  const events = [
    ev({ k: 'user', text: 'go' }),
    ev({ k: 'tool', toolId: 'r1', name: 'Read', input: { file_path: 'a.ts' }, summary: 'a.ts' }),
    ev({ k: 'assistant', text: 'Waiting for the agent.' }),
    ev({ k: 'result', subtype: 'success', outcome: 'completed', text: '', durationMs: 10, costUsd: 0 }),
    ev({ k: 'tool', toolId: 'r2', name: 'Read', input: { file_path: 'b.ts' }, summary: 'b.ts' }),
    ev({ k: 'assistant', text: 'Done: both files agree.' }),
    ev({ k: 'result', subtype: 'success', outcome: 'completed', text: '', durationMs: 10, costUsd: 0 }),
  ]
  const reading = readTurn(turnsOf(events, false)[0]!.rows)
  check('the reply is the last cycle\'s closing only', reading.reply.length === 1 && reading.reply[0]!.id === events[5]!.id, reading.reply)
  check('an earlier cycle\'s closing becomes an update', reading.updates.length === 1 && reading.updates[0]!.id === events[2]!.id, reading.updates)
}

{
  // A result that reported its own final text, and no closing message.
  seq = 0
  const events = [
    ev({ k: 'user', text: 'go' }),
    ev({ k: 'tool', toolId: 'r1', name: 'Read', input: { file_path: 'a.ts' }, summary: 'a.ts' }),
    ev({ k: 'result', subtype: 'success', outcome: 'completed', text: '', durationMs: 10, costUsd: 0, reply: 'From the result.' }),
  ]
  check('the result\'s own reply is the fallback', readTurn(turnsOf(events, false)[0]!.rows).fallback === 'From the result.')
}

{
  // The session stopped while an agent was still out.
  seq = 0
  const events = [
    ev({ k: 'user', text: 'go' }),
    ev({ k: 'tool', toolId: 'spawn', name: 'Task', input: { description: 'dig' }, summary: 'dig' }),
    ev({ k: 'subagent_start', toolId: 'spawn', agentId: 'a1', agentType: 'Explore', description: 'dig', prompt: '', depth: 1 }),
    ev({ k: 'subagent_end', toolId: 'spawn', agentId: 'a1', status: 'running', durationMs: 0, toolUses: 0, result: '', provisional: true }),
    ev({ k: 'tool_result', toolId: 'x', text: 'no such file', isError: true, truncated: false }),
  ]
  const turn = turnsOf(events, false)[0]!
  check('a stopped session with an agent still out is stopped, not failed', turnState(turn, false) === 'interrupted', turnState(turn, false))
  check('and it counts the agent that was cut off', cutOffAgents(turn) === 1, cutOffAgents(turn))
}

{
  // ACP spells tools in lower case and names their kind; counts split by scope.
  seq = 0
  const events = [
    ev({ k: 'user', text: 'go' }),
    ev({ k: 'tool', toolId: 'b1', name: 'bash', input: { command: 'ls' }, summary: 'ls' }),
    ev({ k: 'tool', toolId: 'k1', name: 'run it', kind: 'execute', input: {}, summary: 'make' }),
    ev({ k: 'tool', toolId: 'spawn', name: 'Task', input: { description: 'dig' }, summary: 'dig' }),
    ev({ k: 'subagent_start', toolId: 'spawn', agentId: 'a1', agentType: 'Explore', description: 'dig', prompt: '', depth: 1 }),
    ev({ k: 'tool', toolId: 'b2', name: 'Bash', input: { command: 'pwd' }, summary: 'pwd' }, { agentId: 'a1' }),
    ev({ k: 'file_change', toolId: 'w1', path: 'src/a.ts', change: 'edit', added: 2, removed: 1, preview: '' }, { agentId: 'a1' }),
    ev({ k: 'subagent_end', toolId: 'spawn', agentId: 'a1', status: 'done', durationMs: 10, toolUses: 2, result: 'ok' }),
  ]
  const summary = turnSummary(turnsOf(events, false)[0]!)
  check('lower-case and kind-named commands are counted, split by scope', summary.includes('3 Commands (1 in agents)'), summary)
  check('a subagent\'s file edit is counted', summary.includes('1 File Changed (all in agents)'), summary)
}

{
  // One-line tool summaries.
  seq = 0
  const bash = ev({ k: 'tool', toolId: 'b', name: 'Bash', input: { command: 'bun test' }, summary: 'bun test' })
  const read = ev({ k: 'tool', toolId: 'r', name: 'Read', input: { file_path: '/x/src/view.ts', offset: 120, limit: 61 }, summary: '' })
  const edit = ev({ k: 'tool', toolId: 'w', name: 'Edit', input: { file_path: '/x/src/a.ts' }, summary: 'src/a.ts' })
  const grep = ev({ k: 'tool', toolId: 'g', name: 'Grep', input: { pattern: 'TODO' }, summary: 'TODO' })
  const bg = ev({ k: 'tool', toolId: 'bg', name: 'Bash', input: { command: 'sleep 9' }, summary: 'sleep 9' })
  const facts = toolFacts([
    bash,
    ev({ k: 'tool_result', toolId: 'b', text: 'ok', isError: false, truncated: false, durationMs: 2100, exitCode: 0 }),
    read, edit,
    ev({ k: 'file_change', toolId: 'w', path: '/x/src/a.ts', change: 'edit', added: 12, removed: 3, preview: '' }),
    grep,
    ev({ k: 'tool_result', toolId: 'g', text: 'a.ts\nb.ts\n', isError: false, truncated: false }),
    bg,
    ev({ k: 'subagent_end', toolId: 'bg', agentId: 'task-9', status: 'done', durationMs: 9000, toolUses: 0, result: '', background: 'bash', exitCode: 0 }),
  ])
  const line = (event: SessionEvent) => (event.ev.k === 'tool' ? toolLine(event.ev, facts.get(event.ev.toolId)) : '')
  check('bash says its time and exit status', line(bash) === 'bun test (2.1s, exit 0)', line(bash))
  check('read says the lines it covered', line(read) === 'view.ts:120-180', line(read))
  check('edit says its line counts', line(edit) === 'a.ts +12 −3', line(edit))
  check('grep says its pattern and hits', line(grep) === "'TODO' (2 hits)", line(grep))
  check('a background command says how it ended', line(bg) === 'sleep 9 · ⧗ bg → done', line(bg))
  check('an MCP tool reads as server · tool', toolTitle('mcp__github__create_issue') === 'Github · create_issue', toolTitle('mcp__github__create_issue'))
  const same = facts.get('b')!.result!
  const again = toolFacts([bash, { ...bash, id: 'rb', ev: same }], facts)
  check('unchanged tool facts keep their identity', again.get('b') === facts.get('b'))
}

{
  // Plans, in both spellings.
  const todo = planItems({ k: 'tool', toolId: 't', name: 'TodoWrite', summary: '', input: { todos: [
    { content: 'read', status: 'completed' }, { content: 'fix', status: 'in_progress' }, { content: 'test', status: 'pending' },
  ] } })
  check('a TodoWrite call is a checklist', todo?.map((item) => item.status).join() === 'done,active,pending', todo)
  const acp = planItems({ k: 'system', subtype: 'plan', text: '✓ read\n▸ fix\n· test' })
  check('an ACP plan is the same checklist', acp?.map((item) => item.status).join() === 'done,active,pending', acp)
}

{
  // Harness notices read as one line each and fold away.
  const compact = { k: 'system' as const, subtype: 'compact_boundary', text: 'Conversation compacted', detail: { preTokens: 180_000, postTokens: 40_000 } }
  check('a compaction reads as one line', noticeLine(compact) === 'Compacted · 180k→40k', noticeLine(compact))
  const retry = { k: 'system' as const, subtype: 'api_error', text: 'API error', detail: { attempt: 2, maxRetries: 10, message: 'overloaded' } }
  check('a retry reads as one line', noticeLine(retry) === 'API retry 2/10 · overloaded', noticeLine(retry))
  seq = 0
  check('a retry is a routine notice', isRoutineNotice(ev(retry)))
  check('a compaction is a routine notice', isRoutineNotice(ev(compact)))
}

{
  // The header's facts: files by what happened to them, agents included, and
  // the turn's token traffic split between its own results and its agents'.
  seq = 0
  const events = [
    ev({ k: 'user', text: 'go' }),
    ev({ k: 'file_change', toolId: 'w1', path: 'a.ts', change: 'edit', added: 1, removed: 1, preview: '' }),
    ev({ k: 'file_change', toolId: 'w2', path: 'b.ts', change: 'create', added: 9, removed: 0, preview: '' }),
    ev({ k: 'file_change', toolId: 'w3', path: 'b.ts', change: 'edit', added: 1, removed: 0, preview: '' }),
    ev({ k: 'tool', toolId: 'spawn', name: 'Task', input: { description: 'dig' }, summary: 'dig' }),
    ev({ k: 'subagent_start', toolId: 'spawn', agentId: 'a1', agentType: 'Explore', description: 'dig', prompt: '', depth: 1 }),
    ev({ k: 'file_change', toolId: 'w4', path: 'c.ts', change: 'edit', added: 2, removed: 0, preview: '' }, { agentId: 'a1' }),
    ev({ k: 'tool', toolId: 'd1', name: 'remove', kind: 'delete', input: {}, summary: 'old.ts' }),
    ev({ k: 'subagent_end', toolId: 'spawn', agentId: 'a1', status: 'done', durationMs: 10, toolUses: 1, result: 'ok',
      usage: { input: 5, output: 700, cacheRead: 100, cacheWrite: 0, reasoning: 0 } }),
    ev({ k: 'result', subtype: 'success', outcome: 'completed', text: '', durationMs: 10, costUsd: 0,
      usage: { input: 10, output: 300, cacheRead: 2000, cacheWrite: 50, reasoning: 0 } }),
  ]
  const turn = turnsOf(events, false)[0]!
  const files = turnFiles(turn)
  check('changed files include an agent\'s edit', files.edited.sort().join() === 'a.ts,c.ts', files)
  check('a file created then edited is one added file', files.added.join() === 'b.ts', files)
  check('a delete-kind call is a deleted file', files.deleted.join() === 'old.ts', files)
  check('the turn\'s own tokens come from its results', turn.tokens.main.output === 300 && turn.tokens.main.cacheRead === 2000, turn.tokens)
  check('its agents\' tokens come from their completions', turn.tokens.agents.output === 700, turn.tokens)
  check('counts read compactly', compactCount(25_300) === '25.3k' && compactCount(1_250_000) === '1.3M', compactCount(25_300))
}

{
  // The server's turn ledger decides the state; the events are the fallback.
  const record = (phase: string, extra: Record<string, unknown> = {}) =>
    ({ id: 't1', sessionId: 's', runToken: 'r', status: 'completed', startedAt: T, phase, ...extra }) as never
  check('running and waiting on agents are working', ledgerState(record('running')) === 'working' && ledgerState(record('waiting_agents')) === 'working')
  check('completed is done, stopped is interrupted, failed is failed',
    ledgerState(record('completed')) === 'done' && ledgerState(record('stopped')) === 'interrupted' && ledgerState(record('failed')) === 'failed')
  check('a turn continued by a new prompt is simply done', ledgerState(record('stopped', { subtype: 'continued' })) === 'done')
  check('no phase, no ledger answer', ledgerState(undefined) === null)
  seq = 0
  const events = [
    ev({ k: 'user', text: 'go' }),
    ev({ k: 'tool', toolId: 'a', name: 'Bash', input: { command: 'ls' }, summary: 'ls' }),
  ]
  const turn = turnsOf(events, true)[0]!
  check('the ledger overrides the events: a completed turn is not working', stateOf(turn, record('completed'), true) === 'done')
  check('a turn the ledger does not know is settled, not left spinning', stateOf(turn, null, true) === 'done')
  check('without a ledger the events decide', stateOf(turn, undefined, true) === 'working')
  seq = 0
  const replyEvents = [
    ev({ k: 'user', text: 'go' }),
    ev({ k: 'assistant', text: 'the real answer' }),
    ev({ k: 'tool', toolId: 'late', name: 'Read', input: { file_path: 'x' }, summary: 'x' }),
    ev({ k: 'assistant', text: 'a closing line the events would pick' }),
  ]
  const reading = readTurnWith(turnsOf(replyEvents, false)[0]!.rows, record('completed', { replyEventId: replyEvents[1]!.id }))
  check('the ledger\'s reply event is the reply', reading.reply.length === 1 && reading.reply[0]!.id === replyEvents[1]!.id, reading.reply)
  check('what the events picked moves to the updates', reading.updates.some((row) => row.id === replyEvents[3]!.id), reading.updates)
  check('the ledger counts live agents', activeAgentsOf({ a: record('waiting_agents', { activeAgents: 2 }), b: record('completed', { activeAgents: 5 }) }) === 2)
  check('no ledger, no count', activeAgentsOf(undefined) === null)
}

{
  // Runs of consecutive calls fold into one row; anything that says something breaks them.
  seq = 0
  const call = (id: string, name: string) => ev({ k: 'tool', toolId: id, name, input: {}, summary: id })
  const answer = (id: string, durationMs?: number) => ev({ k: 'tool_result', toolId: id, text: 'ok', isError: false, truncated: false, ...(durationMs ? { durationMs } : {}) })
  const rows = [
    call('b1', 'Bash'), answer('b1', 2000), call('b2', 'Bash'), answer('b2', 3000), call('b3', 'Bash'),
    ev({ k: 'assistant', text: 'a note' }),
    call('r1', 'Read'), call('b4', 'Bash'), call('r2', 'Read'),
    ev({ k: 'thinking', text: 'hmm' }),
    call('single', 'Grep'),
    ev({ k: 'tool', toolId: 'q', name: 'AskUserQuestion', input: {}, summary: '' }),
    call('x1', 'Bash'),
  ]
  const grouped = groupToolRuns(rows)
  const runs = grouped.filter(isToolRun)
  check('consecutive calls become runs', runs.length === 2 && runs[0]!.events.length === 3 && runs[1]!.events.length === 3, runs.map((run) => run.events.length))
  check('a note breaks a run', grouped.some((item) => !isToolRun(item) && 'ev' in item && item.ev.k === 'assistant'))
  check('a lone call stays a card', grouped.some((item) => !isToolRun(item) && 'ev' in item && item.ev.k === 'tool' && item.ev.toolId === 'single'))
  check('a question is never folded into a run', grouped.some((item) => !isToolRun(item) && 'ev' in item && item.ev.k === 'tool' && item.ev.name === 'AskUserQuestion'))
  const facts = toolFacts(rows)
  check('a run of one tool says the tool and its time', toolRunLine(runs[0]!, facts) === 'Bash ×3', toolRunLine(runs[0]!, facts))
  check('a mixed run says how many and which', toolRunLine(runs[1]!, facts).startsWith('3 tools · Read ×2, Bash ×1'), toolRunLine(runs[1]!, facts))
  check('a run keeps its first call as its key', runs[0]!.key === rows[0]!.id)
  // The work row sets the two halves apart: what ran, and how long.
  const parts = toolRunParts(runs[0]!, facts)
  check('a run row splits what ran from its time', parts.label === 'Bash ×3' && parts.time === '', parts)
  check('a run of one kind has that kind (its icon)', toolRunClass(runs[0]!) === 'command', toolRunClass(runs[0]!))
  check('a mixed run has none (a stack)', toolRunClass(runs[1]!) === null, toolRunClass(runs[1]!))
  // ACP names the kind itself, and it wins over the title.
  const acpRun = groupToolRuns([
    ev({ k: 'tool', toolId: 'k1', name: 'Shell', input: {}, summary: 'ls', kind: 'execute' }),
    ev({ k: 'tool', toolId: 'k2', name: 'run_command', input: {}, summary: 'pwd', kind: 'execute' }),
  ]).filter(isToolRun)[0]!
  check('ACP: a run of execute calls is a run of commands', toolRunClass(acpRun) === 'command', toolRunClass(acpRun))
}

{
  // What a folded row previews: the first line of prose, without its marks.
  check('firstLine drops Markdown marks', firstLine('**Checking** the `auth` docs\nmore') === 'Checking the auth docs', firstLine('**Checking** the `auth` docs\nmore'))
  check('firstLine skips blank lines and headings', firstLine('\n\n## Result\nbody') === 'Result', firstLine('\n\n## Result\nbody'))
  check('firstLine reads a list item or a table row as its text', firstLine('- one item') === 'one item' && firstLine('| Route | Fix |').startsWith('Route'), [firstLine('- one item'), firstLine('| Route | Fix |')])
  check('firstLine of nothing is nothing', firstLine('   ') === '')
}

{
  // The same harness line twice in a row is said once, with how many it stands for.
  seq = 0
  const line = (text: string) => ev({ k: 'system', subtype: 'info', text })
  const rows = [
    line('reattached to the agent that kept running while sedano was closed'),
    line('reattached to the agent that kept running while sedano was closed'),
    ev({ k: 'tool', toolId: 'r1', name: 'Bash', input: {}, summary: 'ls' }),
    line('reattached to the agent that kept running while sedano was closed'),
    line('a different line'),
  ]
  const folded = foldRepeats(rows)
  check('two identical harness lines in a row become one', folded.rows.length === 4 && folded.repeats.get(rows[0]!.id) === 2, folded.rows.map((row) => row.id))
  check('the same line after other work is a new line', folded.rows.includes(rows[3]!) && !folded.repeats.has(rows[3]!.id))
  const calls = foldRepeats([ev({ k: 'tool', toolId: 'a', name: 'Bash', input: {}, summary: 'ls' }), ev({ k: 'tool', toolId: 'b', name: 'Bash', input: {}, summary: 'ls' })])
  check('a repeated tool call is real work and is never folded', calls.rows.length === 2 && calls.repeats.size === 0)
}

/* ---------------- every harness, not just Claude ---------------- */

console.log('\n=== per harness ===')

{
  // opencode (ACP, older data): lower-case names, the summary is the name, inputs often empty.
  seq = 0
  const events = [
    ev({ k: 'user', text: 'look around' }),
    ev({ k: 'tool', toolId: 'o1', name: 'bash', input: { cwd: '/root' }, summary: 'bash' }),
    ev({ k: 'tool', toolId: 'o2', name: 'glob', input: {}, summary: 'glob' }),
    ev({ k: 'tool_result', toolId: 'o2', text: 'No files found', isError: false, truncated: false }),
    ev({ k: 'tool', toolId: 'o3', name: 'grep', input: { pattern: 'TODO' }, summary: 'grep' }),
    ev({ k: 'tool_result', toolId: 'o3', text: 'Found 90 matches\n/a.ts:\n  line', isError: false, truncated: false }),
    ev({ k: 'tool', toolId: 'o4', name: 'read', input: {}, summary: 'read' }),
    ev({ k: 'assistant', text: 'Here is what I found.' }),
    ev({ k: 'result', subtype: 'success', outcome: 'completed', text: '', durationMs: 1, costUsd: 0 }),
  ]
  const turn = turnsOf(events, false)[0]!
  const facts = toolFacts(events)
  const line = (index: number) => { const e = events[index]!.ev; return e.k === 'tool' ? toolLine(e, facts.get(e.toolId)) : '' }
  check('opencode: a summary that is only the name says nothing twice', line(1) === '' && line(7) === '', [line(1), line(7)])
  check('opencode: a search says its stated hit count', line(4) === "'TODO' (90 hits)", line(4))
  check('opencode: an empty search says zero hits', line(2) === '', line(2))
  check('opencode: lower-case tools are counted', turn.stats.commands === 1 && turn.stats.reads === 1 && turn.stats.searches === 2, turn.stats)
  const runs = groupToolRuns(turn.rows).filter(isToolRun)
  check('opencode: consecutive calls fold into one run', runs.length === 1 && runs[0]!.events.length === 4, runs.map((run) => run.events.length))
  check('opencode: the closing prose is the reply', readTurn(turn.rows).reply.length === 1)
}

{
  // ACP agents with titles and kinds (codex, gemini, grok, newer opencode).
  seq = 0
  const events = [
    ev({ k: 'user', text: 'fix it' }),
    ev({ k: 'assistant', text: 'Reading the file first.' }),
    ev({ k: 'tool', toolId: 'a1', name: 'Read src/view.ts', kind: 'read', input: { path: 'src/view.ts' }, summary: 'Read src/view.ts' }),
    ev({ k: 'tool', toolId: 'a2', name: 'Read src/store.ts', kind: 'read', input: { path: 'src/store.ts' }, summary: 'Read src/store.ts' }),
    ev({ k: 'tool', toolId: 'a3', name: 'Run `bun test`', kind: 'execute', input: { command: 'bun test' }, summary: 'Run `bun test`' }),
    ev({ k: 'tool_result', toolId: 'a3', text: 'ok', isError: false, truncated: false, durationMs: 4200, exitCode: 0 }),
    ev({ k: 'tool', toolId: 'a4', name: 'Edit src/view.ts', kind: 'edit', input: { path: 'src/view.ts' }, summary: 'Edit src/view.ts' }),
    ev({ k: 'file_change', toolId: 'a4', path: 'src/view.ts', change: 'edit', added: 3, removed: 1, preview: '' }),
    ev({ k: 'system', subtype: 'plan', text: '✓ read\n▸ fix\n· test' }),
    ev({ k: 'assistant', text: 'Fixed.' }),
  ]
  const turn = turnsOf(events, false)[0]!
  const facts = toolFacts(events)
  const tool = (index: number) => events[index]!.ev as Extract<TimelineEvent, { k: 'tool' }>
  check('ACP: a call is labelled by its kind', toolLabel(tool(2)) === 'Read' && toolLabel(tool(4)) === 'Run', [toolLabel(tool(2)), toolLabel(tool(4))])
  check('ACP: the summary drops the repeated kind word', toolLine(tool(2), facts.get('a1')) === 'src/view.ts', toolLine(tool(2), facts.get('a1')))
  check('ACP: an execute call says its time and exit status', toolLine(tool(4), facts.get('a3')) === '`bun test` (4.2s, exit 0)', toolLine(tool(4), facts.get('a3')))
  check('ACP: an edit says its line counts', toolLine(tool(6), facts.get('a4')) === 'view.ts +3 −1', toolLine(tool(6), facts.get('a4')))
  const runs = groupToolRuns(turn.rows).filter(isToolRun)
  check('ACP: a run counts calls by kind, not by title', runs.length === 1 && toolRunLine(runs[0]!, facts).startsWith('4 tools · Read ×2'), runs.map((run) => toolRunLine(run, facts)))
  check('ACP: kinds are counted in the header', turn.stats.reads === 2 && turn.stats.commands === 1, turn.stats)
  check('ACP: the note before the calls is not the reply', readTurn(turn.rows).reply.map((row) => row.ev.k === 'assistant' && row.ev.text).join() === 'Fixed.')
  check('ACP: a plan is a checklist', planItems(events[8]!.ev)?.length === 3)
}

{
  // Command Code: snake_case names, summaries prefixed with the name.
  seq = 0
  const read = ev({ k: 'tool', toolId: 'c1', name: 'read_file', input: { path: 'src/a.ts' }, summary: 'read_file src/a.ts' })
  const run = ev({ k: 'tool', toolId: 'c2', name: 'run_terminal_command', input: { command: 'ls' }, summary: 'run_terminal_command ls' })
  const skill = ev({ k: 'tool', toolId: 'c3', name: 'activate_skill', input: { name: 'costi' }, summary: 'activate_skill costi' })
  const facts = toolFacts([read, run, skill])
  const line = (event: SessionEvent) => (event.ev.k === 'tool' ? toolLine(event.ev, facts.get(event.ev.toolId)) : '')
  check('Command Code: the summary drops the repeated tool name', line(read) === 'src/a.ts' && line(run) === 'ls' && line(skill) === 'costi', [line(read), line(run), line(skill)])
  const turn = turnsOf([ev({ k: 'user', text: 'go' }), read, run, skill], false)[0]!
  check('Command Code: its tools are counted', turn.stats.reads === 1 && turn.stats.commands === 1, turn.stats)
  check('Command Code: consecutive calls fold into one run', groupToolRuns(turn.rows).filter(isToolRun).length === 1)
}

{
  // A lower-case todowrite (opencode) is the same checklist as Claude's TodoWrite.
  const todo = planItems({ k: 'tool', toolId: 't', name: 'todowrite', summary: '', input: { todos: [{ content: 'a', status: 'completed', priority: 'high', id: '1' }] } })
  check('opencode: todowrite is a checklist', todo?.length === 1 && todo[0]!.status === 'done', todo)
}

{
  // Durations: one formatter, and a cut-off agent or a stopped turn ends at its
  // last known event, never at the moment the stop was noticed.
  check('durations read the same way everywhere', [formatDuration(200), formatDuration(4_100), formatDuration(26_000), formatDuration(252_000), formatDuration(3_780_000)].join(' ') === '0.2s 4.1s 26s 4m 12s 1h 3m')
  seq = 0
  const base = 1_760_000_000_000
  const at = (event: SessionEvent, when: number): SessionEvent => ({ ...event, at: when })
  const later = base + 30 * 24 * 3600_000
  const rows = buildRows([
    at(ev({ k: 'user', text: 'go' }), base),
    at(ev({ k: 'subagent_start', toolId: 'cut', agentId: 'a-cut', agentType: 'x', description: 'd', prompt: 'p', depth: 1 }), base + 1_000),
    at(ev({ k: 'tool', toolId: 'c1', name: 'Bash', input: {}, summary: 'ls' }, { agentId: 'a-cut' }), base + 5_000),
    at(ev({ k: 'tool_result', toolId: 'c1', text: '', isError: false, truncated: false }, { agentId: 'a-cut' }), base + 9_000),
    // What an older build wrote a month later: stopped, "now − launch".
    at(ev({ k: 'subagent_end', toolId: 'cut', agentId: 'a-cut', status: 'stopped', durationMs: later - base - 1_000, toolUses: 0, result: '' }, { agentId: 'a-cut' }), later),
  ])
  const turn = buildTurns(rows)[0]!
  const group = turn.rows.find((row) => 'start' in row) as Parameters<typeof agentSpanMs>[0]
  check('a cut-off agent worked until its last activity, not until it was noticed', agentSpanMs(group) === 8_000, agentSpanMs(group))
  check('its turn ends there too', turn.endedAt === base + 9_000, turn.endedAt - base)
  const record = { endedAt: later } as Parameters<typeof turnSpanMs>[1]
  check('a ledger end later than every event is not work', turnSpanMs(turn, record) === 9_000, turnSpanMs(turn, record))
  const zero = buildTurns(buildRows([
    at(ev({ k: 'user', text: 'go' }), base),
    at(ev({ k: 'subagent_start', toolId: 'z', agentId: 'a-z', agentType: 'x', description: 'd', prompt: 'p', depth: 1 }), base + 1_000),
    at(ev({ k: 'tool', toolId: 'z1', name: 'Bash', input: {}, summary: 'ls' }, { agentId: 'a-z' }), 0),
  ]))[0]!
  const zeroGroup = zero.rows.find((row) => 'start' in row) as Parameters<typeof agentSpanMs>[0]
  check('a missing timestamp is ignored rather than measured from', agentSpanMs(zeroGroup) === null, agentSpanMs(zeroGroup))
}

if (failures.length) {
  console.log(`\nturn-view-test: ${failures.length} FAILURES`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('\nturn-view-test: PASSED')
process.exit(0)
