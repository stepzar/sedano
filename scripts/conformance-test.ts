#!/usr/bin/env bun
/**
 * The drivers against what the CLIs really said, not against what we imagined.
 *
 * Every other harness gate in this repo replays a hand-written fake, which is
 * what keeps them fast and hermetic and also what let two defects reach a
 * person: a fixture only ever asserts the shapes its author thought of. This one
 * replays captured protocol instead — `scripts/fixtures/traces/` — through the
 * real drivers:
 *
 *   commandcode/*.jsonl                 seven runs of the real `cmd`, recorded
 *                                       once by `capture-traces.ts`
 *   claude/*.jsonl + *.transcript.jsonl three runs of the real `claude`, both
 *                                       halves of each: the `stream-json` lines
 *                                       it wrote on stdout and the transcript
 *                                       the same run left on disk
 *   claude/local-command.transcript.jsonl
 *                                       records lifted verbatim out of real
 *                                       `~/.claude/projects` transcripts (see
 *                                       its .meta.json for the provenance of
 *                                       every line)
 *
 * The Claude scenarios are discovered from the folder rather than listed here,
 * and a trace with nothing to replay it with — or with nobody asserting anything
 * about it — fails the run. A second hardcoded list is how a capture gets made
 * and then quietly ignored, which is what happened to all three of these.
 *
 * Hermetic and free. Nothing here spawns a vendor CLI: the Command Code side
 * runs `scripts/fixtures/replay-cmd.ts` and the Claude side runs
 * `scripts/fixtures/replay-claude.ts`, both of which print recorded bytes and
 * talk to nothing. No trace is ever regenerated here — capturing costs real
 * money, and a fixture this test wrote itself would prove nothing.
 */
// First, before anything can open the real store: `paths.ts` reads SEDANO_HOME
// at import time and ES imports are hoisted, so an assignment in this file's
// body would already be too late.
import './lib/isolate.ts'

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  LimitCredits,
  LimitWindow,
  SessionStatus,
  TimelineEvent,
  TokenUsage,
} from '@shared'
import { usageValue } from '@shared'
import { CommandCodeDriver } from '../apps/server/src/harnesses/commandcode/session.ts'
import { ClaudeDriver } from '../apps/server/src/harnesses/claude/session.ts'
import { ClaudeTranscriptReader } from '../apps/server/src/harnesses/claude/transcripts.ts'
import { claudeSubagentsDir, claudeTranscriptPath } from '../apps/server/src/paths.ts'
import { Transport } from '../apps/server/src/transport.ts'
import type { CreateOptions, DriverHooks } from '../apps/server/src/harnesses/types.ts'
import type { TraceFrame, TraceMeta } from './capture-traces.ts'
import { redactFrameStructure, redactTranscriptStructure } from './capture-traces.ts'
import { installExitHandlers, onCleanup, runCleanups } from './lib/harness.ts'

installExitHandlers()

type LimitMeta = { plan?: string | null; credits?: LimitCredits | null; error?: string | null }

