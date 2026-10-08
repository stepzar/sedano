#!/usr/bin/env bun
/**
 * The limits panel, in a real browser: the two things that are about geometry.
 *
 * `limits-test.ts` proves what the readout *says*. Nothing it can assert covers
 * what the user actually reported — that the panel "changes" while you look at
 * it — because a box moving under the pointer is a fact about layout, and layout
 * does not exist in a static render. So this check lays the component out in a
 * real engine, at a real viewport, and measures it twice.
 *
 * The two defects it pins down:
 *
 *   - the panel resized and reflowed between polls. Readings arrive per harness
 *     and the set of harnesses in a push is not even constant, so a row the user
 *     was reading slid by 150px mid-glance, and the panel — measured once when
 *     it opened — clipped the rows that arrived afterwards;
 *   - the caret sat after the word `Limits`, planting a divider in the middle of
 *     a strip that is a single control.
 *
 * It builds its own page rather than driving the app: nothing here may depend on
 * which CLIs this machine has logged in, and the whole point is to deliver an
 * update at a moment of our choosing, with the panel open. The stylesheets are
 * the real ones, read off disk — a geometry check against invented CSS would
 * prove nothing about the panel that ships.
 *
 *   bun scripts/limits-ui-test.ts
 */
import { chromium } from 'playwright'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LimitSnapshot } from '@shared'

const ROOT = join(import.meta.dir, '..')
const UI = join(ROOT, 'apps', 'ui', 'src')

const failures: string[] = []
const passed: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail === undefined || ok ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (ok) passed.push(label)
  else failures.push(label)
}

/* ---------------- the page under test ---------------- */

// Inside the repository's `node_modules`, not the system temp dir: the entry
// imports React, and module resolution only walks *up* from the importing file.
const cache = join(ROOT, 'node_modules', '.cache')
mkdirSync(cache, { recursive: true })
const work = mkdtempSync(join(cache, 'limits-ui-'))

/**
 * The entry mounts `LimitsGroup` and nothing else, and hands the test a way to
 * push a new `limits` array into it. That push is the poll: it is the only thing
 * that happens between the two measurements, so anything that moves, moved
 * because of it.
 */
writeFileSync(
  join(work, 'entry.tsx'),
  `import { createRoot } from 'react-dom/client'
import { LimitsGroup } from ${JSON.stringify(join(UI, 'components', 'Limits.tsx'))}
const root = createRoot(document.getElementById('bar'))
window.__setLimits = (limits) => { root.render(<LimitsGroup limits={limits} />) }
`,
)

/**
 * CSS is injected as text instead of bundled, so the assertions run against the
 * exact bytes in the repository's stylesheets. The stub keeps the bundler from
 * having to resolve the `import '../limits.css'` inside the component itself.
 */
const cssStub = {
  name: 'css-as-empty-module',
  setup(build: { onLoad: (f: { filter: RegExp }, cb: () => { contents: string; loader: 'js' }) => void }) {
    build.onLoad({ filter: /\.css$/ }, () => ({ contents: '', loader: 'js' as const }))
  },
}

const built = await Bun.build({
  entrypoints: [join(work, 'entry.tsx')],
  target: 'browser',
  plugins: [cssStub as never],
})
if (!built.success) {
  console.error(built.logs)
  throw new Error('could not bundle the limits panel for the browser')
}
const bundle = await built.outputs[0]!.text()

const styles = readFileSync(join(UI, 'styles.css'), 'utf8')
const limitsCss = readFileSync(join(UI, 'limits.css'), 'utf8')

/**
 * The shell is the app's, reduced to what the panel's placement depends on: a
 * column the height of the window with the status bar pinned to its floor, which
 * is what makes the popover open *upwards* — the case the placement code has to
 * get right and the case the user is looking at.
 */
const html = `<!doctype html><html data-theme="light"><head><meta charset="utf-8">
<style>${styles}</style>
<style>${limitsCss}</style>
<style>
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; }
  #fill { flex: 1; }
  #bar { flex: none; }
</style>
</head><body><div id="fill"></div><div id="bar" class="statusbar"></div>
<script type="module" src="/entry.js"></script></body></html>`

