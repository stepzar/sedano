import { useEffect, useMemo, useRef } from 'react'
import type { SessionEvent } from '@shared'
import { HARNESS_LABEL } from '@shared'
import type { State } from '../store.ts'
import {
  SESSION_STATE_WORD,
  closeTab,
  colorForMachine,
  holdPreview,
  isUnread,
  openDraft,
  releasePreview,
  selectTab,
  sessionState,
  useStore,
} from '../store.ts'
import { IconClose, IconPlus } from './Icons.tsx'
import { tabTitle } from './Chrome.tsx'
import '../switcher.css'

/**
 * The phone's tabs.
 *
 * A strip of tabs that scrolls sideways hides most of them, so on a phone the
 * strip is one button — the tab on screen and how many there are — and this
 * sheet lists every tab as a card with the last lines of its conversation, so
 * several can be read at once and any of them is one tap away.
 */

function machineLabel(host: string | null | undefined): string {
  return host ?? 'This Machine'
}

/** The last few things said in a conversation, oldest first. */
function previewLines(events: SessionEvent[] | undefined): Array<{ who: 'you' | 'agent'; text: string }> {
  if (!events?.length) return []
  const lines: Array<{ who: 'you' | 'agent'; text: string }> = []
  for (let index = events.length - 1; index >= 0 && lines.length < 3; index -= 1) {
    const event = events[index]!
    if (event.agentId) continue
    if (event.ev.k !== 'user' && event.ev.k !== 'assistant') continue
    const text = event.ev.text.replace(/\s+/g, ' ').trim()
    if (!text) continue
    lines.unshift({ who: event.ev.k === 'user' ? 'you' : 'agent', text: text.length > 220 ? `${text.slice(0, 220)}…` : text })
  }
  return lines
}

function TabCard({ id, state, onPicked }: { id: string; state: State; onPicked: () => void }) {
  const draft = state.drafts[id]
  const session = state.sessions[id]
  const events = useStore((s) => s.events[id])
  const lines = useMemo(() => (session?.kind === 'agent' ? previewLines(events) : []), [events, session?.kind])
  if (!draft && !session) return null
  const host = draft ? draft.host : session!.host
  const color = colorForMachine(state, host)
  const status = session ? sessionState(session) : 'stopped'
  const kind = session ? (session.kind === 'terminal' ? 'Terminal' : HARNESS_LABEL[session.harness]) : 'New tab'
  return (
    <div
      className={`switcher-card${state.active === id ? ' current' : ''}`}
      role="button"
      tabIndex={0}
      data-tab-id={id}
      style={{ ['--machine' as string]: `var(--machine-${color.id})` }}
      onClick={() => {
        selectTab(id)
        onPicked()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          selectTab(id)
          onPicked()
        }
      }}
    >
      <div className="switcher-card-head">
        <span
          className={`sess-state ${status}${session && isUnread(state, session) ? ' unread' : ''}`}
          role="img"
          aria-label={SESSION_STATE_WORD[status]}
        />
        <span className="switcher-title">{tabTitle(state, id)}</span>
        <button
          type="button"
          className="round-close switcher-close"
          aria-label={`Close ${tabTitle(state, id)}`}
          onClick={(event) => {
            event.stopPropagation()
            closeTab(id)
          }}
        >
          <IconClose size={14} />
        </button>
      </div>
      <div className="switcher-meta">
        {kind} · {machineLabel(host)}
      </div>
      <div className="switcher-preview">
        {lines.length ? (
          lines.map((line, index) => (
            <p key={index} className={line.who}>
              {line.who === 'you' ? '› ' : ''}
              {line.text}
            </p>
          ))
        ) : (
          <p className="empty">
            {draft ? draft.cwd || 'Choose what to open' : session!.kind === 'terminal' ? session!.cwd : 'Nothing said yet'}
          </p>
        )}
      </div>
    </div>
  )
}

export function TabSwitcher({ state, tabs, onClose }: { state: State; tabs: string[]; onClose: () => void }) {
  const grid = useRef<HTMLDivElement>(null)

  // Stream the conversations whose cards are on screen, for as long as they are.
  useEffect(() => {
    for (const id of tabs) holdPreview(id)
    return () => {
      for (const id of tabs) releasePreview(id)
    }
  }, [tabs.join('|')])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    grid.current?.querySelector<HTMLElement>('.switcher-card.current')?.scrollIntoView({ block: 'nearest' })
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return (
    <div className="overlay switcher-overlay" onClick={onClose}>
      <div className="switcher" role="dialog" aria-label="Open tabs" onClick={(event) => event.stopPropagation()}>
        <header className="switcher-head">
          <h2>
            Tabs <span className="switcher-count">{tabs.length}</span>
          </h2>
          <span className="spacer" />
          <button
            type="button"
            className="ghost switcher-new"
            onClick={() => {
              openDraft(null)
              onClose()
            }}
          >
            <IconPlus size={16} /> New
          </button>
          <button type="button" className="round-close" aria-label="Close tabs" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </header>
        <div className="switcher-grid" ref={grid}>
          {tabs.map((id) => (
            <TabCard key={id} id={id} state={state} onPicked={onClose} />
          ))}
        </div>
      </div>
    </div>
  )
}
