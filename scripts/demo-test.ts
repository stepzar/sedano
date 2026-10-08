#!/usr/bin/env bun
/**
 * The website demo (`apps/ui/src/demo/`) in a real browser: it builds the demo
 * bundle into a temporary folder, serves it under `/demo/` on a free port with
 * nothing else behind it (so any real `/api` request would fail and be
 * counted), and walks the tour a visitor would take — seeded sessions, a
 * streamed reply, a permission allowed and one denied, a question answered, a
 * prompt queued behind a running turn, an interrupt, Settings changing the
 * theme and the sidebar for good, the limits panel, a terminal, the query
 * parameters and deep links, the bridge to a framing page (live theme both
 * ways, `sedano:goto`), the phone layout, and `?phone=1` forcing it in a
 * desktop browser. Zero console errors, zero failed requests.
 *
 *   bun scripts/demo-test.ts            # builds into a temp dir
 *   DEMO_DIR=apps/site/public/demo bun scripts/demo-test.ts   # tests a built copy
 *
 * Screenshots go to /tmp/sedano-demo-qa/ (or SEDANO_QA_DIR).
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium, devices, type Page } from 'playwright'
import { ROOT, installExitHandlers, onCleanup, runCleanups } from './lib/harness.ts'

installExitHandlers()
const failures: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const qa = process.env.SEDANO_QA_DIR ?? '/tmp/sedano-demo-qa'
mkdirSync(qa, { recursive: true })

let dir = process.env.DEMO_DIR ? resolve(process.env.DEMO_DIR) : ''
if (!dir) {
  dir = mkdtempSync(join(tmpdir(), 'sedano-demo-'))
  onCleanup(() => rmSync(dir, { recursive: true, force: true }))
  const build = Bun.spawnSync([process.execPath, 'run', 'build:demo'], { cwd: ROOT, env: { ...process.env, SEDANO_DEMO_OUT: dir }, stdout: 'pipe', stderr: 'pipe' })
  if (build.exitCode !== 0) {
    console.error(build.stderr.toString())
    throw new Error('build:demo failed')
  }
}

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const { pathname } = new URL(request.url)
    if (!pathname.startsWith('/demo/')) return new Response('not here', { status: 404 })
    const file = Bun.file(join(dir, decodeURIComponent(pathname.slice('/demo/'.length)) || 'index.html'))
    return (await file.exists()) ? new Response(file) : new Response('missing', { status: 404 })
  },
})
onCleanup(() => server.stop(true))
const base = `http://127.0.0.1:${server.port}/demo/`

const problems: string[] = []
function watch(page: Page, label: string): void {
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`${label} console: ${message.text()}`)
  })
  page.on('pageerror', (error) => problems.push(`${label} pageerror: ${error.message}`))
  page.on('requestfailed', (request) => problems.push(`${label} failed: ${request.url()}`))
  page.on('response', (response) => {
    if (response.status() >= 400) problems.push(`${label} HTTP ${response.status()}: ${response.url()}`)
  })
}

const pending = '.question.request[data-request-state="pending"]'
const transcriptText = (page: Page) => page.evaluate(() => (document.querySelector('.transcript') as HTMLElement | null)?.innerText ?? '')
const idle = (page: Page, timeout = 30_000) =>
  page.waitForFunction(() => !document.querySelector('.composer textarea')?.getAttribute('placeholder')?.includes('Esc'), null, { timeout })

async function send(page: Page, text: string): Promise<void> {
  const field = page.locator('.composer textarea')
  await field.click()
  await field.fill(text)
  await page.keyboard.press('Enter')
}

/** Click a rail row, unfolding "Show N more" first when the row sits below the fold
 *  (the two deep-link sessions waiting on a card are the workspace's newest). */
async function openFromRail(page: Page, title: string): Promise<void> {
  const row = page.locator('.rail').getByText(title).first()
  if (!(await row.isVisible())) await page.locator('.rail').getByText(/^Show \d+ more$/).first().click()
  await row.click()
}

const browser = await chromium.launch({ channel: 'chrome' })
onCleanup(() => browser.close())

