#!/usr/bin/env bun
/**
 * The doubled screen.
 *
 * A terminal tab draws two things: a screen replayed from `capture-pane`, and
 * the live bytes the pane's log hands over. `term.offset` is the only thing that
 * keeps the two from telling different stories — it says how far into the pane's
 * output stream the replayed screen reaches, so the client can drop a live chunk
 * the screen already contains. When that number is too low the chunk is drawn
 * again on top of the screen that already had it, and a tab that has just opened
 * shows its prompt twice with nothing below.
 *
 * So the contract under test is one sentence:
 *
 *   a snapshot's `offset` must account for everything its screen shows.
 *
 * It is checked against a real tmux pane, because the failure lives in the gap
 * between two commands inside one shell and nothing simulated has that gap. Then
 * the consequence is checked where the user sees it: the frames the driver really
 * produced are replayed into a real xterm.js — the screen, then every live chunk
 * the screen does not cover — and the rendered buffer must hold each line once,
 * for a tab that has just opened and again after a reattach.
 *
 * The remote path goes through `scripts/fixtures/fake-ssh.ts` and never opens a
 * real connection. It cannot check the same contract, and the reason is worth
 * writing down: the fixture's "host" is this machine with a different `$HOME`,
 * while `pipe-pane` runs its command from the *tmux server*, which has the real
 * one. Reader and writer therefore disagree about where the pane log is, which is
 * an artefact of the fixture and not something a real host does. What the remote
 * half does check is the part that actually travels: the snapshot script survives
 * ssh's join-then-parse intact, its reply is still readable as screen + cursor +
 * offset, and a reattach over that hop draws no line twice.
 *
 *   bun scripts/term-double-test.ts
 */
import './lib/isolate.ts'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { SEDANO_HOME } from '../apps/server/src/paths.ts'
import { TerminalDriver } from '../apps/server/src/harnesses/terminal/driver.ts'
import { which } from '../apps/server/src/which.ts'
import type { CreateOptions, DriverHooks, TerminalScreen } from '../apps/server/src/harnesses/types.ts'

const passed: string[] = []
const failures: string[] = []
/** What a run deliberately did not check, so a gap is never silence. */
const notes: string[] = []

const ok = (label: string): void => void passed.push(label)
const bad = (label: string): void => void failures.push(label)
const note = (label: string): void => void notes.push(label)

/* ------------------------------------------------------------------ */
/* the driver, with its output collected                               */
/* ------------------------------------------------------------------ */

/** One live frame, as the socket would carry it. */
interface Chunk {
  text: string
  offset: number
}

const noop = (): void => {}

function hooksCollecting(chunks: Chunk[]): DriverHooks {
  return {
    event: noop,
    delta: noop,
    status: noop,
    model: noop,
    usage: noop,
    tokens: noop,
    nativeId: noop,
    resumeHint: noop,
    title: noop,
    error: noop,
    turnStarted: noop,
    terminal: (text: string, offset?: number) => void chunks.push({ text, offset: offset ?? 0 }),
    meta: noop,
    limits: noop,
  } as unknown as DriverHooks
}

function options(sessionId: string, cwd: string, host: string | null): CreateOptions {
  return {
    sessionId,
    nativeId: null,
    cwd,
    host,
    model: null,
    effort: null,
    permissionMode: 'acceptEdits',
    preset: 'shell',
  }
}

/* ------------------------------------------------------------------ */
/* the contract                                                        */
/* ------------------------------------------------------------------ */

/**
 * The byte position, in the pane's log, just past the last occurrence of a line.
 *
 * The log is the stream `offset` counts, so this is where the chunk carrying that
 * line ends — and therefore the smallest offset a screen showing the line may
 * honestly claim. The *last* occurrence is the one to measure: a shell echoes
 * what you typed before it runs it, and the screen shows the newest copy.
 */
function endOfLine(log: Buffer, line: string): number {
  const at = log.lastIndexOf(Buffer.from(line))
  return at < 0 ? -1 : at + Buffer.byteLength(line)
}

