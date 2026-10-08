#!/usr/bin/env bun
/**
 * The gate: everything that must pass on a clean checkout, with nothing running
 * and no personal state.
 *
 * `check:all` used to be a chain of `&&` that stopped at the first failure, and
 * it included the smokes that need tmux, ssh or a vendor subscription — so on a
 * fresh machine it could not pass, and on a busy one it talked to whatever
 * server happened to be listening. Here every gate runs (a baseline is worth
 * more than an early exit), each one gets its own temporary `SEDANO_HOME`, and
 * the smokes that depend on the outside world are named at the end instead of
 * being run and blamed.
 *
 *   bun scripts/lib/check-all.ts
 */
import { installExitHandlers, ROOT, runCleanups, tempHome } from './harness.ts'

installExitHandlers()

/**
 * `browser` needs a real Chrome, `rust` a cargo toolchain. Everything else is
 * `core`: bun, this repo, and nothing else. CI splits on exactly this line, and
 * `--without browser` is how a machine with no Chrome still gets a verdict.
 */
type Tag = 'core' | 'browser' | 'rust'

interface Gate {
  name: string
  argv: string[]
  why: string
  tag: Tag
  /** A reason this machine cannot run the gate, checked before it is started. */
  skipWhen?: () => string | null
}

/** Order matters: the browser checks need the bundle the build produces. */
const GATES: Gate[] = [
  { name: 'typecheck', argv: ['bun', 'run', 'typecheck'], why: 'the tree compiles', tag: 'core' },
  { name: 'check:version', argv: ['bun', 'run', 'check:version'], why: 'every manifest carries the root package.json version', tag: 'core' },
  { name: 'check:view', argv: ['bun', 'run', 'check:view'], why: 'render tree, against fixtures', tag: 'core' },
  { name: 'check:turn-view', argv: ['bun', 'run', 'check:turn-view'], why: 'turn state, work order and tool summaries', tag: 'core' },
  { name: 'check:db', argv: ['bun', 'run', 'check:db'], why: 'schema migration and event identity', tag: 'core' },
  { name: 'check:db-backup', argv: ['bun', 'run', 'check:db-backup'], why: 'a release that changes the schema keeps the store it found (last three)', tag: 'core' },
  { name: 'check:turn', argv: ['bun', 'run', 'check:turn'], why: 'turn boundaries, late events and the clock of a queued turn', tag: 'core' },
  { name: 'check:files', argv: ['bun', 'run', 'check:files'], why: 'clickable paths, and the server never opening what it would run', tag: 'core' },
  { name: 'check:resume', argv: ['bun', 'run', 'check:resume'], why: 'a respawned session leaves its history alone', tag: 'core' },
  { name: 'check:replay', argv: ['bun', 'run', 'check:replay'], why: 'recorded sessions through the manager: turn phases, replies, cut-off agents, stable history', tag: 'core' },
  { name: 'check:coverage', argv: ['bun', 'run', 'check:coverage'], why: 'every protocol type in each harness\'s published schema is handled or knowingly ignored', tag: 'core' },
  { name: 'check:lifecycle', argv: ['bun', 'run', 'check:lifecycle'], why: 'spawn, stop and delete under races', tag: 'core' },
  { name: 'check:dock', argv: ['bun', 'run', 'check:dock'], why: 'a docked terminal is part of its session: restored, deleted and never listed with it', tag: 'core' },
  { name: 'check:recovery', argv: ['bun', 'run', 'check:recovery'], why: 'pending questions, acks and attachment ownership', tag: 'core' },
  { name: 'check:ws', argv: ['bun', 'run', 'check:ws'], why: 'two clients on one session, and a reconnect', tag: 'core' },
  { name: 'check:store', argv: ['bun', 'run', 'check:store'], why: 'the client queue and the streaming buffers', tag: 'core' },
  { name: 'check:limits', argv: ['bun', 'run', 'check:limits'], why: 'a spent quota never reads like a missing subscription', tag: 'core' },
  { name: 'check:usage-readers', argv: ['bun', 'run', 'check:usage-readers'], why: 'no credential is read or sent to a vendor for usage until its switch is on, and off reads as off, never zero', tag: 'core' },
  { name: 'check:claude', argv: ['bun', 'run', 'check:claude'], why: 'Claude stream and transcript, against fixtures', tag: 'core' },
  { name: 'check:transcript', argv: ['bun', 'run', 'check:transcript'], why: 'nested and concurrent subagents, truncation, split UTF-8', tag: 'core' },
  { name: 'check:markdown', argv: ['bun', 'run', 'check:markdown'], why: 'every GitHub-Flavored Markdown feature a reply can use, and no raw HTML', tag: 'core' },
  { name: 'check:conformance', argv: ['bun', 'run', 'check:conformance'], why: 'the drivers against traces captured from the real CLIs', tag: 'core' },
  { name: 'check:ssh', argv: ['bun', 'run', 'check:ssh'], why: 'host allowlist and transport, against a fake ssh', tag: 'core' },
  { name: 'check:origin', argv: ['bun', 'run', 'check:origin'], why: 'only the app\'s own origins reach the API, over HTTP and WebSocket; the dev UI only in the dev copy', tag: 'core' },
  { name: 'check:remote', argv: ['bun', 'run', 'check:remote'], why: 'remote mode: tailnet host, pairing, device tokens and tailscale serve, against a fake tailscale', tag: 'core' },
  { name: 'check:discovery', argv: ['bun', 'run', 'check:discovery'], why: 'GUI and remote PATH harness discovery, without launching agents', tag: 'core' },
  { name: 'check:settings', argv: ['bun', 'run', 'check:settings'], why: 'per-host harness choice, the host allowlist and the dictation engines', tag: 'core' },
  { name: 'check:dictation', argv: ['bun', 'run', 'check:dictation'], why: 'on-device WAV encoding and transcription without ffmpeg, a server or an API', tag: 'core' },
  { name: 'check:echo', argv: ['bun', 'run', 'check:echo'], why: 'the message-duplication rule', tag: 'core' },
  { name: 'check:acp', argv: ['bun', 'run', 'check:acp'], why: 'ACP driver, against a fake agent', tag: 'core' },
  { name: 'check:cmd', argv: ['bun', 'run', 'check:cmd'], why: 'Command Code driver, against a fake CLI', tag: 'core' },
  { name: 'check:error', argv: ['bun', 'run', 'check:error'], why: 'a failure is explained in prose, never dumped as a stack', tag: 'core' },
  { name: 'check:manager', argv: ['bun', 'run', 'check:manager'], why: 'the interrupt deadline', tag: 'core' },
  { name: 'check:multi', argv: ['bun', 'run', 'check:multi'], why: 'two harnesses at once, and a remote one beside them', tag: 'core' },
  { name: 'check:models', argv: ['bun', 'run', 'check:models'], why: 'model versions and per-model effort choices', tag: 'core' },
  { name: 'check:context-window', argv: ['bun', 'run', 'check:context-window'], why: 'context window per model, and the meter', tag: 'core' },
  { name: 'check:harness-update', argv: ['bun', 'run', 'check:harness-update'], why: 'harness update detection and explicit update', tag: 'core' },
  { name: 'check:harness-sync', argv: ['bun', 'run', 'check:harness-sync'], why: 'the daily harness check and all-harness upgrade', tag: 'core' },
  { name: 'check:transfer', argv: ['bun', 'run', 'check:transfer'], why: 'handing a session over to another harness', tag: 'core' },
  { name: 'check:import', argv: ['bun', 'run', 'check:import'], why: 'archive hides without deleting; every harness store scanned read-only and imported', tag: 'core' },
  { name: 'check:tabs', argv: ['bun', 'run', 'check:tabs'], why: 'persisted tab order and the shared tab rules (open, close, move, replace, merge)', tag: 'core' },
  { name: 'check:machine-color', argv: ['bun', 'run', 'check:machine-color'], why: 'machine colours: contrast, persistence and refusal', tag: 'core' },
  { name: 'build:ui', argv: ['bun', 'run', 'build:ui'], why: 'the bundle the browser checks serve', tag: 'core' },
  { name: 'check:dist', argv: ['bun', 'run', 'check:dist'], why: 'the built bundle actually boots and is served', tag: 'core' },
  { name: 'check:demo-isolated', argv: ['bun', 'run', 'check:demo-isolated'], why: 'the website demo\'s fake server is compiled out of the app bundle', tag: 'core' },
  { name: 'check:sidecar', argv: ['bun', 'run', 'check:sidecar'], why: 'the compiled server starts and opens its store', tag: 'core' },
  {
    name: 'check:rust',
    argv: ['bun', 'run', 'check:rust'],
    why: 'the Tauri shell still compiles',
    tag: 'rust',
    // Reported rather than run: requiring a Rust toolchain of someone who only
    // touches the server or the UI would make the suite unpassable for them.
    skipWhen: () => (Bun.which('cargo') ? null : 'no cargo on PATH'),
  },
  { name: 'check:csp', argv: ['bun', 'run', 'check:csp'], why: 'the desktop CSP lets the real bundle work and still refuses other sites, scripts and eval', tag: 'browser' },
  { name: 'check:contrast', argv: ['bun', 'run', 'check:contrast'], why: 'WCAG ratios, light and dark', tag: 'browser' },
  { name: 'check:ui', argv: ['bun', 'run', 'check:ui'], why: 'the app in a real browser', tag: 'browser' },
  { name: 'check:tabs-ui', argv: ['bun', 'run', 'check:tabs-ui'], why: 'instant, smooth tab reordering in a real browser', tag: 'browser' },
  { name: 'check:tab-keys-ui', argv: ['bun', 'run', 'check:tab-keys-ui'], why: '⌘1…⌘9 pick the tab at that place in the reordered strip, from the composer and from a terminal', tag: 'browser' },
  { name: 'check:tab-sync-ui', argv: ['bun', 'run', 'check:tab-sync-ui'], why: 'open tabs are shared between a desktop and a phone: open, reorder, close with fallback, reload and the one-time merge', tag: 'browser' },
  { name: 'check:image-chips-ui', argv: ['bun', 'run', 'check:image-chips-ui'], why: 'pasted images are atomic chips that stay in step with their thumbnails and the text sent', tag: 'browser' },
  { name: 'check:mobile-ui', argv: ['bun', 'run', 'check:mobile-ui'], why: 'centred location pill on desktop; on an iPhone no sideways overflow, a working drawer, the composer above the keyboard and 44px touch targets', tag: 'browser' },
  { name: 'check:dock-resize-ui', argv: ['bun', 'run', 'check:dock-resize-ui'], why: 'the quick terminal resizes from its top edge within its limits, refits, keeps the transcript pinned and remembers its height', tag: 'browser' },
  { name: 'check:drafts-ui', argv: ['bun', 'run', 'check:drafts-ui'], why: 'what is written in a tab survives tab switches and reloads until it is sent or the tab is closed', tag: 'browser' },
  { name: 'check:remote-ui', argv: ['bun', 'run', 'check:remote-ui'], why: 'a paired iPhone through a real remote-mode server never sees the Mac-only Remote access panel, and refusals read as words', tag: 'browser' },
  { name: 'check:chip-layout-ui', argv: ['bun', 'run', 'check:chip-layout-ui'], why: 'a chip is drawn exactly where its token is, in both composers, wrapped, scrolled and at fractional widths', tag: 'browser' },
  { name: 'check:round-ui', argv: ['bun', 'run', 'check:round-ui'], why: 'close buttons, counters and dots are exact circles, icon buttons exact squares, glyphs centred, no text crosses', tag: 'browser' },
  { name: 'check:follow-ui', argv: ['bun', 'run', 'check:follow-ui'], why: 'the transcript follows a sent prompt to the bottom, and leaves a reader alone', tag: 'browser' },
  { name: 'check:sticky-ui', argv: ['bun', 'run', 'check:sticky-ui'], why: 'open sections pin their header while read, two levels deep, and fold without moving the reader, in Chrome and WebKit', tag: 'browser' },
  { name: 'check:minimap-ui', argv: ['bun', 'run', 'check:minimap-ui'], why: 'every prompt minimap line is its own target, clear of the text, and lands on its prompt, in Chrome and WebKit', tag: 'browser' },
  { name: 'check:models-ui', argv: ['bun', 'run', 'check:models-ui'], why: 'live model names and per-model effort choices in a real browser', tag: 'browser' },
  { name: 'check:settings-ui', argv: ['bun', 'run', 'check:settings-ui'], why: 'typefaces, the dictation selector and the machines panel in a real browser', tag: 'browser' },
  { name: 'check:update-ui', argv: ['bun', 'run', 'check:update-ui'], why: 'the app-update pill and Settings row through every step, failures on screen, nothing in a browser tab', tag: 'browser' },
  { name: 'check:appearance-ui', argv: ['bun', 'run', 'check:appearance-ui'], why: 'each Appearance control changes only its own side (conversation vs interface), live, in Chrome and WebKit, desktop and phone profile', tag: 'browser' },
  { name: 'check:nav', argv: ['bun', 'run', 'check:nav'], why: 'folder columns, remote failures and the bottom terminal, in a real browser', tag: 'browser' },
  { name: 'check:limits-ui', argv: ['bun', 'run', 'check:limits-ui'], why: 'the limits panel holds still while it is being read', tag: 'browser' },
  { name: 'check:demo', argv: ['bun', 'run', 'check:demo'], why: 'the website demo runs the real UI with no server: streaming, queue, questions, permissions, settings, phone', tag: 'browser' },
]

