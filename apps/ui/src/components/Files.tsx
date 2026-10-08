import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchDirectory, updateSettings, type DirEntry, type DirListing } from '../store.ts'
import { IconChevron, IconClose, IconFile, IconFolder, IconSpinner } from './Icons.tsx'

/**
 * The filesystem, two ways.
 *
 * `FolderPicker` answers "where should this run?" — columns, the way a Finder
 * window walks a path: entering a folder opens a column to its right and the
 * ones you came through stay where they were, so the level above is still a
 * click away instead of something you have to walk back up to. `FilesPanel` is
 * the right-hand tree for the session you are in: not a file manager, just the
 * directory you are working in, one level at a time.
 *
 * Both read through `/api/fs`, which lists a single level and nothing else.
 */

/* ------------------------------------------------------------------ */
/* Column navigation                                                   */
/* ------------------------------------------------------------------ */

/**
 * Why a column could not be read.
 *
 * These are the transport's own five kinds (`apps/server/src/transport.ts`) and
 * no others: a machine that is not answering, a folder that is not there and a
 * folder we may not open are three different sentences, and the picker has to be
 * able to say which one it is.
 */
export type FsErrorKind = 'unreachable' | 'timeout' | 'not_found' | 'permission' | 'command_failed'

/** The short tag shown on a failed column, in the app's Capital Case. */
const ERROR_LABEL: Record<FsErrorKind, string> = {
  unreachable: 'Unreachable',
  timeout: 'Timed Out',
  not_found: 'Not Found',
  permission: 'No Permission',
  command_failed: 'Failed',
}

/**
 * The kind behind a failed listing.
 *
 * `/api/fs` answers a failure as `{ error: <message> }` and drops the
 * `RemoteError.kind` the server had already worked out, so the kind is read back
 * out of the text here. That is a reconstruction rather than the original — the
 * server change that would make it exact is listed in this task's report — but
 * even a coarse kind is what keeps "that machine is not answering" from being
 * drawn the same way as "this folder is empty", which is the failure this
 * replaces.
 */
export function classifyFsError(message: string, host: string | null): FsErrorKind {
  const text = message.toLowerCase()
  if (/timed out|timeout/.test(text)) return 'timeout'
  if (/permission denied|operation not permitted|eacces/.test(text)) return 'permission'
  // Only a host can be unreachable, and ssh's own failures are worded by ssh.
  // Checked before `not_found` on purpose: "connection closed" and "no route to
  // host" would otherwise be read as a missing path on a machine we never
  // reached.
  if (
    host &&
    /ssh:|connection (refused|closed|reset)|could not resolve|no route to host|host key|network is (down|unreachable)|broken pipe|not enabled|exited 255/.test(
      text,
    )
  ) {
    return 'unreachable'
  }
  if (/no such file or directory|enoent|not a directory|is not a directory/.test(text)) return 'not_found'
  return 'command_failed'
}

/** One column: what we know about the directory it lists, including nothing yet. */
type Column =
  | { status: 'loading' }
  | { status: 'ready'; listing: DirListing }
  | { status: 'error'; kind: FsErrorKind; message: string }

/**
 * The parent of a POSIX path, as a string.
 *
 * Read rather than requested: both machines this app talks to use POSIX paths,
 * and a round trip to learn what `dirname` already says would be a column of
 * spinner for nothing.
 */
function parentOf(path: string): string | null {
  if (!path || path === '/') return null
  const trimmed = path.replace(/\/+$/, '')
  const at = trimmed.lastIndexOf('/')
  if (at < 0) return null
  return at === 0 ? '/' : trimmed.slice(0, at)
}

/**
 * The columns the picker opens with: the folder you are in, and the one above it.
 *
 * Two, not the whole ancestor chain. A chain is one request per level, and on a
 * host that is seconds of waiting for columns nobody asked to see; two is the
 * fewest that makes the pattern legible from the first frame — you can already
 * step sideways into a sibling — and every deeper level is fetched when it is
 * opened and never again.
 */
function initialTrail(path: string): string[] {
  if (!path) return ['']
  const parent = parentOf(path)
  return parent ? [parent, path] : [path]
}

function Breadcrumb({ path, onGo }: { path: string; onGo: (path: string) => void }) {
  const parts = path.split('/').filter(Boolean)
  return (
    <div className="crumbs">
      <button className="crumb" onClick={() => onGo('/')} title="Root">
        /
      </button>
      {parts.map((part, index) => {
        const here = `/${parts.slice(0, index + 1).join('/')}`
        const last = index === parts.length - 1
        return (
          <span key={here} className="crumb-group">
            <button className={`crumb${last ? ' here' : ''}`} onClick={() => onGo(here)}>
              {part}
            </button>
            {last ? null : <span className="crumb-sep">/</span>}
          </span>
        )
      })}
    </div>
  )
}

