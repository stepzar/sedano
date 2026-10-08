#!/usr/bin/env bun
/**
 * Folder navigation and the bottom terminal, in a real browser.
 *
 * Three things are checked, and each of them is a thing that was wrong:
 *
 * 1. The folder chooser walks in columns. Entering a folder opens a column to
 *    its right and the ones you came through stay where they were — with their
 *    marks — so the level above is a click away. The keyboard does the same
 *    walk, and typing filters the column you are standing in.
 * 2. A column that could not be read says so, with a kind, and *never* looks
 *    like a folder with nothing in it. That confusion is the whole reason the
 *    transport types its failures, and it is checked here against a host that is
 *    reachable and then is not.
 * 3. ⌘J raises the docked terminal from the bottom of the pane and puts it away,
 *    collides with none of the other chords, covers neither the composer nor the
 *    transcript's last line, and leaves the transcript scrolled where it was.
 *
 * Everything runs against `scripts/fixtures/fake-ssh.ts` on a sandboxed PATH, a
 * temporary `SEDANO_HOME` and the fixture ssh config: no real host is contacted
 * and the operator's own store is never opened. The PATH is deliberately narrow
 * so the server cannot find a vendor CLI and start spending somebody's quota
 * looking for its usage.
 *
 *   bun scripts/nav-check.ts      (needs "bun run build:ui" first)
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/* ------------------------------------------------------------------ */
/* The fake ssh has to be on PATH before this process starts           */
/* ------------------------------------------------------------------ */

/**
 * Bun resolves a spawned binary against the PATH the process was started with,
 * so assigning `process.env.PATH` here would still reach the real `ssh`. The
 * first pass only builds the sandbox and re-runs this file inside it.
 *
 * Under `/tmp` rather than `TMPDIR`: ssh control sockets are unix sockets, whose
 * paths are capped at ~104 bytes, and macOS puts `TMPDIR` deep enough to blow
 * that on its own.
 */
