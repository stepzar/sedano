/**
 * A throwaway store, claimed before anything can open the real one.
 *
 * `paths.ts` reads `SEDANO_HOME` once, at import time, and several server
 * modules touch the store as a side effect of being imported at all. A test that
 * sets the variable in its own body is already too late: ES imports are hoisted,
 * so the module graph — and with it `~/.sedano` — is built before the first
 * statement of the test ever runs. Importing this module *first* is what makes
 * the assignment happen first.
 *
 *   import '../lib/isolate.ts'   // must come before any apps/server import
 *   import { thing } from '../apps/server/src/...'
 *
 * An outer runner that already picked a home (see `check-all.ts`) keeps it, so a
 * gate and the suite around it do not disagree about where the store is.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const inherited = process.env.SEDANO_HOME

/** The directory this process is using, whether it made it or was handed one. */
export const SEDANO_TEST_HOME = inherited ?? mkdtempSync(join(tmpdir(), 'sedano-isolate-'))

if (!inherited) {
  process.env.SEDANO_HOME = SEDANO_TEST_HOME
  // Only the maker cleans up: a home we were handed belongs to whoever set it.
  const clean = (): void => {
    try {
      rmSync(SEDANO_TEST_HOME, { recursive: true, force: true })
    } catch {
      // A store we cannot remove is a temp dir, not a failure worth reporting.
    }
  }
  process.on('exit', clean)
  process.on('SIGINT', () => {
    clean()
    process.exit(130)
  })
}