const failures: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) return
  failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const TRACES = join(import.meta.dir, 'fixtures', 'traces')

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = (predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> =>
  new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (predicate()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`))
      setTimeout(tick, 30)
    }
    tick()
  })

/* ------------------------------------------------------------------ */
/* Part 1 — Command Code, against seven captured runs                  */
/* ------------------------------------------------------------------ */

interface Collected {
  events: TimelineEvent[]
  /** The dedupe id each event was published under, by the same index. */
  eventIds: Array<string | undefined>
  /** The agent a published event was attributed to, by the same index. */
  eventAgents: Array<string | undefined>
  /** Direct causal event, by the same index. */
  eventParents: Array<string | undefined>
  /** Parent agent, by the same index. */
  eventParentAgents: Array<string | undefined>
  usage: Array<{ usage: Partial<TokenUsage>; commitTurn: boolean; contextWindow?: number; contextWindowInferred?: boolean }>
  statuses: SessionStatus[]
  models: string[]
  nativeId: string | null
  resumeHint: string | null
  errors: string[]
  text: string
  thinking: string
  limits: Array<{ windows: LimitWindow[]; meta: LimitMeta }>
  metas: Array<{ gitBranch?: string | null; permissionMode?: string | null }>
  titles: string[]
}

function emptyCollected(): Collected {
  return {
    events: [],
    eventIds: [],
    eventAgents: [],
    eventParents: [],
    eventParentAgents: [],
    usage: [],
    statuses: [],
    models: [],
    nativeId: null,
    resumeHint: null,
    errors: [],
    text: '',
    thinking: '',
    limits: [],
    metas: [],
    titles: [],
  }
}

function makeHooks(into: Collected): DriverHooks {
  return {
    event: (ev, opts) => {
      into.events.push(ev)
      into.eventIds.push(opts?.id)
      into.eventAgents.push(opts?.agentId)
      into.eventParents.push(opts?.parentEventId)
      into.eventParentAgents.push(opts?.parentAgentId)
    },
    delta: (_key, kind, text) => {
      if (kind === 'text') into.text += text
      else into.thinking += text
    },
    status: (status) => into.statuses.push(status),
    model: (model) => into.models.push(model),
    // Kept whole, `unreported` included: whether a counter was reported is the
    // point of several checks below, and copying the numbers out would erase it.
    usage: (usage, opts) =>
      into.usage.push({
        usage,
        commitTurn: Boolean(opts?.commitTurn),
        contextWindow: opts?.contextWindow,
        contextWindowInferred: opts?.contextWindowInferred,
      }),
    tokens: () => undefined,
    nativeId: (id) => {
      into.nativeId = id
    },
    resumeHint: (hint) => {
      into.resumeHint = hint
    },
    title: (title) => into.titles.push(title),
    error: (message) => into.errors.push(message),
    turnStarted: () => undefined,
    terminal: () => undefined,
    meta: (meta) => into.metas.push(meta),
    limits: (windows, meta) => into.limits.push({ windows, meta }),
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'sedano-conformance-'))
onCleanup(() => rmSync(scratch, { recursive: true, force: true }))

const REPLAY_MODULE = join(import.meta.dir, 'fixtures', 'replay-cmd.ts')

/**
 * A `cmd` for one scenario, with its trace baked in.
 *
 * The settings cannot travel in the environment: `Bun.spawn` reads the
 * environment this process was *launched* with, exactly as `Bun.which` does, so
 * a variable set in this file's body never reaches the child — and the driver
 * chooses the child's argv, so they cannot travel there either. Writing them
 * into the launcher is what is left, and it keeps one scenario's settings from
 * leaking into the next.
 */
function replayBinFor(scenario: string, opts: { hang?: boolean; argvOut: string }): string {
  const dir = join(scratch, scenario)
  mkdirSync(dir, { recursive: true })
  const bin = join(dir, 'cmd')
  writeFileSync(
    bin,
    [
      '#!/usr/bin/env bun',
      `process.env.SEDANO_REPLAY_TRACE = ${JSON.stringify(join(TRACES, 'commandcode', `${scenario}.jsonl`))}`,
      `process.env.SEDANO_REPLAY_ARGV = ${JSON.stringify(opts.argvOut)}`,
      ...(opts.hang ? ["process.env.SEDANO_REPLAY_HANG = '1'"] : []),
      `await import(${JSON.stringify(REPLAY_MODULE)})`,
      '',
    ].join('\n'),
  )
  chmodSync(bin, 0o755)
  return bin
}

function loadTrace(scenario: string): { meta: TraceMeta; frames: TraceFrame[]; path: string } {
  const path = join(TRACES, 'commandcode', `${scenario}.jsonl`)
  const meta = JSON.parse(readFileSync(join(TRACES, 'commandcode', `${scenario}.meta.json`), 'utf8')) as TraceMeta
  const frames = readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TraceFrame)
  return { meta, frames, path }
}

/** Every `event.type` the CLI really emitted in a trace. */
function frameTypes(frames: TraceFrame[]): Set<string> {
  const types = new Set<string>()
  for (const frame of frames) {
    if (frame.dir !== 'agent') continue
    let parsed: { type?: string; event?: { type?: string } }
    try {
      parsed = JSON.parse(frame.line)
    } catch {
      types.add('<unparsable>')
      continue
    }
    types.add(parsed.type === 'event' ? `event.${parsed.event?.type ?? '?'}` : String(parsed.type))
  }
  return types
}

/**
 * Replay one captured run through the real driver.
 *
 * The model and the approval mode come from the trace's own meta, so the driver
 * builds the argv it would have built that day and `replay-cmd` writes it down
 * for the comparison below.
 */
async function replay(
  scenario: string,
  opts: { hang?: boolean; interruptAfterText?: boolean } = {},
): Promise<{ collected: Collected; meta: TraceMeta; frames: TraceFrame[]; argv: string[] }> {
  const { meta, frames } = loadTrace(scenario)
  const argvFile = join(scratch, `${scenario}.argv.json`)
  const bin = replayBinFor(scenario, { hang: opts.hang, argvOut: argvFile })

  const collected = emptyCollected()
  const create: CreateOptions = {
    sessionId: `conformance-${scenario}`,
    nativeId: null,
    cwd: scratch,
    host: null,
    model: meta.model,
    effort: null,
    // The capture ran `--permission-mode standard`, which is what this driver
    // sends for `default`; asking for anything else would compare the replay
    // against flags the recording was not made with.
    permissionMode: 'default',
  }
  const driver = new CommandCodeDriver(create, makeHooks(collected), bin)
  driver.send(meta.prompt)

  if (opts.interruptAfterText) {
    // The captured run was killed while it was streaming. Interrupting once the
    // recorded prose has arrived reproduces that, rather than racing the frames.
    await waitFor(() => collected.text.length > 0, `${scenario} to start streaming`)
    await sleep(120)
    driver.interrupt()
  }

  // Both, not just the result event: the driver writes its result line while it
  // is still draining the process and only settles the status afterwards, so
  // stopping on the event alone raced the driver to its own ending and left the
  // last status reading "running" at random.
  await waitFor(
    () =>
      collected.events.some((ev) => ev.k === 'result') &&
      ['idle', 'error', 'stopped'].includes(collected.statuses.at(-1) ?? ''),
    `${scenario} to finish`,
  )
  driver.stop()
  const argv = JSON.parse(readFileSync(argvFile, 'utf8')) as string[]
  return { collected, meta, frames, argv }
}

/**
 * Frame types this driver deliberately does nothing with, and why.
 *
 * A capture that turns up a type which is neither handled nor listed here fails
 * the run: a new frame arriving unnoticed is exactly how `tool_errored` and
 * `api_retry` went unread for so long.
 */
const IGNORED_FRAMES: Record<string, string> = {
  'event.message_start': 'a boundary with no payload; the text is committed at message_end',
  'event.message_update':
    'a cumulative snapshot of the whole message so far, not a delta — adding it to the streamed text would repeat every character n times',
  'event.model_trace': 'a provider-side trace id, of no use to a person',
  'event.thinking_start': 'a boundary; the thinking is committed at thinking_end',
}

/** Everything `handleEvent` has a branch for. */
const HANDLED_FRAMES = new Set([
  'result',
  'event.run_start',
  'event.turn_start',
  'event.turn_end',
  'event.run_end',
  'event.run_error',
  'event.interrupted',
  'event.text_delta',
  'event.thinking_delta',
  'event.thinking_end',
  'event.tool_queued',
  'event.tool_running',
  'event.tool_completed',
  'event.tool_errored',
  'event.tool_denied',
  'event.tool_hook_blocked',
  'event.api_retry',
  'event.model_request_start',
  'event.model_request_end',
  'event.message_end',
])

const SCENARIOS = ['plain', 'table', 'permission', 'error', 'slash-cost', 'slash-status', 'cancel']

const seenTypes = new Set<string>()

/* ------------------------------- plain ----------------------------------- */

{
  const { collected, meta, frames, argv } = await replay('plain')
  for (const type of frameTypes(frames)) seenTypes.add(type)

  check(
    'the driver builds the argv the capture was made with',
    JSON.stringify(argv) === JSON.stringify(meta.args),
    { built: argv, captured: meta.args },
  )
  const answers = collected.events.filter((ev) => ev.k === 'assistant')
  check('the captured answer is committed exactly once', answers.length === 1, answers)
  check(
    'and it is the text the CLI really sent',
    answers[0]?.k === 'assistant' && answers[0].text === 'pong',
    answers[0],
  )
  check(
    'the answer is labelled with the model the CLI said it ran',
    answers[0]?.k === 'assistant' && answers[0].model === 'poolside/laguna-s-2.1-free',
    answers[0],
  )
  check(
    'the session id is learned from the real run_start',
    collected.nativeId === 'f96af7d7-cb08-4416-804d-0876f6d3b14d',
    collected.nativeId,
  )
  const committed = collected.usage.find((u) => u.commitTurn)
  check('the turn commits the usage the CLI reported', committed !== undefined, collected.usage)
  check(
    // The CLI's inputTokens (17738) includes its 5792 cached tokens: what is
    // published is the fresh part, so input and cache never count them twice.
    'and the numbers are the captured ones, with the cached part of the input split out',
    committed?.usage.input === 17738 - 5792 && committed?.usage.output === 3 && committed?.usage.cacheRead === 5792,
    committed?.usage,
  )
  // The captured usage block has four keys and no reasoning counter anywhere in
  // the protocol. Reporting 0 for it would be this driver stating a measurement
  // the CLI never took — the one thing `unreported` exists to prevent.
  check(
    'a counter the protocol never publishes reads as unknown, not as zero',
    usageValue(committed?.usage as TokenUsage, 'reasoning') === null,
    committed?.usage,
  )
  check(
    'and the counters it did publish stay known',
    usageValue(committed?.usage as TokenUsage, 'input') === 17738 - 5792,
    committed?.usage,
  )
  const result = collected.events.find((ev) => ev.k === 'result')
  check(
    'the run reports no price, rather than a price of zero',
    result?.k === 'result' && result.costReported === false && result.costUsd === 0,
    result,
  )
  check('the turn ends idle', collected.statuses.at(-1) === 'idle', collected.statuses)
  check('nothing errored', collected.errors.length === 0, collected.errors)
}

/* ------------------------------- table ----------------------------------- */

{
  const { collected, frames } = await replay('table')
  for (const type of frameTypes(frames)) seenTypes.add(type)

  const answers = collected.events.filter((ev) => ev.k === 'assistant')
  check(
    'a markdown table survives the driver byte for byte',
    answers[0]?.k === 'assistant' &&
      answers[0].text === '| Key | Value |\n|-----|-------|\n| a   | 1     |\n| b   | 2     |',
    answers[0],
  )
  // The captured run sat silent for twelve seconds here while the CLI backed
  // off. The reason is the CLI's own, and dropping the frame is what made that
  // silence unexplainable.
  const retry = collected.events.filter((ev) => ev.k === 'system' && ev.subtype === 'api-retry')
  check('a provider back-off is reported rather than swallowed', retry.length === 1, collected.events)
  check(
    "and it carries the CLI's own reason",
    retry[0]?.k === 'system' && retry[0].text.includes('currently at capacity'),
    retry[0],
  )
}

/* ---------------------------- permission --------------------------------- */

{
  const { collected, frames } = await replay('permission')
  for (const type of frameTypes(frames)) seenTypes.add(type)

  // Headless Command Code has no permission frame at all: the blocked call comes
  // back as `tool_hook_blocked`, with the reason as a plain string.
  const results = collected.events.filter((ev) => ev.k === 'tool_result')
  check('a blocked tool call is reported as a failure', results.some((ev) => ev.k === 'tool_result' && ev.isError), results)
  check(
    'and it keeps the CLI’s own explanation',
    results.some((ev) => ev.k === 'tool_result' && ev.text.includes('requires permissions')),
    results,
  )
  const tools = collected.events.filter((ev) => ev.k === 'tool')
  check(
    'the blocked call ends in the error state, not left running',
    tools.some((ev) => ev.k === 'tool' && ev.status === 'error'),
    tools.map((ev) => (ev.k === 'tool' ? ev.status : null)),
  )
  check(
    'the real tool name is kept, not translated',
    tools.some((ev) => ev.k === 'tool' && ev.name === 'shell_command'),
    tools,
  )
  const answers = collected.events.filter((ev) => ev.k === 'assistant')
  check('each of the two captured rounds commits its own answer', answers.length === 2, answers)
  check(
    'and they are not merged into one',
    answers[0]?.k === 'assistant' && answers[0].text === "I'll run that command for you right away.",
    answers[0],
  )
}

/* ------------------------------- error ----------------------------------- */

{
  const { collected, frames } = await replay('error')
  for (const type of frameTypes(frames)) seenTypes.add(type)

  const results = collected.events.filter((ev) => ev.k === 'tool_result')
  check('a denied tool call is an error, not a silent success', results.some((ev) => ev.k === 'tool_result' && ev.isError), results)
  const final = collected.events.find((ev) => ev.k === 'result')
  // `subtype` on the result line is "success" even here; the run's own
  // `stopReason` is the only place the refusal is named, and flattening it made
  // a run that stopped because it was refused look like one that just ended.
  check(
    "the run's own stop reason survives into the result",
    final?.k === 'result' && final.subtype === 'permission_denied',
    final,
  )
  check('a refused run is not reported as an error status', collected.errors.length === 0, collected.errors)
}

/* ----------------------------- slash-cost -------------------------------- */

{
  const { collected, frames } = await replay('slash-cost')
  for (const type of frameTypes(frames)) seenTypes.add(type)

  // What `/cost` really did: Command Code's headless mode has no local command
  // path whatsoever. The text went to the model, which matched it to a skill and
  // called `activate_skill`.
  const skill = collected.events.find((ev) => ev.k === 'tool' && ev.name === 'activate_skill')
  check('the skill call is in the timeline', skill !== undefined, collected.events.filter((ev) => ev.k === 'tool'))
  check(
    'and the card says which skill, not just "activate_skill"',
    skill?.k === 'tool' && skill.summary === 'activate_skill costi',
    skill,
  )
  const statuses = collected.events.filter((ev) => ev.k === 'tool').map((ev) => (ev.k === 'tool' ? ev.status : null))
  check(
    'a tool call moves through the states the CLI published',
    statuses.includes('queued') && statuses.includes('running') && statuses.includes('completed'),
    statuses,
  )
  check(
    'the thinking the CLI streamed is committed',
    collected.events.some((ev) => ev.k === 'thinking' && ev.text.includes('/cost')),
    collected.events.filter((ev) => ev.k === 'thinking'),
  )
}

/* ---------------------------- slash-status ------------------------------- */

{
  const { collected, frames } = await replay('slash-status')
  for (const type of frameTypes(frames)) seenTypes.add(type)

  // The finding this scenario exists for. `/status` is a Claude Code local
  // command; Command Code has no such thing, so the same text became an ordinary
  // prompt, three model rounds and five tool calls. There is nothing here for a
  // local-command path to handle, and inventing one would be inventing protocol.
  const callIds = new Set(collected.events.filter((ev) => ev.k === 'tool').map((ev) => (ev.k === 'tool' ? ev.toolId : '')))
  check('Command Code ran /status as a prompt, not as a local command', callIds.size === 5, [...callIds])
  // Fifteen emissions, five cards: every state change is published under the
  // call's own stable id (`tool:<toolCallId>`), which the store upserts, so
  // "running" rewrites the row "queued" wrote instead of adding a second one.
  const toolEmissions = collected.events.filter((ev) => ev.k === 'tool').length
  const toolIds = new Set(collected.eventIds.filter((id, index) => collected.events[index]?.k === 'tool'))
  check('each state change is published, not only the first', toolEmissions === 15, toolEmissions)
  check(
    'and all of them under one id per call, so a card is rewritten and not stacked',
    toolIds.size === 5 && [...toolIds].every((id) => typeof id === 'string' && id.startsWith('tool:')),
    [...toolIds],
  )
  check(
    'no local-command frame is claimed for a harness that emits none',
    !collected.events.some((ev) => ev.k === 'system' && ev.subtype.startsWith('local')),
    collected.events.filter((ev) => ev.k === 'system'),
  )
  const answers = collected.events.filter((ev) => ev.k === 'assistant')
  check(
    'the final answer is the one the CLI recorded',
    answers.at(-1)?.k === 'assistant' && answers.at(-1)!.text.startsWith('Current session status:'),
    answers.at(-1),
  )
  const totals = collected.usage.find((u) => u.commitTurn)
  check(
    "the committed usage is the run's total, not the last round's",
    totals?.usage.input === 54854 - 17376 && totals?.usage.output === 922,
    totals?.usage,
  )
}

/* ------------------------------- cancel ---------------------------------- */

{
  const { collected, frames } = await replay('cancel', { hang: true, interruptAfterText: true })
  for (const type of frameTypes(frames)) seenTypes.add(type)

  const result = collected.events.find((ev) => ev.k === 'result')
  check('an interrupted run ends as cancelled', result?.k === 'result' && result.subtype === 'cancelled', result)
  check(
    'and it claims no price for a run that never reported one',
    result?.k === 'result' && result.costReported === false,
    result,
  )
  check(
    'a run killed before any usage frame reports no usage at all',
    !collected.usage.some((u) => u.commitTurn),
    collected.usage,
  )
  check(
    'the prose the CLI had already streamed is kept, not thrown away',
    collected.events.some((ev) => ev.k === 'assistant' && ev.text.startsWith('1')),
    collected.events.filter((ev) => ev.k === 'assistant'),
  )
  check('an interrupt is not an error', collected.errors.length === 0, collected.errors)
  check('the interrupted turn ends idle', collected.statuses.at(-1) === 'idle', collected.statuses)
}

/* --------------------- every frame is accounted for ---------------------- */

{
  const unknown = [...seenTypes].filter((type) => !HANDLED_FRAMES.has(type) && !(type in IGNORED_FRAMES))
  check(
    'every frame type in the captured traces is either handled or knowingly ignored',
    unknown.length === 0,
    unknown,
  )
  check('all seven captured scenarios were replayed', SCENARIOS.length === 7, SCENARIOS)
}

/* ------------------------------------------------------------------ */
/* Part 2 — Claude, against captured runs                              */
/* ------------------------------------------------------------------ */

/**
 * Claude speaks through two channels at once, so a conformance replay has to
 * drive both:
 *
 *   <scenario>.jsonl              every `stream-json` line the CLI wrote on
 *                                 stdout, captured by `capture-traces.ts`
 *   <scenario>.transcript.jsonl   the transcript the same run left on disk —
 *                                 which is where the tool calls, the skills, the
 *                                 slash commands and the subagents actually live
 *
 * The scenarios are *discovered* rather than listed: a `.meta.json` in the
 * folder is a trace, and a trace with nothing to replay it with, or with nobody
 * asserting anything about it, fails the run. A second hardcoded list is exactly
 * how a capture gets made and then quietly ignored, which is what happened to
 * these three for a day.
 */

const CLAUDE_TRACES = join(TRACES, 'claude')

interface ClaudeTrace {
  scenario: string
  meta: Record<string, unknown>
  /** The stdout stream, when the scenario was captured from a live CLI. */
  stream: string | null
  /** The on-disk transcript, when one was recovered. */
  transcript: string | null
  /** The `subagents/` sidecars, when the run spawned an agent that left any. */
  subagents: string | null
}

function claudeTraces(): ClaudeTrace[] {
  return readdirSync(CLAUDE_TRACES)
    .filter((name) => name.endsWith('.meta.json'))
    .map((name) => {
      const scenario = name.slice(0, -'.meta.json'.length)
      const stream = join(CLAUDE_TRACES, `${scenario}.jsonl`)
      const transcript = join(CLAUDE_TRACES, `${scenario}.transcript.jsonl`)
      const subagents = join(CLAUDE_TRACES, `${scenario}.subagents`)
      return {
        scenario,
        meta: JSON.parse(readFileSync(join(CLAUDE_TRACES, name), 'utf8')) as Record<string, unknown>,
        stream: existsSync(stream) ? stream : null,
        transcript: existsSync(transcript) ? transcript : null,
        subagents: existsSync(subagents) ? subagents : null,
      }
    })
    .sort((a, b) => a.scenario.localeCompare(b.scenario))
}

/** Scenarios something below actually looked at. */
const claudeAsserted = new Set<string>()

/* -------------------------- the whole driver ----------------------------- */

// Every byte of this — the transcript the replay lays down, the config root the
// driver reads it back from — stays inside one scratch directory. `realpathSync`
// because macOS reaches the temp dir through a symlink and the CLI slugs the
// path it really landed in: the same mismatch that made the capture miss these
// transcripts in the first place.
const claudeScratch = realpathSync(mkdtempSync(join(tmpdir(), 'sedano-conformance-claude-')))
onCleanup(() => rmSync(claudeScratch, { recursive: true, force: true }))

/**
 * A `claude` for one scenario, with its capture baked in.
 *
 * Same reasoning as `replayBinFor` above: the driver chooses this process' argv
 * and `Bun.spawn` reads the environment this process was *launched* with, so the
 * settings can only travel inside the launcher. Nothing here can reach a real
 * CLI — the binary is a file this test just wrote.
 */
function claudeBinFor(trace: ClaudeTrace, argvOut: string): string {
  const dir = join(claudeScratch, 'bin', trace.scenario)
  mkdirSync(dir, { recursive: true })
  const bin = join(dir, 'claude')
  writeFileSync(
    bin,
    [
      '#!/usr/bin/env bun',
      `process.env.SEDANO_REPLAY_TRACE = ${JSON.stringify(trace.stream)}`,
      ...(trace.transcript
        ? [`process.env.SEDANO_REPLAY_TRANSCRIPT = ${JSON.stringify(trace.transcript)}`]
        : []),
      ...(trace.subagents
        ? [`process.env.SEDANO_REPLAY_SUBAGENTS = ${JSON.stringify(trace.subagents)}`]
        : []),
      `process.env.SEDANO_REPLAY_ARGV = ${JSON.stringify(argvOut)}`,
      `await import(${JSON.stringify(join(import.meta.dir, 'fixtures', 'replay-claude.ts'))})`,
      '',
    ].join('\n'),
  )
  chmodSync(bin, 0o755)
  return bin
}

/**
 * Replay one captured Claude run through the real driver.
 *
 * `settled` is the scenario's own last word — the transcript arrives through a
 * poller that runs well after the `result` frame, so stopping on the result
 * alone would race the driver to half its own output.
 */
async function replayClaude(
  trace: ClaudeTrace,
  settled: (collected: Collected) => boolean = () => true,
): Promise<{ collected: Collected; argv: string[] }> {
  const home = join(claudeScratch, 'home', trace.scenario)
  const cwd = join(home, 'work')
  mkdirSync(cwd, { recursive: true })
  // Read by `claudeConfigRoot` when the driver is constructed, and inherited by
  // the replay binary when it is spawned: both have to point here, or the test
  // would be reading and writing the operator's own `~/.claude`.
  process.env.CLAUDE_CONFIG_DIR = join(home, 'claude')

  const argvFile = join(home, 'argv.json')
  const bin = claudeBinFor(trace, argvFile)

  const collected = emptyCollected()
  const create: CreateOptions = {
    sessionId: `conformance-claude-${trace.scenario}`,
    nativeId: null,
    cwd,
    host: null,
    model: (trace.meta.model as string | null) ?? null,
    effort: null,
    permissionMode: (trace.meta.permissionMode as CreateOptions['permissionMode']) ?? 'default',
  }
  const driver = new ClaudeDriver(create, makeHooks(collected), bin)
  await driver.start()
  driver.send(String(trace.meta.prompt ?? ''))

  await waitFor(
    () => collected.events.some((ev) => ev.k === 'result') && settled(collected),
    `the claude ${trace.scenario} replay to finish`,
  )
  driver.stop()
  return { collected, argv: JSON.parse(readFileSync(argvFile, 'utf8')) as string[] }
}

/** Every frame the CLI wrote on stdout in a trace, parsed. */
function claudeFrames(trace: ClaudeTrace): Array<Record<string, any>> {
  if (!trace.stream) return []
  return readFileSync(trace.stream, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as TraceFrame)
    .filter((frame) => frame.dir === 'agent')
    .map((frame) => {
      try {
        return JSON.parse(frame.line) as Record<string, any>
      } catch {
        return {}
      }
    })
}

/**
 * A capture's own `result` frame.
 *
 * The run's authoritative totals live here, and an assertion that reads its
 * expectation out of the same trace it is checking stays true when the scenario
 * is captured again — while still failing the moment the driver publishes
 * something the CLI did not say.
 */
function claudeResultFrame(trace: ClaudeTrace): Record<string, any> | undefined {
  return claudeFrames(trace).find((payload) => payload.type === 'result')
}

/** Every `type` (and `subtype`) the CLI really wrote on stdout in a trace. */
function claudeFrameTypes(path: string): Set<string> {
  const types = new Set<string>()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    const frame = JSON.parse(line) as TraceFrame
    if (frame.dir !== 'agent') continue
    let parsed: { type?: string; subtype?: string }
    try {
      parsed = JSON.parse(frame.line)
    } catch {
      types.add('<unparsable>')
      continue
    }
    // `system` is the one frame whose subtype is a different frame — `init` and
    // `hook_started` have nothing to do with each other. Everywhere else the
    // subtype describes the outcome (`result/success`), not the kind.
    types.add(parsed.type === 'system' ? `system/${parsed.subtype ?? '?'}` : String(parsed.type))
  }
  return types
}

/**
 * Stream frame types this driver deliberately does nothing with, and why.
 *
 * Same contract as `IGNORED_FRAMES` above: a capture that turns up a type which
 * is neither handled nor listed here fails the run.
 */
const CLAUDE_IGNORED_FRAMES: Record<string, string> = {
  'system/hook_started':
    "the CLI announcing it is about to run one of the operator's own hooks; the transcript's stop_hook_summary is what reports a hook that mattered",
  'system/hook_response': 'the same hook coming back; routine success is noise beside the turn itself',
  'system/session_state_changed':
    'running/idle, which this driver already knows from its own turn boundaries — the CLI writes one before init and one after result',
  'system/thinking_tokens': 'handled, but as a token counter rather than as an event',
  'system/status': 'a progress ping with no payload a person could read',
  'system/background_tasks_changed':
    'the set of background tasks currently alive, as a list of {task_id, task_type, description}. Every field of it is already carried, per task and with far more detail, by task_started and task_progress — it is a snapshot for a tray-style surface this app does not have, and it says nothing about state, progress or completion',
  'stream_event':
    'the token-level deltas; handled by `handleStreamLine`, which reads the nested event rather than the frame type',
  user: 'the tool results echoed back into the stream; the transcript is the authoritative copy and carries the ids',
}

const CLAUDE_HANDLED_FRAMES = new Set([
  'system/init',
  'result',
  'assistant',
  'rate_limit_event',
  // The subagent pair. `task_started` is the only source that describes a spawn
  // completely and atomically, and `task_progress` the only one that says
  // anything at all about an agent that is still working.
  'system/task_started',
  'system/task_progress',
])

/* ------------------------------ skill ------------------------------------ */

{
  const trace = claudeTraces().find((t) => t.scenario === 'skill')!
  claudeAsserted.add('skill')
  const { collected, argv } = await replayClaude(trace, (c) =>
    c.events.some((ev) => ev.k === 'assistant'),
  )

  // The argv the driver builds, against the argv the capture was made with. The
  // session id is the one field that cannot match: it is generated per run, and
  // the capture's own id belongs to a conversation that is over.
  const captured = (trace.meta.args as string[]).map((arg, index, all) =>
    all[index - 1] === '--session-id' ? '<uuid>' : arg,
  )
  const built = argv.map((arg, index, all) => (all[index - 1] === '--session-id' ? '<uuid>' : arg))
  check('the driver builds the argv the claude capture was made with', JSON.stringify(built) === JSON.stringify(captured), {
    built,
    captured,
  })

  // The production bug: the card said the word "Skill" and nothing else. The
  // skill's name is the only thing the card had to say.
  const tools = collected.events.filter((ev) => ev.k === 'tool')
  const skill = tools.find((ev) => ev.k === 'tool' && ev.name === 'Skill')
  check('the Skill call reaches the timeline', skill !== undefined, tools)
  check(
    'and the card names the skill that was launched, not just "Skill"',
    skill?.k === 'tool' && skill.summary === 'ping',
    skill,
  )
  check(
    "the skill's own name survives in the input as the CLI sent it",
    skill?.k === 'tool' && (skill.input as { skill?: string }).skill === 'ping',
    skill,
  )
  const results = collected.events.filter((ev) => ev.k === 'tool_result')
  check(
    "the skill's result is the CLI's own line, attached to the call that made it",
    results.some(
      (ev) => ev.k === 'tool_result' && ev.toolId === (skill as { toolId: string }).toolId && ev.text === 'Launching skill: ping',
    ),
    results,
  )
  const answers = collected.events.filter((ev) => ev.k === 'assistant')
  check(
    'and the answer the skill produced is committed',
    answers.some((ev) => ev.k === 'assistant' && ev.text === 'pong-from-skill'),
    answers,
  )

  /* --- the same message's tokens are charged once, not four times --- */

  // What the capture settled: the CLI reports one message's usage four times —
  // once per content block on the stream, and again once per content block in
  // the transcript — all under the same `msg_…` id. `SessionMeter.addUsage`
  // accumulates, so every one of those is a real charge.
  // A re-report that only adds the output the message grew by since is not a
  // second charge of its input: those carry no cache counters at all.
  const perMessage = collected.usage.filter((u) => !u.commitTurn && u.usage.cacheRead !== undefined)
  const cacheReads = perMessage.map((u) => u.usage.cacheRead)
  check(
    "a message's tokens are charged once, however many times the CLI repeats them",
    new Set(cacheReads).size === cacheReads.length,
    cacheReads,
  )
  // One charge per message the CLI actually sent, counted from the trace: the
  // stream carries an `assistant` frame per content block and the transcript a
  // record per content block, so the frames far outnumber the messages.
  const messageIds = new Set(
    claudeFrames(trace)
      .filter((payload) => payload.type === 'assistant' && payload.message?.usage?.input_tokens)
      .map((payload) => String(payload.message.id)),
  )
  check(
    'and every message the CLI sent is charged exactly once',
    perMessage.length === messageIds.size && messageIds.size > 1,
    { charged: perMessage.length, messages: messageIds.size },
  )
  // The run's own totals, from its own result frame. Four charges per message
  // came to 176,860 cache-read tokens against a run that read 44,215.
  const result = claudeResultFrame(trace)
  const reportedCacheRead = result?.usage?.cache_read_input_tokens
  const summed = perMessage.reduce((total, u) => total + (u.usage.cacheRead ?? 0), 0)
  check(
    "the charged cache reads add up to the run's own reported total",
    summed === reportedCacheRead,
    { charged: summed, reported: reportedCacheRead },
  )

  /* --- thinking tokens are read from where the CLI really writes them --- */

  // Pinned to the trace, not to a literal. The claim under test is "the driver
  // publishes the number the CLI reported, from `output_tokens_details`" — and
  // comparing against the capture's own result frame states exactly that, while
  // a hardcoded 79 would also break the next time this scenario is recaptured,
  // for a reason that teaches nobody anything. The shape is asserted alongside:
  // a counter that were simply missing would read as unknown, not as this.
  const committed = collected.usage.find((u) => u.commitTurn)
  const reportedThinking = result?.usage?.output_tokens_details?.thinking_tokens
  check(
    'the capture reports thinking tokens at all, so this can fail',
    typeof reportedThinking === 'number' && reportedThinking > 0,
    reportedThinking,
  )
  check(
    'the thinking tokens the CLI reported are reported, not zeroed',
    usageValue(committed?.usage as TokenUsage, 'reasoning') === reportedThinking,
    { published: committed?.usage, reported: reportedThinking },
  )
  check(
    'and the rest of the turn total is the captured one',
    committed?.usage.input === result?.usage?.input_tokens &&
      committed?.usage.output === result?.usage?.output_tokens &&
      committed?.usage.cacheWrite === result?.usage?.cache_creation_input_tokens,
    { published: committed?.usage, reported: result?.usage },
  )

  /* --- rate_limit_event --- */

  // A frame type nothing else in this repo has ever replayed. It arrives once
  // per run, unasked, and it is the only place the CLI says how much of the
  // subscription is gone.
  check('the CLI’s own rate-limit frame is read', collected.limits.length === 1, collected.limits)
  const windows = collected.limits[0]?.windows ?? []
  check(
    'a utilisation the CLI publishes as a fraction is shown as a percentage',
    windows.find((w) => w.label === '5h')?.usedPercent === 6 &&
      windows.find((w) => w.label === '7d')?.usedPercent === 74,
    windows,
  )
  check(
    'and its reset is read as a second-precision stamp, not a millisecond one',
    windows.find((w) => w.label === '5h')?.resetsAt === 1790082000 * 1000,
    windows,
  )
  check(
    'a run that cannot spend overage says so rather than claiming credit',
    collected.limits[0]?.meta.credits?.hasCredits === false &&
      collected.limits[0]?.meta.error === 'out of credits',
    collected.limits[0]?.meta,
  )

  check('nothing errored', collected.errors.length === 0, collected.errors)
  check('the turn ends idle', collected.statuses.at(-1) === 'idle', collected.statuses)
}

/* --------------------------- slash-status -------------------------------- */

{
  const trace = claudeTraces().find((t) => t.scenario === 'slash-status')!
  claudeAsserted.add('slash-status')
  const { collected } = await replayClaude(trace, (c) =>
    c.events.some((ev) => ev.k === 'system' && ev.subtype.startsWith('local_command')),
  )

  // The symptom, in the run that produced it. `/status` reached the user as two
  // bare "Local command" lines: the invocation and its output both rendered as
  // the title-cased name of the record's subtype.
  const texts = collected.events.map((ev) => ('text' in ev ? ev.text : ''))
  check('a slash command no longer renders as the words "Local command"', !texts.includes('Local command'), texts)

  const users = collected.events.filter((ev) => ev.k === 'user')
  check(
    'the driver does not duplicate the command event owned by the manager',
    users.length === 0,
    users,
  )
  // The manager writes the command at acceptance time. The driver still claims
  // the transcript twin, so it never adds a second user event later.
  const systems = collected.events.filter((ev) => ev.k === 'system')
  check(
    "and what the command printed is shown as the command's output",
    systems.some(
      (ev) => ev.k === 'system' && ev.subtype === 'local_command' && ev.text === "/status isn't available in this environment.",
    ),
    systems,
  )

  // A local command runs no model at all. The CLI still writes a `result` with
  // an all-zero usage block, and publishing a context window alongside it told
  // the readout the context had been measured.
  const committed = collected.usage.find((u) => u.commitTurn)
  check('a turn that ran no model reports no usage', committed?.usage.input === undefined, committed?.usage)
  check('and no context window either', committed?.contextWindow === undefined, committed)
  check('the turn ends idle', collected.statuses.at(-1) === 'idle', collected.statuses)
  check('nothing errored', collected.errors.length === 0, collected.errors)
}

/* ----------------------------- subagent ---------------------------------- */

{
  const trace = claudeTraces().find((t) => t.scenario === 'subagent')!
  claudeAsserted.add('subagent')
  const { collected } = await replayClaude(trace, (c) =>
    // The sidechain's own work is the last thing to land: it comes out of a
    // sidecar file the reader only finds by scanning a directory it polls.
    c.events.some((ev) => ev.k === 'tool' && ev.name === 'Bash'),
  )
  const result = claudeResultFrame(trace)

  /* --- the main chat's size and totals are the main loop's, not the agent's --- */

  const assistantFrames = claudeFrames(trace).filter((frame) => frame.type === 'assistant' && frame.message?.usage)
  const mainIds = new Set(assistantFrames.filter((frame) => !frame.parent_tool_use_id).map((frame) => String(frame.message.id)))
  const agentIds = new Set(assistantFrames.filter((frame) => frame.parent_tool_use_id).map((frame) => String(frame.message.id)))
  check('the capture has sidechain messages on the stream, so this can fail', agentIds.size > 0, agentIds.size)
  const charges = collected.usage.filter((u) => !u.commitTurn && u.usage.cacheRead !== undefined)
  check(
    "a subagent's own messages are not charged to the main chat (its context is its own)",
    charges.length === mainIds.size,
    { charged: charges.length, main: mainIds.size, sidechain: agentIds.size },
  )
  // The window is the CLI's own statement, from the result's `modelUsage`:
  // haiku's 200k here, and not marked as an estimate once it has been said.
  const stated = result?.modelUsage?.[String(result?.modelUsage ? Object.keys(result.modelUsage)[0] : '')]?.contextWindow
  const closing = collected.usage.find((u) => u.commitTurn)
  check('the capture states a window at all', typeof stated === 'number' && stated > 0, stated)
  check(
    "the turn closes with the window the CLI stated, published as a statement",
    closing?.contextWindow === stated && closing?.contextWindowInferred !== true,
    closing,
  )
  check(
    'before the CLI has stated one, the window is published as an estimate',
    charges.every((u) => u.contextWindow === undefined || u.contextWindowInferred === true),
    charges,
  )
  // Output is charged per main-loop message, from its final count (the stream
  // says 3 while the transcript says the finished number): the charges add up
  // to the turn's own output total, so nothing is lost or counted twice.
  const chargedOutput = collected.usage.filter((u) => !u.commitTurn).reduce((total, u) => total + (u.usage.output ?? 0), 0)
  check(
    "the main loop's messages add up to the turn's own output",
    chargedOutput === result?.usage?.output_tokens,
    { charged: chargedOutput, reported: result?.usage?.output_tokens },
  )

  // This capture really did spawn one, which is the trace's word and not ours.
  check('the captured run spawned exactly one subagent', result?.subagent_stats?.spawned === 1, result?.subagent_stats)
  check(
    'and it was launched in the background, which is what the driver has to cope with',
    result?.subagent_stats?.started_in_background === 1,
    result?.subagent_stats,
  )

  /* ----------------------------- the card ------------------------------- */

  const starts = collected.events.filter((ev) => ev.k === 'subagent_start')
  check('the spawn produces a subagent card', starts.length > 0, starts)
  // Under one id, always: the card is upserted, never stacked. Three separate
  // sources describe this one subagent and each of them republishes it.
  const startIds = new Set(
    collected.eventIds.filter((_id, index) => collected.events[index]?.k === 'subagent_start'),
  )
  check(
    'however many sources describe it, it is one card and not several',
    startIds.size === 1 && [...startIds][0] === 'subagent_start:toolu_01XjTG19SJXQJeYM92ji7p7f',
    [...startIds],
  )

  // THE DEFECT THIS TRACE EXPOSED. Two transcript sources each knew half of the
  // card and published under the same id, so the later one overwrote the
  // earlier: whichever poller won, the card lost either its `agentId` (the
  // field every sidechain event is attributed by) or its `prompt` (the only
  // record of what the agent was asked). Every publication has to be complete.
  for (const [index, start] of starts.entries()) {
    if (start.k !== 'subagent_start') continue
    check(
      `subagent_start #${index + 1} names the agent it started`,
      start.agentId === 'ae13abd969458adb1',
      start,
    )
    check(
      `subagent_start #${index + 1} keeps the prompt the agent was given`,
      start.prompt === 'Run the shell command `echo hi` and report the output.',
      start,
    )
    check(`subagent_start #${index + 1} keeps its type`, start.agentType === 'general-purpose', start)
    check(`subagent_start #${index + 1} keeps its description`, start.description === 'Run echo command test', start)
    // Nesting. `spawn_depth` on the live frame and `spawnDepth` in the sidecar
    // meta both say 1 — a top-level agent — and the card must say so rather
    // than default to a number that happens to match.
    check(`subagent_start #${index + 1} carries the depth the CLI reported`, start.depth === 1, start)
  }
  check(
    'the spawn card is bound to the tool call that made it',
    starts.every((ev) => ev.k === 'subagent_start' && ev.toolId === 'toolu_01XjTG19SJXQJeYM92ji7p7f'),
    starts,
  )
  // `subagent_start.model` read `input.model`, which a real `Agent` call does
  // not send; the runtime's answer is `resolvedModel`, on the spawn's result.
  check(
    "the card ends up naming the model the runtime resolved the agent onto",
    starts.some((ev) => ev.k === 'subagent_start' && ev.model === 'claude-haiku-4-5-20251001'),
    starts,
  )

  /* ---------------------------- the ending ------------------------------ */

  const ends = collected.events.filter((ev) => ev.k === 'subagent_end')
  check('the subagent reports an ending', ends.length > 0, ends)
  // It has not ended. The capture's parent turn finished while the agent was
  // still working — `async_launched` — and the run was recorded before any
  // completion notice arrived, so every row here is provisional by definition.
  check(
    'a subagent that is still working is never reported as finished',
    ends.every((ev) => ev.k === 'subagent_end' && ev.provisional === true),
    ends,
  )
  check(
    'and it is reported as running rather than done',
    ends.every((ev) => ev.k === 'subagent_end' && ev.status === 'running'),
    ends.map((ev) => (ev.k === 'subagent_end' ? ev.status : null)),
  )
  // The live progress frame is the only source with real numbers for a running
  // agent; the transcript's launch row has none. Both write under the same id,
  // and the empty one lands last.
  const progress = claudeFrames(trace).find(
    (frame) => frame.type === 'system' && frame.subtype === 'task_progress',
  )
  check('the capture carries a progress frame to read', progress !== undefined, progress)
  const best = ends.at(-1)
  check(
    "the surviving row carries the progress the CLI reported, not the launch row's zeroes",
    best?.k === 'subagent_end' &&
      best.toolUses === progress?.usage?.tool_uses &&
      best.durationMs === progress?.usage?.duration_ms,
    { published: best, reported: progress?.usage },
  )
  check(
    'and the ending is bound to the same spawn call as the card',
    ends.every((ev) => ev.k === 'subagent_end' && ev.toolId === 'toolu_01XjTG19SJXQJeYM92ji7p7f'),
    ends,
  )
  check(
    'a provisional ending claims no result, because the agent has produced none',
    ends.every((ev) => ev.k === 'subagent_end' && ev.result === ''),
    ends,
  )

  /* -------------------- the sidechain stays a sidechain ------------------ */

  // The subagent's own work lives in `subagents/agent-<id>.jsonl`, and every
  // event read out of it has to be attributed to the agent — never to the main
  // loop, where it would read as something the parent did.
  const sidechain = collected.events
    .map((ev, index) => ({ ev, agentId: collected.eventAgents[index] }))
    .filter((entry) => entry.agentId !== undefined)
  check('the sidechain produces events of its own', sidechain.length > 0, sidechain.length)
  check(
    'and every one of them is attributed to the agent that produced it',
    sidechain.every((entry) => entry.agentId === 'ae13abd969458adb1'),
    sidechain.map((entry) => entry.agentId),
  )
  const sidechainTools = sidechain.filter((entry) => entry.ev.k === 'tool')
  check(
    "the agent's own tool call is in the timeline",
    sidechainTools.some((entry) => entry.ev.k === 'tool' && entry.ev.name === 'Bash' && entry.ev.summary === 'echo hi'),
    sidechainTools.map((entry) => entry.ev),
  )
  // The other direction, and the one that actually goes wrong: the parent's own
  // work must not be filed under the agent.
  const parentTools = collected.events
    .map((ev, index) => ({ ev, agentId: collected.eventAgents[index] }))
    .filter((entry) => entry.ev.k === 'tool' && entry.ev.name === 'Agent')
  check(
    'the spawn call itself belongs to the main loop, not to the agent it started',
    parentTools.every((entry) => entry.agentId === undefined),
    parentTools.map((entry) => entry.agentId),
  )
  check(
    "the parent's closing message is the main loop's, not the sidechain's",
    collected.events
      .map((ev, index) => ({ ev, agentId: collected.eventAgents[index] }))
      .filter((entry) => entry.ev.k === 'assistant')
      .every((entry) => entry.agentId === undefined),
    collected.events.filter((ev) => ev.k === 'assistant'),
  )
  // A background agent's prompt is on the spawn card. The sidechain repeats it
  // as its own first `user` record, and printing that would put the agent's
  // instructions in the transcript a second time as if a person had typed them.
  check(
    "the sidechain's copy of its own prompt is not printed as a user message",
    !collected.events.some((ev, index) => ev.k === 'user' && collected.eventAgents[index] !== undefined),
    collected.events.filter((ev) => ev.k === 'user'),
  )

  /* ------------------------------ the turn ------------------------------ */

  const committed = collected.usage.find((u) => u.commitTurn)
  // Pinned to the trace rather than to a literal: the assertion is that the
  // driver publishes the thinking count the CLI reported, and reading the
  // expected value out of the same capture is what actually says that. A
  // hardcoded number would also go red on the next capture, which would be a
  // failure that teaches nobody anything.
  const reportedThinking = result?.usage?.output_tokens_details?.thinking_tokens
  check('the capture reports thinking tokens at all', typeof reportedThinking === 'number' && reportedThinking > 0, reportedThinking)
  check(
    'the thinking tokens the CLI reported are the ones published',
    usageValue(committed?.usage as TokenUsage, 'reasoning') === reportedThinking,
    { published: committed?.usage, reported: reportedThinking },
  )
  check('nothing errored', collected.errors.length === 0, collected.errors)
  check('the turn ends idle', collected.statuses.at(-1) === 'idle', collected.statuses)
}