if (!process.env.SEDANO_NAV_TEST_ROOT) {
  const sandbox = mkdtempSync('/tmp/sedano-nav-')
  const bin = join(sandbox, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'ssh'),
    `#!/bin/sh\nexec ${process.execPath} ${join(import.meta.dir, 'fixtures', 'fake-ssh.ts')} "$@"\n`,
  )
  chmodSync(join(bin, 'ssh'), 0o755)
  const child = Bun.spawnSync([process.execPath, import.meta.path], {
    env: {
      ...process.env,
      // Narrow on purpose: bun (for the server this starts) and the system
      // directories, and nothing a vendor CLI is likely to live in.
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      SEDANO_NAV_TEST_ROOT: sandbox,
      FAKE_SSH_ROOT: sandbox,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  rmSync(sandbox, { recursive: true, force: true })
  process.exit(child.exitCode ?? 1)
}

const { chromium } = await import('playwright')
const { ROOT, installExitHandlers, runCleanups, seedStore, startApi } = await import('./lib/harness.ts')
const { openRichestSession } = await import('./lib/app.ts')

installExitHandlers()

const failures: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) return
  failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

/* ------------------------------------------------------------------ */
/* A world of our own                                                  */
/* ------------------------------------------------------------------ */

const sandbox = process.env.SEDANO_NAV_TEST_ROOT!
const sedanoHome = join(sandbox, 'h')
const controlFile = join(sandbox, 'control.json')
/** The fake host's `$HOME`: the same shape the fake ssh gives every destination. */
const vpsHome = join(sandbox, 'hosts', 'vps')
/** A local tree the picker can be pointed at, so the columns are deterministic. */
const localRoot = join(sandbox, 'tree')

for (const dir of [
  sedanoHome,
  join(localRoot, 'one', 'two', 'three'),
  join(localRoot, 'one', 'hollow'),
  join(localRoot, 'sibling'),
  join(vpsHome, 'work', 'alpha', 'inside'),
  join(vpsHome, 'work', 'hollow'),
]) {
  mkdirSync(dir, { recursive: true })
}

interface Control {
  down?: string[]
}
function control(state: Control): void {
  writeFileSync(controlFile, JSON.stringify(state))
}
control({})

// Only `vps`, and only because it is a literal alias in the fixture ssh config:
// the server's own gate is what this has to satisfy, not a flag.
writeFileSync(join(sedanoHome, 'config.json'), `${JSON.stringify({ hosts: ['vps'] }, null, 2)}\n`)

const bundle = join(ROOT, 'apps', 'ui', 'dist', 'index.html')
if (!existsSync(bundle)) {
  console.error(`the UI bundle is missing at ${bundle} — run "bun run build:ui" before this check`)
  process.exit(1)
}

const env = {
  SEDANO_HOME: sedanoHome,
  SEDANO_SSH_CONFIG: join(import.meta.dir, 'fixtures', 'ssh-config'),
  // Project discovery walks these; pointed at the sandbox so the result never
  // depends on the transcripts the operator happens to have.
  CLAUDE_CONFIG_DIR: join(sedanoHome, 'claude'),
  CODEX_HOME: join(sedanoHome, 'codex'),
  GROK_HOME: join(sedanoHome, 'grok'),
  GEMINI_DIR: join(sedanoHome, 'gemini'),
}

// The fixture sessions claim to run in `<sandbox>/tree/one`, which is what makes
// a new tab open the picker there — two known columns, every time.
await seedStore(env, join(localRoot, 'one'))
const api = await startApi(env)

const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const consoleErrors: string[] = []
page.on('console', (msg) => {
  // A 400 from `/api/fs` is *this check's own doing*: section 4 takes the host
  // down on purpose and the browser logs every failed request. What must stay
  // silent is the app itself — an exception, a React warning, a render that
  // threw — so only the network line the test caused is let through.
  if (msg.type() === 'error' && !msg.text().startsWith('Failed to load resource')) {
    consoleErrors.push(msg.text())
  }
})
page.on('pageerror', (err) => consoleErrors.push(err.message))

await page.goto(`${api.url}/`)
await page.waitForSelector('.app')

/* ------------------------------------------------------------------ */
/* Helpers that speak the picker's language                            */
/* ------------------------------------------------------------------ */

/** Opens a fresh agent draft and its folder chooser. */
async function openPicker(): Promise<void> {
  // A brand-new window intentionally starts with no guessed workspace. For the
  // deterministic local walk below, enter the seeded fixture session first so
  // the new draft inherits the folder the user is actually working in. On the
  // remote-machine pass there is no local row in the filtered rail, so this is
  // a harmless no-op and the picker correctly starts at that host's home.
  if (await page.locator('.launchpad-title').count()) await openRichestSession(page)
  await page.evaluate(async () => {
    document.querySelector<HTMLElement>('.picker-foot .ghost.tiny')?.click()
    await new Promise((r) => setTimeout(r, 120))
    document.querySelector<HTMLElement>('.tab-add')?.click()
    await new Promise((r) => setTimeout(r, 200))
    const cards = [...document.querySelectorAll<HTMLElement>('.choose-card')]
    cards.find((card) => /Agent/.test(card.textContent ?? ''))?.click()
    await new Promise((r) => setTimeout(r, 250))
    // The folder chip opens the workspace menu; "Open folder…" opens the picker.
    document.querySelector<HTMLElement>('.workspace-menu > .select-trigger')?.click()
  })
  await page.locator('.menu-pop .menu-item', { hasText: 'Open folder…' }).click()
  await page.waitForSelector('.fp-col')
  await settled()
}

/** Waits until no column is still reading. */
async function settled(timeoutMs = 15_000): Promise<void> {
  await page
    .waitForFunction(() => document.querySelectorAll('.fp-state[data-state="loading"]').length === 0, {
      timeout: timeoutMs,
    })
    .catch(() => undefined)
}

interface Shape {
  columns: number
  /** The rows of every column, in order. */
  rows: string[][]
  /** The selected row of every column, or null. */
  selected: (string | null)[]
  /** Which column the keyboard is in. */
  focus: number
  /** `ready` / `loading` / `error` / `empty`, per column. */
  states: string[]
  /** The error kind of every column that has one. */
  kinds: (string | null)[]
  breadcrumb: string
  footer: string
}

function shape(): Promise<Shape> {
  return page.evaluate(() => {
    const cols = [...document.querySelectorAll<HTMLElement>('.fp-col')]
    const text = (node: Element | null) => (node?.textContent ?? '').trim()
    return {
      columns: cols.length,
      rows: cols.map((col) => [...col.querySelectorAll('.fp-name')].map((n) => text(n))),
      selected: cols.map((col) => {
        const sel = col.querySelector('.fp-row.sel .fp-name')
        return sel ? text(sel) : null
      }),
      focus: cols.findIndex((col) => col.classList.contains('focus')),
      states: cols.map((col) => {
        const state = col.querySelector<HTMLElement>('.fp-state')
        return state ? (state.dataset.state ?? '?') : 'ready'
      }),
      kinds: cols.map((col) => col.querySelector<HTMLElement>('.fp-state')?.dataset.kind ?? null),
      breadcrumb: text(document.querySelector('.picker-path')),
      footer: text(document.querySelector('.picker-foot .mono')),
    }
  })
}

/** Clicks a folder by name in a given column. */
async function enter(column: number, name: string): Promise<void> {
  const clicked = await page.evaluate(
    ({ column, name }: { column: number; name: string }) => {
      const col = document.querySelectorAll<HTMLElement>('.fp-col')[column]
      if (!col) return false
      const row = [...col.querySelectorAll<HTMLElement>('.fp-row')].find(
        (item) => (item.querySelector('.fp-name')?.textContent ?? '').trim() === name,
      )
      row?.click()
      return Boolean(row)
    },
    { column, name },
  )
  check(`a row named "${name}" exists in column ${column}`, clicked)
  await page.waitForTimeout(120)
  await settled()
}

/* ------------------------------------------------------------------ */
/* 1. Columns, locally                                                 */
/* ------------------------------------------------------------------ */

await openPicker()

const opened = await shape()
check('the chooser opens as columns, not as one list', opened.columns >= 2, opened.columns)
check('the folder you are in is a column of its own', opened.rows[1]?.includes('two') === true, opened.rows)
check('the folder above it is a column too', opened.rows[0]?.includes('one') === true, opened.rows)
check('the column you came from marks where you came from', opened.selected[0] === 'one', opened.selected)

await enter(1, 'two')
const entered = await shape()
check('entering a folder opens a column to its right', entered.columns === opened.columns + 1, entered.columns)
check('the new column holds that folder’s contents', entered.rows[2]?.includes('three') === true, entered.rows)
check('the columns you came through are still there', entered.rows[0]?.includes('one') === true, entered.rows)
check('and they still say which way you went', entered.selected[1] === 'two', entered.selected)
check('the keyboard moves into the column that just opened', entered.focus === 2, entered.focus)
check('the footer names the folder that would be chosen', entered.footer.endsWith('/one/two'), entered.footer)

/* Going back: a click in a parent column, the way the pattern promises. */
await enter(0, 'one')
const back = await shape()
check('clicking a parent column goes back to it', back.focus === 1, back.focus)
check('going back truncates the columns to that path', back.columns === 2, back.columns)
check('the folder that was open is still the marked one', back.selected[0] === 'one', back.selected)

/* ------------------------------------------------------------------ */
/* 2. The keyboard walks the same path                                 */
/* ------------------------------------------------------------------ */

await page.keyboard.press('ArrowDown')
await page.keyboard.press('ArrowRight')
await page.waitForTimeout(150)
await settled()
const byKey = await shape()
check('→ enters the highlighted folder and opens its column', byKey.columns === 3, byKey.columns)
check('→ moves the keyboard into the new column', byKey.focus === 2, byKey.focus)

await page.keyboard.press('ArrowLeft')
await page.waitForTimeout(120)
const leftward = await shape()
check('← steps back a column', leftward.focus === 1, leftward.focus)
check('← lands the highlight on the folder you came out of', leftward.selected[1] !== null, leftward.selected)
check('← keeps the column you left open', leftward.columns === 3, leftward.columns)

/* Typing narrows the column you are standing in, and only that one. */
await page.fill('.picker-search', 'holl')
await page.waitForTimeout(150)
const filtered = await shape()
check('typing filters the column you are in', filtered.rows[1]?.length === 1 && filtered.rows[1][0] === 'hollow', filtered.rows)
check('typing leaves the other columns alone', (filtered.rows[0]?.length ?? 0) > 0, filtered.rows)
await page.fill('.picker-search', '')
await page.waitForTimeout(120)

/* An empty folder is empty. Said here so the remote failure below has something
   to be different from. */
await enter(1, 'hollow')
const hollow = await shape()
check('an empty folder reads as empty', hollow.states[2] === 'empty', hollow.states)
check('an empty folder is not an error', hollow.kinds[2] === null, hollow.kinds)

/* Escape dismisses. */
await page.keyboard.press('Escape')
await page.waitForTimeout(200)
check('Escape dismisses the chooser', (await page.locator('.folder-picker').count()) === 0)

/* ------------------------------------------------------------------ */
/* 3. The buttons are in the app's own casing                          */
/* ------------------------------------------------------------------ */

await openPicker()
/**
 * The controls only: a breadcrumb crumb and a folder row carry a *name* off the
 * filesystem, and a folder called `src` is not a label anybody wrote.
 */
const labels = await page.evaluate(() =>
  [...document.querySelectorAll<HTMLElement>('.picker-head button, .picker-foot button')]
    .filter((node) => !node.classList.contains('crumb'))
    .map((node) => (node.textContent ?? '').trim())
    .filter((text) => text.length > 1 && /[A-Za-z]/.test(text)),
)
/**
 * The convention is Capital Case on every word of a label ("Done", "Cancel",
 * "Show .Folders" elsewhere in this app), and there is no `text-transform`
 * anywhere near a button in `styles.css` — so a lowercase label is a lowercase
 * label, not a style. A leading dot is the dot of `.Folders`.
 */
const lower = labels.filter((text) => /^[a-z]/.test(text))
check('no button in the chooser is labelled in lower case', lower.length === 0, lower)
check('the confirm button is there, capitalised', labels.includes('Use This Folder'), labels)
check('the dismiss button is there, capitalised', labels.includes('Cancel'), labels)

/* ------------------------------------------------------------------ */
/* 4. The same walk on a machine that is not this one                  */
/* ------------------------------------------------------------------ */

await page.keyboard.press('Escape')
await page.waitForTimeout(150)

/** Switches the whole view to a machine by name, through the selector. */
async function useMachine(name: string): Promise<boolean> {
  return page.evaluate(async (wanted: string) => {
    document.querySelector<HTMLElement>('.crumb[title="Which machine to show"]')?.click()
    await new Promise((r) => setTimeout(r, 200))
    const item = [...document.querySelectorAll<HTMLElement>('.menu-pop .menu-item')].find(
      (node) => (node.querySelector('.menu-item-name')?.textContent ?? '').trim() === wanted,
    )
    item?.click()
    await new Promise((r) => setTimeout(r, 400))
    return Boolean(item)
  }, name)
}

check('the enabled host is offered in the machine selector', await useMachine('vps'))
await openPicker()

const remote = await shape()
check('a host lists its own folders', remote.rows.some((rows) => rows.includes('work')), remote.rows)
check('nothing on the host reads as an error while it is up', !remote.states.includes('error'), remote.states)

const workColumn = remote.rows.findIndex((rows) => rows.includes('work'))
await enter(workColumn, 'work')
const inWork = await shape()
check('walking down on a host opens a column too', inWork.columns === workColumn + 2, inWork.columns)
check('the host’s column holds the host’s folders', inWork.rows[workColumn + 1]?.includes('alpha') === true, inWork.rows)

/* An empty folder on the host, so the failure below has a twin to be unlike. */
await enter(workColumn + 1, 'hollow')
const remoteHollow = await shape()
check('an empty folder on a host reads as empty', remoteHollow.states[workColumn + 2] === 'empty', remoteHollow.states)

/* And now the machine stops answering. */
control({ down: ['vps'] })
await enter(workColumn + 1, 'alpha')
const broken = await shape()
const brokenColumn = workColumn + 2
check(
  'a column that could not be read renders as an error',
  broken.states[brokenColumn] === 'error',
  broken.states,
)
check(
  'an unreachable machine does not render as an empty folder',
  broken.states[brokenColumn] !== 'empty',
  broken.states,
)
check(
  'the error carries the kind the transport worked out',
  broken.kinds[brokenColumn] === 'unreachable',
  broken.kinds,
)
check('the error says something a person can read', await page.locator('.fp-error-why').count() > 0)
check('the columns already read are not thrown away by one failure', broken.columns === brokenColumn + 1, broken.columns)

/* Nothing here went near a real machine. */
const sshLog = await Bun.file(join(sandbox, 'ssh.log')).text().catch(() => '')
check('the host was reached through the fake ssh only', sshLog.includes('"host":"vps"'), sshLog.slice(0, 200))
check('no destination other than the fixture host was contacted', !/"host":"(?!vps")/.test(sshLog))

