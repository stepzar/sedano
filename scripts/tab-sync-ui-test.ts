#!/usr/bin/env bun
/**
 * Open tabs are shared between devices: a desktop window (Chrome, 1360×880)
 * and an iPhone (WebKit, touch) against one throwaway server.
 *
 * - a tab opened on the desktop shows up on the phone, live;
 * - a reorder sent by the phone moves the desktop's strip, and a drag on the
 *   desktop moves the phone's list;
 * - closing on the desktop closes on the phone, and the phone's own tab on
 *   screen falls to its neighbour (none left: no tab);
 * - a reload keeps the list, on both;
 * - a device with tabs from before sharing merges them in once (a union that
 *   keeps order), and never again.
 *
 * Only fixture agent sessions are opened, so no harness or shell is started.
 *
 *   bun scripts/tab-sync-ui-test.ts
 */
import { chromium, devices, webkit, type Page } from 'playwright'
import { installExitHandlers, runCleanups } from './lib/harness.ts'
import { resolveApp, expandRail } from './lib/app.ts'

installExitHandlers()
const failures: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

async function until<T>(read: () => Promise<T>, ok: (value: T) => boolean, timeout = 4000): Promise<T> {
  const end = Date.now() + timeout
  let value = await read()
  while (!ok(value) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    value = await read()
  }
  return value
}

const same = (a: Array<string | null>, b: Array<string | null>) => a.length === b.length && a.every((id, i) => id === b[i])

/** The desktop strip, left to right. */
const strip = (page: Page) =>
  page.locator('.tabs .tab').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-tab-id')))

/** The phone's tabs and the one on screen, read from its tab switcher. */
async function phoneTabs(page: Page): Promise<{ ids: Array<string | null>; current: string | null }> {
  await page.locator('.tabs .tab-current').tap()
  await page.waitForSelector('.switcher')
  const read = await page.evaluate(() => ({
    ids: [...document.querySelectorAll('.switcher-card')].map((card) => card.getAttribute('data-tab-id')),
    current: document.querySelector('.switcher-card.current')?.getAttribute('data-tab-id') ?? null,
  }))
  await page.locator('.switcher-head .round-close').tap()
  await page.waitForSelector('.switcher', { state: 'detached' })
  return read
}

/** Pick a tab on the phone, through its switcher. */
async function phoneSelect(page: Page, id: string): Promise<void> {
  await page.locator('.tabs .tab-current').tap()
  await page.locator(`.switcher-card[data-tab-id="${id}"]`).tap()
  await page.waitForSelector('.switcher', { state: 'detached' })
}

/** Send one tab op through the page's own socket, as a phone gesture would. */
async function sendFromPage(page: Page, op: unknown): Promise<void> {
  await page.evaluate((op) => {
    const ws = ((window as any).__ws as WebSocket[]).find((socket) => socket.url.includes('/api/ws') && socket.readyState === 1)!
    ws.send(JSON.stringify({ t: 'tabs', op, cid: crypto.randomUUID() }))
  }, op)
}

const target = await resolveApp()
const state = (await (await fetch(new URL('/api/state', target.url))).json()) as { sessions: Array<{ id: string; kind: string }> }
const agents = state.sessions.filter((session) => session.kind === 'agent').map((session) => session.id)
if (agents.length < 5) throw new Error(`the fixtures need five agent sessions, found ${agents.length}`)

