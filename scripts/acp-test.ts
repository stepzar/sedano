#!/usr/bin/env bun
/**
 * ACP driver test.
 *
 * Drives `AcpDriver` against the fake agent in `scripts/fixtures/`, which speaks
 * the real protocol: streaming updates, tool calls with diffs, agent -> client
 * requests (permissions, file reads and writes), cancellation, turn usage and a
 * session that survives multiple prompts. No vendor CLI, no authentication and
 * no quota involved — so this runs on every `check:all`.
 *
 *   bun scripts/acp-test.ts
 */
import './lib/isolate.ts'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EffortLevel, SessionStatus, TimelineEvent, TokenUsage } from '@shared'
import { versionNumber } from '@shared'
import { AcpDriver, discoveredModels, discoveredVersion, primeModels, type AcpSpec } from '../apps/server/src/harnesses/acp/driver.ts'
import { ACP_AGENTS, specOf } from '../apps/server/src/harnesses/acp/adapter.ts'
import type { CreateOptions, DriverHooks } from '../apps/server/src/harnesses/types.ts'

const fixture = join(import.meta.dir, 'fixtures/fake-acp-agent.ts')
const spec: AcpSpec = { id: 'opencode', args: [fixture], models: [] }

const passed: string[] = []
const failures: string[] = []
const check = (label: string, ok: boolean, detail?: unknown): void => {
  if (ok) passed.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

interface Recorder extends DriverHooks {
  events: TimelineEvent[]
  statuses: SessionStatus[]
  deltas: Array<{ key: string; kind: string; text: string }>
  tokenCount: number
  models: string[]
  native: string | null
  resume: string | null
  errors: string[]
  usages: Array<{ usage: Partial<TokenUsage>; opts?: Record<string, number | boolean> }>
}

function recorder(): Recorder {
  const rec: Recorder = {
    events: [],
    statuses: [],
    deltas: [],
    tokenCount: 0,
    models: [],
    native: null,
    resume: null,
    errors: [],
    event: (ev) => rec.events.push(ev),
    delta: (key, kind, text) => rec.deltas.push({ key, kind, text }),
    status: (status) => rec.statuses.push(status),
    model: (model) => rec.models.push(model),
    usages: [] as Array<{ usage: Partial<TokenUsage>; opts?: Record<string, number | boolean> }>,
    usage: (usage: Partial<TokenUsage>, opts?: Record<string, number | boolean>) => {
      rec.usages.push({ usage, opts })
    },
    tokens: (count) => {
      rec.tokenCount += count
    },
    nativeId: (id) => {
      rec.native = id
    },
    resumeHint: (hint) => {
      rec.resume = hint
    },
    title: () => undefined,
    error: (message) => rec.errors.push(message),
    turnStarted: () => undefined,
    terminal: () => undefined,
    meta: () => undefined,
    limits: () => undefined,
  }
  return rec
}

function options(workdir: string, patch: Partial<CreateOptions> = {}): CreateOptions {
  return {
    sessionId: 'test-session',
    nativeId: null,
    cwd: workdir,
    host: null,
    model: null,
    effort: null,
    permissionMode: 'default',
    ...patch,
  }
}

const bun = Bun.which('bun') ?? process.execPath
const workdir = mkdtempSync(join(tmpdir(), 'sedano-acp-'))
writeFileSync(join(workdir, 'fake-read.txt'), 'hello from a file\n')

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 40))
  }
}

function texts(events: TimelineEvent[]): string[] {
  return events.filter((ev) => ev.k === 'assistant').map((ev) => ev.text)
}

/**
 * The argv every agent in the table is spawned with, for a given session.
 *
 * This is the whole point of the table: the row *is* the protocol spec, so a
 * field that goes missing on the way to the driver (which is exactly what
 * happened to `argv`) shows up here as the wrong command line.
 */
function argvFor(spec: AcpSpec, opts: { model: string | null; effort: EffortLevel | null }): string[] {
  return spec.argv?.(opts) ?? spec.args
}

