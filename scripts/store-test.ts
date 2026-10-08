#!/usr/bin/env bun
/**
 * The client store, against a socket it cannot tell from a real one.
 *
 * Nothing here talks to a server, a harness or a browser: the store is driven
 * through the very messages the server sends and the very socket it sends them
 * on, so what is exercised is the real `handle`, the real `send` and the real
 * queue — not a copy of them written for the test.
 *
 * The failures it pins down, each of which happened:
 *   - a socket that dropped mid-stream left half a turn in the streaming buffer;
 *     the reconnect brought the finished turn back, and the leftover was drawn a
 *     second time, under whatever turn came next, and never went away;
 *   - a burst of keystrokes queued while the server was down pushed the
 *     `new_session` of a launch out of the queue from the head, so every command
 *     that followed named a session the server had never heard of, and the tab
 *     sat on "launching" forever;
 *   - a reload while the server was down threw the whole queue away in silence.
 *
 *   bun scripts/store-test.ts
 */
import type { ClientMsg, SessionEvent } from '@shared'
import { buildRows, buildTurns, isGroup } from '../apps/ui/src/view.ts'

const failures: string[] = []
const passed: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) passed.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

/* ------------------------------------------------------------------ */
/* A browser, as far as the store is concerned                         */
/* ------------------------------------------------------------------ */

const storage = new Map<string, string>()
const fakeStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => void storage.set(key, value),
  removeItem: (key: string) => void storage.delete(key),
  clear: () => storage.clear(),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() {
    return storage.size
  },
}

type Handler = ((event: { data: string }) => void) | null

/** The socket the store thinks it has: every frame it writes is kept here. */
class FakeSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static last: FakeSocket | null = null

  readyState = FakeSocket.CONNECTING
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: Handler = null

  constructor(readonly url: string) {
    FakeSocket.last = this
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED
    this.onclose?.()
  }

  /** The server connecting, and then speaking. */
  open(): void {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }

  deliver(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) })
  }

  frames(): ClientMsg[] {
    return this.sent.map((raw) => JSON.parse(raw) as ClientMsg)
  }
}

const globals = globalThis as unknown as Record<string, unknown>
globals.localStorage = fakeStorage
globals.window = { location: { protocol: 'http:', host: 'localhost:7788' } }
globals.location = { protocol: 'http:', host: 'localhost:7788' }
globals.WebSocket = FakeSocket

/* A queue written by the page that was open before this one reloaded. */
const now = Date.now()
storage.set(
  'sedano.outbox',
  JSON.stringify([
    { msg: { t: 'input', sessionId: 'restored', text: 'survived a reload', cid: 'cid-restored' }, at: now },
    { msg: { t: 'input', sessionId: 'restored', text: 'far too old to mean anything', cid: 'cid-stale' }, at: now - 40 * 60 * 1000 },
    { msg: { t: 'term_input', sessionId: 'restored', data: 'x' }, at: now },
  ]),
)

const store = await import('../apps/ui/src/store.ts')

/* ------------------------------------------------------------------ */
/* 6b — the queue survives a reload                                    */
/* ------------------------------------------------------------------ */

store.connect()
let socket = FakeSocket.last!
socket.open()

/** The socket drops and the client comes back, as a flaky network does it. */
function reconnect(): void {
  socket.close()
  store.connect()
  socket = FakeSocket.last!
  socket.open()
}

{
  const replayed = socket.frames().filter((msg) => msg.t === 'input')
  check('a command queued before the reload is still sent', replayed.some((msg) => msg.t === 'input' && msg.text === 'survived a reload'), replayed)
  check(
    'a command too old to mean anything is not replayed',
    !replayed.some((msg) => msg.t === 'input' && msg.text.startsWith('far too old')),
    replayed,
  )
  check(
    'a keystroke is not carried across a reload',
    !socket.frames().some((msg) => msg.t === 'term_input'),
    socket.frames(),
  )
  check('the replayed command kept its id, so the server can recognise it', replayed.some((msg) => msg.cid === 'cid-restored'), replayed)
}

/* ------------------------------------------------------------------ */
/* 1 — the timeline is the truth, and the buffer yields to it          */
/* ------------------------------------------------------------------ */

const SESSION = 'session-under-test'
const KEY = `${SESSION}:main`
const TURN_A = 'turn-a'
const TURN_B = 'turn-b'

function userEvent(id: string, seq: number, turnId: string, text: string): SessionEvent {
  return { id, sessionId: SESSION, seq, at: seq, turnId, ev: { k: 'user', text } }
}

