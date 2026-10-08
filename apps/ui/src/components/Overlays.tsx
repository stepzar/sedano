import { useEffect, useMemo, useState } from 'react'
import { HARNESS_LABEL } from '@shared'
import type { AttachmentRef, ToastLevel } from '@shared'
import type { DialogState, State, Toast } from '../store.ts'
import {
  attachmentUrl,
  dismissToast,
  dockedTerminals,
  getState,
  newTerminal,
  openDraft,
  refreshProjects,
  resolveDialog,
  selectTab,
  updateSettings,
  workspaceKey,
  workspaceParts,
} from '../store.ts'
import { baseName, HarnessMark, shortPath } from './Chrome.tsx'
import { useMobile } from '../mobile.ts'
import {
  IconClose,
  IconError,
  IconInfo,
  IconPlus,
  IconSearch,
  IconSettings,
  IconSidebar,
  IconStar,
  IconSuccess,
  IconTerminal,
  IconWarning,
} from './Icons.tsx'

const TOAST_ICON: Record<ToastLevel, typeof IconInfo> = {
  error: IconError,
  warning: IconWarning,
  info: IconInfo,
  success: IconSuccess,
}

/**
 * Transient notices, stacked at the top centre under the tab strip — never over
 * the composer or the status bar, which is where the eye and the thumb are.
 */
export function Toasts({ toasts }: { toasts: Toast[] }) {
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = TOAST_ICON[toast.level]
        return (
          <div
            key={toast.id}
            className={`toast ${toast.level}${toast.leaving ? ' leaving' : ''}`}
            role={toast.level === 'error' ? 'alert' : 'status'}
          >
            <span className="toast-icon">
              <Icon size={16} />
            </span>
            <span className="toast-text">{toast.text}</span>
            <button className="toast-close" aria-label="Dismiss" title="Dismiss" onClick={() => dismissToast(toast.id)}>
              <IconClose size={13} />
            </button>
          </div>
        )
      })}
    </div>
  )
}

/**
 * A question the app asks itself — deleting a session, renaming one. Drawn here
 * instead of with `window.confirm` / `window.prompt`, which the desktop webview
 * answers without showing anything, so the button looked broken.
 */
