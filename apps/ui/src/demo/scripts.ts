/**
 * What the demo's agents "do": short scripts of thinking, tool calls, edits,
 * subagents and questions, played back by the fake server (`server.ts`) with
 * realistic timing. Nothing here is generated — a prompt is matched by keyword
 * to one of a few canned scripts, and the seeded history is built from the same
 * scripts, so a live turn and a past one look alike.
 *
 * Paths are relative to the session's folder; the engine makes them absolute.
 */
import type { RequestOption } from '@shared'

export type Step =
  | { t: 'think'; text: string }
  | { t: 'say'; text: string }
  | { t: 'run'; command: string; output: string; ms?: number; exit?: number }
  | { t: 'read'; path: string; output: string }
  | { t: 'search'; pattern: string; output: string }
  | { t: 'edit'; path: string; change: 'create' | 'edit'; added: number; removed: number; diff: string }
  | { t: 'agent'; type: string; description: string; prompt: string; model?: string; steps: Step[]; result: string }
  | {
      t: 'ask'
      kind: 'question' | 'permission'
      title: string
      detail?: string
      options: RequestOption[]
      /** What happens after each answer; an option without a branch just continues. */
      branches: Record<string, Step[]>
    }
  | { t: 'system'; subtype: string; text: string }
  | { t: 'pause'; ms: number }

/* ------------------------------------------------------------------ */
/* Diffs                                                               */
/* ------------------------------------------------------------------ */

const RATE_LIMIT_PATCH = `@@ -0,0 +1,22 @@
+import { LRUCache } from '../lib/lru.ts'
+
+const WINDOW_MS = 60_000
+const MAX_HITS = 120
+
+const buckets = new LRUCache<{ start: number; hits: number }>(5_000)
+
+/** Fixed-window limiter: cheap, predictable, no timers. */
+export function rateLimit(key: string, now = Date.now()): boolean {
+  const bucket = buckets.get(key)
+  if (!bucket || now - bucket.start >= WINDOW_MS) {
+    buckets.set(key, { start: now, hits: 1 })
+    return true
+  }
+  if (bucket.hits >= MAX_HITS) return false
+  bucket.hits += 1
+  return true
+}
+
+export function retryAfter(key: string, now = Date.now()): number {
+  const bucket = buckets.get(key)
+  return bucket ? Math.ceil((bucket.start + WINDOW_MS - now) / 1000) : 0
+}`

const ROUTER_PATCH = `@@ -4,9 +4,15 @@ import { orders } from './routes/orders.ts'
 import { users } from './routes/users.ts'
+import { rateLimit, retryAfter } from './middleware/rate-limit.ts'

 export const router = new Router()

-router.post('/api/orders', auth, orders.create)
+router.post('/api/orders', auth, async (req, ctx) => {
+  const key = ctx.apiKey ?? req.ip
+  if (!rateLimit(key)) {
+    return json({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': String(retryAfter(key)) } })
+  }
+  return orders.create(req, ctx)
+})
 router.get('/api/orders/:id', auth, orders.get)`

const RATE_TEST_PATCH = `@@ -12,7 +12,16 @@ describe('rate limit', () => {
   it('allows the first 120 requests', () => {
     for (let i = 0; i < 120; i++) expect(rateLimit('k', T0)).toBe(true)
   })
-  it.todo('blocks the 121st')
+  it('blocks the 121st inside the window', () => {
+    for (let i = 0; i < 120; i++) rateLimit('k2', T0)
+    expect(rateLimit('k2', T0 + 1_000)).toBe(false)
+    expect(retryAfter('k2', T0 + 1_000)).toBe(59)
+  })
+  it('opens a fresh window after 60 s', () => {
+    for (let i = 0; i < 121; i++) rateLimit('k3', T0)
+    expect(rateLimit('k3', T0 + 60_000)).toBe(true)
+  })
 })`

