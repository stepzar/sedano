#!/usr/bin/env bun
/**
 * Proof that the failure-rendering assertions can fail.
 *
 * A green suite says nothing on its own: a check that asserts something already
 * true of an empty page is green forever. So each mutation below breaks exactly
 * one thing the new checks claim to cover, runs the gate that covers it, and
 * demands it go red. Afterwards the file is restored and its SHA-256 compared
 * with the one taken before the edit, so the harness cannot leave the tree in a
 * state it merely believes is clean.
 *
 *   bun scripts/error-mutations.ts            # every mutation
 *   bun scripts/error-mutations.ts fast       # only the ones the unit gate covers
 *   bun scripts/error-mutations.ts <id> ...   # named mutations
 *
 * Nothing here spawns a vendor CLI or opens a connection: the gates it runs are
 * the hermetic ones.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')

type Gate = 'unit' | 'ui'

interface Mutation {
  id: string
  /** The assertion this is meant to take down, in the words the gate uses. */
  covers: string
  file: string
  find: string
  replace: string
  gate: Gate
}

const TYPES = 'apps/server/src/harnesses/types.ts'
const DRIVER = 'apps/server/src/harnesses/acp/driver.ts'
const TRANSCRIPT = 'apps/ui/src/components/Transcript.tsx'
const STYLES = 'apps/ui/src/styles.css'

