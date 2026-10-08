import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { HarnessId, ImportScan, ImportableSession, SessionSummary } from '@shared'
import { HARNESS_LABEL } from '@shared'
import { getState, notify, selectSession } from '../store.ts'
import { bringBack, scanImports, waitFor } from '../imports.ts'
import { baseName, HarnessMark } from './Chrome.tsx'
import { IconClose, IconSearch, IconSpinner } from './Icons.tsx'
import '../import.css'

/* The popup is opened from the rail and from the composer, and drawn once by
   the app: a tiny module store instead of threading a setter through both. */
type Scope = { cwd: string; host: string | null }
let scope: Scope | null = null
const listeners = new Set<() => void>()

export function openImport(next: Scope): void {
  scope = next
  for (const listener of listeners) listener()
}

function closeImport(): void {
  scope = null
  for (const listener of listeners) listener()
}

function useScope(): Scope | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => scope,
  )
}

/** Mounted once by the app; renders the popup while one is open. */
export function ImportSessionsHost({ onTransfer }: { onTransfer: (session: SessionSummary) => void }) {
  const current = useScope()
  if (!current) return null
  return <ImportDialog key={`${current.host ?? ''}:${current.cwd}`} scope={current} onTransfer={onTransfer} onClose={closeImport} />
}

/** Two opposed arrows: hand the conversation over to another harness. */
function IconTransfer({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 5.5h9.5M10 3l2.5 2.5L10 8" />
      <path d="M13 10.5H3.5M6 8l-2.5 2.5L6 13" />
    </svg>
  )
}

const DAY = 86_400_000

/** The rail's short relative time for today and this week, a date after that. */
function when(at: number): string {
  const diff = Date.now() - at
  if (diff < 60_000) return 'Now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m`
  if (diff < DAY) return `${Math.round(diff / 3_600_000)}h`
  if (diff < 7 * DAY) return `${Math.round(diff / DAY)}d`
  const date = new Date(at)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
}

/** Calendar buckets for the list's light group headers. */
function dateGroup(at: number): string {
  const startOfToday = new Date().setHours(0, 0, 0, 0)
  if (at >= startOfToday) return 'Today'
  if (at >= startOfToday - DAY) return 'Yesterday'
  if (at >= startOfToday - 6 * DAY) return 'This week'
  return 'Older'
}

