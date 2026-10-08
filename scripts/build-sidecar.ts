#!/usr/bin/env bun
/**
 * Builds the self-contained sedano server that ships inside the desktop app.
 *
 * `bun build --compile` produces one executable with the runtime embedded, so a
 * packaged build needs no bun, no node and no node_modules on the user machine.
 * Tauri expects the target triple in the file name (`externalBin`).
 *
 *   bun run scripts/build-sidecar.ts            # host target
 *   bun run scripts/build-sidecar.ts --release
 *   bun run scripts/build-sidecar.ts --release --target x86_64-apple-darwin
 *
 * The target is `--target`, else `TAURI_ENV_TARGET_TRIPLE` (set by the Tauri
 * CLI for `beforeBuildCommand`, so `tauri build --target x86_64-apple-darwin`
 * gets an Intel sidecar on an Apple Silicon runner), else the host. Bun
 * cross-compiles: it downloads the runtime for the other target on first use.
 *   bun run scripts/build-sidecar.ts --outfile /tmp/x/sedano-server
 *
 * `--outfile` exists for the health check in `sidecar-check.ts`: a gate that
 * runs on every `check:all` should not drop a 57 MB binary into the tree the
 * desktop build reads, so it builds its own copy somewhere it can delete.
 */
import { mkdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const root = join(import.meta.dir, '..')
const outDir = join(root, 'apps/desktop/src-tauri/binaries')
const entry = join(root, 'apps/server/src/index.ts')
const release = process.argv.includes('--release')

function hostTriple(): string {
  const proc = Bun.spawnSync(['rustc', '-vV'], { stdout: 'pipe', stderr: 'ignore' })
  const text = proc.stdout.toString()
  const host = /host:\s*(\S+)/.exec(text)?.[1]
  if (host) return host
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  return `${arch}-apple-darwin`
}

/** Rust target triple → `bun build --compile --target`. */
const BUN_TARGETS: Record<string, string> = {
  'aarch64-apple-darwin': 'bun-darwin-arm64',
  'x86_64-apple-darwin': 'bun-darwin-x64',
  'aarch64-unknown-linux-gnu': 'bun-linux-arm64',
  'x86_64-unknown-linux-gnu': 'bun-linux-x64',
}

const flagged = process.argv.includes('--target') ? process.argv[process.argv.indexOf('--target') + 1] : undefined
const requested = flagged || process.env.TAURI_ENV_TARGET_TRIPLE || null
const triple = requested ?? hostTriple()
// No explicit target keeps the plain host build (`--target=bun`), as before.
const bunTarget = requested ? BUN_TARGETS[requested] : 'bun'
if (!bunTarget) {
  console.error(`unsupported target ${requested}; known: ${Object.keys(BUN_TARGETS).join(', ')}`)
  process.exit(1)
}
const explicit = process.argv.includes('--outfile') ? process.argv[process.argv.indexOf('--outfile') + 1] : null
const outfile = explicit || join(outDir, `sedano-server-${triple}`)

mkdirSync(dirname(outfile), { recursive: true })
rmSync(outfile, { force: true })

/**
 * Which build this is, reported by `/api/health` as `build` (see
 * `apps/server/src/version.ts`): the commit and the moment it was compiled, so
 * two binaries of the same version can still be told apart in a bug report.
 */
function buildId(): string {
  const describe = Bun.spawnSync(['git', 'describe', '--always', '--dirty'], { cwd: root, stdout: 'pipe', stderr: 'ignore' })
  const commit = describe.exitCode === 0 ? describe.stdout.toString().trim() : 'unknown'
  return `${commit}@${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}`
}

console.log(`building sidecar → ${outfile}`)
const build = Bun.spawnSync(
  [
    'bun',
    'build',
    '--compile',
    ...(release ? ['--minify'] : []),
    `--target=${bunTarget}`,
    `--define=SEDANO_BUILD_ID=${JSON.stringify(buildId())}`,
    `--outfile=${outfile}`,
    entry,
  ],
  { cwd: root, stdout: 'inherit', stderr: 'inherit' },
)

if (build.exitCode !== 0) {
  console.error('sidecar build failed')
  process.exit(build.exitCode ?? 1)
}

const size = statSync(outfile).size
console.log(`sidecar ready: ${(size / 1024 / 1024).toFixed(1)} MB (${triple})`)
