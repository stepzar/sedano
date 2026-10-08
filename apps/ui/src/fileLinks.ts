import type { SessionEvent } from '@shared'
import { toolFilePath } from './view.ts'

/**
 * Which paths on screen are files you can open: the ones a session's tools and
 * file changes name, and the ones its replies write as code.
 *
 * Pure on purpose — the server decides whether a file may actually be opened
 * (see `apps/server/src/open-file.ts`); this only decides what to underline.
 */

/** `a/./b/../c` → `a/c`, for an absolute path. */
function normalize(path: string): string {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** An absolute path for `path`, anchored at `cwd` when it is relative. */
export function absolutePath(path: string, cwd: string): string | null {
  if (path.startsWith('/')) return normalize(path)
  if (path.startsWith('~')) return null
  return cwd.startsWith('/') ? normalize(`${cwd}/${path}`) : null
}

/** Every file the session's calls read or wrote, as absolute paths. */
export function touchedFiles(events: SessionEvent[], cwd: string): string[] {
  const files = new Set<string>()
  const add = (path: string | null | undefined) => {
    const absolute = path ? absolutePath(path, cwd) : null
    if (absolute) files.add(absolute)
  }
  for (const event of events) {
    const ev = event.ev
    if (ev.k === 'file_change') add(ev.path)
    else if (ev.k === 'tool') add(toolFilePath(ev))
  }
  return [...files].sort()
}

/** Where the files a person opens live, on macOS and Linux. */
const FILE_ROOTS = /^\/(Users|home|tmp|private|Volumes|var|opt|etc|root|mnt|srv)\/[^/]/

/** A trailing `:12` or `:12:4` — a line reference, not part of the name. */
const LINE_SUFFIX = /:\d+(?::\d+)?$/

/**
 * The file a piece of inline code names, or null when it names none.
 *
 * An absolute path (or `~/…`) is taken as written — the server says whether it
 * exists when it is clicked. A relative one only counts when it matches a file
 * the session touched: resolved against the session's folder, or as the tail of
 * one touched path (`test.md` for the `/Users/x/Desktop/test.md` it created) —
 * never a guess among several.
 */
export function fileReference(text: string, cwd: string, touched: readonly string[]): string | null {
  const raw = text.trim().replace(LINE_SUFFIX, '')
  if (!raw || raw.includes('\n') || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return null
  // A path, not a snippet: no shell syntax, and not a folder.
  if (/[`<>|;"]/.test(raw) || raw.endsWith('/')) return null
  if (raw.startsWith('~/')) return raw
  if (raw.startsWith('/')) {
    const path = normalize(raw)
    // `/api/open-file` in a reply is a route, not a file: an absolute path
    // counts when the session touched it or it lives where files do.
    if (touched.includes(path)) return path
    const underCwd = cwd.length > 1 && path.startsWith(`${cwd.replace(/\/+$/, '')}/`)
    return underCwd || FILE_ROOTS.test(path) ? path : null
  }
  // A relative name is a word with an extension or a slash (`test.md`, `src/a`).
  if (/\s/.test(raw) || (!/[^.]\.[a-z0-9]+$/i.test(raw) && !raw.includes('/'))) return null
  const resolved = absolutePath(raw, cwd)
  if (resolved && touched.includes(resolved)) return resolved
  const tail = `/${raw.replace(/^\.\//, '')}`
  const matches = touched.filter((path) => path.endsWith(tail))
  return matches.length === 1 ? matches[0]! : null
}
