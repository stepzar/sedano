#!/usr/bin/env bun
/**
 * Failure normalization: what a person is told when something breaks.
 *
 * Two halves, and both are needed.
 *
 * The first drives `describeFailure` with raw reports that were actually
 * observed — the EPIPE stack trace a Node ACP wrapper printed, an uncaught
 * TypeError from `claude-agent-acp`, the transport's own five error kinds, a
 * missing binary, a signed-out CLI, a spent quota — and asserts the headline
 * names the right thing and the raw report survives to the last character.
 *
 * The second runs the real ACP driver against a fake agent that prints those
 * shapes on its stderr, because a classifier that is right in isolation is worth
 * nothing if the driver never hands it the bytes. The fake agent is written into
 * a temporary directory by this file and run with `bun`: no vendor CLI is ever
 * spawned and no host is ever contacted.
 *
 * It also pins the gallery fixtures to the server: every string in
 * `FIXTURE_FAILURES` must be exactly what `formatFailure` produces for its raw
 * input, so the rendering under review cannot drift away from the app.
 *
 *   bun scripts/error-test.ts
 */
import './lib/isolate.ts'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionStatus, TimelineEvent } from '@shared'
import {
  describeFailure,
  formatFailure,
  isCrashReport,
  isStderrChatter,
  type FailureContext,
} from '../apps/server/src/harnesses/types.ts'
import { AcpDriver, type AcpSpec } from '../apps/server/src/harnesses/acp/driver.ts'
import type { CreateOptions, DriverHooks } from '../apps/server/src/harnesses/types.ts'
import { FIXTURE_CHATTER, FIXTURE_FAILURES } from '../apps/ui/src/fixtures.ts'

const passed: string[] = []
const failures: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) passed.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

/* ------------------------------------------------------------------ */
/* The raw reports                                                     */
/* ------------------------------------------------------------------ */

/**
 * The dump that started this work, verbatim.
 *
 * A Node process wrote it: `node:internal/stream_base_commons` and
 * `Socket._writeGeneric` exist in Node and not in Bun, which is the evidence
 * that says this came from a vendor's wrapper and not from this server.
 */
const EPIPE = `Error: write EPIPE
    at afterWriteDispatched (node:internal/stream_base_commons:159:15)
    at writeGeneric (node:internal/stream_base_commons:150:3)
    at Socket._writeGeneric (node:net:966:11)
    at Socket._write (node:net:978:8)
    at writeOrBuffer (node:internal/streams/writable:572:12)
    at _write (node:internal/streams/writable:501:10)
    at Writable.write (node:internal/streams/writable:510:10)
    at process.<anonymous> (file:///opt/homebrew/lib/node_modules/@google/gemini-cli/dist/index.js:41208:22)
    at process.emit (node:events:518:28)
    at emitUnhandledRejectionWarning (node:internal/process/promises:264:13)`

/** An uncaught exception, with the deprecation notice the wrapper printed first. */
const WRAPPER_CRASH = `(node:48221) [DEP0040] DeprecationWarning: The \`punycode\` module is deprecated.
(Use \`node --trace-deprecation ...\` to show where the warning was created)
TypeError: Cannot read properties of undefined (reading 'sessionId')
    at handleSessionUpdate (node:internal/modules/cjs/loader:1241:14)
    at Object.onNotification (/opt/homebrew/lib/node_modules/@zed-industries/claude-code-acp/dist/index.js:912:7)
    at Socket.<anonymous> (node:internal/streams/readable:1010:12)`

/**
 * The transport's error, reproduced rather than imported.
 *
 * `describeFailure` recognises it by its `name` and `kind` on purpose (the
 * harness contract must not depend on the transport for one `instanceof`), so
 * the test builds the same shape and proves the duck-typing is what holds.
 */
class FakeRemoteError extends Error {
  override readonly name = 'RemoteError'
  constructor(
    readonly kind: string,
    readonly host: string | null,
    message: string,
    readonly reason = message,
  ) {
    super(host ? `${host}: ${message}` : message)
  }
}

