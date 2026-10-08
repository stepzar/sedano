#!/usr/bin/env bun
/**
 * Appearance, measured: every control changes exactly its target, live.
 *
 * The report this check exists for: "conversation text" also resized the
 * interface and the other way round, and picking a typeface did nothing. Both
 * are about what is rendered, so both are proved on the rendered page. For each
 * control (theme, interface typeface, conversation typeface, interface size,
 * conversation size) it measures a fixed set of representative elements — the
 * transcript paragraph, a tool row, a turn header, tool output, a diff, the
 * composer field on one side; the sidebar, the top bar, a tab, the status bar
 * and the composer controls on the other — before and after clicking the
 * control in Settings, and asserts that only the intended ones moved:
 *
 *   - sizes: `font-size` on the intended side changes, nothing on the other;
 *   - typefaces: the family *and the drawn width of the text* change (a family
 *     name the machine does not have changes the computed value and nothing
 *     on screen), monospace surfaces never change;
 *   - theme: colours change, no size, face or text width does;
 *   - every typeface offered really draws differently from the default, and
 *     fonts this machine does not have are not offered at all.
 *
 * All without a reload, in Chrome and WebKit, on the desktop profile and on
 * the phone profile (which keeps its own appearance under
 * `sedano.settings.mobile` and must leave the desktop's alone).
 *
 * Hermetic: it builds its own store and server (see `lib/app.ts`).
 *
 *   bun scripts/appearance-ui-test.ts
 */
import { chromium, devices, webkit, type Browser, type Page } from 'playwright'
import { installExitHandlers, runCleanups } from './lib/harness.ts'
import { openRichestSession, resolveApp } from './lib/app.ts'

installExitHandlers()
const target = await resolveApp()

const failures: string[] = []
let passed = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) passed++
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  console.log(`${ok ? '✓' : '✗'} ${label}`)
}

type Side = 'conversation' | 'interface'
interface Probe {
  selector: string
  side: Side
  /** Monospace on purpose: a typeface choice must never reach it. */
  mono?: boolean
}

/** The representative elements, and which setting owns each. */
const PROBES: Record<string, Probe> = {
  prose: { selector: '.transcript .md-p', side: 'conversation' },
  toolRow: { selector: '.transcript .wr-label', side: 'conversation' },
  turnHeader: { selector: '.transcript .turn-title', side: 'conversation' },
  toolOutput: { selector: '.transcript .tool-body', side: 'conversation', mono: true },
  diff: { selector: '.diff', side: 'conversation', mono: true },
  composerField: { selector: '.composer-inner textarea', side: 'conversation' },
  sidebar: { selector: '.rail .title-text', side: 'interface' },
  topBar: { selector: '.brand, .bar .tab-current .label', side: 'interface' },
  tab: { selector: '.tabs .label', side: 'interface' },
  statusBar: { selector: '.statusbar', side: 'interface' },
  composerControls: { selector: '.composer .chip-select', side: 'interface' },
}

interface Sample {
  fontSize: string
  fontFamily: string
  lineHeight: string
  color: string
  background: string
  /** Summed width of the drawn text lines: what a font change actually does. */
  width: number
}
type Snapshot = Record<string, Sample | null>

async function measure(page: Page): Promise<Snapshot> {
  return page.evaluate((probes) => {
    const out: Record<string, unknown> = {}
    const backgroundOf = (el: Element | null): string => {
      for (let node = el; node; node = node.parentElement) {
        const bg = getComputedStyle(node).backgroundColor
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg
      }
      return getComputedStyle(document.body).backgroundColor
    }
    for (const [name, probe] of Object.entries(probes)) {
      const el = document.querySelector<HTMLElement>(probe.selector)
      if (!el) {
        out[name] = null
        continue
      }
      const style = getComputedStyle(el)
      let width = 0
      if (el instanceof HTMLTextAreaElement) {
        // A field's text is not in the DOM: draw its placeholder with its own font.
        const context = document.createElement('canvas').getContext('2d')!
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
        width = context.measureText(el.value || el.placeholder || 'Ask for a change').width
      } else {
        const range = document.createRange()
        range.selectNodeContents(el)
        for (const rect of range.getClientRects()) width += rect.width
      }
      out[name] = {
        fontSize: style.fontSize,
        fontFamily: style.fontFamily,
        lineHeight: style.lineHeight,
        color: style.color,
        background: backgroundOf(el),
        width: Math.round(width * 100) / 100,
      }
    }
    return out as Snapshot
  }, PROBES)
}

