/**
 * Versioned transcript fixtures.
 *
 * The render checks used to read whatever `~/.sedano/sedano.db` happened to
 * contain, which made them a report on one machine's history rather than a test:
 * a clean checkout had nothing to assert, and a busy one asserted something
 * different every run. These transcripts are the scenarios that actually matter,
 * written down once with the answer they must produce.
 *
 * Each fixture carries its own expectations so the assertions live next to the
 * events they describe. They double as the store the browser checks are seeded
 * with, so what a human sees on screen is the same data the unit-level check
 * asserts on.
 */
import type { HarnessId, SessionEvent, SessionKind, TimelineEvent, TokenUsage } from '@shared'

/** Fixed clock: a fixture that drifts with wall time is not a fixture. */
export const FIXTURE_EPOCH = 1_760_000_000_000

function usage(output: number): TokenUsage {
  return { input: 1200, output, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
}

/** What `buildRows`/`buildTurns` must produce for a fixture. */
export interface TranscriptExpectation {
  /** Turns a stopped session shows. */
  turns: number
  /** Subagent cards nested out of the flat event list. */
  groups: number
  /** Cards whose completion row is the harness' premature, empty write. */
  provisionalGroups: number
  /** Cards still waiting on their agent while the session is live. */
  runningGroupsWhenLive: number
}

export interface TranscriptFixture {
  id: string
  title: string
  /** Why this scenario is in the suite at all. */
  note: string
  harness: HarnessId
  kind: SessionKind
  cwd: string
  model: string | null
  events: SessionEvent[]
  expect: TranscriptExpectation
}

/** Builds a session's events with sequential seq/at, so fixtures stay readable. */
function transcript(
  sessionId: string,
  entries: Array<{ ev: TimelineEvent; agentId?: string; id?: string }>,
): SessionEvent[] {
  return entries.map((entry, index) => {
    // A completion is stored the way the Claude driver writes it: one row per
    // agent, under `subagent_end:<tool id>` and filed as the agent's own. A
    // completion without that identity closed nothing in the actor ledger, so
    // every start of the server "cut off" an agent that had long finished.
    const end = entry.ev.k === 'subagent_end' ? entry.ev : null
    const agentId = entry.agentId ?? end?.agentId
    return {
      id: entry.id ?? (end ? `subagent_end:${end.toolId}` : `${sessionId}-${index + 1}`),
      sessionId,
      seq: index + 1,
      at: FIXTURE_EPOCH + index * 1000,
      ...(agentId ? { agentId } : {}),
      ev: entry.ev,
    }
  })
}

const PATCH = `@@ -1,4 +1,6 @@
 export function greet(name: string) {
-  return 'hi'
+  if (!name) throw new Error('name required')
+  return \`hi \${name}\`
 }
`

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** The ordinary case: one prompt, some work, one reply, one result. */
const plainTurn: TranscriptFixture = {
  id: 'fixture-plain-turn',
  title: 'Harden the greet helper',
  note: 'a finished turn must render as one turn with no card and nothing running',
  harness: 'claude',
  kind: 'agent',
  cwd: '',
  model: 'sonnet',
  events: transcript('fixture-plain-turn', [
    { ev: { k: 'system', subtype: 'init', text: 'session started in the fixture workspace' } },
    { ev: { k: 'user', text: 'Make greet() reject an empty name.' } },
    { ev: { k: 'thinking', text: 'The helper has no guard, so an empty name returns a bare "hi".' } },
    { ev: { k: 'assistant', text: 'Reading the helper first.', model: 'sonnet' } },
    { ev: { k: 'tool', toolId: 'tool-read-1', name: 'Read', input: { path: 'src/greet.ts' }, summary: 'src/greet.ts' } },
    { ev: { k: 'tool_result', toolId: 'tool-read-1', text: "export function greet(name: string) {\n  return 'hi'\n}", isError: false, truncated: false } },
    { ev: { k: 'tool', toolId: 'tool-edit-1', name: 'Edit', input: { path: 'src/greet.ts' }, summary: 'src/greet.ts' } },
    { ev: { k: 'file_change', toolId: 'tool-edit-1', path: 'src/greet.ts', change: 'edit', added: 2, removed: 1, preview: PATCH } },
    { ev: { k: 'tool_result', toolId: 'tool-edit-1', text: 'ok', isError: false, truncated: false } },
    { ev: { k: 'assistant', text: 'Done: `greet()` now throws on an empty name.', model: 'sonnet', usage: usage(180) } },
    { ev: { k: 'result', subtype: 'success', text: '', usage: usage(180), durationMs: 8200, costUsd: 0.0123 } },
  ]),
  // The `system` preamble before the first prompt is a turn with no user message.
  expect: { turns: 2, groups: 0, provisionalGroups: 0, runningGroupsWhenLive: 0 },
}

/** A subagent that finished, with the metrics row the harness writes last. */
const finishedSubagent: TranscriptFixture = {
  id: 'fixture-subagent-done',
  title: 'Audit the auth middleware',
  note: 'a completed sidechain nests under its spawn card and stops running',
  harness: 'claude',
  kind: 'agent',
  cwd: '',
  model: 'opus',
  events: transcript('fixture-subagent-done', [
    { ev: { k: 'user', text: 'Audit the auth middleware with a subagent.' } },
    { ev: { k: 'tool', toolId: 'tool-task-1', name: 'Task', input: { subagent_type: 'general-purpose' }, summary: 'audit auth' } },
    {
      ev: {
        k: 'subagent_start',
        toolId: 'tool-task-1',
        agentId: 'agent-1',
        agentType: 'general-purpose',
        description: 'Audit the auth middleware',
        prompt: 'Read apps/server/src/auth.ts and report every unchecked path.',
        depth: 1,
        model: 'sonnet',
      },
    },
    { agentId: 'agent-1', ev: { k: 'tool', toolId: 'tool-grep-1', name: 'Grep', input: { pattern: 'requireUser' }, summary: 'requireUser' } },
    { agentId: 'agent-1', ev: { k: 'tool_result', toolId: 'tool-grep-1', text: 'apps/server/src/auth.ts:42', isError: false, truncated: false } },
    { agentId: 'agent-1', ev: { k: 'assistant', text: 'Two routes skip requireUser.', model: 'sonnet' } },
    {
      ev: {
        k: 'subagent_end',
        toolId: 'tool-task-1',
        agentId: 'agent-1',
        status: 'done',
        durationMs: 14_500,
        usage: usage(640),
        toolUses: 2,
        result: 'Two routes skip requireUser.',
      },
    },
    { ev: { k: 'assistant', text: 'The audit found two unprotected routes.', model: 'opus', usage: usage(210) } },
    { ev: { k: 'result', subtype: 'success', text: '', usage: usage(210), durationMs: 21_000, costUsd: 0.0410 } },
  ]),
  expect: { turns: 1, groups: 1, provisionalGroups: 0, runningGroupsWhenLive: 0 },
}

/**
 * The premature completion: the harness writes an empty completion row and only
 * then the sidechain does its work. Treating that row as "finished" is what made
 * a working subagent look done.
 */
const prematureCompletion: TranscriptFixture = {
  id: 'fixture-subagent-premature',
  title: 'Trace the flaky upload test',
  note: 'an empty completion row followed by its own work stays provisional',
  harness: 'claude',
  kind: 'agent',
  cwd: '',
  model: 'opus',
  events: transcript('fixture-subagent-premature', [
    { ev: { k: 'user', text: 'Find out why the upload test is flaky.' } },
    { ev: { k: 'tool', toolId: 'tool-task-2', name: 'Task', input: { subagent_type: 'general-purpose' }, summary: 'trace flake' } },
    {
      ev: {
        k: 'subagent_start',
        toolId: 'tool-task-2',
        agentId: 'agent-2',
        agentType: 'general-purpose',
        description: 'Trace the flaky upload test',
        prompt: 'Run the upload test twenty times and report the failures.',
        depth: 1,
      },
    },
    // The empty row the harness writes before the sidechain has done anything.
    {
      ev: {
        k: 'subagent_end',
        toolId: 'tool-task-2',
        agentId: 'agent-2',
        status: 'done',
        durationMs: 0,
        toolUses: 0,
        result: '',
      },
    },
    { agentId: 'agent-2', ev: { k: 'tool', toolId: 'tool-bash-2', name: 'Bash', input: { command: 'bun test upload' }, summary: 'bun test upload' } },
    { agentId: 'agent-2', ev: { k: 'tool_result', toolId: 'tool-bash-2', text: '3 of 20 runs failed', isError: false, truncated: false } },
  ]),
  expect: { turns: 1, groups: 1, provisionalGroups: 1, runningGroupsWhenLive: 1 },
}

/**
 * Two prompts in one session, the second sent while the first turn never got a
 * `result`. An unterminated turn must not leave a second spinner behind.
 */
const twoTurns: TranscriptFixture = {
  id: 'fixture-two-turns',
  title: 'Rename the config loader',
  note: 'a turn without a result is closed by the next prompt, not left running',
  harness: 'commandcode',
  kind: 'agent',
  cwd: '',
  model: 'gpt-5',
  events: transcript('fixture-two-turns', [
    { ev: { k: 'user', text: 'Rename loadConf to loadConfig.' } },
    { ev: { k: 'tool', toolId: 'tool-edit-2', name: 'Edit', input: { path: 'src/config.ts' }, summary: 'src/config.ts' } },
    { ev: { k: 'file_change', toolId: 'tool-edit-2', path: 'src/config.ts', change: 'edit', added: 4, removed: 4, preview: PATCH } },
    // No `result`: the harness died mid-turn.
    { ev: { k: 'error', text: 'the CLI exited before the turn finished' } },
    { ev: { k: 'user', text: 'Try again, and update the tests too.' } },
    { ev: { k: 'tool', toolId: 'tool-write-1', name: 'Write', input: { path: 'src/config.test.ts' }, summary: 'src/config.test.ts' } },
    { ev: { k: 'file_change', toolId: 'tool-write-1', path: 'src/config.test.ts', change: 'create', added: 18, removed: 0, preview: PATCH } },
    { ev: { k: 'assistant', text: 'Renamed and covered by a test.', model: 'gpt-5', usage: usage(320) } },
    { ev: { k: 'result', subtype: 'success', text: '', usage: usage(320), durationMs: 12_400, costUsd: 0.0208 } },
  ]),
  expect: { turns: 2, groups: 0, provisionalGroups: 0, runningGroupsWhenLive: 0 },
}

/** A transcript written by an older build: a completion with no spawn card. */
const orphanCompletion: TranscriptFixture = {
  id: 'fixture-orphan-completion',
  title: 'Legacy transcript',
  note: 'a completion row with no spawn card still renders as a card',
  harness: 'claude',
  kind: 'agent',
  cwd: '',
  model: 'sonnet',
  events: transcript('fixture-orphan-completion', [
    { ev: { k: 'user', text: 'Summarise the release notes.' } },
    {
      ev: {
        k: 'subagent_end',
        toolId: 'tool-task-legacy',
        agentId: 'agent-legacy',
        status: 'done',
        durationMs: 9000,
        usage: usage(120),
        toolUses: 1,
        result: 'Summarised.',
      },
    },
    { ev: { k: 'result', subtype: 'success', text: '', usage: usage(120), durationMs: 9500, costUsd: 0.004 } },
  ]),
  expect: { turns: 1, groups: 1, provisionalGroups: 0, runningGroupsWhenLive: 0 },
}

/** A terminal tab: no transcript at all, but the rail must still list it. */
const terminalTab: TranscriptFixture = {
  id: 'fixture-terminal',
  title: 'Terminal · fixtures',
  note: 'a terminal session has no agent surfaces and must not be mistaken for one',
  harness: 'shell',
  kind: 'terminal',
  cwd: '',
  model: null,
  events: [],
  expect: { turns: 0, groups: 0, provisionalGroups: 0, runningGroupsWhenLive: 0 },
}

/**
 * One turn that touches everything the transcript can draw: a system line, a
 * tool and its result, a patch with an added and a removed line, a delegated
 * subagent and a turn footer.
 *
 * It exists so the browser checks have a single session to open where every
 * surface they assert on is actually on screen; the focused fixtures above stay
 * focused.
 */
const kitchenSink: TranscriptFixture = {
  id: 'fixture-kitchen-sink',
  title: 'Ship the greet guard',
  note: 'every transcript surface in one turn, for the browser checks to read',
  harness: 'claude',
  kind: 'agent',
  cwd: '',
  model: 'opus',
  events: transcript('fixture-kitchen-sink', [
    { ev: { k: 'system', subtype: 'init', text: 'session started in the fixture workspace' } },
    { ev: { k: 'user', text: 'Guard greet() and have an agent double-check the callers.' } },
    { ev: { k: 'thinking', text: 'Guard first, then delegate the caller sweep.' } },
    { ev: { k: 'tool', toolId: 'ks-read', name: 'Read', input: { path: 'src/greet.ts' }, summary: 'src/greet.ts' } },
    { ev: { k: 'tool_result', toolId: 'ks-read', text: "export function greet(name: string) {\n  return 'hi'\n}", isError: false, truncated: false } },
    { ev: { k: 'tool', toolId: 'ks-edit', name: 'Edit', input: { path: 'src/greet.ts' }, summary: 'src/greet.ts' } },
    { ev: { k: 'file_change', toolId: 'ks-edit', path: 'src/greet.ts', change: 'edit', added: 2, removed: 1, preview: PATCH } },
    { ev: { k: 'tool_result', toolId: 'ks-edit', text: 'ok', isError: false, truncated: false } },
    { ev: { k: 'tool', toolId: 'ks-task', name: 'Task', input: { subagent_type: 'general-purpose' }, summary: 'check callers' } },
    {
      ev: {
        k: 'subagent_start',
        toolId: 'ks-task',
        agentId: 'agent-ks',
        agentType: 'general-purpose',
        description: 'Check every caller of greet()',
        prompt: 'Find every call site of greet() and report the ones passing an empty string.',
        depth: 1,
        model: 'sonnet',
      },
    },
    { agentId: 'agent-ks', ev: { k: 'tool', toolId: 'ks-grep', name: 'Grep', input: { pattern: 'greet\\(' }, summary: 'greet(' } },
    { agentId: 'agent-ks', ev: { k: 'tool_result', toolId: 'ks-grep', text: 'src/cli.ts:18', isError: false, truncated: false } },
    {
      ev: {
        k: 'subagent_end',
        toolId: 'ks-task',
        agentId: 'agent-ks',
        status: 'done',
        durationMs: 11_000,
        usage: usage(410),
        toolUses: 1,
        result: 'One caller passes an empty string.',
      },
    },
    { ev: { k: 'assistant', text: 'Guarded, and one caller needs updating.', model: 'opus', usage: usage(260) } },
    { ev: { k: 'result', subtype: 'success', text: '', usage: usage(260), durationMs: 26_000, costUsd: 0.052 } },
  ]),
  // Two turns: the `system` preamble precedes the first prompt, and everything
  // before a prompt is a turn of its own.
  expect: { turns: 2, groups: 1, provisionalGroups: 0, runningGroupsWhenLive: 0 },
}

export const TRANSCRIPT_FIXTURES: TranscriptFixture[] = [
  kitchenSink,
  plainTurn,
  finishedSubagent,
  prematureCompletion,
  twoTurns,
  orphanCompletion,
  terminalTab,
]

/**
 * The fixture the browser checks open: its transcript is the one that exercises
 * the most surfaces at once — a system line, a tool, a tool result, a patch with
 * both an added and a removed line, and a turn footer.
 */
export const RICHEST_FIXTURE = kitchenSink

/** The agent fixtures only: the ones with a transcript worth rendering. */
export const AGENT_FIXTURES = TRANSCRIPT_FIXTURES.filter((fixture) => fixture.kind === 'agent')
