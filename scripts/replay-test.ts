#!/usr/bin/env bun
/**
 * `check:replay` — recorded sessions, replayed through the manager, judged by
 * the turn ledger.
 *
 * Every other harness test drives a driver or a hand-written fake. The state
 * bugs users hit live in the seams between them — the order two channels
 * arrive in, a background agent finishing after the result, the CLI waking up
 * by itself, a respawned process re-reading its predecessor's transcript — so
 * this replays real sessions end to end, with their relative timing, through
 * the same manager the app runs, and asserts only what a person sees:
 *
 *   - each turn's phase (`TurnRecord.phase`), its reply and its cut-off agents;
 *   - that nothing already in the history moves: no event of an earlier
 *     checkpoint changes turn, or time (an agent's *ending* may move later);
 *   - that no turn is left waiting on anything once the replay is over.
 *
 * Scenarios come from two places:
 *   - `scripts/fixtures/replays/*.replay.json` — sanitized real sessions built
 *     by `scripts/replay-build.ts` (every reported bug becomes one of these);
 *   - `scripts/fixtures/traces/<harness>/` — the protocol captures, converted
 *     here into one-turn replays with their recorded timing.
 * ACP agents have no capture (a capture costs quota on a real account), so the
 * ACP family is covered by the fake agent in `fixtures/fake-acp-agent.ts`, and
 * says so.
 *
 * Hermetic: a temporary SEDANO_HOME, CLAUDE_CONFIG_DIR and PATH.
 *
 *   bun scripts/replay-test.ts [name-filter]
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TurnPhase } from '@shared'

const FIXTURES = join(import.meta.dir, 'fixtures')

if (!process.env.SEDANO_REPLAY_SANDBOX) {
  const work = mkdtempSync(join(tmpdir(), 'sedano-replay-'))
  const bin = join(work, 'bin')
  mkdirSync(bin, { recursive: true })
  const player = join(FIXTURES, 'replay-player.ts')
  const install = (name: string, body: string): void => {
    writeFileSync(join(bin, name), body)
    chmodSync(join(bin, name), 0o755)
  }
  install('claude', `#!/bin/sh\nexec ${process.execPath} ${player} claude "$@"\n`)
  install('cmd', `#!/bin/sh\nexec ${process.execPath} ${player} commandcode "$@"\n`)
  install('opencode', `#!/bin/sh\nexec ${process.execPath} ${join(FIXTURES, 'fake-acp-agent.ts')} "$@"\n`)
  const child = Bun.spawn([process.execPath, import.meta.path, ...process.argv.slice(2)], {
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      SEDANO_EXPLICIT_PATH: '1',
      SEDANO_BACKGROUND_SYNC: '0',
      SEDANO_HOME: join(work, 'home'),
      CLAUDE_CONFIG_DIR: join(work, 'claude'),
      SEDANO_REPLAY_SANDBOX: work,
    },
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  const code = await child.exited
  rmSync(work, { recursive: true, force: true })
  process.exit(code)
}

/* ------------------------------------------------------------------ */
/* Scenarios                                                           */
/* ------------------------------------------------------------------ */

interface Frame {
  ms: number
  stream?: unknown
  transcript?: Record<string, unknown>
  sidecar?: { agent: string; meta?: unknown; line?: Record<string, unknown> }
}
interface Cycle {
  trigger: 'prompt' | 'follow'
  frames: Frame[]
}
type Step =
  | { do: 'prompt'; text: string }
  | { do: 'settle' }
  | { do: 'checkpoint' }
  | { do: 'crash' }
  | { do: 'stop' }
  | { do: 'respawn' }
  /** `atRest`: nothing is in flight, so every number must come back unchanged. */
  | { do: 'restart'; atRest?: boolean }
  | { do: 'expectPhase'; turn: number; phase: TurnPhase }
interface TurnExpectation {
  phase: TurnPhase
  reply?: boolean
  cutOffAgents?: number
  /** Agent runs (spawn cards) filed under this turn — a resumed agent's run counts in the turn that resumed it. */
  agentRuns?: number
}
interface Scenario {
  harness: 'claude' | 'commandcode' | 'opencode'
  name: string
  description: string
  source?: string
  recordedSessionId?: string
  cycles: Cycle[]
  script: Step[]
  expect: { stableHistory?: boolean; turns: TurnExpectation[] }
}

