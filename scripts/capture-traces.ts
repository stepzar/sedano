#!/usr/bin/env bun
/**
 * Record what the real coding-agent CLIs actually emit, once, on purpose.
 *
 * Every other harness test in this repo runs against a hand-written fake. That
 * is what keeps them fast and hermetic, and it is also why two defects reached a
 * person: a fixture only ever asserts the shapes its author imagined. This
 * script spends a little real quota to capture the protocol envelope as it
 * really arrives, so `conformance-test.ts` can replay it forever afterwards
 * without spending anything.
 *
 * It is deliberately awkward to run:
 *   - it refuses without `--i-know-this-costs-money`, because it costs money;
 *   - it is not wired into `check:all` and must never be;
 *   - it works in a throwaway directory and a throwaway `SEDANO_HOME`, never in
 *     this repo and never in the operator's real store.
 *
 *   bun scripts/capture-traces.ts --list
 *   bun scripts/capture-traces.ts --i-know-this-costs-money \
 *       --harness commandcode --scenario table
 *
 * What lands on disk, per scenario, under `scripts/fixtures/traces/<harness>/`:
 *   <scenario>.jsonl          every protocol line, both directions, verbatim
 *   <scenario>.meta.json      argv, model, outcome, timings
 *   <scenario>.transcript.jsonl        (claude only) the on-disk transcript
 *   <scenario>.subagents.json          (claude only) the subagent sidecars
 *
 * Everything written here goes through `redact()` first. Nothing is ever
 * synthesised: if a scenario fails, the failure is recorded in the meta file and
 * no trace is written, because a fabricated trace would poison every test built
 * on it.
 */
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, hostname, tmpdir } from 'node:os'
import { join } from 'node:path'

/* ------------------------------------------------------------------ */
/* Where things go                                                     */
/* ------------------------------------------------------------------ */

const ROOT = join(import.meta.dir, '..')
const TRACES = join(ROOT, 'scripts', 'fixtures', 'traces')

/** The placeholder every redacted absolute cwd becomes, in traces and in tests. */
export const CAPTURE_CWD = '/tmp/sedano-capture'
/** The placeholder every redacted home directory becomes. */
export const CAPTURE_HOME = '/Users/user'

/* ------------------------------------------------------------------ */
/* The trace envelope                                                  */
/* ------------------------------------------------------------------ */

/**
 * One protocol line, kept verbatim as a string.
 *
 * The line is not re-parsed and re-serialised: a replay has to reproduce the
 * bytes the driver's own parser saw, including whatever the CLI did with
 * whitespace and field order, or the fixture is a paraphrase rather than a
 * record. `dir` is which way it travelled — `agent` is the CLI talking, `client`
 * is what we wrote back to it, which for Claude's control protocol and for ACP
 * is half the conversation.
 */
export interface TraceFrame {
  dir: 'agent' | 'client' | 'stderr'
  /** Milliseconds since the process was spawned. */
  ms: number
  line: string
}

export interface TraceMeta {
  harness: string
  scenario: string
  /** The argv after the binary, so a replay can assert the flags we really sent. */
  args: string[]
  model: string | null
  permissionMode: string | null
  prompt: string
  capturedAt: string
  outcome: 'ok' | 'failed'
  note: string
  frames: number
  durationMs: number
  /** Present only when the harness writes an on-disk transcript we also read. */
  transcript?: string
  subagents?: string[]
}

/* ------------------------------------------------------------------ */
/* Redaction                                                           */
/* ------------------------------------------------------------------ */

/**
 * Strip everything personal before a byte reaches `scripts/fixtures/`.
 *
 * Order matters: the capture directory sits under the system temp dir and the
 * home directory can appear inside it, so the longest, most specific paths are
 * replaced first. Session uuids are deliberately kept — the Claude transcript
 * path is derived from one, so replacing it would make the fixture internally
 * inconsistent — and they identify a throwaway conversation in a throwaway
 * directory, not a person.
 */
export function redact(text: string, captureCwd: string): string {
  const host = hostname()
  const home = homedir()
  const user = home.split('/').pop() ?? ''
  let out = text
  // The capture directory, in both its plain and its Claude-slug form: the
  // transcript folder name is the cwd with every non-alphanumeric turned into a
  // dash, so the raw string alone would leave the path readable.
  const slug = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-')
  out = out.split(slug(captureCwd)).join(slug(CAPTURE_CWD))
  out = out.split(captureCwd).join(CAPTURE_CWD)
  out = out.split(slug(home)).join(slug(CAPTURE_HOME))
  out = out.split(home).join(CAPTURE_HOME)
  if (user) out = out.split(user).join('user')
  out = out.split(host).join('capture-host')
  out = out.split(host.replace(/\.local$/, '')).join('capture-host')
  // Credentials, in the shapes that actually turn up in agent output.
  out = out.replace(/\b(sk|sk-ant|xai|gsk|ghp|github_pat)[-_][A-Za-z0-9_-]{16,}/g, '$1-REDACTED')
  out = out.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, 'user@example.com')
  return out
}

