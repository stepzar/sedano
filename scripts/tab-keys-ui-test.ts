#!/usr/bin/env bun
/**
 * ⌘1…⌘9 pick the tab at that position in the strip as it is drawn — after the
 * user has dragged tabs around — and ⌘9 is always the last one. The chord has
 * to work wherever the caret is: in the composer, and inside a terminal, where
 * xterm sees keystrokes before the window does. Chrome and WebKit, against a
 * throwaway store.
 *
 *   bun scripts/tab-keys-ui-test.ts
 */
import { chromium, webkit, type Page } from 'playwright'
import { installExitHandlers, runCleanups } from './lib/harness.ts'
import { resolveApp, expandRail } from './lib/app.ts'

installExitHandlers()
const failures: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const strip = (page: Page) =>
  page.locator('.tabs .tab').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-tab-id')))
const active = (page: Page) => page.locator('.tabs .tab.active').getAttribute('data-tab-id')

const target = await resolveApp()
try {
  // The Linux pass is Chrome told it is not on a Mac: the chord is Control
  // there, and Control is also what xterm would otherwise turn into a byte.
  for (const which of ['chromium', 'webkit', 'linux'] as const) {
    console.log(`\n— ${which}`)
    const browser = which === 'webkit' ? await webkit.launch() : await chromium.launch({ channel: 'chrome' })
    const page = await browser.newPage({
      viewport: { width: 1440, height: 900 },
      ...(which === 'linux' ? { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' } : {}),
    })
    const mod = which === 'linux' ? 'Control' : 'Meta'
    const other = which === 'linux' ? 'Meta' : 'Control'
    const key = which === 'linux' ? 'Ctrl+' : '⌘'
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      await page.goto(target.url, { waitUntil: 'networkidle' })
      await page.waitForTimeout(700)
      if (!(await page.locator('.rail .session-item:not(.draft)').count())) {
        await page.locator('.rail-title.workspace').first().click()
        await page.waitForTimeout(250)
      }
      await expandRail(page)
      const rows = page.locator('.rail .session-item:not(.draft)')
      for (let index = 0; index < 4; index += 1) {
        await rows.nth(index).click()
        await page.waitForTimeout(200)
      }
      const opened = await strip(page)
      check(`${which}: four tabs are open`, opened.length >= 4, opened)

      // Drag the first tab to the end, by hand, so the strip's order is the
      // user's and no longer the order the tabs were opened in.
      const tabs = page.locator('.tabs .tab')
      const source = await tabs.nth(0).boundingBox()
      const destination = await tabs.nth(opened.length - 1).boundingBox()
      if (!source || !destination) throw new Error('could not measure the tabs')
      const y = source.y + source.height / 2
      await page.mouse.move(source.x + source.width / 2, y)
      await page.mouse.down()
      const endX = destination.x + destination.width + 10
      for (let step = 1; step <= 16; step += 1) {
        await page.mouse.move(source.x + source.width / 2 + ((endX - source.x - source.width / 2) * step) / 16, y)
        await page.waitForTimeout(16)
      }
      await page.mouse.up()
      await page.waitForTimeout(300)
      const order = await strip(page)
      check(`${which}: the drag moved the first tab to the end`, order.at(-1) === opened[0] && order[0] === opened[1], { opened, order })

      // The caret in the composer: a field that eats most keys.
      await page.locator('.composer textarea').click()
      await page.keyboard.type('draft text')
      await page.keyboard.press(`${mod}+2`)
      await page.waitForTimeout(250)
      check(`${which}: ⌘2 in the composer selects the second tab of the reordered strip`, (await active(page)) === order[1], { active: await active(page), order })
      await page.keyboard.press(`${mod}+1`)
      await page.waitForTimeout(250)
      check(`${which}: ⌘1 selects the leftmost tab`, (await active(page)) === order[0], { active: await active(page), order })
      await page.keyboard.press(`${mod}+9`)
      await page.waitForTimeout(250)
      check(`${which}: ⌘9 selects the last tab`, (await active(page)) === order.at(-1), { active: await active(page), order })
      await page.keyboard.press(`${mod}+8`)
      await page.waitForTimeout(250)
      check(`${which}: a position past the last tab changes nothing`, (await active(page)) === order.at(-1), { active: await active(page), order })
      await page.keyboard.press(`${other}+2`)
      await page.waitForTimeout(250)
      check(`${which}: ${other}+2 is not this platform's tab chord`, (await active(page)) === order.at(-1), { active: await active(page), order })

      // Inside a terminal: raise the docked shell, put the caret in it, and the
      // chord must still reach the app instead of the shell.
      await page.keyboard.press(`${mod}+1`)
      await page.waitForTimeout(250)
      await page.keyboard.press(`${mod}+j`)
      await page.waitForTimeout(700)
      const xterm = page.locator('.xterm:visible').first()
      check(`${which}: a terminal is on screen`, (await xterm.count()) === 1)
      if (await xterm.count()) {
        await xterm.click()
        await page.waitForTimeout(150)
        const inTerminal = await page.evaluate(() => document.activeElement?.classList.contains('xterm-helper-textarea') ?? false)
        check(`${which}: the caret is in the terminal`, inTerminal)
        await page.keyboard.press(`${mod}+2`)
        await page.waitForTimeout(250)
        check(`${which}: ⌘2 inside a terminal selects the second tab`, (await active(page)) === order[1], { active: await active(page), order })
      }
      // The docked shell is a real tmux session: close it, so the run leaves
      // nothing behind on the tmux server.
      await page.keyboard.press(`${mod}+1`)
      await page.waitForTimeout(300)
      for (const close of await page.locator('.dock-tab-x').all()) await close.click()
      await page.waitForTimeout(400)
      const titles = await tabs.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('title') ?? ''))
      check(`${which}: each tab's tooltip names its shortcut`, titles[0]!.endsWith(`${key}1`) && titles[1]!.endsWith(`${key}2`), titles)
      check(`${which}: the page raised no errors`, errors.length === 0, errors)
      if (which === 'chromium') await page.locator('.tabs').screenshot({ path: '.playwright-mcp/tab-keys.png' })
    } finally {
      await browser.close()
    }
  }
} catch (error) {
  failures.push(error instanceof Error ? error.stack ?? error.message : String(error))
} finally {
  await runCleanups()
}

if (failures.length) {
  console.error(`\ntab-keys-ui-test: FAILED\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('\ntab-keys-ui-test: PASSED')
