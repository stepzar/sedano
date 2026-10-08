#!/usr/bin/env bun
/**
 * Archive and import: a session put away is hidden but whole, and every
 * harness' own store is scanned read-only for the conversations of a folder.
 *
 * Hermetic. The process restarts itself inside a sandbox whose `HOME` is a
 * temporary folder seeded from `scripts/fixtures/imports/` (Claude, Codex,
 * Gemini, Command Code and Grok files, an Opencode database built here), whose
 * `SEDANO_HOME` is another, and whose PATH holds only the fake ACP agent as
 * `opencode`. The real `~` is never read and no vendor CLI is reachable.
 *
 *   bun scripts/import-test.ts
 */
import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fixtures = join(import.meta.dir, 'fixtures', 'imports')

if (!process.env.SEDANO_IMPORT_SANDBOX) {
  const home = mkdtempSync(join(tmpdir(), 'sedano-import-home-'))
  const store = mkdtempSync(join(tmpdir(), 'sedano-import-store-'))
  const work = join(mkdtempSync(join(tmpdir(), 'sedano-import-work-')), 'project')
  mkdirSync(work)
  const bin = join(home, 'fake-bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'opencode'), `#!/bin/sh\nexec ${process.execPath} ${join(import.meta.dir, 'fixtures', 'fake-acp-agent.ts')} "$@"\n`)
  chmodSync(join(bin, 'opencode'), 0o755)

  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:/usr/bin:/bin`,
    SEDANO_HOME: store,
    SEDANO_IMPORT_SANDBOX: work,
    // The spec's order: the history arrives before the answer to `session/load`,
    // so a reopen's replay is deterministic.
    FAKE_ACP_REPLAY_FIRST: '1',
  }
  // A store variable inherited from this machine would point a scan at the real one.
  for (const name of ['CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_DIR', 'GROK_HOME', 'XDG_DATA_HOME', 'SEDANO_IMPORT_OPENCODE_DIR', 'SEDANO_IMPORT_COMMANDCODE_DIR']) delete env[name]
  const child = Bun.spawn([process.execPath, import.meta.path], { env, stdio: ['inherit', 'inherit', 'inherit'] })
  const code = await child.exited
  for (const dir of [home, store, join(work, '..')]) rmSync(dir, { recursive: true, force: true })
  process.exit(code)
}

/* ------------------------------------------------------------------ */
/* Inside the sandbox: seed the native stores                          */
/* ------------------------------------------------------------------ */

const work = process.env.SEDANO_IMPORT_SANDBOX!
const home = process.env.HOME!
const hash = createHash('sha256').update(work).digest('hex')

function seed(fixture: string, target: string, mtime: Date): void {
  mkdirSync(join(target, '..'), { recursive: true })
  const text = readFileSync(join(fixtures, fixture), 'utf8').replaceAll('__CWD__', work).replaceAll('__HASH__', hash)
  writeFileSync(target, text)
  utimesSync(target, mtime, mtime)
}

const claudeDir = join(home, '.claude', 'projects', work.replace(/[^a-zA-Z0-9]/g, '-'))
seed('claude-titled.jsonl', join(claudeDir, '11111111-1111-4111-8111-111111111111.jsonl'), new Date('2026-09-01T10:00:04Z'))
seed('claude-prompt.jsonl', join(claudeDir, '22222222-2222-4222-8222-222222222222.jsonl'), new Date('2026-09-02T09:00:05Z'))
seed('claude-other-folder.jsonl', join(claudeDir, '33333333-3333-4333-8333-333333333333.jsonl'), new Date('2026-09-03T09:00:00Z'))
seed('codex-rollout.jsonl', join(home, '.codex', 'sessions', '2026', '09', '04', 'rollout-2026-09-04T08-00-00-01a00000-0000-7000-8000-00000000c0de.jsonl'), new Date('2026-09-04T08:10:00Z'))
seed('codex-subagent.jsonl', join(home, '.codex', 'sessions', '2026', '09', '04', 'rollout-2026-09-04T08-05-00-01a00000-0000-7000-8000-0000000000aa.jsonl'), new Date('2026-09-04T08:11:00Z'))
seed('codex-session-index.jsonl', join(home, '.codex', 'session_index.jsonl'), new Date('2026-09-04T08:10:00Z'))
seed('gemini-session.json', join(home, '.gemini', 'tmp', hash, 'chats', 'session-2026-09-05T12-00-c6c62374.json'), new Date('2026-09-05T12:25:18Z'))
writeFileSync(join(home, '.gemini', 'projects.json'), JSON.stringify({ projects: { [work]: 'project' } }))
seed('gemini-session.jsonl', join(home, '.gemini', 'tmp', 'project', 'chats', 'session-2026-09-06T11-58-d37416ea.jsonl'), new Date('2026-09-06T11:59:27Z'))
seed('gemini-context-only.jsonl', join(home, '.gemini', 'tmp', 'project', 'chats', 'session-2026-09-07T16-10-2fa2f3e6.jsonl'), new Date('2026-09-07T16:10:22Z'))
const ccSlug = work.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
seed('commandcode.jsonl', join(home, '.commandcode', 'projects', ccSlug, 'ee652c79-ee40-463a-887e-fb49ccc58211.jsonl'), new Date('2026-09-08T22:16:10Z'))
writeFileSync(join(home, '.commandcode', 'projects', ccSlug, 'ee652c79-ee40-463a-887e-fb49ccc58211.checkpoints.jsonl'), '{}\n')
seed('grok-summary.json', join(home, '.grok', 'sessions', encodeURIComponent(work), '01a03dc6-326d-7e93-a45e-de40e68a07fa', 'summary.json'), new Date('2026-09-09T12:35:34Z'))

// Opencode keeps everything in one SQLite file; the columns the scan reads.
mkdirSync(join(home, '.local', 'share', 'opencode'), { recursive: true })
const opencodePath = join(home, '.local', 'share', 'opencode', 'opencode.db')
{
  const oc = new Database(opencodePath, { create: true })
  oc.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT NOT NULL, title TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  `)
  const at = Date.parse('2026-09-10T10:00:00Z')
  const session = oc.query('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)')
  session.run('ses_fixture1', null, work, 'New session - 2026-09-10T10:00:00.000Z', at, at)
  session.run('ses_child', 'ses_fixture1', work, 'A sub-agent', at, at + 1)
  session.run('ses_empty', null, work, 'New session - 2026-09-10T11:00:00.000Z', at, at + 2)
  oc.query('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run('msg1', 'ses_fixture1', at, at, JSON.stringify({ role: 'user' }))
  oc.query('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run('msgc', 'ses_child', at, at, JSON.stringify({ role: 'user' }))
  const part = oc.query('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)')
  part.run('prt0', 'msg1', 'ses_fixture1', at, at, JSON.stringify({ type: 'text', text: 'system note', synthetic: true }))
  part.run('prt1', 'msg1', 'ses_fixture1', at + 1, at, JSON.stringify({ type: 'text', text: 'Ping two sites in parallel' }))
  oc.close()
}

/** Every file under the seeded home, with its bytes and mtime: the scan must change none of them. */
function snapshot(dir: string, out = new Map<string, string>()): Map<string, string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) snapshot(path, out)
    else if (!path.startsWith(join(home, 'fake-bin'))) out.set(path, `${st.size}:${st.mtimeMs}:${createHash('sha1').update(readFileSync(path)).digest('hex')}`)
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Checks                                                              */
/* ------------------------------------------------------------------ */

const failures: string[] = []
const passed: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) passed.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

