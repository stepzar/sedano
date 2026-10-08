#!/usr/bin/env bun
/**
 * The SSH story, end to end, without an SSH server.
 *
 * Everything here runs against `scripts/fixtures/fake-ssh.ts` on a temporary
 * PATH, a temporary `SEDANO_HOME` and a fixture `ssh config`: no real host is
 * contacted, the real `~/.ssh/config` is never read, and nothing is left running
 * anywhere. What is checked is the part that used to be invisible — a host that
 * is not enabled, a host that is enabled and unreachable, a poll that is cut in
 * half, and a process left behind on the far side.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// Type-only: importing the module itself here would load it before the
// environment below is in place.
import type { RemoteError as RemoteErrorType } from '../apps/server/src/transport.ts'

/* ------------------------------------------------------------------ */
/* The fake has to be on PATH before this process starts               */
/* ------------------------------------------------------------------ */

/**
 * Bun resolves a spawned binary against the PATH the process was started with,
 * so assigning `process.env.PATH` here would still run the real `ssh`. The first
 * pass therefore only builds the sandbox and re-runs this file inside it.
 *
 * The sandbox lives under `/tmp` and not under `TMPDIR`: ssh control sockets are
 * unix sockets, whose paths are capped at ~104 bytes, and macOS puts `TMPDIR`
 * deep enough to blow that on its own.
 */
if (!process.env.SEDANO_SSH_TEST_ROOT) {
  const sandbox = mkdtempSync('/tmp/sedano-ssh-')
  const bin = join(sandbox, 'bin')
  mkdirSync(bin, { recursive: true })
  // A shell wrapper rather than a shebang: the PATH below is deliberately
  // narrow, and this keeps the fake reachable without putting bun on it.
  writeFileSync(
    join(bin, 'ssh'),
    `#!/bin/sh\nexec ${process.execPath} ${join(import.meta.dir, 'fixtures', 'fake-ssh.ts')} "$@"\n`,
  )
  chmodSync(join(bin, 'ssh'), 0o755)
  const child = Bun.spawnSync([process.execPath, import.meta.path], {
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      SEDANO_SSH_TEST_ROOT: sandbox,
      // The fake reads this at spawn time; a child's environment is fixed when
      // the parent starts, which is why everything else travels in a file.
      FAKE_SSH_ROOT: sandbox,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  rmSync(sandbox, { recursive: true, force: true })
  process.exit(child.exitCode ?? 1)
}

const failures: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) return
  failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

async function throws(label: string, fn: () => unknown, match?: RegExp): Promise<Error | null> {
  try {
    await fn()
    check(label, false, 'did not throw')
    return null
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err))
    check(label, !match || match.test(error.message), error.message)
    return error
  }
}

/* ------------------------------------------------------------------ */
/* A machine that does not exist                                       */
/* ------------------------------------------------------------------ */

const tmp = process.env.SEDANO_SSH_TEST_ROOT!
// Short names on purpose: the ssh control socket path is built from this one.
const sedanoHome = join(tmp, 'h')
const hostsRoot = join(tmp, 'hosts')
const sshLog = join(tmp, 'ssh.log')
const controlFile = join(tmp, 'control.json')
for (const dir of [sedanoHome, hostsRoot]) mkdirSync(dir, { recursive: true })
writeFileSync(sshLog, '')

/** How the fake ssh behaves from the next invocation on. */
interface Control {
  down?: string[]
  hang?: string[]
  cut?: string[]
  flaky?: Record<string, number>
}
function control(state: Control): void {
  writeFileSync(controlFile, JSON.stringify(state))
}
control({})

const localHome = process.env.HOME ?? ''
process.env.SEDANO_HOME = sedanoHome
process.env.SEDANO_SSH_CONFIG = join(import.meta.dir, 'fixtures', 'ssh-config')

const hosts = await import('../apps/server/src/hosts.ts')
const { Transport, RemoteError } = await import('../apps/server/src/transport.ts')
const files = await import('../apps/server/src/fs.ts')

/* ------------------------------------------------------------------ */
/* 1. Parsing a config that looks like a real one                      */
/* ------------------------------------------------------------------ */