/* ------------------- every claude frame is accounted for ----------------- */

{
  const seen = new Set<string>()
  for (const trace of claudeTraces()) {
    if (!trace.stream) continue
    for (const type of claudeFrameTypes(trace.stream)) seen.add(type)
  }
  const unknown = [...seen].filter(
    (type) => !CLAUDE_HANDLED_FRAMES.has(type) && !(type in CLAUDE_IGNORED_FRAMES),
  )
  check(
    'every claude stream frame type in the captured traces is either handled or knowingly ignored',
    unknown.length === 0,
    unknown,
  )
  check('the traces really did carry a rate_limit_event to replay', seen.has('rate_limit_event'), [...seen])
}

/* ------------------ the transcript reader, on its own -------------------- */

interface Seen {
  events: Array<{
    ev: TimelineEvent
    id: string
    agentId?: string
    parentEventId?: string
    parentAgentId?: string
  }>
  usage: TokenUsage[]
}

/**
 * Run the real transcript reader over one captured transcript.
 *
 * Used for `local-command`, which is a set of records lifted out of real
 * transcripts rather than a run anyone recorded end to end — there is no stdout
 * stream to replay it through the whole driver with. `echoes` is what the driver
 * would already have shown locally: the reader asks before it prints a user
 * message, and a slash command the person typed is a user message like any
 * other.
 */