const ctxGemini: FailureContext = { harness: 'Gemini CLI', bin: '/opt/homebrew/bin/gemini', host: null }
const ctxAcp: FailureContext = { harness: 'Claude Code', bin: '/opt/homebrew/bin/claude-agent-acp', host: null }
const ctxCodexLab: FailureContext = { harness: 'Codex', bin: 'codex', host: 'lab' }
const ctxCodex: FailureContext = { harness: 'Codex', bin: 'codex', host: null }
const ctxGrok: FailureContext = { harness: 'Grok', bin: '/opt/homebrew/bin/grok', host: null }
const ctxClaude: FailureContext = { harness: 'Claude Code', bin: 'claude', host: null }
const ctxOpencode: FailureContext = { harness: 'Opencode', bin: 'opencode', host: null }

/* ------------------------------------------------------------------ */
/* 1. A Node stack trace reads as one explanation plus the whole trace */
/* ------------------------------------------------------------------ */

{
  const failure = describeFailure(EPIPE, ctxGemini)
  const [headline] = formatFailure(EPIPE, ctxGemini).split('\n\n')
  check('a broken pipe is named as a broken pipe', failure.shape === 'broken_pipe', failure.shape)
  check(
    'and it is attributed to the wrapper, because the frames are Node internals',
    failure.origin === 'wrapper' && failure.headline.includes('wrapper'),
    failure,
  )
  check(
    'the headline says it is not the reader’s fault',
    /nothing you typed caused this/i.test(failure.headline),
    failure.headline,
  )
  check('the headline is one paragraph', !headline!.includes('\n'), headline)
  check(
    'the headline names the process it spawned',
    failure.headline.includes('/opt/homebrew/bin/gemini'),
    failure.headline,
  )
  check(
    'every frame of the trace survives into the detail',
    EPIPE.split('\n').every((line) => failure.detail.includes(line.trim())),
    failure.detail.length,
  )
  check(
    'the trace keeps its indentation, so a frame still reads as a frame',
    failure.detail.includes('    at Socket._writeGeneric (node:net:966:11)'),
    failure.detail.slice(0, 200),
  )
  check(
    'the wire form is the headline, a blank line, then the raw report',
    formatFailure(EPIPE, ctxGemini) === `${failure.headline}\n\n${failure.detail}`,
  )
}

{
  const failure = describeFailure(WRAPPER_CRASH, ctxAcp)
  check('an uncaught exception is named as a crash', failure.shape === 'crash', failure.shape)
  check(
    'the headline quotes the exception, not the deprecation notice above it',
    failure.headline.includes("TypeError: Cannot read properties of undefined (reading 'sessionId')") &&
      !failure.headline.includes('punycode'),
    failure.headline,
  )
  check(
    'and the notice is still kept in the detail',
    failure.detail.includes('punycode'),
    failure.detail.slice(0, 120),
  )
  check(
    'the reader is told whose fault it is',
    /not in your prompt/i.test(failure.headline),
    failure.headline,
  )
}

/* ------------------------------------------------------------------ */
/* 2. An SSH failure reads as itself                                   */
/* ------------------------------------------------------------------ */

