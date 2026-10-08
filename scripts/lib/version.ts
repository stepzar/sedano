/**
 * Where the version lives, and every file that has to agree with it.
 *
 * The root `package.json` is the one source. `tauri.conf.json` points at it
 * (`"version": "../../../package.json"`), so the app bundle, the updater and the
 * release tag all read it from there; the server reads it through `version.ts`.
 * The other manifests cannot point anywhere — cargo and the workspace
 * package.json files want a literal — so `bump-version.ts` writes them and
 * `version-check.ts` fails the gate the moment one of them drifts.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const ROOT = join(import.meta.dir, '..', '..')

export const ROOT_PACKAGE = join(ROOT, 'package.json')
export const TAURI_CONF = join(ROOT, 'apps/desktop/src-tauri/tauri.conf.json')
/** What `tauri.conf.json`'s `version` must say: a path, relative to the config. */
export const TAURI_VERSION_POINTER = '../../../package.json'
export const CARGO_TOML = join(ROOT, 'apps/desktop/src-tauri/Cargo.toml')
export const CARGO_LOCK = join(ROOT, 'apps/desktop/src-tauri/Cargo.lock')
export const WORKSPACE_PACKAGES = [
  'packages/shared/package.json',
  'apps/server/package.json',
  'apps/ui/package.json',
  'apps/desktop/package.json',
].map((path) => join(ROOT, path))

/** Semver as Tauri's updater compares it: `1.2.3`, optionally `-pre.1`. */
export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export function rootVersion(): string {
  return JSON.parse(readFileSync(ROOT_PACKAGE, 'utf8')).version
}

/** The `[package]` version line of Cargo.toml (the first `version =` in the file). */
export const CARGO_TOML_VERSION = /^(\[package\][^[]*?\nversion = ")([^"]+)(")/m
/** The lockfile entry of this crate. */
export const CARGO_LOCK_VERSION = /(\[\[package\]\]\nname = "sedano"\nversion = ")([^"]+)(")/

/** Every place a version is written, with what it currently says. */
export function versionsOnDisk(): { file: string; version: string | null }[] {
  const read = (file: string) => readFileSync(file, 'utf8')
  return [
    { file: ROOT_PACKAGE, version: rootVersion() },
    ...WORKSPACE_PACKAGES.map((file) => ({ file, version: JSON.parse(read(file)).version ?? null })),
    { file: TAURI_CONF, version: JSON.parse(read(TAURI_CONF)).version ?? null },
    { file: CARGO_TOML, version: CARGO_TOML_VERSION.exec(read(CARGO_TOML))?.[2] ?? null },
    { file: CARGO_LOCK, version: CARGO_LOCK_VERSION.exec(read(CARGO_LOCK))?.[2] ?? null },
  ]
}
