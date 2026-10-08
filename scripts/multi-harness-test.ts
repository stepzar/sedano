#!/usr/bin/env bun
/**
 * Two harnesses at once, and nothing of one showing up in the other.
 *
 * This is the app's whole promise: a Command Code session and an ACP session
 * side by side, each with its own conversation, its own model, its own token
 * count, its own folder and its own machine. Every one of those is global state
 * somewhere — the manager keeps one map of sessions, the drivers share a bus,
 * the metrics ticker walks everything — so "it worked with one session open" has
 * never been evidence of anything.
 *
 * What it pins down:
 *   - two turns really are in flight together, not queued behind one another;
 *   - each session keeps its own native id, model and workspace;
 *   - usage is counted per session, not into a shared total;
 *   - a remote session is spawned over ssh and a local one is not, in the same
 *     process at the same time;
 *   - configuring or stopping one session leaves the other alone.
 *
 * Hermetic: temporary `SEDANO_HOME`, a temporary PATH holding only the fakes
 * from `scripts/fixtures/` (Command Code CLI, ACP agent, ssh), and the fixture
 * ssh config. No vendor CLI, no subscription, no real host.
 *
 *   bun scripts/multi-harness-test.ts
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/* ------------------------------------------------------------------ */
/* A machine of our own                                                */
/* ------------------------------------------------------------------ */

/**
 * `Bun.which` answers from the environment this process was *launched* with, so
 * a PATH assigned here would still find the operator's real CLIs — real account,
 * real quota. The first pass builds the sandbox and starts the test inside it.
 *
 * `/tmp` rather than `TMPDIR`: the ssh control socket path is built from this
 * directory and unix socket paths are capped at ~104 bytes.
 */
if (!process.env.SEDANO_MULTI_SANDBOX) {
  const sandbox = mkdtempSync('/tmp/sedano-multi-')
  const bin = join(sandbox, 'bin')
  mkdirSync(bin, { recursive: true })
  const install = (name: string, body: string): void => {
    writeFileSync(join(bin, name), body)
    chmodSync(join(bin, name), 0o755)
  }
  const fixture = (file: string): string => join(import.meta.dir, 'fixtures', file)

  // `cmd`, the Command Code stand-in. `slow …` holds the turn open long enough
  // for the other harness to be caught running at the same time.
  install(
    'cmd',
    `#!/bin/sh
input=$(cat)
case "$input" in
  slow*) /bin/sleep 1.2 ;;
esac
printf '%s\\n' "$input" | exec ${process.execPath} ${fixture('fake-cmd.ts')} "$@"
`,
  )
  install('opencode', `#!/bin/sh\nexec ${process.execPath} ${fixture('fake-acp-agent.ts')} "$@"\n`)
  install('ssh', `#!/bin/sh\nexec ${process.execPath} ${fixture('fake-ssh.ts')} "$@"\n`)
  // The drivers and the fakes are bun programs; nothing else from this machine
  // is reachable from the PATH below.
  symlinkSync(process.execPath, join(bin, 'bun'))

  const child = Bun.spawn([process.execPath, import.meta.path], {
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      SEDANO_MULTI_SANDBOX: sandbox,
      FAKE_SSH_ROOT: sandbox,
      SEDANO_HOME: join(sandbox, 'h'),
      SEDANO_SSH_CONFIG: join(import.meta.dir, 'fixtures', 'ssh-config'),
      CLAUDE_CONFIG_DIR: join(sandbox, 'claude'),
    },
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  const code = await child.exited
  rmSync(sandbox, { recursive: true, force: true })
  process.exit(code)
}

const sandbox = process.env.SEDANO_MULTI_SANDBOX!
const cmdWork = join(sandbox, 'workspace-cmd')
const acpWork = join(sandbox, 'workspace-acp')
for (const dir of [join(sandbox, 'h'), cmdWork, acpWork]) mkdirSync(dir, { recursive: true })
writeFileSync(join(sandbox, 'control.json'), '{}')

const failures: string[] = []
const passed: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) passed.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const manager = await import('../apps/server/src/manager.ts')
const db = await import('../apps/server/src/db.ts')
const hosts = await import('../apps/server/src/hosts.ts')

