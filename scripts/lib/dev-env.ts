/**
 * Where a development Sedano lives, so it never touches the installed app.
 *
 * The installed app owns `~/.sedano` and port 7788 (the real sessions, durable
 * agents, remote access and paired devices). Everything started from this repo
 * for development — `bun run dev`, `dev:server`, `desktop:dev` — runs on
 * `~/.sedano-dev` and 7789 instead, and says so in `/api/health`
 * (`instance: 'dev'`) so neither desktop shell attaches to the other's server.
 *
 * Deliberately *not* `SEDANO_HOME` / `SEDANO_PORT`: a terminal opened inside the
 * installed app inherits those from its server, and honouring them here would
 * start a dev server on the real store. `SEDANO_DEV_HOME` / `SEDANO_DEV_PORT`
 * move the dev copy.
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const DEV_HOME = resolve(process.env.SEDANO_DEV_HOME ?? join(homedir(), '.sedano-dev'))
export const DEV_PORT = process.env.SEDANO_DEV_PORT ?? '7789'

const APP_HOME = join(homedir(), '.sedano')
const APP_PORT = '7788'

if (DEV_HOME === APP_HOME || DEV_PORT === APP_PORT) {
  console.warn(
    `sedano dev: warning — ${DEV_HOME}:${DEV_PORT} is the installed app's store or port; ` +
      'unset SEDANO_DEV_HOME / SEDANO_DEV_PORT unless you really mean to develop on your real data',
  )
}

/** The environment for a dev server, vite, or anything that talks to them. */
export function devEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  // Inherited from the app's server when started from one of its terminals; a
  // dev server is supervised by `scripts/dev.ts` and serves vite, not a bundle.
  delete env.SEDANO_SUPERVISED
  delete env.SEDANO_UI_DIST
  return { ...env, SEDANO_HOME: DEV_HOME, SEDANO_PORT: DEV_PORT, SEDANO_INSTANCE: 'dev' }
}