const parsed = hosts.sshConfigHosts()
check(
  'the ssh config parses to its literal aliases only',
  JSON.stringify(parsed) ===
    JSON.stringify(['work-gw', 'lab1', 'lab2', 'vps', 'db-a', 'db-b', 'db-c', 'prod-a', 'laptop']),
  parsed,
)
check('an inline comment is not a host', !parsed.includes('#') && !parsed.some((h) => h.includes('#')), parsed)
check('a wildcard pattern is not a host', !parsed.some((h) => h.includes('*') || h.includes('?')), parsed)
check('a negated pattern is not a host', !parsed.includes('!prod-locked') && !parsed.includes('prod-locked'))
check('a commented-out Host block is not a host', !parsed.includes('never-enabled'))
check('an included file contributes its hosts', parsed.includes('work-gw') && parsed.includes('lab2'))

/* ------------------------------------------------------------------ */
/* 2. Only an alias in the config may be enabled                       */
/* ------------------------------------------------------------------ */

for (const host of ['vps', 'db-a', 'db-b', 'db-c']) hosts.setHostEnabled(host, true)
check('enabling an alias records it', hosts.enabledHosts().includes('vps'), hosts.enabledHosts())
await throws('a host absent from the ssh config cannot be enabled', () => hosts.setHostEnabled('evil.example.com', true), /not a Host alias/)
await throws('a user@host destination cannot be enabled', () => hosts.setHostEnabled('deploy@203.0.113.10', true), /not a Host alias/)
await throws('a wildcard cannot be enabled', () => hosts.setHostEnabled('*', true), /unsafe|not a Host alias/)
check('nothing unwanted made it into the allowlist', hosts.enabledHosts().every((h) => parsed.includes(h)), hosts.enabledHosts())

/* ------------------------------------------------------------------ */
/* 3. Safe-looking is not the same as allowed                          */
/* ------------------------------------------------------------------ */

check('no host means this machine', hosts.requireHost(null) === null && hosts.requireHost('') === null)
check('an enabled host passes', hosts.requireHost('vps') === 'vps')
check('laptop is a valid alias', parsed.includes('laptop') && hosts.isSafeHost('laptop'))
await throws('a safe alias that is not enabled is refused', () => hosts.requireHost('laptop'), /not enabled/)
await throws('an arbitrary user@host is refused', () => hosts.requireHost('deploy@203.0.113.10'), /not enabled/)
await throws('an ssh option disguised as a host is refused', () => hosts.requireHost('-oProxyCommand=touch /tmp/pwn'), /unsafe/)
await throws('a transport cannot be built for a host nobody enabled', () => new Transport('laptop'), /not enabled/)
check('a transport can be built for an enabled host', new Transport('vps').host === 'vps')

/* ------------------------------------------------------------------ */
/* 4. An enabled host that is not answering                            */
/* ------------------------------------------------------------------ */

control({ down: ['db-a'] })
const down = new Transport('db-a')
const homeError = await throws('an unreachable home is an error', () => down.home(), /db-a/)
check('the unreachable home is typed', homeError instanceof RemoteError && (homeError as RemoteErrorType).kind === 'unreachable', {
  kind: (homeError as RemoteErrorType | null)?.kind,
})
check('the unreachable home is not this machine', !String(homeError?.message ?? '').includes(localHome || '\u0000'))
await throws('an unreachable listing is an error, not an empty folder', () => down.listDir('/srv'), /db-a/)
await throws('the fs layer refuses to invent a home', () => files.homeFor('db-a'), /db-a/)
await throws('the picker surfaces the failure', () => files.listDirectoryFor('db-a', '/srv'), /db-a/)
await throws('the picker refuses a host nobody enabled', () => files.listDirectoryFor('laptop', ''), /not enabled/)

/* ------------------------------------------------------------------ */
/* 5. A host that answers                                              */
/* ------------------------------------------------------------------ */

const vps = new Transport('vps')
const vpsHome = join(hostsRoot, 'vps')
check('the remote home is the remote home', vps.home() === vpsHome, vps.home())
check('the remote home is not the local one', vps.home() !== localHome)

