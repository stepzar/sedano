import { createContext, useContext, type ReactNode } from 'react'
import { fileReference } from '../fileLinks.ts'

/**
 * What a transcript knows about its session's files, for the paths drawn in it.
 * `open` is null where opening makes no sense — a phone, a session on another
 * machine — and then every path is plain text.
 */
export interface FileLinks {
  cwd: string
  /** Absolute paths the session's calls read or wrote (see `touchedFiles`). */
  touched: readonly string[]
  open: ((path: string) => void) | null
}

export const FileLinksContext = createContext<FileLinks | null>(null)

/**
 * A path you can click to open with the default app. A span, not a button: it
 * sits inside rows that are themselves buttons, so the click is kept from
 * reaching the row (which would fold it). Focusable, and Enter opens it.
 */
export function FileLink({ path, children, className = '' }: { path: string; children: ReactNode; className?: string }) {
  const links = useContext(FileLinksContext)
  if (!links?.open) return <>{children}</>
  const open = links.open
  return (
    <span
      className={`file-link ${className}`}
      role="link"
      tabIndex={0}
      title={`Open ${path}`}
      onClick={(event) => {
        event.stopPropagation()
        event.preventDefault()
        open(path)
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return
        event.stopPropagation()
        event.preventDefault()
        open(path)
      }}
    >
      {children}
    </span>
  )
}

/** Inline code in a reply, clickable when it names a file (see `fileReference`). */
export function CodeSpan({ text }: { text: string }) {
  const links = useContext(FileLinksContext)
  const path = links?.open ? fileReference(text, links.cwd, links.touched) : null
  const code = <code className="md-code">{text}</code>
  return path ? <FileLink path={path}>{code}</FileLink> : code
}