const CSV_PATCH = `@@ -1,21 +1,24 @@
-import { readFile } from 'node:fs/promises'
+import { createReadStream } from 'node:fs'
+import { createInterface } from 'node:readline'
 import { parseRow } from '../lib/csv.ts'
 import { db } from '../lib/db.ts'

-export async function importOrders(path: string): Promise<number> {
-  const text = await readFile(path, 'utf8')
-  const rows = text.split('\\n').slice(1).map(parseRow)
-  await db.insertMany('orders', rows)
-  return rows.length
+const BATCH = 500
+
+export async function importOrders(path: string): Promise<number> {
+  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
+  let batch: Order[] = []
+  let total = 0
+  let header = true
+  for await (const line of lines) {
+    if (header) { header = false; continue }
+    batch.push(parseRow(line))
+    if (batch.length === BATCH) total += await flush(batch), batch = []
+  }
+  return total + (batch.length ? await flush(batch) : 0)
 }`

const EXPIRY_PATCH = `@@ -31,8 +31,9 @@ export async function expireOrders(now = clock.now()) {
-  const cutoff = new Date(Date.now() - TTL_MS)
+  // The clock is injected so tests can pin "now"; Date.now() made the
+  // boundary depend on how long the suite had been running.
+  const cutoff = new Date(now - TTL_MS)
   const stale = await db.orders.where('status', 'pending').andWhere('created_at', '<', cutoff)`

const RUNBOOK_PATCH = `@@ -0,0 +1,28 @@
+# acme-api deploy runbook
+
+## Before you ship
+
+1. \`bun test\` is green on \`main\`.
+2. Migrations are reviewed: \`bun run migrate --dry-run\`.
+3. The changelog has an entry for the release.
+
+## Deploy
+
+\`\`\`sh
+git tag v$(jq -r .version package.json) && git push --tags
+kubectl -n acme rollout restart deploy/api
+kubectl -n acme rollout status deploy/api --timeout=120s
+\`\`\`
+
+## Roll back
+
+\`\`\`sh
+kubectl -n acme rollout undo deploy/api
+\`\`\`
+
+| Signal | Healthy | Page someone |
+|---|---|---|
+| p95 latency | < 120 ms | > 400 ms for 5 min |
+| 5xx rate | < 0.1 % | > 1 % for 2 min |
+| Queue depth | < 50 | > 500 |`

const THEME_PATCH = `@@ -1,6 +1,22 @@
+import { useEffect, useState } from 'react'
+
+type Theme = 'light' | 'dark'
+
+export function ThemeToggle() {
+  const [theme, setTheme] = useState<Theme>(() =>
+    (localStorage.getItem('theme') as Theme | null) ??
+    (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
+  )
+  useEffect(() => {
+    document.documentElement.dataset.theme = theme
+    localStorage.setItem('theme', theme)
+  }, [theme])
+  return (
+    <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Toggle theme">
+      {theme === 'dark' ? '☀︎' : '☾'}
+    </button>
+  )
+}`

const ORDERS_REFACTOR_PATCH = `@@ -18,34 +18,22 @@ export const orders = {
-  async create(req: Request, ctx: Context) {
-    const body = await req.json()
-    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
-      return json({ error: 'items required' }, { status: 400 })
-    }
-    for (const item of body.items) {
-      if (typeof item.sku !== 'string' || typeof item.qty !== 'number' || item.qty < 1) {
-        return json({ error: 'bad item' }, { status: 400 })
-      }
-    }
-    const total = body.items.reduce((sum: number, item: any) => sum + item.qty * prices[item.sku], 0)
+  async create(req: Request, ctx: Context) {
+    const parsed = OrderInput.safeParse(await req.json())
+    if (!parsed.success) return json({ error: parsed.error.issues[0]?.message }, { status: 400 })
+    const total = priceOf(parsed.data.items)
     const order = await db.orders.insert({ ...parsed.data, total, owner: ctx.userId })
     return json(order, { status: 201 })
   },`

/* ------------------------------------------------------------------ */
/* Live scripts, matched by keyword                                    */
/* ------------------------------------------------------------------ */

const TEST_OUTPUT_PASS = `bun test v1.2.23

tests/rate-limit.test.ts:
✓ rate limit > allows the first 120 requests [0.41ms]
✓ rate limit > blocks the 121st inside the window [0.22ms]
✓ rate limit > opens a fresh window after 60 s [0.09ms]

tests/orders.test.ts:
✓ orders > creates an order [3.10ms]
✓ orders > rejects an empty cart [0.52ms]
✓ orders › expiry > expires pending orders after 30 min [1.84ms]

 41 pass
 0 fail
 128 expect() calls
Ran 41 tests across 4 files. [612.00ms]`

