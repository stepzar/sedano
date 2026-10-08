#!/usr/bin/env bun
/**
 * The Claude transcript reader, against transcripts written by hand.
 *
 * `claude-test.ts` drives the *stream* (the control protocol on stdout). This
 * drives the other half: the `.jsonl` files Claude Code writes, which are the
 * only place a subagent's own thinking, tools and results ever appear. The
 * reader tails them byte by byte while they are still being written, and every
 * bug that half has had came from that: a card attributed to the wrong agent, a
 * nested agent rendered as if the main loop had done its work, a huge tool
 * result pasted whole into the UI, and a line split in the middle of a character
 * turning into mojibake or into a line that was dropped altogether.
 *
 * Nothing here spawns anything. The files are written by this test, the reader
 * reads them over the local transport, and the fixtures live in a temporary
 * directory that goes at the end.
 *
 *   bun scripts/transcript-test.ts
 */
// First import, before anything can reach for the real store (see isolate.ts).
import './lib/isolate.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TimelineEvent, TokenUsage } from '@shared'
import { installExitHandlers, onCleanup, runCleanups } from './lib/harness.ts'

installExitHandlers()

const failures: string[] = []
const passed: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) passed.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const root = mkdtempSync(join(tmpdir(), 'sedano-transcript-'))
onCleanup(() => rmSync(root, { recursive: true, force: true }))
// The reader is told its root explicitly, but the module also reads the
// environment when it is imported, and a test must never tail a real session.
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude')

const { ClaudeTranscriptReader } = await import('../apps/server/src/harnesses/claude/transcripts.ts')
const { claudeProjectDir, claudeSubagentsDir, claudeTranscriptPath } = await import('../apps/server/src/paths.ts')
const { Transport } = await import('../apps/server/src/transport.ts')

/* ------------------------------------------------------------------ */
/* A session on disk                                                   */
/* ------------------------------------------------------------------ */

const cwd = join(root, 'workspace')
const sessionId = 'transcript-fixture-session'
const configRoot = join(root, 'claude')
mkdirSync(cwd, { recursive: true })
const transcript = claudeTranscriptPath(cwd, sessionId, configRoot)
const subagents = claudeSubagentsDir(cwd, sessionId, configRoot)
mkdirSync(claudeProjectDir(cwd, configRoot), { recursive: true })
mkdirSync(subagents, { recursive: true })

/** What the reader told us, in the order it said it. */
interface Told {
  ev: TimelineEvent
  id: string
  agentId?: string
  parentEventId?: string
  parentAgentId?: string
}
const told: Told[] = []
const usages: TokenUsage[] = []
let title = ''

const reader = new ClaudeTranscriptReader(
  new Transport(null),
  cwd,
  sessionId,
  {
    event: (ev, id, _at, agentId, causal) => told.push({ ev, id, agentId, ...causal }),
    usage: (usage) => usages.push(usage),
    title: (value) => (title = value),
  },
  configRoot,
)
onCleanup(() => reader.stop())

let uuid = 0
const nextUuid = (): string => `uuid-${++uuid}`

/** Append one record, as the harness does: one JSON object per line. */
function write(path: string, record: Record<string, unknown>): void {
  appendFileSync(path, `${JSON.stringify({ uuid: nextUuid(), timestamp: new Date().toISOString(), ...record })}\n`)
}

const assistantText = (text: string): Record<string, unknown> => ({
  type: 'assistant',
  message: { model: 'claude-fixture', content: [{ type: 'text', text }] },
})
const toolUse = (id: string, name: string, input: Record<string, unknown>): Record<string, unknown> => ({
  type: 'assistant',
  message: { model: 'claude-fixture', content: [{ type: 'tool_use', id, name, input }] },
})