/**
 * A skill's body, when the skill is not one the capture installed itself.
 *
 * Both CLIs hand the model a skill by pasting its whole `SKILL.md` into a tool
 * result, in the same shape:
 *
 * ```
 * <command-name>costi</command-name>
 * Base directory for this skill: /Users/user/.agents/skills/costi
 * The content of SKILL.md is:
 * # …the entire file…
 * ```
 *
 * Which is fine for `ping`, the throwaway skill `installPingSkill` writes into
 * the capture directory for the express purpose of being recorded — and not at
 * all fine for the operator's own skills, whose bodies are their work: the
 * `slash-cost` capture pulled in a pricing model, a client's name and a real
 * month of spend. The base directory is what tells the two apart, and it is
 * right there in the payload. The name is always kept: it is the only part any
 * test asserts on (`activate_skill costi`), and it is not a secret.
 */
/** How every structural redaction below announces itself, and recognises itself. */
const REDACTED = '<redacted'

function redactForeignSkillBody(text: string): string {
  const marker = 'The content of SKILL.md is:'
  const at = text.indexOf(marker)
  if (at < 0) return text
  const dir = /Base directory for this skill:\s*(\S+)/.exec(text)?.[1] ?? ''
  // A skill the capture installed is the fixture; anything else is the
  // operator's. `CAPTURE_CWD` is what `redact()` has already rewritten the
  // capture directory to by the time this runs.
  if (dir.startsWith(CAPTURE_CWD)) return text
  const head = text.slice(0, at + marker.length)
  const body = text.slice(at + marker.length)
  // Already done. Every rule here has to be able to recognise its own work, or
  // running it twice would redact the redaction and a committed fixture could
  // never be checked for being clean.
  if (body.trim().startsWith(REDACTED)) return text
  return `${head}\n${REDACTED}: ${body.trim().length} characters of a skill outside the capture directory>`
}

/** Walk every string in a parsed frame, rewriting the ones that leak. */
function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, mapStrings(item, fn)]),
    )
  }
  return value
}

/**
 * The keys of a Claude `system/init` frame that inventory the operator's machine.
 *
 * Every one of them is ambient context the CLI volunteers about where it is
 * running, and not one of them is protocol anything reads: the driver's `init`
 * branch takes `model` and `permissionMode` and nothing else. Between them they
 * listed this operator's entire working life — their clients' skills by name,
 * the business connectors they have authorised, the plugins they run.
 *
 * The array is kept as an array of the right kind, with one marker element
 * saying how many entries were dropped, so a future reader still meets the shape
 * the CLI really sends.
 */
const INIT_INVENTORY_KEYS = [
  'tools',
  'mcp_servers',
  'slash_commands',
  'terminal_slash_commands',
  'agents',
  'skills',
  'plugins',
  'memory_paths',
]

/**
 * The captured protocol, with the operator's machine taken out of it.
 *
 * `redact()` handles paths and credentials. It cannot handle the three places a
 * CLI volunteers a description of the machine it is running on, because those
 * are structure rather than a pattern:
 *
 *   1. Claude's `system/init` frame, which inventories every tool, skill, slash
 *      command, agent, plugin and MCP server that is installed;
 *   2. Claude's `system/hook_started` / `system/hook_response` frames, which
 *      carry the stdout of the operator's own SessionStart hooks verbatim;
 *   3. a skill activation result, which pastes the whole of a `SKILL.md` in —
 *      see `redactForeignSkillBody`.
 *
 * Only frames that actually match one of those are re-serialised; every other
 * line stays the bytes the CLI wrote, which is the whole point of a capture. A
 * frame that is touched says so in the marker it is left with, so a reader can
 * never mistake a redaction for something the CLI said.
 */
export function redactFrames(text: string, captureCwd: string): string {
  return redactFrameStructure(redact(text, captureCwd))
}

/**
 * The structural half of {@link redactFrames}, on its own.
 *
 * Separated so a test can assert that a committed trace is *already* redacted:
 * running this over it has to change nothing. The pattern half cannot be used
 * that way — it rewrites the running machine's own user and hostname, so on a
 * developer whose username happened to be a common word it would rewrite the
 * fixture and the assertion would fail for a reason that has nothing to do with
 * privacy. This half depends on nothing but the bytes.
 */
