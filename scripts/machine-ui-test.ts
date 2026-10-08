#!/usr/bin/env bun
/**
 * Machine identity and session status, on screen.
 *
 * These are claims about what is *rendered*, which is why they need a browser:
 * a store-level assertion would happily accept a colour nobody paints and a
 * status nobody draws.
 *
 *   - each `SessionStatus` reaches the sidebar as its own mark, `error`
 *     included — the state nobody asked for and the one that matters most;
 *   - changing the selected machine never recolours an existing tab;
 *   - the machine selector carries a dot in that machine's colour, and choosing
 *     a colour in Settings recolours the tabs and survives a reload;
 *   - a resolved model id is drawn as a name with the exact id still reachable;
 *   - the delete confirmation does not mention tmux.
 *
 * It builds its own world: a temporary store with sessions in every status, a
 * fixture ssh config so `vps` is a machine the server will talk about, and an
 * API server on a free port. Nothing already running is touched, and no session
 * is ever started, so no harness binary is spawned.
 *
 *   bun scripts/machine-ui-test.ts
 */
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { ROOT, installExitHandlers, runCleanups, startApi, tempHome } from './lib/harness.ts'

installExitHandlers()

const failures: string[] = []
const passed: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) passed.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const bundle = join(ROOT, 'apps', 'ui', 'dist', 'index.html')
if (!existsSync(bundle)) {
  console.error(`the UI bundle is missing at ${bundle} — run "bun run build:ui" before this check`)
  process.exit(1)
}

const { home, env } = tempHome('machine-ui')
writeFileSync(join(home, 'config.json'), `${JSON.stringify({ hosts: ['vps'] }, null, 2)}\n`)
const serverEnv = { ...env, SEDANO_SSH_CONFIG: join(ROOT, 'scripts', 'fixtures', 'ssh-config') }

/**
 * One session per status, plus one on a server.
 *
 * Seeded in its own process because `db.ts` resolves its file at import time, so
 * the environment has to be set before anything imports it (the same reason
 * `seed-db.ts` is a separate script). `started` is true on all of them: the rail
 * lists work, and a session that was never started is not in it.
 */
const SEEDS = [
  { id: 'st-idle', title: 'Finished Session', status: 'idle', host: null },
  { id: 'st-running', title: 'Working Session', status: 'running', host: null },
  { id: 'st-starting', title: 'Starting Session', status: 'starting', host: null },
  { id: 'st-stopped', title: 'Stopped Session', status: 'stopped', host: null },
  { id: 'st-error', title: 'Failed Session', status: 'error', host: null },
  { id: 'st-remote', title: 'Remote Session', status: 'idle', host: 'vps' },
  // A terminal, because the confirmation under test is the terminal branch: the
  // agent branch never said "tmux", so deleting an agent proves nothing.
  { id: 'st-term', title: 'A Terminal', status: 'idle', host: null, kind: 'terminal' },
]

const seeder = `
const { upsertSession } = await import(${JSON.stringify(join(ROOT, 'apps', 'server', 'src', 'db.ts'))})
const seeds = ${JSON.stringify(SEEDS)}
const cwd = ${JSON.stringify(ROOT)}
for (const [index, seed] of seeds.entries()) {
  const at = Date.now() - (seeds.length - index) * 60000
  upsertSession({
    id: seed.id, harness: seed.kind === 'terminal' ? 'shell' : 'claude', kind: seed.kind ?? 'agent', title: seed.title, cwd,
    host: seed.host, model: 'claude-haiku-4-5-20251001', status: seed.status,
    createdAt: at, updatedAt: at, nativeId: null, transcriptPath: null, resumeHint: null,
    permissionMode: 'acceptEdits', effort: null, gitBranch: 'main', pinned: 0, preset: null,
    started: true,
  })
}
`
const seedFile = join(home, 'seed.ts')
writeFileSync(seedFile, seeder)
const seed = Bun.spawn(['bun', seedFile], { cwd: ROOT, env: { ...process.env, ...serverEnv }, stdout: 'pipe', stderr: 'pipe' })
await seed.exited
if (seed.exitCode !== 0) {
  console.error(await new Response(seed.stderr).text())
  throw new Error('seeding the machine-ui store failed')
}

const api = await startApi(serverEnv)
const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const pageErrors: string[] = []
page.on('pageerror', (err) => pageErrors.push(err.message))

/**
 * A tap into the app's own socket.
 *
 * A session's status cannot be seeded: the server restores every session as
 * `stopped` on purpose — a process that is gone is gone — so a store full of
 * statuses would be rewritten before the first frame. The statuses are therefore
 * delivered the only way they ever really arrive, as a `sessions` message on the
 * socket the app is already listening to. Nothing here fakes the component tree
 * or the store: only the frame is ours.
 */
