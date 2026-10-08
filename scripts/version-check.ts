#!/usr/bin/env bun
/**
 * Fails when any manifest disagrees with the root `package.json` version, or
 * when the workflows do not agree on one bun.
 *
 * A drifted version is how a release ships an updater manifest that says one
 * thing and a bundle that says another — the updater then offers the same
 * build forever, or never offers the new one. `bump-version.ts` writes them all.
 *
 *   bun scripts/version-check.ts
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ROOT, SEMVER, TAURI_CONF, TAURI_VERSION_POINTER, rootVersion, versionsOnDisk } from './lib/version.ts'

const expected = rootVersion()
const failures: string[] = []
if (!SEMVER.test(expected)) failures.push(`package.json version ${JSON.stringify(expected)} is not semver`)

for (const { file, version } of versionsOnDisk()) {
  const want = file === TAURI_CONF ? TAURI_VERSION_POINTER : expected
  if (version !== want) failures.push(`${relative(ROOT, file)}: ${JSON.stringify(version)}, expected "${want}"`)
}

/**
 * One bun for every workflow: the release ships a sidecar compiled by the bun
 * in release.yml, and it should be the runtime ci.yml tested. At least 1.2.4,
 * because older `bun build --compile` output fails `codesign` strict
 * validation and the bundle cannot be signed (docs/release.md).
 */
const workflows = join(ROOT, '.github', 'workflows')
const pins = new Map<string, string[]>()
for (const name of readdirSync(workflows).filter((file) => file.endsWith('.yml'))) {
  for (const match of readFileSync(join(workflows, name), 'utf8').matchAll(/bun-version:\s*['"]?([\w.-]+)/g)) {
    pins.set(match[1]!, [...(pins.get(match[1]!) ?? []), name])
  }
}
if (pins.size > 1) failures.push(`workflows pin different bun versions: ${JSON.stringify(Object.fromEntries(pins))}`)
for (const pinned of pins.keys()) {
  const [major = 0, minor = 0, patch = 0] = pinned.split('.').map(Number)
  if (major * 1e6 + minor * 1e3 + patch < 1_002_004) failures.push(`bun ${pinned} in workflows is older than 1.2.4`)
}

if (failures.length) {
  for (const failure of failures) console.error(`  drift  ${failure}`)
  console.error(`version-check: FAILED — manifests: run "bun scripts/bump-version.ts ${expected}"; bun pins: edit .github/workflows`)
  process.exit(1)
}
console.log(`version-check: PASSED (${expected} everywhere)`)