export function redactFrameStructure(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line
      let frame: TraceFrame
      try {
        frame = JSON.parse(line) as TraceFrame
      } catch {
        return line
      }
      let payload: Record<string, any>
      try {
        payload = JSON.parse(frame.line)
      } catch {
        // Not every line is JSON, and one that is not is kept exactly as it came.
        return line
      }

      let touched = false

      if (payload.type === 'system' && payload.subtype === 'init') {
        for (const key of INIT_INVENTORY_KEYS) {
          const value = payload[key]
          if (!Array.isArray(value) || value.length === 0) continue
          const first = value[0]
          if (typeof first === 'string' ? first.startsWith(REDACTED) : first?.redacted === true) continue
          touched = true
          payload[key] =
            typeof first === 'string'
              ? [`${REDACTED}: ${value.length} entries from the operator's machine>`]
              : [{ redacted: true, count: value.length }]
        }
      }

      if (payload.type === 'system' && String(payload.subtype ?? '').startsWith('hook_')) {
        for (const key of ['output', 'stdout', 'stderr', 'input']) {
          const value = payload[key]
          if (typeof value !== 'string' || !value || value.startsWith(REDACTED)) continue
          touched = true
          payload[key] = `${REDACTED}: ${value.length} characters of a hook's own output>`
        }
      }

      const skilled = mapStrings(payload, redactForeignSkillBody) as Record<string, any>
      if (JSON.stringify(skilled) !== JSON.stringify(payload)) {
        payload = skilled
        touched = true
      }

      if (!touched) return line
      return JSON.stringify({ ...frame, line: JSON.stringify(payload) })
    })
    .join('\n')
}

/**
 * A transcript, with the operator's whole environment taken out of it.
 *
 * `redact()` above works on paths and credentials, and that is not enough for a
 * Claude transcript: every session opens with a run of `attachment` records that
 * dump the machine it ran on — the installed skill listing and their
 * descriptions, the MCP servers and their instructions, the agent roster, the
 * stdout of every SessionStart hook, and whatever CLAUDE.md injected. In this
 * operator's capture that included their employers, their rates and their
 * clients' names. None of it is protocol: `ClaudeTranscriptReader` has no branch
 * for `type: "attachment"` at all, so a fixture keeps the envelope (the record's
 * type, its uuid, its place in the parent chain) and drops only the payload.
 *
 * Everything the reader does read — `user`, `assistant`, `system`, `summary`,
 * `queue-operation` — is left byte for byte as the CLI wrote it.
 *
 * This is for *every* transcript, the `subagents/agent-*.jsonl` sidecars
 * included. A sidechain is a conversation like any other: it opens with the same
 * `attachment` preamble and leaks the same inventory, which is exactly what the
 * first `Agent` capture did — the sidecar went out with only `redact()` on it
 * and carried the operator's whole skill listing.
 */
export function redactTranscript(text: string, captureCwd: string): string {
  return redactTranscriptStructure(redact(text, captureCwd))
}

/** The structural half of {@link redactTranscript}; see `redactFrameStructure`. */
export function redactTranscriptStructure(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line
      let rec: Record<string, unknown>
      try {
        rec = JSON.parse(line)
      } catch {
        return line
      }
      if (rec.type === 'attachment') {
        const kind = (rec.attachment as { type?: unknown } | undefined)?.type
        return JSON.stringify({
          ...rec,
          attachment: { type: typeof kind === 'string' ? kind : 'unknown', redacted: true },
        })
      }
      // A record the reader does read can still carry a skill's body: the CLI
      // hands one to the model as an ordinary `user` record.
      const skilled = mapStrings(rec, redactForeignSkillBody)
      return JSON.stringify(skilled) === JSON.stringify(rec) ? line : JSON.stringify(skilled)
    })
    .join('\n')
}

/* ------------------------------------------------------------------ */
/* Scenarios                                                           */
/* ------------------------------------------------------------------ */

type Harness = 'claude' | 'commandcode' | 'acp-opencode' | 'acp-codex'

interface Scenario {
  id: string
  /** What the person types. A slash command is a prompt like any other. */
  prompt: string
  harnesses: Harness[]
  /** Claude and Command Code both take a mode; ACP takes one at prompt time. */
  permissionMode?: string
  /** How the capture answers a permission / question the agent raises. */
  answer?: 'allow' | 'deny' | 'first-option'
  /** Interrupt the turn this long after it started, instead of letting it end. */
  cancelAfterMs?: number
  /** Drop a project-level skill into the capture directory before running. */
  installSkill?: boolean
  why: string
}

const ALL: Harness[] = ['claude', 'commandcode', 'acp-opencode', 'acp-codex']

