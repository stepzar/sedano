import { homedir } from 'node:os'
import { join } from 'node:path'
import { chmodSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import type { Transport } from './transport.ts'

export const HOME = homedir()

/** Claude Code config root. */
export const CLAUDE_HOME = process.env.CLAUDE_CONFIG_DIR ?? join(HOME, '.claude')
/** Codex config root. */
export const CODEX_HOME = process.env.CODEX_HOME ?? join(HOME, '.codex')
/** Grok config root. */
export const GROK_HOME = process.env.GROK_HOME ?? join(HOME, '.grok')
/** Gemini config root. */
export const GEMINI_HOME = process.env.GEMINI_DIR ?? join(HOME, '.gemini')
/** Our own state root. */
export const SEDANO_HOME = process.env.SEDANO_HOME ?? join(HOME, '.sedano')
/**
 * Which Sedano this is: the installed app (the default, and the user's real
 * data) or a development copy started by `bun run dev` / `desktop:dev`. Reported
 * by `/api/health` so neither desktop shell attaches to the other's server, and
 * used to keep remote access (tailscale serve, paired devices) with the app only.
 */
export const SEDANO_INSTANCE: 'app' | 'dev' = process.env.SEDANO_INSTANCE === 'dev' ? 'dev' : 'app'

export const SSH_CONFIG = join(HOME, '.ssh', 'config')

/**
 * Create the store, readable by its owner only, and tighten one that an older
 * build left readable by everyone.
 *
 * It holds every conversation, pasted images, terminal scrollback and paired
 * device tokens. The modes are set explicitly rather than through a process
 * umask, because a umask is inherited by every agent and shell this server
 * starts — and the files *they* write in a person's projects must keep that
 * person's usual modes.
 */
export function ensureDirs(): void {
  mkdirSync(SEDANO_HOME, { recursive: true, mode: 0o700 })
  makePrivate(SEDANO_HOME)
}

/**
 * Take group and other access off a folder and everything in it (symlinks are
 * left alone). The owner's own bits stay as they were, so an executable stays
 * executable.
 */
export function makePrivate(path: string): void {
  let stat
  try {
    stat = path === SEDANO_HOME ? statSync(path) : lstatSync(path)
  } catch {
    return
  }
  if (stat.isSymbolicLink()) return
  const isDir = stat.isDirectory()
  try {
    chmodSync(path, isDir ? 0o700 : stat.mode & 0o700)
  } catch {
    // Not ours to change (a file another user left here): nothing else to do.
  }
  if (!isDir) return
  for (const name of readdirSync(path)) makePrivate(join(path, name))
}

/**
 * Claude Code derives its per-project transcript folder from the cwd by
 * replacing every non-alphanumeric character with a dash.
 * Verified against ~/.claude/projects on a real machine, e.g.
 *   /Users/x/.claude/projects/-Users-x-memory
 *   -> -Users-x--claude-projects--Users-x-memory
 */
export function claudeProjectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export function claudeProjectDir(cwd: string, root: string = CLAUDE_HOME): string {
  return join(root, 'projects', claudeProjectSlug(cwd))
}

export function claudeTranscriptPath(cwd: string, sessionId: string, root: string = CLAUDE_HOME): string {
  return join(claudeProjectDir(cwd, root), `${sessionId}.jsonl`)
}

/** Directory holding one `<agent-*.jsonl>` + `<agent-*.meta.json>` per subagent. */
export function claudeSubagentsDir(cwd: string, sessionId: string, root: string = CLAUDE_HOME): string {
  return join(claudeProjectDir(cwd, root), sessionId, 'subagents')
}

/** Reverse of {@link claudeProjectSlug} is lossy, so we only use it for display. */
export function slugToPathGuess(slug: string): string {
  return slug.replace(/^-/, '/').replace(/-/g, '/')
}

/**
 * Claude Code's config root on the machine a session actually runs on. Locally
 * that is this process' own setting; on a host it is whatever that machine's
 * shell says, because its `~` and its environment are not ours.
 */
export function claudeConfigRoot(transport: Transport): string {
  if (!transport.remote) return process.env.CLAUDE_CONFIG_DIR ?? CLAUDE_HOME
  const dir = transport.exec('printf %s "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"').stdout.trim()
  return dir || join(transport.home(), '.claude')
}
