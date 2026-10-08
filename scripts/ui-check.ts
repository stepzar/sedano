#!/usr/bin/env bun
/**
 * UI check: opens the app in a real browser and asserts the things that would
 * actually hurt a user, then leaves screenshots for a human to look at.
 *
 * Asserts: no console errors, the transcript is a real scroll container, the
 * content font scales independently from the interface, light and dark are
 * different surfaces, the palette opens, shrinking a workspace group in the
 * rail works, ⌘D opens the inline agent launchpad (never a modal) and selects it
 * while ⌘T opens a terminal straight away, a question nobody can answer any more
 * is greyed and unclickable, answering one never claims it arrived before the
 * server says so, the settings window has sections plus a working search, and
 * the accent is neutral rather than tinted.
 *
 * With no arguments it builds its own world: a temporary store seeded with the
 * transcript fixtures, an API server on a free port serving the built bundle and
 * a vite server for the gallery. Nothing already running is touched, and because
 * the store is known, a surface that is missing is a failure rather than a
 * silent skip. The handful of checks that genuinely need something outside this
 * repo — tmux, a second machine in ~/.ssh/config, a vendor CLI reporting usage —
 * are opt-in and reported separately.
 *
 * Uses the locally installed Chrome (no browser download needed).
 *   bun scripts/ui-check.ts [url] [outfile] [galleryBase]
 */
import { Database } from 'bun:sqlite'
import { basename, join } from 'node:path'
import { chromium, webkit, type Page } from 'playwright'
import { ROOT, installExitHandlers, runCleanups, seedStore, startApi, tempHome } from './lib/harness.ts'
import { openRichestSession, resolveApp } from './lib/app.ts'
import { RICHEST_FIXTURE } from './fixtures/transcripts.ts'