function testScript(): Step[] {
  return [
    { t: 'think', text: 'They want tests. Before writing any I should see what is already covered, and which runner the repo uses — `package.json` says bun. The order handler has no test for an empty cart or a bad SKU. I should ask which cases matter most rather than guess.' },
    { t: 'search', pattern: 'describe\\(', output: 'tests/auth.test.ts:3\ntests/csv-importer.test.ts:5\ntests/orders.test.ts:8\ntests/rate-limit.test.ts:9' },
    { t: 'read', path: 'tests/orders.test.ts', output: "import { describe, expect, it } from 'bun:test'\nimport { app } from '../src/index.ts'\n\ndescribe('orders', () => {\n  it('creates an order', async () => {\n    const res = await app.request('/api/orders', { method: 'POST', body: JSON.stringify(ORDER) })\n    expect(res.status).toBe(201)\n  })\n})" },
    {
      t: 'ask',
      kind: 'question',
      title: 'Which cases should the new tests cover first?',
      detail: 'The order route has one happy-path test. I can add the edge cases, the auth failures, or both.',
      options: [
        { id: 'edges', label: 'Validation edge cases', hint: 'Empty cart, unknown SKU, zero quantity' },
        { id: 'auth', label: 'Auth failures', hint: 'Missing, expired and foreign tokens' },
        { id: 'both', label: 'Both (recommended)', hint: 'About 9 tests, still under a second' },
      ],
      branches: {
        edges: [{ t: 'say', text: 'Going with the validation edge cases.' }],
        auth: [{ t: 'say', text: 'Going with the auth failures.' }],
        both: [{ t: 'say', text: 'Covering both — validation first, then auth.' }],
      },
    },
    {
      t: 'edit',
      path: 'tests/orders.test.ts',
      change: 'edit',
      added: 24,
      removed: 1,
      diff: `@@ -8,4 +8,27 @@ describe('orders', () => {
     expect(res.status).toBe(201)
   })
-})
+
+  it('rejects an empty cart', async () => {
+    const res = await post({ ...ORDER, items: [] })
+    expect(res.status).toBe(400)
+    expect(await res.json()).toEqual({ error: 'items required' })
+  })
+
+  it('rejects an unknown SKU', async () => {
+    const res = await post({ ...ORDER, items: [{ sku: 'nope', qty: 1 }] })
+    expect(res.status).toBe(400)
+  })
+
+  it('refuses an expired token', async () => {
+    const res = await post(ORDER, { token: EXPIRED })
+    expect(res.status).toBe(401)
+  })
+})`,
    },
    {
      t: 'agent',
      type: 'test-runner',
      description: 'Run the full suite',
      prompt: 'Run `bun test` from the repo root and report every failure with its assertion output. Do not edit files.',
      model: 'claude-haiku-4-5',
      steps: [
        { t: 'run', command: 'bun test', output: TEST_OUTPUT_PASS, ms: 1_400, exit: 0 },
      ],
      result: 'All 41 tests pass across 4 files (612 ms). No flaky output on a second run.',
    },
    { t: 'think', text: 'Suite is green, including the new cases. Summarise briefly with the counts.' },
    {
      t: 'say',
      text: [
        'Added **3 tests** to `tests/orders.test.ts`, and the whole suite passes:',
        '',
        '| File | Tests | Result |',
        '|:-----|------:|:------:|',
        '| `tests/orders.test.ts` | 6 | ✅ |',
        '| `tests/rate-limit.test.ts` | 3 | ✅ |',
        '| `tests/auth.test.ts` | 18 | ✅ |',
        '| `tests/csv-importer.test.ts` | 14 | ✅ |',
        '',
        'They go through `app.request`, so they exercise the router and the auth guard rather than calling the handler directly.',
      ].join('\n'),
    },
  ]
}

