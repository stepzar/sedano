#!/usr/bin/env bun
/**
 * Session lifecycle: prompts that are never lost, stops that really stop, and a
 * deleted session that stays deleted.
 *
 * Everything here is hermetic. A temporary `SEDANO_HOME` holds the database, a
 * temporary PATH holds two fake harnesses built from the fixtures in
 * `scripts/fixtures/` (the Command Code NDJSON stand-in and the ACP agent), and
 * no vendor CLI, no subscription and no ssh host is involved. The real store in
 * `~/.sedano` is never opened.
 *
 * The failures it pins down, each of which happened:
 *   - a prompt sent while the harness was busy vanished, and the client was told
 *     it had been sent;
 *   - a spawn that failed reported success, so the prompt was gone with nothing
 *     on screen to say so;
 *   - a stop or a delete during a slow handshake left the process running, and
 *     the finished spawn wrote the deleted session back into the database;
 *   - a killed agent reported its own death, turning a `stopped` session into an
 *     `error` one, and a driver that kept talking after a failed turn turned an
 *     `error` back into `idle`.
 *
 *   bun scripts/lifecycle-test.ts
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const failures: string[] = []
const passed: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) passed.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

/* ------------------------------------------------------------------ */
/* A machine of our own: temp home, temp PATH, fake harnesses          */
/* ------------------------------------------------------------------ */

/**
 * The fake harnesses have to be on the PATH this process was *started* with:
 * `Bun.which` answers from the environment the process was launched in, not from
 * later edits to `process.env`, and a harness looked up through the real PATH
 * would be the user's real CLI — real quota, real account. So the first run only
 * builds the sandbox and starts the test again inside it.
 */
