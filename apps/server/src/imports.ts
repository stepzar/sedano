/**
 * Find the conversations one folder has in every harness' own store, for the
 * import popup, and read the history of the ones no driver can replay.
 *
 * Read-only and bounded: every native store is opened for reading only, each
 * file is read by its head (and, for Claude, its tail) rather than whole, and
 * each harness lists at most `PER_HARNESS` conversations. The formats are the
 * ones on disk, not a published contract, so a record that does not parse is
 * skipped instead of failing the scan, and a store that cannot be read is
 * reported per harness.
 */
import { Database } from 'bun:sqlite'
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import type { HarnessId, ImportScan, ImportableSession, TimelineEvent } from '@shared'
import { claudeProjectSlug } from './paths.ts'

const PER_HARNESS = 200
const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = 32 * 1024
/** A title is a line in a list, not the prompt. */
const TITLE_MAX = 120

/**
 * The stores, resolved when asked: tests point `HOME` at a temporary folder.
 * The two `SEDANO_IMPORT_*` overrides exist for the browser checks, which must
 * not move the real CLIs' own data (`XDG_DATA_HOME` would) to keep a scan off
 * this machine's stores.
 */
function roots() {
  const home = process.env.HOME || homedir()
  return {
    claude: process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'),
    codex: process.env.CODEX_HOME ?? join(home, '.codex'),
    gemini: process.env.GEMINI_DIR ?? join(home, '.gemini'),
    grok: process.env.GROK_HOME ?? join(home, '.grok'),
    opencode: process.env.SEDANO_IMPORT_OPENCODE_DIR ?? join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'opencode'),
    commandcode: process.env.SEDANO_IMPORT_COMMANDCODE_DIR ?? join(home, '.commandcode'),
  }
}

type Found = Omit<ImportableSession, 'source' | 'harness'> & { nativeId: string }

/* ------------------------------------------------------------------ */
/* Small readers                                                        */
/* ------------------------------------------------------------------ */

function readRange(path: string, start: number, length: number): string {
  if (length <= 0) return ''
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(length)
    const read = readSync(fd, buf, 0, length, start)
    return buf.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

/** The complete JSON lines within the first `bytes` of a file. */
function headRecords(path: string, size: number, bytes = HEAD_BYTES): any[] {
  const text = readRange(path, 0, Math.min(size, bytes))
  const lines = text.split('\n')
  // The last line is only whole when the whole file was read.
  if (size > bytes) lines.pop()
  return parseLines(lines)
}

/** The complete JSON lines within the last `bytes` of a file. */
function tailRecords(path: string, size: number, bytes = TAIL_BYTES): any[] {
  if (size <= bytes) return []
  const lines = readRange(path, size - bytes, bytes).split('\n')
  lines.shift()
  return parseLines(lines)
}

function parseLines(lines: string[]): any[] {
  const out: any[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* a line cut or written by a newer version: not a reason to fail the scan */
    }
  }
  return out
}

/**
 * The first line of a file, however long: a Codex rollout opens with its whole
 * system prompt on one line. Bounded all the same.
 */