function bugScript(): Step[] {
  return [
    { t: 'think', text: 'A bug report. First reproduce it: run the failing test on its own, then read the code on the stack trace. Guessing a fix before seeing the failure is how you fix the wrong thing.' },
    {
      t: 'run',
      command: 'bun test tests/orders.test.ts -t expiry',
      output: '✗ orders › expiry > expires pending orders after 30 min\n  Expected: 1\n  Received: 0\n\n      at tests/orders.test.ts:52:31\n\n 0 pass\n 1 fail',
      ms: 900,
      exit: 1,
    },
    { t: 'search', pattern: 'TTL_MS', output: 'src/routes/orders.ts:7:const TTL_MS = 30 * 60_000\nsrc/routes/orders.ts:33:  const cutoff = new Date(Date.now() - TTL_MS)' },
    { t: 'read', path: 'src/routes/orders.ts', output: "export async function expireOrders(now = clock.now()) {\n  const cutoff = new Date(Date.now() - TTL_MS)\n  const stale = await db.orders.where('status', 'pending').andWhere('created_at', '<', cutoff)\n  ...\n}" },
    { t: 'think', text: 'Found it: `expireOrders` takes an injected `now` but ignores it and calls `Date.now()`. The test pins the clock, so the cutoff drifts with real time. The fix is one line. The test database also has stale fixtures from a previous run — resetting it needs a destructive command, so ask first.' },
    {
      t: 'ask',
      kind: 'permission',
      title: 'Run `bun run db:reset --env test`?',
      detail: 'Drops and re-seeds the local test database (acme_test). Nothing outside this machine is touched.',
      options: [
        { id: 'allow', label: 'Allow once', intent: 'allow' },
        { id: 'always', label: 'Always allow db:reset', intent: 'allow' },
        { id: 'deny', label: 'Deny', intent: 'deny', hint: 'I will work around it' },
      ],
      branches: {
        allow: [{ t: 'run', command: 'bun run db:reset --env test', output: 'dropped acme_test\ncreated acme_test\nseeded 3 users, 12 orders', ms: 1_100, exit: 0 }],
        always: [{ t: 'run', command: 'bun run db:reset --env test', output: 'dropped acme_test\ncreated acme_test\nseeded 3 users, 12 orders', ms: 1_100, exit: 0 }],
        deny: [{ t: 'say', text: 'Understood — I will leave the database alone and use a fresh in-memory store for this test instead.' }],
      },
    },
    { t: 'edit', path: 'src/routes/orders.ts', change: 'edit', added: 3, removed: 1, diff: EXPIRY_PATCH },
    { t: 'run', command: 'bun test tests/orders.test.ts', output: '✓ orders > creates an order\n✓ orders > rejects an empty cart\n✓ orders › expiry > expires pending orders after 30 min\n\n 3 pass\n 0 fail', ms: 700, exit: 0 },
    {
      t: 'say',
      text: [
        'Fixed. The cause was a clock mix-up in `expireOrders`:',
        '',
        '```ts',
        '// before — ignores the injected clock',
        'const cutoff = new Date(Date.now() - TTL_MS)',
        '// after',
        'const cutoff = new Date(now - TTL_MS)',
        '```',
        '',
        'The test pins `now`, so with `Date.now()` the cutoff moved with wall time and the order was never old enough to expire. The expiry test now passes deterministically.',
      ].join('\n'),
    },
  ]
}

function refactorScript(): Step[] {
  return [
    { t: 'think', text: 'Refactor request. The order handler does validation by hand: three nested checks with `any`. A schema would make the rules readable and give typed data for free. Keep behaviour identical — same status codes, same error shape — and let the tests prove it.' },
    { t: 'read', path: 'src/routes/orders.ts', output: "export const orders = {\n  async create(req: Request, ctx: Context) {\n    const body = await req.json()\n    if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {\n      return json({ error: 'items required' }, { status: 400 })\n    }\n    ..." },
    { t: 'search', pattern: 'OrderInput', output: 'No matches found' },
    { t: 'edit', path: 'src/routes/orders.ts', change: 'edit', added: 4, removed: 16, diff: ORDERS_REFACTOR_PATCH },
    {
      t: 'edit',
      path: 'src/routes/order-input.ts',
      change: 'create',
      added: 9,
      removed: 0,
      diff: "@@ -0,0 +1,9 @@\n+import { z } from 'zod'\n+\n+export const OrderInput = z.object({\n+  items: z.array(z.object({ sku: z.string(), qty: z.number().int().min(1) })).min(1, 'items required'),\n+  note: z.string().max(500).optional(),\n+})\n+\n+export type OrderInput = z.infer<typeof OrderInput>\n+export const priceOf = (items: OrderInput['items']) => items.reduce((sum, i) => sum + i.qty * prices[i.sku]!, 0)",
    },
    { t: 'run', command: 'bun test && bunx tsc --noEmit', output: ' 41 pass\n 0 fail\nRan 41 tests across 4 files. [598.00ms]', ms: 2_100, exit: 0 },
    {
      t: 'say',
      text: [
        'Refactored `orders.create` — **−12 lines**, same behaviour:',
        '',
        '- Validation moved into a `zod` schema (`src/routes/order-input.ts`), so the rules read as data and `items` is typed instead of `any`.',
        '- Pricing is a pure `priceOf()` helper you can test on its own.',
        '- Status codes and the `{ error }` shape are unchanged; all 41 tests and the type check pass.',
        '',
        'One thing I did **not** change: `prices[sku]` still trusts the SKU exists after validation. Worth a follow-up if SKUs can be retired.',
      ].join('\n'),
    },
  ]
}

