/**
 * The protocol inventory of each harness, derived from the harness' own
 * source of truth — never from what our drivers happen to handle.
 *
 *   claude       `@anthropic-ai/claude-agent-sdk` → `sdk.d.ts`: every member of
 *                the `SDKMessage` union, as `type` or `type/subtype`. This is the
 *                published contract of `--output-format stream-json`.
 *   acp          `@agentclientprotocol/sdk` → `schema/schema.json`: every
 *                `session/update` variant, every method a *client* must answer
 *                (`x-side: client|both`), every tool kind, tool-call content
 *                type and stop reason. One schema for Codex, Gemini, OpenCode,
 *                Grok and every other ACP agent.
 *   commandcode  `command-code` → `dist/cli.mjs`: the NDJSON event vocabulary.
 *                There is no schema; the bundle is scanned for event types that
 *                are constructed (`{type:"x"`) and switched on (`"x"===e.type`,
 *                `case"x":`), or handed straight to the minified emitter
 *                (`s({type:"x"`). A deliberate superset — a false positive is
 *                one line in the mapping, a miss is a silent gap.
 *
 * Deterministic: the same package version always gives the same sorted list,
 * and the file records the package and version it came from (no timestamps).
 *
 * The CLI is `scripts/coverage/extract.ts`:
 *
 *   bun scripts/coverage/extract.ts --write                 pinned versions
 *   bun scripts/coverage/extract.ts --latest --write        latest published
 *   bun scripts/coverage/extract.ts --harness claude --version 0.3.281 --write
 *   bun scripts/coverage/extract.ts --verify                pinned → committed
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type CoverageHarness = 'claude' | 'acp' | 'commandcode'

export interface Inventory {
  harness: CoverageHarness
  package: string
  version: string
  extractor: string
  types: string[]
}

/** The package each inventory is derived from, and the file inside it. */
export const SOURCES: Record<CoverageHarness, { package: string; file: string; pinned: string }> = {
  claude: { package: '@anthropic-ai/claude-agent-sdk', file: 'sdk.d.ts', pinned: '0.3.281' },
  acp: { package: '@agentclientprotocol/sdk', file: 'schema/schema.json', pinned: '1.5.0' },
  commandcode: { package: 'command-code', file: 'dist/cli.mjs', pinned: '1.65.0' },
}

export const INVENTORY_DIR = import.meta.dir

/* ------------------------------------------------------------------ */
/* Extractors                                                          */
/* ------------------------------------------------------------------ */

/** The top-level (depth-one) text of an object type literal starting at `{`. */
function topLevel(text: string, open: number): string {
  let depth = 0
  let out = ''
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) break
    }
    if (depth === 1) out += char
  }
  return out
}

export function extractClaude(dts: string): string[] {
  const union = /export declare type SDKMessage = ([^;]+);/.exec(dts)
  if (!union) throw new Error('sdk.d.ts: no SDKMessage union')
  const types = new Set<string>()
  const visit = (name: string, depth = 0): void => {
    if (depth > 4) return
    const decl = new RegExp(`export declare type ${name} = `).exec(dts)
    if (!decl) throw new Error(`sdk.d.ts: ${name} is not declared`)
    const start = decl.index + decl[0].length
    if (dts[start] !== '{') {
      // An alias of a union (`SDKResultSuccess | SDKResultError`): its members.
      const alias = /^([^;]+);/.exec(dts.slice(start))?.[1] ?? ''
      for (const member of alias.split('|').map((item) => item.trim()).filter((item) => /^\w+$/.test(item))) visit(member, depth + 1)
      return
    }
    const body = topLevel(dts, start)
    // A literal or a union of literals: `subtype: 'a' | 'b'`.
    const literals = (field: string): string[] => {
      const found = new RegExp(`\\b${field}: ((?:'[^']+'\\s*\\|?\\s*)+)`).exec(body)?.[1] ?? ''
      return [...found.matchAll(/'([^']+)'/g)].map((match) => match[1]!)
    }
    const type = literals('type')[0]
    if (!type) return
    const subtypes = literals('subtype')
    if (subtypes.length === 0) types.add(`stream:${type}`)
    for (const subtype of subtypes) types.add(`stream:${type}/${subtype}`)
  }
  for (const member of union[1]!.split('|').map((item) => item.trim())) visit(member)
  return [...types].sort()
}

