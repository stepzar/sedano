#!/usr/bin/env bun
/**
 * Vite for the Tauri dev window, started as `beforeDevCommand`.
 *
 * Vite is pinned to 5174 with `strictPort`, so a second copy dies with
 * "Port 5174 is already in use" — and that failure takes the whole
 * `tauri dev` invocation with it. But a vite on 5174 is exactly what
 * `bun run dev` leaves running, and it serves the same sources through the same
 * `/api` proxy, so there is nothing to gain by starting another one.
 *
 * The shell already behaves this way for the server (it attaches to the dev
 * server on 7789 instead of spawning one); this is the same rule for vite.
 * Prints which case it took, so a failed run is never silent.
 *
 *   bun scripts/dev-ui.ts
 */
import { join } from 'node:path'
import { devEnv } from './lib/dev-env.ts'

const PORT = 5174
const root = join(import.meta.dir, '..')

/**
 * Both spellings, because vite binds one family: on this machine it listens on
 * `[::1]:5174` where `127.0.0.1:5174` refuses, and elsewhere it is the reverse.
 */
const CANDIDATES = [`http://localhost:${PORT}/`, `http://127.0.0.1:${PORT}/`]

/** True when our own dev server is already answering, not just any listener. */
async function uiIsUp(): Promise<boolean> {
  for (const url of CANDIDATES) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) })
      if (response.ok && (await response.text()).includes('id="root"')) return true
    } catch {
      // try the next spelling
    }
  }
  return false
}

if (await uiIsUp()) {
  console.log(`sedano: reusing the dev server already on http://localhost:${PORT}`)
  process.exit(0)
}

const vite = Bun.spawn(['bun', 'run', 'dev:ui'], {
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit',
  env: devEnv(),
})

const shutdown = () => vite.kill()
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

process.exit(await vite.exited)
