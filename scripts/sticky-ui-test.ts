#!/usr/bin/env bun
/**
 * Pinned section headers in the work area, in Chrome and WebKit.
 *
 * An open section taller than the view keeps its header at the top of the
 * transcript while you read inside it: the turn's own header first, then the
 * open row directly in its work right under it, and nothing deeper. Collapsing
 * a pinned section leaves its header where it was, with what came after the
 * section right under it — not a jump to wherever the section began.
 *
 * Gallery only (`preview.html?only=harnesses`): no store, no server, no socket.
 *
 *   bun scripts/sticky-ui-test.ts
 */
import { chromium, webkit } from 'playwright'
import { installExitHandlers, runCleanups, startVite } from './lib/harness.ts'

installExitHandlers()
const failures: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const vite = await startVite()
try {
  for (const which of ['chromium', 'webkit'] as const) {
    const browser = which === 'webkit' ? await webkit.launch() : await chromium.launch({ channel: 'chrome' })
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } })
    // Short on purpose: every open section is taller than the view.
    await page.goto(`${vite.url}/preview.html?only=harnesses&case=harness-claude&height=380`, { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-case="harness-claude"] .subagent > .wr')
    await page.waitForTimeout(400)

    const read = await page.evaluate(async () => {
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
      const host = document.querySelector('[data-case="harness-claude"]')!
      const scroller = host.querySelector<HTMLElement>('.transcript')!
      const top = () => scroller.getBoundingClientRect().top
      const at = (node: Element) => Math.round(node.getBoundingClientRect().top - top())
      const head = host.querySelector<HTMLElement>('.turn-work > .turn-head')!
      const card = host.querySelector<HTMLElement>('.turn-body > .subagent')!
      const row = card.querySelector<HTMLElement>(':scope > .wr')!
      const out: Record<string, unknown> = {}
      // Room below the thread, so the browser never has to clamp the scroll
      // when a section closes: holding a row still is the transcript's job,
      // being unable to scroll past the end is not a regression of it.
      host.querySelector<HTMLElement>('.thread')!.style.paddingBottom = '1600px'

      // Open the subagent and scroll into the middle of it.
      row.click()
      await wait(450)
      out.opened = card.classList.contains('open')
      scroller.scrollTop += card.getBoundingClientRect().top - top() + 160
      await wait(150)
      out.headAt = at(head)
      out.headHeight = Math.round(head.getBoundingClientRect().height)
      out.rowAt = at(row)
      // A row nested inside the subagent never pins: two levels at most.
      const nested = card.querySelector<HTMLElement>('.subagent-body .wi > .wr')
      out.nestedPosition = nested ? getComputedStyle(nested).position : 'missing'
      // Whatever is drawn right under the pinned rows must not show through.
      out.rowBackground = getComputedStyle(row).backgroundColor
      // A long brief is clamped with "Show more", never a box with its own scrollbar.
      const prompt = card.querySelector<HTMLElement>('.subagent-prompt')!
      const toggle = prompt.parentElement!.querySelector<HTMLElement>('.clamp-toggle')
      out.promptClamped = prompt.scrollHeight > prompt.clientHeight + 1 && getComputedStyle(prompt).overflowY !== 'auto' && getComputedStyle(prompt).overflowY !== 'scroll'
      out.promptToggle = toggle?.textContent?.trim() ?? ''
      toggle?.click()
      await wait(120)
      out.promptOpen = prompt.scrollHeight <= prompt.clientHeight + 1 && toggle?.textContent?.trim() === 'Show less' && toggle?.getAttribute('aria-expanded') === 'true'
      toggle?.click()
      await wait(120)
      out.promptRefolded = prompt.scrollHeight > prompt.clientHeight + 1 && toggle?.textContent?.trim() === 'Show more'

      // Collapse it from the pinned header: it stays put, the next row follows.
      const next = card.nextElementSibling as HTMLElement
      const rowBefore = at(row)
      row.click()
      await wait(600)
      out.rowMoved = at(row) - rowBefore
      out.nextGap = Math.round(next.getBoundingClientRect().top - row.getBoundingClientRect().bottom)
      out.closed = !card.classList.contains('open')

      // The turn itself: scroll deep into its work, collapse from its header.
      const run = host.querySelector<HTMLElement>('.turn-body > .tool-run > .wr')!
      run.click()
      await wait(200)
      scroller.scrollTop += run.getBoundingClientRect().top - top() + 60
      await wait(150)
      out.turnHeadAtInside = at(head)
      const headBefore = at(head)
      head.querySelector<HTMLElement>('.turn-toggle')!.click()
      await wait(600)
      out.turnHeadMoved = at(head) - headBefore
      const after = head.closest('.turn-work')!.nextElementSibling as HTMLElement
      out.afterGap = Math.round(after.getBoundingClientRect().top - head.getBoundingClientRect().bottom)
      out.turnFolded = !host.querySelector('.turn-work.open')
      return out
    })

    check(`${which}: the subagent opened`, read.opened === true, read)
    check(`${which}: the turn header pins flush to the top`, Math.abs(read.headAt as number) <= 1, read)
    check(`${which}: the open subagent pins right under it, no gap and no overlap`, Math.abs((read.rowAt as number) - (read.headHeight as number)) <= 1, read)
    check(`${which}: a row nested deeper does not pin`, read.nestedPosition !== 'sticky' && read.nestedPosition !== 'missing', read)
    check(`${which}: a long subagent brief is clamped with "Show more", not scrolled in a box`, read.promptClamped === true && read.promptToggle === 'Show more', read)
    check(`${which}: "Show more" opens it in full, "Show less" folds it again`, read.promptOpen === true && read.promptRefolded === true, read)
    check(`${which}: a pinned row is opaque`, !/rgba\(0, 0, 0, 0\)|transparent/.test(String(read.rowBackground)), read)
    check(`${which}: collapsing a pinned subagent keeps its row where it was`, read.closed === true && Math.abs(read.rowMoved as number) <= 2, read)
    check(`${which}: and what came after it continues right under it`, Math.abs(read.nextGap as number) <= 4, read)
    check(`${which}: the turn header is pinned while reading its work`, Math.abs(read.turnHeadAtInside as number) <= 1, read)
    check(`${which}: collapsing the turn from there keeps its header in place`, read.turnFolded === true && Math.abs(read.turnHeadMoved as number) <= 2, read)
    check(`${which}: and the reply follows right under it`, (read.afterGap as number) >= 0 && (read.afterGap as number) <= 12, read)
    await browser.close()
  }
} finally {
  await runCleanups()
}
if (failures.length) {
  console.log(`\nsticky-ui-test: ${failures.length} FAILURES`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('\nsticky-ui-test: PASSED')
process.exit(0)