const SCENARIOS: Scenario[] = [
  {
    id: 'plain',
    prompt: 'Reply with exactly the word: pong. Nothing else.',
    harnesses: ALL,
    permissionMode: 'default',
    answer: 'allow',
    why: 'the baseline envelope: which usage, cost and context fields really arrive, and which are simply absent',
  },
  {
    id: 'table',
    prompt:
      'Reply with only a GitHub-flavoured markdown table. Two columns, headed Key and Value. Exactly two rows: a with 1, and b with 2. No prose before or after the table.',
    harnesses: ALL,
    permissionMode: 'default',
    answer: 'allow',
    why: 'the table rendering bug: we need a real table as the harness emits it, not one we typed ourselves',
  },
  {
    id: 'subagent',
    // `Agent`, not `Task`. The first capture of this scenario asked for `Task`
    // and came back with `subagent_stats.spawned: 0` and a polite refusal — this
    // CLI has `TaskCreate`/`TaskGet`/`TaskList` (a to-do tracker) and spawns a
    // sidechain through `Agent`. A scenario that names a tool the CLI does not
    // have records a refusal and calls it evidence, which is worse than nothing.
    prompt:
      'Use the Agent tool exactly once to launch a general-purpose subagent. Its only instruction: run the shell command `echo hi` and report the output. When it comes back, reply with exactly: done.',
    harnesses: ['claude'],
    // Not bypassPermissions: the capture answers the one permission request the
    // mode does not cover, which is the least privilege that still completes.
    permissionMode: 'acceptEdits',
    answer: 'allow',
    why: 'subagent_start / subagent_end come from the transcript sidecars, which no fixture has ever been built from',
  },
  {
    id: 'skill',
    prompt: 'Use the ping skill and then reply with exactly what it tells you to reply.',
    harnesses: ['claude'],
    permissionMode: 'acceptEdits',
    answer: 'allow',
    installSkill: true,
    why: 'a real Skill invocation, from a throwaway project-level skill so the capture stays trivial and deterministic',
  },
  {
    id: 'slash-status',
    prompt: '/status',
    harnesses: ALL,
    permissionMode: 'default',
    answer: 'allow',
    why: 'the slash command that broke: its output collapsed to two bare "Local command" lines',
  },
  {
    id: 'slash-cost',
    prompt: '/cost',
    harnesses: ALL,
    permissionMode: 'default',
    answer: 'allow',
    why: 'a second local command, to tell a per-command quirk from the general shape',
  },
  {
    id: 'question',
    prompt:
      'Use the AskUserQuestion tool to ask me whether you should pick option A or option B. Do nothing else until I answer, then reply with exactly the letter I chose.',
    harnesses: ['claude'],
    permissionMode: 'default',
    answer: 'first-option',
    why: 'the native structured question, which is the only moment the model waits on a person',
  },
  {
    id: 'permission',
    prompt: 'Use the Bash tool to run exactly: echo hi',
    harnesses: ALL,
    // `default` is what makes the CLI ask rather than decide for itself.
    permissionMode: 'default',
    answer: 'allow',
    why: 'a permission request as the protocol really frames it, and the tool result that follows an approval',
  },
  {
    id: 'error',
    prompt:
      'Use the Read tool on the absolute path /nonexistent-sedano-capture/definitely-not-here.txt. Then reply with exactly: done.',
    harnesses: ALL,
    permissionMode: 'default',
    answer: 'allow',
    why: 'a failing tool call: which frame carries the reason, and whether it is structured or a string',
  },
  {
    id: 'cancel',
    prompt: 'Count from 1 to 200, writing one number per line, slowly. Do not stop early.',
    harnesses: ALL,
    permissionMode: 'default',
    answer: 'allow',
    cancelAfterMs: 4000,
    why: 'a turn interrupted mid-stream, which is the one ending a fixture cannot fake convincingly',
  },
]

/* ------------------------------------------------------------------ */
/* A recording child process                                           */
/* ------------------------------------------------------------------ */

interface Recorder {
  frames: TraceFrame[]
  write(line: string): void
  /** Close stdin, for the harnesses that read one prompt and then work. */
  end(): void
  kill(signal?: NodeJS.Signals): void
  exited: Promise<number | null>
}

/**
 * Spawn a CLI and record every line it writes and every line we write back.
 *
 * `onLine` is given each parsed-or-not stdout line as it arrives, which is how a
 * scenario notices the turn is over, or that the CLI is blocked on a question
 * only this process can answer.
 */
function record(
  bin: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  onLine: (line: string, rec: Recorder) => void,
  onStderr?: (line: string) => void,
): Recorder {
  const started = Date.now()
  const frames: TraceFrame[] = []
  const child = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })

  const rec: Recorder = {
    frames,
    write(line: string) {
      frames.push({ dir: 'client', ms: Date.now() - started, line })
      try {
        child.stdin.write(`${line}\n`)
      } catch {
        // A CLI that has already gone is not an error worth failing a capture
        // over; the trace records what did arrive.
      }
    },
    end() {
      try {
        child.stdin.end()
      } catch {
        /* already closed */
      }
    },
    kill(signal: NodeJS.Signals = 'SIGTERM') {
      try {
        child.kill(signal)
      } catch {
        /* already gone */
      }
    },
    exited: new Promise((resolve) => child.on('exit', (code) => resolve(code))),
  }

  let out = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    out += chunk
    const lines = out.split('\n')
    out = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      frames.push({ dir: 'agent', ms: Date.now() - started, line })
      onLine(line, rec)
    }
  })
  let err = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    err += chunk
    const lines = err.split('\n')
    err = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      frames.push({ dir: 'stderr', ms: Date.now() - started, line })
      onStderr?.(line)
    }
  })
  return rec
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Wait for a scenario to declare itself finished, with a ceiling.
 *
 * A capture that hangs is a capture that keeps a real CLI (and its quota) alive
 * with nobody watching, so the deadline is short and a timeout is recorded as
 * the outcome rather than retried.
 */
