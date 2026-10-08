import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { SessionSummary } from '@shared'
import {
  getState,
  closeDockTerminal,
  newDockTerminal,
  onTermOutput,
  onTermSnapshot,
  releaseTerminal,
  requestTermSnapshot,
  resizeTerm,
  retainTerminal,
  selectDockTerminal,
  sendTermInput,
  toggleDock,
  useStore,
} from '../store.ts'
import { IconClose, IconPlus, IconTerminal } from './Icons.tsx'
import { APPLE, tabShortcut } from '../shortcuts.ts'
import { DockResizer } from './Resize.tsx'

/**
 * The keys that belong to the app rather than to a shell.
 *
 * A terminal that is on screen must not eat them: ⌘J with the caret in the
 * docked shell has to put that shell away, which it cannot do if xterm claims
 * the keystroke first.
 */
const APP_KEYS = new Set(['j', 'k', 't', 'd', 'b', 'w'])

/**
 * On a Mac the app's chords are ⌘ ones and Control belongs to the shell:
 * ^D is end-of-input, ^W deletes a word, ^K kills the line, ^B moves back.
 * Handing those back to the app too kept them from ever reaching the shell,
 * and ^W then closed the tab instead of deleting a word. ⌘1…⌘9 switch tabs
 * (see `tabShortcut`), so they are the app's too.
 */
function isAppChord(event: KeyboardEvent): boolean {
  if (tabShortcut(event) !== null) return true
  const chord = APPLE ? event.metaKey : event.metaKey || event.ctrlKey
  return chord && APP_KEYS.has(event.key.toLowerCase())
}

/**
 * A terminal tab.
 *
 * Rendering is left to xterm.js: a terminal is not text, and a custom renderer
 * would mangle cursor moves, alternate screens and TUI apps — exactly the mess
 * that makes terminal panes unreadable elsewhere. Colours come from the app
 * tokens, so the surface stays neutral in both themes.
 */
/** The terminal's font size: the conversation size, never below 11px. */
function terminalFontSize(): number {
  const size = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--content-font-size'))
  return Math.max(11, size || 14)
}

function themeFromCss(): Record<string, string> {
  const styles = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback
  const surface = read('--surface', '#ffffff')
  const fg = read('--fg', '#111111')
  const mute = read('--fg-mute', '#777777')
  return {
    background: surface,
    foreground: fg,
    cursor: fg,
    cursorAccent: surface,
    selectionBackground: read('--active', 'rgba(0,0,0,0.12)'),
    black: '#3b3b3b',
    red: read('--err', '#c04a3f'),
    green: read('--ok', '#3f7d5a'),
    yellow: read('--warn', '#b08430'),
    blue: '#4a6b8f',
    magenta: '#7f5f8f',
    cyan: '#3f7d84',
    white: fg,
    brightBlack: mute,
    brightRed: read('--err', '#c04a3f'),
    brightGreen: read('--ok', '#3f7d5a'),
    brightYellow: read('--warn', '#b08430'),
    brightBlue: '#5d81a8',
    brightMagenta: '#9673a6',
    brightCyan: '#4d949c',
    brightWhite: fg,
  }
}

/**
 * `autoFocus` is for a terminal that was just asked for by a click — the quick
 * terminal of an agent's screen. A terminal tab takes the caret only when nothing
 * else has it, because the shortcut that opens it leaves the focus nowhere; the
 * panel is opened from a button, which keeps the focus, and a terminal that
 * swallowed the first keystroke you typed into it reads as a broken one.
 */
