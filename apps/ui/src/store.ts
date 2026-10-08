import { useSyncExternalStore } from 'react'
import { chime } from './chime.ts'
import type {
  ToastLevel,
  TurnRecord,
  Ack,
  AttachmentRef,
  Capabilities,
  ClientMsg,
  CommandId,
  EffortLevel,
  HarnessCommand,
  HarnessId,
  HarnessUpdateInfo,
  HostStatus,
  LimitSnapshot,
  MachineColor,
  MachineColorId,
  OpenTab,
  PermissionMode,
  ProjectRef,
  RequestState,
  ServerMsg,
  SessionEvent,
  SessionMetrics,
  SessionSummary,
  SharedDraft,
  TabOp,
  VoiceProvider,
  VoiceStatus,
} from '@shared'
import { DOCUMENT_MEDIA_TYPE, HARNESS_LABEL, applyTabOp, asOpenTabs, emptyMetrics, machineColorOf, resultOutcomeOf, sameDraft } from '@shared'
import { supportedEffort } from './models.ts'
import { REMOTE_REVOKED_CLOSE, reloadForPairing } from './remoteClient.ts'

/**
 * A tab that exists but has not been launched yet.
 *
 * Creating a tab must not interrogate the user with a form: it opens this
 * landing screen, where the choices are chips inside the composer and the first
 * thing you type is the first thing the session does.
 */
export interface Draft {
  id: string
  /** `null` until the user picks: a new tab starts as a chooser, not a form. */
  kind: 'agent' | null
  cwd: string
  harness: HarnessId
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode
  /** Where a terminal should run, chosen on the chooser screen. */
  host: string | null
  /** Open the folder picker as soon as this tab appears (see openDraft). */
  needsFolder?: boolean
  createdAt: number
  /** Set the moment it is launched, so the tab can follow the real session id. */
  pendingId?: string
  /**
   * The first message this draft was launched with, kept until the server has
   * acknowledged the session. A launch the server refuses used to leave the tab
   * saying "launching" forever with the prompt gone; keeping it here is what
   * lets the composer hand it back instead of losing what was typed.
   */
  pendingPrompt?: string
}

export interface LiveBuffer {
  text: string
  thinking: string
  /**
   * The turn being streamed, when the server says. A buffer is only ever shown
   * under the turn it belongs to: a socket that dropped mid-stream leaves text
   * here that the replayed timeline already contains, and drawing it under the
   * next turn is how one answer came to appear twice.
   */
  turnId?: string
}

/**
 * Where an answer to a question card has got to.
 *
 * `sending` is the truth between the click and the server's ack, and it is the
 * state the UI was missing: the card used to say "answer sent" the instant it
 * was clicked, so an answer the server refused — a question already answered, a
 * session restarted since — looked exactly like one that had been delivered.
 */
export type AnswerState = 'sending' | 'answered'

export interface Toast {
  id: number
  level: ToastLevel
  text: string
  /** Playing its exit animation; removed from the list when that ends. */
  leaving?: boolean
}

export type ThemeChoice = 'system' | 'light' | 'dark'

/**
 * A question the app has to ask before doing something irreversible. It is drawn
 * by the app rather than by `window.confirm` / `window.prompt`, which the desktop
 * webview answers with `false` and `null` without ever showing anything — which
 * is why Delete on a session looked like it did nothing at all.
 */
export interface DialogState {
  id: number
  kind: 'confirm' | 'prompt'
  title: string
  body?: string
  value: string
  confirmLabel: string
  danger: boolean
}

/**
 * The theme choices, defined once. The top bar and Settings render the very same
 * control with the very same labels: two entries for one setting are only
 * confusing when they look like two different settings.
 */
export const THEME_CHOICES: Array<{ value: ThemeChoice; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

export interface UiSettings {
  theme: ThemeChoice
  uiFontSize: number
  contentFontSize: number
  /**
   * The typeface of the interface, and the one the conversation is set in.
   *
   * A family name, or null for the stack the app ships with. Two settings
   * because they do two jobs: the interface has to stay legible at 12px in a
   * sidebar, the conversation is read in paragraphs. Only the prose follows the
   * content font — code, diffs, tool output and terminals keep the monospace
   * stack, because a proportional font there loses the column alignment those
   * surfaces exist to show (see `applySettings`).
   *
   * Optional, and undefined reads exactly like null: settings stored before this
   * existed keep loading, and so does a caller that builds one by hand.
   */
  uiFont?: string | null
  contentFont?: string | null
  /** Width of the rail and of the file panel, in px: both are draggable. */
  railWidth: number
  filesWidth: number
  /** A soft chime when an agent finishes a turn. */
  chimeOnDone: boolean
  /** Short blips when dictation starts and stops recording. Absent means on. */
  dictationSounds?: boolean
  railVisible: boolean
  showThinking: boolean
  /** Collapse finished turns into their one-line summary. */
  compactTurns: boolean
  /** Right-hand tree of the directory the active session works in. */
  filesVisible: boolean
  /**
   * Show the estimated API cost. Off by default: on a subscription nothing is
   * charged per token, so a dollar figure would be misleading.
   */
  showCost: boolean
  /**
   * Which machine the rail is showing: null for this one, or an SSH host. The
   * app works like one window with a machine profile — switching it shows that
   * machine's workspaces instead of opening anything new.
   */
  machine: string | null
  /**
   * Template used to brief a new harness when a conversation is transferred.
   * Optional so settings written by older builds and hand-built test fixtures
   * keep loading; the transfer screen falls back to the shipped template.
   */
  transferPromptTemplate?: string
  /** Legacy persisted setting; always migrated to `bottom`. */
  dockSide: DockSide
}

export type DockSide = 'side' | 'bottom'

export interface State {
  connected: boolean
  sessions: Record<string, SessionSummary>
  /** Tabs that are still just an intent (see Draft). */
  drafts: Record<string, Draft>
  /**
   * Harnesses, terminal presets, hosts and voice status, from the server,
   * keyed by machine (see `capsKey`). The harness list belongs to one machine —
   * a server runs its own CLIs — so it is never shared between them.
   */
  caps: Record<string, Capabilities>
  /**
   * Machines we asked about and never heard back from, keyed like `caps`. A
   * server that does not know about per-machine harnesses answers about this
   * computer instead of staying silent, so the wait also has an end (see
   * `askCaps`): without it the picker waited for a scan that was never coming.
   */
  capsFailed: Record<string, string>
  /** Last explicit update failure per machine and harness; kept beside the button until retried. */
  harnessUpdateErrors: Record<string, string>
  events: Record<string, SessionEvent[]>
  /** Streaming buffers keyed by `${sessionId}:${agentId ?? 'main'}`. */
  live: Record<string, LiveBuffer>
  /**
   * Answers in flight or accepted, keyed by `${sessionId}:${toolId}` (see
   * `AnswerState`). Driven by the server's ack, never by the click.
   */
  answers: Record<string, AnswerState>
  limits: LimitSnapshot[]
  projects: ProjectRef[]
  /**
   * The colour each machine is recognised by, keyed by host (`''` is this
   * computer). The server owns it — it is a fact about the machines, not about
   * this window — so it is never written here except from the server's answer.
   */
  machineColors: Record<string, MachineColorId>
  toasts: Toast[]
  active: string | null
  /**
   * The open tabs, in strip order, shared with every other device on this
   * server (see `reconcileTabs`). Which one is `active` stays this device's.
   */
  openTabs: OpenTab[]
  /** `openTabs` grouped by workspace, derived in `set` — never written directly. */
  tabs: Record<string, string[]>
  settings: UiSettings
  /** Which workspace groups are open in the rail: workspace path → open. */
  railOpen: Record<string, boolean>
  /** The question on screen right now, if any (see DialogState). */
  dialog: DialogState | null
  /** Last model / effort / approvals used per harness (see AgentDefaults). */
  defaults: Record<string, AgentDefaults>
  /** Last time the user looked at each session, for unread indicators. */
  seen: Record<string, number>
  /**
   * The small terminal each agent's screen can pull out, keyed by the agent
   * session id. It lives beside the conversation rather than in the tab strip,
   * so it is not a tab and never becomes one (see `toggleDock`).
   */
  docks: Record<string, Dock>
  version: number
  /**
   * A prompt the user took back out of the queue, on its way into that
   * session's composer. The composer consumes it once (`nonce`).
   */
  restored: Record<string, { text: string; attachments: AttachmentRef[]; nonce: number }>
  /**
   * The server's turn ledger, per session and turn id: what each turn is
   * (`phase`), its live agents, its reply. Empty for a server without one.
   */
  turns: Record<string, Record<string, TurnRecord>>
  /**
   * Prompts the server cancelled that the user has taken back into the
   * composer ("Edit"), by event id: their "Not sent" bubble is not drawn again.
   */
  editedPrompts: Record<string, true>
}

/**
 * The quick terminal docked in an agent's screen.
 *
 * Remembered per agent: every tab belongs to that agent's workspace and
 * reattaches to its tmux session when the panel opens again.
 */
export interface Dock {
  /** Terminal sessions kept in this agent's bottom panel, in tab order. */
  terminals: string[]
  /** The terminal visible in the panel. */
  active: string | null
  open: boolean
}

/**
 * The choices a new session inherits. Model, effort and approvals are the three
 * answers you give before every session and almost never change, so the next
 * one starts where the last one ended — per harness, because a model id means
 * nothing to a different CLI.
 */
export interface AgentDefaults {
  model: string | null
  effort: EffortLevel | null
  permissionMode: PermissionMode
}

const SETTINGS_KEY = 'sedano.settings'
const TABS_KEY = 'sedano.tabs'
const TAB_ORDER_KEY = 'sedano.tab-order'
const SEEN_KEY = 'sedano.seen'
const DEFAULTS_KEY = 'sedano.defaults'
/** Persisted with the key the rail used before this state moved into the store. */
const RAIL_OPEN_KEY = 'sedano.rail.open'
/** Which agent's screen has its quick terminal out, and which shell that is. */
const DOCKS_KEY = 'sedano.docks'
const EDITED_PROMPTS_KEY = 'sedano.edited-prompts'
const DRAFTS_KEY = 'sedano.drafts'
/** The last shared tab list this device saw, drawn before the server answers. */
const OPEN_TABS_KEY = 'sedano.open-tabs'
/** Set once this device's pre-sharing tabs have been merged into the server's list. */
const TABS_MIGRATED_KEY = 'sedano.tabs-migrated'

declare global {
  interface Window {
    __SEDANO_API__?: string
  }
}

/** True inside the Tauri shell, where the page is not served by the API. */
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && typeof window.__SEDANO_API__ === 'string'
}

/** The sizes the interface starts at, and the ones a "reset" goes back to. */
const DEFAULT_UI_FONT = 16
const DEFAULT_CONTENT_FONT = 17
/** What these were before the interface was made readable; see `loadSettings`. */
const LEGACY_UI_FONT = 12.5
const LEGACY_CONTENT_FONT = 14.5

/**
 * The default handoff is deliberately explicit about provenance and restraint:
 * the receiving agent can find the old native session if it needs to, but its
 * first job is to inspect the repository it inherited rather than repeat work.
 */
export const DEFAULT_TRANSFER_PROMPT_TEMPLATE = `Stai continuando una sessione di coding trasferita da {sourceHarness}.

Sessione sorgente: {sourceSession}

Cosa stavamo facendo:
{summary}

Cosa resta da fare:
{remaining}

Continua dallo stato attuale del repository. Controlla prima le modifiche esistenti, non ripetere il lavoro già completato, termina autonomamente le attività rimaste e avvia i test pertinenti prima di rispondere.`

/** Recognises the English template shipped before handoffs became local-only. */
function isLegacyTransferTemplate(value: string | undefined): boolean {
  if (!value) return false
  return /continuing a coding session transferred from/i.test(value) && /\{workspace\}/i.test(value)
}

/**
 * Appearance is kept per kind of device: a phone and the Mac want different
 * sizes, and one setting shared between them made one of the two wrong. The
 * rest of the settings are one set. The test is the device, not the window —
 * a phone keeps its profile when rotated, a narrow Mac window keeps the Mac's.
 * `index.html` repeats this test to paint the right theme before React runs.
 */
export const MOBILE_APPEARANCE_KEY = 'sedano.settings.mobile'
const APPEARANCE_KEYS = ['theme', 'uiFontSize', 'contentFontSize', 'uiFont', 'contentFont'] as const
type Appearance = Pick<UiSettings, (typeof APPEARANCE_KEYS)[number]>
/** Sizes that read well at arm's length on a phone. */
const MOBILE_APPEARANCE_DEFAULTS: Partial<Appearance> = { uiFontSize: 15, contentFontSize: 16 }

/** The sizes and faces "Reset to defaults" goes back to, for this device's profile. */
export function defaultAppearance(): Pick<UiSettings, 'uiFontSize' | 'contentFontSize' | 'uiFont' | 'contentFont'> {
  const sizes = { uiFontSize: DEFAULT_UI_FONT, contentFontSize: DEFAULT_CONTENT_FONT }
  return { ...sizes, ...(isPhoneProfile() ? MOBILE_APPEARANCE_DEFAULTS : {}), uiFont: null, contentFont: null } as ReturnType<typeof defaultAppearance>
}

export function isPhoneProfile(): boolean {
  if (typeof matchMedia !== 'function' || typeof screen === 'undefined') return false
  return matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) <= 820
}

function pickAppearance(settings: Partial<UiSettings>): Partial<Appearance> {
  const out: Partial<Appearance> = {}
  for (const key of APPEARANCE_KEYS) if (key in settings) (out as Record<string, unknown>)[key] = settings[key]
  return out
}

function loadMobileAppearance(): Partial<Appearance> {
  try {
    const raw = localStorage.getItem(MOBILE_APPEARANCE_KEY)
    return { ...MOBILE_APPEARANCE_DEFAULTS, ...(raw ? (JSON.parse(raw) as Partial<Appearance>) : {}) }
  } catch {
    return { ...MOBILE_APPEARANCE_DEFAULTS }
  }
}

function loadSettings(): UiSettings {
  const shared = loadSharedSettings()
  return isPhoneProfile() ? { ...shared, ...loadMobileAppearance() } : shared
}

