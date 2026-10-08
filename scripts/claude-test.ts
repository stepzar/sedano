#!/usr/bin/env bun
/**
 * Claude Code driver test.
 *
 * Drives `ClaudeDriver` against a fake `claude` that speaks the real
 * `stream-json` control protocol: `control_request` / `control_response`,
 * `can_use_tool` permissions, the structured `AskUserQuestion` tool, and a
 * `result` frame. No vendor CLI is started, no subscription is touched, and
 * `CLAUDE_CONFIG_DIR` is pointed at a temporary directory so the person's own
 * transcripts are neither read nor written.
 *
 * What it is here to prove is the part that is invisible until it breaks: the
 * CLI blocks on every control request until an answer comes back, so a request
 * this client does not recognise must still be answered, and a permission mode
 * must approve only what it says it approves.
 *
 *   bun scripts/claude-test.ts
 */
// First, before anything can open the real store: the driver now keeps a note
// per durable session under `SEDANO_HOME`, and a test must write those into a
// scratch directory rather than into the operator's own `~/.sedano`.
import './lib/isolate.ts'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'sedano-claude-home-'))
// Set before the driver is imported: the config root is read from here, and a
// test must never tail the transcripts of a real session.
process.env.CLAUDE_CONFIG_DIR = home

const { ClaudeDriver } = await import('../apps/server/src/harnesses/claude/session.ts')
const workdir = mkdtempSync(join(tmpdir(), 'sedano-claude-'))
const logPath = join(workdir, 'stdin.log')

const passed: string[] = []
const failures: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) passed.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

/* ------------------------------------------------------------------ */
/* The fake CLI                                                        */
/* ------------------------------------------------------------------ */

/**
 * Written to disk rather than kept in this process: the driver spawns a binary,
 * and the point is to exercise the real pipes it writes its answers into.
 *
 * Every line it receives is appended to a log, which is how the test can assert
 * on answers that never reach the timeline — an "unsupported" control response
 * has no event of its own, and that is exactly the one that must be sent.
 */
const FAKE_CLI = `#!/usr/bin/env bun
import { appendFileSync, readSync } from 'node:fs'

const log = process.env.FAKE_CLAUDE_LOG
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n')
const request = (id, body) => emit({ type: 'control_request', request_id: id, request: body })
/** Work the fake wants to do after the next inbound line (see the read loop). */
const deferred = []

emit({
  type: 'system',
  subtype: 'init',
  // A dated id, not the alias the session was started with: this is what the
  // runtime resolves \`--model sonnet\` to.
  model: 'claude-sonnet-4-5-20250929',
  permissionMode: process.argv.includes('--permission-mode')
    ? process.argv[process.argv.indexOf('--permission-mode') + 1]
    : 'bypass',
})

// A blocking read loop, and not \`process.stdin.on('data')\`, because the driver
// now runs its CLI detached with a fifo for stdin (see \`durableLaunch\`): the fd
// this process inherits is an ordinary blocking pipe, and Bun 1.2.2 delivers
// nothing from one of those until it reaches EOF — which, by design, this one
// never does. \`readSync\` gets every line the moment it is written, which is
// what a CLI that answers control requests has to do.
let buffer = ''
const chunk = Buffer.alloc(65536)
for (;;) {
  let read = 0
  try {
    read = readSync(0, chunk, 0, chunk.length, null)
  } catch {
    break
  }
  if (read === 0) break
  buffer += chunk.subarray(0, read).toString('utf8')
  let index = buffer.indexOf('\\n')
  while (index !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) handle(line)
    index = buffer.indexOf('\\n')
  }
  // Nothing scheduled with \`setTimeout\` can run while this loop owns the thread,
  // so anything deferred is drained here instead: the point of the delay is that
  // it happens after the answer, not that a timer measured it.
  while (deferred.length) deferred.shift()()
}
process.exit(0)

function handle(line) {
  if (log) appendFileSync(log, line + '\\n')
  let rec
  try {
    rec = JSON.parse(line)
  } catch {
    return
  }
  if (rec.type !== 'user') return
  const text = (rec.message?.content ?? []).map((block) => block.text ?? '').join(' ')

  if (text.includes('wake')) {
    // A cycle, then the CLI carrying on by itself (a background agent came
    // back): output after the result with nothing sent.
    emit({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 529, error: 'overloaded' })
    emit({ type: 'result', subtype: 'success', is_error: false, result: 'first reply', duration_ms: 5, usage: { input_tokens: 1, output_tokens: 1 } })
    deferred.push(() => finish())
    return
  }
  if (text.includes('unknown control')) {
    // A subtype this client does not implement. The CLI waits for an answer.
    request('req-unknown', { subtype: 'hook_callback', callback_id: 'h1' })
    deferred.push(() => finish())
    return
  }
  if (text.includes('shell')) {
    request('req-bash', { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf /tmp/x' } })
    return
  }
  if (text.includes('edit outside')) {
    request('req-edit-out', { subtype: 'can_use_tool', tool_name: 'Edit', input: { file_path: '/etc/sedano-x.ts' } })
    return
  }
  if (text.includes('edit')) {
    request('req-edit', { subtype: 'can_use_tool', tool_name: 'Edit', input: { file_path: process.cwd() + '/src/x.ts' } })
    return
  }
  if (text.includes('question')) {
    request('req-ask', {
      subtype: 'can_use_tool',
      tool_name: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'How should I format the output?',
            header: 'Format',
            multiSelect: false,
            options: [
              { label: 'Summary', description: 'Brief overview of key points' },
              { label: 'Detailed', description: 'Full explanation with examples' },
            ],
          },
          {
            question: 'Which sections should I include?',
            header: 'Sections',
            multiSelect: true,
            options: [
              { label: 'Introduction', description: 'Opening context' },
              { label: 'Conclusion', description: 'Final summary' },
            ],
          },
        ],
      },
    })
    return
  }
  finish()
}

function finish() {
  emit({
    type: 'assistant',
    message: { role: 'assistant', model: 'claude-sonnet-4-5-20250929', usage: { input_tokens: 10, output_tokens: 4 } },
  })
  emit({ type: 'result', subtype: 'success', is_error: false, result: '', duration_ms: 5, usage: { input_tokens: 10, output_tokens: 4 } })
}
`

