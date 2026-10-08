#!/usr/bin/env bun
/**
 * Who may call the local API: exactly the app's own origins.
 *
 * Any page on any localhost port used to be accepted — and every dev server a
 * person runs is a page on localhost, while the API can spawn processes. The
 * installed copy (`SEDANO_INSTANCE=app`) accepts its webview and the bundle it
 * serves on its own port; only the dev copy also accepts the vite dev server.
 * The HTTP API and the WebSocket upgrade must give the same answer, because
 * either one is enough to drive a session.
 *
 *   bun scripts/origin-test.ts
 */
import { connect } from 'node:net'
import { installExitHandlers, runCleanups, startApi, tempHome, type Server } from './lib/harness.ts'

installExitHandlers()

const failures: string[] = []
const passed: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) passed.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

/** The status line of a raw WebSocket upgrade carrying `origin`. */
function upgradeStatus(port: number, origin: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let head = ''
    socket.on('connect', () => {
      socket.write(
        [
          'GET /api/ws HTTP/1.1',
          `host: 127.0.0.1:${port}`,
          'upgrade: websocket',
          'connection: Upgrade',
          'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==',
          'sec-websocket-version: 13',
          `origin: ${origin}`,
        ].join('\r\n') + '\r\n\r\n',
      )
    })
    socket.on('data', (chunk) => {
      head += chunk.toString('latin1')
      const match = head.match(/^HTTP\/1\.1 (\d{3})/)
      if (match) {
        socket.destroy()
        resolve(Number(match[1]))
      }
    })
    socket.on('error', reject)
    setTimeout(() => reject(new Error('upgrade timed out')), 5000)
  })
}

async function httpStatus(api: Server, origin: string): Promise<number> {
  return (await fetch(`${api.url}/api/state`, { headers: { origin } })).status
}

/** Both doors, one answer: `accepted` decides 200/101 against 403/403. */
async function expectOrigin(label: string, api: Server, origin: string, accepted: boolean): Promise<void> {
  const http = await httpStatus(api, origin)
  const ws = await upgradeStatus(api.port, origin)
  check(`${label}: HTTP ${accepted ? 'accepts' : 'refuses'} ${origin}`, accepted ? http === 200 : http === 403, http)
  check(`${label}: WebSocket ${accepted ? 'accepts' : 'refuses'} ${origin}`, accepted ? ws === 101 : ws === 403, ws)
}

try {
  const app = await startApi(tempHome('origin-app').env)
  for (const origin of ['tauri://localhost', 'http://tauri.localhost', `http://127.0.0.1:${app.port}`, `http://localhost:${app.port}`]) {
    await expectOrigin('app', app, origin, true)
  }
  for (const origin of [
    'http://localhost:5174',
    'http://127.0.0.1:5174',
    'http://localhost:3000',
    `https://localhost:${app.port}`,
    'https://evil.test',
    'null',
    'tauri://evil',
  ]) {
    await expectOrigin('app', app, origin, false)
  }
  const preflight = await fetch(`${app.url}/api/state`, { method: 'OPTIONS', headers: { origin: 'http://localhost:3000' } })
  check('app: a refused origin gets no CORS grant', preflight.headers.get('access-control-allow-origin') === null, [...preflight.headers])
  check('app: no Origin (a native client) is still served', (await fetch(`${app.url}/api/state`)).status === 200)

  const dev = await startApi({ ...tempHome('origin-dev').env, SEDANO_INSTANCE: 'dev' })
  for (const origin of ['http://localhost:5174', 'http://127.0.0.1:5174', 'tauri://localhost', `http://127.0.0.1:${dev.port}`]) {
    await expectOrigin('dev', dev, origin, true)
  }
  for (const origin of ['http://localhost:3000', 'https://evil.test']) {
    await expectOrigin('dev', dev, origin, false)
  }
} finally {
  await runCleanups()
}

for (const label of passed) console.log(`  ok   ${label}`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
console.log(`\norigin: ${passed.length} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
