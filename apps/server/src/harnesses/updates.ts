import type { HarnessId, HarnessUpdateInfo } from '@shared'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { Transport, shq } from '../transport.ts'

interface NpmUpdateSpec {
  bin: string
  packageName: string
  updateCommand: string
}

/**
 * External harness executables Sedano can check without changing the machine.
 * The package name is intentionally explicit: guessing it from a binary name
 * is how `codex-acp` would accidentally check the Codex CLI instead of the
 * bridge that actually owns the protocol connection.
 */
const UPDATE_SPECS: Partial<Record<HarnessId, NpmUpdateSpec>> = {
  claude: { bin: 'claude', packageName: '@anthropic-ai/claude-code', updateCommand: 'claude update' },
  commandcode: { bin: 'cmd', packageName: 'command-code', updateCommand: 'npm install -g command-code@latest' },
  codex: {
    bin: 'codex-acp',
    packageName: '@agentclientprotocol/codex-acp',
    updateCommand: 'npm install -g @agentclientprotocol/codex-acp@latest',
  },
  opencode: {
    bin: 'opencode',
    packageName: 'opencode-ai',
    // Non-npm installations use the vendor updater. For an npm installation we
    // target the binary's own prefix: GUI shells often default to /usr/local.
    updateCommand: 'opencode upgrade',
  },
  gemini: {
    bin: 'gemini',
    packageName: '@google/gemini-cli',
    updateCommand: 'npm install -g @google/gemini-cli@latest',
  },
  freebuff: { bin: 'freebuff', packageName: 'freebuff', updateCommand: 'npm install -g freebuff@latest' },
}

const CODEX_CLI: NpmUpdateSpec = {
  bin: 'codex',
  packageName: '@openai/codex',
  updateCommand: 'npm install -g @openai/codex@latest',
}

/** Match npm's target to the installed binary, even when a GUI has a system npm on PATH. */
export function npmPrefixFromRealpath(path: string): string | null {
  const marker = '/lib/node_modules/'
  const index = path.indexOf(marker)
  return index > 0 ? path.slice(0, index) : null
}

/*
 * Everything below asks the machine through the transport's async calls. The
 * sync ones ran `npm view` (a registry round trip, up to 15 s), `--version`
 * and `which` on the event loop — over ssh for a host, and still a network
 * call for this machine — so a background sweep against a slow or unreachable
 * machine froze every socket and stream for the whole of it.
 */
async function npmInstallation(transport: Transport, bin: string): Promise<{ npm: string; prefix: string } | null> {
  let path: string | null = null
  if (transport.remote) {
    const resolved = await transport.execAsync('realpath ' + shq(bin), { timeoutMs: 8000, retries: 1 })
    if (!resolved.error) path = resolved.stdout.trim()
  } else {
    try { path = realpathSync(bin) } catch { /* no installation to update */ }
  }
  const prefix = path ? npmPrefixFromRealpath(path) : null
  if (!prefix) return null
  const sibling = join(prefix, 'bin', 'npm')
  const npm = (await transport.execAsync('test -x ' + shq(sibling), { timeoutMs: 5000 })).code === 0
    ? sibling : await transport.whichAsync('npm')
  return npm ? { npm, prefix } : null
}

function installCommand(npm: string, prefix: string, packageName: string): string {
  // npm's shebang uses `env node`. Put the Node beside this installation first,
  // even when the desktop app inherited a system PATH instead of nvm's PATH.
  return 'PATH=' + shq(join(prefix, 'bin')) + ':"$PATH"; export PATH; ' +
    shq(npm) + ' install --global --prefix ' + shq(prefix) + ' ' + shq(packageName + '@latest')
}

/** Keep the HTTP/WebSocket server responsive while a package manager runs. */
async function runUpdate(transport: Transport, command: string, harness: HarnessId): Promise<void> {
  const procTag = transport.remote ? `update-${harness}-${Date.now()}` : undefined
  const proc = transport.spawn('sh', ['-lc', command], { stdin: 'ignore', procTag })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    proc.kill()
    // Off a timer: the synchronous cleanup was one more ssh round trip on the loop.
    if (procTag) void transport.cleanupRemoteAsync(procTag)
  }, 180_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (timedOut) throw new Error(`Could not update ${harness}: timed out after 180 seconds`)
    if (code !== 0) throw new Error(`Could not update ${harness}: ${stderr.trim() || stdout.trim() || `exited ${code}`}`)
  } finally {
    clearTimeout(timer)
  }
}

const CACHE_MS = 5 * 60_000
const cache = new Map<string, { at: number; value: HarnessUpdateInfo }>()
const updating = new Map<string, Promise<HarnessUpdateInfo>>()

function versionOf(text: string): string | null {
  return text.match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)?.[1] ?? null
}

