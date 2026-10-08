#!/usr/bin/env bun
/**
 * A peer that goes away, and a failure that does not.
 *
 * A terminal tab on a host is held together by two long-lived `ssh` children: one
 * streaming the pane's log, one carrying keystrokes. Both of them end the moment
 * the machine on the far side stops answering, and that is *normal* — a link
 * blips, a laptop changes network, a server reboots. The rule this file holds the
 * driver to has two halves and they pull in opposite directions:
 *
 *   a peer that is simply gone must not surface as an error and must not wedge
 *   the tab — it must come back on its own when the link does;
 *   a failure the user needs to know about must still reach them.
 *
 * Everything runs against `scripts/fixtures/fake-ssh.ts` on a sandboxed PATH. No
 * real connection is opened, and the only tmux sessions touched are the ones this
 * file created.
 *
 *   bun scripts/term-epipe-test.ts
 */
import './lib/isolate.ts'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SEDANO_HOME } from '../apps/server/src/paths.ts'
import { TerminalDriver } from '../apps/server/src/harnesses/terminal/driver.ts'
import { which } from '../apps/server/src/which.ts'
import type { TimelineEvent } from '@shared'
import type { CreateOptions, DriverHooks } from '../apps/server/src/harnesses/types.ts'

/* ------------------------------------------------------------------ */
/* the fake ssh has to be on PATH before this process starts           */
/* ------------------------------------------------------------------ */

/**
 * `Bun.spawn` resolves a binary against the PATH the process was *launched*
 * with, so setting `process.env.PATH` from here would still run the real client.
 * The first pass builds the sandbox and re-runs this file inside it.
 */
if (!process.env.SEDANO_EPIPE_ROOT) {
  // Under `/tmp` rather than `TMPDIR`: an ssh control socket path is capped at
  // ~104 bytes and macOS puts `TMPDIR` deep enough to blow that on its own.
  const sandbox = mkdtempSync('/tmp/sedano-epipe-')
  const bin = join(sandbox, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'ssh'),
    `#!/bin/sh\nexec ${process.execPath} ${join(import.meta.dir, 'fixtures', 'fake-ssh.ts')} "$@"\n`,
  )
  chmodSync(join(bin, 'ssh'), 0o755)
  writeFileSync(join(sandbox, 'control.json'), '{}')
  const child = Bun.spawnSync([process.execPath, import.meta.path], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      SEDANO_EPIPE_ROOT: sandbox,
      FAKE_SSH_ROOT: sandbox,
      SEDANO_HOME,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  rmSync(sandbox, { recursive: true, force: true })
  process.exit(child.exitCode ?? 1)
}

/* ------------------------------------------------------------------ */

const root = process.env.SEDANO_EPIPE_ROOT
const passed: string[] = []
const failures: string[] = []
const ok = (label: string): void => void passed.push(label)
const bad = (label: string): void => void failures.push(label)

/**
 * Anything that escaped. A write to a peer that has gone is the ordinary end of
 * a stream, so nothing here may reach these handlers — and if something does, the
 * test says exactly what it was rather than reporting a vague wobble.
 */
const escaped: string[] = []
process.on('unhandledRejection', (error: unknown) => {
  escaped.push(`unhandled rejection: ${describe(error)}`)
})
process.on('uncaughtException', (error: unknown) => {
  escaped.push(`uncaught exception: ${describe(error)}`)
})

function describe(error: unknown): string {
  if (error instanceof Error) return `${(error as NodeJS.ErrnoException).code ?? ''} ${error.message}`.trim()
  return String(error)
}

/** How the fake ssh behaves from its next invocation on. */
function control(state: { down?: string[]; hang?: string[]; cut?: string[] }): void {
  writeFileSync(join(root, 'control.json'), JSON.stringify(state))
}

const noop = (): void => {}

interface Collected {
  events: TimelineEvent[]
  statuses: string[]
  errors: string[]
  output: string
}

