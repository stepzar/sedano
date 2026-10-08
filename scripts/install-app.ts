#!/usr/bin/env bun
/**
 * Builds the release app and installs it as /Applications/Sedano.app.
 *
 *   bun run install:app                 # build, quit the running app, replace, relaunch
 *   bun run install:app --rollback      # swap back to Sedano.app.previous
 *
 * Options (mostly for testing the install itself):
 *   --target <dir>   install somewhere other than /Applications
 *   --app <path>     install this bundle instead of building one
 *   --port <n>       the installed app's port, checked before relaunch (7788)
 *   --no-launch      do not relaunch after installing
 *   --force          rebuild the UI and the sidecar even when nothing changed
 *
 * Quitting goes through the app's own quit path (an Apple Event), so the shell
 * stops its server with SIGTERM exactly as when the user quits: sessions are
 * saved and durable agents keep running, to be picked up by the new build.
 *
 * The UI bundle and the compiled sidecar are rebuilt only when their inputs
 * changed (a content hash over the files git knows about), and cargo reuses its
 * own incremental state, so an update that touched one file is quick.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const TAURI_DIR = join(ROOT, 'apps/desktop/src-tauri')
const STAMPS = join(TAURI_DIR, 'target/install-app')
const APP_NAME = 'Sedano.app'

/* ------------------------------------------------------------------ */
/* Arguments                                                           */
/* ------------------------------------------------------------------ */

function option(name: string): string | null {
  const index = process.argv.indexOf(name)
  if (index < 0) return null
  const value = process.argv[index + 1]
  if (!value || value.startsWith('--')) fail(`${name} needs a value`)
  return value
}

const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith('--')))
const targetDir = resolve(option('--target') ?? '/Applications')
const prebuilt = option('--app')
const appPort = Number(option('--port') ?? 7788)
const launch = !flags.has('--no-launch')
const force = flags.has('--force')

const installed = join(targetDir, APP_NAME)
const previous = join(targetDir, `${APP_NAME}.previous`)

function fail(message: string): never {
  console.error(`install:app: ${message}`)
  process.exit(1)
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const timings: Array<{ step: string; ms: number }> = []

async function step<T>(name: string, work: () => T | Promise<T>): Promise<T> {
  const started = performance.now()
  console.log(`\n→ ${name}`)
  try {
    return await work()
  } finally {
    timings.push({ step: name, ms: performance.now() - started })
  }
}

function run(
  argv: string[],
  options: { cwd?: string; quiet?: boolean; env?: Record<string, string> } = {},
): { code: number; out: string } {
  const proc = Bun.spawnSync(argv, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...options.env },
    stdout: options.quiet ? 'pipe' : 'inherit',
    stderr: options.quiet ? 'pipe' : 'inherit',
  })
  return { code: proc.exitCode ?? 1, out: proc.stdout?.toString() ?? '' }
}

function mustRun(argv: string[], options: { cwd?: string; env?: Record<string, string> } = {}): void {
  if (run(argv, options).code !== 0) fail(`failed: ${argv.join(' ')}`)
}

function plistValue(app: string, key: string): string | null {
  const result = run(['/usr/libexec/PlistBuddy', '-c', `Print :${key}`, join(app, 'Contents/Info.plist')], { quiet: true })
  return result.code === 0 ? result.out.trim() : null
}

/* ------------------------------------------------------------------ */
/* Build, skipping what did not change                                 */
/* ------------------------------------------------------------------ */

/** A hash over every file git tracks or would track under `paths`, plus `extra`. */
function inputsHash(paths: string[], extra: string[] = []): string {
  const listed = run(['git', 'ls-files', '-z', '-c', '-o', '--exclude-standard', '--', ...paths], { quiet: true })
  if (listed.code !== 0) return `unhashable-${Date.now()}`
  const hasher = new Bun.CryptoHasher('sha256')
  for (const text of extra) hasher.update(`${text}\0`)
  for (const file of listed.out.split('\0').filter(Boolean).sort()) {
    const path = join(ROOT, file)
    if (!existsSync(path)) continue
    hasher.update(`${file}\0`)
    hasher.update(readFileSync(path))
  }
  return hasher.digest('hex')
}