/**
 * One column of the picker.
 *
 * It draws exactly one of four things and never two of them at once: the folders
 * it holds, the fact that it is still being read, the fact that reading it
 * failed (with the kind), or the fact that there is genuinely nothing in it. The
 * last two used to be the same grey line, which is how an unreachable server
 * read as an empty folder.
 */
function PickerColumn({
  state,
  rows,
  selected,
  focused,
  onOpen,
}: {
  state: Column | undefined
  rows: DirEntry[]
  selected: string | null
  focused: boolean
  onOpen: (entry: DirEntry) => void
}) {
  const node = useRef<HTMLDivElement>(null)

  // Whatever is selected in a column has to be on screen in that column, or
  // stepping back lands on a list scrolled somewhere else entirely.
  useEffect(() => {
    node.current?.querySelector('.fp-row.sel')?.scrollIntoView({ block: 'nearest' })
  }, [selected, rows.length])

  // The column you are standing in is scrolled into view sideways: a column
  // opened past the right edge is a column you cannot see.
  useEffect(() => {
    if (focused) node.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [focused])

  return (
    <div className={`fp-col${focused ? ' focus' : ''}`} ref={node}>
      {!state || state.status === 'loading' ? (
        <div className="fp-state" data-state="loading">
          <IconSpinner size={14} className="spin" />
          <span>Reading…</span>
        </div>
      ) : state.status === 'error' ? (
        <div className="fp-state fp-error" data-state="error" data-kind={state.kind}>
          <span className="fp-error-kind">{ERROR_LABEL[state.kind]}</span>
          <span className="fp-error-why">{state.message}</span>
        </div>
      ) : rows.length === 0 ? (
        <div className="fp-state" data-state="empty">
          <IconFolder size={15} className="tree-icon" />
          <span>No folders here</span>
        </div>
      ) : (
        rows.map((entry) => (
          <button
            key={entry.path}
            // `picker-row` is kept alongside: it is the name this element has
            // always had and still describes it exactly — a row in the chooser
            // you walk into — so every selector written against it keeps
            // working. The column metrics come from `fp-row`, which is defined
            // in `nav.css` and therefore wins where the two overlap.
            className={`picker-row fp-row${entry.path === selected ? ' sel' : ''}${entry.hidden ? ' dim' : ''}`}
            onClick={() => onOpen(entry)}
            title={entry.path}
          >
            <IconFolder size={16} className="tree-icon" />
            <span className="fp-name">{entry.name}</span>
            <span className="fp-into">
              <IconChevron size={15} />
            </span>
          </button>
        ))
      )}
    </div>
  )
}

export function FolderPicker({
  value,
  host = null,
  onPick,
  onClose,
}: {
  value: string
  host?: string | null
  onPick: (path: string, host: string | null) => void
  onClose: () => void
}) {
  /**
   * The open columns, outermost first: `trail[i + 1]` is always a folder inside
   * `trail[i]`, which is what makes the strip a path rather than a history. An
   * empty string means "the home of this machine", which is what the picker asks
   * for when it has been given no folder to start from.
   */
  const [trail, setTrail] = useState<string[]>(() => initialTrail(value))
  /** Everything that has been read, keyed by path: a column is never re-fetched. */
  const [cols, setCols] = useState<Record<string, Column>>({})
  /** The column the keyboard is in. */
  const [focusCol, setFocusCol] = useState(() => initialTrail(value).length - 1)
  /** The row highlighted in that column, or -1 for "the column itself". */
  const [cursor, setCursor] = useState(-1)
  const [needle, setNeedle] = useState('')
  const [showHidden, setShowHidden] = useState(false)

  /** Paths a request has already gone out for, so nothing is asked for twice. */
  const asked = useRef(new Set<string>())
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  // A column is loaded when it is opened and not before: the picker never walks
  // a tree, and on a host that is the difference between one round trip and one
  // per folder you happen to scroll past.
  useEffect(() => {
    for (const path of trail) {
      if (asked.current.has(path)) continue
      asked.current.add(path)
      setCols((current) => ({ ...current, [path]: { status: 'loading' } }))
      fetchDirectory(path, host)
        .then((listing) => {
          if (alive.current) setCols((current) => ({ ...current, [path]: { status: 'ready', listing } }))
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err)
          if (alive.current) {
            setCols((current) => ({
              ...current,
              [path]: { status: 'error', kind: classifyFsError(message, host), message },
            }))
          }
        })
    }
  }, [trail, host])

  // A path belongs to one machine: switching host starts over from that host's
  // home, so a local path is never offered as a folder on a server — and the
  // columns read from the old machine go with it.
  const firstHost = useRef(true)
  useEffect(() => {
    if (firstHost.current) {
      firstHost.current = false
      return
    }
    asked.current.clear()
    setCols({})
    setTrail([''])
    setFocusCol(0)
    setCursor(-1)
    setNeedle('')
  }, [host])

  // Escape closes the chooser the same way it closes every other overlay. The
  // panel's own handler gets there first and stops the event, so this only fires
  // when the focus has drifted outside the modal entirely.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /** The real path of a column, once the machine has told us what it is. */
  const resolved = useCallback(
    (path: string | undefined): string | null => {
      if (path === undefined) return null
      const col = cols[path]
      if (col?.status === 'ready') return col.listing.path
      return path || null
    },
    [cols],
  )

  /** The folders a column holds, before the filter. */
  const rowsOf = useCallback(
    (index: number): DirEntry[] => {
      const col = cols[trail[index] ?? '']
      if (!col || col.status !== 'ready') return []
      const dirs = col.listing.entries.filter((entry) => entry.kind === 'dir')
      return showHidden ? dirs : dirs.filter((entry) => !entry.hidden)
    },
    [cols, trail, showHidden],
  )

  // The filter narrows the column you are standing in, which is the only column
  // you are looking for something in.
  const query = needle.trim().toLowerCase()
  const visibleOf = useCallback(
    (index: number): DirEntry[] => {
      const rows = rowsOf(index)
      if (index !== focusCol || !query) return rows
      return rows.filter((entry) => entry.name.toLowerCase().includes(query))
    },
    [rowsOf, focusCol, query],
  )

  const focusKey = trail[focusCol] ?? ''
  const focusState = cols[focusKey]

  /**
   * Where the highlight lands when the keyboard moves between columns.
   *
   * Stepping back must land on the folder you came out of, and stepping into a
   * fresh column must land on nothing — the column itself is the selection until
   * you point at something inside it. Deliberately not re-run when an unrelated
   * column finishes loading: that would drag the highlight back under the arrow
   * keys.
   */
  useEffect(() => {
    const rows = rowsOf(focusCol)
    const child = resolved(trail[focusCol + 1])
    setCursor(child ? rows.findIndex((entry) => entry.path === child) : -1)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusCol, trail.length, focusKey, focusState?.status])

  const rowsHere = visibleOf(focusCol)
  const at = cursor >= 0 && cursor < rowsHere.length ? cursor : -1
  const highlighted = at >= 0 ? (rowsHere[at] ?? null) : null
  const hereListing = focusState?.status === 'ready' ? focusState.listing : null
  /** What ↵ and "Use This Folder" hand back. */
  const chosen = highlighted?.path ?? hereListing?.path ?? trail[focusCol] ?? value

  /** Enter a folder: a new column to the right of the one it was clicked in. */
  const open = useCallback((index: number, path: string) => {
    setTrail((current) => [...current.slice(0, index + 1), path])
    setFocusCol(index + 1)
    setNeedle('')
  }, [])

  /** Step back: the column above the leftmost one, prepended to the strip. */
  const stepOut = useCallback(() => {
    if (focusCol > 0) {
      setFocusCol(focusCol - 1)
      setNeedle('')
      return
    }
    const up = parentOf(resolved(trail[0]) ?? '')
    if (!up) return
    setTrail((current) => [up, ...current])
    setFocusCol(0)
    setNeedle('')
  }, [focusCol, resolved, trail])

  /** Jump to an ancestor from the breadcrumb, reusing the columns already open. */
  const goTo = useCallback(
    (path: string) => {
      const index = trail.findIndex((item) => resolved(item) === path)
      if (index >= 0) {
        setFocusCol(index)
        setNeedle('')
        return
      }
      const next = initialTrail(path)
      setTrail(next)
      setFocusCol(next.length - 1)
      setNeedle('')
    },
    [resolved, trail],
  )

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (needle) setNeedle('')
      else onClose()
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setCursor((current) => Math.min(rowsHere.length - 1, current + 1))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setCursor((current) => Math.max(0, current - 1))
      return
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      const entry = highlighted ?? rowsHere[0] ?? null
      if (entry) open(focusCol, entry.path)
      return
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      stepOut()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      onPick(chosen, host)
    }
  }

  const canStepOut = focusCol > 0 || Boolean(parentOf(resolved(trail[0]) ?? ''))

  return (
    <div className="overlay" onMouseDown={onClose}>
      {/* The whole panel listens for the keyboard, not the field inside it: the
          search box keeps the caret so typing filters, and the arrows still walk
          the columns from wherever the focus happens to be. */}
      <div
        className="modal folder-picker"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="picker-head">
          <div className="picker-bar">
            {/* A label, not another picker: the machine is chosen in the top-left
                selector, and this only says where the folders below come from. */}
            <span className="label mono">{host ?? 'This Machine'}</span>
            <span className="spacer" />
            <input
              className="picker-search"
              value={needle}
              spellCheck={false}
              autoFocus
              placeholder="Search This Column…"
              onChange={(event) => {
                setNeedle(event.target.value)
                setCursor(-1)
              }}
            />
            <button
              className="ghost tiny"
              onClick={() => setShowHidden((current) => !current)}
              title="Show or hide dot folders"
            >
              {showHidden ? 'Hide .Folders' : 'Show .Folders'}
            </button>
          </div>
          {/* The path gets its own line: on one row with the host control it
              wrapped in the middle of a path, which read as a broken header. */}
          <div className="picker-path">
            <Breadcrumb path={resolved(trail[focusCol]) ?? '/'} onGo={goTo} />
          </div>
        </div>

        <div className="fp-cols">
          <button
            className="fp-out"
            onClick={stepOut}
            disabled={!canStepOut}
            title="The folder above (←)"
          >
            <IconChevron size={16} />
          </button>
          {trail.map((path, index) => (
            <PickerColumn
              key={`${index}:${path}`}
              state={cols[path]}
              rows={visibleOf(index)}
              selected={
                index === focusCol
                  ? (highlighted?.path ?? resolved(trail[index + 1]))
                  : resolved(trail[index + 1])
              }
              focused={index === focusCol}
              onOpen={(entry) => open(index, entry.path)}
            />
          ))}
        </div>

        <div className="picker-foot">
          <span className="mono ellipsis" title={chosen}>
            {host ? `${host}:` : ''}
            {chosen}
          </span>
          <span className="spacer" />
          <button className="ghost tiny" onClick={onClose}>
            Cancel
          </button>
          <button className="primary tiny" onClick={() => onPick(chosen, host)}>
            Use This Folder
          </button>
        </div>
      </div>
    </div>
  )
}