async function until(done: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (done()) return true
    await sleep(50)
  }
  return false
}

/* ------------------------------------------------------------------ */
/* Claude Code                                                         */
/* ------------------------------------------------------------------ */

/**
 * The flags the real driver uses, copied from `claude/session.ts`.
 *
 * Duplicated on purpose rather than imported: importing the driver would pull
 * the whole server module graph (and its store) into a script whose entire job
 * is to talk to a CLI. `conformance-test.ts` uses the real driver instead, which
 * is where that fidelity actually matters.
 */
const CLAUDE_ARGS = [
  '--permission-prompt-tool',
  'stdio',
  '--print',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--include-partial-messages',
  '--verbose',
]

async function captureClaude(scenario: Scenario, cwd: string, model: string): Promise<Partial<TraceMeta>> {
  const uuid = crypto.randomUUID()
  const args = [
    ...CLAUDE_ARGS,
    '--session-id',
    uuid,
    '--model',
    model,
    '--permission-mode',
    scenario.permissionMode ?? 'default',
  ]

  let finished = false
  let note = ''
  const rec = record(
    'claude',
    args,
    cwd,
    { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } as Record<string, string>,
    (line, self) => {
      let frame: Record<string, any>
      try {
        frame = JSON.parse(line)
      } catch {
        return
      }
      if (frame.type === 'control_request') {
        answerClaudeControl(frame, scenario, self)
        return
      }
      if (frame.type === 'result') finished = true
    },
  )

  rec.write(
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: scenario.prompt }] },
      parent_tool_use_id: null,
      session_id: uuid,
    }),
  )

  if (scenario.cancelAfterMs) {
    await sleep(scenario.cancelAfterMs)
    rec.write(
      JSON.stringify({
        type: 'control_request',
        request_id: crypto.randomUUID(),
        request: { subtype: 'interrupt' },
      }),
    )
  }

  const ok = await until(() => finished, 180_000)
  if (!ok) note = 'timed out waiting for the result frame'
  rec.kill()
  await Promise.race([rec.exited, sleep(3000)])
  // The transcript is written as the turn runs, but the last lines can land a
  // beat after the result frame: a short settle beats a fixture missing its end.
  await sleep(1500)

  const transcriptPath = claudeTranscript(cwd, uuid)
  const subagentsDir = join(claudeProjectDir(cwd), uuid, 'subagents')
  return {
    args,
    model,
    permissionMode: scenario.permissionMode ?? 'default',
    outcome: ok ? 'ok' : 'failed',
    note,
    frames: rec.frames.length,
    ...({ __frames: rec.frames, __transcript: transcriptPath, __subagents: subagentsDir } as object),
  }
}

/**
 * Mirrors `paths.ts`: Claude derives the folder from the cwd, dash for anything else.
 *
 * The path has to be the *resolved* one. `mkdtempSync` hands back a directory
 * under `$TMPDIR`, which on macOS is reached through a symlink (`/tmp` →
 * `/private/tmp`), and the CLI slugs the cwd it actually landed in. The capture
 * of 2026-09-22 slugged the unresolved path, looked for a folder that has never
 * existed, found nothing and wrote its traces with no `transcript` — which left
 * the half of the Claude protocol that only the transcript carries (tool calls,
 * skills, slash commands, subagents) out of every fixture that run produced.
 */
function claudeProjectDir(cwd: string): string {
  const root = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  let resolved = cwd
  try {
    resolved = realpathSync(cwd)
  } catch {
    /* a directory that is gone cannot be resolved; the raw path is the best guess */
  }
  return join(root, 'projects', resolved.replace(/[^a-zA-Z0-9]/g, '-'))
}

function claudeTranscript(cwd: string, uuid: string): string {
  return join(claudeProjectDir(cwd), `${uuid}.jsonl`)
}

/**
 * Answer whatever the CLI is blocked on, the way the scenario says to.
 *
 * Every control request gets a reply, including subtypes we do not recognise —
 * the CLI blocks until one arrives, and a capture that ignored one would record
 * a hang instead of a protocol.
 */