/** Runs `build` unless `output` exists and the inputs hash matches the last build's. */
async function cachedBuild(name: string, hash: string, output: string, build: () => void): Promise<void> {
  const stamp = join(STAMPS, `${name}.hash`)
  const last = existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() : null
  if (!force && last === hash && existsSync(output)) {
    console.log(`  ${name}: unchanged, reusing ${output.replace(`${ROOT}/`, '')}`)
    return
  }
  build()
  mkdirSync(STAMPS, { recursive: true })
  writeFileSync(stamp, `${hash}\n`)
}

function hostTriple(): string {
  const text = run(['rustc', '-vV'], { quiet: true }).out
  return /host:\s*(\S+)/.exec(text)?.[1] ?? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`
}

/**
 * The shell is a thin webview whose UI is embedded in the binary, so every UI
 * change recompiles it — and under the config's fat LTO with one codegen unit
 * that recompile re-optimises all of tauri, ~40 s each time. For a build that
 * only goes to this Mac, no LTO, parallel codegen and incremental compilation
 * make it a few seconds; the binary is a little larger and just as fast.
 */
const FAST_RELEASE = {
  CARGO_PROFILE_RELEASE_LTO: 'false',
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS: '16',
  CARGO_PROFILE_RELEASE_INCREMENTAL: 'true',
}

async function buildApp(): Promise<string> {
  const shared = ['packages/shared', 'package.json', 'bun.lock', 'tsconfig.json']
  await step('UI bundle', () =>
    cachedBuild('ui', inputsHash(['apps/ui', ...shared]), join(ROOT, 'apps/ui/dist/index.html'), () =>
      mustRun(['bun', 'run', 'build:ui']),
    ),
  )
  await step('server sidecar', () =>
    cachedBuild(
      'sidecar',
      inputsHash(['apps/server', 'scripts/build-sidecar.ts', ...shared], [Bun.version]),
      join(TAURI_DIR, `binaries/sedano-server-${hostTriple()}`),
      () => mustRun(['bun', 'run', 'sidecar', '--release']),
    ),
  )
  await step('tauri build (release, .app only)', () => {
    // The UI and the sidecar are built above; the config's own
    // `beforeBuildCommand` would rebuild both unconditionally.
    const override = join(STAMPS, 'tauri.install.json')
    mkdirSync(STAMPS, { recursive: true })
    writeFileSync(override, JSON.stringify({ build: { beforeBuildCommand: null } }))
    mustRun([
      join(ROOT, 'node_modules/.bin/tauri'),
      'build',
      '--config',
      join(TAURI_DIR, 'tauri.conf.json'),
      '--config',
      override,
      '--bundles',
      'app',
    ], { env: FAST_RELEASE })
  })
  const built = join(TAURI_DIR, 'target/release/bundle/macos', APP_NAME)
  if (!existsSync(built)) fail(`tauri build finished but ${built} is missing`)
  return built
}

/** The bundle is the one we mean to ship: right identity, icon, sidecar and phone UI. */
function verifyBundle(app: string, strict: boolean): void {
  const config = JSON.parse(readFileSync(join(TAURI_DIR, 'tauri.conf.json'), 'utf8')) as { identifier: string }
  const id = plistValue(app, 'CFBundleIdentifier')
  const name = plistValue(app, 'CFBundleName')
  const icon = plistValue(app, 'CFBundleIconFile')
  const executable = plistValue(app, 'CFBundleExecutable')
  console.log(`  ${app}\n  id ${id}, name ${name}, executable ${executable}, icon ${icon}`)
  if (!strict) return
  const problems: string[] = []
  if (id !== config.identifier) problems.push(`identifier ${id}, expected ${config.identifier}`)
  if (name !== 'Sedano') problems.push(`bundle name ${name}, expected Sedano`)
  const iconFile = icon ? join(app, 'Contents/Resources', icon.endsWith('.icns') ? icon : `${icon}.icns`) : null
  if (!iconFile || !existsSync(iconFile)) problems.push('no app icon in Contents/Resources')
  if (!existsSync(join(app, 'Contents/MacOS/sedano-server'))) problems.push('no sidecar in Contents/MacOS')
  if (!existsSync(join(app, 'Contents/Resources/ui/index.html'))) problems.push('no UI bundle in Contents/Resources/ui')
  if (problems.length) fail(`the built bundle is not right:\n  - ${problems.join('\n  - ')}`)
}

/* ------------------------------------------------------------------ */
/* Quit, replace, relaunch                                             */
/* ------------------------------------------------------------------ */

/** Processes running from the installed bundle: the shell and its sidecar. */
function runningFrom(app: string): number[] {
  const result = run(['pgrep', '-f', `${app}/Contents/MacOS/`], { quiet: true })
  return result.out
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => pid > 0 && pid !== process.pid)
}

async function waitGone(app: string, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!runningFrom(app).length) return true
    await Bun.sleep(250)
  }
  return !runningFrom(app).length
}

/** The shell itself (not its sidecar): the bundle's main executable. */
function shellPids(app: string): number[] {
  // Matched by its tail: `/tmp` shows up as `/private/tmp` in `ps`.
  const executable = `/Contents/MacOS/${plistValue(app, 'CFBundleExecutable') ?? 'sedano'}`
  return runningFrom(app).filter((pid) => {
    const command = run(['ps', '-o', 'command=', '-p', String(pid)], { quiet: true }).out.trim()
    return command.endsWith(executable) || command.includes(`${executable} `)
  })
}

/**
 * The app's own quit, so its shell SIGTERMs the server the way a ⌘Q does.
 *
 * Addressed by pid (`NSRunningApplication.terminate`, a quit Apple Event to that
 * one process), never by bundle id: an older `tauri dev` window shares the
 * app's identifier, and quitting "app.sedano.desktop" could close it instead.
 */
async function quitInstalled(): Promise<void> {
  if (!existsSync(installed) || !runningFrom(installed).length) {
    console.log('  not running')
    return
  }
  for (const pid of shellPids(installed)) {
    const script = `ObjC.import('AppKit'); const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); app.isNil() ? false : app.terminate`
    const quit = Bun.spawn(['osascript', '-l', 'JavaScript', '-e', script], { stdout: 'ignore', stderr: 'ignore' })
    const timer = setTimeout(() => quit.kill(), 10_000)
    await quit.exited
    clearTimeout(timer)
  }
  if (await waitGone(installed, 20_000)) {
    console.log('  quit')
    return
  }
  // No answer to the Apple Event: SIGTERM the shell alone. Its sidecar watches
  // its parent (SEDANO_SUPERVISED) and shuts itself down cleanly when it goes.
  for (const pid of shellPids(installed)) process.kill(pid, 'SIGTERM')
  if (await waitGone(installed, 15_000)) {
    console.log('  stopped with SIGTERM')
    return
  }
  fail(`Sedano is still running (pids ${runningFrom(installed).join(', ')}); quit it by hand and run this again`)
}

function copyBundle(source: string, destination: string): void {
  rmSync(destination, { recursive: true, force: true })
  // `ditto` keeps the code signature, symlinks and extended attributes intact.
  mustRun(['ditto', source, destination])
  // Only a bundle built in this checkout has its quarantine cleared. One passed
  // with `--app` from anywhere else came from somewhere else, and the quarantine is what makes
  // Gatekeeper check it before it first runs — clearing it would skip that.
  // (This `xattr` has no `-r`, so every quarantined file is found and cleared.)
  if (prebuilt && !resolve(prebuilt).startsWith(join(TAURI_DIR, 'target') + '/')) return
  run(['find', destination, '-xattrname', 'com.apple.quarantine', '-exec', 'xattr', '-d', 'com.apple.quarantine', '{}', '+'], {
    quiet: true,
  })
}

/** Copy next to the target first, then swap by rename: the target is never half-written. */
function replaceInstalled(source: string): void {
  mkdirSync(targetDir, { recursive: true })
  const staging = join(targetDir, `.${APP_NAME}.installing`)
  copyBundle(source, staging)
  if (existsSync(installed)) {
    rmSync(previous, { recursive: true, force: true })
    renameSync(installed, previous)
  }
  try {
    renameSync(staging, installed)
  } catch (error) {
    if (existsSync(previous) && !existsSync(installed)) renameSync(previous, installed)
    throw error
  }
  console.log(`  installed ${installed}${existsSync(previous) ? ` (previous kept as ${previous})` : ''}`)
}

function rollback(): void {
  if (!existsSync(previous)) fail(`nothing to roll back to: ${previous} does not exist`)
  const aside = join(targetDir, `.${APP_NAME}.rollback`)
  rmSync(aside, { recursive: true, force: true })
  if (existsSync(installed)) renameSync(installed, aside)
  renameSync(previous, installed)
  // The build rolled back from becomes the new `.previous`, so a rollback can be undone.
  if (existsSync(aside)) renameSync(aside, previous)
  console.log(`  ${installed} is the previous build again`)
}

/**
 * What answers on the app's port now that it has quit. Anything still there was
 * not started by the app — most likely a `bun run dev` or a hand-started server
 * from before dev moved to its own port. It is not ours to stop: the person who
 * started it decides, so this only says who it is.
 */
async function portHolder(): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${appPort}/api/health`, { signal: AbortSignal.timeout(1500) })
    const health = (await response.json().catch(() => ({}))) as { instance?: string; home?: string; pid?: number }
    return `a Sedano server (instance ${health.instance ?? 'unknown'}, data ${health.home ?? 'unknown'}, pid ${health.pid ?? 'unknown'})`
  } catch (error) {
    if (/ECONNREFUSED|Unable to connect|ConnectionRefused/i.test(String(error))) return null
    return 'something that is not Sedano'
  }
}