installExitHandlers()
const out = process.argv[3] ?? '.playwright-mcp/sedano.png'
const target = await resolveApp(process.argv[2], process.argv[4])
const url = target.url
/** The component gallery is dev-only, so it needs the vite server. */
const galleryBase = target.galleryBase

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const errors: string[] = []
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`)
})
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))

const failures: string[] = []
/**
 * Checks that were not run because their premise lives outside this repo.
 *
 * This list used to absorb anything the machine happened not to have, including
 * surfaces the app is supposed to render — so the check passed by not looking.
 * Only the entries below may skip, and each one says what it is waiting for.
 */
const skips: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) return
  failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}
function skip(label: string, reason: string): void {
  skips.push(`${label} — ${reason}`)
}

/** Opt-in checks: `SEDANO_CHECK_OPTIONAL=1` runs the ones this machine can. */
const wantOptional = process.env.SEDANO_CHECK_OPTIONAL === '1'
/** A terminal tab is a tmux session on the machine running the check. */
const hasTmux = Bun.which('tmux') !== null

async function checkAutosize(selector: string) {
  const field = page.locator(selector)
  await field.fill('')
  const measure = () =>
    field.evaluate((node: HTMLTextAreaElement) => ({
      height: node.getBoundingClientRect().height,
      scrollHeight: node.scrollHeight,
      overflowY: getComputedStyle(node).overflowY,
    }))

  const initial = await measure()
  await field.fill('One\nTwo\nThree\nFour')
  await page.waitForTimeout(50)
  const grown = await measure()

  await field.fill(Array.from({ length: 40 }, (_, index) => `Line ${index + 1}`).join('\n'))
  await page.waitForTimeout(50)
  const capped = await measure()

  await field.fill('A narrow field wraps this sentence into more lines. '.repeat(8))
  await page.waitForTimeout(50)
  const wide = await measure()
  await field.evaluate((node: HTMLTextAreaElement) => {
    if (node.parentElement) node.parentElement.style.width = '55%'
  })
  await page.waitForTimeout(100)
  const narrow = await measure()
  await field.evaluate((node: HTMLTextAreaElement) => {
    if (node.parentElement) node.parentElement.style.width = ''
  })

  await field.fill('')
  await page.waitForTimeout(50)
  const shrunk = await measure()
  return { initial, grown, capped, wide, narrow, shrunk }
}

await page.goto(url, { waitUntil: 'networkidle' })
await page.waitForTimeout(2000)
// Open a session before looking at anything: a fresh profile has no active tab,
// and half of what this file inspects (the transcript, its scroll container, the
// composer) only exists inside one.
const opened = await openRichestSession(page)

/* ---------------- housekeeping ---------------- */

/** Ids of the sessions the app has open, read from where the app persists them. */
async function openTabs(): Promise<string[]> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('sedano.tabs')
    return raw ? (Object.values(JSON.parse(raw) as Record<string, string[]>).flat() as string[]) : []
  })
}

/**
 * Every session the server knows about. The cleanup below compares against this
 * rather than against the tab list: selecting an existing session gives it a tab
 * too, and "it has a tab now" is not the same as "this run created it" — that
 * mistake deleted a session belonging to whoever ran the check.
 *
 * Returns null when the list cannot be read, and the caller then deletes
 * nothing: an unknown before-state must never authorise a delete.
 */
async function sessionIds(): Promise<Set<string> | null> {
  try {
    const response = await fetch(new URL('/api/state', url))
    if (!response.ok) return null
    const body = (await response.json()) as { sessions: Array<{ id: string }> }
    return new Set(body.sessions.map((session) => session.id))
  } catch {
    return null
  }
}

/**
 * Delete the sessions this run created. Checks that press ⌘T open a real
 * terminal, and a tab closed with ⌘W only detaches: without this every run left
 * one more tmux session running on the machine, forever.
 */
async function deleteSessions(ids: string[]): Promise<void> {
  if (!ids.length) return
  const socket = new WebSocket(`${url.replace(/^http/, 'ws').replace(/\/$/, '')}/api/ws`)
  await new Promise<void>((resolve) => {
    socket.onopen = () => {
      for (const id of ids) socket.send(JSON.stringify({ t: 'delete_session', sessionId: id }))
      setTimeout(() => {
        socket.close()
        resolve()
      }, 800)
    }
    socket.onerror = () => resolve()
  })
}

const sessionsBefore = await sessionIds()
const createdSessions: string[] = []
if (sessionsBefore === null) {
  console.log('cleanup disabled: could not read the session list before this run')
}

/* ---------------- structure ---------------- */

const layout = await page.evaluate(() => {
  const q = (sel: string) => document.querySelector(sel) as HTMLElement | null
  return {
    rootChildren: document.getElementById('root')?.childElementCount ?? 0,
    titlebar: Boolean(q('.bar .brand')),
    rail: Boolean(q('.rail')),
    workspaces: [...document.querySelectorAll('.rail-title')].map((n) => n.textContent?.trim()),
    sessionItems: document.querySelectorAll('.session-item').length,
    tabs: document.querySelectorAll('.tab').length,
    statusbar: q('.statusbar')?.textContent ?? '',
    transcript: Boolean(q('.transcript')),
    turns: document.querySelectorAll('.turn').length,
    tools: document.querySelectorAll('.tool').length,
    files: document.querySelectorAll('.file-card').length,
    icons: document.querySelectorAll('svg').length,
    bg: getComputedStyle(document.body).backgroundColor,
    fg: getComputedStyle(document.body).color,
  }
})

check('root rendered', layout.rootChildren > 0, layout)
check('titlebar present', layout.titlebar)
check('rail present', layout.rail)
check('status bar present', layout.statusbar.length > 0)
check('svg icon set rendered', layout.icons > 5, layout.icons)

/* ---------------- conversation search and session identity -------- */

const searchableWord = await page.locator('.turn .msg-user .msg-body').first().evaluate((node) =>
  (node.textContent ?? '').match(/[A-Za-z]{4,}/)?.[0] ?? '',
)
await page.getByRole('button', { name: 'Search this conversation' }).click()
await page.getByRole('searchbox', { name: 'Search this conversation' }).fill(searchableWord)
const searchCount = await page.locator('.transcript-search-count').textContent()
check('conversation search finds prompt text', Boolean(searchableWord && searchCount && !searchCount.endsWith('/0')), { searchableWord, searchCount })
await page.getByRole('searchbox', { name: 'Search this conversation' }).press('Enter')
check('search navigates to a turn', await page.locator('.turn.search-target').count() === 1)
await page.waitForTimeout(150)
check('search highlights the located text', await page.evaluate(() => Boolean(CSS.highlights?.has('sedano-search'))))
await page.getByRole('button', { name: 'Close search' }).click()
check('search can close cleanly', await page.getByRole('searchbox', { name: 'Search this conversation' }).count() === 0)

/* ---------------- transcript navigation: landing, minimap, search into folds -------- */

/** Clicks a fixture session in the rail by its title and lets it lay out. */
async function openSessionTitled(title: string, on: Page = page): Promise<boolean> {
  return on.evaluate(async (wanted) => {
    for (const more of document.querySelectorAll<HTMLElement>('.rail-more[aria-expanded="false"]')) more.click()
    await new Promise((r) => setTimeout(r, 100))
    const row = [...document.querySelectorAll<HTMLElement>('.rail .session-item')]
      .find((item) => (item.querySelector('.title')?.textContent ?? '').trim() === wanted)
    row?.click()
    await new Promise((r) => setTimeout(r, 900))
    return Boolean(row)
  }, title)
}
const transcriptPlace = (on: Page = page) => on.evaluate(() => {
  const node = document.querySelector<HTMLElement>('.transcript')!
  return {
    below: Math.round(node.scrollHeight - node.scrollTop - node.clientHeight),
    overflows: node.scrollHeight > node.clientHeight + 40,
  }
})

/**
 * The reader scrolls the open session up, then opens one whose history has not
 * been loaded yet: it arrives after the switch, into a view that used to keep
 * the previous tab's "not following" and — in WebKit, the desktop shell's
 * engine — stayed at the top. A short window, so the fixtures overflow and
 * "at the bottom" means something.
 */
async function landingAfterSwitch(on: Page, fresh: string) {
  await on.setViewportSize({ width: 1440, height: 420 })
  await on.waitForTimeout(300)
  const box = (await on.locator('.transcript').boundingBox())!
  await on.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await on.mouse.wheel(0, -5000)
  await on.waitForTimeout(300)
  await openSessionTitled(fresh, on)
  return transcriptPlace(on)
}
const landing = await landingAfterSwitch(page, 'Trace the flaky upload test')
check('a session opened from the rail lands at its bottom, not where the last tab was scrolled',
  landing.overflows && landing.below <= 4, landing)
await page.setViewportSize({ width: 1440, height: 900 })
await page.waitForTimeout(300)
{
  const engine = await webkit.launch()
  try {
    const other = await engine.newPage({ viewport: { width: 1440, height: 420 } })
    await other.goto(url, { waitUntil: 'networkidle' })
    await other.waitForTimeout(1500)
    await openRichestSession(other)
    const place = await landingAfterSwitch(other, 'Audit the auth middleware')
    check('in WebKit too, a session opened from the rail lands at its bottom', place.overflows && place.below <= 4, place)
  } finally {
    await engine.close()
  }
}

// Two short turns: the last prompt can never scroll up to the top of the view,
// and the minimap used to mark the one before it.
await openSessionTitled('Rename the config loader')
const endMark = await page.evaluate(() => {
  const marks = [...document.querySelectorAll<HTMLElement>('.prompt-mark')]
  return { count: marks.length, current: marks.findIndex((mark) => mark.classList.contains('current')) }
})
const endPlace = await transcriptPlace()
check('the minimap marks the last prompt when the view is at the end of the thread',
  endMark.count >= 2 && endMark.current === endMark.count - 1 && endPlace.below <= 4, { endMark, endPlace })

// "empty name" is in the prompt, in the folded reasoning and in the reply of
// this finished turn — the reasoning is not even mounted until search opens it.
await openSessionTitled('Harden the greet helper')
const foldState = () => page.evaluate(() => ({
  // The prompt's turn; the preamble before it has nothing to read and stays open.
  workOpen: [...document.querySelectorAll('.turn')].pop()?.querySelector('.turn-work')?.classList.contains('open') ?? false,
  thinkOpen: document.querySelector('.think.reasoning')?.classList.contains('open') ?? false,
  count: document.querySelector('.transcript-search-count')?.textContent ?? '',
  current: (() => {
    const registry = CSS.highlights as unknown as Map<string, { forEach: (fn: (range: Range) => void) => void; size: number }> | undefined
    const strong = registry?.get('sedano-search-current')
    let inThink = false
    let text = ''
    strong?.forEach((range) => {
      text = range.toString()
      inThink = Boolean(range.startContainer.parentElement?.closest('.think.reasoning'))
    })
    return { text, inThink, all: registry?.get('sedano-search')?.size ?? 0 }
  })(),
}))
const beforeSearch = await foldState()
await page.getByRole('button', { name: 'Search this conversation' }).click()
const findField = page.getByRole('searchbox', { name: 'Search this conversation' })
await findField.fill('empty name')
await page.waitForTimeout(600)
const firstHit = await foldState()
check('search counts matches inside folded work', firstHit.count === '1/3', { beforeSearch, firstHit })
check('the current match is highlighted', firstHit.current.text.toLowerCase() === 'empty name', firstHit)
await findField.press('Enter')
await page.waitForTimeout(600)
const inReasoning = await foldState()
check('a match in folded reasoning opens the turn and the reasoning, and is highlighted there',
  !beforeSearch.workOpen && !beforeSearch.thinkOpen && inReasoning.workOpen && inReasoning.thinkOpen
    && inReasoning.current.inThink && inReasoning.count === '2/3',
  { beforeSearch, inReasoning })
check('the other matches on screen are highlighted too', inReasoning.current.all >= 2, inReasoning)
await findField.press('Enter')
await page.waitForTimeout(600)
const inReply = await foldState()
check('moving on puts back what the previous match opened', !inReply.workOpen && !inReply.thinkOpen && inReply.count === '3/3', inReply)
await findField.press('Shift+Enter')
await page.waitForTimeout(600)
await page.getByRole('button', { name: 'Close search' }).click()
await page.waitForTimeout(400)
const afterClose = await foldState()
check('closing search restores every fold and removes the highlights',
  !afterClose.workOpen && !afterClose.thinkOpen && !afterClose.current.text && afterClose.current.all === 0, afterClose)
const fieldChrome = await page.evaluate(async () => {
  ;(document.querySelector('.transcript-search-toggle') as HTMLElement).click()
  await new Promise((r) => setTimeout(r, 150))
  const input = document.querySelector<HTMLInputElement>('.transcript-search-box input')!
  input.focus()
  const style = getComputedStyle(input)
  const result = { border: style.borderTopWidth, shadow: style.boxShadow, outline: style.outlineStyle, appearance: style.appearance }
  ;(document.querySelector('.transcript-search-box .search-close') as HTMLElement).click()
  return result
})
check('the search field has no box or focus ring of its own inside the pill',
  fieldChrome.border === '0px' && fieldChrome.shadow === 'none' && fieldChrome.outline === 'none' && fieldChrome.appearance === 'none', fieldChrome)
await openRichestSession(page)

await page.locator('.session-actions-menu .select-trigger').click()
check('session metadata lives in its actions menu', await page.locator('.session-menu-info').count() === 1)
check('session ID action replaces command copy', await page.getByRole('button', { name: 'Copy harness session ID' }).count() === 1)
await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
await page.getByRole('button', { name: 'Copy harness session ID' }).click()
check('copy takes only the native session ID', await page.evaluate(() => navigator.clipboard.readText()) === 'fixture-native-session')
check('copy confirms success with a toast', await page.locator('.toast').filter({ hasText: 'session ID copied' }).count() === 1)

// Export: the ⋯ menu saves the conversation as a file built from the transcript.
await page.locator('.session-actions-menu .select-trigger').click()
const exportItem = page.getByRole('button', { name: /Export as Markdown/ })
check('the session menu offers Export as Markdown', (await exportItem.count()) === 1)
check('the session menu offers Export as Text', (await page.getByRole('button', { name: /Export as Text/ }).count()) === 1)
if (await exportItem.count()) {
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), exportItem.click()])
  const exported = await Bun.file((await download.path())!).text()
  check('the markdown export is named from the session title', download.suggestedFilename().endsWith('.md'), download.suggestedFilename())
  check('the markdown export carries a prompt from the transcript',
    exported.includes('Guard greet() and have an agent double-check the callers.') && exported.startsWith('# '),
    exported.slice(0, 400))
  check('the markdown export leaves the reasoning out', !exported.includes('Guard first, then delegate the caller sweep.'), exported.slice(0, 400))
}

/* ---------------- toasts sit at the top and can be closed ---------------- */

// They used to stack at the bottom right, over the composer and the status bar.
const toastBox = await page.evaluate(() => {
  const toast = document.querySelector('.toast') as HTMLElement | null
  const tabs = document.querySelector('.tabs') as HTMLElement | null
  if (!toast) return null
  const rect = toast.getBoundingClientRect()
  return {
    top: rect.top,
    centre: rect.left + rect.width / 2,
    width: window.innerWidth,
    height: window.innerHeight,
    tabsBottom: tabs?.getBoundingClientRect().bottom ?? 0,
    icon: Boolean(toast.querySelector('.toast-icon svg')),
    close: Boolean(toast.querySelector('button.toast-close[aria-label="Dismiss"]')),
  }
})
if (!toastBox) {
  check('a toast is on screen to measure', false)
} else {
  check('toasts render at the top, under the tab strip', toastBox.top >= toastBox.tabsBottom && toastBox.top < toastBox.height / 3, toastBox)
  check('toasts are centred', Math.abs(toastBox.centre - toastBox.width / 2) < 4, toastBox)
  check('a toast carries an icon for its kind', toastBox.icon, toastBox)
  check('a toast has a close button', toastBox.close, toastBox)
  await page.screenshot({ path: out.replace(/\.png$/, '-toast.png'), fullPage: false })
  await page.locator('.toast .toast-close').first().click()
  await page.waitForTimeout(400)
  check('the close button dismisses the toast', await page.locator('.toast').filter({ hasText: 'session ID copied' }).count() === 0)
}

/* ---------------- scroll container ---------------- */

const scroll = await page.evaluate(() => {
  const node = document.querySelector('.transcript') as HTMLElement | null
  if (!node) return null
  node.scrollTop = 0
  const min = node.scrollTop
  node.scrollTop = 1e6
  const max = node.scrollTop
  const metrics = {
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    maxScroll: max,
    canScroll: max > min,
  }
  node.scrollTop = node.scrollHeight
  return metrics
})
check('the opened session shows a transcript', Boolean(scroll), { opened, layout: layout.transcript })
if (scroll) {
  check('transcript scrolls', scroll.canScroll || scroll.scrollHeight <= scroll.clientHeight, scroll)
  check('transcript has a bounded height', scroll.clientHeight > 100 && scroll.clientHeight < 1200, scroll)
}

/* ---------------- keyboard and search navigation ---------------- */

const searchField = page.locator('.rail-search input')
const rowsBeforeSearch = await page.locator('.rail .session-item').count()
await searchField.fill('this-will-not-match-a-session')
check('search exposes a clear action', await page.locator('.rail-search-clear').count() === 1)
await searchField.press('Escape')
check('Escape clears search without losing sessions',
  (await searchField.inputValue()) === '' && (await page.locator('.rail .session-item').count()) === rowsBeforeSearch)

const keyboardRow = page.locator('.rail .session-item').first()
const keyboardTitle = await keyboardRow.locator('.title-text').textContent()
await keyboardRow.focus()
await keyboardRow.press('Enter')
check('Enter opens a focused session in the rail',
  (await page.locator('.tab.active .label').textContent())?.trim() === keyboardTitle?.trim())
await openRichestSession(page)

/* ---------------- rail collapse ---------------- */

const collapse = await page.evaluate(async () => {
  const group = [...document.querySelectorAll('.rail-title')].find((n) => n.querySelector('.chevron')) as
    | HTMLElement
    | undefined
  if (!group) return null
  const before = document.querySelectorAll('.session-item').length
  group.click()
  await new Promise((r) => setTimeout(r, 120))
  const after = document.querySelectorAll('.session-item').length
  group.click()
  await new Promise((r) => setTimeout(r, 120))
  return { before, after }
})
if (collapse) {
  check('rail group collapses', collapse.before !== collapse.after, collapse)
}

/* ---------------- the rail toggle lives with the rail ---------------- */

const railToggle = await page.evaluate(async () => {
  const toggle = document.querySelector('.tabs .rail-toggle') as HTMLElement | null
  if (!toggle) return { present: false, before: false, after: false, back: false }
  // The rail stays mounted and collapses (so the pane can animate): "hidden" is
  // the class that says it is out of view, not the absence of the element.
  const seen = () => Boolean(document.querySelector('.rail:not(.hidden)'))
  const before = seen()
  toggle.click()
  await new Promise((r) => setTimeout(r, 200))
  const after = seen()
  toggle.click()
  await new Promise((r) => setTimeout(r, 200))
  return { present: true, before, after, back: seen() }
})
check('the rail toggle sits next to the rail, not in the top bar', railToggle.present === true, railToggle)
check(
  'the rail toggle actually hides and restores the rail',
  railToggle.present && railToggle.before !== railToggle.after && railToggle.back === railToggle.before,
  railToggle,
)
const topBarPlus = await page.locator('.bar-actions .icon-btn[title^="New session"]').count()
check('new-session is not offered a fourth time in the top bar', topBarPlus === 0, topBarPlus)

/* ---------------- right-click gives a real menu ---------------- */

const contextMenu = await page.evaluate(async () => {
  // A launched session, not a draft: renaming and pinning belong to something
  // that exists.
  const item = document.querySelector('.session-item:not(.draft)') as HTMLElement | null
  if (!item) return null
  const pinned = () => document.querySelectorAll('.session-item .pin-btn.on').length
  const before = pinned()
  item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 220, clientY: 320 }))
  await new Promise((r) => setTimeout(r, 200))
  const labels = [...document.querySelectorAll('.ctx-pop .ctx-item')].map((node) => node.textContent?.trim() ?? '')
  return { open: Boolean(document.querySelector('.ctx-pop')), labels, before, after: pinned() }
})
if (contextMenu === null) {
  check('a launched session is listed to right-click', false, 'no .session-item:not(.draft) in the rail')
} else {
  check('right-click opens a session menu', contextMenu.open, contextMenu)
  check(
    'the menu offers rename and delete',
    contextMenu.labels.some((label) => /rename/i.test(label)) &&
      contextMenu.labels.some((label) => /delete/i.test(label)),
    contextMenu,
  )
  // Right-click used to toggle the pin behind your back; it must not any more.
  check('right-click no longer silently toggles the pin', contextMenu.before === contextMenu.after, contextMenu)
}
await page.keyboard.press('Escape')
await page.waitForTimeout(200)

await page.screenshot({ path: out, fullPage: false })

/* ---------------- the machine switcher switches ---------------- */

// The top-left control is the machine: one window, one machine at a time, and
// the rail below follows it. It replaced the old recent-workspaces menu.
const beforeMachine = (await page.textContent('.bar .crumb .machine-name'))?.trim() ?? ''
await page.click('.menu .crumb')
await page.waitForTimeout(250)
const menuItems = page.locator('.menu-pop .menu-item')
const menuCount = await menuItems.count()
const menuLabels = await page.locator('.menu-pop .menu-item .menu-item-name').allTextContents()
const targetIndex = menuLabels.findIndex((text) => text.trim() !== '' && text.trim() !== beforeMachine)
if (targetIndex >= 0) await menuItems.nth(targetIndex).click()
await page.waitForTimeout(400)
const afterMachine = (await page.textContent('.bar .crumb .machine-name'))?.trim() ?? ''
if (menuCount < 2) {
  // A second machine is an ssh alias the operator has enabled; there is nothing
  // this repo can do to produce one.
  skip('the machine switcher actually switches', `only one machine is available (${menuLabels.join(', ') || 'none'})`)
} else {
  check('the machine switcher actually switches', afterMachine !== beforeMachine, {
    menuCount,
    targetIndex,
    menuLabels,
    beforeMachine,
    afterMachine,
  })
  // Put it back: everything below assumes the app is on this machine, and the
  // switcher is a persisted choice.
  await page.click('.menu .crumb')
  await page.waitForTimeout(200)
  await page.locator('.menu-pop .menu-item', { hasText: 'This Machine' }).first().click()
  await page.waitForTimeout(300)
}
await page.keyboard.press('Escape')
await page.waitForTimeout(200)

/* ---------------- new tab = inline launchpad ---------------- */

const labelBefore = await page.evaluate(
  () => document.querySelector('.tab.active .label')?.textContent?.trim() ?? '',
)
// ⌘D is the agent shortcut; ⌘T belongs to the terminal (checked just below).
await page.keyboard.press('Meta+d')
await page.waitForTimeout(400)
const launchpad = await page.evaluate(() => {
  const active = document.querySelector('.tab.active .label')?.textContent?.trim() ?? ''
  return {
    labelBefore: null as string | null,
    open: Boolean(document.querySelector('.launchpad')),
    modal: document.querySelector('.launchpad')?.closest('.overlay') !== null,
    chips: document.querySelectorAll('.launchpad-row .chip-select').length,
    composer: Boolean(document.querySelector('.launchpad-field textarea')),
    mic: Boolean(document.querySelector('.launchpad .mic')),
    activeTabTitle: active,
  }
})
launchpad.labelBefore = labelBefore
check('⌘D opens the agent launchpad', launchpad.open, launchpad)
check('the launchpad is inline, not a pop-up', launchpad.modal === false, launchpad.modal)
check('launchpad keeps every setting visible as chips', launchpad.chips >= 4, launchpad.chips)
check('launchpad has a composer', launchpad.composer)
check('launchpad has a microphone', launchpad.mic)
const launchpadAutosize = await checkAutosize('.launchpad-field textarea')
check('launchpad composer grows with multiline text', launchpadAutosize.grown.height > launchpadAutosize.initial.height, launchpadAutosize)
check(
  'launchpad composer has no scrollbar before its cap',
  launchpadAutosize.grown.overflowY === 'hidden' && launchpadAutosize.grown.scrollHeight <= launchpadAutosize.grown.height + 1,
  launchpadAutosize,
)
check(
  'launchpad composer scrolls only after reaching its cap',
  launchpadAutosize.capped.overflowY === 'auto' && launchpadAutosize.capped.scrollHeight > launchpadAutosize.capped.height,
  launchpadAutosize,
)
check('launchpad composer reflows when its width changes', launchpadAutosize.narrow.height > launchpadAutosize.wide.height, launchpadAutosize)
check('launchpad composer shrinks after clearing', launchpadAutosize.shrunk.height <= launchpadAutosize.initial.height + 1, launchpadAutosize)
// The user's complaint: opening a tab must focus the tab, not leave the old one.
check(
  'new tab is selected immediately',
  launchpad.activeTabTitle !== labelBefore && /new session/i.test(launchpad.activeTabTitle),
  { before: labelBefore, after: launchpad.activeTabTitle },
)
await page.screenshot({ path: out.replace(/\.png$/, '-launchpad.png'), fullPage: false })

// The folder chip is the whole point: a workspace is a folder, and the picker
// starts at the root so you can walk down from anywhere.
// The chip opens the workspace menu: recent folders, then "Open folder…" and
// "Import sessions…" (the import button beside the chip is gone).
const workspaceMenu = await page.evaluate(async () => {
  const first = document.querySelector('.launchpad-row .chip-select') as HTMLElement | null
  first?.click()
  await new Promise((r) => setTimeout(r, 250))
  const items = [...document.querySelectorAll<HTMLElement>('.menu-pop .menu-item')]
  return {
    folderIcon: Boolean(first?.querySelector('.chip-icon svg')),
    items: items.map((item) => item.textContent?.trim() ?? ''),
    current: document.querySelectorAll('.menu-pop .menu-item.current').length,
    paths: document.querySelectorAll('.menu-pop .menu-item .menu-item-meta').length,
  }
})
check('the workspace chip carries a folder icon', workspaceMenu.folderIcon, workspaceMenu)
check('the workspace menu offers Open folder…', workspaceMenu.items.includes('Open folder…'), workspaceMenu)
check('the workspace menu offers Import sessions…', workspaceMenu.items.includes('Import sessions…'), workspaceMenu)
check('the workspace menu lists recent folders with the current one checked', workspaceMenu.current === 1 && workspaceMenu.paths >= 1, workspaceMenu)
check('the import button beside the folder chip is gone', (await page.locator('.launchpad-row .import-btn').count()) === 0)
await page.screenshot({ path: out.replace(/\.png$/, '-workspace-menu.png'), fullPage: false })
const folderPicker = await page.evaluate(async () => {
  const open = [...document.querySelectorAll<HTMLElement>('.menu-pop .menu-item')].find((item) => item.textContent?.trim() === 'Open folder…')
  open?.click()
  await new Promise((r) => setTimeout(r, 700))
  const picker = document.querySelector('.folder-picker')
  return {
    open: Boolean(picker),
    head: picker?.querySelector('.picker-head')?.textContent?.trim() ?? '',
    crumbs: (picker?.querySelector('.crumbs')?.textContent ?? '').trim(),
    rows: picker?.querySelectorAll('.picker-row').length ?? 0,
  }
})
check('Open folder… in the workspace menu opens the picker', folderPicker.open, folderPicker)
// The picker browses wherever the app is pointed: with a server selected in the
// machine switcher it lists that server, which needs ssh and is not what these
// two checks are about. Only the local case is asserted.
const machine = (await page.textContent('.bar .crumb .machine-name').catch(() => ''))?.trim() ?? ''
if (machine && machine !== 'This Machine') {
  skip("the picker's starting folder", `the app is on "${machine}", so the picker browses that host over ssh`)
} else {
  // It opens where you already are: walking down from `/` every time was work for
  // nothing. The crumbs still lead up to the machine root.
  check(
    'the picker starts at the workspace you are in',
    folderPicker.open && folderPicker.crumbs !== '/' && folderPicker.crumbs.includes('/'),
    folderPicker,
  )
  check('the picker lists folders to walk into', folderPicker.rows > 3, folderPicker)
}
await page.screenshot({ path: out.replace(/\.png$/, '-launchpad-folder.png'), fullPage: false })
await page.keyboard.press('Escape')
await page.waitForTimeout(200)

/**
 * The last picker (approvals) was cut mid-chevron by the attach button: the
 * lane overflowed with its scrollbar hidden. Pickers now shrink their labels
 * first, so at ordinary widths every chevron sits inside the lane's visible box.
 */
async function lastPickerFits(scope: string) {
  return page.evaluate((root: string) => {
    const lane = document.querySelector<HTMLElement>(`${root} .composer-controls`)
    const triggers = [...(lane?.querySelectorAll<HTMLElement>('.select-trigger') ?? [])]
    const caret = triggers.at(-1)?.querySelector('.caret')?.getBoundingClientRect()
    const box = lane?.getBoundingClientRect()
    const actions = document.querySelector(`${root} .composer-actions`)?.getBoundingClientRect()
    return {
      caretRight: caret?.right ?? null,
      laneRight: box?.right ?? null,
      actionsLeft: actions?.left ?? null,
      fits: Boolean(caret && box && actions && caret.right <= box.right + 0.5 && caret.right <= actions.left),
    }
  }, scope)
}
for (const width of [1280, 900]) {
  await page.setViewportSize({ width, height: 900 })
  await page.waitForTimeout(200)
  const fit = await lastPickerFits('.launchpad')
  check(`the launchpad's last picker is not clipped at ${width}px`, fit.fits, fit)
  await page.screenshot({ path: out.replace(/\.png$/, `-launchpad-row-${width}.png`), fullPage: false })
}
await page.setViewportSize({ width: 1440, height: 900 })
await page.waitForTimeout(150)

/* ---------------- import sessions: two entry points, one popup ---------------- */