function explainScript(): Step[] {
  return [
    { t: 'think', text: 'An explanation, not a change. Read the code path end to end and describe it in the order a request experiences it.' },
    { t: 'read', path: 'src/middleware/auth.ts', output: "export async function auth(req: Request, ctx: Context) {\n  const token = bearer(req)\n  if (!token) return unauthorized('missing token')\n  const claims = await verify(token, KEYS)\n  if (claims.exp * 1000 < clock.now()) return unauthorized('expired')\n  ctx.userId = claims.sub\n}" },
    { t: 'read', path: 'src/router.ts', output: "router.post('/api/orders', auth, rateLimited(orders.create))\nrouter.get('/api/orders/:id', auth, orders.get)\nrouter.get('/health', health)" },
    {
      t: 'say',
      text: [
        'Here is how a request to `POST /api/orders` travels through **acme-api**:',
        '',
        '1. **`router.ts`** matches the route and runs its handlers left to right.',
        '2. **`auth`** reads the `Authorization: Bearer …` header, verifies the JWT against the rotating key set, rejects it if `exp` is in the past, and puts the user id on `ctx`.',
        '3. **`rateLimited`** keys a fixed 60-second window by API key (or IP) — 120 requests, then `429` with `Retry-After`.',
        '4. **`orders.create`** validates the cart, prices it and inserts the row.',
        '',
        '```text',
        'client ──▶ router ──▶ auth ──▶ rateLimited ──▶ orders.create',
        '              │          │            │',
        '            404        401          429',
        '```',
        '',
        '> The interesting choice is that `auth` runs **before** the limiter: an attacker without a token cannot spend a real customer\'s quota.',
      ].join('\n'),
    },
  ]
}

function fallbackScript(prompt: string): Step[] {
  const quoted = prompt.trim().split('\n')[0]!.slice(0, 80)
  return [
    { t: 'think', text: `The user asked: "${quoted}". This is the Sedano demo, so there is no real agent behind it — the honest reply is a short tour of what can be tried.` },
    { t: 'read', path: 'README.md', output: '# acme-api\n\nOrders, users and billing for the Acme storefront. Bun + SQLite, deployed to k8s.' },
    {
      t: 'say',
      text: [
        'This is a **scripted demo** — nothing you type leaves your browser, and no model is running. In the real app this turn would be streamed live from Claude Code, Codex, Gemini CLI, Opencode or Command Code running on your machine.',
        '',
        'A few prompts that show off the interface:',
        '',
        '- **“write tests for the orders route”** — a question card you answer, plus a subagent',
        '- **“fix the expiry bug”** — a permission card you can allow or deny',
        '- **“refactor the order handler”** — diffs you can expand',
        '- **“explain the auth middleware”** — a longer markdown answer',
        '',
        'Send a second prompt while one is running to see it **queue**, or press **Esc** to interrupt.',
      ].join('\n'),
    },
  ]
}

function slashScript(command: string): Step[] {
  if (command === 'compact' || command === 'compress') {
    return [
      { t: 'system', subtype: 'compact_boundary', text: 'Conversation compacted · 96.4k → 11.2k tokens' },
      { t: 'say', text: 'Compacted the conversation. The summary keeps the open task, the files touched and the test status.' },
    ]
  }
  if (command === 'review') {
    return [
      { t: 'run', command: 'git diff --stat main...HEAD', output: ' src/middleware/rate-limit.ts | 22 ++++++\n src/router.ts                |  8 ++-\n tests/rate-limit.test.ts     | 11 +++-\n 3 files changed, 38 insertions(+), 3 deletions(-)', ms: 300, exit: 0 },
      { t: 'say', text: 'Reviewed 3 files. The limiter is sound; one nit — `retryAfter` can return `0` at the exact window edge, which some clients treat as "retry immediately". Consider `Math.max(1, …)`.' },
    ]
  }
  return [{ t: 'say', text: `\`/${command}\` ran. (In the demo, slash commands are acknowledged but not executed.)` }]
}

