#!/usr/bin/env bun
/**
 * The visual half of term-smoke: opens the real app, creates a terminal tab
 * through the launchpad, and asserts that xterm actually mounts, receives the
 * shell's output, and forwards typing back to the shell.
 *
 * It talks to a running server, so it creates one tmux session on this machine
 * and takes it away again on the way out — only that one. `sedano-<8 hex>` is
 * also the name every terminal tab you opened yourself carries, so the cleanup
 * works from a before/after diff instead of a pattern: matching the shape alone
 * used to kill the shells you had running.
 *
 *   bun scripts/term-ui-smoke.ts [url]
 */
import { chromium } from 'playwright'

const url = process.argv[2] ?? 'http://127.0.0.1:7788/'
const passed: string[] = []

/** tmux sessions the driver owns on this machine, right now. */
function driverTmuxSessions(): Set<string> {
  const listed = Bun.spawnSync(['tmux', 'list-sessions', '-F', '#{session_name}']).stdout.toString()
  return new Set(
    listed
      .split('\n')
      .map((line) => line.trim())
      .filter((name) => /^sedano-[0-9a-f]{8}$/.test(name)),
  )
}

/** Session ids the app has open, read from the page the app persists them in. */
async function openTabs(page: import('playwright').Page): Promise<string[]> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('sedano.tabs')
    return raw ? (Object.values(JSON.parse(raw) as Record<string, string[]>).flat() as string[]) : []
  })
}

/** Ask the server to delete the sessions this run created, tmux and all. */
async function deleteSessions(url: string, ids: string[]): Promise<void> {
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

const beforeTmux = driverTmuxSessions()
const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const errors: string[] = []
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text())
})
page.on('pageerror', (err) => errors.push(err.message))

let beforeTabs: string[] = []
let failure: string | null = null