/** Every entry of `ACP_AGENTS`, with the argv it must produce. */
const SPEC_TABLE: Array<{
  harness: string
  id: string
  bin: string
  args: string[]
  /** argv with no model and no effort, and with both. */
  plain: string[]
  configured: string[]
  initTimeoutMs?: number
}> = [
  {
    harness: 'opencode',
    id: 'opencode',
    bin: 'opencode',
    args: ['acp'],
    plain: ['acp'],
    configured: ['acp'],
  },
  {
    harness: 'codex',
    id: 'codex',
    bin: 'codex-acp',
    args: [],
    plain: [],
    configured: [],
  },
  {
    harness: 'gemini',
    id: 'gemini',
    bin: 'gemini',
    args: ['--acp'],
    plain: ['--acp'],
    configured: ['--acp'],
    initTimeoutMs: 180_000,
  },
  {
    harness: 'grok',
    id: 'grok',
    bin: 'grok',
    args: ['agent', 'stdio'],
    // Verified against `grok agent --help`: `stdio` is a subcommand of `agent`,
    // and `-m` / `--reasoning-effort` are options of `agent`, so they go before
    // it. `grok agent stdio -m …` is not a command grok accepts.
    plain: ['agent', 'stdio'],
    configured: ['agent', '-m', 'grok-4-fast', '--reasoning-effort', 'high', 'stdio'],
  },
]

function checkSpecTable(): void {
  check(
    'the spec table covers every wired ACP agent',
    ACP_AGENTS.length === SPEC_TABLE.length &&
      ACP_AGENTS.every((agent, index) => agent.harness === SPEC_TABLE[index]?.harness),
    ACP_AGENTS.map((agent) => agent.harness),
  )
  for (const expected of SPEC_TABLE) {
    const agent = ACP_AGENTS.find((entry) => entry.harness === expected.harness)
    if (!agent) {
      check(`${expected.harness}: is in the table`, false)
      continue
    }
    check(`${expected.harness}: the binary looked for`, agent.bin === expected.bin, agent.bin)
    const spec = specOf(agent)
    check(`${expected.harness}: the spec keeps its id`, spec.id === expected.id, spec.id)
    check(
      `${expected.harness}: the spec keeps its args`,
      JSON.stringify(spec.args) === JSON.stringify(expected.args),
      spec.args,
    )
    check(
      `${expected.harness}: the spec keeps its init timeout`,
      spec.initTimeoutMs === expected.initTimeoutMs,
      spec.initTimeoutMs,
    )
    check(
      `${expected.harness}: the spec keeps its env`,
      JSON.stringify(spec.env ?? null) === JSON.stringify(agent.env ?? null),
      spec.env,
    )
    check(`${expected.harness}: the spec keeps its argv builder`, Boolean(spec.argv) === Boolean(agent.argv))
    check(
      `${expected.harness}: argv with no model or effort`,
      JSON.stringify(argvFor(spec, { model: null, effort: null })) === JSON.stringify(expected.plain),
      argvFor(spec, { model: null, effort: null }),
    )
    check(
      `${expected.harness}: argv with a model and an effort`,
      JSON.stringify(argvFor(spec, { model: 'grok-4-fast', effort: 'high' })) === JSON.stringify(expected.configured),
      argvFor(spec, { model: 'grok-4-fast', effort: 'high' }),
    )
  }
}

