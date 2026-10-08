#!/usr/bin/env bun
/**
 * `check:dock` — the quick terminal belongs to the session it was opened from.
 *
 * It used to be created as a session of its own, remembered as "docked" only in
 * the localStorage of the window that opened it — so every other client (the
 * phone, a second window) listed it in the rail as a workspace of its own, and
 * deleting the agent could leave it behind. Now the server stores it as a child
 * (`parentSessionId`): it is restored with its parent, deleted with it, and an
 * orphan left by an older build is removed at boot.
 *
 * Hermetic: a temporary SEDANO_HOME and a PATH whose `tmux` and `ssh` are fakes.
 * No terminal is actually started (every session here is created deferred).
 *
 *   bun scripts/dock-terminal-test.ts
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionSummary } from '@shared'

if (!process.env.SEDANO_DOCK_SANDBOX) {
  const work = mkdtempSync(join(tmpdir(), 'sedano-dock-'))
  const bin = join(work, 'bin')
  mkdirSync(bin, { recursive: true })
  for (const name of ['tmux', 'ssh']) {
    writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n')
    chmodSync(join(bin, name), 0o755)
  }
  const child = Bun.spawn([process.execPath, import.meta.path], {
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      SEDANO_EXPLICIT_PATH: '1',
      SEDANO_BACKGROUND_SYNC: '0',
      SEDANO_HOME: join(work, 'home'),
      SEDANO_DOCK_SANDBOX: work,
    },
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  const code = await child.exited
  rmSync(work, { recursive: true, force: true })
  process.exit(code)
}

const failures: string[] = []
const passed: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) passed.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const manager = await import('../apps/server/src/manager.ts')
const db = await import('../apps/server/src/db.ts')

const work = process.env.SEDANO_DOCK_SANDBOX!
const cwd = join(work, 'workspace')
mkdirSync(cwd, { recursive: true })
const deferred = { deferStart: true }
const terminal = (parentSessionId: string | null, host: string | null = null) =>
  manager.createSession({ harness: 'shell', kind: 'terminal', cwd, host, preset: '', parentSessionId }, deferred)

/* 1 · A docked terminal is created as part of its agent, on any harness and host */

const harnesses = ['claude', 'codex', 'opencode', 'commandcode'] as const
const agents: SessionSummary[] = []
for (const harness of harnesses) agents.push(await manager.createSession({ harness, cwd } as never, deferred))
const remoteAgent = await manager.createSession({ harness: 'claude', cwd: '/srv/app', host: 'box' } as never, deferred)

const children: SessionSummary[] = []
for (const agent of agents) children.push(await terminal(agent.id))
const remoteChild = await manager.createSession(
  { harness: 'shell', kind: 'terminal', cwd: '/srv/app', host: 'box', preset: '', parentSessionId: remoteAgent.id },
  deferred,
)
check('a docked terminal names its agent', children.every((child, index) => child.parentSessionId === agents[index]!.id), children.map((c) => c.parentSessionId))
check('on a remote host too', remoteChild.parentSessionId === remoteAgent.id && remoteChild.host === 'box', remoteChild)
check('and that is what is stored', db.getSessionRow(children[0]!.id)?.parent_session_id === agents[0]!.id, db.getSessionRow(children[0]!.id))

const refused = async (label: string, run: () => Promise<unknown>) => {
  try {
    await run()
    check(label, false, 'accepted')
  } catch {
    check(label, true)
  }
}
await refused('an agent cannot be opened inside another session', () =>
  manager.createSession({ harness: 'claude', cwd, parentSessionId: agents[0]!.id } as never, deferred))
await refused('a terminal cannot belong to a session that does not exist', () => terminal(crypto.randomUUID()))
await refused('nor to another terminal', () => terminal(children[0]!.id))

/* 2 · A restart brings each child back with its parent */

manager.restore()
check(
  'after a restart every child still names its agent',
  children.every((child, index) => manager.getSession(child.id)?.parentSessionId === agents[index]!.id)
    && manager.getSession(remoteChild.id)?.parentSessionId === remoteAgent.id,
  children.map((child) => manager.getSession(child.id)?.parentSessionId),
)
check('an ordinary session has no parent', manager.getSession(agents[0]!.id)?.parentSessionId === null)

/* 3 · A terminal an older build docked is handed to its agent, once */

const legacy = await terminal(null)
check('a legacy docked terminal starts without a parent', legacy.parentSessionId === null)
check('it is adopted by its agent', manager.setSessionParent(legacy.id, agents[1]!.id).ok)
check('asking again is a no-op', manager.setSessionParent(legacy.id, agents[1]!.id).ok && manager.getSession(legacy.id)?.parentSessionId === agents[1]!.id)
check('an agent cannot be adopted', !manager.setSessionParent(agents[2]!.id, agents[1]!.id).ok)
check('the adoption is stored', db.getSessionRow(legacy.id)?.parent_session_id === agents[1]!.id)

/* 4 · Deleting the agent deletes its terminals */

manager.removeSession(agents[1]!.id)
check('the agent\'s terminals go with it', !manager.getSession(children[1]!.id) && !manager.getSession(legacy.id))
check('from the database too', !db.getSessionRow(children[1]!.id) && !db.getSessionRow(legacy.id))
check('another agent\'s terminal is untouched', manager.getSession(children[0]!.id)?.parentSessionId === agents[0]!.id)
manager.removeSession(remoteAgent.id)
check('a remote agent takes its remote terminal with it', !manager.getSession(remoteChild.id) && !db.getSessionRow(remoteChild.id))

/* 5 · A boot removes a child whose parent is already gone */

{
  const orphan = await terminal(agents[3]!.id)
  const raw = new (await import('bun:sqlite')).Database(join(process.env.SEDANO_HOME!, 'sedano.db'))
  raw.query('DELETE FROM sessions WHERE id = ?').run(agents[3]!.id)
  raw.close()
  manager.restore()
  check('a boot removes an orphaned docked terminal', !manager.getSession(orphan.id) && !db.getSessionRow(orphan.id))
  manager.restore()
  check('and the repair is idempotent', Boolean(manager.getSession(children[0]!.id)) && Boolean(manager.getSession(agents[0]!.id)))
}

for (const session of manager.listSessions()) manager.removeSession(session.id)
await Bun.sleep(200)

for (const label of passed) console.log(`   ✓ ${label}`)
if (failures.length) {
  for (const label of failures) console.error(`   ✗ ${label}`)
  console.error(`dock-terminal-test: FAILED (${failures.length}/${passed.length + failures.length})`)
  process.exit(1)
}
console.log(`dock-terminal-test: PASSED (${passed.length} checks)`)
process.exit(0)
