#!/usr/bin/env bun
/**
 * `check:coverage` — nothing a harness can send goes unaccounted for.
 *
 * Three things, all offline:
 *   1. Every type in each committed inventory (`apps/server/src/harnesses/
 *      coverage/<protocol>.inventory.json`, derived from the harness' own
 *      published schema by `scripts/coverage/extract.ts`) has a mapping entry:
 *      `handled` with where, or `ignored` with why. A `handled` entry names a
 *      file that exists and mentions the type.
 *   2. The extractors are deterministic and correct on small fixtures shaped like the
 *      pinned sources (the full packages are verified against the committed
 *      inventories by `extract.ts --verify`, which needs the registry and runs
 *      in the daily coverage workflow).
 *   3. At runtime an unmapped type is recorded once and a mapped one is not.
 *
 * With `COVERAGE_REPORT=<file>` it writes the unmapped types as JSON, which is
 * what the scheduled workflow turns into a GitHub issue.
 *
 *   bun scripts/coverage-test.ts
 */
import './lib/isolate.ts'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const failures: string[] = []
const passed: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) passed.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const ROOT = join(import.meta.dir, '..')
const COVERAGE = join(ROOT, 'apps', 'server', 'src', 'harnesses', 'coverage')
const HARNESSES_DIR = join(ROOT, 'apps', 'server', 'src', 'harnesses')
const extractors = await import('../apps/server/src/harnesses/coverage/extract.ts')

/* 1 · Every inventory type is mapped */

const report: Array<{ protocol: string; package: string; version: string; unmapped: string[] }> = []
for (const protocol of ['claude', 'acp', 'commandcode'] as const) {
  const inventory = JSON.parse(readFileSync(join(COVERAGE, `${protocol}.inventory.json`), 'utf8')) as {
    package: string
    version: string
    types: string[]
  }
  const mapping = JSON.parse(readFileSync(join(COVERAGE, `${protocol}.mapping.json`), 'utf8')) as Record<
    string,
    { handled?: string; ignored?: string; generic?: string }
  >
  const unmapped = inventory.types.filter((key) => !(key in mapping))
  report.push({ protocol, package: inventory.package, version: inventory.version, unmapped })
  check(`${protocol}: every type of ${inventory.package}@${inventory.version} is mapped`, unmapped.length === 0, unmapped)
  const sources = new Map<string, string>()
  for (const [key, entry] of Object.entries(mapping)) {
    const handled = typeof entry.handled === 'string' && entry.handled.trim() !== ''
    const ignored = typeof entry.ignored === 'string' && entry.ignored.trim() !== ''
    check(`${protocol}: ${key} is either handled (where) or ignored (why)`, handled !== ignored, entry)
    if (!handled) continue
    const file = entry.handled!.split(':')[0]!.trim()
    const path = join(HARNESSES_DIR, file)
    check(`${protocol}: ${key} is handled in a file that exists (${file})`, existsSync(path))
    if (!existsSync(path)) continue
    if (!sources.has(path)) sources.set(path, readFileSync(path, 'utf8'))
    // `generic`: one code path serves every value of this kind, and says so.
    if (entry.generic) continue
    const leaf = key.split(/[:/]/).at(-1)!
    check(`${protocol}: ${file} mentions ${leaf}`, sources.get(path)!.includes(leaf), key)
  }
  const stale = Object.keys(mapping).filter((key) => !inventory.types.includes(key))
  if (stale.length) console.log(`   · ${protocol}: ${stale.length} mapping entries no longer in the inventory: ${stale.join(', ')}`)
}

/* 2 · The extractors, on hand-written fixtures shaped like the pinned sources (the ACP one is an excerpt of its Apache-2.0 schema) */

const fixture = (name: string): string => readFileSync(join(import.meta.dir, 'fixtures', 'coverage', name), 'utf8')
const claude = extractors.extractClaude(fixture('claude-sdk-fixture.d.ts'))
check(
  'claude: the SDKMessage union is read member by member, result aliases included',
  JSON.stringify(claude) ===
    JSON.stringify([
      'stream:assistant',
      'stream:rate_limit_event',
      'stream:result/error_during_execution',
      'stream:result/error_max_budget_usd',
      'stream:result/error_max_structured_output_retries',
      'stream:result/error_max_turns',
      'stream:result/success',
      'stream:system/api_retry',
    ]),
  claude,
)
const acp = extractors.extractAcp(fixture('acp-schema-excerpt.json'))
check('acp: every session/update variant is listed', acp.includes('update:tool_call_update') && acp.includes('update:usage_update'), acp)
check('acp: a method the client answers is listed, one the agent answers is not', acp.includes('method:fs/read_text_file') && !acp.includes('method:session/prompt'), acp)
check('acp: tool kinds and stop reasons are listed', acp.includes('toolKind:execute') && acp.includes('stopReason:refusal'), acp)
const commandcode = extractors.extractCommandCode(fixture('commandcode-fixture.mjs'))
check(
  'commandcode: emitted, switched-on and case-labelled events are listed; a UI dispatch is not',
  JSON.stringify(commandcode) ===
    JSON.stringify(['event:run_start', 'event:tool_completed', 'event:tool_running', 'event:turn_end', 'frame:event', 'frame:result', 'result:error', 'result:max_turns', 'result:success']),
  commandcode,
)
check(
  'the extractors are deterministic',
  JSON.stringify(extractors.extractClaude(fixture('claude-sdk-fixture.d.ts'))) === JSON.stringify(claude)
    && JSON.stringify(extractors.extractAcp(fixture('acp-schema-excerpt.json'))) === JSON.stringify(acp),
)

/* 3 · Runtime: an unmapped type is recorded once, a mapped one never */

const coverage = await import('../apps/server/src/harnesses/coverage.ts')
coverage.noteProtocol('claude', 'claude', 'stream:result/success')
coverage.noteProtocol('claude', 'claude', 'stream:system/brand_new_thing')
coverage.noteProtocol('claude', 'claude', 'stream:system/brand_new_thing')
const seen = coverage.unhandledEvents()
check('a mapped type is not recorded', !seen.some((event) => event.key === 'stream:result/success'), seen)
const fresh = seen.find((event) => event.key === 'stream:system/brand_new_thing')
check('an unmapped type is recorded once, and counted', fresh?.count === 2 && fresh.source === 'live', fresh)
check('the Claude frame key is built like the inventory key', coverage.claudeStreamKey({ type: 'system', subtype: 'api_retry' }) === 'stream:system/api_retry')

if (process.env.COVERAGE_REPORT) writeFileSync(process.env.COVERAGE_REPORT, `${JSON.stringify(report, null, 2)}\n`)

for (const label of passed.slice(-8)) console.log(`   ✓ ${label}`)
if (failures.length) {
  for (const label of failures) console.error(`   ✗ ${label}`)
  console.error(`coverage-test: FAILED (${failures.length} failed, ${passed.length} passed)`)
  process.exit(1)
}
console.log(`coverage-test: PASSED (${passed.length} checks)`)
process.exit(0)
