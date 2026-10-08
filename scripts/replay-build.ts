#!/usr/bin/env bun
/**
 * Turn a real Claude session into a sanitized replay for `check:replay`.
 *
 * "Every reported bug becomes a trace": when a session misbehaves, this reads
 * its transcript and subagent sidecars (read-only — it never opens the live
 * database and never writes under `~/.claude` or `~/.sedano`) and writes a
 * replay that keeps the *structure* — record types, tool names, ids, the order
 * and relative timing of everything, background agents and their
 * notifications, wake-ups — and replaces every piece of content: prompts,
 * replies, thinking, tool inputs and outputs, paths, branch names.
 *
 * The stream channel (stdout of the CLI) is not on disk after the fact, so the
 * frames the manager depends on are rebuilt from the transcript: an `assistant`
 * frame per main-loop message (which is what tells the driver the main loop is
 * working), a `system/task_started` per spawned agent at the spawn call (the
 * live frame that races the transcript line), and a `result` at the end of every
 * cycle. Everything else the stream carries only ever affected token counts.
 *
 *   bun scripts/replay-build.ts --transcript <session>.jsonl --name <name> \
 *       [--until <line>] [--crash-before <line>] [--note "what went wrong"]
 *
 * `--until` stops at a line (0-based) so the replay ends where the bug did;
 * `--crash-before` kills the CLI before the prompt on that line, as a restart
 * or a crash did, so the next prompt respawns it with `--resume`. The output
 * lands in `scripts/fixtures/replays/<name>.replay.json` with an `expect` block
 * to fill in with what *should* have happened.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const args = process.argv.slice(2)
const option = (name: string): string | undefined => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const transcriptPath = option('--transcript')
const name = option('--name')
if (!transcriptPath || !name) {
  console.error('usage: bun scripts/replay-build.ts --transcript <file.jsonl> --name <name> [--until N] [--crash-before N] [--note text]')
  process.exit(2)
}
const until = option('--until') !== undefined ? Number(option('--until')) : Number.POSITIVE_INFINITY
const from = option('--from') !== undefined ? Number(option('--from')) : 0
const crashBefore = option('--crash-before') !== undefined ? Number(option('--crash-before')) : undefined
/** Lines whose prompt is preceded by a restart of sedano itself (the CLI keeps running). */
const restartBefore = new Set((option('--restart-before') ?? '').split(',').filter(Boolean).map(Number))

/* ------------------------------------------------------------------ */
/* Sanitizing: keep structure, replace content                         */
/* ------------------------------------------------------------------ */

/** Values that are structure, not content: ids, kinds, flags, statuses. */
const KEEP = new Set([
  'type', 'subtype', 'role', 'id', 'uuid', 'parentUuid', 'logicalParentUuid', 'sessionId', 'isSidechain',
  'isMeta', 'name', 'tool_use_id', 'stop_reason', 'level', 'agentId', 'status', 'subagent_type',
  'run_in_background', 'is_error', 'backgroundTaskId', 'userType', 'version', 'entrypoint', 'toolUseId',
  'agentType', 'model', 'kind', 'trigger', 'resumedAgentId',
])
/** Record types the reader never looks at: dropped rather than carried as noise. */
const DROP = new Set(['attachment', 'queue-operation', 'atis-latch', 'last-prompt', 'mode', 'cost-state', 'file-history-snapshot'])

function scrub(value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    if (KEEP.has(key)) return value
    if (key === 'cwd') return '/tmp/sedano-capture'
    if (key === 'gitBranch') return 'main'
    if (key === 'timestamp') return value
    if (key === 'signature' || key === 'thinking') return ''
    return value ? `[${key || 'text'}]` : ''
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, key))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v, k)
    return out
  }
  return value
}

/** A task notification keeps its tags — ids, status, exit code — and nothing else. */
function scrubNotification(text: string): string {
  const all = (tag: string) => [...text.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]!.trim())
  const summary = all('summary')[0] ?? ''
  const exit = /exit code (-?\d+)/i.exec(summary)
  const kept = summary.startsWith('Background command')
    ? `Background command "[command]" completed${exit ? ` (exit code ${exit[1]})` : ''}`
    : '[summary]'
  return [
    '<task-notification>',
    ...all('task-id').map((id) => `<task-id>${id}</task-id>`),
    ...all('tool-use-id').map((id) => `<tool-use-id>${id}</tool-use-id>`),
    ...all('status').map((status) => `<status>${status}</status>`),
    `<summary>${kept}</summary>`,
    '</task-notification>',
  ].join('\n')
}

function textOf(rec: any): string {
  const content = rec?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((block: any) => (block?.type === 'text' ? block.text ?? '' : '')).join(' ')
  return ''
}

