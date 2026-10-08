#!/usr/bin/env bun
/**
 * The built bundle, actually booted.
 *
 * `bun run build:ui` only proves vite did not throw. What ships is the server
 * serving `apps/ui/dist`, and nothing checked that it boots and answers: an
 * index that references an asset the build never wrote, or a server that falls
 * back to its "UI not built yet" page, both look exactly like success from the
 * build log. So this starts the real server on a free port against a throwaway
 * store and reads what a browser would read.
 *
 *   bun scripts/dist-check.ts
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { installExitHandlers, ROOT, runCleanups, startApi, tempHome } from './lib/harness.ts'

installExitHandlers()

const failures: string[] = []
const passed: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) passed.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const dist = join(ROOT, 'apps', 'ui', 'dist')
// Run on its own — outside `check:all`, where `build:ui` is the gate before
// this one — it still has to have something to serve.
if (!existsSync(join(dist, 'index.html'))) {
  console.log('no bundle yet: building the UI first')
  const build = Bun.spawn(['bun', 'run', 'build:ui'], { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' })
  if ((await build.exited) !== 0) {
    console.error('dist-check: build:ui failed')
    process.exit(1)
  }
}

const { home, env } = tempHome('dist-check')
const api = await startApi(env)
console.log(`serving ${dist} from ${api.url} (store ${home})`)

try {
  const health = await fetch(`${api.url}/api/health`)
  check('the server answers its health check', health.ok, health.status)
  // The desktop shell compares this with its own version before attaching
  // (`lib.rs`); from source there is no compile-time build id.
  const body = (await health.json()) as { version?: string; build?: string; pid?: number }
  const version = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version
  check('health reports the package.json version', body.version === version, body)
  check('and says it runs from source', body.build === 'source', body)
  check('and its pid', typeof body.pid === 'number' && body.pid > 0, body)

  const root = await fetch(`${api.url}/`)
  const html = await root.text()
  check('the root serves the built index', root.ok, root.status)
  check(
    'and it is the bundle, not the "not built yet" page',
    !html.includes('UI not built yet') && html.includes('<div id="root">'),
    html.slice(0, 200),
  )

  // Every local asset the index names must exist: a hashed file the build
  // renamed, or one written to a directory the server does not serve, turns
  // into a blank page in front of a person and into nothing at all in a log.
  const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((match) => match[1]!)
  check('the index references at least one built asset', refs.length > 0, refs)
  for (const ref of refs) {
    const asset = await fetch(`${api.url}${ref}`)
    const body = await asset.text()
    // The SPA fallback answers 200 with `index.html` for anything missing, so
    // "it is not the index" is the only honest way to ask whether it is there.
    check(`${ref} is served`, asset.ok && !body.includes('<div id="root">'), { status: asset.status, bytes: body.length })
  }

  // An unknown path is the app's own routing, and must reach the app rather
  // than a 404: the desktop shell opens deep links this way.
  const deep = await fetch(`${api.url}/some/app/route`)
  check('an unknown path falls back to the app', deep.ok && (await deep.text()).includes('<div id="root">'), deep.status)

  // The websocket is what the UI talks over; a bundle that boots and cannot
  // connect is not a working app.
  const socket = new WebSocket(`ws://127.0.0.1:${api.port}/api/ws`)
  const opened = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000)
    socket.onopen = () => {
      clearTimeout(timer)
      resolve(true)
    }
    socket.onerror = () => {
      clearTimeout(timer)
      resolve(false)
    }
  })
  check('the websocket the UI needs accepts a connection', opened)
  socket.close()
} finally {
  await runCleanups()
}

if (failures.length) {
  console.log('--- failed checks ---')
  for (const failure of failures) console.log(`✗ ${failure}`)
  console.log(`\ndist-check: ${failures.length} FAILURES (${passed.length} passed)`)
  process.exit(1)
}
console.log(`dist-check: PASSED (${passed.length} checks)`)
process.exit(0)
