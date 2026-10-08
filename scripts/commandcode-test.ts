#!/usr/bin/env bun
/**
 * The Command Code driver, against a fake `cmd` that replays the real NDJSON
 * frame shapes. No quota is spent and the parsing, ordering and resume logic are
 * all exercised: a text turn, a tool call, usage, and `--resume` on the next one.
 */
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionStatus, TimelineEvent, TokenUsage } from '@shared'
import { CommandCodeDriver, resumeCommand } from '../apps/server/src/harnesses/commandcode/session.ts'
import type { CreateOptions, DriverHooks } from '../apps/server/src/harnesses/types.ts'

const failures: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) return
  failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

interface Collected {
  events: TimelineEvent[]
  usage: { usage: TokenUsage; commitTurn: boolean }[]
  statuses: SessionStatus[]
  models: string[]
  nativeId: string | null
  resumeHint: string | null
  errors: string[]
}

function makeHooks(collected: Collected): DriverHooks {
  return {
    event: (ev) => collected.events.push(ev),
    delta: () => undefined,
    status: (status) => collected.statuses.push(status),
    model: (model) => collected.models.push(model),
    usage: (usage, opts) =>
      collected.usage.push({
        usage: {
          input: usage.input ?? 0,
          output: usage.output ?? 0,
          cacheRead: usage.cacheRead ?? 0,
          cacheWrite: usage.cacheWrite ?? 0,
          reasoning: usage.reasoning ?? 0,
        },
        commitTurn: Boolean(opts?.commitTurn),
      }),
    tokens: () => undefined,
    nativeId: (id) => {
      collected.nativeId = id
    },
    resumeHint: (hint) => {
      collected.resumeHint = hint
    },
    title: () => undefined,
    error: (message) => collected.errors.push(message),
    turnStarted: () => undefined,
    terminal: () => undefined,
    meta: () => undefined,
    limits: () => undefined,
  }
}

function emptyCollected(): Collected {
  return { events: [], usage: [], statuses: [], models: [], nativeId: null, resumeHint: null, errors: [] }
}