async function readTranscript(file: string, echoes: string[] = []): Promise<Seen> {
  const root = mkdtempSync(join(tmpdir(), 'sedano-conformance-transcript-'))
  onCleanup(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, 'work')
  mkdirSync(cwd, { recursive: true })
  const session = '00000000-0000-4000-8000-0000000c0de0'
  const target = claudeTranscriptPath(cwd, session, root)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, readFileSync(file, 'utf8'))

  const seen: Seen = { events: [], usage: [] }
  const reader = new ClaudeTranscriptReader(
    new Transport(null),
    cwd,
    session,
    {
      event: (ev, id, _at, agentId, causal) => seen.events.push({ ev, id, agentId, ...causal }),
      usage: (usage) => seen.usage.push(usage),
      title: () => undefined,
      claimUserEcho: (text) => echoes.includes(text),
    },
    root,
  )
  reader.start()
  await waitFor(
    () => seen.events.some((e) => e.ev.k === 'assistant'),
    `${file} to be read`,
  )
  await sleep(150)
  reader.stop()
  return seen
}

{
  // A nested spawn is the smallest fixture that proves the transcript adapter
  // preserves causal identity instead of merely attributing rows to whichever
  // sidechain file they came from.
  const root = mkdtempSync(join(tmpdir(), 'sedano-conformance-nested-'))
  onCleanup(() => rmSync(root, { recursive: true, force: true }))
  const cwd = join(root, 'work')
  const session = 'nested-causality'
  const transcript = claudeTranscriptPath(cwd, session, root)
  const sidechains = claudeSubagentsDir(cwd, session, root)
  mkdirSync(dirname(transcript), { recursive: true })
  mkdirSync(sidechains, { recursive: true })
  writeFileSync(transcript, '')
  writeFileSync(
    join(sidechains, 'agent-alpha.jsonl'),
    `${JSON.stringify({
      uuid: 'alpha-spawn',
      timestamp: new Date().toISOString(),
      type: 'assistant',
      message: {
        model: 'claude-fixture',
        content: [{
          type: 'tool_use',
          id: 'tool-task-gamma',
          name: 'Task',
          input: { subagent_type: 'explorer', description: 'dig deeper', prompt: 'nested work' },
        }],
      },
    })}\n`,
  )
  writeFileSync(
    join(sidechains, 'agent-gamma.meta.json'),
    JSON.stringify({
      agentType: 'explorer',
      description: 'dig deeper',
      toolUseId: 'tool-task-gamma',
      spawnDepth: 2,
    }),
  )
  writeFileSync(join(sidechains, 'agent-gamma.jsonl'), '')

  const seen: Seen = { events: [], usage: [] }
  const reader = new ClaudeTranscriptReader(
    new Transport(null),
    cwd,
    session,
    {
      event: (ev, id, _at, agentId, causal) => seen.events.push({ ev, id, agentId, ...causal }),
      usage: (usage) => seen.usage.push(usage),
      title: () => undefined,
    },
    root,
  )
  reader.start()
  await waitFor(
    () => seen.events.some(
      (entry) => entry.ev.k === 'subagent_start' && entry.ev.agentId === 'gamma' && entry.parentAgentId === 'alpha',
    ),
    'nested subagent causality to be assembled',
  )
  reader.stop()
  const gamma = seen.events.find(
    (entry) => entry.ev.k === 'subagent_start' && entry.ev.agentId === 'gamma' && entry.parentAgentId === 'alpha',
  )
  check('a nested Claude subagent names alpha as gamma parent', gamma?.parentAgentId === 'alpha', gamma)
  check('a nested Claude subagent points at the spawning tool event', gamma?.parentEventId === 'tool:tool-task-gamma', gamma)
}

