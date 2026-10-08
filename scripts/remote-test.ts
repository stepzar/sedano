#!/usr/bin/env bun
/**
 * Remote mode, end to end against the real server and a fake tailscale.
 *
 * What is pinned down:
 *   - remote mode off: a request carrying the tailnet name is refused;
 *   - remote mode on: that name without a device token gets the pairing page, a
 *     401 on the API and on the WebSocket upgrade;
 *   - a pairing code issues an HttpOnly/Secure/SameSite=Strict token once, the
 *     token opens HTTP and WS, a revoked token stops working and its socket is
 *     closed;
 *   - a restricted Tailscale login refuses everyone else;
 *   - DNS rebinding is still refused for every other name, and the localhost
 *     path is exactly as before;
 *   - pairing is rate-limited;
 *   - the tailscale helpers (serve start/stop/status, the dedicated daemon's
 *     launchd agent, login) are idempotent and never overwrite someone else's
 *     serve config — against fakes: no tailnet, no launchd.
 *
 *   bun scripts/remote-test.ts
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { installExitHandlers, runCleanups, startApi, tempHome } from './lib/harness.ts'

installExitHandlers()

const failures: string[] = []
const passed: string[] = []
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) passed.push(label)
  else failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

const { home, env } = tempHome('remote')
const fakes = join(home, 'fakes')
const agents = join(home, 'LaunchAgents')
mkdirSync(fakes, { recursive: true })
const fixture = (file: string) => join(import.meta.dir, 'fixtures', file)
const install = (name: string, target: string): string => {
  const path = join(fakes, name)
  writeFileSync(path, `#!/bin/sh\nexec ${process.execPath} ${target} "$@"\n`)
  chmodSync(path, 0o755)
  return path
}
const tsBin = install('tailscale', fixture('fake-tailscale.ts'))
const launchctl = install('launchctl', fixture('fake-launchctl.ts'))
const daemonBin = join(fakes, 'tailscaled') // never executed: the fake launchctl starts nothing
writeFileSync(daemonBin, '#!/bin/sh\nexit 1\n')
chmodSync(daemonBin, 0o755)

const NAME = 'sedano.tail-test.ts.net'
const stateFile = join(fakes, 'state.json')
type FakeState = { backendState: string; dnsName: string; login: string; serve: Record<string, unknown> }
const writeState = (patch: Partial<FakeState>) => {
  const current: FakeState = existsSync(stateFile)
    ? JSON.parse(readFileSync(stateFile, 'utf8'))
    : { backendState: 'Running', dnsName: NAME, login: 'user@example.com', serve: {} }
  writeFileSync(stateFile, JSON.stringify({ ...current, ...patch }))
}
const readState = (): FakeState => JSON.parse(readFileSync(stateFile, 'utf8'))
const tsLog = (): string[][] =>
  existsSync(join(fakes, 'tailscale.log'))
    ? readFileSync(join(fakes, 'tailscale.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
const launchLog = (): string[][] =>
  existsSync(join(fakes, 'launchctl.log'))
    ? readFileSync(join(fakes, 'launchctl.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
writeState({})

const api = await startApi({
  ...env,
  FAKE_TS_ROOT: fakes,
  SEDANO_TAILSCALE: tsBin,
  SEDANO_TAILSCALED: daemonBin,
  SEDANO_LAUNCHCTL: launchctl,
  SEDANO_LAUNCH_AGENTS_DIR: agents,
})

/** What `tailscale serve` sends: the tailnet Host, forwarding and identity headers. */
function viaTailnet(extra: Record<string, string> = {}, name = NAME): Record<string, string> {
  return {
    host: name,
    'x-forwarded-host': name,
    'x-forwarded-proto': 'https',
    'x-forwarded-for': '100.64.0.9',
    'tailscale-user-login': 'user@example.com',
    'tailscale-user-name': 'Test',
    ...extra,
  }
}

async function get(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${api.url}${path}`, { headers, redirect: 'manual' })
}
async function post(path: string, body: unknown, headers: Record<string, string> = {}, method = 'POST'): Promise<Response> {
  return fetch(`${api.url}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  })
}
const local = (path: string, body?: unknown, method = 'POST') => post(path, body, {}, method)

