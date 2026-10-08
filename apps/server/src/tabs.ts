/**
 * The open tabs every client of this server shares: which tabs are open and in
 * what order. One `kv` row, read and written whole (the list is small and has
 * nothing to query). Which tab is on screen is each device's own business and
 * never reaches here.
 */
import type { CommandId, OpenTab, TabOp } from '@shared'
import { applyTabOp, asOpenTabs, capTabs } from '@shared'
import { broadcast } from './bus.ts'
import { kvGet, kvSet } from './db.ts'

const TABS_KEY = 'tabs.open'

export function openTabs(): OpenTab[] {
  const raw = kvGet(TABS_KEY)
  if (!raw) return []
  try {
    return asOpenTabs(JSON.parse(raw))
  } catch {
    return []
  }
}

function save(tabs: OpenTab[]): void {
  kvSet(TABS_KEY, JSON.stringify(tabs))
}

/** Apply one op, store the result and tell every client (the sender included). */
export function applyTabs(op: TabOp, cid?: CommandId): OpenTab[] {
  const before = openTabs()
  const next = capTabs(applyTabOp(before, op))
  if (next !== before) save(next)
  // Broadcast even when nothing moved: the sender is waiting for the list to
  // stop re-applying its op, and a no-op is still an answer.
  broadcast({ t: 'tabs', tabs: next, ...(cid ? { cid } : {}) })
  return next
}

/** A deleted session takes its tab with it, on every device. */
export function forgetTab(id: string): void {
  if (openTabs().some((tab) => tab.id === id)) applyTabs({ op: 'close', id })
}

/**
 * Drop session tabs whose session is gone. Run at boot only: while clients are
 * connected, a tab can name a session that is still being created.
 */
export function pruneTabs(sessionExists: (id: string) => boolean): void {
  const tabs = openTabs()
  const kept = tabs.filter((tab) => tab.draft || sessionExists(tab.id))
  if (kept.length !== tabs.length) save(kept)
}