/** The script a live prompt plays. */
export function scriptFor(prompt: string): Step[] {
  const text = prompt.toLowerCase()
  const slash = /^\/([\w-]+)/.exec(prompt.trim())
  if (slash) return slashScript(slash[1]!)
  if (/\b(test|tests|spec|coverage)\b/.test(text)) return testScript()
  if (/\b(bug|fix|error|crash|broken|fail|failing|flaky)\b/.test(text)) return bugScript()
  if (/\b(refactor|clean ?up|simplif|tidy|restructure)/.test(text)) return refactorScript()
  if (/\b(explain|how does|how do|what is|what does|why|walk me)\b/.test(text)) return explainScript()
  return fallbackScript(prompt)
}

/* ------------------------------------------------------------------ */
/* Moments: turns already waiting on the visitor when the demo opens   */
/* ------------------------------------------------------------------ */

/**
 * The landing page's captions deep-link to these: each is a live turn that
 * reaches its card within a second of boot and then waits, so the link lands
 * on the moment itself rather than on the lead-up to it.
 */
export interface Moment {
  prompt: string
  steps: Step[]
}

/** A question card: the tests script from the file it reads onward. */
export function questionMoment(): Moment {
  const steps = testScript()
  const ask = steps.findIndex((step) => step.t === 'ask')
  return { prompt: 'Write tests for the orders route.', steps: steps.slice(ask - 1) }
}

/** A permission card for a command that touches the network and the lockfile. */
export function permissionMoment(): Moment {
  return {
    prompt: 'Upgrade zod to v4 and fix whatever breaks.',
    steps: [
      { t: 'read', path: 'package.json', output: '{\n  "name": "acme-api",\n  "dependencies": {\n    "zod": "^3.23.8"\n  }\n}' },
      {
        t: 'ask',
        kind: 'permission',
        title: 'Run `bun add zod@^4`?',
        detail: 'Changes package.json and bun.lock, and downloads the package from the npm registry.',
        options: [
          { id: 'allow', label: 'Allow once', intent: 'allow' },
          { id: 'always', label: 'Always allow bun add', intent: 'allow' },
          { id: 'deny', label: 'Deny', intent: 'deny', hint: 'Keep zod 3' },
        ],
        branches: {
          allow: ZOD_UPGRADE,
          always: ZOD_UPGRADE,
          deny: [{ t: 'say', text: 'Understood — the dependencies stay as they are. Nothing in `src/` needs zod 4 today, so the upgrade can wait for a quieter week.' }],
        },
      },
    ],
  }
}

const ZOD_UPGRADE: Step[] = [
  { t: 'run', command: 'bun add zod@^4', output: 'bun add v1.2.23\n\ninstalled zod@4.1.5\n\n1 package installed [412.00ms]', ms: 900, exit: 0 },
  { t: 'run', command: 'bun test', output: TEST_OUTPUT_PASS, ms: 1_200, exit: 0 },
  { t: 'say', text: 'Upgraded **zod to 4.1.5**. The order schema only uses `z.object`, `z.array` and `.min()`, which kept their meaning, so no code changed and all 41 tests still pass.' },
]

/* ------------------------------------------------------------------ */
/* Seeded history                                                      */
/* ------------------------------------------------------------------ */

export interface SeedTurn {
  prompt: string
  steps: Step[]
  /** The answer each question in the turn got, by its title. */
  answers?: Record<string, string>
}

