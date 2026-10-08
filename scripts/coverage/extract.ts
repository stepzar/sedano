#!/usr/bin/env bun
/**
 * Regenerate or verify the protocol inventories (see
 * `apps/server/src/harnesses/coverage/extract.ts` for what each one is derived
 * from). Network: `npm view` / `npm pack` only — no install, no scripts, no keys.
 *
 *   bun scripts/coverage/extract.ts --write                 pinned versions
 *   bun scripts/coverage/extract.ts --latest --write        latest published
 *   bun scripts/coverage/extract.ts --harness claude --version 0.3.281 --write
 *   bun scripts/coverage/extract.ts --verify                pinned → committed
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import {
  INVENTORY_DIR,
  SOURCES,
  inventoryFor,
  inventoryPath,
  latestVersion,
  readInventory,
  type CoverageHarness,
} from '../../apps/server/src/harnesses/coverage/extract.ts'

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

{
  const args = process.argv.slice(2)
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name)
    return index >= 0 ? args[index + 1] : undefined
  }
  const only = option('--harness') as CoverageHarness | undefined
  const harnesses = only ? [only] : (Object.keys(SOURCES) as CoverageHarness[])
  let failed = false
  for (const harness of harnesses) {
    const source = SOURCES[harness]
    const version = option('--version') ?? (args.includes('--latest') ? await latestVersion(source.package) : source.pinned)
    const inventory = await inventoryFor(harness, version)
    if (args.includes('--verify')) {
      const committed = readInventory(harness)
      const same = committed.version === inventory.version && JSON.stringify(committed.types) === JSON.stringify(inventory.types)
      console.log(`${same ? 'ok  ' : 'DIFF'} ${harness} ${source.package}@${version}: ${inventory.types.length} types`)
      if (!same) failed = true
      continue
    }
    if (args.includes('--write')) mkdirSync(INVENTORY_DIR, { recursive: true })
    if (args.includes('--write')) writeFileSync(inventoryPath(harness), `${JSON.stringify(inventory, null, 2)}\n`)
    console.log(`${harness} ${source.package}@${version}: ${inventory.types.length} types${args.includes('--write') ? ' (written)' : ''}`)
  }
  process.exit(failed ? 1 : 0)
}

