#!/usr/bin/env bun
/**
 * The API alone, on the development store and port (`lib/dev-env.ts`).
 *
 *   bun scripts/dev-server.ts            # bun run dev:server
 *   bun scripts/dev-server.ts --watch    # bun run dev:server:watch
 */
import { join } from 'node:path'
import { DEV_HOME, DEV_PORT, devEnv } from './lib/dev-env.ts'

const root = join(import.meta.dir, '..')
const watch = process.argv.includes('--watch') ? ['--watch'] : []
console.log(`sedano dev server: http://127.0.0.1:${DEV_PORT}, data in ${DEV_HOME}`)
const server = Bun.spawn(['bun', ...watch, 'apps/server/src/index.ts'], {
  cwd: root,
  stdout: 'inherit',
  stderr: 'inherit',
  env: devEnv(),
})
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.kill(signal))
process.exit(await server.exited)
