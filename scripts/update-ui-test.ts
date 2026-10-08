#!/usr/bin/env bun
/**
 * The app-update UI, in a real browser, against a mocked Tauri bridge.
 *
 * The updater itself is Tauri's (its download, signature check and install are
 * proved end to end in docs/release.md's throwaway-key run); what can regress
 * here is ours: whether the pill appears, what it says at each step, whether a
 * failure stays on screen, and that nothing update-related shows in a browser
 * tab. The page is the built bundle served by a real server; "desktop" is the
 * same page with `__SEDANO_API__` and a fake `__TAURI_INTERNALS__` injected, the
 * two things the shell provides.
 *
 *   bun scripts/update-ui-test.ts
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Page } from 'playwright'
import { installExitHandlers, ROOT, runCleanups, startApi, tempHome } from './lib/harness.ts'

installExitHandlers()

const failures: string[] = []
const passed: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) passed.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

if (!existsSync(join(ROOT, 'apps/ui/dist/index.html'))) {
  const build = Bun.spawn(['bun', 'run', 'build:ui'], { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' })
  if ((await build.exited) !== 0) process.exit(1)
}
const version = (JSON.parse(await Bun.file(join(ROOT, 'package.json')).text()) as { version: string }).version

const { env } = tempHome('update-ui')
const api = await startApi(env)
const browser = await chromium.launch(process.env.SEDANO_BROWSER === 'chromium' ? {} : { channel: 'chrome' })

/** What the fake bridge answers to `plugin:updater|check`. */
type CheckAnswer = 'update' | 'none' | 'fail'

/**
 * The shell's side of the page: the API address, and a Tauri IPC that answers
 * the updater, process and app commands and records every call.
 */
function shell(answer: CheckAnswer): string {
  return `
window.__SEDANO_API__ = '127.0.0.1:${api.port}'
window.__calls = []
const callbacks = new Map()
let next = 1
window.__TAURI_INTERNALS__ = {
  transformCallback(callback) { const id = next++; callbacks.set(id, callback); return id },
  unregisterCallback(id) { callbacks.delete(id) },
  convertFileSrc(path) { return path },
  async invoke(cmd, args) {
    window.__calls.push(cmd)
    if (cmd === 'plugin:app|version') return '${version}'
    if (cmd === 'plugin:updater|check') {
      if (${JSON.stringify(answer)} === 'fail') throw 'error sending request: network down'
      if (${JSON.stringify(answer)} === 'none') return null
      return { rid: 7, currentVersion: '${version}', version: '9.9.9', date: null, body: 'notes', rawJson: {} }
    }
    if (cmd === 'plugin:updater|download_and_install') {
      const send = (index, message) => callbacks.get(args.onEvent.id)?.({ index, message })
      send(0, { event: 'Started', data: { contentLength: 100 } })
      send(1, { event: 'Progress', data: { chunkLength: 100 } })
      send(2, { event: 'Finished' })
      return null
    }
    if (cmd === 'plugin:process|restart') return null
    if (cmd === 'plugin:resources|close') return null
    throw 'unmocked ' + cmd
  },
}
`
}

async function openPage(answer: CheckAnswer | null): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
  page.on('pageerror', (error) => failures.push(`pageerror (${answer ?? 'browser'}): ${error.message}`))
  if (answer) await page.addInitScript(shell(answer))
  await page.goto(api.url, { waitUntil: 'networkidle' })
  return page
}

async function openAdvanced(page: Page): Promise<void> {
  await page.evaluate(() => (document.querySelector('button[title^="Settings"]') as HTMLElement | null)?.click())
  await page.waitForSelector('.settings', { timeout: 5000 })
  await page.evaluate(() => {
    const item = [...document.querySelectorAll<HTMLElement>('.settings-nav-item')].find(
      (button) => button.firstElementChild?.textContent?.trim() === 'Advanced',
    )
    item?.click()
  })
  await page.waitForSelector('.update-settings', { timeout: 5000 })
}

const text = (page: Page, selector: string) => page.locator(selector).first().innerText().catch(() => '')
const clickButton = (page: Page, scope: string, label: string) =>
  page.locator(`${scope} button`, { hasText: label }).first().click()