async function main(): Promise<void> {
  /* ---------------- the vendor table ---------------- */

  checkSpecTable()

  /* ---------------- versions read as numbers ---------------- */

  for (const [raw, expected] of [
    ['@agentclientprotocol/codex-acp 1.4.0', '1.4.0'],
    ['2.1.282 (Claude Code)', '2.1.282'],
    ['gemini 0.9.0-preview.3', '0.9.0-preview.3'],
    ['v1.2', '1.2'],
    ['nightly', 'nightly'],
    ['  ', null],
  ] as const) {
    check(`version “${raw}” reads as ${expected}`, versionNumber(raw) === expected, versionNumber(raw))
  }

  /* ---------------- one session, many turns ---------------- */

  {
    const hooks = recorder()
    const driver = new AcpDriver(options(workdir), hooks, spec, bun)
    await driver.start()

    check('the handshake produced a native session id', hooks.native === 'fake-session-1', hooks.native)
    check('a resume hint is offered', Boolean(hooks.resume?.includes('fake-session-1')), hooks.resume)
    // Only the number: `agentInfo.name` is a package name for some vendors
    // (codex-acp says `@agentclientprotocol/codex-acp`) and ate the picker row.
    check('the agent version is remembered as a bare number', discoveredVersion('opencode') === '9.9.9', discoveredVersion('opencode'))
    check(
      'the models the agent reported replace the static list',
      (discoveredModels('opencode') ?? []).some((model) => model.id === 'fake-model-1'),
      discoveredModels('opencode'),
    )
    check(
      'the current ACP model carries the effort choices the agent reported',
      (discoveredModels('opencode') ?? []).find((model) => model.id === 'fake-model-1')?.efforts?.join(',') === 'low,medium,high',
      discoveredModels('opencode'),
    )
    check('the current model is published before the first turn', hooks.models.includes('fake-model-1'), hooks.models)
    check('the session is idle once it is ready', hooks.statuses.at(-1) === 'idle', hooks.statuses)

    const firstDelivery = await driver.send('first')
    check('an ACP prompt is accepted without waiting for the turn result', firstDelivery.status === 'accepted', firstDelivery)
    await waitFor('the first turn to finish', () => hooks.events.some((ev) => ev.k === 'result'))
    check('the turn reports running then idle', hooks.statuses.includes('running') && hooks.statuses.at(-1) === 'idle', hooks.statuses)
    check('thinking is committed as its own event', hooks.events.some((ev) => ev.k === 'thinking'), hooks.events.map((ev) => ev.k))
    check('prose arrives as deltas before it is committed', hooks.deltas.some((delta) => delta.kind === 'text'), hooks.deltas)
    // tokens/sec is built from the deltas (the manager counts their characters);
    // a second chars/4 estimate on top of them doubled the speed.
    check('live speed comes from the deltas alone, not counted twice', hooks.tokenCount === 0 && hooks.deltas.length > 0, hooks.tokenCount)
    check('the answer is committed once, whole', texts(hooks.events).length === 1, texts(hooks.events))

    const tool = hooks.events.find((ev) => ev.k === 'tool')
    check('a tool call becomes a tool event', tool !== undefined && tool.k === 'tool' && tool.name === 'Fake Tool', tool)
    check('the ACP kind travels with the tool call', tool?.k === 'tool' && tool.kind === 'edit', tool)
    const toolResult = hooks.events.find((ev) => ev.k === 'tool_result')
    check('a finished ACP call is timed', toolResult?.k === 'tool_result' && typeof toolResult.durationMs === 'number', toolResult)
    const change = hooks.events.find((ev) => ev.k === 'file_change')
    check(
      'a diff becomes a file change with real counts',
      change?.k === 'file_change' && change.path === 'src/thing.ts' && change.added === 1 && change.removed === 0,
      change,
    )
    check('the file change carries a preview', change?.k === 'file_change' && change.preview.includes('src/thing.ts'), change)
    const result = hooks.events.find((ev) => ev.k === 'result')
    check('the turn ends with a result and its usage', result?.k === 'result' && result.usage?.output === 22, result)
    check('the tool result is not an error', hooks.events.some((ev) => ev.k === 'tool_result' && !ev.isError))

    const pid = /pid (\d+)/.exec(texts(hooks.events)[0] ?? '')?.[1]
    driver.send('second')
    await waitFor('the second turn to finish', () => hooks.events.filter((ev) => ev.k === 'result').length === 2)
    const answers = texts(hooks.events)
    check('the second message continues the same session', answers.at(-1)?.includes('prompt 2') === true, answers.at(-1))
    check(
      'and it is the same agent process, not a new command',
      pid !== undefined && answers.at(-1)?.includes(`pid ${pid}`) === true,
      { pid, last: answers.at(-1) },
    )
    check('two turns mean two results, not two sessions', hooks.native === 'fake-session-1')

    driver.stop()
    await new Promise((resolve) => setTimeout(resolve, 300))
    check('stopping the driver kills the agent', driver.alive === false)
    const refused = await driver.send('after stop')
    check('a stopped ACP driver explicitly refuses a prompt', refused.status === 'refused', refused)
  }

  /* ---------------- usage reaches the metrics ---------------- */

  {
    const hooks = recorder()
    const driver = new AcpDriver(options(workdir), hooks, spec, bun)
    await driver.start()
    driver.send('hello')
    await waitFor('the turn', () => hooks.events.some((ev) => ev.k === 'result'))
    check(
      'usage the agent reports reaches the metrics',
      hooks.usages.some((entry) => entry.opts?.contextTokens === 1234 && entry.opts?.contextWindow === 200_000),
      hooks.usages,
    )
    check(
      'and its cost is not thrown away',
      hooks.usages.some((entry) => entry.opts?.costUsd === 0.0123),
      hooks.usages,
    )
    driver.stop()
  }

  /* ---------------- permissions follow the approval mode ---------------- */

  for (const [mode, expected] of [
    ['plan', 'permission=reject'],
    ['acceptEdits', 'permission=allow-once'],
    ['auto', 'permission=allow-once'],
    ['bypassPermissions', 'permission=allow-once'],
  ] as const) {
    const hooks = recorder()
    const driver = new AcpDriver(options(workdir, { permissionMode: mode }), hooks, spec, bun)
    await driver.start()
    // An edit of a file inside the workspace: the one thing accept edits covers.
    driver.send('ask me perm-path=src/inside.ts')
    await waitFor(`the ${mode} turn`, () => hooks.events.some((ev) => ev.k === 'result'))
    check(`${mode}: the permission request is answered by the mode`, texts(hooks.events).some((text) => text.includes(expected)), {
      mode,
      got: texts(hooks.events),
    })
    check(
      `${mode}: the decision is visible in the transcript`,
      hooks.events.some((ev) => ev.k === 'system' && ev.subtype === 'permission'),
      hooks.events.filter((ev) => ev.k === 'system'),
    )
    check(`${mode}: automatic approval is not shown as a question`, !hooks.events.some((ev) => ev.k === 'request'))
    driver.stop()
  }

  /* ---------------- accept edits stays inside the workspace ---------------- */

  {
    // A symlink inside the workspace that leads out of it is outside.
    const outside = mkdtempSync(join(tmpdir(), 'sedano-acp-outside-'))
    symlinkSync(outside, join(workdir, 'escape'))
    const cases: Array<[string, string]> = [
      ['an edit outside the workspace', `perm-path=${outside}/x.ts`],
      ['an edit through a symlink that leaves it', 'perm-path=escape/x.ts'],
      ['an edit that climbs out with ..', 'perm-path=../elsewhere.ts'],
      ['an edit that names no file', ''],
      ['a delete, even inside', 'perm-kind=delete perm-path=src/inside.ts'],
      ['a move, even inside', 'perm-kind=move perm-path=src/inside.ts'],
      ['a shell command', 'perm-kind=execute'],
    ]
    for (const mode of ['acceptEdits', 'auto'] as const) {
      for (const [label, shape] of cases) {
        const hooks = recorder()
        const driver = new AcpDriver(options(workdir, { permissionMode: mode }), hooks, spec, bun)
        await driver.start()
        driver.send(`ask me ${shape}`)
        await waitFor(`${mode}: ${label} as a card`, () => hooks.events.some((ev) => ev.k === 'request' && ev.kind === 'permission'))
        check(
          `${mode}: ${label} is put to the person, not approved by the mode`,
          !texts(hooks.events).some((text) => text.includes('permission=')),
          texts(hooks.events),
        )
        driver.stop()
      }
    }
    rmSync(outside, { recursive: true, force: true })
  }

  /* ---------------- a mode that asks, asks ---------------- */

  {
    const hooks = recorder()
    const driver = new AcpDriver(options(workdir, { permissionMode: 'default' }), hooks, spec, bun)
    await driver.start()
    driver.send('ask me')
    await waitFor(
      'the question',
      () => hooks.events.some((ev) => ev.k === 'request' && ev.kind === 'permission'),
    )
    const question = hooks.events.find((ev) => ev.k === 'request' && ev.kind === 'permission') as
      | Extract<TimelineEvent, { k: 'request' }>
      | undefined
    const offered = question?.options ?? []
    check('an agent that asks becomes a native request card', Boolean(question), { events: hooks.events.map((e) => e.k) })
    check('the request is not disguised as a tool', !hooks.events.some((ev) => ev.k === 'tool' && ev.name === 'AskUserQuestion'))
    check(
      'the options are the agent\'s own, with their ids',
      (offered ?? []).some((option) => option.id === 'allow-once'),
      offered,
    )
    check(
      'and nothing is answered until a person answers',
      !texts(hooks.events).some((text) => text.includes('permission=')),
      texts(hooks.events),
    )
    // The answer the UI would send.
    driver.answerQuestion(question!.requestId, 'allow-once')
    await waitFor('the answered turn', () => hooks.events.some((ev) => ev.k === 'result'))
    check(
      'the answer reaches the agent and the turn finishes',
      texts(hooks.events).some((text) => text.includes('permission=allow-once')),
      texts(hooks.events),
    )
    driver.stop()
  }

  /* ---------------- the protocol's own question ---------------- */

  {
    const hooks = recorder()
    const driver = new AcpDriver(options(workdir), hooks, spec, bun)
    await driver.start()
    driver.send('elicit this')
    await waitFor(
      'the elicitation card',
      () => hooks.events.some((ev) => ev.k === 'request' && ev.kind === 'question'),
    )
    const question = hooks.events.find((ev) => ev.k === 'request' && ev.kind === 'question') as
      | Extract<TimelineEvent, { k: 'request' }>
      | undefined
    const offered = question?.options ?? []
    check('an elicitation becomes the same native request card', Boolean(question), { got: hooks.events.map((e) => e.k) })
    check(
      'with the schema\u2019s own choices and their wording',
      offered.some((option) => option.id === 'balanced' && option.label === 'Balanced'),
      offered,
    )
    driver.answerQuestion(question!.requestId, 'balanced')
    await waitFor('the elicited turn', () => hooks.events.some((ev) => ev.k === 'result'))
    check(
      'and the choice reaches the agent as an accepted answer',
      texts(hooks.events).some((t) => t.includes('elicited=accept:balanced')),
      texts(hooks.events),
    )
    driver.stop()
  }

  /* ---------------- file access goes through the client ---------------- */

  {
    const hooks = recorder()
    const driver = new AcpDriver(options(workdir, { permissionMode: 'acceptEdits' }), hooks, spec, bun)
    await driver.start()
    driver.send('read it')
    await waitFor('the read turn', () => hooks.events.some((ev) => ev.k === 'result'))
    check(
      'fs/read_text_file is served from disk',
      texts(hooks.events).some((text) => text.includes('read:hello from a file')),
      texts(hooks.events),
    )
    driver.send('write it perm-path=fake-write.txt')
    await waitFor('the write turn', () => hooks.events.filter((ev) => ev.k === 'result').length === 2)
    check(
      'fs/write_text_file writes the file',
      existsSync(join(workdir, 'fake-write.txt')) &&
        readFileSync(join(workdir, 'fake-write.txt'), 'utf8').includes('fake agent'),
    )
    driver.stop()
  }

  /* ---------------- cancel and failure ---------------- */

  {
    const hooks = recorder()
    const driver = new AcpDriver(options(workdir), hooks, spec, bun)
    await driver.start()
    driver.send('please cancel this')
    await waitFor('the turn to start', () => hooks.statuses.includes('running'))
    await new Promise((resolve) => setTimeout(resolve, 200))
    driver.interrupt()
    await waitFor('the cancelled turn to end', () => hooks.events.some((ev) => ev.k === 'result'))
    const result = hooks.events.find((ev) => ev.k === 'result')
    check('an interrupted turn reports cancellation', result?.k === 'result' && result.subtype === 'cancelled', result)
    driver.stop()
  }

  {
    const hooks = recorder()
    const driver = new AcpDriver(options(workdir), hooks, spec, bun)
    await driver.start()
    driver.send('fail now')
    await waitFor('the failure', () => hooks.errors.length > 0)
    check('a refused prompt surfaces as an error', hooks.errors[0]?.includes('refused') === true, hooks.errors)
    check('and the session is marked failed', hooks.statuses.at(-1) === 'error', hooks.statuses)
    // One failure, one error. The manager turns `hooks.error` into the timeline
    // event, so a driver that also emits one printed every failure twice.
    await new Promise((resolve) => setTimeout(resolve, 200))
    check('a failed turn is reported exactly once', hooks.errors.length === 1, hooks.errors)
    check(
      'and the driver does not write a second error event of its own',
      hooks.events.filter((ev) => ev.k === 'error').length === 0,
      hooks.events.filter((ev) => ev.k === 'error'),
    )
    driver.stop()
  }

  /* ---------------- configure: applied, refused, reset ---------------- */

  {
    const encodedSpec: AcpSpec = {
      id: 'encoded-models', args: [fixture], models: [], env: { FAKE_ACP_ENCODED_MODELS: '1' },
    }
    const hooks = recorder()
    const driver = new AcpDriver(options(workdir, { model: 'fake-model-2[high]', effort: 'high' }), hooks, encodedSpec, bun)
    await driver.start()
    check('encoded catalog model is applied through base model plus effort', hooks.models.at(-1) === 'fake-model-2[high]', hooks.models)
    check('initial encoded model is applied before idle', hooks.statuses.at(-1) === 'idle' && hooks.errors.length === 0)
    driver.stop()

    const liveHooks = recorder()
    const live = new AcpDriver(options(workdir), liveHooks, encodedSpec, bun)
    await live.start()
    live.configure({ model: 'fake-model-2[high]', effort: 'high' })
    await live.send('hello')
    await waitFor('encoded model turn', () => liveHooks.events.some((ev) => ev.k === 'result'))
    const answer = liveHooks.events.find((ev) => ev.k === 'assistant')
    check('prompt waits for the encoded model selection', answer?.k === 'assistant' && answer.model === 'fake-model-2[high]', answer)
    live.stop()

    const resumedHooks = recorder()
    const resumed = new AcpDriver(options(workdir, { nativeId: 'fake-session-1', model: 'fake-model-2[high]' }), resumedHooks, encodedSpec, bun)
    await resumed.start()
    check('loaded session retains encoded catalog semantics', resumedHooks.models.at(-1) === 'fake-model-2[high]', resumedHooks.models)
    resumed.stop()
  }

  {
    const hooks = recorder()
    const badSpec: AcpSpec = { id: 'encoded-refuser', args: [fixture], models: [], env: { FAKE_ACP_ENCODED_MODELS: '1' } }
    const driver = new AcpDriver(options(workdir, { model: 'fake-model-2[ultra]' }), hooks, badSpec, bun)
    let rejected = false
    try { await driver.start() } catch { rejected = true }
    check('invalid initial model blocks session start instead of running the default', rejected && !hooks.statuses.includes('idle'))
    driver.stop()
  }

  {
    // A model the agent accepts: published only once its answer says so.
    const hooks = recorder()
    const driver = new AcpDriver(options(workdir), hooks, spec, bun)
    await driver.start()
    const before = hooks.models.length
    driver.configure({ model: 'fake-model-2' })
    await waitFor('the model change', () => hooks.models.length > before)
    check('a model the agent takes is published', hooks.models.at(-1) === 'fake-model-2', hooks.models)
    check('and changing it is not an error', hooks.errors.length === 0, hooks.errors)
    driver.send('hello')
    await waitFor('the turn', () => hooks.events.some((ev) => ev.k === 'result'))
    const answer = hooks.events.find((ev) => ev.k === 'assistant')
    check(
      'the answer is labelled with the model that ran, not the one asked for',
      answer?.k === 'assistant' && answer.model === 'fake-model-2',
      answer,
    )
    driver.stop()
  }

  {
    // A model the agent does not have: an error, and nothing published.
    const hooks = recorder()
    const driver = new AcpDriver(options(workdir), hooks, spec, bun)
    await driver.start()
    driver.configure({ model: 'not-a-model' })
    await waitFor('the refusal', () => hooks.errors.length > 0)
    check('a refused model surfaces as an error', hooks.errors[0]?.includes('not-a-model') === true, hooks.errors)
    check(
      'and the refused model is never published as applied',
      !hooks.models.includes('not-a-model'),
      hooks.models,
    )
    driver.stop()
  }

  {
    // An agent that has no session config options at all: the change is not
    // lost, it waits for a fresh process.
    const hooks = recorder()
    const oldSpec: AcpSpec = { id: 'oldagent', args: [fixture], models: [], env: { FAKE_ACP_NO_CONFIG: '1' } }
    const driver = new AcpDriver(options(workdir), hooks, oldSpec, bun)
    await driver.start()
    driver.configure({ model: 'fake-model-2' })
    await waitFor(
      'the respawn notice',
      () => hooks.events.some((ev) => ev.k === 'system' && ev.subtype === 'config-pending'),
    )
    check('an agent that cannot change live says when it will', true)
    check('and it is dropped so the next message respawns it', driver.alive === false)
    driver.stop()
  }

  {
    // Clearing the model back to the agent's default: the protocol has no value
    // for "no model", so this is a respawn, and it says so.
    const hooks = recorder()
    const driver = new AcpDriver(options(workdir, { model: 'fake-model-2' }), hooks, spec, bun)
    await driver.start()
    driver.configure({ model: null })
    await waitFor(
      'the reset notice',
      () => hooks.events.some((ev) => ev.k === 'system' && ev.subtype === 'config-pending'),
    )
    check('resetting the model is honoured rather than ignored', driver.alive === false)
    check('and it is not reported as a failure', hooks.errors.length === 0, hooks.errors)
    driver.stop()
  }

  {
    // Effort, which ACP models as a `thought_level` config option.
    const hooks = recorder()
    const driver = new AcpDriver(options(workdir), hooks, spec, bun)
    await driver.start()
    driver.configure({ effort: 'high' })
    await new Promise((resolve) => setTimeout(resolve, 400))
    check('an effort the agent exposes is applied without an error', hooks.errors.length === 0, hooks.errors)
    check(
      'and without dropping the agent',
      driver.alive === true &&
        !hooks.events.some((ev) => ev.k === 'system' && ev.subtype === 'config-pending'),
      hooks.events.filter((ev) => ev.k === 'system'),
    )
    driver.stop()
  }

  {
    // Session config is model-dependent. Once model two removes the effort
    // selector, the id learned from model one must not leak into the request.
    const hooks = recorder()
    const dynamicSpec: AcpSpec = {
      id: 'dynamiceffort',
      args: [fixture],
      models: [],
      env: { FAKE_ACP_MODEL_EFFORTS: '1' },
    }
    const driver = new AcpDriver(options(workdir), hooks, dynamicSpec, bun)
    await driver.start()
    driver.configure({ model: 'fake-model-2', effort: 'max' })
    await waitFor(
      'the model-specific effort fallback',
      () => hooks.events.some((ev) => ev.k === 'system' && ev.subtype === 'config-pending'),
    )
    check('a removed effort selector is not called through its stale id', hooks.errors.length === 0, hooks.errors)
    driver.stop()
  }

  {
    // An agent that refuses the value it was handed.
    const hooks = recorder()
    const refuseSpec: AcpSpec = {
      id: 'refuser',
      args: [fixture],
      models: [],
      env: { FAKE_ACP_REFUSE_CONFIG: '1' },
    }
    const driver = new AcpDriver(options(workdir), hooks, refuseSpec, bun)
    await driver.start()
    driver.configure({ effort: 'high' })
    await waitFor('the refusal', () => hooks.errors.length > 0)
    check(
      'a refused effort surfaces as an error instead of being swallowed',
      hooks.errors[0]?.includes('reasoning effort') === true,
      hooks.errors,
    )
    driver.stop()
  }

  /* ---------------- resuming does not duplicate the transcript ---------------- */

  {
    const hooks = recorder()
    const driver = new AcpDriver(options(workdir, { nativeId: 'fake-session-1' }), hooks, spec, bun)
    await driver.start()
    await new Promise((resolve) => setTimeout(resolve, 300))
    check('a resumed session keeps its id', hooks.native === 'fake-session-1', hooks.native)
    check(
      'the replayed history is not re-rendered (it is already in the transcript)',
      !hooks.events.some((ev) => ev.k === 'assistant' && ev.text.includes('REPLAYED HISTORY')),
      hooks.events,
    )
    check(
      'but what the agent says after the replay is kept',
      hooks.events.length === 0 || hooks.events.every((ev) => ev.k === 'system'),
      hooks.events,
    )
    // `LoadSessionResponse` carries the same optional `configOptions` a new
    // session does ("Initial session configuration options if supported by the
    // Agent"), so a reopened conversation can say what model it is on. Ignoring
    // it is how a resumed tab came back reporting no model at all.
    check('a resumed session learns the model it is running', hooks.models.at(-1) === 'fake-model-1', hooks.models)
    driver.stop()
  }

  {
    // The other legal answer: `{}`. The state in that response is optional, and
    // an agent that omits it has told us nothing — which must read as nothing,
    // not as a guess and not as an error.
    const hooks = recorder()
    const bareSpec: AcpSpec = { id: 'bareload', args: [fixture], models: [], env: { FAKE_ACP_LOAD_BARE: '1' } }
    const driver = new AcpDriver(options(workdir, { nativeId: 'fake-session-1' }), hooks, bareSpec, bun)
    await driver.start()
    await new Promise((resolve) => setTimeout(resolve, 300))
    check('an agent that says nothing on load is still resumed', hooks.native === 'fake-session-1', hooks.native)
    check('and nothing is invented about its model', hooks.models.length === 0, hooks.models)
    check('and it is not treated as a failure', hooks.errors.length === 0, hooks.errors)
    driver.stop()
  }

  /* ---------------- an agent that asks to be signed in ---------------- */

  {
    // Grok's shape: `session/new` and `session/load` both refuse until the
    // client names one of the agent's own sign-in methods.
    const hooks = recorder()
    const signInSpec: AcpSpec = { id: 'signin', args: [fixture], models: [], env: { FAKE_ACP_SIGNIN: '1' } }
    const driver = new AcpDriver(options(workdir), hooks, signInSpec, bun)
    await driver.start()
    check('a session opens once the agent has been signed in', hooks.native === 'fake-session-1', hooks.native)
    check(
      'the transcript says a sign-in is happening',
      hooks.events.some((ev) => ev.k === 'system' && ev.subtype === 'auth' && ev.text.includes('sign in')),
      hooks.events,
    )
    check('and the session is usable afterwards', hooks.statuses.at(-1) === 'idle', hooks.statuses)
    driver.stop()
  }

  /* ---------------- the handshake can be the model list ---------------- */

  {
    // Grok reports its version and its models in the handshake's own `_meta`,
    // and gives `session/new` no model list at all — so a picker that only read
    // the session would offer Grok one nameless model.
    const hooks = recorder()
    const metaSpec: AcpSpec = { id: 'metaagent', args: [fixture], models: [], env: { FAKE_ACP_META: '1' } }
    const driver = new AcpDriver(options(workdir), hooks, metaSpec, bun)
    await driver.start()
    check(
      'models come from the handshake when the session reports none',
      (discoveredModels('metaagent') ?? []).map((model) => model.id).join(',') === 'fake-model-9',
      discoveredModels('metaagent'),
    )
    check('the model the agent is running is published', hooks.models.includes('fake-model-9'), hooks.models)
    check('and the version it reported is remembered', discoveredVersion('metaagent') === '9.9.9', discoveredVersion('metaagent'))
    driver.stop()
  }

  /* ---------------- priming never signs anyone in ---------------- */

  {
    // A background scan may not open a browser window: it takes whatever the
    // handshake gave and leaves the sign-in for the moment you open a session.
    const models = await primeModels(
      { id: 'primesignin', args: [fixture], models: [], env: { FAKE_ACP_SIGNIN: '1', FAKE_ACP_META: '1' } },
      bun,
      workdir,
    )
    check('priming reads the handshake models', (models ?? []).map((model) => model.id).join(',') === 'fake-model-9', models)
  }

  {
    // ACP options can change with every model. The isolated scan switches the
    // throwaway session through the catalog and records each exact answer.
    const models = await primeModels(
      { id: 'primeefforts', args: [fixture], models: [], env: { FAKE_ACP_MODEL_EFFORTS: '1' } },
      bun,
      workdir,
    )
    check(
      'priming records effort capability per model',
      models?.find((model) => model.id === 'fake-model-1')?.efforts?.join(',') === 'low,medium,high' &&
        models?.find((model) => model.id === 'fake-model-2')?.efforts?.length === 0,
      models,
    )
    check(
      'priming marks the model the harness currently uses as its default',
      models?.find((model) => model.id === 'fake-model-1')?.isDefault === true,
      models,
    )
  }
}

