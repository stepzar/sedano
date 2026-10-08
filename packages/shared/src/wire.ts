import type {
  AttachmentRef,
  Capabilities,
  EffortLevel,
  HarnessId,
  LimitSnapshot,
  MachineColorId,
  PermissionMode,
  ActorOwnership,
  ActorStatus,
  PromptDelivery,
  ProjectRef,
  SessionEvent,
  SessionMetrics,
  SessionSummary,
  TurnStatus,
} from './events.ts'

export type { PermissionMode, EffortLevel }

export interface NewSessionRequest {
  /** The client may name the session, so a tab keeps its identity end to end. */
  id?: string
  harness: HarnessId
  kind?: 'agent' | 'terminal'
  cwd: string
  host?: string | null
  model?: string | null
  permissionMode?: PermissionMode
  effort?: EffortLevel | null
  /** Command a terminal tab runs (see Capabilities.presets). */
  preset?: string | null
  /**
   * The agent session a docked terminal is opened from (terminals only). It is
   * stored as part of that session (see `SessionSummary.parentSessionId`).
   */
  parentSessionId?: string | null
  /** Reopen an existing native session (claude uuid, codex thread id, ...). */
  nativeId?: string | null
  /** Optional first message; when omitted the session starts idle. */
  prompt?: string
  /** Images pasted into the launchpad, sent with the first message. */
  attachments?: AttachmentRef[]
}

/**
 * Why a mutating command was refused, so the UI can say something true instead
 * of a generic failure. `busy` is a turn already running, `gone` a session that
 * no longer exists, `unsupported` a harness that cannot do what was asked,
 * `rejected` a request the server declined (a host that is not enabled),
 * `not_pending` a question no longer open to an answer (already answered, or
 * closed by a stop, an interrupt or a restart — see `RequestState`), and
 * `failed` anything the server could not carry out.
 */
export type AckError = 'busy' | 'gone' | 'unsupported' | 'rejected' | 'not_pending' | 'failed'

/**
 * The answer to one mutating command.
 *
 * Mutations used to be fire-and-forget: the composer cleared itself, the picker
 * moved to the new value and the question card said "sent" before the server had
 * done anything, so a command the server dropped looked exactly like one it
 * carried out. `cid` is the id the client put on the command, which is what
 * makes this an answer to a particular command rather than a global event.
 */
export interface Ack {
  t: 'ack'
  cid: string
  ok: boolean
  /** Set when the command created or acted on a session. */
  sessionId?: string
  error?: AckError
  /** One line for the user, when `ok` is false. */
  detail?: string
  /** Durable ledger identity for command-driven prompts and turns. */
  promptId?: string
  turnId?: string
}

/** Public projection of a durable prompt lifecycle. */
export interface PromptRecord {
  id: string
  sessionId: string
  commandId?: string | null
  userEventId?: string | null
  turnId: string | null
  delivery: PromptDelivery
  createdAt: number
  updatedAt: number
  error?: string | null
  /**
   * Who cancelled a `cancelled` prompt: `user` (they clicked cancel) or
   * `server` (a stop, an interrupt, or a failed delivery took the queue with
   * it). A client gives the text back to the composer for either — only the
   * user chose to drop it.
   */
  cancelledBy?: 'user' | 'server'
  /** Why, for a server cancel, in words the user can read. */
  cancelReason?: string
}

/**
 * What a turn *is*, decided once by the server's turn ledger for every harness
 * (see docs/architecture.md, "Turn state"). The UI renders this and derives
 * nothing: `running` (the main loop is working), `waiting_agents` (the main
 * loop returned but child agents it started are still working), and the three
 * terminal states. `status` below is the raw ledger row, kept for older clients.
 */
export type TurnPhase = 'running' | 'waiting_agents' | 'completed' | 'stopped' | 'failed'

export interface TurnRecord {
  id: string
  sessionId: string
  runToken: string
  status: TurnStatus
  promptId?: string | null
  startedAt: number
  endedAt?: number | null
  outcome?: 'completed' | 'interrupted' | 'failed' | null
  subtype?: string | null
  /** The turn's state. Absent only from servers older than the ledger view. */
  phase?: TurnPhase
  /** Child agents of this turn still working (drives `waiting_agents`). */
  activeAgents?: number
  /** Child agents a stop, crash or restart cut off (each has a `subagent_end` `stopped`). */
  cutOffAgents?: number
  /** The last main-loop `result` event of the turn, when there is one. */
  resultEventId?: string | null
  /** The last main-loop `assistant` event of the turn: its final reply. */
  replyEventId?: string | null
}

