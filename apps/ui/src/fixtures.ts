/**
 * Fixtures for the component gallery (`preview.html`).
 *
 * Shapes are copied from real transcripts so the gallery exercises exactly the
 * cases the app renders in production: nested subagents, file patches with a
 * diff preview, thinking blocks, a finished turn and one still running.
 */
import type {
  AttachmentRef,
  LimitSnapshot,
  SessionEvent,
  SessionMetrics,
  SessionSummary,
  TokenUsage,
} from '@shared'
import type { LiveBuffer, State, UiSettings } from './store.ts'

const T0 = Date.UTC(2026, 8, 18, 22, 4, 0)

/**
 * The two turns of the fixture thread, as the server records them.
 *
 * The ids are real data here rather than decoration: the transcript only draws a
 * live buffer under the turn it belongs to (`buffer.turnId === turn.turnId`), so
 * without them the gallery could not tell a buffer that belongs to the turn on
 * screen from one left behind by a dropped socket.
 */
export const FIXTURE_TURN_ONE = 'turn-9f3a24'
export const FIXTURE_TURN_TWO = 'turn-b71ce8'

function usage(out: number): TokenUsage {
  return { input: 18_400 + out, output: out, cacheRead: 62_000, cacheWrite: 1_200, reasoning: out }
}

function ev(
  seq: number,
  at: number,
  payload: SessionEvent['ev'],
  extra: { id?: string; agentId?: string; turnId?: string } = {},
): SessionEvent {
  return {
    id: extra.id ?? `fx:${seq}`,
    sessionId: 'fixture',
    seq,
    at,
    agentId: extra.agentId,
    turnId: extra.turnId ?? FIXTURE_TURN_ONE,
    ev: payload,
  }
}

const PATCH = `@@ -0,0 +1,18 @@
+import { LRUCache } from '../lib/lru.ts'
+
+const WINDOW_MS = 60_000
+const MAX_HITS = 120
+
+const buckets = new LRUCache<number>(5_000)
+
+/** Fixed-window limiter: cheap, predictable, no timers. */
+export function rateLimit(key: string): { ok: boolean; retryAfter: number } {
+  const now = Date.now()
+  const bucket = buckets.get(key)
+  if (!bucket || now - bucket.start > WINDOW_MS) {
+    buckets.set(key, { start: now, count: 1 })
+    return { ok: true, retryAfter: 0 }
+  }
+  bucket.count += 1
+  if (bucket.count > MAX_HITS) {
+    return { ok: false, retryAfter: WINDOW_MS - (now - bucket.start) }
+  }
+  return { ok: true, retryAfter: 0 }
+}`

const TEST_PATCH = `@@ -12,7 +12,13 @@ describe('rate limit', () => {
   it('allows the first request', () => {
     expect(rateLimit('a').ok).toBe(true)
   })
-
-  it('is a placeholder', () => {
-    expect(true).toBe(true)
+
+  it('blocks after the window budget', () => {
+    for (let i = 0; i < 120; i++) expect(rateLimit('b').ok).toBe(true)
+    expect(rateLimit('b').ok).toBe(false)
+    expect(rateLimit('b').retryAfter).toBeGreaterThan(0)
+  })
+
+  it('resets after the window', () => {
+    expect(rateLimit('c').ok).toBe(true)
   })
 })`

export const fixtureSession: SessionSummary = {
  id: 'fixture-session',
  harness: 'claude',
  kind: 'agent',
  title: 'Add a rate limiter to /api/orders',
  preset: null,
  cwd: '/Users/you/Projects/acme-api',
  host: null,
  model: 'claude-opus-4-6',
  status: 'running',
  createdAt: T0,
  updatedAt: T0 + 42_000,
  nativeId: 'a3f1c9e2-77bd-4a70-9d4f-1c2b3e4d5f60',
  transcriptPath: '/Users/you/.claude/projects/-Users-you-Projects-acme-api/a3f1c9e2.jsonl',
  resumeHint: 'claude --resume a3f1c9e2-77bd-4a70-9d4f-1c2b3e4d5f60',
  permissionMode: 'acceptEdits',
  effort: 'high',
  gitBranch: 'feat/rate-limit',
  pinned: false,
  started: true,
  metrics: {
    tps: 41.8,
    tpsAvg: 36.2,
    lastTtftMs: 820,
    outputTokens: 1_240,
    inputTokens: 18_400,
    cacheReadTokens: 12_800,
    cacheWriteTokens: 900,
    contextTokens: 96_400,
    contextWindow: 200_000,
    costUsd: 0.0812,
    // This fixture stands for a harness that reports both, so the gallery shows
    // the figures rather than the "not reported" readings.
    costReported: true,
    contextReported: true,
    turnActive: true,
  },
}

/**
 * Two pasted screenshots. Their "id" is an inline data URL on purpose: the
 * gallery has no server to fetch `/api/attachment/<id>` from, and a broken image
 * there would be a console error the UI check counts.
 */
const PASTED_IMAGES: AttachmentRef[] = [
  {
    id: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAAhElEQVR4nO3WMQoAIRBDUc+3Z7Dba3jAPZPVIgiDMpJKkiIwZYpXDb/U1tN73i+92/sipamtJyCiJgFxNTuIrllACpoAiWgmSEczQFKaI4ilGY9RSpOAuJodRNcsIAVNgEQ0E6SjOeaHeyj27iG0dw+hvXsI7d1DaO8eQnv3ENq7h9D+B0bE1YjGzOeHAAAAAElFTkSuQmCC',
    name: 'failing-test.png',
    mediaType: 'image/png',
  },
  {
    id: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADAAAAAgCAIAAADbtmxLAAAAhUlEQVR4nO3WwQkAIRBDUcvbGqxiC7GoLckSFkEYlJGcJDkE5pjDOw2/9FbT+94nvdv7IqXprSYgoiYBcTU7iK5ZQAqaAIloJkhHM0BSmiOIpRmPUUqTgLiaHUTXLCAFTYBENBOkoznmh3so9u4htHcPob17CO3dQ2jvHkJ79xDau4fQ/gcgT+qIsSLvPgAAAABJRU5ErkJggg==',
    name: 'router-order.png',
    mediaType: 'image/png',
  },
]

/**
 * A GFM table as the harnesses really emit them.
 *
 * Copied from the reply that exposed the defect (the transcript printed the
 * pipes verbatim), then widened into the cases a hand-rolled parser gets wrong:
 * per-column alignment from the delimiter row, a pipe escaped inside a cell, and
 * inline markdown — a code span, bold, a link — that has to keep working in a
 * cell.
 */
export const fixtureTableMarkdown = [
  '| Route | Budget | p95 | Blocked |',
  '|:------|:------:|----:|---------|',
  '| /api/orders | 120/min | 41 ms | 0 |',
  '| [/api/orders/:id](https://example.com/docs) | 120/min | **58 ms** | 3 |',
  '| `GET /health \\| jq .ok` | none | 2 ms | 0 |',
].join('\n')

/** Ten columns: wider than any transcript, so the scroll container is exercised. */
export const fixtureWideTableMarkdown = [
  `| ${Array.from({ length: 10 }, (_, i) => `Column ${i + 1}`).join(' | ')} |`,
  `| ${Array.from({ length: 10 }, () => '---').join(' | ')} |`,
  `| ${Array.from({ length: 10 }, (_, i) => `a rather long cell ${i + 1}`).join(' | ')} |`,
].join('\n')

/**
 * The reply the first turn ended on, kept apart because the stale-buffer fixture
 * streams exactly this text again (see `fixtureStaleLive`).
 */