control({})
await page.keyboard.press('Escape')
await page.waitForTimeout(150)
check('the machine selector goes back', await useMachine('This Machine'))

/* ------------------------------------------------------------------ */
/* 5. ⌘J, and the terminal that comes from the bottom                  */
/* ------------------------------------------------------------------ */

// Short enough that the fixture transcript genuinely overflows: "the scroll
// position survives" is only a claim about anything if there is a scroll.
await page.setViewportSize({ width: 1180, height: 760 })
await page.waitForTimeout(200)

// The fixture with the most in it, with its turns unfolded: a transcript that
// fits on screen has no scroll position to survive anything.
const session = await openRichestSession(page)
const ready = await page.evaluate(async () => {
  // The work rows fold to one line each now; open them too, or the unfolded
  // turns are short enough to fit the window.
  for (const row of document.querySelectorAll<HTMLElement>('.turn-body > .wi > button.wr[aria-expanded="false"]')) row.click()
  await new Promise((r) => setTimeout(r, 400))
  const scroller = document.querySelector<HTMLElement>('.transcript')
  // A third of the way down, so it is unambiguously *not* anchored to the end:
  // "the place it was scrolled to" and "still shows its last line" are two
  // different promises, and a transcript parked near the bottom tests both at
  // once and neither properly.
  const max = scroller ? scroller.scrollHeight - scroller.clientHeight : 0
  if (scroller) scroller.scrollTop = Math.round(max * 0.3)
  await new Promise((r) => setTimeout(r, 250))
  return {
    scrollTop: scroller?.scrollTop ?? -1,
    scrollable: max,
    handle: Boolean(document.querySelector('.term-handle')),
    dock: Boolean(document.querySelector('.dock')),
  }
})
check(
  'an agent session opens with a transcript long enough to scroll',
  session.agent && ready.scrollable > 60 && ready.scrollTop > 0,
  { ...session, ...ready },
)
check('the terminal control is in the bottom bar', ready.handle && await page.locator('.statusbar .term-handle').count() === 1, ready)
check('nothing is docked before ⌘J', !ready.dock, ready)

