#!/usr/bin/env bun
/**
 * The limits bar, checked against the seven states it must never confuse.
 *
 * The bar answers one question — is anything about to run out? — and the whole
 * point of the redesign is that the answers are not interchangeable: a spent
 * quota, a reading still on its way and a harness with nothing to report used to
 * render as three shades of the same grey run of words. So this is a test of the
 * classification *and* of the rendering: the state is asserted on the pure
 * function, and the markup is asserted on a real render, because "exhausted
 * jumps out" is a claim about pixels and not about a string.
 *
 * No fixture here touches the machine's own subscriptions: every snapshot is
 * built by hand, so the result is the same on a laptop with three CLIs logged in
 * and on a clean checkout with none.
 *
 *   bun scripts/limits-test.ts
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { LimitSnapshot } from '@shared'
import { LimitsGroup, readLimit, readLimits } from '../apps/ui/src/components/Limits.tsx'

const failures: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail === undefined || ok ? '' : ` — ${JSON.stringify(detail)}`}`)
  if (!ok) failures.push(label)
}

const NOW = Date.now()

function snapshot(patch: Partial<LimitSnapshot> & Pick<LimitSnapshot, 'harness'>): LimitSnapshot {
  return {
    plan: null,
    windows: [],
    credits: null,
    updatedAt: NOW,
    error: null,
    ...patch,
  }
}

/* ---------------- the seven states ---------------- */

/** Reported, with room left. */
const HEALTHY = snapshot({
  harness: 'claude',
  windows: [
    { usedPercent: 4, windowMinutes: 300, resetsAt: NOW + 3 * 3600_000, label: '5h' },
    { usedPercent: 63, windowMinutes: 10_080, resetsAt: NOW + 4 * 86_400_000, label: '7d' },
  ],
})

/** Reported, and close enough to the ceiling to plan around. */
const TIGHT = snapshot({
  harness: 'commandcode',
  plan: 'Individual Goat',
  windows: [
    { usedPercent: 12, windowMinutes: 300, resetsAt: NOW + 3600_000, label: '5h' },
    { usedPercent: 91, windowMinutes: 10_080, resetsAt: NOW + 2 * 86_400_000, label: '7d' },
  ],
  credits: { hasCredits: true, unlimited: false, balance: '$51.16' },
})

/** Reported, and spent — the real shape codex publishes when credits run out. */
const EXHAUSTED = snapshot({
  harness: 'codex',
  credits: { hasCredits: false, unlimited: false, balance: null },
  error: 'workspace credits exhausted',
})

/** Reported, and spent by the window itself rather than by a code. */
const FULL_WINDOW = snapshot({
  harness: 'codex',
  windows: [{ usedPercent: 100, windowMinutes: 300, resetsAt: NOW + 1800_000, label: '5h' }],
})

/** Known harness, no reading yet. An unknown, not a zero. */
const WAITING = snapshot({ harness: 'gemini' })

/** We asked and could not find out. */
const UNREADABLE = snapshot({ harness: 'claude', error: 'usage endpoint rate limited (429)' })

/** Nothing to read and nothing to report. */
const SILENT = snapshot({ harness: 'grok', note: 'No Usage API' })

/** No quota exists: it bills your own provider keys. */
const METERED = snapshot({
  harness: 'opencode',
  plan: 'Pay-per-use',
  credits: { hasCredits: true, unlimited: false, balance: '$2.69' },
})

console.log('--- classification ---')
check('reported and healthy reads as healthy', readLimit(HEALTHY).state === 'healthy', readLimit(HEALTHY).state)
check('reported and nearly exhausted reads as tight', readLimit(TIGHT).state === 'tight', readLimit(TIGHT).state)
check(
  'spent credits read as exhausted, not as a failed reading',
  readLimit(EXHAUSTED).state === 'exhausted',
  readLimit(EXHAUSTED).state,
)
check('a full window reads as exhausted', readLimit(FULL_WINDOW).state === 'exhausted', readLimit(FULL_WINDOW).state)
check('no reading yet reads as waiting', readLimit(WAITING).state === 'waiting', readLimit(WAITING).state)
check('a failed reading reads as unreadable', readLimit(UNREADABLE).state === 'unreadable', readLimit(UNREADABLE).state)
check('nothing to report reads as silent', readLimit(SILENT).state === 'silent', readLimit(SILENT).state)
check('billed to your own keys reads as metered', readLimit(METERED).state === 'metered', readLimit(METERED).state)