function loadSharedSettings(): UiSettings {
  const fallback: UiSettings = {
    theme: 'system',
    uiFontSize: DEFAULT_UI_FONT,
    contentFontSize: DEFAULT_CONTENT_FONT,
    uiFont: null,
    contentFont: null,
    railWidth: 298,
    filesWidth: 236,
    chimeOnDone: true,
    railVisible: true,
    showThinking: true,
    compactTurns: false,
    filesVisible: false,
    showCost: false,
    machine: null,
    transferPromptTemplate: DEFAULT_TRANSFER_PROMPT_TEMPLATE,
    dockSide: 'bottom',
  }
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return fallback
    const stored = { ...fallback, ...(JSON.parse(raw) as Partial<UiSettings>) }
    // Anyone still sitting on the old defaults never chose them — they were what
    // the app shipped — and the old defaults are what made the interface too small
    // to read. Lifting exactly those two numbers moves those people to the new
    // ones without touching a size anybody picked by hand.
    if (stored.uiFontSize === LEGACY_UI_FONT) stored.uiFontSize = DEFAULT_UI_FONT
    if (stored.contentFontSize === LEGACY_CONTENT_FONT) stored.contentFontSize = DEFAULT_CONTENT_FONT
    // That earlier value was a shipped default, not an explicit user choice.
    if (isLegacyTransferTemplate(stored.transferPromptTemplate)) {
      stored.transferPromptTemplate = DEFAULT_TRANSFER_PROMPT_TEMPLATE
    }
    // The quick terminal now has one unambiguous home. Migrate the old choice
    // rather than letting a saved "side" resurrect a removed layout.
    stored.dockSide = 'bottom'
    return stored
  } catch {
    return fallback
  }
}

/**
 * New-session tabs that were opened (an answered chooser) come back after a
 * reload with the harness, model, effort, approvals, folder and machine they
 * had. A draft already launched is not kept: its session is on the server.
 */
function loadDrafts(): Record<string, Draft> {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, Draft>) : {}
    const drafts: Record<string, Draft> = {}
    for (const [id, draft] of Object.entries(parsed)) {
      if (draft && draft.id === id && draft.kind === 'agent') drafts[id] = { ...draft, needsFolder: undefined }
    }
    return drafts
  } catch {
    return {}
  }
}

let persistedDrafts: Record<string, Draft> | null = null

function persistDrafts(drafts: Record<string, Draft>): void {
  if (drafts === persistedDrafts) return
  persistedDrafts = drafts
  const kept: Record<string, Draft> = {}
  for (const [id, draft] of Object.entries(drafts)) {
    if (draft.kind !== 'agent' || draft.pendingId) continue
    const { needsFolder: _picker, pendingPrompt: _prompt, ...rest } = draft
    kept[id] = rest
  }
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(kept))
  } catch {
    /* ignore quota errors */
  }
}

/** The choices of a new-session tab, as every device shares them. */
export function sharedDraftOf(draft: Draft): SharedDraft {
  return {
    cwd: draft.cwd,
    harness: draft.harness,
    model: draft.model,
    effort: draft.effort,
    permissionMode: draft.permissionMode,
    host: draft.host,
    createdAt: draft.createdAt,
  }
}

/** A new-session tab that is in the strip: an answered chooser with a folder. */
function tabbedDraft(draft: Draft): boolean {
  return draft.kind === 'agent' && Boolean(draft.cwd)
}

/**
 * The tabs from before they were shared: the per-workspace lists in the order
 * the strip had them. Read once, as the starting point of the one-time merge.
 */
function loadLegacyTabs(drafts: Record<string, Draft>): OpenTab[] {
  try {
    const grouped = JSON.parse(localStorage.getItem(TABS_KEY) ?? '{}') as Record<string, string[]>
    const order = JSON.parse(localStorage.getItem(TAB_ORDER_KEY) ?? '[]') as unknown
    const open = [...new Set(Object.values(grouped).flat())].filter((id): id is string => typeof id === 'string')
    const available = new Set(open)
    const known = Array.isArray(order) ? order.filter((id): id is string => typeof id === 'string' && available.delete(id)) : []
    const ids = [...known, ...open.filter((id) => available.has(id))]
    return ids.map((id) => (drafts[id] ? { id, draft: sharedDraftOf(drafts[id]!) } : { id }))
  } catch {
    return []
  }
}

function loadOpenTabs(drafts: Record<string, Draft>): OpenTab[] {
  try {
    const raw = localStorage.getItem(OPEN_TABS_KEY)
    if (raw) return asOpenTabs(JSON.parse(raw))
  } catch {
    /* fall back to the old lists */
  }
  const legacy = loadLegacyTabs(drafts)
  persistOpenTabs(legacy)
  return legacy
}

function persistOpenTabs(tabs: OpenTab[]): void {
  try {
    localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(tabs))
  } catch {
    /* ignore quota errors */
  }
}

/** Tabs in the order the user arranged them, independent of their workspace. */
export function orderedTabs(s: State = state): string[] {
  return s.openTabs.map((tab) => tab.id)
}

/**
 * The tabs the strip actually draws, left to right: the shared order, minus
 * ids whose draft or session is not known here (yet). ⌘1…⌘9 count positions in
 * this list, so the number you press is the tab you see there.
 */
export function stripTabs(s: State = state): string[] {
  return orderedTabs(s).filter((id) => s.drafts[id] || s.sessions[id])
}

/** Move one open tab before another (or after it); every device follows. */
export function reorderTab(source: string, target: string, after = false): void {
  if (source === target) return
  const op: TabOp = { op: 'move', id: source, target, after }
  tabOp(op)
}

/* ------------------------------------------------------------------ */
/* The shared tab list                                                 */
/* ------------------------------------------------------------------ */

/**
 * How the tab list is kept in step across devices.
 *
 * The server owns the list (`serverTabs` is its last word). Every change made
 * here is an op (`TabOp`) sent to it and applied locally at once; the list on
 * screen is the server's list with the ops it has not confirmed yet re-applied
 * on top, so a change never flickers back while it is on the wire and a change
 * made elsewhere lands the moment it is broadcast. The ops still pending are
 * exactly the `tabs` commands in the outbox and in flight — the same queue that
 * carries them across a reconnect or a reload.
 *
 * `tabsShared` is false until a server that shares tabs says hello (and stays
 * false with an older one): changes are then applied to the local list only.
 */
let serverTabs: OpenTab[] = []
// A device that has shared before queues its changes for the server even while
// it is still connecting; `hello` settles it either way.
let tabsShared = hasSharedTabs()
/** Ops the server has broadcast the result of but not acknowledged yet. */
const settledTabCids = new Set<string>()

function hasSharedTabs(): boolean {
  try {
    return Boolean(localStorage.getItem(TABS_MIGRATED_KEY))
  } catch {
    return false
  }
}

function pendingTabOps(): TabOp[] {
  const ops: TabOp[] = []
  for (const entry of [...inflight.values(), ...outbox]) {
    const msg = entry.msg
    if (msg.t === 'tabs' && !(msg.cid && settledTabCids.has(msg.cid))) ops.push(msg.op)
  }
  return ops
}

/** Change the shared list: optimistically here, for real on the server. */
function tabOp(op: TabOp): void {
  // Nothing to say when the list already reads that way.
  if (applyTabOp(state.openTabs, op) === state.openTabs) return
  if (tabsShared) send({ t: 'tabs', op })
  else serverTabs = applyTabOp(serverTabs, op)
  reconcileTabs()
}

/**
 * Put the list on screen back in line with the server's plus what is pending,
 * and bring the new-session tabs along: one opened elsewhere gets a draft here,
 * one closed elsewhere loses it. If the tab this device was looking at went
 * away, it falls to its neighbour (the new-session screen when none is left).
 */
function reconcileTabs(): void {
  let list = serverTabs
  for (const op of pendingTabOps()) list = applyTabOp(list, op)
  const drafts = draftsFromTabs(list, state.drafts)
  if (list === state.openTabs && drafts === state.drafts) return
  const before = stripTabs(state)
  persistOpenTabs(list)
  set({ openTabs: list, drafts })
  const active = state.active
  if (!active || !before.includes(active)) return
  const after = stripTabs(state)
  if (after.includes(active)) return
  // Same position: a closed tab gives way to the one on its right (or on its
  // left at the end), and a launched new-session tab to the session it became.
  const next = after[Math.min(before.indexOf(active), after.length - 1)]
  if (next) {
    selectTab(next)
    return
  }
  if (state.sessions[active] && !held.has(active)) send({ t: 'unsubscribe', sessionId: active })
  set({ active: null })
}

function draftsFromTabs(list: OpenTab[], drafts: Record<string, Draft>): Record<string, Draft> {
  let next = drafts
  const edit = (): Record<string, Draft> => (next === drafts ? (next = { ...drafts }) : next)
  const shared = new Map<string, SharedDraft>()
  for (const tab of list) if (tab.draft) shared.set(tab.id, tab.draft)
  for (const [id, spec] of shared) {
    const local = drafts[id]
    if (!local) edit()[id] = { id, kind: 'agent', ...spec }
    else if (local.kind === 'agent' && !local.pendingId && !sameDraft(sharedDraftOf(local), spec)) {
      edit()[id] = { ...local, ...spec }
    }
  }
  // A launching draft is kept until its session arrives; a chooser, or a draft
  // between two folders, has no tab to lose.
  for (const [id, draft] of Object.entries(drafts)) {
    if (tabbedDraft(draft) && !draft.pendingId && !shared.has(id)) delete edit()[id]
  }
  return next
}

/** `openTabs` grouped by workspace (folder + machine); ids not known here yet are left out. */
function groupedTabs(s: Pick<State, 'openTabs' | 'sessions' | 'drafts'>): Record<string, string[]> {
  const grouped: Record<string, string[]> = {}
  for (const { id } of s.openTabs) {
    const session = s.sessions[id]
    const draft = s.drafts[id]
    const key = session ? workspaceKey(session.host, session.cwd) : draft ? placeKey(draft.host, draft.cwd) : ''
    if (key) (grouped[key] ??= []).push(id)
  }
  return grouped
}

function sameGrouping(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => {
    const x = a[key]!
    const y = b[key]
    return Boolean(y) && x.length === y!.length && x.every((id, index) => id === y![index])
  })
}

function loadDefaults(): Record<string, AgentDefaults> {
  try {
    const raw = localStorage.getItem(DEFAULTS_KEY)
    return raw ? (JSON.parse(raw) as Record<string, AgentDefaults>) : {}
  } catch {
    return {}
  }
}