// Quoting: a path with a space and content full of shell metacharacters must
// arrive verbatim, and `$(…)` must never be evaluated anywhere on the way.
const trickyPath = join(vpsHome, 'a dir', "it's $(touch /tmp/sedano-pwn) `id`.txt")
const trickyText = 'line one\n$(touch /tmp/sedano-pwn2) `id` "quotes" \'single\' \\backslash\nè fine\n'
const written = vps.writeText(trickyPath, trickyText)
check('a write reports what it wrote', written.bytes === Buffer.byteLength(trickyText), written)
check('the bytes arrived verbatim', readFileSync(trickyPath, 'utf8') === trickyText)
check('nothing was evaluated on the way', !existsSync('/tmp/sedano-pwn') && !existsSync('/tmp/sedano-pwn2'))
check('reading it back gives the same text', vps.readText(trickyPath) === trickyText)
check('a missing file reads as null', vps.readText(join(vpsHome, 'nope.txt')) === null)
check('exists tells the truth', vps.exists(trickyPath) && !vps.exists(join(vpsHome, 'nope.txt')))

mkdirSync(join(vpsHome, 'work', '.hidden'), { recursive: true })
writeFileSync(join(vpsHome, 'work', 'README.md'), '# hi\n')
const listing = vps.listDir(join(vpsHome, 'work'))
check('a listing classifies its entries', listing.length === 2, listing)
check('a directory is a directory', listing.find((i) => i.name === '.hidden')?.dir === true, listing)
check('a dotfile is hidden', listing.find((i) => i.name === '.hidden')?.hidden === true, listing)

/* ------------------------------------------------------------------ */
/* 6. A write that fails says so                                       */
/* ------------------------------------------------------------------ */

const writeError = await throws('a write to an unreachable host throws', () => down.writeText('/srv/x', 'x'), /db-a/)
check('the failed write is typed', writeError instanceof RemoteError && (writeError as RemoteErrorType).kind === 'unreachable', {
  kind: (writeError as RemoteErrorType | null)?.kind,
})
check('the failed write carries the exit code', (writeError as RemoteErrorType | null)?.code === 255, (writeError as RemoteErrorType | null)?.code)
check('the failed write carries stderr', /refused/i.test((writeError as RemoteErrorType | null)?.stderr ?? ''), (writeError as RemoteErrorType | null)?.stderr)

/* ------------------------------------------------------------------ */
/* 7. Timeout and retry                                                */
/* ------------------------------------------------------------------ */

control({ down: ['db-a'], hang: ['db-b'] })
const hung = new Transport('db-b')
const startedAt = Date.now()
const hungResult = hung.exec('printf hello', { timeoutMs: 700 })
const tookMs = Date.now() - startedAt
check('a silent host times out rather than hanging', tookMs < 5000, tookMs)
check('the timeout is typed', hungResult.error?.kind === 'timeout', { kind: hungResult.error?.kind, tookMs })
check('a timed-out command yields no output', hungResult.stdout === '')

const flaky = new Transport('db-c')
control({ down: ['db-a'], flaky: { 'db-c': 1 } })
const noRetry = flaky.exec('printf hello')
check('without a retry the first failure stands', noRetry.error?.kind === 'unreachable', noRetry.error?.kind)
control({ down: ['db-a'], flaky: { 'db-c': 1 } })
const withRetry = flaky.exec('printf hello', { retries: 1 })
check('an idempotent call reconnects', withRetry.code === 0 && withRetry.stdout === 'hello', withRetry)
control({ down: ['db-a'], flaky: { 'db-c': 1 } })
check('whichAll survives a dropped first connection', flaky.whichAll(['sh']).get('sh') !== undefined)

/* ------------------------------------------------------------------ */
/* 8. poll: growth, truncation, split characters, a cut connection     */
/* ------------------------------------------------------------------ */

const tailPath = join(vpsHome, 'transcript.jsonl')
check('a file that does not exist yet polls as null', vps.poll(tailPath, 0) === null)

writeFileSync(tailPath, 'hello ')
const first = vps.poll(tailPath, 0)
check('the first poll delivers what is there', Buffer.from(first!.bytes).toString() === 'hello ', first)
check('the offset advances by what was delivered', first!.next === 6 && first!.size === 6, first)

// A two-byte character split across two polls: the bytes must survive the gap.
const decoder = new TextDecoder('utf-8')
const encoded = Buffer.from('è', 'utf8')
writeFileSync(tailPath, Buffer.concat([Buffer.from('hello '), encoded.subarray(0, 1)]))
const half = vps.poll(tailPath, first!.next)
check('half a character is still a byte', half!.bytes.length === 1, half)
const halfText = decoder.decode(half!.bytes, { stream: true })
check('half a character decodes to nothing yet', halfText === '', halfText)
writeFileSync(tailPath, Buffer.concat([Buffer.from('hello '), encoded]))
const rest = vps.poll(tailPath, half!.next)
check('the other half completes it', decoder.decode(rest!.bytes, { stream: true }) === 'è', rest)