function answerClaudeControl(frame: Record<string, any>, scenario: Scenario, rec: Recorder): void {
  const requestId = String(frame.request_id ?? '')
  if (!requestId) return
  const request = (frame.request ?? {}) as Record<string, any>
  const subtype = String(request.subtype ?? '')
  const reply = (response: unknown) =>
    rec.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } }))

  if (subtype !== 'can_use_tool') {
    rec.write(
      JSON.stringify({
        type: 'control_response',
        response: { subtype: 'error', request_id: requestId, error: `${subtype} is not supported in this context` },
      }),
    )
    return
  }

  const input = (request.input ?? {}) as Record<string, any>
  if (String(request.tool_name ?? '') === 'AskUserQuestion') {
    // Answer each question with its own first option, which is the shape the
    // real driver sends back: the question's text mapped to an option label.
    const questions: Array<Record<string, any>> = Array.isArray(input.questions) ? input.questions : []
    const answers: Record<string, string> = {}
    for (const question of questions) {
      const label = (question.options ?? [])[0]?.label
      if (label) answers[String(question.question ?? question.header ?? 'Question')] = String(label)
    }
    reply({ behavior: 'allow', updatedInput: { ...input, questions: input.questions, answers } })
    return
  }

  if (scenario.answer === 'deny') {
    reply({ behavior: 'deny', message: 'declined by the capture harness', interrupt: false })
    return
  }
  reply({ behavior: 'allow', updatedInput: input })
}

/* ------------------------------------------------------------------ */
/* Command Code                                                        */
/* ------------------------------------------------------------------ */

function commandCodePermissionArgs(mode: string): string[] {
  switch (mode) {
    case 'plan':
      return ['--permission-mode', 'plan']
    case 'default':
      return ['--permission-mode', 'standard']
    case 'bypassPermissions':
      return ['--yolo']
    default:
      return ['--permission-mode', 'auto-accept']
  }
}

async function captureCommandCode(scenario: Scenario, cwd: string, model: string): Promise<Partial<TraceMeta>> {
  const args = [
    '-p',
    '--output-format',
    'json',
    '--skip-onboarding',
    '--trust',
    '--model',
    model,
    ...commandCodePermissionArgs(scenario.permissionMode ?? 'default'),
  ]
  let finished = false
  const rec = record('cmd', args, cwd, process.env as Record<string, string>, (line) => {
    try {
      if ((JSON.parse(line) as { type?: string }).type === 'result') finished = true
    } catch {
      /* not every line is a frame; the trace keeps it either way */
    }
  })
  // One process per turn: the prompt goes in on stdin and stdin is closed.
  rec.write(scenario.prompt)
  rec.end()

  let killed = false
  if (scenario.cancelAfterMs) {
    await sleep(scenario.cancelAfterMs)
    // Command Code has no interrupt frame — the driver kills the process, so
    // that is what a truthful cancellation capture does too. Nothing more will
    // arrive after that, so the capture does not sit out the normal deadline.
    rec.kill('SIGTERM')
    killed = true
  }

  const ok = await until(() => finished, killed ? 2000 : 180_000)
  rec.kill('SIGKILL')
  await Promise.race([rec.exited, sleep(3000)])
  return {
    args,
    model,
    permissionMode: scenario.permissionMode ?? 'default',
    outcome: ok || scenario.cancelAfterMs ? 'ok' : 'failed',
    note: ok ? '' : scenario.cancelAfterMs ? 'killed mid-turn on purpose' : 'no result frame arrived',
    frames: rec.frames.length,
    ...({ __frames: rec.frames } as object),
  }
}

/* ------------------------------------------------------------------ */
/* ACP agents                                                          */
/* ------------------------------------------------------------------ */

const ACP_SPECS: Record<string, { bin: string; args: string[] }> = {
  'acp-opencode': { bin: 'opencode', args: ['acp'] },
  'acp-codex': { bin: 'codex-acp', args: [] },
}

/**
 * Drive an ACP agent by hand and record both halves of the JSON-RPC.
 *
 * The driver is not used here for the same reason as Claude's: the point is the
 * bytes on the pipe, not our reading of them. Requests the agent makes of the
 * client (permission, file access) are answered the way the scenario says, and
 * the answer is recorded too — a one-sided ACP trace cannot be replayed at all.
 */