let promptCount = 0
function sanitize(rec: any): { rec: any; prompt?: string } {
  const text = textOf(rec)
  if (rec.type === 'user' && text.includes('<task-notification>')) {
    const clean = scrub(rec) as any
    clean.message = { ...clean.message, content: scrubNotification(text) }
    return { rec: clean }
  }
  const command = slashCommand(rec)
  if (command) {
    // The command name is structure (it decides what the CLI does); its
    // arguments are the user's and are replaced.
    const clean = scrub(rec) as any
    clean.message = { ...clean.message, content: `<command-name>${command}</command-name>\n<command-message>${command.replace(/^\//, '')}</command-message>\n<command-args></command-args>` }
    return { rec: clean, prompt: command }
  }
  if (rec.type === 'user' && textOf(rec).includes('<local-command-stdout>')) {
    const clean = scrub(rec) as any
    clean.message = { ...clean.message, content: '<local-command-stdout>[output]</local-command-stdout>' }
    return { rec: clean }
  }
  if (isPrompt(rec)) {
    promptCount += 1
    const prompt = `[prompt ${promptCount}]`
    const clean = scrub(rec) as any
    clean.message = { ...clean.message, content: [{ type: 'text', text: prompt }] }
    return { rec: clean, prompt }
  }
  const clean = scrub(rec) as any
  // A spawn call must keep a prompt: a card without one is never announced.
  for (const block of clean?.message?.content ?? []) {
    if (block?.type === 'tool_use' && block.input && typeof block.input === 'object') {
      if ('prompt' in block.input) block.input.prompt = '[agent prompt]'
    }
  }
  return { rec: clean }
}

/** A slash command the user typed, as the reader renders it (`/name args`). */
function slashCommand(rec: any): string | null {
  if (rec?.type !== 'user' || rec.isMeta) return null
  const name = /<command-name>([^<]*)<\/command-name>/.exec(textOf(rec))?.[1]?.trim()
  return name ? name : null
}

function isPrompt(rec: any): boolean {
  if (rec?.type !== 'user' || rec.isMeta || rec.isCompactSummary || rec.isVisibleInTranscriptOnly) return false
  if (slashCommand(rec)) return true
  const content = rec.message?.content
  const text = textOf(rec)
  if (!text.trim() || text.includes('<task-notification>') || text.includes('<command-') || text.includes('<local-command')) return false
  if (Array.isArray(content) && content.some((block: any) => block?.type === 'tool_result')) return false
  return true
}

/* ------------------------------------------------------------------ */
/* Cycles                                                              */
/* ------------------------------------------------------------------ */

interface Frame {
  ms: number
  stream?: unknown
  transcript?: Record<string, unknown>
  sidecar?: { agent: string; meta?: unknown }
}
interface Cycle {
  trigger: 'prompt' | 'follow'
  frames: Frame[]
  /** Kept for the script: the prompt text the test sends for a prompt cycle. */
  prompt?: string
  /** A crash precedes this cycle's prompt. */
  crashBefore?: boolean
  /** A restart of sedano precedes this cycle's prompt. */
  restartBefore?: boolean
}

const lines = readFileSync(transcriptPath, 'utf8').split('\n').filter((line) => line.trim())
const records = lines.map((line) => JSON.parse(line)).slice(0, Number.isFinite(until) ? until + 1 : undefined)
const recordedSessionId = records.find((rec) => typeof rec.sessionId === 'string')?.sessionId as string | undefined

// Sidecars name the spawn call each agent came from.
const sidecarDir = join(dirname(transcriptPath), basename(transcriptPath, '.jsonl'), 'subagents')
const agentByTool = new Map<string, { agentId: string; meta: unknown }>()
if (existsSync(sidecarDir)) {
  for (const file of readdirSync(sidecarDir)) {
    if (!file.endsWith('.meta.json')) continue
    const meta = JSON.parse(readFileSync(join(sidecarDir, file), 'utf8'))
    const agentId = file.slice('agent-'.length, -'.meta.json'.length)
    if (typeof meta.toolUseId === 'string') agentByTool.set(meta.toolUseId, { agentId, meta: scrub(meta) })
  }
}

// A `SendMessage` that resumed a stopped agent: the CLI starts a new run of it
// under that call, which is what the live `task_started` frame says.
const resumedByTool = new Map<string, string>()
for (const rec of records) {
  const resumed = rec?.toolUseResult?.resumedAgentId
  const toolId = (rec?.message?.content ?? []).find?.((block: any) => block?.type === 'tool_result')?.tool_use_id
  if (typeof resumed === 'string' && typeof toolId === 'string') resumedByTool.set(toolId, resumed)
}

/** Real gaps, compressed: order is what matters, and a replay must be quick. */
const GAP_CAP_MS = 120
const cycles: Cycle[] = []
let current: Cycle | null = null
let ended = true
let lastAt = 0
let resultCount = 0
/** Index of the current cycle's last end-of-turn frame. */
let lastEndIndex = Number.POSITIVE_INFINITY

