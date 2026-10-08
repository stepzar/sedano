import { useSyncExternalStore } from 'react'
import { apiHttp, isDesktop } from './store.ts'

/**
 * The page as seen by the server: opened on the Mac itself, or from a paired
 * phone over the tailnet (see docs/remote.md).
 *
 * A phone whose device was revoked (or whose remote mode was switched off) is
 * answered 401 on every `/api/*` and has its socket closed with 4401. Either
 * one reloads the page, which is how the server gets to show its pairing page
 * instead of an app that silently stopped working.
 */

export interface RemoteMe {
  remote: boolean
  device?: { id: string; name: string } | null
  login?: string | null
}

/** Close code the server uses when a remote device lost its right to connect. */
export const REMOTE_REVOKED_CLOSE = 4401

let reloading = false

/** Reload once, however many requests failed at the same moment. */
export function reloadForPairing(): void {
  if (reloading) return
  reloading = true
  location.reload()
}

function isApiUrl(input: RequestInfo | URL): boolean {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  try {
    return new URL(raw, location.href).pathname.startsWith('/api/')
  } catch {
    return false
  }
}

/**
 * Wraps `fetch` once, so every API call in the app — there are many, spread
 * over the store and the panels — gets the same 401 handling without each of
 * them having to know about remote mode.
 */
export function installRemoteGuard(): void {
  const original = window.fetch.bind(window)
  const guarded = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await original(input, init)
    if (response.status === 401 && isApiUrl(input)) reloadForPairing()
    return response
  }
  window.fetch = Object.assign(guarded, { preconnect: window.fetch.preconnect }) as typeof fetch
}

let me: RemoteMe | null = null
let asked = false
const listeners = new Set<() => void>()

function askOnce(): void {
  if (asked) return
  asked = true
  void fetch(apiHttp('/api/remote/me'))
    .then(async (response) => (response.ok ? ((await response.json()) as RemoteMe) : null))
    .catch(() => null)
    .then((value) => {
      // No answer is not "local": the management UI stays hidden, and the
      // next screen that asks tries again.
      if (!value) asked = false
      me = value
      for (const listener of listeners) listener()
    })
}

/** Who the server thinks is looking; null until (and unless) it has answered. */
export function useRemoteMe(): RemoteMe | null {
  askOnce()
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => me,
  )
}

/**
 * True only once the server has said this page is on the Mac itself. Anything
 * else — still asking, no answer, a paired phone — keeps the local-only
 * management UI off the screen.
 */
export function useIsLocal(): boolean {
  return useRemoteMe()?.remote === false
}

/**
 * Whether this page is on the Mac itself, from its address alone: the desktop
 * shell, or a browser on a loopback name. A phone only ever reaches the server
 * through the tailnet name. No request, so it can gate something drawn on every
 * transcript; the server still refuses a remote caller on its own.
 */
export function isLocalPage(): boolean {
  if (isDesktop()) return true
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(location.hostname)
}