/** The complaint when a frame claims less than its screen shows, else null. */
function contractBreach(shot: TerminalScreen, log: Buffer, line: string): string | null {
  if (!shot.screen.includes(line)) return null
  const endsAt = endOfLine(log, line)
  if (endsAt < 0) return null
  if (shot.offset >= endsAt) return null
  return `screen shows "${line.slice(0, 40)}" (ends at byte ${endsAt}) but offset says ${shot.offset} — ${endsAt - shot.offset} bytes the screen already has would be drawn again`
}

/**
 * The same check against every line the screen shows rather than one named line,
 * which is what a prompt needs: nobody chose its text.
 */
function contractBreachAny(shot: TerminalScreen, log: Buffer): string | null {
  for (const raw of stripEscapes(shot.screen).split('\n')) {
    const line = raw.trim()
    // Short lines are not distinctive enough to locate in the log.
    if (line.length < 8) continue
    const breach = contractBreach({ ...shot, screen: line }, log, line)
    if (breach) return breach
  }
  return null
}

/** Escape sequences out, so a rendered line can be looked for in the raw log. */
function stripEscapes(text: string): string {
  return text
    .replace(/\][^]*?(|\\)/g, '')
    .replace(/k[^]*?(|\\)/g, '')
    .replace(/\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[=>]/g, '')
}

/**
 * The reply has to be taken apart correctly, and the screen is where a mistake
 * shows: the driver's script prints a byte count, the screen, a second byte count
 * and the cursor, and a parser that loses its footing sends the whole lot out as
 * the screen — the counts and the cursor then appear in the pane as text. This
 * says the screen is a screen: the cursor came back separately, and the tail of
 * the reply is not sitting inside it.
 */
function parseResidue(shot: TerminalScreen): string | null {
  if (!shot.cursor) return 'the cursor did not come back, so the reply was not parsed'
  if (/\n\s*\d+\s*\n\d+,\d+\s*$/.test(shot.screen)) return 'the offset and the cursor were left inside the screen'
  return null
}

/* ------------------------------------------------------------------ */
/* rendering, in a real xterm                                          */
/* ------------------------------------------------------------------ */

const XTERM_JS = readFileSync(join(import.meta.dir, '../node_modules/@xterm/xterm/lib/xterm.js'), 'utf8')

/**
 * Replay one attach into a real xterm and read back what it drew.
 *
 * This is the client's rule and nothing else: the replayed screen replaces what
 * the terminal has, and a live chunk is written only when the screen does not
 * already cover it (`offset > snapshot.offset`). Running it here is what turns
 * the contract into a picture — the frames are the ones the driver really
 * produced and the buffer is the one xterm really rendered, so bytes drawn twice
 * are bytes that are in the buffer twice.
 */
async function renderAttach(browser: Browser, shot: TerminalScreen, chunks: Chunk[]): Promise<string[]> {
  const page = await browser.newPage()
  try {
    await page.setContent('<div id="host" style="width:900px;height:600px"></div>')
    await page.addScriptTag({ content: XTERM_JS })
    return await page.evaluate(
      ({ shot, chunks }) => {
        const global = window as unknown as { Terminal: new (opts: unknown) => any }
        const term = new global.Terminal({ cols: 100, rows: 30, scrollback: 2000, allowProposedApi: true })
        term.open(document.getElementById('host')!)
        // The same steps `Terminal.tsx` takes: one trailing newline off (tmux pads
        // the capture to the pane's height and every line it prints ends with one),
        // bare LFs turned back into CRLF, and the cursor put where the pane says it
        // is.
        const screen = shot.screen.replace(/\r?\n$/, '')
        term.reset()
        const place = shot.cursor ? `[${shot.cursor.y + 1};${shot.cursor.x + 1}H` : ''
        term.write(screen.replace(/\r?\n/g, '\r\n') + place)
        for (const chunk of chunks) {
          if (chunk.offset <= shot.offset) continue
          term.write(chunk.text)
        }
        return new Promise<string[]>((resolve) => {
          term.write('', () => {
            const buffer = term.buffer.active
            const lines: string[] = []
            for (let y = 0; y < buffer.length; y += 1) lines.push(buffer.getLine(y)?.translateToString(true) ?? '')
            resolve(lines)
          })
        })
      },
      { shot, chunks },
    )
  } finally {
    await page.close()
  }
}