// The bundle is served as its own file rather than inlined: a module script
// ends at the first `</script>` in its text, and a bundle of React contains
// strings that look exactly like one.
const server = Bun.serve({
  port: 0,
  fetch: (request) =>
    new URL(request.url).pathname === '/entry.js'
      ? new Response(bundle, { headers: { 'content-type': 'text/javascript' } })
      : new Response(html, { headers: { 'content-type': 'text/html' } }),
})

/* ---------------- fixtures ---------------- */

const NOW = Date.now()
function snapshot(patch: Partial<LimitSnapshot> & Pick<LimitSnapshot, 'harness'>): LimitSnapshot {
  return { plan: null, windows: [], credits: null, updatedAt: NOW, error: null, ...patch }
}

const CLAUDE = snapshot({
  harness: 'claude',
  windows: [
    { usedPercent: 4, windowMinutes: 300, resetsAt: NOW + 3 * 3600_000, label: '5h' },
    { usedPercent: 74, windowMinutes: 10_080, resetsAt: NOW + 86_400_000, label: '7d' },
  ],
})
const CMD = snapshot({
  harness: 'commandcode',
  plan: 'Individual Goat',
  windows: [{ usedPercent: 54, windowMinutes: 10_080, resetsAt: NOW + 5 * 86_400_000, label: '7d' }],
  credits: { hasCredits: true, unlimited: false, balance: '$51.16' },
})
/** Known harness, reading still on its way. */
const CODEX_WAITING = snapshot({ harness: 'codex' })
/** The same harness once it answers — with *one* window, not the two reserved. */
const CODEX_ARRIVED = snapshot({
  harness: 'codex',
  windows: [{ usedPercent: 31, windowMinutes: 300, resetsAt: NOW + 1800_000, label: '5h' }],
})
const CODEX_UPDATED = snapshot({
  harness: 'codex',
  windows: [{ usedPercent: 34, windowMinutes: 300, resetsAt: NOW + 1700_000, label: '5h' }],
})
const GEMINI_WAITING = snapshot({ harness: 'gemini' })
/**
 * The reading lands close to its ceiling on purpose. The panel's order has to be
 * fixed rather than sorted by severity, and only a reading that *changes* the
 * severity order can tell the two apart: this one would jump to the front of a
 * severity sort, dragging every row after it.
 */
const GEMINI_ARRIVED = snapshot({
  harness: 'gemini',
  windows: [
    { usedPercent: 12, windowMinutes: 300, resetsAt: NOW + 3600_000, label: '5h' },
    { usedPercent: 91, windowMinutes: 10_080, resetsAt: NOW + 2 * 86_400_000, label: '7d' },
  ],
})
const GEMINI_UPDATED = snapshot({
  harness: 'gemini',
  windows: [
    { usedPercent: 14, windowMinutes: 300, resetsAt: NOW + 3500_000, label: '5h' },
    { usedPercent: 92, windowMinutes: 10_080, resetsAt: NOW + 2 * 86_400_000, label: '7d' },
  ],
})
/** Nothing to read and nothing to report: present in some pushes, not in others. */
const GROK_NOTE = snapshot({ harness: 'grok', note: 'No Usage API' })
const OPENCODE = snapshot({
  harness: 'opencode',
  plan: 'Pay-per-use',
  credits: { hasCredits: true, unlimited: false, balance: '$2.69' },
})

const FIRST = [CLAUDE, CMD, CODEX_ARRIVED, GEMINI_ARRIVED, GROK_NOTE, OPENCODE]

/* ---------------- driving ---------------- */

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(server.url.href)
page.on('pageerror', (error) => console.log(`  page error: ${error.message}`))
// Nothing is on screen until the first push: the bar is the component's answer
// to a `limits` array, and an empty one draws nothing at all.
await page.waitForFunction(() => typeof (window as never as { __setLimits?: unknown }).__setLimits === 'function')

async function setLimits(limits: LimitSnapshot[]): Promise<void> {
  await page.evaluate((next) => (window as never as { __setLimits: (l: unknown) => void }).__setLimits(next), limits)
  // One frame, so React has committed and the browser has laid it out again.
  await settle()
}