function TreeDir({
  path,
  name,
  depth,
  host = null,
  defaultOpen = false,
}: {
  path: string
  name: string
  depth: number
  host?: string | null
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const [listing, setListing] = useState<DirListing | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || listing) return
    let alive = true
    void fetchDirectory(path, host)
      .then((next) => {
        if (alive) setListing(next)
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      alive = false
    }
  }, [open, path, host, listing])

  const entries = listing?.entries ?? []
  const dirs = entries.filter((entry) => entry.kind === 'dir')
  const files = entries.filter((entry) => entry.kind === 'file')
  const indent = 4 + depth * 14

  return (
    <div className="tree-node">
      <button
        className="tree-row"
        style={{ paddingLeft: indent }}
        onClick={() => setOpen((value) => !value)}
        title={path}
      >
        <span className={`tree-chevron${open ? ' open' : ''}`}>
          <IconChevron size={17} />
        </span>
        <IconFolder size={17} className="tree-icon" />
        <span className="tree-name">{name}</span>
      </button>
      {open ? (
        <div className="tree-children">
          {error ? <div className="tree-note error">{error}</div> : null}
          {dirs.map((child) => (
            <TreeDir key={child.path} path={child.path} name={child.name} depth={depth + 1} host={host} />
          ))}
          {files.map((child) => (
            <div
              key={child.path}
              className={`tree-file${child.hidden ? ' dim' : ''}`}
              style={{ paddingLeft: indent + 14 }}
              title={child.path}
            >
              <span className="tree-chevron leaf">
                <IconChevron size={17} />
              </span>
              <IconFile size={17} className="tree-icon" />
              <span className="tree-name">{child.name}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** The right-hand tree: the directory this session is working in. */
export function FilesPanel({ cwd, host }: { cwd: string; host?: string | null }) {
  const name = cwd.split('/').filter(Boolean).pop() ?? cwd
  return (
    <aside className="files-panel">
      <div className="files-head">
        <IconFolder size={17} className="tree-icon" />
        <span className="label" title={host ? `${host}:${cwd}` : cwd}>
          {name}
        </span>
        <span className="spacer" />
        {host ? <span className="mono">{host}</span> : null}
        {/* On a phone the tree covers the pane: its way back sits on it. */}
        <button
          type="button"
          className="icon-btn round-close mobile-only"
          aria-label="Close the file tree"
          title="Close"
          onClick={() => updateSettings({ filesVisible: false })}
        >
          <IconClose size={16} />
        </button>
      </div>
      <div className="files-tree">
        {/* The tree is read from wherever the session runs — here, or on the
            host over SSH — so what it shows is what the agent can see. */}
        <TreeDir path={cwd} name={name} depth={0} host={host} defaultOpen />
      </div>
    </aside>
  )
}
