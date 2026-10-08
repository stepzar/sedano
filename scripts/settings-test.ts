#!/usr/bin/env bun
/**
 * The settings that are answers about a machine, not switches in a file.
 *
 * Three things in Settings are detected rather than configured — which
 * harnesses a machine has, which hosts `~/.ssh/config` defines and whether they
 * answer, which speech engines are installed — and every one of them had the
 * same defect: the panel showed a choice without showing what it was choosing
 * between, and a click changed a value the panel then drew over with a cached
 * one. What is pinned down here:
 *
 *   - a per-host harness preference persists across a restart and the catalog
 *     the server publishes respects it, per machine and not globally;
 *   - hiding a harness leaves a session that is using it completely intact —
 *     its row, its models, its approval modes and its own record;
 *   - the ssh allowlist still refuses everything that is not a literal `Host`
 *     alias in the config, including via the new endpoints;
 *   - a host that does not answer reports a *typed* failure, never a blank;
 *   - the dictation panel describes what is really installed, and choosing an
 *     engine or a model is a change that actually takes effect.
 *
 * Hermetic: temporary `SEDANO_HOME`, a temporary PATH holding only the fakes
 * from `scripts/fixtures/`, a temporary `HOME` for the whisper model directory,
 * and the fixture ssh config. No vendor CLI, no subscription, no real host.
 *
 *   bun scripts/settings-test.ts
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// Type-only: importing anything from the server here would load it before the
// environment below is in place.
import type { Capabilities, HarnessInfo } from '@shared'

/* ------------------------------------------------------------------ */
/* A machine of our own                                                */
/* ------------------------------------------------------------------ */

/**
 * `Bun.which` and `Bun.spawn` answer from the environment this process was
 * *launched* with, so a PATH assigned here would still find the operator's real
 * CLIs — real account, real quota, a 429 for their trouble. The first pass only
 * builds the sandbox and restarts this file inside it.
 *
 * `/tmp` rather than `TMPDIR`: the ssh control socket path is built from this
 * directory and unix socket paths are capped at ~104 bytes.
 */
if (!process.env.SEDANO_SETTINGS_SANDBOX) {
  const sandbox = mkdtempSync('/tmp/sedano-set-')
  const bin = join(sandbox, 'bin')
  const home = join(sandbox, 'home')
  const models = join(home, '.cache/whisper-cpp')
  for (const dir of [bin, models, join(sandbox, 'h')]) mkdirSync(dir, { recursive: true })

  const install = (name: string, body: string): void => {
    writeFileSync(join(bin, name), body)
    chmodSync(join(bin, name), 0o755)
  }
  const fixture = (file: string): string => join(import.meta.dir, 'fixtures', file)

  // Two harnesses that exist here and one that does not, which is what makes
  // "installed" and "offered" two separable columns rather than one.
  install('cmd', `#!/bin/sh\nexec ${process.execPath} ${fixture('fake-cmd.ts')} "$@"\n`)
  install('opencode', `#!/bin/sh\nexec ${process.execPath} ${fixture('fake-acp-agent.ts')} "$@"\n`)
  install('ssh', `#!/bin/sh\nexec ${process.execPath} ${fixture('fake-ssh.ts')} "$@"\n`)
  // The normal dictation path has one executable: the browser already sends a
  // 16 kHz PCM WAV, so this sandbox deliberately contains no ffmpeg and no
  // speech server. Record the argv to prove the selected model reaches it.
  install(
    'whisper-cli',
    `#!/bin/sh\nprintf '%s\\n' "$@" > "$SEDANO_SETTINGS_SANDBOX/whisper-args"\nprintf 'fake whisper transcript\\n'\n`,
  )
  symlinkSync(process.execPath, join(bin, 'bun'))

  // Two model files, so "pick a model" has something to pick between. The bytes
  // do not matter; being on disk under a HOME we control does.
  writeFileSync(join(models, 'ggml-large-v3-turbo-q5_0.bin'), 'x'.repeat(2048))
  writeFileSync(join(models, 'ggml-small.bin'), 'x'.repeat(1024))

  const child = Bun.spawn([process.execPath, import.meta.path], {
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      SEDANO_SETTINGS_SANDBOX: sandbox,
      FAKE_SSH_ROOT: sandbox,
      SEDANO_HOME: join(sandbox, 'h'),
      SEDANO_SSH_CONFIG: join(import.meta.dir, 'fixtures', 'ssh-config'),
      CLAUDE_CONFIG_DIR: join(sandbox, 'claude'),
    },
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  const code = await child.exited
  rmSync(sandbox, { recursive: true, force: true })
  process.exit(code)
}

const sandbox = process.env.SEDANO_SETTINGS_SANDBOX!
const workspace = join(sandbox, 'workspace')
mkdirSync(workspace, { recursive: true })
writeFileSync(join(sandbox, 'control.json'), '{}')

const failures: string[] = []
const passed: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) passed.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

