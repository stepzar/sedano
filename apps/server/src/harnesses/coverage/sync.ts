/**
 * Keep the coverage contract current on this machine: when an installed
 * harness changes version, derive the inventory of *that* version from its
 * published package and record every type the mapping does not cover, so the
 * "Unhandled events" list names what a new release added before any session
 * meets it. Runs from the daily harness sweep; network is `npm view`/`npm pack`
 * only, and an offline machine simply tries again next sweep.
 */
import type { HarnessId } from '@shared'
import * as db from '../../db.ts'
import { noteProtocol, type CoverageProtocol } from '../coverage.ts'
import { SOURCES, fetchPackageFile, extract, latestVersion } from './extract.ts'

const KV_KEY = 'coverage.derived.v1'

/** Which protocol each harness speaks. Terminal presets speak none. */
const PROTOCOL: Partial<Record<HarnessId, CoverageProtocol>> = {
  claude: 'claude',
  commandcode: 'commandcode',
  codex: 'acp',
  gemini: 'acp',
  opencode: 'acp',
  grok: 'acp',
}

/** The package version that describes an installed harness version. */
async function packageVersion(protocol: CoverageProtocol, installed: string): Promise<string> {
  if (protocol === 'commandcode') return installed
  if (protocol === 'acp') return latestVersion(SOURCES.acp.package)
  // The Agent SDK is released with the CLI and shares its patch number
  // (CLI 2.1.281 ↔ SDK 0.3.281); the latest one stands in when there is none.
  const patch = installed.split('.').at(-1)
  const proc = Bun.spawn(['npm', 'view', SOURCES.claude.package, 'versions', '--json'], { stdout: 'pipe', stderr: 'ignore' })
  const versions = JSON.parse((await new Response(proc.stdout).text()) || '[]') as string[]
  await proc.exited
  return [...versions].reverse().find((version) => version.split('.').at(-1) === patch) ?? (await latestVersion(SOURCES.claude.package))
}

export async function refreshCoverage(installed: Partial<Record<HarnessId, string | null>>): Promise<void> {
  // Hermetic runs (the test suite scopes its PATH explicitly) and anyone who
  // opts out never reach the registry.
  if (process.env.SEDANO_EXPLICIT_PATH === '1' || process.env.SEDANO_COVERAGE_SYNC === '0') return
  let derived: Record<string, string> = {}
  try {
    derived = JSON.parse(db.kvGet(KV_KEY) ?? '{}') as Record<string, string>
  } catch {
    derived = {}
  }
  for (const [harness, version] of Object.entries(installed) as Array<[HarnessId, string | null]>) {
    const protocol = PROTOCOL[harness]
    const clean = version?.match(/\d+\.\d+\.\d+/)?.[0]
    if (!protocol || !clean) continue
    try {
      const pkgVersion = await packageVersion(protocol, clean)
      const seen = `${protocol}@${pkgVersion}`
      if (derived[harness] === seen) continue
      const source = SOURCES[protocol]
      const types = extract(protocol, await fetchPackageFile(source.package, pkgVersion, source.file))
      for (const key of types) noteProtocol(protocol, harness, key, { source: 'inventory', version: clean })
      derived[harness] = seen
      db.kvSet(KV_KEY, JSON.stringify(derived))
    } catch (err) {
      console.error(`sedano: could not refresh the ${harness} protocol inventory:`, err instanceof Error ? err.message : err)
    }
  }
}
