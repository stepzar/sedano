/**
 * Archive, scan and import: the client half of `/api/session/archive`,
 * `/api/import/scan` and `/api/import` (see apps/server/src/imports.ts).
 */
import type { ImportScan, ImportableSession, SessionSummary } from '@shared'
import { apiHttp, getState, notify, subscribe } from './store.ts'

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(apiHttp(path), init)
  const body = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `request failed (${response.status})`)
  return body
}

function post<T>(path: string, body: unknown): Promise<T> {
  return call<T>(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
}

/** Hide a session from the rail; it stays whole and can be restored from the import popup. */
export async function archiveSession(session: SessionSummary): Promise<void> {
  try {
    await post('/api/session/archive', { sessionId: session.id, archived: true })
    notify('info', 'Session archived. Restore it with Import Sessions… on its workspace.')
  } catch (error) {
    notify('error', `Could not archive the session: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function scanImports(cwd: string, host: string | null): Promise<ImportScan> {
  const params = new URLSearchParams({ cwd })
  if (host) params.set('host', host)
  return call<ImportScan>(`/api/import/scan?${params.toString()}`)
}

/**
 * Bring one scanned conversation into Sedano — an unarchive or a native import —
 * and resolve once this client has the session, so it can be opened.
 */
export async function bringBack(item: ImportableSession, cwd: string, host: string | null): Promise<SessionSummary> {
  const { session } = item.source === 'archived'
    ? await post<{ session: SessionSummary }>('/api/session/archive', { sessionId: item.sessionId, archived: false })
    : await post<{ session: SessionSummary }>('/api/import', { harness: item.harness, nativeId: item.nativeId, cwd, host })
  return (await waitFor(() => getState().sessions[session.id], 5000)) ?? session
}

/** Resolve with the first truthy value `read` gives as the store changes, or null at the deadline. */
export function waitFor<T>(read: () => T | undefined | null | false, timeoutMs: number): Promise<T | null> {
  const now = read()
  if (now) return Promise.resolve(now)
  return new Promise((resolve) => {
    const stop = subscribe(() => {
      const value = read()
      if (!value) return
      clearTimeout(timer)
      stop()
      resolve(value)
    })
    const timer = setTimeout(() => {
      stop()
      resolve(null)
    }, timeoutMs)
  })
}
