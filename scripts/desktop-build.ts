#!/usr/bin/env bun
/**
 * `tauri build`, with the build machine's paths kept out of the binary.
 *
 * rustc writes source paths into a release binary (panic locations, the paths
 * of every crate in `~/.cargo/registry`), so an installed app used to carry the
 * builder's home directory. `--remap-path-prefix` rewrites them at compile
 * time; cargo has no stable profile setting for it yet (`trim-paths` is still
 * nightly-only), so it goes in through the environment, encoded so a path with
 * a space survives. The release workflow sets the same flags itself.
 *
 *   bun run desktop:build                  # .app + .dmg
 *   bun run desktop:build --bundles app    # any other `tauri build` argument
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')

/** The last matching prefix wins, so the narrower checkout path comes last. */
const remaps = [`--remap-path-prefix=${homedir()}=~`, `--remap-path-prefix=${root}=sedano`]
const inherited = process.env.CARGO_ENCODED_RUSTFLAGS
  ? process.env.CARGO_ENCODED_RUSTFLAGS.split('\x1f')
  : (process.env.RUSTFLAGS ?? '').split(/\s+/)
const rustflags = [...inherited.filter(Boolean), ...remaps].join('\x1f')

const proc = Bun.spawn(
  [
    join(root, 'node_modules/.bin/tauri'),
    'build',
    '--config',
    join(root, 'apps/desktop/src-tauri/tauri.conf.json'),
    ...process.argv.slice(2),
  ],
  { cwd: root, stdio: ['inherit', 'inherit', 'inherit'], env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: rustflags } },
)
process.exit(await proc.exited)