const MUTATIONS: Mutation[] = [
  /* ---- the classifier ---- */
  {
    id: 'no-node-frames',
    covers: 'a Node trace is attributed to the wrapper',
    file: TYPES,
    find: 'const NODE_INTERNAL_FRAME = /^\\s+at .*\\(?node:internal\\//m',
    replace: 'const NODE_INTERNAL_FRAME = /^\\s+at .*\\(?never-matches-this\\//m',
    gate: 'unit',
  },
  {
    id: 'no-broken-pipe',
    covers: 'a broken pipe is named as a broken pipe',
    file: TYPES,
    find: 'const BROKEN_PIPE = /\\bEPIPE\\b',
    replace: 'const BROKEN_PIPE = /\\bNOT_EPIPE\\b',
    gate: 'unit',
  },
  {
    id: 'drop-detail',
    covers: 'the raw report survives into the detail',
    file: TYPES,
    find: '  if (failure.headline.includes(failure.detail)) return failure.headline\n  return `${failure.headline}${FAILURE_SEPARATOR}${failure.detail}`',
    replace: '  return failure.headline',
    gate: 'unit',
  },
  {
    id: 'summary-takes-chatter',
    covers: 'the headline quotes the exception, not the notice above it',
    file: TYPES,
    find: "    if (!trimmed || trimmed.startsWith('at ') || isStderrChatter(trimmed)) continue",
    replace: "    if (!trimmed || trimmed.startsWith('at ')) continue",
    gate: 'unit',
  },
  {
    id: 'nothing-is-chatter',
    covers: 'chatter is recognised as chatter',
    file: TYPES,
    find: '  return CHATTER.some((pattern) => pattern.test(trimmed))',
    replace: '  return false',
    gate: 'unit',
  },
  {
    id: 'everything-is-chatter',
    covers: 'a real failure line is never chatter',
    file: TYPES,
    find: '  return CHATTER.some((pattern) => pattern.test(trimmed))',
    replace: '  return true',
    gate: 'unit',
  },
  {
    id: 'no-ssh-kinds',
    covers: 'an ssh failure is recognised as a transport failure',
    file: TYPES,
    find: "  if (record.name !== 'RemoteError') return null",
    replace: "  if (record.name !== 'NeverThisName') return null",
    gate: 'unit',
  },
  {
    id: 'ssh-blames-the-agent',
    covers: 'an unreachable host is never described as the agent failing',
    file: TYPES,
    find: 'return `Could not reach ${host} over SSH, so ${harness} never started there.',
    replace: 'return `${harness} crashed. Could not reach ${host} over SSH.',
    gate: 'unit',
  },
  {
    id: 'ssh-quotes-the-command',
    covers: 'the command it suggests is a command that runs',
    file: TYPES,
    find: '${alias ? ` \\`ssh ${alias}\\`` : \' the connection\'}',
    replace: '${alias ? ` \\`ssh “${alias}”\\`` : \' the connection\'}',
    gate: 'unit',
  },
  {
    id: 'no-missing-cli',
    covers: 'a missing CLI is recognised',
    file: TYPES,
    find: 'const NOT_INSTALLED = /\\bENOENT\\b',
    replace: 'const NOT_INSTALLED = /\\bNEVER_ENOENT\\b',
    gate: 'unit',
  },
  {
    id: 'no-signed-out',
    covers: 'a signed-out CLI is recognised',
    file: TYPES,
    find: '  /authentication required|not (?:logged|signed) in',
    replace: '  /never-authentication-required|never-not (?:logged|signed) in',
    gate: 'unit',
  },
  {
    id: 'no-quota',
    covers: 'a spent quota is recognised',
    file: TYPES,
    find: 'const QUOTA = /\\b429\\b|rate.?limit|usage limit|quota|too many requests|overloaded|insufficient (?:credit|quota)/i',
    replace: 'const QUOTA = /\\bnever-a-quota-problem\\b/i',
    gate: 'unit',
  },
  {
    id: 'quota-invents-a-reset',
    covers: 'it invents no reset time',
    file: TYPES,
    find: 'wait for the limit to come back',
    replace: 'wait 60 minutes for the limit to come back',
    gate: 'unit',
  },
  {
    id: 'unknown-pretends-to-know',
    covers: 'an unrecognised failure says so rather than guessing',
    file: TYPES,
    find: 'headline: `${harness} reported a failure that sedano does not recognise, so it is passed on exactly as it arrived. The full report is below.`,\n    detail: text,\n    origin: ctx.origin ?? \'unknown\',\n    shape: \'unknown\',',
    replace: "headline: `${harness} hit a temporary network problem. Try again.`,\n    detail: text,\n    origin: ctx.origin ?? 'agent',\n    shape: 'quota',",
    gate: 'unit',
  },
  {
    id: 'error-stack-again',
    covers: 'our own refusals are not dressed up as crashes',
    file: TYPES,
    find: '    return value.message.trim()',
    replace: '    return (value.stack ?? value.message).trim()',
    gate: 'unit',
  },

  /* ---- the driver ---- */
  {
    id: 'stderr-unwired',
    covers: 'a wrapper crash on stderr is reported exactly once',
    file: DRIVER,
    find: '      onStderr: (text) => this.onStderr(text),\n',
    replace: '',
    gate: 'unit',
  },
  {
    /*
     * What decides that a line on stderr is worth a card.
     *
     * Note which edit this is: filtering chatter out of the detection buffer is
     * a second layer and, on its own, does not change the outcome — removing it
     * leaves the gate green, because the notices still do not look like a stack
     * trace. `isCrashReport` is the load-bearing one, so that is what is broken
     * here. (A mutation that stayed green told us that, and it is worth saying
     * out loud rather than replacing with one that happens to work.)
     */
    id: 'crash-detector-too-eager',
    covers: 'three lines of stderr chatter produce no error at all',
    file: TYPES,
    find: '  if (NODE_INTERNAL_FRAME.test(text)) return true\n  if (EXPLICIT_CRASH.test(text) && STACK_FRAME.test(text)) return true\n  return ERROR_HEADER.test(text) && STACK_FRAME.test(text)',
    replace: '  return true',
    gate: 'unit',
  },
  {
    id: 'detail-loses-chatter',
    covers: 'the chatter printed before the crash is kept with it',
    file: DRIVER,
    find: "    this.hooks.error(formatFailure(this.stderrRaw.join('\\n').trim(), this.failureContext))",
    replace: '    this.hooks.error(formatFailure(report, this.failureContext))',
    gate: 'unit',
  },
  {
    id: 'exit-is-silent',
    covers: 'an agent that dies while idle is reported as a failure',
    file: DRIVER,
    find: '        if (this.crashReported || code === 0 || code === null) return',
    replace: '        return',
    gate: 'unit',
  },
  {
    id: 'crash-reported-twice',
    covers: 'a wrapper crash on stderr is reported exactly once',
    file: DRIVER,
    find: '    this.crashReported = true\n    this.crashBuffer = \'\'',
    replace: "    this.crashBuffer = ''",
    gate: 'unit',
  },

  /* ---- the card ---- */
  {
    id: 'no-headline-split',
    covers: 'each shape leads with one paragraph of prose',
    file: TRANSCRIPT,
    find: "  const split = text.indexOf('\\n\\n')",
    replace: '  const split = -1',
    gate: 'ui',
  },
  {
    id: 'detail-always-open',
    covers: 'each shape starts with the detail closed',
    file: TRANSCRIPT,
    find: '  const [open, setOpen] = useState(false)\n  const text = ev.text ?? \'\'',
    replace: "  const [open, setOpen] = useState(true)\n  const text = ev.text ?? ''",
    gate: 'ui',
  },
  {
    id: 'no-copy',
    covers: 'each shape can be copied in one click',
    file: TRANSCRIPT,
    find: '        <CopyButton text={text} label="Copy This Report" />\n',
    replace: '',
    gate: 'ui',
  },
  {
    id: 'no-disclosure',
    covers: 'each shape offers the detail behind a disclosure',
    file: TRANSCRIPT,
    find: '      {detail ? (',
    replace: '      {false ? (',
    gate: 'ui',
  },
  {
    id: 'failure-back-in-the-fold',
    covers: 'the failure stays on screen when the turn is collapsed',
    file: TRANSCRIPT,
    find: '  const activity = work.activity.filter((row) => !failures.includes(row as SessionEvent))',
    replace: '  const activity = work.activity',
    gate: 'ui',
  },
  {
    id: 'headline-unreadable',
    covers: 'the headline is legible in both themes',
    file: STYLES,
    find: '.error-headline {\n  flex: 1;',
    replace: '.error-headline {\n  color: var(--err-soft);\n  flex: 1;',
    gate: 'ui',
  },
]