function throws(label: string, fn: () => unknown, match: RegExp): void {
  try {
    fn()
    check(label, false, 'did not throw')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    check(label, match.test(message), message)
  }
}

// Dynamic, and after the environment above is in place: a static import is
// hoisted, and the module graph would open the operator's real store.
const manager = await import('../apps/server/src/manager.ts')
const hosts = await import('../apps/server/src/hosts.ts')
const transcribe = await import('../apps/server/src/transcribe.ts')
const audio = await import('../apps/ui/src/audio.ts')
const db = await import('../apps/server/src/db.ts')

function waitFor(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (predicate()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`))
      setTimeout(tick, 30)
    }
    tick()
  })
}

const harnessIn = (caps: Capabilities, id: string): HarnessInfo | undefined =>
  caps.harnesses.find((item) => item.id === id)

/* ------------------------------------------------------------------ */
/* 1 · The ssh allowlist, still a boundary                             */
/* ------------------------------------------------------------------ */

// It has to be a literal `Host` alias in the config that is actually being read
// — not a pattern, not a name that merely looks like one, not an ssh option.
check('vps is a candidate', hosts.sshConfigHosts().includes('vps'))
check('no host is enabled to start with', hosts.enabledHosts().length === 0, hosts.enabledHosts())

throws('a host nobody declared is refused', () => hosts.setHostEnabled('10.0.0.1', true), /not a Host alias/)
throws('an ssh option is refused as a name', () => hosts.setHostEnabled('-oProxyCommand=id', true), /unsafe/)
throws('a pattern is not a destination', () => hosts.setHostEnabled('*', true), /unsafe|not a Host alias/)
throws(
  'a host that is only in a comment is refused',
  () => hosts.setHostEnabled('never-enabled', true),
  /not a Host alias/,
)

hosts.setHostEnabled('vps', true)
manager.invalidateCapabilities()
check('an enabled alias becomes authorized', hosts.isAuthorizedHost('vps'))
check('every other alias stays out', !hosts.isAuthorizedHost('laptop'))

throws('the gate still refuses an unenabled alias', () => hosts.assertAuthorizedHost('laptop'), /not enabled/)
// The new surfaces go through the same gate, or they are a hole in it.
throws('checking an unenabled host is refused', () => manager.checkHost('laptop'), /not enabled/)
throws(
  'a harness preference about an unenabled host is refused',
  () => manager.setHarnessEnabled('laptop', 'commandcode', false),
  /not enabled/,
)

/* ------------------------------------------------------------------ */
/* 2 · A host that does not answer says why                            */
/* ------------------------------------------------------------------ */

const control = (state: Record<string, unknown>): void =>
  writeFileSync(join(sandbox, 'control.json'), JSON.stringify(state))

control({ down: ['vps'] })
const down = manager.checkHost('vps')
check('an unreachable host is not left blank', down.reach !== null, down)
check('and the failure is typed', down.reach === 'unreachable', down.reach)
check('with a line worth reading', Boolean(down.detail && down.detail.length > 8), down.detail)
check('and a timestamp, so "never checked" stays a third state', typeof down.checkedAt === 'number')

const listed = manager.hostStatusList()
check('the status list covers every candidate', listed.length === hosts.sshConfigHosts().length, listed.length)
check(
  'a host nobody checked reports null, not ok',
  listed.find((item) => item.host === 'laptop')?.reach === null,
)
check('and it is marked as not enabled', listed.find((item) => item.host === 'laptop')?.enabled === false)

// An unreachable machine must not read as "nothing is installed there".
const downCaps = await manager.capabilities('vps', true)
check('an unreachable catalog carries the reason', Boolean(downCaps.probeError), downCaps.probeError)

control({})
const up = manager.checkHost('vps')
check('a host that answers is ok', up.reach === 'ok', up)

/* ------------------------------------------------------------------ */
/* 3 · Detected here, chosen here                                      */
/* ------------------------------------------------------------------ */

const local = await manager.capabilities(null, true)
check('the local catalog found the fake cmd', harnessIn(local, 'commandcode')?.installed === true)
check('and opencode beside it', harnessIn(local, 'opencode')?.installed === true)
check('and did not invent claude', harnessIn(local, 'claude')?.installed === false)
check('everything installed is offered by default', harnessIn(local, 'commandcode')?.enabled === true)

manager.setHarnessEnabled(null, 'commandcode', false)
const hidden = await manager.capabilities(null, true)
check('a hidden harness is published as hidden', harnessIn(hidden, 'commandcode')?.enabled === false)
check('its neighbour is untouched', harnessIn(hidden, 'opencode')?.enabled === true)
// The row stays: a client hiding it still needs the models and approval modes
// for a session that is already running it, and Settings needs it to undo.
check('and the row is still there to turn back on', Boolean(harnessIn(hidden, 'commandcode')))
check(
  'with its approval modes intact',
  (harnessIn(hidden, 'commandcode')?.permissionModes ?? []).length > 0,
  harnessIn(hidden, 'commandcode')?.permissionModes,
)

/* The preference is about one machine, not about the harness. */
const remote = await manager.capabilities('vps', true)
check('the same harness on another machine is unaffected', harnessIn(remote, 'commandcode')?.enabled === true)

manager.setHarnessEnabled('vps', 'opencode', false)
check(
  'and hiding it there does not hide it here',
  harnessIn(await manager.capabilities(null, true), 'opencode')?.enabled === true,
)
check(
  'while it is hidden there',
  harnessIn(await manager.capabilities('vps', true), 'opencode')?.enabled === false,
)

throws('an id no build knows is refused', () => manager.setHarnessEnabled(null, 'nonesuch' as never, false), /unknown harness/)

/* It survives the process: the preference is in the store, not in a variable. */
const restart = Bun.spawnSync(
  [
    process.execPath,
    '-e',
    `const r = await import(${JSON.stringify(join(import.meta.dir, '..', 'apps/server/src/harnesses/registry.ts'))});` +
      `console.log(JSON.stringify({ local: r.isHarnessEnabled(null, 'commandcode'), remote: r.isHarnessEnabled('vps', 'opencode'), other: r.isHarnessEnabled('vps', 'commandcode') }))`,
  ],
  { env: process.env, stdout: 'pipe', stderr: 'pipe' },
)
const afterRestart = JSON.parse(restart.stdout.toString().trim() || '{}') as Record<string, boolean>
check('the preference survives a restart', afterRestart.local === false, restart.stderr.toString())
check('per machine, after a restart too', afterRestart.remote === false && afterRestart.other === true, afterRestart)

/* ------------------------------------------------------------------ */
/* 4 · Hiding a harness does not touch a session using it              */
/* ------------------------------------------------------------------ */

manager.setHarnessEnabled(null, 'commandcode', true)
const session = await manager.createSession({ harness: 'commandcode', kind: 'agent', cwd: workspace })
const first = await manager.sendMessage(session.id, 'hello')
check('the session took its first prompt', first.ok === true, first)
await waitFor(() => manager.getSession(session.id)?.status === 'idle', 'the first turn to finish')
const before = manager.getSession(session.id)!
const eventsBefore = db.loadEvents(session.id).length

manager.setHarnessEnabled(null, 'commandcode', false)

const after = manager.getSession(session.id)
check('the session is still there', Boolean(after))
check('still on its own harness', after?.harness === 'commandcode')
check('with its native id', after?.nativeId === before.nativeId, { before: before.nativeId, after: after?.nativeId })
check('and its status untouched', after?.status === before.status)
check('and every event still in the store', db.loadEvents(session.id).length === eventsBefore)

// And it must still *work*: a preference about a picker is not a kill switch.
const sent = await manager.sendMessage(session.id, 'again')
check('a hidden harness still accepts a prompt', sent.ok === true, sent)
// Only waited on when it was accepted: a refused prompt is already a failure
// above, and hanging twenty seconds on it would hide the rest of the report.
if (sent.ok) await waitFor(() => manager.getSession(session.id)?.status === 'idle', 'the second turn to finish')
check('and finishes it', db.loadEvents(session.id).length > eventsBefore)

manager.removeSession(session.id)
manager.setHarnessEnabled(null, 'commandcode', true)

/* ------------------------------------------------------------------ */
/* 5 · Dictation describes this machine, and a click changes something */
/* ------------------------------------------------------------------ */

const encoded = audio.wavBlob([new Float32Array(48_000).fill(0.25)], 48_000)
const encodedBytes = new Uint8Array(await encoded.arrayBuffer())
const encodedView = new DataView(encodedBytes.buffer)
check('the microphone encoder emits WAV', new TextDecoder().decode(encodedBytes.slice(0, 4)) === 'RIFF')
check('the microphone encoder emits mono PCM', encodedView.getUint16(22, true) === 1)
check('the microphone encoder emits 16 kHz', encodedView.getUint32(24, true) === 16_000)
check('one second stays one second after resampling', encodedView.getUint32(40, true) === 16_000 * 2)

const initial = await transcribe.resolveVoice(true)
check('the engines are reported at all', (initial.engines ?? []).length === 2, initial.engines?.length)
const whisper = initial.engines?.find((engine) => engine.id === 'whisper-cli')
const server = initial.engines?.find((engine) => engine.id === 'openai')
check('whisper is found because it is really there', whisper?.ready === true, whisper)
check('with the model files that are really on disk', (whisper?.models ?? []).length === 2, whisper?.models)
check(
  'best model first',
  whisper?.models?.[0]?.label === 'ggml-large-v3-turbo-q5_0.bin',
  whisper?.models?.map((m) => m.label),
)
check('the model sizes are real', (whisper?.models?.[0]?.bytes ?? 0) === 2048, whisper?.models?.[0]?.bytes)
check('no speech server is running, and it says so', server?.ready === false, server)
check('and says what is missing rather than nothing', Boolean(server?.missing), server)

// The bug, exactly: `auto` resolved to whisper-cli, and the panel read the
// resolved value — so the selected button was never the button that was pressed.
check('what was chosen is reported apart from what it resolved to', initial.configured === 'auto', initial.configured)
check('while the resolution is whisper', initial.provider === 'whisper-cli', initial.provider)

transcribe.setConfig({ provider: 'openai' })
const chosen = await transcribe.resolveVoice(true)
check('an old server choice without an endpoint migrates to on-device', chosen.configured === 'auto', chosen.configured)
check('and cannot disable working local dictation', chosen.provider === 'whisper-cli' && chosen.ready, chosen)

transcribe.setConfig({ provider: 'whisper-cli' })
const back = await transcribe.resolveVoice(true)
check('choosing whisper explicitly works', back.configured === 'whisper-cli' && back.ready === true, back)

const small = whisper?.models?.find((model) => model.label === 'ggml-small.bin')
check('the smaller model is one of the offered files', Boolean(small), whisper?.models)
if (small) {
  transcribe.setConfig({ model: small.path })
  const picked = await transcribe.resolveVoice(true)
  check('picking a model file takes effect', picked.model === small.path, picked.model)

  // The composer now sends PCM WAV directly. This call is fully hermetic — the
  // fake above is the only executable it can reach — and fails if ffmpeg has
  // crept back into the required path.
  const wav = new Uint8Array(44 + 1600 * 2)
  wav.set(new TextEncoder().encode('RIFF'), 0)
  wav.set(new TextEncoder().encode('WAVE'), 8)
  const spoken = await transcribe.transcribe(wav, 'audio/wav')
  check('a WAV transcribes without ffmpeg or a speech server', spoken === 'fake whisper transcript', spoken)
  const whisperArgs = (await Bun.file(join(sandbox, 'whisper-args')).text()).split('\n')
  check('the selected model reaches whisper-cli', whisperArgs.includes(small.path), whisperArgs)
}

// A model that is not on this machine is not silently accepted as the one in use.
transcribe.setConfig({ model: '/nowhere/ggml-imaginary.bin' })
const imaginary = await transcribe.resolveVoice(true)
check('a model that is not there is not reported as in use', imaginary.model !== '/nowhere/ggml-imaginary.bin', imaginary.model)
transcribe.setConfig({ model: '' })

throws(
  'an engine nobody implements is refused',
  () => transcribe.setConfig({ provider: 'telepathy' as never }),
  /unknown dictation engine/,
)
check('and the stored choice is unchanged', transcribe.config().provider === 'whisper-cli')

transcribe.setConfig({ provider: 'auto' })

/* ------------------------------------------------------------------ */
/* 6 · The same, over HTTP, where the cache actually bites             */
/* ------------------------------------------------------------------ */

/**
 * The half of "I click and nothing changes" that only exists at the boundary.
 *
 * `Capabilities` is what the panel reads, it is cached for twenty seconds per
 * machine, and changing the dictation settings used to leave that cache alone —
 * so the very next read handed the panel the answer from before the click and it
 * drew the old engine straight back over the new one. Proving that needs a real
 * server with a real cache, and a read that does *not* force a rescan, because
 * forcing one is exactly what hides the bug.
 */
const { startApi, runCleanups } = await import('./lib/harness.ts')
const api = await startApi({})

const json = async (path: string, init?: RequestInit): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${api.url}${path}`, init)
  return { status: response.status, body: await response.json().catch(() => ({})) }
}
const post = (path: string, payload: unknown) =>
  json(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })

