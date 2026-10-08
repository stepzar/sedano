/**
 * Images pasted into the composer, and text documents (a long paste, a dropped
 * file — see `@shared/documents.ts`).
 *
 * They are written once under `~/.sedano/attachments` and referenced by id
 * everywhere else: the wire message, the stored timeline event and the harness
 * payload all carry the id, so nothing ever ships base64 through the socket.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOCUMENT_MEDIA_TYPE, documentSummary, type AttachmentRef } from '@shared'
import * as db from './db.ts'
import { SEDANO_HOME } from './paths.ts'

const DIR = join(SEDANO_HOME, 'attachments')

/** What a model can actually look at, and what a browser paste produces. */
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  // Every document is stored as plain UTF-8 text; its name keeps the extension.
  [DOCUMENT_MEDIA_TYPE]: 'txt',
}

const MAX_BYTES = 5 * 1024 * 1024

const UUID = /^[0-9a-f-]{36}$/i

export interface StoredAttachment extends AttachmentRef {
  bytes: number
}

function ensureDir(): void {
  mkdirSync(DIR, { recursive: true, mode: 0o700 })
}

/** The media type without its `; charset=…` tail, lowercased. */
function normalizeMediaType(mediaType: string): string {
  return mediaType.split(';')[0]!.trim().toLowerCase()
}

export function saveAttachment(bytes: Uint8Array, mediaType: string, name: string): StoredAttachment {
  const type = normalizeMediaType(mediaType)
  const extension = EXTENSIONS[type]
  if (!extension) {
    throw new Error(`unsupported type "${type}" — use png, jpeg, gif, webp or plain text`)
  }
  const document = type === DOCUMENT_MEDIA_TYPE
  const what = document ? 'document' : 'image'
  if (bytes.byteLength === 0) throw new Error(`empty ${what}`)
  if (bytes.byteLength > MAX_BYTES) {
    throw new Error(`${what} is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB — the limit is 5 MB`)
  }
  let summary: { lines: number; preview: string } | null = null
  if (document) {
    try {
      summary = documentSummary(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      throw new Error('that file is not UTF-8 text')
    }
  }
  ensureDir()
  const id = crypto.randomUUID()
  const finalName = name.trim() || `${what}.${extension}`
  // Written synchronously: the id is handed out the moment this returns, and a
  // GET for it can arrive before an async write would have landed.
  writeFileSync(join(DIR, `${id}.${extension}`), bytes, { mode: 0o600 })
  // The row is what gives the file an owner. It starts unbound — nobody has sent
  // this image yet — and stays deletable until the message that carries it is
  // written (see `db.bindAttachments`).
  db.insertAttachment({
    id,
    name: finalName,
    mediaType: type,
    extension,
    bytes: bytes.byteLength,
    createdAt: Date.now(),
  })
  return { id, name: finalName, mediaType: type, bytes: bytes.byteLength, ...summary }
}

/**
 * Path of a stored attachment, or null when the id names nothing we hold.
 *
 * The row is the answer. The directory scan behind it is for files written
 * before there were rows: a transcript from an older build still references
 * them, and a lookup that only trusted the table would turn every one of those
 * images into a broken picture.
 */
function pathOf(id: string): { path: string; mediaType: string } | null {
  // An id that is not a uuid cannot address a file: no `..`, no absolute paths.
  if (!UUID.test(id)) return null
  const row = db.getAttachment(id)
  if (row) return { path: join(DIR, `${id}.${row.extension}`), mediaType: row.mediaType }
  let names: string[]
  try {
    names = readdirSync(DIR)
  } catch {
    return null
  }
  const file = names.find((name) => name.startsWith(`${id}.`))
  if (!file) return null
  const extension = file.slice(id.length + 1)
  const mediaType = Object.keys(EXTENSIONS).find((type) => EXTENSIONS[type] === extension)
  if (!mediaType) return null
  return { path: join(DIR, file), mediaType }
}

/** Remove the bytes of one attachment. Missing files are not an error here. */
function removeFile(id: string, extension: string): void {
  try {
    rmSync(join(DIR, `${id}.${extension}`), { force: true })
  } catch {
    // A file we cannot remove is a leaked image, not a reason to fail the
    // delete that asked for it: the row goes either way.
  }
}

/**
 * Why a delete was refused, or null when it went through.
 *
 * Only an upload nobody has sent can be deleted. Once an image is on a message
 * it is part of that transcript, and removing it would leave the message
 * referring to bytes that are gone — deleting the session is how those go.
 */
export function deleteAttachment(id: string): 'gone' | 'sent' | null {
  if (!UUID.test(id)) return 'gone'
  const row = db.getAttachment(id)
  if (!row) return 'gone'
  if (row.sessionId) return 'sent'
  db.deleteAttachmentRow(id)
  removeFile(id, row.extension)
  return null
}

/** Drop the images a deleted session carried. Ids come from `db.deleteSession`. */
export function deleteAttachments(ids: string[]): void {
  for (const id of ids) {
    if (!UUID.test(id)) continue
    // The row is already gone with the session, so the extension is recovered
    // from the directory: an id addresses exactly one file.
    for (const extension of new Set(Object.values(EXTENSIONS))) removeFile(id, extension)
  }
}

/** Uploads abandoned in the composer are swept after a day. */
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000

/**
 * Drop uploads that were never sent.
 *
 * Run once at boot rather than on a timer: an image is only abandoned because
 * the app went away with it still in a composer, so a restart is exactly when
 * that becomes knowable, and a sweeper on a clock would be scanning for
 * something that cannot happen while the app is up.
 *
 * Only rows are swept. A file with no row is an image from before this table
 * existed, and the transcript that shows it still points at it — deleting those
 * would be this function tidying away the user's history.
 */
export function sweepAttachments(now = Date.now()): number {
  const stale = db.staleUnboundAttachments(now - ABANDONED_AFTER_MS)
  for (const row of stale) {
    db.deleteAttachmentRow(row.id)
    removeFile(row.id, row.extension)
  }
  return stale.length
}

export function readAttachment(id: string): { bytes: Uint8Array; mediaType: string } | null {
  const found = pathOf(id)
  if (!found) return null
  try {
    return { bytes: new Uint8Array(readFileSync(found.path)), mediaType: found.mediaType }
  } catch {
    return null
  }
}

/** A document's text, or null when the id names no document we hold. */
export function attachmentText(id: string): string | null {
  const found = readAttachment(id)
  if (!found || found.mediaType !== DOCUMENT_MEDIA_TYPE) return null
  return new TextDecoder().decode(found.bytes)
}

/** The same bytes as base64, which is the shape every harness asks for. */
export function attachmentBase64(id: string): { data: string; mediaType: string } | null {
  const found = readAttachment(id)
  if (!found) return null
  return { data: Buffer.from(found.bytes).toString('base64'), mediaType: found.mediaType }
}