export interface ActorRecord {
  id: string
  sessionId: string
  turnId: string | null
  parentActorId?: string | null
  spawnEventId?: string | null
  ownership: ActorOwnership
  provider: string
  title?: string
  description?: string
  model?: string | null
  status: ActorStatus
  updatedAt: number
}

/**
 * What became of one prompt.
 *
 * A prompt has three honest outcomes and they must be told apart: it went to the
 * harness, it is waiting for the running turn to end, or it never left. The old
 * answer was an unconditional `true` returned before the process even existed,
 * so a spawn that failed looked exactly like a prompt that had been sent. The
 * codes are the ones an `Ack` carries, so wiring this to the socket is a
 * translation and not a second vocabulary.
 */
export type SendResult =
  | { ok: true; queued: boolean; promptId?: string; turnId?: string }
  | { ok: false; code: Extract<AckError, 'gone' | 'failed'>; detail: string; promptId?: string; turnId?: string }

/**
 * What became of one configuration change.
 *
 * `pending` is the honest answer for almost all of them: model, effort and
 * approval mode are CLI flags or a request the agent may refuse, so the server
 * has recorded what was asked for and the session summary will say it is in
 * effect once it is (see `SessionSummary.pendingOptions`). `busy` is a turn in
 * flight — its options are settled for as long as it runs.
 */
export type ConfigureResult =
  | { ok: true; pending: boolean }
  | { ok: false; code: Extract<AckError, 'busy' | 'gone' | 'failed'>; detail: string }

/**
 * The choices of a new-session tab that has not been launched yet, shared so
 * another device can draw the tab and launch it. What is being typed in it is
 * not here: composer text stays on the device it was written on.
 */
export interface SharedDraft {
  cwd: string
  harness: HarnessId
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode
  host: string | null
  createdAt: number
}

/**
 * One open tab, shared by every client of this server. A session tab is just
 * its id; a new-session tab carries its choices (`draft`). Which tab is on
 * screen is not shared — every device picks its own.
 */
export interface OpenTab {
  id: string
  draft?: SharedDraft
}

/**
 * One change to the shared tab list. The server applies them in arrival order
 * (last writer wins) and broadcasts the result; every op is idempotent, so a
 * replay after a reconnect lands on the same list. See `applyTabOp`.
 *
 * - `open`: add a tab (at the end, or right after `after`), or update the
 *   choices of a new-session tab already open, in place.
 * - `close`: remove it.
 * - `move`: put it just before `target` (or just after, with `after`).
 * - `replace`: a launched new-session tab becomes its session, in place.
 * - `merge`: one-time union of a device's pre-sharing tabs into the list.
 */
export type TabOp =
  | { op: 'open'; tab: OpenTab; after?: string | null }
  | { op: 'close'; id: string }
  | { op: 'move'; id: string; target: string; after?: boolean }
  | { op: 'replace'; from: string; to: string }
  | { op: 'merge'; tabs: OpenTab[] }