try {
  // A browser tab (or a phone): nothing to install, the server's version shown.
  {
    const page = await openPage(null)
    await openAdvanced(page)
    await page.waitForFunction((want) => document.querySelector('.update-version')?.textContent?.includes(want), version, { timeout: 5000 }).catch(() => {})
    check('browser: Settings shows the server version', (await text(page, '.update-version')) === `Sedano ${version}`, await text(page, '.update-version'))
    check('browser: and says updates come with the Mac app', (await text(page, '.update-settings')).includes('Updates come with the Mac app'))
    check('browser: no check button', (await page.locator('.update-settings button').count()) === 0)
    check('browser: no update pill', (await page.locator('.update-pill').count()) === 0)
    await page.close()
  }

  // Desktop, an update available: check → pill → install with progress → restart.
  {
    const page = await openPage('update')
    await openAdvanced(page)
    check('desktop: Settings shows the app version', (await text(page, '.update-version')) === `Sedano ${version}`, await text(page, '.update-version'))
    check('desktop: nothing offered before a check', (await page.locator('.update-pill').count()) === 0)
    await clickButton(page, '.update-settings', 'Check for updates')
    await page.waitForSelector('.update-pill', { timeout: 5000 }).catch(() => {})
    await page.locator('.update-pill').screenshot({ path: join(ROOT, '.playwright-mcp', 'update-pill-available.png') }).catch(() => {})
    check('the pill offers the new version', (await text(page, '.update-pill')).includes('Update to 9.9.9'), await text(page, '.update-pill'))
    check('Settings offers the install too', (await text(page, '.update-settings')).includes('Install 9.9.9'), await text(page, '.update-settings'))
    await page.locator('.update-pill').click()
    await page.waitForFunction(() => document.querySelector('.update-pill')?.textContent?.includes('Restart'), null, { timeout: 5000 }).catch(() => {})
    await page.screenshot({ path: join(ROOT, '.playwright-mcp', 'update-ready.png') }).catch(() => {})
    check('after the install the pill asks for a restart', (await text(page, '.update-pill')).includes('Restart to update'), await text(page, '.update-pill'))
    const calls = (await page.evaluate(() => (window as unknown as { __calls: string[] }).__calls)) as string[]
    check('the install went through the updater plugin', calls.includes('plugin:updater|download_and_install'), calls)
    check('and nothing restarted on its own', !calls.includes('plugin:process|restart'), calls)
    await page.locator('.update-pill').click()
    await page.waitForSelector('.dialog-actions', { timeout: 5000 }).catch(() => {})
    check('restarting asks first', (await page.locator('.dialog-actions').count()) === 1)
    await clickButton(page, '.dialog-actions', 'Restart')
    await page.waitForTimeout(200)
    const after = (await page.evaluate(() => (window as unknown as { __calls: string[] }).__calls)) as string[]
    check('confirming relaunches through the process plugin', after.includes('plugin:process|restart'), after)
    await page.close()
  }

  // Desktop, already current: said so, no pill.
  {
    const page = await openPage('none')
    await openAdvanced(page)
    await clickButton(page, '.update-settings', 'Check for updates')
    await page.waitForFunction(() => document.querySelector('.update-settings')?.textContent?.includes('Up to date'), null, { timeout: 5000 }).catch(() => {})
    check('up to date: Settings says so', (await text(page, '.update-settings')).includes('Up to date'), await text(page, '.update-settings'))
    check('up to date: a toast answers the click', (await text(page, '.toasts')).includes('latest version'), await text(page, '.toasts'))
    check('up to date: no pill', (await page.locator('.update-pill').count()) === 0)
    await page.close()
  }

  // Desktop, the check fails: on screen in all three places, never silent.
  {
    const page = await openPage('fail')
    await openAdvanced(page)
    await clickButton(page, '.update-settings', 'Check for updates')
    await page.waitForSelector('.update-pill.error', { timeout: 5000 }).catch(() => {})
    await page.screenshot({ path: join(ROOT, '.playwright-mcp', 'update-failed.png') }).catch(() => {})
    check('a failed check shows an error pill', (await text(page, '.update-pill.error')).includes('Update check failed'), await text(page, '.update-pill'))
    check('the reason is in Settings', (await text(page, '.update-settings')).includes('network down'), await text(page, '.update-settings'))
    check('and in a toast', (await text(page, '.toasts')).includes('network down'), await text(page, '.toasts'))
    await page.close()
  }
} finally {
  await browser.close()
  await runCleanups()
}

if (failures.length) {
  for (const failure of failures) console.log(`✗ ${failure}`)
  console.log(`update-ui-test: ${failures.length} FAILURES (${passed.length} passed)`)
  process.exit(1)
}
console.log(`update-ui-test: PASSED (${passed.length} checks)`)
process.exit(0)
