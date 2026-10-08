#!/usr/bin/env bun
/**
 * A stand-in CLI that plays a recorded session back, cycle by cycle, with its
 * timing — for `scripts/replay-test.ts`.
 *
 * `replay-claude.ts` and `replay-cmd.ts` dump one capture at once, which is
 * right for checking a driver parses every frame. State bugs are different:
 * they live in *ordering* — a live launch frame read before the transcript line
 * that made the call, a background agent finishing after the result, the CLI
 * waking up by itself, a second process re-reading the first one's transcript.
 * So a replay here is a list of cycles, each a list of timed frames on the two
 * channels a harness really uses (stream on stdout, transcript + subagent
 * sidecars on disk), and it survives across processes: a respawned CLI carries
 * on from the cycle the last one stopped at.
 *
 *   SEDANO_REPLAY_DIR   holds `replay.json` (the cycles) and `cursor` (progress)
 *
 * argv[2] is the harness mode:
 *   claude       one long-lived process; each stdin `user` line plays the next
 *                `prompt` cycle and every `follow` cycle after it (a wake-up)
 *   commandcode  one process per turn; stdin is read to EOF, one prompt cycle
 *                (and its follows) is played, and the process exits
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface Frame {
  ms: number
  stream?: unknown
  transcript?: Record<string, unknown>
  sidecar?: { agent: string; meta?: unknown; line?: Record<string, unknown> }
}
interface Cycle {
  trigger: 'prompt' | 'follow'
  frames: Frame[]
}
interface Replay {
  recordedSessionId?: string
  cycles: Cycle[]
}

const mode = process.argv[2]
const argv = process.argv.slice(3)
const dir = process.env.SEDANO_REPLAY_DIR
if (!dir || (mode !== 'claude' && mode !== 'commandcode')) {
  process.stderr.write('replay-player: SEDANO_REPLAY_DIR and a mode (claude | commandcode) are required\n')
  process.exit(2)
}
const replay = JSON.parse(readFileSync(join(dir, 'replay.json'), 'utf8')) as Replay
const cursorFile = join(dir, 'cursor')
let cursor = existsSync(cursorFile) ? Number(readFileSync(cursorFile, 'utf8')) || 0 : 0

const flag = (name: string): string | null => {
  const index = argv.indexOf(name)
  return index >= 0 ? (argv[index + 1] ?? null) : null
}
const sessionId = flag('--session-id') ?? flag('--resume')
// The logical path the harness was started in; `cwd()` resolves macOS' /var
// symlink and would name a different transcript folder than the reader's.
const projectDir =
  mode === 'claude' && process.env.CLAUDE_CONFIG_DIR
    ? join(process.env.CLAUDE_CONFIG_DIR, 'projects', (process.env.PWD || process.cwd()).replace(/[^a-zA-Z0-9]/g, '-'))
    : null

/** The recorded conversation id becomes the one this run is using. */
function retarget<T>(value: T): T {
  if (!replay.recordedSessionId || !sessionId) return value
  return JSON.parse(JSON.stringify(value).split(replay.recordedSessionId).join(sessionId)) as T
}

function play(frame: Frame): void {
  if (frame.stream !== undefined) process.stdout.write(`${JSON.stringify(retarget(frame.stream))}\n`)
  if (frame.transcript && projectDir && sessionId) {
    mkdirSync(projectDir, { recursive: true })
    // Stamped as it is written, so the transcript's clock and the stream's agree.
    const record = { ...retarget(frame.transcript), timestamp: new Date().toISOString() }
    appendFileSync(join(projectDir, `${sessionId}.jsonl`), `${JSON.stringify(record)}\n`)
  }
  if (frame.sidecar && projectDir && sessionId) {
    const subagents = join(projectDir, sessionId, 'subagents')
    mkdirSync(subagents, { recursive: true })
    const base = join(subagents, `agent-${frame.sidecar.agent}`)
    if (frame.sidecar.meta !== undefined) {
      writeFileSync(`${base}.meta.json`, JSON.stringify(retarget(frame.sidecar.meta)))
      if (!existsSync(`${base}.jsonl`)) writeFileSync(`${base}.jsonl`, '')
    }
    if (frame.sidecar.line) {
      appendFileSync(`${base}.jsonl`, `${JSON.stringify({ ...retarget(frame.sidecar.line), timestamp: new Date().toISOString() })}\n`)
    }
  }
}

/** One prompt cycle and the follow cycles after it, with their timing. */
function playFromCursor(): void {
  for (let first = true; cursor < replay.cycles.length; first = false) {
    const cycle = replay.cycles[cursor]!
    if (!first && cycle.trigger !== 'follow') break
    const started = Date.now()
    for (const frame of cycle.frames) {
      const wait = started + frame.ms - Date.now()
      if (wait > 0) Bun.sleepSync(wait)
      play(frame)
    }
    cursor += 1
    writeFileSync(cursorFile, String(cursor))
  }
}

if (mode === 'commandcode') {
  // One process per turn, prompt on stdin to end of input (see `durableLaunch`).
  await Bun.stdin.text()
  playFromCursor()
  process.exit(0)
}

// claude: a blocking read loop, because the stdin a detached CLI inherits is a
// fifo held open read-write, and Bun delivers nothing from one until EOF.
let buffer = ''
let initialised = false
const chunk = Buffer.alloc(65536)
for (;;) {
  let read = 0
  try {
    read = readSync(0, chunk, 0, chunk.length, null)
  } catch {
    break
  }
  if (read === 0) break
  buffer += chunk.subarray(0, read).toString('utf8')
  let index = buffer.indexOf('\n')
  while (index !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    index = buffer.indexOf('\n')
    if (!line) continue
    let rec: { type?: string }
    try {
      rec = JSON.parse(line)
    } catch {
      continue
    }
    if (rec.type !== 'user') continue
    if (!initialised) {
      initialised = true
      process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-replay', session_id: sessionId })}\n`)
    }
    playFromCursor()
  }
}
process.exit(0)