/**
 * Waits until the panel is standing still.
 *
 * `.menu-pop` opens with a 120ms `pop` keyframe that scales it to 0.995 and
 * slides it 5px, so a box measured too early is a box measured mid-animation —
 * about 4px of it. Only the popover's own animations are awaited: the pending
 * meters pulse forever, and waiting on those would never return.
 */
async function settle(): Promise<void> {
  await page.evaluate(async () => {
    const pop = document.querySelector('.menu-pop')
    if (pop) await Promise.all(pop.getAnimations().map((a) => a.finished.catch(() => undefined)))
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
  })
}

/** Everything a measurement of "did the panel move?" needs, in one read. */
async function measure() {
  return page.evaluate(() => {
    const pop = document.querySelector('.menu-pop')
    if (!pop) return null
    const box = pop.getBoundingClientRect()
    const titles = [...pop.querySelectorAll('.menu-title')] as HTMLElement[]
    return {
      box: { top: box.top, left: box.left, width: box.width, height: box.height, bottom: box.bottom },
      sections: titles.map((t) => t.textContent ?? ''),
      rowTops: Object.fromEntries(titles.map((t) => [t.textContent ?? '', t.getBoundingClientRect().top])),
      scrollHeight: pop.scrollHeight,
      clientHeight: pop.clientHeight,
      overflowY: getComputedStyle(pop).overflowY,
      viewport: window.innerHeight,
      /** The last thing in the panel — if this is reachable, nothing is lost. */
      lastText: (pop.lastElementChild as HTMLElement | null)?.textContent ?? '',
    }
  })
}

/**
 * How much movement counts as none.
 *
 * Not zero, and the reason is worth writing down rather than rounding away.
 * Layout here is fractional — a section measures 127.546875px — while the floor
 * that holds a section open is `offsetHeight`, which the engine only reports in
 * whole pixels. A floor can therefore sit up to half a pixel under the section
 * it holds, and the panel settles a fraction of a pixel from where it was. One
 * pixel is the honest boundary: below it nothing is on screen to see, and the
 * defect being tested for moved rows by seventy and a hundred and fifty.
 */
const STILL = 1

function sameBox(a: { top: number; left: number; width: number; height: number }, b: typeof a): boolean {
  return (
    Math.abs(a.top - b.top) < STILL &&
    Math.abs(a.left - b.left) < STILL &&
    Math.abs(a.width - b.width) < STILL &&
    Math.abs(a.height - b.height) < STILL
  )
}

await setLimits(FIRST)
await page.waitForSelector('.limits-bar')
await page.click('.limits-bar')
await page.waitForSelector('.menu-pop')
await settle()

/* ---------------- 1. the panel does not move while you read it ---------------- */

console.log('\n--- geometry across an update ---')

const before = (await measure())!
// Real readings update in place. A provider with spend may be absent from one
// partial push; the panel keeps the last real reading while it is open.
await setLimits([CLAUDE, CMD, CODEX_UPDATED, GEMINI_UPDATED])
const after = (await measure())!

check('the panel keeps its box when a reading arrives', sameBox(before.box, after.box), {
  before: before.box,
  after: after.box,
})
check(
  'a row already on screen does not move when a reading arrives',
  Math.abs(before.rowTops['Claude Code']! - after.rowTops['Claude Code']!) < STILL,
  { before: before.rowTops['Claude Code'], after: after.rowTops['Claude Code'] },
)
check(
  'the rows keep their order when a reading arrives',
  before.sections.join('|') === after.sections.join('|'),
  { before: before.sections, after: after.sections },
)
check('providers with no subscription or usage never get a panel section', !after.sections.includes('Grok'), after.sections)
check('a used provider left out of a partial push keeps its row', after.sections.includes('Opencode'), after.sections)
check(
  'updated readings do not move the following section',
  Math.abs(before.rowTops['Gemini CLI']! - after.rowTops['Gemini CLI']!) < STILL,
  { before: before.rowTops['Gemini CLI'], after: after.rowTops['Gemini CLI'] },
)
// The space held open is space and nothing else: a placeholder carrying a label,
// a percentage or a reset time would be a number nobody reported.
const pendingText = await page.evaluate(() =>
  [...document.querySelectorAll('.menu-pop .menu-meter.pending')].map((r) => (r.textContent ?? '').trim()).join(''),
)
check('the room held for a reading shows no invented value', pendingText.replace(/​/g, '') === '', pendingText)

