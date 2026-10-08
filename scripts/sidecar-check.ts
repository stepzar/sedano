#!/usr/bin/env bun
/**
 * The compiled sidecar, built and then actually run.
 *
 * The desktop app does not run `bun apps/server/src/index.ts`: it runs the
 * single executable `bun build --compile` produces, and that is a different
 * program. Anything the bundler cannot see — a dynamic import, a file read
 * relative to the source tree, a native module — compiles fine and dies on
 * first start, which is the one place nobody is watching a log. So the gate is
 * not "the build exited 0" but "the binary listens and answers".
 *
 * It builds into a temporary directory: the real one lives under
 * `apps/desktop/src-tauri/binaries`, is 57 MB, and is what a desktop build
 * ships — a test has no business rewriting it.
 *
 *   bun scripts/sidecar-check.ts
 */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { freePort, installExitHandlers, onCleanup, ROOT, runCleanups, tempHome } from './lib/harness.ts'

installExitHandlers()

const failures: string[] = []
const passed: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) passed.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const outDir = mkdtempSync(join(tmpdir(), 'sedano-sidecar-'))
onCleanup(() => rmSync(outDir, { recursive: true, force: true }))
const binary = join(outDir, 'sedano-server')

console.log('building the sidecar…')
const build = Bun.spawn(['bun', 'run', 'scripts/build-sidecar.ts', '--outfile', binary], {
  cwd: ROOT,
  stdout: 'inherit',
  stderr: 'inherit',
})
check('the sidecar compiles', (await build.exited) === 0)

if (failures.length) {
  await runCleanups()
  console.log(`✗ ${failures[0]}`)
  console.log('sidecar-check: FAILED')
  process.exit(1)
}

const size = statSync(binary).size
check('the binary is self-contained (tens of MB, runtime included)', size > 10 * 1024 * 1024, size)

// Its own store and its own port: the sidecar is a real server, and starting it
// on the default one would fight with the app the operator is running.
const { home, env } = tempHome('sidecar-check')
const guiBin = join(home, '.bun', 'bin')
mkdirSync(guiBin, { recursive: true })
// Inert and TUI-only: the catalog may discover it, but no adapter can launch it
// while this test proves the compiled sidecar can see beyond a Finder-like PATH.
const guiHarness = join(guiBin, 'freebuff')
writeFileSync(guiHarness, '#!/bin/sh\nexit 88\n')
chmodSync(guiHarness, 0o755)
const port = freePort()
const proc = Bun.spawn([binary], {
  cwd: outDir,
  env: {
    ...process.env,
    ...env,
    HOME: home,
    PATH: '/usr/bin:/bin',
    SEDANO_PORT: String(port),
    SEDANO_HOST: '127.0.0.1',
  },
  stdout: 'pipe',
  stderr: 'pipe',
})
const chunks: string[] = []
const drain = async (stream: ReadableStream<Uint8Array> | null): Promise<void> => {
  if (!stream) return
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    if (value) chunks.push(decoder.decode(value))
  }
}
void drain(proc.stdout as ReadableStream<Uint8Array>)
void drain(proc.stderr as ReadableStream<Uint8Array>)
onCleanup(async () => {
  proc.kill('SIGTERM')
  const died = await Promise.race([
    proc.exited.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
  ])
  if (!died) proc.kill('SIGKILL')
  await proc.exited
})

let healthy = false
const deadline = Date.now() + 30_000
while (Date.now() < deadline && proc.exitCode === null) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`)
    if (response.ok) {
      healthy = true
      break
    }
  } catch {
    /* not listening yet */
  }
  await Bun.sleep(200)
}
check('the compiled binary starts and answers its health check', healthy, {
  exitCode: proc.exitCode,
  output: chunks.join('').slice(-2000),
})

if (healthy) {
  // The desktop shell refuses a server whose version differs from its own
  // (`lib.rs`), so the compiled binary has to carry the version it was built
  // from, and a build id that says it is not running from source.
  const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { version?: string; build?: string }
  const expected = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
  check('the health check reports the package.json version', health.version === expected, health)
  check('and a build id stamped at compile time', typeof health.build === 'string' && health.build !== 'source' && health.build.includes('@'), health)

  // `/api/state` reads the session list out of the database, which is the part
  // a compiled build gets wrong: `bun:sqlite` has to be embedded, not resolved
  // on disk at start-up.
  const state = await fetch(`http://127.0.0.1:${port}/api/state`)
  const body = state.ok ? ((await state.json()) as { sessions?: unknown[] }) : null
  check('and it can open its store', state.ok && Array.isArray(body?.sessions), state.status)

  const capsResponse = await fetch(`http://127.0.0.1:${port}/api/caps`)
  const caps = capsResponse.ok
    ? ((await capsResponse.json()) as { harnesses?: Array<{ id?: string; installed?: boolean }> })
    : null
  check(
    'and the packaged server discovers a user harness outside a GUI PATH',
    capsResponse.ok && caps?.harnesses?.find((item) => item.id === 'freebuff')?.installed === true,
    caps,
  )
}

await runCleanups()
void home

if (failures.length) {
  console.log('--- failed checks ---')
  for (const failure of failures) console.log(`✗ ${failure}`)
  console.log(`\nsidecar-check: ${failures.length} FAILURES (${passed.length} passed)`)
  process.exit(1)
}
console.log(`sidecar-check: PASSED (${passed.length} checks, ${(size / 1024 / 1024).toFixed(1)} MB)`)
process.exit(0)
