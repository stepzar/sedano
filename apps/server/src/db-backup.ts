import type { Database } from 'bun:sqlite'
import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { makePrivate } from './paths.ts'

/**
 * A copy of the store taken before a newer (or older) release migrates it.
 *
 * The migrations in `db.ts` are idempotent and transactional, but they only go
 * forward: once a release has rebuilt a table, the build before it cannot read
 * the file, and there was no copy to go back to. So the first open by a release
 * other than the one that last opened the store snapshots it (`VACUUM INTO`,
 * which includes whatever is still in the WAL), lets the migrations run, and
 * keeps the snapshot as `sedano.db.bak-<previous version>` only if the schema
 * actually changed. Opening with the same release costs one `kv` read.
 */

/** Where the release that last opened (and migrated) the store is recorded. */
const VERSION_KEY = 'db.lastOpenedByVersion'
/** Versioned backups kept; older ones are deleted. Hand-made copies are never touched. */
export const BACKUPS_KEPT = 3
const BACKUP_NAME = /^sedano\.db\.bak-(\d+\.\d+\.\d+[0-9A-Za-z.+-]*|unversioned)$/

function schemaOf(db: Database): string {
  return db
    .query<{ type: string; name: string; sql: string | null }, []>(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all()
    .map((row) => `${row.type}|${row.name}|${row.sql ?? ''}`)
    .join('\n')
}

function recordedVersion(db: Database): string | null {
  try {
    return db.query<{ v: string }, [string]>('SELECT v FROM kv WHERE k = ?').get(VERSION_KEY)?.v ?? null
  } catch {
    return null // a store from before `kv` existed
  }
}

function prune(dir: string): void {
  const backups = readdirSync(dir)
    .filter((name) => BACKUP_NAME.test(name))
    .map((name) => ({ path: join(dir, name), at: statSync(join(dir, name)).mtimeMs }))
    .sort((left, right) => right.at - left.at)
  for (const old of backups.slice(BACKUPS_KEPT)) rmSync(old.path, { force: true })
}

/**
 * Call right after opening the store and before the first migration; call
 * `finish()` once every migration has run. A failed snapshot is reported and
 * the store still opens — refusing to start would leave the user with nothing.
 */
export function beginMigrationBackup(db: Database, path: string, version: string): { finish(): void } {
  const previous = recordedVersion(db)
  const before = schemaOf(db)
  /** `written` is the file the snapshot went to: `final` itself unless that name was taken. */
  let snapshot: { written: string; final: string } | null = null

  // A brand-new store has nothing to lose; the same release has nothing to migrate.
  if (previous !== version && before !== '') {
    const label = (previous ?? 'unversioned').replace(/[^0-9A-Za-z.+-]/g, '_')
    const final = join(dirname(path), `${basename(path)}.bak-${label}`)
    // Straight to the final name when it is free, so a migration that throws
    // (and never reaches `finish`) still leaves the backup where it is expected.
    const written = existsSync(final) ? `${final}.tmp` : final
    try {
      rmSync(`${final}.tmp`, { force: true })
      db.exec(`VACUUM INTO '${written.replaceAll("'", "''")}'`)
      // A full copy of every conversation: as private as the store it came from.
      makePrivate(written)
      snapshot = { written, final }
    } catch (err) {
      rmSync(written, { force: true }) // never a pre-existing backup: see `written`
      console.error(`sedano: could not back up ${path} before migrating to ${version}; continuing without a backup:`, err)
    }
  }

  return {
    finish(): void {
      if (snapshot) {
        if (schemaOf(db) !== before) {
          if (snapshot.written !== snapshot.final) renameSync(snapshot.written, snapshot.final)
          console.log(`sedano: the store was migrated to ${version}; the previous one is ${snapshot.final}`)
          prune(dirname(path))
        } else {
          rmSync(snapshot.written, { force: true })
        }
      }
      if (previous !== version) {
        db.query('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(VERSION_KEY, version)
      }
    },
  }
}