/**
 * Draw one replayed screen at the pane's own geometry and read back the rows the
 * user would be looking at.
 *
 * This is the other half of the picture, and it needs no race at all: whatever
 * the pane is showing, the replay of it has to show the same thing. A frame that
 * is one row short slides the whole thing up, and with the scrollback an attach
 * brings along the line above the screen lands where the screen's first row
 * belongs — which is how one prompt came to read as two.
 */
async function renderViewport(
  browser: Browser,
  shot: TerminalScreen,
  cols: number,
  rows: number,
): Promise<string[]> {
  const page = await browser.newPage()
  try {
    await page.setContent('<div id="host" style="width:1200px;height:600px"></div>')
    await page.addScriptTag({ content: XTERM_JS })
    return await page.evaluate(
      ({ shot, cols, rows, esc }) => {
        const global = window as unknown as { Terminal: new (opts: unknown) => any }
        const term = new global.Terminal({ cols, rows, scrollback: 10000, allowProposedApi: true })
        term.open(document.getElementById('host')!)
        term.reset()
        const place = shot.cursor ? `${esc}[${shot.cursor.y + 1};${shot.cursor.x + 1}H` : ''
        term.write(shot.screen.replace(/\r?\n/g, '\r\n') + place)
        return new Promise<string[]>((resolve) => {
          term.write('', () => {
            const buffer = term.buffer.active
            const lines: string[] = []
            for (let y = buffer.baseY; y < buffer.baseY + rows; y += 1) {
              lines.push(buffer.getLine(y)?.translateToString(true).trimEnd() ?? '')
            }
            resolve(lines)
          })
        })
      },
      { shot, cols, rows, esc: String.fromCharCode(27) },
    )
  } finally {
    await page.close()
  }
}

/** What tmux says is on the pane's screen right now, as plain rows. */
function paneRows(name: string): string[] {
  const out = Bun.spawnSync(['tmux', 'capture-pane', '-p', '-t', name], { stdout: 'pipe', stderr: 'ignore' })
    .stdout.toString()
  // The last line is the artefact of the capture's trailing newline, not a row.
  const rows = out.split('\n')
  if (rows.length && rows[rows.length - 1] === '') rows.pop()
  return rows.map((line) => line.trimEnd())
}

/** The pane's geometry, as tmux has it. */
function paneSize(name: string): { cols: number; rows: number } | null {
  const out = Bun.spawnSync(['tmux', 'display', '-p', '-t', name, '#{window_width}x#{window_height}'], {
    stdout: 'pipe',
    stderr: 'ignore',
  }).stdout.toString().trim()
  const [cols, rows] = out.split('x').map((value) => Number.parseInt(value, 10))
  return Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0 ? { cols, rows } : null
}

/**
 * Every rendered line the marker appears on.
 *
 * Two are expected and both are real: the command as the shell echoed it back,
 * and the line that command printed. A third is residue — the same bytes drawn a
 * second time — which is what a broken offset looks like on screen.
 */
function linesWith(lines: string[], marker: string): string[] {
  return lines.filter((line) => line.includes(marker))
}

/** The first pair of identical, non-blank lines sitting one on top of the other. */
function adjacentTwin(lines: string[]): string | null {
  let previous = ''
  for (const line of lines) {
    const text = line.trim()
    if (text && text === previous) return text
    previous = text
  }
  return null
}

/* ------------------------------------------------------------------ */
/* one run, local or through fake-ssh                                  */
/* ------------------------------------------------------------------ */

/** Panes this run created, so cleanup can never touch one it did not make. */
const madeTmux = new Set<string>()

/**
 * The pane log the *driver* counts its offsets against.
 *
 * Locally that is this machine's store. Through the fixture it is the fake host's
 * `$HOME` — the path the driver's own `wc -c` reads — and it stays empty, because
 * `pipe-pane` runs its command from the tmux server, which has the real `$HOME`.
 * Reading the file the pane actually wrote would compare two different streams
 * and invent a failure, so this returns nothing instead and the log-based half of
 * the run stands down and says so.
 */
