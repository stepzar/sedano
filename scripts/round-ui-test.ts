#!/usr/bin/env bun
/**
 * Round controls are geometrically round: close buttons, the prompt-jump
 * button, counters, status dots and switch knobs are exact circles (equal
 * sides, a radius of half the side), icon-only buttons are exact squares, and
 * the glyph inside each one is centred on it. No control draws its cross with
 * a "×" character. Chrome at a desktop width and WebKit as an iPhone, against a
 * throwaway store; the docked shell is closed again at the end.
 *
 *   bun scripts/round-ui-test.ts
 */
import { chromium, devices, webkit, type Browser, type Page } from 'playwright'
import { installExitHandlers, runCleanups } from './lib/harness.ts'
import { openRichestSession, resolveApp } from './lib/app.ts'

installExitHandlers()
const failures: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const CIRCLES = [
  '.tab .x',
  '.dock-tab-x',
  '.rail-search-clear',
  '.ws-delete:not(.armed)',
  '.transcript-search-box .search-close',
  '.round-close',
  '.msg-jump',
  '.dot',
  '.machine-dot',
  '.env-dot',
  '.sess-state',
  '.switch .knob',
]
const SQUARES = ['.icon-btn']

function measure(page: Page) {
  return page.evaluate(
    ({ circles, squares }) => {
      const problems: Array<Record<string, unknown>> = []
      const seen: Record<string, number> = {}
      const visible = (node: HTMLElement) => {
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      }
      const radius = (node: HTMLElement, side: number) => {
        const value = getComputedStyle(node).borderTopLeftRadius
        return value.endsWith('%') ? (parseFloat(value) / 100) * side : parseFloat(value)
      }
      const centred = (node: HTMLElement, rect: DOMRect) => {
        const glyph = node.querySelector(':scope > svg') as SVGElement | null
        if (!glyph) return null
        const box = glyph.getBoundingClientRect()
        return {
          dx: Math.abs(box.left + box.width / 2 - (rect.left + rect.width / 2)),
          dy: Math.abs(box.top + box.height / 2 - (rect.top + rect.height / 2)),
        }
      }
      for (const [shape, list] of [['circle', circles], ['square', squares]] as const) {
        for (const selector of list) {
          for (const node of document.querySelectorAll<HTMLElement>(selector)) {
            if (!visible(node)) continue
            seen[selector] = (seen[selector] ?? 0) + 1
            // Measured without transforms (a spinning ring or a scaled pulse).
            const rect = node.getBoundingClientRect()
            const width = node.offsetWidth || rect.width
            const height = node.offsetHeight || rect.height
            const off = centred(node, rect)
            const issue: string[] = []
            if (Math.abs(width - height) > 0.5) issue.push(`not ${shape === 'circle' ? 'round' : 'square'} (${width}×${height})`)
            if (shape === 'circle' && radius(node, Math.min(width, height)) < Math.min(width, height) / 2 - 0.5) issue.push(`radius ${getComputedStyle(node).borderTopLeftRadius}`)
            if (off && (off.dx > 0.75 || off.dy > 0.75)) issue.push(`glyph off centre by ${off.dx.toFixed(2)},${off.dy.toFixed(2)}`)
            if (issue.length) problems.push({ selector, issue: issue.join('; '), html: node.outerHTML.slice(0, 80) })
          }
        }
      }
      // No cross drawn with a character, anywhere a control is.
      const crosses = [...document.querySelectorAll<HTMLElement>('button, [role="button"]')]
        .filter((node) => visible(node) && [...node.childNodes].some((child) => child.nodeType === 3 && /[×✕✖]/.test(child.textContent ?? '')))
        .map((node) => node.outerHTML.slice(0, 80))
      return { problems, seen, crosses }
    },
    { circles: CIRCLES, squares: SQUARES },
  )
}

async function tour(page: Page, tag: string): Promise<void> {
  const collected: Array<Awaited<ReturnType<typeof measure>>> = []
  await page.goto(target.url, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  await openRichestSession(page)
  if (!tag.startsWith('iPhone')) {
    await page.locator('.rail-search input').fill('a')
    await page.locator('.rail-title.workspace').first().hover()
  }
  collected.push(await measure(page))
  // Conversation search, with its own close.
  await page.locator('.transcript-search-toggle').first().click().catch(() => undefined)
  await page.waitForTimeout(200)
  collected.push(await measure(page))
  // The quick terminal: its tabs' close buttons and its own.
  await page.keyboard.press('Meta+j')
  await page.locator('.dock-tab-x').first().waitFor({ timeout: 10_000 }).catch(() => undefined)
  collected.push(await measure(page))
  await page.screenshot({ path: `.playwright-mcp/round-${tag.replace(/\s+/g, '-')}.png` })
  for (const close of await page.locator('.dock-tab-x').all()) await close.click().catch(() => undefined)
  await page.waitForTimeout(300)
  // Settings: the switches.
  await page.locator('.bar .settings-btn').click()
  await page.locator('.settings-nav-item', { hasText: 'Interface' }).click()
  await page.waitForTimeout(200)
  collected.push(await measure(page))
  // The palette, whose close button is on screen on a phone.
  await page.keyboard.press('Escape')
  await page.locator('.location-pill').click()
  await page.waitForTimeout(200)
  collected.push(await measure(page))
  await page.keyboard.press('Escape')

  const problems = collected.flatMap((item) => item.problems)
  const crosses = [...new Set(collected.flatMap((item) => item.crosses))]
  const seen = collected.reduce<Record<string, number>>((all, item) => {
    for (const [key, count] of Object.entries(item.seen)) all[key] = Math.max(all[key] ?? 0, count)
    return all
  }, {})
  check(`${tag}: round controls measured (${Object.keys(seen).length} kinds)`, Object.keys(seen).length >= 8, seen)
  check(`${tag}: every one is an exact circle or square with a centred glyph`, problems.length === 0, problems.slice(0, 8))
  check(`${tag}: no control draws its cross with a character`, crosses.length === 0, crosses)
}

const target = await resolveApp()
let browser: Browser | null = null
try {
  browser = await chromium.launch({ channel: 'chrome' })
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await tour(desktop, 'desktop')
  await browser.close()
  browser = await webkit.launch()
  const context = await browser.newContext({ ...devices['iPhone 15'], viewport: { width: 393, height: 852 } })
  await tour(await context.newPage(), 'iPhone')
} catch (error) {
  failures.push(error instanceof Error ? error.stack ?? error.message : String(error))
} finally {
  await browser?.close()
  await runCleanups()
}

if (failures.length) {
  console.error(`\nround-ui-test: FAILED\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('\nround-ui-test: PASSED')
