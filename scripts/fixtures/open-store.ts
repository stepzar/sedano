#!/usr/bin/env bun
/**
 * Opens the store at `$SEDANO_HOME/sedano.db` the way the server does —
 * running every migration in `db.ts` — and closes it. One process per open:
 * `db.ts` is a module singleton, and the backup is decided at module load.
 */
const db = await import('../../apps/server/src/db.ts')
db.closeDb()
