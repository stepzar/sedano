import { useSyncExternalStore } from 'react'
import { apiHttp, isDesktop } from './store.ts'

/**
 * App updates, through Tauri's updater plugin.
 *
 * The desktop app asks GitHub for `latest.json` (the endpoint and the public
 * key live in `tauri.conf.json`) shortly after it opens and every few hours
 * after that; the user picks when to install and when to restart. Nothing here
 * runs in a browser tab or on a paired phone — those load the UI from the
 * server and update with the Mac — nor under `tauri dev`, where the version is
 * whatever the checkout says.
 *
 * Every failure ends up on screen (the pill, Settings and a toast for the ones
 * the user asked for): an updater that fails quietly is how an app stays on an
 * old release without anyone knowing.
 */
export type UpdatePhase =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'current'; checkedAt: number }
  | { phase: 'available'; version: string }
  | { phase: 'installing'; version: string; percent: number | null }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; during: 'check' | 'install' | 'restart'; message: string }

const FIRST_CHECK_DELAY_MS = 10_000
const CHECK_EVERY_MS = 4 * 60 * 60_000

let state: UpdatePhase = { phase: 'idle' }
const listeners = new Set<() => void>()
/** The plugin's handle on the pending update; `downloadAndInstall` lives on it. */
let pending: { version: string; downloadAndInstall: (onEvent?: (event: DownloadEvent) => void) => Promise<void> } | null = null

type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' }

function set(next: UpdatePhase): void {
  state = next
  for (const listener of listeners) listener()
}

export function useUpdate(): UpdatePhase {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => state,
  )
}

/** Updates are the desktop shell's: a browser or a phone has nothing to install. */
export function canUpdate(): boolean {
  return isDesktop()
}

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.trim() || 'unknown error'
}

/**
 * Asks the endpoint whether a newer release exists. Returns the phase it ended
 * in so a caller that asked explicitly can say so. A check never interrupts an
 * install already under way, and an update already installed stays "ready".
 */
export async function checkForUpdate(): Promise<UpdatePhase> {
  if (!canUpdate()) return state
  if (state.phase === 'checking' || state.phase === 'installing' || state.phase === 'ready') return state
  set({ phase: 'checking' })
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check()
    if (update) {
      pending = update
      set({ phase: 'available', version: update.version })
    } else {
      pending = null
      set({ phase: 'current', checkedAt: Date.now() })
    }
  } catch (error) {
    set({ phase: 'error', during: 'check', message: describe(error) })
  }
  return state
}

/** Downloads, verifies (the plugin checks the signature) and installs the pending update. */
export async function installUpdate(): Promise<void> {
  if (!pending) {
    await checkForUpdate()
    if (!pending) return
  }
  const update = pending
  let total = 0
  let received = 0
  set({ phase: 'installing', version: update.version, percent: null })
  try {
    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') total = event.data.contentLength ?? 0
      if (event.event === 'Progress') {
        received += event.data.chunkLength
        set({ phase: 'installing', version: update.version, percent: total ? Math.min(100, Math.round((received / total) * 100)) : null })
      }
    })
    set({ phase: 'ready', version: update.version })
  } catch (error) {
    set({ phase: 'error', during: 'install', message: describe(error) })
  }
}

/** Quits and reopens on the installed version; the shell stops its server on the way out. */
export async function restartToUpdate(): Promise<void> {
  try {
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  } catch (error) {
    set({ phase: 'error', during: 'restart', message: describe(error) })
  }
}

/** The running app's version (desktop), else the server's (browser, phone). */
export async function currentVersion(): Promise<string | null> {
  try {
    if (isDesktop()) {
      const { getVersion } = await import('@tauri-apps/api/app')
      return await getVersion()
    }
    const response = await fetch(apiHttp('/api/health'))
    return response.ok ? (((await response.json()) as { version?: string }).version ?? null) : null
  } catch {
    return null
  }
}

/** True under the vite dev server (`tauri dev`); vite replaces `import.meta.env` at build time. */
const DEV_SERVER = Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV)

let started = false

/** Once per page: a first check shortly after launch, then every few hours. */
export function startUpdateChecks(): void {
  if (started || !canUpdate() || DEV_SERVER) return
  started = true
  setTimeout(() => void checkForUpdate(), FIRST_CHECK_DELAY_MS)
  setInterval(() => void checkForUpdate(), CHECK_EVERY_MS)
}