/** Real gaps, compressed: the order is the experiment, the waiting is not. */
const GAP_CAP_MS = 150
function compress<T extends { at: number }>(items: T[]): Array<T & { ms: number }> {
  const sorted = [...items].sort((a, b) => a.at - b.at)
  let ms = 0
  let last = sorted[0]?.at ?? 0
  return sorted.map((item) => {
    ms += Math.min(GAP_CAP_MS, Math.max(0, item.at - last))
    last = item.at
    return { ...item, ms }
  })
}

interface TraceFrame {
  dir: 'agent' | 'client' | 'stderr'
  ms: number
  line: string
}
const readJsonl = (path: string): any[] =>
  readFileSync(path, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line))

/** One capture, as a one-turn replay with its recorded timing. */
function fromTrace(harness: 'claude' | 'commandcode', scenario: string): Scenario | null {
  const dir = join(FIXTURES, 'traces', harness)
  const streamPath = join(dir, `${scenario}.jsonl`)
  const metaPath = join(dir, `${scenario}.meta.json`)
  if (!existsSync(streamPath) || !existsSync(metaPath)) return null
  const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { prompt: string; outcome: string }
  if (meta.outcome !== 'ok') return null
  const stream = (readJsonl(streamPath) as TraceFrame[]).filter((frame) => frame.dir === 'agent')
  const items: Array<{ at: number; frame: Omit<Frame, 'ms'> }> = []
  const promptAt = (readJsonl(streamPath) as TraceFrame[]).find((frame) => frame.dir === 'client')?.ms ?? 0
  for (const frame of stream) {
    let parsed: unknown
    try {
      parsed = JSON.parse(frame.line)
    } catch {
      continue
    }
    items.push({ at: frame.ms, frame: { stream: parsed } })
  }
  let recordedSessionId: string | undefined
  if (harness === 'claude') {
    const transcriptPath = join(dir, `${scenario}.transcript.jsonl`)
    if (existsSync(transcriptPath)) {
      const records = readJsonl(transcriptPath)
      recordedSessionId = records.find((rec) => typeof rec.sessionId === 'string')?.sessionId
      const first = Date.parse(records[0]?.timestamp ?? '') || 0
      for (const rec of records) {
        items.push({ at: promptAt + (Date.parse(rec.timestamp ?? '') || first) - first, frame: { transcript: rec } })
      }
    }
    const sidecars = join(dir, `${scenario}.subagents`)
    if (existsSync(sidecars)) {
      for (const file of readdirSync(sidecars)) {
        const agent = file.replace(/^agent-/, '').replace(/\.(meta\.json|jsonl)$/, '')
        if (file.endsWith('.meta.json')) {
          items.push({ at: promptAt, frame: { sidecar: { agent, meta: JSON.parse(readFileSync(join(sidecars, file), 'utf8')) } } })
        } else {
          const lines = readJsonl(join(sidecars, file))
          const first = Date.parse(lines[0]?.timestamp ?? '') || 0
          for (const line of lines) {
            items.push({ at: promptAt + (Date.parse(line.timestamp ?? '') || first) - first, frame: { sidecar: { agent, line } } })
          }
        }
      }
    }
  }
  const frames = compress(items).map(({ ms, frame }) => ({ ms, ...frame }))
  const last = [...frames].reverse().find((frame) => (frame.stream as { type?: string } | undefined)?.type === 'result')
  const result = last?.stream as { is_error?: boolean; subtype?: string } | undefined
  if (!result) return null
  const failed = result.is_error === true || (result.subtype !== undefined && result.subtype !== 'success')
  return {
    harness,
    name: `trace:${harness}/${scenario}`,
    description: `the ${harness} capture "${scenario}", replayed with its recorded timing`,
    recordedSessionId,
    cycles: [{ trigger: 'prompt', frames }],
    script: [{ do: 'prompt', text: meta.prompt }, { do: 'settle' }],
    expect: { turns: [{ phase: failed ? 'failed' : 'completed', reply: !failed }] },
  }
}

/**
 * What a capture shows beyond its final frame. `subagent` launched a
 * background agent and the capture ended while it still ran: the honest state
 * is waiting on it, and a stop then cuts it off. `slash-status` is a local
 * command — no model reply at all.
 */