async function relaunch(): Promise<void> {
  if (!launch) {
    console.log('  skipped (--no-launch)')
    return
  }
  // The old sidecar may take a moment to release the port after the shell quit.
  let holder = await portHolder()
  for (let tries = 0; holder && tries < 20; tries++) {
    await Bun.sleep(250)
    holder = await portHolder()
  }
  if (holder) {
    console.log(
      `  not launched: port ${appPort} is held by ${holder}.\n` +
        `  Stop it (Ctrl-C the old \`bun run dev\`, or \`kill -TERM <pid>\` — a graceful stop, durable agents survive),\n` +
        `  then open ${installed}.`,
    )
    return
  }
  mustRun(['open', installed])
  console.log('  launched')
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

if (process.platform !== 'darwin') fail('this installs a macOS app bundle')
const started = performance.now()

if (flags.has('--rollback')) {
  await step('quit the running app', quitInstalled)
  await step('roll back', rollback)
  await step('relaunch', relaunch)
} else {
  const source = prebuilt ? resolve(prebuilt) : await buildApp()
  if (!existsSync(join(source, 'Contents/Info.plist'))) fail(`${source} is not an app bundle`)
  await step('check the bundle', () => verifyBundle(source, !prebuilt))
  await step('quit the running app', quitInstalled)
  await step('replace the installed app', () => replaceInstalled(source))
  await step('relaunch', relaunch)
}

console.log('\ntimings:')
for (const { step: name, ms } of timings) console.log(`  ${name.padEnd(34)} ${(ms / 1000).toFixed(1)}s`)
console.log(`  ${'total'.padEnd(34)} ${((performance.now() - started) / 1000).toFixed(1)}s`)