try {
  await main()
} catch (error) {
  failures.push(`threw: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  rmSync(workdir, { recursive: true, force: true })
}

for (const label of passed) console.log(`   ✓ ${label}`)
if (failures.length) {
  for (const label of failures) console.error(`   ✗ ${label}`)
  console.error(`acp-test: FAILED (${failures.length}/${passed.length + failures.length})`)
  /* ---------------- leave the store as we found it ---------------- */

// Priming with the fake agent writes its models into the same cache the app
// reads, and they showed up in the picker as if they were real. Cleared here so
// running the tests cannot put fixtures in front of a person.
{
  const { kvGet, kvSet } = await import('../apps/server/src/db.ts')
  const raw = kvGet('models')
  if (raw) {
    const cache = JSON.parse(raw) as Record<string, Record<string, Array<{ id?: string }>>>
    let changed = false
    for (const [machine, byHarness] of Object.entries(cache)) {
      for (const [harness, models] of Object.entries(byHarness)) {
        if (models.length && models.every((model) => String(model.id ?? '').startsWith('fake-model'))) {
          delete byHarness[harness]
          changed = true
        }
      }
      if (!Object.keys(byHarness).length) delete cache[machine]
    }
    if (changed) kvSet('models', JSON.stringify(cache))
  }
  console.log('  (fixture catalogues cleared from the store)')
}

process.exit(1)
}
/* ---------------- leave the store as we found it ---------------- */

// Priming with the fake agent writes its models into the same cache the app
// reads, and they showed up in the picker as if they were real. Cleared here so
// running the tests cannot put fixtures in front of a person.
{
  const { kvGet, kvSet } = await import('../apps/server/src/db.ts')
  const raw = kvGet('models')
  if (raw) {
    const cache = JSON.parse(raw) as Record<string, Record<string, Array<{ id?: string }>>>
    let changed = false
    for (const [machine, byHarness] of Object.entries(cache)) {
      for (const [harness, models] of Object.entries(byHarness)) {
        if (models.length && models.every((model) => String(model.id ?? '').startsWith('fake-model'))) {
          delete byHarness[harness]
          changed = true
        }
      }
      if (!Object.keys(byHarness).length) delete cache[machine]
    }
    if (changed) kvSet('models', JSON.stringify(cache))
  }
}

console.log(`acp-test: PASSED (${passed.length} checks)`)
