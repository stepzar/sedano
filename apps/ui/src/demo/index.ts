/**
 * The public website's demo: the real Sedano UI with its server faked in the
 * page. Installed by `main.tsx` only in the demo build (`bun run build:demo`,
 * `VITE_SEDANO_DEMO=1`); every other build compiles this module out.
 *
 * The fake sits at the network boundary — `fetch` for `/api/*` and the
 * `WebSocket` to `/api/ws` — so every line of the app above it is the code
 * that ships. Nothing leaves the browser.
 *
 * Query parameters: `?theme=dark|light`, `?session=<id>` (open that session),
 * `?panel=limits` (open the limits panel), `?embed=1` (inside an iframe: no
 * focus-scrolling of the host page), `?phone=1` (the phone layout and
 * appearance on any browser: `phone-prepaint.js`; with `embed=1`, also the
 * iPhone's safe areas, for the landing page's phone mockup).
 *
 * Framed by the landing page (same origin only), it talks to its parent:
 *   → parent  { type: 'sedano-demo:ready', liveTheme: true }   once installed
 *   → parent  { type: 'sedano-demo:theme', theme }             Settings changed the theme
 *   ← parent  { type: 'sedano:theme', theme }                  the page's theme changed
 *   ← parent  { type: 'sedano:goto', session?, panel? }        a caption was clicked
 */
import type { ClientMsg, ServerMsg } from '@shared'
import { getState, selectSession, subscribe, updateSettings } from '../store.ts'
import { handleApi } from './http.ts'
import { installPill } from './pill.ts'
import { mountPhoneHost, wantsPhoneHost } from './phone-host.ts'
import { DemoServer, type DemoClient } from './server.ts'

/** Present in the demo bundle and nowhere else (see scripts/demo-isolated-check.ts). */
export const DEMO_MARKER = 'sedano-demo-mode-7c41'

function isApi(url: URL): boolean {
  return url.origin === location.origin && url.pathname.startsWith('/api/')
}

function installFetch(server: DemoServer): void {
  const original = window.fetch.bind(window)
  const fake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let url: URL
    try {
      url = new URL(raw, location.href)
    } catch {
      return original(input, init)
    }
    if (!isApi(url)) return original(input, init)
    if (input instanceof Request) {
      const body = input.method === 'GET' || input.method === 'HEAD' ? undefined : await input.text()
      return handleApi(server, url, { method: input.method, body, ...init })
    }
    return handleApi(server, url, init)
  }
  window.fetch = Object.assign(fake, { preconnect: window.fetch.preconnect }) as typeof fetch
}

/**
 * A WebSocket that never touches the network: messages go to the in-page
 * server and its answers come back as `message` events, asynchronously, so the
 * store sees exactly the timing shape of a real socket.
 */
function installSocket(server: DemoServer): void {
  const Native = window.WebSocket

  class DemoSocket extends EventTarget {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSING = 2
    static readonly CLOSED = 3
    readonly CONNECTING = 0
    readonly OPEN = 1
    readonly CLOSING = 2
    readonly CLOSED = 3
    readyState = 0
    readonly url: string
    readonly protocol = ''
    readonly extensions = ''
    binaryType: BinaryType = 'blob'
    bufferedAmount = 0
    onopen: ((event: Event) => void) | null = null
    onclose: ((event: CloseEvent) => void) | null = null
    onerror: ((event: Event) => void) | null = null
    onmessage: ((event: MessageEvent) => void) | null = null
    private client: DemoClient

    constructor(url: string | URL) {
      super()
      this.url = String(url)
      this.client = {
        subscribed: new Set(),
        send: (msg: ServerMsg) => {
          const data = JSON.stringify(msg)
          setTimeout(() => {
            if (this.readyState !== 1) return
            const event = new MessageEvent('message', { data })
            this.onmessage?.(event)
            this.dispatchEvent(event)
          }, 0)
        },
      }
      void server.ready.then(() =>
        setTimeout(() => {
          if (this.readyState !== 0) return
          this.readyState = 1
          const event = new Event('open')
          this.onopen?.(event)
          this.dispatchEvent(event)
          server.connect(this.client)
        }, 30),
      )
    }

    send(data: string): void {
      if (this.readyState !== 1) return
      let msg: ClientMsg
      try {
        msg = JSON.parse(String(data)) as ClientMsg
      } catch {
        return
      }
      setTimeout(() => void server.receive(this.client, msg), 0)
    }

    close(): void {
      if (this.readyState >= 2) return
      this.readyState = 3
      server.disconnect(this.client)
      const event = new CloseEvent('close', { code: 1000, wasClean: true })
      this.onclose?.(event)
      this.dispatchEvent(event)
    }
  }

  const Patched = function (this: unknown, url: string | URL, protocols?: string | string[]) {
    const target = new URL(String(url), location.href)
    if (target.pathname === '/api/ws') return new DemoSocket(url)
    return new Native(url, protocols)
  } as unknown as typeof WebSocket
  Object.assign(Patched, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })
  Patched.prototype = Native.prototype
  window.WebSocket = Patched
}