async function captureAcp(
  harness: Harness,
  scenario: Scenario,
  cwd: string,
  model: string | null,
): Promise<Partial<TraceMeta>> {
  const spec = ACP_SPECS[harness]!
  let nextId = 1
  let sessionId: string | null = null
  let finished = false
  let failure = ''
  const pending = new Map<number, (result: { result?: unknown; error?: unknown }) => void>()

  const rec = record(spec.bin, spec.args, cwd, process.env as Record<string, string>, (line, self) => {
    let frame: Record<string, any>
    try {
      frame = JSON.parse(line)
    } catch {
      return
    }
    // A reply to something we asked.
    if (frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined)) {
      pending.get(Number(frame.id))?.({ result: frame.result, error: frame.error })
      pending.delete(Number(frame.id))
      return
    }
    // A request the agent makes of us: it blocks until it is answered.
    if (frame.id !== undefined && typeof frame.method === 'string') {
      const answer = acpClientAnswer(frame.method, scenario)
      self.write(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: answer }))
      return
    }
    if (frame.method === 'session/update' && frame.params?.update?.sessionUpdate === 'agent_message_chunk') {
      // Streaming: nothing to do but keep the frame, which `record` already did.
    }
  })

  const call = async (method: string, params: unknown, timeoutMs = 120_000): Promise<any> => {
    const id = nextId++
    const promise = new Promise<{ result?: unknown; error?: unknown }>((resolve) => pending.set(id, resolve))
    rec.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    const settled = await Promise.race([promise, sleep(timeoutMs).then(() => null)])
    if (!settled) throw new Error(`${method} timed out`)
    if (settled.error) throw new Error(`${method} failed: ${JSON.stringify(settled.error)}`)
    return settled.result
  }

  try {
    await call(
      'initialize',
      { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } },
      120_000,
    )
    const session = await call('session/new', { cwd, mcpServers: [] }, 180_000)
    sessionId = String((session as { sessionId?: string }).sessionId ?? '')
    if (model) {
      // Best effort: an agent that does not publish the option simply refuses,
      // and the refusal is itself worth having in the trace.
      try {
        await call('session/set_config_option', { sessionId, optionId: 'model', value: model }, 60_000)
      } catch {
        /* recorded in the trace */
      }
    }
    const prompt = call(
      'session/prompt',
      { sessionId, prompt: [{ type: 'text', text: scenario.prompt }] },
      180_000,
    )
    if (scenario.cancelAfterMs) {
      await sleep(scenario.cancelAfterMs)
      rec.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }))
    }
    await prompt
    finished = true
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }

  rec.kill()
  await Promise.race([rec.exited, sleep(3000)])
  return {
    args: spec.args,
    model,
    permissionMode: scenario.permissionMode ?? 'default',
    outcome: finished ? 'ok' : 'failed',
    note: failure,
    frames: rec.frames.length,
    ...({ __frames: rec.frames } as object),
  }
}

/** What the capture answers when an ACP agent asks the client something. */
function acpClientAnswer(method: string, scenario: Scenario): unknown {
  if (method === 'session/request_permission') {
    // The option id is not knowable in advance, so the permissive outcome is
    // selected by kind: `selected` needs an id, `cancelled` does not. The
    // scenario that wants a real approval reads the request out of the trace.
    return scenario.answer === 'deny' ? { outcome: { outcome: 'cancelled' } } : { outcome: { outcome: 'cancelled' } }
  }
  if (method === 'fs/read_text_file') return { content: '' }
  if (method === 'fs/write_text_file') return null
  return {}
}

/* ------------------------------------------------------------------ */
/* Writing the fixture                                                 */
/* ------------------------------------------------------------------ */