const finish = (): void => {
  if (!current) return
  const last = current.frames.at(-1)?.ms ?? 0
  resultCount += 1
  current.frames.push({
    ms: last + 10,
    stream: {
      type: 'result',
      uuid: `replay-result-${resultCount}`,
      subtype: 'success',
      is_error: false,
      result: '[reply]',
      duration_ms: 10,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  })
  cycles.push(current)
  current = null
}

records.forEach((raw, line) => {
  if (line < from || DROP.has(raw.type)) return
  const at = Date.parse(raw.timestamp ?? '') || lastAt
  const notification = raw.type === 'user' && textOf(raw).includes('<task-notification>')
  const prompt = isPrompt(raw)
  if (prompt || (notification && ended)) {
    // A slash command's own records — the compaction boundary and summary a
    // `/compact` writes — land in the transcript just before the command line
    // itself. They are that command's work, not the previous cycle's tail.
    const carried = slashCommand(raw) && current ? current.frames.splice(lastEndIndex + 1) : []
    finish()
    current = {
      trigger: prompt ? 'prompt' : 'follow',
      frames: [],
      ...(prompt && crashBefore === line ? { crashBefore: true } : {}),
      ...(prompt && restartBefore.has(line) ? { restartBefore: true } : {}),
    }
    ended = false
    lastAt = at
    lastEndIndex = Number.POSITIVE_INFINITY
    if (carried.length) {
      const base = carried[0]!.ms
      current.frames.push(...carried.map((frame) => ({ ...frame, ms: frame.ms - base })))
    }
  }
  if (!current) return
  const cycleStart = current.frames.at(-1)?.ms ?? 0
  const ms = current.frames.length ? cycleStart + Math.min(GAP_CAP_MS, Math.max(0, at - lastAt)) : 0
  lastAt = at
  const { rec, prompt: promptText } = sanitize(raw)
  if (promptText) current.prompt = promptText
  current.frames.push({ ms, transcript: rec })
  if (rec.type === 'assistant' && !rec.isSidechain) {
    current.frames.push({
      ms,
      stream: {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { id: rec.message?.id, role: 'assistant', model: 'claude-replay', content: [], usage: { input_tokens: 1, output_tokens: 1 } },
      },
    })
    for (const block of rec.message?.content ?? []) {
      const resumed = block?.type === 'tool_use' && block.name === 'SendMessage' ? resumedByTool.get(block.id) : undefined
      if (resumed) {
        current.frames.push({
          ms,
          stream: {
            type: 'system',
            subtype: 'task_started',
            task_id: resumed,
            tool_use_id: block.id,
            task_type: 'local_agent',
            subagent_type: 'general-purpose',
            description: '[description]',
            prompt: '[agent prompt]',
            is_backgrounded: true,
          },
        })
        continue
      }
      if (block?.type !== 'tool_use' || block.name !== 'Agent') continue
      const agent = agentByTool.get(block.id)
      if (!agent) continue
      current.frames.push({ ms, sidecar: { agent: agent.agentId, meta: agent.meta } })
      current.frames.push({
        ms,
        stream: {
          type: 'system',
          subtype: 'task_started',
          task_id: agent.agentId,
          tool_use_id: block.id,
          task_type: 'local_agent',
          subagent_type: block.input?.subagent_type ?? 'general-purpose',
          description: '[description]',
          prompt: '[agent prompt]',
        },
      })
    }
    if (rec.message?.stop_reason === 'end_turn') {
      ended = true
      lastEndIndex = current.frames.length - 1
    }
  }
})
finish()

// What a replay starts with must be a prompt: a leading wake-up (a notice the
// resumed CLI printed before anything was sent) plays with the first prompt.
while (cycles.length > 1 && cycles[0]!.trigger === 'follow' && cycles[1]!.trigger === 'prompt') {
  const [lead, next] = [cycles[0]!, cycles[1]!]
  const shift = (lead.frames.at(-1)?.ms ?? 0) + 10
  // The lead's synthetic result is dropped: nothing was answered yet.
  const frames = lead.frames.filter((frame) => (frame.stream as { type?: string } | undefined)?.type !== 'result')
  cycles.splice(0, 2, { ...next, frames: [...frames, ...next.frames.map((frame) => ({ ...frame, ms: frame.ms + shift }))] })
}

/* ------------------------------------------------------------------ */
/* The script and the expectations to fill in                          */
/* ------------------------------------------------------------------ */

const script: unknown[] = []
for (const cycle of cycles) {
  if (cycle.trigger !== 'prompt') continue
  if (cycle.crashBefore) script.push({ do: 'crash' })
  if (cycle.restartBefore) script.push({ do: 'restart' })
  script.push({ do: 'checkpoint' }, { do: 'prompt', text: cycle.prompt }, { do: 'settle' })
}

const replay = {
  harness: 'claude',
  name,
  description: option('--note') ?? 'describe what went wrong',
  source: `built by scripts/replay-build.ts from a real session (${records.length} records, sanitized)`,
  recordedSessionId,
  cycles: cycles.map(({ prompt: _prompt, crashBefore: _crash, restartBefore: _restart, ...cycle }) => cycle),
  script,
  expect: {
    stableHistory: true,
    turns: cycles.filter((cycle) => cycle.trigger === 'prompt').map(() => ({ phase: 'completed', reply: true })),
  },
}

const out = join(import.meta.dir, 'fixtures', 'replays', `${name}.replay.json`)
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(replay, null, 1)}\n`)
console.log(`wrote ${out}: ${cycles.length} cycles (${cycles.filter((c) => c.trigger === 'prompt').length} prompts), ${script.length} steps`)
