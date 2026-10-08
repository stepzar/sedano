#!/usr/bin/env bun
/**
 * The usage readers that send a stored credential to a vendor are off until
 * the person turns them on.
 *
 * Claude's reader takes Claude Code's OAuth token (from the Keychain, or
 * `secret-tool` on Linux) to call an undocumented endpoint, and Command Code's
 * takes the API key `cmd login` wrote. Neither may happen on its own. Off, the
 * panel must say "off" — never show a zero, and never the numbers an earlier
 * poll left in the store. On, the reader runs straight away.
 *
 * The credential tools are fakes that only write down that they were asked,
 * and they answer with nothing, so the "on" half never reaches the network.
 *
 *   bun scripts/usage-readers-test.ts
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LimitSnapshot } from '@shared'
import { installExitHandlers, runCleanups, startApi, tempHome } from './lib/harness.ts'

installExitHandlers()

const failures: string[] = []
const passed: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) passed.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const { env } = tempHome('usage-readers')
// Outside the store: the server tightens everything in it when it starts.
const { home } = tempHome('usage-readers-tools')
const bin = join(home, 'bin')
const asked = join(home, 'keychain-asked')
mkdirSync(bin, { recursive: true })
const tool = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(bin, name), 0o755)
}
// The Keychain (macOS) and the Secret Service (Linux): record the question, answer nothing.
tool('security', `echo "$@" >> ${JSON.stringify(asked)}`)
tool('secret-tool', `echo "$@" >> ${JSON.stringify(asked)}`)
// Installed harnesses, so the panel has something to say about them.
tool('claude', 'exit 0')
tool('cmd', 'exit 0')
const authFile = join(home, 'commandcode-auth.json')
writeFileSync(authFile, JSON.stringify({ apiKey: 'test-key-never-sent' }))

// A token in the environment wins over every store (see `claudeCredentials`),
// and one is there whenever this runs inside Claude Code: cleared, or "on"
// would send it.
const serverEnv = {
  ...env,
  PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
  COMMANDCODE_AUTH_FILE: authFile,
  CLAUDE_CODE_OAUTH_TOKEN: '',
  ANTHROPIC_OAUTH_TOKEN: '',
}

const limitsOf = async (url: string): Promise<LimitSnapshot[]> =>
  ((await (await fetch(`${url}/api/state`)).json()) as { limits: LimitSnapshot[] }).limits

try {
  const api = await startApi(serverEnv)
  // The poller reads at boot; give it the time it used to need.
  await Bun.sleep(1500)

  const readers = (await (await fetch(`${api.url}/api/usage-readers`)).json()) as {
    readers: Array<{ id: string; on: boolean; endpoint: string; credential: string }>
  }
  check('both readers are listed', readers.readers.map((reader) => reader.id).sort().join() === 'claude,commandcode', readers)
  check('both are off by default', readers.readers.every((reader) => !reader.on), readers)
  check(
    'each names the endpoint and the credential',
    readers.readers.every((reader) => reader.endpoint.startsWith('https://') && reader.credential.length > 0),
    readers,
  )
  check('off: no credential was looked up', !existsSync(asked))

  const off = await limitsOf(api.url)
  for (const harness of ['claude', 'commandcode']) {
    const snapshot = off.find((entry) => entry.harness === harness)
    check(`off: ${harness} reads as off`, snapshot?.off === true, snapshot)
    check(`off: ${harness} shows no number`, (snapshot?.windows.length ?? 0) === 0, snapshot)
  }

  const refused = await fetch(`${api.url}/api/usage-readers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'codex', on: true }),
  })
  check('a reader that does not exist cannot be turned on', refused.status === 400, refused.status)

  const turned = await fetch(`${api.url}/api/usage-readers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'claude', on: true }),
  })
  const after = (await turned.json()) as { readers: Array<{ id: string; on: boolean }> }
  check('turning one on is confirmed', after.readers.find((reader) => reader.id === 'claude')?.on === true, after)
  check('and only that one', after.readers.find((reader) => reader.id === 'commandcode')?.on === false, after)
  const deadline = Date.now() + 10_000
  while (!existsSync(asked) && Date.now() < deadline) await Bun.sleep(100)
  check('on: the credential is looked up straight away', existsSync(asked))
  // The other readers in the same round (a local CLI among them) may take a while.
  let on = await limitsOf(api.url)
  while ((on.find((entry) => entry.harness === 'claude')?.off ?? true) && Date.now() < deadline + 20_000) {
    await Bun.sleep(200)
    on = await limitsOf(api.url)
  }
  const claude = on.find((entry) => entry.harness === 'claude')
  check('on: claude is no longer "off"', claude !== undefined && claude.off !== true, claude)
  check('on: with no token it says so, not zero', Boolean(claude?.error) && (claude?.windows.length ?? 0) === 0, claude)
  check('on: commandcode stays off', on.find((entry) => entry.harness === 'commandcode')?.off === true)

  // The choice is stored with the rest of the settings: a restart keeps it.
  await api.stop()
  const again = await startApi(serverEnv)
  const kept = (await (await fetch(`${again.url}/api/usage-readers`)).json()) as { readers: Array<{ id: string; on: boolean }> }
  check('the switch survives a restart', kept.readers.find((reader) => reader.id === 'claude')?.on === true, kept)

  await fetch(`${again.url}/api/usage-readers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'claude', on: false }),
  })
  const offAgain = (await limitsOf(again.url)).find((entry) => entry.harness === 'claude')
  check('turned off again, the stored reading is not shown', offAgain?.off === true, offAgain)
} finally {
  await runCleanups()
}

for (const label of passed) console.log(`  ok   ${label}`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
console.log(`\nusage-readers: ${passed.length} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