function newer(latest: string, installed: string): boolean {
  const tuple = (value: string): number[] => value.split('-', 1)[0]!.split('.').map((part) => Number(part) || 0)
  const left = tuple(latest)
  const right = tuple(installed)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0)
  }
  return false
}

function unknown(detail: string, installedVersion: string | null = null): HarnessUpdateInfo {
  return {
    status: 'unknown',
    installedVersion,
    latestVersion: null,
    updateCommand: null,
    detail,
    checkedAt: Date.now(),
  }
}

async function inspectNpm(host: string | null, spec: NpmUpdateSpec): Promise<HarnessUpdateInfo> {
  const transport = new Transport(host)
  const bin = await transport.whichAsync(spec.bin)
  if (!bin) return unknown(`${spec.bin} is not installed on ${host ?? 'this machine'}`)

  const installedResult = await transport.execAsync(`${shq(bin)} --version`, { timeoutMs: 10_000, retries: 1 })
  const installedVersion = versionOf(`${installedResult.stdout}\n${installedResult.stderr}`)
  if (!installedVersion) return unknown(`Could not read the installed ${spec.bin} version`)

  const npm = await transport.whichAsync('npm')
  if (!npm) return unknown(`npm is not installed, so ${spec.packageName} cannot be checked`, installedVersion)
  const latestResult = await transport.execAsync(
    `${shq(npm)} view ${shq(spec.packageName)} version --json`,
    { timeoutMs: 15_000, retries: 1 },
  )
  if (latestResult.error) {
    return unknown(`Could not check the latest ${spec.packageName} version: ${latestResult.error.reason}`, installedVersion)
  }
  const latestVersion = versionOf(latestResult.stdout)
  if (!latestVersion) return unknown(`The registry returned no version for ${spec.packageName}`, installedVersion)
  const available = newer(latestVersion, installedVersion)
  const selfUpdate = spec.updateCommand === 'opencode upgrade' || spec.updateCommand === 'claude update'
  const installation = available && (spec.updateCommand === 'opencode upgrade' || !selfUpdate)
    ? await npmInstallation(transport, bin) : null
  if (available && !selfUpdate && !installation) {
    return unknown(`Found ${latestVersion}, but could not identify the installation containing ${bin}`, installedVersion)
  }
  return {
    status: available ? 'available' : 'current',
    installedVersion,
    latestVersion,
    updateCommand: available
      ? installation
        ? installCommand(installation.npm, installation.prefix, spec.packageName)
        : `${shq(bin)} ${spec.updateCommand.split(' ')[1]}`
      : null,
    detail: available
      ? `${spec.packageName} ${installedVersion} is behind ${latestVersion}`
      : `${spec.packageName} ${installedVersion} is current`,
    checkedAt: Date.now(),
  }
}

async function inspectCodex(host: string | null): Promise<HarnessUpdateInfo> {
  const bridge = await inspectNpm(host, UPDATE_SPECS.codex!)
  const cli = await inspectNpm(host, CODEX_CLI)
  // The bridge owns ACP, but it delegates model availability to the CLI. Both
  // releases must be current for a refresh to expose new Codex models.
  if (!cli.installedVersion) return bridge
  if (bridge.status === 'unknown' || cli.status === 'unknown') {
    return unknown(`Codex update check incomplete: ${bridge.status === 'unknown' ? bridge.detail : cli.detail}`)
  }
  const available = bridge.status === 'available' || cli.status === 'available'
  return {
    status: available ? 'available' : 'current',
    installedVersion: `ACP ${bridge.installedVersion} · CLI ${cli.installedVersion}`,
    latestVersion: `ACP ${bridge.latestVersion} · CLI ${cli.latestVersion}`,
    updateCommand: available ? [bridge.updateCommand, cli.updateCommand].filter(Boolean).join(' && ') : null,
    detail: available ? 'Codex ACP or CLI has a newer release' : 'Codex ACP and CLI are current',
    checkedAt: Date.now(),
  }
}

async function inspectGrok(host: string | null): Promise<HarnessUpdateInfo> {
  const transport = new Transport(host)
  const bin = await transport.whichAsync('grok')
  if (!bin) return unknown(`grok is not installed on ${host ?? 'this machine'}`)
  const result = await transport.execAsync(`${shq(bin)} update --check --json`, { timeoutMs: 20_000, retries: 1 })
  if (result.error) return unknown(`Could not check Grok updates: ${result.error.reason}`)
  try {
    const parsed = JSON.parse(result.stdout) as {
      currentVersion?: string
      latestVersion?: string
      updateAvailable?: boolean
      error?: string | null
    }
    if (parsed.error) return unknown(parsed.error, parsed.currentVersion ?? null)
    return {
      status: parsed.updateAvailable ? 'available' : 'current',
      installedVersion: parsed.currentVersion ?? null,
      latestVersion: parsed.latestVersion ?? null,
      updateCommand: parsed.updateAvailable ? 'grok update' : null,
      detail: parsed.updateAvailable
        ? `Grok ${parsed.currentVersion ?? 'installed'} is behind ${parsed.latestVersion ?? 'the latest release'}`
        : `Grok ${parsed.currentVersion ?? ''} is current`.trim(),
      checkedAt: Date.now(),
    }
  } catch {
    return unknown('Grok returned an unreadable update status')
  }
}