function loadRailOpen(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(RAIL_OPEN_KEY)
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

function loadDocks(): Record<string, Dock> {
  try {
    const raw = localStorage.getItem(DOCKS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, Partial<Dock> & { terminal?: string | null }>
    const docks: Record<string, Dock> = {}
    for (const [agentId, dock] of Object.entries(parsed)) {
      const terminals = Array.isArray(dock.terminals)
        ? dock.terminals.filter((id): id is string => typeof id === 'string')
        : dock.terminal
          ? [dock.terminal]
          : []
      docks[agentId] = {
        terminals,
        active: dock.active && terminals.includes(dock.active) ? dock.active : (terminals[0] ?? null),
        open: Boolean(dock.open),
      }
    }
    return docks
  } catch {
    return {}
  }
}

function persistDefaults(defaults: Record<string, AgentDefaults>): void {
  try {
    localStorage.setItem(DEFAULTS_KEY, JSON.stringify(defaults))
  } catch {
    /* ignore quota errors */
  }
}

/** The remembered choices for a harness, or nothing when it is new to us. */
export function agentDefaultsFor(s: State, harness: HarnessId): Partial<AgentDefaults> {
  return s.defaults[harness] ?? {}
}

function rememberDefaults(
  defaults: Record<string, AgentDefaults>,
  harness: HarnessId,
  patch: Partial<AgentDefaults>,
): Record<string, AgentDefaults> {
  const current = defaults[harness] ?? { model: null, effort: null, permissionMode: 'acceptEdits' }
  const next = { ...defaults, [harness]: { ...current, ...patch } }
  persistDefaults(next)
  return next
}

const initialDrafts = loadDrafts()
const initialTabs = loadOpenTabs(initialDrafts)
serverTabs = initialTabs

const initial: State = {
  connected: false,
  sessions: {},
  drafts: initialDrafts,
  caps: {},
  capsFailed: {},
  harnessUpdateErrors: {},
  events: {},
  live: {},
  answers: {},
  limits: [],
  projects: [],
  machineColors: {},
  toasts: [],
  active: null,
  openTabs: initialTabs,
  tabs: {},
  settings: loadSettings(),
  railOpen: loadRailOpen(),
  dialog: null,
  defaults: loadDefaults(),
  seen: loadSeen(),
  docks: loadDocks(),
  restored: {},
  turns: {},
  editedPrompts: loadEditedPrompts(),
  version: 0,
}

initial.tabs = groupedTabs(initial)

let state: State = initial
const listeners = new Set<() => void>()

function set(patch: Partial<State>): void {
  state = { ...state, ...patch, version: state.version + 1 }
  if (patch.drafts) persistDrafts(state.drafts)
  if (patch.openTabs || patch.sessions || patch.drafts) {
    const tabs = groupedTabs(state)
    if (!sameGrouping(tabs, state.tabs)) {
      state.tabs = tabs
      persistTabs(tabs)
    }
  }
  for (const listener of listeners) listener()
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getState(): State {
  return state
}

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => selector(state),
    () => selector(initial),
  )
}

/**
 * The state the app shell renders from: everything except what streams.
 *
 * A streamed token only changes `live`, and a metrics tick only changes one
 * session's `metrics`; subscribing the whole shell to both re-rendered the rail,
 * the tabs, the top bar and every memo under them several times a second for
 * two small readouts. So this hands back the *previous* snapshot while nothing
 * else moved. The transcript, the composer and the meters that do show those
 * values subscribe to them directly (`useStore((s) => s.live)` and friends).
 */
let shell: State = state

export function shellState(s: State): State {
  if (s !== shell && !onlyStreamingMoved(shell, s)) shell = s
  return shell
}

function onlyStreamingMoved(before: State, after: State): boolean {
  let streamed = false
  for (const key of Object.keys(after) as Array<keyof State>) {
    if (key === 'version' || before[key] === after[key]) continue
    if (key === 'live' || (key === 'sessions' && onlyMetricsMoved(before.sessions, after.sessions))) {
      streamed = true
      continue
    }
    return false
  }
  // A bump that changed nothing in the state is a deliberate redraw of UI state
  // kept outside it (the tab order, see `reorderTab`), so it must get through.
  return streamed
}

function onlyMetricsMoved(before: State['sessions'], after: State['sessions']): boolean {
  const ids = Object.keys(after)
  if (ids.length !== Object.keys(before).length) return false
  return ids.every((id) => {
    const a = before[id]
    const b = after[id]
    if (a === b) return true
    if (!a || !b || Object.keys(a).length !== Object.keys(b).length) return false
    return (Object.keys(b) as Array<keyof SessionSummary>).every((field) => field === 'metrics' || a[field] === b[field])
  })
}

/* ------------------------------------------------------------------ */
/* Derived helpers                                                     */
/* ------------------------------------------------------------------ */

export function agentKey(sessionId: string, agentId?: string | null): string {
  return `${sessionId}:${agentId ?? 'main'}`
}

export function activeSession(s: State): SessionSummary | null {
  return s.active ? (s.sessions[s.active] ?? null) : null
}

/**
 * A workspace is a folder *on a machine*: `/home/app` on this laptop and
 * `/home/app` on a server are two different places, and grouping them together
 * in the rail would be a lie. The key carries the host when there is one.
 */
export function workspaceKey(host: string | null | undefined, cwd: string): string {
  return host ? `${host}:${cwd}` : cwd
}

/**
 * The key for something that may not have a folder yet — a draft between picking
 * a host and picking its directory. It has no workspace until it has a folder,
 * so it gets no group in the rail either.
 */
export function placeKey(host: string | null | undefined, cwd: string): string {
  return cwd ? workspaceKey(host, cwd) : ''
}

/** Split a workspace key back into the machine and the folder, for display. */
export function workspaceParts(key: string): { host: string | null; cwd: string } {
  // The separator is `:/`, which a host name cannot contain and a POSIX path
  // starts with — so a local key (a bare path) never matches.
  const at = key.indexOf(':/')
  if (at > 0) return { host: key.slice(0, at), cwd: key.slice(at + 1) }
  return { host: null, cwd: key }
}

/** True when this workspace lives on the machine the rail is showing. */
export function onMachine(key: string, machine: string | null): boolean {
  return workspaceParts(key).host === machine
}

/**
 * The key one machine's capabilities are stored under. The empty string is this
 * computer, which no host name can be.
 */
export function capsKey(host: string | null | undefined): string {
  return host ?? ''
}

function harnessUpdateKey(harness: HarnessId, host: string | null | undefined): string {
  return `${capsKey(host)}:${harness}`
}

export function harnessUpdateError(s: State, harness: HarnessId, host: string | null | undefined): string | null {
  return s.harnessUpdateErrors[harnessUpdateKey(harness, host)] ?? null
}

/**
 * The capabilities of one machine. Harnesses are looked up on the machine the
 * session will run on — a CLI installed on this laptop is not installed on your
 * server — so a picker asks for *that* machine's answer, and nothing shows until
 * it arrives.
 */
export function capsFor(s: State, host: string | null | undefined): Capabilities | null {
  return offered(s)[capsKey(host)] ?? null
}

/**
 * The catalog exactly as the server sent it, hidden harnesses included.
 *
 * Settings is the one screen that must see what was *found* and not only what is
 * offered — hiding a harness is a choice you have to be able to undo, and a row
 * filtered out of the only screen that can bring it back is a one-way door.
 */
export function rawCapsFor(s: State, host: string | null | undefined): Capabilities | null {
  return s.caps[capsKey(host)] ?? null
}

/**
 * The catalogs with the harnesses you hid taken out — except the ones a session
 * is already running.
 *
 * That exception is the whole point. Hiding a harness is about pickers; a
 * session already open on it still needs its models, its approval modes and its
 * label, and dropping the row would have turned a preference into a session that
 * quietly lost its model list. Order does not matter either: this is computed
 * when read, so a session that arrives after the catalog is still covered.
 *
 * Memoised on the two inputs, because every render asks.
 */
let offeredCache: {
  caps: Record<string, Capabilities>
  sessions: Record<string, SessionSummary>
  out: Record<string, Capabilities>
} | null = null

function offered(s: State): Record<string, Capabilities> {
  if (offeredCache && offeredCache.caps === s.caps && offeredCache.sessions === s.sessions) {
    return offeredCache.out
  }
  const inUse = new Set<string>()
  for (const session of Object.values(s.sessions)) inUse.add(`${capsKey(session.host)}:${session.harness}`)
  const out: Record<string, Capabilities> = {}
  for (const [key, caps] of Object.entries(s.caps)) {
    const kept = caps.harnesses.filter(
      // `enabled === undefined` is an older server, which offered everything.
      (harness) => harness.enabled !== false || inUse.has(`${key}:${harness.id}`),
    )
    out[key] = kept.length === caps.harnesses.length ? caps : { ...caps, harnesses: kept }
  }
  offeredCache = { caps: s.caps, sessions: s.sessions, out }
  return out
}

/**
 * Why a harness is offering no models, in one line for its picker.
 *
 * A list is read from the agent itself, on the machine that runs it, so an empty
 * one has a few very different causes — not installed, never wired, the agent
 * could not answer, or the answer is still on its way — and they all used to look
 * like a single "Default Model" row, which reads as "this harness has one model".
 * Saying which it is costs a line and answers the question the picker raises.
 */
export function modelsWhy(s: State, harness: HarnessId, host?: string | null): string | null {
  const info = capsFor(s, host)?.harnesses.find((item) => item.id === harness)
  const where = host ?? 'this machine'
  if (!info) return `Reading what ${where} has installed…`
  if (info.models.length > 1) return null
  if (!info.wired) return `${HARNESS_LABEL[harness]} is not wired into this server build`
  if (!info.installed) return `Not installed on ${where}`
  // The agent was asked and could not answer: say what it said.
  if (info.modelsNote) return info.modelsNote
  const scan = capsErrorFor(s, host)
  if (scan) return scan
  // Rows are on offer but this machine did not report them (see the adapter):
  // say so, so nobody thinks this is that account's catalog.
  if (info.models.length > 1) return `${HARNESS_LABEL[harness]} on ${where} did not report its models — these are the ones it reports elsewhere`
  return `${HARNESS_LABEL[harness]} is being asked for its models on ${where} — they appear in a moment`
}

/**
 * Whether an image can reach the model a session (or a draft) is running.
 *
 * Two answers are needed, and they are different questions: whether the harness
 * can carry an image at all, and whether *this* model reads one. Command Code
 * with a Claude model and Command Code with a text-only model are not the same
 * thing, and a flag per harness was wrong for one of them either way.
 *
 * A model the catalog does not describe — the concrete id a harness resolved an
 * alias to, usually — falls back to the harness's own answer, which is the
 * better guess than a list that does not mention it.
 */
export function takesImages(
  s: State,
  harness: HarnessId,
  model: string | null,
  host?: string | null,
): { ok: boolean; why: string | null } {
  const info = capsFor(s, host)?.harnesses.find((item) => item.id === harness)
  if (!info) return { ok: true, why: null }
  if (!info.images) {
    return {
      ok: false,
      why: info.imagesNote ?? `${HARNESS_LABEL[harness]} takes text only — images cannot be sent to it`,
    }
  }
  const chosen = info.models.find((item) => item.id === (model ?? ''))
  if (chosen?.images === false) {
    return { ok: false, why: `${chosen.label} does not take images — pick a model that does` }
  }
  return { ok: true, why: null }
}

/**
 * The capabilities that are the server's own — the SSH hosts you enabled, the
 * terminal presets, dictation. They are the same whichever machine is on
 * screen, so this is simply whichever answer we have.
 */
export function serverCaps(s: State): Capabilities | null {
  return s.caps[''] ?? Object.values(s.caps)[0] ?? null
}

/** Everything in a catalog that does not describe the machine it came from. */
type SharedCaps = Omit<Capabilities, 'host' | 'harnesses' | 'probeError'>

function sharedCaps(caps: Capabilities): SharedCaps {
  return {
    presets: caps.presets,
    hosts: caps.hosts,
    availableHosts: caps.availableHosts,
    ...(caps.hostStatus ? { hostStatus: caps.hostStatus } : {}),
    voice: caps.voice,
  }
}

/** Apply a fact that belongs to the server itself to every machine we know. */
function patchAllCaps(patch: Partial<SharedCaps>): void {
  const caps: Record<string, Capabilities> = {}
  for (const [key, value] of Object.entries(state.caps)) caps[key] = { ...value, ...patch }
  set({ caps })
}

export function sessionsByWorkspace(s: State): Array<{ workspace: string; sessions: SessionSummary[] }> {
  const groups = new Map<string, SessionSummary[]>()
  // A docked terminal is an agent's panel, not a place you work: left in, it
  // would appear as a workspace of its own next to the conversation it belongs to.
  const docked = dockedTerminals(s)
  for (const session of Object.values(s.sessions)) {
    if (docked.has(session.id)) continue
    const key = workspaceKey(session.host, session.cwd)
    const list = groups.get(key) ?? []
    list.push(session)
    groups.set(key, list)
  }
  // Sorted by creation, not by last touch: opening a session used to move it to
  // the top, which made the rail reshuffle under the cursor. A new session
  // still appears at the top of its workspace; nothing else ever moves.
  // Recency is not lost, it lives in the workspace menu instead.
  return [...groups.entries()]
    .map(([workspace, sessions]) => ({
      workspace,
      sessions: sessions.sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
        return b.createdAt - a.createdAt
      }),
    }))
    .sort((a, b) => {
      const aTop = Math.max(...a.sessions.map((x) => x.createdAt))
      const bTop = Math.max(...b.sessions.map((x) => x.createdAt))
      return bTop - aTop
    })
}

/* ------------------------------------------------------------------ */
/* Filesystem (read-only, one level at a time)                         */
/* ------------------------------------------------------------------ */

export interface DirEntry {
  name: string
  path: string
  kind: 'dir' | 'file'
  hidden: boolean
}

export interface DirListing {
  path: string
  name: string
  parent: string | null
  entries: DirEntry[]
}

/**
 * One level of a directory. The picker and the file panel both draw what they
 * ask for, which is why neither of them ever walks a tree of your home folder.
 * An empty path asks for the home directory, which is where a folder picker
 * starts when the caller has no folder in mind.
 */
export async function fetchDirectory(path: string, host?: string | null): Promise<DirListing> {
  const params = new URLSearchParams()
  if (path) params.set('path', path)
  if (host) params.set('host', host)
  const query = params.toString() ? `?${params.toString()}` : ''
  const response = await fetch(apiHttp(`/api/fs${query}`))
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `cannot read ${path}`)
  }
  return (await response.json()) as DirListing
}

/**
 * Where a shell starts when it has no folder to start in: the home of the machine
 * it will run on. An empty answer is a machine that could not be asked, and the
 * caller falls back to a folder it already knows.
 */
export async function fetchHome(host?: string | null): Promise<string> {
  const params = new URLSearchParams()
  if (host) params.set('host', host)
  const query = params.toString() ? `?${params.toString()}` : ''
  try {
    const response = await fetch(apiHttp(`/api/home${query}`))
    if (!response.ok) return ''
    const body = (await response.json().catch(() => ({}))) as { path?: string }
    return body.path ?? ''
  } catch {
    return ''
  }
}

/**
 * Enable or disable one SSH host. The candidates come from `~/.ssh/config`;
 * only the ones you enable appear in a picker. The server broadcasts fresh
 * capabilities; reflecting the response here too means the change lands on the
 * click, not on the round trip.
 */
export async function setHost(host: string, enabled: boolean): Promise<void> {
  const response = await fetch(apiHttp('/api/hosts'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ host, enabled }),
  })
  const body = (await response.json().catch(() => ({}))) as {
    hosts?: string[]
    available?: string[]
    status?: HostStatus[]
    error?: string
  }
  if (!response.ok) {
    notify('error', body.error ?? 'could not update hosts')
    return
  }
  if (body.hosts) {
    // Which hosts are enabled is the server's own fact, so it lands on every
    // machine's catalog instead of waiting for one re-broadcast per machine.
    patchAllCaps({
      hosts: body.hosts,
      ...(body.available ? { availableHosts: body.available } : {}),
      ...(body.status ? { hostStatus: body.status } : {}),
    })
  }
}

/**
 * Ask one host whether it is actually there.
 *
 * Only ever for a host that is enabled — the server refuses anything else, and
 * that refusal is the allowlist doing its job rather than an error to work
 * around. The answer carries the transport's own failure kind, so "the machine
 * did not answer" and "it answered and ssh refused the login" stay different
 * things on screen.
 */
export async function checkHost(host: string): Promise<HostStatus | null> {
  try {
    const response = await fetch(apiHttp('/api/host-check'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host }),
    })
    const body = (await response.json().catch(() => ({}))) as Partial<HostStatus> & { error?: string }
    if (!response.ok || !body.host) {
      notify('error', body.error ?? `could not check ${host}`)
      return null
    }
    const status = body as HostStatus
    const current = serverCaps(state)?.hostStatus ?? []
    patchAllCaps({ hostStatus: current.map((item) => (item.host === host ? status : item)) })
    return status
  } catch (err) {
    notify('error', err instanceof Error ? err.message : String(err))
    return null
  }
}

/**
 * Show or hide one harness on one machine.
 *
 * Nothing is changed here: the command goes out with a command id and the switch
 * moves when the server broadcasts the catalog it built from the new preference.
 * Flipping it on the click would be the UI claiming a change the server may
 * refuse — a machine that is no longer enabled, a harness this build dropped.
 */
export function setHarnessEnabled(host: string | null, harness: HarnessId, enabled: boolean): void {
  send({ t: 'set_harness_enabled', host, harness, enabled })
}

/**
 * Choose the colour one machine is recognised by.
 *
 * Nothing moves here: the swatch lights up when the server broadcasts the new
 * map, the same rule the harness switches follow. A colour the server refuses
 * would otherwise leave the panel claiming a choice that was never stored.
 */
export function setMachineColor(host: string | null, color: MachineColorId | null): void {
  send({ t: 'set_machine_color', host, color })
}

/**
 * The colour a machine is drawn in, default included.
 *
 * Every surface that marks a machine goes through this one function, so "nobody
 * chose" looks the same everywhere instead of each caller inventing its own
 * fallback.
 */
export function colorForMachine(s: State, host: string | null | undefined): MachineColor {
  return machineColorOf(s.machineColors, host)
}

/**
 * What a session is doing, as the five states worth telling apart.
 *
 * `SessionStatus` is the authority and this is a reading of it, not a second
 * source: the server is the only thing that knows whether a process is alive,
 * and a UI that decided for itself is how a card goes on saying "running" after
 * the turn ended. `error` is first because it outranks everything — a session
 * that failed while a turn was open is a failure, not a turn — and it is the
 * one state here nobody asked for and everybody needs.
 *
 * `metrics.turnActive` is deliberately *not* allowed to promote a session to
 * working: it is a streaming flag, and a flag left set by a dropped process
 * would pin a spinner to a session that finished — which is exactly the defect
 * the transcript already had to be cured of. The status is what ends.
 */
export type SessionState = 'error' | 'working' | 'starting' | 'ready' | 'stopped'

const SESSION_STATE: Record<SessionSummary['status'], SessionState> = {
  error: 'error',
  running: 'working',
  starting: 'starting',
  idle: 'ready',
  stopped: 'stopped',
}

export function sessionState(session: SessionSummary): SessionState {
  return SESSION_STATE[session.status]
}

/** The word beside the mark, so the colour is never carrying this alone. */
export const SESSION_STATE_WORD: Record<SessionState, string> = {
  error: 'Failed',
  working: 'Working',
  starting: 'Starting',
  ready: 'Ready',
  stopped: 'Stopped',
}

/** Whether a turn is streaming right now — the two states that show motion. */
export function sessionStateMoves(state: SessionState): boolean {
  return state === 'working' || state === 'starting'
}

/**
 * Change the dictation settings, and take the answer as the truth.
 *
 * The server replies with the status it resolved *after* the change, and that is
 * what is written into every catalog: the panel used to re-read a capabilities
 * cache built before the click, which drew the old engine straight back over the
 * new one.
 */