await page.addInitScript(() => {
  const Native = window.WebSocket
  const sockets: WebSocket[] = []
  class Tapped extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols)
      sockets.push(this)
    }
  }
  ;(window as unknown as { WebSocket: typeof WebSocket }).WebSocket = Tapped as unknown as typeof WebSocket
  ;(window as unknown as { __feed: (msg: unknown) => void }).__feed = (msg) => {
    for (const socket of sockets) {
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(msg) }))
    }
  }
})

/** Opens the rail's workspace groups, if they are not open already. */
async function expandRail(): Promise<void> {
  await page.evaluate(() => {
    if (document.querySelector('.rail .session-item')) return
    for (const head of document.querySelectorAll<HTMLElement>('.rail-title.workspace')) head.click()
  })
  await page.waitForSelector('.rail .session-item', { timeout: 10_000 })
  // Each workspace starts with its newest sessions only; the checks need all.
  await page.evaluate(async () => {
    for (const more of document.querySelectorAll<HTMLElement>('.rail-more[aria-expanded="false"]')) more.click()
    await new Promise((r) => setTimeout(r, 150))
  })
}

try {
  await page.goto(`${api.url}/`, { waitUntil: 'networkidle' })
  // A choice left over from another run would make an assertion pass for the
  // wrong reason; the tabs are rebuilt below from scratch.
  await page.evaluate(() => {
    localStorage.removeItem('sedano.settings')
    localStorage.removeItem('sedano.tabs')
  })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.app')

  /* ---------------------------------------------------------------- */
  /* 1. Status in the sidebar                                          */
  /* ---------------------------------------------------------------- */

  // The workspace group starts collapsed unless it holds the active session.
  await expandRail()

  // One session per status, delivered on the socket (see the tap above). The
  // summaries are the server's own, with only `status` changed, so every other
  // field the rail reads is real.
  await page.evaluate(async (wanted: Record<string, string>) => {
    const state = (await (await fetch('/api/state')).json()) as { sessions: Array<{ id: string; status: string }> }
    const sessions = state.sessions.map((session) => ({ ...session, status: wanted[session.id] ?? session.status }))
    ;(window as unknown as { __feed: (msg: unknown) => void }).__feed({ t: 'sessions', sessions })
  }, Object.fromEntries(SEEDS.map((seed) => [seed.id, seed.status])))
  await page.waitForTimeout(300)

  const marks = await page.evaluate(() => {
    const out: Record<string, { className: string; label: string | null; animation: string; runningColour: string }> = {}
    for (const row of document.querySelectorAll<HTMLElement>('.rail .session-item')) {
      const title = row.querySelector('.title-text')?.textContent?.trim() ?? ''
      const state = row.querySelector<HTMLElement>('.sess-state')
      out[title] = {
        className: state?.className ?? '',
        label: state?.getAttribute('aria-label') ?? null,
        animation: state ? getComputedStyle(state).animationName : '',
        runningColour: state ? getComputedStyle(state).borderTopColor : '',
      }
    }
    return out
  })

  check('a finished session is marked ready', marks['Finished Session']?.className.includes('ready') === true, marks['Finished Session'])
  check('a finished session says so in words', marks['Finished Session']?.label === 'Ready', marks['Finished Session'])
  check('a running session shows the moving amber indicator', marks['Working Session']?.animation === 'machine-ring', marks['Working Session'])
  check('the running indicator is amber', marks['Working Session']?.runningColour === 'rgb(138, 101, 18)', marks['Working Session'])
  check('a running session says so in words', marks['Working Session']?.label === 'Working', marks['Working Session'])
  check('a starting session shows the moving amber indicator', marks['Starting Session']?.animation === 'machine-ring', marks['Starting Session'])
  check('a starting session is told apart from a working one', marks['Starting Session']?.label === 'Starting', marks['Starting Session'])
  check('a stopped session is marked stopped', marks['Stopped Session']?.className.includes('stopped') === true, marks['Stopped Session'])
  check('a stopped session says so in words', marks['Stopped Session']?.label === 'Stopped', marks['Stopped Session'])
  // The state nobody listed, and the one that outranks all of them.
  check('a failed session is marked as an error', marks['Failed Session']?.className.includes('error') === true, marks['Failed Session'])
  check('a failed session says so in words', marks['Failed Session']?.label === 'Failed', marks['Failed Session'])
  check(
    'no two states share a mark',
    new Set(Object.values(marks).map((mark) => mark.className)).size >= 4,
    marks,
  )

  /* ---------------------------------------------------------------- */
  /* 2. The model, read as a name                                      */
  /* ---------------------------------------------------------------- */

  const model = await page.evaluate(() => {
    const row = [...document.querySelectorAll<HTMLElement>('.rail .session-item')].find((item) =>
      item.querySelector('.title-text')?.textContent?.includes('Finished Session'),
    )
    const cell = [...(row?.querySelectorAll<HTMLElement>('.meta span') ?? [])].find((span) =>
      /Haiku|haiku/.test(span.textContent ?? ''),
    )
    return { text: cell?.textContent ?? null, title: cell?.getAttribute('title') ?? null }
  })
  check('the resolved model id is drawn as a name', model.text === 'Claude Haiku 4.5', model)
  check('the exact id is still reachable', model.title === 'claude-haiku-4-5-20251001', model)

  /* ---------------------------------------------------------------- */
  /* 3. Tabs from another machine                                      */
  /* ---------------------------------------------------------------- */

  // Open one tab per machine: this computer's finished session and the one on
  // `vps`. Both live in the same folder, so the only thing separating them is
  // the machine — which is precisely the distinction under test.
  await page.evaluate(() => {
    const row = [...document.querySelectorAll<HTMLElement>('.rail .session-item')].find((item) =>
      item.querySelector('.title-text')?.textContent?.includes('Finished Session'),
    )
    row?.click()
  })
  await page.waitForTimeout(400)
  await expandRail()

  const tabs = await page.evaluate(() => {
    const read = (tab: Element) => {
      const style = getComputedStyle(tab)
      return {
        borderLeft: style.borderLeftWidth,
        borderColor: style.borderLeftColor,
        background: style.backgroundColor,
        machine: tab.querySelector('.tab-machine')?.textContent ?? null,
      }
    }
    const out: Record<string, ReturnType<typeof read>> = {}
    for (const tab of document.querySelectorAll('.tabs .tab')) {
      out[tab.querySelector('.label')?.textContent?.trim() ?? '?'] = read(tab)
    }
    return out
  })
  check('every tab says which machine it is on', tabs['Finished Session']?.machine === 'This Machine', tabs)

  const activeTab = page.locator('.tabs .tab.active')
  const activeLook = await activeTab.evaluate((tab) => ({
    shadow: getComputedStyle(tab).boxShadow,
    weight: getComputedStyle(tab.querySelector('.label')!).fontWeight,
    dot: getComputedStyle(tab.querySelector('.sess-state')!).backgroundColor,
    dotBorder: getComputedStyle(tab.querySelector('.sess-state')!).borderTopColor,
  }))
  check('the selected tab has a machine-coloured edge', activeLook.shadow.includes('rgb(74, 90, 104)'), activeLook)
  check('the selected tab title has stronger weight', Number(activeLook.weight) >= 600, activeLook)
  check('the tab status dot uses its machine colour',
    activeLook.dot === 'rgb(74, 90, 104)' || activeLook.dotBorder === 'rgb(74, 90, 104)', activeLook)

  // Rename from the tab itself, then from its context menu; the sidebar and tab
  // are views of the same server-side title, not two independent labels.
  await activeTab.locator('.label').dblclick()
  await page.locator('.dialog-input').fill('Renamed From Tab')
  await page.locator('.dialog-actions .primary').click()
  await page.waitForFunction(() => document.querySelector('.tabs .tab.active .label')?.textContent === 'Renamed From Tab')
  check('double-clicking the tab renames the session', await page.locator('.rail .title-text', { hasText: 'Renamed From Tab' }).count() === 1)
  await activeTab.click({ button: 'right' })
  await page.locator('.ctx-pop .ctx-item', { hasText: 'Rename' }).click()
  await page.locator('.dialog-input').fill('Finished Session')
  await page.locator('.dialog-actions .primary').click()
  await page.waitForFunction(() => document.querySelector('.tabs .tab.active .label')?.textContent === 'Finished Session')
  check('the tab context menu can rename the same session', await page.locator('.rail .title-text', { hasText: 'Finished Session' }).count() === 1)

  await page.locator('.rail .session-item', { hasText: 'Working Session' }).click()
  await page.waitForSelector('.composer .mic')
  check('dictation remains available while a session works', await page.locator('.composer .mic').isEnabled())
  await page.locator('.rail .session-item', { hasText: 'Finished Session' }).click()

  // Selecting `vps` leaves this computer's tab open — that is the situation the
  // whole feature exists for.
  await page.evaluate(() => {
    const crumb = [...document.querySelectorAll<HTMLElement>('.bar .crumb')].find((button) =>
      button.querySelector('.machine-name'),
    )
    crumb?.click()
  })
  await page.waitForSelector('.menu-pop')
  // The enabled hosts arrive with the machine's capabilities, which is a scan
  // and not instant: clicking before it lands would find a menu with one row.
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll('.menu-pop .menu-item')].some(
        (item) => item.querySelector('.menu-item-name')?.textContent?.trim() === 'vps',
      ),
    undefined,
    { timeout: 30_000 },
  )
  const picked = await page.evaluate(() => {
    const item = [...document.querySelectorAll<HTMLElement>('.menu-pop .menu-item')].find(
      (button) => button.querySelector('.menu-item-name')?.textContent?.trim() === 'vps',
    )
    item?.click()
    return Boolean(item)
  })
  // If the server never offered `vps`, the colour-stability check would not
  // exercise a real environment change.
  check('the enabled server is offered in the machine selector', picked === true)
  await page.waitForFunction(
    () => document.querySelector('.bar .crumb .machine-name')?.textContent?.trim() === 'vps',
    undefined,
    { timeout: 10_000 },
  )
  await page.waitForTimeout(300)

  const afterSwitch = await page.evaluate(() => {
    const tab = document.querySelector('.tabs .tab')
    if (!tab) return null
    const style = getComputedStyle(tab)
    return {
      label: tab.querySelector('.label')?.textContent?.trim() ?? null,
      borderLeft: style.borderLeftWidth,
      borderColor: style.borderLeftColor,
      background: style.backgroundColor,
      machine: tab.querySelector('.tab-machine')?.textContent ?? null,
    }
  })
  check('and it names its own machine, not the selected one', afterSwitch?.machine === 'This Machine', afterSwitch)
  check(
    'switching environment does not recolour the tab',
    afterSwitch !== null &&
      afterSwitch.background === tabs['Finished Session']?.background,
    { afterSwitch, beforeSwitch: tabs['Finished Session'] },
  )

  // A new tab must describe the selected host, not suggest the user still has
  // to choose between this computer and a server.
  await page.click('.tab-add')
  const chooserCopy = await page.locator('.choose-launchpad .launchpad-sub').textContent()
  check('the new-tab chooser names the selected server', chooserCopy?.includes('on vps') === true, chooserCopy)
  await page.keyboard.press('Meta+w')

  /* ---------------------------------------------------------------- */
  /* 4. The colour, chosen and remembered                              */
  /* ---------------------------------------------------------------- */

  const switcherDot = await page.evaluate(() => {
    const dot = document.querySelector('.bar .crumb .machine-dot')
    return dot ? getComputedStyle(dot).backgroundColor : null
  })
  check('the machine selector carries a dot', switcherDot !== null, switcherDot)

  // Back to this computer, then pick a colour for it in Settings.
  await page.evaluate(() => {
    const crumb = [...document.querySelectorAll<HTMLElement>('.bar .crumb')].find((button) =>
      button.querySelector('.machine-name'),
    )
    crumb?.click()
  })
  await page.waitForTimeout(200)
  await page.evaluate(() => {
    const item = [...document.querySelectorAll<HTMLElement>('.menu-pop .menu-item')].find((button) =>
      button.textContent?.includes('This Machine'),
    )
    item?.click()
  })
  await page.waitForTimeout(400)

  await page.evaluate(() => (document.querySelector('button[title^="Settings"]') as HTMLElement | null)?.click())
  await page.waitForSelector('.settings')
  await page.evaluate(() => {
    const item = [...document.querySelectorAll<HTMLElement>('.settings-nav-item')].find(
      (button) => button.firstElementChild?.textContent?.trim() === 'Machines',
    )
    item?.click()
  })
  // A named menu is intelligible before hue is: the old grid of dots required
  // guessing which colour each circle meant, and made keyboard comparison
  // needlessly hard.
  const colourMenu = await page.evaluate(async () => {
    const row = [...document.querySelectorAll<HTMLElement>('.set-item')].find((node) =>
      node.querySelector('.set-item-name')?.textContent?.trim().startsWith('Colour'),
    )
    ;(row?.querySelector('.select-trigger') as HTMLElement | null)?.click()
    await new Promise((resolve) => setTimeout(resolve, 150))
    const pop = document.querySelector('.menu-pop')
    return {
      trigger: row?.querySelector('.chip-select')?.textContent?.trim() ?? '',
      labels: [...(pop?.querySelectorAll('.menu-item-name') ?? [])].map((node) => node.textContent?.trim() ?? ''),
      hasDotGrid: Boolean(row?.querySelector('.machine-swatches')),
    }
  })
  check('machine colour is a named dropdown', colourMenu.trigger.length > 0 && colourMenu.labels.length === 8, colourMenu)
  check('each machine colour is named in the dropdown', colourMenu.labels.includes('Moss'), colourMenu)
  check('machine colour no longer relies on an anonymous dot grid', colourMenu.hasDotGrid === false, colourMenu)
  await page.screenshot({ path: join(ROOT, '.playwright-mcp', 'sedano-machine-colour-menu.png'), fullPage: false })

  await page.evaluate(() => {
    const option = [...document.querySelectorAll<HTMLElement>('.menu-pop .menu-item')].find(
      (button) => button.querySelector('.menu-item-name')?.textContent?.trim() === 'Moss',
    )
    option?.click()
  })
  await page.waitForTimeout(500)
  const chosen = await page.evaluate(() => {
    const row = [...document.querySelectorAll<HTMLElement>('.set-item')].find((node) =>
      node.querySelector('.set-item-name')?.textContent?.trim().startsWith('Colour'),
    )
    return row?.querySelector('.chip-select')?.textContent?.includes('Moss') ?? false
  })
  check('the dropdown shows the colour once the server has stored the choice', chosen === true)

  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  const colouredDot = await page.evaluate(() => {
    const dot = document.querySelector('.bar .crumb .machine-dot')
    return dot ? getComputedStyle(dot).backgroundColor : null
  })
  check('the machine selector shows the chosen colour', colouredDot === 'rgb(63, 107, 37)', colouredDot)

  // The colour lives on the server, so it must come back on a fresh page too —
  // a value kept only in this window would pass everything above and still be
  // gone tomorrow.
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.app')
  const afterReload = await page.evaluate(() => {
    const dot = document.querySelector('.bar .crumb .machine-dot')
    return dot ? getComputedStyle(dot).backgroundColor : null
  })
  check('and it is still there after a reload', afterReload === 'rgb(63, 107, 37)', afterReload)

  // Dark theme: the same choice, the other value, and nothing recomputed in JS.
  await page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('sedano.settings') ?? '{}')
    localStorage.setItem('sedano.settings', JSON.stringify({ ...stored, theme: 'dark' }))
  })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.app')
  const darkDot = await page.evaluate(() => {
    const dot = document.querySelector('.bar .crumb .machine-dot')
    return dot ? getComputedStyle(dot).backgroundColor : null
  })
  check('the dark theme uses the dark value of the same colour', darkDot === 'rgb(143, 192, 106)', darkDot)

  /* ---------------------------------------------------------------- */
  /* 5. Deleting a terminal                                            */
  /* ---------------------------------------------------------------- */

  // The confirmation is built by the context menu, so it is read from the menu
  // rather than from the source: the wording on screen is the thing under test.
  await page.evaluate(() => {
    localStorage.setItem('sedano.settings', JSON.stringify({ theme: 'light' }))
  })
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('.app')
  await expandRail()
  const row = await page.$(
    '.rail .session-item:has(.title-text:text-is("A Terminal"))',
  )
  check('the terminal fixture is in the rail', row !== null)
  await row?.click({ button: 'right' })
  await page.waitForSelector('.ctx-pop')
  const menuText = await page.evaluate(() => document.querySelector('.ctx-pop')?.textContent ?? '')
  check('the delete entry does not mention tmux', !/tmux/i.test(menuText), menuText)
  await page.evaluate(() => {
    const item = [...document.querySelectorAll<HTMLElement>('.ctx-item')].find((button) =>
      button.textContent?.startsWith('Delete'),
    )
    item?.click()
  })
  await page.waitForSelector('.dialog-box')
  const dialogText = await page.evaluate(() => document.querySelector('.dialog-box')?.textContent ?? '')
  check('the delete confirmation does not mention tmux', !/tmux/i.test(dialogText), dialogText)
  check('the delete confirmation says what happens instead', /transcript|shell/i.test(dialogText), dialogText)
  await page.keyboard.press('Escape')

  check('the app raised no errors while all of this happened', pageErrors.length === 0, pageErrors)
} finally {
  await browser.close()
  await runCleanups()
}

console.log(`\n${passed.length} checks passed`)
for (const label of passed) console.log(`ok   ${label}`)
if (failures.length) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  console.log(`\nverdict: MACHINE UI PROBLEM (${failures.length})`)
  process.exit(1)
}
console.log('machine-ui-test: PASSED')
