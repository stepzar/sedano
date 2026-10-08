#!/usr/bin/env bun
/**
 * A respawned Claude session must not rewrite its own history.
 *
 * A new Claude driver re-reads the whole transcript, and its results used to
 * restart their ids at `result:<conversation>:1`. On a live session that did
 * three things at once: every old subagent card was re-stamped with the time of
 * the re-read, the new turn's result overwrote the first turn's, and every old
 * agent was registered again as a `starting` actor of the new turn — which then
 * waited on them forever. This drives exactly that path through the manager
 * with a fake CLI (stream on stdout, transcript and subagent sidecar on disk),
 * then checks that a boot repairs a database carrying the old damage.
 *
 * Hermetic: a temporary SEDANO_HOME, CLAUDE_CONFIG_DIR and PATH.
 *
 *   bun scripts/resume-history-test.ts
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.SEDANO_RESUME_SANDBOX) {
  const work = mkdtempSync(join(tmpdir(), 'sedano-resume-'))
  const bin = join(work, 'bin')
  mkdirSync(bin, { recursive: true })
  const fake = join(work, 'fake-claude.ts')
  writeFileSync(fake, FAKE_CLI())
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\nexec ${process.execPath} ${fake} "$@"\n`)
  chmodSync(join(bin, 'claude'), 0o755)
  const child = Bun.spawn([process.execPath, import.meta.path], {
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      SEDANO_EXPLICIT_PATH: '1',
      SEDANO_BACKGROUND_SYNC: '0',
      SEDANO_HOME: join(work, 'home'),
      CLAUDE_CONFIG_DIR: join(work, 'claude'),
      SEDANO_RESUME_SANDBOX: work,
    },
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  const code = await child.exited
  rmSync(work, { recursive: true, force: true })
  process.exit(code)
}

const work = process.env.SEDANO_RESUME_SANDBOX
const failures: string[] = []
const passed: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) passed.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}
async function waitFor(label: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(50)
  }
}

const manager = await import('../apps/server/src/manager.ts')
const db = await import('../apps/server/src/db.ts')

const cwd = join(work, 'workspace')
mkdirSync(cwd, { recursive: true })
const session = await manager.createSession({ harness: 'claude', cwd, permissionMode: 'bypassPermissions' } as never)

/* 1 · A first turn that spawns a subagent */

const first = await manager.sendMessage(session.id, 'spawn an agent')
const events = () => db.loadEvents(session.id)
await waitFor('the first turn to finish with its agent', () =>
  events().some((event) => event.ev.k === 'subagent_start')
  && events().some((event) => event.ev.k === 'subagent_end' && event.ev.status === 'done')
  && manager.getSession(session.id)?.status === 'idle',
)
await Bun.sleep(600)
const startBefore = events().find((event) => event.ev.k === 'subagent_start')!
const resultBefore = events().find((event) => event.ev.k === 'result')!
check('the first turn has its subagent card', startBefore.turnId === first.turnId, startBefore)

/* 2 · A settings change drops the process; the next prompt respawns it */

const applied = manager.setSessionOptions(session.id, { model: 'opus' })
check('the settings change is accepted while idle', applied.ok, applied)
const second = await manager.sendMessage(session.id, 'just answer')
await waitFor('the second turn to finish', () =>
  events().filter((event) => event.ev.k === 'result' && !event.agentId).length >= 2
  && manager.getSession(session.id)?.status === 'idle',
)
// The new driver's transcript reader re-reads everything; give it time.
await Bun.sleep(1500)

const startAfter = events().find((event) => event.id === startBefore.id)!
check('the old subagent card keeps its time', startAfter.at === startBefore.at, { before: startBefore.at, after: startAfter.at })
check('and its turn', startAfter.turnId === first.turnId, startAfter.turnId)
const resultAfter = events().find((event) => event.id === resultBefore.id)!
check(
  'the first turn\'s result is not overwritten by the second\'s',
  JSON.stringify(resultAfter.ev) === JSON.stringify(resultBefore.ev) && resultAfter.turnId === first.turnId,
  { before: resultBefore, after: resultAfter },
)
check(
  'the second turn has a result of its own',
  events().some((event) => event.ev.k === 'result' && event.turnId === second.turnId),
)
// The new driver re-read the whole transcript, prompts included: each prompt
// is still exactly one bubble, and nothing it read lost its turn.
const bubbles = (text: string): number => events().filter((event) => event.ev.k === 'user' && event.ev.text === text).length
check('a re-read transcript does not duplicate an earlier prompt', bubbles('spawn an agent') === 1, bubbles('spawn an agent'))
check('nor the prompt that respawned it', bubbles('just answer') === 1, bubbles('just answer'))
const secondActors = db.listActors(session.id, second.turnId!).filter((actor) => actor.ownership === 'provider')
check('no old agent is registered again under the new turn', secondActors.length === 0, secondActors)
check('the new turn completes', db.getTurn(second.turnId!)?.state === 'completed', db.getTurn(second.turnId!))

