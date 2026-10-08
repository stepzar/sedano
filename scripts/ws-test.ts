#!/usr/bin/env bun
/**
 * Two clients on one session, and a client that comes back.
 *
 * The cockpit is meant to be open in more than one window — a desktop shell and
 * a browser tab, two tabs, a laptop and a phone — and a session belongs to the
 * server, not to whoever opened it. That promise is only worth anything if every
 * client sees the same session: a broadcast that reaches one socket, a replay
 * that stops short of what the other already has, or a command that a reconnect
 * carries out twice all look fine from a single window.
 *
 * `recovery-test.ts` already proves a replayed command is answered the same way
 * *on one socket*; what is new here is the second client and the reconnect —
 * the ack memory is server-wide, and nothing checked that.
 *
 * Hermetic: a temporary `SEDANO_HOME`, a temporary PATH holding only the fake
 * Command Code CLI from `scripts/fixtures/`, a server of our own on a free port.
 * No vendor CLI, no subscription, no ssh.
 *
 *   bun scripts/ws-test.ts
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerMsg, SessionEvent } from '@shared'
import { freePort, installExitHandlers, runCleanups, startApi, tempHome } from './lib/harness.ts'

/* ------------------------------------------------------------------ */
/* A PATH with nothing real on it                                      */
/* ------------------------------------------------------------------ */

/**
 * The server is a child process, and a child's PATH is fixed when it is
 * spawned — `Bun.which` inside it answers from there. Setting `process.env.PATH`
 * in this file would leave the server resolving the operator's real `cmd`, so
 * the first pass only builds the sandbox and starts this test again inside it.
 */
if (!process.env.SEDANO_WS_SANDBOX) {
  const sandbox = mkdtempSync(join(tmpdir(), 'sedano-ws-'))
  const bin = join(sandbox, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'cmd'),
    `#!/bin/sh\nexec ${process.execPath} ${join(import.meta.dir, 'fixtures', 'fake-cmd.ts')} "$@"\n`,
  )
  chmodSync(join(bin, 'cmd'), 0o755)
  // The harness starts the server with `bun`, so bun itself has to be reachable
  // from the narrow PATH — as a link to this very runtime, not as whatever the
  // machine happens to have.
  symlinkSync(process.execPath, join(bin, 'bun'))
  const child = Bun.spawn([process.execPath, import.meta.path], {
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, SEDANO_WS_SANDBOX: sandbox },
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  const code = await child.exited
  rmSync(sandbox, { recursive: true, force: true })
  process.exit(code)
}

installExitHandlers()

const sandbox = process.env.SEDANO_WS_SANDBOX!
const failures: string[] = []
const passed: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) passed.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

function waitFor(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (predicate()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`))
      setTimeout(tick, 30)
    }
    tick()
  })
}

/* ------------------------------------------------------------------ */
/* A client, as the UI is one                                          */
/* ------------------------------------------------------------------ */

interface Client {
  name: string
  socket: WebSocket
  /** Every committed event this client was told about, live or replayed. */
  events: SessionEvent[]
  /** Only the ones that arrived as live `event` frames. */
  live: SessionEvent[]
  timelines: Array<{ sessionId: string; count: number; cursor?: number }>
  acks: Array<Extract<ServerMsg, { t: 'ack' }>>
  /** Receive order, used to prove a cold-start prompt precedes its ack. */
  order: string[]
  send: (msg: unknown) => void
  close: () => void
}

const { home, env } = tempHome('ws-test')
const port = freePort()
const api = await startApi(env, port)

async function connect(name: string): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/ws`)
  const client: Client = {
    name,
    socket,
    events: [],
    live: [],
    timelines: [],
    acks: [],
    order: [],
    send: (msg) => socket.send(JSON.stringify(msg)),
    close: () => socket.close(),
  }
  /**
   * Hold an event the way a real client does: keyed, not appended.
   *
   * An event is identified by `(session_id, id)` and the server broadcasts the
   * *same* event again whenever it learns more about it — a tool call moving
   * from queued to running to completed rewrites one row in place, keeping its
   * `seq`. A client that pushes every frame therefore ends up holding one entry
   * per revision, and comparing that count against a replay (which returns rows)
   * measures how chatty the harness was, not whether anything was lost. The real
   * store upserts by id (see `apps/ui/src/store.ts`, `case 'event'`), so this
   * does too — otherwise the test is checking a client nobody ships.
   */
  const absorb = (event: SessionEvent): void => {
    const index = client.events.findIndex((held) => held.sessionId === event.sessionId && held.id === event.id)
    if (index >= 0) client.events[index] = event
    else client.events.push(event)
  }
  socket.onmessage = (raw) => {
    const msg = JSON.parse(String(raw.data)) as ServerMsg
    if (msg.t === 'ack') {
      client.acks.push(msg)
      client.order.push(`ack:${msg.cid}`)
    }
    if (msg.t === 'timeline') {
      client.timelines.push({ sessionId: msg.sessionId, count: msg.events.length, cursor: msg.cursor })
      for (const event of msg.events) absorb(event)
    }
    if (msg.t === 'event') {
      absorb(msg.event)
      client.order.push(`event:${msg.event.ev.k}`)
      // `live` stays a log of every frame: "the departed client is told nothing
      // more" is a statement about frames sent, not about events known.
      client.live.push(msg.event)
    }
  }
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error(`${name} never connected`))
  })
  return client
}