// The popup scans every harness store for the folder. In the world this check
// builds, the vendor roots are empty temporary folders (see `tempHome`), so it
// settles on whatever the seeded store archived — or on "nothing to import".
async function readImportPopup() {
  await page.waitForFunction(() => {
    const dialog = document.querySelector('.import-dialog')
    return Boolean(dialog) && !dialog!.querySelector('.import-state .spin')
  }, undefined, { timeout: 8000 }).catch(() => {})
  return page.evaluate(() => {
    const dialog = document.querySelector('.import-dialog')
    return {
      open: Boolean(dialog),
      modal: Boolean(dialog?.closest('.overlay')),
      title: dialog?.querySelector('h2')?.textContent?.trim() ?? '',
      failed: Boolean(dialog?.querySelector('.import-state[role="alert"]')),
      settled: Boolean(dialog) && !dialog!.querySelector('.import-state .spin'),
    }
  })
}
await page.locator('.launchpad-row .chip-select').first().click()
await page.waitForTimeout(200)
const importMenuItem = page.locator('.menu-pop .menu-item', { hasText: 'Import sessions…' })
check('the workspace menu offers Import sessions… beside the folder', (await importMenuItem.count()) === 1)
if (await importMenuItem.count()) await importMenuItem.click()
const importFromComposer = await readImportPopup()
check('Import sessions… in the workspace menu opens the import popup', importFromComposer.open && importFromComposer.title === 'Import Sessions', importFromComposer)
check('the import popup finishes its scan without an error', importFromComposer.settled && !importFromComposer.failed, importFromComposer)
await page.screenshot({ path: out.replace(/\.png$/, '-import.png'), fullPage: false })
await page.keyboard.press('Escape')
await page.waitForTimeout(200)
check('Escape closes the import popup', !(await page.$('.import-dialog')))

await page.click('.rail-title.workspace', { button: 'right' })
await page.waitForTimeout(200)
const importItem = page.locator('.ctx-pop .ctx-item', { hasText: 'Import Sessions' })
check('right-clicking a workspace offers Import Sessions…', (await importItem.count()) === 1)
if (await importItem.count()) await importItem.click()
const importFromRail = await readImportPopup()
check('the workspace menu opens the same import popup', importFromRail.open && importFromRail.title === 'Import Sessions' && !importFromRail.failed, importFromRail)

// The seeded store archived two sessions (Codex and Claude): listed here, hidden
// from the rail. A search and the harness chips narrow the list; clicking a row
// continues it. Archive in its menu puts it away again, which also leaves the
// store as the later checks expect it.
const archivedTitle = 'Migrate the upload bucket'
const otherArchivedTitle = 'Tidy the release notes'
const railTitles = () => page.$$eval('.rail .session-item .title-text', (nodes) => nodes.map((node) => node.textContent?.trim() ?? ''))
const importTitles = () => page.$$eval('.import-dialog .import-row .import-title', (nodes) => nodes.map((node) => node.textContent?.trim() ?? ''))
const archivedRow = await page.evaluate((wanted) => {
  const row = [...document.querySelectorAll('.import-row')].find((item) => item.querySelector('.import-title')?.textContent?.trim() === wanted)
  return {
    listed: Boolean(row),
    badge: row?.querySelector('.import-badge')?.textContent?.trim() ?? '',
    harnessIcon: Boolean(row?.querySelector('.import-harness svg')),
    buttons: [...(row?.querySelectorAll('button') ?? [])].map((button) => button.getAttribute('aria-label')),
    searchFocused: document.activeElement === document.querySelector('.import-search input'),
    chips: [...document.querySelectorAll('.import-chips .chip')].map((chip) => chip.textContent?.replace(/\s+/g, ' ').trim()),
  }
}, archivedTitle)
check('the import popup lists an archived session, marked, with its harness icon', archivedRow.listed && archivedRow.badge === 'Archived' && archivedRow.harnessIcon, archivedRow)
check('an import row has one secondary action (Transfer), the row itself continues', JSON.stringify(archivedRow.buttons) === JSON.stringify(['Transfer']), archivedRow.buttons)
check('the import search is focused when the popup opens', archivedRow.searchFocused, archivedRow)
check('the import popup offers All plus one chip per harness', archivedRow.chips.length === 3 && archivedRow.chips[0]?.startsWith('All') && archivedRow.chips.some((chip) => chip?.startsWith('Codex')) && archivedRow.chips.some((chip) => chip?.startsWith('Claude')), archivedRow.chips)
check('the import list is newest first', JSON.stringify(await importTitles()) === JSON.stringify([archivedTitle, otherArchivedTitle]), await importTitles())

await page.fill('.import-search input', 'RELEASE')
await page.waitForTimeout(100)
check('the import search filters by title, case-insensitively', JSON.stringify(await importTitles()) === JSON.stringify([otherArchivedTitle]), await importTitles())
await page.fill('.import-search input', 'no such session')
await page.waitForTimeout(100)
check('an import search with no match says so', (await page.textContent('.import-dialog .import-empty').catch(() => ''))?.trim() === 'No sessions match')
await page.fill('.import-search input', '')

await page.click('.import-chips .chip[data-harness="claude"]')
await page.waitForTimeout(100)
check('the Claude chip shows only Claude sessions', JSON.stringify(await importTitles()) === JSON.stringify([otherArchivedTitle]), await importTitles())
await page.click('.import-chips .chip[data-harness="codex"]')
await page.waitForTimeout(100)
check('the Codex chip shows only Codex sessions', JSON.stringify(await importTitles()) === JSON.stringify([archivedTitle]), await importTitles())
await page.locator('.import-chips .chip', { hasText: 'All' }).click()
await page.waitForTimeout(100)
check('the All chip shows every session again', (await importTitles()).length === 2, await importTitles())
await page.screenshot({ path: out.replace(/\.png$/, '-import-list.png'), fullPage: false })
const selectedImportTitle = () => page.textContent('.import-dialog .import-row.sel .import-title').catch(() => '')
await page.focus('.import-search input')
await page.keyboard.press('ArrowDown')
const afterDown = await selectedImportTitle()
await page.keyboard.press('ArrowUp')
const afterUp = await selectedImportTitle()
check('arrow keys move the import selection', afterDown === otherArchivedTitle && afterUp === archivedTitle, { afterDown, afterUp })

check('an archived session is not in the rail', !(await railTitles()).includes(archivedTitle))
await page.locator('.import-row', { hasText: archivedTitle }).locator('.import-title').click()
await page.waitForTimeout(900)
const restoredInRail = (await railTitles()).includes(archivedTitle)
check('clicking an import row restores the archived session into the rail and closes the popup', restoredInRail && !(await page.$('.import-dialog')))
const restoredRow = page.locator('.rail .session-item', { hasText: archivedTitle })
if (await restoredRow.count()) {
  await restoredRow.first().click({ button: 'right' })
  await page.waitForTimeout(200)
  const archiveItem = page.locator('.ctx-pop .ctx-item', { hasText: /^Archive$/ })
  check('the session menu offers Archive', (await archiveItem.count()) === 1)
  if (await archiveItem.count()) await archiveItem.click()
  await page.waitForTimeout(700)
  check('Archive hides the session from the rail again', !(await railTitles()).includes(archivedTitle))
}
await page.keyboard.press('Escape')
await page.waitForTimeout(200)

/* ---------------- ⌘T opens the terminal itself ---------------- */

// A terminal has nothing to configure, so the shortcut must land in the shell —
// no form, no extra click. A terminal tab is a tmux session on this machine, so
// this is the one check that spawns something outside the temporary store.
if (!hasTmux) {
  skip('⌘T opens a terminal directly', 'tmux is not installed, and a terminal tab is a tmux session')
} else {
  await page.keyboard.press('Meta+t')
  await page.waitForTimeout(3000)
  // Remembered now, before ⌘W detaches the tab: this is the session this run has
  // to delete on the way out. Only ids that did not exist beforehand count.
  if (sessionsBefore) {
    createdSessions.push(...(await openTabs()).filter((id) => !sessionsBefore.has(id)))
  }
  const terminalShortcut = await page.evaluate(() => ({
    launchpad: Boolean(document.querySelector('.launchpad')),
    term: Boolean(document.querySelector('.term-host .xterm')),
    title: document.querySelector('.tab.active .label')?.textContent?.trim() ?? '',
  }))
  check(
    '⌘T opens a terminal directly, with no form in between',
    terminalShortcut.term && !terminalShortcut.launchpad,
    terminalShortcut,
  )
  check('the terminal tab is named', /^Terminal/.test(terminalShortcut.title), terminalShortcut)
  // Leave the tab without keeping the session open in this window.
  await page.keyboard.press('Meta+w')
  await page.waitForTimeout(300)
}

/* ---------------- a new tab asks the only question ---------------- */

// "+" must open the chooser — agent or terminal — and nothing else, so the mode
// is decided once instead of being a switch you can flick back and forth.
await page.click('.tab-add')
await page.waitForTimeout(350)
const chooser = await page.evaluate(() => ({
  cards: [...document.querySelectorAll('.choose-card .choose-title')].map((n) => n.textContent?.trim()),
  shortcuts: document.querySelectorAll('.choose-card .choose-shortcut').length,
  field: Boolean(document.querySelector('.launchpad-field')),
  title: document.querySelector('.tab.active .label')?.textContent?.trim() ?? '',
}))
check(
  'a new tab asks agent or terminal, and nothing else',
  chooser.cards.length === 2 && chooser.field === false,
  chooser,
)
check('each start card shows its shortcut', chooser.shortcuts === 2, chooser)
await page.screenshot({ path: out.replace(/\.png$/, '-chooser.png'), fullPage: false })
// Back to an agent launchpad for the composer-dependent checks below.
await page.keyboard.press('Meta+d')
await page.waitForTimeout(300)

/* ---------------- settings ---------------- */

await page.keyboard.press('Meta+,')
await page.waitForTimeout(400)
const settings = await page.evaluate(() => ({
  open: Boolean(document.querySelector('.settings')),
  sections: [...document.querySelectorAll('.settings-nav button')].map((n) => n.textContent?.trim()),
  rows: document.querySelectorAll('.settings-row').length,
  hasSearch: Boolean(document.querySelector('.settings-search input')),
}))
check('settings opens with ⌘,', settings.open, settings)
check('settings lists sections on the left', settings.sections.length >= 5, settings.sections)
check('settings has a search field', settings.hasSearch)
const filtered = await page.evaluate(async () => {
  const before = document.querySelectorAll('.settings-row').length
  const input = document.querySelector('.settings-search input') as HTMLInputElement | null
  if (!input) return { before, after: before }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, 'theme')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise((r) => setTimeout(r, 200))
  return { before, after: document.querySelectorAll('.settings-row').length }
})
check('settings search narrows the rows', filtered.after > 0 && filtered.after < filtered.before, filtered)
await page.screenshot({ path: out.replace(/\.png$/, '-settings.png'), fullPage: false })
// In a short window the section list scrolls on its own, below a search
// field that stays put, instead of spilling out of the dialog.
await page.fill('.settings-search input', '')
await page.setViewportSize({ width: 1440, height: 260 })
await page.waitForTimeout(200)
const settingsNav = await page.evaluate(() => {
  const list = document.querySelector<HTMLElement>('.settings-nav-list')
  const search = document.querySelector<HTMLElement>('.settings-search')
  if (!list || !search) return null
  list.scrollTop = list.scrollHeight
  return {
    scrollHeight: list.scrollHeight,
    clientHeight: list.clientHeight,
    overflowY: getComputedStyle(list).overflowY,
    scrolled: list.scrollTop > 0,
    searchVisible: search.getBoundingClientRect().top >= list.closest('.settings')!.getBoundingClientRect().top,
  }
})
check(
  'settings nav scrolls on its own when the window is short',
  Boolean(settingsNav && settingsNav.scrollHeight > settingsNav.clientHeight && settingsNav.overflowY === 'auto' && settingsNav.scrolled && settingsNav.searchVisible),
  settingsNav,
)
await page.setViewportSize({ width: 1440, height: 900 })
await page.waitForTimeout(200)
await page.keyboard.press('Escape')
await page.waitForTimeout(200)

/* ---------------- one kind of dropdown, everywhere ---------------- */

// The composer and the file tree belong to a session, and the checks above left
// a brand new draft tab active. Select a real session from the rail first.
// An agent session, not a terminal or a not-yet-launched draft: the composer's
// menus only exist where a model, an effort and an approval mode do.
const sessionReady = await openRichestSession(page)
check('an agent session is listed in the rail', sessionReady.agent, sessionReady)
if (sessionReady.agent) {
  check('a session is available to inspect', sessionReady.composer, sessionReady)
  const sessionAutosize = await checkAutosize('.composer-inner textarea')
  check('session composer grows with multiline text', sessionAutosize.grown.height > sessionAutosize.initial.height, sessionAutosize)
  check(
    'session composer has no scrollbar before its cap',
    sessionAutosize.grown.overflowY === 'hidden' && sessionAutosize.grown.scrollHeight <= sessionAutosize.grown.height + 1,
    sessionAutosize,
  )
  check(
    'session composer scrolls only after reaching its cap',
    sessionAutosize.capped.overflowY === 'auto' && sessionAutosize.capped.scrollHeight > sessionAutosize.capped.height,
    sessionAutosize,
  )
  check('session composer reflows when its width changes', sessionAutosize.narrow.height > sessionAutosize.wide.height, sessionAutosize)
  check('session composer shrinks after clearing', sessionAutosize.shrunk.height <= sessionAutosize.initial.height + 1, sessionAutosize)

  /* ---------------- a long paste is a document, not a wall of text ---------------- */
  const longText = Array.from({ length: 40 }, (_, index) => `line ${index + 1} of a long pasted log`).join('\n')
  await page.evaluate((text) => {
    const area = document.querySelector<HTMLTextAreaElement>('.composer textarea')!
    area.focus()
    const data = new DataTransfer()
    data.setData('text/plain', text)
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: data })
    area.dispatchEvent(event)
  }, longText)
  await page.waitForSelector('.composer .attach.doc', { timeout: 5000 }).catch(() => null)
  await page.waitForFunction(() => !document.querySelector('.composer .attach.pending'), undefined, { timeout: 5000 }).catch(() => null)
  const pasted = await page.evaluate(() => ({
    value: document.querySelector<HTMLTextAreaElement>('.composer textarea')?.value ?? null,
    tiles: document.querySelectorAll('.composer .attach.doc').length,
    tile: document.querySelector('.composer .attach.doc')?.textContent ?? '',
  }))
  check('a long paste becomes a document tile', pasted.tiles === 1, pasted)
  check('a long paste does not land in the textarea', pasted.value === '', pasted)
  check('the tile shows the first lines and the line count', pasted.tile.includes('line 1 of') && pasted.tile.includes('40L'), pasted)

  await page.locator('.composer .attach.doc .doc-open').click()
  await page.waitForSelector('.doc-viewer textarea', { timeout: 5000 }).catch(() => null)
  const opened = await page.locator('.doc-viewer textarea').inputValue().catch(() => null)
  check('clicking the tile opens the whole document', opened === longText, opened?.slice(0, 80))
  const edited = 'edited document\nsecond line'
  await page.locator('.doc-viewer textarea').fill(edited)
  await page.locator('.doc-viewer .doc-actions button.primary').click()
  await page.waitForFunction(() => !document.querySelector('.doc-viewer') && !document.querySelector('.composer .attach.pending'), undefined, { timeout: 5000 }).catch(() => null)
  await page.waitForTimeout(400) // the draft is written to storage a beat later
  await page.locator('.composer .attach.doc .doc-open').click()
  await page.waitForSelector('.doc-viewer textarea', { timeout: 5000 }).catch(() => null)
  const reopened = await page.locator('.doc-viewer textarea').inputValue().catch(() => null)
  check('an edit is saved and is what the document holds on reopen', reopened === edited, reopened)
  await page.keyboard.press('Escape')
  const stored = await page.evaluate(() => {
    const drafts = JSON.parse(localStorage.getItem('sedano.composer-drafts') ?? '{}') as Record<string, { documents?: { lines?: number }[] }>
    return Object.values(drafts).flatMap((draft) => draft.documents ?? []).map((ref) => ref.lines)
  })
  check('the edited document is what the draft keeps', stored.includes(2), stored)
  await page.locator('.composer .attach.doc .attach-remove').click()
  check('a document tile can be removed', (await page.locator('.composer .attach.doc').count()) === 0)

  /* ---------------- the pickers say what they are with an icon, not a word ---------------- */
  const pickers = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.composer .composer-controls .chip-select')].map((chip) => ({
      text: chip.textContent?.trim() ?? '',
      icon: Boolean(chip.querySelector('.chip-icon svg')),
    })),
  )
  check('the composer pickers carry an icon each', pickers.length >= 3 && pickers.every((picker) => picker.icon), pickers)
  check('the effort picker does not spell out "Effort"', pickers.every((picker) => !/effort/i.test(picker.text)), pickers)
}

/* ---------------- desktop-width layout discipline ---------------- */