function hooksCollecting(into: Collected): DriverHooks {
  return {
    event: (ev: TimelineEvent) => void into.events.push(ev),
    delta: noop,
    status: (status: string) => void into.statuses.push(status),
    model: noop,
    usage: noop,
    tokens: noop,
    nativeId: noop,
    resumeHint: noop,
    title: noop,
    error: (message: string) => void into.errors.push(message),
    turnStarted: noop,
    terminal: (text: string) => void (into.output += text),
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

/** Panes this run created, so cleanup can never touch one it did not make. */
const madeTmux = new Set<string>()

function cleanup(): void {
  for (const name of madeTmux) {
    Bun.spawnSync(['tmux', 'kill-session', '-t', name], { stdout: 'ignore', stderr: 'ignore' })
    for (const dir of [join(SEDANO_HOME, 'panes'), join(homedir(), '.sedano', 'panes'), join(root, 'hosts', 'blipbox', '.sedano', 'panes')]) {
      const file = join(dir, `${name}.log`)
      if (existsSync(file)) rmSync(file, { force: true })
    }
  }
}

if (!which('tmux')) {
  console.error('term-epipe-test: SKIPPED — tmux is not installed, and a terminal tab needs a pane')
  process.exit(0)
}

try {
  /* ---------------------------------------------------------------- */
  /* 1. a failure the user needs to see stays visible                  */
  /* ---------------------------------------------------------------- */

  // A host that refuses the connection is not a peer that went away: nothing was
  // ever opened, and the tab the user just asked for is not going to appear. That
  // has to come back as an error with the reason in it, not as a silent tab.
  control({ down: ['deadbox'] })
  const deadHome = join(root, 'hosts', 'deadbox')
  mkdirSync(deadHome, { recursive: true })
  const deadCollected: Collected = { events: [], statuses: [], errors: [], output: '' }
  const dead = new TerminalDriver(
    options('dead0000-0000-0000-0000-000000000000', deadHome, 'deadbox'),
    hooksCollecting(deadCollected),
    'shell',
  )
  madeTmux.add(dead.name)
  let refusal: string | null = null
  try {
    await dead.start()
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error)
  } finally {
    dead.stop()
  }
  if (!refusal) bad('a host that refuses the connection started a tab anyway, with no error')
  else if (!/refused|could not start tmux session/i.test(refusal)) {
    bad(`a refused connection was reported as "${refusal}" — the reason has to be in it`)
  } else ok(`a refused connection is reported, with the reason: "${refusal.slice(0, 80)}"`)

  /* ---------------------------------------------------------------- */
  /* 2. a peer that goes away is not an error, and not the end         */
  /* ---------------------------------------------------------------- */

  control({})
  const blipHome = join(root, 'hosts', 'blipbox')
  mkdirSync(blipHome, { recursive: true })
  const blip: Collected = { events: [], statuses: [], errors: [], output: '' }
  const driver = new TerminalDriver(
    options('b1190000-0000-0000-0000-000000000000', blipHome, 'blipbox'),
    hooksCollecting(blip),
    'shell',
  )
  madeTmux.add(driver.name)
  await driver.start()
  await Bun.sleep(1200)

  const eventsBefore = blip.events.length

  // The machine stops answering. Every ssh from now on is refused, which is what
  // takes the output stream and the keystroke channel down together.
  control({ down: ['blipbox'] })

  // Type into it while it is gone. None of this can reach the pane, and none of
  // it may raise anything either: a keystroke that cannot be delivered is a
  // keystroke that is lost, which is the honest outcome and not a failure.
  for (let i = 0; i < 12; i += 1) {
    driver.write('x')
    driver.resize(80 + i, 24)
    await Bun.sleep(120)
  }
  // The liveness watcher ticks every 4s; give it two chances to get it wrong.
  await Bun.sleep(9000)

  const exits = blip.events
    .slice(eventsBefore)
    .filter((ev) => (ev as { subtype?: string }).subtype === 'terminal-exit')
  if (exits.length) bad('an unreachable host was announced as "the shell exited" — the pane is still there')
  else ok('an unreachable host is not announced as a shell that exited')
  if (blip.errors.length) bad(`a host that went away was reported as an error: ${blip.errors.join(' | ')}`)
  else ok('a host that went away raises no error of its own')

  // And it has to come back by itself. The pane never went anywhere — only the
  // link did — so once the link is back, typing must land in it again.
  control({})
  const marker = `BACK${Math.random().toString(36).slice(2, 7).toUpperCase()}`
  let landed = false
  for (let attempt = 0; attempt < 30 && !landed; attempt += 1) {
    driver.write(`printf '%s\\n' ${marker}\r`)
    await Bun.sleep(700)
    const screen = await driver.snapshot(false)
    landed = screen.screen.includes(marker)
  }
  if (!landed) bad(`the tab never recovered: ${marker} never reached the pane after the host came back`)
  else ok('the tab recovers on its own once the host answers again')

  driver.destroy()
  await Bun.sleep(300)

  if (escaped.length) bad(`something escaped while the peer was gone: ${escaped.join(' | ')}`)
  else ok('nothing escaped as an unhandled rejection or an uncaught exception')
} catch (error) {
  bad(`crashed — ${error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)}`)
} finally {
  cleanup()
}

// A rejection can arrive a tick after the work that caused it, so the verdict
// waits for the loop to drain once more.
await Bun.sleep(400)
if (escaped.length && !failures.some((line) => line.startsWith('something escaped'))) {
  bad(`something escaped: ${escaped.join(' | ')}`)
}

for (const marker of passed) console.log(`   ✓ ${marker}`)
for (const marker of failures) console.error(`   ✗ ${marker}`)
if (failures.length) {
  console.error('term-epipe-test: FAILED')
  process.exit(1)
}
console.log('term-epipe-test: PASSED')