/** Where everything is, in viewport coordinates. */
function geometry() {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const node = document.querySelector(selector)
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height) }
    }
    const scroller = document.querySelector<HTMLElement>('.transcript')
    return {
      dock: box('.dock'),
      dockClass: document.querySelector('.dock')?.className ?? null,
      composer: box('.composer'),
      transcript: box('.transcript'),
      handle: box('.term-handle'),
      statusbar: box('.statusbar'),
      handleOn: document.querySelector('.term-handle')?.classList.contains('on') ?? false,
      scrollTop: scroller?.scrollTop ?? -1,
      // How far the transcript is from showing its own last line. Zero is "the
      // last line is on screen"; the panel must not push it off.
      fromEnd: scroller
        ? Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight)
        : -1,
      pane: box('.pane'),
    }
  })
}

const before = await geometry()
await page.keyboard.press('Meta+j')
await page.waitForTimeout(600)
const raised = await geometry()

check('⌘J raises the terminal', raised.dock !== null, raised.dockClass)
check('it comes up docked to the bottom', raised.dockClass?.includes('dock-bottom') === true, raised.dockClass)
check('the control shows that the panel is up', raised.handleOn, raised.handleOn)
check(
  'the raised panel does not cover the composer',
  Boolean(raised.composer && raised.dock && raised.composer.bottom <= raised.dock.top),
  { composer: raised.composer, dock: raised.dock },
)
check(
  'the raised panel does not cover the transcript',
  Boolean(raised.transcript && raised.dock && raised.transcript.bottom <= raised.dock.top),
  { transcript: raised.transcript, dock: raised.dock },
)
check(
  'the control stays inside the bottom bar',
  Boolean(raised.statusbar && raised.handle && raised.handle.top >= raised.statusbar.top && raised.handle.bottom <= raised.statusbar.bottom),
  { statusbar: raised.statusbar, handle: raised.handle },
)
check(
  'the transcript keeps the place it was scrolled to',
  raised.scrollTop === before.scrollTop,
  { before: before.scrollTop, after: raised.scrollTop },
)