const TRACE_OVERRIDES: Record<string, Partial<Pick<Scenario, 'script' | 'expect'>>> = {
  'trace:claude/subagent': {
    script: [
      { do: 'prompt', text: '' },
      { do: 'settle' },
      { do: 'expectPhase', turn: 1, phase: 'waiting_agents' },
      { do: 'checkpoint' },
      { do: 'stop' },
    ],
    expect: { stableHistory: true, turns: [{ phase: 'stopped', reply: true, cutOffAgents: 1 }] },
  },
  'trace:claude/slash-status': { expect: { turns: [{ phase: 'completed' }] } },
  // A restart after the turn: the readout has to come back as it was.
  'trace:claude/skill': { script: [{ do: 'prompt', text: '' }, { do: 'settle' }, { do: 'restart', atRest: true }] },
  'trace:commandcode/plain': { script: [{ do: 'prompt', text: '' }, { do: 'settle' }, { do: 'restart', atRest: true }] },
}

function withOverrides(scenario: Scenario | null): Scenario | null {
  if (!scenario) return null
  const override = TRACE_OVERRIDES[scenario.name]
  if (!override) return scenario
  const prompt = scenario.script.find((step) => step.do === 'prompt')
  const script = override.script?.map((step) => (step.do === 'prompt' && prompt?.do === 'prompt' ? { ...step, text: prompt.text } : step))
  return { ...scenario, ...(script ? { script } : {}), ...(override.expect ? { expect: override.expect } : {}) }
}

const scenarios: Scenario[] = []
const replayDir = join(FIXTURES, 'replays')
for (const file of existsSync(replayDir) ? readdirSync(replayDir).sort() : []) {
  if (file.endsWith('.replay.json')) scenarios.push(JSON.parse(readFileSync(join(replayDir, file), 'utf8')))
}
for (const scenario of ['subagent', 'skill', 'slash-status']) {
  const found = withOverrides(fromTrace('claude', scenario))
  if (found) scenarios.push(found)
}
for (const scenario of ['plain', 'table', 'error', 'slash-status', 'slash-cost']) {
  const found = withOverrides(fromTrace('commandcode', scenario))
  if (found) scenarios.push(found)
}
// The ACP family: no capture exists (see the header), so the fake agent.
scenarios.push({
  harness: 'opencode',
  name: 'synthetic:acp/plain',
  description: 'an ACP agent (the fake in fixtures/fake-acp-agent.ts): one prompt, one answer',
  cycles: [],
  script: [{ do: 'prompt', text: 'hello' }, { do: 'settle' }, { do: 'restart', atRest: true }],
  expect: { turns: [{ phase: 'completed', reply: true }] },
})

/* ------------------------------------------------------------------ */
/* Running one                                                         */
/* ------------------------------------------------------------------ */

const manager = await import('../apps/server/src/manager.ts')
const db = await import('../apps/server/src/db.ts')
const { readDurableState } = await import('../apps/server/src/transport.ts')