const userTexts = (client: Client): string[] =>
  client.events.filter((event) => event.ev.k === 'user').map((event) => ('text' in event.ev ? event.ev.text : ''))

try {
  const alice = await connect('alice')
  const bob = await connect('bob')

  /* ---------------- one session, two clients ---------------- */

  const sessionId = crypto.randomUUID()
  alice.send({
    t: 'new_session',
    cid: 'cid-open',
    req: {
      id: sessionId,
      harness: 'commandcode',
      kind: 'agent',
      cwd: sandbox,
      prompt: 'hello from alice',
    },
  })
  await waitFor(() => alice.acks.some((ack) => ack.cid === 'cid-open'), 'the session to open')
  check('the session opens', alice.acks[0]?.ok === true, alice.acks[0])
  check(
    'a cold-start prompt is visible before its launch is acknowledged',
    alice.order.indexOf('event:user') >= 0 && alice.order.indexOf('event:user') < alice.order.indexOf('ack:cid-open'),
    alice.order,
  )

  // Bob was not the one who opened it: he subscribes, as a second window does.
  bob.send({ t: 'subscribe', sessionId })
  await waitFor(() => bob.timelines.some((line) => line.sessionId === sessionId), 'bob to get the timeline')
  check('a second client can subscribe to a session it did not open', true)

  await waitFor(() => userTexts(bob).includes('hello from alice'), "bob to see alice's prompt")
  check('a prompt one client sends reaches the other', userTexts(bob).includes('hello from alice'))

  await waitFor(
    () => alice.events.some((event) => event.ev.k === 'result') && bob.events.some((event) => event.ev.k === 'result'),
    'the turn to finish for both clients',
  )
  // The same facts, in the same order, with the same identity: two clients that
  // disagree about the sequence are two different transcripts on screen.
  const seqs = (client: Client): string => client.events.map((event) => `${event.seq}:${event.ev.k}`).join(',')
  check('both clients hold the same events, in the same order', seqs(alice) === seqs(bob), {
    alice: seqs(alice),
    bob: seqs(bob),
  })

  /* ---------------- one client leaves, the other works ---------------- */

  const bobSawBefore = bob.events.length
  bob.close()
  await Bun.sleep(200)

  alice.send({ t: 'input', cid: 'cid-second', sessionId, text: 'alice carries on' })
  await waitFor(() => userTexts(alice).includes('alice carries on'), 'the second prompt to land')
  await waitFor(
    () => alice.events.filter((event) => event.ev.k === 'result').length === 2,
    'the second turn to finish',
  )
  check('a client dropping does not stop the session', true)
  check('and the departed client is told nothing more', bob.events.length === bobSawBefore, {
    before: bobSawBefore,
    after: bob.events.length,
  })

  /* ---------------- and comes back ---------------- */

  const back = await connect('bob-again')
  back.send({ t: 'subscribe', sessionId })
  await waitFor(() => back.timelines.some((line) => line.sessionId === sessionId), 'the replay to arrive')
  const replay = back.timelines.find((line) => line.sessionId === sessionId)!
  check('a reconnecting client is given the whole session, not the tail', back.events.length === alice.events.length, {
    replayed: back.events.length,
    live: alice.events.length,
  })
  check('the replay carries what it missed', userTexts(back).includes('alice carries on'), userTexts(back))
  check(
    'the replay names how far it reaches',
    replay.cursor === Math.max(...back.events.map((event) => event.seq)),
    { cursor: replay.cursor },
  )
  const ids = back.events.map((event) => event.id)
  check('and it replays nothing twice', new Set(ids).size === ids.length, ids.length - new Set(ids).size)

  /* ---------------- a command replayed on the new socket ---------------- */

  // What a reconnecting client does: it replays every command it never saw an
  // answer to. The answer here was delivered, but the client cannot know that,
  // and the second prompt must not be sent a second time.
  const before = userTexts(alice).filter((text) => text === 'alice carries on').length
  back.send({ t: 'input', cid: 'cid-second', sessionId, text: 'alice carries on' })
  await waitFor(() => back.acks.some((ack) => ack.cid === 'cid-second'), 'the replay to be answered')
  check('a command replayed on a new socket is answered, not refused', back.acks.at(-1)?.ok === true, back.acks.at(-1))
  await Bun.sleep(600)
  const after = userTexts(alice).filter((text) => text === 'alice carries on').length
  check('and it is not carried out a second time', after === before, { before, after })

  /* ---------------- a session everyone left ---------------- */

  alice.send({ t: 'unsubscribe', sessionId })
  back.send({ t: 'delete_session', cid: 'cid-delete', sessionId })
  await waitFor(() => back.acks.some((ack) => ack.cid === 'cid-delete'), 'the delete to be acknowledged')
  check('a client that did not open the session can still close it', back.acks.at(-1)?.ok === true, back.acks.at(-1))

  alice.close()
  back.close()
} finally {
  await api.stop()
  await runCleanups()
}

void home

if (failures.length) {
  console.log('--- failed checks ---')
  for (const failure of failures) console.log(`✗ ${failure}`)
  console.log(`\nws-test: ${failures.length} FAILURES (${passed.length} passed)`)
  process.exit(1)
}
console.log(`ws-test: PASSED (${passed.length} checks)`)
process.exit(0)
