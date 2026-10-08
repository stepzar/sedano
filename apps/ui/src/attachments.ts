/**
 * Pasting images and documents into a composer.
 *
 * Both composers — the launchpad's first message and an open session's chat —
 * treat a pasted image the same way: the bytes are uploaded once and the text
 * keeps an `[image:N]` token where it was pasted, so the agent reads the text
 * and the images in the order they were meant. A document (a long paste, a
 * dropped text file) has no token: it is a chip beside the pictures, and the
 * server appends it to the prompt (see `@shared/documents.ts`).
 */

/** The images in a paste, ignoring the text flavours that come with them. */
export function imageFiles(data: DataTransfer | null): File[] {
  return [...(data?.items ?? [])]
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
}

/** The token that marks where an image sits in the message text. */
export function imageToken(n: number): string {
  return `[image:${n}]`
}

/** Drop `[image:n]` and renumber the ones after it, so the strip still matches. */
export function dropImageToken(text: string, n: number): string {
  return text
    .replace(new RegExp(`\\s*\\[image:${n}\\]`, 'g'), '')
    .replace(/\[image:(\d+)\]/g, (match, digits: string) => {
      const value = Number(digits)
      return value > n ? imageToken(value - 1) : match
    })
}

/** A whole token, and the fragments a half-deleted one leaves behind. */
const TOKEN_OR_FRAGMENT = /\[image:?\d*\]?/g

/**
 * Keep the tokens in the text and the pictures above it in step.
 *
 * They are one thing in two places, so a fragment is a deletion: a backspace
 * anywhere inside `[image:2]` takes the whole token, and the picture goes with
 * it. The numbers are closed up behind it, so what the text says and what the
 * strip shows can never disagree.
 *
 * Nothing is touched while tokens are only being *added* — a paste writes its
 * tokens before the upload of the bytes finishes, and a rewrite in that window
 * would fight the paste for the same text. `known` is how many pictures the
 * strip is showing and `pending` how many are still uploading, so only a
 * decrease is read as a deletion. A token that points past both, or repeats a
 * number already seen (an undo bringing back a chip whose picture is gone), has
 * no picture behind it and is dropped like a fragment.
 */
export function syncImageTokens(text: string, known: number, pending = 0): { text: string; kept: number[] } | null {
  const kept: number[] = []
  let fragment = false
  const scanned = text.replace(TOKEN_OR_FRAGMENT, (match) => {
    const whole = /^\[image:(\d+)\]$/.exec(match)?.[1]
    const number = Number(whole)
    if (!whole || number < 1 || number > known + pending || kept.includes(number)) {
      fragment = true
      return ''
    }
    kept.push(number)
    return `\u0000${kept.length}\u0000`
  })
  if (!fragment && kept.length >= known) return null
  return {
    text: scanned.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => imageToken(Number(index))),
    kept,
  }
}

/** Where each whole `[image:N]` token sits in the text. */
export interface ImageTokenSpan {
  start: number
  end: number
  n: number
}

export function imageTokenSpans(text: string): ImageTokenSpan[] {
  const spans: ImageTokenSpan[] = []
  for (const match of text.matchAll(/\[image:(\d+)\]/g)) {
    spans.push({ start: match.index, end: match.index + match[0].length, n: Number(match[1]) })
  }
  return spans
}

/**
 * Pasted *text* that carries tokens (a chip copied out of the composer, or out
 * of a sent message) would point at pictures this message does not have, so
 * only the words are kept.
 */
export function withoutImageTokens(text: string): string {
  return text.replace(/ ?\[image:\d+\] ?/g, (match) => (match.startsWith(' ') && match.endsWith(' ') ? ' ' : ''))
}

/** Let a drag carrying files drop on the field; text drags keep their default. */
export function allowFileDrop(event: { dataTransfer: DataTransfer; preventDefault: () => void }): void {
  if ([...event.dataTransfer.types].includes('Files')) event.preventDefault()
}

/**
 * The offset in a textarea under a point, where the engine can say (Chrome
 * reports the textarea itself as the caret's node); null elsewhere, and the
 * drop goes to the current caret instead.
 */
export function caretAtPoint(area: HTMLTextAreaElement, x: number, y: number): number | null {
  const at = (document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  }).caretPositionFromPoint?.(x, y)
  return at && at.offsetNode === area ? at.offset : null
}

/* ------------------------------------------------------------------ */
/* Text documents                                                      */
/* ------------------------------------------------------------------ */

/**
 * A paste this long becomes a document chip instead of text in the box, as it
 * does in Claude.ai and ChatGPT: a wall of log or code is hard to write around,
 * and the message you send still reads as what you typed.
 */
const LONG_PASTE_CHARS = 1500
const LONG_PASTE_LINES = 25

export function isLongPaste(text: string): boolean {
  return text.length > LONG_PASTE_CHARS || text.split('\n').length > LONG_PASTE_LINES
}

/** Text files a browser may report with an empty or non-`text/` type. */
const TEXT_EXTENSIONS = new Set(
  (
    'txt md markdown mdx rst adoc org tex log csv tsv json jsonl ndjson yaml yml toml ini cfg conf env xml html htm css scss sass less ' +
    'js mjs cjs jsx ts mts cts tsx vue svelte astro py rb php java kt kts scala go rs c h cc cpp hpp cs swift m mm dart lua r jl ' +
    'sh bash zsh fish ps1 bat sql graphql gql proto tf hcl dockerfile makefile gradle properties diff patch srt vtt'
  ).split(' '),
)

const TEXT_TYPES = /^(text\/|application\/(json|ld\+json|xml|yaml|x-yaml|toml|javascript|typescript|x-sh|x-shellscript|sql|graphql|x-ndjson))/

/** Whether a file is text a harness can read inline. */
export function isTextFile(file: File): boolean {
  if (file.type.startsWith('image/')) return false
  if (TEXT_TYPES.test(file.type)) return true
  const name = file.name.toLowerCase()
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
  return TEXT_EXTENSIONS.has(extension)
}

/** The attach button's `accept`: pictures and the text types above. */
export const ATTACH_ACCEPT = ['image/*', 'text/*', ...[...TEXT_EXTENSIONS].map((extension) => `.${extension}`)].join(',')

/** Every file in a paste or a drop, whatever its type. */
export function transferFiles(data: DataTransfer | null): File[] {
  return [...(data?.items ?? [])]
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
}

/** Files sorted into pictures and documents; anything else is left out. */
export function sortFiles(files: File[]): { images: File[]; documents: File[] } {
  return {
    images: files.filter((file) => file.type.startsWith('image/')),
    documents: files.filter(isTextFile),
  }
}