{
  socket.deliver({ t: 'delta', sessionId: SESSION, key: 'k1', kind: 'text', text: 'narrating…', turnId: TURN_A })
  check('a streamed chunk lands in the buffer', store.getState().live[KEY]?.text === 'narrating…', store.getState().live)
  check('and the buffer knows which turn it is', store.getState().live[KEY]?.turnId === TURN_A, store.getState().live)

  // The socket dies mid-stream — after the narration, before the event that
  // would have cleared the buffer — and the client comes back to a turn that
  // finished while it was away.
  reconnect()
  socket.deliver({
    t: 'timeline',
    sessionId: SESSION,
    cursor: 2,
    events: [
      userEvent('u1', 1, TURN_A, 'do the thing'),
      { id: 'a1', sessionId: SESSION, seq: 2, at: 2, turnId: TURN_A, ev: { k: 'assistant', text: 'narrating… and done' } },
    ],
  })
  check('the replay clears the buffer it replaced', store.getState().live[KEY] === undefined, store.getState().live)
  check('and the timeline is what the session now holds', store.getState().events[SESSION]?.length === 2)

  // The whole point, said the way the screen says it: the answer is in the
  // rebuilt turn exactly once, and the buffer has nothing left to add to it.
  const turns = buildTurns(buildRows(store.getState().events[SESSION] ?? []))
  const answers = turns
    .flatMap((turn) => turn.rows)
    .filter((row) => !isGroup(row) && row.ev.k === 'assistant')
  check('the finished answer appears exactly once', answers.length === 1, answers.length)

  // The next turn starts: nothing of the previous one may be shown under it.
  socket.deliver({ t: 'event', sessionId: SESSION, event: userEvent('u2', 3, TURN_B, 'and now this') })
  check('a new turn starts with no leftover buffer', store.getState().live[KEY] === undefined, store.getState().live)

  // A replay can be older than a live frame already received by this client:
  // its cursor is the boundary of its authority, not permission to erase the
  // newer tail. This is the race the cursor exists to close.
  socket.deliver({
    t: 'timeline',
    sessionId: SESSION,
    cursor: 2,
    events: [
      userEvent('u1', 1, TURN_A, 'do the thing'),
      { id: 'a1', sessionId: SESSION, seq: 2, at: 2, turnId: TURN_A, ev: { k: 'assistant', text: 'narrating… and done' } },
    ],
  })
  check(
    'a timeline snapshot keeps live events beyond its cursor',
    store.getState().events[SESSION]?.some((event) => event.id === 'u2') === true,
    store.getState().events[SESSION],
  )
}

{
  /* A chunk of a different turn never continues the buffer of the one before. */
  socket.deliver({ t: 'delta', sessionId: SESSION, key: 'k2', kind: 'text', text: 'first turn text', turnId: TURN_A })
  socket.deliver({ t: 'delta', sessionId: SESSION, key: 'k3', kind: 'text', text: 'second turn text', turnId: TURN_B })
  check('the buffer of a new turn does not inherit the old one', store.getState().live[KEY]?.text === 'second turn text', store.getState().live)
}

{
  /* A session that stops has nothing left to stream. */
  socket.deliver({ t: 'delta', sessionId: SESSION, key: 'k4', kind: 'text', text: 'half a sentence', turnId: TURN_B })
  // Same turn as the chunk before it, so this one continues that buffer.
  check('the buffer is there while it runs', store.getState().live[KEY]?.text.endsWith('half a sentence') === true, store.getState().live)
  socket.deliver({
    t: 'session',
    session: {
      id: SESSION,
      harness: 'opencode',
      kind: 'agent',
      title: 'under test',
      preset: null,
      cwd: '/tmp',
      host: null,
      model: null,
      status: 'stopped',
      createdAt: 1,
      updatedAt: 2,
      nativeId: null,
      transcriptPath: null,
      resumeHint: null,
      permissionMode: 'manual',
      effort: null,
      gitBranch: null,
      pinned: false,
      started: true,
      metrics: { tokensIn: 0, tokensOut: 0, tokensTotal: 0, contextUsed: 0, contextWindow: 0, costUsd: 0, durationMs: 0, chars: 0, toolCalls: 0, contextReported: false, costReported: false },
    },
  })
  check('a session that is no longer working drops its buffer', store.getState().live[KEY] === undefined, store.getState().live)
}