function firstLine(path: string, max = 2 * 1024 * 1024): string {
  const fd = openSync(path, 'r')
  try {
    const chunks: Buffer[] = []
    let offset = 0
    while (offset < max) {
      const buf = Buffer.alloc(64 * 1024)
      const read = readSync(fd, buf, 0, buf.length, offset)
      if (read <= 0) break
      const slice = buf.subarray(0, read)
      const newline = slice.indexOf(10)
      if (newline >= 0) {
        chunks.push(slice.subarray(0, newline))
        break
      }
      chunks.push(slice)
      offset += read
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function listFiles(dir: string, keep: (name: string) => boolean): Array<{ path: string; mtime: number; size: number }> {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const files: Array<{ path: string; mtime: number; size: number }> = []
  for (const name of names) {
    if (!keep(name)) continue
    const path = join(dir, name)
    try {
      const st = statSync(path)
      if (st.isFile()) files.push({ path, mtime: st.mtimeMs, size: st.size })
    } catch {
      /* gone between the listing and the stat */
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime)
}

/** One line, whitespace collapsed, cut at a readable length. */
export function cleanTitle(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1).trimEnd()}…` : flat
}

/** Text parts of a message content: a string, or an array of `{ text }` / `{ type: 'text', text }`. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
        const type = (part as { type?: unknown }).type
        if (type === undefined || type === 'text' || type === 'input_text') return (part as { text: string }).text
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/** Context a harness injects as a user message (`<environment_context>`, `<session_context>`, ...). */
function injected(text: string): boolean {
  const start = text.trimStart()
  return !start || start.startsWith('<') || start.startsWith('# AGENTS.md') || start.startsWith('Caveat:')
}

function time(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

/* ------------------------------------------------------------------ */
/* Claude Code: ~/.claude/projects/<slug>/<uuid>.jsonl                  */
/* ------------------------------------------------------------------ */

function scanClaude(cwd: string): Found[] {
  const dir = join(roots().claude, 'projects', claudeProjectSlug(cwd))
  const found: Found[] = []
  for (const file of listFiles(dir, (name) => name.endsWith('.jsonl')).slice(0, PER_HARNESS)) {
    const records = headRecords(file.path, file.size)
    // The slug is lossy (`/a-b` and `/a/b` share one): the records say which folder.
    const recordCwd = records.find((rec) => typeof rec?.cwd === 'string')?.cwd
    if (recordCwd && recordCwd !== cwd) continue
    let prompt = ''
    for (const rec of records) {
      if (rec?.type !== 'user' || rec.isMeta === true || rec.isSidechain === true) continue
      const text = textOf(rec.message?.content)
      if (text && !injected(text)) {
        prompt = text
        break
      }
    }
    // The newest name wins: a rename, then the harness' own title, then a summary.
    let named = ''
    for (const rec of [...records, ...tailRecords(file.path, file.size)]) {
      if (rec?.type === 'custom-title' && typeof rec.customTitle === 'string' && rec.customTitle.trim()) named = `custom:${rec.customTitle}`
      else if (!named.startsWith('custom:') && rec?.type === 'ai-title' && typeof rec.aiTitle === 'string' && rec.aiTitle.trim()) named = `ai:${rec.aiTitle}`
      else if (!named && rec?.type === 'summary' && typeof rec.summary === 'string' && rec.summary.trim()) named = `summary:${rec.summary}`
    }
    const title = named ? named.slice(named.indexOf(':') + 1) : prompt
    if (!title) continue
    found.push({ nativeId: basename(file.path, '.jsonl'), title: cleanTitle(title), updatedAt: file.mtime })
  }
  return found
}

/* ------------------------------------------------------------------ */
/* Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl                  */
/* ------------------------------------------------------------------ */

function codexThreadNames(root: string): Map<string, string> {
  const names = new Map<string, string>()
  const path = join(root, 'session_index.jsonl')
  try {
    if (statSync(path).size > 8 * 1024 * 1024) return names
    for (const rec of parseLines(readFileSync(path, 'utf8').split('\n'))) {
      if (typeof rec?.id === 'string' && typeof rec.thread_name === 'string' && rec.thread_name.trim()) names.set(rec.id, rec.thread_name)
    }
  } catch {
    /* no index: titles come from the first prompt */
  }
  return names
}

function scanCodex(cwd: string): Found[] {
  const root = roots().codex
  const files: Array<{ path: string; mtime: number; size: number }> = []
  const walk = (dir: string, depth: number) => {
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      const path = join(dir, name)
      if (depth < 3) walk(path, depth + 1)
      else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) {
        try {
          const st = statSync(path)
          files.push({ path, mtime: st.mtimeMs, size: st.size })
        } catch {
          /* gone */
        }
      }
    }
  }
  walk(join(root, 'sessions'), 0)
  files.sort((a, b) => b.mtime - a.mtime)
  const names = codexThreadNames(root)
  const found: Found[] = []
  // Other folders' rollouts are read too, one header each: a bound on those,
  // not only on the matches, is what keeps a big history fast.
  for (const file of files.slice(0, 1500)) {
    if (found.length >= PER_HARNESS) break
    let meta: any
    try {
      meta = JSON.parse(firstLine(file.path))
    } catch {
      continue
    }
    const payload = meta?.type === 'session_meta' ? meta.payload : null
    if (!payload || payload.cwd !== cwd || typeof payload.id !== 'string') continue
    // A sub-agent's thread belongs to the conversation that spawned it.
    const source = payload.source
    if (payload.thread_source === 'subagent' || (source && typeof source === 'object' && 'subagent' in source)) continue
    let title = names.get(payload.id) ?? ''
    if (!title) {
      for (const rec of headRecords(file.path, file.size, 512 * 1024)) {
        const item = rec?.payload
        if (rec?.type === 'event_msg' && item?.type === 'user_message' && typeof item.message === 'string' && !injected(item.message)) {
          title = item.message
          break
        }
        if (rec?.type === 'response_item' && item?.type === 'message' && item.role === 'user') {
          const text = textOf(item.content)
          if (text && !injected(text)) {
            title = text
            break
          }
        }
      }
    }
    if (!title) continue
    found.push({ nativeId: payload.id, title: cleanTitle(title), updatedAt: file.mtime })
  }
  return found
}

/* ------------------------------------------------------------------ */
/* Gemini CLI: ~/.gemini/tmp/<sha256(cwd) | project name>/chats          */
/* ------------------------------------------------------------------ */

function geminiDirs(root: string, cwd: string): string[] {
  const hash = createHash('sha256').update(cwd).digest('hex')
  const dirs = [join(root, 'tmp', hash, 'chats')]
  // Newer versions name the folder after the project, listed in projects.json.
  try {
    const projects = JSON.parse(readFileSync(join(root, 'projects.json'), 'utf8'))?.projects
    const name = projects?.[cwd]
    if (typeof name === 'string' && name && !name.includes('/')) dirs.push(join(root, 'tmp', name, 'chats'))
  } catch {
    /* no registry */
  }
  return dirs
}

function geminiMessages(rec: any): any[] {
  if (Array.isArray(rec?.messages)) return rec.messages
  if (Array.isArray(rec?.$set?.messages)) return rec.$set.messages
  if (rec?.$push?.messages) return [].concat(rec.$push.messages)
  if (typeof rec?.type === 'string' && 'content' in rec) return [rec]
  return []
}

function scanGemini(cwd: string): Found[] {
  const root = roots().gemini
  const hash = createHash('sha256').update(cwd).digest('hex')
  const found: Found[] = []
  const seen = new Set<string>()
  for (const dir of geminiDirs(root, cwd)) {
    for (const file of listFiles(dir, (name) => name.startsWith('session-') && (name.endsWith('.json') || name.endsWith('.jsonl')))) {
      if (found.length >= PER_HARNESS) break
      let records: any[]
      if (file.path.endsWith('.jsonl')) records = headRecords(file.path, file.size, 256 * 1024)
      else if (file.size > 16 * 1024 * 1024) continue
      else {
        try {
          records = [JSON.parse(readFileSync(file.path, 'utf8'))]
        } catch {
          continue
        }
      }
      const header = records[0]
      const id = header?.sessionId
      if (typeof id !== 'string' || seen.has(id)) continue
      if (typeof header.projectHash === 'string' && header.projectHash !== hash) continue
      if (typeof header.kind === 'string' && header.kind !== 'main') continue
      let prompt = ''
      for (const message of records.flatMap(geminiMessages)) {
        if (message?.type !== 'user') continue
        const text = textOf(message.content)
        if (text && !injected(text)) {
          prompt = text
          break
        }
      }
      if (!prompt) continue
      seen.add(id)
      found.push({ nativeId: id, title: cleanTitle(prompt), updatedAt: file.mtime })
    }
  }
  return found
}

/* ------------------------------------------------------------------ */
/* Opencode: ~/.local/share/opencode/opencode.db                        */
/* ------------------------------------------------------------------ */

function scanOpencode(cwd: string): Found[] {
  const path = join(roots().opencode, 'opencode.db')
  if (!existsSync(path)) return []
  const db = new Database(path, { readonly: true })
  try {
    db.exec('PRAGMA busy_timeout = 1000')
    const rows = db
      .query<{ id: string; title: string; time_updated: number }, [string, number]>(
        `SELECT id, title, time_updated FROM session s
         WHERE directory = ? AND parent_id IS NULL
           AND EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id)
         ORDER BY time_updated DESC LIMIT ?`,
      )
      .all(cwd, PER_HARNESS)
    const firstPrompt = db.query<{ text: string | null }, [string]>(
      `SELECT json_extract(p.data, '$.text') AS text FROM part p
       JOIN message m ON m.id = p.message_id
       WHERE p.session_id = ? AND json_extract(m.data, '$.role') = 'user'
         AND json_extract(p.data, '$.type') = 'text'
         AND coalesce(json_extract(p.data, '$.synthetic'), 0) = 0
       ORDER BY p.time_created, p.id LIMIT 1`,
    )
    const found: Found[] = []
    for (const row of rows) {
      // An ACP session keeps the placeholder title Opencode gives every new one.
      const placeholder = !row.title.trim() || /^New session - /.test(row.title)
      const title = placeholder ? (firstPrompt.get(row.id)?.text ?? '') : row.title
      if (!title.trim()) continue
      found.push({ nativeId: row.id, title: cleanTitle(title), updatedAt: row.time_updated })
    }
    return found
  } finally {
    db.close()
  }
}

/* ------------------------------------------------------------------ */
/* Grok: ~/.grok/sessions/<percent-encoded cwd>/<id>/summary.json       */
/* ------------------------------------------------------------------ */

function scanGrok(cwd: string): Found[] {
  const dir = join(roots().grok, 'sessions', encodeURIComponent(cwd))
  let ids: string[]
  try {
    ids = readdirSync(dir)
  } catch {
    return []
  }
  const found: Found[] = []
  for (const id of ids) {
    let summary: any
    try {
      summary = JSON.parse(readFileSync(join(dir, id, 'summary.json'), 'utf8'))
    } catch {
      continue
    }
    if (summary?.session_kind === 'subagent' || !summary?.num_chat_messages) continue
    if (summary.info?.cwd && summary.info.cwd !== cwd) continue
    let title = [summary.generated_title, summary.session_summary].find((value) => typeof value === 'string' && value.trim()) ?? ''
    if (!title) {
      const history = join(dir, id, 'chat_history.jsonl')
      try {
        const size = statSync(history).size
        for (const rec of headRecords(history, size, 256 * 1024)) {
          // `prompt_index` marks what the user typed; injected context has none.
          if (rec?.type !== 'user' || rec.prompt_index === undefined) continue
          const text = textOf(rec.content)
          if (text && !injected(text)) {
            title = text
            break
          }
        }
      } catch {
        /* no history file */
      }
    }
    if (!title) continue
    const updatedAt = time(summary.last_active_at ?? summary.updated_at, 0)
    found.push({ nativeId: String(summary.info?.id ?? id), title: cleanTitle(title), updatedAt })
  }
  return found.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, PER_HARNESS)
}

/* ------------------------------------------------------------------ */
/* Command Code: ~/.commandcode/projects/<slug>/<uuid>.jsonl            */
/* ------------------------------------------------------------------ */

/** Command Code's folder name for a cwd: lowercased, every run of other characters a dash. */
export function commandCodeSlug(cwd: string): string {
  return cwd.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function commandCodeFile(name: string): boolean {
  return name.endsWith('.jsonl') && !name.endsWith('.checkpoints.jsonl')
}

function scanCommandCode(cwd: string): Found[] {
  const dir = join(roots().commandcode, 'projects', commandCodeSlug(cwd))
  const found: Found[] = []
  for (const file of listFiles(dir, commandCodeFile).slice(0, PER_HARNESS)) {
    const records = headRecords(file.path, file.size)
    const header = records[0]
    if (header?.type !== 'session' || typeof header.id !== 'string' || header.cwd !== cwd) continue
    let prompt = ''
    let command = ''
    for (const rec of records) {
      if (rec?.type !== 'message' || rec.message?.role !== 'user') continue
      const text = textOf(rec.message.content).trim()
      if (!text) continue
      // A slash command is a title only when nothing else was ever asked.
      if (text.startsWith('/')) command ||= text
      else {
        prompt = text
        break
      }
    }
    const title = prompt || command
    if (!title) continue
    found.push({ nativeId: header.id, title: cleanTitle(title), updatedAt: file.mtime })
  }
  return found
}

/**
 * A Command Code conversation as timeline events. Its driver continues a
 * conversation with `--resume` but has no transcript to replay, so the import
 * carries the history itself: the prompts, the replies and the thinking.
 */
export function commandCodeHistory(cwd: string, nativeId: string): Array<{ ev: TimelineEvent; at: number }> {
  const path = join(roots().commandcode, 'projects', commandCodeSlug(cwd), `${nativeId}.jsonl`)
  if (!/^[\w-]+$/.test(nativeId) || !existsSync(path) || statSync(path).size > 32 * 1024 * 1024) return []
  const events: Array<{ ev: TimelineEvent; at: number }> = []
  for (const rec of parseLines(readFileSync(path, 'utf8').split('\n'))) {
    if (rec?.type !== 'message' || !rec.message) continue
    const at = time(rec.timestamp, Date.now())
    const content = Array.isArray(rec.message.content) ? rec.message.content : [rec.message.content]
    if (rec.message.role === 'user') {
      const text = textOf(content).trim()
      if (text) events.push({ ev: { k: 'user', text }, at })
      continue
    }
    if (rec.message.role !== 'assistant') continue
    const thinking = content
      .map((part: any) => (part?.type === 'thinking' && typeof part.thinking === 'string' ? part.thinking : ''))
      .filter(Boolean)
      .join('\n')
      .trim()
    if (thinking) events.push({ ev: { k: 'thinking', text: thinking }, at })
    const text = textOf(content).trim()
    if (text) events.push({ ev: { k: 'assistant', text, ...(typeof rec.model === 'string' ? { model: rec.model } : {}) }, at })
  }
  return events
}

/* ------------------------------------------------------------------ */
/* The scan                                                             */
/* ------------------------------------------------------------------ */

const SCANNERS: Array<[HarnessId, (cwd: string) => Found[]]> = [
  ['claude', scanClaude],
  ['codex', scanCodex],
  ['gemini', scanGemini],
  ['opencode', scanOpencode],
  ['grok', scanGrok],
  ['commandcode', scanCommandCode],
]

/**
 * The native conversation an import names, looked up the way the scan found
 * it. An import only ever opens something the scan could have listed, so a
 * client cannot hand a CLI an arbitrary id or folder.
 */
export function findNative(harness: HarnessId, cwd: string, nativeId: string): { title: string } | null {
  const scan = SCANNERS.find(([id]) => id === harness)?.[1]
  if (!scan) return null
  const item = scan(cwd).find((found) => found.nativeId === nativeId)
  return item ? { title: item.title } : null
}

export interface ScanInput {
  cwd: string
  host: string | null
  /** Sedano's archived sessions of this folder. */
  archived: Array<{ id: string; harness: HarnessId; nativeId: string | null; title: string; updatedAt: number }>
  /** `harness:nativeId` of every conversation Sedano holds, archived or not. */
  held: Set<string>
}

export function scanFolder(input: ScanInput): ImportScan {
  const sessions: ImportableSession[] = input.archived.map((row) => ({
    harness: row.harness,
    source: 'archived',
    sessionId: row.id,
    nativeId: row.nativeId,
    title: cleanTitle(row.title) || 'Untitled session',
    updatedAt: row.updatedAt,
  }))
  const errors: ImportScan['errors'] = []
  const notes: string[] = []
  if (input.host) {
    notes.push(`Native harness sessions are only scanned on this machine, not on ${input.host}.`)
  } else {
    for (const [harness, scan] of SCANNERS) {
      try {
        const found = scan(input.cwd)
        if (found.length >= PER_HARNESS) notes.push(`Only the newest ${PER_HARNESS} sessions of each harness are listed.`)
        for (const item of found) {
          if (input.held.has(`${harness}:${item.nativeId}`)) continue
          sessions.push({ harness, source: 'native', ...item })
        }
      } catch (error) {
        errors.push({ harness, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  return { cwd: input.cwd, host: input.host, sessions, errors, notes: [...new Set(notes)] }
}
