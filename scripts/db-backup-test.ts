#!/usr/bin/env bun
/**
 * The store is copied before a release migrates it, and only then.
 *
 * Each open is its own process (`fixtures/open-store.ts`) against a throwaway
 * `SEDANO_HOME`, because the backup is decided when `db.ts` loads. The running
 * release is whatever `package.json` says; earlier releases are simulated by
 * rewriting the version the store recorded.
 *
 *   bun scripts/db-backup-test.ts
 */
import { Database } from 'bun:sqlite'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const VERSION = (await Bun.file(join(ROOT, 'package.json')).json()).version as string
const KEY = 'db.lastOpenedByVersion'

const failures: string[] = []
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) passed++
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const home = mkdtempSync(join(tmpdir(), 'sedano-db-backup-test-'))
const store = join(home, 'sedano.db')
const backups = () => readdirSync(home).filter((name) => name.startsWith('sedano.db.bak-')).sort()

function open(): void {
  const proc = Bun.spawnSync(['bun', join(ROOT, 'scripts/fixtures/open-store.ts')], {
    cwd: ROOT,
    env: { ...process.env, SEDANO_HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (proc.exitCode !== 0) throw new Error(`opening the store failed:\n${proc.stderr.toString()}`)
}

function withStore<T>(path: string, read: (db: Database) => T): T {
  const db = new Database(path)
  try {
    return read(db)
  } finally {
    db.close()
  }
}
const recorded = () => withStore(store, (db) => db.query<{ v: string }, [string]>('SELECT v FROM kv WHERE k = ?').get(KEY)?.v)
const record = (version: string) => withStore(store, (db) => db.query('UPDATE kv SET v = ? WHERE k = ?').run(version, KEY))
const tables = (path: string) =>
  withStore(path, (db) => db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name))

try {
  // 1. A brand-new store: nothing to lose.
  open()
  check('a new store takes no backup', backups().length === 0, backups())
  check('and records the release that created it', recorded() === VERSION, recorded())

  // 2. The same release again: nothing to migrate.
  open()
  check('reopening with the same release takes no backup', backups().length === 0, backups())

  // 3. Another release, but no schema change: no backup kept.
  record('0.0.1')
  open()
  check('a new release that changes no schema keeps no backup', backups().length === 0, backups())
  check('but records itself', recorded() === VERSION, recorded())

  // 4. Another release that does change the schema: the old store is kept.
  record('0.0.2')
  withStore(store, (db) => db.exec('DROP TABLE prompt_queue'))
  open()
  const kept = join(home, 'sedano.db.bak-0.0.2')
  check('a migrating release keeps the store it found as .bak-<previous version>', existsSync(kept), backups())
  const keptMode = existsSync(kept) ? statSync(kept).mode & 0o777 : 0
  check('the backup is readable by its owner only, like the store', keptMode !== 0 && (keptMode & 0o077) === 0, keptMode.toString(8))
  check('the backup is the pre-migration store', existsSync(kept) && !tables(kept).includes('prompt_queue'), existsSync(kept) && tables(kept))
  check('and the live store is migrated', tables(store).includes('prompt_queue'))
  check('no temporary file is left behind', !backups().some((name) => name.endsWith('.tmp')), backups())

  // 5. Only the last three versioned backups are kept; a hand-made copy is never pruned.
  const old = Date.now() / 1000 - 3600
  for (const [index, label] of ['0.0.3', '0.0.4', '0.0.5'].entries()) {
    writeFileSync(join(home, `sedano.db.bak-${label}`), 'old')
    utimesSync(join(home, `sedano.db.bak-${label}`), old - index, old - index)
  }
  writeFileSync(join(home, 'sedano.db.bak-20260101'), 'manual')
  utimesSync(join(home, 'sedano.db.bak-20260101'), old - 99, old - 99)
  record('0.0.6')
  withStore(store, (db) => db.exec('DROP TABLE prompt_queue'))
  open()
  check(
    'three versioned backups are kept, newest first',
    JSON.stringify(backups()) === JSON.stringify(['sedano.db.bak-0.0.2', 'sedano.db.bak-0.0.3', 'sedano.db.bak-0.0.6', 'sedano.db.bak-20260101']),
    backups(),
  )

  // 6. A store from before versions were recorded is backed up as "unversioned".
  rmSync(home, { recursive: true, force: true })
  const legacyHome = mkdtempSync(join(tmpdir(), 'sedano-db-backup-test-'))
  const legacy = new Database(join(legacyHome, 'sedano.db'), { create: true })
  legacy.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL,
    agent_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL)`)
  legacy.close()
  const proc = Bun.spawnSync(['bun', join(ROOT, 'scripts/fixtures/open-store.ts')], {
    cwd: ROOT,
    env: { ...process.env, SEDANO_HOME: legacyHome },
    stderr: 'pipe',
  })
  check('a legacy store opens', proc.exitCode === 0, proc.stderr.toString().slice(-500))
  const legacyBackup = join(legacyHome, 'sedano.db.bak-unversioned')
  check('a store from before versions were recorded is kept as .bak-unversioned', existsSync(legacyBackup), readdirSync(legacyHome))
  check('holding only the legacy schema', existsSync(legacyBackup) && JSON.stringify(tables(legacyBackup)) === '["events"]', existsSync(legacyBackup) && tables(legacyBackup))
  rmSync(legacyHome, { recursive: true, force: true })
} finally {
  rmSync(home, { recursive: true, force: true })
}

if (failures.length) {
  for (const failure of failures) console.log(`✗ ${failure}`)
  console.log(`db-backup-test: ${failures.length} FAILURES (${passed} passed)`)
  process.exit(1)
}
console.log(`db-backup-test: PASSED (${passed} checks)`)
