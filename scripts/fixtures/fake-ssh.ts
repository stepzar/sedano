#!/usr/bin/env bun
/**
 * A fake `ssh`, so the transport can be tested without a server.
 *
 * It is a real program on PATH, not a stub inside the process: the transport
 * shells out to `ssh` and everything interesting about it — argument quoting,
 * exit codes, timeouts, a connection dying mid-command, a process left running
 * on the far side — only exists at that boundary. Replacing the binary is the
 * only way to exercise it hermetically.
 *
 * The "host" is a directory: every destination gets its own `$HOME` under
 * `<root>/hosts/<host>`, and the command runs in a local shell with that home,
 * which makes `printf %s "$HOME"`, `wc -c`, `tail -F` and friends behave exactly
 * as they would over a real connection.
 *
 * `FAKE_SSH_ROOT` is the only environment variable, because a child's
 * environment is fixed when the parent starts and a test needs to change a
 * host's behaviour *while it runs*. Everything else is read per invocation from
 * `<root>/control.json`:
 *
 *   { "down": ["h"],   hosts that refuse the connection (exit 255, like ssh)
 *     "hang": ["h"],   hosts that accept and then never answer
 *     "cut":  ["h"],   hosts that answer halfway and drop the connection
 *     "flaky": { "h": 2 } }  failures left to serve before that host works
 *
 * Every invocation is appended to `<root>/ssh.log` as one JSON line.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)

/** ssh options that take a separate value, so the destination is not mistaken. */
const WITH_VALUE = new Set([
  '-o', '-i', '-p', '-l', '-F', '-S', '-J', '-b', '-c', '-D', '-E', '-e',
  '-I', '-L', '-m', '-O', '-Q', '-R', '-W', '-w',
])

let index = 0
while (index < argv.length) {
  const arg = argv[index]!
  if (WITH_VALUE.has(arg)) {
    index += 2
    continue
  }
  if (arg.startsWith('-')) {
    index += 1
    continue
  }
  break
}

const host = argv[index] ?? ''
// ssh joins the remaining arguments with a space and hands the result to the
// login shell. Reproducing that join is the point: it is what makes a quoting
// mistake in the transport visible here instead of on a real server.
const command = argv.slice(index + 1).join(' ')

const root = process.env.FAKE_SSH_ROOT ?? ''
if (!host || !root) {
  process.stderr.write('fake-ssh: no destination\n')
  process.exit(255)
}

const controlFile = join(root, 'control.json')

interface Control {
  down?: string[]
  hang?: string[]
  cut?: string[]
  flaky?: Record<string, number>
}

function control(): Control {
  try {
    return JSON.parse(readFileSync(controlFile, 'utf8')) as Control
  } catch {
    return {}
  }
}

appendFileSync(join(root, 'ssh.log'), `${JSON.stringify({ host, command, argv })}\n`)

function refuse(): never {
  process.stderr.write(`ssh: connect to host ${host} port 22: Connection refused\n`)
  process.exit(255)
}

const state = control()
if ((state.down ?? []).includes(host)) refuse()

// One failure per credit in the control file: the retry path needs a host that
// is down now and up on the next attempt.
const credits = state.flaky?.[host] ?? 0
if (credits > 0) {
  writeFileSync(controlFile, JSON.stringify({ ...state, flaky: { ...state.flaky, [host]: credits - 1 } }))
  refuse()
}

if ((state.hang ?? []).includes(host)) {
  // Accepted, then silence. The caller's own deadline is what must end this.
  Bun.sleepSync(600_000)
  process.exit(255)
}

const home = join(root, 'hosts', host)
if (!existsSync(home)) mkdirSync(home, { recursive: true })
const env = { ...process.env, HOME: home, PWD: home }

if ((state.cut ?? []).includes(host)) {
  // The command runs, and the connection dies with half the reply delivered.
  const result = Bun.spawnSync(['sh', '-c', command], { cwd: home, env, stdout: 'pipe', stderr: 'pipe' })
  const out = Buffer.from(result.stdout)
  process.stdout.write(out.subarray(0, Math.floor(out.length / 2)))
  process.stderr.write('Connection to host closed by remote host.\n')
  process.exit(255)
}

const result = Bun.spawnSync(['sh', '-c', command], {
  cwd: home,
  env,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})
process.exit(result.exitCode ?? 1)