function driverLogPath(name: string, host: string | null): string {
  return host
    ? join(process.env.FAKE_SSH_ROOT ?? '', 'hosts', host, '.sedano', 'panes', `${name}.log`)
    : join(SEDANO_HOME, 'panes', `${name}.log`)
}

/** Everywhere a pane of this run may have left a log, for cleanup. */
function paneLogCandidates(name: string, host: string | null): string[] {
  return [driverLogPath(name, host), join(homedir(), '.sedano', 'panes', `${name}.log`), join(SEDANO_HOME, 'panes', `${name}.log`)]
}

function readPaneLog(name: string, host: string | null): Buffer {
  const path = driverLogPath(name, host)
  try {
    if (statSync(path).size > 0) return readFileSync(path)
  } catch {
    /* nothing there */
  }
  return Buffer.alloc(0)
}

async function exercise(browser: Browser, where: string, host: string | null, cwd: string): Promise<void> {
  const label = `[${where}]`
  const sessionId = `${Math.random().toString(16).slice(2, 10)}-0000-0000-0000-000000000000`
  const chunks: Chunk[] = []
  const driver = new TerminalDriver(options(sessionId, cwd, host), hooksCollecting(chunks), 'shell')
  madeTmux.add(driver.name)
  const log = (): Buffer => readPaneLog(driver.name, host)

  const marked: { shot: TerminalScreen; chunks: Chunk[]; marker: string; breached: boolean }[] = []

  try {
    await driver.start()

    /* --- 1. the screen of a pane that is still printing its first prompt --- */
    // This is the user's case: a tab asks for its screen the moment it opens, and
    // the shell's first prompt is written while that capture is being taken.
    let opening: string | null = null
    let residue: string | null = null
    for (let attempt = 0; attempt < 12 && !opening && !residue; attempt += 1) {
      const shot = await driver.snapshot(attempt === 0)
      if (!shot.screen.trim()) {
        await Bun.sleep(60)
        continue
      }
      residue = parseResidue(shot)
      opening = contractBreachAny(shot, log())
      await Bun.sleep(60)
    }
    if (residue) bad(`${label} the snapshot reply was mis-parsed: ${residue}`)
    else ok(`${label} the snapshot reply comes back as a screen, a cursor and an offset`)
    if (opening) bad(`${label} a starting pane's screen claimed an offset it did not cover: ${opening}`)
    else if (log().length) ok(`${label} every screen of a starting pane covered what it showed`)

    await Bun.sleep(600)

    /* --- 2. a line printed while a capture is in flight --- */
    // The sweep is wide and fine because the moment a typed line reaches the pane
    // is a round trip away, and the capture has to land on top of it.
    let breaches = 0
    let raced = 0
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const marker = `SEDANOMARK${attempt}`
      const before = chunks.length
      driver.write(`printf '%s\\n' ${marker}\r`)
      await Bun.sleep(attempt * 5)
      const shot = await driver.snapshot(false)
      await Bun.sleep(350)
      const breach = contractBreach(shot, log(), marker)
      if (shot.screen.includes(marker)) {
        raced += 1
        marked.push({ shot, chunks: chunks.slice(before), marker, breached: breach !== null })
      }
      if (breach) {
        breaches += 1
        if (breaches === 1) bad(`${label} ${breach}`)
      }
    }
    if (!raced) bad(`${label} no capture ever caught a line mid-flight — nothing was tested`)
    else if (!breaches && log().length) ok(`${label} ${raced} captures caught a line mid-flight and every one covered it`)
    if (!log().length) {
      note(
        `${label} the pane log the driver counts against is not readable from here, so the offset contract itself is only checked on this machine (see the header)`,
      )
    }

    /* --- 3. what that renders as --- */
    // A frame that broke the contract is the one worth drawing, because the point
    // of the contract is what it does to the screen. When every frame was honest
    // the last one stands in, and the assertion is the same either way.
    const sample = marked.find((frame) => frame.breached) ?? marked[marked.length - 1]
    if (sample) {
      const lines = await renderAttach(browser, sample.shot, sample.chunks)
      const seen = linesWith(lines, sample.marker)
      if (seen.length > 2) {
        bad(`${label} ${sample.marker} rendered on ${seen.length} lines, expected the echo and the output only: ${JSON.stringify(seen)}`)
      } else ok(`${label} a line a capture caught mid-flight renders once, under the command that printed it`)
    }

    /* --- 4. a reattach --- */
    // First fill the scrollback past the pane's own height. A replay only slides
    // when history plus screen is taller than the terminal: below that nothing
    // scrolls, a frame one row short pads out to the same picture, and a test that
    // never scrolls cannot see the failure it is here for.
    driver.write("for i in $(seq 1 60); do echo PAD$i; done\r")
    await Bun.sleep(2500)
    // And then clear it, which is what leaves the pane in the shape the failure
    // needs: a prompt on the first row and blank rows all the way down, with all
    // that output now in the scrollback. Those blank rows are the ones a frame
    // loses, and losing them is invisible until there is history above them.
    driver.write('clear\r')
    await Bun.sleep(1500)

    // Closing the app and coming back: the tmux session survives, a new driver
    // takes it over, and the client draws the screen it is handed plus whatever
    // arrives live. Nothing may be drawn twice.
    driver.stop()
    await Bun.sleep(400)
    const again: Chunk[] = []
    const second = new TerminalDriver(options(sessionId, cwd, host), hooksCollecting(again), 'shell')
    try {
      await second.start()
      const reattach = await second.snapshot(true)
      // A moment for the tail to hand over anything written after the capture,
      // which is precisely what an attach must not draw twice.
      await Bun.sleep(700)
      const breach = contractBreachAny(reattach, log())
      if (breach) bad(`${label} a reattach claimed an offset it did not cover: ${breach}`)
      else if (log().length) ok(`${label} the screen a reattach replayed covered what it showed`)

      // What the pane shows and what the replay draws have to be the same rows.
      // Deliberately compared while the pane is quiet, so this says nothing about
      // timing and everything about the shape of the frame.
      const size = paneSize(driver.name)
      if (size) {
        const quiet = await second.snapshot(true)
        // A frame ends where the pane's screen ends, blank rows and all. They are
        // not padding to be tidied away: they are what says where the screen is,
        // and a frame one row short slides the whole replay up by a row under the
        // scrollback an attach brings with it — which is how the line above the
        // screen came to sit where the pane's first row belongs.
        const real = paneRows(driver.name)
        const tail = quiet.screen.split('\n').slice(-real.length).map((line) => line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').trimEnd())
        if (real.length && tail.join('\n') !== real.join('\n')) {
          bad(
            `${label} the frame does not end on the pane's screen\n      pane: ${JSON.stringify(real.slice(0, 3))} … ${JSON.stringify(real.slice(-2))}\n      frame tail: ${JSON.stringify(tail.slice(0, 3))} … ${JSON.stringify(tail.slice(-2))}`,
          )
        } else if (real.length) ok(`${label} a replay ends exactly on the pane's ${real.length} visible rows`)

        const shown = await renderViewport(browser, quiet, size.cols, size.rows)
        if (shown.join('\n') !== real.join('\n')) {
          bad(
            `${label} the replayed screen is not the pane's screen\n      pane:   ${JSON.stringify(real)}\n      drawn:  ${JSON.stringify(shown)}`,
          )
        } else ok(`${label} a replay with the scrollback draws exactly the pane's ${size.rows} rows`)
      }

      const lines = await renderAttach(browser, reattach, again)
      const twin = adjacentTwin(lines)
      if (twin) bad(`${label} a reattach drew "${twin}" twice, one line under the other`)
      else ok(`${label} a reattach renders no line twice`)

      const last = marked[marked.length - 1]?.marker
      if (last) {
        const seen = linesWith(lines, last)
        if (seen.length > 2) bad(`${label} ${last} is on ${seen.length} lines after a reattach: ${JSON.stringify(seen)}`)
        else ok(`${label} the session's last line is on screen once after a reattach`)
      }
    } finally {
      second.destroy()
      await Bun.sleep(200)
    }
  } finally {
    driver.destroy()
    await Bun.sleep(200)
  }
}