try {
  await page.goto(url, { waitUntil: 'networkidle' })
  await page.waitForTimeout(1500)
  beforeTabs = await openTabs(page)

  // This smoke is about *this* machine's terminal, and ⌘T follows the machine
  // switcher — a persisted choice that may be a server. Put it back to local
  // first, or there is no shell here to type into.
  const machineName = (await page.textContent('.bar .crumb .machine-name').catch(() => ''))?.trim()
  if (machineName && machineName !== 'This Machine') {
    await page.click('.menu .crumb')
    await page.waitForTimeout(250)
    await page.locator('.menu-pop .menu-item', { hasText: 'This Machine' }).first().click()
    await page.waitForTimeout(400)
  }

  // ⌘T creates the terminal itself now: there is no form to fill in first.
  await page.keyboard.press('Meta+t')
  await page.waitForTimeout(3000)

  // Opening a terminal is not enough: it has to accept typing immediately, with
  // no click first. The user types into the tab they just opened, which is
  // exactly the path a "click .xterm first" test never exercises.
  const firstMarker = `open${Date.now().toString().slice(-5)}`
  const firstCommand = `echo ${firstMarker}`
  await page.keyboard.type(`${firstCommand}\n`)
  await page.waitForTimeout(1800)
  const onOpen = await page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '')
  // The whole command line, not just the marker: the shell echoes exactly what
  // it received, so a swallowed first keystroke shows up as "cho open…" — and
  // the marker alone would still match, inside the "command not found" error.
  if (!onOpen.includes(firstCommand)) {
    throw new Error(`the command line never reached the shell intact: ${JSON.stringify(onOpen.slice(-160))}`)
  }
  passed.push('a freshly opened terminal accepts typing without a click')

  // The keystroke sink must have a box: Chrome focuses a 0×0 element, WebKit
  // (the desktop window) does not, and the symptom is "the terminal ignores me".
  const sink = await page.evaluate(() => {
    const node = document.querySelector('.xterm-helper-textarea') as HTMLElement | null
    if (!node) return null
    const box = node.getBoundingClientRect()
    return { width: box.width, height: box.height, opacity: getComputedStyle(node).opacity }
  })
  if (!sink || sink.width < 1 || sink.height < 1) {
    throw new Error(`the keystroke sink has no box (${JSON.stringify(sink)}) — WebKit will not focus it`)
  }
  passed.push(`keystroke sink has a box (${sink.width}×${sink.height}, opacity ${sink.opacity})`)

  const mounted = await page.evaluate(() => ({
    xterm: Boolean(document.querySelector('.xterm')),
    rows: document.querySelectorAll('.xterm-rows > div').length,
    text: document.querySelector('.xterm-rows')?.textContent ?? '',
    title: document.querySelector('.tab.active .label')?.textContent?.trim() ?? '',
    status: document.querySelector('.statusbar')?.textContent ?? '',
    launchpadGone: !document.querySelector('.launchpad'),
  }))

  if (!mounted.xterm) throw new Error('xterm did not mount')
  passed.push('xterm mounted in the tab')
  if (mounted.rows < 5) throw new Error(`xterm has only ${mounted.rows} rows`)
  passed.push(`xterm rendered ${mounted.rows} rows`)
  // Prompt glyphs across the usual setups, plus a path-looking string.
  if (!/[➜❯»$%#>]|~\/|\/[a-z]/.test(mounted.text)) {
    throw new Error(`no shell output on screen: ${JSON.stringify(mounted.text.slice(0, 120))}`)
  }
  passed.push('the shell prompt is on screen')
  if (!/^Terminal/.test(mounted.title)) throw new Error(`tab title is "${mounted.title}"`)
  passed.push(`tab title is "${mounted.title}"`)
  if (!mounted.launchpadGone) throw new Error('the launchpad stayed after creating the tab')
  passed.push('the launchpad is replaced by the terminal')

  // Typing must reach the shell and the answer must come back through the
  // stream, not from a local echo.
  const marker = `sedano${Date.now().toString().slice(-5)}`
  await page.click('.xterm')
  await page.keyboard.type(`echo ${marker}\n`)
  await page.waitForTimeout(2000)
  const typed = await page.evaluate(() => document.querySelector('.xterm-rows')?.textContent ?? '')
  if (!typed.includes(marker)) throw new Error(`typed input never reached the shell: ${JSON.stringify(typed.slice(-120))}`)
  const occurrences = typed.split(marker).length - 1
  if (occurrences < 2) throw new Error(`the command echoed once but produced no output (${occurrences} occurrences)`)
  passed.push('typing reaches the shell and its output comes back')

  // A terminal is talked to directly: the chat composer must not be there at all.
  const composer = await page.evaluate(() => Boolean(document.querySelector('.composer')))
  if (composer) throw new Error('a terminal tab still renders the message composer')
  passed.push('a terminal tab has no message composer')

  await page.screenshot({ path: '.playwright-mcp/sedano-terminal.png' })

  console.log(`session title: ${mounted.title}`)
  if (errors.length) throw new Error(`console errors: ${errors.join(' | ')}`)
} catch (error) {
  failure = error instanceof Error ? error.message : String(error)
} finally {
  const created = (await openTabs(page).catch(() => [])).filter((id) => !beforeTabs.includes(id))
  await browser.close()

  // Housekeeping, in two parts: the sessions this run opened are deleted through
  // the server (which takes their tmux with them), and any tmux session that
  // appeared while we ran and is still there is killed by name. Sessions that
  // existed beforehand are never touched.
  await deleteSessions(url, created)
  for (const name of driverTmuxSessions()) {
    if (!beforeTmux.has(name)) Bun.spawnSync(['tmux', 'kill-session', '-t', name])
  }
}

for (const marker of passed) console.log(`   ✓ ${marker}`)
if (failure) {
  if (errors.length) console.error(`console errors:\n${errors.join('\n')}`)
  console.error(`term-ui-smoke: FAILED — ${failure}`)
  process.exit(1)
}
console.log('term-ui-smoke: PASSED')