type Field = keyof Sample
function changed(before: Snapshot, after: Snapshot, field: Field): string[] {
  return Object.keys(PROBES).filter((name) => before[name] && after[name] && before[name]![field] !== after[name]![field])
}
function present(snapshot: Snapshot, names: string[]): string[] {
  return names.filter((name) => snapshot[name])
}
const on = (side: Side, filter: (probe: Probe) => boolean = () => true) =>
  Object.entries(PROBES)
    .filter(([, probe]) => probe.side === side && filter(probe))
    .map(([name]) => name)
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x))

/* ------------------------------------------------------------------ */
/* Driving Settings                                                    */
/* ------------------------------------------------------------------ */

async function openAppearance(page: Page, phone: boolean): Promise<void> {
  if (phone) {
    await page.locator('.bar .settings-btn').click()
    await page.locator('.settings-nav-item', { hasText: 'Appearance' }).click()
  } else {
    await page.locator('button[title^="Settings"]').first().click()
    await page.locator('.settings-nav-item', { hasText: 'Appearance' }).click()
  }
  await page.waitForSelector('.settings-row')
}

const row = (page: Page, label: string) =>
  page.locator('.settings-row', { has: page.locator('.settings-label', { hasText: label }) })

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  await page.waitForTimeout(60)
}

async function step(page: Page, label: string, direction: 'Bigger' | 'Smaller', times: number): Promise<void> {
  for (let i = 0; i < times; i++) await row(page, label).locator(`button[title^="${direction}"]`).click()
  await settle(page)
}

async function optionsOf(page: Page, label: string): Promise<string[]> {
  await row(page, label).locator('.select-trigger').first().click()
  const names = await page.locator('.menu-pop .menu-item-name').allTextContents()
  await row(page, label).locator('.select-trigger').first().click()
  return names
}

async function choose(page: Page, label: string, option: string): Promise<void> {
  await row(page, label).locator('.select-trigger').first().click()
  await page.locator('.menu-pop .menu-item', { has: page.locator('.menu-item-name', { hasText: new RegExp(`^${option}$`) }) }).click()
  await settle(page)
}

/* ------------------------------------------------------------------ */
/* One run: a browser × a profile                                      */
/* ------------------------------------------------------------------ */

