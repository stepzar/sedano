#!/usr/bin/env bun
/**
 * A stand-in for `cmd` that replays a captured trace instead of inventing one.
 *
 * `fake-cmd.ts` next door writes frames its author typed out; this writes the
 * bytes a real `cmd -p --output-format json` run actually produced, straight
 * out of `scripts/fixtures/traces/commandcode/<scenario>.jsonl`. That is the
 * whole point of the capture: the driver under test gets the protocol as it
 * really arrives — field order, whitespace, frames nobody knew existed — and
 * nothing here is a paraphrase of it.
 *
 * It spends nothing and talks to nothing. Configured entirely by environment,
 * because the driver decides this process' argv and a replay may not change it:
 *
 *   SEDANO_REPLAY_TRACE   the .jsonl to replay (required)
 *   SEDANO_REPLAY_ARGV    a file to write this process' real argv into, as JSON,
 *                         so a test can assert the flags the driver chose
 *   SEDANO_REPLAY_HANG    when set, stay alive after the last frame instead of
 *                         exiting — the truthful shape of a run that was killed
 *                         mid-turn, which is how the `cancel` trace was captured
 *
 * Only the frames the agent wrote are replayed. A `client` frame is what the
 * capture wrote *to* the CLI and a `stderr` frame goes to stderr, where it came
 * from; replaying either onto stdout would be putting words in the CLI's mouth.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const tracePath = process.env.SEDANO_REPLAY_TRACE
if (!tracePath) {
  process.stderr.write('replay-cmd: SEDANO_REPLAY_TRACE is not set\n')
  process.exit(2)
}

const argvOut = process.env.SEDANO_REPLAY_ARGV
if (argvOut) writeFileSync(argvOut, JSON.stringify(process.argv.slice(2)))

// The driver writes the prompt and closes stdin; a real `cmd -p` reads it before
// it works, so this does too. Nothing is done with it — the answer is already
// recorded — but leaving the pipe unread changes when the driver's write
// resolves, and a replay that does not drain stdin is a different experiment.
await Bun.stdin.text()

interface Frame {
  dir: 'agent' | 'client' | 'stderr'
  ms: number
  line: string
}

const frames: Frame[] = readFileSync(tracePath, 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as Frame)

for (const frame of frames) {
  // Verbatim, with the single newline the capture stripped when it split the
  // stream into lines. The driver's own parser is what has to cope with them.
  if (frame.dir === 'agent') process.stdout.write(`${frame.line}\n`)
  else if (frame.dir === 'stderr') process.stderr.write(`${frame.line}\n`)
}

if (process.env.SEDANO_REPLAY_HANG) {
  // The captured run never reached its own ending: it was killed. Exiting here
  // would hand the driver a clean end of stream, which is precisely the case
  // that trace does not describe.
  setInterval(() => undefined, 1000)
} else {
  process.exit(0)
}
