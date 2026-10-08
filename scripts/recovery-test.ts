#!/usr/bin/env bun
/**
 * Recovery: questions that cannot be answered twice, commands that are answered
 * by id, and images that have an owner.
 *
 * Everything here is hermetic. A temporary `SEDANO_HOME` holds the store, a
 * temporary PATH holds a fake ACP agent built from `scripts/fixtures/`, and no
 * vendor CLI, no subscription and no ssh host is involved. The real store in
 * `~/.sedano` is never opened, and no real account is ever spoken to.
 *
 * The failures it pins down, each of which happened:
 *   - a question pending when the app went down came back as a card that looked
 *     clickable, wired to a continuation that no longer existed: clicking it did
 *     nothing at all, silently;
 *   - a stop left the same card live forever, because nothing wrote the fact
 *     that the question had been closed;
 *   - two clients could answer the same question, and the second answer went
 *     into a continuation that had already been resolved;
 *   - a mutating command had no answer of any kind, so a prompt the server
 *     dropped and a prompt it carried out looked identical from the client;
 *   - a command replayed after a reconnect was carried out a second time;
 *   - an image pasted and then removed stayed on disk forever, and deleting a
 *     session left every image it carried behind with nothing able to name it.
 *
 *   bun scripts/recovery-test.ts
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const failures: string[] = []
const passed: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) passed.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

/* ------------------------------------------------------------------ */
/* A machine of our own: temp home, temp PATH, a fake agent            */
/* ------------------------------------------------------------------ */

/**
 * The fake agent has to be on the PATH this process was *started* with:
 * `Bun.which` answers from the environment the process was launched in, not
 * from later edits to `process.env`, so a harness looked up through the real
 * PATH would be the user's real CLI — real quota, real account. The first run
 * only builds the sandbox and starts the test again inside it.
 */