/** Lowercase without accents, so "cafe" finds "Café". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

function rowKey(item: ImportableSession): string {
  return item.source === 'archived' ? `sedano:${item.sessionId}` : `${item.harness}:${item.nativeId}`
}

type Filter = HarnessId | 'all' | 'archived'

function ImportDialog({
  scope: { cwd, host },
  onTransfer,
  onClose,
}: {
  scope: Scope
  onTransfer: (session: SessionSummary) => void
  onClose: () => void
}) {
  const [scan, setScan] = useState<ImportScan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let live = true
    setScan(null)
    setError(null)
    scanImports(cwd, host)
      .then((result) => live && setScan(result))
      .catch((failure) => live && setError(failure instanceof Error ? failure.message : String(failure)))
    return () => {
      live = false
    }
  }, [cwd, host, attempt])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const sessions = useMemo(() => [...(scan?.sessions ?? [])].sort((a, b) => b.updatedAt - a.updatedAt), [scan])

  // One chip per harness that has something, most sessions first.
  const harnessChips = useMemo(() => {
    const counts = new Map<HarnessId, number>()
    for (const item of sessions) counts.set(item.harness, (counts.get(item.harness) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [sessions])
  const archivedCount = sessions.filter((item) => item.source === 'archived').length
  // "Archived" only filters something when the list mixes both kinds.
  const showArchivedChip = archivedCount > 0 && archivedCount < sessions.length
  const showChips = harnessChips.length > 1 || showArchivedChip

  const shown = useMemo(() => {
    const needle = fold(query.trim())
    return sessions.filter((item) => {
      if (filter === 'archived' ? item.source !== 'archived' : filter !== 'all' && item.harness !== filter) return false
      return !needle || fold(item.title).includes(needle)
    })
  }, [sessions, query, filter])

  useEffect(() => setSelected(0), [query, filter])

  useEffect(() => {
    listRef.current?.querySelector('.import-row.sel')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const act = async (item: ImportableSession, mode: 'continue' | 'transfer') => {
    if (busy) return
    setBusy(rowKey(item))
    try {
      const session = await bringBack(item, cwd, host)
      selectSession(session.id)
      if (mode === 'transfer') {
        // The handoff prompt is written from the conversation, so it waits for
        // the history to arrive (an import replays it from the harness).
        await waitFor(() => getState().events[session.id]?.some((event) => event.ev.k === 'user' || event.ev.k === 'assistant'), 15_000)
        onTransfer(getState().sessions[session.id] ?? session)
      }
      onClose()
    } catch (failure) {
      notify('error', `Could not bring the session back: ${failure instanceof Error ? failure.message : String(failure)}`)
      setBusy(null)
    }
  }

  const onListKey = (event: React.KeyboardEvent) => {
    if (!shown.length) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setSelected((index) => Math.min(shown.length - 1, Math.max(0, index + step)))
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing && !(event.target as HTMLElement).closest('button')) {
      event.preventDefault()
      const item = shown[selected]
      if (item) void act(item, 'continue')
    }
  }

  const folder = baseName(cwd) || cwd
  const showHarnessIcon = filter === 'all' && harnessChips.length > 1

  const rows: React.ReactNode[] = []
  let lastGroup = ''
  shown.forEach((item, index) => {
    const group = dateGroup(item.updatedAt)
    if (group !== lastGroup) {
      rows.push(<div className="import-group" key={`group:${group}`}>{group}</div>)
      lastGroup = group
    }
    const key = rowKey(item)
    rows.push(
      <div
        key={key}
        className={`import-row${index === selected ? ' sel' : ''}`}
        role="option"
        aria-selected={index === selected}
        aria-disabled={Boolean(busy)}
        onMouseMove={() => index !== selected && setSelected(index)}
        onClick={() => void act(item, 'continue')}
      >
        {showHarnessIcon ? (
          <span className="import-harness" title={HARNESS_LABEL[item.harness]}>
            <HarnessMark harness={item.harness} kind="agent" />
          </span>
        ) : null}
        <span className="import-title" title={item.title}>{item.title}</span>
        {item.source === 'archived' ? <span className="import-badge">Archived</span> : null}
        {busy === key ? (
          <IconSpinner size={14} className="spin" />
        ) : (
          <button
            className="icon-btn import-transfer"
            title="Transfer to another harness…"
            aria-label="Transfer"
            disabled={Boolean(busy)}
            onClick={(event) => {
              event.stopPropagation()
              void act(item, 'transfer')
            }}
          >
            <IconTransfer size={14} />
          </button>
        )}
        <span className="import-when" title={new Date(item.updatedAt).toLocaleString()}>{when(item.updatedAt)}</span>
      </div>,
    )
  })

  return (
    <div className="overlay import-overlay" onMouseDown={onClose}>
      <div
        className="modal import-dialog"
        role="dialog"
        aria-label="Import sessions"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onListKey}
      >
        <header className="import-head">
          <div>
            <h2>Import Sessions</h2>
            <p title={host ? `${host}:${cwd}` : cwd}>
              Sessions of <strong>{folder}</strong> not open in Sedano
            </p>
          </div>
          <button className="icon-btn" title="Close" aria-label="Close" onClick={onClose}>
            <IconClose size={14} />
          </button>
        </header>

        <div className="settings-search import-search">
          <IconSearch size={15} />
          <input
            autoFocus
            placeholder="Search sessions"
            value={query}
            spellCheck={false}
            aria-label="Search sessions"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        {showChips ? (
          <div className="import-chips" role="group" aria-label="Filter by harness">
            <button className={`chip toggle${filter === 'all' ? ' on' : ''}`} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
              All <span className="import-count">{sessions.length}</span>
            </button>
            {harnessChips.length > 1
              ? harnessChips.map(([harness, count]) => (
                  <button
                    key={harness}
                    className={`chip toggle${filter === harness ? ' on' : ''}`}
                    aria-pressed={filter === harness}
                    data-harness={harness}
                    onClick={() => setFilter(harness)}
                  >
                    <HarnessMark harness={harness} kind="agent" />
                    {HARNESS_LABEL[harness]} <span className="import-count">{count}</span>
                  </button>
                ))
              : null}
            {showArchivedChip ? (
              <button className={`chip toggle${filter === 'archived' ? ' on' : ''}`} aria-pressed={filter === 'archived'} data-harness="archived" onClick={() => setFilter('archived')}>
                Archived <span className="import-count">{archivedCount}</span>
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="import-body" ref={listRef} role="listbox" aria-label="Sessions">
          {error ? (
            <div className="import-state" role="alert">
              <span>Could not scan this folder: {error}</span>
              <button className="ghost tiny" onClick={() => setAttempt((value) => value + 1)}>Retry</button>
            </div>
          ) : !scan ? (
            <div className="import-state">
              <IconSpinner size={15} className="spin" />
              <span>Scanning every harness…</span>
            </div>
          ) : !sessions.length ? (
            <div className="import-state">
              <span>Nothing to import: every session of this folder is already in Sedano.</span>
            </div>
          ) : !shown.length ? (
            <div className="import-state import-empty">
              <span>No sessions match</span>
            </div>
          ) : (
            rows
          )}
          {scan?.errors.map((item) => (
            <p className="import-note warn" key={item.harness}>
              {HARNESS_LABEL[item.harness]} could not be read: {item.error}
            </p>
          ))}
          {scan?.notes.map((note) => (
            <p className="import-note" key={note}>{note}</p>
          ))}
        </div>
      </div>
    </div>
  )
}