await page.keyboard.press('Meta+j')
await page.waitForTimeout(500)
const dismissed = await geometry()
check('⌘J puts it away again', dismissed.dock === null, dismissed.dockClass)
check('the control stops showing it as up', !dismissed.handleOn, dismissed.handleOn)
check(
  'and the transcript is still where it was',
  dismissed.scrollTop === before.scrollTop,
  { before: before.scrollTop, after: dismissed.scrollTop },
)

/**
 * The other half of "it does not cover the last line".
 *
 * The panel never overlaps the transcript — it takes space away from it — so the
 * line that can go missing is the *last* one: shrink a transcript that was read
 * to the end and the end slides below the fold. Read to the end, raise, and the
 * end has to still be on screen.
 */
await page.evaluate(() => {
  const scroller = document.querySelector<HTMLElement>('.transcript')
  if (scroller) scroller.scrollTop = scroller.scrollHeight
})
await page.waitForTimeout(250)
await page.keyboard.press('Meta+j')
await page.waitForTimeout(700)
const pinnedRaise = await geometry()
check(
  'a transcript read to the end still shows its last line once the panel is up',
  pinnedRaise.fromEnd >= 0 && pinnedRaise.fromEnd <= 4,
  { fromEnd: pinnedRaise.fromEnd, dock: pinnedRaise.dock },
)
await page.keyboard.press('Meta+j')
await page.waitForTimeout(400)