export function extractAcp(schemaText: string): string[] {
  const schema = JSON.parse(schemaText) as { $defs: Record<string, any> }
  const defs = schema.$defs
  const types = new Set<string>()
  const consts = (def: any, property?: string): string[] =>
    (def?.oneOf ?? def?.anyOf ?? [])
      .map((variant: any) => (property ? variant?.properties?.[property]?.const : variant?.const))
      .filter((value: unknown): value is string => typeof value === 'string')
  for (const value of consts(defs.SessionUpdate, 'sessionUpdate')) types.add(`update:${value}`)
  for (const value of consts(defs.ToolKind)) types.add(`toolKind:${value}`)
  for (const value of consts(defs.ToolCallContent, 'type')) types.add(`toolContent:${value}`)
  for (const value of consts(defs.ContentBlock, 'type')) types.add(`content:${value}`)
  for (const value of consts(defs.StopReason)) types.add(`stopReason:${value}`)
  for (const def of Object.values(defs)) {
    const method = def?.['x-method']
    const side = def?.['x-side']
    if (typeof method === 'string' && (side === 'client' || side === 'both')) types.add(`method:${method}`)
  }
  return [...types].sort()
}

export function extractCommandCode(bundle: string): string[] {
  const switched = new Set<string>()
  for (const match of bundle.matchAll(/"([a-z]+(?:_[a-z]+)+)"(?:===|!==)[a-zA-Z_$]{1,3}\.type\b/g)) switched.add(match[1]!)
  for (const match of bundle.matchAll(/\b[a-zA-Z_$]{1,3}\.type(?:===|!==)"([a-z]+(?:_[a-z]+)+)"/g)) switched.add(match[1]!)
  for (const match of bundle.matchAll(/\bcase"([a-z]+(?:_[a-z]+)+)":/g)) switched.add(match[1]!)
  const built = new Set<string>()
  for (const match of bundle.matchAll(/\{type:"([a-z]+(?:_[a-z]+)+)"/g)) built.add(match[1]!)
  const types = new Set<string>(['frame:event', 'frame:result', 'result:success', 'result:error', 'result:max_turns'])
  for (const type of switched) if (built.has(type)) types.add(`event:${type}`)
  // Emitted but never switched on inside the CLI (its NDJSON writer only
  // forwards them): an object literal handed straight to a short-named
  // function, which is how the minified run loop calls its `emit`.
  for (const match of bundle.matchAll(/\b[a-zA-Z_$]{1,2}\(\{type:"([a-z]+(?:_[a-z]+)+)"/g)) types.add(`event:${match[1]!}`)
  return [...types].sort()
}

export function extract(harness: CoverageHarness, source: string): string[] {
  if (harness === 'claude') return extractClaude(source)
  if (harness === 'acp') return extractAcp(source)
  return extractCommandCode(source)
}

/* ------------------------------------------------------------------ */
/* Fetching a published package                                        */
/* ------------------------------------------------------------------ */

/** `npm view <pkg> version` — the latest published version. */
export async function latestVersion(pkg: string): Promise<string> {
  const proc = Bun.spawn(['npm', 'view', pkg, 'version'], { stdout: 'pipe', stderr: 'pipe' })
  const out = (await new Response(proc.stdout).text()).trim()
  if ((await proc.exited) !== 0 || !out) throw new Error(`npm view ${pkg} failed`)
  return out
}

/** Download one published file (`npm pack`, no install, no scripts run). */
export async function fetchPackageFile(pkg: string, version: string, file: string): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'sedano-coverage-'))
  try {
    const pack = Bun.spawn(['npm', 'pack', `${pkg}@${version}`, '--silent'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    const tarball = (await new Response(pack.stdout).text()).trim().split('\n').at(-1) ?? ''
    if ((await pack.exited) !== 0 || !tarball) throw new Error(`npm pack ${pkg}@${version} failed`)
    const untar = Bun.spawn(['tar', 'xzf', tarball, `package/${file}`], { cwd: dir, stdout: 'ignore', stderr: 'pipe' })
    if ((await untar.exited) !== 0) throw new Error(`${pkg}@${version} has no ${file}`)
    return readFileSync(join(dir, 'package', file), 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function inventoryFor(harness: CoverageHarness, version: string): Promise<Inventory> {
  const source = SOURCES[harness]
  const text = await fetchPackageFile(source.package, version, source.file)
  return { harness, package: source.package, version, extractor: 'apps/server/src/harnesses/coverage/extract.ts', types: extract(harness, text) }
}

export function inventoryPath(harness: CoverageHarness): string {
  return join(INVENTORY_DIR, `${harness}.inventory.json`)
}

export function readInventory(harness: CoverageHarness): Inventory {
  return JSON.parse(readFileSync(inventoryPath(harness), 'utf8')) as Inventory
}
