#!/usr/bin/env bun
/**
 * The shell on a desktop window and on an iPhone, against a throwaway store:
 *
 * - desktop: the location pill sits in the exact centre of the top bar and
 *   names only the project folder (full path in its tooltip), with the machine
 *   chip left of the name and the branch right of it; the rail's workspace
 *   headers carry no machine chip; Settings has a Remote access panel that
 *   draws a scannable QR of the pairing link;
 * - iPhone 15 (WebKit, touch, 393×852, a notch and a home indicator): no
 *   horizontal overflow, the rail is a drawer that a tap or an edge swipe
 *   opens and picking a session closes, the composer stays on screen when the
 *   keyboard shrinks the visual viewport, every touch target is at least
 *   44px, the minimap is gone, an image picked with the attach button becomes
 *   a chip, and a paired phone gets no Remote access section;
 * - any `/api/*` answered 401 reloads the page (the pairing page's way in).
 *
 * The remote-management endpoints are answered by the page itself here, so no
 * tailscale is asked and nothing is paired. Screenshots go to .playwright-mcp/.
 *
 *   bun scripts/mobile-ui-test.ts
 */
import { chromium, devices, webkit, type Browser, type Page } from 'playwright'
import { basename } from 'node:path'
import { installExitHandlers, runCleanups } from './lib/harness.ts'
import { openRichestSession, resetSharedTabs, resolveApp } from './lib/app.ts'

installExitHandlers()
const failures: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? '✓' : '✗'} ${label}`)
  if (!ok) failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const SHOTS = '.playwright-mcp'
const PAIRING_URL = 'https://sedano.tail1234.ts.net/?code=K7QM3XPA'
// A 1×1 PNG: the smallest picture the attachment pipeline will take.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate((theme) => {
    const raw = localStorage.getItem('sedano.settings')
    const settings = raw ? JSON.parse(raw) : {}
    localStorage.setItem('sedano.settings', JSON.stringify({ ...settings, theme }))
    document.documentElement.dataset.theme = theme
  }, theme)
}

/** Remote management, answered in the page: nothing reaches tailscale or pairs a device. */
async function fakeRemoteApi(page: Page, me: { remote: boolean }): Promise<void> {
  const status = {
    config: { enabled: true, hostname: null, allowedLogin: 'me@example.com', tailscale: { instance: 'dedicated', nodeName: 'sedano' } },
    hostname: { effective: 'sedano.tail1234.ts.net', detected: 'sedano.tail1234.ts.net', override: null },
    url: 'https://sedano.tail1234.ts.net/',
    devices: [{ id: 'dev1', name: 'iPhone', createdAt: Date.now() - 86_400_000, lastSeenAt: Date.now() - 120_000, login: 'me@example.com', userAgent: 'iPhone' }],
    pairing: { active: false, expiresAt: null },
  }
  const tailscale = {
    instance: 'dedicated',
    cli: '/opt/homebrew/bin/tailscale',
    daemon: { binary: '/opt/homebrew/bin/tailscaled', installed: true, loaded: true, plist: '', socket: '' },
    node: { reachable: true, backendState: 'Running', dnsName: 'sedano.tail1234.ts.net', login: 'me@example.com', tailnet: 'tail1234', authUrl: null, error: null },
    loginAllowed: true,
    serve: { active: true, url: 'https://sedano.tail1234.ts.net/', conflict: null, funnel: false },
    serveError: null,
  }
  await page.route('**/api/remote**', async (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })
    if (url.pathname === '/api/remote/me') return json(me)
    if (url.pathname === '/api/remote/tailscale') return json(tailscale)
    if (url.pathname === '/api/remote/pairing' && method === 'POST') {
      return json({ code: 'K7QM3XPA', display: 'K7QM-3XPA', url: PAIRING_URL, expiresAt: Date.now() + 300_000 })
    }
    if (url.pathname === '/api/remote') return json(status)
    return json({ ok: true })
  })
}

/** What the top bar shows, measured. */
function topBar(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>('.bar')!.getBoundingClientRect()
    const pill = document.querySelector<HTMLElement>('.location-pill')
    const rect = pill?.getBoundingClientRect()
    return {
      barCentre: bar.left + bar.width / 2,
      pillCentre: rect ? rect.left + rect.width / 2 : null,
      pillWidth: rect?.width ?? 0,
      pillInside: rect ? rect.left >= bar.left - 0.5 && rect.right <= bar.right + 0.5 : false,
      project: pill?.querySelector('.project-name')?.textContent ?? null,
      env: pill?.querySelector('.env-name')?.textContent ?? null,
      envBeforeName: Boolean(pill?.querySelector('.env-chip + .pill-search + .project-name, .env-chip ~ .project-name')),
      gitAfterName: pill?.querySelector('.project-name ~ .git-chip')?.textContent ?? null,
      title: pill?.getAttribute('title') ?? '',
    }
  })
}

async function desktopPass(browser: Browser, url: string, cwd: string): Promise<void> {
  for (const width of [1440, 1024]) {
    for (const theme of ['light', 'dark'] as const) {
      const page = await browser.newPage({ viewport: { width, height: 860 } })
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await fakeRemoteApi(page, { remote: false })
      // Every visit starts as a fresh device did before tabs were shared: none open.
      await resetSharedTabs(url)
      await page.goto(url, { waitUntil: 'networkidle' })
      await setTheme(page, theme)
      await page.reload({ waitUntil: 'networkidle' })
      await page.waitForTimeout(500)
      await openRichestSession(page)
      const bar = await topBar(page)
      const tag = `desktop ${width} ${theme}`
      check(`${tag}: the location pill is centred in the top bar`, bar.pillCentre !== null && Math.abs(bar.pillCentre - bar.barCentre) <= 1.5, bar)
      check(`${tag}: the pill names the project folder only`, bar.project === basename(cwd) && !bar.project.includes('/'), bar.project)
      check(`${tag}: the full path is in the tooltip`, bar.title.includes(cwd), bar.title)
      check(`${tag}: the machine chip is left of the name`, Boolean(bar.env) && bar.envBeforeName, bar)
      check(`${tag}: the pill is wide enough to read`, bar.pillWidth >= 300, bar.pillWidth)
      if (width === 1440 && theme === 'light') {
        const headerChips = await page.locator('.rail-title.workspace .chip').count()
        check(`${tag}: rail workspace headers carry no machine chip`, headerChips === 0, headerChips)
        const attach = await page.locator('.composer .attach-btn').count()
        check(`${tag}: the composer has an attach button`, attach === 1, attach)
        const handle = await page.locator('.statusbar .term-handle').evaluate((node) => ({
          text: node.textContent?.trim(),
          title: node.getAttribute('title') ?? '',
          square: Math.abs(node.getBoundingClientRect().width - node.getBoundingClientRect().height) < 0.5,
        }))
        check(`${tag}: the terminal toggle is an icon, its shortcut in the tooltip`, handle.text === '' && handle.title.includes('⌘J') && handle.square, handle)
        const bar = await page.locator('.tabs .row > .icon-btn').count()
        check(`${tag}: the desktop keeps its folder and star buttons on the tab bar`, bar === 2, bar)
        await page.locator('.location-pill').click()
        await page.keyboard.type('gre')
        await page.waitForTimeout(200)
        const marks = await page.locator('.palette-item mark.palette-match').allTextContents()
        check(`${tag}: search results mark what matched`, marks.length > 0 && marks.every((text) => text.toLowerCase() === 'gre'), marks)
        await page.keyboard.press('Escape')
        // Every tab closed: the new-tab chooser, not a folder picker.
        for (let guard = 0; guard < 12 && (await page.locator('.tabs .tab .x').count()); guard += 1) {
          await page.locator('.tabs .tab .x').first().click({ force: true })
          await page.waitForTimeout(150)
        }
        await page.waitForTimeout(300)
        const empty = await page.evaluate(() => ({
          title: document.querySelector('.launchpad-title')?.textContent ?? null,
          picker: Boolean(document.querySelector('.folder-picker')),
        }))
        check(`${tag}: with every tab closed the chooser is shown`, empty.title === 'What do you want to open?' && !empty.picker, empty)
        await openRichestSession(page)
      }
      await page.screenshot({ path: `${SHOTS}/shell-desktop-${width}-${theme}.png` })

      if (width === 1440) {
        // Settings → Remote access, with a pairing code on screen.
        await page.keyboard.press('Meta+,')
        await page.locator('.settings-nav-item', { hasText: 'Remote access' }).click()
        await page.locator('.remote-panel button', { hasText: 'New pairing code' }).click()
        await page.locator('.remote-qr').waitFor()
        const code = await page.locator('.remote-code').textContent()
        check(`${tag}: the pairing code is shown`, code === 'K7QM-3XPA', code)
        const devices = await page.locator('.remote-devices li').count()
        check(`${tag}: the paired device is listed with a revoke button`, devices === 1 && (await page.locator('.remote-devices button', { hasText: 'Revoke' }).count()) === 1)
        await page.locator('.settings').screenshot({ path: `${SHOTS}/shell-remote-settings-${theme}.png` })
        if (theme === 'light') await page.locator('.remote-qr').screenshot({ path: `${SHOTS}/shell-remote-qr.png` })
      }
      check(`${tag}: the page raised no errors`, errors.length === 0, errors)
      await page.close()
    }
  }
}

/**
 * A stand-in visual viewport: WebKit in Playwright has no on-screen keyboard,
 * so the test shrinks this one the way iOS shrinks the real one.
 */
const FAKE_VIEWPORT = `
  (() => {
    // Read live: before the viewport meta applies, innerHeight is the 980px
    // layout's, not the phone's.
    let keyboard = 0
    const fake = new EventTarget()
    Object.defineProperties(fake, {
      height: { get: () => window.innerHeight - keyboard },
      width: { get: () => window.innerWidth },
      offsetTop: { value: 0 },
      offsetLeft: { value: 0 },
      scale: { value: 1 },
    })
    Object.defineProperty(window, 'visualViewport', { get: () => fake, configurable: true })
    window.__keyboard = (px) => {
      keyboard = px
      fake.dispatchEvent(new Event('resize'))
    }
    // An iPhone 15's notch and home indicator (env() cannot be emulated).
    document.addEventListener('DOMContentLoaded', () => {
      document.documentElement.style.setProperty('--safe-top', '47px')
      document.documentElement.style.setProperty('--safe-bottom', '34px')
    })
  })()
