#!/usr/bin/env bun
/** Gallery-only UI checks. No real session or model process is started. */
import { chromium } from 'playwright'
import { installExitHandlers, runCleanups, startVite } from './lib/harness.ts'

installExitHandlers()
const vite = await startVite()
const browser = await chromium.launch({ channel: 'chrome' })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  await page.goto(`${vite.url}/preview.html?only=turns`)
  const message = page.locator('[data-case="turn-long-prompt"] .msg-body')
  const toggle = page.locator('[data-case="turn-long-prompt"] .msg-expand')
  await message.waitFor()
  if (await toggle.getAttribute('aria-expanded') !== 'false') throw new Error('long prompt should start collapsed')
  if (await page.locator('[data-case="turn-long-prompt"] .msg-user-card .msg-expand').count() !== 1) throw new Error('show more must be inside the message card')
  if (!(await message.getAttribute('class'))?.includes('collapsed')) throw new Error('long prompt is not clamped')
  const foldedHeight = await message.evaluate((node) => node.getBoundingClientRect().height)
  await toggle.click()
  if (await toggle.getAttribute('aria-expanded') !== 'true') throw new Error('show more did not expand')
  if ((await message.textContent())?.includes('Paragraph 12') !== true) throw new Error('expanded prompt was truncated')
  const openHeight = await message.evaluate((node) => node.getBoundingClientRect().height)
  if (openHeight <= foldedHeight * 2) throw new Error(`expanded prompt did not grow: ${foldedHeight} → ${openHeight}`)
  const jump = page.locator('[data-case="turn-long-prompt"] .msg-jump')
  if (await jump.count() !== 1) throw new Error('expanded long prompt needs a jump-to-end arrow')
  await jump.click()
  if (await toggle.isVisible() !== true) throw new Error('jump-to-end did not reveal the end of the prompt')
  await toggle.click()
  if (await jump.count() !== 0) throw new Error('jump-to-end should disappear after folding')
  if (await toggle.getAttribute('aria-expanded') !== 'false') throw new Error('show less did not collapse')
  const refoldedHeight = await message.evaluate((node) => node.getBoundingClientRect().height)
  if (Math.abs(refoldedHeight - foldedHeight) > 1) throw new Error('prompt did not return to folded height')
  const agent = page.locator('[data-case="turn-subagent-starting"] .subagent[data-state="running"] .subagent-running-icon')
  await agent.first().waitFor()
  const animation = await agent.first().evaluate((node) => getComputedStyle(node).animationName)
  if (animation !== 'spin') throw new Error(`running subagent has no loading animation: ${animation}`)
  const scroller = page.locator('[data-case="turn-sticky-header"] .transcript')
  const sticky = page.locator('[data-case="turn-sticky-header"] .turn[data-state="working"] .turn-head')
  // Thirty calls fold into one run; open it, or there is nothing to scroll.
  await page.locator('[data-case="turn-sticky-header"] .tool-run > .wr').click()
  await page.locator('[data-case="turn-sticky-header"] .tool-run-more').click()
  await page.waitForTimeout(200)
  await scroller.evaluate((node) => { node.scrollTop = 500 })
  const stickyPosition = await sticky.evaluate((node) => {
    const scroller = node.closest('.transcript')!
    const wrap = scroller.closest('.transcript-wrap')!
    return {
      offset: node.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
      topbarGap: scroller.getBoundingClientRect().top - wrap.getBoundingClientRect().top,
      // The opaque band behind the pinned header: a spread shadow, clipped to
      // the header's height and reaching past both sides of the view.
      backing: getComputedStyle(node).boxShadow,
      clip: getComputedStyle(node).clipPath,
    }
  })
  if (Math.abs(stickyPosition.offset) > 1) throw new Error(`pinned header leaves a gap above it: ${stickyPosition.offset}px`)
  if (Math.abs(stickyPosition.topbarGap) > 1) throw new Error(`search row leaves a gap below the topbar: ${stickyPosition.topbarGap}px`)
  const spread = Number(/(\d+(?:\.\d+)?)px\s*$/.exec(stickyPosition.backing.replace(/^rgba?\([^)]*\)\s*/, '').trim())?.[1] ?? 0)
  if (stickyPosition.backing === 'none' || spread < 900 || !/inset/.test(stickyPosition.clip)) throw new Error(`pinned header does not mask scrolled content across the viewport: ${JSON.stringify(stickyPosition)}`)
  console.log('long-message-ui-test: PASSED (message controls, running subagent, flush pinned header)')
} finally {
  await browser.close()
  await runCleanups()
}
