#!/usr/bin/env bun
/**
 * A stand-in for `claude` that replays a captured run instead of inventing one.
 *
 * `replay-cmd.ts` next door does the same job for Command Code, and the shape is
 * the same for a reason: the driver under test gets the protocol exactly as it
 * really arrived. Claude, though, speaks through *two* channels at once, and a
 * replay is only truthful if it reproduces both:
 *
 *   - the `stream-json` lines on stdout, out of `<scenario>.jsonl`;
 *   - the on-disk transcript under the Claude config root, out of
 *     `<scenario>.transcript.jsonl` — which is where every tool call, every
 *     skill, every slash command and every subagent actually lives. A replay
 *     that only fed stdout would leave the driver's whole timeline empty and a
 *     test built on it would be asserting about a channel that carries almost
 *     nothing.
 *
 * It spends nothing and talks to nothing. Configured entirely by environment,
 * because the driver decides this process' argv and a replay may not change it:
 *
 *   SEDANO_REPLAY_TRACE       the stdout .jsonl to replay (required)
 *   SEDANO_REPLAY_TRANSCRIPT  the transcript .jsonl to lay down (optional)
 *   SEDANO_REPLAY_SUBAGENTS   a folder of `agent-*.jsonl` / `agent-*.meta.json`
 *                             sidecars to lay down beside it (optional) — a
 *                             sidechain's own transcript, which is the only
 *                             place a subagent's thinking and tool calls exist
 *   SEDANO_REPLAY_ARGV        a file to write this process' real argv into, as
 *                             JSON, so a test can assert the flags the driver
 *                             chose
 *
 * The session id is not ours to pick: the driver generates one and passes it as
 * `--session-id`, so the transcript is written under *that* id, at the path the
 * driver's own reader is already watching. `CLAUDE_CONFIG_DIR` and the working
 * directory are inherited from the spawn, which is how a test keeps every byte
 * of this inside a scratch directory and away from a real `~/.claude`.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const tracePath = process.env.SEDANO_REPLAY_TRACE
if (!tracePath) {
  process.stderr.write('replay-claude: SEDANO_REPLAY_TRACE is not set\n')
  process.exit(2)
}

const argv = process.argv.slice(2)
const argvOut = process.env.SEDANO_REPLAY_ARGV
if (argvOut) writeFileSync(argvOut, JSON.stringify(argv))

const flag = (name: string): string | null => {
  const index = argv.indexOf(name)
  return index >= 0 ? (argv[index + 1] ?? null) : null
}

/* -------------------------------------------------------------- */
/* The transcript, under the id the driver chose                   */
/* -------------------------------------------------------------- */

const transcriptSource = process.env.SEDANO_REPLAY_TRANSCRIPT
const subagentsSource = process.env.SEDANO_REPLAY_SUBAGENTS
const sessionId = flag('--session-id') ?? flag('--resume')
if ((transcriptSource || subagentsSource) && sessionId) {
  const root = process.env.CLAUDE_CONFIG_DIR
  if (!root) {
    // Refusing beats guessing: without an explicit root this would write into
    // the operator's real `~/.claude`, and a test fixture has no business there.
    process.stderr.write('replay-claude: CLAUDE_CONFIG_DIR is not set; refusing to write a transcript\n')
    process.exit(2)
  }
  const slug = process.cwd().replace(/[^a-zA-Z0-9]/g, '-')
  const projectDir = join(root, 'projects', slug)

  // The captured files name the session they were recorded under. The reader
  // keys nothing off that field, but leaving a second id in files the driver
  // found by its own id would be a fixture contradicting itself, so the recorded
  // id is rewritten to the one this run is using — and nothing else is touched.
  const recordedId = transcriptSource
    ? /"sessionId":"([0-9a-f-]+)"/.exec(readFileSync(transcriptSource, 'utf8'))?.[1]
    : undefined
  const retarget = (body: string) => (recordedId ? body.split(recordedId).join(sessionId) : body)

  if (transcriptSource) {
    const target = join(projectDir, `${sessionId}.jsonl`)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, retarget(readFileSync(transcriptSource, 'utf8')))
  }

  if (subagentsSource) {
    // `claudeSubagentsDir`: the sidecars live under the session's *own* folder,
    // beside the transcript rather than inside it.
    const target = join(projectDir, sessionId, 'subagents')
    mkdirSync(target, { recursive: true })
    for (const name of readdirSync(subagentsSource)) {
      writeFileSync(join(target, name), retarget(readFileSync(join(subagentsSource, name), 'utf8')))
    }
  }
}

/* -------------------------------------------------------------- */
/* stdout                                                          */
/* -------------------------------------------------------------- */

interface Frame {
  dir: 'agent' | 'client' | 'stderr'
  ms: number
  line: string
}

const frames: Frame[] = readFileSync(tracePath, 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as Frame)

// Only the frames the agent wrote. A `client` frame is what the capture wrote
// *to* the CLI — the driver writes its own — and replaying one onto stdout would
// be putting words in the CLI's mouth.
for (const frame of frames) {
  if (frame.dir === 'agent') process.stdout.write(`${frame.line}\n`)
  else if (frame.dir === 'stderr') process.stderr.write(`${frame.line}\n`)
}

// Stay alive. A real `claude --print --input-format stream-json` holds the
// session open for the next message and is closed by the client; exiting here
// would hand the driver an end-of-stream it never saw, and `watchExit` would
// publish an ending of its own on top of the recorded `result`.
setInterval(() => undefined, 1000)