const script = join(workdir, 'fake-claude.ts')
writeFileSync(script, FAKE_CLI)
// The driver spawns a binary and appends its own flags, so the stand-in has to
// be a binary too: a one-line launcher that hands everything to the fake.
const bin = join(workdir, 'claude')
writeFileSync(bin, `#!/bin/sh\nexec ${JSON.stringify(Bun.which('bun') ?? process.execPath)} ${JSON.stringify(script)} "$@"\n`)
chmodSync(bin, 0o755)

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

type Ev = import('@shared').TimelineEvent
type Hooks = import('../apps/server/src/harnesses/types.ts').DriverHooks
type Opts = import('../apps/server/src/harnesses/types.ts').CreateOptions

interface Recorder extends Hooks {
  events: Ev[]
  models: string[]
  statuses: string[]
  errors: string[]
}

function recorder(): Recorder {
  const rec = {
    events: [] as Ev[],
    models: [] as string[],
    statuses: [] as string[],
    errors: [] as string[],
    event: (ev: Ev) => rec.events.push(ev),
    delta: () => undefined,
    status: (status: string) => rec.statuses.push(status),
    model: (model: string) => rec.models.push(model),
    usage: () => undefined,
    tokens: () => undefined,
    nativeId: () => undefined,
    resumeHint: () => undefined,
    title: () => undefined,
    error: (message: string) => rec.errors.push(message),
    turnStarted: () => undefined,
    terminal: () => undefined,
    meta: () => undefined,
    limits: () => undefined,
  }
  return rec as unknown as Recorder
}

function options(patch: Partial<Opts> = {}): Opts {
  return {
    sessionId: 'claude-test',
    nativeId: null,
    cwd: workdir,
    host: null,
    // An alias on purpose: nothing may be derived from it (see the model check).
    model: 'sonnet',
    effort: null,
    permissionMode: 'default',
    ...patch,
  }
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 15_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}

/** Every line the fake CLI has been sent so far, parsed. */
function sent(): Array<Record<string, any>> {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, any>]
      } catch {
        return []
      }
    })
}