/** `--without browser rust` drops those groups; everything else stays. */
const excluded = new Set<string>()
for (let index = 0; index < process.argv.length; index++) {
  if (process.argv[index] === '--without') {
    for (let next = index + 1; next < process.argv.length && !process.argv[next]!.startsWith('--'); next++) {
      excluded.add(process.argv[next]!)
    }
  }
}

/** Not gates: they need something this repo cannot provide. */
const OPTIONAL: Array<{ name: string; needs: string }> = [
  { name: 'check:smoke', needs: 'the `claude` CLI, logged in, and quota to spend' },
  { name: 'check:term', needs: 'tmux, and ssh for the remote half' },
  // These two self-skip without tmux rather than failing, so they could sit in
  // the gate list — but a gate that quietly skips is not a gate, and the pane
  // they measure only exists where tmux does.
  { name: 'check:term-double', needs: 'tmux and Chrome: proves a replayed screen is the pane, drawn once' },
  { name: 'check:term-epipe', needs: 'tmux: proves a peer that went away is not an error, and a real failure still is' },
  { name: 'check:term-ui', needs: 'tmux and a browser session against a real terminal' },
  { name: 'check:ui with SEDANO_CHECK_OPTIONAL=1', needs: 'a vendor CLI reporting usage limits' },
  // Deliberately not automated: `tauri dev` needs a window server and a webview,
  // and a run that cannot be torn down leaves a process holding the store. The
  // Rust half is covered by `check:rust`, the server half by `check:sidecar`.
  { name: 'desktop attach/spawn/quit', needs: 'a desktop session: `bun run desktop:dev`, by hand' },
]