/* ---------------- 2. the panel is never clipped ---------------- */

console.log('\n--- clipping ---')

/** Nothing the panel holds may be both off-screen and unreachable. */
function reachable(m: NonNullable<Awaited<ReturnType<typeof measure>>>): boolean {
  const insideViewport = m.box.top >= -0.5 && m.box.bottom <= m.viewport + 0.5
  const fitsOrScrolls = m.scrollHeight <= m.clientHeight + 0.5 || m.overflowY === 'auto' || m.overflowY === 'scroll'
  return insideViewport && fitsOrScrolls
}

const normal = (await measure())!
check('at a normal viewport the panel is inside the window', normal.box.top >= -0.5 && normal.box.bottom <= normal.viewport + 0.5, normal.box)
check('at a normal viewport nothing is cut off', reachable(normal), {
  scrollHeight: normal.scrollHeight,
  clientHeight: normal.clientHeight,
  overflowY: normal.overflowY,
})
check('the panel ends with the control it is supposed to end with', normal.lastText.includes('Refresh now'), normal.lastText)

await page.setViewportSize({ width: 1440, height: 420 })
await settle()
const short = (await measure())!
check('at a short viewport the panel is inside the window', short.box.top >= -0.5 && short.box.bottom <= short.viewport + 0.5, {
  box: short.box,
  viewport: short.viewport,
})
check('at a short viewport the panel scrolls rather than clipping', reachable(short) && short.scrollHeight > short.clientHeight, {
  scrollHeight: short.scrollHeight,
  clientHeight: short.clientHeight,
  overflowY: short.overflowY,
})
// Scrolled with the wheel, not by setting `scrollTop`. A script can scroll a
// box whose overflow is `hidden`, so the cheap version of this check passes on a
// panel nobody can actually move — which is the very state it exists to catch.
const popBox = (await page.locator('.menu-pop').boundingBox())!
await page.mouse.move(popBox.x + popBox.width / 2, popBox.y + popBox.height / 2)
await page.mouse.wheel(0, 2000)
await settle()
const bottomReached = await page.evaluate(() => {
  const pop = document.querySelector('.menu-pop')!
  const last = pop.lastElementChild!.getBoundingClientRect()
  const box = pop.getBoundingClientRect()
  return last.bottom <= box.bottom + 1 && last.top >= box.top - 1
})
check('at a short viewport the last row can be scrolled to', bottomReached)

// A window too short for either side still may not put the panel off-screen.
await page.setViewportSize({ width: 1440, height: 240 })
await settle()
const tiny = (await measure())!
check('at a window too short for either side the panel is still inside it', reachable(tiny), {
  box: tiny.box,
  viewport: tiny.viewport,
})

await page.setViewportSize({ width: 1440, height: 900 })
await settle()

/* ---------------- 3. the caret ---------------- */

console.log('\n--- the caret ---')