if (!process.env.SEDANO_RECOVERY_SANDBOX) {
  const home = mkdtempSync(join(tmpdir(), 'sedano-recovery-home-'))
  const work = mkdtempSync(join(tmpdir(), 'sedano-recovery-work-'))
  const bin = join(work, 'bin')
  mkdirSync(bin)
  const fakeAcp = join(import.meta.dir, 'fixtures', 'fake-acp-agent.ts')
  writeFileSync(join(bin, 'opencode'), `#!/bin/sh\nexec ${process.execPath} ${fakeAcp} "$@"\n`)
  chmodSync(join(bin, 'opencode'), 0o755)
  // The server is started as a child process by name, so `bun` has to be
  // reachable from the sandbox — as a shim, not by putting its install
  // directory on the PATH, which is exactly where a real vendor CLI would be.
  writeFileSync(join(bin, 'bun'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`)
  chmodSync(join(bin, 'bun'), 0o755)

  const child = Bun.spawn([process.execPath, import.meta.path], {
    // Only our own binaries and the base system tools: a real `opencode`,
    // `claude` or `cmd` installed on this machine is not reachable from here.
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      SEDANO_HOME: home,
      SEDANO_RECOVERY_SANDBOX: work,
    },
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  const code = await child.exited
  rmSync(home, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
  process.exit(code)
}

const work = process.env.SEDANO_RECOVERY_SANDBOX
const home = process.env.SEDANO_HOME!

const { addClient } = await import('../apps/server/src/bus.ts')
const manager = await import('../apps/server/src/manager.ts')
const db = await import('../apps/server/src/db.ts')
const attachments = await import('../apps/server/src/attachments.ts')
const { freePort, onCleanup, runCleanups, startApi } = await import('./lib/harness.ts')
import type { Ack, ServerMsg, SessionEvent } from '@shared'

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

/** Every event the manager broadcast to a subscriber, per session. */
const seen = new Map<string, SessionEvent[]>()
const watcher = {
  id: 'recovery-test',
  subscribed: new Set<string>(),
  send: (msg: ServerMsg) => {
    if (msg.t !== 'event') return
    const list = seen.get(msg.sessionId) ?? []
    list.push(msg.event)
    seen.set(msg.sessionId, list)
  },
}
addClient(watcher)

const resultsFor = (sessionId: string, toolId: string): string[] =>
  db
    .loadEvents(sessionId)
    .filter((event) => event.ev.k === 'tool_result' && event.ev.toolId === toolId)
    .map((event) => (event.ev.k === 'tool_result' ? event.ev.text : ''))

/* ------------------------------------------------------------------ */
/* 3 — a question pending at restart expires, and says so             */
/* ------------------------------------------------------------------ */

/**
 * The fixture is a database as a crash leaves it: a session, an
 * `AskUserQuestion` with no result under it, and a request row still pending.
 * Nothing here has a process behind it, which is the whole point.
 */
{
  const id = 'restored-session'
  const now = Date.now()
  db.upsertSession({
    id,
    harness: 'opencode',
    kind: 'agent',
    title: 'a question nobody answered',
    cwd: work,
    host: null,
    model: 'fake-model-1',
    status: 'running',
    createdAt: now,
    updatedAt: now,
    nativeId: null,
    transcriptPath: null,
    resumeHint: null,
    permissionMode: 'acceptEdits',
    effort: null,
    gitBranch: null,
    pinned: 0,
    started: true,
  })
  const turnId = 'turn-interrupted-by-restart'
  db.insertEvent({ id: 'u1', sessionId: id, seq: 1, at: now, turnId, ev: { k: 'user', text: 'do the thing' } })
  db.insertEvent({
    id: 'q1',
    sessionId: id,
    seq: 2,
    at: now + 8500,
    turnId,
    ev: {
      k: 'tool',
      toolId: 'call-permission',
      name: 'AskUserQuestion',
      input: { questions: [{ question: 'May I?', options: [{ id: 'allow', label: 'Allow' }] }] },
      summary: 'May I?',
    },
  })
  db.openRequest(id, 'call-permission', null, now)

  manager.restore()

  const recovered = db
    .loadEvents(id)
    .find((event) => event.turnId === turnId && event.ev.k === 'result')
  check('a non-durable turn interrupted by restart gets a result boundary', recovered?.ev.k === 'result', recovered)
  check(
    'the recovered result keeps the real persisted duration',
    recovered?.ev.k === 'result' && recovered.ev.durationMs === 8500,
    recovered?.ev,
  )
  check(
    'the recovered result explains why no final answer arrived',
    recovered?.ev.k === 'result' && recovered.ev.subtype === 'server_restart',
    recovered?.ev,
  )

  const row = db.getRequest(id, 'call-permission')
  check('a question pending at restart is expired', row?.state === 'expired', row)
  check(
    'the expiry is written into the transcript, so a replay shows the card closed',
    resultsFor(id, 'call-permission').length === 1,
    resultsFor(id, 'call-permission'),
  )
  check(
    'and it says why it was never answered',
    /sedano restarted/.test(resultsFor(id, 'call-permission')[0] ?? ''),
    resultsFor(id, 'call-permission'),
  )

  /* 4 — an answer the server cannot take is refused, not swallowed */
  const late = manager.answerQuestion(id, 'call-permission', 'allow')
  check('answering an expired question is refused', !late.ok, late)
  check('and the refusal says it is not pending', !late.ok && late.code === 'not_pending', late)

  const unknown = manager.answerQuestion(id, 'no-such-tool', 'allow')
  check('answering a question the server never saw is refused', !unknown.ok, unknown)
  check('and that refusal is not pending either', !unknown.ok && unknown.code === 'not_pending', unknown)

  const nowhere = manager.answerQuestion('no-such-session', 'call-permission', 'allow')
  check('answering into a session that is gone says so', !nowhere.ok && nowhere.code === 'gone', nowhere)

  // A second restart must not stack a second closing line on the same card.
  manager.restore()
  check(
    'a second restart adds nothing: the request is already closed',
    resultsFor(id, 'call-permission').length === 1,
    resultsFor(id, 'call-permission'),
  )
  manager.removeSession(id)
}

/* ------------------------------------------------------------------ */
/* 9 — two clients, one answer                                        */
/* ------------------------------------------------------------------ */

{
  const session = await manager.createSession({ harness: 'opencode', kind: 'agent', cwd: work, permissionMode: 'manual' })
  watcher.subscribed.add(session.id)
  void manager.sendMessage(session.id, 'ask me before you touch anything')
  await waitFor(() => db.pendingRequests(session.id).length > 0, 'the agent to ask for permission')
  const toolId = db.pendingRequests(session.id)[0]!.toolId

  const first = manager.answerQuestion(session.id, toolId, 'allow-once')
  check('the first answer is accepted', first.ok, first)
  check('the request is answered the moment it is taken', db.getRequest(session.id, toolId)?.state === 'answered')

  const second = manager.answerQuestion(session.id, toolId, 'reject')
  check('a second client answering the same question is refused', !second.ok, second)
  check('and is told the question was already answered', !second.ok && second.code === 'not_pending', second)

  // The other client learns about it the same way it learns everything: the
  // native request is rewritten in place and broadcast to every subscriber.
  await waitFor(
    () => (seen.get(session.id) ?? []).some(
      (e) => e.ev.k === 'request' && e.ev.requestId === toolId && e.ev.state === 'answered',
    ),
    'the answer to reach the other client',
  )
  check('the other client sees the question close', true)
  manager.removeSession(session.id)
  watcher.subscribed.delete(session.id)
}

/* ------------------------------------------------------------------ */
/* The readout says where its numbers came from                       */
/* ------------------------------------------------------------------ */

/**
 * A window the agent reported is not the same thing as one inferred from the
 * model name, and the ring is drawn differently for each. The fake agent reports
 * both a size and a cost, so this pins the "reported" side of that distinction —
 * and that a cost is believed because it was given, not because it was non-zero.
 */
{
  const session = await manager.createSession({ harness: 'opencode', kind: 'agent', cwd: work, permissionMode: 'manual' })
  await manager.sendMessage(session.id, 'just answer')
  await waitFor(() => (manager.getSession(session.id)?.metrics.contextWindow ?? 0) > 0, 'the agent to report its usage')
  const metrics = manager.getSession(session.id)!.metrics
  check('a reported window counts as reported', metrics.contextReported === true, metrics)
  check('and is not marked as inferred', metrics.contextWindowInferred === false, metrics)
  check('a reported cost counts as reported', metrics.costReported === true, metrics)
  manager.removeSession(session.id)
}

/* ------------------------------------------------------------------ */
/* 5 (server half) — a stop closes what is waiting                    */
/* ------------------------------------------------------------------ */

/**
 * The driver half of this — the agent being told `cancelled` — is the ACP and
 * Claude change that is not in this tranche. What is checked here is the record
 * the server owns: after a stop, nothing is pending and the transcript says so,
 * which is what makes the card dead after a fresh load.
 */
{
  const session = await manager.createSession({ harness: 'opencode', kind: 'agent', cwd: work, permissionMode: 'manual' })
  void manager.sendMessage(session.id, 'ask me before you touch anything')
  await waitFor(() => db.pendingRequests(session.id).length > 0, 'the agent to ask for permission')
  const toolId = db.pendingRequests(session.id)[0]!.toolId

  manager.stopSession(session.id)
  check('a stop leaves nothing pending', db.pendingRequests(session.id).length === 0)
  check('the stopped request is cancelled', db.getRequest(session.id, toolId)?.state === 'cancelled')
  check(
    'a freshly loaded transcript shows the question closed',
    db.loadEvents(session.id).some(
      (event) =>
        event.ev.k === 'request'
        && event.ev.requestId === toolId
        && event.ev.state === 'cancelled'
        && /the session was stopped/.test(event.ev.closedReason ?? ''),
    ),
    db.loadEvents(session.id).filter((event) => event.ev.k === 'request' && event.ev.requestId === toolId),
  )
  const afterStop = manager.answerQuestion(session.id, toolId, 'allow-once')
  check('the card is dead: an answer after the stop is refused', !afterStop.ok && afterStop.code === 'not_pending', afterStop)
  manager.removeSession(session.id)
}

/* ------------------------------------------------------------------ */
/* 8 — an attachment has an owner, and can be taken back              */
/* ------------------------------------------------------------------ */

/** A 1×1 PNG, as bytes: the smallest thing a paste can produce. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)
const attachmentFile = (id: string): string => join(home, 'attachments', `${id}.png`)

{
  /* upload → delete */
  const saved = attachments.saveAttachment(new Uint8Array(PNG), 'image/png', 'paste.png')
  check('an upload is recorded, unbound', db.getAttachment(saved.id)?.sessionId === null, db.getAttachment(saved.id))
  check('and its bytes are on disk', existsSync(attachmentFile(saved.id)))
  check('an unsent upload can be taken back', attachments.deleteAttachment(saved.id) === null)
  check('the row goes with it', db.getAttachment(saved.id) === null)
  check('and so do the bytes', !existsSync(attachmentFile(saved.id)))
  check('deleting it again says it is gone', attachments.deleteAttachment(saved.id) === 'gone')
}

{
  /**
   * upload → sent → a restart → the session is deleted.
   *
   * The message is written the way `emit` writes one that carries an image: the
   * `user` event holds the reference and the upload is bound to it. Going
   * through a harness would only decide *which* harness this is a test of — the
   * fake agent declares it cannot read images, which is a different path and is
   * checked below — and the ownership is the same either way.
   */
  const id = 'session-with-an-image'
  const now = Date.now()
  const saved = attachments.saveAttachment(new Uint8Array(PNG), 'image/png', 'sent.png')
  db.upsertSession({
    id,
    harness: 'opencode',
    kind: 'agent',
    title: 'look at this',
    cwd: work,
    host: null,
    model: 'fake-model-1',
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    nativeId: null,
    transcriptPath: null,
    resumeHint: null,
    permissionMode: 'manual',
    effort: null,
    gitBranch: null,
    pinned: 0,
    started: true,
  })
  db.insertEvent({
    id: 'm1',
    sessionId: id,
    seq: 1,
    at: now,
    ev: {
      k: 'user',
      text: 'look at this',
      attachments: [{ id: saved.id, name: saved.name, mediaType: saved.mediaType }],
    },
  })
  db.bindAttachments([saved.id], id, 'm1')
  check('a sent image belongs to its session', db.getAttachment(saved.id)?.sessionId === id, db.getAttachment(saved.id))
  check('a sent image cannot be taken back', attachments.deleteAttachment(saved.id) === 'sent')

  // A restart, as far as the store is concerned: the rows are all there is.
  manager.restore()
  const carried = db
    .loadEvents(id)
    .some((event) => event.ev.k === 'user' && event.ev.attachments?.some((item) => item.id === saved.id))
  check('the transcript still references it after a restart', carried)
  check('and the bytes are still there to be served', Boolean(attachments.readAttachment(saved.id)))

  manager.removeSession(id)
  check('deleting the session takes its images with it', db.getAttachment(saved.id) === null)
  check('including the bytes', !existsSync(attachmentFile(saved.id)))
}

{
  /* upload → a harness that cannot read images → dropped, not orphaned */
  const session = await manager.createSession({ harness: 'opencode', kind: 'agent', cwd: work, permissionMode: 'manual' })
  const saved = attachments.saveAttachment(new Uint8Array(PNG), 'image/png', 'refused.png')
  const sent = await manager.sendMessage(session.id, 'look at this', [
    { id: saved.id, name: saved.name, mediaType: saved.mediaType },
  ])
  check('the message itself still goes', sent.ok, sent)
  check('an image the harness cannot read is not left on disk', !existsSync(attachmentFile(saved.id)))
  check('and leaves no row behind either', db.getAttachment(saved.id) === null)
  manager.removeSession(session.id)
}

{
  /* a text document → inline in the prompt the harness gets, a chip in the transcript */
  const session = await manager.createSession({ harness: 'opencode', kind: 'agent', cwd: work, permissionMode: 'manual' })
  const saved = attachments.saveAttachment(new TextEncoder().encode('alpha line\nbeta line'), 'text/plain; charset=utf-8', 'notes.md')
  check('a document upload reports its line count', saved.lines === 2 && saved.preview === 'alpha line\nbeta line', saved)
  const ref = { id: saved.id, name: saved.name, mediaType: saved.mediaType, lines: saved.lines, preview: saved.preview }
  const sent = await manager.sendMessage(session.id, 'echo-prompt please', [ref])
  check('a message with a document is sent, even to a harness that takes no images', sent.ok, sent)
  const echoed = (): string =>
    db.loadEvents(session.id).map((event) => (event.ev.k === 'assistant' ? event.ev.text : '')).find((text) => text.includes('echo:')) ?? ''
  await waitFor(() => Boolean(echoed()), 'the fake agent to echo its prompt').catch(() => undefined)
  check(
    'the harness is handed the document inline, under its name',
    echoed().includes('echo-prompt please') && echoed().includes('<attached_file name="notes.md">') && echoed().includes('alpha line\nbeta line'),
    echoed(),
  )
  const user = db.loadEvents(session.id).find((event) => event.ev.k === 'user')
  check(
    'the stored message keeps the typed words and the document as an attachment',
    user?.ev.k === 'user' && user.ev.text === 'echo-prompt please' && user.ev.attachments?.[0]?.id === saved.id,
    user?.ev,
  )
  check('a sent document belongs to its session', db.getAttachment(saved.id)?.sessionId === session.id, db.getAttachment(saved.id))
  check('a sent document cannot be taken back', attachments.deleteAttachment(saved.id) === 'sent')
  manager.removeSession(session.id)
  check('deleting the session takes its documents with it', db.getAttachment(saved.id) === null && !attachments.readAttachment(saved.id))
}

{
  /* a non-UTF-8 "document" is refused at upload */
  let refused = false
  try {
    attachments.saveAttachment(new Uint8Array([0xff, 0xfe, 0x00, 0xd8]), 'text/plain', 'binary.txt')
  } catch {
    refused = true
  }
  check('a document that is not UTF-8 text is refused', refused)
}

{
  /* upload → never sent → swept */
  const saved = attachments.saveAttachment(new Uint8Array(PNG), 'image/png', 'abandoned.png')
  check('a fresh upload is not swept', attachments.sweepAttachments() === 0)
  check('and is still there', existsSync(attachmentFile(saved.id)))
  // A day later, from the sweeper's point of view.
  const swept = attachments.sweepAttachments(Date.now() + 25 * 60 * 60 * 1000)
  check('an upload nobody ever sent is swept', swept === 1, swept)
  check('the abandoned bytes are gone', !existsSync(attachmentFile(saved.id)))
}

/* ------------------------------------------------------------------ */
/* 1 (server half) — the commands are answered by id, over a socket   */
/* ------------------------------------------------------------------ */

/**
 * A real server on its own port, against its own store, driven over a real
 * websocket: the ack is a fact about the wire, and testing it anywhere else
 * would be testing something else.
 */
{
  const socketHome = join(work, 'socket-home')
  mkdirSync(socketHome, { recursive: true })
  const api = await startApi({ SEDANO_HOME: socketHome }, freePort())
  onCleanup(() => api.stop())

  const socket = new WebSocket(`ws://127.0.0.1:${api.port}/api/ws`)
  const acks: Ack[] = []
  const timelines: Array<{ sessionId: string; cursor?: number }> = []
  socket.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as ServerMsg
    if (msg.t === 'ack') acks.push(msg)
    if (msg.t === 'timeline') timelines.push({ sessionId: msg.sessionId, cursor: msg.cursor })
  }
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error('the websocket never opened'))
  })
  const say = (msg: unknown): void => socket.send(JSON.stringify(msg))
  const ackFor = (cid: string): Ack | undefined => acks.find((ack) => ack.cid === cid)

  const sessionId = crypto.randomUUID()
  say({
    t: 'new_session',
    cid: 'cid-create',
    req: { id: sessionId, harness: 'opencode', kind: 'agent', cwd: work },
  })
  await waitFor(() => Boolean(ackFor('cid-create')), 'the launch to be acknowledged')
  check('a launch is acknowledged', ackFor('cid-create')?.ok === true, ackFor('cid-create'))
  check('and the ack names the session it made', ackFor('cid-create')?.sessionId === sessionId)
  check('the timeline carries a replay cursor', timelines.some((item) => item.sessionId === sessionId && item.cursor === 0), timelines)

  // The same command again, as a reconnect replays it: answered as before, and
  // not carried out a second time.
  say({
    t: 'new_session',
    cid: 'cid-create',
    req: { id: sessionId, harness: 'opencode', kind: 'agent', cwd: work },
  })
  await waitFor(() => acks.filter((ack) => ack.cid === 'cid-create').length === 2, 'the replay to be answered')
  const [firstAck, repeatAck] = acks.filter((ack) => ack.cid === 'cid-create')
  check('a replayed command is answered the same way', JSON.stringify(firstAck) === JSON.stringify(repeatAck), [firstAck, repeatAck])

  say({ t: 'answer_question', cid: 'cid-answer', sessionId, toolId: 'nothing-is-waiting', optionId: 'allow' })
  await waitFor(() => Boolean(ackFor('cid-answer')), 'the answer to be refused')
  check('an answer nobody is waiting for is refused', ackFor('cid-answer')?.ok === false, ackFor('cid-answer'))
  check('and the refusal names the reason', ackFor('cid-answer')?.error === 'not_pending', ackFor('cid-answer'))

  say({ t: 'input', cid: 'cid-gone', sessionId: 'no-such-session', text: 'hello?' })
  await waitFor(() => Boolean(ackFor('cid-gone')), 'the prompt to be refused')
  check('a prompt into a session that does not exist is refused', ackFor('cid-gone')?.ok === false, ackFor('cid-gone'))
  check('and says the session is gone', ackFor('cid-gone')?.error === 'gone', ackFor('cid-gone'))

  say({ t: 'stop', cid: 'cid-stop', sessionId })
  await waitFor(() => Boolean(ackFor('cid-stop')), 'the stop to be acknowledged')
  check('a stop is acknowledged', ackFor('cid-stop')?.ok === true, ackFor('cid-stop'))

  say({ t: 'delete_session', cid: 'cid-delete', sessionId })
  await waitFor(() => Boolean(ackFor('cid-delete')), 'the delete to be acknowledged')
  check('a delete is acknowledged', ackFor('cid-delete')?.ok === true, ackFor('cid-delete'))

  socket.close()
  await api.stop()
}

/* ------------------------------------------------------------------ */

for (const session of manager.listSessions()) manager.removeSession(session.id)
await runCleanups()

if (failures.length) {
  console.log('--- failed checks ---')
  for (const failure of failures) console.log(`✗ ${failure}`)
  console.log(`\nrecovery-test: ${failures.length} FAILURES (${passed.length} passed)`)
  process.exit(1)
}
console.log(`recovery-test: PASSED (${passed.length} checks)`)
process.exit(0)
