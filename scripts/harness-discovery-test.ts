#!/usr/bin/env bun
/**
 * Harness discovery from the two environments that hide user-installed CLIs:
 * a macOS GUI PATH and a non-interactive ssh command.
 *
 * Every "agent" is an inert shell file which writes a marker if executed. The
 * test only resolves paths, so a passing run proves discovery did not launch a
 * vendor process or spend quota.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

if (!process.env.SEDANO_DISCOVERY_SANDBOX) {
  const root = mkdtempSync(join(tmpdir(), 'sedano-discovery-'))
  const bin = join(root, 'path-bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(
    join(bin, 'ssh'),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dir, 'fixtures/fake-ssh.ts'))} "$@"\n`,
  )
  chmodSync(join(bin, 'ssh'), 0o755)
  writeFileSync(join(root, 'control.json'), '{}')
  const child = Bun.spawnSync([process.execPath, import.meta.path], {
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: join(root, 'local-home'),
      SEDANO_HOME: join(root, 'sedano-home'),
      SEDANO_DISCOVERY_SANDBOX: root,
      SEDANO_SSH_CONFIG: join(import.meta.dir, 'fixtures/ssh-config'),
      FAKE_SSH_ROOT: root,
    },
    stdout: 'inherit',
    stderr: 'inherit',
  })
  rmSync(root, { recursive: true, force: true })
  process.exit(child.exitCode ?? 1)
}

const root = process.env.SEDANO_DISCOVERY_SANDBOX!
const localHome = process.env.HOME!
const remoteHome = join(root, 'hosts', 'vps')
const ran = join(root, 'agent-ran')
const failures: string[] = []
const passed: string[] = []

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) passed.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

function install(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, `#!/bin/sh\nprintf ran >> ${JSON.stringify(ran)}\nexit 88\n`)
  chmodSync(path, 0o755)
}

const localClaude = join(localHome, '.bun', 'bin', 'claude')
const localGrok = join(localHome, '.grok', 'bin', 'grok')
const oldOpencode = join(localHome, '.nvm', 'versions', 'node', 'v18.0.0', 'bin', 'opencode')
const newOpencode = join(localHome, '.nvm', 'versions', 'node', 'v22.0.0', 'bin', 'opencode')
install(localClaude)
install(localGrok)
install(oldOpencode)
install(newOpencode)

const remoteGemini = join(remoteHome, '.local', 'bin', 'gemini')
const remoteCodex = join(remoteHome, '.nvm', 'versions', 'node', 'v22.1.0', 'bin', 'codex-acp')
install(remoteGemini)
install(remoteCodex)

const { discoveryPath, which } = await import('../apps/server/src/which.ts')
const hosts = await import('../apps/server/src/hosts.ts')
const { Transport } = await import('../apps/server/src/transport.ts')

check('the simulated GUI PATH really omits user install locations', process.env.PATH === `${join(root, 'path-bin')}:/usr/bin:/bin`, process.env.PATH)
check('a Bun-installed harness is found from a GUI launch', which('claude') === localClaude, which('claude'))
check('a vendor-installed harness is found from a GUI launch', which('grok') === localGrok, which('grok'))
check('an nvm-installed harness is found without an active nvm shell', which('opencode') === newOpencode, which('opencode'))
check('a missing harness stays missing', which('not-a-sedano-harness') === null)
check('the discovery PATH keeps the inherited PATH first', discoveryPath().startsWith(process.env.PATH!))

hosts.setHostEnabled('vps', true)
const remote = new Transport('vps')
const catalog = remote.whichAll(['gemini', 'codex-acp', 'missing-agent'])
check('a remote user-bin harness is found without an interactive shell', catalog.get('gemini') === remoteGemini, catalog)
check('a remote nvm harness is found without an interactive shell', catalog.get('codex-acp') === remoteCodex, catalog)
check('a missing remote harness is explicitly null', catalog.get('missing-agent') === null, catalog)
check('the single remote lookup uses the same discovery rules', remote.which('gemini') === remoteGemini)
check('discovery never executes a harness', !existsSync(ran))

if (failures.length) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  console.error(`harness-discovery-test: FAILED (${failures.length} failures, ${passed.length} passed)`)
  process.exit(1)
}
console.log(`harness-discovery-test: PASSED (${passed.length} checks)`)
