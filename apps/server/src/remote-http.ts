/**
 * The HTTP side of remote mode: the pairing page a phone lands on, and the
 * `/api/remote*` endpoints the desktop UI drives it with.
 *
 * Management (turning remote mode on, pairing codes, devices, tailscale) is
 * local-only: a paired phone can use Sedano but cannot mint more devices or
 * change who is let in.
 */
import type { Access } from './remote.ts'
import * as remote from './remote.ts'
import * as tailscale from './tailscale.ts'
import { SEDANO_INSTANCE } from './paths.ts'

type RemoteAccess = Extract<Access, { kind: 'remote' }>

/** What an unpaired phone may fetch: enough to pair and to add the app to its home screen. */
const PUBLIC_ASSET = /^\/(manifest\.webmanifest|icon\.svg|apple-touch-icon\.png|icons\/[a-z0-9-]+\.png)$/

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...extra } })
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function pairPage(options: { code?: string; error?: string; status?: number }): Response {
  const error = options.error ? `<p class="error">${escapeHtml(options.error)}</p>` : ''
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Sedano">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="icon" type="image/svg+xml" href="/icon.svg">
<title>Pair with Sedano</title>
<style>
  body { font: 17px -apple-system, system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; }
  main { width: min(22rem, 90vw); }
  h1 { font-size: 1.4rem; margin: 0 0 .5rem; }
  p { opacity: .75; line-height: 1.4; }
  input, button { font: inherit; width: 100%; box-sizing: border-box; padding: .8rem; border-radius: .6rem; margin-top: .6rem; }
  input { border: 1px solid #8888; letter-spacing: .15em; text-transform: uppercase; text-align: center; }
  button { border: 0; background: #2f7d32; color: #fff; font-weight: 600; }
  .error { color: #c62828; opacity: 1; }
</style>
</head>
<body>
<main>
  <h1>Pair this device</h1>
  <p>On the Mac, open Sedano → Settings → Remote access and create a pairing code.</p>
  ${error}
  <form method="post" action="/api/remote/pair">
    <input name="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" required value="${escapeHtml(options.code ?? '')}">
    <input name="name" placeholder="Device name (optional)" maxlength="64">
    <button type="submit">Pair</button>
  </form>
</main>
</body>
</html>`
  return new Response(html, {
    status: options.status ?? 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // Not `no-referrer`: under that policy a browser sends `Origin: null` with
      // the form POST (Fetch spec, "serializing a request origin"), and a null
      // Origin is — rightly — refused. `same-origin` keeps the Origin on our own
      // POST and still sends nothing to anyone else.
      'referrer-policy': 'same-origin',
      'x-frame-options': 'DENY',
    },
  })
}

async function readPairBody(req: Request): Promise<{ code: string; name: string | null; form: boolean }> {
  const type = req.headers.get('content-type') ?? ''
  if (type.includes('application/json')) {
    const body = (await req.json().catch(() => ({}))) as { code?: unknown; name?: unknown }
    return { code: String(body.code ?? ''), name: typeof body.name === 'string' ? body.name : null, form: false }
  }
  const form = new URLSearchParams(await req.text().catch(() => ''))
  return { code: form.get('code') ?? '', name: form.get('name'), form: true }
}

async function handlePair(req: Request, access: RemoteAccess): Promise<Response> {
  const body = await readPairBody(req)
  const result = remote.pair(body.code, {
    name: body.name,
    login: access.login,
    userAgent: req.headers.get('user-agent'),
  })
  if (!result.ok) {
    return body.form
      ? pairPage({ code: body.code, error: result.error, status: result.status })
      : json({ error: result.error }, result.status)
  }
  const cookie = remote.sessionCookie(result.token)
  // A 303 to `/` is a same-origin navigation, so the SameSite=Strict cookie
  // just set is sent with it.
  if (body.form) return new Response(null, { status: 303, headers: { location: '/', 'set-cookie': cookie } })
  return json({ device: result.device }, 200, { 'set-cookie': cookie })
}

/**
 * Everything a remote request without a valid device token gets: the pairing
 * page, the pairing endpoint, the install assets — and a 401 for the rest.
 */
export async function unpaired(
  req: Request,
  url: URL,
  access: RemoteAccess,
  serveStatic: (pathname: string) => Response,
): Promise<Response> {
  if (url.pathname === '/api/remote/pair' && req.method === 'POST') return handlePair(req, access)
  if (req.method === 'GET' && PUBLIC_ASSET.test(url.pathname)) return serveStatic(url.pathname)
  if (url.pathname.startsWith('/api/')) return json({ error: 'this device is not paired' }, 401)
  if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('not paired', { status: 401 })
  return pairPage({ code: url.searchParams.get('code') ?? undefined })
}

function remoteStatus() {
  const config = remote.remoteConfig()
  const effective = remote.effectiveHostname()
  return {
    config,
    hostname: { effective, detected: remote.detected().hostname, override: config.hostname },
    url: effective ? `https://${effective}/` : null,
    devices: remote.listDevices(),
    pairing: remote.pairingStatus(),
  }
}

async function tailscaleStatus(port: number) {
  const { instance } = remote.remoteConfig().tailscale
  const node = await tailscale.nodeStatus(instance)
  let serve: tailscale.ServeStatus | null = null
  let serveError: string | null = null
  if (node.dnsName) {
    try {
      serve = await tailscale.serveStatus(instance, node.dnsName, port)
    } catch (err) {
      serveError = err instanceof Error ? err.message : String(err)
    }
  }
  const allowed = remote.remoteConfig().allowedLogin
  return {
    instance,
    cli: tailscale.cliBinary(instance),
    daemon: await tailscale.daemonStatus(),
    node,
    loginAllowed: !allowed || node.login === allowed,
    serve,
    serveError,
  }
}

type Action = 'serve-start' | 'serve-stop' | 'login' | 'daemon-install' | 'daemon-uninstall'

async function tailscaleAction(action: Action, port: number): Promise<unknown> {
  const config = remote.remoteConfig()
  const { instance, nodeName } = config.tailscale
  switch (action) {
    case 'daemon-install':
      return { daemon: await tailscale.daemonInstall() }
    case 'daemon-uninstall':
      return { daemon: await tailscale.daemonUninstall() }
    case 'login':
      if (instance !== 'dedicated') throw new Error('log in to the Tailscale app itself; login here is for the dedicated instance')
      return tailscale.login(nodeName)
    case 'serve-start':
    case 'serve-stop': {
      const node = await tailscale.nodeStatus(instance)
      if (!node.dnsName) throw new Error(`tailscale is not running (${node.error ?? node.backendState ?? 'no answer'})`)
      if (action === 'serve-stop') return { serve: await tailscale.serveStop(instance, node.dnsName, port) }
      if (!config.enabled) throw new Error('turn remote mode on first')
      if (config.allowedLogin && node.login !== config.allowedLogin) {
        throw new Error(`this tailscale instance is logged in as ${node.login ?? 'nobody'}, not ${config.allowedLogin}`)
      }
      if (config.hostname && config.hostname !== node.dnsName) {
        throw new Error(`the hostname override ${config.hostname} is not this node's name ${node.dnsName}`)
      }
      const serve = await tailscale.serveStart(instance, node.dnsName, port)
      await remote.refreshDetectedHostname()
      return { serve }
    }
  }
}

const ACTIONS: Action[] = ['serve-start', 'serve-stop', 'login', 'daemon-install', 'daemon-uninstall']

/** `/api/remote*`, for a local caller or a paired device. Null when the path is not ours. */
export async function handleRemoteApi(req: Request, url: URL, access: Access, port: number): Promise<Response | null> {
  if (!url.pathname.startsWith('/api/remote')) return null
  const path = url.pathname

  if (path === '/api/remote/me' && req.method === 'GET') {
    return json(access.kind === 'remote' ? { remote: true, device: access.device, login: access.login } : { remote: false })
  }
  if (path === '/api/remote/pair' && req.method === 'POST') {
    if (access.kind !== 'remote') return json({ error: 'pairing is for remote devices' }, 400)
    return handlePair(req, access)
  }
  if (path === '/api/remote/unpair' && req.method === 'POST') {
    if (access.kind !== 'remote' || !access.device) return json({ error: 'not a paired device' }, 400)
    remote.revokeDevice(access.device.id)
    return json({ ok: true }, 200, { 'set-cookie': remote.clearedCookie() })
  }

  if (access.kind !== 'local') return json({ error: 'remote access is managed from the Mac' }, 403)

  // Remote access belongs to the installed app: `tailscale serve` points at its
  // port, and the dedicated tailscaled is one launchd agent per Mac. A dev copy
  // changing either would take the phone away from the real sessions.
  if (SEDANO_INSTANCE === 'dev' && req.method !== 'GET') {
    return json({ error: 'remote access is managed by the installed Sedano app, not this development copy' }, 409)
  }

  try {
    if (path === '/api/remote' && req.method === 'GET') return json(remoteStatus())
    if (path === '/api/remote' && req.method === 'POST') {
      const patch = (await req.json().catch(() => ({}))) as remote.ConfigPatch
      remote.updateRemoteConfig(patch)
      if (remote.remoteConfig().enabled) await remote.refreshDetectedHostname()
      return json(remoteStatus())
    }
    if (path === '/api/remote/pairing' && req.method === 'POST') {
      if (!remote.remoteConfig().enabled) return json({ error: 'turn remote mode on first' }, 409)
      if (!remote.effectiveHostname()) await remote.refreshDetectedHostname()
      return json(remote.createPairingCode())
    }
    if (path === '/api/remote/pairing' && req.method === 'DELETE') {
      remote.cancelPairing()
      return json({ ok: true })
    }
    if (path.startsWith('/api/remote/devices/') && req.method === 'DELETE') {
      const id = decodeURIComponent(path.slice('/api/remote/devices/'.length))
      if (!remote.revokeDevice(id)) return json({ error: 'no such device' }, 404)
      return json({ devices: remote.listDevices() })
    }
    if (path === '/api/remote/tailscale' && req.method === 'GET') return json(await tailscaleStatus(port))
    if (path === '/api/remote/tailscale' && req.method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as { action?: string }
      if (!ACTIONS.includes(body.action as Action)) return json({ error: `action must be one of ${ACTIONS.join(', ')}` }, 400)
      try {
        return json(await tailscaleAction(body.action as Action, port))
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 409)
      }
    }
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 400)
  }
  return json({ error: 'not found' }, 404)
}
