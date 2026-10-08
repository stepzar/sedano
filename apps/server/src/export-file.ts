/**
 * Save an exported conversation to ~/Downloads, the fallback of the desktop
 * shell.
 *
 * A browser saves a download by itself, and the desktop shell asks its native
 * save dialog and writes the file itself (`export_conversation` in `lib.rs`).
 * This is only for a shell that cannot: it takes a file *name*, never a path —
 * a request from a page must not be able to pick where a file lands — and it
 * never replaces a file, numbering the name instead.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { homeDirectory } from './fs.ts'

const ALLOWED_EXTENSIONS = new Set(['.md', '.txt'])

export type ExportFileResult = { ok: true; path: string } | { ok: false; status: 400; error: string }

export async function writeExportFile(body: { path?: unknown; name?: unknown; content?: unknown }): Promise<ExportFileResult> {
  if (typeof body.content !== 'string') return { ok: false, status: 400, error: 'content is required' }
  if (body.path !== undefined) {
    return { ok: false, status: 400, error: 'a path is chosen in the save dialog, not sent here; send a file name' }
  }
  const target = downloadsPath(body.name)
  if (!target) return { ok: false, status: 400, error: 'a file name is required' }
  if (!ALLOWED_EXTENSIONS.has(extname(target).toLowerCase())) {
    return { ok: false, status: 400, error: 'only .md and .txt exports can be saved' }
  }
  mkdirSync(join(homeDirectory(), 'Downloads'), { recursive: true })
  // `wx`: should a file (or a symlink) appear under this name after the check,
  // the write fails rather than replacing it.
  try {
    writeFileSync(target, body.content, { flag: 'wx' })
  } catch (err) {
    return { ok: false, status: 400, error: `could not save ${target}: ${err instanceof Error ? err.message : String(err)}` }
  }
  return { ok: true, path: target }
}

/** `~/Downloads/<name>`, numbered (`name (2).md`) rather than overwriting. */
function downloadsPath(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const file = basename(name.replace(/\0/g, '')).trim()
  if (!file || file === '.' || file === '..') return null
  const folder = join(homeDirectory(), 'Downloads')
  const extension = extname(file)
  const stem = file.slice(0, file.length - extension.length)
  let candidate = join(folder, file)
  for (let copy = 2; existsSync(candidate); copy++) candidate = join(folder, `${stem} (${copy})${extension}`)
  return candidate
}