const FIRST_REPLY = [
  'The limiter is in and covered:',
  '',
  '```ts',
  'app.use(rateLimit({ windowMs: 60_000, max: 120 }))',
  '```',
  '',
  'All 5 tests pass.',
  '',
  fixtureTableMarkdown,
].join('\n')

export const fixtureEvents: SessionEvent[] = [
  ev(1, T0, {
    k: 'user',
    text: 'Add a fixed-window rate limiter to the /api/orders endpoint (120 req/min per key), wire it into the router, and cover it with tests.',
  }),
  // The harness opens every session by reporting its own configuration, and
  // closes every turn with one line per hook it ran. Both are real shapes the
  // transcript has to place: the first is the caption over the work, the second
  // is bookkeeping folded under it.
  ev(100, T0 + 100, {
    k: 'system',
    subtype: 'init',
    text: 'claude-opus-4-6 · /Users/you/Projects/acme-api · acceptEdits',
  }),
  ev(2, T0 + 900, {
    k: 'thinking',
    text: 'The endpoint goes through src/middleware, so the limiter belongs there. A fixed window with an LRU is enough — no timers, nothing to leak. I need the existing middleware signature first, then I can delegate the test run while I write the patch.',
  }),
  ev(3, T0 + 2_600, {
    k: 'assistant',
    text: "I'll read the current middleware first, then write the limiter and hand the test suite to a subagent.",
  }),
  ev(4, T0 + 3_100, {
    k: 'tool',
    toolId: 'tu_read',
    name: 'Read',
    input: { file_path: '/Users/you/Projects/acme-api/src/middleware/index.ts' },
    summary: 'src/middleware/index.ts',
  }),
  ev(5, T0 + 3_400, {
    k: 'tool_result',
    toolId: 'tu_read',
    text: 'export type Handler = (req: Request) => Promise<Response>\nexport function chain(...handlers: Handler[]): Handler {\n  return async (req) => {\n    for (const h of handlers) await h(req)\n    return new Response(null, { status: 204 })\n  }\n}',
    isError: false,
    truncated: false,
  }),
  ev(6, T0 + 6_200, {
    k: 'file_change',
    toolId: 'tu_write',
    path: '/Users/you/Projects/acme-api/src/middleware/rate-limit.ts',
    change: 'create',
    added: 18,
    removed: 0,
    preview: PATCH,
  }),
  ev(7, T0 + 6_500, {
    k: 'tool',
    toolId: 'tu_task',
    name: 'Task',
    input: { subagent_type: 'general-purpose', description: 'Run the test suite' },
    summary: 'general-purpose · run the full test suite',
  }),
  ev(
    8,
    T0 + 6_600,
    {
      k: 'subagent_start',
      toolId: 'tu_task',
      agentId: 'agent-a1',
      agentType: 'general-purpose',
      description: 'Run the test suite',
      prompt: 'Run `bun test` from the repo root and report every failure with its assertion output.',
      depth: 1,
      model: 'claude-haiku-4-5',
    },
  ),
  ev(
    9,
    T0 + 7_100,
    {
      k: 'tool',
      toolId: 'sa_bash',
      name: 'Bash',
      input: { command: 'bun test', description: 'run the suite' },
      summary: 'bun test',
    },
    { agentId: 'agent-a1' },
  ),
  ev(
    10,
    T0 + 11_400,
    {
      k: 'tool_result',
      toolId: 'sa_bash',
      text: '5 pass, 0 fail, 412 expect() calls\nRan 5 tests across 1 file in 1.21s',
      isError: false,
      truncated: false,
    },
    { agentId: 'agent-a1' },
  ),
  ev(
    11,
    T0 + 11_800,
    {
      k: 'file_change',
      toolId: 'sa_edit',
      path: '/Users/you/Projects/acme-api/tests/rate-limit.test.ts',
      change: 'edit',
      added: 6,
      removed: 1,
      preview: TEST_PATCH,
    },
    { agentId: 'agent-a1' },
  ),
  ev(
    12,
    T0 + 12_200,
    {
      k: 'subagent_end',
      toolId: 'tu_task',
      agentId: 'agent-a1',
      status: 'done',
      durationMs: 5_400,
      usage: usage(310),
      toolUses: 2,
      tools: { read: 0, search: 0, bash: 1, edit: 1, other: 0, linesAdded: 6, linesRemoved: 1 },
      result: 'All 5 tests pass. Added the window-budget case to tests/rate-limit.test.ts.',
    },
  ),
  ev(13, T0 + 13_000, {
    k: 'assistant',
    text: FIRST_REPLY,
    model: 'claude-opus-4-6',
    usage: usage(420),
  }),
  ev(101, T0 + 18_200, { k: 'system', subtype: 'stop_hook_summary', text: '2 hooks ran in 22ms' }),
  ev(14, T0 + 18_400, {
    k: 'result',
    subtype: 'success',
    text: '',
    usage: usage(1_240),
    durationMs: 18_400,
    costUsd: 0.0812,
    costReported: true,
  }),
  ev(15, T0 + 24_000, {
    k: 'user',
    // The log rides along as a document, the way a harness writes one back into
    // its own transcript: the bubble shows a tile, not forty lines of log.
    text: `Now run the entire suite, including the integration tests. The failures look like these: [image:1] [image:2]\n\n<attached_file name="failing-run.log">\n${Array.from({ length: 40 }, (_, i) => `[${String(i).padStart(2, '0')}] orders › expiry > check ${i + 1}`).join('\n')}\n</attached_file>`,
    attachments: PASTED_IMAGES,
  }, { turnId: FIXTURE_TURN_TWO }),
  ev(16, T0 + 25_100, {
    k: 'tool',
    toolId: 'tu_bash2',
    name: 'Bash',
    input: { command: 'bun test --integration' },
    summary: 'bun test --integration',
  }, { turnId: FIXTURE_TURN_TWO }),
  ev(17, T0 + 31_800, {
    k: 'tool_result',
    toolId: 'tu_bash2',
    text: '38 pass, 1 fail\n\n✗ orders › expiry > rejects an expired token\n  Expected: 401, Received: 500',
    isError: true,
    truncated: false,
  }, { turnId: FIXTURE_TURN_TWO }),
  ev(18, T0 + 32_400, {
    k: 'thinking',
    text: 'One integration failure, and it is not the limiter: the expiry path throws before the auth guard. Looking at the order of middleware in the test harness.',
  }, { turnId: FIXTURE_TURN_TWO }),
  {
    id: 'ev-question',
    sessionId: 'fixture',
    seq: 900,
    at: Date.now() - 40_000,
    turnId: FIXTURE_TURN_TWO,
    ev: {
      k: 'tool',
      toolId: 'tu_question',
      name: 'AskUserQuestion',
      summary: 'Come gestiamo i rimborsi? (+2)',
      input: {
        questions: [
          {
            header: 'Rimborsi',
            question: "Qual e' il perimetro di questo giro?",
            multiSelect: false,
            options: [
              {
                label: 'Pulsanti + split della metrica (Consigliato)',
                description: 'Zero migrazione, zero backend nuovo.',
              },
              { label: 'Solo i pulsanti adesso', description: 'La metrica la rifiniamo con dati reali in mano.' },
            ],
          },
        ],
      },
    },
  },
]

/**
 * The reply being streamed right now: it belongs to the turn on screen, so the
 * transcript draws it under that turn while the harness is still writing it.
 */
export const fixtureLive: Record<string, LiveBuffer> = {
  'fixture-session:main': {
    thinking: '',
    text: 'The failure is upstream of the limiter — the expired-token case reaches the handler before the auth guard runs. Checking the route order now…',
    turnId: FIXTURE_TURN_TWO,
  },
}

