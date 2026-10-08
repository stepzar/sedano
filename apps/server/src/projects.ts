import { readdirSync, statSync, readFileSync, openSync, readSync, closeSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import type { HarnessId, ProjectRef } from '@shared'
import { CLAUDE_HOME, CODEX_HOME, GROK_HOME, HOME } from './paths.ts'
import { allHosts } from './hosts.ts'

interface Hit {
  path: string
  at: number
  harness: HarnessId
}

function readHead(path: string, bytes = 16 * 1024): string {
  try {
    const st = statSync(path)
    const length = Math.min(bytes, st.size)
    if (length <= 0) return ''
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(length)
      readSync(fd, buf, 0, length, 0)
      return buf.toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

function newestFile(dir: string, minMtime = 0): { path: string; mtime: number } | null {
  let best: { path: string; mtime: number } | null = null
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue
    const full = join(dir, name)
    try {
      const st = statSync(full)
      if (!st.isFile()) continue
      if (st.mtimeMs < minMtime) continue
      if (!best || st.mtimeMs > best.mtime) best = { path: full, mtime: st.mtimeMs }
    } catch {
      /* ignore */
    }
  }
  return best
}

/** Claude: recover the real cwd from the first record of each project transcript. */
function fromClaude(): Hit[] {
  const hits: Hit[] = []
  const root = join(CLAUDE_HOME, 'projects')
  let dirs: string[]
  try {
    dirs = readdirSync(root)
  } catch {
    return hits
  }
  for (const dir of dirs) {
    const full = join(root, dir)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (!st.isDirectory()) continue
    const newest = newestFile(full, Date.now() - 1000 * 60 * 60 * 24 * 120)
    if (!newest) continue
    const head = readHead(newest.path, 32 * 1024)
    const match = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head)
    if (!match) continue
    let cwd: string
    try {
      cwd = JSON.parse(`"${match[1]}"`) as string
    } catch {
      continue
    }
    if (!cwd.startsWith('/')) continue
    const dirMtime = (() => {
      try {
        return statSync(full).mtimeMs
      } catch {
        return newest.mtime
      }
    })()
    hits.push({ path: cwd, at: Math.max(newest.mtime, dirMtime), harness: 'claude' })
  }
  return hits
}

/** Codex: trusted project list from config.toml + cwd of the newest rollouts. */
function fromCodex(): Hit[] {
  const hits: Hit[] = []
  try {
    const toml = readFileSync(join(CODEX_HOME, 'config.toml'), 'utf8')
    const configMtime = statSync(join(CODEX_HOME, 'config.toml')).mtimeMs
    for (const m of toml.matchAll(/\[projects\."((?:[^"\\]|\\.)*)"\]/g)) {
      hits.push({ path: m[1]!.replace(/\\"/g, '"'), at: configMtime, harness: 'codex' })
    }
  } catch {
    /* no config */
  }

  // Recent rollouts carry the real cwd.
  const root = join(CODEX_HOME, 'sessions')
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  const files: Array<{ path: string; mtime: number }> = []
  while (stack.length) {
    const { dir, depth } = stack.pop()!
    if (depth > 3) continue
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const full = join(dir, name)
      try {
        const st = statSync(full)
        if (st.isDirectory()) stack.push({ dir: full, depth: depth + 1 })
        else if (name.endsWith('.jsonl')) files.push({ path: full, mtime: st.mtimeMs })
      } catch {
        /* ignore */
      }
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  for (const file of files.slice(0, 60)) {
    const head = readHead(file.path, 4096)
    const match = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(head)
    if (match?.[1]?.startsWith('/')) hits.push({ path: match[1], at: file.mtime, harness: 'codex' })
  }
  return hits
}

/** Grok: session folders are percent-encoded absolute paths. */
function fromGrok(): Hit[] {
  const hits: Hit[] = []
  const root = join(GROK_HOME, 'sessions')
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return hits
  }
  for (const name of names) {
    let decoded: string
    try {
      decoded = decodeURIComponent(name)
    } catch {
      continue
    }
    if (!decoded.startsWith('/')) continue
    let at = Date.now()
    try {
      at = statSync(join(root, name)).mtimeMs
    } catch {
      /* ignore */
    }
    hits.push({ path: decoded, at, harness: 'grok' })
  }
  return hits
}

/** Plain directories under ~/Projects, or the folder `SEDANO_PROJECTS_DIR` names. */
function fromProjectsDir(): Hit[] {
  const hits: Hit[] = []
  const root = process.env.SEDANO_PROJECTS_DIR || join(HOME, 'Projects')
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return hits
  }
  for (const name of names) {
    if (name.startsWith('.')) continue
    const full = join(root, name)
    try {
      const st = statSync(full)
      if (!st.isDirectory()) continue
      let at = st.mtimeMs
      try {
        const git = statSync(join(full, '.git'))
        at = Math.max(at, git.mtimeMs)
      } catch {
        /* not a repo */
      }
      hits.push({ path: full, at, harness: 'claude' })
    } catch {
      /* ignore */
    }
  }
  return hits
}

export function sshHosts(): string[] {
  return allHosts()
}

let cache: { at: number; projects: ProjectRef[] } | null = null
const TTL = 30_000

export function listProjects(force = false): ProjectRef[] {
  if (!force && cache && Date.now() - cache.at < TTL) return cache.projects
  const hosts = sshHosts()
  const merged = new Map<string, ProjectRef>()

  const absorb = (hit: Hit) => {
    const existing = merged.get(hit.path)
    if (existing) {
      existing.lastUsed = Math.max(existing.lastUsed, hit.at)
      if (!existing.harnesses.includes(hit.harness)) existing.harnesses.push(hit.harness)
      return
    }
    merged.set(hit.path, {
      path: hit.path,
      name: basename(hit.path) || hit.path,
      lastUsed: hit.at,
      exists: existsSync(hit.path),
      hosts,
      harnesses: [hit.harness],
    })
  }

  for (const hit of [...fromClaude(), ...fromCodex(), ...fromGrok(), ...fromProjectsDir()]) absorb(hit)

  const projects = [...merged.values()]
    .filter((p) => p.exists)
    .sort((a, b) => b.lastUsed - a.lastUsed)
  cache = { at: Date.now(), projects }
  return projects
}

export function cacheAge(): number {
  return cache ? Date.now() - cache.at : -1
}