function waitFor(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
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

const textsOf = (id: string, kind: string): string[] =>
  db
    .loadEvents(id)
    .filter((event) => event.ev.k === kind)
    .map((event) => ('text' in event.ev ? event.ev.text : ''))
const status = (id: string): string | undefined => manager.getSession(id)?.status

manager.restore()

try {
  /* ---------------- two sessions, two harnesses, one process ---------------- */

  const cmd = await manager.createSession({ harness: 'commandcode', kind: 'agent', cwd: cmdWork })
  const acp = await manager.createSession({ harness: 'opencode', kind: 'agent', cwd: acpWork })
  check('two harnesses can be open at once', cmd.id !== acp.id && manager.listSessions().length === 2)

  // Both prompts go out before either turn is waited on: the point is the
  // overlap, and sending them one at a time would prove nothing about it.
  const sent = await Promise.all([
    manager.sendMessage(cmd.id, 'slow — the Command Code turn'),
    manager.sendMessage(acp.id, 'the ACP turn'),
  ])
  check('both prompts are accepted', sent.every((result) => result.ok), sent)
  check(
    'neither prompt is queued behind the other',
    sent.every((result) => result.ok && !result.queued),
    sent,
  )

  await waitFor(() => status(cmd.id) === 'running', 'the Command Code turn to start')
  check('the two turns are in flight together', status(acp.id) === 'running' || textsOf(acp.id, 'assistant').length > 0, {
    cmd: status(cmd.id),
    acp: status(acp.id),
  })

  await waitFor(() => status(cmd.id) === 'idle' && status(acp.id) === 'idle', 'both turns to finish')

  const acpEvents = db.loadEvents(acp.id)
  const acpUser = acpEvents.find((event) => event.ev.k === 'user' && !event.agentId)
  const acpTurnEvents = acpEvents.filter((event) => ['thinking', 'assistant', 'tool', 'result'].includes(event.ev.k) && !event.agentId)
  check(
    'cold ACP startup keeps prompt, work and result in one turn',
    Boolean(acpUser?.turnId) && acpTurnEvents.length > 0 && acpTurnEvents.every((event) => event.turnId === acpUser?.turnId),
    acpEvents.map((event) => ({ kind: event.ev.k, turnId: event.turnId })),
  )
  check('cold ACP startup produces only the real result', acpEvents.filter((event) => event.ev.k === 'result' && !event.agentId).length === 1)

  /* ---------------- nothing of one is in the other ---------------- */

  const cmdSummary = manager.getSession(cmd.id)!
  const acpSummary = manager.getSession(acp.id)!

  check('each session keeps its own harness', cmdSummary.harness === 'commandcode' && acpSummary.harness === 'opencode', {
    cmd: cmdSummary.harness,
    acp: acpSummary.harness,
  })
  check('each session keeps its own native id', cmdSummary.nativeId === 'fake-session-0001' && acpSummary.nativeId === 'fake-session-1', {
    cmd: cmdSummary.nativeId,
    acp: acpSummary.nativeId,
  })
  // Each harness names its own model, and neither of them asked for one: what
  // the session reports is what the process it is talking to answered with. The
  // ACP half is the one that used to read `null` — the handshake happens inside
  // `adapter.create`, and the commit that closes the spawn wrote the (empty)
  // request straight over the agent's answer.
  check('each session names the model its own harness reported', cmdSummary.model === 'fake/model' && acpSummary.model === 'fake-model-1', {
    cmd: cmdSummary.model,
    acp: acpSummary.model,
  })
  check('a session that asked for no model still reports the one it is running', acpSummary.model !== null, acpSummary.model)
  check('each session keeps its own workspace', cmdSummary.cwd === cmdWork && acpSummary.cwd === acpWork, {
    cmd: cmdSummary.cwd,
    acp: acpSummary.cwd,
  })
  check(
    'neither transcript carries the other prompt',
    textsOf(cmd.id, 'user').join(' ').includes('Command Code') &&
      !textsOf(cmd.id, 'user').join(' ').includes('ACP') &&
      textsOf(acp.id, 'user').join(' ').includes('ACP') &&
      !textsOf(acp.id, 'user').join(' ').includes('Command Code'),
    { cmd: textsOf(cmd.id, 'user'), acp: textsOf(acp.id, 'user') },
  )

  /* ---------------- usage is counted per session ---------------- */

  const acpTokens = acpSummary.metrics.outputTokens
  const cmdTokensAfterOne = cmdSummary.metrics.outputTokens
  check('both sessions counted their own output tokens', acpTokens > 0 && cmdTokensAfterOne > 0, {
    cmd: cmdTokensAfterOne,
    acp: acpTokens,
  })

  // A second turn on one session only: a shared counter would move both.
  await manager.sendMessage(cmd.id, 'a second Command Code turn')
  await waitFor(() => status(cmd.id) === 'idle', 'the second turn to finish')
  check(
    'a second turn adds to its own session',
    manager.getSession(cmd.id)!.metrics.outputTokens > cmdTokensAfterOne,
    { before: cmdTokensAfterOne, after: manager.getSession(cmd.id)!.metrics.outputTokens },
  )
  check('and leaves the other count alone', manager.getSession(acp.id)!.metrics.outputTokens === acpTokens, {
    before: acpTokens,
    after: manager.getSession(acp.id)!.metrics.outputTokens,
  })

  /* ---------------- configuring one does not configure the other ---------------- */

  const configured = manager.setSessionOptions(acp.id, { model: 'fake-model-2' })
  check('the ACP session takes a new model', configured.ok, configured)
  await waitFor(() => manager.getSession(acp.id)?.model === 'fake-model-2', 'the model change to apply', 15_000)
  check('the Command Code session still has its own model', manager.getSession(cmd.id)?.model === 'fake/model', manager.getSession(cmd.id)?.model)

  /* ---------------- asking for a model, and stopping asking ---------------- */

  /**
   * The two neighbours of the case above, because the rule is one rule: the
   * summary carries what the session is *running*, and the only authority on
   * that is the process. A request wins while it is the last thing said, and it
   * stops winning the moment the agent answers something else — a reset that
   * leaves the old value on screen is the same lie as a handshake overwritten by
   * an empty request, just in the other direction.
   */
  const picky = await manager.createSession({ harness: 'opencode', kind: 'agent', cwd: acpWork, model: 'fake-model-2' })
  const pickySent = await manager.sendMessage(picky.id, 'a turn on a chosen model')
  check('a session can be opened on a chosen model', pickySent.ok, pickySent)
  await waitFor(() => status(picky.id) === 'idle', 'the chosen-model turn to finish')
  check('a requested model is what the session reports', manager.getSession(picky.id)?.model === 'fake-model-2', manager.getSession(picky.id)?.model)

  const reset = manager.setSessionOptions(picky.id, { model: null })
  check('the preference can be dropped again', reset.ok, reset)
  // Dropping the model needs a fresh process, so the change lands on the next
  // turn — which is the turn that will hear the agent's own default.
  await manager.sendMessage(picky.id, 'a turn after the reset')
  await waitFor(() => status(picky.id) === 'idle', 'the turn after the reset to finish')
  // The respawn resumes the conversation, and `session/load` carries the same
  // `configOptions` a new session does, so the agent names the model it went
  // back to. The session must report *that* — not the preference that was just
  // dropped, and not "no model" either.
  check(
    'dropping the preference hands the answer back to the agent',
    manager.getSession(picky.id)?.model === 'fake-model-1',
    manager.getSession(picky.id)?.model,
  )
  check('and nothing of it leaked into the other ACP session', manager.getSession(acp.id)?.model === 'fake-model-2', manager.getSession(acp.id)?.model)
  manager.removeSession(picky.id)

  /* ---------------- a remote session beside the local ones ---------------- */

  hosts.setHostEnabled('vps', true)
  const remote = await manager.createSession({ harness: 'commandcode', kind: 'agent', cwd: '.', host: 'vps' })
  const remoteSent = await manager.sendMessage(remote.id, 'the remote turn')
  check('a remote session opens beside the local ones', remoteSent.ok, remoteSent)
  await waitFor(() => status(remote.id) === 'idle' || status(remote.id) === 'error', 'the remote turn to settle')
  check('the remote turn ran', status(remote.id) === 'idle', {
    status: status(remote.id),
    errors: textsOf(remote.id, 'error'),
  })
  check('the remote session is marked as belonging to its host', manager.getSession(remote.id)?.host === 'vps', manager.getSession(remote.id)?.host)
  check('the local sessions stayed local', manager.getSession(cmd.id)?.host === null && manager.getSession(acp.id)?.host === null, {
    cmd: manager.getSession(cmd.id)?.host,
    acp: manager.getSession(acp.id)?.host,
  })
  const sshLog = await Bun.file(join(sandbox, 'ssh.log')).text().catch(() => '')
  check('the remote session really went over ssh', sshLog.includes('"host":"vps"'), sshLog.slice(0, 400))
  check('and only one session did', !sshLog.includes(cmdWork) && !sshLog.includes(acpWork), sshLog.slice(0, 400))

  // The failure reported in the app was specifically a cold remote ACP launch
  // while a local turn was open. A remote Command Code turn does not exercise
  // the ACP/ssh stdio path, so keep that combination in the regression suite.
  const localAgain = manager.sendMessage(cmd.id, 'slow — keep the local turn open')
  await waitFor(() => status(cmd.id) === 'running', 'the local turn to overlap remote ACP')
  const remoteAcp = await manager.createSession({ harness: 'opencode', kind: 'agent', cwd: '.', host: 'vps' }, { deferStart: true })
  const remoteAcpSent = await manager.sendMessage(remoteAcp.id, 'the remote ACP turn')
  check('remote ACP prompt is accepted while a local turn runs', remoteAcpSent.ok, remoteAcpSent)
  await waitFor(() => status(remoteAcp.id) === 'idle' || status(remoteAcp.id) === 'error', 'remote ACP turn to settle')
  check('remote ACP turn completes without stopping the local turn', status(remoteAcp.id) === 'idle', {
    status: status(remoteAcp.id),
    errors: textsOf(remoteAcp.id, 'error'),
  })
  await localAgain
  await waitFor(() => status(cmd.id) === 'idle', 'the overlapping local turn to finish')
  check('local turn survives remote ACP startup', status(cmd.id) === 'idle', status(cmd.id))
  manager.removeSession(remoteAcp.id)

  /* ---------------- stopping one leaves the others ---------------- */

  manager.stopSession(cmd.id)
  await waitFor(() => status(cmd.id) === 'stopped', 'the stopped session to settle')
  check('stopping one session does not stop the others', status(acp.id) === 'idle' && status(remote.id) === 'idle', {
    acp: status(acp.id),
    remote: status(remote.id),
  })

  manager.removeSession(cmd.id)
  check('deleting one session leaves the others in the list', manager.listSessions().length === 2, manager.listSessions().map((s) => s.harness))
  check('and its transcript is the only one that went', db.loadEvents(acp.id).length > 0 && db.loadEvents(cmd.id).length === 0, {
    acp: db.loadEvents(acp.id).length,
    cmd: db.loadEvents(cmd.id).length,
  })
} finally {
  for (const session of manager.listSessions()) manager.removeSession(session.id)
}

if (failures.length) {
  console.log('--- failed checks ---')
  for (const failure of failures) console.log(`✗ ${failure}`)
  console.log(`\nmulti-harness-test: ${failures.length} FAILURES (${passed.length} passed)`)
  process.exit(1)
}
console.log(`multi-harness-test: PASSED (${passed.length} checks)`)
process.exit(0)