/**
 * The composer is deliberately dense, which made it the easiest place to get a
 * superficially reasonable flex layout that failed as soon as a long model name
 * met a smaller desktop window: chips wrapped and the microphone/send controls
 * moved onto different rows. Check the actual rectangles at the desktop widths
 * people use. The options lane may scroll horizontally; the two actions may
 * never wrap, overflow, or lose their shared baseline.
 */
const responsiveLayouts: Array<Record<string, unknown>> = []
for (const width of [1440, 1280, 1080, 900, 860]) {
  await page.setViewportSize({ width, height: 900 })
  await page.waitForTimeout(180)
  if (width === 1280 || width === 900) {
    const fit = await lastPickerFits('.composer')
    check(`the composer's last picker is not clipped at ${width}px`, fit.fits, fit)
  }
  const reading = await page.evaluate((currentWidth: number) => {
    const box = (node: Element | null) => {
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }
    }
    const row = document.querySelector('.composer-row') as HTMLElement | null
    const composer = document.querySelector('.composer-inner') as HTMLElement | null
    const controls = document.querySelector('.composer-controls') as HTMLElement | null
    const mic = document.querySelector('.composer .mic')
    const send = document.querySelector('.composer .send')
    const status = document.querySelector('.statusbar') as HTMLElement | null
    const turnHead = document.querySelector('.turn-head') as HTMLElement | null
    const subagentType = document.querySelector('.subagent-type') as HTMLElement | null
    return {
      width: currentWidth,
      composer: box(composer),
      row: box(row),
      controls: controls ? { ...box(controls), scrollWidth: controls.scrollWidth, clientWidth: controls.clientWidth } : null,
      mic: box(mic),
      send: box(send),
      rowOverflow: row ? { scrollHeight: row.scrollHeight, clientHeight: row.clientHeight } : null,
      status: status ? { ...box(status), scrollHeight: status.scrollHeight, clientHeight: status.clientHeight } : null,
      turnHead: turnHead ? { scrollWidth: turnHead.scrollWidth, clientWidth: turnHead.clientWidth } : null,
      subagentType: subagentType
        ? { height: subagentType.getBoundingClientRect().height, lineHeight: Number.parseFloat(getComputedStyle(subagentType).lineHeight) }
        : null,
    }
  }, width)
  responsiveLayouts.push(reading)
  const data = reading as {
    composer: { left: number; right: number } | null
    mic: { top: number; bottom: number; left: number; right: number } | null
    send: { top: number; bottom: number; left: number; right: number } | null
    rowOverflow: { scrollHeight: number; clientHeight: number } | null
    status: { scrollHeight: number; clientHeight: number } | null
    turnHead: { scrollWidth: number; clientWidth: number } | null
    subagentType: { height: number; lineHeight: number } | null
  }
  check(`composer actions share one row at ${width}px`, Boolean(data.mic && data.send && Math.abs(data.mic.top - data.send.top) < 1), reading)
  check(
    `composer actions stay inside their box at ${width}px`,
    Boolean(data.composer && data.mic && data.send && data.mic.left >= data.composer.left && data.send.right <= data.composer.right),
    reading,
  )
  check(
    `composer controls do not create a second row at ${width}px`,
    Boolean(data.rowOverflow && data.rowOverflow.scrollHeight <= data.rowOverflow.clientHeight + 1),
    reading,
  )
  check(
    `status bar text is never vertically clipped at ${width}px`,
    Boolean(data.status && data.status.scrollHeight <= data.status.clientHeight + 1),
    reading,
  )
  check(
    `turn summaries stay inside their header at ${width}px`,
    Boolean(data.turnHead && data.turnHead.scrollWidth <= data.turnHead.clientWidth + 1),
    reading,
  )
  // This session can have its old turn folded; the gallery below always mounts
  // a subagent and checks that surface directly.
  if (data.subagentType) check(
    `subagent type stays on one line at ${width}px`,
    data.subagentType.height <= data.subagentType.lineHeight * 1.25,
    reading,
  )
  await page.screenshot({ path: out.replace(/\.png$/, `-responsive-${width}.png`), fullPage: false })
}
await page.setViewportSize({ width: 1440, height: 900 })
await page.waitForTimeout(180)

const menus = await page.evaluate(async () => {
  // A native <select> cannot be styled past the OS: if one is left anywhere, the
  // app has two visual languages for the same idea.
  const natives = document.querySelectorAll('select').length
  // The composer is the densest menu surface in the app.
  const composerChips = [...document.querySelectorAll<HTMLElement>('.composer .select-trigger .chip-select')]
  composerChips[0]?.click()
  await new Promise((r) => setTimeout(r, 200))
  const popped = document.querySelector('.menu-pop')
  const items = [...document.querySelectorAll('.menu-pop .menu-item')].map((n) =>
    n.textContent?.trim().slice(0, 24),
  )
  // Escape reaches the menus through the window, not the document.
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  return { natives, chips: composerChips.length, opened: Boolean(popped), items }
})
check('no native select is left in the app', menus.natives === 0, menus.natives)
if (sessionReady.agent) {
  check('the composer chips open a real menu', menus.opened && menus.items.length > 0, menus)
}

/* ---------------- limits explain themselves ---------------- */

// The meters read the usage a vendor CLI reports, so what is in this panel is
// whatever the operator's subscriptions say — nothing a fixture can produce.
// Opt in with SEDANO_CHECK_OPTIONAL=1.
const limits = !wantOptional
  ? { present: false, opened: false, sections: 0, notes: 0, refresh: false }
  : await page.evaluate(async () => {
  const empty = { present: false, opened: false, sections: 0, notes: 0, refresh: false }
  const group = document.querySelector('.statusbar .group.clickable')
  // The button is what opens the panel; the group around it is just layout.
  const trigger = group?.querySelector('.select-trigger') as HTMLElement | null
  if (!group || !trigger) return empty
  trigger.click()
  await new Promise((r) => setTimeout(r, 300))
  // The popover is portalled to the body (so it can never be clipped), which is
  // why this is a document-wide lookup rather than one scoped to the group.
  const pops = [...document.querySelectorAll('.menu-pop')]
  // Pick the panel that actually carries sections: another menu (the workspace
  // switcher) may legitimately be open at the same time.
  const pop = pops.find((node) => node.querySelector('.menu-section')) ?? pops[0] ?? null
  return {
    present: true,
    opened: Boolean(pop),
    popCount: pops.length,
    titles: pops.map((node) => node.querySelector('.menu-title')?.textContent ?? ''),
    // Long enough to reach the footer note, which is the line that explains
    // what the percentages are of.
    html: (pop?.textContent ?? '').slice(0, 260),
    sections: pop?.querySelectorAll('.menu-section').length ?? 0,
    notes: pop?.querySelectorAll('.menu-note').length ?? 0,
    refresh: [...(pop?.querySelectorAll('.menu-item') ?? [])].some((n) => /refresh/i.test(n.textContent ?? '')),
  }
})
if (!limits.present) {
  skip(
    'the limit meters explain themselves',
    wantOptional
      ? 'no harness reported a usage limit on this machine'
      : 'needs a vendor CLI reporting usage — set SEDANO_CHECK_OPTIONAL=1',
  )
} else {
  check('the limit meters are clickable', limits.opened, limits)
  check('clicking them explains the numbers instead of doing nothing', limits.notes > 0, limits)
  check('the panel offers a refresh', limits.refresh, limits)
}
await page.keyboard.press('Escape')
await page.waitForTimeout(150)

/* ---------------- the file tree of the session ---------------- */

const files = await page.evaluate(async () => {
  const toggle = document.querySelector('.tabs .icon-btn:not(.rail-toggle)') as HTMLElement | null
  // The tab strip offers this for a session *and* for a tab that has not started
  // yet: a new tab has a folder too, and the tree is how you see it. So the
  // toggle is looked up by what it does, not by position.
  const tree = [...document.querySelectorAll('.tabs .icon-btn')].find((node) =>
    (node.getAttribute('title') ?? '').toLowerCase().includes('file tree'),
  ) as HTMLElement | null
  if (!toggle && !tree) return { toggle: false }
  const button = (tree ?? toggle) as HTMLElement
  const draft = Boolean(document.querySelector('.launchpad-field'))
  const before = Boolean(document.querySelector('.files-panel'))
  button.click()
  await new Promise((r) => setTimeout(r, 700))
  const panel = document.querySelector('.files-panel')
  const rows = panel?.querySelectorAll('.tree-row').length ?? 0
  button.click()
  await new Promise((r) => setTimeout(r, 250))
  return {
    toggle: true,
    draft,
    before,
    opened: Boolean(panel),
    rows,
    closed: !document.querySelector('.files-panel'),
  }
})
check('the tab strip offers the file tree', files.toggle, files)
if (files.toggle) {
  check('the tab strip can open the file tree', files.opened === true && files.before === false, files)
  // A new tab opens the tree on the folder it has picked, which in a test run can
  // legitimately be empty; a running session's folder is never empty.
  check(
    'the tree lists the directory it was opened on',
    files.draft === true || (files.rows ?? 0) > 0,
    files,
  )
  check('and closes again', files.closed === true, files)
}

/* ---------------- palette ---------------- */

await page.keyboard.press('Meta+k')
await page.waitForTimeout(400)
const palette = await page.evaluate(() => ({
  open: Boolean(document.querySelector('.palette-list')),
  groups: [...document.querySelectorAll('.palette-group')].map((n) => n.textContent),
  items: document.querySelectorAll('.palette-item').length,
}))
check('palette opens with ⌘K', palette.open)
check('palette has groups', palette.groups.length > 0, palette.groups)
await page.screenshot({ path: out.replace(/\.png$/, '-palette.png'), fullPage: false })
await page.keyboard.press('Escape')
await page.waitForTimeout(200)

/* ---------------- dark theme ---------------- */

await page.evaluate(() => {
  localStorage.setItem(
    'sedano.settings',
    JSON.stringify({ theme: 'dark', uiFontSize: 12.5, contentFontSize: 14.5, railVisible: true }),
  )
})
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(1500)
const dark = await page.evaluate(() => ({
  theme: document.documentElement.dataset.theme,
  bg: getComputedStyle(document.body).backgroundColor,
  fg: getComputedStyle(document.body).color,
}))
check('dark theme applied', dark.theme === 'dark', dark)
check('dark surface differs from light', dark.bg !== layout.bg, { light: layout.bg, dark: dark.bg })
await page.screenshot({ path: out.replace(/\.png$/, '-dark.png'), fullPage: false })

// The import popup in the dark theme: opened from the fixture workspace's menu
// (it holds the archived Claude session), looked at, closed.
await page.locator('.rail-title.workspace', { hasText: basename(ROOT) }).first().click({ button: 'right' })
await page.waitForTimeout(200)
const darkImportItem = page.locator('.ctx-pop .ctx-item', { hasText: 'Import Sessions' })
if (await darkImportItem.count()) {
  await darkImportItem.click()
  await readImportPopup()
  await page.screenshot({ path: out.replace(/\.png$/, '-import-dark.png'), fullPage: false })
}
await page.keyboard.press('Escape')
await page.waitForTimeout(200)

/* ---------------- the palette is neutral, not tinted ---------------- */

const tint = await page.evaluate(() => {
  const css = getComputedStyle(document.documentElement)
  const toRgb = (value: string) => {
    const probe = document.createElement('span')
    probe.style.color = value.trim()
    document.body.appendChild(probe)
    const rgb = getComputedStyle(probe).color
    probe.remove()
    const [r, g, b] = rgb.match(/\d+/g)?.map(Number) ?? [0, 0, 0]
    return { r, g, b }
  }
  const accent = toRgb(css.getPropertyValue('--accent'))
  const bg = toRgb(css.getPropertyValue('--bg'))
  const max = Math.max(accent.r, accent.g, accent.b)
  const min = Math.min(accent.r, accent.g, accent.b)
  return { accent, bg, spread: max - min, bgSpread: Math.max(bg.r, bg.g, bg.b) - Math.min(bg.r, bg.g, bg.b) }
})
check('accent is neutral (low chroma)', tint.spread <= 48, tint)
check('surfaces are neutral (low chroma)', tint.bgSpread <= 24, tint)

/* ---------------- independent font scales ---------------- */

await page.evaluate(() => {
  localStorage.setItem(
    'sedano.settings',
    JSON.stringify({ theme: 'light', uiFontSize: 11, contentFontSize: 22, railVisible: true, showThinking: true }),
  )
})
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
// The reload lands on whatever tab the app restores, so the transcript is opened
// again before the content scale is measured on it.
await openRichestSession(page)
const scales = await page.evaluate(() => {
  const transcript = document.querySelector('.transcript')
  const statusbar = document.querySelector('.statusbar')
  const rail = document.querySelector('.rail')
  return {
    body: getComputedStyle(document.body).fontSize,
    content: transcript ? getComputedStyle(transcript).fontSize : null,
    statusbar: statusbar ? getComputedStyle(statusbar).fontSize : null,
    rail: rail ? getComputedStyle(rail).fontSize : null,
  }
})
check('interface font scaled', scales.statusbar === '11px', scales)
check('content font scaled independently', scales.content === '22px', scales)
await page.screenshot({ path: out.replace(/\.png$/, '-bigfont.png'), fullPage: false })

/* ---------------- the readouts tell the truth ---------------- */

/**
 * Three ways the app used to state things nobody told it.
 *
 * The fixture sessions are restored from the store with no metrics of their own,
 * so the server says in so many words that neither a cost nor a context window
 * was reported — which is exactly the case that used to render as `$0.0000` and
 * as an empty ring. `showCost` is turned on because the price is hidden by
 * default, and hiding it would make this check pass by not looking.
 */
await page.evaluate(() => {
  localStorage.setItem(
    'sedano.settings',
    JSON.stringify({ theme: 'light', uiFontSize: 12.5, contentFontSize: 14.5, railVisible: true, showCost: true }),
  )
})
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(1200)
await openRichestSession(page)
const truthful = await page.evaluate(() => {
  const statusbar = document.querySelector('.statusbar')
  const ring = document.querySelector('.composer .ctx-ring')
  return {
    statusbar: statusbar?.textContent ?? '',
    // A price nobody quoted must not be printed as one, in any precision.
    fakeZeroCost: /\$0\.0+(\D|$)/.test(statusbar?.textContent ?? ''),
    costUnreported: Boolean(statusbar?.querySelector('.unreported')),
    ring: Boolean(ring),
    ringUnknown: ring?.classList.contains('unknown') ?? false,
    // The unknown ring must not draw an arc at all: a zero-length arc and a
    // real "0% used" are the same picture.
    ringHasFill: Boolean(ring?.querySelector('.ctx-fill')),
    ringText: ring?.textContent?.trim() ?? '',
  }
})
// The unknown readings are meant to be looked at, not only asserted on.
await page.screenshot({ path: out.replace(/\.png$/, '-unreported.png'), fullPage: false })
check('an unreported cost is not printed as $0.00', !truthful.fakeZeroCost, truthful)
check('an unreported cost says so instead', truthful.costUnreported, truthful)
if (truthful.ring) {
  check('an unreported context ring is marked unknown', truthful.ringUnknown, truthful)
  check('an unreported context ring draws no arc', !truthful.ringHasFill, truthful)
  check('an unreported context ring shows no percentage', truthful.ringText === '—', truthful)
} else {
  check('the composer shows a context ring', false, truthful)
}

/**
 * The approval picker offers only modes the harness will honour.
 *
 * Command Code's headless mode has no channel to ask a question down — `cmd
 * --help` lists `standard`, `plan` and `auto-accept` and nothing else — so
 * "Manual" was a promise its CLI cannot keep. Claude Code's CLI really does take
 * all six, so the same picker must still offer it there: a check that only
 * looked at one harness would pass just as happily for a picker that had been
 * trimmed everywhere.
 */
