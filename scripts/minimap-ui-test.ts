#!/usr/bin/env bun
/**
 * The prompt minimap, in Chrome and WebKit: every line is its own target.
 *
 * Lines stacked 12px apart were too close to hit one on purpose. Each line now
 * owns a 20px target (asserted ≥18px pitch, no two targets overlapping), the
 * strip is centred on the transcript's edge without covering any of its text,
 * it stops at 60% of the transcript and scrolls on its own past that, and the
 * first, a middle and the last line each land on their own prompt when clicked.
 * It keeps 12–16px from the scroller's content edge (past the scrollbar), and
 * from the file panel when that is open: it belongs to the transcript column.
 *
 * The gallery's thirty-prompt case for the lines, and a hermetic app (a
 * throwaway store, its own server) for the file panel. Nothing live is touched.
 *
 *   bun scripts/minimap-ui-test.ts
 */
import { chromium, webkit } from 'playwright'
import { installExitHandlers, runCleanups, startVite } from './lib/harness.ts'
import { resolveApp } from './lib/app.ts'

installExitHandlers()
const failures: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const CASE = '[data-case="turn-many-prompts"]'
const vite = await startVite()
try {
  for (const which of ['chromium', 'webkit'] as const) {
    const browser = which === 'webkit' ? await webkit.launch() : await chromium.launch({ channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    await page.goto(`${vite.url}/preview.html?only=turns`, { waitUntil: 'networkidle' })
    await page.locator(`${CASE} .prompt-minimap`).waitFor()
    await page.locator(CASE).scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)

    const shape = await page.evaluate((selector) => {
      const host = document.querySelector(selector)!
      const strip = host.querySelector<HTMLElement>('.prompt-minimap')!
      const wrap = strip.closest('.transcript-wrap')!.getBoundingClientRect()
      const box = strip.getBoundingClientRect()
      const marks = [...strip.querySelectorAll<HTMLElement>('.prompt-mark')].map((node) => node.getBoundingClientRect())
      const thread = host.querySelector<HTMLElement>('.thread')!
      const textRight = thread.getBoundingClientRect().right - parseFloat(getComputedStyle(thread).paddingRight)
      let overlaps = 0
      for (let index = 1; index < marks.length; index += 1) if (marks[index]!.top < marks[index - 1]!.bottom - 0.5) overlaps += 1
      const line = getComputedStyle(strip.querySelector('.prompt-mark')!, '::before')
      return {
        count: marks.length,
        pitch: marks.length > 1 ? Math.round((marks[1]!.top - marks[0]!.top) * 10) / 10 : 0,
        overlaps,
        width: Math.round(box.width),
        lineWidth: parseFloat(line.width),
        lineHeight: parseFloat(line.height),
        centred: Math.abs((box.top + box.bottom) / 2 - (wrap.top + wrap.bottom) / 2) <= 2,
        maxHeight: box.height <= wrap.height * 0.6 + 1,
        scrolls: strip.scrollHeight > strip.clientHeight,
        clearOfText: box.left >= textRight - 0.5,
        insideView: box.right <= wrap.right,
        // From the strip to the scroller's content edge, past its scrollbar.
        edgeGap: Math.round(host.querySelector<HTMLElement>('.transcript')!.getBoundingClientRect().left + host.querySelector<HTMLElement>('.transcript')!.clientWidth - box.right),
      }
    }, CASE)
    check(`${which}: one line per prompt`, shape.count === 30, shape)
    check(`${which}: each line owns at least 18px`, shape.pitch >= 18, shape)
    check(`${which}: no two targets overlap`, shape.overlaps === 0, shape)
    check(`${which}: the strip is about 28px wide and the lines are 16×3`, shape.width >= 24 && shape.width <= 30 && shape.lineWidth === 16 && shape.lineHeight === 3, shape)
    check(`${which}: centred on the transcript, at most 60% of it, scrolling past that`, shape.centred && shape.maxHeight && shape.scrolls, shape)
    check(`${which}: it covers no transcript text`, shape.clearOfText && shape.insideView, shape)
    check(`${which}: it keeps 12–16px from the scroller's edge and its scrollbar`, shape.edgeGap >= 12 && shape.edgeGap <= 16, shape)

    for (const index of [0, 14, 29]) {
      const mark = page.locator(`${CASE} .prompt-mark`).nth(index)
      // vite reloads the gallery when any source is saved (another agent at
      // work in the tree): wait for the line to be back rather than read null.
      await mark.waitFor({ state: 'attached' })
      await page.locator(CASE).scrollIntoViewIfNeeded()
      await mark.evaluate((node) => node.scrollIntoView({ block: 'nearest' }))
      await page.waitForTimeout(100)
      const box = (await mark.boundingBox())!
      const hit = await page.evaluate(({ selector, x, y, index }) => {
        const node = document.elementFromPoint(x, y)
        return node === document.querySelectorAll(`${selector} .prompt-mark`)[index]
      }, { selector: CASE, x: box.x + box.width / 2, y: box.y + box.height / 2, index })
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await page.waitForTimeout(900)
      const landed = await page.evaluate(({ selector, index }) => {
        const host = document.querySelector(selector)!
        const scroller = host.querySelector<HTMLElement>('.transcript')!
        const turn = host.querySelectorAll<HTMLElement>('.turn')[index]!
        const prompt = turn.querySelector<HTMLElement>(':scope > .msg-user')!
        const offset = prompt.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        const atEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 2
        return { offset: Math.round(offset), atEnd, current: host.querySelectorAll('.prompt-mark')[index]?.classList.contains('current') ?? false }
      }, { selector: CASE, index })
      // The last prompt cannot be scrolled to the top when the thread ends first.
      const onTop = Math.abs(landed.offset - 12) <= 3 || (landed.atEnd && landed.offset >= 0)
      check(`${which}: line ${index + 1} is the thing under its centre`, hit, { index, box })
      check(`${which}: clicking line ${index + 1} lands on prompt ${index + 1}`, onTop, landed)
    }
    // A narrow window, where the thread fills the pane: still clear of the text.
    await page.setViewportSize({ width: 840, height: 900 })
    await page.waitForTimeout(300)
    const narrow = await page.evaluate((selector) => {
      const host = document.querySelector(selector)!
      const strip = host.querySelector<HTMLElement>('.prompt-minimap')!.getBoundingClientRect()
      const thread = host.querySelector<HTMLElement>('.thread')!
      const textRight = thread.getBoundingClientRect().right - parseFloat(getComputedStyle(thread).paddingRight)
      return { stripLeft: Math.round(strip.left), textRight: Math.round(textRight) }
    }, CASE)
    check(`${which}: in a narrow window it still covers no text`, narrow.stripLeft >= narrow.textRight + 4, narrow)
    await browser.close()
  }

  // The app, with the file panel closed and open.
  const target = await resolveApp()
  const browser = await chromium.launch({ channel: 'chrome' })
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  await page.goto(target.url, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  // The seeded session with two prompts: a minimap needs at least two.
  await page.evaluate(async () => {
    if (!document.querySelector('.rail .session-item')) {
      ;(document.querySelector('.rail-title.workspace') as HTMLElement | null)?.click()
      await new Promise((r) => setTimeout(r, 300))
    }
    for (const more of document.querySelectorAll<HTMLElement>('.rail-more[aria-expanded="false"]')) more.click()
    await new Promise((r) => setTimeout(r, 150))
    const row = [...document.querySelectorAll<HTMLElement>('.rail .session-item')]
      .find((item) => (item.querySelector('.title')?.textContent ?? '').trim() === 'Rename the config loader')
    row?.click()
    await new Promise((r) => setTimeout(r, 900))
  })
  const place = () => page.evaluate(() => {
    const strip = document.querySelector<HTMLElement>('.prompt-minimap')
    const scroller = document.querySelector<HTMLElement>('.transcript')!
    const thread = document.querySelector<HTMLElement>('.thread')!
    const panel = document.querySelector<HTMLElement>('.files-panel')
    if (!strip) return null
    const box = strip.getBoundingClientRect()
    const contentRight = scroller.getBoundingClientRect().left + scroller.clientWidth
    const textRight = thread.getBoundingClientRect().right - parseFloat(getComputedStyle(thread).paddingRight)
    return {
      edgeGap: Math.round(contentRight - box.right),
      panelGap: panel ? Math.round(panel.getBoundingClientRect().left - box.right) : null,
      textGap: Math.round(box.left - textRight),
    }
  })
  const closed = await place()
  check('app: the session has a minimap to place', closed !== null, closed)
  check('app, file panel closed: 12–16px from the edge, clear of the text', Boolean(closed && closed.edgeGap >= 12 && closed.edgeGap <= 16 && closed.textGap >= 4), closed)
  const toggled = await page.evaluate(() => {
    const tree = [...document.querySelectorAll<HTMLElement>('.tabs .icon-btn')].find((node) =>
      (node.getAttribute('title') ?? '').toLowerCase().includes('file tree'))
    tree?.click()
    return Boolean(tree)
  })
  await page.waitForTimeout(700)
  const open = await place()
  check('app: the file panel opens', toggled && (await page.locator('.files-panel').count()) === 1)
  check(
    'app, file panel open: it moves with the transcript column, 12–16px from its edge and clear of the panel',
    Boolean(open && open.edgeGap >= 12 && open.edgeGap <= 16 && open.panelGap !== null && open.panelGap >= 12 && open.textGap >= 4),
    open,
  )
  await browser.close()
} finally {
  await runCleanups()
}
if (failures.length) {
  console.log(`\nminimap-ui-test: ${failures.length} FAILURES`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('\nminimap-ui-test: PASSED')
process.exit(0)
