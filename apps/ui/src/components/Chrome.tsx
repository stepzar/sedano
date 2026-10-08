import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type {
  EffortLevel,
  HarnessCommand,
  HarnessId,
  MachineColor,
  PermissionMode,
  SessionSummary,
} from '@shared'
import { HARNESS_LABEL, isDocument } from '@shared'
import type { Draft, SessionState, State } from '../store.ts'
import {
  useStore,
  takeRestoredPrompt,
  SESSION_STATE_WORD,
  agentKey,
  attachmentUrl,
  capsFor,
  closeDraft,
  colorForMachine,
  closeTab,
  confirmDialog,
  deleteSession,
  ensureCaps,
  fetchCommands,
  getState,
  interruptSession,
  inspectHarness,
  isUnread,
  loadCaps,
  modelsWhy,
  newTerminal,
  notify,
  onMachine,
  openDraft,
  orderedTabs,
  stripTabs,
  promptDialog,
  rawCapsFor,
  reorderTab,
  renameSession,
  selectTab,
  sendMessage,
  sendTermInput,
  serverCaps,
  sessionState,
  setSessionOptions,
  sessionsByWorkspace,
  setWorkspaceOpen,
  takesImages,
  togglePin,
  updateDraft,
  updateSettings,
  uploadAttachment,
  workspaceKey,
  workspaceParts,
} from '../store.ts'
import { allowFileDrop, caretAtPoint, dropImageToken, imageToken, isLongPaste, sortFiles, syncImageTokens, transferFiles } from '../attachments.ts'
import { useDocuments } from './Documents.tsx'
import { PromptField } from './PromptField.tsx'
import { useComposerDraft } from '../drafts.ts'
import { IconClose } from './Icons.tsx'
import {
  effortCapability,
  findModelChoice,
  modelChoices,
  modelName,
  modelWithEffort,
  effortOptions,
  permissionModeOptions,
  readModel,
} from '../models.ts'
import '../machine.css'
import {
  IconAgent,
  IconBrain,
  IconCaret,
  IconClaude,
  IconCodex,
  IconCommand,
  IconDownload,
  IconFiles,
  IconFreebuff,
  IconGemini,
  IconGrok,
  IconModel,
  IconMoon,
  IconMore,
  IconOpencode,
  IconPlus,
  IconSearch,
  IconSend,
  IconSettings,
  IconShield,
  IconSidebar,
  IconStar,
  IconStop,
  IconSun,
  IconTerminal,
} from './Icons.tsx'
import { MenuSection, MenuTrigger, Select } from './Menu.tsx'
import { LimitsGroup } from './Limits.tsx'
import { Lightbox } from './Overlays.tsx'
import { MicButton } from './Mic.tsx'
import { ACTIVITY_WORD, activeAgentsOf, activityOf, buildRows, livePhaseOf, subagentInfos } from '../view.ts'
import { useAutosizeTextarea } from '../useAutosizeTextarea.ts'
import { useOverflowFade } from '../useOverflowFade.ts'
import { exportConversation } from '../transcriptExport.ts'
import { APPLE } from '../shortcuts.ts'
import { setDrawer, toggleDrawer, useDrawer, useLongPress, useMobile } from '../mobile.ts'
import { AttachButton } from './AttachButton.tsx'
import { TabSwitcher } from './TabSwitcher.tsx'
import { openImport } from './ImportSessions.tsx'
import { archiveSession } from '../imports.ts'

/**
 * The machine's colour, handed to CSS as one custom property.
 *
 * The *id* crosses into the stylesheet, not a hex, so the two theme values live
 * in `machine.css` and switching theme recolours everything with no React
 * involved (see the palette comment there).
 */
function machineStyle(color: MachineColor): React.CSSProperties {
  return { ['--machine' as string]: `var(--machine-${color.id})` } as React.CSSProperties
}

/** The name of a machine as it is written wherever it is named. */
function machineName(host: string | null | undefined): string {
  return host ?? 'This Machine'
}

/** A clickable row should respond to the same keys as a native button. */
function activateOnKey(event: React.KeyboardEvent<HTMLElement>, action: () => void): void {
  if (event.target !== event.currentTarget) return
  if (event.key !== 'Enter' && event.key !== ' ') return
  event.preventDefault()
  action()
}

/**
 * The dot that says which machine something belongs to. Never alone: the name
 * it marks is always beside it, because this hue is the one thing in the
 * interface a reader may simply not be able to see.
 */
function MachineDot({ color, host }: { color: MachineColor; host: string | null | undefined }) {
  return (
    <span
      className="machine-dot"
      style={machineStyle(color)}
      title={`${machineName(host)} — ${color.label}`}
      aria-hidden
    />
  )
}

/**
 * What a session is doing, as one mark.
 *
 * `sessionState` decides *what* (see `store.ts`); this decides how big. In the
 * sidebar's metadata line has room to make the state explicit: a restrained
 * amber ring moves while work is in progress, green is done, and grey is no
 * longer available. The tab strip uses the same small mark, so an agent never
 * changes meaning merely because it is seen in a different part of the app.
 *
 * The state is in the tooltip in words on every surface, so the mark is never
 * the only thing saying it.
 */
function SessionMark({ state, orb = false, host, unread = false }: { state: SessionState; orb?: boolean; host?: string | null; unread?: boolean }) {
  const word = unread ? `${SESSION_STATE_WORD[state]} · new output` : SESSION_STATE_WORD[state]
  const description = host === undefined ? word : `${word} · ${machineName(host)}`
  return <span className={`sess-state ${state}${orb ? ' sidebar' : ''}${unread ? ' unread' : ''}`} title={description} role="img" aria-label={description} />
}

/**
 * The mark that goes with a harness, so a session card says which CLI it is at a
 * glance instead of only in words.
 */
export function HarnessMark({ harness, kind, size = 12 }: { harness: HarnessId; kind: SessionSummary['kind']; size?: number }) {
  const props = { size, className: 'harness-mark' }
  if (kind === 'terminal' || harness === 'shell') return <IconTerminal {...props} />
  switch (harness) {
    case 'claude':
      return <IconClaude {...props} />
    case 'codex':
      return <IconCodex {...props} />
    case 'commandcode':
      return <IconCommand {...props} />
    case 'gemini':
      return <IconGemini {...props} />
    case 'grok':
      return <IconGrok {...props} />
    case 'opencode':
      return <IconOpencode {...props} />
    case 'freebuff':
      return <IconFreebuff {...props} />
    default:
      return <IconAgent {...props} />
  }
}

const PERMISSION_LABEL: Record<PermissionMode, string> = {
  default: 'Ask',
  acceptEdits: 'Accept Edits',
  auto: 'Auto',
  manual: 'Manual',
  plan: 'Plan Only',
  bypassPermissions: 'Bypass All',
}