async function approvalsFor(harness: RegExp) {
  return page.evaluate(async (pattern: string) => {
    const want = new RegExp(pattern, 'i')
    const rows = [...document.querySelectorAll<HTMLElement>('.rail .session-item:not(.draft)')]
    const row = rows.find((node) => want.test(node.querySelector('.meta')?.textContent ?? ''))
    if (!row) return { found: false, active: '', opened: false, labels: [] as string[] }
    row.click()
    await new Promise((r) => setTimeout(r, 900))
    // `title` sits on the menu wrapper, not on the button inside it.
    const wrap = [...document.querySelectorAll<HTMLElement>('.composer .menu')].find((node) =>
      /approval/i.test(node.getAttribute('title') ?? ''),
    )
    const trigger = wrap?.querySelector('.select-trigger') as HTMLElement | null
    trigger?.click()
    await new Promise((r) => setTimeout(r, 250))
    const labels = [...document.querySelectorAll('.menu-pop .menu-item')].map((n) => n.textContent?.trim() ?? '')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    // Which session the picker belongs to, so this cannot quietly assert about
    // some other harness's composer.
    const active = document.querySelector('.rail .session-item.active .meta')?.textContent ?? ''
    return { found: true, active, opened: labels.length > 0, labels }
  }, harness.source)
}
const hasMode = (labels: string[], mode: RegExp) => labels.some((label) => mode.test(label.replace('✓', '').trim()))
const approvals = {
  commandcode: await approvalsFor(/command code/),
  claude: await approvalsFor(/claude code/),
}
if (!approvals.commandcode.found) {
  check('a Command Code session exists to check its picker', false, approvals)
} else {
  check(
    'the Command Code session is the one being inspected',
    /command code/i.test(approvals.commandcode.active),
    approvals.commandcode,
  )
  check('the approval picker opens', approvals.commandcode.opened, approvals.commandcode)
  check(
    'Command Code is not offered a "Manual" approval mode its CLI does not have',
    !hasMode(approvals.commandcode.labels, /^manual$/i),
    approvals.commandcode,
  )
  check(
    'Command Code is not offered "Auto", which is its accept-edits flag under a second name',
    !hasMode(approvals.commandcode.labels, /^auto$/i),
    approvals.commandcode,
  )
}
if (!approvals.claude.found) {
  check('a Claude Code session exists to check its picker', false, approvals)
} else {
  check(
    'Claude Code keeps the "Manual" mode its CLI really accepts',
    hasMode(approvals.claude.labels, /^manual$/i),
    approvals.claude,
  )
}
await page.keyboard.press('Escape')
await page.waitForTimeout(150)

/* ---------------- component gallery (fixtures, no server) ---------------- */