/**
 * Wait until the catalog stops moving on its own.
 *
 * A harness whose model list is unknown is asked in the background, and its
 * answer drops the whole cache — which would invalidate it for us and make the
 * assertion below pass without the code under test doing anything. Two identical
 * reads in a row mean that settling is over and the next invalidation can only
 * be the one the change causes.
 */
let previous = ''
let primed = await json('/api/caps')
for (let attempt = 0; attempt < 40; attempt += 1) {
  const now = JSON.stringify(primed.body.harnesses)
  if (now === previous) break
  previous = now
  await Bun.sleep(250)
  primed = await json('/api/caps')
}
check('the served catalog reports the configured engine', primed.body.voice?.configured === 'auto', primed.body.voice)

await post('/api/voice', { provider: 'openai' })
// No `force`: this is the read the panel does, against the cache the change has
// to have reached.
const afterChange = await json('/api/caps')
check(
  'and an unusable server choice cannot disable on-device dictation',
  afterChange.body.voice?.configured === 'auto' && afterChange.body.voice?.ready === true,
  afterChange.body.voice,
)
await post('/api/voice', { provider: 'auto' })

const rejectedProvider = await post('/api/voice', { provider: 'telepathy' })
check('an unknown engine is refused at the boundary', rejectedProvider.status === 400, rejectedProvider)

/* The allowlist, at the boundary too. */
const bogus = await post('/api/hosts', { host: 'nowhere.example', enabled: true })
check('a host nobody declared is refused over HTTP', bogus.status === 400, bogus)
const unsafe = await post('/api/hosts', { host: '-oProxyCommand=id', enabled: true })
check('and so is an ssh option shaped like a name', unsafe.status === 400, unsafe)
const uncheckable = await post('/api/host-check', { host: 'laptop' })
check('checking a host nobody enabled is refused over HTTP', uncheckable.status === 400, uncheckable)
const checked = await post('/api/host-check', { host: 'vps' })
check('while an enabled one answers with a typed state', checked.body.reach === 'ok', checked.body)

await runCleanups()

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

for (const line of passed) console.log(`  ok  ${line}`)
if (failures.length) {
  console.error(`\nsettings-test: ${failures.length} failure(s)`)
  for (const line of failures) console.error(`  ✗ ${line}`)
  process.exit(1)
}
console.log(`\nsettings-test: ${passed.length} checks passed`)
process.exit(0)