{
  const cases: Array<[string, string, RegExp]> = [
    ['unreachable', 'ssh: connect to host lab port 22: Operation timed out', /could not reach/i],
    ['timeout', 'no answer within 20s', /did not answer in time/i],
    ['not_found', 'cannot stat /srv/acme-api', /not on that machine/i],
    ['permission', 'Permission denied (publickey)', /permission/i],
    ['command_failed', 'codex exited 3', /failed/i],
  ]
  for (const [kind, message, expected] of cases) {
    const failure = describeFailure(new FakeRemoteError(kind, 'lab', message), ctxCodexLab)
    check(`an ssh ${kind} is recognised as a transport failure`, failure.shape === 'ssh' && failure.origin === 'transport', failure)
    check(`an ssh ${kind} is explained in its own terms`, expected.test(failure.headline), failure.headline)
    check(`an ssh ${kind} names the host`, failure.headline.includes('lab'), failure.headline)
    check(`an ssh ${kind} keeps what ssh said`, failure.detail.includes(message), failure.detail)
  }
  const unreachable = describeFailure(
    new FakeRemoteError('unreachable', 'lab', 'ssh: connect to host lab port 22: Operation timed out'),
    ctxCodexLab,
  )
  check(
    'an unreachable host is never described as the agent failing',
    !/Codex (?:crashed|refused|reported)/.test(unreachable.headline) && /Codex never started there/.test(unreachable.headline),
    unreachable.headline,
  )
  check(
    'and the command it suggests is a command that runs',
    unreachable.headline.includes('`ssh lab`'),
    unreachable.headline,
  )
  check(
    'a transport failure is not confused with a crash even when it carries a trace',
    describeFailure(new FakeRemoteError('unreachable', 'lab', EPIPE), ctxCodexLab).shape === 'ssh',
  )
}

/* ------------------------------------------------------------------ */
/* 3. A missing or signed-out CLI says what to do                      */
/* ------------------------------------------------------------------ */

{
  for (const raw of ['spawn codex ENOENT', 'bash: codex: command not found', '/bin/sh: codex: No such file or directory']) {
    const failure = describeFailure(raw, ctxCodex)
    check(`a missing CLI is recognised (${raw.slice(0, 20)}…)`, failure.shape === 'not_installed', failure.shape)
    check('and it says to install it', /install it/i.test(failure.headline), failure.headline)
    check('and it names the binary that was looked for', failure.headline.includes('`codex`'), failure.headline)
    check('and it names the machine', failure.headline.includes('this machine'), failure.headline)
  }
  const remote = describeFailure('spawn codex ENOENT', { ...ctxCodex, host: 'lab' })
  check('a missing CLI on a host names that host', remote.headline.includes('“lab”'), remote.headline)

  for (const raw of [
    'acp: session/new failed: Authentication required. Please run `grok login` first.',
    'Error: not logged in',
    'HTTP 401 Unauthorized',
  ]) {
    const failure = describeFailure(raw, ctxGrok)
    check(`a signed-out CLI is recognised (${raw.slice(0, 24)}…)`, failure.shape === 'signed_out', failure.shape)
    check('and it says which command signs in', failure.headline.includes('login`'), failure.headline)
  }
  check(
    'signed out and not installed are not the same answer',
    describeFailure('not logged in', ctxGrok).headline !==
      describeFailure('spawn grok ENOENT', ctxGrok).headline,
  )
}

/* ------------------------------------------------------------------ */
/* 4. A spent quota, and an unknown that stays unknown                 */
/* ------------------------------------------------------------------ */

{
  const quota = describeFailure('API error 429: rate limit exceeded for organisation org_4f21 (requests per minute)', ctxClaude)
  check('a spent quota is recognised', quota.shape === 'quota', quota.shape)
  check('and it says the session is fine', /session is fine/i.test(quota.headline), quota.headline)
  check(
    'and it invents no reset time',
    !/\b\d+\s*(?:minute|hour|second)/i.test(quota.headline),
    quota.headline,
  )

  const unknown = describeFailure('glorp subsystem returned status BLEEM', ctxOpencode)
  check('an unrecognised failure says so rather than guessing', unknown.shape === 'unknown', unknown.shape)
  check(
    'and it admits it did not recognise the report',
    /does not recognise/i.test(unknown.headline),
    unknown.headline,
  )
  check('and it still carries the report', unknown.detail === 'glorp subsystem returned status BLEEM', unknown.detail)
  check(
    'nothing is ever reduced to [object Object]',
    !formatFailure({ weird: true, nested: { x: 1 } }, ctxOpencode).includes('[object Object]'),
    formatFailure({ weird: true, nested: { x: 1 } }, ctxOpencode),
  )
  check(
    'an empty report is a headline on its own, not a dangling separator',
    !formatFailure('', ctxOpencode).includes('\n\n'),
    formatFailure('', ctxOpencode),
  )
}

