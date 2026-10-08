/**
 * The app a browser check points at.
 *
 * By default the check builds its own world: a temporary store seeded with the
 * transcript fixtures, an API server on a free port serving the built bundle,
 * and a vite dev server for the component gallery. Nothing already running is
 * touched, and the fixtures are what the assertions below can rely on being
 * there.
 *
 * Passing a URL keeps the old behaviour — pointing a check at a server you are
 * already running — but then the store is whatever that server has, so the
 * checks say so in their report.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { ROOT, seedStore, startApi, startVite, tempHome } from './harness.ts'
import { RICHEST_FIXTURE } from '../fixtures/transcripts.ts'

export interface AppTarget {
  /** Where the app itself is served. */
  url: string
  /** Base for `preview.html`; the gallery only exists on the vite dev server. */
  galleryBase: string
  /** True when this process created the store and the servers. */
  hermetic: boolean
  /** The folder the fixture sessions claim to run in. */
  cwd: string
}

/**
 * Resolves the target from the CLI arguments, starting servers when none were
 * given. Callers are expected to have installed the exit handlers already, so
 * everything started here is stopped again by `runCleanups()`.
 */
export async function resolveApp(url?: string, galleryBase?: string): Promise<AppTarget> {
  if (url) {
    return { url, galleryBase: galleryBase ?? 'http://localhost:5174', hermetic: false, cwd: ROOT }
  }

  const bundle = join(ROOT, 'apps', 'ui', 'dist', 'index.html')
  if (!existsSync(bundle)) {
    throw new Error(`the UI bundle is missing at ${bundle} — run "bun run build:ui" before this check`)
  }

  const { home, env } = tempHome('ui-check')
  await seedStore(env, ROOT)
  const api = await startApi(env)
  const vite = await startVite()
  console.log(`hermetic run: store ${home}, app ${api.url}, gallery ${vite.url}`)
  return { url: `${api.url}/`, galleryBase: vite.url, hermetic: true, cwd: ROOT }
}

export interface OpenedSession {
  /** A session row was clicked. */
  clicked: boolean
  /** The row belongs to an agent, not a terminal. */
  agent: boolean
  /** The fixture with the richest transcript was the one opened. */
  fixture: boolean
  /** The session composer, which only an agent session has. */
  composer: boolean
}

/**
 * Opens a session worth inspecting and unfolds it.
 *
 * Which session it is matters: the rail is ordered newest first, and the newest
 * fixture has almost nothing in it, so "the first agent row" measured a nearly
 * empty transcript. A finished turn also collapses to a single line, taking its
 * tools and its files with it, so every collapsed turn is expanded too.
 */
export async function openRichestSession(page: Page): Promise<OpenedSession> {
  const result = await page.evaluate(async (wanted: string) => {
    // Groups start collapsed unless they hold the active session, so open one
    // before looking for a row.
    if (!document.querySelector('.rail .session-item')) {
      ;(document.querySelector('.rail-title.workspace') as HTMLElement | null)?.click()
      await new Promise((r) => setTimeout(r, 300))
    }
    // A workspace shows its newest sessions only; the fixtures need them all.
    for (const more of document.querySelectorAll<HTMLElement>('.rail-more[aria-expanded="false"]')) more.click()
    await new Promise((r) => setTimeout(r, 150))
    const rows = [...document.querySelectorAll<HTMLElement>('.rail .session-item:not(.draft)')]
    const agents = rows.filter((row) => !/terminal/i.test(row.querySelector('.meta')?.textContent ?? ''))
    const preferred = agents.find((row) => (row.querySelector('.title')?.textContent ?? '').trim() === wanted)
    const item = preferred ?? agents[0] ?? rows[0] ?? null
    item?.click()
    await new Promise((r) => setTimeout(r, 900))
    // Finished turns fold their work away; the checks measure that work. The
    // chevron says its state by class (the glyph is an icon now, not '▸').
    for (const toggle of document.querySelectorAll<HTMLElement>('.turn-toggle')) {
      if (toggle.querySelector('.chevron:not(.open)')) toggle.click()
    }
    await new Promise((r) => setTimeout(r, 400))
    return {
      clicked: Boolean(item),
      agent: agents.length > 0,
      fixture: Boolean(preferred),
      composer: Boolean(document.querySelector('.composer .select-trigger')),
    }
  }, RICHEST_FIXTURE.title)
  return result
}

/** Shows every session of every open workspace (each starts with its newest few). */
export async function expandRail(page: Page): Promise<void> {
  await page.evaluate(async () => {
    for (const more of document.querySelectorAll<HTMLElement>('.rail-more[aria-expanded="false"]')) more.click()
    await new Promise((r) => setTimeout(r, 150))
  })
}

/**
 * Close every open tab on the server. Open tabs are shared by every client of
 * one server, so a check that wants a fresh window — no tabs, the chooser on
 * screen — has to say so, or it inherits the tabs an earlier pass left open.
 */
export async function resetSharedTabs(url: string): Promise<void> {
  const socket = new WebSocket(`${url.replace(/^http/, 'ws').replace(/\/$/, '')}/api/ws`)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('resetSharedTabs: no answer from the server')), 5000)
    socket.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as { t: string; tabs?: Array<{ id: string }> }
      if (msg.t !== 'hello' && msg.t !== 'tabs') return
      const open = msg.tabs ?? []
      if (!open.length) {
        clearTimeout(timer)
        socket.close()
        resolve()
        return
      }
      if (msg.t === 'hello') for (const tab of open) socket.send(JSON.stringify({ t: 'tabs', op: { op: 'close', id: tab.id } }))
    }
  })
}