export const SEED_RATE_LIMIT: SeedTurn[] = [
  {
    prompt: 'Add a fixed-window rate limiter to POST /api/orders (120 req/min per API key), wire it into the router, and cover it with tests.',
    steps: [
      { t: 'system', subtype: 'init', text: 'claude-opus-4-6 · /Users/you/Projects/acme-api · acceptEdits' },
      { t: 'think', text: 'The endpoint goes through src/middleware, so the limiter belongs there. A fixed window with an LRU is enough — no timers, nothing to leak. I need the existing middleware signature first, then I can hand the test run to a subagent while I wire the router.' },
      { t: 'say', text: "I'll read the current middleware first, then write the limiter and hand the test suite to a subagent." },
      { t: 'read', path: 'src/middleware/index.ts', output: "export type Handler = (req: Request, ctx: Context) => Promise<Response | void>\nexport function chain(...handlers: Handler[]): Handler {\n  return async (req, ctx) => {\n    for (const h of handlers) {\n      const res = await h(req, ctx)\n      if (res) return res\n    }\n  }\n}" },
      { t: 'search', pattern: 'LRUCache', output: 'src/lib/lru.ts:1:export class LRUCache<T> {' },
      { t: 'edit', path: 'src/middleware/rate-limit.ts', change: 'create', added: 22, removed: 0, diff: RATE_LIMIT_PATCH },
      { t: 'edit', path: 'src/router.ts', change: 'edit', added: 7, removed: 1, diff: ROUTER_PATCH },
      {
        t: 'agent',
        type: 'general-purpose',
        description: 'Write and run the limiter tests',
        prompt: 'Fill in tests/rate-limit.test.ts: the 121st request inside a window is refused with the right retry-after, and a new window opens after 60 s. Then run `bun test`.',
        model: 'claude-haiku-4-5',
        steps: [
          { t: 'read', path: 'tests/rate-limit.test.ts', output: "describe('rate limit', () => {\n  it('allows the first 120 requests', () => { ... })\n  it.todo('blocks the 121st')\n})" },
          { t: 'edit', path: 'tests/rate-limit.test.ts', change: 'edit', added: 10, removed: 1, diff: RATE_TEST_PATCH },
          { t: 'run', command: 'bun test', output: TEST_OUTPUT_PASS, ms: 1_210, exit: 0 },
        ],
        result: 'Added two cases to tests/rate-limit.test.ts. All 41 tests pass (612 ms).',
      },
      {
        t: 'say',
        text: [
          'The limiter is in and covered:',
          '',
          '```ts',
          "router.post('/api/orders', auth, rateLimited(orders.create))",
          '```',
          '',
          '| Route | Budget | p95 | Blocked |',
          '|:------|:------:|----:|---------|',
          '| `POST /api/orders` | 120/min | 41 ms | 0 |',
          '| `GET /api/orders/:id` | none | 12 ms | 0 |',
          '| `GET /health` | none | 2 ms | 0 |',
          '',
          'A refused request gets **429** with a `Retry-After` header, keyed by API key and falling back to the client IP.',
        ].join('\n'),
      },
    ],
  },
  {
    prompt: 'Should the limiter be per route or global? Ask me before changing anything.',
    steps: [
      { t: 'think', text: 'A design question — present the options and let them choose, then act on it.' },
      {
        t: 'ask',
        kind: 'question',
        title: 'Where should the request budget apply?',
        detail: 'Per route keeps a burst on one endpoint from starving the others; global is simpler to reason about.',
        options: [
          { id: 'route', label: 'Per route (recommended)', hint: 'One window per key and route' },
          { id: 'global', label: 'Global', hint: 'One window per key for the whole API' },
        ],
        branches: {
          route: [
            { t: 'edit', path: 'src/middleware/rate-limit.ts', change: 'edit', added: 2, removed: 2, diff: "@@ -9,4 +9,4 @@\n-export function rateLimit(key: string, now = Date.now()): boolean {\n-  const bucket = buckets.get(key)\n+export function rateLimit(key: string, route: string, now = Date.now()): boolean {\n+  const bucket = buckets.get(`${route}:${key}`)" },
            { t: 'say', text: 'Done — buckets are now keyed by **route + API key**, so a burst of `POST /api/orders` no longer eats into the budget of `GET /api/orders/:id`. Tests still pass.' },
          ],
          global: [{ t: 'say', text: 'Kept it global: one window per API key. Nothing to change.' }],
        },
      },
    ],
    answers: { 'Where should the request budget apply?': 'route' },
  },
]