// Truncation: a reused session id starts a fresh file, and a shorter size is how
// a caller learns to start over.
writeFileSync(tailPath, 'x')
const shrunk = vps.poll(tailPath, rest!.next)
check('a truncated file reports a smaller size', shrunk!.size < rest!.next, shrunk)
check('a truncated file delivers nothing', shrunk!.bytes.length === 0, shrunk)

/** Read a file to the end through poll, the way a tailer does. */
function drain(path: string, from: number): { bytes: Buffer; offset: number; reads: number[] } {
  let offset = from
  let bytes = Buffer.alloc(0)
  const reads: number[] = []
  for (;;) {
    const polled = vps.poll(path, offset)
    if (!polled || polled.error) break
    if (!polled.bytes.length) break
    reads.push(offset)
    bytes = Buffer.concat([bytes, Buffer.from(polled.bytes)])
    offset = polled.next
  }
  return { bytes, offset, reads }
}

// Two readers of the same growing file: neither may miss a byte or see one twice.
const bulk = join(vpsHome, 'bulk.log')
writeFileSync(bulk, '')
let expected = ''
const readers = [0, 0]
const collected = ['', '']
for (let round = 0; round < 12; round += 1) {
  const chunk = `${'è'.repeat(round)}line-${round}\n`
  expected += chunk
  writeFileSync(bulk, expected)
  for (const reader of [0, 1]) {
    const drained = drain(bulk, readers[reader]!)
    readers[reader] = drained.offset
    collected[reader] += drained.bytes.toString()
  }
}
check('a poll reader loses nothing', collected[0] === expected, { got: collected[0]!.length, want: expected.length })
check('the second reader sees the same stream', collected[1] === expected)
check('the offsets end where the file does', readers[0] === Buffer.byteLength(expected), readers)

// A connection that dies halfway through a poll: the bytes that did arrive are
// counted, the ones that did not are still there for the next poll.
const cut = join(vpsHome, 'cut.log')
const cutBody = `${'0123456789'.repeat(24)}\n`
writeFileSync(cut, cutBody)
control({ down: ['db-a'], cut: ['vps'] })
const partial = vps.poll(cut, 0)
control({ down: ['db-a'] })
check('a cut poll delivers less than the file', (partial?.bytes.length ?? 0) < Buffer.byteLength(cutBody), partial?.bytes.length)
check('a cut poll never reports more than it delivered', partial!.next === partial!.size, partial)
check('a cut poll advances only by what arrived', partial!.next === partial!.bytes.length, {
  next: partial!.next,
  delivered: partial!.bytes.length,
})
const after = drain(cut, partial!.next)
check(
  'the rest of the file arrives exactly once',
  Buffer.concat([Buffer.from(partial!.bytes), after.bytes]).toString() === cutBody,
)

// An unreachable host mid-tail is an error, never an empty read at a new offset.
control({ down: ['db-a', 'vps'] })
const dropped = vps.poll(cut, 10)
control({ down: ['db-a'] })
check('a poll of an unreachable host reports the failure', dropped?.error?.kind === 'unreachable', dropped?.error?.kind)
check('a failed poll does not move the offset', dropped!.next === 10 && dropped!.size === 10, dropped)

/* ------------------------------------------------------------------ */
/* 9. remoteEnv names are shell variable names                         */
/* ------------------------------------------------------------------ */

await throws(
  'a remote environment name that is shell code is refused',
  () => vps.spawn('true', [], { remoteEnv: { 'X=1; rm -rf /': 'y' }, stdout: 'ignore', stderr: 'ignore' }),
  /unsafe remote environment name/,
)
const envProc = vps.spawn('sh', ['-c', 'printf %s "$SEDANO_TEST"'], {
  remoteEnv: { SEDANO_TEST: "a b '; touch /tmp/sedano-pwn3" },
  stdout: 'pipe',
})
const envOut = await new Response(envProc.stdout).text()
check('a valid remote environment value survives quoting', envOut === "a b '; touch /tmp/sedano-pwn3", envOut)
check('the remote environment value was not executed', !existsSync('/tmp/sedano-pwn3'))