export async function setVoice(patch: Partial<VoiceConfig>): Promise<VoiceStatus | null> {
  try {
    const response = await fetch(apiHttp('/api/voice'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    const body = (await response.json().catch(() => ({}))) as VoiceStatus & { error?: string }
    if (!response.ok || body.error) {
      notify('error', body.error ?? 'could not change the dictation engine')
      return null
    }
    patchAllCaps({ voice: body })
    return body
  } catch (err) {
    notify('error', err instanceof Error ? err.message : String(err))
    return null
  }
}

/** Re-read the dictation status (download progress, last run) into every catalog. */
export async function refreshVoice(): Promise<VoiceStatus | null> {
  try {
    const response = await fetch(apiHttp('/api/voice'))
    if (!response.ok) return null
    const body = (await response.json()) as VoiceStatus
    patchAllCaps({ voice: body })
    return body
  } catch {
    return null
  }
}

/** Download, cancel or delete a whisper.cpp model; the reply is the new status. */
export async function voiceModelAction(
  request: { action: 'download' | 'cancel'; file: string } | { action: 'delete'; path: string },
): Promise<VoiceStatus | null> {
  try {
    const response = await fetch(apiHttp('/api/voice/models'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    })
    const body = (await response.json().catch(() => ({}))) as VoiceStatus & { error?: string }
    if (!response.ok || body.error) {
      notify('error', body.error ?? 'could not change the dictation models')
      return null
    }
    patchAllCaps({ voice: body })
    return body
  } catch (err) {
    notify('error', err instanceof Error ? err.message : String(err))
    return null
  }
}

/** The dictation settings a client may change; mirrors the server's `VoiceConfig`. */
export interface VoiceConfig {
  provider: VoiceProvider
  model: string | null
  endpoint: string | null
  language: string
}

/* ------------------------------------------------------------------ */
/* Harness commands and skills                                         */
/* ------------------------------------------------------------------ */

/**
 * The slash commands and skills a harness offers in one workspace. Unlike the
 * catalog's list (built once, machine-wide), skills are files next to the
 * workspace — and on the host it runs on — so this is asked per session.
 */
export async function fetchCommands(
  harness: HarnessId,
  cwd: string,
  host?: string | null,
): Promise<HarnessCommand[]> {
  const params = new URLSearchParams({ harness })
  if (cwd) params.set('cwd', cwd)
  if (host) params.set('host', host)
  try {
    const response = await fetch(apiHttp(`/api/commands?${params.toString()}`))
    if (!response.ok) return []
    const body = (await response.json()) as { commands?: HarnessCommand[] }
    return body.commands ?? []
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ */
/* Attachments                                                         */
/* ------------------------------------------------------------------ */

/**
 * Upload one pasted image and get back the reference a message carries. The
 * bytes go up once and are then addressed by id, so neither the socket nor the
 * stored timeline ever holds base64.
 */
export async function uploadAttachment(file: File | Blob, name: string): Promise<AttachmentRef> {
  const response = await fetch(apiHttp('/api/attachment'), {
    method: 'POST',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-filename': name },
    body: file,
  })
  const body = (await response.json().catch(() => ({}))) as Partial<AttachmentRef> & { error?: string }
  if (!response.ok || !body.id) throw new Error(body.error ?? 'could not upload the attachment')
  const ref: AttachmentRef = { id: body.id, name: body.name ?? name, mediaType: body.mediaType ?? file.type }
  if (typeof body.lines === 'number') ref.lines = body.lines
  if (typeof body.preview === 'string') ref.preview = body.preview
  uploadedListener?.(ref, file)
  return ref
}

/**
 * Upload a text document (a long paste, a dropped file, or an edit of one).
 * An edit is a new upload with a new id: the bytes behind an id never change,
 * so the old one is simply left for the sweep, like any unsent upload.
 */
export function uploadDocument(text: string, name: string): Promise<AttachmentRef> {
  return uploadAttachment(new Blob([text], { type: DOCUMENT_MEDIA_TYPE }), name)
}

/** A document's full text. */
export async function readDocument(ref: AttachmentRef): Promise<string> {
  const response = await fetch(attachmentUrl(ref))
  if (!response.ok) throw new Error('that document is no longer available')
  return response.text()
}

/**
 * Open a file of a session with the Mac's default app. The server checks it
 * (exists, a regular file, nothing executable) and says why when it refuses.
 */
export async function openSessionFile(sessionId: string, path: string): Promise<void> {
  try {
    const response = await fetch(apiHttp('/api/open-file'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, path }),
    })
    if (response.ok) return
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    toast('error', body.error ?? `could not open ${path}`)
  } catch {
    toast('error', `could not open ${path}: the server did not answer`)
  }
}

let uploadedListener: ((ref: AttachmentRef, bytes: Blob) => void) | null = null

/** Told about every upload with its bytes (see `drafts.ts`, which keeps a copy). */
export function onAttachmentUploaded(listener: (ref: AttachmentRef, bytes: Blob) => void): void {
  uploadedListener = listener
}

/**
 * Where an attachment's bytes live. Fixtures pass an inline data URL, so the
 * component gallery renders images with no server behind it.
 */
export function attachmentUrl(attachment: AttachmentRef): string {
  if (attachment.id.startsWith('data:')) return attachment.id
  return apiHttp(`/api/attachment/${attachment.id}`)
}

/* ------------------------------------------------------------------ */
/* Persistence of local UI preferences                                 */
/* ------------------------------------------------------------------ */

export function updateSettings(patch: Partial<UiSettings>): void {
  const settings = { ...state.settings, ...patch }
  if (isPhoneProfile()) {
    // The phone's appearance goes to its own layer; the shared set keeps the
    // Mac's appearance exactly as it was stored.
    const stored = loadSharedSettings()
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings, ...pickAppearance(stored) }))
    localStorage.setItem(MOBILE_APPEARANCE_KEY, JSON.stringify(pickAppearance(settings)))
  } else {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  }
  applySettings(settings)
  set({ settings })
}

function resolvedTheme(choice: ThemeChoice): 'light' | 'dark' {
  if (choice !== 'system') return choice
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

/* ------------------------------------------------------------------ */
/* Typefaces                                                           */
/* ------------------------------------------------------------------ */

/**
 * The stack the app ships with; a chosen family is put in front of it, so a
 * font missing a glyph still falls back to something rather than to nothing.
 * It mirrors `--font-ui` in the stylesheet on purpose: this is what "no choice"
 * means, and it has to survive the variable being overwritten.
 */
const UI_STACK = `-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', system-ui, sans-serif`

/**
 * The typefaces on offer, and why it is a list rather than "everything you have".
 *
 * Enumerating the installed fonts needs `queryLocalFonts`, which is Chromium
 * only, behind a permission prompt, and simply absent from the WKWebView the
 * desktop build runs in — so on the machine this app is most used on, an
 * "everything installed" picker would be an empty one. Beyond availability, most
 * of a system's fonts are display faces, symbol sets and fonts with no italic or
 * no medium weight, and offering those is offering a choice that makes the
 * interface worse.
 *
 * So: a short list of faces that ship with an OS or come with common developer
 * tooling, every one of them checked against `document.fonts` before it is
 * offered — a font that is not on this machine is never in the list — plus a
 * field for typing the name of one you have and this list does not know, which
 * is checked the same way before it is accepted.
 */
export interface FontChoice {
  /** The CSS family name, which is also the id. */
  family: string
  label: string
  /** What it is good at, in three words, for the row under the name. */
  note: string
}

const UI_FONTS: FontChoice[] = [
  { family: 'Inter', note: 'Neutral · made for screens', label: 'Inter' },
  { family: 'Helvetica Neue', note: 'Classic grotesque', label: 'Helvetica Neue' },
  { family: 'Segoe UI', note: 'Windows system', label: 'Segoe UI' },
  { family: 'Roboto', note: 'Android · Linux system', label: 'Roboto' },
  { family: 'IBM Plex Sans', note: 'Slightly warmer', label: 'IBM Plex Sans' },
  { family: 'Avenir Next', note: 'Geometric · roomy', label: 'Avenir Next' },
]

const CONTENT_FONTS: FontChoice[] = [
  ...UI_FONTS,
  { family: 'New York', note: 'Apple serif · long reading', label: 'New York' },
  { family: 'Charter', note: 'Serif · sturdy on screen', label: 'Charter' },
  { family: 'Iowan Old Style', note: 'Serif · bookish', label: 'Iowan Old Style' },
  { family: 'Georgia', note: 'Serif · everywhere', label: 'Georgia' },
  { family: 'IBM Plex Serif', note: 'Serif · technical', label: 'IBM Plex Serif' },
  { family: 'SF Mono', note: 'Monospace throughout', label: 'SF Mono' },
  { family: 'JetBrains Mono', note: 'Monospace throughout', label: 'JetBrains Mono' },
]

/**
 * Whether this machine can actually render a family.
 *
 * `document.fonts.check` cannot answer this: it only knows about web fonts
 * loaded through `@font-face`, and for any other name it answers `true` — so
 * every family on the list, installed or not, used to be offered, and picking
 * one this machine does not have silently changed nothing. What does answer it
 * is drawing: text set in `"Family", serif` is measured against the same text
 * in plain `serif` (and in `sans-serif` and `monospace`, in case the family
 * happens to be the generic fallback itself). A width that differs from all
 * three baselines' fallback is a font that is really there.
 */
export function fontAvailable(family: string): boolean {
  const name = family.replace(/"/g, '').trim()
  if (!name) return false
  const context = measuringContext()
  if (!context) return true
  const sample = 'mmmmmmmmmmlli WQ@#0123 fiffl'
  return ['serif', 'sans-serif', 'monospace'].some((generic) => {
    context.font = `72px ${generic}`
    const fallback = context.measureText(sample).width
    context.font = `72px "${name}", ${generic}`
    return context.measureText(sample).width !== fallback
  })
}

let canvasContext: CanvasRenderingContext2D | null | undefined
function measuringContext(): CanvasRenderingContext2D | null {
  if (canvasContext !== undefined) return canvasContext
  canvasContext = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  return canvasContext
}

/** The offered fonts, filtered down to the ones this machine has. */
export function availableFonts(kind: 'ui' | 'content'): FontChoice[] {
  return (kind === 'ui' ? UI_FONTS : CONTENT_FONTS).filter((font) => fontAvailable(font.family))
}

/** A family name put in front of the shipped stack, so a missing glyph still resolves. */
function stackWith(family: string | null, base: string): string {
  return family ? `"${family.replace(/"/g, '')}", ${base}` : base
}

export function applySettings(settings: UiSettings): void {
  const root = document.documentElement
  root.dataset.theme = resolvedTheme(settings.theme)
  root.dataset.themeChoice = settings.theme
  // Inline on the root, so the value overrides the `:root` rule in the
  // stylesheet without the stylesheet having to know these settings exist.
  root.style.setProperty('--font-ui', stackWith(settings.uiFont ?? null, UI_STACK))
  // The conversation only, and its own default: "System Default" there is
  // the shipped stack, not whatever the interface face was set to, so the two
  // pickers never move each other. `--font-mono` is deliberately left alone: code,
  // diffs, tool output and the terminal set it directly, so they keep their
  // columns whatever is chosen here (see `settings.css`).
  root.style.setProperty('--font-content', stackWith(settings.contentFont ?? null, UI_STACK))
  root.style.setProperty('--ui-font-size', `${settings.uiFontSize}px`)
  root.style.setProperty('--content-font-size', `${settings.contentFontSize}px`)
  root.style.setProperty('--mono-font-size', `${Math.max(10, settings.contentFontSize - 1.5)}px`)
  root.style.setProperty('--rail-width', `${settings.railWidth}px`)
  root.style.setProperty('--files-width', `${settings.filesWidth}px`)
}

/** Follow the OS theme while the choice stays on "system". */
export function watchSystemTheme(): void {
  const media = matchMedia('(prefers-color-scheme: dark)')
  media.addEventListener('change', () => {
    if (state.settings.theme === 'system') applySettings(state.settings)
  })
}

function loadSeen(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    return raw ? (JSON.parse(raw) as Record<string, number>) : {}
  } catch {
    return {}
  }
}

/** Mark a session as read; used for the unread dot in the sidebar. */
export function markSeen(sessionId: string): void {
  const seen = { ...state.seen, [sessionId]: Date.now() }
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
  } catch {
    /* ignore quota errors */
  }
  set({ seen })
}

export function isUnread(state: State, session: SessionSummary): boolean {
  if (session.status === 'running') return false
  const seen = state.seen[session.id]
  return seen !== undefined ? session.updatedAt > seen : false
}

export function adjustContentFont(delta: number): void {
  const next = Math.min(28, Math.max(10, state.settings.contentFontSize + delta))
  updateSettings({ contentFontSize: next })
}

export function adjustUiFont(delta: number): void {
  const next = Math.min(20, Math.max(9, state.settings.uiFontSize + delta))
  updateSettings({ uiFontSize: next })
}

function persistTabs(tabs: Record<string, string[]>): void {
  localStorage.setItem(TABS_KEY, JSON.stringify(tabs))
}

/* ------------------------------------------------------------------ */
/* Terminal stream                                                     */
/* ------------------------------------------------------------------ */

/**
 * Terminal output is a firehose: it bypasses the store on purpose and goes
 * straight to the views that asked for it.
 */
type TermListener = (
  sessionId: string,
  data: string,
  meta?: { cursor?: { x: number; y: number }; offset?: number },
) => void
const termListeners = new Set<TermListener>()
/** Replayed screens take a different door: they replace, they do not append. */
const termSnapshotListeners = new Set<TermListener>()

export function onTermOutput(listener: TermListener): () => void {
  termListeners.add(listener)
  return () => termListeners.delete(listener)
}

export function onTermSnapshot(listener: TermListener): () => void {
  termSnapshotListeners.add(listener)
  return () => termSnapshotListeners.delete(listener)
}

/** The key an answer's state is held under (see `State.answers`). */
export function answerKey(sessionId: string, toolId: string): string {
  return `${sessionId}:${toolId}`
}

/**
 * Answer a question an agent is waiting on (see the wire message).
 *
 * The card goes to `sending`, not to "sent": what happens to the answer is the
 * server's to say, and it says it in the ack.
 */
export function answerQuestion(sessionId: string, toolId: string, optionId: string): void {
  set({ answers: { ...state.answers, [answerKey(sessionId, toolId)]: 'sending' } })
  send({ t: 'answer_question', sessionId, toolId, optionId })
}

/** How far an answer to one question card has got, if it has been clicked here. */
export function answerStateFor(s: State, sessionId: string, toolId: string): AnswerState | null {
  return s.answers[answerKey(sessionId, toolId)] ?? null
}

/**
 * Whether a question is still open to an answer.
 *
 * Read from the timeline, which is where the server writes the outcome: a result
 * under the question is the question closed — by an answer, by a stop, or by the
 * restart that outlived the process that asked (the text says which). A card
 * only ever invites a click while this says `pending`, which is what stops a
 * restored transcript from offering buttons that lead nowhere.
 */