// The two that must never be the same word. "Out of credits" is a quota that was
// spent; "no quota" is a harness that never had one. The old bar printed the
// first as `No Credits` and the second as `—`, which is how they got confused.
check(
  'a spent quota and a harness with no quota do not share a state',
  readLimit(EXHAUSTED).state !== readLimit(METERED).state,
)
check(
  'a spent quota says so in words a person reads',
  readLimit(EXHAUSTED).tag === 'Out Of Credits',
  readLimit(EXHAUSTED).tag,
)
check(
  'a reading we are still waiting for is not an absence',
  readLimit(WAITING).inBar && !readLimit(SILENT).inBar,
  { waiting: readLimit(WAITING).inBar, silent: readLimit(SILENT).inBar },
)

/* ---------------- what earns a place in the bar ---------------- */

const ALL = [HEALTHY, METERED, EXHAUSTED, SILENT, TIGHT, WAITING]
const ordered = readLimits(ALL)
const inBar = ordered.filter((reading) => reading.inBar).map((reading) => reading.harness)

console.log('\n--- the bar ---')
console.log(`  order: ${ordered.map((r) => `${r.harness}:${r.state}`).join(' ')}`)
check('a harness with nothing to report is absent from the bar', !inBar.includes('grok'), inBar)
check('a harness that bills your own keys is absent from the bar', !inBar.includes('opencode'), inBar)
check('the worst comes first, so the left edge is the thing to worry about', ordered[0]?.state === 'exhausted', ordered[0]?.state)
check('a tight quota outranks a healthy one', ordered[1]?.state === 'tight', ordered[1]?.state)
check(
  'every harness stays in the panel, including the ones the bar drops',
  ordered.length === ALL.length,
  { got: ordered.length, want: ALL.length },
)

/* ---------------- what is actually drawn ---------------- */

const markup = renderToStaticMarkup(createElement(LimitsGroup, { limits: ALL }))
/**
 * What is on screen, not what is in the markup: a tooltip is an attribute, and
 * asserting on the raw HTML let a chip pass for saying something it only said on
 * hover.
 */
const visible = (html: string): string => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
const barText = visible(markup)
console.log('\n--- rendered bar ---')
console.log(`  ${barText}`)

// Counted against the list this fixture should produce, not against the same
// function the bar used — otherwise the check agrees with any answer at all.
check('the bar draws exactly the three harnesses with actual quota readings', (markup.match(/limit-chip/g) ?? []).length === 3, {
  chips: (markup.match(/limit-chip/g) ?? []).length,
  kept: inBar,
})
check('the exhausted harness is drawn as exhausted', markup.includes('limit-chip exhausted'))
check('the healthy harness is not drawn as exhausted', markup.includes('limit-chip healthy'))
check('the exhausted chip carries its words, not a bare dash', barText.includes('Out Of Credits'), barText)
check('a harness with nothing to report draws nothing in the bar', !barText.includes('Grok'), barText)
check('a pay-per-use harness draws nothing in the bar', !barText.includes('Opencode'), barText)
check('the number says which window it is of', barText.includes('63% 7d'), barText)

/* ---------------- exhausted is visually distinct ---------------- */

// A different class name is not a different look. The stylesheet has to give the
// exhausted chip its own colour, or the redesign is a rename.
const css = readFileSync(join(import.meta.dir, '..', 'apps/ui/src/limits.css'), 'utf8')
function ruleFor(selector: string): string {
  const at = css.indexOf(`${selector} {`)
  return at < 0 ? '' : css.slice(at, css.indexOf('}', at))
}
const exhaustedRule = ruleFor('.limit-chip.exhausted')
const baseRule = ruleFor('.limit-chip')