/* ------------------------------------------------------------------ */
/* 10. A long-lived remote process is cleaned up explicitly            */
/* ------------------------------------------------------------------ */

const tag = 'sedano-ssh-test-proc'
const pidFile = join(vpsHome, '.sedano', 'procs', `${tag}.pid`)
const longLived = vps.spawn('sleep', ['120'], { procTag: tag, stdout: 'ignore', stderr: 'ignore' })
for (let wait = 0; wait < 100 && !existsSync(pidFile); wait += 1) await Bun.sleep(30)
check('a tagged remote process records its pid', existsSync(pidFile))
const remotePid = Number(existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim() : 0)
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
check('the remote process is running', remotePid > 0 && alive(remotePid), remotePid)
// Killing the ssh client is exactly what does *not* clean up after itself.
try {
  longLived.kill()
} catch {
  /* already gone */
}
await Bun.sleep(300)
check('killing the ssh client leaves the remote process behind', alive(remotePid), remotePid)
vps.cleanupRemote(tag)
await Bun.sleep(300)
check('explicit cleanup kills the remote process', !alive(remotePid), remotePid)
check('explicit cleanup removes the pid file', !existsSync(pidFile))

/* ------------------------------------------------------------------ */
/* 11. Every endpoint, and new_session, refuse a host nobody enabled   */
/* ------------------------------------------------------------------ */

const port = 7800 + Math.floor(Math.random() * 400)
process.env.SEDANO_PORT = String(port)
process.env.SEDANO_HOST = '127.0.0.1'
await import('../apps/server/src/index.ts')
const base = `http://127.0.0.1:${port}`

for (const path of [
  '/api/fs?host=laptop',
  '/api/home?host=laptop',
  '/api/harnesses?host=laptop',
  '/api/caps?host=laptop',
  '/api/commands?harness=claude&cwd=/tmp&host=laptop',
]) {
  const response = await fetch(`${base}${path}`)
  const body = (await response.json()) as { error?: string }
  check(`${path} refuses a host that is not enabled`, response.status === 400, response.status)
  check(`${path} says why`, /not enabled/.test(body.error ?? ''), body.error)
}

const evil = await fetch(`${base}/api/hosts`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ host: 'deploy@203.0.113.10', enabled: true }),
})
check('/api/hosts refuses a destination that is not in the ssh config', evil.status === 400, evil.status)

const unreachable = await fetch(`${base}/api/home?host=db-a`)
const unreachableBody = (await unreachable.json()) as { error?: string; path?: string }
check('/api/home reports an unreachable host', unreachable.status === 400, unreachable.status)
check('/api/home never answers with the local home', unreachableBody.path === undefined, unreachableBody)
check('/api/home names the host', /db-a/.test(unreachableBody.error ?? ''), unreachableBody.error)

