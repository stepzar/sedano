import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { SessionSummary } from '@shared'
import { Composer, Rail, StatusBar, TabStrip, TopBar, tabTitle } from './components/Chrome.tsx'
import { FilesPanel } from './components/Files.tsx'
import { FILES_RESIZE, RAIL_RESIZE, Resizer } from './components/Resize.tsx'
import { Launchpad } from './components/Launchpad.tsx'
import { Dialogs, Palette, Toasts } from './components/Overlays.tsx'
import { SettingsDialog } from './components/Settings.tsx'
import { TerminalDock, TerminalHandle, TerminalView, raiseTerminal } from './components/Terminal.tsx'
import { TransferDialog } from './components/Transfer.tsx'
import { ImportSessionsHost } from './components/ImportSessions.tsx'
import { Transcript } from './components/Transcript.tsx'
// Loaded after the main stylesheet, which is imported by `main.tsx` before this
// module: the column picker and the bottom terminal add shapes on top of the
// app's tokens rather than restyling anything already there.
import './nav.css'
// The shell's own layer: the centred location pill, then the phone layout,
// which has to come last to win at its breakpoint.
import './shell.css'
import './round.css'
import './mobile.css'
import { setDrawer, toggleDrawer, useDrawer, useMobile } from './mobile.ts'
import { UpdatePill } from './components/UpdatePill.tsx'
import {
  adjustContentFont,
  adjustUiFont,
  applySettings,
  closeTab,
  connect,
  getState,
  interruptSession,
  markSeen,
  newTerminal,
  openDraft,
  refreshLimits,
  selectTab,
  shellState,
  stripTabs,
  updateSettings,
  useStore,
  watchSystemTheme,
  workspaceKey,
} from './store.ts'
import { tabAtShortcut, tabShortcut } from './shortcuts.ts'

type Overlay = 'none' | 'palette' | 'settings'

