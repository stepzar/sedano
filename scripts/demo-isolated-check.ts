#!/usr/bin/env bun
/**
 * The website demo's fake server (`apps/ui/src/demo/`) must never ship in the
 * app. It is gated by a build-time constant in `main.tsx`; this builds the
 * normal bundle and the demo bundle into temporary folders and proves the
 * marker only `src/demo/index.ts` contains is absent from the first and
 * present in the second (so the check cannot pass by grepping for nothing).
 *
 *   bun scripts/demo-isolated-check.ts
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ROOT, installExitHandlers, onCleanup, runCleanups } from './lib/harness.ts'

installExitHandlers()

const source = readFileSync(join(ROOT, 'apps/ui/src/demo/index.ts'), 'utf8')
const marker = /DEMO_MARKER = '([^']+)'/.exec(source)?.[1]
if (!marker) throw new Error('DEMO_MARKER not found in apps/ui/src/demo/index.ts')

function build(argv: string[], out: string): void {
  const run = Bun.spawnSync(argv, { cwd: ROOT, env: { ...process.env, SEDANO_DEMO_OUT: out }, stdout: 'pipe', stderr: 'pipe' })
  if (run.exitCode !== 0) {
    console.error(run.stderr.toString())
    throw new Error(`${argv.join(' ')} failed`)
  }
}

function contains(dir: string, needle: string): string[] {
  const hits: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) hits.push(...contains(path, needle))
    else if (/\.(js|html|css)$/.test(name) && readFileSync(path, 'utf8').includes(needle)) hits.push(path)
  }
  return hits
}

const app = mkdtempSync(join(tmpdir(), 'sedano-app-'))
const demo = mkdtempSync(join(tmpdir(), 'sedano-demo-'))
onCleanup(() => rmSync(app, { recursive: true, force: true }))
onCleanup(() => rmSync(demo, { recursive: true, force: true }))

build([process.execPath, 'x', 'vite', 'build', '--config', 'apps/ui/vite.config.ts', '--outDir', app, '--emptyOutDir'], app)
build([process.execPath, 'run', 'build:demo'], demo)

// The marker, and a sentence only the demo's notice says.
const leaked = [...contains(app, marker), ...contains(app, 'nothing leaves your browser')]
const present = contains(demo, marker)
await runCleanups()

let ok = true
if (leaked.length) {
  console.error(`✗ the app bundle contains the demo: ${leaked.join(', ')}`)
  ok = false
} else console.log('✓ the app bundle has no demo code')
if (!present.length) {
  console.error('✗ the demo bundle lacks its marker — this check would prove nothing')
  ok = false
} else console.log('✓ the demo bundle carries its marker')
process.exit(ok ? 0 : 1)