/* ------------------------------------------------------------------ */

const argv = process.argv.slice(2)
const wanted =
  argv.length === 0
    ? MUTATIONS
    : argv[0] === 'fast'
      ? MUTATIONS.filter((m) => m.gate === 'unit')
      : MUTATIONS.filter((m) => argv.includes(m.id))

if (!wanted.length) {
  console.error(`no mutation matched ${argv.join(' ')}`)
  process.exit(2)
}

function sha(path: string): string {
  return createHash('sha256').update(readFileSync(join(ROOT, path))).digest('hex')
}

async function runGate(gate: Gate): Promise<boolean> {
  const command = gate === 'unit' ? ['bun', 'scripts/error-test.ts'] : ['bun', 'scripts/ui-check.ts']
  const proc = Bun.spawn(command, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
  const [, , code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return code === 0
}

/** The baseline must be green, or "it went red" proves nothing. */
const gates = [...new Set(wanted.map((m) => m.gate))]
for (const gate of gates) {
  const green = await runGate(gate)
  console.log(`baseline ${gate}: ${green ? 'GREEN' : 'RED'}`)
  if (!green) {
    console.log('the baseline must be green before any mutation means anything')
    process.exit(1)
  }
}

let bad = 0
for (const mutation of wanted) {
  const path = join(ROOT, mutation.file)
  const before = readFileSync(path, 'utf8')
  const digest = sha(mutation.file)
  if (!before.includes(mutation.find)) {
    console.log(`SKIP ${mutation.id} — the code it patches has moved (${mutation.file})`)
    bad += 1
    continue
  }
  writeFileSync(path, before.replace(mutation.find, mutation.replace))
  let red = false
  try {
    red = !(await runGate(mutation.gate))
  } finally {
    writeFileSync(path, before)
  }
  const restored = sha(mutation.file) === digest
  if (!red) bad += 1
  if (!restored) bad += 1
  console.log(
    `${red ? 'RED ' : 'GREEN'}  ${restored ? 'restored' : 'DIRTY   '}  ${mutation.id.padEnd(26)} ${mutation.covers}`,
  )
}

console.log(
  bad === 0
    ? `every assertion is falsifiable: ${wanted.length}/${wanted.length}`
    : `${bad} problem(s): a mutation that stayed green is an assertion that proves nothing`,
)
process.exit(bad === 0 ? 0 : 1)
