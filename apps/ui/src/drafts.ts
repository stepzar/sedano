/**
 * What is being written in each tab, kept until it is sent or the tab closes.
 *
 * Both composers — the launchpad of a new-session tab and the chat box of an
 * open session — unmount when you switch tabs, and their text and pictures used
 * to go with them. Here they are kept per tab id: in memory at once (so a tab
 * switch reads back exactly what was on screen) and in `localStorage` a beat
 * later (so a reload does too). An empty draft is no draft: sending clears the
 * box, and that removes the entry.
 *
 * Pictures and documents are kept as the server's attachment refs — the bytes are already
 * uploaded, and the thumbnails load them from the server, so no object URL is
 * ever created here. The server drops uploads nobody sent after a day, at its
 * next start; a copy of each picture's bytes in IndexedDB is what lets a draft
 * older than that upload it again instead of pointing at nothing.
 */
import { useEffect, useRef, useState, type SetStateAction } from 'react'
import type { AttachmentRef } from '@shared'
import { dropImageToken, syncImageTokens } from './attachments.ts'
import { attachmentUrl, getState, onAttachmentUploaded, subscribe, uploadAttachment } from './store.ts'

export interface ComposerDraft {
  text: string
  /** The pictures, in `[image:N]` order. */
  attachments: AttachmentRef[]
  /** Text documents (long pastes, dropped files): chips with no token. */
  documents: AttachmentRef[]
}

const refsOf = (draft: ComposerDraft) => [...draft.attachments, ...draft.documents]

const KEY = 'sedano.composer-drafts'
const WRITE_DELAY_MS = 300

function load(): Record<string, ComposerDraft> {
  try {
    const raw = localStorage.getItem(KEY)
    const parsed = raw ? (JSON.parse(raw) as Record<string, ComposerDraft>) : {}
    const drafts: Record<string, ComposerDraft> = {}
    for (const [id, draft] of Object.entries(parsed)) {
      if (typeof draft?.text !== 'string' || !Array.isArray(draft.attachments)) continue
      const documents = Array.isArray(draft.documents) ? draft.documents : []
      drafts[id] = {
        text: draft.text,
        attachments: draft.attachments.filter((ref) => typeof ref?.id === 'string'),
        documents: documents.filter((ref) => typeof ref?.id === 'string'),
      }
    }
    return drafts
  } catch {
    return {}
  }
}

let drafts = load()
/** Drafts read from storage whose pictures have not been checked against the server yet. */
const unverified = new Set(Object.keys(drafts))

let writeTimer: ReturnType<typeof setTimeout> | null = null

function flush(): void {
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = null
  try {
    localStorage.setItem(KEY, JSON.stringify(drafts))
  } catch {
    /* ignore quota errors: the draft still survives tab switches in memory */
  }
}

function scheduleWrite(): void {
  if (writeTimer) clearTimeout(writeTimer)
  writeTimer = setTimeout(flush, WRITE_DELAY_MS)
}

if (typeof window !== 'undefined') {
  // A reload inside the debounce window must not lose the last keystrokes.
  window.addEventListener('pagehide', flush)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush()
  })
}

export function readComposerDraft(id: string): ComposerDraft | null {
  return drafts[id] ?? null
}

function writeComposerDraft(id: string, next: ComposerDraft): void {
  const previous = drafts[id]
  if (previous && previous.text === next.text && previous.attachments === next.attachments && previous.documents === next.documents) return
  const empty = !next.text && !next.attachments.length && !next.documents.length
  if (empty) {
    if (!previous) return
    const { [id]: _gone, ...rest } = drafts
    drafts = rest
  } else {
    drafts = { ...drafts, [id]: next }
  }
  if (previous) {
    const kept = new Set(refsOf(next).map((ref) => ref.id))
    forgetBytes(refsOf(previous).filter((ref) => !kept.has(ref.id)).map((ref) => ref.id))
  }
  scheduleWrite()
}

/** The tab closed: what was being written in it goes too. */
export function forgetComposerDraft(id: string): void {
  const previous = drafts[id]
  if (!previous) return
  const { [id]: _gone, ...rest } = drafts
  drafts = rest
  forgetBytes(refsOf(previous).map((ref) => ref.id))
  scheduleWrite()
}

// A draft lives as long as its tab: when an id leaves the strip — closed, or a
// launched draft replaced by its session — its draft is dropped. Watching the
// tabs rather than the close button covers every way a tab goes away.
// That includes a tab closed on another device (the tab list is shared).
let openList = getState().openTabs
let openTabs = new Set(openList.map((tab) => tab.id))
subscribe(() => {
  const list = getState().openTabs
  if (list === openList) return
  openList = list
  const now = new Set(list.map((tab) => tab.id))
  if (now.size === openTabs.size && [...now].every((id) => openTabs.has(id))) return
  for (const id of openTabs) if (!now.has(id)) forgetComposerDraft(id)
  openTabs = now
})

/* ------------------------------------------------------------------ */
/* The bytes, for re-uploading                                         */
/* ------------------------------------------------------------------ */

const DB_NAME = 'sedano-drafts'
const STORE = 'images'

let database: Promise<IDBDatabase | null> | null = null