`

/** Every element a thumb is expected to hit, with its size. */
function smallTargets(page: Page) {
  return page.evaluate(() => {
    const selectors = [
      '.bar .crumb',
      '.location-pill',
      '.bar-actions .icon-btn',
      '.tabs .rail-toggle',
      '.tabs .tab',
      '.tabs .tab .x',
      '.tabs .tab-add',
      '.tabs .row .icon-btn',
      '.tabs .row .select-trigger',
      '.composer .send',
      '.composer .attach-btn',
      '.composer .mic',
      '.composer-controls .select-trigger',
      '.composer .composer-options-toggle',
      '.rail.open .session-item',
      '.rail.open .rail-title.workspace',
      '.rail.open .rail-search input',
    ]
    const small: Array<{ selector: string; width: number; height: number; text: string }> = []
    let counted = 0
    for (const selector of selectors) {
      for (const node of document.querySelectorAll<HTMLElement>(selector)) {
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') continue
        counted += 1
        if (rect.width < 43.5 || rect.height < 43.5) {
          small.push({ selector, width: Math.round(rect.width), height: Math.round(rect.height), text: (node.textContent ?? '').trim().slice(0, 20) })
        }
      }
    }
    return { counted, small }
  })
}

function overflow(page: Page) {
  return page.evaluate(() => {
    const width = window.innerWidth
    const offenders = [...document.querySelectorAll<HTMLElement>('.app *')]
      .filter((node) => {
        const rect = node.getBoundingClientRect()
        if (!rect.width || rect.right <= width + 1) return false
        // Inside a lane that scrolls sideways on purpose, or a closed drawer.
        return !node.closest('.tabs, .composer-controls, .rail.drawer:not(.open), .statusbar, pre, .code, table, .files-tree')
      })
      .slice(0, 5)
      .map((node) => `${node.className} (${Math.round(node.getBoundingClientRect().right)})`)
    return {
      scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      width,
      offenders,
    }
  })
}


/**
 * Every screen a phone reaches, one after the other, each checked the same way:
 * nothing sideways out of the window, nothing spilling out of the button that
 * holds it, and — for an overlay — a way back that is on screen.
 */
function screenProblems(page: Page) {
  return page.evaluate(() => {
    const width = window.innerWidth
    const height = window.innerHeight
    const problems: string[] = []
    // Only what is on screen: measuring every node of a long transcript (and
    // the style of every ancestor) kept WebKit busy for minutes.
    const onScreen = (rect: DOMRect) => rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < height
    const scrollsSideways = new WeakMap<Element, boolean>()
    const clipped = (node: Element) => {
      for (let up = node.parentElement; up; up = up.parentElement) {
        let known = scrollsSideways.get(up)
        if (known === undefined) {
          const style = getComputedStyle(up)
          known = style.overflowX !== 'visible' || up.matches('.tabs, .composer-controls, .statusbar')
          scrollsSideways.set(up, known)
        }
        if (known) return true
      }
      return false
    }
    for (const node of document.querySelectorAll<HTMLElement>('body *')) {
      const rect = node.getBoundingClientRect()
      if (!onScreen(rect) || (rect.right <= width + 1 && rect.left >= -1)) continue
      if (getComputedStyle(node).visibility === 'hidden' || node.closest('.rail.drawer:not(.open)') || clipped(node)) continue
      problems.push(`sideways: ${node.tagName.toLowerCase()}.${String(node.className).slice(0, 40)}`)
    }
    // Content that spills out of the card or button it belongs to (the
    // launchpad's collapsed cards: icon below the pill, labels outside it).
    for (const box of document.querySelectorAll<HTMLElement>('button, .choose-card, .settings-row, .palette-item, .switcher-card')) {
      const outer = box.getBoundingClientRect()
      if (!onScreen(outer) || getComputedStyle(box).visibility === 'hidden') continue
      const inner = [...box.querySelectorAll<HTMLElement>('*')].slice(0, 40).find((child) => {
        const rect = child.getBoundingClientRect()
        if (!rect.width || !rect.height) return false
        if (rect.top >= outer.top - 1.5 && rect.bottom <= outer.bottom + 1.5) return false
        return getComputedStyle(child).position !== 'absolute'
      })
      if (inner) problems.push(`spills out of ${box.className || box.tagName}: ${inner.tagName.toLowerCase()}.${String(inner.className).slice(0, 30)} "${(inner.textContent ?? '').trim().slice(0, 24)}"`)
    }
    const kbd = [...document.querySelectorAll<HTMLElement>('kbd, .choose-shortcut, .term-handle-key')].filter((node) => node.offsetParent).length
    if (kbd) problems.push(`${kbd} keyboard-shortcut hints on a touch screen`)
    return [...new Set(problems)].slice(0, 8)
  })
}

let lastScreen = ''

async function phoneTour(browser: Browser, url: string, size: { name: string; width: number; height: number }, part: 1 | 2 | 3): Promise<void> {
  const context = await browser.newContext({
    ...devices['iPhone 15'],
    viewport: { width: size.width, height: size.height },
    screen: { width: size.width, height: size.height },
  })
  await context.addInitScript(FAKE_VIEWPORT)
  // The Mac's own appearance, stored before the phone ever opens the app.
  await context.addInitScript(() => {
    if (!localStorage.getItem('sedano.settings')) localStorage.setItem('sedano.settings', JSON.stringify({ uiFontSize: 18, contentFontSize: 19 }))
  })
  const page = await context.newPage()
  // Clicks, not taps, in this tour: WebKit's emulated tap now and then never
  // reports back, which stalled the run; the tap path itself is covered above.
  page.setDefaultTimeout(8_000)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  // No request interception here: routed requests are what wedged WebKit in a
  // long visit. The Remote access panel (which would ask tailscale) is covered
  // by the desktop pass and by check:remote-ui instead.
  const screen = async (name: string, extra?: () => Promise<void>) => {
    lastScreen = `${size.name} ${name}`
    await page.waitForTimeout(350)
    // A page that stopped answering is a failure to report, not a run that hangs.
    const problems = await Promise.race([
      screenProblems(page),
      new Promise<string[]>((resolve) => setTimeout(() => resolve(['the page stopped answering for 15s']), 15_000)),
    ])
    check(`${size.name} ${name}: no overflow, overlap or shortcut hints`, problems.length === 0, problems)
    if (extra) await extra()
    await page.screenshot({ path: `${SHOTS}/qa-${size.name}-${name}.png`, timeout: 15_000 })
  }
  const closeVisible = async (name: string, selector: string) => {
    const box = await page.locator(selector).first().boundingBox().catch(() => null)
    check(`${size.name} ${name}: a close/back control is on screen`, Boolean(box && box.width >= 43.5 && box.height >= 43.5 && box.y >= 0), box)
  }
  const openDrawer = async () => {
    // A menu left open eats the first tap outside it; tap until the drawer is out.
    for (let attempt = 0; attempt < 3 && !(await page.locator('.rail.drawer.open').count()); attempt += 1) {
      await page.keyboard.press('Escape')
      await page.locator('.tabs .rail-toggle').click()
      await page.waitForTimeout(300)
    }
  }
  const swipeDown = (selector: string) =>
    page.evaluate((selector) => {
      const head = document.querySelector(selector)!
      const fire = (type: string, y: number) => {
        const event = new Event(type, { bubbles: true })
        Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [{ clientX: 100, clientY: y }] })
        Object.defineProperty(event, 'changedTouches', { value: [{ clientX: 100, clientY: y }] })
        head.dispatchEvent(event)
      }
      fire('touchstart', 60)
      fire('touchend', 220)
    }, selector)

  // Every visit starts as a fresh device did before tabs were shared: none open.
  await resetSharedTabs(url)
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  // Three short visits rather than one long one: a single WebKit page driven
  // for minutes now and then stops answering the driver.
  if (part === 1) {
  await screen('launchpad', async () => {
    const cards = await page.locator('.choose-card').evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().height)))
    check(`${size.name} launchpad: both choices are full cards`, cards.length === 2 && cards.every((height) => height >= 90), cards)
  })
  await page.locator('.choose-card').first().click()
  await screen('launchpad-agent')
  // The folder chip opens the workspace menu; "Open folder…" is where the picker lives.
  await page.locator('.workspace-select').first().click()
  await screen('workspace-menu', async () => {
    const menu = await page.locator('.menu-pop').evaluate((node) => {
      const rect = node.getBoundingClientRect()
      return { inside: rect.left >= 0 && rect.right <= window.innerWidth, items: [...node.querySelectorAll('.menu-item')].map((item) => item.textContent?.trim()) }
    })
    check(`${size.name} workspace menu: fits the screen and offers Import sessions…`, menu.inside && menu.items.includes('Import sessions…'), menu)
  })
  await page.locator('.menu-pop .menu-item', { hasText: 'Open folder…' }).click()
  await page.locator('.folder-picker').waitFor()
  await screen('folder-picker', async () => {
    const fits = await page.locator('.folder-picker').evaluate((node) => {
      const rect = node.getBoundingClientRect()
      return rect.left >= -0.5 && rect.right <= window.innerWidth + 0.5 && rect.bottom <= window.innerHeight + 0.5
    })
    check(`${size.name} folder picker: fits the screen`, fits)
    await closeVisible('folder picker', '.picker-foot .ghost')
  })
  await swipeDown('.picker-head')
  await page.waitForTimeout(300)
  check(`${size.name} folder picker: a swipe down closes it`, (await page.locator('.folder-picker').count()) === 0)

  const uiSize = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-font-size').trim())
  check(`${size.name}: the phone uses its own appearance, not the Mac's 18px`, uiSize === '15px', uiSize)
  const chrome = await page.evaluate(() => ({
    themeColors: [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((meta) => meta.content),
    bar: getComputedStyle(document.querySelector('.bar')!).backgroundColor,
    style: document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.getAttribute('content'),
    theme: document.documentElement.dataset.theme,
  }))
  check(
    `${size.name}: the status bar area is the top bar's colour`,
    chrome.themeColors.length > 0 && chrome.themeColors.every((colour) => colour === chrome.bar) && chrome.style === (chrome.theme === 'dark' ? 'black-translucent' : 'default'),
    chrome,
  )
  }

  await openRichestSession(page)
  if (part === 2) {
  // A second tab, so the switcher and the swipe have somewhere to go.
  await openDrawer()
  await page.locator('.rail .session-item:not(.active)').filter({ hasNot: page.locator('.meta', { hasText: /Terminal/ }) }).first().click()
  await page.waitForTimeout(500)
  await screen('session', async () => {
    const bar = await page.evaluate(() => ({
      strip: document.querySelectorAll('.tabs .tab').length,
      current: document.querySelector('.tab-current .label')?.textContent ?? '',
      count: document.querySelector('.tab-current .tab-count')?.textContent ?? '',
    }))
    check(`${size.name} tabs: one current-tab button with a count, no sideways strip`, bar.strip === 0 && Boolean(bar.current) && Number(bar.count) >= 2, bar)
  })
  const before = await page.locator('.tab-current .label').textContent()
  await page.evaluate(() => {
    const bar = document.querySelector('.tabs')!
    const fire = (type: string, x: number) => {
      const event = new Event(type, { bubbles: true })
      Object.defineProperty(event, 'touches', { value: type === 'touchend' ? [] : [{ clientX: x, clientY: 80 }] })
      Object.defineProperty(event, 'changedTouches', { value: [{ clientX: x, clientY: 80 }] })
      bar.dispatchEvent(event)
    }
    fire('touchstart', 80)
    fire('touchend', 300)
  })
  await page.waitForTimeout(400)
  const after = await page.locator('.tab-current .label').textContent()
  check(`${size.name} tabs: a swipe across the bar goes to the tab beside it`, before !== after, { before, after })
  await page.locator('.tab-current').click()
  await page.locator('.switcher').waitFor()
  await page.waitForTimeout(900)
  await screen('tab-switcher', async () => {
    const cards = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.switcher-card')].map((card) => {
        const rect = card.getBoundingClientRect()
        return { onScreen: rect.top >= 0 && rect.bottom <= window.innerHeight && rect.width > 100, preview: (card.querySelector('.switcher-preview')?.textContent ?? '').trim().length }
      }),
    )
    check(`${size.name} tab switcher: every tab is a card, several on screen at once`, cards.length >= 2 && cards.filter((card) => card.onScreen).length >= 2, cards)
    check(`${size.name} tab switcher: the cards show the conversations' last lines`, cards.some((card) => card.preview > 20), cards)
    await closeVisible('tab switcher', '.switcher-head .round-close')
  })
  await page.locator('.switcher-card:not(.current)').first().click()
  await page.waitForTimeout(400)
  check(`${size.name} tab switcher: tapping a card opens that tab and closes the sheet`, (await page.locator('.switcher').count()) === 0 && (await page.locator('.tab-current .label').textContent()) === before)

  await page.locator('.location-pill').click()
  await page.locator('.palette').waitFor()
  await screen('palette', async () => {
    await closeVisible('palette', '.palette .round-close')
    const field = await page.locator('.palette-head input').evaluate((node: HTMLInputElement) => ({
      focused: document.activeElement === node,
      fits: node.scrollWidth <= node.clientWidth + 1,
      placeholder: node.placeholder,
    }))
    check(`${size.name} palette: the keyboard stays down until the field is tapped`, !field.focused, field)
    check(`${size.name} palette: the placeholder fits its field`, field.fits, field)
  })
  await page.locator('.palette-head input').click()
  await page.keyboard.type('gre')
  await page.waitForTimeout(200)
  const search = await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('.palette-head input')!
    const style = getComputedStyle(input)
    return {
      marks: [...document.querySelectorAll('.palette-item mark.palette-match')].map((node) => node.textContent?.toLowerCase()),
      ring: style.boxShadow !== 'none' || (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || parseFloat(style.borderTopWidth) > 0,
      head: getComputedStyle(document.querySelector('.palette-head')!).backgroundColor,
    }
  })
  check(`${size.name} palette: results mark the characters that matched`, search.marks.length > 0 && search.marks.every((text) => text === 'gre'), search)
  check(`${size.name} palette: the focused field has no ring, only a background change`, !search.ring && !/rgba\(0, 0, 0, 0\)/.test(search.head), search)
  await screen('palette-results')
  await page.locator('.palette .round-close').click()
  await page.waitForTimeout(200)
  check(`${size.name} palette: its close button closes it`, (await page.locator('.palette').count()) === 0)
  await page.locator('.location-pill').click()
  await page.locator('.palette').waitFor()
  await swipeDown('.palette-head')
  await page.waitForTimeout(250)
  check(`${size.name} palette: a swipe down closes it`, (await page.locator('.palette').count()) === 0)

  // The tree and the pin are in the ⋯ menu on a phone, not on the bar.
  const barButtons = await page.locator('.tabs .row > .icon-btn').count()
  check(`${size.name} tab bar: no folder or star buttons of its own`, barButtons === 0, barButtons)
  await page.locator('.tabs .session-actions-menu .select-trigger').click()
  await page.locator('.menu-item', { hasText: 'Show file tree' }).click()
  await page.locator('.files-panel').waitFor()
  await screen('files', () => closeVisible('file tree', '.files-panel .round-close'))
  await page.locator('.files-panel .round-close').click()
  await page.waitForTimeout(200)
  check(`${size.name} file tree: its close button closes it`, (await page.locator('.files-panel').count()) === 0)

  await page.locator('.tabs .session-actions-menu .select-trigger').click()
  await screen('session-menu')
  await page.keyboard.press('Escape')
  // A toast: asking for the model list again says so.
  await page.locator('.composer-options-toggle').click()
  await page.locator('.composer-controls .select-trigger').first().click()
  await page.locator('.menu-pop button', { hasText: 'Refresh models' }).click()
  await page.locator('.toast').first().waitFor()
  await page.locator('.composer-options-toggle').click()
  await screen('toast', async () => {
    const box = await page.locator('.toast').first().boundingBox()
    check(`${size.name} toast: fits the screen`, Boolean(box && box.x >= 0 && box.x + box.width <= size.width + 0.5 && box.y + box.height <= size.height), box)
    // At the top, clear of the notch and the bars, not over the composer.
    const tabsBottom = await page.locator('.tabs').first().evaluate((node) => node.getBoundingClientRect().bottom)
    check(`${size.name} toast: sits at the top, under the bars`, Boolean(box && box.y >= tabsBottom && box.y - tabsBottom <= 16), { box, tabsBottom })
    check(`${size.name} toast: has a close button`, (await page.locator('.toast .toast-close').count()) > 0)
  })

  // A dialog: rename, from the long press on a session row.
  await openDrawer()
  await page.evaluate(() => {
    const row = document.querySelector('.rail .session-item')!
    const touch = [{ clientX: 120, clientY: 300 }]
    const event = new Event('touchstart', { bubbles: true })
    Object.defineProperty(event, 'touches', { value: touch })
    Object.defineProperty(event, 'changedTouches', { value: touch })
    row.dispatchEvent(event)
  })
  await page.waitForTimeout(700)
  await page.locator('.ctx-pop .ctx-item', { hasText: 'Rename' }).click()
  await page.locator('.dialog-box').waitFor()
  await screen('dialog', async () => {
    const box = await page.locator('.dialog-box').boundingBox()
    check(`${size.name} dialog: a centred card that fits`, Boolean(box && box.x >= 0 && box.x + box.width <= size.width + 0.5 && box.height < size.height), box)
    await closeVisible('dialog', '.dialog-actions button')
  })
  const dialogState = await page.evaluate(() => ({
    boxes: document.querySelectorAll('.dialog-box').length,
    buttons: [...document.querySelectorAll('.dialog-actions button')].map((node) => node.textContent),
  }))
  if (dialogState.boxes) await page.locator('.dialog-actions button').first().click()
  check(`${size.name} dialog: still open until answered`, dialogState.boxes === 1, dialogState)
  await openDrawer()
  // The scrim's visible strip is to the right of the drawer.
  await page.locator('.drawer-scrim').click({ position: { x: size.width - 12, y: 200 } })
  await page.waitForTimeout(300)
  check(`${size.name}: tapping beside the drawer closes it`, (await page.locator('.rail.drawer.open').count()) === 0)
  const status = await page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>('.statusbar')!.getBoundingClientRect()
    const handle = document.querySelector<HTMLElement>('.term-handle')
    return { height: Math.round(bar.height), handleText: handle?.textContent?.trim() ?? null, handleLabel: handle?.getAttribute('aria-label') ?? null }
  })
  // 36px of line plus what the home indicator leaves of its 34px inset.
  check(`${size.name} status bar: one slim line`, status.height <= 36 + 8 + 20 + 1, status)
  check(`${size.name} status bar: the terminal control is an icon, named for screen readers`, status.handleText === '' && Boolean(status.handleLabel), status)
  await page.locator('.statusbar .limits-bar').click()
  await screen('limits')
  await page.keyboard.press('Escape')

  // Long-pressing a sidebar row opens its menu and selects no text.
  await openDrawer()
  const rowStyle = await page.locator('.rail .session-item').first().evaluate(async (node) => {
    const style = getComputedStyle(node) as CSSStyleDeclaration & { webkitUserSelect?: string }
    // Desktop WebKit drops `-webkit-touch-callout` when it parses (only iOS
    // knows it), so the shipped stylesheet is read for the rule instead.
    const css = (
      await Promise.all(
        [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map((link) => fetch(link.href).then((response) => response.text())),
      )
    ).join('\n') + [...document.querySelectorAll('style')].map((tag) => tag.textContent).join('\n')
    const callout = /\.session-item[^{}]*\{[^}]*-webkit-touch-callout:\s*none/.test(css)
    return { select: style.userSelect || style.webkitUserSelect, callout: callout ? 'none' : 'default' }
  })
  check(`${size.name} sidebar: a long press starts no text selection or callout`, rowStyle.select === 'none' && rowStyle.callout === 'none', rowStyle)
  // The fixtures were opened with every session shown; back to the default.
  if ((await page.locator('.rail-more').first().textContent()) === 'Show fewer') await page.locator('.rail-more').first().click()
  const rail = await page.evaluate(() => ({
    groups: document.querySelectorAll('.rail-title.workspace').length,
    open: document.querySelectorAll('.rail-title.workspace[aria-expanded="true"]').length,
    rows: document.querySelectorAll('.rail-section:last-child .session-item').length,
    more: document.querySelector('.rail-more')?.textContent ?? '',
  }))
  check(`${size.name} sidebar: a few workspaces are all open, three sessions each, then "Show N more"`, rail.groups === rail.open && rail.rows <= rail.groups * 4 && /Show \d+ more/.test(rail.more), rail)
  await page.locator('.rail-more').first().click()
  const expanded = await page.locator('.rail-section:last-child .session-item').count()
  check(`${size.name} sidebar: "Show more" reveals the rest`, expanded > rail.rows, { before: rail.rows, after: expanded })
  await screen('drawer')
  await page.locator('.drawer-scrim').click({ position: { x: size.width - 12, y: 200 } })

  // Every tab closed: the new-tab chooser, never a folder picker.
  for (let guard = 0; guard < 12 && (await page.locator('.tab-current .tab-count').textContent()) !== '1'; guard += 1) {
    await page.locator('.tab-current').click()
    await page.locator('.switcher-card .switcher-close').first().click()
    await page.keyboard.press('Escape')
    await page.waitForTimeout(150)
  }
  await page.locator('.tab-current').click()
  await page.locator('.switcher-card .switcher-close').first().click().catch(() => undefined)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  const empty = await page.evaluate(() => ({
    title: document.querySelector('.launchpad-title')?.textContent ?? null,
    picker: Boolean(document.querySelector('.folder-picker')),
  }))
  check(`${size.name}: with every tab closed the chooser is shown, not a folder picker`, empty.title === 'What do you want to open?' && !empty.picker, empty)
  }

  if (part === 3) {
  await page.locator('.bar .settings-btn').click()
  await screen('settings', () => closeVisible('settings list', '.settings-list-head button'))
  for (const section of ['Appearance', 'Interface', 'Dictation', 'Machines', 'Sessions', 'Advanced']) {
    await page.locator('.settings-nav-item', { hasText: section }).click()
    await screen(`settings-${section.toLowerCase().replace(/\s+/g, '-')}`, async () => {
      const scrolling = await page.evaluate(() => {
        const rows = document.querySelector<HTMLElement>('.settings-rows')!
        const traps = [...rows.querySelectorAll<HTMLElement>('*')].filter((node) => {
          const style = getComputedStyle(node)
          return /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 2 && node.tagName !== 'TEXTAREA'
        })
        return { rows: getComputedStyle(rows).overflowY, traps: traps.map((node) => String(node.className).slice(0, 40)) }
      })
      check(`${size.name} settings ${section}: one scroll container, no nested scroll traps`, scrolling.rows === 'auto' && scrolling.traps.length === 0, scrolling)
      // And it really scrolls: the container fits the screen, and a scroll
      // gesture brings its last row into view.
      const reach = await page.evaluate(() => {
        const rows = document.querySelector<HTMLElement>('.settings-rows')!
        const box = rows.getBoundingClientRect()
        return { bottom: Math.round(box.bottom), height: rows.clientHeight, content: rows.scrollHeight, viewport: window.innerHeight }
      })
      check(`${size.name} settings ${section}: the rows fit the screen`, reach.bottom <= reach.viewport + 1, reach)
      if (reach.content > reach.height + 4) {
        // WebKit on a phone has no wheel to drive: scroll the container itself,
        // which only works if it is the thing that scrolls.
        await page.locator('.settings-rows').evaluate((node) => node.scrollTo({ top: node.scrollHeight }))
        await page.waitForTimeout(300)
        const last = await page.evaluate(() => {
          const rows = document.querySelector<HTMLElement>('.settings-rows')!
          const row = [...rows.querySelectorAll<HTMLElement>('.settings-row')].at(-1)!.getBoundingClientRect()
          return { scrollTop: Math.round(rows.scrollTop), lastBottom: Math.round(row.bottom), rowsBottom: Math.round(rows.getBoundingClientRect().bottom) }
        })
        check(`${size.name} settings ${section}: scrolling reaches the last row`, last.scrollTop > 0 && last.lastBottom <= last.rowsBottom + 2, last)
      }
    })
    if (section === 'Appearance') {
      const note = await page.locator('.settings-row', { hasText: 'This phone' }).count()
      check(`${size.name} settings: appearance says it applies to this phone`, note === 1, note)
      await page.locator('.settings-row button[title^="Bigger"]').first().click()
      const stored = await page.evaluate(() => ({
        shared: JSON.parse(localStorage.getItem('sedano.settings') ?? '{}'),
        phone: JSON.parse(localStorage.getItem('sedano.settings.mobile') ?? '{}'),
      }))
      check(
        `${size.name} settings: a size changed on the phone is kept for the phone only`,
        stored.shared.uiFontSize === 18 && stored.shared.contentFontSize === 19 && (stored.phone.uiFontSize !== undefined || stored.phone.contentFontSize !== undefined),
        stored,
      )
      await page.evaluate(() => localStorage.removeItem('sedano.settings.mobile'))
    }
    await page.locator('.settings-back').click()
    await page.waitForTimeout(200)
  }
  check(`${size.name} settings: Back returns to the list of sections`, (await page.locator('.settings.mobile-list').count()) === 1)
  await swipeDown('.settings-list-head')
  await page.waitForTimeout(250)
  check(`${size.name} settings: a swipe down closes it`, (await page.locator('.settings').count()) === 0)
  }
  check(`${size.name} part ${part}: the page raised no errors`, errors.length === 0, errors)
  await context.close()
}