console.log('\n--- the look ---')
check('the exhausted chip has a rule of its own', exhaustedRule.length > 0)
check('exhausted is coloured with the error token, not the default ink', exhaustedRule.includes('var(--err)'), exhaustedRule)
check('the default chip is not coloured with the error token', !baseRule.includes('var(--err)'), baseRule)
check('exhausted is filled, not just re-inked', exhaustedRule.includes('background:'), exhaustedRule)
check('exhausted is weighted more than its neighbours', exhaustedRule.includes('font-weight'), exhaustedRule)
// The boundary the user could not see: every chip is a bounded box, so one
// harness can never run into the next as a single stream of words.
check('each harness is a bounded box', baseRule.includes('border:') && baseRule.includes('border-radius:'), baseRule)
check(
  'waiting is drawn as provisional rather than as a value',
  ruleFor('.limit-chip.waiting').includes('dashed'),
  ruleFor('.limit-chip.waiting'),
)

/* ---------------- an unknown is never dressed as a number ---------------- */

console.log('\n--- honesty ---')
const waitingText = visible(renderToStaticMarkup(createElement(LimitsGroup, { limits: [WAITING] })))
check('a harness with no reading yet is hidden until it has data', waitingText === '', waitingText)
check('a harness with no reading yet is not drawn as 0%', !waitingText.includes('0%'), waitingText)
check('a harness with no reading yet is not drawn as an em dash', !waitingText.includes('—'), waitingText)
check('a failed reading names the failure rather than a number', readLimit(UNREADABLE).tag === 'Read Throttled', readLimit(UNREADABLE).tag)

// A bar with nothing worth showing still has to say that, or the label stands
// alone and reads as a broken widget.
const quietMarkup = renderToStaticMarkup(createElement(LimitsGroup, { limits: [SILENT, METERED] }))
check('a bar with no quotas at all says so', visible(quietMarkup).includes('No Quotas To Track'), visible(quietMarkup))
check(
  'a provider with no subscription or usage does not leave an empty Limits control',
  renderToStaticMarkup(createElement(LimitsGroup, { limits: [SILENT, WAITING] })) === '',
)
// A reader switched off in Settings: an unknown by choice, said in the bar.
const OFF = snapshot({ harness: 'claude', off: true })
check('a reader that is off reads as off', readLimit(OFF).state === 'off', readLimit(OFF))
const offText = visible(renderToStaticMarkup(createElement(LimitsGroup, { limits: [OFF] })))
check('an off reader says Off in the bar', offText.includes('Off'), offText)
check('an off reader is never drawn as 0%', !offText.includes('%'), offText)
check('and its explanation points at Settings', readLimit(OFF).detail.includes('Settings') && readLimit(OFF).detail.includes('not a number of zero'))
check('an off reader is drawn as provisional', ruleFor('.limit-chip.off').includes('dashed'), ruleFor('.limit-chip.off'))
const preferencesMarkup = visible(renderToStaticMarkup(createElement(LimitsGroup, {
  limits: ALL,
  enabledHarnesses: ['claude', 'commandcode', 'opencode'],
})))
check('harnesses hidden in preferences stay out of Limits', !preferencesMarkup.includes('Codex'), preferencesMarkup)
check('enabled harness readings remain in Limits', preferencesMarkup.includes('Claude'), preferencesMarkup)

console.log('\n--- claude reading ---')
// A throttled poll keeps the last good numbers: the card still has bars.
const STALE = { ...HEALTHY, updatedAt: NOW - 40 * 60_000, error: 'usage endpoint returned 429 · last reading 40m ago' }
check('a throttled reading with last good numbers still shows them', readLimit(STALE).state === 'healthy', readLimit(STALE).state)
// Importing the reader opens the server database: point it at a scratch home.
process.env.SEDANO_HOME = join(tmpdir(), `sedano-limits-${process.pid}`)
const { normalizeWindows } = await import('../apps/server/src/usage/claude.ts')
const low = normalizeWindows({
  five_hour: { utilization: 0.0, resets_at: '2026-09-23T13:10:00+00:00' },
  seven_day: { utilization: 1.0, resets_at: '2026-09-23T16:59:59+00:00' },
  nimbus_quill: { utilization: 0.0, resets_at: null },
  limits: [{ kind: 'session', percent: 0 }],
})
check('utilization is a percentage: 1.0 is 1%, not 100%', low.map((w) => `${w.label}:${w.usedPercent}`).join(',') === '5h:0,7d:1', low)

if (failures.length) {
  console.log(`\nlimits-test: ${failures.length} FAILURES`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('\nlimits-test: PASSED')
process.exit(0)
