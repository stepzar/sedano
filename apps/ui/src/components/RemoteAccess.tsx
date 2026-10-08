import { useEffect, useMemo, useState } from 'react'
import { apiHttp, confirmDialog, notify } from '../store.ts'
import { openExternal } from '../native.ts'
import { encodeQr, qrSvgPath } from '../qr.ts'
import '../remote.css'

/**
 * Settings → Remote access: the buttons for what docs/remote.md does with curl.
 * Shapes are the ones `apps/server/src/remote-http.ts` answers with; every one
 * of these endpoints is refused to a paired phone, so this panel is shown on
 * the Mac only.
 */

interface Device {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number
  login: string | null
  userAgent: string | null
}

interface RemoteStatus {
  config: {
    enabled: boolean
    hostname: string | null
    allowedLogin: string | null
    tailscale: { instance: 'app' | 'dedicated'; nodeName: string }
  }
  hostname: { effective: string | null; detected: string | null; override: string | null }
  url: string | null
  devices: Device[]
  pairing: { active: boolean; expiresAt: number | null }
}

interface TailscaleStatus {
  instance: 'app' | 'dedicated'
  cli: string | null
  daemon: { binary: string | null; installed: boolean; loaded: boolean; plist: string; socket: string }
  node: {
    reachable: boolean
    backendState: string | null
    dnsName: string | null
    login: string | null
    tailnet: string | null
    authUrl: string | null
    error: string | null
  }
  loginAllowed: boolean
  serve: { active: boolean; url: string | null; conflict: string | null; funnel: boolean } | null
  serveError: string | null
}

interface Pairing {
  code: string
  display: string
  url: string | null
  expiresAt: number
}

type Action = 'serve-start' | 'serve-stop' | 'login' | 'daemon-install' | 'daemon-uninstall'

/** What a refused or unreachable management endpoint means to the person reading. */
const NOT_HERE = 'Remote access can only be managed on the Mac that runs Sedano.'

async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let response: Response
  try {
    response = await fetch(apiHttp(path), {
      method: init?.method ?? 'GET',
      headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    })
  } catch {
    // Safari says "Load failed" for any network refusal; that is never useful here.
    throw new Error(NOT_HERE)
  }
  if (response.status === 403) throw new Error(NOT_HERE)
  const body = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `request failed (${response.status})`)
  return body
}