const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws`)
const toasts: string[] = []
const sessions: string[] = []
socket.addEventListener('message', (event) => {
  const msg = JSON.parse(String(event.data)) as { t: string; text?: string; session?: { id: string } }
  if (msg.t === 'toast' && msg.text) toasts.push(msg.text)
  if (msg.t === 'session' && msg.session) sessions.push(msg.session.id)
})
await new Promise<void>((resolve, reject) => {
  socket.addEventListener('open', () => resolve())
  socket.addEventListener('error', () => reject(new Error('websocket failed')))
  setTimeout(() => reject(new Error('websocket timed out')), 5000)
})
socket.send(
  JSON.stringify({
    t: 'new_session',
    req: { harness: 'claude', kind: 'agent', cwd: '/tmp', host: 'laptop' },
  }),
)
await Bun.sleep(600)
check('new_session refuses a host that is not enabled', toasts.some((text) => /not enabled/.test(text)), toasts)
check('new_session created nothing', sessions.length === 0, sessions)
socket.close()

/* ------------------------------------------------------------------ */
/* 11. The async twins: same answers, and the event loop keeps running */
/* ------------------------------------------------------------------ */

control({})
const asyncFile = join(vpsHome, 'async.jsonl')
writeFileSync(asyncFile, 'a'.repeat(100))
check('pollAsync reads a missing file as null', (await vps.pollAsync(join(vpsHome, 'nope.jsonl'), 0)) === null)
const capped = await vps.pollAsync(asyncFile, 0, 40)
check('pollAsync hands over at most the cap', capped?.bytes.length === 40, capped)
check('a capped poll reports where it stopped', capped?.next === 40 && capped?.size === 40, capped)
const remainder = await vps.pollAsync(asyncFile, 40, 1000)
check('the next poll continues from there', remainder?.bytes.length === 60 && remainder?.next === 100, remainder)
check('existsAsync agrees with exists', (await vps.existsAsync(asyncFile)) === true && (await vps.existsAsync(join(vpsHome, 'nope'))) === false)
check('readTextAsync reads the file', (await vps.readTextAsync(asyncFile)) === 'a'.repeat(100))
check('readTextAsync reads a missing file as null', (await vps.readTextAsync(join(vpsHome, 'nope'))) === null)
check('homeAsync is the host home', (await vps.homeAsync()) === vpsHome)
check(
  'listDirAsync lists like listDir',
  JSON.stringify(await vps.listDirAsync(vpsHome)) === JSON.stringify(vps.listDir(vpsHome)),
)
const asyncListing = await files.listDirectoryForAsync('vps', '')
check('the async /api/fs listing starts at the host home', asyncListing.path === vpsHome, asyncListing.path)

control({ hang: ['db-b'] })
let ticks = 0
const ticker = setInterval(() => (ticks += 1), 50)
const hungAsync = await new Transport('db-b').execAsync('printf hello', { timeoutMs: 700 })
clearInterval(ticker)
check('a silent host times out asynchronously too', hungAsync.error?.kind === 'timeout', hungAsync.error?.kind)
check('and the event loop kept running while it waited', ticks >= 8, ticks)

// The harness update check against a host that never answers: it used to run
// `which`/`--version`/`npm view` synchronously, freezing the whole server for
// every timeout in the chain. Now it must come back "unknown" with the loop alive.
const { checkHarnessUpdate } = await import('../apps/server/src/harnesses/updates.ts')
let updateTicks = 0
const updateTicker = setInterval(() => (updateTicks += 1), 50)
const updateStarted = Date.now()
const hungUpdate = await checkHarnessUpdate('db-b', 'gemini', true)
const updateMs = Date.now() - updateStarted
clearInterval(updateTicker)
check('an update check on a silent host answers unknown', hungUpdate?.status === 'unknown', hungUpdate)
check(
  'and the event loop kept ticking for the whole wait',
  updateTicks >= Math.floor(updateMs / 50) * 0.5 && updateTicks >= 20,
  { updateTicks, updateMs },
)
control({})

/* ------------------------------------------------------------------ */
/* Accept edits: "inside the workspace" is the same answer on a host     */
/* ------------------------------------------------------------------ */

{
  const { insideWorkspace } = await import('../apps/server/src/harnesses/workspace-scope.ts')
  const workspace = join(tmp, 'ws')
  const outside = join(tmp, 'out')
  mkdirSync(join(workspace, 'src'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  symlinkSync(outside, join(workspace, 'escape'))
  symlinkSync(join(outside, 'missing'), join(workspace, 'dangling'))
  writeFileSync(join(workspace, 'src', 'a.ts'), '')
  const table: Array<[string, string[], boolean]> = [
    ['an existing file inside', [join(workspace, 'src', 'a.ts')], true],
    ['a new file inside', [join(workspace, 'src', 'new', 'b.ts')], true],
    ['a relative path inside', ['src/a.ts'], true],
    ['a .. that stays inside', [join(workspace, 'src', '..', 'src', 'a.ts')], true],
    ['a file outside', [join(outside, 'x.ts')], false],
    ['a .. that climbs out', ['../out/x.ts'], false],
    ['a symlink that leads out', [join(workspace, 'escape', 'x.ts')], false],
    ['a dangling symlink', [join(workspace, 'dangling')], false],
    ['a .. inside a folder that does not exist', [join(workspace, 'nope', '..', '..', 'out', 'x')], false],
    ['one inside and one outside', [join(workspace, 'src', 'a.ts'), join(outside, 'x.ts')], false],
    ['a home-relative path', ['~/x.ts'], false],
    ['no path at all', [], false],
  ]
  for (const [label, paths, expected] of table) {
    check(`local: ${label}`, (await insideWorkspace(new Transport(null), workspace, paths)) === expected, paths)
    check(`on a host: ${label}`, (await insideWorkspace(vps, workspace, paths)) === expected, paths)
  }
  control({ down: ['vps'] })
  check('a host that cannot be asked is never inside', !(await insideWorkspace(vps, workspace, ['src/a.ts'])))
  control({})
}

/* ------------------------------------------------------------------ */
/* The store is the owner's only: here, and on a host                    */
/* ------------------------------------------------------------------ */

{
  const { ensureDirs } = await import('../apps/server/src/paths.ts')
  const { durableLaunch, durableDestroy } = await import('../apps/server/src/transport.ts')
  const mode = (path: string) => (statSync(path).mode & 0o777).toString(8)

  // What an older build left behind: everything readable by everyone.
  mkdirSync(join(sedanoHome, 'attachments'), { recursive: true, mode: 0o755 })
  writeFileSync(join(sedanoHome, 'attachments', 'old.png'), 'x', { mode: 0o644 })
  chmodSync(sedanoHome, 0o755)
  ensureDirs()
  check('the store folder is the owner\'s only', mode(sedanoHome) === '700', mode(sedanoHome))
  check('an old folder in it is tightened', mode(join(sedanoHome, 'attachments')) === '700', mode(join(sedanoHome, 'attachments')))
  check('an old file in it is tightened', mode(join(sedanoHome, 'attachments', 'old.png')) === '600')
  writeFileSync(join(sedanoHome, 'tool'), '#!/bin/sh\n', { mode: 0o755 })
  ensureDirs()
  check('an executable stays executable, for its owner only', mode(join(sedanoHome, 'tool')) === '700', mode(join(sedanoHome, 'tool')))

  // A store opened for the first time, in a process of its own: the database
  // and its WAL appear after the folder was tightened.
  const fresh = join(tmp, 'fresh-store')
  Bun.spawnSync([process.execPath, '-e', `await import(${JSON.stringify(join(import.meta.dir, '../apps/server/src/db.ts'))})`], {
    env: { ...process.env, SEDANO_HOME: fresh },
  })
  for (const file of ['sedano.db', 'sedano.db-wal']) {
    const path = join(fresh, file)
    check(`a new ${file} is the owner's only`, existsSync(path) && mode(path) === '600', existsSync(path) && mode(path))
  }

  const project = join(tmp, 'proj')
  mkdirSync(project, { recursive: true })
  const umaskOf = async (host: string | null, tag: string, agentsDir: string, root: string) => {
    const record = await durableLaunch(host, { tag, bin: 'sh', args: ['-c', `umask > ${tag}.umask`], cwd: project }, { fresh: true })
    const deadline = Date.now() + 5000
    while (!existsSync(join(project, `${tag}.umask`)) && Date.now() < deadline) await Bun.sleep(50)
    await Bun.sleep(100)
    const where = host ?? 'here'
    check(`${where}: the Sedano folder is the owner's only`, mode(root) === '700', mode(root))
    check(`${where}: the agents folder is the owner's only`, mode(agentsDir) === '700', mode(agentsDir))
    for (const suffix of ['in', 'out', 'err']) {
      const file = join(agentsDir, `${tag}.${suffix}`)
      check(`${where}: the agent's .${suffix} is the owner's only`, existsSync(file) && mode(file) === '600', existsSync(file) && mode(file))
    }
    const seen = existsSync(join(project, `${tag}.umask`)) ? readFileSync(join(project, `${tag}.umask`), 'utf8').trim() : ''
    check(`${where}: the agent itself keeps the usual umask`, seen !== '' && seen !== '0077' && seen !== '077', seen)
    await durableDestroy(record)
  }
  // A host's "home" in the fake is its own folder, and that is where `.sedano` lands.
  mkdirSync(join(hostsRoot, 'vps', '.sedano'), { recursive: true, mode: 0o755 })
  await umaskOf(null, 'modes-local', join(sedanoHome, 'agents'), sedanoHome)
  await umaskOf('vps', 'modes-remote', join(hostsRoot, 'vps', '.sedano', 'agents'), join(hostsRoot, 'vps', '.sedano'))
}

/* ------------------------------------------------------------------ */

const sshCalls = readFileSync(sshLog, 'utf8').trim().split('\n').filter(Boolean).length

if (failures.length) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  console.error(`ssh-test: FAILED (${failures.length} of the checks above, ${sshCalls} fake ssh calls)`)
  process.exit(1)
}
console.log(`ssh-test: PASSED (${sshCalls} fake ssh calls, no real host contacted)`)
process.exit(0)