export function requestStateFor(s: State, sessionId: string, toolId: string): RequestState {
  const native = (s.events[sessionId] ?? []).find(
    (event) => event.ev.k === 'request' && event.ev.requestId === toolId,
  )
  if (native?.ev.k === 'request') return native.ev.state
  const closed = (s.events[sessionId] ?? []).some(
    (event) => event.ev.k === 'tool_result' && event.ev.toolId === toolId,
  )
  if (closed) return 'answered'
  const status = s.sessions[sessionId]?.status
  // No result and no process: nothing is waiting for this answer any more.
  if (status === 'stopped' || status === 'error') return 'expired'
  return 'pending'
}

export function sendTermInput(sessionId: string, data: string): void {
  send({ t: 'term_input', sessionId, data })
}

export function resizeTerm(sessionId: string, cols: number, rows: number): void {
  send({ t: 'term_resize', sessionId, cols, rows })
}

/**
 * Ask for the pane's screen.
 *
 * `history` is for an attach — a tab that just opened, or a panel coming back —
 * where what you had scrolled back to is exactly what is missing. A resync of a
 * screen already on display asks for the screen alone.
 */
export function requestTermSnapshot(sessionId: string, history = false): void {
  send(history ? { t: 'term_snapshot', sessionId, history: true } : { t: 'term_snapshot', sessionId })
}

/* ------------------------------------------------------------------ */
/* Socket                                                              */
/* ------------------------------------------------------------------ */

let socket: WebSocket | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempts = 0
let toastSeq = 0
let warnedOffline = false
/**
 * Queueing before the *first* connection is normal start-up, not a fault: the
 * socket is still opening and nothing is wrong yet. Only a drop after we had a
 * connection is worth telling the user about.
 */
let everConnected = false

function wsUrl(): string {
  if (isDesktop()) return `ws://${window.__SEDANO_API__}/api/ws`
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/api/ws`
}

/** Absolute API URL when the page is not served by the API itself (desktop). */
export function apiHttp(path: string): string {
  return isDesktop() ? `http://${window.__SEDANO_API__}${path}` : path
}

export function connect(): void {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  socket = new WebSocket(wsUrl())

  socket.onopen = () => {
    reconnectAttempts = 0
    warnedOffline = false
    everConnected = true
    set({ connected: true })
    if (state.active) send({ t: 'subscribe', sessionId: state.active })
    // The docked terminals are subscribed too, and a dropped socket takes their
    // subscription with it — without this the panel would sit there, frozen on
    // the screen it had, while its shell kept running on the machine.
    for (const dock of Object.values(state.docks)) {
      if (dock.open) for (const terminal of dock.terminals) send({ t: 'subscribe', sessionId: terminal })
    }
    // And every terminal tab whose view is still mounted, hidden ones included.
    for (const id of held) send({ t: 'subscribe', sessionId: id })
    // The socket is open only now, which is the first moment a request can be
    // sent at all. Capabilities are re-fetched on every (re)connect, for the
    // machine on screen — the harness list is that machine's, not the server's.
    capsAsked.clear()
    loadCaps()
    // Everything the user asked for while we were offline goes out now, in order.
    flushOutbox()
  }

  socket.onclose = (event?: CloseEvent) => {
    // A phone whose pairing was revoked: reloading lets the server show the
    // pairing page, where retrying would only be refused forever.
    if (event?.code === REMOTE_REVOKED_CLOSE) {
      reloadForPairing()
      return
    }
    // Whatever was on the wire never got an answer, so it goes back in the queue
    // rather than being assumed delivered (see `requeueInflight`).
    requeueInflight()
    set({ connected: false })
    if (reconnectTimer) clearTimeout(reconnectTimer)
    // Quick at first — a restart of the local server is back within a second —
    // then easing off to a few seconds, so a server that is simply not running
    // is not dialled more than once a second for as long as the window is open.
    const delay = Math.min(800 * 2 ** reconnectAttempts, 5_000)
    reconnectAttempts += 1
    reconnectTimer = setTimeout(connect, delay)
  }

  socket.onerror = () => {
    /* onclose handles the retry */
  }

  socket.onmessage = (event) => {
    let msg: ServerMsg
    try {
      msg = JSON.parse(String(event.data)) as ServerMsg
    } catch {
      return
    }
    handle(msg)
  }
}

/**
 * Commands the server owes an answer for.
 *
 * These are the ones a user performed deliberately and would notice the loss of:
 * a prompt, a launch, an answer to a question, a stop, a delete. Each carries a
 * command id, is kept until the server acknowledges it by that id, and is
 * replayed on reconnect — the id is what makes the replay safe, because the
 * server recognises a command it has already carried out.
 */
const DURABLE: ReadonlySet<ClientMsg['t']> = new Set([
  'new_session',
  'input',
  'answer_question',
  'cancel_prompt',
  'stop',
  'interrupt',
  'delete_session',
  'set_session_options',
  'rename_session',
  'pin_session',
  'set_session_parent',
  // A preference, but a durable one: the switch in Settings only moves when the
  // server says it moved, so a command lost with the socket would leave a
  // control showing the value it failed to set.
  'set_harness_enabled',
  // A tab opened, closed or moved must reach the other devices even when the
  // socket drops under it (see `reconcileTabs`).
  'tabs',
])

/**
 * Everything else, in order of how little it is worth keeping. A keystroke
 * replayed minutes later lands in whatever the shell is doing by then; a
 * subscription, a scan or a snapshot is re-asked on reconnect anyway. These are
 * what a full queue drops, and they are dropped oldest first.
 */
function droppable(msg: ClientMsg): boolean {
  return !DURABLE.has(msg.t)
}

interface Queued {
  msg: ClientMsg
  /** When it was queued, so a command too stale to mean anything is not replayed. */
  at: number
}

/**
 * Actions asked while offline. They are not dropped: they go out, in order, the
 * moment the socket is back. Terminal geometry coalesces (only the last one per
 * session matters) so a burst of resizes cannot pile up.
 *
 * Mirrored into `localStorage`, because the queue used to live only in this
 * module: reloading the page while the server was down threw away every prompt
 * and every launch waiting in it, without a word.
 */
const OUTBOX_KEY = 'sedano.outbox'
/** Above this the queue is trimmed; see `trimOutbox` for what is allowed to go. */
const OUTBOX_BUDGET = 400
/**
 * How long a queued command still means what it meant. A prompt from ten minutes
 * ago is a prompt the user has moved on from, and replaying it into a session
 * they have since stopped or deleted is worse than admitting it never went.
 */
const OUTBOX_MAX_AGE_MS = 10 * 60 * 1000

let outbox: Queued[] = loadOutbox()

function loadOutbox(): Queued[] {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as Queued[]
    const cutoff = Date.now() - OUTBOX_MAX_AGE_MS
    return parsed.filter((entry) => entry?.msg?.t && entry.at > cutoff && !droppable(entry.msg))
  } catch {
    return []
  }
}

function persistOutbox(): void {
  try {
    // Only the durable half is written: a keystroke or a subscription is not
    // worth carrying across a reload, and writing them would evict what is.
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox.filter((entry) => !droppable(entry.msg))))
  } catch {
    // A full or unavailable storage must not stop the app from queueing in
    // memory, which is still better than dropping the command.
  }
}

/** Warned once per queue overflow, rather than on every message that overflows it. */
let warnedFull = false

/**
 * Keep the queue inside its budget without losing anything that matters.
 *
 * The old rule cut from the head, so the oldest survivor of a burst of
 * keystrokes was whatever had been queued first — which is exactly where the
 * `new_session` of a launch sits. Everything that follows it then names a
 * session the server has never heard of. Now only droppable commands go, oldest
 * first, and a queue that is still over budget with nothing but real actions in
 * it says so instead of quietly eating one.
 */
function trimOutbox(): void {
  if (outbox.length <= OUTBOX_BUDGET) return
  const kept: Queued[] = []
  let toDrop = outbox.length - OUTBOX_BUDGET
  for (const entry of outbox) {
    if (toDrop > 0 && droppable(entry.msg)) {
      toDrop -= 1
      continue
    }
    kept.push(entry)
  }
  outbox = kept
  if (outbox.length > OUTBOX_BUDGET && !warnedFull) {
    warnedFull = true
    toast('warning', `${outbox.length} actions are waiting for the server — none have been lost, but nothing new can be queued safely`)
  }
}

/**
 * The id that makes a retry a retry.
 *
 * Minted once per action and kept across every replay of it, so the server can
 * tell "do this" from "you may already have done this" (see `CommandId`).
 */
function withCommandId(msg: ClientMsg): ClientMsg {
  if (!DURABLE.has(msg.t)) return msg
  const existing = (msg as { cid?: CommandId }).cid
  if (existing) return msg
  return { ...msg, cid: crypto.randomUUID() } as ClientMsg
}

/**
 * Durable commands handed to the socket and not yet acknowledged.
 *
 * `readyState === OPEN` only says the browser accepted the bytes, not that
 * anything received them: a socket whose TCP path is dead stays OPEN until a
 * timeout notices, and every command sent into it in the meantime used to
 * disappear with no queueing and no retry. Holding them until the ack — and
 * putting them back when the socket closes — is what closes that window.
 */
const inflight = new Map<CommandId, Queued>()

export function send(msg: ClientMsg): void {
  const outgoing = withCommandId(msg)
  const cid = (outgoing as { cid?: CommandId }).cid
  if (socket?.readyState === WebSocket.OPEN) {
    if (cid) inflight.set(cid, { msg: outgoing, at: Date.now() })
    socket.send(JSON.stringify(outgoing))
    return
  }
  enqueue({ msg: outgoing, at: Date.now() })
  // Dropping the message on the floor is how "delete does nothing" looked: the
  // click was fine, there was simply nobody to hear it. Say it once per
  // disconnection rather than on every click.
  if (everConnected && state.connected === false && !warnedOffline) {
    warnedOffline = true
    toast('warning', 'Not connected to the sedano server — queued until it is back. Reconnecting…')
  }
}

function enqueue(entry: Queued): void {
  outbox.push(entry)
  if (entry.msg.t === 'term_resize') {
    const { sessionId } = entry.msg
    outbox = outbox.filter(
      (queued) => !(queued.msg.t === 'term_resize' && queued.msg.sessionId === sessionId && queued !== entry),
    )
  }
  trimOutbox()
  persistOutbox()
}

function flushOutbox(): void {
  if (!outbox.length || socket?.readyState !== WebSocket.OPEN) return
  const pending = outbox
  outbox = []
  // The queue is empty again, so the next overflow is worth saying out loud.
  warnedFull = false
  persistOutbox()
  for (const entry of pending) {
    const cid = (entry.msg as { cid?: CommandId }).cid
    if (cid) inflight.set(cid, entry)
    socket.send(JSON.stringify(entry.msg))
  }
}

/**
 * The socket went away with commands on it. They go back to the front of the
 * queue, in the order they were sent, and they keep their command ids — the
 * server answers a repeat with what it answered the first time, so a prompt that
 * did arrive is not sent twice and one that did not is not lost.
 */
function requeueInflight(): void {
  if (!inflight.size) return
  const returning = [...inflight.values()]
  inflight.clear()
  outbox = [...returning, ...outbox]
  trimOutbox()
  persistOutbox()
}

/** Everything a launch that failed was going to do to that session. */
function dropQueuedFor(sessionId: string): void {
  const before = outbox.length
  outbox = outbox.filter((entry) => !('sessionId' in entry.msg && entry.msg.sessionId === sessionId))
  for (const [cid, entry] of inflight) {
    if ('sessionId' in entry.msg && entry.msg.sessionId === sessionId) inflight.delete(cid)
  }
  if (outbox.length !== before) persistOutbox()
}

/** How long each kind stays: something that went wrong needs time to be read. */
const TOAST_MS: Record<ToastLevel, number> = { error: 9000, warning: 6500, info: 4000, success: 3500 }
/** Matches the exit animation of `.toast.leaving`. */
const TOAST_EXIT_MS = 160

function toast(level: ToastLevel, text: string): void {
  const id = ++toastSeq
  set({ toasts: [...state.toasts, { id, level, text }] })
  setTimeout(() => dismissToast(id), TOAST_MS[level])
}

/** Show a transient message from anywhere in the UI. */
export function notify(level: ToastLevel, text: string): void {
  toast(level, text)
}

/** Every key of a per-agent map that belongs to one session (see `agentKey`). */
function withoutSession<T>(map: Record<string, T>, sessionId: string): Record<string, T> {
  const prefix = `${sessionId}:`
  const kept: Record<string, T> = {}
  let dropped = false
  for (const [key, value] of Object.entries(map)) {
    if (key === sessionId || key.startsWith(prefix)) dropped = true
    else kept[key] = value
  }
  return dropped ? kept : map
}

/** Everything this client was holding on behalf of a session that is now gone. */
function forgetSession(sessionId: string): Pick<State, 'events' | 'live' | 'answers' | 'turns'> {
  const events = { ...state.events }
  delete events[sessionId]
  const turns = { ...state.turns }
  delete turns[sessionId]
  return {
    events,
    turns,
    live: withoutSession(state.live, sessionId),
    answers: withoutSession(state.answers, sessionId),
  }
}

function upsertSession(summary: SessionSummary): void {
  const known = Boolean(state.sessions[summary.id])
  const sessions = { ...state.sessions, [summary.id]: summary }
  // A tab is opened in exactly two cases: the client already put this id in the
  // strip because it is the tab you just opened optimistically (⌘T), or a draft
  // is being replaced by the session it launched (handled below, in place).
  // Every other `session` broadcast — and there is one on every status change,
  // forever — must not re-add a tab you closed: that is what made a closed tab
  // come back on its own.
  const replacingDraft = Object.values(state.drafts).some((draft) => draft.pendingId === summary.id)
  const openingHere = !known && state.active === summary.id
  // A session that is not working has nothing left to stream, so a buffer still
  // holding half a turn is a leftover: it can only be drawn as a second answer
  // that never arrives (see the `timeline` case for the same reasoning).
  const live =
    summary.status === 'running' || summary.status === 'starting'
      ? state.live
      : withoutSession(state.live, summary.id)
  set({ sessions, live })
  if (openingHere && !replacingDraft) tabOp({ op: 'open', tab: { id: summary.id } })
  // A session that was opened optimistically (⌘T) is already the active tab, but
  // it did not exist when we asked to subscribe — so its output had nowhere to
  // go. Subscribe the moment the server confirms it.
  if (!known && state.active === summary.id) send({ t: 'subscribe', sessionId: summary.id })
}

/* ------------------------------------------------------------------ */
/* Drafts: the new-tab landing screen                                  */
/* ------------------------------------------------------------------ */

/**
 * Where the tab you are looking at works: the folder and the machine. A new tab
 * opened without an explicit target continues here — including on a server, so
 * ⌘T on a remote terminal gives another shell on the same host, not a local one.
 */
