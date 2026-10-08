/**
 * What "accept edits" may approve without asking: an edit whose every file is
 * inside the session's folder.
 *
 * One rule for every harness that answers permission requests itself (Claude's
 * `can_use_tool`, ACP's `session/request_permission`). A request that names no
 * file, names one outside the folder, or names one we cannot resolve is put to
 * the person instead — "could not tell" must never read as "inside".
 *
 * Inside is decided on the real filesystem, not on the spelling: a symlink in
 * the folder that points elsewhere is elsewhere, and `..` is followed the way
 * the kernel follows it. A file that does not exist yet is judged by its
 * deepest existing parent. On an SSH host the same walk runs there, because
 * that is where the edit lands.
 */
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { shq, type Transport } from '../transport.ts'

/** Characters that would break the one-path-per-line answer from a host. */
const UNSAFE = /[\0\n\r\t]/

/**
 * Join the part of a path that exists (already resolved) with the part that
 * does not. A `..` in the missing part cannot be resolved honestly, so it is
 * an unknown rather than a guess.
 */
function joinRest(real: string, rest: string): string | null {
  const segments = rest.split('/').filter((segment) => segment !== '' && segment !== '.')
  if (segments.includes('..')) return null
  return segments.length ? join(real, ...segments) : real
}

function resolveLocal(path: string): string | null {
  const parts = path.split('/')
  for (let end = parts.length; end > 0; end--) {
    const prefix = parts.slice(0, end).join('/') || '/'
    try {
      lstatSync(prefix)
    } catch {
      continue
    }
    try {
      // A dangling symlink exists (lstat) but does not resolve: writing through
      // it creates its target, wherever that is — so it is an unknown.
      return joinRest(realpathSync(prefix), parts.slice(end).join('/'))
    } catch {
      return null
    }
  }
  return null
}

/**
 * Walk up to the deepest existing ancestor and `realpath` it, on the host. A
 * host without `realpath` answers with an empty line, which reads as unknown.
 */
const REMOTE_RESOLVE =
  'r() { p=$1; rest=; while :; do ' +
  'if [ -L "$p" ] || [ -e "$p" ]; then x=$(realpath "$p" 2>/dev/null) || x=; printf "R:%s\\t%s\\n" "$x" "$rest"; return; fi; ' +
  'case $p in /|"") printf "R:\\t\\n"; return;; esac; ' +
  'rest="/${p##*/}$rest"; p=${p%/*}; [ -n "$p" ] || p=/; done; }; '

/**
 * Each absolute path resolved through symlinks on the transport's machine, or
 * null where that cannot be done. Relative paths are not accepted here: what
 * they are relative to is the caller's decision.
 */
export async function resolvePaths(transport: Transport, paths: string[]): Promise<Array<string | null>> {
  const usable = paths.map((path) => isAbsolute(path) && !UNSAFE.test(path))
  if (!transport.remote) return paths.map((path, index) => (usable[index] ? resolveLocal(path) : null))

  const asked = paths.filter((_, index) => usable[index])
  const answers: Array<string | null> = []
  if (asked.length) {
    const result = await transport.execAsync(REMOTE_RESOLVE + asked.map((path) => `r ${shq(path)}`).join('; '), {
      timeoutMs: 8000,
      retries: 1,
    })
    if (result.error) throw result.error
    for (const line of result.stdout.split('\n')) {
      if (!line.startsWith('R:')) continue
      const [real = '', rest = ''] = line.slice(2).split('\t')
      answers.push(real.startsWith('/') ? joinRest(real, rest) : null)
    }
    if (answers.length !== asked.length) throw new Error('the host did not resolve every path')
  }
  let next = 0
  return paths.map((_, index) => (usable[index] ? answers[next++]! : null))
}

/**
 * Whether every path is inside `cwd`, both resolved on the session's machine.
 * Relative paths are relative to `cwd`. No paths, or any path that cannot be
 * resolved (or a host that cannot be asked), is `false`.
 */
export async function insideWorkspace(transport: Transport, cwd: string, paths: string[]): Promise<boolean> {
  if (!paths.length || !isAbsolute(cwd)) return false
  // `~` is the shell's, not the filesystem's: as a path it would be read as a
  // folder named "~" inside the workspace, which is not what the agent meant.
  if (paths.some((path) => path.startsWith('~'))) return false
  const absolute = paths.map((path) => (isAbsolute(path) ? path : `${cwd}/${path}`))
  let resolved: Array<string | null>
  try {
    resolved = await resolvePaths(transport, [cwd, ...absolute])
  } catch {
    return false
  }
  const [root, ...targets] = resolved
  if (!root) return false
  const prefix = root.endsWith('/') ? root : `${root}/`
  return targets.every((target) => target !== null && (target === root || target.startsWith(prefix)))
}

/**
 * The one decision "accept edits" (and `auto`, its alias outside Claude) makes
 * by itself: an edit, every file of it inside the workspace. Deletes, moves,
 * shell commands, fetches and anything unnamed go to the person.
 */
export async function acceptEditsMayApprove(
  transport: Transport,
  cwd: string,
  request: { isEdit: boolean; paths: string[] },
): Promise<boolean> {
  return request.isEdit && (await insideWorkspace(transport, cwd, request.paths))
}