{
  // The transcript on its own, with no live stream beside it. This is what a
  // resumed session reads, and what a session whose CLI process died falls back
  // to — so the subagent has to be describable from the transcript alone, and
  // `system/task_started` is not available to do it.
  const seen = await readTranscript(join(CLAUDE_TRACES, 'subagent.transcript.jsonl'))
  const ends = seen.events.filter((e) => e.ev.k === 'subagent_end').map((e) => e.ev)
  check('the transcript alone still reports the subagent', ends.length > 0, ends)
  // `async_launched` is the CLI saying the agent has been started, and this
  // answered "done" for it — the one state that mattered was the one it could
  // not say, and only the `provisional` flag kept the card from reading as
  // finished.
  check(
    'an agent the transcript says was just launched is running, not done',
    ends.every((ev) => ev.k === 'subagent_end' && ev.status === 'running'),
    ends,
  )
  const starts = seen.events.filter((e) => e.ev.k === 'subagent_start').map((e) => e.ev)
  check(
    'and the transcript alone still assembles a whole card, id and prompt together',
    starts.some(
      (ev) =>
        ev.k === 'subagent_start' &&
        ev.agentId === 'ae13abd969458adb1' &&
        ev.prompt === 'Run the shell command `echo hi` and report the output.',
    ),
    starts,
  )
}