/**
 * What a socket that dropped mid-stream leaves behind.
 *
 * The buffer still holds the reply of the *first* turn — text the replayed
 * timeline already contains — while the second turn is the one being rendered.
 * Drawing it anyway is how one answer came to be shown twice and never went
 * away, so the transcript must recognise it as belonging to another turn and
 * ignore it. The gallery reaches this state with `preview.html?live=stale`.
 */
export const fixtureStaleLive: Record<string, LiveBuffer> = {
  'fixture-session:main': { thinking: '', text: FIRST_REPLY, turnId: FIXTURE_TURN_ONE },
}

/**
 * Sessions that differ only in what their harness reported.
 *
 * Metrics are never persisted, so no stored session carries any: these exist so
 * the gallery can render the real readouts against each of the three honest
 * states and prove which `SessionMetrics` produces which reading — the rings
 * looking different from each other is not the same claim.
 */
function metrics(patch: Partial<SessionMetrics>): SessionMetrics {
  return {
    tps: 0,
    tpsAvg: 0,
    lastTtftMs: null,
    outputTokens: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    contextTokens: 0,
    contextWindow: 0,
    costUsd: 0,
    turnActive: false,
    ...patch,
  }
}

function readoutSession(id: string, patch: Partial<SessionSummary>): SessionSummary {
  return {
    ...fixtureSession,
    id,
    title: 'Readout',
    status: 'idle',
    started: true,
    ...patch,
  }
}

/** Claude publishes its window, so the occupancy is a measurement. */
export const fixtureContextReported = readoutSession('readout-ctx-reported', {
  title: 'Trim the onboarding emails',
  harness: 'claude',
  model: 'claude-opus-4-6',
  metrics: metrics({
    contextTokens: 96_400,
    contextWindow: 200_000,
    contextReported: true,
    contextWindowInferred: false,
    costReported: true,
    costUsd: 0.0812,
  }),
})

/** Codex reports the tokens but not the window: the size is read off the model. */
export const fixtureContextInferred = readoutSession('readout-ctx-inferred', {
  title: 'Migrate the legacy CSV importer',
  harness: 'codex',
  model: 'gpt-5.6-codex',
  metrics: metrics({
    contextTokens: 96_400,
    contextWindow: 272_000,
    contextReported: true,
    contextWindowInferred: true,
    costReported: false,
  }),
})

/** A harness that has said nothing at all about the context yet. */
export const fixtureContextUnknown = readoutSession('readout-ctx-unknown', {
  title: 'Document the deploy runbook',
  harness: 'gemini',
  model: 'gemini-3-pro',
  metrics: metrics({ contextReported: false, costReported: false }),
})

/**
 * Command Code bills a subscription and publishes no price, so the status bar
 * has to say so rather than print the `$0.0000` it used to.
 */
export const fixtureCostUnreported = readoutSession('readout-cost-unreported', {
  title: 'Rename the billing webhook handler',
  harness: 'commandcode',
  model: 'cmd-large',
  metrics: metrics({ costReported: false, contextReported: false }),
})

/**
 * The other half of the same rule: a harness that really did quote zero — a turn
 * stopped before it billed anything — reported a price, and a reported price is
 * a figure. Only silence gets the em dash.
 */
export const fixtureCostZero = readoutSession('readout-cost-zero', {
  title: 'Stopped before it billed anything',
  harness: 'claude',
  model: 'claude-haiku-4-5',
  metrics: metrics({ costUsd: 0, costReported: true, contextReported: false }),
})

/**
 * Every harness the operator has installed, reporting at once.
 *
 * This is the widest the status bar ever gets — five harnesses, one of them out
 * of credits, another with two windows — and it is exactly the state the bar was
 * reported clipped in. The gallery needs it as a fixture because a real reading
 * depends on which CLIs happen to be installed on the machine running the check.
 */
const READ_AT = Date.now() - 90_000

export const fixtureLimits: LimitSnapshot[] = [
  {
    harness: 'claude',
    plan: 'Max 20x',
    windows: [
      { label: '5h', usedPercent: 12, windowMinutes: 300, resetsAt: READ_AT + 2 * 3600_000 },
      { label: '7d', usedPercent: 68, windowMinutes: 10_080, resetsAt: READ_AT + 4 * 86_400_000 },
    ],
    credits: null,
    updatedAt: READ_AT,
    error: null,
  },
  {
    harness: 'codex',
    plan: 'Plus',
    windows: [],
    credits: { hasCredits: false, unlimited: false, balance: null },
    updatedAt: READ_AT,
    error: 'credits exhausted',
  },
  {
    harness: 'commandcode',
    plan: 'Pro',
    windows: [{ label: '5h', usedPercent: 34, windowMinutes: 300, resetsAt: READ_AT + 3600_000 }],
    credits: null,
    updatedAt: READ_AT,
    error: null,
  },
  {
    harness: 'gemini',
    plan: null,
    windows: [],
    credits: null,
    updatedAt: READ_AT,
    error: null,
    note: 'Billed against your own API key — there is no quota to read.',
  },
  {
    harness: 'grok',
    plan: null,
    windows: [],
    credits: null,
    updatedAt: READ_AT,
    error: 'no oauth token',
  },
]

/* ------------------------------------------------------------------ */
/* Turn states                                                         */
/* ------------------------------------------------------------------ */

/**
 * The states a turn can be read in, staged side by side.
 *
 * These exist because the defect they cover is a *comparison*: "still working"
 * and "this is the answer" looked alike, and no single screenshot can show that.
 * The gallery renders them together at `preview.html?only=turns`, so the check
 * can assert the two are distinguishable in the DOM and a person can see that
 * they are distinguishable on screen.
 */
const TS = 'turn-state'
/**
 * The turn-state fixtures start a few seconds ago rather than at `T0`.
 *
 * A running turn counts the seconds since its prompt, and a prompt dated three
 * days back would put "68:03:11" in the header — true, but not the picture this
 * page is for. The thread fixtures keep `T0` because their clocks are printed,
 * not counted.
 */
const TS0 = Date.now() - 14_000

function stateSession(id: string, status: SessionSummary['status']): SessionSummary {
  return { ...fixtureSession, id, status, title: id }
}

function stateEvent(
  seq: number,
  at: number,
  payload: SessionEvent['ev'],
  extra: { id?: string; agentId?: string; parentAgentId?: string; parentEventId?: string; turnId?: string } = {},
): SessionEvent {
  return {
    id: extra.id ?? `${TS}:${seq}`,
    sessionId: 'turn-state',
    seq,
    at,
    agentId: extra.agentId,
    parentAgentId: extra.parentAgentId,
    parentEventId: extra.parentEventId,
    turnId: extra.turnId ?? TS,
    ev: payload,
  }
}

const ASK = 'Ping google.com and github.com from two agents and give me a table.'

/**
 * The skill call exactly as the harness emits it.
 *
 * `input.skill` is the whole identity of the call and the server writes no
 * summary for it, which is why the card rendered as the bare word "Skill" and a
 * clock. The fixture carries the real shape — `{ skill, args }` — so the check
 * is against what the harness sends, not against a convenient invention.
 */
const SKILL_CALL: SessionEvent['ev'] = {
  k: 'tool',
  toolId: 'tu_skill',
  name: 'Skill',
  input: { skill: 'superpowers:dispatching-parallel-agents', args: 'two pings, one table' },
  summary: '',
}