/* 3 · A stop ends the agents that died with the process */

const third = await manager.sendMessage(session.id, 'spawn a slow agent')
await waitFor('the slow agent to start', () =>
  events().some((event) => event.ev.k === 'subagent_start' && event.turnId === third.turnId),
)
manager.stopSession(session.id)
const cut = events().find((event) => event.ev.k === 'subagent_end' && event.turnId === third.turnId)
check('a stop writes a stopped end for the agent it cut off', cut?.ev.k === 'subagent_end' && cut.ev.status === 'stopped', cut)
// Timed at the agent's last own activity, not at the moment the stop was
// noticed: a restart days later used to stamp "now" on it, and the card and its
// turn read as having worked for days.
{
  const start = events().find((event) => event.ev.k === 'subagent_start' && event.turnId === third.turnId)
  const agentId = cut?.ev.k === 'subagent_end' ? cut.ev.agentId : ''
  const lastOwn = events()
    .filter((event) => event.agentId === agentId && event.ev.k !== 'subagent_end' && event.at > 0)
    .reduce((latest, event) => Math.max(latest, event.at), start?.at ?? 0)
  check(
    'the stopped end is timed at the agent\'s last activity, and its duration runs only to there',
    Boolean(cut && start) && cut!.at === lastOwn && cut!.ev.k === 'subagent_end' && cut!.ev.durationMs === lastOwn - start!.at,
    { cutAt: cut?.at, lastOwn, start: start?.at, duration: cut?.ev.k === 'subagent_end' ? cut.ev.durationMs : null },
  )
}
check(
  'and closes its actor row',
  db.listActors(session.id, third.turnId!).every((actor) => actor.status !== 'starting' && actor.status !== 'running'),
  db.listActors(session.id, third.turnId!),
)

/* 3b · A prompt sent mid-turn goes to the CLI at once and opens its own turn */

const busy = await manager.sendMessage(session.id, 'slow work please')
await waitFor('the slow turn to be running', () => manager.getSession(session.id)?.status === 'running')
const midTurn = await manager.sendMessage(session.id, 'and one more thing')
check('a mid-turn prompt is sent, not queued', midTurn.ok && !midTurn.queued, midTurn)
check('nothing waits in the queue', (manager.getSession(session.id)?.queuedPrompts ?? 0) === 0)
await waitFor('both prompts to be answered', () =>
  events().filter((event) => event.ev.k === 'result' && !event.agentId && event.turnId === midTurn.turnId).length >= 1
  && manager.getSession(session.id)?.status === 'idle',
)
const views = new Map(manager.turnViews(session.id).map((turn) => [turn.id, turn]))
check('the interrupted turn ends as continued', views.get(busy.turnId!)?.phase === 'completed' && views.get(busy.turnId!)?.subtype === 'continued', views.get(busy.turnId!))
check('the mid-turn prompt\'s turn completes with a reply', views.get(midTurn.turnId!)?.phase === 'completed' && Boolean(views.get(midTurn.turnId!)?.replyEventId), views.get(midTurn.turnId!))

/* 3c · A name the user gives the session survives respawns, restarts and re-reads */