/* ------------------------------------------------------------------ */
/* the fake host                                                       */
/* ------------------------------------------------------------------ */

/**
 * The fake `ssh` has to be on PATH before this process starts.
 *
 * `Bun.spawn` resolves a binary against the PATH the process was *launched*
 * with, so assigning `process.env.PATH` from here would still run the real
 * client — and opening a real connection is the one thing this must never do.
 * The first pass therefore only builds the sandbox and re-runs this file inside
 * it with the fake first on PATH. The rest of PATH is kept because the run needs
 * tmux and Chrome; first position is what decides `ssh`.
 */
if (!process.env.SEDANO_DOUBLE_ROOT) {
  // Under `/tmp` rather than `TMPDIR`: an ssh control socket path is capped at
  // ~104 bytes and macOS puts `TMPDIR` deep enough to blow that on its own.
  const sandbox = mkdtempSync('/tmp/sedano-dbl-')
  const bin = join(sandbox, 'bin')
  mkdirSync(bin, { recursive: true })
  const fixture = join(import.meta.dir, 'fixtures', 'fake-ssh.ts')
  writeFileSync(join(bin, 'ssh'), `#!/bin/sh\nexec ${process.execPath} ${fixture} "$@"\n`)
  chmodSync(join(bin, 'ssh'), 0o755)
  writeFileSync(join(sandbox, 'control.json'), '{}')
  const child = Bun.spawnSync([process.execPath, import.meta.path], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      SEDANO_DOUBLE_ROOT: sandbox,
      // The fake reads this at spawn time; a child's environment is fixed when
      // the parent starts, which is why everything else travels in a file.
      FAKE_SSH_ROOT: sandbox,
      SEDANO_HOME,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  rmSync(sandbox, { recursive: true, force: true })
  process.exit(child.exitCode ?? 1)
}

if (!which('tmux')) {
  console.error('term-double-test: SKIPPED — tmux is not installed, and there is no pane to test without it')
  process.exit(0)
}

const sandboxRoot = process.env.SEDANO_DOUBLE_ROOT
const workdir = mkdtempSync(join(tmpdir(), 'sedano-double-'))

// The installed Chrome, like the other browser checks in this repo: playwright's
// own headless shell is not part of the checkout.
const browser = await chromium.launch({ channel: 'chrome' })
let crashed: string | null = null

try {
  const local = join(workdir, 'local')
  mkdirSync(local, { recursive: true })
  await exercise(browser, 'this machine', null, local)

  // The remote path, through the fixture. The shim first on PATH is what
  // guarantees no real connection can be opened, whatever the host is called.
  const remoteHome = join(sandboxRoot, 'hosts', 'fakebox')
  mkdirSync(remoteHome, { recursive: true })
  await exercise(browser, 'a host', 'fakebox', remoteHome)
} catch (error) {
  crashed = error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
} finally {
  await browser.close()
  // Only what this run made: its panes, by name, and the logs those panes wrote —
  // including the one the fixture's tmux server put in the real home.
  for (const name of madeTmux) {
    Bun.spawnSync(['tmux', 'kill-session', '-t', name], { stdout: 'ignore', stderr: 'ignore' })
    for (const candidate of [...paneLogCandidates(name, 'fakebox'), ...paneLogCandidates(name, null)]) {
      if (existsSync(candidate)) rmSync(candidate, { force: true })
    }
  }
  rmSync(workdir, { recursive: true, force: true })
}

for (const marker of notes) console.log(`   · ${marker}`)
for (const marker of passed) console.log(`   ✓ ${marker}`)
for (const marker of failures) console.error(`   ✗ ${marker}`)
if (crashed) console.error(`term-double-test: crashed — ${crashed}`)
if (failures.length || crashed) {
  console.error('term-double-test: FAILED')
  process.exit(1)
}
console.log('term-double-test: PASSED')