/** The bookkeeping that used to stack five deep between the work and the reply. */
const NOTICES: SessionEvent['ev'][] = [
  { k: 'system', subtype: 'stop_hook_summary', text: '2 hooks ran in 22ms' },
  {
    k: 'result',
    subtype: 'success',
    text: '',
    usage: usage(670),
    durationMs: 8_600,
    costUsd: 0,
    costReported: false,
  },
  { k: 'system', subtype: 'stop_hook_summary', text: '2 hooks ran in 21ms' },
]

const CONFIG: SessionEvent['ev'] = {
  k: 'system',
  subtype: 'init',
  text: 'claude-haiku-4-5-20251001 · /Users/you/Projects/acme-api · bypassPermissions',
}

/**
 * A block of thinking the harness has already committed.
 *
 * It opens on "The user wants…" for a reason: this is the text the transcript
 * clipped, and the report was a screenshot reading "e user wants me to start two
 * subagents". The first characters of the block are the assertion, so the
 * fixture keeps a first word worth losing.
 */
const COMMITTED_THINKING =
  'The user wants me to start two subagents and put their answers in one table. Two pings are independent, so they can go out together rather than one after the other; the table only makes sense once both have reported, so I will dispatch both and wait.\n\n**Checking project docs**'

/** A turn mid-flight: the work is open, prose is streaming, nothing has settled. */
export const fixtureWorkingEvents: SessionEvent[] = [
  stateEvent(1, TS0, { k: 'user', text: ASK }),
  stateEvent(2, TS0 + 200, CONFIG),
  stateEvent(30, TS0 + 500, { k: 'thinking', text: COMMITTED_THINKING }),
  stateEvent(3, TS0 + 900, SKILL_CALL),
  stateEvent(4, TS0 + 1_400, {
    k: 'subagent_start',
    toolId: 'tu_ping',
    agentId: 'agent-ping',
    agentType: 'general-purpose',
    description: 'Ping google.com',
    prompt: 'Run `ping -c 3 google.com` and report the IP, the mean round trip and the packet loss.',
    depth: 1,
  }),
  stateEvent(
    5,
    TS0 + 2_000,
    { k: 'tool', toolId: 'sa_ping', name: 'Bash', input: { command: 'ping -c 3 google.com' }, summary: 'ping -c 3 google.com' },
    { agentId: 'agent-ping' },
  ),
]

export const fixtureWorkingLive: Record<string, LiveBuffer> = {
  'turn-working:main': {
    thinking: 'Two pings, two agents. The table comes after both report.',
    text: 'Dispatching both agents now — google.com first',
    turnId: TS,
  },
}

/** One active turn with a second prompt durably waiting behind it. */
export const fixtureQueuedPromptEvents: SessionEvent[] = [
  stateEvent(
    1,
    TS0,
    { k: 'user', text: 'Finish the API migration.', promptId: 'prompt-active', delivery: 'delivered' },
    { id: 'prompt:active', turnId: 'turn-active' },
  ),
  stateEvent(2, TS0 + 1_000, { k: 'thinking', text: 'Checking the remaining endpoints.' }, { turnId: 'turn-active' }),
  stateEvent(
    3,
    TS0 + 2_000,
    { k: 'user', text: 'Then update the migration guide.', promptId: 'prompt-queued', delivery: 'queued' },
    { id: 'prompt:queued', turnId: 'turn-queued' },
  ),
]

/** A protocol-native decision: visible once, answerable in place. */
export const fixtureNativeRequestEvents: SessionEvent[] = [
  stateEvent(1, TS0, { k: 'user', text: 'Clean up the generated build artifacts.' }),
  stateEvent(2, TS0 + 700, {
    k: 'request',
    requestId: 'permission-clean-build',
    kind: 'permission',
    title: 'Remove generated build artifacts?',
    detail: 'The harness wants to delete dist/ and rebuild it from source.',
    options: [
      { id: 'allow-once', label: 'Allow once', hint: 'Only for this operation', intent: 'allow' },
      { id: 'deny', label: 'Deny', hint: 'Keep the existing files', intent: 'deny' },
    ],
    state: 'pending',
  }),
]

/** The same turn, over: the work has settled and the answer is the answer. */
export const fixtureFinishedEvents: SessionEvent[] = [
  ...fixtureWorkingEvents,
  stateEvent(
    6,
    TS0 + 6_100,
    { k: 'tool_result', toolId: 'sa_ping', text: '3 packets transmitted, 3 received, 0.0% packet loss', isError: false, truncated: false },
    { agentId: 'agent-ping' },
  ),
  stateEvent(7, TS0 + 6_400, {
    k: 'subagent_end',
    toolId: 'tu_ping',
    agentId: 'agent-ping',
    status: 'done',
    durationMs: 5_000,
    usage: usage(140),
    toolUses: 1,
    tools: { read: 0, search: 0, bash: 1, edit: 0, other: 0, linesAdded: 0, linesRemoved: 0 },
    result: 'google.com — 142.251.27.139, 90.7 ms mean, 0% loss.',
  }),
  ...NOTICES.map((payload, index) => stateEvent(8 + index, TS0 + 7_000 + index * 100, payload)),
  stateEvent(11, TS0 + 8_000, { k: 'assistant', text: 'Both pings are clean.', model: 'claude-opus-4-6' }),
  stateEvent(12, TS0 + 8_400, {
    k: 'result',
    subtype: 'success',
    text: '',
    usage: usage(820),
    durationMs: 8_400,
    costUsd: 0,
    costReported: false,
  }),
]

/**
 * One turn, three assistant messages — the shape that read as three unrelated
 * events, each behind its own hairline.
 */
export const fixtureMultiReplyEvents: SessionEvent[] = [
  ...fixtureFinishedEvents.filter((event) => event.ev.k !== 'assistant' && event.ev.k !== 'result'),
  stateEvent(20, TS0 + 8_000, { k: 'assistant', text: '2 agents dispatched: google.com and github.com.' }),
  stateEvent(21, TS0 + 8_200, { k: 'assistant', text: 'One is back: github.com, 107 ms, no loss. Waiting on google.com.' }),
  stateEvent(22, TS0 + 8_600, { k: 'assistant', text: `Both done.\n\n${fixtureTableMarkdown}` }),
  stateEvent(23, TS0 + 9_000, {
    k: 'result',
    subtype: 'success',
    text: '',
    usage: usage(820),
    durationMs: 9_000,
    costUsd: 0,
    costReported: false,
  }),
]

/**
 * Two subagents in the seconds after they were launched.
 *
 * Copied from `scripts/fixtures/traces/claude/subagent.jsonl`, which shows what
 * actually arrives and in what order. The spawn call — `{"type":"tool_use",
 * "name":"Agent","input":{"description":…,"prompt":…,"subagent_type":…}}` — is
 * always first, and it already names the agent and says what it was sent to do.
 * The harness' own `system/task_started` frame repeats all of that plus the
 * agent id, and the `agent-<id>.meta.json` sidecar repeats the type and the
 * description but never the prompt.
 *
 * The two cards here are the two ways a card can be caught starting:
 *
 *   github — only the spawn call has landed: nothing else knows this agent yet.
 *   google — a launch frame landed *first* carrying the placeholder type and no
 *            description at all, which is the "agent · agent" row in the report.
 *
 * Both must read as what they are, because the spawn call said so.
 */