/** A raw WebSocket upgrade, so the Host header is ours to choose. Resolves with the status line. */
function upgrade(headers: Record<string, string>): Promise<{ status: number; socket: ReturnType<typeof connect> }> {
  return new Promise((resolve, reject) => {
    const socket = connect(api.port, '127.0.0.1')
    let head = ''
    socket.on('connect', () => {
      const lines = [
        'GET /api/ws HTTP/1.1',
        'upgrade: websocket',
        'connection: Upgrade',
        'sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version: 13',
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      ]
      socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    })
    socket.on('data', (chunk) => {
      if (head.includes('\r\n')) return
      head += chunk.toString('latin1')
      const match = head.match(/^HTTP\/1\.1 (\d{3})/)
      if (match) resolve({ status: Number(match[1]), socket })
    })
    socket.on('error', reject)
    setTimeout(() => reject(new Error('upgrade timed out')), 5000)
  })
}
async function wsStatus(headers: Record<string, string>): Promise<number> {
  const { status, socket } = await upgrade(headers)
  socket.destroy()
  return status
}

try {
  /* ---------------- localhost path, unchanged ---------------- */
  check('local: health answers', (await get('/api/health')).ok)
  check('local: state answers without a token', (await get('/api/state')).ok)
  check('local: an allowed Origin still posts', (await post('/api/remote', {}, { origin: `http://127.0.0.1:${api.port}` })).ok)
  check('local: a foreign Origin is still refused', (await post('/api/remote', {}, { origin: 'https://evil.test' })).status === 403)
  check('local: the WebSocket upgrades', (await wsStatus({ host: `127.0.0.1:${api.port}` })) === 101)
  check('local: a foreign Origin cannot upgrade', (await wsStatus({ host: `127.0.0.1:${api.port}`, origin: 'https://evil.test' })) === 403)
  check('rebinding: a foreign Host is refused', (await get('/api/state', { host: 'evil.test' })).status === 403)

  // Only when a bundle is built; `check:dist` owns whether it is.
  const indexResponse = await get('/')
  const indexHtml = await indexResponse.text()
  if (indexResponse.ok && indexHtml.includes('<div id="root">')) {
    check('static: the index is revalidated', indexResponse.headers.get('cache-control') === 'no-cache', indexResponse.headers.get('cache-control'))
    const asset = indexHtml.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1]
    if (asset) {
      const cached = (await get(asset)).headers.get('cache-control')
      check('static: hashed assets are immutable', cached === 'public, max-age=31536000, immutable', cached)
    }
  }
  const manifest = await get('/manifest.webmanifest')
  if (manifest.ok) {
    check('static: the manifest has its type', manifest.headers.get('content-type')?.includes('manifest+json') === true)
  }

  /* ---------------- remote mode off ---------------- */
  check('off: the default config is off', ((await (await get('/api/remote')).json()) as { config: { enabled: boolean } }).config.enabled === false)
  check('off: the tailnet name is refused', (await get('/', viaTailnet())).status === 403)
  check('off: the tailnet name cannot upgrade', (await wsStatus(viaTailnet())) === 403)
  check('off: tailscale is never asked', tsLog().length === 0, tsLog())
  check('off: a pairing code cannot be made', (await local('/api/remote/pairing')).status === 409)

  /* ---------------- remote mode on ---------------- */
  const enabled = (await (await local('/api/remote', { enabled: true })).json()) as {
    hostname: { effective: string | null; detected: string | null }
    url: string | null
  }
  check('on: the tailnet name is detected from tailscale status', enabled.hostname.detected === NAME, enabled)
  check('on: and it is the URL', enabled.url === `https://${NAME}/`, enabled.url)
  check('on: bad config is refused', (await local('/api/remote', { hostname: 'not a name' })).status === 400)

  const page = await get('/', viaTailnet())
  const pageText = await page.text()
  check('on: without a token the phone gets the pairing page', page.status === 200 && pageText.includes('Pair this device'), page.status)
  check('on: the pairing page is not cached', page.headers.get('cache-control') === 'no-store')
  // `no-referrer` here made Safari send `Origin: null` with the Pair form, which
  // is refused: the phone saw the page and then "forbidden origin".
  check('on: the pairing page keeps the Origin on its own POST', page.headers.get('referrer-policy') === 'same-origin', page.headers.get('referrer-policy'))
  check('on: an Origin of null is still refused', (await get('/api/state', viaTailnet({ origin: 'null' }))).status === 403)
  check('on: without a token the API is 401', (await get('/api/state', viaTailnet())).status === 401)
  check('on: without a token the WebSocket is 401', (await wsStatus(viaTailnet())) === 401)
  check('on: without a token an attachment is 401', (await get('/api/attachment/x', viaTailnet())).status === 401)
  check('on: install assets are public', [200, 404].includes((await get('/manifest.webmanifest', viaTailnet())).status))
  check('on: a garbage token is 401', (await get('/api/state', viaTailnet({ cookie: '__Host-sedano_device=nope' }))).status === 401)
  check('on: rebinding is still refused', (await get('/api/state', { host: 'evil.test' })).status === 403)
  check('on: a proxied request for another name is refused', (await get('/', viaTailnet({}, 'evil.ts.net'))).status === 403)
  check('on: a mismatched X-Forwarded-Host is refused', (await get('/', viaTailnet({ 'x-forwarded-host': 'evil.test' }))).status === 403)
  check('on: a foreign Origin via the tailnet is refused', (await get('/api/state', viaTailnet({ origin: 'https://evil.test' }))).status === 403)
  check('on: a funnel request is refused', (await get('/', viaTailnet({ 'tailscale-funnel-request': '?1' }))).status === 403)
  check('on: management is local-only', (await post('/api/remote/pairing', {}, viaTailnet())).status === 401)

  /* ---------------- pairing ---------------- */
  const code = (await (await local('/api/remote/pairing')).json()) as { code: string; display: string; url: string }
  check('pairing: a code and its URL', /^[A-Z2-9]{8}$/.test(code.code) && code.url === `https://${NAME}/pair?code=${code.code}`, code)
  const wrong = await post('/api/remote/pair', { code: 'AAAAAAAA' }, viaTailnet({ origin: `https://${NAME}` }))
  check('pairing: a wrong code is 401', wrong.status === 401 && !wrong.headers.get('set-cookie'))
  const paired = await post('/api/remote/pair', { code: code.display.toLowerCase(), name: 'Test iPhone' }, viaTailnet({ origin: `https://${NAME}` }))
  const setCookie = paired.headers.get('set-cookie') ?? ''
  check('pairing: the right code (any case, with dash) pairs', paired.status === 200, paired.status)
  check(
    'pairing: the cookie is HttpOnly, Secure, SameSite=Strict, __Host-',
    /^__Host-sedano_device=[\w-]{40,};/.test(setCookie) && /HttpOnly/.test(setCookie) && /Secure/.test(setCookie) && /SameSite=Strict/.test(setCookie),
    setCookie,
  )
  const token = setCookie.split(';')[0]!
  const reuse = await post('/api/remote/pair', { code: code.code }, viaTailnet())
  check('pairing: a code works once', reuse.status === 401, reuse.status)

  const form = await fetch(`${api.url}/api/remote/pair`, {
    method: 'POST',
    headers: { ...viaTailnet({ origin: `https://${NAME}` }), 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: ((await (await local('/api/remote/pairing')).json()) as { code: string }).code }),
    redirect: 'manual',
  })
  check('pairing: the HTML form pairs and redirects home', form.status === 303 && form.headers.get('location') === '/' && !!form.headers.get('set-cookie'), form.status)
  const formToken = (form.headers.get('set-cookie') ?? '').split(';')[0]!

  // The full set a phone's Pair tap arrives with: Safari's form POST headers
  // plus what `tailscale serve` adds (it keeps Host, sets X-Forwarded-*, the
  // Tailscale-User-* identity and Tailscale-Headers-Info).
  const safariCode = ((await (await local('/api/remote/pairing')).json()) as { code: string }).code
  const safari = await fetch(`${api.url}/api/remote/pair`, {
    method: 'POST',
    headers: {
      host: NAME,
      origin: `https://${NAME}`,
      referer: `https://${NAME}/pair?code=${safariCode}`,
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'it-IT,it;q=0.9',
      'accept-encoding': 'gzip, deflate, br',
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      'x-forwarded-for': '100.101.102.103',
      'x-forwarded-host': NAME,
      'x-forwarded-proto': 'https',
      'tailscale-user-login': 'user@example.com',
      'tailscale-user-name': 'Test User',
      'tailscale-user-profile-pic': 'https://lh3.googleusercontent.com/a/x',
      'tailscale-headers-info': 'https://tailscale.com/s/serve-headers',
    },
    body: new URLSearchParams({ code: safariCode, name: '' }),
    redirect: 'manual',
  })
  check('safari: the real Pair tap pairs and goes home', safari.status === 303 && safari.headers.get('location') === '/', safari.status)
  const safariCookie = (safari.headers.get('set-cookie') ?? '').split(';')[0]!
  const safariHeaders = viaTailnet({ cookie: safariCookie, origin: `https://${NAME}`, 'sec-fetch-site': 'same-origin' })
  check('safari: then the app loads', (await get('/', viaTailnet({ cookie: safariCookie }))).ok)
  check('safari: its fetches work', (await get('/api/state', safariHeaders)).ok)
  check('safari: its POSTs work', (await post('/api/voice', {}, safariHeaders)).status !== 403)
  check('safari: its WebSocket upgrades', (await wsStatus(safariHeaders)) === 101)
  check('safari: the device was named from its user agent', ((await (await get('/api/remote/me', safariHeaders)).json()) as { device: { name: string } }).device?.name === 'iPhone')

  const authed = viaTailnet({ cookie: token })
  check('token: the API answers', (await get('/api/state', authed)).ok)
  check('token: the WebSocket upgrades', (await wsStatus(authed)) === 101)
  const me = (await (await get('/api/remote/me', authed)).json()) as { remote: boolean; device: { name: string } }
  check('token: /me says remote, with the device', me.remote === true && me.device?.name === 'Test iPhone', me)
  check('token: /me locally says local', ((await (await get('/api/remote/me')).json()) as { remote: boolean }).remote === false)
  check('token: a paired phone cannot manage remote mode', (await post('/api/remote', { enabled: false }, authed)).status === 403)
  check('token: a paired phone cannot mint codes', (await post('/api/remote/pairing', {}, authed)).status === 403)

  const status = (await (await get('/api/remote')).json()) as { devices: Array<Record<string, unknown>> }
  const device = status.devices.find((d) => d.name === 'Test iPhone')
  check('devices: listed, with the Tailscale login', device?.login === 'user@example.com', status.devices)
  check('devices: no token or hash is ever listed', !JSON.stringify(status).includes('tokenHash') && !JSON.stringify(status).includes(token.split('=')[1]!))
  const stored = readFileSync(join(home, 'remote.json'), 'utf8')
  check('devices: tokens are stored hashed', !stored.includes(token.split('=')[1]!))
  check('devices: the file is private', (statSync(join(home, 'remote.json')).mode & 0o077) === 0)

  /* ---------------- allowed login ---------------- */
  await local('/api/remote', { allowedLogin: 'User@Example.com' })
  check('login: the allowed account passes', (await get('/api/state', authed)).ok)
  check('login: another account is refused', (await get('/api/state', viaTailnet({ cookie: token, 'tailscale-user-login': 'work@corp.com' }))).status === 403)
  const noLogin = viaTailnet({ cookie: token })
  delete noLogin['tailscale-user-login']
  check('login: no identity header is refused', (await get('/api/state', noLogin)).status === 403)
  check('login: another account cannot even pair', (await post('/api/remote/pair', { code: 'X' }, viaTailnet({ 'tailscale-user-login': 'work@corp.com' }))).status === 403)

  /* ---------------- revoke ---------------- */
  const live = await upgrade(authed)
  check('revoke: a socket is open before', live.status === 101)
  const closed = new Promise<boolean>((resolve) => {
    live.socket.on('close', () => resolve(true))
    setTimeout(() => resolve(false), 3000)
  })
  const revoked = await local(`/api/remote/devices/${device!.id}`, undefined, 'DELETE')
  check('revoke: the device is removed', revoked.ok)
  check('revoke: the token is dead', (await get('/api/state', authed)).status === 401)
  check('revoke: the dead token cannot upgrade', (await wsStatus(authed)) === 401)
  check('revoke: its open socket was closed', await closed)
  check('revoke: another device is untouched', (await get('/api/state', viaTailnet({ cookie: formToken }))).ok)
  const selfOut = await post('/api/remote/unpair', {}, viaTailnet({ cookie: formToken, origin: `https://${NAME}` }))
  check('unpair: a phone can sign itself out', selfOut.ok && /Max-Age=0/.test(selfOut.headers.get('set-cookie') ?? ''))
  check('unpair: and its token is dead', (await get('/api/state', viaTailnet({ cookie: formToken }))).status === 401)

  /* ---------------- manual hostname override ---------------- */
  await local('/api/remote', { hostname: 'mac.other-tail.ts.net', allowedLogin: null })
  check('override: the detected name is no longer served', (await get('/', viaTailnet())).status === 403)
  check('override: the override is', (await get('/', viaTailnet({}, 'mac.other-tail.ts.net'))).status === 200)
  await local('/api/remote', { hostname: null })

  /* ---------------- tailscale serve helpers ---------------- */
  const port = api.port
  const serveCalls = () => tsLog().filter((a) => a.includes('serve') && !a.includes('status'))
  const ts1 = (await (await get('/api/remote/tailscale')).json()) as { serve: { active: boolean }; node: { login: string } }
  check('serve: status says inactive', ts1.serve?.active === false, ts1)
  const start = (await (await local('/api/remote/tailscale', { action: 'serve-start' })).json()) as { serve: { active: boolean; url: string } }
  check('serve: start proxies to this server', start.serve?.active === true && start.serve.url === `https://${NAME}/`, start)
  check(
    'serve: the command is tailnet-only serve to 127.0.0.1',
    JSON.stringify(serveCalls()[0]) === JSON.stringify(['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`]),
    serveCalls(),
  )
  await local('/api/remote/tailscale', { action: 'serve-start' })
  check('serve: start again is a no-op', serveCalls().length === 1, serveCalls())
  check('serve: never funnel', !tsLog().some((a) => a.includes('funnel')))
  const stop = (await (await local('/api/remote/tailscale', { action: 'serve-stop' })).json()) as { serve: { active: boolean } }
  check('serve: stop turns it off', stop.serve?.active === false && serveCalls().length === 2, stop)
  const stopAgain = await local('/api/remote/tailscale', { action: 'serve-stop' })
  check('serve: stop again is a no-op', stopAgain.ok && serveCalls().length === 2, serveCalls())

  writeState({ serve: { Web: { [`${NAME}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3000' } } } } } })
  const conflict = await local('/api/remote/tailscale', { action: 'serve-start' })
  check('serve: someone else\'s :443 is not overwritten', conflict.status === 409 && serveCalls().length === 2, await conflict.text())
  check('serve: and it is still theirs', JSON.stringify(readState().serve).includes('127.0.0.1:3000'))
  writeState({ serve: { AllowFunnel: { [`${NAME}:443`]: true } } })
  check('serve: refuses to start with funnel on', (await local('/api/remote/tailscale', { action: 'serve-start' })).status === 409)
  writeState({ serve: {} })

  await local('/api/remote', { allowedLogin: 'user@example.com' })
  writeState({ login: 'work@corp.com' })
  const wrongAccount = await local('/api/remote/tailscale', { action: 'serve-start' })
  check('serve: refuses a node logged into another account', wrongAccount.status === 409 && serveCalls().length === 2, await wrongAccount.text())
  writeState({ login: 'user@example.com' })

  await local('/api/remote', { enabled: false })
  check('serve: refuses to start while remote mode is off', (await local('/api/remote/tailscale', { action: 'serve-start' })).status === 409)
  await local('/api/remote', { enabled: true })

  check('serve: login is refused for the app instance', (await local('/api/remote/tailscale', { action: 'login' })).status === 409)

  /* ---------------- the dedicated instance ---------------- */
  const socket = join(home, 'tailscale', 'tailscaled.sock')
  const before = tsLog().length
  await local('/api/remote', { tailscale: { instance: 'dedicated', nodeName: 'sedano' } })
  await local('/api/remote/tailscale', { action: 'serve-start' })
  const dedicatedCalls = tsLog().slice(before)
  check(
    'dedicated: every call goes to its own socket',
    dedicatedCalls.length > 0 && dedicatedCalls.every((a) => a[0] === '--socket' && a[1] === socket),
    dedicatedCalls,
  )
  await local('/api/remote/tailscale', { action: 'serve-stop' })

  const install1 = (await (await local('/api/remote/tailscale', { action: 'daemon-install' })).json()) as { daemon: { installed: boolean; loaded: boolean } }
  const plistPath = join(agents, 'dev.sedano.tailscaled.plist')
  const plist = existsSync(plistPath) ? readFileSync(plistPath, 'utf8') : ''
  check('daemon: install writes and loads the agent', install1.daemon?.installed === true && install1.daemon.loaded === true, install1)
  check(
    'daemon: userspace networking, its own state and socket',
    plist.includes('--tun=userspace-networking') && plist.includes(`--socket=${socket}`) && plist.includes(`--statedir=${join(home, 'tailscale')}`) && plist.includes('--port=0'),
    plist,
  )
  const bootstraps = () => launchLog().filter((a) => a[0] === 'bootstrap').length
  await local('/api/remote/tailscale', { action: 'daemon-install' })
  check('daemon: install again is a no-op', bootstraps() === 1, launchLog())
  const removed = (await (await local('/api/remote/tailscale', { action: 'daemon-uninstall' })).json()) as { daemon: { installed: boolean; loaded: boolean } }
  check('daemon: uninstall unloads and removes', removed.daemon?.installed === false && removed.daemon.loaded === false && !existsSync(plistPath), removed)
  const again = await local('/api/remote/tailscale', { action: 'daemon-uninstall' })
  check('daemon: uninstall again is a no-op', again.ok)

  writeState({ backendState: 'NeedsLogin' })
  const login = (await (await local('/api/remote/tailscale', { action: 'login' })).json()) as { state: string; authUrl: string }
  check('login: surfaces the auth URL', login.state === 'needs-auth' && login.authUrl === 'https://login.tailscale.com/a/fake-login', login)
  const upCall = tsLog().find((a) => a.includes('up'))
  check('login: registers under the configured name', upCall?.includes('--hostname=sedano') === true, upCall)
  const loginAgain = (await (await local('/api/remote/tailscale', { action: 'login' })).json()) as { authUrl: string }
  check('login: asking again reuses the pending login', loginAgain.authUrl === login.authUrl && tsLog().filter((a) => a.includes('up')).length === 1)
  writeState({ backendState: 'Running' })

  /* ---------------- rate limit (last: it blocks pairing for a minute) ---------------- */
  // Earlier sections spent some of the minute's budget; count what is left.
  await local('/api/remote/pairing')
  const statuses: number[] = []
  let burned = false
  for (let i = 0; i < 12; i++) {
    statuses.push((await post('/api/remote/pair', { code: 'WRONGCOD' }, viaTailnet())).status)
    if (i === 4) burned = ((await (await get('/api/remote')).json()) as { pairing: { active: boolean } }).pairing.active === false
  }
  check('rate limit: repeated wrong codes hit 429', statuses.slice(-2).every((s) => s === 429), statuses)
  check('rate limit: five wrong codes burn the code', burned, statuses)
} finally {
  await runCleanups()
}

for (const label of passed) console.log(`  ok   ${label}`)
for (const failure of failures) console.log(`  FAIL ${failure}`)
console.log(`\nremote: ${passed.length} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