export function TerminalView({ session, autoFocus = false }: { session: SessionSummary; autoFocus?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<XTerm | null>(null)
  const fit = useRef<FitAddon | null>(null)

  /**
   * Live bytes seen, and the count when the last snapshot was asked for.
   *
   * A replay *replaces* the screen, which is right for a stale one and wrong for
   * the one in front of you: type into a tab while a snapshot is in flight (a
   * capture is asked for on every resize, plus three retries while the pane is
   * still blank) and the one that lands a moment later is drawn over what you
   * just wrote. What you see then is not what the shell has — a character missing
   * here, a word doubled there — and it reads as "typing is broken" for a line the
   * pane never lost. The count is the fix: a replay is only worth drawing if
   * nothing live has arrived since it was asked for, because then the screen is
   * already ahead of it. A reattach that is genuinely out of step asks again on
   * window focus, and that request is the one that lands.
   */
  const live = useRef({ bytes: 0, askedAt: 0 })
  const askForScreen = (history = false) => {
    live.current.askedAt = live.current.bytes
    requestTermSnapshot(session.id, history)
  }

  useEffect(() => {
    live.current = { bytes: 0, askedAt: 0 }
    if (!host.current) return
    // While this view exists its session stays subscribed, even when the tab is
    // not the one on screen (see `retainTerminal`).
    retainTerminal(session.id)
    const terminal = new XTerm({
      fontFamily:
        "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, monospace",
      fontSize: terminalFontSize(),
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10_000,
      macOptionIsMeta: true,
      theme: themeFromCss(),
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(host.current)
    term.current = terminal
    fit.current = fitAddon

    /** The geometry the pane has been told about, so we only speak when it changes. */
    let sent = { cols: 0, rows: 0 }
    /**
     * The scrollback is worth asking for once per mount: that is the attach, and
     * everything you had scrolled back to is what an attach is missing. A replay
     * after that is a resync of the screen already on display — history there
     * would just be the same lines again, every time you switch windows.
     */
    let wantHistory = true
    const applySize = () => {
      try {
        fitAddon.fit()
        if (terminal.cols === sent.cols && terminal.rows === sent.rows) return
        sent = { cols: terminal.cols, rows: terminal.rows }
        resizeTerm(session.id, terminal.cols, terminal.rows)
        // The screen is re-captured at the size it will be drawn at. A capture
        // taken for the previous width replays wrapped and columned all wrong —
        // "ls" spread over the line, the prompt stranded mid-row — so a real
        // change of geometry is always followed by a fresh replay.
        askForScreen(wantHistory)
      } catch {
        /* the element may be hidden while the tab is inactive */
      }
    }
    // The first fit waits a beat: at mount the pane is still animating in, and a
    // measurement taken mid-animation is a size the window will not actually
    // have — which meant two resizes, two SIGWINCH and a prompt drawn twice.
    // The ResizeObserver fires once on observe, so the debounced path below
    // takes the measurement once the layout is real.

    // A terminal tab opens so you can type into it: take the caret straight
    // away, otherwise the first keystrokes land on the body and are lost.
    const active = document.activeElement as HTMLElement | null
    if (autoFocus || !active || active === document.body) terminal.focus()

    // xterm sees the keystroke before the window does, so the app's own chords
    // are handed straight back: returning false keeps them out of the shell and
    // lets them bubble to the handler in `App.tsx`.
    terminal.attachCustomKeyEventHandler((event) => {
      if (isAppChord(event)) return false
      return true
    })

    const dataSub = terminal.onData((data) => sendTermInput(session.id, data))

    /**
     * A replayed screen *replaces* what the terminal has, because it is the whole
     * screen: that is what stops a reattach from stacking a second copy of the
     * pane under the first. Live bytes are appended as they arrive.
     *
     * It must not be skipped just because a few live bytes got here first. The
     * shell answers a resize with a cursor sequence and nothing else, so the pane
     * looked empty — a cursor alone in the middle of nothing — while the screen
     * it already had was thrown away.
     */
    let seeded = false
    /**
     * How far into the pane's stream the screen on display reaches, and how far
     * the live output already drawn reaches.
     *
     * They are two different questions and both matter. A chunk the screen
     * already covers must not be drawn again — the shell's first prompt is
     * written just before the capture and delivered just after it, and drawing
     * both printed it twice on one line. And a screen filmed *before* output that
     * has already been drawn must not replace it — that is the terminal that was
     * one row behind the shell, with your last command scrolled out of sight.
     */
    let covered = 0
    let liveUpTo = 0
    const titles = dropPaneTitles()
    const offOutput = onTermOutput((sessionId, data, meta) => {
      if (sessionId !== session.id) return
      live.current.bytes += data.length
      if (meta?.offset !== undefined && meta.offset <= covered) return
      const visible = titles(data)
      if (visible) terminal.write(visible)
      if (meta?.offset !== undefined) liveUpTo = Math.max(liveUpTo, meta.offset)
    })
    const offSnapshot = onTermSnapshot((sessionId, data, meta) => {
      if (sessionId !== session.id) return
      // Nothing live since it was asked for, or it is a capture of a screen we
      // have already moved past.
      if (live.current.bytes !== live.current.askedAt) return
      // A screen filmed before output that has already been drawn would take that
      // output away: the terminal then sits one row behind the shell and the
      // command you just ran is above the fold, which reads as "part of it is
      // missing, I have to scroll up". A replay is only worth drawing when it is
      // at least as new as what is on display.
      if (meta?.offset !== undefined && meta.offset < liveUpTo) return
      // The frame is already exactly the rows of the pane: the driver takes the
      // capture's own trailing newline off, so what arrives is R lines joined by
      // R-1 newlines and writing it fills an R-row terminal precisely, with
      // nothing scrolled off the top.
      //
      // Taking another newline off here is what put the terminal a row behind the
      // pane. On a screen replayed alone nobody sees it — the row it loses is the
      // blank one at the bottom. Replayed with the scrollback an attach brings
      // along, it slides the whole picture up by a row: the last line of the
      // history comes to rest where the pane's first row belongs, and a shell
      // whose scrollback is a column of identical prompts then shows its prompt
      // twice with the rest of the pane empty. That is the "two prompts and
      // nothing else" a docked terminal opened on.
      const cursor = meta?.cursor
      const screen = data
      if (!screen.trim()) return
      terminal.reset()
      // `tmux capture-pane` separates its lines with a bare LF, and xterm reads
      // LF as "down one row, same column" — writing it verbatim painted the pane
      // as a staircase, each line starting where the previous one ended. A
      // terminal line always begins at the left margin, so the CR is put back.
      //
      // And the cursor is put where the pane says it is, last: the capture drops
      // the padding tmux pads every row with, so a screen written out ends left
      // of the real cursor — one cell early on a shell prompt — and the shell's
      // next echo then lands on a cell that belonged to the prompt (`✗ ls` came
      // out as `✗ls`). Only the pane knows, so only the pane gets to say.
      const place = cursor ? `\u001b[${cursor.y + 1};${cursor.x + 1}H` : ''
      terminal.write(screen.replace(/\r?\n/g, '\r\n') + place)
      seeded = true
      if (meta?.offset !== undefined) covered = meta.offset
      // From here on a replay is a resync, not an attach.
      wantHistory = false
    })

    // The pane may still be empty the instant we mount — tmux is starting the
    // shell, and `pipe-pane` only sees what is written after it attaches, so the
    // first prompt can be missed entirely. The first snapshot goes out with the
    // first resize (at the real geometry); these retries cover a blank one.
    const retries = [700, 1500, 3000].map((delay) =>
      setTimeout(() => {
        if (!seeded) askForScreen(wantHistory)
      }, delay),
    )

    // Resizes are coalesced: every `resize-window` makes the shell redraw its
    // prompt line, and a burst of them from one layout change would paint a
    // column of prompts down the pane.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(applySize, 60)
    })
    observer.observe(host.current)

    // "Conversation text" sizes terminals too, and has to reach one that is
    // already open: the setting lands as an inline variable on the root, so a
    // change there is re-read, and the pane refitted to the new cell size.
    const sizeWatch = new MutationObserver(() => {
      const next = terminalFontSize()
      if (terminal.options.fontSize === next) return
      terminal.options.fontSize = next
      applySize()
    })
    sizeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })

    const onFocus = () => terminal.focus()
    host.current.addEventListener('mousedown', onFocus)

    const onKey = (event: KeyboardEvent) => {
      // ⌘K and friends belong to the app, everything else to the shell.
      if ((event.metaKey && APP_KEYS.has(event.key.toLowerCase())) || tabShortcut(event) !== null) return
      const focused = document.activeElement as HTMLElement | null
      // Never take the caret away from a field the user is typing into. The
      // terminal's own composer sits directly below the pane, so focusing the
      // terminal on every keydown made both of them half-unusable.
      if (focused && focused !== document.body) {
        if (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA' || focused.isContentEditable) return
        if (host.current?.contains(focused)) return
      }
      terminal.focus()
    }
    window.addEventListener('keydown', onKey)

    return () => {
      releaseTerminal(session.id)
      observer.disconnect()
      sizeWatch.disconnect()
      if (resizeTimer) clearTimeout(resizeTimer)
      for (const timer of retries) clearTimeout(timer)
      host.current?.removeEventListener('mousedown', onFocus)
      window.removeEventListener('keydown', onKey)
      dataSub.dispose()
      offOutput()
      offSnapshot()
      terminal.dispose()
      term.current = null
    }
  }, [session.id])

  // Coming back to the window is exactly when a terminal can be out of step: the
  // live stream may have handed us a fragment of an escape sequence while we were
  // away, which leaves the cursor elsewhere and every following line in the wrong
  // column. The pane is the truth, so ask for its screen again and replace ours.
  useEffect(() => {
    const resync = () => {
      if (document.visibilityState !== 'visible') return
      askForScreen()
    }
    window.addEventListener('focus', resync)
    document.addEventListener('visibilitychange', resync)
    return () => {
      window.removeEventListener('focus', resync)
      document.removeEventListener('visibilitychange', resync)
    }
  }, [session.id])

  // Theme switches must reach the running terminal too.
  useEffect(() => {
    const apply = () => {
      if (term.current) term.current.options.theme = themeFromCss()
    }
    const observer = new MutationObserver(apply)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  return <div className="term-host" ref={host} />
}

/**
 * A filter for the window-title escapes a pane emits.
 *
 * `ESC ] 2 ; …` is xterm's own spelling and xterm.js consumes it correctly.
 * `ESC k … ST` is the *screen* spelling, and that is the one a shell inside tmux
 * uses — oh-my-zsh and friends pick it from `$TERM` — which xterm.js does not
 * know: it drops the introducer and types the payload into the screen. What the
 * payload holds is the command that is about to run, so the terminal repeats
 * every command you type inside its own output, and when it lands on the prompt
 * line the two are glued together.
 *
 * The sequence only ever sets a title nobody in this app reads, so it is
 * swallowed whole — one piece even when the pane splits it across reads, which
 * is why the filter remembers what it is holding.
 */
function dropPaneTitles(): (chunk: string) => string {
  let held = ''
  return (chunk: string): string => {
    let text = held + chunk
    held = ''
    let out = ''
    for (;;) {
      const start = text.indexOf('\u001bk')
      if (start < 0) break
      const bell = text.indexOf('\u0007', start + 2)
      const st = text.indexOf('\u001b\\', start + 2)
      const end = bell >= 0 && (st < 0 || bell < st) ? bell + 1 : st >= 0 ? st + 2 : -1
      if (end < 0) {
        // No terminator yet: keep it and wait for the rest.
        out += text.slice(0, start)
        held = text.slice(start)
        // A title cannot be this long, and a pane writing nonsense must not turn
        // into a buffer that grows forever with a frozen screen behind it.
        if (held.length > 4096) held = ''
        return out
      }
      out += text.slice(0, start)
      text = text.slice(end)
    }
    // A lone ESC may be the introducer of a title arriving in the next read.
    if (text.endsWith('\u001b')) {
      held = '\u001b'
      text = text.slice(0, -1)
    }
    return out + text
  }
}

/**
 * The quick terminal of an agent's screen: a shell in the folder that agent works
 * in, beside the conversation or under it.
 *
 * It is the same xterm a terminal tab is — one terminal, one behaviour, one set
 * of keystroke and snapshot rules — mounted in a panel instead of across the
 * whole pane. It is also a *different session* from the one ⌘T opens, which is
 * the point: a command in here must not disturb the full-size terminal you left
 * in the middle of something.
 *
 * The session it shows is deliberately not a tab (see `toggleDock`), so this is
 * the only view of it: nothing else draws these bytes, and closing the panel
 * leaves the shell running in tmux for the next click.
 */
/**
 * Raise the terminal from the bottom, or put it away.
 *
 * ⌘J and the handle on the bottom edge both name a direction, so opening always
 * opens downstairs: a shortcut that sometimes produced a column on the right
 * would be a different shortcut, and the panel has to arrive from where the
 * control is or the two read as unrelated.
 *
 * The panel has one home: below the conversation.
 */
export function raiseTerminal(agentId: string): void {
  const state = getState()
  /**
   * A transcript that was read to the end has to still end on screen afterwards.
   *
   * The panel takes its height *from* the transcript rather than covering it, and
   * the scroller is never remounted — so its `scrollTop` survives the change,
   * which is precisely what leaves the last line one panel-height below the new
   * fold. Nothing about the transcript's own scrolling is touched here: whether
   * it was anchored to the end is read before the panel moves, and the anchor is
   * put back only if it was there. A transcript scrolled to the middle keeps the
   * exact place it was left.
   */
  const scroller = document.querySelector<HTMLElement>('.transcript')
  const atEnd = scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 8 : false

  toggleDock(agentId)

  // Two frames: the first is the render the toggle caused, the second is the
  // layout it produced.
  if (atEnd && scroller) {
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        scroller.scrollTop = scroller.scrollHeight
      }),
    )
  }
}