manager.renameSession(session.id, 'My own name')
check('a rename takes effect', manager.getSession(session.id)?.title === 'My own name' && manager.getSession(session.id)?.titleSource === 'user')
// A respawn: the new driver re-reads the whole transcript, first prompt and the
// harness' own \`summary\` record included — both used to become the title.
manager.setSessionOptions(session.id, { model: 'sonnet' })
const summarized = await manager.sendMessage(session.id, 'write a summary')
await waitFor('the summary turn to finish', () =>
  events().some((event) => event.ev.k === 'result' && !event.agentId && event.turnId === summarized.turnId)
  && manager.getSession(session.id)?.status === 'idle',
)
await Bun.sleep(1500)
const titleRow = () => db.getSessionRow(session.id)
check('a respawn and a transcript re-read keep the name', manager.getSession(session.id)?.title === 'My own name', manager.getSession(session.id)?.title)
check('and so does the stored row', titleRow()?.title === 'My own name' && titleRow()?.title_source === 'user', titleRow())
// A restart, then a prompt that respawns the process on the restored entry.
manager.stopSession(session.id)
manager.restore()
check('a restart keeps the name', manager.getSession(session.id)?.title === 'My own name', manager.getSession(session.id)?.title)
const afterRestart = await manager.sendMessage(session.id, 'just answer again')
await waitFor('the turn after the restart to finish', () =>
  events().some((event) => event.ev.k === 'result' && !event.agentId && event.turnId === afterRestart.turnId)
  && manager.getSession(session.id)?.status === 'idle',
)
await Bun.sleep(1500)
check('a re-read after the restart keeps the name', manager.getSession(session.id)?.title === 'My own name', manager.getSession(session.id)?.title)
manager.stopSession(session.id)

// The damage an earlier build did: the rename is in the ledger, the row lost it.
{
  const cid = crypto.randomUUID()
  const msg = { t: 'rename_session', sessionId: session.id, title: 'Lost and found', cid }
  db.claimCommand(cid, 'rename_session', JSON.stringify(msg), session.id)
  db.completeCommand(cid, { t: 'ack', cid, ok: true, sessionId: session.id })
  const raw = new (await import('bun:sqlite')).Database(join(process.env.SEDANO_HOME!, 'sedano.db'))
  raw.query("UPDATE sessions SET title = 'spawn an agent', title_source = 'auto' WHERE id = ?").run(session.id)
  raw.close()
  manager.restore()
  check('a boot restores a rename the row lost, from the ledger', manager.getSession(session.id)?.title === 'Lost and found' && titleRow()?.title === 'Lost and found' && titleRow()?.title_source === 'user', titleRow())
  manager.renameSession(session.id, 'Renamed after the repair')
  manager.restore()
  check('the repair runs once: a later rename is not undone by it', manager.getSession(session.id)?.title === 'Renamed after the repair', manager.getSession(session.id)?.title)
}

/* 4 · A boot repairs history damaged by an earlier build */

// Reproduce the old damage by hand: a re-stamped card, an overwritten result
// filed under the old turn, and a duplicate `starting` actor in the new turn.
const damagedAt = Date.now() + 3_600_000
const raw = (await import('bun:sqlite')).Database
const store = new raw(join(process.env.SEDANO_HOME!, 'sedano.db'))
store.query('UPDATE events SET at = ? WHERE session_id = ? AND id = ?').run(damagedAt, session.id, startAfter.id)
const secondResult = events().find((event) => event.ev.k === 'result' && event.turnId === second.turnId)!
store.query('UPDATE events SET turn_id = ? WHERE session_id = ? AND id = ?').run(first.turnId!, session.id, secondResult.id)
const agent = db.listActors(session.id, first.turnId!).find((actor) => actor.ownership === 'provider')!
store.query(
  `INSERT INTO actors (session_id, id, turn_id, parent_actor_id, spawn_event_id, ownership, provider, title, description, model, status, created_at, updated_at)
   VALUES (?, ?, ?, NULL, ?, 'provider', 'claude', '', '', NULL, 'starting', ?, ?)`,
).run(session.id, agent.id, second.turnId!, agent.spawnEventId, Date.now(), Date.now())
store.close()

manager.restore()
const repairedStart = db.getEvent(session.id, startAfter.id)!
check('a boot puts a re-stamped card back at its spawn call', repairedStart.at < damagedAt && Math.abs(repairedStart.at - startBefore.at) < 60_000, repairedStart.at)
check('a boot re-files a result under the turn it came in', db.getEvent(session.id, secondResult.id)?.turnId === second.turnId, db.getEvent(session.id, secondResult.id)?.turnId)
check(
  'a boot closes a duplicate actor of an old agent',
  db.listActors(session.id, second.turnId!).every((actor) => actor.status !== 'starting' && actor.status !== 'running'),
  db.listActors(session.id, second.turnId!),
)
check(
  'after a boot every prompt is still one bubble',
  ['spawn an agent', 'just answer', 'slow work please', 'and one more thing'].every((text) => bubbles(text) === 1),
  ['spawn an agent', 'just answer', 'slow work please', 'and one more thing'].map(bubbles),
)
const before = JSON.stringify(db.loadEvents(session.id).map((event) => [event.id, event.at, event.turnId]))
manager.restore()
check('the repair is idempotent', JSON.stringify(db.loadEvents(session.id).map((event) => [event.id, event.at, event.turnId])) === before)

