import { useEffect, useRef, useState, type ReactNode, type SetStateAction } from 'react'
import { createPortal } from 'react-dom'
import { documentSummary, type AttachmentRef, type InlineDocument } from '@shared'
import { notify, readDocument, uploadDocument } from '../store.ts'
import { IconClose, IconDocument } from './Icons.tsx'

/**
 * Text documents on a message: a long paste or a dropped text file, shown as a
 * tile beside the pictures instead of as a wall of text (see
 * `@shared/documents.ts` for how they reach the harness).
 */

/** One tile: the first lines, the name and how long it is. */
export function DocumentTile({
  name,
  lines,
  preview,
  onOpen,
  onRemove,
}: {
  name: string
  lines?: number
  preview?: string
  onOpen: () => void
  onRemove?: () => void
}) {
  return (
    <div className="attach doc">
      <button type="button" className="doc-open" title={`Open ${name}`} aria-label={`Open ${name}`} onClick={onOpen}>
        <span className="doc-preview mono">{preview ?? ''}</span>
        <span className="doc-meta">
          <IconDocument size={11} />
          <span className="doc-name">{name}</span>
          {lines ? <span className="doc-lines mono">{lines}L</span> : null}
        </span>
      </button>
      {onRemove ? (
        <button type="button" className="attach-remove" title={`Remove ${name}`} onClick={onRemove}>
          <IconClose size={10} strokeWidth={2.2} />
        </button>
      ) : null}
    </div>
  )
}

/**
 * The whole document, to read — and, in the composer, to edit. Closing it
 * (Done, Escape, a click outside) keeps what was typed: an edit is never lost
 * to a stray click. Only "Discard" throws it away.
 */