export const fixtureSubagentStartingEvents: SessionEvent[] = [
  stateEvent(1, TS0, { k: 'user', text: ASK }),
  stateEvent(2, TS0 + 300, CONFIG),
  stateEvent(3, TS0 + 800, {
    k: 'tool',
    toolId: 'tu_start_gh',
    name: 'Agent',
    input: {
      description: 'Ping github.com and register the result',
      prompt: 'Run `ping -c 3 github.com` and report the IP, the mean round trip and the packet loss.',
      subagent_type: 'general-purpose',
    },
    summary: '',
  }),
  stateEvent(4, TS0 + 1_100, {
    k: 'tool',
    toolId: 'tu_start_gg',
    name: 'Agent',
    input: {
      description: 'Ping google.com and register the result',
      prompt: 'Run `ping -c 3 google.com` and report the IP, the mean round trip and the packet loss.',
      subagent_type: 'general-purpose',
    },
    summary: '',
  }),
  // The launch frame as a source that knows least: no type, no description.
  stateEvent(5, TS0 + 1_300, {
    k: 'subagent_start',
    toolId: 'tu_start_gg',
    agentId: 'agent-gg',
    agentType: 'agent',
    description: '',
    prompt: '',
    depth: 1,
  }),
]

/** A provider child launched by another provider child: causal nesting, not depth guesswork. */
export const fixtureNestedSubagentEvents: SessionEvent[] = [
  stateEvent(1, TS0, { k: 'user', text: 'Inspect auth, delegating deeper only if needed.' }),
  stateEvent(2, TS0 + 500, {
    k: 'subagent_start', toolId: 'tu_parent', agentId: 'agent-parent', agentType: 'general-purpose',
    description: 'Audit authentication', prompt: 'Audit the authentication flow and delegate the token parser.', depth: 1,
  }),
  stateEvent(3, TS0 + 900, {
    k: 'tool', toolId: 'tu_child', name: 'Task',
    input: { description: 'Inspect token parser', prompt: 'Inspect token parsing edge cases.' }, summary: 'Inspect token parser',
  }, { agentId: 'agent-parent' }),
  stateEvent(4, TS0 + 1_200, {
    k: 'subagent_start', toolId: 'tu_child', agentId: 'agent-child', agentType: 'explorer',
    description: 'Inspect token parser', prompt: 'Inspect token parsing edge cases.', depth: 2,
  }, { parentAgentId: 'agent-parent', parentEventId: 'tool:tu_child' }),
  stateEvent(5, TS0 + 2_000, { k: 'assistant', text: 'Found an unchecked expired-token branch.' }, {
    agentId: 'agent-child', parentAgentId: 'agent-parent',
  }),
  stateEvent(6, TS0 + 2_200, {
    k: 'subagent_end', toolId: 'tu_child', agentId: 'agent-child', status: 'done',
    durationMs: 1_000, toolUses: 1, result: 'Found an unchecked expired-token branch.',
  }, { agentId: 'agent-child', parentAgentId: 'agent-parent' }),
]

/** A subagent that did not come back clean: never folded, never quiet. */
export const fixtureSubagentFailedEvents: SessionEvent[] = [
  stateEvent(1, TS0, { k: 'user', text: 'Run the integration suite in a subagent.' }),
  stateEvent(2, TS0 + 400, {
    k: 'subagent_start',
    toolId: 'tu_fail',
    agentId: 'agent-fail',
    agentType: 'general-purpose',
    description: 'Run the integration suite',
    prompt: 'Run `bun test --integration` and report every failure with its assertion output.',
    depth: 1,
  }),
  stateEvent(
    3,
    TS0 + 900,
    { k: 'tool', toolId: 'sa_fail', name: 'Bash', input: { command: 'bun test --integration' }, summary: 'bun test --integration' },
    { agentId: 'agent-fail' },
  ),
  stateEvent(
    4,
    TS0 + 4_000,
    { k: 'tool_result', toolId: 'sa_fail', text: 'error: Cannot find module "./config.test.ts"', isError: true, truncated: false },
    { agentId: 'agent-fail' },
  ),
  stateEvent(5, TS0 + 4_300, {
    k: 'subagent_end',
    toolId: 'tu_fail',
    agentId: 'agent-fail',
    status: 'error',
    durationMs: 3_900,
    usage: usage(60),
    toolUses: 1,
    tools: { read: 0, search: 0, bash: 1, edit: 0, other: 0, linesAdded: 0, linesRemoved: 0 },
    result: 'The suite never started: the integration config is missing from this checkout.',
  }),
  stateEvent(6, TS0 + 4_800, {
    k: 'result',
    subtype: 'error_during_execution',
    text: '',
    usage: usage(60),
    durationMs: 4_800,
    costUsd: 0,
    costReported: false,
  }),
]

/* ------------------------------------------------------------------ */
/* Failures                                                            */
/* ------------------------------------------------------------------ */

/**
 * One sample per failure shape, as the server actually writes it.
 *
 * These strings are not prose somebody composed for a gallery: every one of them
 * is the literal output of `formatFailure` in `apps/server/src/harnesses/types.ts`
 * for a captured raw report, and `scripts/error-test.ts` regenerates each one
 * from its raw input and fails if the two have drifted apart. So a wording change
 * on the server cannot leave the gallery showing something the app never says,
 * and a shape nobody renders cannot quietly stop being rendered.
 *
 * The raw reports themselves — the EPIPE dump, the wrapper's TypeError, the ssh
 * failures — live in that test next to the shapes they exercise.
 */
export const FIXTURE_FAILURES = {
  /** A Node stack trace from a vendor's ACP wrapper: the report that started this. */
  'err-broken-pipe':
    "Gemini CLI's own command-line wrapper (`/opt/homebrew/bin/gemini`) closed its side of the connection while sedano was still writing to it — a broken pipe. The process had already gone away, so nothing you typed caused this; the crash it printed on its way out is below. Send your message again to start it back up.\n\nError: write EPIPE\n    at afterWriteDispatched (node:internal/stream_base_commons:159:15)\n    at writeGeneric (node:internal/stream_base_commons:150:3)\n    at Socket._writeGeneric (node:net:966:11)\n    at Socket._write (node:net:978:8)\n    at writeOrBuffer (node:internal/streams/writable:572:12)\n    at _write (node:internal/streams/writable:501:10)\n    at Writable.write (node:internal/streams/writable:510:10)\n    at process.<anonymous> (file:///opt/homebrew/lib/node_modules/@google/gemini-cli/dist/index.js:41208:22)\n    at process.emit (node:events:518:28)\n    at emitUnhandledRejectionWarning (node:internal/process/promises:264:13)",
  /** An uncaught exception, with the deprecation chatter that preceded it kept. */
  'err-crash':
    "Claude Code's own command-line wrapper (`/opt/homebrew/bin/claude-agent-acp`) crashed with an internal error — TypeError: Cannot read properties of undefined (reading 'sessionId'). This is a fault inside that program, not in your prompt or this session; the full stack trace is kept below. Send your message again to start it back up.\n\n(node:48221) [DEP0040] DeprecationWarning: The `punycode` module is deprecated.\n(Use `node --trace-deprecation ...` to show where the warning was created)\nTypeError: Cannot read properties of undefined (reading 'sessionId')\n    at handleSessionUpdate (node:internal/modules/cjs/loader:1241:14)\n    at Object.onNotification (/opt/homebrew/lib/node_modules/@zed-industries/claude-code-acp/dist/index.js:912:7)\n    at Socket.<anonymous> (node:internal/streams/readable:1010:12)",
  /** The transport's own `unreachable`, kept as itself rather than as an agent failure. */
  'err-ssh':
    'Could not reach “lab” over SSH, so Codex never started there. Check the machine is up and that `ssh lab` works from a terminal.\n\nlab: ssh: connect to host lab port 22: Operation timed out',
  'err-not-installed':
    'Codex is not installed on this machine — sedano looked for `codex` on the PATH and found nothing. Install it there, then send your message again.\n\nspawn codex ENOENT',
  'err-signed-out':
    'Grok is installed on this machine but nobody is signed in to it — run `/opt/homebrew/bin/grok login` in a terminal, then send your message again.\n\nacp: session/new failed: Authentication required. Please run `grok login` first.',
  'err-quota':
    'Claude Code refused the request because its usage limit is spent. The session is fine — wait for the limit to come back, or switch to another harness for now.\n\nAPI error 429: rate limit exceeded for organisation org_4f21 (requests per minute)',
  /** Nothing recognised: the honest headline, and every character handed over. */
  'err-unknown':
    'Opencode reported a failure that sedano does not recognise, so it is passed on exactly as it arrived. The full report is below.\n\nglorp subsystem returned status BLEEM',
} as const