export function activeWorkspace(s: State = state): { host: string | null; cwd: string } {
  if (s.active) {
    const draft = s.drafts[s.active]
    // A draft waiting for a folder has no workspace yet — it must not shadow the
    // one you were last in, or ⌘T on the chooser would have nowhere to open.
    if (draft?.cwd) return { host: draft.host, cwd: draft.cwd }
    const session = s.sessions[s.active]
    if (session) return { host: session.host, cwd: session.cwd }
  }
  return workspaceForMachine(s, s.settings.machine)
}

/**
 * Where work happens on one machine: the folder you last used on it, or the
 * machine itself with no folder yet when it has never been used.
 *
 * This is what makes a new tab belong to the machine you picked in the top-left
 * — `/home/app` on a server must never be inherited from a local path, and a
 * machine you have never opened a folder on starts by asking for one.
 */
export function workspaceForMachine(
  s: State = state,
  machine: string | null = s.settings.machine,
): { host: string | null; cwd: string } {
  const sessions = Object.values(s.sessions)
    .filter((item) => workspaceParts(workspaceKey(item.host, item.cwd)).host === machine)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const recent = sessions[0]
  if (recent) return { host: recent.host, cwd: recent.cwd }
  const draft = Object.values(s.drafts).find((item) => item.host === machine && item.cwd)
  if (draft) return { host: draft.host, cwd: draft.cwd }
  // A fresh local machine still has somewhere obvious to work: the projects we
  // found on it. A server we have never used has no such guess, so it asks.
  if (machine === null && s.projects[0]?.path) return { host: null, cwd: s.projects[0].path }
  return { host: machine, cwd: '' }
}

/**
 * Open or close a workspace group. It lives in the store rather than inside the
 * rail so that creating a tab can open the group it lands in: a new session used
 * to be invisible inside a workspace you had collapsed an hour earlier.
 */
export function setWorkspaceOpen(workspace: string, open: boolean): void {
  if (!workspace || state.railOpen[workspace] === open) return
  const railOpen = { ...state.railOpen, [workspace]: open }
  try {
    localStorage.setItem(RAIL_OPEN_KEY, JSON.stringify(railOpen))
  } catch {
    /* ignore quota errors */
  }
  set({ railOpen })
}

export function openDraft(
  kind: Draft['kind'],
  cwd?: string,
  opts: { pickFolder?: boolean; host?: string | null } = {},
): string {
  const machine = state.settings.machine
  const explicitHost = opts.host !== undefined
  const current = state.active ? (state.sessions[state.active] ?? state.drafts[state.active]) : null
  // A tab opened without an explicit target belongs to the machine you picked in
  // the top-left, in the folder you last used on it. Only a caller that names a
  // host (the palette's local projects, say) gets to point somewhere else.
  const host = explicitHost ? opts.host! : machine
  ensureCaps(host)
  const workspace = explicitHost
    ? (cwd ?? '')
    : cwd ?? (current?.host === machine ? current.cwd : '')
  const key = placeKey(host, workspace)
  // A chooser is a pane, not a tab: until you answer it nothing has been opened,
  // so it gets no tab in the strip and no group in the rail. Answering it (see
  // `updateDraft`) is what opens the tab.
  if (kind !== null && key) setWorkspaceOpen(key, true)
  // A second shortcut press while a fresh, untouched draft is already open must
  // focus it, not pile up another tab that looks identical.
  const existing = Object.values(state.drafts).find(
    (item) => item.kind === kind && item.cwd === workspace && item.host === host && !item.pendingId,
  )
  if (existing) {
    set({ active: existing.id })
    return existing.id
  }
  const id = `draft:${crypto.randomUUID()}`
  const previous = Object.values(state.drafts).sort((a, b) => b.createdAt - a.createdAt)[0]
  const activeSession = state.active ? state.sessions[state.active] : null
  // Same harness as the tab you are in (a terminal does not vote), and the
  // model / effort / approvals that harness was last used with.
  const harness: HarnessId =
    previous?.harness ?? (activeSession && activeSession.kind === 'agent' ? activeSession.harness : 'claude')
  const remembered = state.defaults[harness]
  const draft: Draft = {
    id,
    kind,
    cwd: workspace,
    harness,
    model: remembered?.model ?? previous?.model ?? null,
    effort: remembered?.effort ?? previous?.effort ?? null,
    permissionMode: remembered?.permissionMode ?? previous?.permissionMode ?? 'acceptEdits',
    host,
    needsFolder: opts.pickFolder,
    createdAt: Date.now(),
  }
  set({ drafts: { ...state.drafts, [id]: draft }, active: id })
  if (tabbedDraft(draft)) tabOp({ op: 'open', tab: { id, draft: sharedDraftOf(draft) } })
  return id
}

/**
 * Open a terminal tab, immediately.
 *
 * A terminal has nothing to configure up front — no model, no prompt — so asking
 * through a form first was pure friction. It starts in the folder you are in,
 * with the last preset and host you used.
 */
export function openTerminal(
  s: State = state,
  opts: { cwd?: string; host?: string | null; preset?: string } = {},
): boolean {
  const machine = s.settings.machine
  const explicitHost = opts.host !== undefined
  const active = activeWorkspace(s)
  const host = explicitHost ? opts.host! : machine
  ensureCaps(host)
  // Same rule as a new draft: follow the machine on screen, in the folder used
  // there. A caller that names a host (⌘T inside a terminal) keeps its own.
  const cwd = explicitHost
    ? (opts.cwd ?? '')
    : opts.cwd && active.host === machine
      ? opts.cwd
      : workspaceForMachine(s, machine).cwd
  // A machine with no folder yet cannot start a shell: the caller asks for one.
  if (!cwd) return false
  // A shell opened on a host is that machine's: bring it into view, or the new
  // tab would appear under a machine the rail is not showing.
  if (host !== state.settings.machine) updateSettings({ machine: host })
  // A terminal on a server is a different workspace from the same path here.
  const key = workspaceKey(host, cwd)
  setWorkspaceOpen(key, true)
  // The tab is opened here, with the id the server will confirm, so the terminal
  // is what you are looking at — creating it silently left you on the old tab.
  const id = crypto.randomUUID()
  createSession({
    id,
    harness: 'shell',
    kind: 'terminal',
    cwd,
    host,
    // Deliberately a plain shell, not the last preset: a remembered preset id
    // that no longer resolves (older sessions stored the literal "shell") opened
    // a terminal that never started.
    preset: opts.preset ?? '',
  })
  // Selection only: the subscription is sent when the server confirms the
  // session, otherwise it arrives before the session exists and is dropped.
  set({ active: id })
  tabOp({ op: 'open', tab: { id } })
  return true
}

/**
 * Open a terminal tab. It starts in the home of the machine it runs on — a shell
 * with no folder in mind belongs at the top of your own tree, not in whatever
 * folder you happened to open last — unless the caller names a folder.
 *
 * The home is a question only the target machine can answer (`/root` on a server,
 * `/Users/you` here), so this waits for the answer. When one cannot be had — that
 * machine is down — the folder you last used there is the fallback, and asking is
 * the last resort.
 */
export async function newTerminal(
  s: State = state,
  opts: { cwd?: string; host?: string | null; preset?: string } = {},
): Promise<void> {
  const host = opts.host !== undefined ? opts.host : s.settings.machine
  const cwd = opts.cwd || (await fetchHome(host))
  if (cwd && openTerminal(s, { ...opts, cwd, host })) return
  if (openTerminal(s, opts)) return
  openDraft(null, undefined, { pickFolder: true })
}

/* ------------------------------------------------------------------ */
/* The quick terminal docked in an agent's screen                      */
/* ------------------------------------------------------------------ */

/**
 * Pull the small terminal out of an agent's screen, or put it away.
 *
 * It is a shell in *that agent's* folder on that agent's machine — a quick
 * command belongs where the work is, not in whatever folder the full-size
 * terminal tab happens to sit in — and it is a different session from the one
 * ⌘T opens, so the two never fight over the same tmux pane.
 */
export function toggleDock(agentId: string): void {
  const agent = state.sessions[agentId]
  if (!agent || agent.kind === 'terminal') return
  const dock = state.docks[agentId] ?? { terminals: [], active: null, open: false }
  if (dock.open) {
    saveDock(agentId, { ...dock, open: false })
    return
  }
  const existing = dock.terminals.filter((id) => Boolean(state.sessions[id]))
  if (existing.length) {
    saveDock(agentId, {
      terminals: existing,
      active: dock.active && existing.includes(dock.active) ? dock.active : existing[0]!,
      open: true,
    })
    return
  }
  newDockTerminal(agentId)
}

/** Add another shell tab to an agent's bottom terminal panel. */
export function newDockTerminal(agentId: string): void {
  const agent = state.sessions[agentId]
  if (!agent || agent.kind === 'terminal') return
  const dock = state.docks[agentId] ?? { terminals: [], active: null, open: false }
  const id = crypto.randomUUID()
  // Stored as part of the agent session, not as a session of its own: every
  // client, not only this window, knows it is this dock's (see `syncDocks`).
  createSession({ id, harness: 'shell', kind: 'terminal', cwd: agent.cwd, host: agent.host, preset: '', parentSessionId: agentId })
  saveDock(agentId, { terminals: [...dock.terminals, id], active: id, open: true })
}

export function selectDockTerminal(agentId: string, terminalId: string): void {
  const dock = state.docks[agentId]
  if (!dock?.terminals.includes(terminalId)) return
  saveDock(agentId, { ...dock, active: terminalId })
}

export function closeDockTerminal(agentId: string, terminalId: string): void {
  const dock = state.docks[agentId]
  if (!dock?.terminals.includes(terminalId)) return
  const terminals = dock.terminals.filter((id) => id !== terminalId)
  const index = dock.terminals.indexOf(terminalId)
  const active = dock.active === terminalId
    ? (terminals[Math.min(index, terminals.length - 1)] ?? null)
    : dock.active
  saveDock(agentId, { terminals, active, open: terminals.length ? dock.open : false })
  deleteSession(terminalId)
}

function saveDock(agentId: string, dock: Dock): void {
  const docks = { ...state.docks, [agentId]: dock }
  persistDocks(docks)
  set({ docks })
}

function persistDocks(docks: Record<string, Dock>): void {
  try {
    localStorage.setItem(DOCKS_KEY, JSON.stringify(docks))
  } catch {
    /* ignore quota errors */
  }
}

/**
 * Terminal sessions that belong to an agent's panel rather than to the tab strip.
 *
 * They are ordinary sessions on the server, so every list of sessions — the rail,
 * the palette — has to leave them out: a shell opened to run one command must not
 * turn up as a workspace of its own, and must never be opened full size while the
 * panel is showing it.
 */
export function dockedTerminals(s: State): Set<string> {
  const ids = new Set<string>()
  for (const dock of Object.values(s.docks)) for (const id of dock.terminals) ids.add(id)
  for (const session of Object.values(s.sessions)) if (session.parentSessionId) ids.add(session.id)
  return ids
}

/**
 * Line the local docks up with what the server says each session owns.
 *
 * The server is the record: a terminal it lists under an agent is in that
 * agent's dock here too, whichever window opened it, so the dock comes back
 * when the agent's tab is reopened on any client. The other direction is a
 * migration: a terminal this window remembers docking but the server does not
 * know as a child (an older build made them sessions of their own, and they
 * showed up in every other client's rail) is handed to its agent, once.
 */
function syncDocks(sessions: Record<string, SessionSummary>): void {
  let docks = state.docks
  let changed = false
  for (const session of Object.values(sessions)) {
    const parent = session.parentSessionId
    if (!parent || !sessions[parent]) continue
    const dock = docks[parent] ?? { terminals: [], active: null, open: false }
    if (dock.terminals.includes(session.id)) continue
    const terminals = [...dock.terminals, session.id]
    docks = { ...docks, [parent]: { ...dock, terminals, active: dock.active ?? session.id } }
    changed = true
  }
  for (const [agentId, dock] of Object.entries(docks)) {
    if (sessions[agentId]?.kind !== 'agent') continue
    for (const id of dock.terminals) {
      const terminal = sessions[id]
      if (terminal?.kind === 'terminal' && terminal.parentSessionId === null) {
        send({ t: 'set_session_parent', sessionId: id, parentSessionId: agentId })
      }
    }
  }
  if (!changed) return
  persistDocks(docks)
  set({ docks })
}

/**
 * Drop what a removed session owned: an agent takes its quick terminal with it
 * (the panel that gave it a purpose is gone, and leaving the shell behind is how
 * tmux sessions accumulate on a server), and a docked terminal that was deleted
 * leaves the dock pointing at a fresh shell for next time.
 */
function forgetDock(docks: Record<string, Dock>, removed: string): Record<string, Dock> {
  const next: Record<string, Dock> = {}
  let changed = false
  for (const [agentId, dock] of Object.entries(docks)) {
    if (agentId === removed) {
      for (const terminal of dock.terminals) {
        if (terminal !== removed && state.sessions[terminal]) send({ t: 'delete_session', sessionId: terminal })
      }
      changed = true
      continue
    }
    if (dock.terminals.includes(removed)) {
      const terminals = dock.terminals.filter((id) => id !== removed)
      next[agentId] = {
        ...dock,
        terminals,
        active: dock.active === removed ? (terminals[0] ?? null) : dock.active,
        open: terminals.length ? dock.open : false,
      }
      changed = true
      continue
    }
    next[agentId] = dock
  }
  if (!changed) return docks
  persistDocks(next)
  return next
}

export function updateDraft(id: string, patch: Partial<Draft>): void {
  const draft = state.drafts[id]
  if (!draft) return
  const next = { ...draft, ...patch }

  // Whatever you pick here is what the next session of this harness opens with.
  const touched = patch.model !== undefined || patch.effort !== undefined || patch.permissionMode !== undefined
  const defaults =
    next.kind === 'agent' && touched
      ? rememberDefaults(state.defaults, next.harness, {
          model: next.model,
          effort: next.effort,
          permissionMode: next.permissionMode,
        })
      : state.defaults

  set({ drafts: { ...state.drafts, [id]: next }, defaults })

  // Answering the chooser is the moment something is actually opened: the pane
  // becomes a tab you can close. A draft that loses its folder (another machine,
  // not picked yet) leaves the strip until it has one again. Any other change
  // of its choices is shared, so another device launches what this one shows.
  if (tabbedDraft(next)) tabOp({ op: 'open', tab: { id, draft: sharedDraftOf(next) } })
  else if (tabbedDraft(draft)) tabOp({ op: 'close', id })
}

export function closeDraft(id: string): void {
  const draft = state.drafts[id]
  if (!draft) return
  const key = placeKey(draft.host, draft.cwd)
  const drafts = { ...state.drafts }
  delete drafts[id]
  const patch: Partial<State> = { drafts }
  if (state.active === id) {
    const remaining = key ? (state.tabs[key] ?? []).filter((tab) => tab !== id) : []
    patch.active = remaining[remaining.length - 1] ?? null
  }
  set(patch)
  tabOp({ op: 'close', id })
}

