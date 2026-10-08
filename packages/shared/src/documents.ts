import type { AttachmentRef } from './events.ts'

/**
 * Text documents attached to a message: a long paste, or a dropped `.md`.
 *
 * They travel like images — uploaded once, referenced by id, shown as a chip —
 * but every harness takes text, so on the way to the harness each one is
 * appended to the prompt inside an `<attached_file>` block. The same block is
 * what a harness writes back into its own transcript, so a history read from
 * there is split again here and still shows chips instead of the whole text.
 */

/** The one media type a document is stored under. */
export const DOCUMENT_MEDIA_TYPE = 'text/plain'

export function isDocument(ref: Pick<AttachmentRef, 'mediaType'>): boolean {
  return ref.mediaType.startsWith('text/')
}

/** How many lines, and the first few of them, for a chip. */
export function documentSummary(text: string): { lines: number; preview: string } {
  const lines = text ? text.split('\n').length : 0
  return { lines, preview: text.split('\n').slice(0, 8).join('\n').slice(0, 480) }
}

function fileBlock(name: string, text: string): string {
  return `<attached_file name="${name.replace(/"/g, "'")}">\n${text}\n</attached_file>`
}

/** The prompt a harness receives: what was typed, then each document in full. */
export function withDocuments(text: string, documents: { name: string; text: string }[]): string {
  if (!documents.length) return text
  const blocks = documents.map((document) => fileBlock(document.name, document.text)).join('\n\n')
  return text ? `${text}\n\n${blocks}` : blocks
}

/** A document found inside a message's own text (a history read from the harness). */
export interface InlineDocument {
  name: string
  text: string
}

// Each block must be followed by another block or by the end of the message,
// which keeps a closing tag *inside* a document from ending it early.
const BLOCK = /(?:^|\n\n)<attached_file name="([^"]*)">\n([\s\S]*?)\n<\/attached_file>(?=\n\n<attached_file |\s*$)/g

/**
 * Split the `<attached_file>` blocks off the end of a message. Only blocks at
 * the end are taken — that is where `withDocuments` puts them — so a prompt
 * that merely talks about the tag keeps its words.
 */
export function splitDocuments(text: string): { text: string; documents: InlineDocument[] } {
  if (!text.includes('<attached_file ')) return { text, documents: [] }
  const documents: InlineDocument[] = []
  let start = -1
  for (const match of text.matchAll(BLOCK)) {
    if (start === -1) start = match.index
    documents.push({ name: match[1]!, text: match[2]! })
  }
  if (start === -1) return { text, documents: [] }
  return { text: text.slice(0, start).trimEnd(), documents }
}