/**
 * The control for the docked terminal, inside the bottom bar.
 *
 * It used to be an icon in the top-right toolbar, as far from the panel it opens
 * as the window allows. Down here it is the lip the panel comes up out of, and
 * it carries its own shortcut: a key that raises a panel is only discoverable
 * where the panel appears.
 */
export function TerminalHandle({ agent }: { agent: SessionSummary }) {
  const open = useStore((s) => s.docks[agent.id]?.open ?? false)
  return (
    <button
      className={`icon-btn term-handle${open ? ' on' : ''}`}
      onClick={() => raiseTerminal(agent.id)}
      aria-label={open ? 'Put the terminal away' : 'Raise a terminal'}
      aria-pressed={open}
      title={
        open
          ? 'Put the terminal away (⌘J) — the shell keeps running'
          : 'Raise a terminal in this session’s folder (⌘J)'
      }
    >
      <IconTerminal size={16} />
    </button>
  )
}

export function TerminalDock({ agent }: { agent: SessionSummary }) {
  const dock = useStore((s) => s.docks[agent.id] ?? null)
  const terminalId = dock?.active ?? dock?.terminals[0] ?? null
  const terminal = useStore((s) => (terminalId ? (s.sessions[terminalId] ?? null) : null))
  if (!dock?.open) return null

  const where = terminal?.cwd ?? agent.cwd
  return (
    <div className="dock dock-bottom">
      <DockResizer />
      <div className="dock-head">
        <div className="dock-tabs" role="tablist" aria-label="Terminals">
          {dock.terminals.map((id, index) => (
            <button
              key={id}
              className={`dock-tab${id === (dock.active ?? terminal?.id) ? ' active' : ''}`}
              role="tab"
              aria-selected={id === (dock.active ?? terminal?.id)}
              onClick={() => selectDockTerminal(agent.id, id)}
            >
              <span>Terminal {index + 1}</span>
              <span
                className="dock-tab-x"
                onClick={(event) => {
                  event.stopPropagation()
                  closeDockTerminal(agent.id, id)
                }}
                title="Close this terminal"
              >
                <IconClose size={11} />
              </span>
            </button>
          ))}
          <button className="dock-tab-add" onClick={() => newDockTerminal(agent.id)} title="New terminal tab">
            <IconPlus size={14} />
          </button>
        </div>
        <span className="spacer" />
        <span className="path mono" title={`${where}${agent.host ? ` · ${agent.host}` : ''}`}>{where}</span>
        <button className="icon-btn dock-close" onClick={() => toggleDock(agent.id)} title="Put the terminal away" aria-label="Put the terminal away">
          <IconClose size={14} />
        </button>
      </div>
      {/* A host takes a moment to answer and start tmux, and saying so beats a
          panel that looks broken for two seconds. */}
      {terminal ? (
        <TerminalView session={terminal} autoFocus />
      ) : (
        <div className="dock-wait">Starting a shell in {where}…</div>
      )}
    </div>
  )
}