const waitFor = (predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> =>
  new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (predicate()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`))
      setTimeout(tick, 40)
    }
    tick()
  })

const dir = mkdtempSync(join(tmpdir(), 'sedano-fake-cmd-'))
const bin = join(dir, 'cmd')
writeFileSync(bin, readFileSync(join(import.meta.dir, 'fixtures', 'fake-cmd.ts')))
chmodSync(bin, 0o755)

function options(overrides: Partial<CreateOptions> = {}): CreateOptions {
  return {
    sessionId: 's1',
    nativeId: null,
    cwd: dir,
    host: null,
    model: null,
    effort: null,
    permissionMode: 'acceptEdits',
    ...overrides,
  }
}

/* ------------------------------- first turn ------------------------------- */

const first = emptyCollected()
const driver = new CommandCodeDriver(options(), makeHooks(first), bin)
const firstDelivery = await driver.send('do a thing')
check('a launched Command Code prompt reports confirmed delivery', firstDelivery.status === 'delivered', firstDelivery)
await waitFor(() => first.events.some((ev) => ev.k === 'result'), 'the first turn to finish')
// The result is the content boundary. A durable Command Code turn becomes idle
// only after its detached wrapper has really exited; otherwise a second prompt
// can enter the small gap and look finished while it is only queued.
await waitFor(() => first.statuses[first.statuses.length - 1] === 'idle', 'the first wrapper to exit')

const kinds = first.events.map((ev) => ev.k)
check('the driver does not duplicate the user event owned by the manager', !kinds.includes('user'), kinds)
check('thinking is committed as an event', kinds.includes('thinking'), kinds)
const answers = first.events.filter((ev) => ev.k === 'assistant')
check('the answer is committed exactly once', answers.length === 1, answers)
check('the answer is whole', answers[0]?.k === 'assistant' && answers[0].text === 'Hello world', answers[0])
check(
  'the answer comes before the tool call',
  kinds.indexOf('assistant') < kinds.indexOf('tool'),
  kinds,
)
check('a tool call becomes a tool event', kinds.includes('tool'), kinds)
check('the tool result is kept', kinds.includes('tool_result'), kinds)
check('the turn ends with a result', kinds[kinds.length - 1] === 'result', kinds)
check('the session id is learned from the stream', first.nativeId === 'fake-session-0001', first.nativeId)
check('a resume hint is exposed', typeof first.resumeHint === 'string' && first.resumeHint.includes('--resume'), first.resumeHint)
check('the model is reported', first.models.includes('fake/model'), first.models)
check(
  'the answer is labelled with the model that ran, not the one asked for',
  answers[0]?.k === 'assistant' && answers[0].model === 'fake/model',
  answers[0],
)
check('usage is committed for the turn', first.usage.some((u) => u.commitTurn), first.usage)
check('usage carries the real numbers', first.usage[0]?.usage.output === 3, first.usage[0])
check('the turn ends idle', first.statuses[first.statuses.length - 1] === 'idle', first.statuses)
check('nothing errored', first.errors.length === 0, first.errors)
driver.stop()
const refusedAfterStop = await driver.send('after stop')
check('a stopped Command Code driver explicitly refuses a prompt', refusedAfterStop.status === 'refused', refusedAfterStop)

/* ------------------------------- resume turn ------------------------------ */

const second = emptyCollected()
const resumed = new CommandCodeDriver(options({ nativeId: 'existing-123' }), makeHooks(second), bin)
resumed.send('continue')
await waitFor(() => second.events.some((ev) => ev.k === 'result'), 'the resumed turn to finish')
const argvEvent = second.events.find((ev) => ev.k === 'tool') as { input?: { args?: string[] } } | undefined
const argv = argvEvent?.input?.args ?? []
check('a resumed turn passes --resume <id>', argv.includes('--resume') && argv[argv.indexOf('--resume') + 1] === 'existing-123', argv)
check('the JSON output mode is requested', argv.includes('--output-format') && argv[argv.indexOf('--output-format') + 1] === 'json', argv)
check('acceptEdits maps to auto-accept', argv.includes('--permission-mode') && argv[argv.indexOf('--permission-mode') + 1] === 'auto-accept', argv)
resumed.stop()

/* -------------------------- interrupt a stuck turn ------------------------ */

const stuck = emptyCollected()
const hanging = new CommandCodeDriver(options(), makeHooks(stuck), bin)
hanging.send('hang')
// Wait for the process to announce itself, not merely for the turn to start: an
// interrupt that lands before the fake CLI has armed itself is a kill, and a
// kill is the case the driver always handled. The hang is what is under test.
await waitFor(() => stuck.nativeId === 'fake-session-0001', 'the stuck process to arm itself')
const askedAt = Date.now()
hanging.interrupt()
await waitFor(
  () => ['idle', 'error', 'stopped'].includes(stuck.statuses[stuck.statuses.length - 1] ?? ''),
  'the interrupt to end the stuck turn',
)
check(
  'an interrupt ends a turn whose process refuses to die',
  Date.now() - askedAt < 1500,
  `${Date.now() - askedAt}ms`,
)
check(
  'the interrupted turn is reported as cancelled',
  stuck.events.some((ev) => ev.k === 'result' && ev.subtype === 'cancelled'),
  stuck.events.map((ev) => ev.k),
)
check('the stuck turn ends idle', stuck.statuses[stuck.statuses.length - 1] === 'idle', stuck.statuses)
check('an interrupted turn is not an error', stuck.errors.length === 0, stuck.errors)
check('nothing is committed as an answer', !stuck.events.some((ev) => ev.k === 'assistant'), stuck.events)

/* ------------------------- native turn boundaries ------------------------- */

const rounds = emptyCollected()
const twoTurns = new CommandCodeDriver(options(), makeHooks(rounds), bin)
twoTurns.send('two turns')
await waitFor(() => rounds.events.some((ev) => ev.k === 'result'), 'the two-round run to finish')
const roundKinds = rounds.events.map((ev) => ev.k)
const roundAnswers = rounds.events.filter((ev) => ev.k === 'assistant')
check(
  'each native turn commits its own answer',
  roundAnswers.length === 2 && roundAnswers[0]?.k === 'assistant' && roundAnswers[0].text === 'First round.',
  roundAnswers,
)
check(
  'and the two rounds are not merged into one answer',
  roundAnswers[1]?.k === 'assistant' && roundAnswers[1].text === 'Second round.',
  roundAnswers,
)
check(
  'the answers are committed after the tool call that separated them',
  roundKinds.indexOf('tool_result') < roundKinds.lastIndexOf('assistant'),
  roundKinds,
)
check(
  "the run's own stop reason is kept when it is not a plain end",
  rounds.events.some((ev) => ev.k === 'result' && ev.subtype === 'max_tokens'),
  rounds.events.filter((ev) => ev.k === 'result'),
)
twoTurns.stop()

/* --------------------- structured errors and boundaries ------------------- */

const broken = emptyCollected()
const failing = new CommandCodeDriver(options(), makeHooks(broken), bin)
failing.send('boom')
await waitFor(() => broken.events.some((ev) => ev.k === 'result'), 'the failing turn to finish')

const toolResult = broken.events.find((ev) => ev.k === 'tool_result')
check(
  'a failed tool call is reported as failed',
  toolResult?.k === 'tool_result' && toolResult.isError,
  toolResult,
)
check(
  'and its structured error is kept, not flattened',
  toolResult?.k === 'tool_result' && toolResult.text.includes('command failed with exit 1') && toolResult.text.includes('ETOOL'),
  toolResult,
)
const failedResult = broken.events.find((ev) => ev.k === 'result')
check(
  'the run error keeps its own message',
  failedResult?.k === 'result' && failedResult.text.includes('the run gave up'),
  failedResult,
)
check(
  'a structured error never reaches a person as [object Object]',
  !broken.errors.some((message) => message.includes('[object Object]')) &&
    !JSON.stringify(broken.events).includes('[object Object]'),
  broken.errors,
)
check('a failed run is reported as an error', broken.errors.length > 0, broken.errors)
check('and leaves the session in error', broken.statuses[broken.statuses.length - 1] === 'error', broken.statuses)
failing.stop()

/* ----------------------------- resume hint -------------------------------- */

// Asked of the pure builder: a hermetic test must not open an ssh connection,
// and an alias nobody enabled is refused by the transport before it tries.
const remoteHint = resumeCommand(dir, 'abc-123', 'example-host')
check(
  'a remote session resumes on the machine it ran on',
  remoteHint.startsWith('ssh example-host ') && remoteHint.includes('--resume abc-123') && remoteHint.includes(dir),
  remoteHint,
)
check(
  'and the remote command is quoted as one command',
  remoteHint === `ssh example-host 'cd ${dir} && cmd --resume abc-123'`,
  remoteHint,
)
check(
  'a local session resumes with a plain command',
  first.resumeHint === `cd ${dir} && cmd --resume fake-session-0001`,
  first.resumeHint,
)

/* ---------------------- interrupt with no process at all ------------------ */

const idle = emptyCollected()
const quiet = new CommandCodeDriver(options(), makeHooks(idle), bin)
quiet.interrupt()
await new Promise((resolve) => setTimeout(resolve, 100))
check('an interrupt with nothing running is harmless', idle.statuses.length === 0, idle.statuses)

if (failures.length) {
  console.error('--- failed checks ---')
  for (const failure of failures) console.error(`✗ ${failure}`)
  console.error('commandcode-test: FAILED')
  process.exit(1)
}
console.log('commandcode-test: PASSED')