const LOCAL_COMMAND = join(CLAUDE_TRACES, 'local-command.transcript.jsonl')

{
  claudeAsserted.add('local-command')
  const seen = await readTranscript(LOCAL_COMMAND)
  const texts = seen.events.map((e) => ('text' in e.ev ? e.ev.text : ''))

  // The symptom the user reported, in the records that produced it.
  check(
    'a slash command no longer renders as the words "Local command"',
    !texts.includes('Local command'),
    texts,
  )

  const users = seen.events.filter((e) => e.ev.k === 'user').map((e) => (e.ev as { text: string }).text)
  const systems = seen.events
    .filter((e) => e.ev.k === 'system')
    .map((e) => e.ev as { subtype: string; text: string })

  // Shape 1: the untagged invocation 2.1.261 writes (this is the exact record
  // sedano produced when the bug was reported).
  check('an untagged invocation renders as the command that was typed', users.includes('/status'), users)
  check(
    'and its output renders as what the command printed',
    systems.some((ev) => ev.text === "/status isn't available in this environment."),
    systems,
  )

  // Shape 2: the tagged invocation, name and arguments both.
  check('a tagged invocation keeps its name and its arguments', users.includes('/model opus'), users)
  check(
    'terminal escapes in a command’s output are stripped, not printed',
    systems.some((ev) => ev.text === 'Set model to Opus 5 and saved as your default for new sessions'),
    systems,
  )

  // Shape 3: the older `user` record whose content is the same tagged string.
  // The `user` branch reads message.content as an array, so this shape used to
  // render as nothing whatsoever.
  check(
    'the older user-record shape renders too',
    users.includes('/model claude-fable-5-1[1m]'),
    users,
  )
  check(
    'an invocation with empty arguments has no trailing space',
    users.includes('/compact'),
    users,
  )

  // The synthetic message.
  const assistants = seen.events.filter((e) => e.ev.k === 'assistant').map((e) => e.ev as { text: string; model?: string })
  check(
    'a message the CLI wrote itself still shows its text',
    assistants.some((ev) => ev.text.startsWith("You've hit your session limit")),
    assistants,
  )
  check(
    'but it names no model, because no model produced it',
    assistants.every((ev) => ev.model === undefined),
    assistants,
  )
  check(
    'and its all-zero usage block is not reported as tokens spent',
    seen.usage.length === 0,
    seen.usage,
  )
}