/* ------------------------------------------------------------------ */
/* 5. Chatter is not a failure, and a failure is not chatter           */
/* ------------------------------------------------------------------ */

{
  for (const line of FIXTURE_CHATTER) {
    check(`chatter is recognised as chatter: ${line.slice(0, 34)}…`, isStderrChatter(line), line)
    check(`and chatter is never a crash report: ${line.slice(0, 20)}…`, !isCrashReport(line), line)
  }
  for (const line of [
    '(node:1) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.',
    'npm notice New major version of npm available!',
    'info  resolving plugins',
    '  ⠋ 42% downloading model',
  ]) {
    check(`more chatter, recognised: ${line.slice(0, 30)}…`, isStderrChatter(line), line)
  }
  for (const line of ['Error: write EPIPE', 'TypeError: x is not a function', 'Authentication required']) {
    check(`a real failure line is never chatter: ${line}`, !isStderrChatter(line), line)
  }
  check('a whole stack trace is a crash report', isCrashReport(EPIPE))
  check('and so is an uncaught exception under chatter', isCrashReport(WRAPPER_CRASH))
  check(
    'a log line that merely says "error" is not a crash report',
    !isCrashReport('warn: error rate is high, retrying'),
  )
  check(
    'and neither is a whole buffer of chatter',
    !isCrashReport(FIXTURE_CHATTER.join('\n')),
  )
}

/* ------------------------------------------------------------------ */
/* 6. The gallery shows what the app says                              */
/* ------------------------------------------------------------------ */

{
  const expected: Array<[keyof typeof FIXTURE_FAILURES, unknown, FailureContext]> = [
    ['err-broken-pipe', EPIPE, ctxGemini],
    ['err-crash', WRAPPER_CRASH, ctxAcp],
    [
      'err-ssh',
      new FakeRemoteError('unreachable', 'lab', 'ssh: connect to host lab port 22: Operation timed out'),
      ctxCodexLab,
    ],
    ['err-not-installed', 'spawn codex ENOENT', ctxCodex],
    ['err-signed-out', 'acp: session/new failed: Authentication required. Please run `grok login` first.', ctxGrok],
    ['err-quota', 'API error 429: rate limit exceeded for organisation org_4f21 (requests per minute)', ctxClaude],
    ['err-unknown', 'glorp subsystem returned status BLEEM', ctxOpencode],
  ]
  for (const [id, raw, ctx] of expected) {
    check(`the gallery fixture ${id} is exactly what the server writes`, FIXTURE_FAILURES[id] === formatFailure(raw, ctx), {
      fixture: FIXTURE_FAILURES[id].slice(0, 90),
      server: formatFailure(raw, ctx).slice(0, 90),
    })
    check(`and ${id} has a detail for the UI to hide`, FIXTURE_FAILURES[id].includes('\n\n'))
  }
}

/* ------------------------------------------------------------------ */
/* 7. The driver actually hands those bytes over                       */
/* ------------------------------------------------------------------ */

interface Recorder extends DriverHooks {
  events: TimelineEvent[]
  errors: string[]
  statuses: SessionStatus[]
}

function recorder(): Recorder {
  const rec: Recorder = {
    events: [],
    errors: [],
    statuses: [],
    event: (ev) => rec.events.push(ev),
    delta: () => undefined,
    status: (status) => rec.statuses.push(status),
    model: () => undefined,
    usage: () => undefined,
    tokens: () => undefined,
    nativeId: () => undefined,
    resumeHint: () => undefined,
    title: () => undefined,
    error: (message) => rec.errors.push(message),
    turnStarted: () => undefined,
    terminal: () => undefined,
    meta: () => undefined,
    limits: () => undefined,
  }
  return rec
}