/** Read-only update audit for one harness, cached briefly per machine. */
export async function checkHarnessUpdate(
  host: string | null,
  harness: HarnessId,
  force = false,
): Promise<HarnessUpdateInfo | null> {
  const key = `${host ?? ''}:${harness}`
  const prior = cache.get(key)
  if (!force && prior && Date.now() - prior.at < CACHE_MS) return prior.value
  const spec = UPDATE_SPECS[harness]
  const value = harness === 'codex'
    ? await inspectCodex(host)
    : spec
      ? await inspectNpm(host, spec)
    : harness === 'grok'
      ? await inspectGrok(host)
      : null
  if (value) cache.set(key, { at: Date.now(), value })
  return value
}

/**
 * Apply one known adapter update after an explicit UI action.
 *
 * The client sends only a harness id. Commands and package names remain in this
 * server-side allowlist, so this endpoint cannot be turned into a remote shell.
 * A selection never reaches here; selecting remains a read-only check.
 */
async function performHarnessUpdate(
  host: string | null,
  harness: HarnessId,
): Promise<HarnessUpdateInfo> {
  const before = await checkHarnessUpdate(host, harness, true)
  if (!before) throw new Error(`${harness} has no updater`)
  if (before.status !== 'available') return before

  const transport = new Transport(host)
  if (harness === 'codex') {
    const bridge = await inspectNpm(host, UPDATE_SPECS.codex!)
    const cli = await inspectNpm(host, CODEX_CLI)
    for (const [part, release] of [[UPDATE_SPECS.codex!, bridge], [CODEX_CLI, cli]] as const) {
      if (release.status !== 'available') continue
      const bin = await transport.whichAsync(part.bin)
      const installation = bin ? await npmInstallation(transport, bin) : null
      if (!installation) throw new Error(`Could not identify the npm installation containing ${part.bin}`)
      await runUpdate(transport, installCommand(installation.npm, installation.prefix, part.packageName), harness)
    }
    cache.delete(`${host ?? ''}:${harness}`)
    const after = await checkHarnessUpdate(host, harness, true)
    if (after?.status === 'available') throw new Error(`Codex update command finished, but ${after.detail}`)
    return after ?? unknown('Codex was updated but could not be checked')
  }
  let command: string
  const spec = UPDATE_SPECS[harness]
  if (harness === 'grok') {
    const bin = await transport.whichAsync('grok')
    if (!bin) throw new Error(`grok is not installed on ${host ?? 'this machine'}`)
    command = `${shq(bin)} update`
  } else if (spec?.updateCommand === 'opencode upgrade') {
    const bin = await transport.whichAsync(spec.bin)
    if (!bin) throw new Error(`${spec.bin} is not installed on ${host ?? 'this machine'}`)
    const installation = await npmInstallation(transport, bin)
    command = installation
      ? installCommand(installation.npm, installation.prefix, spec.packageName)
      : `${shq(bin)} upgrade`
  } else if (spec?.updateCommand === 'claude update') {
    const bin = await transport.whichAsync(spec.bin)
    if (!bin) throw new Error(`${spec.bin} is not installed on ${host ?? 'this machine'}`)
    command = `${shq(bin)} update`
  } else if (spec) {
    const bin = await transport.whichAsync(spec.bin)
    const installation = bin ? await npmInstallation(transport, bin) : null
    if (!installation) throw new Error(`Could not identify the npm installation containing ${spec.bin}`)
    command = installCommand(installation.npm, installation.prefix, spec.packageName)
  } else {
    throw new Error(`${harness} has no updater`)
  }

  // Updating is intentionally not retried: a lost connection after a package
  // manager changed files is not proof that running the mutation twice is safe.
  await runUpdate(transport, command, harness)
  cache.delete(`${host ?? ''}:${harness}`)
  const after = await checkHarnessUpdate(host, harness, true)
  if (after?.status === 'available') throw new Error(`${harness} update command finished, but ${after.detail}`)
  return after ?? unknown(`${harness} was updated but could not be checked`)
}

/** Share one update per installation across windows and requests. */
export function applyHarnessUpdate(host: string | null, harness: HarnessId): Promise<HarnessUpdateInfo> {
  const key = `${host ?? ''}:${harness}`
  const pending = updating.get(key)
  if (pending) return pending
  const work = performHarnessUpdate(host, harness)
  updating.set(key, work)
  void work.finally(() => updating.delete(key)).catch(() => undefined)
  return work
}
