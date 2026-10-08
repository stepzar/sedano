import type { Adapter, CreateOptions, Driver, DriverHooks, ModelInfo } from '../types.ts'
import { ClaudeDriver } from './session.ts'
import { Transport, shq } from '../../transport.ts'
import { which } from '../../which.ts'
import { guessContextWindow } from '../../metrics.ts'

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const FAMILY = ['opus', 'sonnet', 'haiku', 'fable'] as const
type ClaudeFamily = (typeof FAMILY)[number]
type ClaudeVersions = Partial<Record<ClaudeFamily, string>>

/** Last version names read from each machine's installed Claude Code binary. */
const versionsByMachine = new Map<string, ClaudeVersions>()
const scannedAt = new Map<string, number>()
const SCAN_TTL_MS = 60_000

function versionParts(value: string): number[] {
  return value.split('.').map((part) => Number(part))
}

function newer(left: string, right: string): boolean {
  const a = versionParts(left)
  const b = versionParts(right)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference) return difference > 0
  }
  return false
}

/**
 * Read the concrete family versions known by this Claude Code build.
 *
 * Claude exposes aliases rather than a model-list command. Its self-contained
 * binary still carries the concrete model ids those aliases can resolve to;
 * reading those strings is local, token-free and follows installed CLI updates.
 */
export function parseClaudeModelVersions(output: string): ClaudeVersions {
  const found: ClaudeVersions = {}
  const pattern = /\bclaude-(opus|sonnet|haiku|fable)-(\d+(?:-\d+)*)\b/gi
  for (const match of output.matchAll(pattern)) {
    const family = match[1]!.toLowerCase() as ClaudeFamily
    const parts = match[2]!.split('-')
    if (/^(19|20)\d{6}$/.test(parts.at(-1) ?? '')) parts.pop()
    const version = `${Number(parts[0])}.${Number(parts[1] ?? 0)}`
    if (!found[family] || newer(version, found[family]!)) found[family] = version
  }
  return found
}

function familyLabel(family: ClaudeFamily, versions: ClaudeVersions): string {
  const name = family.charAt(0).toUpperCase() + family.slice(1)
  return versions[family] ? `${name} ${versions[family]}` : name
}

function nativeMillion(family: ClaudeFamily, versions: ClaudeVersions): boolean {
  const version = versions[family]
  return Boolean(version) && guessContextWindow(`claude-${family}-${version!.replace('.', '-')}`) === 1_000_000
}

export function modelsForVersions(versions: ClaudeVersions): ModelInfo[] {
  const adjustable = (id: string, label: string): ModelInfo => ({
    id,
    label,
    images: true,
    efforts: CLAUDE_EFFORTS,
  })
  // A family whose current model already runs 1M natively gets one row that
  // says so: next to a "· 1M" twin, plain "Opus 5.5" read as the 200k one,
  // though the CLI runs both at 1M. The `[1m]` row stays only where it changes
  // something, or where the version (and so the window) is not known.
  const rows = (family: 'opus' | 'fable'): ModelInfo[] =>
    nativeMillion(family, versions)
      ? [adjustable(family, `${familyLabel(family, versions)} · 1M (latest)`)]
      : [
          adjustable(`${family}[1m]`, `${familyLabel(family, versions)} · 1M (latest)`),
          adjustable(family, `${familyLabel(family, versions)} (latest)`),
        ]
  const sonnetWindow = nativeMillion('sonnet', versions) ? ' · 1M' : ''
  return [
    { id: '', label: 'Default (from Settings)', isDefault: true, efforts: CLAUDE_EFFORTS },
    ...rows('opus'),
    adjustable('sonnet', `${familyLabel('sonnet', versions)}${sonnetWindow} (latest)`),
    { id: 'haiku', label: `${familyLabel('haiku', versions)} (latest)`, images: true, efforts: [] },
    ...rows('fable'),
  ]
}

async function binaryStrings(bin: string): Promise<string> {
  const proc = Bun.spawn(['strings', bin], { stdout: 'pipe', stderr: 'ignore' })
  const output = await new Response(proc.stdout).text()
  const code = await proc.exited
  return code === 0 ? output : ''
}

async function refreshClaudeModels(host: string | null, force = false): Promise<void> {
  const key = host ?? ''
  if (!force && Date.now() - (scannedAt.get(key) ?? 0) < SCAN_TTL_MS) return
  const transport = new Transport(host)
  const bin = host ? transport.which('claude') : which('claude')
  if (!bin) return
  // On a host only the model ids travel. The whole `strings` of the binary is
  // ~50MB, and this is a synchronous ssh call: shipping it held the event loop
  // for up to the full timeout, and a slow link cut it off with nothing parsed.
  const output = host
    ? transport.exec(
        `strings ${shq(bin)} | grep -oiE 'claude-(opus|sonnet|haiku|fable)-[0-9]+(-[0-9]+)*' | sort -u`,
        { timeoutMs: 20_000 },
      ).stdout ?? ''
    : await binaryStrings(bin)
  const parsed = parseClaudeModelVersions(output)
  if (Object.keys(parsed).length) versionsByMachine.set(key, parsed)
  scannedAt.set(key, Date.now())
}

async function detectClaude(): Promise<{ bin: string | null; version: string | null }> {
  const bin = which('claude')
  if (!bin) return { bin: null, version: null }
  try {
    const proc = Bun.spawn([bin, '--version'], { stdout: 'pipe', stderr: 'ignore' })
    const out = (await new Response(proc.stdout).text()).trim()
    await proc.exited
    await refreshClaudeModels(null)
    return { bin, version: out || null }
  } catch {
    return { bin, version: null }
  }
}

export const claudeAdapter: Adapter = {
  id: 'claude',
  label: 'Claude Code',
  images: true,

  async detect() {
    const { bin, version } = await detectClaude()
    return { available: bin !== null, bin, version }
  },

  // Stable aliases, labelled with concrete versions known by that machine's
  // installed CLI. The session still records what the runtime actually used.
  models: (host) => modelsForVersions(versionsByMachine.get(host ?? '') ?? {}),

  async refreshModels(host) {
    await refreshClaudeModels(host, true)
  },

  async create(opts: CreateOptions, hooks: DriverHooks): Promise<Driver> {
    // On a host the binary lives on the host, so it is resolved there; the local
    // `which` says nothing about what that machine has installed.
    if (opts.host) {
      const bin = new Transport(opts.host).which('claude')
      if (!bin) throw new Error(`claude CLI not found on ${opts.host}`)
      const driver = new ClaudeDriver(opts, hooks, bin)
      await driver.start()
      return driver
    }
    const { bin } = await detectClaude()
    if (!bin) throw new Error('claude CLI not found in PATH')
    const driver = new ClaudeDriver(opts, hooks, bin)
    await driver.start()
    return driver
  },
}