/* ------------------------------------------------------------------ */
/* 8 (client half) — a removed session is forgotten, not just hidden   */
/* ------------------------------------------------------------------ */

{
  socket.deliver({ t: 'delta', sessionId: SESSION, key: 'k5', kind: 'text', text: 'still going', turnId: TURN_B })
  socket.deliver({ t: 'session_removed', id: SESSION })
  check('a removed session leaves no transcript behind', store.getState().events[SESSION] === undefined)
  check('and no streaming buffer behind', store.getState().live[KEY] === undefined, store.getState().live)
}

/* ------------------------------------------------------------------ */
/* 6a — a full queue drops keystrokes, never a launch                  */
/* ------------------------------------------------------------------ */

const LAUNCHED = 'launched-session'

{
  socket.close()
  store.createSession({ id: LAUNCHED, harness: 'opencode', kind: 'agent', cwd: '/tmp', prompt: 'the first thing' })
  for (let index = 0; index < 500; index += 1) store.sendTermInput('a-terminal', String(index % 10))
  store.sendMessage(LAUNCHED, 'and then this')

  const queued = JSON.parse(storage.get('sedano.outbox') ?? '[]') as Array<{ msg: ClientMsg }>
  const launch = queued.find((entry) => entry.msg.t === 'new_session')
  check('the launch survives a burst of keystrokes', Boolean(launch), queued.map((entry) => entry.msg.t))
  check(
    'and so does the prompt that depends on it',
    queued.some((entry) => entry.msg.t === 'input' && entry.msg.sessionId === LAUNCHED),
    queued.map((entry) => entry.msg.t),
  )
  check(
    'the keystrokes are the ones that went',
    !queued.some((entry) => entry.msg.t === 'term_input'),
    queued.map((entry) => entry.msg.t),
  )
}

/* ------------------------------------------------------------------ */
/* 6c — a launch the server refused takes its dependants with it       */
/* ------------------------------------------------------------------ */

{
  const reconnected = new FakeSocket('ws://localhost/api/ws')
  // The store reconnects on its own timer; opening a fresh socket by hand is
  // the same path, without waiting out the backoff.
  store.connect()
  const live = FakeSocket.last === reconnected ? reconnected : FakeSocket.last!
  live.open()
  const launch = live.frames().find((msg) => msg.t === 'new_session')
  check('the queued launch goes out on reconnect', Boolean(launch), live.frames().map((msg) => msg.t))
  const cid = launch && 'cid' in launch ? launch.cid : undefined
  check('and it carries a command id', Boolean(cid), launch)

  live.deliver({ t: 'ack', cid, ok: false, error: 'rejected', detail: 'that host is not enabled' })
  const left = JSON.parse(storage.get('sedano.outbox') ?? '[]') as Array<{ msg: ClientMsg }>
  check(
    'a refused launch takes the prompts that named it with it',
    !left.some((entry) => 'sessionId' in entry.msg && entry.msg.sessionId === LAUNCHED),
    left.map((entry) => entry.msg),
  )
}

/* ------------------------------------------------------------------ */
/* 3 (client half) — a closed question is not a clickable one          */
/* ------------------------------------------------------------------ */

{
  const live = FakeSocket.last!
  const asked: SessionEvent = {
    id: 'q1',
    sessionId: 'question-session',
    seq: 1,
    at: 1,
    ev: { k: 'tool', toolId: 'ask-1', name: 'AskUserQuestion', input: {}, summary: 'May I?' },
  }
  live.deliver({ t: 'timeline', sessionId: 'question-session', cursor: 1, events: [asked] })
  check(
    'a question with no result is open to an answer',
    store.requestStateFor(store.getState(), 'question-session', 'ask-1') === 'pending',
  )

  live.deliver({
    t: 'event',
    sessionId: 'question-session',
    event: {
      id: 'r1',
      sessionId: 'question-session',
      seq: 2,
      at: 2,
      ev: { k: 'tool_result', toolId: 'ask-1', text: 'not answered — the session was stopped', isError: false, truncated: false },
    },
  })
  check(
    'a question the server closed is not open to one',
    store.requestStateFor(store.getState(), 'question-session', 'ask-1') === 'answered',
    store.getState().events['question-session'],
  )
}

/* ------------------------------------------------------------------ */
/* 4 — a native request carries its own live and terminal state        */
/* ------------------------------------------------------------------ */

