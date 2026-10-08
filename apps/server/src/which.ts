import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * GUI applications on macOS normally start with `/usr/bin:/bin:…`, not with
 * the PATH from the terminal where Claude, Codex, Bun or npm were installed.
 * These are executable directories used by the supported installers and
 * version managers. We inspect directories only: sourcing `.zshrc` here would
 * execute arbitrary interactive configuration inside the background server.
 */
function userBinDirs(home: string): string[] {
  return [
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.local', 'share', 'pnpm'),
    join(home, 'Library', 'pnpm'),
    join(home, '.npm-global', 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, '.mise', 'shims'),
    join(home, '.claude', 'bin'),
    join(home, '.codex', 'bin'),
    join(home, '.commandcode', 'bin'),
    join(home, '.opencode', 'bin'),
    join(home, '.gemini', 'bin'),
    join(home, '.grok', 'bin'),
  ]
}

const SYSTEM_BIN_DIRS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
]

/** All installed nvm Node versions, because a GUI process has no active nvm. */
function nvmBinDirs(home: string): string[] {
  const root = join(home, '.nvm', 'versions', 'node')
  try {
    // Descending makes a newer Node installation win when the inherited PATH
    // did not already name the user's active one.
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name, 'bin'))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
  } catch {
    return []
  }
}

/**
 * PATH used for tool discovery and child processes in a packaged desktop app.
 * The inherited entries stay first, so a terminal launch behaves exactly as it
 * did before; fallbacks only fill in what a GUI launch omitted.
 */
export function discoveryPath(
  inherited = process.env.PATH ?? '',
  home = process.env.HOME || homedir(),
): string {
  // Explicitly scoped environments (notably hermetic probes) can opt out of
  // finding unrelated user/system CLIs outside their supplied PATH.
  if (process.env.SEDANO_EXPLICIT_PATH === '1') return inherited
  const entries = [
    ...inherited.split(':').filter(Boolean),
    ...userBinDirs(home),
    ...nvmBinDirs(home),
  ]
  return [...new Set(entries)].join(':')
}

/**
 * POSIX-shell prelude for a remote, non-interactive ssh command.
 *
 * It is static shell source: no host, binary or user-controlled text is
 * interpolated. `$HOME` remains quoted and every candidate must be a directory.
 * The nvm glob is intentionally expanded by the remote shell; an unmatched glob
 * fails `-d` and is ignored.
 */
export function remoteDiscoveryPathPrelude(): string {
  const quoted = [
    '$HOME/.local/bin',
    '$HOME/bin',
    '$HOME/.bun/bin',
    '$HOME/.volta/bin',
    '$HOME/.cargo/bin',
    '$HOME/.local/share/pnpm',
    '$HOME/Library/pnpm',
    '$HOME/.npm-global/bin',
    '$HOME/.asdf/shims',
    '$HOME/.mise/shims',
    '$HOME/.claude/bin',
    '$HOME/.codex/bin',
    '$HOME/.commandcode/bin',
    '$HOME/.opencode/bin',
    '$HOME/.gemini/bin',
    '$HOME/.grok/bin',
  ].map((path) => `"${path}"`)
  const candidates = [
    ...quoted,
    '"$HOME"/.nvm/versions/node/*/bin',
    ...SYSTEM_BIN_DIRS.map((path) => `"${path}"`),
  ].join(' ')
  return `for sedano_bin_dir in ${candidates}; do [ -d "$sedano_bin_dir" ] && PATH="\${PATH:+$PATH:}$sedano_bin_dir"; done; export PATH; `
}

/**
 * Resolve a binary using the environment this process actually uses plus the
 * well-known GUI fallbacks above.
 *
 * `Bun.which(bin)` does not read a PATH assigned after process launch. Passing
 * PATH explicitly is also what keeps hermetic tests on their fake tools rather
 * than accidentally reaching a real account and spending quota.
 */
export function which(bin: string): string | null {
  return Bun.which(bin, { PATH: discoveryPath() }) ?? null
}