export function baseName(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

export function shortPath(path: string): string {
  const parts = path.split('/').filter(Boolean)
  if (parts.length <= 2) return path
  return `…/${parts.slice(-2).join('/')}`
}

function relTime(at: number): string {
  const diff = Date.now() - at
  if (diff < 60_000) return 'Now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h`
  return `${Math.round(diff / 86_400_000)}d`
}

export function tabTitle(state: State, tabId: string): string {
  const draft = state.drafts[tabId]
  if (draft) return draft.kind === null ? 'New Tab' : 'New Session'
  const session = state.sessions[tabId]
  if (!session) return 'Session'
  return sessionLabel(session)
}

function sessionLabel(session: SessionSummary): string {
  return session.title || (session.kind === 'terminal' ? 'Terminal' : HARNESS_LABEL[session.harness])
}

/**
 * The ordinal of a session among the *open tabs* that share its title, or null
 * when it is the only one. Three shells in one folder are named identically by
 * the harness, and a strip of identical tabs cannot be told apart; the number
 * sits before the label, where truncation cannot eat it.
 *
 * Counting open tabs rather than every session with that name is what makes the
 * numbers worth reading: close two of three and the last one is 1, not 3. A
 * session with no tab is not in the strip, so it carries no number.
 */
export function sessionOrdinal(state: State, sessionId: string): number | null {
  const session = state.sessions[sessionId]
  if (!session) return null
  const label = sessionLabel(session)
  const tabs = (state.tabs[workspaceKey(session.host, session.cwd)] ?? [])
    .map((id) => state.sessions[id])
    .filter((other): other is SessionSummary => Boolean(other) && sessionLabel(other) === label)
  if (tabs.length < 2) return null
  const index = tabs.findIndex((other) => other.id === sessionId)
  return index < 0 ? null : index + 1
}

/* ------------------------------------------------------------------ */
/* Title bar                                                           */
/* ------------------------------------------------------------------ */

/**
 * One window, one machine at a time.
 *
 * Where you are is two things — a machine and a folder — and this is the machine
 * half: pick this computer or one of your servers, and everything below (the
 * rail) shows that machine's workspaces. Nothing is opened and no window is
 * added; it is a profile switch, not a new session.
 */
function MachineMenu({ state }: { state: State }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const current = state.settings.machine
  // The hosts you enabled are the server's own list, identical on every machine.
  const hosts = serverCaps(state)?.hosts ?? []

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    // Captured and marked handled, so the Esc that closes this does not also
    // reach the app's Esc (which interrupts the running turn).
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const pick = (machine: string | null) => {
    setOpen(false)
    updateSettings({ machine })
    // The harnesses belong to the machine on screen, so its catalog is (re)asked
    // for here — otherwise the picker would keep offering what the machine you
    // just left has installed.
    loadCaps(machine)
    // A tab that is still choosing follows the machine: the chooser is about to
    // start a session, and it must start it on the machine you just picked.
    const active = getState().active
    const draft = active ? getState().drafts[active] : null
    if (draft) updateDraft(draft.id, { host: machine, cwd: '', needsFolder: draft.kind !== null })
  }

  return (
    <div className="menu" ref={box}>
      <button className="crumb" onClick={() => setOpen((value) => !value)} title="Which machine to show">
        {/* The same mark the tabs of this machine carry, so the top bar and the
            strip below it are visibly about the same thing. */}
        <MachineDot color={colorForMachine(state, current)} host={current} />
        <span className="machine-name">{current ?? 'This Machine'}</span>
        <span className={`caret${open ? ' open' : ''}`}>
          <IconCaret size={17} />
        </span>
      </button>
      {open ? (
        <div className="menu-pop">
          <div className="menu-title">Machine</div>
          <button className={`menu-item${current === null ? ' current' : ''}`} onClick={() => pick(null)}>
            <MachineDot color={colorForMachine(state, null)} host={null} />
            <span className="menu-item-name">This Machine</span>
            <span className="spacer" />
            {current === null ? <span className="check">✓</span> : null}
          </button>
          {hosts.map((host) => (
            <button
              key={host}
              className={`menu-item${current === host ? ' current' : ''}`}
              onClick={() => pick(host)}
            >
              <MachineDot color={colorForMachine(state, host)} host={host} />
              <span className="menu-item-name mono">{host}</span>
              <span className="spacer" />
              {current === host ? <span className="check">✓</span> : null}
            </button>
          ))}
          {!hosts.length ? (
            <div className="menu-empty">No servers enabled — pick them in Settings → Terminal.</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function TopBar({
  state,
  onOpenPalette,
  onOpenSettings,
}: {
  state: State
  onOpenPalette: () => void
  onOpenSettings: () => void
}) {
  const active = state.active ? state.sessions[state.active] : null
  const draft = state.active ? state.drafts[state.active] : null
  const cwd = active?.cwd ?? draft?.cwd ?? ''
  // Where the tab on screen runs: its own machine, or — with nothing open —
  // the one picked in the machine menu.
  const host = active ? active.host : draft ? draft.host : state.settings.machine
  const project = cwd ? baseName(cwd) || cwd : 'No Workspace'
  const themeChoice = state.settings.theme
  const unhandled = serverCaps(state)?.unhandledEvents?.length ?? 0
  const isDark =
    themeChoice === 'dark' ||
    (themeChoice === 'system' &&
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-color-scheme: dark)').matches)

  return (
    <div className="bar" data-tauri-drag-region>
      <div className="bar-side bar-left" data-tauri-drag-region>
        <span className="brand" data-tauri-drag-region>
          sedano
        </span>
        <MachineMenu state={state} />
      </div>
      {/* Where you are, in the middle where the eye lands: the machine, the
          project folder and its branch. The full path is one hover away; the
          pill itself opens search. */}
      <button
        className="location-pill"
        onClick={onOpenPalette}
        title={`${cwd ? `${host ? `${host}:` : ''}${cwd}` : 'No workspace'}\nSearch everything (⌘K)`}
      >
        <span className="env-chip" style={machineStyle(colorForMachine(state, host))}>
          <span className="env-dot" aria-hidden />
          <span className="env-name">{machineName(host)}</span>
        </span>
        <IconSearch size={15} className="pill-search" />
        <span className="project-name">{project}</span>
        {active?.gitBranch ? <span className="chip mono git-chip">{active.gitBranch}</span> : null}
      </button>
      <div className="bar-side bar-right" data-tauri-drag-region>
      <div className="bar-actions">
        {/* Theme is its own control, beside Settings rather than inside it. */}
        <button
          className="icon-btn theme-btn"
          onClick={() => updateSettings({ theme: isDark ? 'light' : 'dark' })}
          title={isDark ? 'Switch to the light theme' : 'Switch to the dark theme'}
        >
          {isDark ? <IconMoon /> : <IconSun />}
        </button>
        <button
          className="icon-btn settings-btn"
          onClick={onOpenSettings}
          title={unhandled ? `Settings (⌘,) — ${unhandled} unhandled event${unhandled > 1 ? 's' : ''}` : 'Settings (⌘,)'}
        >
          <IconSettings />
          {/* Something a harness said that sedano cannot show yet: worth one
              quiet number, found under Settings › Advanced. */}
          {unhandled ? <span className="icon-badge">{unhandled}</span> : null}
        </button>
        {/* Only when something is wrong: a green "live" light on every second
            of the day is noise, and it made people ask what it was for. */}
        {state.connected ? null : (
          <span className="chip warn" title="The local sedano server is unreachable — retrying">
            <span className="dot error" />
            offline
          </span>
        )}
      </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Rail                                                                */
/* ------------------------------------------------------------------ */

/**
 * Right-click menu for a session: the things you do *to* a session rather than
 * *with* it. Right-click used to toggle the pin silently, which is not a thing
 * a context menu is allowed to do to you.
 */
function SessionMenu({
  session,
  at,
  onClose,
}: {
  session: SessionSummary
  at: { x: number; y: number }
  onClose: () => void
}) {
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) onClose()
    }
    // Captured and marked handled, so the Esc that closes this does not also
    // reach the app's Esc (which interrupts the running turn).
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])

  const rename = async () => {
    onClose()
    const next = await promptDialog({ title: 'Rename Session', value: session.title })
    if (next?.trim()) renameSession(session.id, next.trim())
  }

  const remove = async () => {
    onClose()
    // What actually happens, in the words of the thing on screen. It used to say
    // "tmux", which is how the terminal is built and not something anybody needs
    // to know at the moment they are deciding whether to delete a tab.
    const note =
      session.kind === 'terminal'
        ? 'The shell it is running stops, and anything still running in it is ended.'
        : 'Its transcript is removed from this workspace.'
    const ok = await confirmDialog({
      title: `Delete “${session.title || session.id}”?`,
      body: note,
      confirmLabel: 'Delete',
      danger: true,
    })
    if (ok) deleteSession(session.id)
  }

  return (
    // Kept on screen: the row can sit near the bottom or the right edge.
    <div
      className="ctx-pop"
      ref={box}
      // Rendered inside the row it is for: a tap on an item must not also count
      // as a tap on the row (which opened the session and shut the drawer).
      onClick={(event) => event.stopPropagation()}
      style={{
        left: Math.min(at.x, Math.max(0, window.innerWidth - 200)),
        top: Math.min(at.y, Math.max(0, window.innerHeight - 150)),
      }}
    >
      <button className="ctx-item" onClick={rename}>
        Rename…
      </button>
      <button
        className="ctx-item"
        onClick={() => {
          togglePin(session.id, !session.pinned)
          onClose()
        }}
      >
        {session.pinned ? 'Unpin From Top' : 'Pin To Top'}
      </button>
      {session.kind === 'agent' ? (
        <button
          className="ctx-item"
          title="Hide it from the sidebar. Nothing is deleted; restore it from Import Sessions…"
          onClick={() => {
            onClose()
            void archiveSession(session)
          }}
        >
          {session.status === 'running' || session.status === 'starting' ? 'Stop And Archive' : 'Archive'}
        </button>
      ) : null}
      <div className="ctx-sep" />
      <button className="ctx-item danger" onClick={remove}>
        Delete{session.kind === 'terminal' ? ' (and its shell)' : ''}
      </button>
    </div>
  )
}

function SessionRow({ session, state }: { session: SessionSummary; state: State }) {
  const unread = isUnread(state, session)
  const label = tabTitle(state, session.id)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const longPress = useLongPress()
  // On a phone the rail is a drawer over the pane: picking a session is also
  // closing it, or the choice would stay hidden behind it.
  const open = () => {
    selectTab(session.id)
    setDrawer(false)
  }
  return (
    <div
      className={`session-item${state.active === session.id ? ' active' : ''}`}
      role="button"
      tabIndex={0}
      aria-current={state.active === session.id ? 'page' : undefined}
      onClick={open}
      onKeyDown={(event) => activateOnKey(event, open)}
      {...longPress(setMenu)}
      onContextMenu={(event) => {
        event.preventDefault()
        setMenu({ x: event.clientX, y: event.clientY })
      }}
      title={`${label}\n${SESSION_STATE_WORD[sessionState(session)]} · ${machineName(session.host)}\n${session.cwd}${session.resumeHint ? `\n${session.resumeHint}` : ''}`}
    >
      <div className="title">
        {sessionOrdinal(state, session.id) ? <span className="ord">{sessionOrdinal(state, session.id)}</span> : null}
        <span className="title-text">{label}</span>
      </div>
      <div className="meta">
        {/* The sidebar is where the state was asked for, so it is the surface
            that gets the app's own motion rather than a smaller stand-in. */}
        <SessionMark state={sessionState(session)} orb />
        <HarnessMark harness={session.harness} kind={session.kind} />
        <span>{session.kind === 'terminal' ? 'Terminal' : HARNESS_LABEL[session.harness]}</span>
        {session.model ? (
          <>
            <span className="sep">·</span>
            {/* The resolved id read as a name, with the id itself on hover: what
                ran is the truth, and it is still one pointer away. */}
            <span title={session.model}>{modelName(session.model)}</span>
          </>
        ) : null}
        <span className="sep">·</span>
        <span>{relTime(session.updatedAt)}</span>
      </div>
      <div className={`right${session.pinned ? ' always' : ''}`}>
        {unread ? <span className="dot" /> : null}
        <button
          className={`pin-btn${session.pinned ? ' on' : ''}`}
          title={session.pinned ? 'Unpin' : 'Pin'}
          onClick={(event) => {
            event.stopPropagation()
            togglePin(session.id, !session.pinned)
          }}
        >
          <IconStar size={14} fill={session.pinned ? 'currentColor' : 'none'} />
        </button>
      </div>
      {menu ? <SessionMenu session={session} at={menu} onClose={() => setMenu(null)} /> : null}
    </div>
  )
}

function WorkspaceHeader({
  workspace,
  sessions,
  expanded,
  running,
  onToggle,
}: {
  workspace: string
  sessions: SessionSummary[]
  expanded: boolean
  running: number
  onToggle: () => void
}) {
  // Deleting a workspace means deleting every session in it, so the first click
  // arms and the second one acts — never a single stray click.
  const [confirming, setConfirming] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const count = sessions.length
  // The key is `host:/path`. The rail only lists the machine picked top-left,
  // so the header shows just the folder; the machine is in the tooltip.
  const { host, cwd: folder } = workspaceParts(workspace)
  const name = baseName(folder) || folder
  return (
    <div
      className="rail-title workspace"
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={(event) => activateOnKey(event, onToggle)}
      onContextMenu={(event) => {
        event.preventDefault()
        setMenu({ x: event.clientX, y: event.clientY })
      }}
      title={host ? `${host}:${folder}` : folder}
    >
      <span className="chevron" style={{ transform: expanded ? 'rotate(90deg)' : 'none' }}>
        ›
      </span>
      <span className="workspace-name">{name}</span>
      {running ? <span className="dot running" /> : null}
      <span className="count">{count}</span>
      <button
        className={`ws-delete${confirming ? ' armed' : ''}`}
        title={
          confirming
            ? `Click again to delete ${count} tab${count === 1 ? '' : 's'}`
            : 'Delete this workspace (every session in it)'
        }
        onClick={(event) => {
          event.stopPropagation()
          if (!confirming) {
            setConfirming(true)
            setTimeout(() => setConfirming(false), 4000)
            return
          }
          setConfirming(false)
          for (const session of sessions) deleteSession(session.id)
        }}
      >
        {confirming ? 'confirm' : <IconClose size={12} />}
      </button>
      {menu ? (
        <WorkspaceMenu at={menu} onClose={() => setMenu(null)} onImport={() => openImport({ cwd: folder, host })} />
      ) : null}
    </div>
  )
}

/** Right-click menu for a workspace header. */
function WorkspaceMenu({ at, onClose, onImport }: { at: { x: number; y: number }; onClose: () => void; onImport: () => void }) {
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) onClose()
    }
    // Captured and marked handled, so the Esc that closes this does not also
    // reach the app's Esc (which interrupts the running turn).
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [onClose])
  return (
    <div
      className="ctx-pop"
      ref={box}
      onClick={(event) => event.stopPropagation()}
      style={{
        left: Math.min(at.x, Math.max(0, window.innerWidth - 200)),
        top: Math.min(at.y, Math.max(0, window.innerHeight - 60)),
      }}
    >
      <button
        className="ctx-item"
        onClick={() => {
          onClose()
          onImport()
        }}
      >
        Import Sessions…
      </button>
    </div>
  )
}

/** Up to this many workspaces are all shown open. */
const RAIL_OPEN_ALL = 6
/** Sessions shown per workspace before "Show N more". */
const RAIL_RECENT = 3

/**
 * The rows a workspace shows: its newest few, plus the one on screen if it is
 * older than those — the session you are in is never hidden behind "more".
 */
function railRows(sessions: SessionSummary[], all: boolean, active: string | null): SessionSummary[] {
  if (all || sessions.length <= RAIL_RECENT) return sessions
  const recent = sessions.slice(0, RAIL_RECENT)
  const current = sessions.find((session) => session.id === active)
  return current && !recent.includes(current) ? [...recent, current] : recent
}

export function Rail({ state }: { state: State }) {
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState<Record<string, boolean>>({})
  const searchField = useRef<HTMLInputElement>(null)
  const total = useMemo(() => Object.keys(state.sessions).length, [state.sessions])

  const machine = state.settings.machine

  // The rail is what you have actually started: sessions, one group per folder
  // and machine. A tab that has not been launched yet — the chooser, or the
  // draft you are still typing into — is deliberately not here, because until
  // the first message there is nothing to come back to. It lives in the strip.
  //
  // The rail is a view of one machine too: the folder `/home/app` here and the
  // same path on a server are different workspaces, and mixing them would be
  // the confusion the machine selector exists to remove.
  const groups = useMemo(
    () => sessionsByWorkspace(state).filter((group) => onMachine(group.workspace, machine)),
    // What `sessionsByWorkspace` reads: re-grouping on every streamed token was
    // work for nothing.
    [state.sessions, state.docks, machine],
  )

  const needle = query.toLowerCase().trim()
  const filtered = useMemo(() => {
    if (!needle) return groups
    return groups
      .map((group) => ({
        ...group,
        sessions: group.sessions.filter(
          (session) =>
            session.title.toLowerCase().includes(needle) ||
            session.cwd.toLowerCase().includes(needle) ||
            (session.model ?? '').toLowerCase().includes(needle),
        ),
      }))
      .filter((group) => group.sessions.length > 0)
  }, [groups, needle])

  const pinned = useMemo(
    () => Object.values(state.sessions).filter((session) => session.pinned).sort((a, b) => b.updatedAt - a.updatedAt),
    [state.sessions],
  )

  // The workspace you came back for: the newest one, whose group opens so your
  // sessions are on screen instead of behind a header.
  const newestWorkspace = useMemo(
    () => [...Object.values(state.sessions)].sort((a, b) => b.updatedAt - a.updatedAt)[0]?.cwd ?? null,
    [state.sessions],
  )
  // The workspace the active tab lives in — a draft counts, which is what makes
  // a brand new tab show up expanded instead of hidden inside a closed group.
  // A chooser with no folder yet has no workspace of its own, so it borrows the
  // newest one: the front door should not hide everything behind it.
  const activeWorkspace = state.active
    ? (state.drafts[state.active]?.cwd || state.sessions[state.active]?.cwd || newestWorkspace)
    : null

  const fallbackWorkspace = state.active ? null : newestWorkspace

  const isOpen = (workspace: string, list: SessionSummary[]): boolean => {
    if (needle) return true
    // An explicit choice always wins — this is the group you clicked shut.
    const explicit = state.railOpen[workspace]
    if (explicit !== undefined) return explicit
    // A machine with a handful of workspaces shows them all open: each one is
    // at most a few rows (see RAIL_RECENT below), so nothing is hidden for no reason.
    if (groups.length <= RAIL_OPEN_ALL) return true
    // Otherwise: closed by default, except the workspace you are working in,
    // which is what keeps fifty folders from filling the sidebar.
    if (workspace === activeWorkspace || workspace === fallbackWorkspace) return true
    return list.some((session) => session.id === state.active)
  }

  const toggle = (workspace: string, current: boolean) => {
    setWorkspaceOpen(workspace, !current)
  }

  // A phone shows the rail as a drawer, open only while asked for (see `mobile.ts`).
  const mobile = useMobile()
  const drawer = useDrawer()
  const shown = mobile ? drawer : state.settings.railVisible
  const className = mobile ? `rail drawer${drawer ? ' open' : ''}` : `rail${shown ? '' : ' hidden'}`

  return (
    <div className={className} aria-hidden={!shown}>
      <div className="rail-inner">
        <div className="rail-search">
          <IconSearch size={16} />
          <input
            ref={searchField}
            aria-label="Search sessions"
            placeholder="Search sessions"
            value={query}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.stopPropagation()
                setQuery('')
              }
            }}
          />
          {query ? (
            <button
              type="button"
              className="rail-search-clear"
              aria-label="Clear session search"
              title="Clear search (Esc)"
              onClick={() => {
                setQuery('')
                searchField.current?.focus()
              }}
            >
              <IconClose size={13} />
            </button>
          ) : null}
        </div>

        {pinned.length && !needle ? (
          <div className="rail-section">
            <div className="rail-title">Pinned</div>
            {pinned.map((session) => (
              <SessionRow key={session.id} session={session} state={state} />
            ))}
          </div>
        ) : null}

        <div className="rail-section">
          <div className="rail-title">
            Workspaces
            <span className="count">{groups.length}</span>
          </div>
          {filtered.map((group) => {
            const expanded = isOpen(group.workspace, group.sessions)
            const running = group.sessions.filter((session) => session.status === 'running').length
            return (
              <div key={group.workspace}>
                <WorkspaceHeader
                  workspace={group.workspace}
                  sessions={group.sessions}
                  expanded={expanded}
                  running={running}
                  onToggle={() => toggle(group.workspace, expanded)}
                />
                {expanded ? (
                  <>
                    {railRows(group.sessions, Boolean(needle) || Boolean(showAll[group.workspace]), state.active).map((session) => (
                      <SessionRow key={session.id} session={session} state={state} />
                    ))}
                    {!needle && group.sessions.length > RAIL_RECENT ? (
                      <button
                        type="button"
                        className="rail-more"
                        aria-expanded={Boolean(showAll[group.workspace])}
                        onClick={() => setShowAll((current) => ({ ...current, [group.workspace]: !current[group.workspace] }))}
                      >
                        {showAll[group.workspace]
                          ? 'Show fewer'
                          : `Show ${group.sessions.length - railRows(group.sessions, false, state.active).length} more`}
                      </button>
                    ) : null}
                  </>
                ) : null}
              </div>
            )
          })}
          {filtered.length === 0 ? (
            <div className="rail-empty">
              {needle ? (
                <>Nothing matches “{query}”.</>
              ) : machine ? (
                <>
                  No workspaces on <span className="mono">{machine}</span> yet.
                </>
              ) : (
                <>No sessions yet.</>
              )}
            </div>
          ) : null}
        </div>
      </div>
      <div className="rail-foot">
        <span>
          {total} Session{total === 1 ? '' : 's'} · {groups.length} Workspace{groups.length === 1 ? '' : 's'}
        </span>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

/** The ⌘N that reaches a tab, for its tooltip: ⌘9 is the last one, as in a browser. */
function tabShortcutHint(position: number, count: number): string {
  const key = APPLE ? '⌘' : 'Ctrl+'
  if (position === count - 1 && count > 8) return `\n${key}9`
  return position < 8 ? `\n${key}${position + 1}` : ''
}

export function TabStrip({ state, onTransfer }: { state: State; onTransfer: (session: SessionSummary) => void }) {
  const active = state.active
  const activeDraft: Draft | null = active ? (state.drafts[active] ?? null) : null
  const session = active && !activeDraft ? state.sessions[active] : null
  // Tabs belong to the window, not to whichever machine happens to be selected
  // in the top bar. Their machine stays visible on each tab, so changing
  // environment never makes already-open work disappear.
  const shown = useMemo(() => stripTabs(state), [state.tabs, state.drafts, state.sessions, state.version])
  const [dragging, setDragging] = useState<string | null>(null)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const tabNodes = useRef(new Map<string, HTMLDivElement>())
  const previousPositions = useRef(new Map<string, DOMRect>())
  const suppressedClick = useRef<string | null>(null)
  const drag = useRef<{
    id: string
    pointerId: number
    startX: number
    offsetX: number
    desiredLeft: number
    previousLeft: number
    active: boolean
    frame: number | null
  } | null>(null)

  const mobile = useMobile()
  const drawer = useDrawer()
  const railShown = mobile ? drawer : state.settings.railVisible
  const longPress = useLongPress()
  // Phone only: the strip is one "current tab" button and a switcher sheet.
  const [switcher, setSwitcher] = useState(false)
  // The tab on screen counts even while it is still a chooser outside the strip.
  const tabCount = shown.length + (active && !shown.includes(active) ? 1 : 0)
  const swipe = useRef<{ x: number; y: number } | null>(null)
  /** A sideways swipe across the bar moves to the tab beside this one. */
  const swipeHandlers = mobile
    ? {
        onTouchStart: (event: React.TouchEvent) => {
          const touch = event.touches[0]
          swipe.current = touch ? { x: touch.clientX, y: touch.clientY } : null
        },
        onTouchEnd: (event: React.TouchEvent) => {
          const start = swipe.current
          const touch = event.changedTouches[0]
          swipe.current = null
          if (!start || !touch) return
          const dx = touch.clientX - start.x
          if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(touch.clientY - start.y) * 1.5) return
          const index = active ? shown.indexOf(active) : -1
          const next = shown[index + (dx < 0 ? 1 : -1)]
          if (next) selectTab(next)
        },
      }
    : {}

  const renameTab = async (item: SessionSummary) => {
    const next = await promptDialog({ title: 'Rename Session', value: item.title })
    if (next?.trim()) renameSession(item.id, next.trim())
  }

  /**
   * Keep the held tab under the pointer and reorder once its leading edge has
   * travelled through 75% of the next tab (25% from the far edge when moving
   * left). This is the early, symmetric threshold a hand expects: the held tab
   * does not have to reach the neighbour's final position before it makes room.
   * Native HTML drag events arrive in coarse
   * bursts and draw their own delayed ghost; pointer capture gives us one
   * animation frame per movement instead.
   */
  const paintDrag = () => {
    const current = drag.current
    if (!current?.active) return
    current.frame = null
    const node = tabNodes.current.get(current.id)
    if (!node) return

    const inlineTransform = node.style.transform
    node.style.transform = ''
    const natural = node.getBoundingClientRect()
    node.style.transform = inlineTransform
    const offset = current.desiredLeft - natural.left
    node.style.transform = `translate3d(${offset}px, 0, 0)`
    node.style.zIndex = '3'

    const movingRight = current.desiredLeft > current.previousLeft
    const movingLeft = current.desiredLeft < current.previousLeft
    current.previousLeft = current.desiredLeft
    const order = orderedTabs(getState())
    const index = order.indexOf(current.id)
    if (movingRight && index >= 0 && index < order.length - 1) {
      const next = order[index + 1]!
      const rect = tabNodes.current.get(next)?.getBoundingClientRect()
      // The held tab's leading edge has covered 75% of the neighbour.
      if (rect && current.desiredLeft + natural.width >= rect.left + rect.width * 0.75) {
        reorderTab(current.id, next, true)
      }
    } else if (movingLeft && index > 0) {
      const previous = order[index - 1]!
      const rect = tabNodes.current.get(previous)?.getBoundingClientRect()
      if (rect && current.desiredLeft <= rect.left + rect.width * 0.25) {
        reorderTab(current.id, previous)
      }
    }
  }

  const scheduleDragPaint = () => {
    const current = drag.current
    if (!current?.active || current.frame !== null) return
    current.frame = requestAnimationFrame(paintDrag)
  }

  const finishDrag = (id: string, pointerId: number, cancelled = false) => {
    const current = drag.current
    if (!current || current.id !== id || current.pointerId !== pointerId) return
    if (current.frame !== null) cancelAnimationFrame(current.frame)
    const node = tabNodes.current.get(id)
    if (current.active && node) {
      paintDrag()
      const heldTransform = node.style.transform || 'translate3d(0, 0, 0)'
      node.style.transform = ''
      node.style.zIndex = ''
      node.animate(
        [{ transform: heldTransform }, { transform: 'translate3d(0, 0, 0)' }],
        { duration: cancelled ? 90 : 130, easing: 'cubic-bezier(.2,.8,.2,1)' },
      )
      suppressedClick.current = id
      setTimeout(() => {
        if (suppressedClick.current === id) suppressedClick.current = null
      }, 0)
    }
    drag.current = null
    setDragging(null)
  }

  useEffect(() => () => {
    const frame = drag.current?.frame
    if (frame != null) cancelAnimationFrame(frame)
  }, [])

  // FLIP: after the held tab crosses a neighbour, that neighbour glides out of
  // its way. An interrupted animation continues from the pixels currently on
  // screen, which is what keeps rapid back-and-forth movement from jumping.
  useLayoutEffect(() => {
    const next = new Map<string, DOMRect>()
    for (const [id, node] of tabNodes.current) {
      if (id === dragging) {
        const transform = node.style.transform
        node.style.transform = ''
        next.set(id, node.getBoundingClientRect())
        node.style.transform = transform
        continue
      }
      const visual = node.getBoundingClientRect()
      const animations = node.getAnimations()
      for (const animation of animations) animation.cancel()
      const rect = node.getBoundingClientRect()
      next.set(id, rect)
      const before = animations.length ? visual : previousPositions.current.get(id)
      if (!before || (before.left === rect.left && before.top === rect.top)) continue
      node.animate(
        [
          { transform: `translate(${before.left - rect.left}px, ${before.top - rect.top}px)` },
          { transform: 'translate(0, 0)' },
        ],
        { duration: 140, easing: 'cubic-bezier(.2,.8,.2,1)' },
      )
    }
    previousPositions.current = next
    scheduleDragPaint()
  }, [dragging, shown.join('|')])

  return (
    <div className={`tabs${mobile ? ' tabs-compact' : ''}`} {...swipeHandlers}>
      {/* Lives with the thing it controls: the rail is on the left, so the
          toggle is too — and it stays reachable while the rail is hidden. */}
      <button
        className={`icon-btn rail-toggle${railShown ? '' : ' off'}`}
        onClick={() => (mobile ? toggleDrawer() : updateSettings({ railVisible: !state.settings.railVisible }))}
        title={`${railShown ? 'Hide' : 'Show'} sidebar (⌘B)`}
        aria-label={`${railShown ? 'Hide' : 'Show'} sidebar`}
        aria-expanded={railShown}
      >
        <IconSidebar />
      </button>
      {mobile ? (
        <button
          type="button"
          className="tab-current"
          onClick={() => setSwitcher(true)}
          aria-label={`${active ? tabTitle(state, active) : 'No tab'} — show all ${tabCount} tabs`}
          style={machineStyle(colorForMachine(state, activeDraft ? activeDraft.host : (session?.host ?? null)))}
        >
          {session ? <SessionMark state={sessionState(session)} unread={isUnread(state, session)} /> : <span className="sess-state stopped" />}
          <span className="label">{active ? tabTitle(state, active) : 'No tab'}</span>
          <span className="tab-count" aria-hidden>{tabCount}</span>
        </button>
      ) : shown.map((id, position) => {
        const draft = state.drafts[id]
        const item = state.sessions[id]
        if (!draft && !item) return null
        // Which machine this tab runs on, and whether that is the one selected
        // in the top bar.
        const host = draft ? draft.host : item!.host
        const color = colorForMachine(state, host)
        return (
          <div
            key={id}
            ref={(node) => {
              if (node) tabNodes.current.set(id, node)
              else tabNodes.current.delete(id)
            }}
            data-tab-id={id}
            role="button"
            tabIndex={0}
            aria-label={`${tabTitle(state, id)} on ${machineName(host)}`}
            className={`tab${state.active === id ? ' active' : ''}${dragging === id ? ' dragging' : ''}`}
            style={machineStyle(color)}
            onClick={(event) => {
              if (suppressedClick.current === id) {
                event.preventDefault()
                suppressedClick.current = null
                return
              }
              selectTab(id)
            }}
            onDoubleClick={(event) => {
              if (!item || (event.target as HTMLElement).closest('.x')) return
              event.preventDefault()
              void renameTab(item)
            }}
            onKeyDown={(event) => {
              if (event.key === 'F2' && item && event.target === event.currentTarget) {
                event.preventDefault()
                void renameTab(item)
                return
              }
              activateOnKey(event, () => selectTab(id))
            }}
            onContextMenu={(event) => {
              if (!item) return
              event.preventDefault()
              setMenu({ id, x: event.clientX, y: event.clientY })
            }}
            {...(item ? longPress((at) => setMenu({ id, ...at })) : {})}
            onPointerDown={(event) => {
              // A finger scrolls the strip; reordering is a mouse gesture.
              if (event.pointerType === 'touch') return
              if (event.button !== 0 || (event.target as HTMLElement).closest('.x')) return
              const rect = event.currentTarget.getBoundingClientRect()
              drag.current = {
                id,
                pointerId: event.pointerId,
                startX: event.clientX,
                offsetX: event.clientX - rect.left,
                desiredLeft: rect.left,
                previousLeft: rect.left,
                active: false,
                frame: null,
              }
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={(event) => {
              const current = drag.current
              if (!current || current.id !== id || current.pointerId !== event.pointerId) return
              if (!current.active) {
                if (Math.abs(event.clientX - current.startX) < 3) return
                current.active = true
                setDragging(id)
              }
              event.preventDefault()
              current.desiredLeft = event.clientX - current.offsetX
              scheduleDragPaint()
            }}
            onPointerUp={(event) => {
              finishDrag(id, event.pointerId)
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId)
              }
            }}
            onPointerCancel={(event) => finishDrag(id, event.pointerId, true)}
            title={`${
              draft
                ? `${machineName(host)}\n${draft.cwd}`
                : `${item!.title}\n${SESSION_STATE_WORD[sessionState(item!)]} · ${machineName(host)}\n${item!.cwd}`
            }${tabShortcutHint(position, shown.length)}`}
          >
            {draft ? (
              draft.kind === 'agent' ? (
                <span className="sess-state stopped" />
              ) : (
                <IconPlus size={14} />
              )
            ) : (
              <SessionMark state={sessionState(item!)} host={host} unread={isUnread(state, item!)} />
            )}
            {!draft && sessionOrdinal(state, id) ? <span className="ord">{sessionOrdinal(state, id)}</span> : null}
            <span className="label" title={item ? 'Double-click to rename session' : undefined}>{tabTitle(state, id)}</span>
            {/* Small, and always there: the colour makes it findable, the name
                is what actually says which machine it is. */}
            <span className="tab-machine">{machineName(host)}</span>
            <span
              className="x"
              draggable={false}
              role="button"
              tabIndex={0}
              aria-label={`Close ${tabTitle(state, id)}`}
              onClick={(event) => {
                event.stopPropagation()
                closeTab(id)
              }}
              onKeyDown={(event) => activateOnKey(event, () => closeTab(id))}
            >
              <IconClose size={11} />
            </span>
          </div>
        )
      })}
      {menu && state.sessions[menu.id] ? (
        <SessionMenu session={state.sessions[menu.id]!} at={menu} onClose={() => setMenu(null)} />
      ) : null}
      {mobile && switcher ? <TabSwitcher state={state} tabs={shown} onClose={() => setSwitcher(false)} /> : null}
      <button className="tab-add" onClick={() => openDraft(null)} title="New tab (⌘D agent · ⌘T terminal)">
        <IconPlus size={16} />
      </button>
      <span className="spacer" />
      {session || activeDraft ? (
        <div className="row" style={{ alignItems: 'center', gap: 2 }}>
          {/* The terminal's control lives on the bottom edge of the pane,
              where the panel itself rises from (see `TerminalHandle`). It used
              to be here, in the top-right toolbar, pointing at something that
              opens from the opposite corner; once the handle existed, two
              controls for one panel was one too many. */}
          {/* Offered on a tab that has not started yet too: the tree is how you
              see the folder you just picked, which is the one decision that
              screen is about. It was session-only, so it was missing exactly
              there. */}
          {/* On a phone the tree and the pin live in the ⋯ menu (below): the
              bar keeps room for the tab itself. */}
          {(session && !mobile) || (!session && activeDraft?.cwd) ? (
            <button
              className={`icon-btn${state.settings.filesVisible ? ' on' : ''}`}
              onClick={() => updateSettings({ filesVisible: !state.settings.filesVisible })}
              title={
                state.settings.filesVisible
                  ? 'Hide the file tree of this folder'
                  : 'Show the file tree of this folder'
              }
            >
              <IconFiles size={16} />
            </button>
          ) : null}
          {session && !mobile ? (
            <button
              className="icon-btn"
              onClick={() => togglePin(session.id, !session.pinned)}
              title={session.pinned ? 'Unpin session' : 'Pin session'}
              style={session.pinned ? { color: 'var(--fg)' } : undefined}
            >
              <IconStar size={16} fill={session.pinned ? 'currentColor' : 'none'} />
            </button>
          ) : null}
          {session ? (
            <MenuTrigger
              align="end"
              width={270}
              className="session-actions-menu"
              title="Session actions"
              trigger={() => <IconMore size={17} />}
            >
              {(close) => (
                <>
                  {mobile ? (
                    <>
                      <button
                        className="menu-item"
                        onClick={() => {
                          updateSettings({ filesVisible: !state.settings.filesVisible })
                          close()
                        }}
                      >
                        <IconFiles size={16} />
                        <span className="menu-item-name">{state.settings.filesVisible ? 'Hide file tree' : 'Show file tree'}</span>
                      </button>
                      <button
                        className="menu-item"
                        onClick={() => {
                          togglePin(session.id, !session.pinned)
                          close()
                        }}
                      >
                        <IconStar size={16} fill={session.pinned ? 'currentColor' : 'none'} />
                        <span className="menu-item-name">{session.pinned ? 'Unpin session' : 'Pin session'}</span>
                      </button>
                      <div className="menu-sep" />
                    </>
                  ) : null}
                  <div className="session-menu-info">
                    <span className="session-menu-heading">Session</span>
                    <span>{session.kind === 'terminal' ? 'Terminal' : HARNESS_LABEL[session.harness]} · {machineName(session.host)}</span>
                    <span className="session-menu-path" title={session.cwd}>{session.cwd}</span>
                    {session.nativeId ? (
                      <span className="session-menu-id mono" title={session.nativeId}>{session.nativeId}</span>
                    ) : (
                      <span className="session-menu-id">{session.status === 'starting' ? 'Waiting for harness session ID' : 'Harness session ID unavailable'}</span>
                    )}
                  </div>
                  <button
                    className="menu-item"
                    disabled={!session.nativeId}
                    onClick={() => {
                      if (!session.nativeId) return
                      void navigator.clipboard.writeText(session.nativeId)
                        .then(() => notify('success', `${session.kind === 'terminal' ? 'Terminal' : HARNESS_LABEL[session.harness]} session ID copied`))
                        .catch(() => notify('error', 'Could not copy the session ID'))
                      close()
                    }}
                  >
                    <span className="menu-item-name">Copy harness session ID</span>
                  </button>
                  {session.kind === 'agent' ? (
                    <button
                      className="menu-item"
                      onClick={() => {
                        close()
                        onTransfer(session)
                      }}
                    >
                      <span className="menu-item-name">Transfer…</span>
                      <span className="menu-item-meta">New harness</span>
                    </button>
                  ) : null}
                  {session.kind === 'agent' ? (
                    <>
                      <div className="menu-sep" />
                      {(['markdown', 'text'] as const).map((format) => (
                        <button
                          key={format}
                          className="menu-item"
                          onClick={() => {
                            close()
                            void exportConversation(session, getState().events[session.id] ?? [], format)
                          }}
                        >
                          <IconDownload size={16} className="menu-item-glyph" />
                          <span className="menu-item-name">{format === 'markdown' ? 'Export as Markdown' : 'Export as Text'}</span>
                          <span className="menu-item-meta">{format === 'markdown' ? '.md' : '.txt'}</span>
                        </button>
                      ))}
                    </>
                  ) : null}
                </>
              )}
            </MenuTrigger>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Composer                                                            */
/* ------------------------------------------------------------------ */

export function Composer({ session, state }: { session: SessionSummary; state: State }) {
  // Kept per tab until sent or closed (see `drafts.ts`).
  const { text, setText, attachments, setAttachments, documents, setDocuments } = useComposerDraft(session.id)
  const docs = useDocuments(documents, setDocuments, (value) => insertAtCaret(value))
  const [slashIndex, setSlashIndex] = useState(0)
  const [uploading, setUploading] = useState(0)
  const [zoom, setZoom] = useState<number | null>(null)
  // Phone only: the three pickers fold into one summary chip (see mobile.css).
  const [optionsOpen, setOptionsOpen] = useState(false)
  const controlsLane = useOverflowFade<HTMLDivElement>()
  const area = useAutosizeTextarea(text)

  // A queued prompt the user just cancelled comes back here: its text first,
  // then whatever was already being written, with the caret at the end. Its
  // pictures go first too, so the draft's own `[image:N]` tokens shift past them.
  const restored = useStore((s) => s.restored[session.id])
  const caretToEnd = useRef(false)
  useEffect(() => {
    if (!restored) return
    const images = restored.attachments.filter((ref) => !isDocument(ref))
    const restoredDocuments = restored.attachments.filter(isDocument)
    const count = images.length
    setText((current) => {
      const shifted = current.replace(/\[image:(\d+)\]/g, (_match, digits: string) => imageToken(Number(digits) + count))
      return shifted.trim() ? `${restored.text}\n\n${shifted}` : restored.text
    })
    if (count) setAttachments((list) => [...images, ...list])
    if (restoredDocuments.length) setDocuments((list) => [...restoredDocuments, ...list])
    caretToEnd.current = true
    takeRestoredPrompt(session.id)
  }, [restored?.nonce, session.id])
  useEffect(() => {
    if (!caretToEnd.current) return
    caretToEnd.current = false
    const node = area.current
    if (!node) return
    node.focus()
    node.setSelectionRange(node.value.length, node.value.length)
  }, [text])

  // The harness on the machine this session runs on: its model list is that
  // machine's, and a CLI installed only here says nothing about a server.
  const harness = capsFor(state, session.host)?.harnesses.find((item) => item.id === session.harness)

  /**
   * Commands and skills for *this* workspace. The catalog's list is static and
   * per machine; skills are files next to the folder (or on the host the session
   * runs on), so they are asked for here and fall back to the catalog until they
   * arrive.
   */
  const [loadedCommands, setLoadedCommands] = useState<HarnessCommand[] | null>(null)
  const commands = loadedCommands ?? harness?.commands ?? []

  // A session restored on a server, opened before its machine was ever asked
  // about: the model list comes from that machine's catalog, so ask for it.
  useEffect(() => ensureCaps(session.host), [session.host])

  useEffect(() => {
    let alive = true
    setLoadedCommands(null)
    void fetchCommands(session.harness, session.cwd, session.host).then((list) => {
      if (alive) setLoadedCommands(list)
    })
    return () => {
      alive = false
    }
  }, [session.harness, session.cwd, session.host])

  // Background subagents keep working after the parent turn's `result`, so the
  // stop button has to mean "something is still working", not just "a turn is
  // streaming" — otherwise you cannot stop what is still running.
  const subagentsRunning = useMemo(
    () =>
      // Nothing can still be working in a session that is not running (see
      // `anyAgentRunning`): counting a provisional card there is what left
      // "Working…" on screen after the turn was over.
      session.status === 'running'
        ? subagentInfos(state.events[session.id] ?? []).filter((info) => info.running).length
        : 0,
    // This session's events only: any store update used to re-run it.
    [session.id, session.status, state.events[session.id]],
  )
  // The ledger says whether the session's turn is waiting on agents; the
  // events only say which call it is on.
  const ledger = useStore((s) => s.turns[session.id])
  const livePhase = livePhaseOf(ledger)
  // Working while the ledger's turn is live; without a ledger, while the
  // session runs or the events show agents still out.
  const working = livePhase !== null || session.status === 'running' || (!ledger && subagentsRunning > 0)
  const streaming = session.status === 'running'
  // What the turn is doing, read from its own events — the same reading the
  // transcript's header shows, so the placeholder cannot disagree with it.
  // The rows are rebuilt only when this session's events change; the live buffer
  // changes on every streamed token and must not re-group the whole history.
  const sessionEvents = state.events[session.id]
  const rows = useMemo(() => buildRows(sessionEvents ?? []), [sessionEvents])
  // Read from the store directly: the shell's `state` does not move per token.
  const liveBuffer = useStore((s) => s.live[agentKey(session.id)])
  const activity = useMemo(
    () => (livePhase === 'waiting_agents' ? 'delegating' : activityOf(rows, { ...liveBuffer, running: session.status === 'running' })),
    [rows, liveBuffer, session.status, livePhase],
  )

  // A configuration request applies when the next harness process starts. It is
  // still the value the person just selected, so controls render the pending
  // request immediately while the summary keeps the confirmed runtime truth.
  const displayModel = session.pendingOptions && 'model' in session.pendingOptions
    ? session.pendingOptions.model ?? null
    : session.model
  const displayEffort = session.pendingOptions && 'effort' in session.pendingOptions
    ? session.pendingOptions.effort ?? null
    : session.effort
  const displayPermission = session.pendingOptions && 'permissionMode' in session.pendingOptions
    ? session.pendingOptions.permissionMode ?? session.permissionMode
    : session.permissionMode

  /**
   * The models, as rows worth reading: one per model, its own name first and the
   * plan it belongs to small at the end (see `models.ts`). The effort a catalog
   * encodes in its ids — `sol[high]` — becomes a property of the model instead of
   * six near-identical rows.
   */
  const choices = useMemo(() => {
    const list = [...(harness?.models ?? [])]
    // The harness reports the model it is actually running, which is the id the
    // runtime resolved and not the alias that was asked for — `haiku` comes back
    // as `claude-haiku-4-5-20251001`. That id is the truth and it stays the
    // value; what it is *labelled* is the same id read as a name, because the
    // row used to print the id itself and nobody chose a model called that.
    if (displayModel && !findModelChoice(modelChoices(list), displayModel)) {
      list.unshift({ id: displayModel, label: modelName(displayModel) })
    }
    return modelChoices(list)
  }, [displayModel, harness, state.version])

  const chosen = useMemo(() => {
    return findModelChoice(choices, displayModel)
  }, [choices, displayModel])
  const selectedModel = useMemo(
    () => (displayModel ? readModel({ id: displayModel, label: displayModel }) : undefined),
    [displayModel],
  )

  const models = useMemo(() => {
    if (!choices.length) {
      // Nothing from the harness: say why rather than offer one row that looks
      // like the whole catalog (see `modelsWhy`).
      return [{ value: '', label: 'Default Model', hint: modelsWhy(state, session.harness, session.host) ?? undefined }]
    }
    return choices.map((choice) => ({
      value: choice.id,
      label: choice.label,
      suffix: choice.suffix ?? undefined,
    }))
  }, [choices, session.harness, session.host, state.version])

  /** The efforts this model can be asked for, from the catalog's own variants. */
  const modelEffort = useMemo(
    () => effortCapability(harness?.models ?? [], chosen?.base ?? ''),
    [chosen, harness, state.version],
  )

  // A catalog that answered "this model has no adjustable effort" is not the
  // same as one that said nothing (see the options below).
  const modelEfforts = modelEffort.levels
  const effortsKnown = Boolean(chosen) && modelEffort.known
  const effortsFixed = Boolean(chosen) && modelEffort.fixed

  const effortChoices = useMemo(
    () => effortOptions({ levels: modelEfforts, fixed: effortsFixed }, Boolean(chosen?.encodedEffort)),
    [chosen?.encodedEffort, modelEfforts, effortsFixed],
  )

  const wantedEffort = selectedModel?.effort ?? displayEffort ?? ''
  const effortValue = modelEfforts.includes(wantedEffort) ? wantedEffort : ''
  /**
   * Choosing a model also decides which efforts are legal for it. An effort the
   * new model does not take is dropped here rather than carried along: leaving it
   * in the session is what puts a value in the chip that no option matches (it
   * renders as "Pick One") and sends the harness something it refuses.
   */
  const pickModel = (value: string) => {
    const next = choices.find((choice) => choice.id === value || choice.base === value)
    const nextEffort = effortCapability(harness?.models ?? [], next?.base ?? '')
    const allowed = nextEffort.levels
    const current = selectedModel?.effort ?? displayEffort
    const keep = current && allowed.includes(current) ? current : null
    const effective = keep ?? (next?.encodedEffort ? (allowed[0] ?? null) : null)
    setSessionOptions(session.id, {
      model: next?.encodedEffort ? modelWithEffort(next, effective) : (value || null),
      ...(nextEffort.known
        ? { effort: (next?.encodedEffort ? null : keep) as EffortLevel | null }
        : { effort: null }),
    })
  }

  // `/` surfaces the harness' own commands and skills — the same ones you would
  // type inside it — instead of sedano inventing a second, divergent set. The
  // whole list is offered and the menu scrolls; a hard cap hid the very skill
  // you were looking for.
  const slashQuery = text.startsWith('/') && !text.includes(' ') ? text.slice(1).toLowerCase() : null
  const slashMatches = useMemo(
    () => (slashQuery === null ? [] : commands.filter((c) => c.name.toLowerCase().includes(slashQuery))),
    [slashQuery, commands],
  )
  const slashOpen = slashMatches.length > 0
  const slashList = useRef<HTMLDivElement>(null)

  useEffect(() => setSlashIndex(0), [slashQuery])

  // Keyboard navigation must not walk off the end of a filtered list, and the
  // selected row must stay visible in a menu that scrolls.
  useEffect(() => {
    setSlashIndex((value) => Math.min(value, Math.max(0, slashMatches.length - 1)))
    slashList.current?.querySelector('.slash-item.sel')?.scrollIntoView({ block: 'nearest' })
  }, [slashIndex, slashMatches.length])

  const insertCommand = (name: string) => {
    setText(`/${name} `)
    area.current?.focus()
  }

  const insertAtCaret = (snippet: string) => {
    const caret = area.current?.selectionStart
    setText((current) => {
      const at = caret ?? current.length
      return `${current.slice(0, at)}${snippet}${current.slice(at)}`
    })
  }

  /**
   * A pasted image is uploaded once and referenced by id; the message keeps an
   * `[image:N]` token where it was pasted, so the agent reads the text and the
   * images in the order they were meant.
   */
  const addImages = (files: File[]) => {
    // The model decides, not the harness: a text-only model refuses what a vision
    // model takes, on the same harness.
    const verdict = takesImages(state, session.harness, session.model, session.host)
    if (!verdict.ok) {
      notify('error', verdict.why ?? 'this model does not take images')
      return
    }
    const first = attachments.length + uploading + 1
    insertAtCaret(files.map((_, index) => imageToken(first + index)).join(' '))
    setUploading((count) => count + files.length)
    files.forEach((file, index) => {
      uploadAttachment(file, file.name || `pasted-${first + index}.png`)
        .then((ref) => setAttachments((list) => [...list, ref]))
        .catch((error: unknown) => {
          notify('error', error instanceof Error ? error.message : String(error))
          setText((current) => dropImageToken(current, first + index))
        })
        .finally(() => setUploading((count) => count - 1))
    })
  }

  /** Pictures go in as `[image:N]` chips, text files as document tiles. */
  const attachFiles = (files: File[]) => {
    const { images, documents: texts } = sortFiles(files)
    if (images.length) addImages(images)
    if (texts.length) docs.addFiles(texts)
    return images.length + texts.length > 0
  }

  /** A long paste becomes a document rather than a wall of text in the box. */
  const paste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (attachFiles(transferFiles(event.clipboardData))) {
      event.preventDefault()
      return
    }
    const pasted = event.clipboardData.getData('text/plain')
    if (!isLongPaste(pasted)) return
    event.preventDefault()
    docs.addPaste(pasted)
  }

  /** A dropped image lands where it was dropped, like a pasted one. */
  const drop = (event: React.DragEvent<HTMLTextAreaElement>) => {
    const files = transferFiles(event.dataTransfer)
    const { images, documents: texts } = sortFiles(files)
    if (!images.length && !texts.length) return
    event.preventDefault()
    const area = event.currentTarget
    area.focus()
    const at = caretAtPoint(area, event.clientX, event.clientY)
    if (at !== null) area.setSelectionRange(at, at)
    attachFiles(files)
  }

  const removeAttachment = (index: number) => {
    setAttachments((list) => list.filter((_, position) => position !== index))
    setText((current) => dropImageToken(current, index + 1))
  }

  /**
   * Typing, with the images kept in step: the token in the text and the picture
   * in the strip are one thing, so deleting any part of a token deletes both
   * (see `syncImageTokens`).
   */
  const editText = (value: string) => {
    const synced = syncImageTokens(value, attachments.length, uploading)
    if (!synced) {
      setText(value)
      return
    }
    setAttachments((list) => synced.kept.map((number) => list[number - 1]!).filter(Boolean))
    setText(synced.text)
  }

  const submit = () => {
    const value = text.trim()
    // An edited document still uploading would go out as its old version.
    if (docs.busy) return
    // An image or a document on its own is a message: it says "look at this".
    // Pictures first, so `[image:N]` is still the Nth attachment.
    const all = [...attachments, ...documents]
    if (!value && !all.length) return
    sendMessage(session.id, value, all.length ? all : undefined)
    setText('')
    setAttachments([])
    setDocuments([])
  }

  return (
    <div className="composer">
      {slashOpen ? (
        <div className="slash-menu">
          <div className="slash-inner">
            <div className="menu-title">
              {HARNESS_LABEL[session.harness]} commands &amp; skills · {slashMatches.length}
            </div>
            <div className="slash-list" ref={slashList}>
              {slashMatches.map((command, index) => (
                <button
                  key={command.name}
                  className={`slash-item${index === slashIndex ? ' sel' : ''}`}
                  onMouseEnter={() => setSlashIndex(index)}
                  onClick={() => insertCommand(command.name)}
                >
                  {command.kind === 'skill' ? <span className="slash-kind">skill</span> : null}
                  <span className="slash-name mono">/{command.name}</span>
                  <span className="slash-desc">{command.description}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
      <div className="composer-inner">
        {attachments.length || uploading || documents.length || docs.busy ? (
          <div className="attach-strip">
            {attachments.map((attachment, index) => (
              <div className="attach" key={attachment.id}>
                <img
                  src={attachmentUrl(attachment)}
                  alt={attachment.name}
                  title={attachment.name}
                  onClick={() => setZoom(index)}
                />
                <span className="attach-tag mono">{index + 1}</span>
                <button
                  className="attach-remove"
                  title={`Remove ${attachment.name}`}
                  onClick={() => removeAttachment(index)}
                >
                  <IconClose size={10} strokeWidth={2.2} />
                </button>
              </div>
            ))}
            {docs.tiles}
            {uploading || docs.busy ? <div className="attach pending">uploading…</div> : null}
          </div>
        ) : null}
        <PromptField
          ref={area}
          value={text}
          rows={1}
          onPaste={paste}
          onDrop={drop}
          onDragOver={allowFileDrop}
          ready={attachments.length}
          placeholder={
            working
              ? `${ACTIVITY_WORD[activity]}… Press Esc To Interrupt`
              : `Message ${HARNESS_LABEL[session.harness]}`
          }
          onChange={(event) => editText(event.target.value)}
          onKeyDown={(event) => {
            if (slashOpen) {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setSlashIndex((value) => Math.min(slashMatches.length - 1, value + 1))
                return
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setSlashIndex((value) => Math.max(0, value - 1))
                return
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                setText('')
                return
              }
              if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
                event.preventDefault()
                insertCommand(slashMatches[slashIndex]!.name)
                return
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              submit()
            }
          }}
        />
        <div className={`composer-row${optionsOpen ? ' options-open' : ''}`}>
          <button
            type="button"
            className="composer-options-toggle"
            aria-expanded={optionsOpen}
            aria-label="Model, effort and approvals"
            onClick={() => setOptionsOpen((value) => !value)}
          >
            <span className="composer-options-summary">
              {[
                chosen?.label ?? (displayModel ? modelName(displayModel) : 'Default Model'),
                effortChoices.find((option) => option.value === effortValue)?.label,
                PERMISSION_LABEL[displayPermission],
              ].filter(Boolean).join(' · ')}
            </span>
            <span className={`caret${optionsOpen ? ' open' : ''}`}>
              <IconCaret size={15} />
            </span>
          </button>
          {/* Controls may be more numerous than a narrow desktop can show. They
              get one quiet horizontal lane; the recording and send actions are
              a separate fixed lane, so neither wraps below the other or jumps
              when a model has a long name. */}
          <div className="composer-controls" aria-label="Message options" ref={controlsLane}>
          {/* Only a streaming turn blocks these: a background subagent must not
              lock the composer you are still typing in. */}
          <Select
            value={choices.length ? (chosen?.id ?? '') : (displayModel ?? '')}
            options={models}
            icon={<IconModel size={15} />}
            disabled={streaming || !effortsKnown || effortsFixed}
            footerAction={{
              label: 'Refresh models & version',
              onClick: () => {
                notify('info', `Refreshing ${HARNESS_LABEL[session.harness]} in the background…`)
                void inspectHarness(session.harness, session.host)
              },
            }}
            width={380}
            placeholder="Default Model"
            // The exact id is one hover away: the label is readable, and what
            // actually ran is still recoverable from the control that shows it.
            title={
              streaming
                ? 'Stop the turn before switching model'
                : `${harness?.modelsNote ?? 'Model for this session'}${displayModel ? `\n${displayModel}` : ''}`
            }
            onChange={pickModel}
          />
          <Select
            value={effortValue}
            options={effortChoices}
            icon={<IconBrain size={15} />}
            disabled={streaming}
            title={
              streaming
                ? 'Stop the turn before changing effort'
                : !effortsKnown
                  ? 'This model has not reported its reasoning-effort options yet'
                  : modelEfforts.length
                  ? `Reasoning effort this model offers: ${modelEfforts.join(', ')}`
                  : 'Reasoning effort'
            }
            onChange={(value) => {
              // A catalog that encodes the effort in the model id is asked with
              // the id: the harness has no separate flag to set.
              if (modelEfforts.length && chosen?.encodedEffort) {
                setSessionOptions(session.id, { model: modelWithEffort(chosen, value || null) })
                return
              }
              setSessionOptions(session.id, { effort: (value || null) as EffortLevel | null })
            }}
          />
          <Select
            value={displayPermission}
            icon={<IconShield size={15} />}
            // What this harness publishes on *this* machine, which is the only
            // authority on what it will honour; the local table is the fallback
            // for a server too old to say (see `models.ts`).
            options={permissionModeOptions(session.harness, displayPermission, harness?.permissionModes).map((mode) => ({
              value: mode,
              label: PERMISSION_LABEL[mode],
            }))}
            disabled={streaming}
            // A non-interactive session cannot always be asked mid-turn, so the
            // harness simply refuses the tool. Saying so here is the whole
            // explanation.
            title={
              streaming
                ? 'Stop the turn before changing approvals'
                : "Tool approvals. A harness that cannot ask mid-turn refuses instead: pick 'Bypass All' to let it run tools without asking."
            }
            onChange={(value) => setSessionOptions(session.id, { permissionMode: value as PermissionMode })}
          />
          </div>
          <div className="composer-actions">
          {/* Context belongs to the message being composed, so it stays with
              the fixed message actions instead of drifting left in the
              scrollable model/effort/approval lane. */}
          <ContextMeter session={session} />
          <AttachButton onFiles={attachFiles} />
          <MicButton
            voice={serverCaps(state)?.voice}
            onText={(value) => setText((current) => (current ? `${current.trimEnd()} ${value}` : value))}
          />
          {working ? (
            <button className="send stop" onClick={() => interruptSession(session.id)} title="Interrupt (esc)">
              <IconStop />
            </button>
          ) : (
            <button
              className="send"
              onClick={submit}
              disabled={(!text.trim() && !attachments.length && !documents.length) || docs.busy > 0}
              title="Send (↵)"
            >
              <IconSend />
            </button>
          )}
          </div>
        </div>
      </div>
      {zoom === null ? null : (
        <Lightbox images={attachments} index={zoom} onClose={() => setZoom(null)} />
      )}
      {docs.viewer}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Status bar                                                          */
/* ------------------------------------------------------------------ */

/**
 * How full this conversation is, beside the composer.
 *
 * The harness reports the window and what the conversation now occupies, so the
 * one number you want before typing a long prompt — "is there room?" — sits next
 * to where you type, and clicking it opens the ledger behind it. This is the
 * sole context readout: repeating the percentage below made two controls look
 * like two different measurements.
 */
export function ContextMeter({ session }: { session: SessionSummary }) {
  // Metrics ticks do not re-render the shell (see `shellState`); the meter
  // listens for them itself.
  const metrics = useStore((s) => s.sessions[session.id]?.metrics ?? session.metrics)
  const used = metrics?.contextTokens ?? 0
  const reportedWindow = metrics?.contextWindow ?? 0
  // A live session created before the server-side correction can still carry
  // the base Claude window. Its own input above 200k proves that denominator is
  // wrong; never paint a false 100% ring while the active process continues.
  const window = reportedWindow > 0 && used > reportedWindow
    ? session.harness === 'claude' && reportedWindow === 200_000 && used <= 1_000_000
      ? 1_000_000
      : 0
    : reportedWindow
  /**
   * Nobody has told us how full this conversation is.
   *
   * An empty ring is the picture of "0% used", which is a claim — and the one
   * shape we must not borrow for silence. So the unknown reading gets its own
   * ring: no fill at all, a dashed track, and an em dash where the percentage
   * goes. It is not a small number, it is not a number.
   */
  const unknown = metrics?.contextReported === false && !used
  if (!used && !unknown) return null
  /**
   * There is a window, but nobody published it: it was guessed from the model's
   * name. Most harnesses are here, and it is the only reason they have a ring at
   * all — so the reading is shown, marked as the approximation it is. A "62%"
   * built on a guessed denominator, drawn exactly like one the harness stated,
   * is the kind of confidence the app has no right to.
   */
  const approximate = !unknown && Boolean(window) && (metrics?.contextWindowInferred === true || window !== reportedWindow)
  // Without a window there is no percentage to show — a harness whose model we
  // do not know reports tokens, not a "how full", so the ring shows the tokens.
  const percent = window ? Math.min(100, (used / window) * 100) : 0
  const reading = unknown
    ? 'This harness has not reported how full the context is'
    : approximate
      ? `About ${percent.toFixed(0)}% of an estimated ${window.toLocaleString()}-token window — the harness has not stated its window, so the size comes from its model table`
      : window
        ? `${used.toLocaleString()} of ${window.toLocaleString()} tokens used`
        : `${used.toLocaleString()} tokens in context`
  const line = (label: string, value: string, hint?: string) => (
    <div className="ctx-line" title={hint}>
      <span>{label}</span>
      <span className="mono">{value}</span>
    </div>
  )
  return (
    <MenuTrigger
      className="ctx-meter"
      width={264}
      align="end"
      title={reading}
      trigger={(open) => (
        <span
          className={`ctx-ring${open ? ' open' : ''}${unknown ? ' unknown' : ''}${approximate ? ' approx' : ''}`}
          title={reading}
        >
          <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden>
            <circle className="ctx-track" cx="10" cy="10" r="7.5" />
            {unknown ? null : (
              <circle
                className={`ctx-fill${percent >= 90 ? ' err' : percent >= 70 ? ' warn' : ''}`}
                cx="10"
                cy="10"
                r="7.5"
                strokeDasharray={2 * Math.PI * 7.5}
                strokeDashoffset={2 * Math.PI * 7.5 * (1 - percent / 100)}
              />
            )}
          </svg>
          <span className="mono ctx-percent">
            {unknown ? '—' : window ? `${approximate ? '≈' : ''}${percent.toFixed(0)}%` : formatK(used)}
          </span>
        </span>
      )}
    >
      {() => (
        <>
          <MenuSection label="This conversation">
            {unknown ? (
              <div className="menu-note">Not Reported By This Harness</div>
            ) : (
              <>
                {window
                  ? line(
                      'Window',
                      `${approximate ? '≈' : ''}${formatK(window)} tokens`,
                      approximate
                        ? 'estimated from the model table — the harness has not stated its window (yet)'
                        : undefined,
                    )
                  : null}
                {line('Used', window ? `${formatK(used)} · ${approximate ? '≈' : ''}${percent.toFixed(0)}%` : `${formatK(used)} tokens`, 'what the harness reports for this chat')}
                {window ? line('Room left', `${approximate ? '≈' : ''}${formatK(Math.max(0, window - used))} tokens`) : null}
              </>
            )}
          </MenuSection>
          <MenuSection label="Session totals">
            {line('Fresh input', `${formatK(metrics?.inputTokens ?? 0)} tokens`)}
            {line('From cache', `${formatK(metrics?.cacheReadTokens ?? 0)} tokens`, 'served from the prompt cache: much cheaper')}
            {line('Written to cache', `${formatK(metrics?.cacheWriteTokens ?? 0)} tokens`)}
            {line('Output', `${formatK(metrics?.outputTokens ?? 0)} tokens`)}
            {line('Speed', `${(metrics?.tpsAvg ?? 0).toFixed(0)} tok/s`, 'average since the turn started')}
          </MenuSection>
        </>
      )}
    </MenuTrigger>
  )
}

/** Token counts, short enough for a status bar. */
function formatK(tokens: number): string {
  // A long session's cache reads run into the tens of millions: "75439.6k" is
  // a number to count digits in, "75.4M" is one to read.
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : `${tokens}`
}

/**
 * The subagent list behind the status-bar chip: what is running, and — behind a
 * click, because it is history — what already finished. Mixing the two in one
 * flat list made "archived" look like more of the same running work.
 */
export function SubagentMenu({ items }: { items: Array<{ toolId: string; label: string; running: boolean }> }) {
  const [showArchive, setShowArchive] = useState(false)
  const running = items.filter((item) => item.running)
  const finished = items.filter((item) => !item.running)

  return (
    <>
      <div className="menu-title">{running.length ? `Running Now · ${running.length}` : 'Nothing Running'}</div>
      {running.length === 0 ? <div className="menu-note">No subagent is working right now.</div> : null}
      {running.map((item) => (
        <div className="menu-row" key={item.toolId}>
          <span className="dot running" />
          <span className="menu-item-name">{item.label}</span>
        </div>
      ))}
      {finished.length ? (
        <>
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => setShowArchive((value) => !value)}>
            <span className="menu-item-name">
              Earlier · {finished.length} archived
            </span>
            <span className="spacer" />
            <span className="caret">{showArchive ? '▾' : '▸'}</span>
          </button>
          {showArchive
            ? finished.map((item) => (
                <div className="menu-row" key={item.toolId}>
                  <span className="dot stopped" />
                  <span className="menu-item-name">{item.label}</span>
                </div>
              ))
            : null}
        </>
      ) : null}
    </>
  )
}

export function StatusBar({ state, session, terminalControl }: { state: State; session: SessionSummary | null; terminalControl?: React.ReactNode }) {
  // Live, unlike the shell's `session` (see `shellState`).
  const metrics = useStore((s) => (session ? (s.sessions[session.id]?.metrics ?? session.metrics) : undefined))
  const live = session?.status === 'running'
  const subagents = useMemo(() => {
    type Item = { toolId: string; label: string; running: boolean }
    if (!session) return { running: 0, total: 0, list: [] as Item[] }
    // Same derivation the transcript cards use, so the two can never disagree.
    const items: Item[] = subagentInfos(state.events[session.id] ?? []).map((info) => ({
      toolId: info.toolId,
      label: info.description,
      // Nothing can still be working in a session that is not running. The
      // provisional-completion rule can be fooled by a trailing sidechain event,
      // and "2 running" on a finished turn outlives its usefulness fast.
      running: info.running && live,
    }))
    // The ledger's count of live agents, when the server keeps one; the events'
    // reading otherwise.
    const counted = session ? activeAgentsOf(state.turns[session.id]) : null
    return { running: counted ?? items.filter((item) => item.running).length, total: items.length, list: items }
  }, [session?.id, session ? state.events[session.id] : undefined, session ? state.turns[session.id] : undefined, live])

  const costUnknown = metrics?.costReported === false
  const enabledLimitHarnesses = rawCapsFor(state, state.settings.machine)?.harnesses
    .filter((harness) => harness.enabled !== false)
    .map((harness) => harness.id)

  return (
    <div className="statusbar">
      <LimitsGroup limits={state.limits} enabledHarnesses={enabledLimitHarnesses} />
      {session ? (
        <>
          {session.kind === 'terminal' ? (
            <span className="group status-detail">
              <span className="mono" title="Reopen this shell outside the app">
                {session.resumeHint ?? 'tmux'}
              </span>
            </span>
          ) : (
            <span className="group status-detail">
              {metrics?.lastTtftMs ? (
                <span className="mono" title="time to first token">
                  TTFT {metrics.lastTtftMs}ms
                </span>
              ) : null}
            </span>
          )}
          {subagents.running > 0 ? (
            <span className="group">
              {/* Only while something is running: "13 subagents" beside an idle
                  session read as thirteen still open. The count is what runs
                  now; on click the list shows them, with the finished ones
                  under an archive. Finished history lives in the transcript. */}
              <MenuTrigger
                className="clickable"
                title="Subagents in this session"
                width={360}
                trigger={() => (
                  <span className="chip mono">
                    <span className="dot running" />
                    {`${subagents.running} running`}
                  </span>
                )}
              >
                {() => <SubagentMenu items={subagents.list} />}
              </MenuTrigger>
            </span>
          ) : null}
          <span className="spacer" />
          {/* The token ledger keeps cumulative traffic here. Context fullness
              has one home beside the composer, so its percentage is not
              repeated in this bar. */}
          <span className="group status-detail">
            {metrics?.inputTokens ? (
              <span className="mono" title="fresh input tokens">
                {formatK(metrics.inputTokens)} In
              </span>
            ) : null}
            {metrics?.cacheReadTokens ? (
              <span className="mono" title="input served from the prompt cache (much cheaper)">
                {formatK(metrics.cacheReadTokens)} Cache
              </span>
            ) : null}
            {metrics?.outputTokens ? (
              <span className="mono" title="output tokens this session">
                {formatK(metrics.outputTokens)} Out
              </span>
            ) : null}
            {/* A subscription charges nothing per token, so the figure is only
                shown when the user asks for it — and when it is asked for, a
                harness that publishes no price says so. `$0.0000` is a claim
                about what the turn cost; an em dash is the absence of one. */}
            {!state.settings.showCost ? null : costUnknown ? (
              <span className="mono unreported" title="This harness does not report a cost — no price was given, not a price of zero">
                $ —
              </span>
            ) : metrics?.costUsd || metrics?.costReported ? (
              <span className="mono" title="equivalent API cost — not charged on a subscription">
                ${(metrics.costUsd ?? 0).toFixed(4)}
              </span>
            ) : null}
          </span>
          {terminalControl ? <span className="group terminal-control">{terminalControl}</span> : null}
        </>
      ) : (
        <span className="spacer" />
      )}
    </div>
  )
}