/**
 * ⌘J must not have taken a chord that was already spoken for. The neighbours are
 * asserted by driving them: each one still does its own thing, and none of them
 * raises a terminal.
 */
check(
  '⌘J left no overlay open behind it',
  (await page.locator('.overlay').count()) === 0,
)

await page.keyboard.press('Meta+k')
await page.waitForTimeout(300)
const afterPalette = await page.evaluate(() => ({
  palette: Boolean(document.querySelector('.overlay')),
  dock: Boolean(document.querySelector('.dock')),
}))
check('⌘K still opens the palette and does not raise a terminal', afterPalette.palette && !afterPalette.dock, afterPalette)
await page.keyboard.press('Escape')
await page.waitForTimeout(200)

await page.keyboard.press('Meta+b')
await page.waitForTimeout(300)
const afterRail = await page.evaluate(() => ({
  railHidden: Boolean(document.querySelector('.body.rail-hidden')),
  dock: Boolean(document.querySelector('.dock')),
}))
check('⌘B still hides the rail and does not raise a terminal', afterRail.railHidden && !afterRail.dock, afterRail)
await page.keyboard.press('Meta+b')
await page.waitForTimeout(200)

/* A short window is where a fixed-height panel used to squeeze the composer out. */
await page.setViewportSize({ width: 1180, height: 620 })
await page.waitForTimeout(300)
await page.keyboard.press('Meta+j')
await page.waitForTimeout(600)
const short = await geometry()
check('on a short window the panel still leaves the composer whole', Boolean(short.composer && short.composer.height > 60), short.composer)
check(
  'and it still does not cover it',
  Boolean(short.composer && short.dock && short.composer.bottom <= short.dock.top),
  { composer: short.composer, dock: short.dock },
)
check('and the transcript is still a visible strip', Boolean(short.transcript && short.transcript.height > 40), short.transcript)
await page.keyboard.press('Meta+j')
await page.waitForTimeout(300)

/* ------------------------------------------------------------------ */

check('the app logged no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 4))

await browser.close()
await runCleanups()

if (failures.length) {
  console.error(`nav-check: ${failures.length} failure(s)`)
  for (const line of failures) console.error(`  ✗ ${line}`)
  process.exit(1)
}
console.log('nav-check: all checks passed')