export function DocumentViewer({
  name,
  load,
  readOnly,
  onSave,
  onInline,
  onClose,
}: {
  name: string
  load: () => Promise<string>
  readOnly?: boolean
  onSave?: (text: string) => void
  onInline?: (text: string) => void
  onClose: () => void
}) {
  const [original, setOriginal] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const latest = useRef({ text, original, readOnly, onSave, onClose })
  latest.current = { text, original, readOnly, onSave, onClose }

  useEffect(() => {
    let alive = true
    load()
      .then((value) => {
        if (!alive) return
        setOriginal(value)
        setText(value)
      })
      .catch((reason: unknown) => alive && setError(reason instanceof Error ? reason.message : String(reason)))
    return () => {
      alive = false
    }
  }, [])

  const close = () => {
    const now = latest.current
    if (!now.readOnly && now.original !== null && now.text !== now.original) now.onSave?.(now.text)
    now.onClose()
  }

  useEffect(() => {
    // Captured on the window, like the lightbox: Escape must not reach the app
    // and interrupt the turn running behind the viewer.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const dirty = original !== null && text !== original
  const { lines } = documentSummary(text)

  // On the body: the tile that opens it can sit inside a transformed or
  // scrolling ancestor, which would trap a fixed overlay inside that box.
  return createPortal(
    <div className="overlay doc-overlay" onMouseDown={close}>
      <div className="modal doc-viewer" role="dialog" aria-label={name} onMouseDown={(event) => event.stopPropagation()}>
        <div className="doc-head">
          <IconDocument size={15} />
          <span className="doc-title">{name}</span>
          <span className="doc-count mono">
            {original === null ? '' : `${lines} ${lines === 1 ? 'line' : 'lines'} · ${text.length.toLocaleString()} chars`}
          </span>
          <button type="button" className="icon-btn" title="Close" aria-label="Close" onClick={close}>
            <IconClose size={13} />
          </button>
        </div>
        {error ? (
          <div className="doc-error">{error}</div>
        ) : original === null ? (
          <div className="doc-error">Loading…</div>
        ) : readOnly ? (
          <pre className="doc-text mono">{text}</pre>
        ) : (
          <textarea
            className="doc-text mono"
            autoFocus
            spellCheck={false}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && (event.key === 's' || event.key === 'Enter')) {
                event.preventDefault()
                close()
              }
            }}
          />
        )}
        {readOnly || original === null ? null : (
          <div className="doc-actions">
            {onInline ? (
              <button type="button" title="Put the text in the message itself" onClick={() => {
                onInline(text)
                onClose()
              }}>
                Insert As Text
              </button>
            ) : null}
            <span className="doc-spacer" />
            {dirty ? (
              <button type="button" onClick={onClose}>
                Discard Changes
              </button>
            ) : null}
            <button type="button" className="primary" onClick={close}>
              {dirty ? 'Save' : 'Done'}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  )
}

/**
 * A composer's documents: adding (a long paste, a file), removing, and the
 * viewer that edits one. An edit is uploaded as a new document that takes the
 * old one's place, so what the draft points at is always what was last saved —
 * on the server, and across a reload (see `drafts.ts`).
 */
export function useDocuments(
  documents: AttachmentRef[],
  setDocuments: (next: SetStateAction<AttachmentRef[]>) => void,
  onInline: (text: string) => void,
) {
  const [busy, setBusy] = useState(0)
  const [viewing, setViewing] = useState<string | null>(null)

  const upload = (text: string, name: string, place: (ref: AttachmentRef) => void) => {
    setBusy((count) => count + 1)
    uploadDocument(text, name)
      .then(place)
      .catch((error: unknown) => notify('error', error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy((count) => count - 1))
  }

  const add = (text: string, name: string) => upload(text, name, (ref) => setDocuments((list) => [...list, ref]))

  const addPaste = (text: string) => add(text, `pasted-${documents.length + busy + 1}.txt`)

  const addFiles = (files: File[]) => {
    for (const file of files) {
      void file.text().then((text) => add(text, file.name || 'document.txt'))
    }
  }

  const remove = (id: string) => setDocuments((list) => list.filter((ref) => ref.id !== id))

  const save = (id: string, text: string) => {
    const ref = documents.find((item) => item.id === id)
    if (!ref) return
    if (!text.trim()) return remove(id)
    upload(text, ref.name, (next) => setDocuments((list) => list.map((item) => (item.id === id ? next : item))))
  }

  const open = documents.find((ref) => ref.id === viewing)
  const viewer: ReactNode = open ? (
    <DocumentViewer
      key={open.id}
      name={open.name}
      load={() => readDocument(open)}
      onSave={(text) => save(open.id, text)}
      onInline={(text) => {
        remove(open.id)
        onInline(text)
      }}
      onClose={() => setViewing(null)}
    />
  ) : null

  const tiles = documents.map((ref) => (
    <DocumentTile
      key={ref.id}
      name={ref.name}
      lines={ref.lines}
      preview={ref.preview}
      onOpen={() => setViewing(ref.id)}
      onRemove={() => remove(ref.id)}
    />
  ))

  return { busy, addPaste, addFiles, tiles, viewer }
}

/** The documents of a sent message, read-only: stored ones and ones found inline. */
export function SentDocuments({ refs, inline }: { refs: AttachmentRef[]; inline: InlineDocument[] }) {
  const [viewing, setViewing] = useState<{ name: string; load: () => Promise<string> } | null>(null)
  return (
    <>
      {refs.map((ref) => (
        <DocumentTile
          key={ref.id}
          name={ref.name}
          lines={ref.lines}
          preview={ref.preview}
          onOpen={() => setViewing({ name: ref.name, load: () => readDocument(ref) })}
        />
      ))}
      {inline.map((document, index) => {
        const summary = documentSummary(document.text)
        return (
          <DocumentTile
            key={`inline-${index}`}
            name={document.name}
            lines={summary.lines}
            preview={summary.preview}
            onOpen={() => setViewing({ name: document.name, load: () => Promise.resolve(document.text) })}
          />
        )
      })}
      {viewing ? <DocumentViewer name={viewing.name} load={viewing.load} readOnly onClose={() => setViewing(null)} /> : null}
    </>
  )
}