function waitFor(predicate: () => boolean, label: string, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (predicate()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`))
      setTimeout(tick, 30)
    }
    tick()
  })
}

const manager = await import('../apps/server/src/manager.ts')
const db = await import('../apps/server/src/db.ts')
const { scanFolder, commandCodeHistory, findNative, cleanTitle } = await import('../apps/server/src/imports.ts')
const tabs = await import('../apps/server/src/tabs.ts')

manager.restore()

const scan = () =>
  scanFolder({
    cwd: work,
    host: null,
    archived: db.archivedSessions(work, null).map((row) => ({ id: row.id, harness: row.harness, nativeId: row.native_id, title: row.title, updatedAt: row.updated_at })),
    held: manager.heldNativeIds(),
  })

/* The scan: every harness, clean titles, newest first, nothing written. */
{
  const before = snapshot(home)
  const started = performance.now()
  const result = scan()
  const elapsed = performance.now() - started
  const after = snapshot(home)
  const titles = Object.fromEntries(result.sessions.map((item) => [`${item.harness}:${item.nativeId}`, item.title]))

  check('the scan reports no store errors', result.errors.length === 0, result.errors)
  check('claude: the harness title wins over the first prompt', titles['claude:11111111-1111-4111-8111-111111111111'] === 'Streaming parser refactor', titles)
  check('claude: without a title, the first real prompt (commands and meta skipped)', titles['claude:22222222-2222-4222-8222-222222222222'] === 'Add a dark theme toggle to the settings page', titles)
  check('claude: a transcript of another folder sharing the slug is left out', !('claude:33333333-3333-4333-8333-333333333333' in titles), titles)
  check('codex: the thread name from the session index', titles['codex:01a00000-0000-7000-8000-00000000c0de'] === 'Fix the CI build', titles)
  check('codex: a sub-agent thread is not a conversation to import', !('codex:01a00000-0000-7000-8000-0000000000aa' in titles), titles)
  check('gemini: the legacy JSON chat, by the first user message', titles['gemini:c6c62374-f885-4def-9fe1-100c6585d31b'] === 'Write release notes for version 2', titles)
  check('gemini: the JSONL chat under the project name, injected context skipped', titles['gemini:d37416ea-8f31-49cd-8bcf-888aa8b386b8'] === 'Summarize the open issues', titles)
  check('gemini: a chat with nothing but injected context is left out', !('gemini:2fa2f3e6-bfc5-4c5e-bc10-78578c79732f' in titles), titles)
  check('opencode: a placeholder title falls back to the first real prompt', titles['opencode:ses_fixture1'] === 'Ping two sites in parallel', titles)
  check('opencode: sub-agent and empty sessions are left out', !('opencode:ses_child' in titles) && !('opencode:ses_empty' in titles), titles)
  check('grok: the generated title', titles['grok:01a03dc6-326d-7e93-a45e-de40e68a07fa'] === 'Mailpit guard, e2e green', titles)
  check('commandcode: the first prompt that is not a slash command', titles['commandcode:ee652c79-ee40-463a-887e-fb49ccc58211'] === 'Rename the config loader', titles)
  check('commandcode: the checkpoints sidecar is not a session', result.sessions.filter((item) => item.harness === 'commandcode').length === 1, result.sessions)
  check('every row is native and sorted newest first', result.sessions.every((item, index) => item.source === 'native' && (index === 0 || result.sessions[index - 1]!.updatedAt >= item.updatedAt)), result.sessions.map((item) => item.updatedAt))
  check('the scan is fast', elapsed < 2000, elapsed)
  check('the scan writes nothing to any native store', JSON.stringify([...before]) === JSON.stringify([...after]))
  check('a title is one trimmed line', cleanTitle(`  a\n\n b ${'x'.repeat(300)}`).length <= 120 && !cleanTitle('a\nb').includes('\n'))
  check('an import only resolves what the scan would list', findNative('claude', work, '33333333-3333-4333-8333-333333333333') === null && findNative('claude', '/nowhere', '11111111-1111-4111-8111-111111111111') === null)
}

/* A remote folder: only Sedano's own archive, never this machine's stores. */
{
  const result = scanFolder({ cwd: work, host: 'some-server', archived: [], held: new Set() })
  check('a remote scan lists no native session of this machine', result.sessions.length === 0 && result.notes.length === 1, result)
}

/* Command Code: its history comes from the store, the driver cannot replay it. */
{
  const history = commandCodeHistory(work, 'ee652c79-ee40-463a-887e-fb49ccc58211')
  const kinds = history.map((item) => item.ev.k)
  check('commandcode history: prompts, thinking and replies in order, tool results skipped', JSON.stringify(kinds) === JSON.stringify(['user', 'assistant', 'user', 'thinking', 'assistant']), kinds)
  const session = await manager.importNativeSession({ harness: 'commandcode', nativeId: 'ee652c79-ee40-463a-887e-fb49ccc58211', cwd: work, host: null, title: 'Rename the config loader', history })
  const events = db.loadEvents(session.id)
  check('commandcode import: the history is on the session', events.filter((event) => event.ev.k === 'user').length === 2 && events.some((event) => event.ev.k === 'assistant' && event.ev.text === 'Renamed it to loadConfig.'), events.map((event) => event.ev))
  check('commandcode import: it resumes the native id', session.nativeId === 'ee652c79-ee40-463a-887e-fb49ccc58211' && session.started && session.title === 'Rename the config loader', session)
  const again = await manager.importNativeSession({ harness: 'commandcode', nativeId: 'ee652c79-ee40-463a-887e-fb49ccc58211', cwd: work, host: null, history })
  check('importing twice hands back the same session', again.id === session.id, { first: session.id, again: again.id })
  check('an imported conversation leaves the scan', !scan().sessions.some((item) => item.nativeId === 'ee652c79-ee40-463a-887e-fb49ccc58211'))
}

/* An ACP import replays its history through `session/load` (the fake agent). */
let acpId = ''
{
  const session = await manager.importNativeSession({ harness: 'opencode', nativeId: 'ses_fixture1', cwd: work, host: null, title: 'Ping two sites in parallel' })
  acpId = session.id
  const texts = () => db.loadEvents(acpId).map((event) => `${event.ev.k}:${'text' in event.ev ? event.ev.text : ''}`)
  try {
    await waitFor(() => texts().includes('user:REPLAYED QUESTION') && texts().includes('assistant:REPLAYED HISTORY'), 'the replayed history')
  } catch (error) {
    check('acp import: the replayed conversation is rendered', false, { error: String(error), texts: texts() })
  }
  const order = texts().filter((text) => text.includes('REPLAYED'))
  check('acp import: the replayed conversation is rendered in order', JSON.stringify(order) === JSON.stringify(['user:REPLAYED QUESTION', 'assistant:REPLAYED HISTORY']), texts())
  check('acp import: the session resumes the native id', manager.getSession(acpId)?.nativeId === 'ses_fixture1', manager.getSession(acpId))

  // A respawn of a session that now has its history must not print it again.
  manager.stopSession(acpId)
  const sent = await manager.sendMessage(acpId, 'hello again')
  check('acp import: a prompt after a stop is sent', sent.ok, sent)
  await waitFor(() => texts().some((text) => text.startsWith('assistant:') && !text.includes('REPLAYED')), 'the reply').catch(() => {})
  const replays = texts().filter((text) => text.includes('REPLAYED')).length
  check('acp import: a later reopen does not replay the history twice', replays === 2, texts())
}

/* Archive: hidden everywhere, deleted nowhere, and a running session is stopped. */
{
  tabs.applyTabs({ op: 'open', tab: { id: acpId } })
  const eventsBefore = db.loadEvents(acpId).length
  const busy = await manager.sendMessage(acpId, 'cancel me later')
  check('archive: the session is busy before it is archived', busy.ok, busy)
  await waitFor(() => manager.getSession(acpId)?.status === 'running', 'the turn to run').catch(() => {})
  check('archive: accepted', manager.archiveSession(acpId))
  check('archive: gone from the session list', !manager.listSessions().some((item) => item.id === acpId))
  check('archive: gone from the shared tabs', !tabs.openTabs().some((tab) => tab.id === acpId), tabs.openTabs())
  const row = db.getSessionRow(acpId)
  check('archive: the row is kept, flagged', row?.archived === 1, row)
  check('archive: a boot would not load it', !db.loadSessions().some((item) => item.id === acpId))
  check('archive: the transcript is kept', db.loadEvents(acpId).length >= eventsBefore, { before: eventsBefore, after: db.loadEvents(acpId).length })
  check('archive: the running turn was stopped', row?.status === 'stopped', row?.status)
  const listed = scan().sessions.filter((item) => item.harness === 'opencode')
  check('archive: the scan lists it once, as archived', listed.length === 1 && listed[0]!.source === 'archived' && listed[0]!.sessionId === acpId, listed)

  const restored = manager.unarchiveSession(acpId)
  check('unarchive: the session is back in the list', Boolean(restored) && manager.listSessions().some((item) => item.id === acpId))
  check('unarchive: the flag is cleared', db.getSessionRow(acpId)?.archived === 0)
  check('unarchive: its history is intact', db.loadEvents(acpId).length >= eventsBefore)
  check('unarchive: it comes back stopped', restored?.status === 'stopped', restored?.status)
  check('unarchive: it leaves the scan', !scan().sessions.some((item) => item.sessionId === acpId || item.nativeId === 'ses_fixture1'))
  check('unarchive: asking again is harmless', manager.unarchiveSession(acpId)?.id === acpId)
}

await manager.shutdown().catch(() => {})
for (const label of passed) console.log(`   ✓ ${label}`)
for (const failure of failures) console.log(`   ✗ ${failure}`)
console.log(`import-test: ${failures.length ? 'FAILED' : 'PASSED'} (${passed.length} passed, ${failures.length} failed)`)
process.exit(failures.length ? 1 : 0)
