#!/usr/bin/env bun
/**
 * The quick terminal (⌘J) is resized by dragging its top edge: the panel
 * follows the pointer within its limits (120px to 80% of the window), the
 * xterm inside refits to more rows, a pinned transcript stays at its bottom,
 * the height survives a reload and a double click puts it back. Chrome,
 * against a throwaway store; the docked shells are closed again at the end.
 *
 *   bun scripts/dock-resize-ui-test.ts
 */
import { chromium, type Page } from 'playwright'
import { installExitHandlers, runCleanups } from './lib/harness.ts'
import { openRichestSession, resolveApp } from './lib/app.ts'

installExitHandlers()
const failures: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const measure = (page: Page) =>
  page.evaluate(() => {
    const dock = document.querySelector<HTMLElement>('.dock-bottom')
    const transcript = document.querySelector<HTMLElement>('.transcript')
    return {
      height: dock ? Math.round(dock.getBoundingClientRect().height) : 0,
      rows: document.querySelectorAll('.dock-bottom .xterm-rows > div').length,
      fromBottom: transcript ? Math.round(transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight) : -1,
    }
  })

async function dragEdge(page: Page, dy: number): Promise<void> {
  const box = await page.locator('.dock-resizer').boundingBox()
  if (!box) throw new Error('no resize handle on the terminal')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let step = 1; step <= 10; step += 1) {
    await page.mouse.move(x, y + (dy * step) / 10)
    await page.waitForTimeout(16)
  }
  await page.mouse.up()
  await page.waitForTimeout(400)
}

const target = await resolveApp()
const browser = await chromium.launch({ channel: 'chrome' })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(target.url, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  await openRichestSession(page)
  await page.keyboard.press('Meta+j')
  await page.locator('.dock-bottom .xterm-rows > div').first().waitFor({ timeout: 10_000 })
  await page.waitForTimeout(700)

  // Pin the transcript to its bottom first, so the drag has something to keep.
  await page.evaluate(() => {
    const node = document.querySelector<HTMLElement>('.transcript')
    if (node) node.scrollTop = node.scrollHeight
  })
  await page.waitForTimeout(200)
  const before = await measure(page)
  check('the terminal is open with a handle on its top edge', before.height > 0 && (await page.locator('.dock-resizer').count()) === 1, before)
  const cursor = await page.locator('.dock-resizer').evaluate((node) => getComputedStyle(node).cursor)
  check('the handle shows a row-resize cursor', cursor === 'row-resize', cursor)

  await dragEdge(page, -200)
  const taller = await measure(page)
  check('dragging the edge up makes the terminal taller by the distance dragged', Math.abs(taller.height - before.height - 200) <= 3, { before, taller })
  check('the terminal refits to more rows', taller.rows > before.rows, { before: before.rows, after: taller.rows })
  check('a transcript that was at its bottom stays there', taller.fromBottom <= 2, taller)
  await page.screenshot({ path: '.playwright-mcp/dock-resize-taller.png' })

  await dragEdge(page, -2000)
  const top = await measure(page)
  check('it stops at 80% of the window', Math.abs(top.height - 720) <= 2, top)
  await dragEdge(page, 2000)
  const bottom = await measure(page)
  check('and at 120px', Math.abs(bottom.height - 120) <= 2, bottom)

  await dragEdge(page, -180)
  const kept = await measure(page)
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  await openRichestSession(page)
  if (!(await page.locator('.dock-bottom').count())) await page.keyboard.press('Meta+j')
  await page.locator('.dock-bottom .xterm-rows > div').first().waitFor({ timeout: 10_000 })
  await page.waitForTimeout(500)
  const reloaded = await measure(page)
  check('the height survives a reload', Math.abs(reloaded.height - kept.height) <= 2, { kept, reloaded })

  await page.locator('.dock-resizer').dblclick()
  await page.waitForTimeout(400)
  const reset = await measure(page)
  const stored = await page.evaluate(() => localStorage.getItem('sedano.dock-height'))
  check('a double click puts back the default height', reset.height === Math.round(Math.min(260, Math.max(150, 900 * 0.34))) && stored === null, { reset, stored })

  // The docked shells are real tmux sessions: close them.
  for (const close of await page.locator('.dock-tab-x').all()) await close.click()
  await page.waitForTimeout(400)
  check('the page raised no errors', errors.length === 0, errors)
} catch (error) {
  failures.push(error instanceof Error ? error.stack ?? error.message : String(error))
} finally {
  await browser.close()
  await runCleanups()
}

if (failures.length) {
  console.error(`\ndock-resize-ui-test: FAILED\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('\ndock-resize-ui-test: PASSED')