const failures: string[] = []
let passedChecks = 0
function check(scenario: Scenario, label: string, ok: boolean, detail?: unknown): void {
  if (ok) passedChecks += 1
  else failures.push(`${scenario.name}: ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

async function until(label: string, predicate: () => boolean, timeoutMs = 30_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(40)
  }
}

async function run(scenario: Scenario): Promise<void> {
  const work = join(process.env.SEDANO_REPLAY_SANDBOX!, scenario.name.replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'replay.json'), JSON.stringify({ recordedSessionId: scenario.recordedSessionId, cycles: scenario.cycles }))
  process.env.SEDANO_REPLAY_DIR = work
  const cwd = join(work, 'workspace')
  mkdirSync(cwd, { recursive: true })
  const cursor = (): number => Number(existsSync(join(work, 'cursor')) ? readFileSync(join(work, 'cursor'), 'utf8') : 0) || 0
  const promptCycles = scenario.cycles.map((cycle, index) => (cycle.trigger === 'prompt' ? index : -1)).filter((index) => index >= 0)

  const session = await manager.createSession({ harness: scenario.harness, cwd, permissionMode: 'bypassPermissions' } as never)
  // Named by the user before anything happens: every respawn, restart and
  // transcript re-read below has to leave that name alone.
  const userTitle = `Named by the user · ${scenario.harness}`
  manager.renameSession(session.id, userTitle)
  const turnIds: string[] = []
  const snapshots: Array<Map<string, { at: number; turnId?: string; kind: string }>> = []
  let prompts = 0
  try {
    for (const step of scenario.script) {
      if (step.do === 'prompt') {
        const sent = await manager.sendMessage(session.id, step.text)
        check(scenario, `prompt ${prompts + 1} is accepted`, sent.ok, sent)
        if (sent.ok && sent.turnId) turnIds.push(sent.turnId)
        prompts += 1
      } else if (step.do === 'settle') {
        // Every cycle this prompt triggers has been played, and the manager has
        // been quiet for a moment: nothing more is coming until the next step.
        const target = promptCycles[prompts] ?? scenario.cycles.length
        await until('the replay to reach its next prompt', () => scenario.cycles.length === 0 || cursor() >= target)
        let seq = -1
        let quietSince = Date.now()
        await until('the session to go quiet', () => {
          const now = db.maxSeq(session.id)
          if (now !== seq) {
            seq = now
            quietSince = Date.now()
          }
          const status = manager.getSession(session.id)?.status
          return Date.now() - quietSince > 900 && status !== 'starting'
        })
      } else if (step.do === 'checkpoint') {
        snapshots.push(new Map(db.loadEvents(session.id, 100_000).map((event) => [event.id, { at: event.at, turnId: event.turnId, kind: event.ev.k }])))
      } else if (step.do === 'crash') {
        // The CLI dies under the session — a crash, a restart, a kill — and the
        // driver has to notice on its own, as it would live.
        const state = readDurableState(session.id)
        check(scenario, 'a process to crash exists', Boolean(state?.pid))
        if (state?.pid) {
          try {
            process.kill(-state.pid, 'SIGKILL')
          } catch {
            process.kill(state.pid, 'SIGKILL')
          }
        }
        await until('the crash to be noticed', () => {
          const status = manager.getSession(session.id)?.status
          return status === 'idle' || status === 'error' || status === 'stopped'
        }, 15_000).catch(() => undefined)
        await Bun.sleep(6_000)
      } else if (step.do === 'stop') {
        manager.stopSession(session.id)
      } else if (step.do === 'restart') {
        // sedano restarts and the CLI keeps running: the server lets go of its
        // process (as on SIGTERM) and a new boot reattaches to it, whose reader
        // re-reads the whole transcript — the path every live restart takes.
        const before = manager.getSession(session.id)?.metrics
        await manager.shutdown(1000)
        manager.restore()
        await Bun.sleep(2500)
        // The readout survives the restart: the same totals, and the same window
        // with the same standing (stated or estimated) — not "not reported".
        const after = manager.getSession(session.id)?.metrics
        const same = (key: 'outputTokens' | 'cacheReadTokens' | 'inputTokens' | 'contextWindow' | 'contextTokens') =>
          check(scenario, `after a restart, ${key} is what it was`, after?.[key] === before?.[key], { before: before?.[key], after: after?.[key] })
        if (step.atRest) {
          for (const key of ['outputTokens', 'cacheReadTokens', 'inputTokens', 'contextWindow', 'contextTokens'] as const) same(key)
          check(scenario, 'after a restart, the window is still reported', after?.contextReported === before?.contextReported, { before, after })
          check(scenario, 'and still stated or estimated as before', after?.contextWindowInferred === before?.contextWindowInferred, { before, after })
        } else {
          // Mid-turn the re-read transcript can be ahead of what had streamed,
          // so the numbers may grow; a window that was there must not vanish.
          check(scenario, 'after a restart mid-turn, a window that was shown still is',
            !(before?.contextWindow) || (after?.contextWindow ?? 0) > 0, { before, after })
        }
      } else if (step.do === 'expectPhase') {
        const view = manager.turnViews(session.id).find((turn) => turn.id === turnIds[step.turn - 1])
        check(scenario, `turn ${step.turn} is ${step.phase} at this point`, view?.phase === step.phase, view)
      } else if (step.do === 'respawn') {
        const applied = manager.setSessionOptions(session.id, { effort: 'high' })
        check(scenario, 'a respawn is accepted', applied.ok, applied)
      }
    }

    /* ---------------- the verdict ---------------- */

    const views = new Map(manager.turnViews(session.id).map((turn) => [turn.id, turn]))
    const row = db.getSessionRow(session.id)
    check(scenario, 'the name the user gave the session is kept', manager.getSession(session.id)?.title === userTitle, manager.getSession(session.id)?.title)
    check(scenario, 'and is what is stored', row?.title === userTitle && row?.title_source === 'user', { title: row?.title, source: row?.title_source })
    check(scenario, 'one turn per prompt', turnIds.length === scenario.expect.turns.length, { turns: turnIds.length })
    scenario.expect.turns.forEach((expected, index) => {
      const view = views.get(turnIds[index] ?? '')
      check(scenario, `turn ${index + 1} is ${expected.phase}`, view?.phase === expected.phase, view)
      if (expected.reply) {
        const reply = view?.replyEventId ? db.getEvent(session.id, view.replyEventId) : null
        check(scenario, `turn ${index + 1} has its final reply`, reply?.ev.k === 'assistant', view?.replyEventId)
      }
      if (expected.agentRuns !== undefined) {
        const runs = db.loadEventsOfKind(session.id, 'subagent_start').filter((event) => event.turnId === turnIds[index])
        check(scenario, `turn ${index + 1} has ${expected.agentRuns} agent run(s)`, runs.length === expected.agentRuns, runs.map((event) => event.id))
      }
      if (expected.cutOffAgents !== undefined) {
        check(scenario, `turn ${index + 1} cut off ${expected.cutOffAgents} agent(s)`, view?.cutOffAgents === expected.cutOffAgents, view?.cutOffAgents)
      }
    })
    // Every prompt is exactly one bubble, however many processes re-read the
    // transcript that echoes it, and every bubble belongs to a turn.
    const users = db.loadEvents(session.id, 100_000).filter((event) => event.ev.k === 'user')
    for (const step of scenario.script) {
      if (step.do !== 'prompt' || !step.text) continue
      const copies = users.filter((event) => event.ev.k === 'user' && event.ev.text === step.text)
      check(scenario, `"${step.text.slice(0, 30)}" is one bubble`, copies.length === 1, copies.map((event) => event.id))
    }
    // A card is where its own call was made: never before it (a resumed
    // agent's run used to take the time of the agent's first spawn).
    const early = db.loadEventsOfKind(session.id, 'subagent_start').filter((start) => {
      const call = start.ev.k === 'subagent_start' ? db.getEvent(session.id, `tool:${start.ev.toolId}`) : null
      return call && start.at < call.at - 1000
    })
    check(scenario, 'no agent card is earlier than its own call', early.length === 0, early.map((event) => event.id))
    const turnless = users.filter((event) => !event.turnId)
    check(scenario, 'no user bubble is outside a turn', turnless.length === 0, turnless.map((event) => event.id))
    const expectedLive = new Set(
      scenario.expect.turns
        .map((expected, index) => (expected.phase === 'running' || expected.phase === 'waiting_agents' ? turnIds[index] : null))
        .filter(Boolean),
    )
    for (const view of views.values()) {
      if (expectedLive.has(view.id)) continue
      check(scenario, `no turn is left working (${view.id.slice(0, 8)})`, view.phase !== 'running' && view.phase !== 'waiting_agents', view)
    }
    if (scenario.expect.stableHistory) {
      const now = new Map(db.loadEvents(session.id, 100_000).map((event) => [event.id, event]))
      const moved: unknown[] = []
      for (const snapshot of snapshots) {
        for (const [id, before] of snapshot) {
          const after = now.get(id)
          if (!after) continue
          if (after.turnId !== before.turnId || (before.kind !== 'subagent_end' && after.at !== before.at)) {
            moved.push({ id, before, after: { at: after.at, turnId: after.turnId } })
          }
        }
      }
      check(scenario, 'no historical event changed turn or time', moved.length === 0, moved.slice(0, 5))
    }
  } catch (error) {
    failures.push(`${scenario.name}: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    manager.removeSession(session.id)
    await Bun.sleep(300)
  }
}

const filter = process.argv[2]
for (const scenario of scenarios) {
  if (filter && !scenario.name.includes(filter)) continue
  const before = failures.length
  const started = Date.now()
  await run(scenario)
  console.log(`${failures.length === before ? '   ✓' : '   ✗'} ${scenario.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
}

if (failures.length) {
  for (const failure of failures) console.error(`   ✗ ${failure}`)
  console.error(`replay-test: FAILED (${failures.length} failed, ${passedChecks} passed)`)
  process.exit(1)
}
console.log(`replay-test: PASSED (${passedChecks} checks)`)
process.exit(0)