try {
  /* ---------------- desktop ---------------- */
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage()
  watch(page, 'desktop')
  await page.goto(`${base}?theme=light`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.tabs .tab', { timeout: 15_000 })
  check('seeded tabs are open', (await page.locator('.tabs .tab').count()) >= 3)
  check('?theme=light applies', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'light')
  check('the demo notice is shown', await page.locator('.demo-pill').isVisible())
  check('robots are told not to index', (await page.locator('meta[name="robots"]').getAttribute('content')) === 'noindex')
  await page.screenshot({ path: `${qa}/desktop-load.png` })

  // A seeded session in another harness, opened from the rail.
  await openFromRail(page, 'Stream the CSV importer')
  await page.waitForFunction(() => document.querySelector('.transcript')?.textContent?.includes('Peak memory'), null, { timeout: 10_000 })
  check('a seeded Codex session opens with its history', true)
  await page.screenshot({ path: `${qa}/desktop-codex.png` })

  // A streamed reply, a queued prompt and a permission allowed.
  await page.locator('.tabs .tab[data-tab-id="demo-claude"]').click()
  await page.waitForTimeout(400)
  await send(page, 'fix the expiry bug')
  const lengths: number[] = []
  for (let i = 0; i < 14; i++) {
    lengths.push((await transcriptText(page)).length)
    await page.waitForTimeout(180)
  }
  const growth = lengths.filter((value, index) => index > 0 && value > lengths[index - 1]!).length
  check('the reply streams in (the transcript grows step by step)', growth >= 4, lengths)
  await send(page, 'write tests for the orders route')
  await page.waitForFunction(() => document.querySelector('.transcript')?.textContent?.includes('Queued'), null, { timeout: 5_000 })
  check('a prompt sent mid-turn is queued', true)
  await page.screenshot({ path: `${qa}/desktop-queued.png` })
  await page.waitForSelector(`${pending}:has-text("Permission")`, { timeout: 20_000 })
  await page.screenshot({ path: `${qa}/desktop-permission.png` })
  await page.locator(pending).getByText('Allow once').click()
  await page.waitForFunction(() => document.querySelector('.transcript')?.textContent?.includes('passes deterministically'), null, { timeout: 30_000 })
  check('allowing the permission lets the turn finish', (await transcriptText(page)).includes('bun run db:reset'))

  // The queued prompt runs next and asks a question.
  await page.waitForSelector(`${pending}:has-text("Question")`, { timeout: 30_000 })
  check('the queued prompt starts on its own', true)
  await page.screenshot({ path: `${qa}/desktop-question.png` })
  await page.locator(pending).getByText('Both (recommended)').click()
  await page.waitForFunction(() => document.querySelector('.transcript')?.textContent?.includes('exercise the router'), null, { timeout: 40_000 })
  check('answering the question continues the turn', (await transcriptText(page)).includes('Covering both'))
  await idle(page)

  // A permission denied takes the other branch.
  await send(page, 'there is still a bug in expiry')
  await page.waitForSelector(`${pending}:has-text("Permission")`, { timeout: 20_000 })
  await page.locator(pending).getByText('Deny', { exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.transcript')?.textContent?.includes('leave the database alone'), null, { timeout: 20_000 })
  check('denying the permission takes the other path', true)
  await idle(page)

  // Esc interrupts a running turn.
  await send(page, 'explain the auth middleware')
  await page.waitForTimeout(1_200)
  await page.keyboard.press('Escape')
  await idle(page, 8_000)
  check('Esc interrupts the turn', !(await transcriptText(page)).includes('An attacker without a token'))
  await page.screenshot({ path: `${qa}/desktop-interrupted.png` })

  // Settings: theme and sidebar, applied and kept across a reload.
  await page.locator('.settings-btn').click()
  await page.locator('[title="Theme"]').first().click()
  await page.locator('.menu-item', { hasText: 'Dark' }).first().click()
  await page.waitForTimeout(200)
  check('Settings switches the theme', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark')
  await page.locator('.settings-nav-item', { hasText: 'Interface' }).click()
  await page.locator('button[role="switch"][aria-label="Sidebar"]').click()
  await page.waitForTimeout(200)
  await page.screenshot({ path: `${qa}/desktop-settings.png` })
  await page.keyboard.press('Escape')
  check('Settings hides the sidebar', await page.locator('.body.rail-hidden').count() === 1)
  await page.goto(base, { waitUntil: 'networkidle' })
  await page.waitForSelector('.tabs .tab')
  check('the choices survive a reload', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark' && (await page.locator('.body.rail-hidden').count()) === 1)
  await page.keyboard.press('Meta+b')
  await page.waitForTimeout(200)
  check('⌘B brings the sidebar back', (await page.locator('.body.rail-hidden').count()) === 0)

  // The limits panel.
  await page.locator('.statusbar button', { hasText: 'LIMITS' }).first().click()
  await page.waitForTimeout(400)
  check('the limits panel opens with readings', (await page.getByText('Max 20x').count()) > 0)
  await page.screenshot({ path: `${qa}/desktop-limits-dark.png` })
  await page.keyboard.press('Escape')

  // The palette, a new agent tab and the folder chip's workspace menu.
  await page.keyboard.press('Meta+k')
  await page.waitForTimeout(300)
  check('⌘K opens the palette', (await page.locator('.palette').count()) > 0)
  await page.keyboard.press('Escape')
  await page.keyboard.press('Meta+d')
  await page.waitForSelector('.launchpad', { timeout: 5_000 })
  await page.locator('.launchpad').getByText('acme-api', { exact: true }).first().click()
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${qa}/desktop-folder-menu.png` })
  await page.keyboard.press('Escape')

  // A brand-new session launched from the launchpad gets a reply.
  await page.locator('.launchpad textarea').fill('hello there')
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.querySelector('.transcript')?.textContent?.includes('scripted demo'), null, { timeout: 20_000 })
  check('a new session launched from the launchpad replies', true)

  // A terminal tab.
  await openFromRail(page, 'Terminal · Shell · acme-api')
  await page.waitForSelector('.xterm', { timeout: 5_000 })
  await page.waitForTimeout(800)
  await page.locator('.xterm').last().click()
  await page.keyboard.type('git log')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(500)
  check('the terminal answers', (await page.locator('.xterm-rows').last().innerText()).includes('Rate-limit POST'))
  await page.screenshot({ path: `${qa}/desktop-terminal.png` })
  await context.close()

  /* ---------------- query parameters ---------------- */
  const direct = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  watch(direct, 'params')
  await direct.goto(`${base}?session=demo-gemini&theme=dark&embed=1`, { waitUntil: 'networkidle' })
  await direct.waitForFunction(() => document.querySelector('.tabs .tab.active')?.getAttribute('data-tab-id') === 'demo-gemini', null, { timeout: 10_000 })
  check('?session= opens that session', true)
  check('?embed=1 is recognised', (await direct.evaluate(() => document.documentElement.dataset.demoEmbed)) === '1')
  await direct.screenshot({ path: `${qa}/params-gemini-dark.png` })

  // The landing page's deep links: each lands on its moment with no clicks.
  await direct.goto(`${base}?session=demo-question&theme=light`, { waitUntil: 'networkidle' })
  await direct.waitForSelector(`${pending}:has-text("Which cases")`, { timeout: 10_000 })
  check('?session=demo-question lands on a waiting question', true)
  await direct.goto(`${base}?session=demo-permission`, { waitUntil: 'networkidle' })
  await direct.waitForSelector(`${pending}:has-text("bun add zod")`, { timeout: 10_000 })
  await direct.locator(pending).getByText('Allow once').click()
  await direct.waitForFunction(() => document.querySelector('.transcript')?.textContent?.includes('Upgraded'), null, { timeout: 20_000 })
  check('?session=demo-permission lands on a permission that can be allowed', true)
  await direct.goto(`${base}?session=demo-question&panel=limits`, { waitUntil: 'networkidle' })
  await direct.waitForFunction(() => document.body.textContent?.includes('Max 20x'), null, { timeout: 10_000 })
  check('?panel=limits opens the limits panel', true)
  // The Esc that closes a menu is the menu's: the waiting turn keeps running.
  await direct.waitForSelector(pending, { timeout: 10_000 })
  await direct.keyboard.press('Escape')
  await direct.waitForTimeout(600)
  check('Esc closes the limits panel without interrupting the turn', !(await direct.evaluate(() => document.body.textContent?.includes('Max 20x'))) && (await direct.locator(pending).count()) === 1)
  await direct.close()

  /* ---------------- framed by a page (the landing's bridge) ---------------- */
  type Seen = { type?: string; theme?: string; liveTheme?: boolean }
  const host = await browser.newPage({ viewport: { width: 1200, height: 800 } })
  watch(host, 'framed')
  // A page on the demo's own origin, like the landing page.
  await host.goto(`${base}?session=demo-gemini`, { waitUntil: 'networkidle' })
  await host.evaluate((src) => {
    const seen: unknown[] = []
    ;(window as unknown as { seen: unknown[] }).seen = seen
    window.addEventListener('message', (event) => seen.push(event.data))
    document.body.innerHTML = `<iframe id="demo" src="${src}" style="width:1100px;height:700px;border:0"></iframe>`
  }, `${base}?embed=1&theme=light`)
  const received = (wanted: Seen) =>
    host.waitForFunction(
      (w) => (window as unknown as { seen: Seen[] }).seen.some((m) => Object.entries(w).every(([k, v]) => (m as Record<string, unknown>)[k] === v)),
      wanted,
      { timeout: 15_000 },
    )
  await received({ type: 'sedano-demo:ready', liveTheme: true })
  check('the framed demo says it is ready, with a live theme', true)
  const frame = host.frames().find((f) => f.url().includes('embed=1'))!
  await frame.waitForSelector('.tabs .tab', { timeout: 15_000 })
  const post = (message: object) =>
    host.evaluate((m) => (document.getElementById('demo') as HTMLIFrameElement).contentWindow!.postMessage(m, location.origin), message)
  await post({ type: 'sedano:theme', theme: 'dark' })
  await frame.waitForFunction(() => document.documentElement.dataset.theme === 'dark', null, { timeout: 3_000 })
  check('sedano:theme switches the framed demo live (no reload)', (await frame.evaluate(() => performance.getEntriesByType('navigation').length)) === 1 && frame.url().includes('theme=light'))
  await post({ type: 'sedano:goto', session: 'demo-question' })
  await frame.waitForSelector(`${pending}:has-text("Which cases")`, { timeout: 10_000 })
  check('sedano:goto opens a session live', true)
  await post({ type: 'sedano:goto', panel: 'limits' })
  await frame.waitForFunction(() => document.body.textContent?.includes('Max 20x'), null, { timeout: 10_000 })
  check('sedano:goto opens the limits panel live', true)
  await host.screenshot({ path: `${qa}/framed-limits-dark.png` })
  await frame.press('body', 'Escape')
  // A theme picked in the demo's own Settings is reported to the page.
  await frame.locator('.settings-btn').click()
  await frame.locator('[title="Theme"]').first().click()
  await frame.locator('.menu-item', { hasText: 'Light' }).first().click()
  await received({ type: 'sedano-demo:theme', theme: 'light' })
  check('a theme picked in the demo is reported to the page', true)
  // A message from another origin is ignored.
  const foreign = await frame.evaluate(() => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'sedano:theme', theme: 'dark' }, origin: 'https://evil.example', source: window.parent }))
    return document.documentElement.dataset.theme
  })
  check('a message from another origin is ignored', foreign === 'light')
  await host.close()

  /* ---------------- phone ---------------- */
  const phone = await browser.newContext({ ...devices['iPhone 13'], viewport: { width: 390, height: 844 } })
  const mobile = await phone.newPage()
  watch(mobile, 'phone')
  await mobile.goto(`${base}?theme=light`, { waitUntil: 'networkidle' })
  await mobile.waitForSelector('.composer textarea', { timeout: 15_000 })
  check('no sideways overflow on a phone', (await mobile.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0)
  await mobile.screenshot({ path: `${qa}/phone-load.png` })
  await mobile.locator('.composer textarea').tap()
  await mobile.locator('.composer textarea').fill('refactor the order handler')
  await mobile.locator('.composer textarea').press('Enter')
  await mobile.waitForFunction(() => document.querySelector('.transcript')?.textContent?.includes('same behaviour'), null, { timeout: 30_000 })
  check('a prompt sent on a phone gets its reply', true)
  await mobile.screenshot({ path: `${qa}/phone-reply.png` })
  await phone.close()

  /* ---------------- ?phone=1 in a desktop browser (the landing's phone mockup) ---------------- */
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const mock = await desk.newPage()
  watch(mock, 'phone=1')
  await mock.goto(`${base}?theme=light`, { waitUntil: 'networkidle' })
  await mock.evaluate((src) => {
    document.body.innerHTML = `<iframe id="demo" src="${src}" style="width:402px;height:874px;border:0"></iframe>`
  }, `${base}?embed=1&phone=1&theme=dark`)
  const phoneFrame = await (await mock.waitForSelector('#demo')).contentFrame()
  await phoneFrame!.waitForSelector('.composer textarea', { timeout: 15_000 })
  const layout = await phoneFrame!.evaluate(() => {
    const root = document.documentElement
    const bar = document.querySelector('.bar')!.getBoundingClientRect()
    const statusbar = document.querySelector('.statusbar')
    return {
      marked: root.dataset.demoPhone === '1',
      coarse: matchMedia('(pointer: coarse)').matches && !matchMedia('(hover: hover)').matches,
      uiFont: getComputedStyle(root).getPropertyValue('--ui-font-size').trim(),
      appFixed: getComputedStyle(document.querySelector('.app')!).position === 'fixed',
      drawerRail: document.querySelector('.body.rail-hidden') !== null,
      kbdHidden: [...document.querySelectorAll('kbd')].every((k) => (k as HTMLElement).offsetParent === null),
      barTop: getComputedStyle(document.querySelector('.bar')!).paddingTop,
      barHeight: bar.height,
      statusbarBottom: statusbar ? getComputedStyle(statusbar).paddingBottom : null,
      overflow: document.documentElement.scrollWidth - innerWidth,
    }
  })
  check('?phone=1 marks the page as a phone', layout.marked)
  check('?phone=1 answers touch media queries as a phone does', layout.coarse)
  check("?phone=1 loads the phone's appearance profile (15px interface)", layout.uiFont === '15px', layout.uiFont)
  check('?phone=1 at 402×874 renders the mobile layout (fixed app, rail as a closed drawer)', layout.appFixed && layout.drawerRail, layout)
  check('?phone=1 hides keyboard hints, like a phone', layout.kbdHidden)
  check('?embed=1&phone=1 puts the top bar under a 62px status-bar safe area', layout.barTop === '62px' && layout.barHeight >= 62 + 44, layout)
  check('?embed=1&phone=1 keeps the status bar clear of the home indicator', layout.statusbarBottom === '20px', layout.statusbarBottom)
  check('?phone=1 has no sideways overflow', layout.overflow <= 0, layout.overflow)
  await phoneFrame!.locator('.composer textarea').click()
  await phoneFrame!.locator('.composer textarea').fill('refactor the order handler')
  await phoneFrame!.locator('.composer textarea').press('Enter')
  await phoneFrame!.waitForFunction(() => document.querySelector('.transcript')?.textContent?.includes('same behaviour'), null, { timeout: 30_000 })
  check('?phone=1 takes clicks and typing and streams the reply', true)
  await mock.screenshot({ path: `${qa}/phone-param-embedded.png`, clip: { x: 0, y: 0, width: 402, height: 874 } })

  // Opened full screen on a wide desktop: a phone-sized stage around the demo.
  await mock.goto(`${base}?phone=1&theme=light`, { waitUntil: 'networkidle' })
  const hosted = await (await mock.waitForSelector('.demo-phone-host iframe', { timeout: 10_000 })).contentFrame()
  await hosted!.waitForSelector('.composer textarea', { timeout: 15_000 })
  check(
    '/demo/?phone=1 on a wide screen frames the phone layout',
    (await mock.locator('.app').count()) === 0 && (await hosted!.evaluate(() => getComputedStyle(document.querySelector('.app')!).position)) === 'fixed',
  )
  await mock.screenshot({ path: `${qa}/phone-param-host.png` })
  await desk.close()
} catch (error) {
  failures.push(`the walk stopped: ${error instanceof Error ? error.message : String(error)}`)
}

check('no console errors and no failed requests', problems.length === 0, problems)
await runCleanups()
if (failures.length) {
  console.error(`\n${failures.length} demo check(s) failed:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log(`\ndemo ok — screenshots in ${qa}`)