export type FailureCaseId = keyof typeof FIXTURE_FAILURES

/**
 * Stderr a harness prints on its way to working.
 *
 * Kept as a fixture because "this must not become a red card" is an assertion
 * about a shape, and the shape has to exist somewhere a check can point at. The
 * server never turns these into an `error`; the gallery therefore renders them
 * as what they are — system lines — and `check:ui` asserts that the failure case
 * beside them has an error card and this one does not.
 */
export const FIXTURE_CHATTER = [
  '(node:48221) ExperimentalWarning: WASI is an experimental feature and might change at any time',
  '(Use `node --trace-warnings ...` to show where the warning was created)',
  'npm warn exec The following package was not found and will be installed: @zed-industries/claude-code-acp',
]

const FAILURE_LABEL: Record<FailureCaseId, string> = {
  'err-broken-pipe': 'A broken pipe, with the wrapper’s Node stack trace behind it',
  'err-crash': 'An uncaught exception inside a vendor’s wrapper',
  'err-ssh': 'An SSH host that never answered — the transport, not the agent',
  'err-not-installed': 'A CLI that is not on this machine',
  'err-signed-out': 'A CLI that is installed but signed out',
  'err-quota': 'A usage limit that is spent',
  'err-unknown': 'A failure nothing recognised, passed on whole',
}

function failureEvents(id: FailureCaseId): SessionEvent[] {
  return [
    stateEvent(1, TS0, { k: 'user', text: ASK }, { id: `${id}:1` }),
    stateEvent(2, TS0 + 300, CONFIG, { id: `${id}:2` }),
    stateEvent(
      3,
      TS0 + 900,
      { k: 'tool', toolId: `${id}-tool`, name: 'Bash', input: { command: 'ping -c 3 google.com' }, summary: 'ping -c 3 google.com' },
      { id: `${id}:3` },
    ),
    stateEvent(4, TS0 + 2_400, { k: 'error', text: FIXTURE_FAILURES[id] }, { id: `${id}:4` }),
  ]
}

/**
 * Chatter and a failure in one turn.
 *
 * The comparison is the point, and it is the same kind of comparison the turn
 * states needed: three lines of harmless stderr next to one real failure, so
 * "noise did not become an error" and "the error was not lost in the noise" can
 * both be read off one picture.
 */
const chatterEvents: SessionEvent[] = [
  stateEvent(1, TS0, { k: 'user', text: ASK }, { id: 'err-chatter:1' }),
  ...FIXTURE_CHATTER.map((text, index) =>
    stateEvent(2 + index, TS0 + 200 * (index + 1), { k: 'system', subtype: 'stderr', text }, { id: `err-chatter:${2 + index}` }),
  ),
  stateEvent(9, TS0 + 3_000, { k: 'assistant', text: 'google.com answered in 12ms.' }, { id: 'err-chatter:9' }),
  stateEvent(10, TS0 + 3_100, {
    k: 'result',
    subtype: 'success',
    text: '',
    usage: usage(40),
    durationMs: 3_100,
    costUsd: 0,
    costReported: false,
  }, { id: 'err-chatter:10' }),
]

export interface TurnCase {
  id: string
  label: string
  session: SessionSummary
  events: SessionEvent[]
  live: Record<string, LiveBuffer>
}

/** One turn per failure shape, plus the chatter that must not become one. */
export const fixtureFailureCases: TurnCase[] = [
  ...(Object.keys(FIXTURE_FAILURES) as FailureCaseId[]).map((id) => ({
    id,
    label: FAILURE_LABEL[id],
    session: stateSession(id, 'idle' as const),
    events: failureEvents(id),
    live: {},
  })),
  {
    id: 'err-chatter',
    label: 'Harmless stderr — chatter, not a failure',
    session: stateSession('err-chatter', 'idle'),
    events: chatterEvents,
    live: {},
  },
]

export const fixtureTurnCases: TurnCase[] = [
  {
    id: 'turn-sticky-header',
    label: 'Long running turn — header pinned against the top edge',
    session: stateSession('turn-sticky-header', 'running'),
    events: [
      stateEvent(1, TS0, { k: 'user', text: 'Inspect the repository.' }),
      ...Array.from({ length: 30 }, (_, index) => stateEvent(index + 2, TS0 + (index + 1) * 100, {
        k: 'tool',
        toolId: `sticky-tool-${index}`,
        name: 'Bash',
        input: { command: `Inspect file ${index + 1}` },
        summary: `Inspect file ${index + 1}`,
      })),
    ],
    live: {},
  },
  {
    id: 'turn-long-prompt',
    label: 'Long user prompt — folded by default',
    session: stateSession('turn-long-prompt', 'idle'),
    events: [stateEvent(1, TS0, {
      k: 'user',
      text: Array.from({ length: 12 }, (_, index) => `Paragraph ${index + 1}: review this detailed requirement and keep its original wording visible when expanded.`).join('\n'),
    })],
    live: {},
  },
  {
    id: 'turn-harness-starting',
    label: 'Prompt accepted while the harness is still starting',
    session: stateSession('turn-harness-starting', 'starting'),
    events: [stateEvent(1, TS0, { k: 'user', text: 'Check the repository status.' })],
    live: {},
  },
  {
    id: 'turn-working',
    label: 'In progress — work open, prose streaming',
    session: stateSession('turn-working', 'running'),
    events: fixtureWorkingEvents,
    live: fixtureWorkingLive,
  },
  {
    id: 'turn-prompt-queued',
    label: 'A prompt waiting behind the active turn',
    session: stateSession('turn-prompt-queued', 'running'),
    events: fixtureQueuedPromptEvents,
    live: {},
  },
  {
    id: 'turn-native-request',
    label: 'A native harness request waiting for an answer',
    session: stateSession('turn-native-request', 'running'),
    events: fixtureNativeRequestEvents,
    live: {},
  },
  {
    id: 'turn-finished',
    label: 'Finished — the same turn, settled',
    session: stateSession('turn-finished', 'idle'),
    events: fixtureFinishedEvents,
    live: {},
  },
  {
    id: 'turn-multi-reply',
    label: 'One turn, three assistant messages',
    session: stateSession('turn-multi', 'idle'),
    events: fixtureMultiReplyEvents,
    live: {},
  },
  {
    id: 'turn-subagent-failed',
    label: 'A subagent that failed',
    session: stateSession('turn-failed', 'idle'),
    events: fixtureSubagentFailedEvents,
    live: {},
  },
  {
    id: 'turn-subagent-starting',
    label: 'Two subagents in the second after they were launched',
    session: stateSession('turn-starting', 'running'),
    events: fixtureSubagentStartingEvents,
    live: {},
  },
  {
    id: 'turn-many-prompts',
    label: 'Thirty prompts — the minimap past its height, scrolling on its own',
    session: stateSession('turn-many-prompts', 'idle'),
    events: Array.from({ length: 30 }, (_, index) => [
      stateEvent(index * 3 + 1, TS0 + index * 3_000, { k: 'user', text: `Prompt number ${index + 1}: check step ${index + 1}.` }, { id: `many:${index}:u`, turnId: `many-${index}` }),
      stateEvent(index * 3 + 2, TS0 + index * 3_000 + 1_000, { k: 'assistant', text: `Step ${index + 1} is fine.` }, { id: `many:${index}:a`, turnId: `many-${index}` }),
      stateEvent(index * 3 + 3, TS0 + index * 3_000 + 1_200, { k: 'result', subtype: 'success', text: '', durationMs: 1_200, costUsd: 0, costReported: false }, { id: `many:${index}:r`, turnId: `many-${index}` }),
    ]).flat(),
    live: {},
  },
  {
    id: 'turn-subagent-nested',
    label: 'A subagent launched by another subagent',
    session: stateSession('turn-nested', 'running'),
    events: fixtureNestedSubagentEvents,
    live: {},
  },
]