function options(cwd: string): CreateOptions {
  return {
    sessionId: 'error-test',
    nativeId: null,
    cwd,
    host: null,
    model: null,
    effort: null,
    permissionMode: 'default',
  }
}

async function waitFor(what: string, until: () => boolean, ms = 6000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (until()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/**
 * An ACP agent that handshakes and then misbehaves on stderr, the way the real
 * Node wrappers do. `FAKE_MODE` picks which misbehaviour.
 *
 *   chatter   → print only deprecation notices and npm noise, then answer normally
 *   crash     → print chatter, then an EPIPE stack trace in three chunks, and
 *               never answer. The third chunk lands well after the trace has
 *               been reported, which is what makes "reported exactly once" a
 *               claim that can fail.
 *   exit      → print chatter and walk out with a non-zero code mid-turn
 *   idle-exit → walk out with a non-zero code with no turn running at all,
 *               which is the case nothing else in the driver notices
 */
const AGENT = `
const MODE = process.env.FAKE_MODE ?? 'chatter'
const CHATTER = ${JSON.stringify(FIXTURE_CHATTER)}
const EPIPE = ${JSON.stringify(EPIPE)}
let buffer = ''
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let at = buffer.indexOf('\\n')
  while (at !== -1) {
    const line = buffer.slice(0, at).trim()
    buffer = buffer.slice(at + 1)
    if (line) handle(JSON.parse(line))
    at = buffer.indexOf('\\n')
  }
})
function handle(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } })
    // Chatter arrives before anything else, exactly as a Node CLI prints it.
    for (const line of CHATTER) process.stderr.write(line + '\\n')
    return
  }
  if (msg.method === 'session/new') {
    send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'fake-session' } })
    if (MODE === 'idle-exit') {
      process.stderr.write('shutting down: the wrapper lost its upstream\\n')
      setTimeout(() => process.exit(9), 60)
    }
    return
  }
  if (msg.method === 'session/prompt') {
    if (MODE === 'crash') {
      // Three writes: two close together, so the driver has to reassemble the
      // trace across chunks, and one long after the report has gone out, so a
      // driver that forgot it had already reported would report again.
      const lines = EPIPE.split('\\n')
      process.stderr.write(lines.slice(0, 3).join('\\n') + '\\n')
      setTimeout(() => process.stderr.write(lines.slice(3).join('\\n') + '\\n'), 30)
      setTimeout(() => process.stderr.write('    at aLateFrame (node:internal/timers:512:7)\\n'), 500)
      return
    }
    if (MODE === 'exit') {
      process.stderr.write('some final words\\n')
      setTimeout(() => process.exit(7), 20)
      return
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } })
    return
  }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: {} })
}
`

const workdir = mkdtempSync(join(tmpdir(), 'sedano-error-'))
const agentPath = join(workdir, 'agent.mjs')
writeFileSync(agentPath, AGENT)
const bun = process.execPath

function specFor(mode: string): AcpSpec {
  return { id: 'opencode', args: [agentPath], models: [], env: { FAKE_MODE: mode } }
}

try {
  /* --- chatter must not become a red card --- */
  {
    const hooks = recorder()
    const driver = new AcpDriver(options(workdir), hooks, specFor('chatter'), bun)
    await driver.start()
    driver.send('hello')
    await waitFor('the turn to finish', () => hooks.statuses.includes('idle') && hooks.events.some((ev) => ev.k === 'result'))
    // Long enough that a crash debounce would have fired if one had been armed.
    await new Promise((resolve) => setTimeout(resolve, 400))
    check('three lines of stderr chatter produce no error at all', hooks.errors.length === 0, hooks.errors)
    check('and no error event reaches the timeline', !hooks.events.some((ev) => ev.k === 'error'), hooks.events.map((ev) => ev.k))
    check('and the turn still finished normally', hooks.statuses.includes('idle'), hooks.statuses)
    driver.stop()
  }

  /* --- a Node stack trace on stderr becomes exactly one readable failure --- */
  {
    const hooks = recorder()
    const driver = new AcpDriver(options(workdir), hooks, specFor('crash'), bun)
    await driver.start()
    driver.send('hello')
    await waitFor('the crash to be reported', () => hooks.errors.length > 0)
    // Long enough for the late frame (500ms) and its debounce to have gone by:
    // "exactly once" is only a claim if a second report had the chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 900))
    const reported = hooks.errors[0] ?? ''
    const [headline, ...rest] = reported.split('\n\n')
    const detail = rest.join('\n\n')
    check('a wrapper crash on stderr is reported exactly once', hooks.errors.length === 1, hooks.errors.length)
    check('the headline is one paragraph of plain language', !headline!.includes('\n') && headline!.length > 40, headline)
    check('it says a broken pipe, in words', /broken pipe/i.test(headline!), headline)
    check("it attributes the crash to the agent's own wrapper", /wrapper/i.test(headline!), headline)
    check(
      'the whole trace is kept, reassembled across the two writes it arrived in',
      EPIPE.split('\n').every((line) => detail.includes(line)),
      detail,
    )
    check(
      'the chatter printed before the crash is kept with it, not discarded',
      FIXTURE_CHATTER.every((line) => detail.includes(line)),
      detail,
    )
    check('and the raw trace is never in the headline', !headline!.includes('    at '), headline)
    driver.stop()
  }

  /* --- an agent that walks out mid-turn is never silent --- */
  {
    const hooks = recorder()
    const driver = new AcpDriver(options(workdir), hooks, specFor('exit'), bun)
    await driver.start()
    driver.send('hello')
    await waitFor('the exit to be reported', () => hooks.errors.length > 0)
    const reported = hooks.errors.find((message) => message.includes('exited')) ?? ''
    check('an agent that exits mid-turn produces an error, not only a grey note', Boolean(reported), hooks.errors)
    check('the exit code is in the headline', /code 7/.test(reported.split('\n\n')[0] ?? ''), reported)
    check('and what it printed on the way out is kept', reported.includes('some final words'), reported)
    check(
      'the session is left in the error state, not idle',
      hooks.statuses[hooks.statuses.length - 1] === 'error',
      hooks.statuses,
    )
    driver.stop()
  }

  /* --- an agent that dies while idle is the case nothing else catches --- */
  {
    // No turn is in flight, so there is no pending request to reject and no
    // prompt to fail: before this, the whole event was a grey "stopped (exit 9)"
    // note folded into the transcript, and everything the process printed on its
    // way out was thrown away.
    const hooks = recorder()
    const driver = new AcpDriver(options(workdir), hooks, specFor('idle-exit'), bun)
    await driver.start()
    await waitFor('the exit to be reported', () => hooks.errors.length > 0)
    const reported = hooks.errors[0] ?? ''
    const [headline, ...rest] = reported.split('\n\n')
    check('an agent that dies while idle is reported as a failure', hooks.errors.length === 1, hooks.errors)
    check('the headline says it stopped on its own and gives the code', /stopped on its own/.test(headline!) && /code 9/.test(headline!), headline)
    check('and it still says what to do next', /send your message again/i.test(headline!), headline)
    check('and what it printed is kept', rest.join('\n\n').includes('the wrapper lost its upstream'), reported)
    check(
      'the grey note is still there too, because the session did stop',
      hooks.events.some((ev) => ev.k === 'system' && ev.subtype === 'agent-exit'),
      hooks.events.map((ev) => ev.k),
    )
    driver.stop()
  }
} finally {
  rmSync(workdir, { recursive: true, force: true })
}

/* ------------------------------------------------------------------ */

for (const label of passed) console.log(`   ✓ ${label}`)
for (const label of failures) console.log(`   ✗ ${label}`)
if (failures.length) {
  console.log(`error-test: FAILED (${failures.length}/${passed.length + failures.length})`)
  process.exit(1)
}
console.log(`error-test: PASSED (${passed.length} checks)`)
