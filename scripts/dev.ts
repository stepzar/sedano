#!/usr/bin/env bun
/**
 * Runs the backend and the vite dev server together, with no extra dependency
 * and no process manager to maintain.
 */
import { spawn } from 'bun'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DEV_HOME, DEV_PORT, devEnv } from './lib/dev-env.ts'

const root = join(import.meta.dir, '..')
const nodeModules = join(root, 'node_modules')

if (!existsSync(nodeModules)) {
  console.log('installing dependencies…')
  const install = spawn(['bun', 'install'], { cwd: root, stdout: 'inherit', stderr: 'inherit' })
  await install.exited
}

// ACP agents live inside this process. An automatic watch restart kills every
// in-flight turn, including sessions on other machines. Keep the backend stable
// by default; opt in only when working on backend code with no active agents.
const startServer = () => spawn(['bun', ...(process.env.SEDANO_WATCH_SERVER === '1' ? ['--watch'] : []), 'apps/server/src/index.ts'], {
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit',
  env: devEnv(),
})
let server = startServer()

// Both ports are configurable so a second dev session can run alongside this
// one; vite reads the `SEDANO_PORT` set by `devEnv` for its `/api` proxy. The
// API port and the store are the dev ones (see `lib/dev-env.ts`), never the
// installed app's.
const uiPort = process.env.SEDANO_UI_PORT ?? '5174'
const apiPort = DEV_PORT

const vite = spawn(['bunx', 'vite', '--config', 'apps/ui/vite.config.ts', '--port', uiPort], {
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit',
  env: devEnv(),
})

let stopping = false
const shutdown = () => {
  if (stopping) return
  stopping = true
  server.kill()
  vite.kill()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

console.log(`\n  sedano dev\n  UI   -> http://localhost:${uiPort}\n  API  -> http://127.0.0.1:${apiPort}\n  data -> ${DEV_HOME}\n`)

// A native runtime crash bypasses every JS catch in the API. Keep the UI and
// supervisor alive so persisted sessions can be restored and clients reconnect.
// Only the server we own is restarted; an intentional Ctrl-C still stops both.
void vite.exited.then(() => shutdown())
let failures = 0
while (!stopping) {
  const startedAt = Date.now()
  const code = await server.exited
  if (stopping) break
  failures = Date.now() - startedAt > 60_000 ? 1 : failures + 1
  const delay = Math.min(10_000, 500 * 2 ** Math.min(failures - 1, 5))
  console.error(`sedano server exited (${code}); restarting in ${delay}ms`)
  await Bun.sleep(delay)
  if (!stopping) server = startServer()
}