const gallery = {
  turns: 0,
  tools: 0,
  subagents: 0,
  files: 0,
  diffs: 0,
  answers: 0,
  answersMissing: 0,
  collapsed: 0,
  answersMissingWhenCollapsed: 0,
  fileGroupsFolded: false,
}
async function shootGallery(theme: 'light' | 'dark', file: string): Promise<void> {
  await page.goto(`${galleryBase}/preview.html?theme=${theme}`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  // Diffs are behind a click by design; open the first one so the check proves
  // the patch renderer actually works.
  await page.evaluate(() => {
    // A subagent that has come back folds its prompt and its work away, and its
    // work is where the nested file card lives: open it first, the way anyone
    // checking a finished turn would, or half of what this counts is not drawn.
    for (const node of document.querySelectorAll<HTMLElement>('.subagent-head')) {
      if (node.querySelector('.chevron:not(.open)')) node.click()
    }
  })
  await page.waitForTimeout(250)
  // The file lists fold by default: check that, then open them to reach the files.
  gallery.fileGroupsFolded = await page.evaluate(() => {
    const groups = [...document.querySelectorAll<HTMLElement>('.file-group')]
    const folded = groups.length > 0 && groups.every((group) => !group.classList.contains('open') && !group.querySelector('.file-card'))
    for (const head of document.querySelectorAll<HTMLElement>('.file-group-head[aria-expanded="false"]')) head.click()
    return folded
  })
  await page.waitForTimeout(250)
  await page.evaluate(() => {
    const head = document.querySelector('.file-head') as HTMLElement | null
    head?.click()
  })
  await page.waitForTimeout(250)
  const counts = await page.evaluate(() => {
    const turns = [...document.querySelectorAll('.turn')]
    // The reply must sit outside the collapsible work block, and a collapsed
    // turn must still show it — otherwise the answer needs a click to be read.
    // `.turn-agent` is the bracket around everything the agent did and said, so
    // the reply is one level in; it is still outside the collapsible work block,
    // which is what this asserts.
    const hasAnswer = (turn: Element) => Boolean(turn.querySelector(':scope > .turn-agent > .msg-assistant.answer'))
    const answers = turns.filter(hasAnswer)
    // A turn that said anything at all must have its reply outside the block:
    // if it only lives inside, reading it costs a click.
    const missing = turns.filter((turn) => turn.querySelector('.msg-assistant') && !hasAnswer(turn))
    const collapsed = turns.filter((turn) => turn.querySelector('.turn-toggle .chevron:not(.open)'))
    const collapsedMissingReply = collapsed.filter((turn) => !hasAnswer(turn))
    return {
      turns: turns.length,
      tools: document.querySelectorAll('.tool').length,
      subagents: document.querySelectorAll('.subagent').length,
      files: document.querySelectorAll('.file-card').length,
      diffs: document.querySelectorAll('.diff div').length,
      answers: answers.length,
      answersMissing: missing.length,
      collapsed: collapsed.length,
      answersMissingWhenCollapsed: collapsedMissingReply.length,
    }
  })
  if (theme === 'light') Object.assign(gallery, counts)
  await page.screenshot({ path: file, fullPage: false })
}

/**
 * Clicking an option must never claim the answer arrived.
 *
 * The gallery is the one surface with a question still open, and its store has
 * no socket — so the answer leaves the card as `sending` and stays there, which
 * is exactly the window the old card lied in: it wrote "answer sent" from the
 * click handler, before the message had left the browser, so an answer the
 * server went on to refuse looked identical to one that was delivered.
 */
const answering = { clickable: false, afterClick: '', disabledAfterClick: false }
async function checkAnswerIsNotClaimed(): Promise<void> {
  await page.goto(`${galleryBase}/preview.html?theme=light`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  const result = await page.evaluate(async () => {
    const option = document.querySelector<HTMLButtonElement>('.question .question-option')
    if (!option) return null
    const clickable = !option.disabled
    option.click()
    await new Promise((r) => setTimeout(r, 300))
    return {
      clickable,
      afterClick: (document.querySelector('.question .question-foot')?.textContent ?? '').trim(),
      disabledAfterClick: Boolean(
        document.querySelector<HTMLButtonElement>('.question .question-option')?.disabled,
      ),
    }
  })
  if (!result) {
    check('the gallery still renders an open question card', false)
    return
  }
  Object.assign(answering, result)
  check('an open question card is clickable', result.clickable, result)
  check('answering does not claim the answer arrived', !/answer sent/i.test(result.afterClick), result)
  check('answering says it is sending', /sending/i.test(result.afterClick), result)
  check('a card being answered stops taking clicks', result.disabledAfterClick, result)
}

/**
 * The context ring has three readings, and they must not look alike.
 *
 * Confident — the harness published its window. Approximate — there is a window,
 * but it was guessed from the model name (`contextWindowInferred`), which is the
 * ordinary case for most harnesses. Unknown — nothing was reported at all.
 *
 * Only the *rendering* contract is asserted here, by drawing the three rings
 * side by side: three classes that look alike would make the three states one
 * state. Which `SessionMetrics` earns which class is the other half of the
 * contract, and it is asserted next door (`checkReadoutMapping`) against the
 * gallery's readout fixtures.
 */
const ctxRings: Record<string, { track: string; fill: string; color: string }> = {}
async function checkContextRingStates(): Promise<void> {
  const readings = await page.evaluate(() => {
    const host = document.createElement('div')
    host.id = 'ctx-ring-probe'
    host.innerHTML = ['', 'approx', 'unknown']
      .map(
        (variant) =>
          `<span class="ctx-ring ${variant}" data-variant="${variant || 'confident'}">` +
          '<svg viewBox="0 0 20 20" width="20" height="20">' +
          '<circle class="ctx-track" cx="10" cy="10" r="7.5"></circle>' +
          '<circle class="ctx-fill" cx="10" cy="10" r="7.5"></circle>' +
          '</svg><span class="mono ctx-percent">62%</span></span>',
      )
      .join('')
    document.body.append(host)
    const out: Record<string, { track: string; fill: string; color: string }> = {}
    for (const ring of host.querySelectorAll<HTMLElement>('.ctx-ring')) {
      const track = ring.querySelector('.ctx-track') as SVGElement
      const fill = ring.querySelector('.ctx-fill') as SVGElement
      out[ring.dataset.variant as string] = {
        track: getComputedStyle(track).stroke,
        fill: getComputedStyle(fill).stroke,
        color: getComputedStyle(ring).color,
      }
    }
    host.remove()
    return out
  })
  Object.assign(ctxRings, readings)
  const confident = readings.confident
  const approx = readings.approx
  const unknown = readings.unknown
  if (!confident || !approx || !unknown) {
    check('the three context readings render', false, readings)
    return
  }
  check(
    'an approximate context reading is drawn differently from a confident one',
    approx.track !== confident.track || approx.fill !== confident.fill,
    readings,
  )
  check(
    'an approximate context reading is not drawn as an unknown one',
    approx.track !== unknown.track || approx.color !== unknown.color,
    readings,
  )
  check('an unknown context reading is drawn differently from a confident one', unknown.track !== confident.track, readings)
}

/**
 * Which metrics earn which reading.
 *
 * Three rings that look different prove nothing on their own: the defect this
 * pass fixed was a *mapping* one — an estimated window drawn exactly like a
 * measured one, and a silence drawn as "0%". No stored session carries metrics
 * (they are never persisted), so the gallery stages the three shapes as
 * fixtures and this reads back what the real components made of them:
 *
 *   contextReported:false                          → dashed ring, no arc, "—"
 *   contextReported:true, contextWindowInferred:true → an arc and a "≈" percentage
 *   contextReported:true, contextWindowInferred:false → an arc and a bare percentage
 *
 * The cost readout is the same rule in the status bar: `costReported:false` is
 * an em dash, and a price that really was quoted — zero included — is a figure.
 */
type RingReading = { unknown: boolean; approx: boolean; text: string; arc: boolean } | null
type BarReading = { text: string; cost: string; unreported: boolean } | null
const readouts = {
  reported: null as RingReading,
  inferred: null as RingReading,
  unknown: null as RingReading,
  costUnreported: null as BarReading,
  costZero: null as BarReading,
}
async function checkReadoutMapping(): Promise<void> {
  await page.goto(`${galleryBase}/preview.html?theme=light`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  const found = await page.evaluate(() => {
    const ring = (name: string) => {
      const node = document.querySelector(`[data-case="${name}"] .ctx-ring`)
      if (!node) return null
      return {
        unknown: node.classList.contains('unknown'),
        approx: node.classList.contains('approx'),
        text: (node.textContent ?? '').trim(),
        // The arc is the "how full" claim: an unknown reading must not draw one,
        // because a zero-length arc and a real 0% are the same picture.
        arc: Boolean(node.querySelector('.ctx-fill')),
      }
    }
    const bar = (name: string) => {
      const node = document.querySelector(`[data-case="${name}"] .statusbar`)
      if (!node) return null
      // The status bar marks every silence with `.unreported`, context included,
      // so the cost readout is picked by its own tooltip: asking the whole bar
      // whether anything is unreported would answer about the wrong number.
      const cost = node.querySelector('[title*="cost"]')
      return {
        text: (node.textContent ?? '').trim(),
        cost: (cost?.textContent ?? '').trim(),
        unreported: Boolean(cost?.classList.contains('unreported')),
      }
    }
    return {
      reported: ring('ctx-reported'),
      inferred: ring('ctx-inferred'),
      unknown: ring('ctx-unknown'),
      costUnreported: bar('cost-unreported'),
      costZero: bar('cost-zero'),
    }
  })
  Object.assign(readouts, found)
  const { reported, inferred, unknown, costUnreported, costZero } = found
  if (!reported || !inferred || !unknown) {
    check('the gallery renders one context ring per metric shape', false, found)
  } else {
    check(
      'a reported window renders as a plain percentage',
      /^\d+%$/.test(reported.text) && !reported.unknown && !reported.approx && reported.arc,
      reported,
    )
    check(
      'an inferred window renders as an approximation',
      inferred.approx && /^≈\d+%$/.test(inferred.text) && !inferred.unknown && inferred.arc,
      inferred,
    )
    check(
      'metrics that report no context render the unknown ring',
      unknown.unknown && unknown.text === '—' && !unknown.arc,
      unknown,
    )
  }
  if (!costUnreported || !costZero) {
    check('the gallery renders one status bar per cost shape', false, found)
  } else {
    check(
      'an unreported cost is never printed as a zero price',
      !/\$\s*0\.0/.test(costUnreported.text) && costUnreported.unreported && /^\$\s*—$/.test(costUnreported.cost),
      costUnreported,
    )
    check(
      'a cost that really was quoted as zero is printed as a figure',
      /^\$0\.0+$/.test(costZero.cost) && !costZero.unreported,
      costZero,
    )
  }
}

/**
 * After a reconnect, the reply is on screen exactly once.
 *
 * A socket dropping mid-stream left the streamed text in the `live` buffer; the
 * authoritative `timeline` that followed never cleared it, so the same reply was
 * drawn twice — once from the timeline and once from the leftover buffer — and
 * never went away. The fix gates the buffer on turn identity, and this is that
 * gate at the render level: `?live=stale` hands the transcript a buffer holding
 * the *first* turn's reply while the *second* turn is the one on screen, which
 * is exactly the shape a dropped socket leaves behind.
 *
 * Both directions matter. A buffer belonging to another turn must be dropped
 * (or the reply appears twice), and a buffer belonging to the turn on screen
 * must still be drawn (or nothing streams any more).
 */
const REPLAYED = 'The limiter is in and covered'
const STREAMING = 'The failure is upstream of the limiter'
const liveBuffer = {
  fresh: { turns: 0, replayed: -1, streaming: -1 },
  stale: { turns: 0, replayed: -1, streaming: -1 },
}
async function checkLiveBufferBelongsToItsTurn(): Promise<void> {
  const read = async (query: string) => {
    await page.goto(`${galleryBase}/preview.html?theme=light${query}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(700)
    return page.evaluate(
      ([replayed, streaming]: string[]) => {
        const text = document.querySelector('.transcript')?.textContent ?? ''
        const count = (needle: string) => text.split(needle).length - 1
        return { turns: document.querySelectorAll('.turn').length, replayed: count(replayed), streaming: count(streaming) }
      },
      [REPLAYED, STREAMING],
    )
  }
  liveBuffer.fresh = await read('')
  liveBuffer.stale = await read('&live=stale')
  await page.screenshot({ path: out.replace(/\.png$/, '-gallery-stale.png'), fullPage: false })
  // The counts only mean something if the thread is on screen at all.
  check('the stale-buffer gallery still renders the thread', liveBuffer.stale.turns >= 2, liveBuffer)
  check(
    'a live buffer left over from another turn is not rendered',
    liveBuffer.stale.replayed === 1,
    liveBuffer,
  )
  check(
    'the reply of the turn being streamed is still rendered',
    liveBuffer.fresh.streaming === 1,
    liveBuffer,
  )
  check('and the earlier reply is not duplicated while it streams', liveBuffer.fresh.replayed === 1, liveBuffer)
}

/**
 * The turn's two readings, and the things that used to be illegible in them.
 *
 * The complaint this pass answers is that a turn still working and a turn that
 * had answered looked the same — output streams while the work is going on, so
 * prose on screen proved nothing. `preview.html?only=turns` stages both readings
 * of the same turn side by side with no furniture over them, which is the only
 * way a check (or a person) can compare them.
 *
 * Asserted here: the two states differ in the DOM rather than only in a word;
 * the Skill card carries the skill's name; one turn with three assistant
 * messages is one answer block; a failed subagent is never the thing that gets
 * folded away; and the jump control overlaps nothing.
 */
const turnStates = {
  working: null as Record<string, unknown> | null,
  finished: null as Record<string, unknown> | null,
  multiReply: null as Record<string, unknown> | null,
  failed: null as Record<string, unknown> | null,
  overlaps: [] as string[],
}
async function checkTurnStates(): Promise<void> {
  await page.goto(`${galleryBase}/preview.html?theme=light&only=turns`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(800)

  const read = await page.evaluate(() => {
    const one = (id: string) => {
      const host = document.querySelector(`[data-case="${id}"]`)
      const turn = host?.querySelector('.turn')
      if (!turn) return null
      const answer = turn.querySelector('.msg-assistant.answer')
      return {
        state: turn.getAttribute('data-state') ?? '',
        // The turn's own live signal: the spinner at its bottom, which a settled
        // turn has not — and which is never repeated in the header.
        liveMark: Boolean(turn.querySelector('.turn-live .thinking-indicator')),
        headSpinner: Boolean(turn.querySelector('.turn-head .thinking-indicator')),
        liveIsLast: turn.querySelector('.turn-agent')?.lastElementChild?.classList.contains('turn-live') ?? false,
        outputParts: turn.querySelectorAll('.turn-output > .output-part').length,
        outputSeparators: turn.querySelectorAll('.turn-output .output-sep').length,
        elapsed: Boolean(turn.querySelector('.turn-elapsed')),
        title: (turn.querySelector('.turn-title')?.textContent ?? '').trim(),
        workRule: turn.querySelector('.turn-body')
          ? getComputedStyle(turn.querySelector('.turn-body') as Element).borderLeftWidth
          : '',
        noteRules: [...turn.querySelectorAll('.activity-note')].map((node) => getComputedStyle(node).borderLeftWidth),
        headerWidth: (turn.querySelector('.turn-head') as HTMLElement).getBoundingClientRect().width,
        turnWidth: (turn as HTMLElement).getBoundingClientRect().width,
        headerShadow: getComputedStyle(turn.querySelector('.turn-head') as Element).boxShadow,
        answers: turn.querySelectorAll('.msg-assistant.answer').length,
        answerClass: answer?.className ?? '',
        caret: Boolean(turn.querySelector('.answer-caret')),
        answerText: (answer?.textContent ?? '').trim(),
        liveProgress: [...turn.querySelectorAll('.turn-body .activity-note.live')].map((node) => (node.textContent ?? '').trim()),
        repeatedLabels: turn.querySelectorAll('.work-label, .work-update-label, .think .block-label').length,
        stickyHeader: getComputedStyle(turn.querySelector('.turn-head') as Element).position,
        reasoningEmphasisWeight: turn.querySelector('.think strong')
          ? getComputedStyle(turn.querySelector('.think strong') as Element).fontWeight
          : '',
        // Every tool card's visible head text, so an empty one is visible here.
        toolHeads: [...turn.querySelectorAll('.tool')].map((node) => ({
          tool: node.getAttribute('data-tool') ?? '',
          summary: (node.querySelector('.summary')?.textContent ?? '').trim(),
        })),
        subagents: [...turn.querySelectorAll('.subagent')].map((node) => ({
          state: node.getAttribute('data-state') ?? '',
          detailOpen: Boolean(node.querySelector('.subagent-detail.open')),
          // The conclusion must be readable without opening anything: the
          // folded line previews the first line of what the agent came back with.
          result: (node.querySelector(':scope > .wr .subagent-preview')?.textContent ?? '').trim().slice(0, 80),
          failedMark: (node.querySelector(':scope > .wr .wr-status.failed')?.textContent ?? '').trim(),
          lines: node.querySelectorAll(':scope > .wr').length,
          height: Math.round((node as HTMLElement).getBoundingClientRect().height),
        })),
        notices: turn.querySelectorAll('.turn-notes').length,
        // The per-result timing lines and the hook rows: folded, so none of them
        // may be painted between the work and the reply.
        visibleNoticeLines: [...turn.querySelectorAll('.turn-body > .line-result, .turn-body > .line-system')].length,
      }
    }
    return {
      working: one('turn-working'),
      finished: one('turn-finished'),
      multiReply: one('turn-multi-reply'),
      failed: one('turn-subagent-failed'),
    }
  })

  Object.assign(turnStates, read)
  const { working, finished, multiReply, failed } = read
  if (!working || !finished || !multiReply || !failed) {
    check('the turn-state gallery renders every case', false, read)
    return
  }

  /* --- in progress and finished are not the same picture --- */
  check('a turn still working is marked as such in the DOM', working.state === 'working', working)
  check('a turn that has answered is marked as finished', finished.state === 'done', finished)
  check(
    'the two states differ by the live spinner and clock without extra rules',
    working.liveMark !== finished.liveMark &&
      working.elapsed !== finished.elapsed &&
      working.workRule === '0px' &&
      working.noteRules.every((width: string) => width === '0px'),
    { working, finished },
  )
  check(
    'the working header is words, not a spinner: "Working for …"',
    !working.headSpinner && /^Working for \d+[smh]/.test(working.title as string),
    working,
  )
  check('the live indicator sits at the bottom of the turn, after what it said', working.liveIsLast === true, working)
  check('a settled turn has no live indicator', !finished.liveMark && !finished.liveIsLast, finished)
  check('a finished turn says how long it took', /^Worked for \d+s$/.test(finished.title), finished)
  check(
    'live prose stays inside activity rather than masquerading as an answer',
    working.answers === 0 && Array.isArray(working.liveProgress) && working.liveProgress.some((text: string) => text.includes('Dispatching both agents')) && !working.caret,
    working,
  )
  check('working header is sticky and activity labels are not repeated', working.stickyHeader === 'sticky' && working.repeatedLabels === 0, working)
  check('reasoning emphasis does not become a heavy headline', Number(working.reasoningEmphasisWeight) <= 400, working.reasoningEmphasisWeight)
  const stickyReach = await page.evaluate(() => {
    const host = document.querySelector('[data-case="turn-working"]')
    const scroller = host?.querySelector<HTMLElement>('.transcript')
    const body = host?.querySelector<HTMLElement>('.turn-body')
    const header = host?.querySelector<HTMLElement>('.turn-head')
    if (!scroller || !body || !header) return null
    body.style.minHeight = '1200px'
    scroller.scrollTop = 500
    const scrollerTop = scroller.getBoundingClientRect().top
    const headerTop = header.getBoundingClientRect().top
    return { scrollTop: scroller.scrollTop, offset: headerTop - scrollerTop }
  })
  check('the working disclosure remains reachable after a long scroll', Boolean(stickyReach && stickyReach.scrollTop > 400 && stickyReach.offset >= 0 && stickyReach.offset < 24), stickyReach)
  check(
    'and the finished turn says the opposite',
    /final/.test(finished.answerClass) && !finished.caret,
    finished,
  )

  /* --- the Skill card --- */
  const skill = working.toolHeads.find((tool: { tool: string }) => tool.tool === 'Skill')
  check('the gallery renders a skill call', Boolean(skill), working.toolHeads)
  check(
    'the skill card shows the skill it is running, not just the word "Skill"',
    skill?.summary === 'superpowers:dispatching-parallel-agents',
    skill,
  )

  /* --- one turn reads as one thing --- */
  check('three assistant messages of one turn are one answer', multiReply.answers === 1, multiReply)
  check(
    'and each is its own moment in it: three parts, a time before the second and the third',
    multiReply.outputParts === 3 && multiReply.outputSeparators === 2,
    multiReply,
  )
  check(
    'and none of them is lost in the merge',
    ['2 agents dispatched', 'One is back', 'Both done'].every((needle) => multiReply.answerText.includes(needle)),
    multiReply.answerText,
  )

  /* --- the noise between the work and the reply --- */
  check('routine harness notices are folded behind a disclosure', finished.notices === 1, finished)
  check(
    'no timing or hook line is painted between the work and the reply',
    finished.visibleNoticeLines === 0,
    finished,
  )

  /* --- subagent cards: compact, but never dishonest --- */
  const doneAgent = finished.subagents[0]
  const failedAgent = failed.subagents[0]
  check('a finished subagent card folds its prompt, its work and its result away', doneAgent?.detailOpen === false, doneAgent)
  check('a folded subagent is one line', doneAgent?.lines === 1 && (doneAgent?.height ?? 99) <= 40 && (failedAgent?.height ?? 99) <= 40, { doneAgent, failedAgent })
  check('but its line still previews what the agent concluded', (doneAgent?.result ?? '').includes('142.251'), doneAgent)
  check('a failed subagent card is marked failed', failedAgent?.state === 'failed', failedAgent)
  check(
    'a failed subagent says so on its folded line, with the reason',
    failedAgent?.failedMark === 'Failed' && (failedAgent?.result ?? '').includes('never started'),
    failedAgent,
  )

  /* --- nothing overlaps --- */
  // The jump control used to be a pill parked over the scroller, so it sat on
  // whatever line happened to be at the bottom of the view — the RESULT of a
  // subagent card, in the report. Scroll away from the bottom to summon it, then
  // compare its box against every element the transcript paints.
  // The main gallery thread, because summoning the control needs a transcript
  // long enough to scroll away from the bottom of.
  await page.goto(`${galleryBase}/preview.html?theme=light`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)
  const overlaps = await page.evaluate(() => {
    const scroller = document.querySelector('.transcript') as HTMLElement | null
    if (!scroller) return ['no transcript']
    scroller.scrollTop = 0
    scroller.dispatchEvent(new Event('scroll'))
    return new Promise<string[]>((resolve) => {
      setTimeout(() => {
        const wrap = scroller.closest('.transcript-wrap') as HTMLElement | null
        const jump = wrap?.querySelector('.jump') as HTMLElement | null
        if (!jump) return resolve(['no jump control'])
        const a = jump.getBoundingClientRect()
        // Transcript rows are clipped by the scroller, and a clipped row is not
        // on screen however far its own box runs: compare against what the
        // scroller actually paints, or half the thread counts as an overlap.
        const clip = scroller.getBoundingClientRect()
        const hits: string[] = []
        for (const node of wrap!.querySelectorAll<HTMLElement>('.thread *')) {
          if (!node.textContent?.trim()) continue
          const b = node.getBoundingClientRect()
          if (!b.width || !b.height) continue
          const top = Math.max(b.top, clip.top)
          const bottom = Math.min(b.bottom, clip.bottom)
          if (bottom <= top) continue
          const overlap =
            Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
            Math.max(0, Math.min(a.bottom, bottom) - Math.max(a.top, top))
          if (overlap > 1) hits.push(`${node.className || node.tagName}: ${node.textContent.trim().slice(0, 40)}`)
        }
        resolve(hits)
      }, 350)
    })
  })
  turnStates.overlaps = overlaps as string[]
  check('the jump control overlaps nothing in the transcript', (overlaps as string[]).length === 0, overlaps)

  await page.goto(`${galleryBase}/preview.html?theme=light&only=turns`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  await page.screenshot({ path: out.replace(/\.png$/, '-turns.png'), fullPage: true })
  await page.goto(`${galleryBase}/preview.html?theme=dark&only=turns`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(600)
  await page.screenshot({ path: out.replace(/\.png$/, '-turns-dark.png'), fullPage: true })
}

/**
 * Every failure shape, as a person actually meets it.
 *
 * The complaint this answers is a raw stack trace dumped into the transcript
 * with nothing around it saying what it was or whose it was. So what is asserted
 * here is legibility, not merely presence: one paragraph of prose on screen, the
 * trace behind a disclosure that starts closed, the whole report one click from
 * the clipboard — and, the part the transcript used to get wrong, the failure
 * still on screen when the turn that produced it is folded up.
 *
 * `preview.html?only=turns` carries one turn per shape plus a turn whose stderr
 * was only chatter, which is the comparison the last two checks read.
 */
const failureCards = {
  cases: [] as Array<Record<string, unknown>>,
  chatterErrors: -1,
  chatterSystem: 0,
  openedDetail: '',
  collapsedHeadline: '',
  collapsedVisible: false,
  contrast: [] as string[],
}
async function checkFailureCards(): Promise<void> {
  await page.goto(`${galleryBase}/preview.html?theme=light&only=turns`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(700)

  const read = await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[data-case^="err-"]')].map((node) => node.getAttribute('data-case') ?? '')
    const cases = ids
      .filter((id) => id !== 'err-chatter')
      .map((id) => {
        const host = document.querySelector(`[data-case="${id}"]`)!
        const card = host.querySelector('.line-error')
        const headline = (card?.querySelector('.error-headline')?.textContent ?? '').trim()
        const fold = card?.querySelector('.error-fold')
        return {
          id,
          card: Boolean(card),
          // One card, and it is not inside the collapsible: a failure drawn both
          // inside the fold and beside the reply is two cards, and the one the
          // eye finds first is the one that disappears when the turn folds up.
          cards: host.querySelectorAll('.line-error').length,
          inFold: Boolean(card?.closest('.turn-fold')),
          headline,
          // One paragraph: a newline here means the raw report leaked into it.
          oneParagraph: !headline.includes('\n'),
          // No stack frame, no JSON, no bare exception name on its own.
          noFrames: !/\n\s+at /.test(headline) && !headline.startsWith('    at '),
          sentence: /[.?!]$/.test(headline),
          disclosure: Boolean(card?.querySelector('.error-more')),
          expanded: card?.querySelector('.error-more')?.getAttribute('aria-expanded') ?? '',
          // Mounted but folded: height zero is what "closed" means here.
          detailHeight: fold ? Math.round((fold as HTMLElement).getBoundingClientRect().height) : -1,
          detailText: (card?.querySelector('.error-detail')?.textContent ?? '').trim().length,
          copy: Boolean(card?.querySelector('.copy-btn')),
        }
      })
    const chatter = document.querySelector('[data-case="err-chatter"]')
    return {
      cases,
      chatterErrors: chatter ? chatter.querySelectorAll('.line-error').length : -1,
      chatterSystem: chatter ? chatter.querySelectorAll('.line-system').length : 0,
    }
  })
  Object.assign(failureCards, read)

  if (!read.cases.length) {
    check('the gallery stages every failure shape', false, read)
    return
  }
  check('the gallery stages every failure shape', read.cases.length >= 7, read.cases.length)
  for (const item of read.cases) {
    check(`${item.id} renders as a failure card`, item.card, item)
    check(`${item.id} renders exactly one, outside the collapsible work block`, item.cards === 1 && !item.inFold, item)
    check(`${item.id} leads with one paragraph of prose`, item.oneParagraph && item.headline.length > 40, item)
    check(`${item.id} keeps the raw report out of that paragraph`, item.noFrames, item.headline)
    check(`${item.id} says it as a sentence`, item.sentence, item.headline)
    check(`${item.id} offers the detail behind a disclosure`, item.disclosure, item)
    check(`${item.id} starts with the detail closed`, item.expanded === 'false' && item.detailHeight === 0, item)
    check(`${item.id} still holds the whole report`, (item.detailText as number) > 10, item)
    check(`${item.id} can be copied in one click`, item.copy, item)
  }

  /* --- the disclosure actually discloses --- */
  const opened = await page.evaluate(async () => {
    const host = document.querySelector('[data-case="err-broken-pipe"]')!
    const button = host.querySelector<HTMLButtonElement>('.error-more')!
    button.click()
    await new Promise((r) => setTimeout(r, 400))
    const fold = host.querySelector('.error-fold') as HTMLElement
    return {
      expanded: button.getAttribute('aria-expanded') ?? '',
      height: Math.round(fold.getBoundingClientRect().height),
      text: (host.querySelector('.error-detail')?.textContent ?? '').trim(),
    }
  })
  failureCards.openedDetail = opened.text.slice(0, 160)
  check('opening the disclosure shows the trace', opened.expanded === 'true' && opened.height > 20, opened)
  check(
    'and the trace is the real one, frames and all',
    opened.text.includes('at Socket._writeGeneric (node:net:966:11)'),
    failureCards.openedDetail,
  )

  /* --- chatter is not a failure --- */
  check('stderr chatter never becomes a red card', read.chatterErrors === 0, read)
  check('and it is still on screen as what it is', read.chatterSystem >= 3, read)

  /* --- and a real failure is never folded away --- */
  const collapsed = await page.evaluate(async () => {
    const host = document.querySelector('[data-case="err-quota"]')!
    const toggle = host.querySelector<HTMLButtonElement>('.turn-toggle')!
    toggle.click()
    await new Promise((r) => setTimeout(r, 450))
    const card = host.querySelector('.line-error') as HTMLElement | null
    const box = card?.getBoundingClientRect()
    return {
      folded: !host.querySelector('.turn-fold.open'),
      headline: (card?.querySelector('.error-headline')?.textContent ?? '').trim(),
      // Inside a folded row an element still reports its full height — the fold
      // clips the paint, not the box — so "on screen" has to mean "not inside
      // the thing that was just folded away".
      visible: Boolean(card && box && box.height > 4 && box.width > 4 && !card.closest('.turn-fold')),
    }
  })
  failureCards.collapsedHeadline = collapsed.headline
  failureCards.collapsedVisible = collapsed.visible
  check('collapsing the turn really folds its work away', collapsed.folded, collapsed)
  check('but the failure stays on screen, with its explanation', collapsed.visible && collapsed.headline.length > 40, collapsed)

  /* --- and it is legible in both themes ---
     `check:contrast` owns the repo's ratio gate, but its target list lives in a
     file this change does not own, so the three surfaces this card introduces
     are measured here instead of going unmeasured. Same maths, same rule: real
     WCAG ratios against the background the browser actually paints. */
  for (const theme of ['light', 'dark'] as const) {
    await page.goto(`${galleryBase}/preview.html?theme=${theme}&only=turns`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(600)
    const ratios = await page.evaluate(() => {
      const rgb = (value: string): [number, number, number, number] => {
        const parts = value.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1]
        return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1]
      }
      const lum = ([r, g, b]: [number, number, number, number]) => {
        const channel = (v: number) => {
          const s = v / 255
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
        }
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
      }
      const blend = (fg: [number, number, number, number], bg: [number, number, number, number]) =>
        [
          fg[3] * fg[0] + (1 - fg[3]) * bg[0],
          fg[3] * fg[1] + (1 - fg[3]) * bg[1],
          fg[3] * fg[2] + (1 - fg[3]) * bg[2],
          1,
        ] as [number, number, number, number]
      // The painted background: walk up until something is not transparent.
      const behind = (node: Element): [number, number, number, number] => {
        let current: Element | null = node
        let stack: Array<[number, number, number, number]> = []
        while (current) {
          const colour = rgb(getComputedStyle(current).backgroundColor)
          if (colour[3] > 0) stack.push(colour)
          if (colour[3] === 1) break
          current = current.parentElement
        }
        let base: [number, number, number, number] = [255, 255, 255, 1]
        for (const layer of stack.reverse()) base = blend(layer, base)
        return base
      }
      const measure = (selector: string) => {
        const node = document.querySelector(selector)
        if (!node) return null
        const style = getComputedStyle(node)
        const bg = behind(node)
        const fg = blend(rgb(style.color), bg)
        const a = lum(fg)
        const b = lum(bg)
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
        return { selector, ratio: Math.round(ratio * 100) / 100, fontSize: style.fontSize }
      }
      return ['.error-headline', '.error-more', '.error-detail'].map(measure)
    })
    for (const sample of ratios) {
      if (!sample) {
        check(`a failure surface is missing in ${theme}`, false, ratios)
        continue
      }
      // 4.5 for the prose a person has to read, 3.2 for the disclosure label —
      // the same two thresholds the contrast gate uses for body and for labels.
      const min = sample.selector === '.error-more' ? 3.2 : 4.5
      failureCards.contrast.push(`${theme} ${sample.selector} ${sample.ratio}:1 (min ${min}, ${sample.fontSize})`)
      check(`${sample.selector} is legible in ${theme}`, sample.ratio >= min, sample)
    }
  }
}

/**
 * The markdown renderer gained GFM tables and had no assertion of its own: the
 * defect it fixed was the transcript printing the pipes verbatim, so a table
 * that stops being a table would go unnoticed.
 */
const mdTable = { rows: 0, cols: 0, aligns: [] as string[], code: 0, link: 0, pipe: false, wide: 0 }
async function checkMarkdownTables(): Promise<void> {
  await page.goto(`${galleryBase}/preview.html?theme=light`, { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  const found = await page.evaluate(() => {
    const table = document.querySelector('[data-case="md-table"] table')
    const wide = document.querySelector('[data-case="md-table-wide"] table')
    if (!table) return null
    const header = [...table.querySelectorAll('thead th')]
    return {
      rows: table.querySelectorAll('tbody tr').length,
      cols: header.length,
      aligns: header.map((cell) => getComputedStyle(cell).textAlign),
      code: table.querySelectorAll('code').length,
      link: table.querySelectorAll('a').length,
      // The escaped pipe belongs inside its cell, not as a column boundary.
      pipe: (table.textContent ?? '').includes('GET /health | jq .ok'),
      wide: wide ? wide.querySelectorAll('thead th').length : 0,
    }
  })
  if (!found) {
    check('a GFM table renders as a table, not as pipes', false)
    return
  }
  Object.assign(mdTable, found)
  check('a GFM table renders as a real table', found.rows === 3 && found.cols === 4, found)
  check('the delimiter row sets each column alignment', found.aligns.join(',') === 'left,center,right,left', found)
  check('inline markdown keeps working inside a cell', found.code >= 1 && found.link >= 1, found)
  check('an escaped pipe stays inside its cell', found.pipe, found)
  check('a wide table keeps all of its columns', found.wide === 10, found)
}

/**
 * The transcript, measured rather than looked at.
 *
 * Every one of these answers a defect reported from a screenshot, and every one
 * of them is a number rather than an impression — because the worst of them was
 * invisible unless you already knew the sentence. Thinking text was being
 * painted two or three characters short on its left edge ("e user wants me to
 * start two subagents"), which no rendering check that counts elements can see:
 * the block was there, the class was right, the text was in the DOM, and the
 * browser simply did not draw the first twenty pixels of it.
 *
 * So the clipping assertion is geometry. For every element that paints text, its
 * left edge is compared against every ancestor that clips horizontally. Only the
 * left edge: a box scrolling sideways past its right edge is a table or a code
 * block doing its job, while text starting to the left of the thing that clips
 * it is never anything but lost.
 */
const transcriptShape = {
  clipped: [] as string[],
  hiddenSideways: [] as string[],
  blocks: [] as string[],
  starting: [] as Array<Record<string, unknown>>,
  carets: null as Record<string, unknown> | null,
  dots: null as Record<string, unknown> | null,
  jump: null as Record<string, unknown> | null,
}

/** Text painted outside the box that clips it, anywhere inside the transcript. */
function clipProbe(): { hits: string[]; sideways: string[] } {
  const hits: string[] = []
  const sideways: string[] = []
  for (const root of document.querySelectorAll('.transcript')) {
    for (const node of root.querySelectorAll('*')) {
      // Only elements that paint text of their own: a wrapper's box is allowed
      // to be anywhere, it is the glyphs that must not be cut.
      const own = [...node.childNodes].some((child) => child.nodeType === 3 && (child.textContent ?? '').trim())
      if (!own) continue
      const box = node.getBoundingClientRect()
      if (!box.width || !box.height) continue
      const style = getComputedStyle(node)
      if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue
      const label = `${node.className || node.tagName}: ${(node.textContent ?? '').trim().slice(0, 42)}`
      // Text wider than the box it is hidden inside. Exempt: a box that scrolls
      // (the overflow is reachable) and one that ellipsises or clamps (the
      // truncation is the design, and it is marked as such).
      const clips = style.overflowX === 'hidden'
      const truncates =
        style.textOverflow === 'ellipsis' || style.getPropertyValue('-webkit-line-clamp') !== 'none'
      if (clips && !truncates && node.scrollWidth > node.clientWidth + 1) {
        sideways.push(`${label} (${node.scrollWidth} > ${node.clientWidth})`)
      }
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        if (getComputedStyle(parent).overflowX === 'visible') continue
        const cut = parent.getBoundingClientRect().left - box.left
        if (cut > 0.5) hits.push(`${label} — ${cut.toFixed(1)}px cut by .${parent.className}`)
      }
    }
  }
  return { hits, sideways }
}

/**
 * One step of the transcript reading, retried once if the page went away under
 * it.
 *
 * The gallery is served by vite, and vite reloads it the moment any source file
 * is saved — which, while someone is working in this repo, can land in the
 * middle of a measurement and destroy the execution context. That is noise about
 * the editor, not news about the UI, so a step that is hit by it is taken again
 * from its own navigation rather than reported as a defect.
 */
async function step<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!/Execution context was destroyed|Target (page|closed)|frame was detached/i.test(String(error))) throw error
    await page.waitForTimeout(800)
    return await run()
  }
}

async function checkTranscriptShape(): Promise<void> {
  /* --- 1. nothing is painted outside the box that clips it --- */
  // Both pages and both themes: the turns page stages a live turn and a
  // finished one side by side, the thread page has the pinned thinking block,
  // the tables and the code. A defect that only shows once the fold is open
  // would hide behind a screenshot of the other page.
  for (const query of ['&only=turns', '', '&only=turns&ui=17&content=22'] as const) {
    const read = await step(async () => {
      await page.goto(`${galleryBase}/preview.html?theme=light${query}`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(700)
      return page.evaluate(clipProbe)
    })
    transcriptShape.clipped.push(...read.hits.map((hit) => `${query || 'thread'}: ${hit}`))
    transcriptShape.hiddenSideways.push(...read.sideways.map((hit) => `${query || 'thread'}: ${hit}`))
  }
  check(
    'no text in the transcript is painted outside the box that clips it',
    transcriptShape.clipped.length === 0,
    transcriptShape.clipped.slice(0, 6),
  )
  check(
    'no text block hides its own content sideways',
    transcriptShape.hiddenSideways.length === 0,
    transcriptShape.hiddenSideways.slice(0, 6),
  )

  const turnsPage = async () => {
    await page.goto(`${galleryBase}/preview.html?theme=light&only=turns`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(700)
  }

  /* --- 2. what each block is, said in the DOM --- */
  const blocks = await step(async () => {
    await turnsPage()
    return page.evaluate(() => {
    const one = (id: string) => {
      const host = document.querySelector(`[data-case="${id}"]`)
      const thinking = host?.querySelector('[data-block="thinking"]')
      const reply = host?.querySelector('.msg-assistant.answer')
      const progress = host?.querySelector('.turn-body [data-block="progress"].live')
      return {
        id,
        thinking: Boolean(thinking),
        thinkingLabel: (thinking?.querySelector('.block-label')?.textContent ?? '').trim(),
        progress: Boolean(progress),
        progressInFold: Boolean(progress?.closest('.turn-fold')),
        replyBlock: reply?.getAttribute('data-block') ?? '',
        replyLabel: reply?.getAttribute('aria-label') ?? '',
        // The two must not be the same kind of thing in the tree, or nothing
        // downstream — a test, a screen reader, a person reading the markup —
        // can tell the monologue from the answer.
        distinct: Boolean(thinking) && Boolean(progress) && !progress!.contains(thinking!),
        // The old treatment: a tinted slab the reply also shifted sideways into.
        shifted: reply ? getComputedStyle(reply).marginLeft : '',
      }
    }
      return { working: one('turn-working'), finished: one('turn-finished') }
    })
  })
  transcriptShape.blocks = [JSON.stringify(blocks.working), JSON.stringify(blocks.finished)]
  check('thinking and live progress are separate rows inside one activity fold', blocks.working.distinct && blocks.working.progressInFold, blocks.working)
  check('reasoning no longer repeats a heading inside the activity', blocks.working.thinkingLabel === '', blocks.working)
  const thinkingFold = await page.evaluate(async () => {
    const host = document.querySelector('[data-case="turn-working"]')
    const toggle = host?.querySelector<HTMLElement>('.turn-toggle')
    const before = Boolean(host?.querySelector('[data-block="thinking"]')) && Boolean(host?.querySelector('.activity-note.live'))
    toggle?.click()
    await new Promise((resolve) => setTimeout(resolve, 300))
    const after = Boolean(host?.querySelector('[data-block="thinking"]')) || Boolean(host?.querySelector('.activity-note.live'))
    return { before, after }
  })
  check(
    'collapsing the animated turn header really hides its reasoning',
    thinkingFold.before && !thinkingFold.after,
    thinkingFold,
  )
  check(
    'live progress is not rendered as a reply outside the fold',
    blocks.working.replyBlock === '' && blocks.working.progressInFold,
    blocks.working,
  )
  check(
    'and the finished reply says it is the reply',
    blocks.finished.replyBlock === 'reply' && blocks.finished.replyLabel === 'Reply',
    blocks.finished,
  )
  check('the finished reply keeps its column', blocks.finished.shifted === '0px', blocks.finished)

  const harnessStarting = await page.evaluate(() => {
    const host = document.querySelector('[data-case="turn-harness-starting"]')
    return {
      messages: host?.querySelectorAll('.msg-user').length ?? 0,
      message: (host?.querySelector('.msg-user .msg-body')?.textContent ?? '').trim(),
      status: (host?.querySelector('.turn-live .think-word')?.textContent ?? '').trim(),
      animated: Boolean(host?.querySelector('.turn-live .thinking-indicator')),
    }
  })
  check(
    'a prompt is already visible while its harness starts',
    harnessStarting.messages === 1 && harnessStarting.message === 'Check the repository status.',
    harnessStarting,
  )
  check(
    'the starting turn uses the same animated status surface as working',
    harnessStarting.animated && harnessStarting.status === 'Starting the harness…',
    harnessStarting,
  )

  /* --- 3. a subagent card in the second after it was launched --- */
  const starting = await step(async () => {
    await turnsPage()
    return page.evaluate(async () => {
      const host = document.querySelector('[data-case="turn-subagent-starting"]')
      // Folded while it works, like every card: open each one to read its brief.
      for (const head of host?.querySelectorAll<HTMLElement>('.subagent > .subagent-head[aria-expanded="false"]') ?? []) head.click()
      await new Promise((resolve) => setTimeout(resolve, 120))
      return [...(host?.querySelectorAll('.subagent') ?? [])].map((node) => ({
        type: (node.querySelector('.subagent-type')?.textContent ?? '').trim(),
        desc: (node.querySelector('.subagent-desc')?.textContent ?? '').trim(),
        prompt: (node.querySelector('.subagent-prompt')?.textContent ?? '').trim().length,
      }))
    })
  })
  transcriptShape.starting = starting
  check('both subagents caught starting have a card', starting.length === 2, starting)
  for (const [index, card] of starting.entries()) {
    check(`a subagent still starting names its type (card ${index + 1})`, card.type === 'general-purpose', card)
    check(
      `a subagent still starting says what it was sent to do (card ${index + 1})`,
      /^Ping (github|google)\.com and register the result$/.test(card.desc),
      card,
    )
    check(`a subagent still starting carries its prompt (card ${index + 1})`, card.prompt > 20, card)
  }

  /* --- 4. the disclosure caret is a target, not a speck --- */
  const carets = await step(async () => {
    await turnsPage()
    return page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.chevron')].map((node) => {
      const box = node.getBoundingClientRect()
      const glyph = node.querySelector('svg')?.getBoundingClientRect()
      return { w: box.width, h: box.height, glyph: glyph ? Math.min(glyph.width, glyph.height) : 0 }
    })
    return {
      count: boxes.length,
      smallest: boxes.reduce((least, box) => Math.min(least, box.w, box.h), Infinity),
      smallestGlyph: boxes.reduce((least, box) => Math.min(least, box.glyph), Infinity),
    }
    })
  })
  transcriptShape.carets = carets
  check('the transcript has disclosure carets to measure', carets.count >= 4, carets)
  // 24px is the smallest target worth aiming at, and the caret is the main way
  // into a card: it was an 11px text triangle in an 11px box.
  check('every disclosure caret is at least 24px on both sides', carets.smallest >= 24, carets)
  check('and carries a real glyph, not a character', carets.smallestGlyph >= 14, carets)

  /* --- 5. the status dot is a circle --- */
  const dots = await step(async () => page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.dot')].map((node) => {
      const box = node.getBoundingClientRect()
      return { w: Math.round(box.width * 100) / 100, h: Math.round(box.height * 100) / 100, r: getComputedStyle(node).borderRadius }
    })
    return {
      count: boxes.length,
      worstSkew: boxes.reduce((worst, box) => Math.max(worst, Math.abs(box.w - box.h)), 0),
      smallest: boxes.reduce((least, box) => Math.min(least, box.w, box.h), Infinity),
      rounded: boxes.every((box) => box.r === '50%'),
      sample: boxes.slice(0, 3),
    }
  }))
  transcriptShape.dots = dots
  // Turn headers no longer carry a dot (the spinner and the words say the
  // state), so the page has fewer of them; one is enough to measure the shape.
  check('there are status dots to measure', dots.count >= 1, dots)
  // A `border-radius: 50%` on a box that is not square is an ellipse, which is
  // exactly what "il pallino sembra un po' schiacciato" was: it was 7 by 8.
  check('the status dot is a square box', dots.worstSkew < 0.5, dots)
  check('and is drawn as a circle in it', dots.rounded && dots.smallest >= 6, dots)

  /* --- 6. the jump control reflects whether anything is below --- */
  // Expanding a "Worked for Ns" block adds height and pushes the bottom of the
  // thread out of view, which is what summons the control; collapsing it takes
  // that height straight back out. No scroll event follows a fold closing, so
  // the control used to stay behind offering to jump down to nothing.
  //
  // Staged at the top of the thread and in a window tall enough that the folded
  // thread fits in it: that is the one place the defect can be seen. Scrolled
  // anywhere else the browser clamps `scrollTop` when the content shrinks, and
  // the clamp fires the scroll event that used to be the only thing keeping the
  // control honest — so the bug would repair itself before it could be measured.
  await page.setViewportSize({ width: 1440, height: 1200 })
  const jump = await step(async () => {
    await page.goto(`${galleryBase}/preview.html?theme=light`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(900)
    return page.evaluate(async () => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    const scroller = document.querySelector('.transcript') as HTMLElement
    const wrap = scroller.closest('.transcript-wrap') as HTMLElement
    const folds = () => [...document.querySelectorAll<HTMLButtonElement>('.turn-toggle')]
    const open = (toggle: HTMLElement) => Boolean(toggle.closest('.turn-agent')?.querySelector('.turn-fold.open'))
    const shown = () => Boolean(wrap.querySelector('.jump'))
    const below = () => Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight)

    for (const toggle of folds()) if (!open(toggle)) toggle.click()
    await wait(700)
    scroller.scrollTop = 0
    await wait(400)
    const expanded = { below: below(), shown: shown() }

    // Nothing here scrolls: the folds close, the thread gets shorter, and the
    // view stays exactly where it was.
    for (const toggle of folds()) if (open(toggle)) toggle.click()
    await wait(800)
    const collapsed = { below: below(), shown: shown(), scrollTop: scroller.scrollTop }
    return { expanded, collapsed }
    })
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  transcriptShape.jump = jump
  check(
    'opening the folds puts content below the view, and the control appears',
    jump.expanded.below > 60 && jump.expanded.shown,
    jump,
  )
  // The premise, asserted rather than assumed: if collapsing did not actually
  // remove the overflow, the assertion below would pass by never being tested.
  check('collapsing them removes the overflow it was offering to scroll', jump.collapsed.below <= 60, jump)
  check('and the control goes with it, without waiting for a scroll', jump.collapsed.shown === false, jump)
  check('the view itself never moved', jump.collapsed.scrollTop === 0, jump)
}

try {
  await shootGallery('light', out.replace(/\.png$/, '-gallery.png'))
  await shootGallery('dark', out.replace(/\.png$/, '-gallery-dark.png'))
  const galleryType = await page.locator('.subagent-type').first().evaluate((node) => ({
    height: node.getBoundingClientRect().height,
    lineHeight: Number.parseFloat(getComputedStyle(node).lineHeight),
  }))
  check('gallery subagent type stays on one line', galleryType.height <= galleryType.lineHeight * 1.25, galleryType)
  await checkContextRingStates()
  await checkReadoutMapping()
  await checkLiveBufferBelongsToItsTurn()
  await checkAnswerIsNotClaimed()
  await checkMarkdownTables()
  await checkTurnStates()
  await checkFailureCards()
  await checkTranscriptShape()
  check('gallery renders the thread', gallery.turns >= 2, gallery)
  check('gallery renders tools', gallery.tools >= 2, gallery)
  check('gallery renders a live subagent card', gallery.subagents >= 1, gallery)
  check('gallery renders file cards', gallery.files >= 2, gallery)
  check('gallery renders a diff', gallery.diffs > 10, gallery)
  check('a turn\'s file list starts folded, one row until clicked', gallery.fileGroupsFolded === true, gallery)
  check('turns with a reply render it as an answer', gallery.answers >= 1, gallery)
  check('no turn keeps its reply only inside the work block', gallery.answersMissing === 0, gallery)
  check('a collapsed turn still shows its reply', gallery.answersMissingWhenCollapsed === 0, gallery)
} catch (error) {
  check('gallery reachable', false, String(error))
}

/* ---------------- a request nobody can answer any more ---------------- */

/**
 * A question whose process is gone must read as history, not as an invitation.
 *
 * This is the defect that outlived a restart: the transcript still held an
 * `AskUserQuestion` with no result under it, so the card came back live, with
 * its buttons enabled, and clicking one reached a server that had no driver to
 * hand the answer to — silently.
 *
 * It needs a store the shared fixtures do not have (they leave no question
 * open), so it builds its own: the fixture seed for a rail to open, plus one
 * session carrying a question that was never answered. Every restored session
 * comes back `stopped`, which is precisely the state that makes the request
 * expired.
 */
const expired = { card: false, greyed: false, enabledOptions: -1, foot: '', pointer: '' }
async function checkExpiredQuestion(): Promise<void> {
  const { home, env } = tempHome('ui-check-expired')
  await seedStore(env, ROOT)

  const title = 'Waiting on an answer that never came'
  const sessionId = 'fixture-expired-question'
  const at = Date.now() - 30 * 60_000
  const store = new Database(join(home, 'sedano.db'))
  try {
    store.query(
      `INSERT INTO sessions (id, harness, kind, title, cwd, host, model, status, created_at, updated_at,
         native_id, transcript_path, resume_hint, permission_mode, effort, git_branch, pinned, preset, started)
       VALUES (?, 'claude', 'agent', ?, ?, NULL, 'sonnet', 'idle', ?, ?, NULL, NULL, NULL, 'acceptEdits', NULL, 'main', 0, NULL, 1)`,
    ).run(sessionId, title, ROOT, at, at)
    const event = (seq: number, ev: Record<string, unknown>) =>
      store
        .query('INSERT INTO events (id, session_id, seq, at, agent_id, kind, payload) VALUES (?, ?, ?, ?, NULL, ?, ?)')
        .run(`${sessionId}-${seq}`, sessionId, seq, at + seq * 1000, String(ev.k), JSON.stringify(ev))
    event(1, { k: 'user', text: 'Drop the legacy orders column?' })
    event(2, {
      k: 'tool',
      toolId: 'tu_expired',
      name: 'AskUserQuestion',
      summary: 'Drop the legacy column?',
      input: {
        questions: [
          {
            header: 'Migration',
            question: 'The column is unused in this repo. Drop it?',
            options: [
              { id: 'drop', label: 'Drop it', description: 'irreversible on this database' },
              { id: 'keep', label: 'Keep it for now', description: 'the migration stays reversible' },
            ],
          },
        ],
      },
    })
  } finally {
    store.close()
  }

  const api = await startApi(env)
  const other = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  other.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console (expired): ${msg.text()}`)
  })
  other.on('pageerror', (err) => errors.push(`pageerror (expired): ${err.message}`))
  await other.goto(`${api.url}/`, { waitUntil: 'networkidle' })
  await other.waitForTimeout(1500)

  const opened = await other.evaluate(async (wanted: string) => {
    if (!document.querySelector('.rail .session-item')) {
      ;(document.querySelector('.rail-title.workspace') as HTMLElement | null)?.click()
      await new Promise((r) => setTimeout(r, 400))
    }
    // Each workspace shows its newest sessions first; the fixture may be behind "Show N more".
    for (const more of document.querySelectorAll<HTMLElement>('.rail-more[aria-expanded="false"]')) more.click()
    await new Promise((r) => setTimeout(r, 150))
    const row = [...document.querySelectorAll<HTMLElement>('.rail .session-item')].find(
      (item) => (item.querySelector('.title')?.textContent ?? '').trim() === wanted,
    )
    row?.click()
    await new Promise((r) => setTimeout(r, 900))
    for (const toggle of document.querySelectorAll<HTMLElement>('.turn-toggle')) {
      if (toggle.querySelector('.chevron:not(.open)')) toggle.click()
    }
    await new Promise((r) => setTimeout(r, 400))
    return Boolean(row)
  }, title)
  check('the expired-question session can be opened', opened)

  const reading = await other.evaluate(() => {
    const card = document.querySelector('.question')
    if (!card) return null
    const options = [...card.querySelectorAll<HTMLButtonElement>('.question-option')]
    return {
      card: true,
      greyed: card.classList.contains('closed'),
      enabledOptions: options.filter((option) => !option.disabled).length,
      foot: (card.querySelector('.question-foot')?.textContent ?? '').trim(),
      pointer: options[0] ? getComputedStyle(options[0]).cursor : '',
    }
  })
  if (!reading) {
    check('a question left unanswered still renders as a card', false)
  } else {
    Object.assign(expired, reading)
    check('an expired question still renders as a card', reading.card, reading)
    check('an expired question card is greyed out', reading.greyed, reading)
    check('an expired question offers nothing to click', reading.enabledOptions === 0, reading)
    check('an expired question does not invite an answer', !/pick one above/i.test(reading.foot), reading)
    check('an expired question never claims one was sent', !/answer sent/i.test(reading.foot), reading)
    check('an expired question option does not read as clickable', reading.pointer !== 'pointer', reading)
  }

  await other.screenshot({ path: out.replace(/\.png$/, '-expired.png'), fullPage: false })
  await other.evaluate(() => {
    document.documentElement.dataset.theme = 'dark'
  })
  await other.waitForTimeout(300)
  await other.screenshot({ path: out.replace(/\.png$/, '-expired-dark.png'), fullPage: false })
  await other.close()
  await api.stop()
}

/* ---------------- transfer never offers the source harness ---------------- */

/**
 * The dialog against a known catalog: the server's own is whatever this machine
 * has installed, so the socket's `caps` answer is rewritten to offer every chat
 * harness, with a long version on one of them. The source's own harness must
 * not be among the targets, and a long version must give way before the name.
 */
async function checkTransferDialog(): Promise<void> {
  const other = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const LONG_VERSION = '1.4.0-a-very-long-prerelease-tag.20260925'
  await other.routeWebSocket(/\/api\/ws/, (client) => {
    const server = client.connectToServer()
    server.onMessage((raw) => {
      if (typeof raw !== 'string') return client.send(raw)
      const msg = JSON.parse(raw) as { t?: string; caps?: { harnesses: Array<Record<string, unknown>> } }
      if (msg.t === 'caps' && msg.caps) {
        msg.caps.harnesses = msg.caps.harnesses.map((item) =>
          item.id === 'shell' || item.tui
            ? item
            : { ...item, installed: true, wired: true, enabled: true, version: item.id === 'codex' ? LONG_VERSION : '2.1.282' },
        )
        return client.send(JSON.stringify(msg))
      }
      client.send(raw)
    })
  })
  await other.goto(url, { waitUntil: 'networkidle' })
  await other.waitForTimeout(1500)
  await openRichestSession(other)
  await other.locator('.session-actions-menu .select-trigger').click()
  await other.getByRole('button', { name: /Transfer…/ }).click()
  await other.waitForTimeout(600)
  const source = ((await other.locator('.transfer-source > span').first().textContent()) ?? '').trim()
  await other.locator('.transfer-grid label').filter({ hasText: 'Harness' }).locator('.select-trigger').click()
  await other.waitForTimeout(300)
  const rows = await other.evaluate(() =>
    [...document.querySelectorAll('.menu-pop .menu-item:not(.menu-action)')].map((row) => {
      const name = row.querySelector('.menu-item-name') as HTMLElement | null
      const meta = row.querySelector('.menu-item-meta') as HTMLElement | null
      return {
        name: name?.textContent ?? '',
        nameCut: name ? name.scrollWidth > name.clientWidth : true,
        meta: meta?.textContent ?? '',
        metaInside: meta ? meta.getBoundingClientRect().right <= row.getBoundingClientRect().right : true,
      }
    }),
  )
  check('transfer lists target harnesses', rows.length > 0, { source, rows })
  check('transfer does not offer the session’s own harness', Boolean(source) && !rows.some((row) => row.name === source), { source, rows })
  check('every harness in the transfer menu has a name', rows.every((row) => row.name.trim().length > 0), rows)
  check('a harness name is never cut to make room for its version', rows.every((row) => !row.nameCut), rows)
  check('a long version stays inside the menu', rows.every((row) => row.metaInside), rows)
  await other.screenshot({ path: out.replace(/\.png$/, '-transfer.png'), fullPage: false })
  await other.close()
}

try {
  await checkTransferDialog()
} catch (error) {
  check('the transfer dialog could be opened', false, String(error))
}

if (target.hermetic) {
  try {
    await checkExpiredQuestion()
  } catch (error) {
    check('the expired-question world could be built', false, String(error))
  }
} else {
  skip('an expired question card', 'the store belongs to the server this run was pointed at')
}

// Nothing is deleted when the before-state was unknown: a check that cannot
// tell what it created has no business deleting anything. In a hermetic run the
// whole store goes anyway, but the terminal tab left a tmux session behind and
// deleting the session is what kills it.
if (sessionsBefore) await deleteSessions(createdSessions)
await browser.close()
// Stops the servers this run started (and only those) and removes the temporary
// store, whether the checks passed or not.
await runCleanups()

console.log('--- layout ---')
console.log(JSON.stringify({ ...layout, statusbar: layout.statusbar.slice(0, 160) }, null, 1))
console.log('--- scroll container ---')
console.log(JSON.stringify(scroll, null, 1))
console.log('--- dark ---')
console.log(JSON.stringify(dark, null, 1))
console.log('--- scales ---')
console.log(JSON.stringify(scales, null, 1))
console.log('--- launchpad ---')
console.log(JSON.stringify(launchpad, null, 1))
console.log('--- responsive composer/status layouts ---')
console.log(JSON.stringify(responsiveLayouts, null, 1))
console.log('--- settings ---')
console.log(JSON.stringify({ ...settings, filtered }, null, 1))
console.log('--- limits panel ---')
console.log(JSON.stringify(limits, null, 1))
console.log('--- truthful readouts ---')
console.log(JSON.stringify({ ...truthful, statusbar: truthful.statusbar.slice(0, 160) }, null, 1))
console.log('--- approval modes offered ---')
console.log(JSON.stringify(approvals, null, 1))
console.log('--- tint ---')
console.log(JSON.stringify(tint, null, 1))
console.log('--- gallery ---')
console.log(JSON.stringify(gallery, null, 1))
console.log('--- answering a question ---')
console.log(JSON.stringify(answering, null, 1))
console.log('--- context ring states ---')
console.log(JSON.stringify(ctxRings, null, 1))
console.log('--- readouts, per metric shape ---')
console.log(JSON.stringify(readouts, null, 1))
console.log('--- markdown tables ---')
console.log(JSON.stringify(mdTable, null, 1))
console.log('--- transcript shape ---')
console.log(JSON.stringify(transcriptShape, null, 1))
console.log('--- turn states ---')
console.log(JSON.stringify(turnStates, null, 1))
console.log('--- failure cards ---')
console.log(JSON.stringify(failureCards, null, 1))
console.log('--- live buffer after a reconnect ---')
console.log(JSON.stringify(liveBuffer, null, 1))
console.log('--- expired question ---')
console.log(JSON.stringify(expired, null, 1))
console.log('--- console errors ---')
console.log(errors.length ? errors.join('\n') : '(none)')
console.log('--- screenshots ---')
console.log(
  [
    out,
    '-palette.png',
    '-launchpad.png',
    '-launchpad-terminal.png',
    '-responsive-1440.png',
    '-responsive-1080.png',
    '-responsive-860.png',
    '-settings.png',
    '-dark.png',
    '-bigfont.png',
    '-unreported.png',
    '-gallery.png',
    '-gallery-dark.png',
    '-gallery-stale.png',
    '-turns.png',
    '-turns-dark.png',
    '-expired.png',
    '-expired-dark.png',
    '-toast.png',
    '-transfer.png',
    '-import-list.png',
    '-import-dark.png',
  ]
    .map((suffix) => (suffix.startsWith('-') ? out.replace(/\.png$/, suffix) : suffix))
    .join('\n'),
)

const verdict = errors.length === 0 && failures.length === 0 ? 'UI OK' : 'UI PROBLEM'
console.log('--- store ---')
console.log(target.hermetic ? 'hermetic: fixture store, own server, own port' : `external: ${url}`)
if (skips.length) {
  console.log('--- optional checks not run ---')
  for (const entry of skips) console.log(`… ${entry}`)
}
if (failures.length) {
  console.log('--- failed checks ---')
  for (const failure of failures) console.log(`✗ ${failure}`)
}
console.log(`verdict: ${verdict}`)
if (failures.length || errors.length) process.exit(1)
