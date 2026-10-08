#!/usr/bin/env bun
/**
 * Terminal end-to-end test.
 *
 * Creates a real terminal tab, types into it and checks that a shell answered,
 * then resizes it and asks for a screen snapshot. These are the parts only a
 * live tmux session can prove: keystrokes reach the shell, output comes back,
 * geometry is honoured, and the session outlives this process.
 *
 *   bun scripts/term-smoke.ts [ws://127.0.0.1:7788/api/ws] [cwd] [host]
 *
 * The host is optional and matters more than it looks: a terminal tab on a server
 * talks to it through ssh, and every bug in this area so far lived in that hop
 * (the pipe command re-parsed by the host's shell, a keystroke batch losing its
 * spaces, `cat` stalling on uutils coreutils, `tail` waiting for a newline that a
 * terminal never sends). None of those show up locally, so this can be pointed at
 * a machine that is one network away. Its tmux checks follow the session there.
 */
import type { ClientMsg, ServerMsg } from '@shared'
import { SSH_OPTS } from '../apps/server/src/transport.ts'

const url = process.argv[2] ?? 'ws://127.0.0.1:7788/api/ws'
const cwd = process.argv[3] ?? process.cwd()
const host = process.argv[4] ?? null

/** Run a command on the machine that owns the session — there, or here. */
function onOwner(args: string[]): { stdout: string; exitCode: number } {
  const argv = host ? ['ssh', ...SSH_OPTS, host, ...args.map((arg) => `'${arg.replace(/'/g, `'\\''`)}'`)] : args
  const proc = Bun.spawnSync(argv, { stdout: 'pipe', stderr: 'ignore' })
  return { stdout: proc.stdout.toString(), exitCode: proc.exitCode }
}

const messages: ServerMsg[] = []
const output = new Map<string, string>()
const passed: string[] = []

function events(): ServerMsg[] {
  return messages
}

function sessionOfKind(kind: string): string | null {
  for (const msg of events()) {
    if (msg.t === 'session' && msg.session.kind === kind && msg.session.cwd === cwd) return msg.session.id
  }
  return null
}

const text = (id: string): string => output.get(id) ?? ''

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (predicate()) {
      passed.push(label)
      return
    }
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
}

const socket = new WebSocket(url)
const send = (msg: ClientMsg) => socket.send(JSON.stringify(msg))

socket.onmessage = (event) => {
  const msg = JSON.parse(String(event.data)) as ServerMsg
  messages.push(msg)
  if (msg.t === 'term') output.set(msg.sessionId, `${text(msg.sessionId)}${msg.data}`)
  if (msg.t === 'toast' && msg.level === 'error') console.error(`   server error: ${msg.text}`)
}

socket.onerror = () => {
  console.error('websocket error')
  process.exit(1)
}

socket.onopen = async () => {
  try {
    send({
      t: 'new_session',
      req: { harness: 'shell', kind: 'terminal', cwd, host, preset: 'shell', permissionMode: 'acceptEdits' },
    })

    await waitFor('session created', () => sessionOfKind('terminal') !== null, 15_000)
    const sessionId = sessionOfKind('terminal')!
    send({ t: 'subscribe', sessionId })
    console.log(`session ${sessionId.slice(0, 8)} · terminal · ${cwd}${host ? ` · ${host}` : ''}`)

    const title = events().find((msg) => msg.t === 'session' && msg.session.id === sessionId)
    if (title && title.t === 'session') {
      // Terminal tabs must announce themselves as terminals, never as a session.
      if (!/^Terminal/.test(title.session.title)) {
        throw new Error(`title is "${title.session.title}" — expected it to start with "Terminal"`)
      }
      passed.push(`title is "${title.session.title}"`)
    }

    // A tab that opens late has missed everything already printed — the pane is
    // not a log we replay, so the first screen is asked for by name. On a server
    // that is the difference between "no output" and "output before we looked":
    // starting a session there is a few ssh round trips, and the prompt is up
    // before this connection is.
    send({ t: 'term_snapshot', sessionId })
    await waitFor('shell produced output', () => text(sessionId).length > 0, 25_000)
    await waitFor('shell printed a prompt', () => /[%$#>]/.test(text(sessionId)), 25_000)

    const token = `sedano-${Math.random().toString(36).slice(2, 8)}`
    send({ t: 'term_input', sessionId, data: `echo ${token}\r` })
    await waitFor('typed command reached the shell', () => text(sessionId).includes(token), 10_000)

    // A space is the first thing an argument-contaminated command loses. Typing
    // one has to reach the shell as one string: `ssh host tmux send-keys -l "echo
    // a b"` arrives there as *two* arguments and the pane runs `echoa b`.
    const spaced = `spaced-${Math.random().toString(36).slice(2, 6)}`
    send({ t: 'term_input', sessionId, data: `echo ${spaced} ${spaced}\r` })
    await waitFor(
      'a space in a command survives the trip',
      () => text(sessionId).includes(`${spaced} ${spaced}`),
      10_000,
    )

    send({ t: 'term_resize', sessionId, cols: 120, rows: 40 })
    await new Promise((resolve) => setTimeout(resolve, 700))
    const tmuxName = `sedano-${sessionId.replace(/-/g, '').slice(0, 8)}`
    const sizeText = onOwner(['tmux', 'list-panes', '-t', tmuxName, '-F', '#{pane_width}x#{pane_height}']).stdout.trim()
    if (sizeText !== '120x40') throw new Error(`resize did not reach tmux: pane is ${sizeText || 'missing'} (wanted 120x40)`)
    passed.push(`resize reached tmux (${sizeText})`)

    const before = text(sessionId).length
    send({ t: 'term_snapshot', sessionId })
    await waitFor('snapshot replayed the screen', () => text(sessionId).length > before)
    if (!text(sessionId).includes(token)) throw new Error('the snapshot did not contain the earlier command output')
    passed.push('snapshot contains the earlier output')

    // A keystroke has to come back *before* any newline exists. `tail -n 0 -F`
    // reads lines, and a terminal produces almost no complete ones — a keystroke
    // echo, a cursor move, a whole TUI screen all arrive without a trailing \n
    // and sat in its buffer until Enter. That is how a live tab looked dead while
    // you typed, and why the screen was suddenly correct after a reattach.
    const beforeKey = text(sessionId).length
    send({ t: 'term_input', sessionId, data: 'x' })
    await waitFor(
      'a keystroke echoes back with no newline in sight',
      () => text(sessionId).slice(beforeKey).includes('x'),
      4000,
    )

    const listed = onOwner(['tmux', 'list-sessions', '-F', '#{session_name}']).stdout
    if (!listed.split('\n').includes(tmuxName)) throw new Error(`tmux session ${tmuxName} is not listed`)
    passed.push(`tmux session ${tmuxName} lives on ${host ?? 'this machine'}`)

    // Deleting a terminal session has to take its tmux session with it: the tab
    // says the shell is gone, so leaving it running on the host is a lie — and a
    // leak that only grows. (Closing a *tab* still detaches on purpose.)
    send({ t: 'delete_session', sessionId })
    await waitFor(
      'session deleted',
      () => events().some((msg) => msg.t === 'session_removed' && msg.id === sessionId),
      10_000,
    )
    const survived = onOwner(['tmux', 'has-session', '-t', tmuxName])
    if (survived.exitCode === 0) throw new Error(`tmux session ${tmuxName} survived deletion`)
    passed.push('deleting the session killed its tmux session')

    for (const marker of passed) console.log(`   ✓ ${marker}`)
    console.log('term-smoke: PASSED')
    process.exit(0)
  } catch (error) {
    for (const marker of passed) console.log(`   ✓ ${marker}`)
    console.error(`term-smoke: FAILED — ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