function ago(at: number): string {
  const diff = Date.now() - at
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} h ago`
  return `${Math.round(diff / 86_400_000)} d ago`
}

function QrCode({ text }: { text: string }) {
  const qr = useMemo(() => {
    try {
      return qrSvgPath(encodeQr(text))
    } catch {
      return null
    }
  }, [text])
  if (!qr) return null
  return (
    <svg className="remote-qr" viewBox={`0 0 ${qr.size} ${qr.size}`} shapeRendering="crispEdges" role="img" aria-label="QR code of the pairing link">
      <rect width={qr.size} height={qr.size} fill="#fff" />
      <path d={qr.path} fill="#000" />
    </svg>
  )
}

export function RemoteAccessPanel() {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [tailscale, setTailscale] = useState<TailscaleStatus | null>(null)
  const [pairing, setPairing] = useState<Pairing | null>(null)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [login, setLogin] = useState('')
  const [now, setNow] = useState(Date.now())

  const refresh = async () => {
    try {
      const next = await call<RemoteStatus>('/api/remote')
      setStatus(next)
      setLogin((current) => current || next.config.allowedLogin || '')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
    call<TailscaleStatus>('/api/remote/tailscale').then(setTailscale).catch(() => undefined)
  }

  // Polled while open: a phone pairing, or a login finishing in the browser,
  // shows up here without a manual refresh.
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 5_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!pairing) return
    const timer = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [pairing])

  const run = async (label: string, work: () => Promise<void>) => {
    setBusy(label)
    setError(null)
    try {
      await work()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
      void refresh()
    }
  }

  const patch = (body: Record<string, unknown>) =>
    run('config', async () => {
      setStatus(await call<RemoteStatus>('/api/remote', { method: 'POST', body }))
    })

  const tailscaleAction = (action: Action) =>
    run(action, async () => {
      const result = await call<{ authUrl?: string | null; state?: string }>('/api/remote/tailscale', {
        method: 'POST',
        body: { action },
      })
      if (action === 'login') setAuthUrl(result.authUrl ?? null)
    })

  const createPairing = () =>
    run('pairing', async () => {
      setPairing(await call<Pairing>('/api/remote/pairing', { method: 'POST' }))
      setNow(Date.now())
    })

  const cancelPairing = () =>
    run('pairing', async () => {
      await call('/api/remote/pairing', { method: 'DELETE' })
      setPairing(null)
    })

  const revoke = async (device: Device) => {
    const ok = await confirmDialog({
      title: `Revoke “${device.name}”?`,
      body: 'It is signed out at once and has to pair again with a new code.',
      confirmLabel: 'Revoke',
      danger: true,
    })
    if (!ok) return
    void run(`revoke-${device.id}`, async () => {
      await call(`/api/remote/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' })
      notify('success', `${device.name} revoked`)
    })
  }

  if (!status) {
    return <div className="remote-panel remote-muted">{error ?? 'Loading…'}</div>
  }

  const { config } = status
  const node = tailscale?.node
  const dedicated = config.tailscale.instance === 'dedicated'
  const secondsLeft = pairing ? Math.max(0, Math.round((pairing.expiresAt - now) / 1000)) : 0
  const pairingLive = pairing && secondsLeft > 0

  return (
    <div className="remote-panel">
      {error ? <div className="remote-error" role="alert">{error}</div> : null}

      <section className="remote-block">
        <div className="remote-line">
          <span className="remote-heading">Remote mode</span>
          <span className="spacer" />
          <button
            className={`switch${config.enabled ? ' on' : ''}`}
            role="switch"
            aria-checked={config.enabled}
            aria-label="Remote mode"
            disabled={busy === 'config'}
            onClick={() => patch({ enabled: !config.enabled })}
          >
            <span className="knob" />
          </button>
        </div>
        <p className="remote-muted">
          {config.enabled
            ? status.url
              ? <>Reachable at <span className="mono">{status.url}</span> once published below.</>
              : 'On. The tailnet name is not known yet — start Tailscale below.'
            : 'Off: requests that come through a proxy are refused.'}
        </p>
        <div className="remote-line wrap">
          <label className="remote-field">
            <span>Only this Tailscale login</span>
            <input
              value={login}
              placeholder="you@example.com (anyone on the tailnet if empty)"
              spellCheck={false}
              autoCapitalize="off"
              onChange={(event) => setLogin(event.target.value)}
              onBlur={() => {
                const next = login.trim() || null
                if (next !== config.allowedLogin) void patch({ allowedLogin: next })
              }}
            />
          </label>
          <div className="segment" role="group" aria-label="Tailscale instance">
            {(['app', 'dedicated'] as const).map((instance) => (
              <button
                key={instance}
                className={config.tailscale.instance === instance ? 'on' : ''}
                onClick={() => patch({ tailscale: { instance } })}
                title={instance === 'app' ? 'The Tailscale app already on this Mac' : 'A second tailscaled for a personal tailnet'}
              >
                {instance === 'app' ? 'Tailscale app' : 'Dedicated'}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="remote-block">
        <div className="remote-line">
          <span className="remote-heading">Tailscale</span>
          <span className={`chip${node?.backendState === 'Running' ? '' : ' warn'}`}>
            {!tailscale ? 'checking…' : node?.reachable ? (node.backendState ?? 'unknown') : 'not running'}
          </span>
          <span className="spacer" />
        </div>
        {tailscale ? (
          <dl className="remote-facts">
            {node?.dnsName ? (<><dt>Name</dt><dd className="mono">{node.dnsName}</dd></>) : null}
            {node?.login ? (<><dt>Account</dt><dd className="mono">{node.login}{tailscale.loginAllowed ? '' : ' — not the allowed login'}</dd></>) : null}
            {dedicated ? (<><dt>Daemon</dt><dd>{tailscale.daemon.installed ? (tailscale.daemon.loaded ? 'installed, running' : 'installed, not loaded') : tailscale.daemon.binary ? 'not installed' : 'tailscaled not found — brew install tailscale'}</dd></>) : null}
            <dt>Published</dt>
            <dd>
              {tailscale.serve?.active ? <span className="mono">{tailscale.serve.url}</span> : 'no'}
              {tailscale.serve?.conflict ? ` — port 443 already serves ${tailscale.serve.conflict}` : ''}
              {tailscale.serve?.funnel ? ' — Funnel is on: Sedano refuses to run behind it' : ''}
            </dd>
            {node?.error && !node.reachable ? (<><dt>Error</dt><dd>{node.error}</dd></>) : null}
            {tailscale.serveError ? (<><dt>Serve</dt><dd>{tailscale.serveError}</dd></>) : null}
          </dl>
        ) : null}
        <div className="remote-actions">
          {dedicated ? (
            tailscale?.daemon.installed ? (
              <button disabled={Boolean(busy)} onClick={() => tailscaleAction('daemon-uninstall')}>Uninstall daemon</button>
            ) : (
              <button disabled={Boolean(busy)} onClick={() => tailscaleAction('daemon-install')}>Install daemon</button>
            )
          ) : null}
          {dedicated && node?.reachable && node.backendState !== 'Running' ? (
            <button disabled={Boolean(busy)} onClick={() => tailscaleAction('login')}>Log in…</button>
          ) : null}
          {tailscale?.serve?.active ? (
            <button disabled={Boolean(busy)} onClick={() => tailscaleAction('serve-stop')}>Stop publishing</button>
          ) : (
            <button
              className="primary"
              disabled={Boolean(busy) || !config.enabled || node?.backendState !== 'Running'}
              title={!config.enabled ? 'Turn remote mode on first' : undefined}
              onClick={() => tailscaleAction('serve-start')}
            >
              Publish on tailnet
            </button>
          )}
        </div>
        {authUrl ? (
          <p className="remote-muted">
            Sign in with your personal account:{' '}
            <a href={authUrl} onClick={(event) => { event.preventDefault(); void openExternal(authUrl) }}>{authUrl}</a>
          </p>
        ) : null}
      </section>

      <section className="remote-block">
        <div className="remote-line">
          <span className="remote-heading">Pair a device</span>
          <span className="spacer" />
          {pairingLive ? (
            <button disabled={busy === 'pairing'} onClick={cancelPairing}>Cancel</button>
          ) : (
            <button className="primary" disabled={!config.enabled || busy === 'pairing'} onClick={createPairing}>
              New pairing code
            </button>
          )}
        </div>
        {pairingLive ? (
          <div className="remote-pairing">
            {pairing.url ? <QrCode text={pairing.url} /> : null}
            <div className="remote-pairing-text">
              <div className="remote-code mono">{pairing.display}</div>
              <p className="remote-muted">
                Scan with the iPhone camera, or open {pairing.url ? <span className="mono">{pairing.url}</span> : 'the tailnet address'} and
                type the code. Valid once, for {Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}.
              </p>
            </div>
          </div>
        ) : (
          <p className="remote-muted">{config.enabled ? 'A code is valid for 5 minutes and can be used once.' : 'Turn remote mode on to pair a device.'}</p>
        )}
      </section>

      <section className="remote-block">
        <div className="remote-line">
          <span className="remote-heading">Paired devices</span>
          <span className="count">{status.devices.length}</span>
        </div>
        {status.devices.length ? (
          <ul className="remote-devices">
            {status.devices.map((device) => (
              <li key={device.id}>
                <div className="remote-device-text">
                  <span className="remote-device-name">{device.name}</span>
                  <span className="remote-muted">
                    {device.login ? `${device.login} · ` : ''}last seen {ago(device.lastSeenAt)}
                  </span>
                </div>
                <button className="danger" disabled={busy === `revoke-${device.id}`} onClick={() => revoke(device)}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="remote-muted">No devices yet.</p>
        )}
      </section>
    </div>
  )
}
