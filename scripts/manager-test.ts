#!/usr/bin/env bun
/**
 * The manager's interrupt deadline.
 *
 * Stopping a turn cannot depend on the harness answering: Claude Code only
 * resets its status on a later `result`, an ACP agent on the cancelled prompt
 * settling, and a CLI can hold its stdout open from a child it left behind. The
 * manager is the only place that can finish a stop every one of them might never
 * answer, and an unanswerable stop is what left a session on "Working…" with
 * neither Esc nor the stop button able to do anything.
 *
 * Runs against a temporary SEDANO_HOME and a temporary PATH, with the fake `cmd`
 * from `scripts/fixtures/`: no quota is spent and nothing the running app holds
 * is touched.
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installExitHandlers, onCleanup, runCleanups, tempHome } from './lib/harness.ts'

// Registered before anything is created: a failed assertion, a timeout or a ⌃C
// must still take the scratch directories and the fake CLI with it.
installExitHandlers()

const failures: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) return
  failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

// Before anything else imports them: the manager reads both when it loads.
const { home, env } = tempHome('manager-home')
const binDir = mkdtempSync(join(tmpdir(), 'sedano-manager-bin-'))
onCleanup(() => rmSync(binDir, { recursive: true, force: true }))
const bin = join(binDir, 'cmd')
writeFileSync(bin, readFileSync(join(import.meta.dir, 'fixtures', 'fake-cmd.ts')))
chmodSync(bin, 0o755)
for (const [key, value] of Object.entries(env)) process.env[key] = value
process.env.PATH = `${binDir}:${process.env.PATH}`

const { addClient } = await import('../apps/server/src/bus.ts')
const manager = await import('../apps/server/src/manager.ts')

function waitFor(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (predicate()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`))
      setTimeout(tick, 40)
    }
    tick()
  })
}

/** Everything the manager broadcasts about a session's status. */
const statuses: string[] = []
addClient({
  id: 'manager-test',
  subscribed: new Set(),
  send: (msg) => {
    if (msg.t === 'session') statuses.push(msg.session.status)
  },
})

manager.restore()

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/* ---------------------- a turn whose CLI will not die --------------------- */

const stuck = await manager.createSession({ harness: 'commandcode', kind: 'agent', cwd: binDir })
manager.sendMessage(stuck.id, 'hang')
await waitFor(() => manager.getSession(stuck.id)?.status === 'running', 'the stuck turn to start')
const askedAt = Date.now()
check('interrupting a session that exists is accepted', manager.interruptSession(stuck.id))
await waitFor(() => manager.getSession(stuck.id)?.status !== 'running', 'the stuck turn to end')
const elapsed = Date.now() - askedAt
check('a CLI that refuses to die still ends its turn', elapsed < 8000, `${elapsed}ms`)
check('the stopped turn is broadcast, not just held', statuses.includes('stopped') || statuses.includes('idle'), statuses)
check('the stopped turn is not left running in the store', manager.getSession(stuck.id)?.status !== 'running', manager.getSession(stuck.id)?.status)

/* ------------------- a turn nothing else will ever end -------------------- */

const wedged = await manager.createSession({ harness: 'commandcode', kind: 'agent', cwd: binDir })
// A live driver with no turn in flight is the state every harness can reach and
// none of them can leave: the process is gone or deaf, so nothing will ever
// report a status again. Set directly, because the driver above can no longer
// produce it — that is what the rest of this file proves.
const wedgedSummary = manager.getSession(wedged.id)!
wedgedSummary.status = 'running'
const wedgedAt = Date.now()
check('interrupting a session nothing is running is accepted', manager.interruptSession(wedged.id))
await waitFor(() => manager.getSession(wedged.id)?.status !== 'running', 'the deadline to end the wedged turn')
const waited = Date.now() - wedgedAt
check('the deadline, and not the harness, ends a turn nothing answers', waited >= 3000, `${waited}ms`)
check('the wedged turn is stopped rather than left running', manager.getSession(wedged.id)?.status === 'stopped', manager.getSession(wedged.id)?.status)

/* -------------------- a session whose process is already gone ------------- */

const orphan = await manager.createSession({ harness: 'commandcode', kind: 'agent', cwd: binDir })
manager.stopSession(orphan.id)
const orphanSummary = manager.getSession(orphan.id)!
orphanSummary.status = 'running'
check('a session with no living process is stopped instead of ignored', manager.interruptSession(orphan.id))
check('the stop happens at once when there is nothing to ask', manager.getSession(orphan.id)?.status === 'stopped', manager.getSession(orphan.id)?.status)

await sleep(50)

// The checks are done: the sessions are stopped and the scratch directories are
// ours to remove, so nothing here should outlive the run.
for (const session of manager.listSessions()) manager.removeSession(session.id)
await runCleanups()
void home

if (failures.length) {
  console.error('--- failed checks ---')
  for (const failure of failures) console.error(`✗ ${failure}`)
  console.error('manager-test: FAILED')
  process.exit(1)
}
console.log('manager-test: PASSED')
process.exit(0)