export const fixtureSettings: UiSettings = {
  theme: 'light',
  uiFontSize: 16,
  contentFontSize: 17,
  railWidth: 298,
  filesWidth: 236,
  chimeOnDone: true,
  railVisible: true,
  showThinking: true,
  compactTurns: false,
  filesVisible: false,
  showCost: false,
  machine: null,
  dockSide: 'bottom',
}

/**
 * Enough app state to render the real status bar in the gallery.
 *
 * `showCost` is on because the price is hidden by default on a subscription, and
 * a hidden readout would make the cost cases pass by not being drawn at all.
 */
export const fixtureState: State = {
  connected: true,
  sessions: {},
  drafts: {},
  caps: {},
  capsFailed: {},
  harnessUpdateErrors: {},
  // The subagent chip of the real status bar is derived from the session's own
  // events, so the gallery hands it the thread it already renders.
  events: { [fixtureSession.id]: fixtureEvents },
  live: {},
  answers: {},
  limits: fixtureLimits,
  projects: [],
  machineColors: {},
  toasts: [],
  active: null,
  openTabs: [],
  tabs: {},
  settings: { ...fixtureSettings, showCost: true },
  railOpen: {},
  dialog: null,
  defaults: {},
  seen: {},
  docks: {},
  restored: {},
  turns: {},
  editedPrompts: {},
  version: 1,
}

/* ------------------------------------------------------------------ */
/* One finished turn per harness                                       */
/* ------------------------------------------------------------------ */

/**
 * The work area as each harness actually fills it.
 *
 * The UI is provider-agnostic, but the shapes are not: Claude names its tools
 * and launches subagents, ACP agents title each call and name its `kind`, and
 * Command Code uses lower-case tool names. One settled turn per harness, with
 * every kind of row it can produce, is what a redesign of the work area has to
 * be judged against — `preview.html?only=harnesses` renders them side by side.
 */
function harnessEvents(
  id: string,
  rows: Array<SessionEvent['ev'] | [SessionEvent['ev'], { agentId?: string; parentAgentId?: string }]>,
): SessionEvent[] {
  return rows.map((row, index) => {
    const [payload, extra] = Array.isArray(row) ? row : [row, {}]
    return stateEvent(index + 1, TS0 + index * 700, payload, { id: `${id}:${index + 1}`, turnId: `${id}-turn`, ...extra })
  })
}

const call = (toolId: string, name: string, input: unknown, summary = '', kind?: string): SessionEvent['ev'] =>
  ({ k: 'tool', toolId, name, input, summary, ...(kind ? { kind } : {}) })
const done = (toolId: string, text: string, extra: { durationMs?: number; exitCode?: number; isError?: boolean } = {}): SessionEvent['ev'] =>
  ({ k: 'tool_result', toolId, text, isError: extra.isError ?? false, truncated: false, ...extra })
const settled = (ms: number): SessionEvent['ev'] =>
  ({ k: 'result', subtype: 'success', text: '', usage: usage(900), durationMs: ms, costUsd: 0, costReported: false })

// ACP replaces its plan in place (one id per session), so the row keeps the
// place of the first plan and the text of the last.
const ACP_PLAN = '✓ Read the limiter and its tests\n✓ Add a per-key window\n▸ Run the test suite\n· Update the changelog'

function acpEvents(id: string, titles: { run: string; read: string; search: string; edit: string }): SessionEvent[] {
  return harnessEvents(id, [
    { k: 'user', text: 'Add a per-key window to the rate limiter and run the tests.' },
    { k: 'thinking', text: 'The limiter keeps one global bucket. A per-key window means a map keyed by caller, pruned on read.\n\nI should read the current tests first.' },
    { k: 'system', subtype: 'plan', text: ACP_PLAN },
    call(`${id}-r1`, titles.read, { path: 'src/limiter.ts' }, `${titles.read} src/limiter.ts`, 'read'),
    done(`${id}-r1`, 'export function rateLimit() {}'),
    call(`${id}-r2`, titles.read, { path: 'test/limiter.test.ts' }, `${titles.read} test/limiter.test.ts`, 'read'),
    done(`${id}-r2`, 'describe(...)'),
    call(`${id}-s1`, titles.search, { query: 'rateLimit(' }, `${titles.search} rateLimit(`, 'search'),
    done(`${id}-s1`, 'src/api/orders.ts\nsrc/api/users.ts'),
    { k: 'assistant', text: 'The limiter is only called from two routes, so the key can be the caller id they already pass.' },
    call(`${id}-e1`, titles.edit, { path: 'src/limiter.ts' }, `${titles.edit} src/limiter.ts`, 'edit'),
    done(`${id}-e1`, 'ok'),
    call(`${id}-x1`, titles.run, { command: 'bun test' }, `${titles.run} bun test`, 'execute'),
    done(`${id}-x1`, '14 pass\n0 fail', { durationMs: 3_200, exitCode: 0 }),
    call(`${id}-x2`, titles.run, { command: 'bun run typecheck' }, `${titles.run} bun run typecheck`, 'execute'),
    done(`${id}-x2`, '', { durationMs: 5_900, exitCode: 0 }),
    { k: 'assistant', text: 'Each caller now gets its own 60-second window. All 14 tests pass and the tree type-checks.' },
    settled(21_000),
  ])
}

const CLAUDE_AGENT_RESULT =
  'The middleware trusts `x-user-id` from the request when the session cookie is missing.\n\n' +
  'Three routes are exposed: `/api/orders`, `/api/users/:id` and `/api/export`. The fix is to read the id from the verified session only and reject the header outright.\n\n' +
  '| Route | Exposed | Fix |\n|---|---|---|\n| /api/orders | yes | session only |\n| /api/users/:id | yes | session only |\n| /api/export | yes | session only |'