export function Dialogs({ dialog }: { dialog: DialogState | null }) {
  const [text, setText] = useState('')
  const id = dialog?.id ?? 0

  useEffect(() => {
    if (dialog?.kind === 'prompt') setText(dialog.value)
  }, [id, dialog?.kind, dialog?.value])

  if (!dialog) return null
  const answer = dialog.kind === 'prompt' ? text : 'yes'

  return (
    <div className="overlay" onClick={() => resolveDialog(null)}>
      <div className="modal dialog-box" onClick={(event) => event.stopPropagation()}>
        <div className="dialog-title">{dialog.title}</div>
        {dialog.body ? <div className="dialog-body">{dialog.body}</div> : null}
        {dialog.kind === 'prompt' ? (
          <input
            className="dialog-input"
            autoFocus
            spellCheck={false}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                resolveDialog(text)
              }
              if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                resolveDialog(null)
              }
            }}
          />
        ) : null}
        <div className="dialog-actions">
          <button onClick={() => resolveDialog(null)}>Cancel</button>
          <button
            className={dialog.danger ? 'primary danger' : 'primary'}
            autoFocus={dialog.kind === 'confirm'}
            onClick={() => resolveDialog(answer)}
          >
            {dialog.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Lightbox                                                            */
/* ------------------------------------------------------------------ */

const LIGHTBOX_EXIT_MS = 180

/**
 * A pasted image, full size. Shared by the composer strip and the transcript, so
 * clicking a thumbnail means the same thing wherever you are.
 */
export function Lightbox({
  images,
  index,
  onClose,
}: {
  images: AttachmentRef[]
  index: number
  onClose: () => void
}) {
  const [cursor, setCursor] = useState(index)
  const [closing, setClosing] = useState(false)
  const [ratio, setRatio] = useState<number | null>(null)

  useEffect(() => setCursor(index), [index])
  useEffect(() => setRatio(null), [cursor])

  useEffect(() => {
    // Captured on the window: Escape otherwise reaches the app's own handler and
    // interrupts the running turn behind the image.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setClosing(true)
        return
      }
      if (images.length < 2) return
      if (event.key === 'ArrowRight') setCursor((value) => (value + 1) % images.length)
      if (event.key === 'ArrowLeft') setCursor((value) => (value - 1 + images.length) % images.length)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [images.length])

  useEffect(() => {
    if (!closing) return
    const timer = setTimeout(onClose, LIGHTBOX_EXIT_MS)
    return () => clearTimeout(timer)
  }, [closing, onClose])

  const image = images[cursor]
  if (!image) return null

  return (
    <div className={`lightbox${closing ? ' closing' : ''}`} onClick={() => setClosing(true)}>
      {/* The original bytes, scaled to fit the window whatever their size: a
          small screenshot used to open at its own size in the middle of the
          dimmed screen. Its shape is only known once it loads. */}
      <img
        key={image.id}
        src={attachmentUrl(image)}
        alt={image.name}
        className={ratio ? 'fitted' : undefined}
        style={ratio ? ({ '--ratio': ratio } as React.CSSProperties) : undefined}
        onLoad={(event) => {
          const { naturalWidth, naturalHeight } = event.currentTarget
          if (naturalWidth && naturalHeight) setRatio(naturalWidth / naturalHeight)
        }}
      />
      {images.length > 1 ? (
        <div className="lightbox-count mono">
          {cursor + 1} / {images.length}
        </div>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Command palette                                                     */
/* ------------------------------------------------------------------ */

interface PaletteItem {
  id: string
  group: string
  label: string
  sub: string
  icon?: React.ReactNode
  run: () => void
}

/** The text with every occurrence of what was typed marked, case-insensitively. */
function Highlight({ text, needle }: { text: string; needle: string }) {
  if (!needle || !text) return <>{text}</>
  const parts: React.ReactNode[] = []
  const lower = text.toLowerCase()
  let from = 0
  for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
    if (at > from) parts.push(text.slice(from, at))
    parts.push(<mark key={at} className="palette-match">{text.slice(at, at + needle.length)}</mark>)
    from = at + needle.length
  }
  parts.push(text.slice(from))
  return <>{parts}</>
}

export function Palette({
  state,
  onClose,
  onOpenSettings,
}: {
  state: State
  onClose: () => void
  onOpenSettings: () => void
}) {
  const mobile = useMobile()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)

  const items = useMemo<PaletteItem[]>(() => {
    // Terminals docked in an agent's screen are not places you go (see the
    // filter below): the palette must not offer to open one, and their workspace
    // is the agent's, which is already in the list.
    const docked = dockedTerminals(state)
    const list: PaletteItem[] = [
      {
        id: 'action:session',
        group: 'Actions',
        label: 'New Session',
        sub: 'Agent tab in a workspace',
        icon: <IconPlus size={16} />,
        run: () => openDraft('agent'),
      },
      {
        id: 'action:terminal',
        group: 'Actions',
        label: 'New Terminal',
        sub: 'Tmux shell, local or over SSH',
        icon: <IconTerminal size={16} />,
        run: () => void newTerminal(),
      },
      {
        id: 'action:settings',
        group: 'Actions',
        label: 'Settings',
        sub: 'Theme, type scale, dictation',
        icon: <IconSettings size={16} />,
        run: () => onOpenSettings(),
      },
      {
        id: 'action:theme',
        group: 'Actions',
        label: 'Toggle Light / Dark',
        sub: 'Switch theme now',
        run: () => {
          const dark =
            getState().settings.theme === 'dark' ||
            (getState().settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
          updateSettings({ theme: dark ? 'light' : 'dark' })
        },
      },
      {
        id: 'action:rail',
        group: 'Actions',
        label: 'Toggle Sidebar',
        sub: 'Show or hide the session rail',
        icon: <IconSidebar size={16} />,
        run: () => updateSettings({ railVisible: !getState().settings.railVisible }),
      },
    ]

    const workspaces = new Map<string, number>()
    for (const session of Object.values(state.sessions)) {
      if (docked.has(session.id)) continue
      const key = workspaceKey(session.host, session.cwd)
      workspaces.set(key, (workspaces.get(key) ?? 0) + 1)
    }
    // Discovered projects are local paths, so they are always this machine.
    for (const project of state.projects.slice(0, 120)) {
      workspaces.set(project.path, workspaces.get(project.path) ?? 0)
    }
    for (const [key, count] of workspaces) {
      const { host, cwd } = workspaceParts(key)
      list.push({
        id: `workspace:${key}`,
        group: 'Workspaces',
        label: baseName(cwd) || cwd,
        sub: `${host ? `${host}:` : ''}${cwd}${count ? ` · ${count} session${count === 1 ? '' : 's'}` : ''}`,
        run: () => openDraft('agent', cwd, { host }),
      })
    }

    for (const session of Object.values(state.sessions)) {
      // A docked terminal belongs to an agent's panel, not to this list: it is
      // not a place you go, it is a panel you open on a conversation.
      if (docked.has(session.id)) continue
      list.push({
        id: `session:${session.id}`,
        group: 'Sessions',
        label: session.title || 'Untitled session',
        sub: `${session.kind === 'terminal' ? 'terminal' : HARNESS_LABEL[session.harness]} · ${shortPath(session.cwd)}`,
        icon: session.pinned ? <IconStar size={15} fill="currentColor" /> : <HarnessMark harness={session.harness} kind={session.kind} size={14} />,
        run: () => selectTab(session.id),
      })
    }
    return list
  }, [state.projects, state.sessions, state.docks, onOpenSettings])

  const needle = query.toLowerCase().trim()
  const filtered = useMemo(() => {
    if (!needle) return items.slice(0, 40)
    return items
      .map((item) => {
        const haystack = `${item.label} ${item.sub} ${item.group}`.toLowerCase()
        const index = haystack.indexOf(needle)
        return { item, score: index === -1 ? Number.POSITIVE_INFINITY : index + haystack.length / 1000 }
      })
      .filter((entry) => Number.isFinite(entry.score))
      .sort((a, b) => a.score - b.score)
      .slice(0, 40)
      .map((entry) => entry.item)
  }, [items, needle])

  useEffect(() => setCursor(0), [needle])
  useEffect(() => {
    refreshProjects()
  }, [])

  const run = (item: PaletteItem | undefined) => {
    if (!item) return
    item.run()
    onClose()
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal palette" onClick={(event) => event.stopPropagation()}>
        <div className="palette-head">
          <IconSearch size={17} />
          <input
            // On a phone the keyboard would cover half the list before anything
            // was asked for: focus waits for a tap on the field.
            autoFocus={!mobile}
            placeholder={mobile ? 'Search' : 'Search workspaces, sessions and actions'}
            value={query}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onClose()
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                setCursor((value) => Math.min(filtered.length - 1, value + 1))
              }
              if (event.key === 'ArrowUp') {
                event.preventDefault()
                setCursor((value) => Math.max(0, value - 1))
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                run(filtered[cursor])
              }
            }}
          />
          <span className="mono" style={{ color: 'var(--fg-faint)' }}>
            {filtered.length}
          </span>
          {/* A phone has no Escape key: the way back has to be on screen. */}
          <button type="button" className="icon-btn round-close mobile-only" aria-label="Close search" title="Close" onClick={onClose}>
            <IconClose size={16} />
          </button>
        </div>
        <div className="palette-list">
          {filtered.map((item, index) => {
            const showGroup = index === 0 || filtered[index - 1]?.group !== item.group
            return (
              <div key={item.id} style={{ display: 'contents' }}>
                {showGroup ? <div className="palette-group">{item.group}</div> : null}
                <div
                  className={`palette-item${index === cursor ? ' sel' : ''}`}
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => run(item)}
                >
                  {item.icon ? <span className="palette-icon">{item.icon}</span> : null}
                  <span><Highlight text={item.label} needle={needle} /></span>
                  <span className="spacer" />
                  <span className="path mono"><bdi dir="ltr"><Highlight text={item.sub ?? ''} needle={needle} /></bdi></span>
                </div>
              </div>
            )
          })}
          {filtered.length === 0 ? <div className="palette-item">Nothing matches “{query}”.</div> : null}
        </div>
      </div>
    </div>
  )
}
