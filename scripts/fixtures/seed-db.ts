#!/usr/bin/env bun
/**
 * Writes the transcript fixtures into the store at `SEDANO_HOME`, so the browser
 * checks have the surfaces they assert on — a rail with sessions, a transcript
 * with turns, a composer with its menus — without borrowing the operator's own
 * history.
 *
 * Runs as its own process on purpose: `db.ts` resolves its file at import time,
 * so the environment has to be set before anything imports it.
 *
 *   SEDANO_HOME=/tmp/whatever bun scripts/fixtures/seed-db.ts [cwd]
 */
import { join } from 'node:path'
import { TRANSCRIPT_FIXTURES } from './transcripts.ts'

const home = process.env.SEDANO_HOME
if (!home) {
  console.error('refusing to seed: SEDANO_HOME is not set, and the real store is not a fixture')
  process.exit(1)
}
if (home === join(process.env.HOME ?? '', '.sedano')) {
  console.error(`refusing to seed the real store at ${home}`)
  process.exit(1)
}

/** Where the fixture sessions claim to have run: a real folder, so the file tree has something to list. */
const cwd = process.argv[2] ?? join(import.meta.dir, '..', '..')

const { upsertSession, insertEvent, kvSet, setSessionArchived } = await import('../../apps/server/src/db.ts')

// The model-picker browser check needs the exact ACP shape Codex publishes:
// one model id per effort, without a separate `efforts` field. Keep this
// opt-in so unrelated fixture galleries retain their normal catalogs.
if (process.env.SEDANO_SEED_CODEX_MODELS === '1') {
  kvSet('models', JSON.stringify({ '': { codex: ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({
    id: `gpt-6-luna[${effort}]`, label: `6 Luna (${effort})`,
  })) } }))
  kvSet('model-refresh-at-v1', JSON.stringify({ ':codex': Date.now() }))
}

for (const [index, fixture] of TRANSCRIPT_FIXTURES.entries()) {
  const at = Date.now() - (TRANSCRIPT_FIXTURES.length - index) * 60_000
  upsertSession({
    id: fixture.id,
    harness: fixture.harness,
    kind: fixture.kind,
    title: fixture.title,
    cwd,
    host: null,
    model: fixture.model,
    status: 'idle',
    createdAt: at,
    updatedAt: at,
    nativeId: fixture.id === 'fixture-kitchen-sink' ? 'fixture-native-session' : null,
    transcriptPath: null,
    resumeHint: null,
    permissionMode: 'acceptEdits',
    effort: null,
    gitBranch: 'main',
    pinned: 0,
    preset: null,
    // Not a draft: a session that was never started has no transcript and no
    // composer, and those are exactly what the browser checks inspect.
    started: true,
  })
  for (const event of fixture.events) insertEvent(event)
}

// Two archived sessions of different harnesses: hidden from the rail, listed by
// the import popup (enough for its harness filter to show).
const ARCHIVED = [
  { id: 'fixture-archived-session', harness: 'codex', title: 'Migrate the upload bucket', daysAgo: 3 },
  { id: 'fixture-archived-claude', harness: 'claude', title: 'Tidy the release notes', daysAgo: 12 },
] as const
for (const archived of ARCHIVED) {
  const at = Date.now() - archived.daysAgo * 86_400_000
  upsertSession({
    id: archived.id,
    harness: archived.harness,
    kind: 'agent',
    title: archived.title,
    cwd,
    host: null,
    model: null,
    status: 'stopped',
    createdAt: at,
    updatedAt: at,
    nativeId: `${archived.id}-native`,
    transcriptPath: null,
    resumeHint: null,
    permissionMode: 'acceptEdits',
    effort: null,
    gitBranch: 'main',
    pinned: 0,
    preset: null,
    started: true,
  })
  insertEvent({ id: `${archived.id}-1`, sessionId: archived.id, seq: 1, at, ev: { k: 'user', text: archived.title } })
  setSessionArchived(archived.id, true)
}

console.log(`seeded ${TRANSCRIPT_FIXTURES.length} fixture sessions (and two archived) into ${home}`)