{
  // The same records, with the driver having already echoed what the person
  // typed: the transcript twin is dropped rather than printed a second time.
  const seen = await readTranscript(LOCAL_COMMAND, ['/status', '/model opus'])
  const users = seen.events.filter((e) => e.ev.k === 'user').map((e) => (e.ev as { text: string }).text)
  check('an invocation the driver already showed is not printed twice', !users.includes('/status'), users)
  check('including a tagged one, reassembled before it is claimed', !users.includes('/model opus'), users)
  check(
    'and the output of a claimed invocation is still shown',
    seen.events.some((e) => e.ev.k === 'system' && e.ev.text === "/status isn't available in this environment."),
    seen.events.filter((e) => e.ev.k === 'system'),
  )
}

/* ------------- no captured trace carries the operator's machine ---------- */

{
  // These files get committed. A capture records whatever the CLI volunteered
  // about the machine it ran on, and the CLIs volunteer a great deal: the
  // `system/init` frame inventories every skill, slash command, agent, plugin
  // and MCP server installed, a `hook_*` frame carries the operator's own hook
  // output verbatim, and activating a skill pastes the whole of its `SKILL.md`
  // in. The first capture did exactly that — a client's name and a pricing model
  // among it — and nothing noticed until a person read the files.
  //
  // The check is the redaction itself: running the structural pass over a
  // committed trace has to change nothing, which is only true if it was already
  // applied. Any rule added to `capture-traces.ts` later is enforced here for
  // free. The pattern half of the redaction is deliberately not run — it
  // rewrites the *running* machine's user and hostname, so it would make this
  // depend on whose laptop the suite is on.
  // Every `.jsonl` under the folder, sidecars included. The `subagents/`
  // directory is where this check was blind once already: a sidechain has its
  // own `attachment` preamble and leaks the same inventory as any transcript,
  // and the first `Agent` capture went out with it intact.
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    )

  let scanned = 0
  for (const path of walk(TRACES)) {
    if (!path.endsWith('.jsonl')) continue
    scanned += 1
    const text = readFileSync(path, 'utf8')
    // A sidecar is a transcript: `agent-<id>.jsonl` under `<scenario>.subagents`.
    const isTranscript = path.endsWith('.transcript.jsonl') || path.includes('.subagents')
    const redacted = isTranscript ? redactTranscriptStructure(text) : redactFrameStructure(text)
    check(`${path.slice(TRACES.length + 1)} was redacted before it was committed`, redacted === text, {
      path,
      firstDifference: text.split('\n').findIndex((line, index) => line !== redacted.split('\n')[index]),
    })
  }
  check('the redaction check actually found files to check', scanned > 10, scanned)
}