const claudeHarnessEvents = harnessEvents('h-claude', [
  { k: 'user', text: 'Audit the auth middleware and fix what you find.' },
  CONFIG,
  { k: 'thinking', text: COMMITTED_THINKING },
  call('hc-todo', 'TodoWrite', { todos: [
    { content: 'Audit the middleware', status: 'completed' },
    { content: 'Fix the header fallback', status: 'in_progress' },
    { content: 'Run the suite', status: 'pending' },
  ] }),
  { k: 'assistant', text: 'Sending an agent to audit the middleware while I read the routes.' },
  { k: 'subagent_start', toolId: 'hc-agent', agentId: 'agent-audit', agentType: 'Explore', description: 'Audit the auth middleware', prompt: 'Read src/middleware/auth.ts and every route that uses it. Report any path where the user id can come from the client.\n\nFor each route, say:\n- where the user id is read from (session, header, query or body);\n- whether the session is verified before the handler runs;\n- what an unauthenticated caller could do with it.\n\nDo not change any file. Keep the report to one table and at most three sentences of summary.', depth: 1 },
  [call('hc-a1', 'Read', { file_path: '/Users/you/Projects/acme-api/src/middleware/auth.ts' }, 'src/middleware/auth.ts'), { agentId: 'agent-audit' }],
  [done('hc-a1', 'export function auth() {}'), { agentId: 'agent-audit' }],
  [call('hc-a2', 'Grep', { pattern: 'x-user-id' }, 'x-user-id'), { agentId: 'agent-audit' }],
  [done('hc-a2', 'Found 3 files'), { agentId: 'agent-audit' }],
  [{ k: 'assistant', text: 'The header fallback is used by three routes.' }, { agentId: 'agent-audit' }],
  [call('hc-a3', 'Read', { file_path: '/Users/you/Projects/acme-api/src/api/export.ts' }, 'src/api/export.ts'), { agentId: 'agent-audit' }],
  [done('hc-a3', 'export default route'), { agentId: 'agent-audit' }],
  [{ k: 'assistant', text: CLAUDE_AGENT_RESULT }, { agentId: 'agent-audit' }],
  { k: 'subagent_end', toolId: 'hc-agent', agentId: 'agent-audit', status: 'done', durationMs: 38_000, usage: usage(1_400), toolUses: 3, result: CLAUDE_AGENT_RESULT },
  call('hc-b1', 'Bash', { command: 'git diff --stat' }, 'git diff --stat'),
  done('hc-b1', '', { durationMs: 200, exitCode: 0 }),
  call('hc-b2', 'Bash', { command: 'bun test test/auth.test.ts' }, 'bun test test/auth.test.ts'),
  done('hc-b2', '9 pass', { durationMs: 4_100, exitCode: 0 }),
  call('hc-b3', 'Bash', { command: 'bun run typecheck' }, 'bun run typecheck'),
  done('hc-b3', '', { durationMs: 6_300, exitCode: 0 }),
  { k: 'assistant', text: 'The audit found the header fallback; fixing it now.' },
  settled(30_000),
  call('hc-e1', 'Edit', { file_path: '/Users/you/Projects/acme-api/src/middleware/auth.ts', old_string: 'a', new_string: 'b' }, 'src/middleware/auth.ts'),
  done('hc-e1', 'ok'),
  ...NOTICES,
  { k: 'assistant', text: 'The middleware now reads the user id from the verified session only, and rejects `x-user-id` outright. All 9 auth tests pass.' },
  settled(52_000),
])

/** A Claude turn still out: one agent running, one back, the reply not written yet. */
const REATTACHED: SessionEvent['ev'] = { k: 'system', subtype: 'reattached', text: 'reattached to the agent that kept running while sedano was closed' }

const claudeRunningEvents = harnessEvents('h-claude-live', [
  { k: 'user', text: 'Ping google.com and github.com from two agents and give me a table.' },
  // Said twice in a row by the harness, drawn once with "×2".
  REATTACHED,
  REATTACHED,
  { k: 'thinking', text: COMMITTED_THINKING },
  { k: 'subagent_start', toolId: 'hl-1', agentId: 'agent-gh', agentType: 'general-purpose', description: 'Ping github.com', prompt: 'Run `ping -c 3 github.com` and report the mean round trip.', depth: 1 },
  { k: 'subagent_start', toolId: 'hl-2', agentId: 'agent-gg', agentType: 'general-purpose', description: 'Ping google.com', prompt: 'Run `ping -c 3 google.com` and report the mean round trip.', depth: 1 },
  [call('hl-t1', 'Bash', { command: 'ping -c 3 github.com' }, 'ping -c 3 github.com'), { agentId: 'agent-gh' }],
  [done('hl-t1', '3 received', { durationMs: 2_100, exitCode: 0 }), { agentId: 'agent-gh' }],
  [{ k: 'assistant', text: 'github.com — 140.82.121.4, 107 ms mean, 0% loss.' }, { agentId: 'agent-gh' }],
  { k: 'subagent_end', toolId: 'hl-1', agentId: 'agent-gh', status: 'done', durationMs: 4_000, toolUses: 1, result: 'github.com — 140.82.121.4, 107 ms mean, 0% loss.' },
  [call('hl-t2', 'Bash', { command: 'ping -c 3 google.com' }, 'ping -c 3 google.com'), { agentId: 'agent-gg' }],
])

const commandcodeHarnessEvents = harnessEvents('h-cmd', [
  { k: 'user', text: 'Rename the config loader to loadSettings and update the callers.' },
  { k: 'assistant', text: 'I will find every caller first.' },
  call('hm-1', 'grep', { pattern: 'loadConfig' }, 'grep loadConfig'),
  done('hm-1', 'src/a.ts\nsrc/b.ts\nsrc/c.ts'),
  call('hm-2', 'read_file', { path: 'src/config.ts' }, 'read_file src/config.ts'),
  done('hm-2', 'export function loadConfig() {}'),
  call('hm-3', 'edit_file', { path: 'src/config.ts' }, 'edit_file src/config.ts'),
  done('hm-3', 'ok'),
  call('hm-4', 'edit_file', { path: 'src/a.ts' }, 'edit_file src/a.ts'),
  done('hm-4', 'ok'),
  call('hm-5', 'run_terminal_command', { command: 'bun test' }, 'run_terminal_command bun test'),
  done('hm-5', '1 fail', { durationMs: 2_400, exitCode: 1, isError: true }),
  { k: 'assistant', text: 'One test still imports the old name.' },
  call('hm-6', 'edit_file', { path: 'test/config.test.ts' }, 'edit_file test/config.test.ts'),
  done('hm-6', 'ok'),
  call('hm-7', 'run_terminal_command', { command: 'bun test' }, 'run_terminal_command bun test'),
  done('hm-7', '12 pass', { durationMs: 2_300, exitCode: 0 }),
  { k: 'assistant', text: '`loadConfig` is now `loadSettings` in the loader, its two callers and the test. The suite passes.' },
  settled(14_000),
])

function harnessCase(harness: SessionSummary['harness'], label: string, model: string, events: SessionEvent[], status: SessionSummary['status'] = 'idle'): TurnCase {
  return { id: `harness-${harness}${status === 'running' ? '-live' : ''}`, label, session: { ...stateSession(`harness-${harness}`, status), harness, model }, events, live: {} }
}

export const fixtureHarnessCases: TurnCase[] = [
  harnessCase('claude', 'Claude Code — reasoning, plan, notes, a subagent, a tool run, updates, notices', 'claude-opus-4-6', claudeHarnessEvents),
  harnessCase('claude', 'Claude Code — still working: one agent back, one running', 'claude-opus-4-6', claudeRunningEvents, 'running'),
  harnessCase('codex', 'Codex (ACP) — titled calls with a kind, a plan, reasoning', 'gpt-5.6', acpEvents('h-codex', { run: 'Run', read: 'Read', search: 'Search', edit: 'Edit' })),
  harnessCase('gemini', 'Gemini (ACP)', 'gemini-2.5-pro', acpEvents('h-gemini', { run: 'Shell', read: 'ReadFile', search: 'SearchText', edit: 'WriteFile' })),
  harnessCase('opencode', 'OpenCode (ACP)', 'anthropic/claude-sonnet-4-5', acpEvents('h-opencode', { run: 'bash', read: 'read', search: 'grep', edit: 'edit' })),
  harnessCase('grok', 'Grok (ACP)', 'grok-4', acpEvents('h-grok', { run: 'run_command', read: 'read_file', search: 'search', edit: 'edit_file' })),
  harnessCase('commandcode', 'Command Code — lower-case tool names, a failed command', 'poolside/laguna-s-2.1-free', commandcodeHarnessEvents),
]