function waitFor(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (predicate()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`))
      setTimeout(tick, 40)
    }
    tick()
  })
}

const eventsOf = (agentId: string | undefined): Told[] => told.filter((entry) => entry.agentId === agentId)
const kinds = (list: Told[]): string[] => list.map((entry) => entry.ev.k)

/* ------------------------------------------------------------------ */
/* The session starts                                                  */
/* ------------------------------------------------------------------ */

writeFileSync(transcript, '')
write(transcript, { type: 'user', gitBranch: 'feature/fixture', permissionMode: 'default', message: { content: [{ type: 'text', text: 'Audit the auth code.' }] } })
reader.start()
await waitFor(() => told.some((entry) => entry.ev.k === 'user'), 'the first prompt to be read')
check('a prompt in the transcript becomes a user event', kinds(eventsOf(undefined)).includes('user'))

/* ------------------------------------------------------------------ */
/* Two subagents at the same time                                      */
/* ------------------------------------------------------------------ */

/**
 * Concurrency is the ordinary case for this harness — one `Task` call can launch
 * several agents, and their sidecar files are written *at the same time*. The
 * reader tails one file per agent and stamps every line with the agent it came
 * from; getting that wrong puts one agent's tool calls inside another's card,
 * which is indistinguishable from the agent having done them.
 */
const agents = ['alpha', 'beta']
for (const [index, agent] of agents.entries()) {
  write(transcript, toolUse(`tool-task-${agent}`, 'Task', { subagent_type: 'general-purpose', description: `audit ${agent}`, prompt: `look at ${agent}` }))
  writeFileSync(
    join(subagents, `agent-${agent}.meta.json`),
    JSON.stringify({ agentType: 'general-purpose', description: `audit ${agent}`, toolUseId: `tool-task-${agent}`, spawnDepth: 1 }),
  )
  writeFileSync(join(subagents, `agent-${agent}.jsonl`), '')
  void index
}

await waitFor(
  () => told.filter((entry) => entry.ev.k === 'subagent_start').length >= 2,
  'both subagents to be announced',
)

// Interleaved on purpose: line by line, alternating files, the way two agents
// working at once actually write.
for (let round = 0; round < 3; round++) {
  for (const agent of agents) {
    const file = join(subagents, `agent-${agent}.jsonl`)
    write(file, toolUse(`tool-${agent}-${round}`, 'Grep', { pattern: `${agent}-${round}` }))
    write(file, assistantText(`${agent} says ${round}`))
  }
}

await waitFor(
  () => agents.every((agent) => eventsOf(agent).filter((entry) => entry.ev.k === 'assistant').length === 3),
  'both subagents to be read to the end',
)

for (const agent of agents) {
  const mine = eventsOf(agent)
  const texts = mine.filter((entry) => entry.ev.k === 'assistant').map((entry) => ('text' in entry.ev ? entry.ev.text : ''))
  check(`${agent}: every line it wrote is attributed to it`, texts.every((text) => text.startsWith(agent)), texts)
  check(
    `${agent}: nothing the other agent wrote landed here`,
    !texts.some((text) => text.startsWith(agent === 'alpha' ? 'beta' : 'alpha')),
    texts,
  )
  const patterns = mine
    .filter((entry) => entry.ev.k === 'tool')
    .map((entry) => ('input' in entry.ev ? String((entry.ev.input as { pattern?: string }).pattern) : ''))
  check(`${agent}: its tool calls are its own`, patterns.every((pattern) => pattern.startsWith(agent)), patterns)
}
// Announced twice on purpose — once from the parent's `Task` call, once from
// the meta file, whichever lands first — and both carry the same event id, so
// the store keeps one row. What matters is that there are two *agents*.
const announcedIds = new Set(
  told.filter((entry) => entry.ev.k === 'subagent_start').map((entry) => entry.id),
)
check('the concurrent agents were announced separately', announcedIds.size === 2, [...announcedIds])
check(
  'nothing a subagent wrote was mistaken for the main loop',
  !eventsOf(undefined).some((entry) => entry.ev.k === 'assistant' && 'text' in entry.ev && /^(alpha|beta) says/.test(entry.ev.text)),
  kinds(eventsOf(undefined)),
)

/* ------------------------------------------------------------------ */
/* A subagent that spawns a subagent                                   */
/* ------------------------------------------------------------------ */

/**
 * The nested case: `alpha` delegates to `gamma`. The spawn is a `Task` call
 * inside alpha's *own* sidechain, and gamma's meta says how deep it is. What
 * matters is that gamma's work is gamma's — a nested agent flattened into its
 * parent is the same lost boundary as a subagent flattened into the main loop.
 */
write(join(subagents, 'agent-alpha.jsonl'), toolUse('tool-task-gamma', 'Task', { subagent_type: 'explorer', description: 'dig deeper', prompt: 'nested work' }))
writeFileSync(
  join(subagents, 'agent-gamma.meta.json'),
  JSON.stringify({ agentType: 'explorer', description: 'dig deeper', toolUseId: 'tool-task-gamma', spawnDepth: 2 }),
)
writeFileSync(join(subagents, 'agent-gamma.jsonl'), '')
write(join(subagents, 'agent-gamma.jsonl'), assistantText('gamma went one level down'))

await waitFor(
  () =>
    eventsOf('gamma').some((entry) => entry.ev.k === 'assistant') &&
    told.some(
      (entry) =>
        entry.ev.k === 'subagent_start' &&
        entry.ev.agentId === 'gamma' &&
        entry.parentAgentId === 'alpha',
    ),
  'the nested agent and its parent relationship to be read',
)
const nestedStart = told.find(
  (entry) =>
    entry.ev.k === 'subagent_start' &&
    entry.ev.agentId === 'gamma' &&
    entry.parentAgentId === 'alpha',
)
check('a nested subagent is announced', Boolean(nestedStart), kinds(told))
check(
  'and it is announced at the depth it was spawned',
  nestedStart !== undefined && 'depth' in nestedStart.ev && nestedStart.ev.depth === 2,
  nestedStart?.ev,
)
check(
  'gamma keeps alpha as the agent that spawned it',
  nestedStart?.parentAgentId === 'alpha',
  nestedStart,
)
check(
  "gamma's spawn points at alpha's Task event",
  nestedStart?.parentEventId === 'tool:tool-task-gamma',
  nestedStart,
)
check(
  "the nested agent's work belongs to it, not to its parent",
  eventsOf('gamma').some((entry) => entry.ev.k === 'assistant' && 'text' in entry.ev && entry.ev.text.startsWith('gamma')) &&
    !eventsOf('alpha').some((entry) => entry.ev.k === 'assistant' && 'text' in entry.ev && entry.ev.text.startsWith('gamma')),
  { gamma: kinds(eventsOf('gamma')), alpha: kinds(eventsOf('alpha')) },
)

/* ------------------------------------------------------------------ */
/* A tool result too big to show                                       */
/* ------------------------------------------------------------------ */

/**
 * A `Read` of a large file comes back whole. The UI has to be told that what it
 * received is a beginning and not the file, or a person reads a truncated result
 * as the complete answer — and the untruncated version is megabytes through a
 * websocket for nothing.
 */
const huge = 'x'.repeat(20_000)
write(transcript, toolUse('tool-read-huge', 'Read', { file_path: '/tmp/huge.txt' }))
write(transcript, {
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: 'tool-read-huge', content: huge }] },
})
await waitFor(
  () => told.some((entry) => entry.ev.k === 'tool_result' && 'toolId' in entry.ev && entry.ev.toolId === 'tool-read-huge'),
  'the large tool result to be read',
)
const big = told.find((entry) => entry.ev.k === 'tool_result' && 'toolId' in entry.ev && entry.ev.toolId === 'tool-read-huge')!
check('a huge tool result is cut down', 'text' in big.ev && big.ev.text.length < huge.length, 'text' in big.ev ? big.ev.text.length : null)
check('and it says it was cut', 'truncated' in big.ev && big.ev.truncated === true, big.ev)

const small = 'a readable answer'
write(transcript, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-small', content: small }] } })
await waitFor(
  () => told.some((entry) => entry.ev.k === 'tool_result' && 'toolId' in entry.ev && entry.ev.toolId === 'tool-small'),
  'the small tool result to be read',
)
const ordinary = told.find((entry) => entry.ev.k === 'tool_result' && 'toolId' in entry.ev && entry.ev.toolId === 'tool-small')!
check('an ordinary result is not claimed to be truncated', 'truncated' in ordinary.ev && ordinary.ev.truncated === false, ordinary.ev)

/* ------------------------------------------------------------------ */
/* A line cut in the middle of a character                             */
/* ------------------------------------------------------------------ */

/**
 * The tailer reads by byte offset, so a poll lands wherever the writer happens
 * to be — including between the two halves of a multi-byte character. Decoding
 * each read on its own turns "è" into "Ã¨" or into a replacement character, and
 * a line split before its newline is a whole record dropped. The write below is
 * deliberately cut inside a 4-byte emoji, with the poll interval let through in
 * between so the reader really does see the half.
 */
const message = 'caffè ☕️ 🍰 finito'
const record = `${JSON.stringify({ uuid: nextUuid(), timestamp: new Date().toISOString(), ...assistantText(message) })}\n`
const bytes = Buffer.from(record, 'utf8')
// A cut inside the emoji: find its first byte and stop one byte into it.
const emojiAt = bytes.indexOf(Buffer.from('🍰', 'utf8'))
check('the fixture really does contain a multi-byte character', emojiAt > 0, emojiAt)
appendFileSync(transcript, bytes.subarray(0, emojiAt + 1))
// Longer than the 120 ms poll: the reader must see the incomplete character.
await Bun.sleep(400)
check(
  'a record whose line has not ended yet is not committed half-read',
  !told.some((entry) => entry.ev.k === 'assistant' && 'text' in entry.ev && entry.ev.text.includes('caffè')),
  told.filter((entry) => entry.ev.k === 'assistant').map((entry) => ('text' in entry.ev ? entry.ev.text : '')),
)
appendFileSync(transcript, bytes.subarray(emojiAt + 1))
await waitFor(
  () => told.some((entry) => entry.ev.k === 'assistant' && 'text' in entry.ev && entry.ev.text.includes('caffè')),
  'the stitched line to be read',
)
const stitched = told.find((entry) => entry.ev.k === 'assistant' && 'text' in entry.ev && entry.ev.text.includes('caffè'))!
check(
  'a character split across two reads arrives whole',
  'text' in stitched.ev && stitched.ev.text === message,
  'text' in stitched.ev ? stitched.ev.text : null,
)

/* ------------------------------------------------------------------ */
/* The facts a transcript carries beside its events                    */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Display details: what the redesign reads beside the text            */
/* ------------------------------------------------------------------ */

// A subagent edit: its sidechain has no toolUseResult, so the change comes
// from the call's own arguments.
const editor = join(subagents, 'agent-editor.jsonl')
writeFileSync(editor, '')
write(editor, toolUse('tool-edit-editor', 'Edit', { file_path: '/src/a.ts', old_string: 'one\ntwo', new_string: 'uno\ndue\ntre' }))
write(editor, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-edit-editor', content: 'The file /src/a.ts has been updated.' }] } })
await waitFor(() => told.some((entry) => entry.ev.k === 'file_change' && entry.ev.toolId === 'tool-edit-editor'), 'a subagent file change')
const agentChange = told.find((entry) => entry.ev.k === 'file_change' && entry.ev.toolId === 'tool-edit-editor')!
check(
  'a subagent Edit becomes a file_change counted from its input',
  agentChange.ev.k === 'file_change' && agentChange.ev.added === 3 && agentChange.ev.removed === 2 && agentChange.ev.source === 'input',
  agentChange.ev,
)
check('and it is attributed to the subagent', agentChange.agentId === 'editor', agentChange.agentId)

// Hidden reasoning: one marker per message, however many records it is written as.
for (let index = 0; index < 2; index += 1) {
  write(transcript, {
    type: 'assistant',
    message: { id: 'msg-hidden', model: 'claude-fixture', content: [{ type: 'thinking', thinking: '', signature: 'sig' }] },
  })
}
write(transcript, { type: 'assistant', message: { id: 'msg-redacted', model: 'claude-fixture', content: [{ type: 'redacted_thinking', data: 'x' }] } })
await waitFor(() => told.some((entry) => entry.id === 'thinking:hidden:msg-redacted'), 'the redacted marker')
const hidden = told.filter((entry) => entry.ev.k === 'thinking' && entry.ev.hidden)
check('withheld and redacted thinking become hidden markers', new Set(hidden.map((entry) => entry.id)).size === 2, hidden.map((entry) => entry.id))

// System records keep their details.
write(transcript, { type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 180000, postTokens: 9000 } })
write(transcript, { type: 'system', subtype: 'api_error', error: { status: 529, message: 'Overloaded' } })
write(transcript, { type: 'system', subtype: 'api_error', error: { status: 529, message: 'Overloaded' }, retryAttempt: 1, maxRetries: 10, retryInMs: 600 })
await waitFor(() => told.some((entry) => entry.ev.k === 'system' && entry.ev.subtype === 'api_error'), 'the api error')
await Bun.sleep(300)
const compact = told.find((entry) => entry.ev.k === 'system' && entry.ev.subtype === 'compact_boundary')
check(
  'a compaction says how much it compacted',
  compact?.ev.k === 'system' && compact.ev.detail?.preTokens === 180000 && compact.ev.detail?.postTokens === 9000 && /180,000 → 9,000/.test(compact.ev.text),
  compact?.ev,
)
const apiErrors = told.filter((entry) => entry.ev.k === 'system' && entry.ev.subtype === 'api_error')
check('a final API error keeps its status and message', apiErrors.length === 1 && apiErrors[0]!.ev.k === 'system' && apiErrors[0]!.ev.detail?.status === 529 && /529: Overloaded/.test(apiErrors[0]!.ev.text), apiErrors.map((entry) => entry.ev))

// A Bash call: failure exit code, duration, and its background completion.
write(transcript, toolUse('tool-bash-fail', 'Bash', { command: 'false' }))
write(transcript, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-bash-fail', is_error: true, content: 'Exit code 2\nboom' }] }, toolUseResult: { stdout: '', stderr: 'boom', interrupted: false } })
write(transcript, toolUse('tool-bash-bg', 'Bash', { command: 'sleep 9', run_in_background: true }))
write(transcript, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-bash-bg', content: 'Command running in background with ID: bfixture1.' }] }, toolUseResult: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'bfixture1' } })
write(transcript, { type: 'user', message: { content: '<task-notification>\n<task-id>bfixture1</task-id>\n<tool-use-id>tool-bash-bg</tool-use-id>\n<status>completed</status>\n<summary>Background command "sleep" completed (exit code 3)</summary>\n</task-notification>' } })
await waitFor(() => told.some((entry) => entry.ev.k === 'subagent_end' && entry.ev.toolId === 'tool-bash-bg'), 'the background completion')
const failed = told.find((entry) => entry.ev.k === 'tool_result' && entry.ev.toolId === 'tool-bash-fail')
check('a failed Bash result carries its exit code and a duration', failed?.ev.k === 'tool_result' && failed.ev.exitCode === 2 && typeof failed.ev.durationMs === 'number', failed?.ev)
const launched = told.find((entry) => entry.ev.k === 'tool_result' && entry.ev.toolId === 'tool-bash-bg')
check('a backgrounded Bash result names its task', launched?.ev.k === 'tool_result' && launched.ev.backgroundTaskId === 'bfixture1', launched?.ev)
const bgEnd = told.find((entry) => entry.ev.k === 'subagent_end' && entry.ev.toolId === 'tool-bash-bg')!
check(
  'a background shell ending is tagged as one, on its Bash call, with its exit code',
  bgEnd.ev.k === 'subagent_end' && bgEnd.ev.background === 'bash' && bgEnd.ev.exitCode === 3 && bgEnd.ev.status === 'error' && bgEnd.agentId === undefined,
  { ev: bgEnd.ev, agentId: bgEnd.agentId },
)

// A spawn card carries the spawn call's own time.
const spawned = told.filter((entry) => entry.ev.k === 'subagent_start')
check('a subagent card carries when it was spawned', spawned.length > 0 && spawned.every((entry) => entry.ev.k === 'subagent_start' && typeof entry.ev.spawnedAt === 'number'), spawned.map((entry) => entry.ev))

write(transcript, { type: 'summary', summary: 'Audit of the auth code' })
await waitFor(() => title !== '', 'the summary to become a title')
check('a summary in the transcript names the session', title === 'Audit of the auth code', title)

reader.stop()
await runCleanups()

if (failures.length) {
  console.log('--- failed checks ---')
  for (const failure of failures) console.log(`✗ ${failure}`)
  console.log(`\ntranscript-test: ${failures.length} FAILURES (${passed.length} passed)`)
  process.exit(1)
}
console.log(`transcript-test: PASSED (${passed.length} checks)`)
process.exit(0)