/* ------------------- no captured trace goes unreplayed ------------------- */

{
  const traces = claudeTraces()
  for (const trace of traces) {
    // Loud, not silent. A capture costs real money and a capture nobody replays
    // is money spent on nothing — which is precisely what happened to `skill`,
    // `slash-status` and `subagent` between the day they were recorded and the
    // day this block was written.
    check(
      `the claude ${trace.scenario} trace has something to replay it with`,
      trace.stream !== null || trace.transcript !== null,
      trace,
    )
    check(`the claude ${trace.scenario} trace is asserted about`, claudeAsserted.has(trace.scenario), {
      scenario: trace.scenario,
      asserted: [...claudeAsserted],
    })
  }
  check('there are claude traces at all', traces.length > 0, traces.length)
}

/* ------------------------------------------------------------------ */
/* Part 3 — a placeholder cannot become a model                        */
/* ------------------------------------------------------------------ */

{
  const binDir = mkdtempSync(join(tmpdir(), 'sedano-conformance-bin-'))
  onCleanup(() => rmSync(binDir, { recursive: true, force: true }))
  const fake = join(binDir, 'cmd')
  writeFileSync(fake, readFileSync(join(import.meta.dir, 'fixtures', 'fake-cmd.ts')))
  chmodSync(fake, 0o755)
  // Ahead of the real one: `which.ts` passes this PATH to `Bun.which` explicitly,
  // which is the whole reason a test can put a fake here at all.
  process.env.PATH = `${binDir}:${process.env.PATH}`
  // Nothing in this block may reach the operator's own Claude config.
  process.env.CLAUDE_CONFIG_DIR = join(binDir, 'claude')

  // Imported now rather than at the top: the manager opens the store and reads
  // the PATH as it loads, and both have to be the ones set above.
  const db = await import('../apps/server/src/db.ts')
  const manager = await import('../apps/server/src/manager.ts')

  /* --- a row already poisoned recovers instead of staying poisoned --- */

  const poisoned = 'conformance-poisoned'
  const now = Date.now()
  db.upsertSession({
    id: poisoned,
    harness: 'commandcode',
    kind: 'agent',
    title: 'a session stored before placeholders were refused',
    cwd: binDir,
    host: null,
    model: '<synthetic>',
    status: 'stopped',
    createdAt: now,
    updatedAt: now,
    nativeId: null,
    transcriptPath: null,
    resumeHint: null,
    permissionMode: 'default',
    effort: null,
    gitBranch: null,
    preset: null,
    pinned: 0,
    started: true,
  })
  check(
    'the poisoned row really is in the store to begin with',
    db.loadSessions().find((row) => row.id === poisoned)?.model === '<synthetic>',
  )

  manager.restore()
  check(
    'a stored placeholder is healed on load, not carried forward',
    manager.getSession(poisoned)?.model === null,
    manager.getSession(poisoned)?.model,
  )
  // Healed in the summary is not healed in the database: the row has to be
  // rewritten, or the next restart reads the placeholder back.
  manager.renameSession(poisoned, 'renamed, which persists the row')
  check(
    'and the healed value is written back, so a restart cannot resurrect it',
    db.loadSessions().find((row) => row.id === poisoned)?.model === null,
    db.loadSessions().find((row) => row.id === poisoned)?.model,
  )

  /* --- a harness naming a placeholder is refused at the hook --- */

  const live = await manager.createSession({ harness: 'commandcode', kind: 'agent', cwd: binDir })
  check('a fresh session starts with no model claimed', manager.getSession(live.id)?.model === null, manager.getSession(live.id)?.model)
  manager.sendMessage(live.id, 'synthetic model')
  // On the turn's own ending, not on the status: a session that has not started
  // yet reads `starting`, and waiting for "anything but running" was answered
  // before the harness had said a word — which made every check after it pass
  // without the turn ever having happened.
  await waitFor(
    () => manager.loadSessionEvents(live.id).some((event) => event.ev.k === 'result'),
    'the placeholder turn to finish',
  )
  check(
    'the fake really did report a placeholder as its model',
    manager.loadSessionEvents(live.id).some((event) => event.ev.k === 'assistant' && event.ev.model === '<synthetic>'),
    manager.loadSessionEvents(live.id).filter((event) => event.ev.k === 'assistant'),
  )
  check(
    'a placeholder the harness reports never becomes the session’s model',
    manager.getSession(live.id)?.model === null,
    manager.getSession(live.id)?.model,
  )
  check(
    'nor is it persisted',
    db.loadSessions().find((row) => row.id === live.id)?.model === null,
    db.loadSessions().find((row) => row.id === live.id)?.model,
  )

  /* --- and it cannot be asked for --- */

  // Options may only change between turns, so the request has to wait for the
  // session to settle — otherwise the refusal below is "busy", which would be
  // green whether the guard existed or not.
  await waitFor(() => manager.getSession(live.id)?.status === 'idle', 'the session to settle')
  const asked = manager.setSessionOptions(live.id, { model: '<synthetic>' })
  // The reason matters as much as the refusal: a session that happened to be
  // busy would also answer `ok: false`, and a check that accepted that would be
  // green whether the guard existed or not.
  check(
    'asking to run a placeholder is refused, and refused for being one',
    asked.ok === false && asked.detail.includes('is not a model'),
    asked,
  )
  check(
    'a real model is still accepted, so the refusal is not a blanket one',
    manager.setSessionOptions(live.id, { model: 'poolside/laguna-s-2.1-free' }).ok === true,
  )
  check(
    'and refusing it leaves the session alone',
    manager.getSession(live.id)?.model === null,
    manager.getSession(live.id)?.model,
  )

  for (const session of manager.listSessions()) manager.removeSession(session.id)
  await sleep(50)
}

/* ------------------------------------------------------------------ */

await runCleanups()

if (failures.length) {
  console.error('--- failed checks ---')
  for (const failure of failures) console.error(`✗ ${failure}`)
  console.error('conformance-test: FAILED')
  process.exit(1)
}
console.log('conformance-test: PASSED')
process.exit(0)