// One store for the whole run, thrown away at the end: a check that forgets to
// isolate itself still cannot reach `~/.sedano` from here.
const { home, env } = tempHome('check-all')

interface Outcome {
  gate: Gate
  ok: boolean
  ms: number
}

const outcomes: Outcome[] = []
const skipped: Array<{ gate: Gate; why: string }> = []
for (const gate of GATES) {
  if (excluded.has(gate.tag)) {
    skipped.push({ gate, why: `--without ${gate.tag}` })
    continue
  }
  const unavailable = gate.skipWhen?.()
  if (unavailable) {
    skipped.push({ gate, why: unavailable })
    continue
  }
  console.log(`\n=== ${gate.name} — ${gate.why} ===`)
  const started = Date.now()
  const proc = Bun.spawn(gate.argv, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const code = await proc.exited
  outcomes.push({ gate, ok: code === 0, ms: Date.now() - started })
}

await runCleanups()

const failed = outcomes.filter((outcome) => !outcome.ok)
console.log('\n================ check:all ================')
console.log(`hermetic gates (temporary store ${home}):`)
for (const outcome of outcomes) {
  console.log(`  ${outcome.ok ? 'ok  ' : 'FAIL'} ${outcome.gate.name.padEnd(22)} ${(outcome.ms / 1000).toFixed(1)}s`)
}
if (skipped.length) {
  console.log('\ngates this machine could not run:')
  for (const entry of skipped) console.log(`  skip ${entry.gate.name.padEnd(22)} ${entry.why}`)
}
console.log('\noptional smokes, not run here:')
for (const entry of OPTIONAL) console.log(`  …    ${entry.name.padEnd(16)} needs ${entry.needs}`)
console.log(
  `\nverdict: ${failed.length ? `${failed.length} of ${outcomes.length} gates FAILED (${failed.map((f) => f.gate.name).join(', ')})` : `all ${outcomes.length} hermetic gates passed`}`,
)
process.exit(failed.length ? 1 : 0)