function responseTo(requestId: string): Record<string, any> | undefined {
  return sent().find(
    (rec) => rec.type === 'control_response' && rec.response?.request_id === requestId,
  )
}

// Every spawn logs what it was sent here.
process.env.FAKE_CLAUDE_LOG = logPath

async function main(): Promise<void> {
  /* ---------------- every control request is answered ---------------- */

  {
    const hooks = recorder()
    const driver = new ClaudeDriver(options(), hooks, bin)
    await driver.start()
    const delivery = await driver.send('unknown control')
    check('a FIFO write reports confirmed Claude delivery', delivery.status === 'delivered', delivery)
    await waitFor('the answer to the unrecognised control request', () => responseTo('req-unknown') !== undefined)
    const answer = responseTo('req-unknown')
    check('an unrecognised control_request is still answered', answer !== undefined, sent())
    check(
      'and it is answered as unsupported, not as a success',
      answer?.response?.subtype === 'error' && String(answer?.response?.error).includes('hook_callback'),
      answer,
    )
    driver.stop()
    const refused = await driver.send('after stop')
    check('a stopped Claude driver explicitly refuses a prompt', refused.status === 'refused', refused)
  }

  /* ---------------- a cycle the CLI starts by itself ---------------- */

  {
    const hooks = recorder()
    const driver = new ClaudeDriver(options(), hooks, bin)
    await driver.start()
    await driver.send('wake up later')
    await waitFor('both cycles', () => hooks.events.filter((ev) => ev.k === 'result').length >= 2)
    const tail = hooks.statuses.slice(-4).join(',')
    check('output after the result is reported as a new running cycle', tail === 'running,idle,running,idle', hooks.statuses)
    const first = hooks.events.find((ev) => ev.k === 'result')
    check('a successful result keeps the reply text', first?.k === 'result' && first.reply === 'first reply' && first.text === '', first)
    const retry = hooks.events.find((ev) => ev.k === 'system' && ev.subtype === 'api_retry')
    check(
      'a live API retry is shown with its attempt and status',
      retry?.k === 'system' && retry.detail?.attempt === 1 && retry.detail?.status === 529 && /retry 1\/10/.test(retry.text),
      retry,
    )
    driver.stop()
  }

  /* ---------------- the model is the one the CLI reported ---------------- */

  {
    const hooks = recorder()
    const driver = new ClaudeDriver(options({ model: 'sonnet' }), hooks, bin)
    await driver.start()
    await waitFor('the init frame', () => hooks.models.length > 0)
    check(
      'the model published is the resolved one, not the alias asked for',
      hooks.models.every((model) => model !== 'sonnet') && hooks.models.includes('claude-sonnet-4-5-20250929'),
      hooks.models,
    )
    driver.stop()
  }

  /* ---------------- acceptEdits accepts edits, and only edits ---------------- */

  {
    const hooks = recorder()
    const driver = new ClaudeDriver(options({ permissionMode: 'acceptEdits' }), hooks, bin)
    await driver.start()
    driver.send('shell please')
    await waitFor(
      'the shell permission to become a question',
      () => hooks.events.some((ev) => ev.k === 'request' && ev.kind === 'permission'),
    )
    check('acceptEdits does not auto-approve a shell tool', responseTo('req-bash') === undefined, sent())
    const card = hooks.events.find((ev) => ev.k === 'request' && ev.kind === 'permission') as
      | Extract<import('@shared').TimelineEvent, { k: 'request' }>
      | undefined
    check('it is put to the person as a native request', card?.title === 'Run Bash?', card)
    check('the permission is not disguised as a tool', !hooks.events.some((ev) => ev.k === 'tool' && ev.name === 'AskUserQuestion'))
    driver.answerQuestion(card!.requestId, 'Deny')
    await waitFor('the denial to reach the CLI', () => responseTo('req-bash') !== undefined)
    check(
      'and the answer is the person’s, not the mode’s',
      responseTo('req-bash')?.response?.response?.behavior === 'deny',
      responseTo('req-bash'),
    )
    driver.stop()
  }

  {
    const hooks = recorder()
    const driver = new ClaudeDriver(options({ permissionMode: 'acceptEdits' }), hooks, bin)
    await driver.start()
    driver.send('edit something')
    await waitFor('the edit to be approved', () => responseTo('req-edit') !== undefined)
    check(
      'acceptEdits does auto-approve a file edit',
      responseTo('req-edit')?.response?.response?.behavior === 'allow',
      responseTo('req-edit'),
    )
    check(
      'and it asks nobody about it',
      !hooks.events.some((ev) => ev.k === 'request'),
      hooks.events.map((ev) => ev.k),
    )
    driver.stop()
  }

  {
    const hooks = recorder()
    const driver = new ClaudeDriver(options({ permissionMode: 'acceptEdits' }), hooks, bin)
    await driver.start()
    driver.send('edit outside the workspace')
    await waitFor(
      'the outside edit to become a question',
      () => hooks.events.some((ev) => ev.k === 'request' && ev.kind === 'permission'),
    )
    check('acceptEdits does not auto-approve an edit outside the workspace', responseTo('req-edit-out') === undefined, sent())
    const card = hooks.events.find((ev) => ev.k === 'request' && ev.kind === 'permission') as
      | Extract<import('@shared').TimelineEvent, { k: 'request' }>
      | undefined
    check('the card names the file', card?.detail?.includes('/etc/sedano-x.ts') === true, card)
    driver.answerQuestion(card!.requestId, 'Deny')
    await waitFor('the denial to reach the CLI', () => responseTo('req-edit-out') !== undefined)
    driver.stop()
  }

  /* ---------------- AskUserQuestion keeps its structure ---------------- */

  {
    const hooks = recorder()
    const driver = new ClaudeDriver(options({ permissionMode: 'acceptEdits' }), hooks, bin)
    await driver.start()
    driver.send('question time')
    await waitFor(
      'both question cards',
      () => hooks.events.filter((ev) => ev.k === 'request' && ev.kind === 'question').length === 2,
    )
    const cards = hooks.events.filter((ev) => ev.k === 'request' && ev.kind === 'question') as Array<
      Extract<import('@shared').TimelineEvent, { k: 'request' }>
    >
    const first = cards[0]!
    check('a structured question is a native request, not a tool', cards.length === 2, cards.length)
    check('the question keeps its own text', first.title === 'How should I format the output?', first)
    check('and its header', first.detail === 'Format', first)
    check(
      'and its real options, with their descriptions',
      first.options.length === 2 &&
        first.options[0]!.label === 'Summary' &&
        first.options[0]!.hint === 'Brief overview of key points',
      first.options,
    )
    check(
      'each question keeps its own native identity',
      cards[0]!.requestId !== cards[1]!.requestId,
      cards.map((card) => card.requestId),
    )
    check('nothing is answered before the person answers', responseTo('req-ask') === undefined, sent())

    driver.answerQuestion(cards[0]!.requestId, 'Summary')
    await new Promise((resolve) => setTimeout(resolve, 150))
    check(
      'one answer of two does not close the request',
      responseTo('req-ask') === undefined,
      responseTo('req-ask'),
    )
    driver.answerQuestion(cards[1]!.requestId, 'Conclusion')
    await waitFor('the answers to reach the CLI', () => responseTo('req-ask') !== undefined)
    const reply = responseTo('req-ask')!.response.response
    check('the answer is an allow carrying the choices', reply.behavior === 'allow', reply)
    check(
      'keyed by the question text, as the tool expects',
      reply.updatedInput?.answers?.['How should I format the output?'] === 'Summary' &&
        reply.updatedInput?.answers?.['Which sections should I include?'] === 'Conclusion',
      reply.updatedInput,
    )
    check(
      'and the original questions are passed back with it',
      Array.isArray(reply.updatedInput?.questions) && reply.updatedInput.questions.length === 2,
      reply.updatedInput?.questions,
    )
    driver.stop()
  }
}

try {
  await main()
} catch (error) {
  failures.push(`threw: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  rmSync(workdir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

for (const label of passed) console.log(`   ✓ ${label}`)
if (failures.length) {
  for (const label of failures) console.error(`   ✗ ${label}`)
  console.error(`claude-test: FAILED (${failures.length}/${passed.length + failures.length})`)
  process.exit(1)
}
console.log(`claude-test: PASSED (${passed.length} checks)`)
