/**
 * Open a file the agent touched with this machine's default app — the path on
 * a tool row, or a path in a reply.
 *
 * "Open" must never mean "run". The request comes from a click in a web page,
 * so the file is checked here, not trusted: it has to exist, be a regular file
 * (an `.app` bundle is a directory), carry no execute bit, and not have an
 * extension macOS or a Linux desktop hands to something that executes it
 * (Terminal for `.command`, the Python launcher for `.py`, a `.fileloc` that
 * points anywhere). Symlinks are judged by what they point to.
 */
import { realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, resolve } from 'node:path'
import { homeDirectory } from './fs.ts'

/** Extensions whose default "open" runs, installs, mounts or redirects. */
const REFUSED_EXTENSIONS = new Set([
  '.app', '.command', '.tool', '.terminal', '.sh', '.bash', '.zsh', '.csh', '.ksh', '.fish',
  '.workflow', '.action', '.scpt', '.scptd', '.applescript', '.osax',
  '.jar', '.py', '.pyw', '.pl', '.rb', '.php',
  '.fileloc', '.webloc', '.inetloc', '.url', '.desktop',
  '.pkg', '.mpkg', '.dmg', '.prefpane', '.kext', '.mobileconfig', '.bundle', '.plugin',
  '.exe', '.bat', '.cmd', '.com', '.msi', '.ps1', '.appimage', '.deb', '.rpm', '.run', '.bin',
])

export type OpenFileResult =
  | { ok: true; path: string }
  | { ok: false; status: 400 | 403 | 404 | 501; error: string }

/**
 * The absolute file a click means: `~/…` from home, a relative path from the
 * session's folder. Only a local, absolute folder can anchor a relative path.
 */
export function resolveFilePath(path: string, cwd?: string | null): string | null {
  const text = path.trim()
  if (!text || text.includes('\0')) return null
  if (text === '~' || text.startsWith('~/')) return resolve(homeDirectory(), text.slice(2))
  if (isAbsolute(text)) return resolve(text)
  return cwd && isAbsolute(cwd) ? resolve(cwd, text) : null
}

/** Whether `path` may be opened, and the real file it names. Never opens anything. */
export function checkOpenable(path: string, cwd?: string | null): OpenFileResult {
  const resolved = resolveFilePath(path, cwd)
  if (!resolved) return { ok: false, status: 400, error: 'not a path this machine can open' }
  let real: string
  try {
    real = realpathSync(resolved)
  } catch {
    return { ok: false, status: 404, error: `${resolved} does not exist` }
  }
  const stat = statSync(real)
  if (!stat.isFile()) return { ok: false, status: 403, error: `${resolved} is not a regular file` }
  if (stat.mode & 0o111) return { ok: false, status: 403, error: `${resolved} is executable — not opened` }
  const extension = extname(real).toLowerCase()
  if (REFUSED_EXTENSIONS.has(extension) || REFUSED_EXTENSIONS.has(extname(resolved).toLowerCase())) {
    return { ok: false, status: 403, error: `${extension} files are not opened from here` }
  }
  return { ok: true, path: real }
}

/** The command that opens a document with the default app, or null where there is none. */
function openerFor(platform: NodeJS.Platform): string | null {
  if (platform === 'darwin') return 'open'
  if (platform === 'linux') return 'xdg-open'
  return null
}

export function openFile(
  path: string,
  cwd?: string | null,
  spawn: (argv: string[]) => void = (argv) => {
    Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).unref()
  },
  platform: NodeJS.Platform = process.platform,
): OpenFileResult {
  const opener = openerFor(platform)
  if (!opener) return { ok: false, status: 501, error: `opening files is not supported on ${platform}` }
  const checked = checkOpenable(path, cwd)
  if (!checked.ok) return checked
  // An argument vector, never a shell: the path is one argument whatever it
  // contains, and it is absolute, so it cannot be read as a flag.
  spawn([opener, checked.path])
  return checked
}
