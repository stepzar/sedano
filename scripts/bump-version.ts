#!/usr/bin/env bun
/**
 * Sets the release version everywhere it is written (see `lib/version.ts`).
 *
 *   bun scripts/bump-version.ts 0.2.0
 *
 * It only edits files; committing and tagging stay with the person releasing
 * (docs/release.md). Run `bun run check:version` afterwards — it is the same
 * check CI runs.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { relative } from 'node:path'
import {
  CARGO_LOCK,
  CARGO_LOCK_VERSION,
  CARGO_TOML,
  CARGO_TOML_VERSION,
  ROOT,
  ROOT_PACKAGE,
  SEMVER,
  TAURI_CONF,
  TAURI_VERSION_POINTER,
  WORKSPACE_PACKAGES,
} from './lib/version.ts'

const next = process.argv[2]?.replace(/^v/, '')
if (!next || !SEMVER.test(next)) {
  console.error('usage: bun scripts/bump-version.ts <major.minor.patch>')
  process.exit(1)
}

/** Rewrites only the `"version"` value, so key order and formatting stay as they are. */
function setPackageVersion(file: string): void {
  const text = readFileSync(file, 'utf8')
  const updated = text.replace(/("version":\s*")[^"]*(")/, `$1${next}$2`)
  if (updated === text && !text.includes(`"version": "${next}"`)) throw new Error(`no "version" in ${file}`)
  writeFileSync(file, updated)
}

function setByPattern(file: string, pattern: RegExp): void {
  const text = readFileSync(file, 'utf8')
  if (!pattern.test(text)) throw new Error(`no version found in ${file}`)
  writeFileSync(file, text.replace(pattern, `$1${next}$3`))
}

for (const file of [ROOT_PACKAGE, ...WORKSPACE_PACKAGES]) setPackageVersion(file)
setByPattern(CARGO_TOML, CARGO_TOML_VERSION)
setByPattern(CARGO_LOCK, CARGO_LOCK_VERSION)

const tauri = JSON.parse(readFileSync(TAURI_CONF, 'utf8'))
if (tauri.version !== TAURI_VERSION_POINTER) {
  console.warn(`warning: ${relative(ROOT, TAURI_CONF)} "version" is ${JSON.stringify(tauri.version)}, expected "${TAURI_VERSION_POINTER}"`)
}

console.log(`version set to ${next}`)