function openDatabase(): Promise<IDBDatabase | null> {
  if (database) return database
  database = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') return resolve(null)
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })
  return database
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await openDatabase()
  if (!db) return null
  return new Promise((resolve) => {
    try {
      const request = run(db.transaction(STORE, mode).objectStore(STORE))
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    } catch {
      // Quota, a private window, a closed database: the copy is a convenience.
      resolve(null)
    }
  })
}

function forgetBytes(ids: string[]): void {
  for (const id of ids) void withStore('readwrite', (store) => store.delete(id))
}

/**
 * Kept as an ArrayBuffer, not a Blob: WebKit refuses Blobs in IndexedDB in
 * ephemeral sessions (private windows), and a buffer is stored everywhere.
 */
interface StoredBytes {
  type: string
  data: ArrayBuffer
}

onAttachmentUploaded((ref, bytes) => {
  void bytes.arrayBuffer().then((data) =>
    withStore('readwrite', (store) => store.put({ type: bytes.type || ref.mediaType, data } satisfies StoredBytes, ref.id)),
  )
})

// Copies nobody's draft points at any more (an upload that never reached a
// draft, a tab closed while the app was away) are dropped once per start.
void withStore('readonly', (store) => store.getAllKeys()).then((keys) => {
  const used = new Set(Object.values(drafts).flatMap((draft) => refsOf(draft).map((ref) => ref.id)))
  forgetBytes((keys ?? []).map(String).filter((id) => !used.has(id)))
})

/**
 * One upload of a draft read back from storage, checked against the server: the
 * same ref while the server still has it, a new one uploaded again from the
 * copy when it has been swept, and null when there is no copy either.
 */
async function verifyRef(ref: AttachmentRef): Promise<AttachmentRef | null> {
  const found = await fetch(attachmentUrl(ref), { cache: 'no-store' })
    .then((response) => response.ok)
    .catch(() => true) // offline is not "gone": keep it and let the send decide
  if (found) return ref
  const copy = await withStore<StoredBytes | undefined>('readonly', (store) => store.get(ref.id))
  const bytes = copy?.data ? new Blob([copy.data], { type: copy.type || ref.mediaType }) : null
  const again = bytes ? await uploadAttachment(bytes, ref.name).catch(() => null) : null
  if (again) forgetBytes([ref.id])
  return again
}

/**
 * The uploads of a draft read back from storage. A picture that is gone for
 * good is dropped together with its chip, so text and pictures still agree.
 */
async function verifyDraft(draft: ComposerDraft): Promise<ComposerDraft> {
  let text = draft.text
  const attachments: AttachmentRef[] = []
  let position = 0
  for (const ref of draft.attachments) {
    position += 1
    const checked = await verifyRef(ref)
    if (checked) {
      attachments.push(checked)
      continue
    }
    text = dropImageToken(text, position)
    position -= 1
  }
  const documents: AttachmentRef[] = []
  for (const ref of draft.documents) {
    const checked = await verifyRef(ref)
    if (checked) documents.push(checked)
  }
  return { text, attachments, documents }
}

/* ------------------------------------------------------------------ */
/* The hook                                                            */
/* ------------------------------------------------------------------ */

function start(id: string, fallbackText: string): ComposerDraft & { id: string } {
  const saved = drafts[id]
  if (!saved) return { id, text: fallbackText, attachments: [], documents: [] }
  // An upload still running when the tab was left never reached the draft;
  // its chip would point at nothing.
  const synced = syncImageTokens(saved.text, saved.attachments.length)
  return { id, text: synced ? synced.text : saved.text, attachments: saved.attachments, documents: saved.documents }
}

/**
 * A composer's text and pictures, kept for its tab. Drop-in for two
 * `useState`s: the setters take values or updater functions alike.
 */
export function useComposerDraft(id: string, fallbackText = '') {
  const [value, setValue] = useState(() => start(id, fallbackText))
  let current = value
  // The same composer can be handed another tab: read that tab's draft.
  if (value.id !== id) {
    current = start(id, fallbackText)
    setValue(current)
  }

  useEffect(() => {
    writeComposerDraft(current.id, { text: current.text, attachments: current.attachments, documents: current.documents })
  }, [current.id, current.text, current.attachments, current.documents])

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  useEffect(() => {
    if (!unverified.has(id)) return
    unverified.delete(id)
    const saved = drafts[id]
    if (!saved || !refsOf(saved).length) return
    void verifyDraft(saved).then((checked) => {
      const before = refsOf(saved)
      const after = refsOf(checked)
      if (after.length === before.length && after.every((ref, index) => ref === before[index])) return
      writeComposerDraft(id, checked)
      if (alive.current) setValue((now) => (now.id === id ? { id, ...checked } : now))
    })
  }, [id])

  const setText = (next: SetStateAction<string>) =>
    setValue((now) => ({ ...now, text: typeof next === 'function' ? next(now.text) : next }))
  const setAttachments = (next: SetStateAction<AttachmentRef[]>) =>
    setValue((now) => ({ ...now, attachments: typeof next === 'function' ? next(now.attachments) : next }))

  const setDocuments = (next: SetStateAction<AttachmentRef[]>) =>
    setValue((now) => ({ ...now, documents: typeof next === 'function' ? next(now.documents) : next }))

  return {
    text: current.text,
    setText,
    attachments: current.attachments,
    setAttachments,
    documents: current.documents,
    setDocuments,
  }
}