/** Server -> client. */
export type ServerMsg =
  | Ack
  | { t: 'prompt'; sessionId: string; prompt: PromptRecord }
  | { t: 'turn'; sessionId: string; turn: TurnRecord }
  | { t: 'actor'; sessionId: string; actor: ActorRecord }
  /**
   * `machineColors` rides along on the greeting because the colours decide how
   * the first frame is painted: fetching them afterwards would draw every tab
   * in the default colour and then recolour it, which is a flash the user reads
   * as a bug. Optional, so a server from before this field keeps working —
   * the client then shows the default colour, which is what "nobody chose" is.
   */
  | {
      t: 'hello'
      sessions: SessionSummary[]
      limits: LimitSnapshot[]
      projects: ProjectRef[]
      machineColors?: Record<string, MachineColorId>
      /** The shared open tabs, in strip order. Absent from a server that does not share them. */
      tabs?: OpenTab[]
    }
  | { t: 'sessions'; sessions: SessionSummary[] }
  | { t: 'session'; session: SessionSummary }
  | { t: 'session_removed'; id: string }
  /**
   * Full timeline for a session (on subscribe / after replay).
   *
   * `cursor` is how far into the session's event stream this timeline reaches:
   * the `seq` of its last event, or 0 for a session with none. A replay and the
   * live stream otherwise tell two stories — the client cannot say whether an
   * `event` that arrives while a timeline is in flight is already in it — and
   * the watermark is what lets it answer that without guessing. Optional so a
   * server from before this field keeps working with a newer client.
   */
  | {
      t: 'timeline'
      sessionId: string
      events: SessionEvent[]
      cursor?: number
      /** Every ledger turn of the session, in start order (see `TurnRecord.phase`). */
      turns?: TurnRecord[]
    }
  /** One committed event appended to a session. */
  | { t: 'event'; sessionId: string; event: SessionEvent }
  /**
   * Transient streaming chunk (never persisted).
   *
   * `turnId` is which turn is being streamed. A streaming buffer is the one piece
   * of session state the client builds itself, and without a turn on it there is
   * no way to tell whether what is in the buffer belongs to the turn on screen:
   * a socket that dropped mid-stream left a narration in the buffer that the
   * replayed timeline already contained, and it was drawn a second time under
   * whatever turn came next. Absent for a stream that belongs to no turn.
   */
  | {
      t: 'delta'
      sessionId: string
      agentId?: string
      key: string
      kind: 'text' | 'thinking'
      text: string
      turnId?: string
    }
  | { t: 'metrics'; sessionId: string; metrics: SessionMetrics }
  /**
   * Raw terminal output for a terminal tab. Live only, never persisted.
   * `snapshot` marks a replayed screen: the client replaces what it has instead
   * of appending, so reattaching cannot stack one screen on top of another.
   * A replayed screen also carries where its cursor is, because a screen alone
   * does not say: the pane pads every row to its full width and `capture-pane`
   * drops that padding, so the text ends left of where the cursor really is.
   *
   * `offset` is how far into the pane's output stream the frame reaches, and it
   * is what keeps the replay and the live stream from telling different stories:
   * a chunk the screen already covers is not drawn twice, and a screen filmed
   * before chunks that have been drawn already never replaces them.
   */
  | { t: 'term'; sessionId: string; data: string; snapshot?: boolean; cursor?: { x: number; y: number }; offset?: number }
  | { t: 'limits'; limits: LimitSnapshot[] }
  | { t: 'projects'; projects: ProjectRef[] }
  | { t: 'caps'; caps: Capabilities }
  /**
   * Every machine's colour, whenever one changes. Broadcast rather than sent to
   * the client that asked: a second window open on the same server must not
   * keep painting a machine in the colour it had a minute ago.
   */
  | { t: 'machine_colors'; colors: Record<string, MachineColorId> }
  | { t: 'toast'; level: ToastLevel; text: string }
  /**
   * The shared tab list after a change, to every client. `cid` is the command
   * that produced it, so the sender can stop re-applying it on top.
   */
  | { t: 'tabs'; tabs: OpenTab[]; cid?: CommandId }

/**
 * The idempotency id a client puts on a mutating command.
 *
 * The socket's outbox is replayed on reconnect, and a command the server already
 * carried out before the connection dropped would otherwise be carried out twice
 * — a prompt sent again, a session created again. The id is minted once, when
 * the user acts, and kept across every retry of that same command, so the server
 * can recognise a repeat and answer with the original `Ack` instead of redoing
 * the work. It is also what an `Ack` is matched against.
 */
export type CommandId = string