/**
 * Turn a draft into a real session. The id is chosen here so the tab can point
 * at the session immediately, and the server confirms it by name.
 */
export function launchDraft(id: string, prompt?: string, attachments?: AttachmentRef[]): void {
  const draft = state.drafts[id]
  if (!draft) return
  // A chooser tab has no mode yet, so there is nothing to start.
  if (draft.kind === null) return
  const sessionId = crypto.randomUUID()
  const models = capsFor(state, draft.host)?.harnesses.find((item) => item.id === draft.harness)?.models ?? []
  const effort = supportedEffort(models, draft.model, draft.effort)
  // The prompt is kept on the draft until the server confirms the session: a
  // launch that is refused must be able to give it back (see `pendingPrompt`).
  updateDraft(id, { pendingId: sessionId, pendingPrompt: prompt?.trim() || undefined })
  createSession({
    id: sessionId,
    harness: draft.harness,
    kind: draft.kind,
    cwd: draft.cwd,
    model: draft.model,
    effort,
    permissionMode: draft.permissionMode,
    host: draft.host,
    prompt: prompt?.trim() || undefined,
    attachments: attachments?.length ? attachments : undefined,
  })
}

/**
 * Start a fresh session from a handoff without disturbing the source session.
 *
 * It uses a one-off draft as the optimistic tab, just like the ordinary
 * launchpad: the prompt stays recoverable if the server refuses the launch and
 * the tab is replaced in place when the real session is acknowledged.
 */
export function launchTransfer(
  target: Pick<Draft, 'cwd' | 'host' | 'harness' | 'model' | 'effort' | 'permissionMode'>,
  prompt: string,
): string {
  const draftId = `draft:${crypto.randomUUID()}`
  const sessionId = crypto.randomUUID()
  const models = capsFor(state, target.host)?.harnesses.find((item) => item.id === target.harness)?.models ?? []
  const effort = supportedEffort(models, target.model, target.effort)
  const key = placeKey(target.host, target.cwd)
  const draft: Draft = {
    id: draftId,
    kind: 'agent',
    ...target,
    effort,
    createdAt: Date.now(),
    pendingId: sessionId,
    pendingPrompt: prompt.trim(),
  }
  const defaults = rememberDefaults(state.defaults, target.harness, {
    model: target.model,
    effort,
    permissionMode: target.permissionMode,
  })
  setWorkspaceOpen(key, true)
  set({ drafts: { ...state.drafts, [draftId]: draft }, defaults, active: draftId })
  if (tabbedDraft(draft)) tabOp({ op: 'open', tab: { id: draftId, draft: sharedDraftOf(draft) } })
  if (target.host !== state.settings.machine) updateSettings({ machine: target.host })
  createSession({
    id: sessionId,
    harness: target.harness,
    kind: 'agent',
    cwd: target.cwd,
    host: target.host,
    model: target.model,
    effort,
    permissionMode: target.permissionMode,
    prompt: prompt.trim(),
  })
  return draftId
}

/**
 * The machines whose capabilities were already asked for on this connection.
 * One scan per machine is enough until something asks for a refresh.
 */
const capsAsked = new Set<string>()
/** The pending scanner per machine, so a late answer can stop the wait. */
const capsTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * How long a machine's scan may take before we say it never came back. A remote
 * probe is an SSH round trip with a retry behind it, so this is generous on
 * purpose — the point is to stop waiting forever, not to hurry a slow server.
 */
const CAPS_TIMEOUT = 40_000

/**
 * Ask one machine about itself and record that a scan is in flight.
 *
 * `force` rescans instead of taking the server's cached answer: opening an
 * environment means looking at it *now*, and software gets installed and removed
 * between two looks.
 */
function askCaps(host: string | null, force: boolean): void {
  const key = capsKey(host)
  capsAsked.add(key)
  const failed = { ...state.capsFailed }
  delete failed[key]
  set({ capsFailed: failed })
  send({ t: 'list_caps', host, force })
  const previous = capsTimers.get(key)
  if (previous) clearTimeout(previous)
  capsTimers.set(
    key,
    setTimeout(() => {
      capsTimers.delete(key)
      if (state.caps[key]) return
      // The server did not answer about this machine. A build from before
      // per-machine catalogs ignores `host` and answers about this computer
      // instead, which is exactly what leaves a picker empty forever.
      const where = host ?? 'this machine'
      set({
        capsFailed: { ...state.capsFailed, [key]: `the server did not answer about ${where} — restart it` },
      })
    }, CAPS_TIMEOUT),
  )
}

/** Scan one machine again — on connect, on a machine switch, after a change. */
export function loadCaps(host: string | null = state.settings.machine): void {
  askCaps(host, true)
}

/**
 * Scan a machine the first time it is actually looked at. Demand-driven on
 * purpose: probing every host that has a session would be one SSH round trip per
 * server, at startup, for a catalog nobody has asked to see.
 */
export function ensureCaps(host: string | null | undefined): void {
  const key = capsKey(host)
  if (state.caps[key] || capsAsked.has(key)) return
  askCaps(host ?? null, true)
}

/** One selected-harness inspection per machine at a time. */
const harnessInspections = new Map<string, Promise<HarnessUpdateInfo | null>>()

/**
 * Refresh the selected harness rather than merely rescanning the machine PATH.
 * The server opens a token-free protocol session for its current model catalog
 * and checks whether the external ACP executable has a newer stable release.
 */
export function inspectHarness(
  harness: HarnessId,
  host: string | null | undefined,
): Promise<HarnessUpdateInfo | null> {
  const machine = host ?? null
  const key = `${machine ?? ''}:${harness}`
  const existing = harnessInspections.get(key)
  if (existing) return existing
  const request = (async () => {
    try {
      const response = await fetch(apiHttp('/api/harness-check'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host: machine, harness }),
      })
      const body = await response.json() as {
        caps?: Capabilities
        update?: HarnessUpdateInfo | null
        error?: string
      }
      if (!response.ok || !body.caps) throw new Error(body.error ?? `could not inspect ${harness}`)
      set({ caps: { ...state.caps, [capsKey(machine)]: body.caps } })
      if (body.update?.status === 'available') {
        notify(
          'info',
          `${body.update.detail}.`,
        )
      }
      return body.update ?? null
    } catch (error) {
      notify('error', `Could not refresh ${harness}: ${error instanceof Error ? error.message : String(error)}`)
      return null
    } finally {
      harnessInspections.delete(key)
    }
  })()
  harnessInspections.set(key, request)
  return request
}

/** Explicitly update a selected harness adapter, then adopt its fresh catalog. */
export async function updateHarnessAdapter(
  harness: HarnessId,
  host: string | null | undefined,
): Promise<HarnessUpdateInfo | null> {
  const machine = host ?? null
  const key = harnessUpdateKey(harness, machine)
  const cleared = { ...state.harnessUpdateErrors }
  delete cleared[key]
  set({ harnessUpdateErrors: cleared })
  try {
    const response = await fetch(apiHttp('/api/harness-update'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: machine, harness }),
    })
    const body = await response.json() as {
      caps?: Capabilities
      update?: HarnessUpdateInfo | null
      error?: string
    }
    if (!response.ok || !body.caps) throw new Error(body.error ?? `could not update ${harness}`)
    set({ caps: { ...state.caps, [capsKey(machine)]: body.caps } })
    if (body.update?.status !== 'current') {
      throw new Error(body.update?.detail ?? `${harness} was updated but its version could not be verified`)
    }
    notify('success', `${harness} is up to date.`)
    return body.update ?? null
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    set({ harnessUpdateErrors: { ...state.harnessUpdateErrors, [key]: message } })
    notify('error', message)
    return null
  }
}

/** Why a machine's scan failed, or null while it is still running. */
export function capsErrorFor(s: State, host: string | null | undefined): string | null {
  return s.capsFailed[capsKey(host)] ?? null
}

/**
 * What an acknowledged command means for the screen.
 *
 * The command is matched by id, so this is always about the very action the user
 * performed — not about "something failed somewhere", which is all a broadcast
 * toast could ever say.
 */
function onAcked(sent: ClientMsg, ack: Ack): void {
  if (sent.t === 'tabs') {
    settledTabCids.delete(ack.cid)
    if (ack.ok) return
    // Refused: the op is no longer pending, so the list goes back to the server's.
    reconcileTabs()
  }

  if (sent.t === 'answer_question') {
    const key = answerKey(sent.sessionId, sent.toolId)
    const answers = { ...state.answers }
    if (ack.ok) answers[key] = 'answered'
    // Refused: the card goes back to being unanswered, because it is. The reason
    // comes from the server — already answered, no longer pending, session gone.
    else delete answers[key]
    set({ answers })
    if (!ack.ok) toast('error', ack.detail ?? 'that answer was not accepted')
    return
  }

  if (sent.t === 'cancel_prompt' && ack.ok) {
    // Cancelled means "not yet, not like this": the text comes back to where it
    // was written, so taking a prompt out of the queue loses nothing.
    const prompt = (state.events[sent.sessionId] ?? []).find(
      (event) => event.ev.k === 'user' && event.ev.promptId === sent.promptId,
    )
    if (prompt?.ev.k === 'user') restoreToComposer(sent.sessionId, prompt.ev.text, prompt.ev.attachments ?? [])
    return
  }

  if (sent.t === 'new_session' && !ack.ok) {
    const proposed = sent.req.id
    if (proposed) {
      // Nothing that names this session can succeed now, and the tab must stop
      // saying "launching": the draft takes its prompt back (see `pendingPrompt`).
      dropQueuedFor(proposed)
      const drafts = { ...state.drafts }
      let changed = false
      for (const [draftId, draft] of Object.entries(drafts)) {
        if (draft.pendingId !== proposed) continue
        const { pendingId: _dropped, ...rest } = draft
        drafts[draftId] = rest
        changed = true
      }
      if (changed) set({ drafts })
    }
    toast('error', ack.detail ?? 'that session could not be started')
    return
  }

  if (!ack.ok) toast('error', ack.detail ?? 'the server could not carry that out')
}