const desktopBrowser = await chromium.launch({ channel: 'chrome' })
const phoneBrowser = await webkit.launch()
try {
  const errors: string[] = []
  const desktop = await (await desktopBrowser.newContext({ viewport: { width: 1360, height: 880 } })).newPage()
  const { defaultBrowserType: _type, ...iphone } = devices['iPhone 15']!
  const phoneContext = await phoneBrowser.newContext(iphone)
  // The phone's socket, reachable from the test (see `sendFromPage`).
  await phoneContext.addInitScript(() => {
    const Native = window.WebSocket
    const w = window as any
    w.__ws = []
    window.WebSocket = class extends Native {
      constructor(...args: any[]) {
        super(...(args as [string]))
        w.__ws.push(this)
      }
    } as any
  })
  const phone = await phoneContext.newPage()
  for (const page of [desktop, phone]) page.on('pageerror', (error) => errors.push(error.message))

  await desktop.goto(target.url, { waitUntil: 'networkidle' })
  await desktop.waitForTimeout(600)
  if (!(await desktop.locator('.rail .session-item:not(.draft)').count())) {
    await desktop.locator('.rail-title.workspace').first().click()
    await desktop.waitForTimeout(250)
  }
  await expandRail(desktop)
  const agentRows = desktop.locator('.rail .session-item:not(.draft)').filter({ hasNotText: /terminal/i })
  const openNth = async (index: number) => {
    await agentRows.nth(index).click()
    await desktop.waitForTimeout(200)
  }
  await openNth(0)
  await openNth(1)
  await openNth(2)
  const desktopOpen = await strip(desktop)
  check('desktop: three tabs are open', desktopOpen.length === 3, desktopOpen)

  /* The phone sees them -------------------------------------------------- */
  await phone.goto(target.url, { waitUntil: 'networkidle' })
  await phone.waitForTimeout(700)
  let onPhone = await phoneTabs(phone)
  check('phone: opens with the desktop\'s tabs, in order', same(onPhone.ids, desktopOpen), { onPhone, desktopOpen })

  // Live: a fourth tab opened on the desktop while the phone is connected.
  await openNth(3)
  const fourOnDesktop = await strip(desktop)
  onPhone = await until(() => phoneTabs(phone), (value) => value.ids.length === 4)
  check('phone: a tab opened on the desktop appears, live', same(onPhone.ids, fourOnDesktop), { onPhone, fourOnDesktop })

  /* Reorder --------------------------------------------------------------- */
  const [first, second, third, fourth] = fourOnDesktop as string[]
  await sendFromPage(phone, { op: 'move', id: fourth, target: first, after: false })
  const expected = [fourth, first, second, third]
  const reordered = await until(() => strip(desktop), (value) => same(value, expected))
  check('desktop: a reorder from the phone moves the strip', same(reordered, expected), { reordered, expected })
  onPhone = await phoneTabs(phone)
  check('phone: and its own list agrees', same(onPhone.ids, expected), onPhone)

  // Drag on the desktop: the first tab past the second.
  const tabs = desktop.locator('.tabs .tab')
  const source = (await tabs.nth(0).boundingBox())!
  const over = (await tabs.nth(1).boundingBox())!
  await desktop.mouse.move(source.x + source.width / 2, source.y + source.height / 2)
  await desktop.mouse.down()
  const endX = over.x + over.width * 0.9
  for (let step = 1; step <= 10; step += 1) {
    await desktop.mouse.move(source.x + source.width / 2 + ((endX - source.x - source.width / 2) * step) / 10, source.y + source.height / 2)
    await desktop.waitForTimeout(20)
  }
  await desktop.mouse.up()
  await desktop.waitForTimeout(300)
  const dragged = await strip(desktop)
  check('desktop: the drag moved the tab', dragged[1] === fourth, dragged)
  onPhone = await until(() => phoneTabs(phone), (value) => same(value.ids, dragged))
  check('phone: a drag on the desktop reorders the phone\'s list', same(onPhone.ids, dragged), { onPhone, dragged })

  /* Close, and the phone's tab on screen falls back ----------------------- */
  const phoneActive = dragged[2]!
  await phoneSelect(phone, phoneActive)
  onPhone = await phoneTabs(phone)
  check('phone: picked a tab of its own', onPhone.current === phoneActive, onPhone)
  const desktopActive = await desktop.locator('.tabs .tab.active').getAttribute('data-tab-id')
  await desktop.locator(`.tabs .tab[data-tab-id="${phoneActive}"] .x`).click()
  const neighbour = dragged[3]
  onPhone = await until(() => phoneTabs(phone), (value) => !value.ids.includes(phoneActive))
  check('phone: a tab closed on the desktop closes on the phone', !onPhone.ids.includes(phoneActive) && onPhone.ids.length === 3, onPhone)
  check('phone: its tab on screen falls to the neighbour', onPhone.current === neighbour, { onPhone, neighbour })
  check(
    'desktop: which tab is on screen stays its own',
    desktopActive !== phoneActive && (await desktop.locator('.tabs .tab.active').getAttribute('data-tab-id')) === desktopActive,
    { desktopActive, phoneActive },
  )

  /* Reload keeps the list ------------------------------------------------- */
  const beforeReload = await strip(desktop)
  await phone.reload({ waitUntil: 'networkidle' })
  await phone.waitForTimeout(700)
  onPhone = await phoneTabs(phone)
  check('phone: a reload keeps the shared list', same(onPhone.ids, beforeReload), { onPhone, beforeReload })
  await desktop.reload({ waitUntil: 'networkidle' })
  await desktop.waitForTimeout(700)
  check('desktop: a reload keeps the shared list', same(await strip(desktop), beforeReload), await strip(desktop))

  /* A new-session tab is shared too --------------------------------------- */
  await desktop.keyboard.press('Meta+d')
  const draftId = await until(
    async () => (await strip(desktop)).find((id) => id?.startsWith('draft:')) ?? null,
    (value) => value !== null,
  )
  onPhone = await until(() => phoneTabs(phone), (value) => value.ids.includes(draftId))
  check('phone: a new-session tab opened on the desktop appears', Boolean(draftId) && onPhone.ids.includes(draftId), { draftId, onPhone })
  await desktop.locator(`.tabs .tab[data-tab-id="${draftId}"] .x`).click()
  onPhone = await until(() => phoneTabs(phone), (value) => !value.ids.includes(draftId))
  check('phone: and closes with it', !onPhone.ids.includes(draftId), onPhone)

  /* Closing everything leaves the phone with no tab ------------------------ */
  await phoneSelect(phone, onPhone.ids[0]!)
  for (const id of await strip(desktop)) {
    await desktop.locator(`.tabs .tab[data-tab-id="${id}"] .x`).click()
    await desktop.waitForTimeout(150)
  }
  onPhone = await until(() => phoneTabs(phone), (value) => value.ids.length === 0)
  check('phone: with every tab closed elsewhere, none is on screen', onPhone.ids.length === 0 && onPhone.current === null, onPhone)
  const bar = (await phone.locator('.tabs .tab-current .label').textContent()) ?? ''
  // Nothing left to fall back to: the phone is on the new-session screen.
  check('phone: and it is on the new-session screen', bar.includes('No tab') || bar.trim() === 'New Tab', bar)

  /* Migration: a device's pre-sharing tabs are merged in, once ------------ */
  await openNth(0)
  const serverBefore = await strip(desktop)
  const notOpen = agents.filter((id) => !serverBefore.includes(id))
  const legacyContext = await desktopBrowser.newContext({ viewport: { width: 1360, height: 880 } })
  const legacyTabs = [notOpen[0]!, serverBefore[0]!, notOpen[1]!, 'gone-session']
  await legacyContext.addInitScript((ids: string[]) => {
    if (sessionStorage.getItem('seeded')) return
    sessionStorage.setItem('seeded', '1')
    localStorage.setItem('sedano.tabs', JSON.stringify({ '/somewhere': ids }))
    localStorage.setItem('sedano.tab-order', JSON.stringify(ids))
  }, legacyTabs)
  const legacy = await legacyContext.newPage()
  legacy.on('pageerror', (error) => errors.push(error.message))
  await legacy.goto(target.url, { waitUntil: 'networkidle' })
  await legacy.waitForTimeout(800)
  // The server's tab first (it was there), each old tab right after the one it followed.
  const union = [notOpen[0]!, serverBefore[0]!, notOpen[1]!]
  const merged = await until(() => strip(desktop), (value) => same(value, union))
  check('migration: the old tabs are merged into the shared list, in order, minus a deleted session', same(merged, union), { merged, union })
  check('migration: the migrating device shows the union', same(await strip(legacy), union), await strip(legacy))
  onPhone = await until(() => phoneTabs(phone), (value) => same(value.ids, union))
  check('migration: the phone sees the union', same(onPhone.ids, union), onPhone)

  await desktop.locator(`.tabs .tab[data-tab-id="${notOpen[0]}"] .x`).click()
  await until(() => strip(legacy), (value) => !value.includes(notOpen[0]!))
  await legacy.reload({ waitUntil: 'networkidle' })
  await legacy.waitForTimeout(800)
  const afterReload = await strip(legacy)
  check('migration: only once — a merged tab closed elsewhere stays closed after a reload', !afterReload.includes(notOpen[0]!) && same(afterReload, await strip(desktop)), { afterReload, desktop: await strip(desktop) })

  await desktop.screenshot({ path: '.playwright-mcp/tab-sync-desktop.png' })
  await phone.screenshot({ path: '.playwright-mcp/tab-sync-phone.png' })
  check('no page raised an error', errors.length === 0, errors)
} catch (error) {
  failures.push(error instanceof Error ? error.stack ?? error.message : String(error))
} finally {
  await desktopBrowser.close()
  await phoneBrowser.close()
  await runCleanups()
}

if (failures.length) {
  console.error(`\ntab-sync-ui-test: FAILED\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('\ntab-sync-ui-test: PASSED')