const caret = await page.evaluate(() => {
  const bar = document.querySelector('.limits-bar')!
  const trigger = bar.closest('button')
  const mark = bar.querySelector('.limits-caret')
  const label = bar.querySelector('.limits-title')
  const chips = [...bar.querySelectorAll('.limit-chip')] as HTMLElement[]
  if (!mark || !label) return null
  // The word on its own, without the caret: both live inside `.limits-title`,
  // so the label's box would include the caret and prove nothing about order.
  const word = [...label.childNodes].find((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim())
  const range = document.createRange()
  if (word) range.selectNodeContents(word)
  return {
    /** The first of the bar's own parts, whichever of them comes first. */
    firstPart: (bar.querySelector('.limits-caret, .limit-chip, .limits-title') as HTMLElement | null)?.className ?? '',
    // Document order, not `firstElementChild`: the word `Limits` is a text node,
    // so a caret moved to sit *after* it is still the first *element* of its
    // span — the exact arrangement being tested against.
    caretIsFirst: [word, ...chips]
      .filter((n): n is ChildNode => !!n)
      .every((n) => !!(mark.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)),
    caretLeft: mark.getBoundingClientRect().left,
    wordLeft: word ? range.getBoundingClientRect().left : Number.NEGATIVE_INFINITY,
    chipLefts: chips.map((c) => c.getBoundingClientRect().left),
    /** One control: the caret's nearest button is the trigger, and the only one. */
    oneButton: !!trigger && mark.closest('button') === trigger && trigger.querySelectorAll('button').length === 0,
  }
})
check('the caret is the first thing in the trigger', !!caret?.caretIsFirst, caret?.firstPart)
check('the caret sits to the left of the word it labels', !!caret && caret.caretLeft < caret.wordLeft, caret)
check(
  'the caret sits to the left of every harness chip, so it divides nothing',
  !!caret && caret.chipLefts.every((left) => caret.caretLeft < left),
  caret,
)
check('the caret is not a control of its own', !!caret?.oneButton)

const state = async () =>
  page.evaluate(() => {
    const mark = document.querySelector('.limits-caret')
    return {
      open: !!document.querySelector('.menu-pop'),
      expanded: document.querySelector('.limits-bar')?.closest('button')?.getAttribute('aria-expanded') ?? null,
      rotated: mark ? getComputedStyle(mark).transform : 'none',
    }
  })

/**
 * Waits for the panel to reach a state, and reports rather than throws when it
 * does not. A control that stops working is an assertion going red — a check
 * that dies of a timeout says only that something broke, somewhere.
 */
async function settleOpen(want: boolean): Promise<void> {
  try {
    await page.waitForSelector('.menu-pop', { state: want ? 'attached' : 'detached', timeout: 3000 })
  } catch {
    /* the assertion that follows is the one that should say so */
  }
  await settle()
}

// Close it first, then drive the whole cycle from the caret alone.
await page.keyboard.press('Escape')
await settleOpen(false)
const shut = await state()
await page.click('.limits-caret', { force: true }).catch(() => undefined)
await settleOpen(true)
const opened = await state()
await page.click('.limits-caret', { force: true }).catch(() => undefined)
await settleOpen(false)
const closed = await state()

check('clicking the caret opens the panel', opened.open && !shut.open)
check('clicking the caret again closes it', !closed.open)
check('the trigger says whether it is open', shut.expanded === 'false' && opened.expanded === 'true', {
  shut: shut.expanded,
  opened: opened.expanded,
})
check('the caret turns over when the panel opens', shut.rotated !== opened.rotated, {
  shut: shut.rotated,
  opened: opened.rotated,
})

// Keyboard: the trigger is a real button, so it must be focusable and operable
// without a pointer, and Escape must give the focus back a way out.
const keyboard = await page.evaluate(async () => {
  const trigger = document.querySelector('.limits-bar')?.closest('button') as HTMLElement | null
  trigger?.focus()
  return { focused: !!trigger && document.activeElement === trigger, tabIndex: trigger?.tabIndex ?? -1 }
})
await page.keyboard.press('Enter')
await settleOpen(true)
const byKey = await state()
// Escape is only worth testing against a panel that is actually open, so the
// panel is opened by hand if the keyboard did not manage it. Without this the
// check passes on a panel that was already shut — which is how a broken Escape
// handler could read as a working one.
if (!byKey.open) {
  await page.click('.limits-bar', { force: true }).catch(() => undefined)
  await settleOpen(true)
}
const beforeEscape = await state()
await page.keyboard.press('Escape')
await settleOpen(false)
const byEscape = await state()

check('the trigger takes keyboard focus', keyboard.focused && keyboard.tabIndex >= 0, keyboard)
check('Enter opens the panel from the keyboard', byKey.open && byKey.expanded === 'true', byKey)
check('Escape closes it again', beforeEscape.open && !byEscape.open, { beforeEscape, byEscape })

/* ---------------- done ---------------- */

await browser.close()
server.stop(true)
rmSync(work, { recursive: true, force: true })

console.log(`\n${passed.length} passed`)
if (failures.length) {
  console.log(`limits-ui-test: ${failures.length} FAILURES`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('limits-ui-test: PASSED')
process.exit(0)