async function phonePass(url: string, cwd: string): Promise<void> {
  const browser = await webkit.launch()
  try {
    for (const theme of ['light', 'dark'] as const) {
      const context = await browser.newContext({
        ...devices['iPhone 15'],
        viewport: { width: 393, height: 852 },
        screen: { width: 393, height: 852 },
      })
      await context.addInitScript(FAKE_VIEWPORT)
      const page = await context.newPage()
      page.setDefaultTimeout(8_000)
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      const tag = `iPhone ${theme}`
      await fakeRemoteApi(page, { remote: true })
      // Every visit starts as a fresh device did before tabs were shared: none open.
      await resetSharedTabs(url)
      await page.goto(url, { waitUntil: 'networkidle' })
      await setTheme(page, theme)
      await page.reload({ waitUntil: 'networkidle' })
      await page.waitForTimeout(600)

      // The drawer starts shut, even though the desktop sidebar setting is on.
      const closed = await page.locator('.rail').evaluate((node) => node.getBoundingClientRect().right <= 0 || getComputedStyle(node).visibility === 'hidden')
      check(`${tag}: the drawer starts closed`, closed)
      await page.locator('.tabs .rail-toggle').tap()
      await page.waitForTimeout(350)
      const opened = await page.locator('.rail').evaluate((node) => {
        const rect = node.getBoundingClientRect()
        return rect.left >= -0.5 && rect.width > 200 && getComputedStyle(node).visibility === 'visible'
      })
      check(`${tag}: tapping the toggle opens the drawer`, opened)
      check(`${tag}: a scrim covers the pane`, (await page.locator('.drawer-scrim').count()) === 1)
      const drawerTargets = await smallTargets(page)
      check(`${tag}: drawer touch targets are at least 44px`, drawerTargets.small.length === 0, drawerTargets.small)
      await page.screenshot({ path: `${SHOTS}/shell-iphone-drawer-${theme}.png` })

      // Picking a session opens it and puts the drawer away.
      if (!(await page.locator('.rail .session-item').count())) await page.locator('.rail-title.workspace').first().tap()
      await page.waitForTimeout(250)
      const agents = page.locator('.rail .session-item').filter({ hasNot: page.locator('.meta', { hasText: /Terminal/ }) })
      await agents.first().tap()
      await page.waitForTimeout(700)
      check(`${tag}: picking a session closes the drawer`, (await page.locator('.rail.drawer.open').count()) === 0)
      check(`${tag}: the session's composer is on screen`, (await page.locator('.composer textarea').count()) === 1)

      // An edge swipe opens it again, a swipe back closes it.
      const swipe = async (from: number, to: number) =>
        page.evaluate(([from, to]) => {
          // WebKit has no Touch constructor; the handler only reads positions.
          const fire = (type: string, touches: object[], changed: object[]) => {
            const event = new Event(type)
            Object.defineProperty(event, 'touches', { value: touches })
            Object.defineProperty(event, 'changedTouches', { value: changed })
            window.dispatchEvent(event)
          }
          fire('touchstart', [{ clientX: from, clientY: 400 }], [{ clientX: from, clientY: 400 }])
          fire('touchend', [], [{ clientX: to, clientY: 410 }])
        }, [from, to])
      await swipe(8, 200)
      await page.waitForTimeout(300)
      check(`${tag}: an edge swipe opens the drawer`, (await page.locator('.rail.drawer.open').count()) === 1)
      await swipe(300, 60)
      await page.waitForTimeout(300)
      check(`${tag}: a swipe back closes it`, (await page.locator('.rail.drawer.open').count()) === 0)

      const bar = await topBar(page)
      check(`${tag}: the pill is centred`, bar.pillCentre !== null && Math.abs(bar.pillCentre - bar.barCentre) <= 1.5, bar)
      check(`${tag}: the pill names the project folder only`, bar.project === basename(cwd), bar.project)
      check(`${tag}: the pill fits in the bar`, bar.pillInside, bar)
      const safe = await page.evaluate(() => ({
        barTop: document.querySelector<HTMLElement>('.location-pill')!.getBoundingClientRect().top,
        statusBottomPad: parseFloat(getComputedStyle(document.querySelector('.statusbar')!).paddingBottom),
      }))
      check(`${tag}: the top bar clears the notch`, safe.barTop >= 47, safe)
      // The home indicator overlaps the lower 14px of its inset by design.
      check(`${tag}: the status bar clears the home indicator`, safe.statusBottomPad >= 34 - 14, safe)
      const minimap = await page.locator('.prompt-minimap').evaluateAll((nodes) => nodes.filter((node) => (node as HTMLElement).offsetParent !== null).length)
      check(`${tag}: the prompt minimap is hidden`, minimap === 0, minimap)
      const wide = await overflow(page)
      check(`${tag}: nothing overflows sideways`, wide.scroll <= wide.width && wide.offenders.length === 0, wide)
      const targets = await smallTargets(page)
      check(`${tag}: touch targets are at least 44px`, targets.counted > 8 && targets.small.length === 0, targets)
      const fieldFont = await page.locator('.composer textarea').evaluate((node) => parseFloat(getComputedStyle(node).fontSize))
      check(`${tag}: the composer field is at least 16px (no zoom on focus)`, fieldFont >= 16, fieldFont)
      const status = await page.evaluate(() => {
        const bar = document.querySelector<HTMLElement>('.statusbar')!
        return { scroll: bar.scrollWidth, client: bar.clientWidth, chips: [...bar.querySelectorAll<HTMLElement>('.limit-chip')].filter((chip) => chip.offsetParent).length }
      })
      check(`${tag}: the status bar fits without scrolling, one limits chip`, status.scroll <= status.client + 1 && status.chips <= 1, status)
      await page.screenshot({ path: `${SHOTS}/shell-iphone-session-${theme}.png` })

      // The pickers: one summary chip, and in full (nothing truncated) once tapped.
      const folded = await page.evaluate(() => ({
        toggle: document.querySelector<HTMLElement>('.composer-options-toggle')?.textContent ?? '',
        pickers: [...document.querySelectorAll<HTMLElement>('.composer-controls .select-trigger')].filter((node) => node.offsetParent).length,
      }))
      check(`${tag}: model · effort · approvals fold into one chip`, folded.pickers === 0 && folded.toggle.split(' · ').length >= 3, folded)
      await page.locator('.composer-options-toggle').tap()
      await page.waitForTimeout(200)
      const unfolded = await page.evaluate(() => {
        const inner = document.querySelector<HTMLElement>('.composer-inner')!.getBoundingClientRect()
        return [...document.querySelectorAll<HTMLElement>('.composer-controls .select-trigger')].map((node) => {
          const rect = node.getBoundingClientRect()
          const label = node.querySelector<HTMLElement>('.chip-select') ?? node
          return { text: node.textContent?.trim(), inside: rect.left >= inner.left - 0.5 && rect.right <= inner.right + 0.5 && rect.width > 0, truncated: label.scrollWidth > label.clientWidth + 1 }
        })
      })
      check(`${tag}: tapped, all three pickers show in full inside the composer`, unfolded.length === 3 && unfolded.every((item) => item.inside && !item.truncated), unfolded)
      await page.screenshot({ path: `${SHOTS}/shell-iphone-options-${theme}.png` })
      await page.locator('.composer-options-toggle').tap()
      await page.waitForTimeout(150)

      // The keyboard: the visual viewport shrinks, the composer stays above it.
      await page.locator('.composer textarea').tap()
      await page.evaluate(() => (window as unknown as { __keyboard: (px: number) => void }).__keyboard(336))
      await page.waitForTimeout(250)
      const typing = await page.evaluate(() => {
        const visible = window.innerHeight - 336
        const composer = document.querySelector<HTMLElement>('.composer-inner')!.getBoundingClientRect()
        const status = document.querySelector<HTMLElement>('.statusbar')
        return {
          visible,
          composerTop: Math.round(composer.top),
          composerBottom: Math.round(composer.bottom),
          statusShown: Boolean(status && status.offsetParent !== null),
          keyboardClass: document.documentElement.classList.contains('keyboard-open'),
        }
      })
      check(`${tag}: with the keyboard up the composer is fully visible above it`, typing.composerBottom <= typing.visible && typing.composerTop > 100, typing)
      check(`${tag}: the status bar steps aside for the keyboard`, typing.keyboardClass && !typing.statusShown, typing)
      await page.screenshot({ path: `${SHOTS}/shell-iphone-keyboard-${theme}.png` })
      await page.evaluate(() => (window as unknown as { __keyboard: (px: number) => void }).__keyboard(0))
      await page.waitForTimeout(150)

      if (theme === 'light') {
        // A picked photo goes through the same pipeline as a pasted one.
        await page.locator('.composer input[type=file]').setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: PNG })
        await page.locator('.composer .attach:not(.pending)').first().waitFor({ timeout: 5_000 }).catch(() => undefined)
        const attached = await page.evaluate(() => ({
          thumbs: document.querySelectorAll('.composer .attach:not(.pending)').length,
          text: document.querySelector<HTMLTextAreaElement>('.composer textarea')!.value,
        }))
        check(`${tag}: a picked image becomes an attachment with its token`, attached.thumbs === 1 && attached.text.includes('[image:1]'), attached)
        await page.screenshot({ path: `${SHOTS}/shell-iphone-attach.png` })

        // A paired phone does not get the management section.
        await page.locator('.bar .settings-btn').tap()
        await page.waitForTimeout(300)
        const remoteSection = await page.locator('.settings-nav-item', { hasText: 'Remote access' }).count()
        check(`${tag}: a paired phone has no Remote access section`, remoteSection === 0, remoteSection)
        const settingsWide = await overflow(page)
        check(`${tag}: Settings fits the phone`, settingsWide.scroll <= settingsWide.width, settingsWide)
        await page.screenshot({ path: `${SHOTS}/shell-iphone-settings.png` })
        await page.locator('.settings-head button:visible', { hasText: 'Done' }).first().tap()

        // A 401 from the API (a revoked phone) reloads into the pairing page.
        await page.route('**/api/revoked-probe', (route) => route.fulfill({ status: 401, body: '{"error":"this device is not paired"}' }))
        const reloaded = page.waitForEvent('load', { timeout: 5_000 }).then(() => true, () => false)
        await page.evaluate(() => void fetch('/api/revoked-probe'))
        check(`${tag}: a 401 from /api reloads the page`, await reloaded)
      }
      check(`${tag}: the page raised no errors`, errors.length === 0, errors)
      await context.close()
    }
  } finally {
    await browser.close()
  }
}