export function App() {
  // Not the whole state: streamed tokens and metrics ticks are read by the
  // transcript, composer and meters themselves (see `shellState`).
  const state = useStore(shellState)
  const mobile = useMobile()
  const drawer = useDrawer()
  const railShown = mobile ? drawer : state.settings.railVisible
  const [overlay, setOverlay] = useState<Overlay>('none')
  const [transfer, setTransfer] = useState<SessionSummary | null>(null)

  const activeId = state.active
  const draft = activeId ? (state.drafts[activeId] ?? null) : null
  const session = activeId && !draft ? (state.sessions[activeId] ?? null) : null
  const events = session ? (state.events[session.id] ?? []) : []

  // Opening a tab manually plays a short expand: the launchpad becomes the pane
  // it promised. Only a launch (draft → session) animates, not switching tabs.
  const [entering, setEntering] = useState<'agent' | 'terminal' | null>(null)
  const launchedFrom = useRef({ draft: false })

  useEffect(() => {
    applySettings(getState().settings)
    watchSystemTheme()
    connect()
    // Capabilities (harnesses, presets, hosts, voice) are fetched by the socket
    // itself on every (re)open, so there is nothing to ask for here — asking
    // before the socket is open only queued a message and warned about it.
    // A slow, non-forcing poll: the limits are a reading, and the usage endpoint
    // throttles anyone who asks too often.
    const timer = setInterval(() => refreshLimits(), 300_000)
    return () => clearInterval(timer)
  }, [])

  /**
   * An empty app is a question, not a blank page: with nothing active the pane
   * asks what to open. The chooser is a pane rather than a tab, so nothing is
   * opened until you answer it — and it is shown whether or not the server is
   * up, because a blank pane reads as "the app is broken" instead.
   */
  useEffect(() => {
    if (!state.active) openDraft(null)
  }, [state.active, state.version])

  useEffect(() => {
    if (session) markSeen(session.id)
  }, [session?.id, session?.updatedAt])

  useEffect(() => {
    const cameFromDraft = launchedFrom.current.draft
    launchedFrom.current = { draft: Boolean(draft) }
    if (!cameFromDraft || !session) return
    setEntering(session.kind)
    const timer = setTimeout(() => setEntering(null), 380)
    return () => clearTimeout(timer)
  }, [activeId, session?.id, session?.kind, draft])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey
      const key = event.key.toLowerCase()
      if (meta && key === 'k') {
        event.preventDefault()
        setOverlay((value) => (value === 'palette' ? 'none' : 'palette'))
        return
      }
      if (meta && key === 't') {
        event.preventDefault()
        // A terminal needs no form: it opens on the machine you picked in the
        // top-left, in the home of that machine.
        void newTerminal(getState())
        return
      }
      if (meta && key === 'd') {
        event.preventDefault()
        openDraft('agent')
        return
      }
      // ⌘J raises the quick terminal from the bottom of the pane and puts it
      // away again. Only an agent screen has one — a terminal tab already is the
      // shell — so on one the key is left alone rather than swallowed.
      if (meta && key === 'j') {
        const current = getState().active ? getState().sessions[getState().active!] : null
        if (!current || current.kind === 'terminal') return
        event.preventDefault()
        raiseTerminal(current.id)
        return
      }
      if (meta && key === 'b') {
        event.preventDefault()
        if (mobile) toggleDrawer()
        else updateSettings({ railVisible: !getState().settings.railVisible })
        return
      }
      if (meta && key === 'w') {
        event.preventDefault()
        // Read now, not from the render this handler was made in: after a ⌘2
        // the closure's tab is no longer the one on screen.
        const current = getState().active
        if (current) closeTab(current)
        return
      }
      if (meta && event.key === ',') {
        event.preventDefault()
        setOverlay('settings')
        return
      }
      // ⌘1…⌘9 jump to the tab at that position in the strip, in the order the
      // user dragged them into; ⌘9 is always the last tab, as in a browser.
      const position = tabShortcut(event)
      if (position !== null) {
        const target = tabAtShortcut(stripTabs(getState()), position)
        event.preventDefault()
        if (target && target !== getState().active) selectTab(target)
        return
      }
      if (meta && (event.key === '+' || event.key === '=')) {
        event.preventDefault()
        if (event.altKey) adjustUiFont(1)
        else adjustContentFont(1)
        return
      }
      if (meta && (event.key === '-' || event.key === '_')) {
        event.preventDefault()
        if (event.altKey) adjustUiFont(-1)
        else adjustContentFont(-1)
        return
      }
      if (event.key === 'Escape' && !meta) {
        // A menu or popover already used this Esc to close itself.
        if (event.defaultPrevented) return
        if (overlay !== 'none') {
          setOverlay('none')
          return
        }
        const current = getState().active ? getState().sessions[getState().active!] : null
        if (current?.status === 'running' && current.kind !== 'terminal') interruptSession(current.id)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [overlay, draft?.cwd, session?.cwd, mobile])

  // Leaving the phone layout (rotating an iPad, resizing a window) must not
  // leave an invisible drawer open behind the desktop rail.
  useEffect(() => {
    if (!mobile) setDrawer(false)
  }, [mobile])

  const title = useMemo(() => {
    // A chooser is not a thing that is open: the window keeps the app's own name
    // instead of claiming a tab that has not been opened.
    if (draft) return draft.kind === null ? 'sedano' : 'New Session'
    if (session) return tabTitle(state, session.id)
    return 'sedano'
  }, [draft?.id, draft?.kind, session?.id, session?.title, session?.status, state.version])

  useEffect(() => {
    document.title = title && title !== 'sedano' ? `${title} · sedano` : 'sedano'
  }, [title])

  const onFileStats = useCallback(() => undefined, [])

  /**
   * The quick terminal of an agent's screen. It is the same panel in both dock
   * positions — only where it sits changes — and it is keyed by the agent so that
   * moving to another conversation mounts that conversation's own shell instead
   * of leaving this one's screen on display.
   */
  const dock =
    session && session.kind !== 'terminal' ? <TerminalDock key={session.id} agent={session} /> : null

  /**
   * What the file explorer is pointed at.
   *
   * A tab that has not started yet has a folder too — the one you picked for it —
   * and the tree is exactly as useful there: you choose where to work by looking
   * at it. It used to be unavailable until a session existed, which meant the
   * explorer was missing in the one moment you were deciding the folder.
   */
  const browseRoot =
    state.settings.filesVisible && session
      ? { cwd: session.cwd, host: session.host }
      : state.settings.filesVisible && draft?.cwd
        ? { cwd: draft.cwd, host: draft.host }
        : null

  /**
   * The terminal tabs of the workspace on screen. All of them are rendered, so
   * switching between them is just a change of which one is visible — the shells
   * behind them keep streaming, and their screens (and scrollback) are never
   * rebuilt. The session on screen is included even if it has no tab yet.
   */
  const terminalSlots = useMemo(() => {
    if (!session || session.kind !== 'terminal') return []
    const ids = state.tabs[workspaceKey(session.host, session.cwd)] ?? []
    const slots = (ids.includes(session.id) ? ids : [session.id, ...ids])
      .map((id) => state.sessions[id])
      .filter((item): item is SessionSummary => Boolean(item) && item!.kind === 'terminal')
    return slots
  }, [session?.id, session?.kind, session?.host, session?.cwd, state.tabs, state.sessions, state.version])

  return (
    <div className="app">
      <TopBar
        state={state}
        onOpenPalette={() => setOverlay('palette')}
        onOpenSettings={() => setOverlay('settings')}
      />
      <div className={`body${railShown ? '' : ' rail-hidden'}`}>
        <Rail state={state} />
        {mobile ? (
          drawer ? <div className="drawer-scrim" onClick={() => setDrawer(false)} aria-hidden /> : null
        ) : railShown ? (
          <Resizer spec={RAIL_RESIZE} />
        ) : null}
        <div className="pane">
          <TabStrip state={state} onTransfer={setTransfer} />
          <div className="pane-body">
            <div className={`pane-main${entering ? ` entering entering-${entering}` : ''}`}>
              {/* Everything you see in a pane comes from the server. Without a
                  socket the panes look empty, which reads as "the session lost
                  its history" — say what is actually going on instead. */}
              {!state.connected ? (
                <div className="offline-banner">
                  <span className="dot err" />
                  <span>
                    Not connected to the sedano server — reconnecting. Sessions and history live on the server; they
                    appear here as soon as it is back.
                  </span>
                </div>
              ) : null}
              {draft ? <Launchpad state={state} draft={draft} /> : null}
              {session ? (
                <>
                  {session.kind === 'terminal' ? (
                    // Every terminal tab of this workspace stays mounted, and only
                    // the one on screen is visible. Remounting on each switch is
                    // what made a terminal paint itself again from an empty screen
                    // — a white flash, then the shell's screen redrawn from a
                    // fresh capture — while an agent tab, which renders from the
                    // events it already has, appeared instantly. Keeping them
                    // mounted also keeps the scrollback you had scrolled back to.
                    <div className="term-slots">
                      {terminalSlots.map((item) => (
                        <div
                          key={item.id}
                          className={`pane-slot${item.id === session.id ? '' : ' hidden'}`}
                          aria-hidden={item.id !== session.id}
                        >
                          <TerminalView session={item} />
                        </div>
                      ))}
                    </div>
                  ) : (
                    <>
                      {/* Keyed by session: each one opens fresh, at its latest
                          message, instead of inheriting the scroll position and
                          the follow state of the tab shown before it. */}
                      <Transcript
                        key={session.id}
                        session={session}
                        events={events}
                        settings={state.settings}
                        connected={state.connected}
                        onFileStats={onFileStats}
                      />
                      <Composer session={session} state={state} />
                    </>
                  )}
                </>
              ) : null}
              {/* No draft and no session is the half-frame before the chooser
                  above opens: the question is the front door, never a panel of
                  marketing copy. */}
              {!draft && !session ? null : null}
            </div>
            {/* Only for a session: the tree is the directory the work happens in,
                and a tab that is still a draft has none. */}
            {browseRoot ? (
              <>
                {mobile ? null : <Resizer spec={FILES_RESIZE} />}
                {/* Keyed by the directory it shows: switching sessions must
                    remount the tree, or it keeps the previous session's listing. */}
                <FilesPanel key={`${browseRoot.host ?? ''}:${browseRoot.cwd}`} cwd={browseRoot.cwd} host={browseRoot.host} />
              </>
            ) : null}
          </div>
          {/* The panel shares this pane; its control lives in the bottom bar. */}
          {dock}
        </div>
      </div>
      <StatusBar state={state} session={session}
        terminalControl={session && session.kind !== 'terminal' ? <TerminalHandle agent={session} /> : null} />

      {overlay === 'palette' ? (
        <Palette state={state} onClose={() => setOverlay('none')} onOpenSettings={() => setOverlay('settings')} />
      ) : null}
      {overlay === 'settings' ? <SettingsDialog state={state} onClose={() => setOverlay('none')} /> : null}
      {transfer ? <TransferDialog state={state} session={transfer} onClose={() => setTransfer(null)} /> : null}
      <ImportSessionsHost onTransfer={setTransfer} />

      <UpdatePill />
      <Toasts toasts={state.toasts} />
      <Dialogs dialog={state.dialog} />
    </div>
  )
}

export type { SessionSummary }
