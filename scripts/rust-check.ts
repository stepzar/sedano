#!/usr/bin/env bun
/**
 * `cargo check` for the Tauri shell.
 *
 * The desktop window is Rust, and nothing in the TypeScript suite would notice
 * it stopped compiling — the first sign would be a failed release build. This
 * is the cheap half of that build: types and borrows, no linking, no bundling.
 *
 * It is deliberately *optional*. A Rust toolchain is a large thing to require of
 * someone who only touches the server or the UI, so a machine without `cargo`
 * gets a clearly reported skip and a zero exit rather than a red gate. When the
 * toolchain is there, it is a real failure.
 *
 *   bun scripts/rust-check.ts
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './lib/harness.ts'

const manifest = join(ROOT, 'apps', 'desktop', 'src-tauri', 'Cargo.toml')

/** `Bun.which` answers from the launch environment, which is what we want here. */
const cargo = Bun.which('cargo')
if (!cargo) {
  console.log('rust-check: SKIPPED — no cargo on PATH (install a Rust toolchain to run this gate)')
  process.exit(0)
}
if (!existsSync(manifest)) {
  console.log(`rust-check: SKIPPED — no Tauri crate at ${manifest}`)
  process.exit(0)
}

/**
 * `tauri-build` reads `tauri.conf.json`, and its `externalBin` entry points at
 * the compiled sidecar. Without it the build script fails for a reason that has
 * nothing to do with the Rust code, so the missing binary is reported as what it
 * is instead of as a compile error.
 */
const version = Bun.spawnSync(['rustc', '-vV'], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString()
const triple = /host:\s*(\S+)/.exec(version)?.[1] ?? ''
const sidecar = join(ROOT, 'apps', 'desktop', 'src-tauri', 'binaries', `sedano-server-${triple}`)
if (triple && !existsSync(sidecar)) {
  console.log(`rust-check: SKIPPED — the sidecar ${sidecar} is missing; run "bun run sidecar" first`)
  process.exit(0)
}

/**
 * The same holds for the UI bundle: `frontendDist` and `bundle.resources` both
 * point at `apps/ui/dist`, and `tauri-build` refuses a resource path that does
 * not exist. CI used to run this gate without building it and read the build
 * script's exit 101 as "the Rust code is broken". This one is a failure, not a
 * skip — `bun run build:ui` takes seconds and needs nothing but bun.
 */
const uiDist = join(ROOT, 'apps', 'ui', 'dist', 'index.html')
if (!existsSync(uiDist)) {
  console.log(`rust-check: FAILED — the UI bundle ${uiDist} is missing; run "bun run build:ui" first`)
  process.exit(1)
}

console.log(`cargo check (${triple || 'host'})`)
const proc = Bun.spawn(['cargo', 'check', '--manifest-path', manifest, '--quiet'], {
  cwd: ROOT,
  stdout: 'inherit',
  stderr: 'inherit',
})
const code = await proc.exited
console.log(code === 0 ? 'rust-check: PASSED' : 'rust-check: FAILED')
process.exit(code)