manager.removeSession(session.id)
await Bun.sleep(300)

for (const label of passed) console.log(`   ✓ ${label}`)
if (failures.length) {
  for (const label of failures) console.error(`   ✗ ${label}`)
  console.error(`resume-history-test: FAILED (${failures.length}/${passed.length + failures.length})`)
  process.exit(1)
}
console.log(`resume-history-test: PASSED (${passed.length} checks)`)
process.exit(0)

/**
 * The fake CLI: one prompt per stdin line, a stream on stdout, and the
 * transcript plus subagent sidecar Claude Code writes on disk.
 */
function FAKE_CLI(): string {
  return `
import { appendFileSync, mkdirSync, readSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const argv = process.argv.slice(2)
const flag = (name) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined }
const uuid = flag('--session-id') ?? flag('--resume')
const root = process.env.CLAUDE_CONFIG_DIR
// The logical path the session was opened with (macOS resolves /var to /private/var in cwd()).
const project = join(root, 'projects', (process.env.PWD || process.cwd()).replace(/[^a-zA-Z0-9]/g, '-'))
const transcript = join(project, uuid + '.jsonl')
const subagents = join(project, uuid, 'subagents')
mkdirSync(subagents, { recursive: true })
let counter = 0
const record = (rec) => appendFileSync(transcript, JSON.stringify({ uuid: 'r' + Date.now() + '-' + (++counter), timestamp: new Date().toISOString(), sessionId: uuid, ...rec }) + '\\n')
const emit = (rec) => process.stdout.write(JSON.stringify(rec) + '\\n')
const result = () => emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', duration_ms: 5, usage: { input_tokens: 1, output_tokens: 1 } })
emit({ type: 'system', subtype: 'init', model: 'claude-sonnet-4-5-20250929' })
let buffer = ''
const chunk = Buffer.alloc(65536)
for (;;) {
  let read = 0
  try { read = readSync(0, chunk, 0, chunk.length, null) } catch { break }
  if (!read) break
  buffer += chunk.subarray(0, read).toString('utf8')
  let index
  while ((index = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    const rec = JSON.parse(line)
    if (rec.type !== 'user') continue
    const text = rec.message.content.map((block) => block.text ?? '').join(' ')
    record({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
    if (text.includes('agent')) {
      const n = Date.now().toString(36)
      const tool = 'toolu_' + n
      const agent = 'a' + n
      record({ type: 'assistant', message: { id: 'm' + n, role: 'assistant', model: 'claude-sonnet-4-5-20250929', content: [{ type: 'tool_use', id: tool, name: 'Agent', input: { subagent_type: 'general-purpose', description: 'look around', prompt: 'look around' } }] } })
      writeFileSync(join(subagents, 'agent-' + agent + '.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'look around', toolUseId: tool, spawnDepth: 1 }))
      writeFileSync(join(subagents, 'agent-' + agent + '.jsonl'), '')
      emit({ type: 'system', subtype: 'task_started', task_id: agent, tool_use_id: tool, task_type: 'local_agent', subagent_type: 'general-purpose', description: 'look around', prompt: 'look around' })
      if (text.includes('slow')) continue
      Bun.sleepSync(300)
      record({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool, content: [{ type: 'text', text: 'found it' }] }] }, toolUseResult: { agentId: agent, status: 'completed', totalToolUseCount: 2, totalDurationMs: 300, content: [{ type: 'text', text: 'found it' }] } })
    }
    if (text.includes('summary')) record({ type: 'summary', summary: 'A summary the harness wrote' })
    if (text.includes('slow work')) Bun.sleepSync(1500)
    record({ type: 'assistant', message: { id: 'm' + Date.now(), role: 'assistant', model: 'claude-sonnet-4-5-20250929', content: [{ type: 'text', text: 'done' }] } })
    Bun.sleepSync(400)
    result()
  }
}
`
}