export const SEED_CSV: SeedTurn[] = [
  {
    prompt: 'The CSV importer runs out of memory on the 2 GB export. Make it stream instead of reading the whole file.',
    steps: [
      { t: 'think', text: '`importOrders` reads the file with readFile and splits it — the whole 2 GB is in memory twice. A line reader over a stream, flushed in batches, keeps memory flat.' },
      { t: 'read', path: 'src/importers/csv-importer.ts', output: "export async function importOrders(path: string): Promise<number> {\n  const text = await readFile(path, 'utf8')\n  const rows = text.split('\\n').slice(1).map(parseRow)\n  await db.insertMany('orders', rows)\n  return rows.length\n}" },
      { t: 'run', command: 'ls -lh fixtures/', output: 'total 2.1G\n-rw-r--r--  1 you  staff   2.0G  orders-2026.csv\n-rw-r--r--  1 you  staff   1.2K  orders-small.csv', ms: 80, exit: 0 },
      { t: 'edit', path: 'src/importers/csv-importer.ts', change: 'edit', added: 15, removed: 5, diff: CSV_PATCH },
      { t: 'run', command: '/usr/bin/time -l bun scripts/import.ts fixtures/orders-2026.csv', output: 'imported 18,204,331 orders in 74.2s\n    214 MB  maximum resident set size', ms: 3_400, exit: 0 },
      { t: 'run', command: 'bun test tests/csv-importer.test.ts', output: ' 14 pass\n 0 fail\nRan 14 tests across 1 file. [233.00ms]', ms: 600, exit: 0 },
      {
        t: 'say',
        text: [
          'The importer now streams. On the 2 GB export:',
          '',
          '| | Before | After |',
          '|---|---:|---:|',
          '| Peak memory | OOM at ~7.8 GB | **214 MB** |',
          '| Time | — | 74 s |',
          '| Rows | — | 18,204,331 |',
          '',
          'Rows are inserted in batches of 500 inside one transaction per batch, so a crash leaves at most one partial batch to retry.',
        ].join('\n'),
      },
    ],
  },
]

export const SEED_EXPLAIN: SeedTurn[] = [
  { prompt: 'Explain how the auth middleware decides a token is valid.', steps: explainScript() },
]

export const SEED_FLAKY: SeedTurn[] = [
  { prompt: 'The order-expiry test fails about one run in five. Find out why and fix it.', steps: bugScript(), answers: { 'Run `bun run db:reset --env test`?': 'allow' } },
]

export const SEED_RUNBOOK: SeedTurn[] = [
  {
    prompt: 'Write a deploy runbook for acme-api in docs/runbook.md: checks before shipping, the deploy commands, rollback, and which alerts mean page someone.',
    steps: [
      { t: 'read', path: '.github/workflows/ci.yml', output: 'jobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: oven-sh/setup-bun@v2\n      - run: bun install --frozen-lockfile\n      - run: bun test' },
      { t: 'search', pattern: 'rollout', output: 'infra/k8s/api.yaml:14:  strategy: { type: RollingUpdate }' },
      { t: 'edit', path: 'docs/runbook.md', change: 'create', added: 28, removed: 0, diff: RUNBOOK_PATCH },
      { t: 'say', text: 'Wrote `docs/runbook.md`: pre-flight checks, the three deploy commands, a one-line rollback, and an alert table with the thresholds from the current Grafana dashboard. It links to nothing internal, so it is safe to keep in the repo.' },
    ],
  },
]

export const SEED_THEME: SeedTurn[] = [
  {
    prompt: 'Add a dark mode toggle to the dashboard header that remembers the choice.',
    steps: [
      { t: 'read', path: 'src/components/Dashboard.tsx', output: "export function Dashboard() {\n  return (\n    <header className=\"top\">\n      <h1>Orders</h1>\n    </header>\n  )\n}" },
      { t: 'edit', path: 'src/components/ThemeToggle.tsx', change: 'create', added: 19, removed: 0, diff: THEME_PATCH },
      { t: 'run', command: 'bun run build', output: 'vite v6.3.5 building for production...\n✓ 214 modules transformed.\ndist/index.html   0.46 kB\ndist/assets/index-Cf3k2.js  148.12 kB │ gzip: 47.90 kB\n✓ built in 1.38s', ms: 1_500, exit: 0 },
      { t: 'say', text: 'Added `ThemeToggle` to the dashboard header. It starts from the system preference, remembers an explicit choice in `localStorage`, and sets `data-theme` on `<html>` so the existing CSS variables switch in one place.' },
    ],
  },
]