if (!process.env.SEDANO_LIFECYCLE_SANDBOX) {
  const home = mkdtempSync(join(tmpdir(), 'sedano-lifecycle-home-'))
  const work = mkdtempSync(join(tmpdir(), 'sedano-lifecycle-work-'))
  const bin = join(work, 'bin')
  mkdirSync(bin)
  const bun = process.execPath
  const fakeCmd = join(import.meta.dir, 'fixtures', 'fake-cmd.ts')
  const fakeAcp = join(import.meta.dir, 'fixtures', 'fake-acp-agent.ts')
  const install = (path: string, body: string): void => {
    writeFileSync(path, body)
    chmodSync(path, 0o755)
  }

  /**
   * `cmd`, the Command Code stand-in: the fixture, with three prompts
   * intercepted so a test can ask for a turn that takes time or a turn that
   * fails. The fixture is the protocol, this is only the timing.
   */
  install(
    join(bin, 'cmd'),
    `#!/bin/sh
input=$(cat)
case "$input" in
  slowboom*) /bin/sleep 0.8; echo 'the fake CLI refused the turn' >&2; exit 2 ;;
  boom*) echo 'the fake CLI refused the turn' >&2; exit 2 ;;
  slow*) /bin/sleep 1.0 ;;
  errframe*)
    # A turn the CLI reports as failed in its own protocol, on a process that
    # then exits cleanly — which is how a harness says "error" and then, from the
    # exit, "idle" a moment later.
    printf '%s\\n' '{"type":"event","event":{"type":"run_start","sessionId":"fake-session-err"}}'
    printf '%s\\n' '{"type":"result","subtype":"error","sessionId":"fake-session-err","error":"the model refused the turn","durationMs":3}'
    exit 0 ;;
esac
printf '%s\\n' "$input" | exec ${bun} ${fakeCmd} "$@"
`,
  )

  /**
   * `opencode`, the ACP agent. It answers at once unless the test has asked for
   * a slow handshake by dropping the flag file, in which case it writes its pid
   * down first — so a stop or a delete during the handshake can be checked
   * against the process itself instead of being taken on trust.
   */
  install(
    join(bin, 'opencode'),
    `#!/bin/sh
if [ -f ${join(work, 'slow-handshake')} ]; then
  echo $$ > ${join(work, 'acp.pid')}
  /bin/sleep 1.5
fi
exec ${bun} ${fakeAcp} "$@"
`,
  )

  const child = Bun.spawn([process.execPath, import.meta.path], {
    // Only our own binaries and the base system tools: a real `gemini`,
    // `claude` or `cmd` installed on this machine is not reachable from here.
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      SEDANO_HOME: home,
      SEDANO_LIFECYCLE_SANDBOX: work,
    },
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  const code = await child.exited
  rmSync(home, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
  process.exit(code)
}

const work = process.env.SEDANO_LIFECYCLE_SANDBOX
const slowFlag = join(work, 'slow-handshake')
const acpPidFile = join(work, 'acp.pid')

const { addClient } = await import('../apps/server/src/bus.ts')
const manager = await import('../apps/server/src/manager.ts')
const db = await import('../apps/server/src/db.ts')

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function waitFor(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (predicate()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`))
      setTimeout(tick, 30)
    }
    tick()
  })
}

/** Every status the manager broadcast, per session. */
const statuses = new Map<string, string[]>()
addClient({
  id: 'lifecycle-test',
  subscribed: new Set(),
  send: (msg) => {
    if (msg.t !== 'session') return
    const list = statuses.get(msg.session.id) ?? []
    list.push(msg.session.status)
    statuses.set(msg.session.id, list)
  },
})

const statusesOf = (id: string): string[] => statuses.get(id) ?? []
const texts = (id: string, kind: string): string[] =>
  db
    .loadEvents(id)
    .filter((event) => event.ev.k === kind)
    .map((event) => ('text' in event.ev ? event.ev.text : ''))
const userTexts = (id: string): string[] => texts(id, 'user')
const userDelivery = (id: string, text: string): string | undefined => {
  const event = db.loadEvents(id).find((item) => item.ev.k === 'user' && item.ev.text === text)
  return event?.ev.k === 'user' ? event.ev.delivery : undefined
}
const cancelledBy = (id: string, text: string): string | undefined => {
  const event = db.loadEvents(id).find((item) => item.ev.k === 'user' && item.ev.text === text)
  return event?.ev.k === 'user' ? event.ev.cancelledBy : undefined
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

manager.restore()

/* ------------------------------------------------------------------ */
/* A prompt sent while the harness is busy waits, and is told so       */
/* ------------------------------------------------------------------ */

{
  const session = await manager.createSession({ harness: 'commandcode', kind: 'agent', cwd: work })
  const first = await manager.sendMessage(session.id, 'slow first prompt')
  check('the first prompt is sent, not queued', first.ok && !first.queued, first)
  await waitFor(() => manager.getSession(session.id)?.status === 'running', 'the slow turn to start')

  const second = await manager.sendMessage(session.id, 'second prompt')
  check('a prompt sent mid-turn is accepted', second.ok, second)
  check('a prompt sent mid-turn is reported as queued, not as sent', second.ok && second.queued, second)
  check('the queue is visible on the session', manager.getSession(session.id)?.queuedPrompts === 1, manager.getSession(session.id)?.queuedPrompts)
  check('a queued prompt is on disk, not only in memory', db.loadPromptQueue(session.id).length === 1, db.loadPromptQueue(session.id))
  check('a queued prompt is visible immediately', userTexts(session.id).includes('second prompt'), userTexts(session.id))
  check('the visible prompt still says it is queued', userDelivery(session.id, 'second prompt') === 'queued', userDelivery(session.id, 'second prompt'))

  await waitFor(() => userDelivery(session.id, 'second prompt') === 'delivered', 'the queued prompt to run')
  check('the queued prompt runs at the start of the next turn', userTexts(session.id)[0] === 'slow first prompt', userTexts(session.id))
  await waitFor(() => manager.getSession(session.id)?.queuedPrompts === 0, 'the queue to empty')
  check('the drained queue leaves nothing on disk', db.loadPromptQueue(session.id).length === 0)
  await waitFor(() => manager.getSession(session.id)?.status === 'idle', 'the second turn to end')
  // The queued turn's clock: it starts when the queue released it, after the
  // slow turn, never at the moment it was typed.
  const views = new Map(manager.turnViews(session.id).map((turn) => [turn.id, turn]))
  const typed = second.ok && second.promptId ? db.getEvent(session.id, `prompt:${second.promptId}`)?.at ?? 0 : 0
  const ran = second.ok && second.turnId ? views.get(second.turnId)?.startedAt ?? 0 : 0
  const firstEnded = first.ok && first.turnId ? views.get(first.turnId)?.endedAt ?? 0 : 0
  check('a queued turn starts after the turn it waited for', firstEnded > 0 && ran >= firstEnded, { ran, firstEnded })
  check('a queued turn does not start when it was typed', typed > 0 && ran - typed >= 500, { typed, ran })
  manager.removeSession(session.id)
}

/* A queued prompt can be cancelled without affecting the running turn. */
{
  const session = await manager.createSession({ harness: 'commandcode', kind: 'agent', cwd: work })
  await manager.sendMessage(session.id, 'slow cancellable turn')
  await waitFor(() => manager.getSession(session.id)?.status === 'running', 'the cancellable turn to start')
  const queued = await manager.sendMessage(session.id, 'cancel this queued prompt')
  check('the cancellable prompt entered the queue', queued.ok && queued.queued && Boolean(queued.promptId), queued)
  const cancelled = queued.ok && queued.promptId ? manager.cancelPrompt(session.id, queued.promptId) : null
  check('cancelling a queued prompt is accepted', cancelled?.ok === true, cancelled)
  check('a cancelled prompt leaves the durable queue', db.loadPromptQueue(session.id).length === 0, db.loadPromptQueue(session.id))
  check('the prompt remains visible as cancelled', userDelivery(session.id, 'cancel this queued prompt') === 'cancelled', userDelivery(session.id, 'cancel this queued prompt'))
  check('and says the user cancelled it', cancelledBy(session.id, 'cancel this queued prompt') === 'user', cancelledBy(session.id, 'cancel this queued prompt'))
  await waitFor(() => manager.getSession(session.id)?.status === 'idle', 'the cancellable turn to finish')
  manager.removeSession(session.id)
}

/* ------------------------------------------------------------------ */
/* A spawn that fails is a failure, never a silent success             */
/* ------------------------------------------------------------------ */

{
  // `gemini` is wired but its binary does not exist on this PATH, so the spawn
  // fails the way a missing or broken CLI does.
  const session = await manager.createSession({ harness: 'gemini', kind: 'agent', cwd: work })
  const result = await manager.sendMessage(session.id, 'this can never be delivered')
  check('a prompt whose spawn failed is not reported as sent', !result.ok, result)
  check('the failure says it failed', !result.ok && result.code === 'failed', result)
  check('the failure is on the timeline too', texts(session.id, 'error').some((text) => text.includes('could not start')), texts(session.id, 'error'))
  check(
    'an accepted prompt stays visible even when the harness cannot start',
    userTexts(session.id).includes('this can never be delivered'),
    userTexts(session.id),
  )
  check('the session says it is in error', manager.getSession(session.id)?.status === 'error', manager.getSession(session.id)?.status)
  manager.removeSession(session.id)
}

/* ------------------------------------------------------------------ */
/* Stop during a slow handshake: no orphan, no resurrection            */
/* ------------------------------------------------------------------ */

writeFileSync(slowFlag, 'the next agents take their time starting\n')

{
  rmSync(acpPidFile, { force: true })
  const id = crypto.randomUUID()
  const starting = manager.createSession({ id, harness: 'opencode', kind: 'agent', cwd: work })
  await waitFor(() => existsSync(acpPidFile), 'the slow agent to start')
  const pid = Number(readFileSync(acpPidFile, 'utf8').trim())
  check('the slow agent really started', alive(pid), pid)

  check('stopping a starting session is accepted', manager.stopSession(id))
  await starting
  await waitFor(() => !alive(pid), 'the orphan to be killed', 8000).catch(() => undefined)
  check('a stop during the handshake leaves no process behind', !alive(pid), pid)
  check('a stop during the handshake ends stopped', manager.getSession(id)?.status === 'stopped', manager.getSession(id)?.status)
  check('the driver that finished starting is not kept', statusesOf(id).at(-1) === 'stopped', statusesOf(id))
  manager.removeSession(id)
}

{
  rmSync(acpPidFile, { force: true })
  const id = crypto.randomUUID()
  const starting = manager.createSession({ id, harness: 'opencode', kind: 'agent', cwd: work })
  await waitFor(() => existsSync(acpPidFile), 'the slow agent to start')
  const pid = Number(readFileSync(acpPidFile, 'utf8').trim())

  check('deleting a starting session is accepted', manager.removeSession(id))
  check('a deleted session is gone from the database at once', db.getSessionRow(id) === null)
  await starting
  // Long enough for the handshake to complete and for anything it would have
  // published to have been published.
  await sleep(2000)
  check('a delete during the handshake leaves no process behind', !alive(pid), pid)
  check('a deleted session is not resurrected by its own spawn', db.getSessionRow(id) === null, db.getSessionRow(id))
  check('a deleted session is not back in the store', manager.getSession(id) === null)
}

rmSync(slowFlag, { force: true })

/* ------------------------------------------------------------------ */
/* A forced ACP stop ends stopped, not error                           */
/* ------------------------------------------------------------------ */

{
  const session = await manager.createSession({ harness: 'opencode', kind: 'agent', cwd: work })
  // The fake agent stays busy on "cancel" until it is told to stop, which is the
  // turn a forced stop has to end.
  await manager.sendMessage(session.id, 'cancel please')
  await waitFor(() => manager.getSession(session.id)?.status === 'running', 'the ACP turn to start')
  manager.stopSession(session.id)
  const after = statusesOf(session.id).length
  // The agent is killed mid-prompt and answers with a failed turn: that answer
  // belongs to the process the user just replaced.
  await sleep(800)
  check('a forced ACP stop ends stopped', manager.getSession(session.id)?.status === 'stopped', manager.getSession(session.id)?.status)
  check(
    'the killed agent cannot turn the stop into an error',
    !statusesOf(session.id).slice(after - 1).includes('error'),
    statusesOf(session.id).slice(after - 1),
  )
  manager.removeSession(session.id)
}

/* ------------------------------------------------------------------ */
/* A failed turn stays failed, and the prompt queued behind it still runs */
/* ------------------------------------------------------------------ */

{
  // The native CLIs run the next message after an error, and so does this: the
  // failure stays on record in its own turn, and what the user queued behind it
  // is delivered rather than silently dropped (see the status hook).
  const session = await manager.createSession({ harness: 'commandcode', kind: 'agent', cwd: work })
  const failing = await manager.sendMessage(session.id, 'slowboom please')
  await waitFor(() => manager.getSession(session.id)?.status === 'running', 'the failing turn to start')
  const queued = await manager.sendMessage(session.id, 'queued behind a failure')
  check('a prompt behind a failing turn is queued', queued.ok && queued.queued, queued)

  await waitFor(() => userDelivery(session.id, 'queued behind a failure') === 'delivered', 'the queued prompt to be delivered after the failure')
  await waitFor(() => manager.getSession(session.id)?.status === 'idle', 'the queued prompt to finish')
  const turns = new Map(manager.turnViews(session.id).map((turn) => [turn.id, turn]))
  check('the failed turn stays failed', turns.get(failing.turnId!)?.phase === 'failed', turns.get(failing.turnId!))
  check('the queued prompt runs in its own turn', turns.get(queued.turnId!)?.phase === 'completed', turns.get(queued.turnId!))
  check('nothing was dropped', !texts(session.id, 'system').some((text) => text.includes('not sent')), texts(session.id, 'system'))
  check('the queue is empty', manager.getSession(session.id)?.queuedPrompts === 0, manager.getSession(session.id)?.queuedPrompts)
  manager.removeSession(session.id)
}

{
  // The other shape of the same defect: the CLI reports a failed turn in its
  // protocol and then exits 0, so the driver says `error` and, from the clean
  // exit, `idle` right after. The session looked ready when nothing had recovered.
  const session = await manager.createSession({ harness: 'commandcode', kind: 'agent', cwd: work })
  await manager.sendMessage(session.id, 'errframe please')
  await waitFor(() => manager.getSession(session.id)?.status === 'error', 'the failed turn to be reported')
  const after = statusesOf(session.id).length
  await sleep(700)
  check(
    'a clean exit after a failed turn does not turn error back into idle',
    manager.getSession(session.id)?.status === 'error',
    statusesOf(session.id).slice(after - 1),
  )
  check(
    'no later status is published for a turn that already ended in error',
    statusesOf(session.id).slice(after).every((status) => status === 'error'),
    statusesOf(session.id).slice(after),
  )
  manager.removeSession(session.id)
}

/* ------------------------------------------------------------------ */
/* A stop never runs what was queued behind it                         */
/* ------------------------------------------------------------------ */

{
  const session = await manager.createSession({ harness: 'commandcode', kind: 'agent', cwd: work })
  await manager.sendMessage(session.id, 'slow turn to be stopped')
  await waitFor(() => manager.getSession(session.id)?.status === 'running', 'the turn to start')
  const queued = await manager.sendMessage(session.id, 'must never run')
  check('the prompt behind the stopped turn was queued', queued.ok && queued.queued, queued)

  manager.stopSession(session.id)
  check('a stop empties the queue at once', manager.getSession(session.id)?.queuedPrompts === 0, manager.getSession(session.id)?.queuedPrompts)
  check('a stop empties the queue on disk too', db.loadPromptQueue(session.id).length === 0)
  // Long enough for the stopped turn to have ended and for a drain to have run.
  await sleep(1500)
  check('a stop does not run a queued prompt afterwards', userDelivery(session.id, 'must never run') === 'cancelled', userDelivery(session.id, 'must never run'))
  check('and the prompt says the server cancelled it, and why', cancelledBy(session.id, 'must never run') === 'server', cancelledBy(session.id, 'must never run'))
  check('a stopped session stays stopped', manager.getSession(session.id)?.status === 'stopped', manager.getSession(session.id)?.status)
  manager.removeSession(session.id)
}

/* ------------------------------------------------------------------ */
/* The queue survives a restart of the manager                         */
/* ------------------------------------------------------------------ */

{
  const session = await manager.createSession({ harness: 'commandcode', kind: 'agent', cwd: work })
  await manager.sendMessage(session.id, 'slow turn across a restart')
  await waitFor(() => manager.getSession(session.id)?.status === 'running', 'the turn to start')
  await manager.sendMessage(session.id, 'waiting across the restart')
  check('the prompt is queued before the restart', db.loadPromptQueue(session.id).length === 1)

  // What a restart is, for the manager: the same database read again into fresh
  // entries. Nothing calls stop, exactly as nothing calls it when the process
  // dies, so this is the queue that a user would find waiting for them.
  manager.restore()
  const restored = manager.getSession(session.id)
  check('the session comes back after the restart', restored !== null)
  check('the queue comes back with it', restored?.queuedPrompts === 1, restored?.queuedPrompts)
  check('and it is still the prompt that was typed', db.loadPromptQueue(session.id)[0]?.text === 'waiting across the restart', db.loadPromptQueue(session.id))
  const waiting = db.loadEvents(session.id).find((event) => event.ev.k === 'user' && event.ev.text === 'waiting across the restart')
  check(
    'restart recovery does not close the future queued turn as interrupted',
    !db.loadEvents(session.id).some((event) => event.turnId === waiting?.turnId && event.ev.k === 'result'),
    db.loadEvents(session.id).filter((event) => event.turnId === waiting?.turnId).map((event) => event.ev.k),
  )
  manager.removeSession(session.id)
}

/* ------------------------------------------------------------------ */
/* An option is pending until something confirms it                    */

{
  const session = await manager.createSession({ harness: 'commandcode', kind: 'agent', cwd: work })
  const asked = manager.setSessionOptions(session.id, { model: 'a-model-nobody-has-run-yet' })
  check('a configuration change is accepted', asked.ok, asked)
  check('and is reported as pending, not as applied', asked.ok && asked.pending, asked)
  check(
    'the summary does not claim a model that has not run',
    manager.getSession(session.id)?.model !== 'a-model-nobody-has-run-yet',
    manager.getSession(session.id)?.model,
  )
  check(
    'the request is visible as pending',
    manager.getSession(session.id)?.pendingOptions?.model === 'a-model-nobody-has-run-yet',
    manager.getSession(session.id)?.pendingOptions,
  )

  await manager.sendMessage(session.id, 'a turn that applies the change')
  await waitFor(() => manager.getSession(session.id)?.status === 'idle', 'the configured turn to end')
  // The fixture echoes its own argv through a tool call, so this is the process
  // really having been started with what was asked for.
  const argv = db
    .loadEvents(session.id)
    .map((event) => (event.ev.k === 'tool' ? JSON.stringify(event.ev.input) : ''))
    .join(' ')
  check('the respawn applied the pending model', argv.includes('a-model-nobody-has-run-yet'), argv.slice(0, 200))
  check('nothing stays pending once it is running', manager.getSession(session.id)?.pendingOptions === undefined, manager.getSession(session.id)?.pendingOptions)
  check(
    'the model in the summary is the one the harness reported',
    manager.getSession(session.id)?.model === 'fake/model',
    manager.getSession(session.id)?.model,
  )

  await manager.sendMessage(session.id, 'slow turn while configuring')
  await waitFor(() => manager.getSession(session.id)?.status === 'running', 'the turn to start')
  const refused = manager.setSessionOptions(session.id, { effort: 'high' })
  check('a configuration change during a turn is refused', !refused.ok, refused)
  check('and says the session is busy', !refused.ok && refused.code === 'busy', refused)
  await waitFor(() => manager.getSession(session.id)?.status === 'idle', 'the turn to end')
  manager.removeSession(session.id)
}

/* ------------------------------------------------------------------ */
/* Asking for the same session twice is asking once                    */
/* ------------------------------------------------------------------ */

{
  const id = crypto.randomUUID()
  const before = manager.listSessions().length
  const first = await manager.createSession({ id, harness: 'commandcode', kind: 'agent', cwd: work })
  const second = await manager.createSession({ id, harness: 'commandcode', kind: 'agent', cwd: work })
  check('the proposed id is the id that was used', first.id === id && second.id === id, [first.id, second.id])
  check('the repeat is the same session, not a second one', manager.listSessions().length === before + 1, manager.listSessions().length - before)
  check('the repeat is the same summary', first === second)
  manager.removeSession(id)
}

/* ------------------------------------------------------------------ */

for (const session of manager.listSessions()) manager.removeSession(session.id)

if (failures.length) {
  console.log('--- failed checks ---')
  for (const failure of failures) console.log(`✗ ${failure}`)
  console.log(`\nlifecycle-test: ${failures.length} FAILURES (${passed.length} passed)`)
  process.exit(1)
}
console.log(`lifecycle-test: PASSED (${passed.length} checks)`)
process.exit(0)