function handle(msg: ServerMsg): void {
  switch (msg.t) {
    case 'ack': {
      const pending = inflight.get(msg.cid)
      inflight.delete(msg.cid)
      // A command answered twice (the replay of one the server had already
      // carried out) is no longer in flight, and there is nothing left to do.
      if (pending) onAcked(pending.msg, msg)
      return
    }

    case 'hello': {
      const sessions: Record<string, SessionSummary> = {}
      for (const session of msg.sessions) sessions[session.id] = session
      const known = new Set(msg.sessions.map((session) => session.id))
      // What this device had open that still means something: a session the
      // server still has, or a new-session tab.
      const local = state.openTabs.filter((tab) => tab.draft || known.has(tab.id))
      if (msg.tabs) {
        // The server's list is the list. The first time, this device's own tabs
        // from before they were shared are merged into it, once.
        tabsShared = true
        serverTabs = msg.tabs
        if (!hasSharedTabs()) {
          try {
            localStorage.setItem(TABS_MIGRATED_KEY, '1')
          } catch {
            /* ignore quota errors */
          }
          if (local.length) send({ t: 'tabs', op: { op: 'merge', tabs: local } })
        }
      } else {
        // A server that does not share tabs: the list stays this device's.
        tabsShared = false
        serverTabs = local
      }
      // Absent from an older server, and absent is not empty: keeping what we
      // already hold means a reconnect to a server that cannot answer does not
      // repaint every tab in the default colour.
      set({
        sessions,
        limits: msg.limits,
        projects: msg.projects,
        ...(msg.machineColors ? { machineColors: msg.machineColors } : {}),
      })
      reconcileTabs()
      syncDocks(sessions)

      // Only the tabs that were open come back; sessions you are not looking at
      // belong in the rail.
      const open = orderedTabs(state).filter((id) => known.has(id))
      // Nothing was open, so nothing is opened: selecting a session here would
      // attach a shell (or spawn a harness) just because the app started.
      if (!open.length) return
      // An open new-session tab is a place too: a reconnect leaves you on it.
      const onDraft = state.active ? state.drafts[state.active]?.kind === 'agent' : false
      if (!onDraft && (!state.active || !known.has(state.active))) {
        // Otherwise come back to the tab you were on.
        const newest = open
          .map((id) => sessions[id])
          .filter((session): session is SessionSummary => Boolean(session))
          .sort((a, b) => b.updatedAt - a.updatedAt)[0]
        if (newest) selectSession(newest.id)
      }
      return
    }

    case 'sessions': {
      const sessions: Record<string, SessionSummary> = {}
      for (const session of msg.sessions) sessions[session.id] = session
      set({ sessions })
      syncDocks(sessions)
      return
    }

    case 'machine_colors': {
      set({ machineColors: msg.colors })
      return
    }

    case 'caps': {
      // Presets, hosts and voice are the server's own facts and come back with
      // every answer, so they are spread into the catalogs of the other
      // machines; the harness list describes the one machine it was probed on
      // and replaces only that one.
      const shared = sharedCaps(msg.caps)
      const caps: Record<string, Capabilities> = {}
      for (const [known, value] of Object.entries(state.caps)) caps[known] = { ...value, ...shared }
      const key = capsKey(msg.caps.host)
      caps[key] = msg.caps
      const failed = { ...state.capsFailed }
      // An answer about one machine ends the wait for it — and, when it did not
      // carry a machine at all, for every scan still running: that is a server
      // from before this feature, and waiting longer cannot help.
      const legacy = (msg.caps as { host?: string | null }).host === undefined
      for (const pending of legacy ? [...capsTimers.keys()] : [key]) {
        const timer = capsTimers.get(pending)
        if (timer) clearTimeout(timer)
        capsTimers.delete(pending)
        delete failed[pending]
        if (legacy && !caps[pending]) {
          failed[pending] = `the server is an older build — it answered about this computer, not about ${pending}`
        }
      }
      set({ caps, capsFailed: failed })
      return
    }

    case 'term': {
      // Raw terminal frames never touch the store: they would re-render the app
      // on every byte. Terminal views subscribe directly instead. A replayed
      // screen carries where its cursor is and how far the pane's stream had run
      // when it was taken (see the wire).
      const listeners = msg.snapshot ? termSnapshotListeners : termListeners
      const meta = { cursor: msg.cursor, offset: msg.offset }
      for (const listener of listeners) listener(msg.sessionId, msg.data, meta)
      return
    }

    case 'session': {
      upsertSession(msg.session)
      if (msg.session.parentSessionId) syncDocks(state.sessions)
      // A launched draft is replaced by the real session, in place.
      const drafts = { ...state.drafts }
      for (const [draftId, draft] of Object.entries(drafts)) {
        if (draft.pendingId === msg.session.id) {
          delete drafts[draftId]
          const wasActive = state.active === draftId
          const patch: Partial<State> = { drafts }
          if (wasActive) patch.active = msg.session.id
          set(patch)
          // The tab the draft occupied becomes the session's, in place, on
          // every device.
          tabOp({ op: 'replace', from: draftId, to: msg.session.id })
          // The subscription is what carries this session's events; asking for it
          // while the tab still pointed at the draft id meant the first turn of a
          // launched session could play out with nothing listening.
          if (wasActive) send({ t: 'subscribe', sessionId: msg.session.id })
          return
        }
      }
      return
    }

    case 'session_removed': {
      const sessions = { ...state.sessions }
      delete sessions[msg.id]
      // The transcript and the streaming buffers of a session that no longer
      // exists are held for nothing, and a buffer outliving its session is a
      // buffer that can still be drawn (see `forgetSession`).
      // Its tab goes too: the server drops it from the shared list and says so.
      const { events, live, answers, turns: ledger } = forgetSession(msg.id)
      const active = state.active === msg.id ? null : state.active
      // An agent takes the quick terminal of its screen with it (see `forgetDock`).
      const docks = forgetDock(state.docks, msg.id)
      set({ sessions, active, docks, events, live, answers, turns: ledger })
      return
    }

    /**
     * The server's timeline is authoritative up to its cursor. A live event may
     * already have reached this client after the server took that snapshot but
     * before the frame arrived here; replacing the whole list would erase it.
     * Keep only local rows beyond the snapshot cursor, upsert by event id, then
     * restore commit order. With an older server that sends no cursor, retain
     * the historical replace-all behaviour.
     *
     * Streaming buffers still yield to the timeline: they are guesses at what
     * a turn will say, while committed events are what it said.
     */
    case 'timeline': {
      const held = state.events[msg.sessionId] ?? []
      const tail = msg.cursor === undefined ? [] : held.filter((event) => event.seq > msg.cursor!)
      const byId = new Map(msg.events.map((event) => [event.id, event]))
      for (const event of tail) byId.set(event.id, event)
      const next = [...byId.values()].sort((a, b) => a.seq - b.seq)
      const events = { ...state.events, [msg.sessionId]: next }
      const patch: Partial<State> = { events, live: withoutSession(state.live, msg.sessionId) }
      // The ledger comes with the replay: it is the whole of it, so it replaces.
      if (msg.turns) patch.turns = { ...state.turns, [msg.sessionId]: Object.fromEntries(msg.turns.map((turn) => [turn.id, turn])) }
      set(patch)
      return
    }

    case 'turn': {
      // One turn moved (started, waiting on agents, settled): replace it in place.
      const held = state.turns[msg.sessionId] ?? {}
      set({ turns: { ...state.turns, [msg.sessionId]: { ...held, [msg.turn.id]: msg.turn } } })
      return
    }

    case 'event': {
      // A finished turn is the one thing worth a sound: you started it and went
      // to do something else. Cancelled turns are not "done", so they are quiet.
      const finished = msg.event.ev
      if (finished.k === 'result' && resultOutcomeOf(finished) === 'completed') chime()
      const list = state.events[msg.sessionId] ?? []
      const index = list.findIndex((e) => e.id === msg.event.id)
      let next: SessionEvent[]
      if (index >= 0) {
        next = [...list]
        // An event rewritten in place keeps the turn it was first filed under,
        // the same rule the server's store applies (`COALESCE(turn_id, …)`).
        // The live frame carries the turn the *rewrite* happened in: a resumed
        // harness re-announcing every old subagent during a new prompt moved
        // all those cards — and, behind them, the new prompt's turn — to the
        // top of the transcript, where the prompt looked as if it had vanished.
        const kept = list[index]!.turnId
        next[index] = kept && kept !== msg.event.turnId ? { ...msg.event, turnId: kept } : msg.event
      } else {
        next = [...list, msg.event]
      }
      const live = { ...state.live }
      const key = agentKey(msg.sessionId, msg.event.agentId)
      const buffer = live[key]
      const kind = msg.event.ev.k
      if (buffer && (kind === 'assistant' || kind === 'tool' || kind === 'tool_result' || kind === 'result')) {
        live[key] = { ...buffer, text: '' }
      }
      if (buffer && kind === 'thinking') live[key] = { ...buffer, thinking: '' }
      set({ events: { ...state.events, [msg.sessionId]: next }, live })
      return
    }

    case 'delta': {
      const key = agentKey(msg.sessionId, msg.agentId)
      const held = state.live[key]
      // A chunk of a different turn never continues the buffer of the one before
      // it: the previous turn's text is either already on the timeline or was
      // never going to arrive, and appending to it is how two turns became one.
      const current =
        held && (held.turnId === msg.turnId || held.turnId === undefined)
          ? held
          : { text: '', thinking: '' }
      const next: LiveBuffer =
        msg.kind === 'text'
          ? { ...current, text: trimTail(current.text + msg.text), turnId: msg.turnId }
          : { ...current, thinking: trimTail(current.thinking + msg.text), turnId: msg.turnId }
      set({ live: { ...state.live, [key]: next } })
      return
    }

    case 'metrics': {
      const session = state.sessions[msg.sessionId]
      if (!session) return
      const sessions = { ...state.sessions, [msg.sessionId]: { ...session, metrics: msg.metrics } }
      set({ sessions })
      return
    }

    case 'limits': {
      set({ limits: msg.limits })
      return
    }

    case 'projects': {
      set({ projects: msg.projects })
      return
    }

    case 'toast': {
      toast(msg.level, msg.text)
      return
    }

    case 'tabs': {
      // Ours or another device's, this is now the list; what this device has
      // not had confirmed yet is re-applied on top (see `reconcileTabs`).
      if (msg.cid) settledTabCids.add(msg.cid)
      serverTabs = msg.tabs
      reconcileTabs()
      return
    }
  }
}

/** Keep streaming buffers bounded so a long turn cannot bloat memory. */
function trimTail(text: string, limit = 60_000): string {
  return text.length > limit ? text.slice(text.length - limit) : text
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

/**
 * Sessions a mounted terminal view is listening to.
 *
 * A terminal tab stays mounted when you switch away (that is what keeps its
 * scrollback and stops it repainting from blank), so its subscription has to
 * outlive the switch too: without this, `selectSession` would unsubscribe the tab
 * you just left and it would come back with a gap in its output.
 */
const held = new Set<string>()

/** A terminal view mounted for this session: keep its output coming. */
export function retainTerminal(id: string): void {
  held.add(id)
  if (state.sessions[id]) send({ t: 'subscribe', sessionId: id })
}

/**
 * The tab switcher's previews: an agent tab that is not on screen streams its
 * events while its card is shown. Only for agents — a terminal view holds its
 * own subscription through `retainTerminal`.
 */
export function holdPreview(id: string): void {
  if (state.sessions[id]?.kind === 'agent') retainTerminal(id)
}

export function releasePreview(id: string): void {
  if (state.sessions[id]?.kind === 'agent') releaseTerminal(id)
}

/** The view is gone: stop streaming it, unless it is the session on screen. */
export function releaseTerminal(id: string): void {
  held.delete(id)
  if (state.active !== id && state.sessions[id]) send({ t: 'unsubscribe', sessionId: id })
}

export function selectSession(id: string): void {
  if (state.active && state.active !== id && state.sessions[state.active] && !held.has(state.active)) {
    send({ t: 'unsubscribe', sessionId: state.active })
  }
  if (state.sessions[id]) send({ t: 'subscribe', sessionId: id })
  const session = state.sessions[id]
  // Opening a session brings its tab back. Closing a tab only detaches it, so
  // without this you could be looking at a session with no tab to click, close
  // or switch away from — the tab strip and the rail disagreed about what was
  // open, and closing then reopening a tab left the strip looking like a pile.
  set({ active: id })
  if (session) tabOp({ op: 'open', tab: { id } })
  markSeen(id)
}

/**
 * Model, effort and approvals are CLI flags: the server restarts the harness on
 * the next message. Rejected while a turn is running.
 */
export function setSessionOptions(
  sessionId: string,
  patch: { model?: string | null; effort?: EffortLevel | null; permissionMode?: PermissionMode },
): void {
  send({ t: 'set_session_options', sessionId, ...patch })
  // Changing it on a live session is also how you say "this is what I want from
  // now on", so the next session of that harness opens with it.
  const session = state.sessions[sessionId]
  if (session && session.kind === 'agent') {
    set({
      defaults: rememberDefaults(state.defaults, session.harness, {
        model: patch.model !== undefined ? patch.model : session.model,
        effort: patch.effort !== undefined ? patch.effort : session.effort,
        permissionMode: patch.permissionMode ?? session.permissionMode,
      }),
    })
  }
}

export function closeTab(tabId: string): void {
  if (state.drafts[tabId]) {
    closeDraft(tabId)
    return
  }
  const session = state.sessions[tabId]
  const workspace = session ? workspaceKey(session.host, session.cwd) : ''
  // Closed even when the session is gone: a stale id that no session answers
  // for could otherwise never be closed.
  if (!state.openTabs.some((tab) => tab.id === tabId)) return
  if (state.active === tabId) {
    const remaining = workspace ? (state.tabs[workspace] ?? []).filter((id) => id !== tabId) : []
    const next = remaining[remaining.length - 1]
    if (next) selectTab(next)
    else set({ active: null })
  }
  tabOp({ op: 'close', id: tabId })
}

/** Select a tab, whether it is a real session or a draft. */
export function selectTab(tabId: string): void {
  if (state.drafts[tabId]) {
    set({ active: tabId })
    return
  }
  // A docked terminal is shown in the panel of the agent it belongs to. Opening
  // it as a tab too would draw the same session twice — two xterms, two
  // snapshots, and the output landing in whichever asked last.
  if (dockedTerminals(state).has(tabId)) return
  selectSession(tabId)
}

export function createSession(req: {
  id?: string
  harness: SessionSummary['harness']
  kind?: 'agent' | 'terminal'
  cwd: string
  model?: string | null
  effort?: EffortLevel | null
  permissionMode?: PermissionMode
  host?: string | null
  preset?: string | null
  prompt?: string
  attachments?: AttachmentRef[]
  nativeId?: string | null
  parentSessionId?: string | null
}): void {
  send({ t: 'new_session', req })
}

export function sendMessage(sessionId: string, text: string, attachments?: AttachmentRef[]): void {
  send({ t: 'input', sessionId, text, attachments })
}

export function cancelQueuedPrompt(sessionId: string, promptId: string): void {
  send({ t: 'cancel_prompt', sessionId, promptId })
}

export function interruptSession(sessionId: string): void {
  send({ t: 'interrupt', sessionId })
}

export function stopSession(sessionId: string): void {
  send({ t: 'stop', sessionId })
}

export function deleteSession(sessionId: string): void {
  send({ t: 'delete_session', sessionId })
}

export function renameSession(sessionId: string, title: string): void {
  send({ t: 'rename_session', sessionId, title })
}

export function togglePin(sessionId: string, pinned: boolean): void {
  send({ t: 'pin_session', sessionId, pinned })
}

/**
 * Ask the server for limits. `force` bypasses its cache and should be tied to a
 * real click: polling it forcibly is what got us throttled.
 */
export function refreshLimits(force = false): void {
  if (force) notify('info', 'Checking limits…')
  send({ t: 'refresh_limits', force })
}

export function refreshProjects(): void {
  send({ t: 'list_projects' })
}

/** Close a toast early (its ✕) or on time: it animates out, then leaves the list. */
export function dismissToast(id: number): void {
  const target = state.toasts.find((t) => t.id === id)
  if (!target || target.leaving) return
  set({ toasts: state.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t)) })
  setTimeout(() => set({ toasts: state.toasts.filter((t) => t.id !== id) }), TOAST_EXIT_MS)
}

/* ------------------------------------------------------------------ */
/* Dialogs                                                             */
/* ------------------------------------------------------------------ */

let dialogSeq = 0
/** The resolver of the question on screen; the state only carries its shape. */
let pendingDialog: { resolve: (value: string | null) => void } | null = null

function ask(dialog: Omit<DialogState, 'id'>): Promise<string | null> {
  // One question at a time: an earlier one is cancelled rather than orphaned.
  pendingDialog?.resolve(null)
  return new Promise((resolve) => {
    pendingDialog = { resolve }
    set({ dialog: { ...dialog, id: ++dialogSeq } })
  })
}

/** Ask a yes/no question, drawn by the app. Resolves true only on confirm. */
export async function confirmDialog(opts: {
  title: string
  body?: string
  confirmLabel?: string
  danger?: boolean
}): Promise<boolean> {
  const answer = await ask({
    kind: 'confirm',
    title: opts.title,
    body: opts.body,
    value: '',
    confirmLabel: opts.confirmLabel ?? 'Confirm',
    danger: opts.danger ?? false,
  })
  return answer !== null
}

/** Ask for a line of text. Resolves null when cancelled. */
export function promptDialog(opts: {
  title: string
  value?: string
  body?: string
  confirmLabel?: string
}): Promise<string | null> {
  return ask({
    kind: 'prompt',
    title: opts.title,
    body: opts.body,
    value: opts.value ?? '',
    confirmLabel: opts.confirmLabel ?? 'Save',
    danger: false,
  })
}

/** Answer the question on screen. `null` is a cancel. */
export function resolveDialog(value: string | null): void {
  const pending = pendingDialog
  pendingDialog = null
  set({ dialog: null })
  pending?.resolve(value)
}

export function metricsOf(session: SessionSummary | null): SessionMetrics {
  return session?.metrics ?? emptyMetrics()
}

export { emptyMetrics }

/** The composer has taken the restored prompt; nothing is left to hand over. */
export function takeRestoredPrompt(sessionId: string): void {
  if (!state.restored[sessionId]) return
  set({ restored: withoutSession(state.restored, sessionId) })
}

function restoreToComposer(sessionId: string, text: string, attachments: AttachmentRef[]): void {
  const nonce = (state.restored[sessionId]?.nonce ?? 0) + 1
  set({ restored: { ...state.restored, [sessionId]: { text, attachments, nonce } } })
}

function loadEditedPrompts(): Record<string, true> {
  try {
    const raw = localStorage.getItem(EDITED_PROMPTS_KEY)
    return raw ? (JSON.parse(raw) as Record<string, true>) : {}
  } catch {
    return {}
  }
}

/**
 * "Edit" on a prompt the server cancelled: its text and pictures go back into
 * the composer (the same merge as a cancel the user clicked), and its bubble
 * is not drawn again, here or after a reload.
 */
export function editCancelledPrompt(sessionId: string, eventId: string): void {
  const prompt = (state.events[sessionId] ?? []).find((event) => event.id === eventId)
  if (prompt?.ev.k !== 'user') return
  restoreToComposer(sessionId, prompt.ev.text, prompt.ev.attachments ?? [])
  const editedPrompts = { ...state.editedPrompts, [eventId]: true as const }
  try {
    localStorage.setItem(EDITED_PROMPTS_KEY, JSON.stringify(editedPrompts))
  } catch {
    /* ignore quota errors */
  }
  set({ editedPrompts })
}