{
  const live = FakeSocket.last!
  const pending: SessionEvent = {
    id: 'native-request-1',
    sessionId: 'question-session',
    seq: 3,
    at: 3,
    ev: {
      k: 'request',
      requestId: 'native-ask-1',
      kind: 'question',
      title: 'Which format?',
      options: [{ id: 'short', label: 'Short' }],
      state: 'pending',
    },
  }
  live.deliver({ t: 'event', sessionId: 'question-session', event: pending })
  check(
    'a native request is open from its own state',
    store.requestStateFor(store.getState(), 'question-session', 'native-ask-1') === 'pending',
  )
  live.deliver({
    t: 'event',
    sessionId: 'question-session',
    event: {
      ...pending,
      ev: { ...pending.ev, state: 'answered', answeredOptionId: 'short' },
    },
  })
  check(
    'the same native event becomes answered in place',
    store.requestStateFor(store.getState(), 'question-session', 'native-ask-1') === 'answered'
      && store.getState().events['question-session']?.filter((event) => event.id === pending.id).length === 1,
    store.getState().events['question-session'],
  )
}

/* ------------------------------------------------------------------ */
/* 5 (client half) — an answer is never "sent" before the ack          */
/* ------------------------------------------------------------------ */

{
  const live = FakeSocket.last!
  store.answerQuestion('a-session', 'a-question', 'allow')
  check('the card says sending, not sent', store.answerStateFor(store.getState(), 'a-session', 'a-question') === 'sending')
  const answer = live.frames().find((msg) => msg.t === 'answer_question')
  const cid = answer && 'cid' in answer ? answer.cid : undefined
  live.deliver({ t: 'ack', cid, ok: false, error: 'not_pending', detail: 'that question has already been answered' })
  check(
    'a refused answer leaves the card unanswered',
    store.answerStateFor(store.getState(), 'a-session', 'a-question') === null,
    store.getState().answers,
  )

  store.answerQuestion('a-session', 'another-question', 'allow')
  const second = live.frames().filter((msg) => msg.t === 'answer_question').at(-1)
  const secondCid = second && 'cid' in second ? second.cid : undefined
  live.deliver({ t: 'ack', cid: secondCid, ok: true })
  check(
    'an accepted answer is what marks the card answered',
    store.answerStateFor(store.getState(), 'a-session', 'another-question') === 'answered',
    store.getState().answers,
  )
}

{
  // An event rewritten in place keeps its first turn, as the server's store does.
  socket.deliver({ t: 'event', sessionId: SESSION, event: { id: 'again', sessionId: SESSION, seq: 40, at: 40, turnId: TURN_A, ev: { k: 'assistant', text: 'first' } } })
  socket.deliver({ t: 'event', sessionId: SESSION, event: { id: 'again', sessionId: SESSION, seq: 40, at: 99, turnId: TURN_B, ev: { k: 'assistant', text: 'rewritten' } } })
  const held = store.getState().events[SESSION]?.find((event) => event.id === 'again')
  check('a rewritten event keeps the turn it was filed under', held?.turnId === TURN_A && held.ev.k === 'assistant' && held.ev.text === 'rewritten', held)
}

{
  // Cancelling a queued prompt hands its text back to the composer — once the
  // server has said the cancel took, not on the click.
  const live = FakeSocket.last!
  live.deliver({ t: 'event', sessionId: 'queue-session', event: {
    id: 'queued-1', sessionId: 'queue-session', seq: 1, at: 1, turnId: 'queued-turn',
    ev: { k: 'user', text: 'do this next', promptId: 'p-1', delivery: 'queued', attachments: [{ id: 'img', name: 'a.png', mediaType: 'image/png' }] },
  } })
  store.cancelQueuedPrompt('queue-session', 'p-1')
  check('nothing comes back before the server agrees', store.getState().restored['queue-session'] === undefined)
  const cancel = live.frames().filter((msg) => msg.t === 'cancel_prompt').at(-1)
  live.deliver({ t: 'ack', cid: cancel && 'cid' in cancel ? cancel.cid : undefined, ok: true })
  const restored = store.getState().restored['queue-session']
  check('the cancelled prompt comes back for the composer', restored?.text === 'do this next' && restored.attachments.length === 1, restored)
  store.takeRestoredPrompt('queue-session')
  check('and it is handed over once', store.getState().restored['queue-session'] === undefined)
}
{
  // "Edit" on a prompt the server cancelled: back into the composer, bubble gone.
  const live = FakeSocket.last!
  live.deliver({ t: 'event', sessionId: 'queue-session', event: {
    id: 'server-cancelled', sessionId: 'queue-session', seq: 2, at: 2, turnId: 'queued-turn-2',
    ev: { k: 'user', text: 'send me later', promptId: 'p-2', delivery: 'cancelled', cancelledBy: 'server' },
  } })
  store.editCancelledPrompt('queue-session', 'server-cancelled')
  check('Edit puts a server-cancelled prompt back in the composer', store.getState().restored['queue-session']?.text === 'send me later', store.getState().restored)
  check('and its bubble is not drawn again', store.getState().editedPrompts['server-cancelled'] === true)
}

