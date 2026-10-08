/**
 * The shared tab list's one rule book, used by the server (which owns the list)
 * and by every client (which applies its own changes before the server answers).
 * Running the same function on both ends is what makes the optimistic list and
 * the server's list agree once the answer arrives.
 */
import type { OpenTab, SharedDraft, TabOp } from './wire.ts'

const MAX_TABS = 500

function indexOf(tabs: OpenTab[], id: string): number {
  return tabs.findIndex((tab) => tab.id === id)
}

export function sameDraft(a: SharedDraft | undefined, b: SharedDraft | undefined): boolean {
  if (!a || !b) return a === b
  return (
    a.cwd === b.cwd &&
    a.harness === b.harness &&
    a.model === b.model &&
    a.effort === b.effort &&
    a.permissionMode === b.permissionMode &&
    a.host === b.host &&
    a.createdAt === b.createdAt
  )
}

/** Insert `tab` right after `anchor`, or at the end when there is no such tab. */
function insertAfter(tabs: OpenTab[], tab: OpenTab, anchor: string | null | undefined): OpenTab[] {
  const at = anchor ? indexOf(tabs, anchor) : -1
  if (at < 0) return [...tabs, tab]
  return [...tabs.slice(0, at + 1), tab, ...tabs.slice(at + 1)]
}

/**
 * The list after one op. Returns the same array when nothing changed, and every
 * op is idempotent: applying it twice gives what applying it once gave.
 */
export function applyTabOp(tabs: OpenTab[], op: TabOp): OpenTab[] {
  switch (op.op) {
    case 'open': {
      const at = indexOf(tabs, op.tab.id)
      if (at < 0) return insertAfter(tabs, op.tab, op.after)
      if (sameDraft(tabs[at]!.draft, op.tab.draft)) return tabs
      return tabs.map((tab, index) => (index === at ? op.tab : tab))
    }
    case 'close': {
      return indexOf(tabs, op.id) < 0 ? tabs : tabs.filter((tab) => tab.id !== op.id)
    }
    case 'move': {
      const from = indexOf(tabs, op.id)
      if (from < 0 || op.id === op.target || indexOf(tabs, op.target) < 0) return tabs
      const moving = tabs[from]!
      const rest = tabs.filter((tab) => tab.id !== op.id)
      const to = indexOf(rest, op.target) + (op.after ? 1 : 0)
      if (to === from) return tabs
      return [...rest.slice(0, to), moving, ...rest.slice(to)]
    }
    case 'replace': {
      const from = indexOf(tabs, op.from)
      if (indexOf(tabs, op.to) >= 0) return from < 0 ? tabs : tabs.filter((tab) => tab.id !== op.from)
      // The new-session tab was closed elsewhere while it launched: the session
      // still exists and whoever launched it is looking at it, so it gets a tab.
      if (from < 0) return [...tabs, { id: op.to }]
      return tabs.map((tab, index) => (index === from ? { id: op.to } : tab))
    }
    case 'merge': {
      // A union that keeps both orders: the list's own, and each incoming tab
      // lands right after the tab it followed on the device that had it — or,
      // with nothing before it, right before the first one it preceded.
      let next = tabs
      let previous: string | null = null
      op.tabs.forEach((tab, position) => {
        if (indexOf(next, tab.id) < 0) {
          const following = previous ? undefined : op.tabs.slice(position + 1).find((later) => indexOf(next, later.id) >= 0)
          const at = following ? indexOf(next, following.id) : -1
          next = at >= 0 ? [...next.slice(0, at), tab, ...next.slice(at)] : insertAfter(next, tab, previous)
        }
        previous = tab.id
      })
      return next
    }
  }
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function asSharedDraft(value: unknown): SharedDraft | null {
  if (!value || typeof value !== 'object') return null
  const draft = value as Record<string, unknown>
  if (!isString(draft.cwd) || !isString(draft.harness) || !isString(draft.permissionMode)) return null
  if (draft.model !== null && !isString(draft.model)) return null
  if (draft.effort !== null && !isString(draft.effort)) return null
  if (draft.host !== null && !isString(draft.host)) return null
  if (typeof draft.createdAt !== 'number') return null
  return {
    cwd: draft.cwd,
    harness: draft.harness as SharedDraft['harness'],
    model: draft.model as string | null,
    effort: draft.effort as string | null,
    permissionMode: draft.permissionMode as SharedDraft['permissionMode'],
    host: draft.host as string | null,
    createdAt: draft.createdAt,
  }
}

/** One tab as sent by a client or read back from storage, or null when it is not one. */
export function asOpenTab(value: unknown): OpenTab | null {
  if (!value || typeof value !== 'object') return null
  const tab = value as Record<string, unknown>
  if (!isString(tab.id) || !tab.id || tab.id.length > 200) return null
  if (tab.draft === undefined) return { id: tab.id }
  const draft = asSharedDraft(tab.draft)
  return draft ? { id: tab.id, draft } : null
}

/** A list of tabs from outside, keeping the valid ones and the first of any duplicate id. */
export function asOpenTabs(value: unknown): OpenTab[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const tabs: OpenTab[] = []
  for (const item of value.slice(0, MAX_TABS)) {
    const tab = asOpenTab(item)
    if (!tab || seen.has(tab.id)) continue
    seen.add(tab.id)
    tabs.push(tab)
  }
  return tabs
}

/** An op from a client, validated, or null when it is malformed. */
export function asTabOp(value: unknown): TabOp | null {
  if (!value || typeof value !== 'object') return null
  const op = value as Record<string, unknown>
  switch (op.op) {
    case 'open': {
      const tab = asOpenTab(op.tab)
      if (!tab || (op.after !== undefined && op.after !== null && !isString(op.after))) return null
      return { op: 'open', tab, after: (op.after as string | null | undefined) ?? null }
    }
    case 'close':
      return isString(op.id) ? { op: 'close', id: op.id } : null
    case 'move':
      return isString(op.id) && isString(op.target) ? { op: 'move', id: op.id, target: op.target, after: op.after === true } : null
    case 'replace':
      return isString(op.from) && isString(op.to) && op.to ? { op: 'replace', from: op.from, to: op.to } : null
    case 'merge':
      return Array.isArray(op.tabs) ? { op: 'merge', tabs: asOpenTabs(op.tabs) } : null
    default:
      return null
  }
}

/** Cap on how many tabs the list keeps, so a runaway client cannot grow it forever. */
export function capTabs(tabs: OpenTab[]): OpenTab[] {
  return tabs.length > MAX_TABS ? tabs.slice(tabs.length - MAX_TABS) : tabs
}