/**
 * Inside an iframe, `focus()` scrolls the host page to bring the frame into
 * view — the landing page would jump to the demo on load. Until the visitor
 * touches the demo, focusing never scrolls.
 */
function holdFocusScroll(): void {
  const original = HTMLElement.prototype.focus
  let engaged = false
  const engage = () => {
    engaged = true
  }
  window.addEventListener('pointerdown', engage, { once: true, capture: true })
  window.addEventListener('keydown', engage, { once: true, capture: true })
  HTMLElement.prototype.focus = function focus(options?: FocusOptions) {
    original.call(this, engaged ? options : { ...options, preventScroll: true })
  }
}

/** Open `?session=<id>` once the server has said hello. */
function openRequestedSession(id: string): void {
  // Already known (a caption clicked after boot): switch now.
  if (getState().sessions[id]) {
    selectSession(id)
    return
  }
  const stop = subscribe(() => {
    if (!getState().sessions[id]) return
    stop()
    // After the hello has picked its own tab, so this one wins.
    setTimeout(() => selectSession(id), 0)
  })
}

/** Open the status bar's limits panel once its readings have arrived. */
function openLimitsPanel(): void {
  const started = Date.now()
  const timer = setInterval(() => {
    const bar = document.querySelector('.limits-bar')
    if (!bar && Date.now() - started < 10_000) return
    clearInterval(timer)
    if (bar && !bar.querySelector('.limits-caret.open')) bar.closest('button')?.click()
  }, 100)
}

function goto(target: { session?: unknown; panel?: unknown }): void {
  if (typeof target.session === 'string') openRequestedSession(target.session)
  // After the session switch, so a re-render never closes the panel again.
  if (target.panel === 'limits') setTimeout(openLimitsPanel, 150)
}

/**
 * The landing page and the demo share one theme: the page's bulb drives the
 * demo live, and a theme picked in the demo's own Settings is reported back.
 */
function bridgeParent(): void {
  const parent = window.parent
  if (parent === window) return
  const root = document.documentElement
  const post = (message: unknown) => parent.postMessage(message, location.origin)
  window.addEventListener('message', (event) => {
    if (event.source !== parent || event.origin !== location.origin) return
    const data = event.data as { type?: unknown; theme?: unknown; session?: unknown; panel?: unknown } | null
    if (data?.type === 'sedano:theme' && (data.theme === 'light' || data.theme === 'dark')) {
      // Compared with what is shown, so a "System" choice that already matches survives.
      if (root.dataset.theme !== data.theme) updateSettings({ theme: data.theme })
    } else if (data?.type === 'sedano:goto') {
      goto(data)
    }
  })
  let reported = root.dataset.theme
  new MutationObserver(() => {
    if (root.dataset.theme === reported) return
    reported = root.dataset.theme
    post({ type: 'sedano-demo:theme', theme: reported })
  }).observe(root, { attributes: true, attributeFilter: ['data-theme'] })
  post({ type: 'sedano-demo:ready', liveTheme: true })
}

export async function installDemo(): Promise<void> {
  const params = new URLSearchParams(location.search)
  if (wantsPhoneHost(params)) {
    // This page only frames the phone-sized demo; the app never mounts here.
    mountPhoneHost(params)
    await new Promise(() => {})
  }
  const embedded = params.get('embed') === '1' || window.self !== window.top
  document.documentElement.dataset.demo = DEMO_MARKER
  if (embedded) {
    document.documentElement.dataset.demoEmbed = '1'
    holdFocusScroll()
  }
  const server = new DemoServer()
  installFetch(server)
  installSocket(server)
  goto({ session: params.get('session') ?? undefined, panel: params.get('panel') ?? undefined })
  installPill(embedded)
  await server.ready
  bridgeParent()
}
