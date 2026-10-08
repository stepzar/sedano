#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyHarnessUpdate, checkHarnessUpdate } from '../apps/server/src/harnesses/updates.ts'

const root = mkdtempSync(join(tmpdir(), 'sedano-harness-update-'))
const state = join(root, 'version')
const installs = join(root, 'installs')
const nativeUpgrades = join(root, 'native-upgrades')
const oldPath = process.env.PATH

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

function executable(name: string, body: string): void {
  const path = join(root, name)
  writeFileSync(path, `#!/bin/sh\nset -eu\n${body}\n`)
  chmodSync(path, 0o755)
}

try {
  writeFileSync(state, '1.12.0\n')
  writeFileSync(installs, '')
  writeFileSync(nativeUpgrades, '')
  const packageBin = join(root, 'lib/node_modules/@agentclientprotocol/codex-acp/dist/index.js')
  mkdirSync(join(root, 'lib/node_modules/@agentclientprotocol/codex-acp/dist'), { recursive: true })
  writeFileSync(packageBin, `#!/bin/sh\ncat ${quote(state)}\n`)
  chmodSync(packageBin, 0o755)
  symlinkSync(packageBin, join(root, 'codex-acp'))
  const codexBin = join(root, 'lib/node_modules/@openai/codex/bin/codex.js')
  mkdirSync(join(root, 'lib/node_modules/@openai/codex/bin'), { recursive: true })
  writeFileSync(codexBin, `#!/bin/sh\ncat ${quote(state)}\n`)
  chmodSync(codexBin, 0o755)
  symlinkSync(codexBin, join(root, 'codex'))
  const opencodeBin = join(root, 'lib/node_modules/opencode-ai/bin/opencode.exe')
  mkdirSync(join(root, 'lib/node_modules/opencode-ai/bin'), { recursive: true })
  writeFileSync(opencodeBin, `#!/bin/sh\nif [ "\${1:-}" = upgrade ]; then printf "native\\n" >> ${quote(nativeUpgrades)}; exit 0; fi\ncat ${quote(state)}\n`)
  chmodSync(opencodeBin, 0o755)
  symlinkSync(opencodeBin, join(root, 'opencode'))
  executable('npm', [
    'if [ "$1" = view ]; then printf "\\\"1.13.0\\\"\\n"; exit 0; fi',
    `if [ "$1" = install ]; then sleep 0.1; printf "install\\n" >> ${quote(installs)}; printf "1.13.0\\n" > ${quote(state)}; exit 0; fi`,
    'exit 2',
  ].join('\n'))
  process.env.PATH = `${root}:${oldPath ?? ''}`

  const before = await checkHarnessUpdate(null, 'codex', true)
  if (before?.status !== 'available' || !before.installedVersion?.includes('1.12.0') || !before.latestVersion?.includes('1.13.0')) {
    throw new Error(`bad pre-update result: ${JSON.stringify(before)}`)
  }
  if (!before.updateCommand?.includes(`--prefix '${realpathSync(root)}'`)) throw new Error(`update targets wrong prefix: ${before.updateCommand}`)
  let serverCouldRun = false
  const tick = setTimeout(() => { serverCouldRun = true }, 20)
  const [after, concurrent] = await Promise.all([applyHarnessUpdate(null, 'codex'), applyHarnessUpdate(null, 'codex')])
  clearTimeout(tick)
  if (!serverCouldRun) throw new Error('update blocked the server event loop')
  if (concurrent !== after || readFileSync(installs, 'utf8').trim().split('\n').length !== 2) {
    throw new Error('concurrent clicks ran duplicate package installations')
  }
  if (after.status !== 'current' || !after.installedVersion?.includes('1.13.0') || !after.latestVersion?.includes('1.13.0')) {
    throw new Error(`bad post-update result: ${JSON.stringify(after)}`)
  }
  // An npm-installed OpenCode must update *that* prefix, not invoke its own
  // auto-detection (which can choose /usr/local from a desktop GUI PATH).
  writeFileSync(state, '1.12.0\n')
  const opencodeBefore = await checkHarnessUpdate(null, 'opencode', true)
  if (opencodeBefore?.status !== 'available' ||
      !opencodeBefore.updateCommand?.includes(`--prefix '${realpathSync(root)}'`)) {
    throw new Error(`npm OpenCode has the wrong updater: ${JSON.stringify(opencodeBefore)}`)
  }
  const opencodeAfter = await applyHarnessUpdate(null, 'opencode')
  if (opencodeAfter.status !== 'current' || readFileSync(nativeUpgrades, 'utf8') !== '') {
    throw new Error(`npm OpenCode did not update its own prefix: ${JSON.stringify(opencodeAfter)}`)
  }
  console.log('harness-update-test: PASSED (read-only detection + explicit update + rescan)')
} finally {
  if (oldPath === undefined) delete process.env.PATH
  else process.env.PATH = oldPath
  rmSync(root, { recursive: true, force: true })
}
