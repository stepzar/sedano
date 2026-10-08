#!/usr/bin/env bun
/** A hermetic daily check and explicit all-harness upgrade. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const marker = 'SEDANO_SYNC_SANDBOX'
if (!process.env[marker]) {
  const root = mkdtempSync(join(tmpdir(), 'sedano-sync-'))
  const bin = join(root, 'bin')
  const packageBin = join(root, 'lib/node_modules/freebuff/bin/freebuff')
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(root, 'lib/node_modules/freebuff/bin'), { recursive: true })
  const version = join(root, 'version')
  const views = join(root, 'views')
  writeFileSync(version, '1.12.0\n')
  writeFileSync(views, '')
  writeFileSync(packageBin, `#!/bin/sh\ncat '${version}'\n`)
  chmodSync(packageBin, 0o755)
  symlinkSync(packageBin, join(bin, 'freebuff'))
  const npm = join(bin, 'npm')
  writeFileSync(npm, `#!/bin/sh\nif [ "$1" = view ]; then printf view >> '${views}'; printf '"1.13.0"\\n'; exit 0; fi\nif [ "$1" = install ]; then printf '1.13.0\\n' > '${version}'; exit 0; fi\nexit 2\n`)
  chmodSync(npm, 0o755)
  const child = Bun.spawnSync([process.execPath, import.meta.path], {
    env: {
      ...process.env,
      [marker]: root,
      SEDANO_HOME: join(root, 'sedano'),
      SEDANO_SSH_CONFIG: join(root, 'no-ssh-config'),
      SEDANO_EXPLICIT_PATH: '1',
      PATH: `${bin}:/usr/bin:/bin`,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  process.stdout.write(child.stdout)
  process.stderr.write(child.stderr)
  rmSync(root, { recursive: true, force: true })
  process.exit(child.exitCode ?? 1)
}

const root = process.env[marker]!
const { startHarnessSync, harnessSyncStatus } = await import('../apps/server/src/manager.ts')
const { kvGet } = await import('../apps/server/src/db.ts')
const settle = async () => {
  for (let attempt = 0; attempt < 300 && harnessSyncStatus().running; attempt += 1) {
    await Bun.sleep(20)
  }
  const status = harnessSyncStatus()
  if (status.running) throw new Error('catalog sync did not finish')
  if (status.failures.length) throw new Error(`catalog sync failed: ${JSON.stringify(status.failures)}`)
  return status
}

const started = startHarnessSync('check', true)
if (!started.running) throw new Error('manual refresh blocked instead of running in background')
const checked = await settle()
if (checked.total !== 1 || checked.completed !== 1) throw new Error(`wrong progress: ${JSON.stringify(checked)}`)
if (!kvGet('harness-updates-v1')?.includes('available')) throw new Error('available release was not cached')
const views = join(root, 'views')
const beforeDaily = readFileSync(views, 'utf8')
startHarnessSync('check')
await settle()
if (readFileSync(views, 'utf8') !== beforeDaily) throw new Error('daily check ignored its persistent cache')
startHarnessSync('upgrade', true)
await settle()
if (readFileSync(join(root, 'version'), 'utf8').trim() !== '1.13.0') throw new Error('explicit upgrade did not install the release')
if (!kvGet('harness-updates-v1')?.includes('current')) throw new Error('installed release was not rescanned')
console.log('harness-sync-test: PASSED (background, daily cache, manual update, rescan)')
