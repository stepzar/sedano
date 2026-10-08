#!/usr/bin/env bun
/**
 * The app as a paired iPhone sees it, through a real remote-mode server: the
 * tailnet name in X-Forwarded-Host, a device token from a real pairing, and
 * WebKit with iPhone 15 emulation. A fake tailscale CLI stands in for the real
 * one, so nothing outside the temporary store is touched.
 *
 * - the phone never sees Settings → Remote access, not even while the server
 *   is still answering "who am I" (the answer is held back on purpose);
 * - on the Mac the section is there and reads the live status;
 * - a management endpoint that is refused or unreachable says so in words,
 *   never Safari's "Load failed".
 *
 *   bun scripts/remote-ui-test.ts
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, devices, webkit, type Page } from 'playwright'
import { installExitHandlers, ROOT, runCleanups, seedStore, startApi, tempHome } from './lib/harness.ts'

installExitHandlers()
const failures: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const NAME = 'sedano.tail-test.ts.net'
const LOGIN = 'me@example.com'

const { home, env } = tempHome('remote-ui')
const fakes = join(home, 'fakes')
mkdirSync(fakes, { recursive: true })
const install = (name: string, target: string): string => {
  const path = join(fakes, name)
  writeFileSync(path, `#!/bin/sh\nexec ${process.execPath} ${target} "$@"\n`)
  chmodSync(path, 0o755)
  return path
}
const fixture = (file: string) => join(import.meta.dir, 'fixtures', file)
writeFileSync(join(fakes, 'state.json'), JSON.stringify({ backendState: 'Running', dnsName: NAME, login: LOGIN, serve: {} }))
const daemonBin = join(fakes, 'tailscaled')
writeFileSync(daemonBin, '#!/bin/sh\nexit 1\n')
chmodSync(daemonBin, 0o755)

/** Opens Settings and reports what the remote section looks like right then. */
async function settingsView(page: Page, settle: number) {
  await page.locator('.bar .settings-btn').click()
  await page.waitForTimeout(settle)
  return page.evaluate(() => ({
    nav: [...document.querySelectorAll('.settings-nav-item')].some((node) => /Remote access/.test(node.textContent ?? '')),
    panel: document.querySelectorAll('.remote-panel').length,
    text: /iPhone and other devices|Load failed/.test(document.querySelector('.settings')?.textContent ?? ''),
  }))
}

try {
  await seedStore(env, ROOT)
  const api = await startApi({
    ...env,
    FAKE_TS_ROOT: fakes,
    SEDANO_TAILSCALE: install('tailscale', fixture('fake-tailscale.ts')),
    SEDANO_TAILSCALED: daemonBin,
    SEDANO_LAUNCHCTL: install('launchctl', fixture('fake-launchctl.ts')),
    SEDANO_LAUNCH_AGENTS_DIR: join(home, 'LaunchAgents'),
  })
  const local = (path: string, body: unknown = {}) =>
    fetch(`${api.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const tailnet = { 'x-forwarded-host': NAME, 'x-forwarded-proto': 'https', 'x-forwarded-for': '100.64.0.9', 'tailscale-user-login': LOGIN }

  // Remote mode on, then a real pairing: the phone's token comes from the server.
  await local('/api/remote', { enabled: true, allowedLogin: LOGIN })
  const code = (await (await local('/api/remote/pairing')).json()) as { code: string }
  const paired = await fetch(`${api.url}/api/remote/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: `https://${NAME}`, ...tailnet },
    body: JSON.stringify({ code: code.code, name: 'Test iPhone' }),
  })
  const token = (paired.headers.get('set-cookie') ?? '').split(';')[0]!
  check('the phone pairs with a real code', paired.ok && token.startsWith('__Host-sedano_device='), paired.status)

  /* ---------------- the phone ---------------- */
  const phone = await webkit.launch()
  try {
    const context = await phone.newContext({
      ...devices['iPhone 15'],
      viewport: { width: 393, height: 852 },
      // What tailscale serve adds, and the cookie Safari would send on https.
      extraHTTPHeaders: { ...tailnet, origin: `https://${NAME}`, cookie: token },
    })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    // "Who am I" answers late, so Settings opens while it is still unknown.
    await page.route('**/api/remote/me', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2_500))
      await route.continue()
    })
    await page.goto(api.url, { waitUntil: 'domcontentloaded' })
    await page.locator('.bar .settings-btn').waitFor()
    const early = await settingsView(page, 200)
    check('phone: no Remote access while the server has not answered yet', !early.nav && !early.panel && !early.text, early)
    await page.waitForTimeout(3_000)
    const late = await page.evaluate(() => ({
      nav: [...document.querySelectorAll('.settings-nav-item')].some((node) => /Remote access/.test(node.textContent ?? '')),
      panel: document.querySelectorAll('.remote-panel').length,
    }))
    check('phone: none once it has said this is a paired device', !late.nav && !late.panel, late)
    const me = await page.evaluate(async () => (await fetch('/api/remote/me')).json())
    check('phone: the server does see a paired remote device', me.remote === true && me.device?.name === 'Test iPhone', me)
    const refused = await page.evaluate(async () => (await fetch('/api/remote')).status)
    check('phone: management is refused to it (403)', refused === 403, refused)
    await page.screenshot({ path: '.playwright-mcp/remote-iphone-settings.png' })
    check('phone: the page raised no errors', errors.length === 0, errors)
    await context.close()
  } finally {
    await phone.close()
  }

  /* ---------------- the Mac ---------------- */
  const mac = await chromium.launch({ channel: 'chrome' })
  try {
    const page = await mac.newPage({ viewport: { width: 1280, height: 860 } })
    await page.goto(api.url, { waitUntil: 'networkidle' })
    await page.waitForTimeout(400)
    await settingsView(page, 300)
    await page.locator('.settings-nav-item', { hasText: 'Remote access' }).click()
    await page.locator('.remote-panel .remote-heading').first().waitFor({ timeout: 10_000 })
    const devices = await page.locator('.remote-devices li').count()
    check('Mac: Remote access reads the live status, with the paired phone', devices === 1, devices)
    await page.locator('.settings').screenshot({ path: '.playwright-mcp/remote-mac-settings.png' })

    // Refused or unreachable: words, not "Load failed".
    await page.keyboard.press('Escape')
    await page.route('**/api/remote', (route) => route.abort('failed'))
    await settingsView(page, 300)
    await page.locator('.settings-nav-item', { hasText: 'Remote access' }).click()
    await page.waitForTimeout(500)
    const message = (await page.locator('.remote-panel').first().textContent()) ?? ''
    check('Mac: an unreachable endpoint is explained, not "Load failed"', /only be managed on the Mac/.test(message) && !/Load failed|Failed to fetch/.test(message), message)
  } finally {
    await mac.close()
  }
} catch (error) {
  failures.push(error instanceof Error ? error.stack ?? error.message : String(error))
} finally {
  await runCleanups()
}

if (failures.length) {
  console.error(`\nremote-ui-test: FAILED\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('\nremote-ui-test: PASSED')