{
  // The turn ledger: a replay brings all of it, a 'turn' frame moves one turn.
  const live = FakeSocket.last!
  const turn = (id: string, phase: string) => ({ id, sessionId: 'ledger', runToken: 'r', status: 'running', startedAt: 1, phase }) as never
  live.deliver({ t: 'timeline', sessionId: 'ledger', events: [], cursor: 0, turns: [turn('t1', 'completed'), turn('t2', 'running')] } as never)
  check('a replay brings the whole ledger', Object.keys(store.getState().turns.ledger ?? {}).join() === 't1,t2', store.getState().turns.ledger)
  live.deliver({ t: 'turn', sessionId: 'ledger', turn: turn('t2', 'waiting_agents') } as never)
  check('a turn frame moves one turn in place', store.getState().turns.ledger?.t2?.phase === 'waiting_agents' && store.getState().turns.ledger?.t1?.phase === 'completed')
}

{
  // The quick terminal is part of the session it was opened from: the server
  // says so, and every client — not only the window that opened it — obeys.
  const live = FakeSocket.last!
  const summary = (id: string, extra: Record<string, unknown>) => ({
    id, harness: 'claude', kind: 'agent', title: id, preset: null, cwd: '/work', host: null, model: null,
    status: 'idle', createdAt: 1, updatedAt: 1, nativeId: null, transcriptPath: null, resumeHint: null,
    permissionMode: 'acceptEdits', effort: null, gitBranch: null, pinned: false, started: true,
    parentSessionId: null, metrics: {}, ...extra,
  })
  const shell = (id: string, parentSessionId: string | null) =>
    summary(id, { harness: 'shell', kind: 'terminal', preset: 'shell', parentSessionId })
  live.deliver({ t: 'sessions', sessions: [summary('dock-agent', {}), shell('dock-child', 'dock-agent')] })
  const listed = store.sessionsByWorkspace(store.getState()).flatMap((group) => group.sessions.map((session) => session.id))
  check('a docked terminal is not listed in the rail', listed.includes('dock-agent') && !listed.includes('dock-child'), listed)
  check('it is in its agent\'s dock, on a client that never opened it', store.getState().docks['dock-agent']?.terminals.includes('dock-child') === true, store.getState().docks)
  const before = live.frames().length
  store.toggleDock('dock-agent')
  check('reopening the dock brings that terminal back, no new shell', store.getState().docks['dock-agent']?.open === true
    && store.getState().docks['dock-agent']?.active === 'dock-child'
    && !live.frames().slice(before).some((msg) => msg.t === 'new_session'))
  store.newDockTerminal('dock-agent')
  const created = live.frames().filter((msg) => msg.t === 'new_session').at(-1)
  check('a new dock terminal is created as part of the agent', created?.t === 'new_session' && created.req.parentSessionId === 'dock-agent', created)

  // A terminal an older build docked, known to this window only: handed over once.
  const legacyId = store.getState().docks['dock-agent']!.terminals.at(-1)!
  live.deliver({ t: 'sessions', sessions: [summary('dock-agent', {}), shell('dock-child', 'dock-agent'), shell(legacyId, null)] })
  const adopt = live.frames().filter((msg) => msg.t === 'set_session_parent').at(-1)
  check('a terminal this window docked is handed to its agent', adopt?.t === 'set_session_parent' && adopt.sessionId === legacyId && adopt.parentSessionId === 'dock-agent', adopt)
  const listedLegacy = store.sessionsByWorkspace(store.getState()).flatMap((group) => group.sessions.map((session) => session.id))
  check('and is not listed meanwhile', !listedLegacy.includes(legacyId), listedLegacy)
}

/* ------------------------------------------------------------------ */

if (failures.length) {
  console.log('--- failed checks ---')
  for (const failure of failures) console.log(`✗ ${failure}`)
  console.log(`\nstore-test: ${failures.length} FAILURES (${passed.length} passed)`)
  process.exit(1)
}
console.log(`store-test: PASSED (${passed.length} checks)`)
process.exit(0)