async function run(browser: Browser, engine: string, phone: boolean): Promise<void> {
  const tag = `${engine}/${phone ? 'phone' : 'desktop'}`
  const context = await browser.newContext(
    phone
      ? { ...devices['iPhone 15'], viewport: { width: 393, height: 852 }, screen: { width: 393, height: 852 } }
      : { viewport: { width: 1440, height: 900 } },
  )
  // A desktop appearance already stored, which the phone must not rewrite.
  const DESKTOP = { theme: 'light', uiFontSize: 16, contentFontSize: 17, uiFont: null, contentFont: null }
  await context.addInitScript((desktop) => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.clear()
      localStorage.setItem('sedano.settings', JSON.stringify(desktop))
      sessionStorage.setItem('seeded', '1')
    }
  }, DESKTOP)
  const page = await context.newPage()
  page.setDefaultTimeout(8_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    await page.goto(target.url, { waitUntil: 'networkidle' })
    await openRichestSession(page)
    // Tool output and the diff only exist once opened.
    await page.locator('.transcript .wr-label', { hasText: /^2 tools/ }).first().click().catch(() => undefined)
    await page.locator('.transcript .wr-label', { hasText: /^Read$/ }).first().click().catch(() => undefined)
    await page.locator('.transcript .wr-label', { hasText: /file changed/ }).first().click().catch(() => undefined)
    // The path itself opens the file (see FileLink); the badge beside it folds the diff open.
    await page.locator('.transcript .file-head .file-badge').first().click().catch(() => undefined)
    await settle(page)

    const base = await measure(page)
    const missing = Object.keys(PROBES).filter((name) => !base[name])
    const required = phone ? ['prose', 'toolRow', 'turnHeader', 'composerField', 'topBar', 'composerControls'] : Object.keys(PROBES)
    check(`${tag}: every representative element is on screen`, required.every((name) => base[name]), { missing })

    await openAppearance(page, phone)
    const conversation = present(base, on('conversation'))
    const chrome = present(base, on('interface'))

    // --- Conversation size ------------------------------------------------
    let before = await measure(page)
    await step(page, 'Conversation text', 'Bigger', 4)
    let after = await measure(page)
    let moved = changed(before, after, 'fontSize')
    check(`${tag}: conversation size resizes the whole conversation, live`, sameSet(moved, conversation), { moved, conversation })
    check(`${tag}: conversation size leaves the interface alone`, !moved.some((name) => chrome.includes(name)), moved)
    check(`${tag}: conversation size changes no face and no colour`, changed(before, after, 'fontFamily').length + changed(before, after, 'color').length === 0)
    await step(page, 'Conversation text', 'Smaller', 4)
    check(`${tag}: conversation size goes back exactly`, changed(before, await measure(page), 'fontSize').length === 0)

    // --- Interface size ---------------------------------------------------
    before = await measure(page)
    await step(page, 'Interface text', 'Bigger', 4)
    after = await measure(page)
    moved = changed(before, after, 'fontSize')
    check(`${tag}: interface size resizes the interface, live`, sameSet(moved, chrome), { moved, chrome })
    check(`${tag}: interface size leaves the conversation alone`, !moved.some((name) => conversation.includes(name)), moved)
    check(`${tag}: interface size changes no face and no colour`, changed(before, after, 'fontFamily').length + changed(before, after, 'color').length === 0)
    await step(page, 'Interface text', 'Smaller', 4)
    check(`${tag}: interface size goes back exactly`, changed(before, await measure(page), 'fontSize').length === 0)

    // --- Typefaces --------------------------------------------------------
    const uiOptions = (await optionsOf(page, 'Interface typeface')).filter((name) => name !== 'System Default')
    const contentOptions = (await optionsOf(page, 'Conversation typeface')).filter((name) => name !== 'System Default')
    check(`${tag}: typefaces are on offer`, uiOptions.length > 0 && contentOptions.length > 0, { uiOptions, contentOptions })
    if (process.platform === 'darwin') {
      const absent = ['Segoe UI', 'Roboto'].filter((name) => uiOptions.includes(name))
      check(`${tag}: fonts this Mac does not have are not offered`, absent.length === 0, absent)
    }

    const proseFaces = present(base, ['prose', 'toolRow', 'turnHeader', 'composerField'])
    const chromeFaces = present(base, on('interface'))
    const mono = present(base, on('conversation', (probe) => Boolean(probe.mono)))

    before = await measure(page)
    const dead: string[] = []
    for (const option of contentOptions) {
      await choose(page, 'Conversation typeface', option)
      after = await measure(page)
      if (after.prose!.width === before.prose!.width) dead.push(option)
      if (option !== contentOptions[0]) continue
      const face = changed(before, after, 'fontFamily')
      const drawn = changed(before, after, 'width')
      check(`${tag}: conversation typeface (${option}) reaches the conversation, live`, sameSet(face, proseFaces), { face, proseFaces })
      check(`${tag}: conversation typeface (${option}) is actually drawn`, drawn.includes('prose') && drawn.includes('toolRow'), drawn)
      check(`${tag}: conversation typeface leaves the interface and monospace alone`, ![...face, ...drawn].some((name) => chromeFaces.includes(name) || mono.includes(name)), { face, drawn })
      check(`${tag}: conversation typeface changes no size`, changed(before, after, 'fontSize').length === 0)
    }
    check(`${tag}: every conversation typeface offered draws differently from the default`, dead.length === 0, dead)
    await choose(page, 'Conversation typeface', 'System Default')
    check(`${tag}: conversation typeface goes back to the default`, changed(before, await measure(page), 'width').length === 0)

    before = await measure(page)
    dead.length = 0
    for (const option of uiOptions) {
      await choose(page, 'Interface typeface', option)
      after = await measure(page)
      const reference = present(after, ['sidebar', 'tab', 'topBar'])[0]!
      if (after[reference]!.width === before[reference]!.width) dead.push(option)
      if (option !== uiOptions[0]) continue
      const face = changed(before, after, 'fontFamily')
      const drawn = changed(before, after, 'width')
      check(`${tag}: interface typeface (${option}) reaches the interface, live`, sameSet(face, chromeFaces), { face, chromeFaces })
      check(`${tag}: interface typeface (${option}) is actually drawn`, drawn.includes(reference), drawn)
      check(`${tag}: interface typeface leaves the conversation alone`, ![...face, ...drawn].some((name) => conversation.includes(name)), { face, drawn })
      check(`${tag}: interface typeface changes no size`, changed(before, after, 'fontSize').length === 0)
    }
    check(`${tag}: every interface typeface offered draws differently from the default`, dead.length === 0, dead)
    // Both faces set at once: each keeps to its own side.
    await choose(page, 'Conversation typeface', contentOptions.at(-1)!)
    const both = await measure(page)
    await choose(page, 'Interface typeface', 'System Default')
    const onlyConversation = await measure(page)
    check(`${tag}: resetting the interface face does not move the conversation face`, present(both, proseFaces).every((name) => both[name]!.fontFamily === onlyConversation[name]!.fontFamily))
    await choose(page, 'Conversation typeface', 'System Default')

    // --- Theme ------------------------------------------------------------
    before = await measure(page)
    await choose(page, 'Theme', 'Dark')
    after = await measure(page)
    const recoloured = [...new Set([...changed(before, after, 'color'), ...changed(before, after, 'background')])]
    check(`${tag}: theme recolours both sides, live`, recoloured.includes('prose') && recoloured.some((name) => chrome.includes(name)), recoloured)
    const shifted = [...changed(before, after, 'fontSize'), ...changed(before, after, 'fontFamily'), ...changed(before, after, 'width')]
    check(`${tag}: theme changes no size, face or text width`, shifted.length === 0, shifted)
    await choose(page, 'Theme', 'Light')

    // --- Kept, and kept per profile ----------------------------------------
    await step(page, 'Conversation text', 'Bigger', 2)
    await step(page, 'Interface text', 'Smaller', 2)
    await choose(page, 'Conversation typeface', contentOptions[0]!)
    const chosen = await measure(page)
    const stored = await page.evaluate(() => ({
      shared: JSON.parse(localStorage.getItem('sedano.settings') ?? '{}'),
      phone: JSON.parse(localStorage.getItem('sedano.settings.mobile') ?? 'null'),
    }))
    if (phone) {
      const untouched = ['theme', 'uiFontSize', 'contentFontSize', 'uiFont', 'contentFont'].every(
        (key) => stored.shared[key] === (DESKTOP as Record<string, unknown>)[key],
      )
      check(`${tag}: the phone's choices leave the desktop's appearance as stored`, untouched, stored.shared)
      check(`${tag}: the phone's choices are kept for the phone`, stored.phone?.contentFont === contentOptions[0], stored.phone)
    } else {
      check(`${tag}: the desktop's choices are stored`, stored.shared.contentFont === contentOptions[0] && stored.phone === null, stored)
    }
    await page.reload({ waitUntil: 'networkidle' })
    await openRichestSession(page)
    const reloaded = await measure(page)
    const drift = ['prose', 'toolRow', 'composerField', 'topBar', 'composerControls'].filter(
      (name) => chosen[name] && reloaded[name] && (chosen[name]!.fontSize !== reloaded[name]!.fontSize || chosen[name]!.fontFamily !== reloaded[name]!.fontFamily),
    )
    check(`${tag}: sizes and faces survive a reload`, drift.length === 0, drift.map((name) => [name, chosen[name], reloaded[name]]))

    check(`${tag}: no page errors`, errors.length === 0, errors)
  } finally {
    await context.close()
  }
}

try {
  for (const engine of ['chromium', 'webkit'] as const) {
    const browser = engine === 'webkit' ? await webkit.launch() : await chromium.launch({ channel: 'chrome' })
    try {
      await run(browser, engine, false)
      await run(browser, engine, true)
    } finally {
      await browser.close()
    }
  }
} catch (error) {
  failures.push(`crashed: ${error instanceof Error ? error.message : String(error)}`)
}

await runCleanups()
if (failures.length) {
  console.error(`\n${failures.length} appearance check(s) failed:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
console.log(`\nappearance: ${passed} checks passed`)