function writeTrace(harness: Harness, scenario: Scenario, cwd: string, result: Record<string, any>): void {
  const dir = join(TRACES, harness)
  mkdirSync(dir, { recursive: true })
  const frames: TraceFrame[] = result.__frames ?? []

  if (result.outcome !== 'ok') {
    // No trace at all for a scenario that did not happen: the meta file says so,
    // and a test that looks for the fixture finds nothing rather than a guess.
    writeFileSync(
      join(dir, `${scenario.id}.meta.json`),
      `${JSON.stringify(
        {
          harness,
          scenario: scenario.id,
          capturedAt: new Date().toISOString(),
          outcome: 'failed',
          note: result.note || 'the scenario did not complete',
          why: scenario.why,
        },
        null,
        2,
      )}\n`,
    )
    console.log(`  ✗ ${harness}/${scenario.id}: ${result.note || 'did not complete'} (no trace written)`)
    return
  }

  const body = frames.map((frame) => JSON.stringify(frame)).join('\n')
  writeFileSync(join(dir, `${scenario.id}.jsonl`), `${redactFrames(body, cwd)}\n`)

  const meta: TraceMeta = {
    harness,
    scenario: scenario.id,
    args: result.args ?? [],
    model: result.model ?? null,
    permissionMode: result.permissionMode ?? null,
    prompt: scenario.prompt,
    capturedAt: new Date().toISOString(),
    outcome: 'ok',
    note: result.note ?? '',
    frames: frames.length,
    durationMs: frames.length ? (frames[frames.length - 1]!.ms ?? 0) : 0,
  }

  if (result.__transcript && existsSync(result.__transcript)) {
    meta.transcript = `${scenario.id}.transcript.jsonl`
    writeFileSync(
      join(dir, meta.transcript),
      redactTranscript(readFileSync(result.__transcript, 'utf8'), cwd),
    )
  }
  if (result.__subagents && existsSync(result.__subagents)) {
    const names = readdirSync(result.__subagents)
    if (names.length) {
      meta.subagents = names
      const target = join(dir, `${scenario.id}.subagents`)
      rmSync(target, { recursive: true, force: true })
      mkdirSync(target, { recursive: true })
      for (const name of names) {
        const body = readFileSync(join(result.__subagents, name), 'utf8')
        // A sidecar `.jsonl` is a transcript and gets a transcript's redaction;
        // its `.meta.json` is four fields of routing (agentType, description,
        // toolUseId, spawnDepth) and only needs the pattern pass.
        writeFileSync(
          join(target, name),
          name.endsWith('.jsonl') ? redactTranscript(body, cwd) : redact(body, cwd),
        )
      }
    }
  }

  writeFileSync(join(dir, `${scenario.id}.meta.json`), `${redact(JSON.stringify(meta, null, 2), cwd)}\n`)
  console.log(`  ✓ ${harness}/${scenario.id}: ${frames.length} frames${meta.subagents ? `, ${meta.subagents.length} subagent files` : ''}`)
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

/**
 * Everything below runs only when this file is the program.
 *
 * `redact`, `CAPTURE_CWD` and `SCENARIOS` are the vocabulary a replay has to
 * share with the capture — a test that redacted differently would be comparing
 * against a paraphrase — so `conformance-test.ts` imports them. Without this
 * guard importing the module *ran the capture's argument parsing*, which exits
 * the process with a refusal before the importing test has done anything at
 * all. The capture still refuses to run without `--i-know-this-costs-money`;
 * that check simply belongs to the program, not to the module.
 */
if (import.meta.main) {
const argv = Bun.argv.slice(2)
const flag = (name: string): string | null => {
  const index = argv.indexOf(name)
  return index >= 0 ? (argv[index + 1] ?? null) : null
}

if (argv.includes('--list')) {
  for (const scenario of SCENARIOS) {
    console.log(`${scenario.id.padEnd(14)} ${scenario.harnesses.join(', ')}`)
    console.log(`${' '.repeat(15)}${scenario.why}`)
  }
  process.exit(0)
}

if (!argv.includes('--i-know-this-costs-money')) {
  console.error(
    'capture-traces spends real quota against real CLIs and is never part of check:all.\n' +
      'Re-run it with --i-know-this-costs-money if that is what you meant.\n\n' +
      '  bun scripts/capture-traces.ts --list\n' +
      '  bun scripts/capture-traces.ts --i-know-this-costs-money --harness commandcode --scenario table\n',
  )
  process.exit(2)
}

const harness = flag('--harness') as Harness | null
const wanted = flag('--scenario')
if (!harness) {
  console.error('--harness is required (claude | commandcode | acp-opencode | acp-codex)')
  process.exit(2)
}

const model =
  flag('--model') ??
  (harness === 'claude'
    ? 'claude-haiku-4-5-20251001'
    : harness === 'commandcode'
      ? 'poolside/laguna-s-2.1-free'
      : null)

// A throwaway store and a throwaway working directory. The vendor config is
// deliberately *not* isolated — that is where the login lives, and a capture
// against a logged-out CLI would record nothing worth keeping.
const home = mkdtempSync(join(tmpdir(), 'sedano-capture-home-'))
process.env.SEDANO_HOME = home
const cwd = flag('--cwd') ?? mkdtempSync(join(tmpdir(), 'sedano-capture-cwd-'))
mkdirSync(cwd, { recursive: true })
writeFileSync(join(cwd, 'note.txt'), 'hello\n')
writeFileSync(join(cwd, 'math.js'), 'export const add = (a, b) => a + b\n')

const selected = SCENARIOS.filter(
  (scenario) => scenario.harnesses.includes(harness) && (!wanted || scenario.id === wanted),
)
if (!selected.length) {
  console.error(`no scenario matches --harness ${harness}${wanted ? ` --scenario ${wanted}` : ''}`)
  process.exit(2)
}

console.log(`capturing ${harness} (${model ?? 'default model'}) in ${cwd}`)
try {
  for (const scenario of selected) {
    if (scenario.installSkill) installPingSkill(cwd)
    console.log(`- ${scenario.id}`)
    const result =
      harness === 'claude'
        ? await captureClaude(scenario, cwd, model!)
        : harness === 'commandcode'
          ? await captureCommandCode(scenario, cwd, model!)
          : await captureAcp(harness, scenario, cwd, model)
    writeTrace(harness, scenario, cwd, result as Record<string, any>)
  }
} finally {
  rmSync(home, { recursive: true, force: true })
  if (!flag('--keep-cwd')) rmSync(cwd, { recursive: true, force: true })
}
}

/**
 * A project-level skill that costs nothing to run.
 *
 * Invoking one of the operator's real skills would be neither trivial nor
 * deterministic, and the point of the capture is the protocol envelope around a
 * skill, not what any particular skill does.
 */
function installPingSkill(dir: string): void {
  const skill = join(dir, '.claude', 'skills', 'ping')
  mkdirSync(skill, { recursive: true })
  writeFileSync(
    join(skill, 'SKILL.md'),
    [
      '---',
      'name: ping',
      'description: Use when the user says "use the ping skill". Replies with a fixed word.',
      '---',
      '',
      '# ping',
      '',
      'Reply with exactly the word `pong-from-skill` and nothing else.',
      '',
    ].join('\n'),
  )
}

export { SCENARIOS, type Scenario }