const target = await resolveApp()
try {
  const browser = await chromium.launch({ channel: 'chrome' })
  try {
    await desktopPass(browser, target.url, target.cwd)
  } finally {
    await browser.close()
  }
  await phonePass(target.url, target.cwd)
  for (const size of [
    { name: 'iphone15', width: 393, height: 852 },
    { name: 'iphone-se', width: 375, height: 667 },
    { name: 'landscape', width: 852, height: 393 },
  ]) {
    for (const part of [1, 2, 3] as const) {
      // A fresh WebKit for every visit: one that wedges takes every page in it
      // down with it, and a stall is then reported instead of hanging the run.
      // Headless WebKit now and then stops producing frames for a page (the
      // driver then waits on "stable" forever); that visit is retried once in a
      // fresh browser, and only a second stall counts as a failure.
      let outcome = ''
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const phones = await webkit.launch()
        const recorded = failures.length
        const done = phoneTour(phones, target.url, size, part).then(() => 'ok', (error: unknown) => {
          const text = error instanceof Error ? error.message : String(error)
          const where = text.split('\n').find((line) => line.includes('waiting for')) ?? ''
          return `error: ${text.split('\n')[0]} ${where.replace(/\u001b\[[0-9;]*m/g, '').trim()}`
        })
        const stalled = new Promise<string>((resolve) => setTimeout(() => resolve(`stalled at ${lastScreen}`), 120_000))
        outcome = await Promise.race([done, stalled])
        await Promise.race([phones.close(), new Promise((resolve) => setTimeout(resolve, 5_000))])
        const stalledPage = failures.slice(recorded).some((failure) => failure.includes('stopped answering'))
        if (outcome === 'ok' && !stalledPage) break
        if (attempt === 1) {
          console.log(`… ${size.name} part ${part}: ${stalledPage ? 'page stopped answering' : outcome} — retrying once`)
          failures.splice(recorded)
        }
      }
      check(`${size.name} part ${part}: the visit completed`, outcome === 'ok', outcome)
    }
  }
} catch (error) {
  failures.push(error instanceof Error ? error.stack ?? error.message : String(error))
} finally {
  await runCleanups()
}

if (failures.length) {
  console.error(`\nmobile-ui-test: FAILED\n${failures.join('\n')}`)
  process.exit(1)
}
console.log('\nmobile-ui-test: PASSED')
// Explicit, like the other browser checks: a WebKit that wedged and was left
// behind by the 5 s close race keeps the event loop alive, and `check:all` used
// to sit forever after this very line.
process.exit(0)