/** Client -> server. */
export type ClientMsg =
  | { t: 'new_session'; req: NewSessionRequest; cid?: CommandId }
  | { t: 'input'; sessionId: string; text: string; attachments?: AttachmentRef[]; cid?: CommandId }
  | { t: 'cancel_prompt'; sessionId: string; promptId: string; cid?: CommandId }
  | { t: 'interrupt'; sessionId: string; cid?: CommandId }
  /**
   * The answer to a question an agent asked mid-turn.
   *
   * `toolId` identifies the pending question (it is the id the question event
   * carried); `optionId` is the choice. Harnesses differ in how they ask — a
   * Claude tool permission, an ACP permission request — but the shape the user
   * answers is the same, so this is one message and one card in the UI.
   */
  | { t: 'answer_question'; sessionId: string; toolId: string; optionId: string; cid?: CommandId }
  | { t: 'stop'; sessionId: string; cid?: CommandId }
  | { t: 'subscribe'; sessionId: string }
  | { t: 'unsubscribe'; sessionId: string }
  | { t: 'rename_session'; sessionId: string; title: string; cid?: CommandId }
  /**
   * Model/reasoning/approval live in the CLI flags, so changing them restarts
   * the harness process on the next message (history is preserved by --resume).
   */
  | {
      t: 'set_session_options'
      sessionId: string
      model?: string | null
      effort?: EffortLevel | null
      permissionMode?: PermissionMode
      cid?: CommandId
    }
  | { t: 'pin_session'; sessionId: string; pinned: boolean; cid?: CommandId }
  /**
   * Hand a terminal to the agent session whose dock it lives in. Only for the
   * docked terminals an older build created as sessions of their own: the
   * client that remembers them says whose they are, once. Idempotent.
   */
  | { t: 'set_session_parent'; sessionId: string; parentSessionId: string; cid?: CommandId }
  | { t: 'delete_session'; sessionId: string; cid?: CommandId }
  /** `force` skips the cache: the periodic poll does not, so the usage endpoint is not hammered. */
  | { t: 'refresh_limits'; force?: boolean }
  | { t: 'list_projects' }
  /**
   * Capabilities of one machine: a harness list is per machine (see
   * Capabilities). `force` rescans instead of answering from the server's cache,
   * which is what opening an environment should do.
   */
  | { t: 'list_caps'; host?: string | null; force?: boolean }
  /**
   * Show or hide one harness on one machine.
   *
   * It carries a `cid` like every other mutation, because the switch must not
   * move until the server says it moved: the preference lives on the server, and
   * a toggle that flipped on the click would be claiming a change that a refused
   * command never made. `host` is which machine the preference is about — null
   * for this computer — and an unauthorized one is refused (`rejected`) exactly
   * like everywhere else.
   */
  | { t: 'set_harness_enabled'; host?: string | null; harness: HarnessId; enabled: boolean; cid?: CommandId }
  /**
   * The colour one machine is recognised by (see `MachineColorId`).
   *
   * `host` is which machine — null for this computer — and an unauthorized one
   * is refused exactly like everywhere else, because a preference about a
   * machine nobody enabled is still a message naming that machine. `null` for
   * the colour puts it back to the default. It carries a `cid` like every other
   * mutation: the swatch moves when the server says it moved.
   */
  | { t: 'set_machine_color'; host?: string | null; color: MachineColorId | null; cid?: CommandId }
  /*
   * Terminal tabs: keystrokes and geometry for the process behind the tab.
   *
   * These two carry no `cid` on purpose. They are the highest-frequency messages
   * on the socket — one per keystroke — and acknowledging each of them would
   * double that traffic to say something the pane's own output already says. A
   * keystroke also has a shelf life: replaying one minutes later, into whatever
   * the shell is doing by then, is worse than losing it, which is why the outbox
   * treats them as droppable rather than durable.
   */
  | { t: 'term_input'; sessionId: string; data: string }
  | { t: 'term_resize'; sessionId: string; cols: number; rows: number }
  /**
   * Replay the pane's screen, for a client that just attached. `history` brings
   * the scrollback along: attaching is when the lines you had scrolled back to
   * are the ones missing, and a resync of a screen already on display is not.
   */
  | { t: 'term_snapshot'; sessionId: string; history?: boolean }
  /** Change the shared tab list (see `TabOp`). */
  | { t: 'tabs'; op: TabOp; cid?: CommandId }

/** How a transient notice reads: its icon, its colour and how long it stays. */
export type ToastLevel = 'info' | 'success' | 'warning' | 'error'

/**
 * One conversation the import popup can bring into Sedano (`GET /api/import/scan`).
 *
 * `archived` is a Sedano session the user archived: `sessionId` names it and
 * restoring it is an unarchive. `native` is a conversation the harness keeps in
 * its own store that Sedano does not hold: importing it opens a session that
 * resumes `nativeId`.
 */
export interface ImportableSession {
  harness: HarnessId
  source: 'archived' | 'native'
  sessionId?: string
  nativeId: string | null
  /** The native title, or the first prompt, trimmed. */
  title: string
  /** Last activity, epoch ms. */
  updatedAt: number
}

export interface ImportScan {
  cwd: string
  host: string | null
  /** Newest first. */
  sessions: ImportableSession[]
  /** A store that exists but could not be read, per harness. */
  errors: Array<{ harness: HarnessId; error: string }>
  /** Why part of the scan was skipped (a remote machine, a capped list). */
  notes: string[]
}
