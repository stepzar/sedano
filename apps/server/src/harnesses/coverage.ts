/**
 * The coverage contract at runtime: every protocol message a harness sends is
 * checked against the mapping that says what sedano does with it (see
 * `harnesses/coverage/*.mapping.json` and `check:coverage`). A type the
 * mapping does not know is recorded once, kept across restarts, announced once
 * as a notice, and listed in Settings — so a new CLI version reveals what it
 * added the first time it is used, instead of the day somebody notices a
 * missing card.
 */
import type { UnhandledEvent } from '@shared'
import { broadcast } from '../bus.ts'
import * as db from '../db.ts'
import claudeMapping from './coverage/claude.mapping.json'
import acpMapping from './coverage/acp.mapping.json'
import commandcodeMapping from './coverage/commandcode.mapping.json'

export type CoverageProtocol = 'claude' | 'acp' | 'commandcode'

const MAPPINGS: Record<CoverageProtocol, Record<string, unknown>> = {
  claude: claudeMapping,
  acp: acpMapping,
  commandcode: commandcodeMapping,
}

const KV_KEY = 'coverage.unhandled.v1'
/** Bounded: a harness sending garbage must not grow the store without end. */
const MAX_RECORDS = 200

let records: Map<string, UnhandledEvent> | null = null

function load(): Map<string, UnhandledEvent> {
  if (records) return records
  records = new Map()
  try {
    const stored = JSON.parse(db.kvGet(KV_KEY) ?? '[]') as UnhandledEvent[]
    for (const record of stored) records.set(`${record.protocol}|${record.key}`, record)
  } catch {
    /* an unreadable list starts empty */
  }
  return records
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
function save(): void {
  // Coalesced: a burst of the same unknown frame is one write, not one per frame.
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      db.kvSet(KV_KEY, JSON.stringify([...load().values()]))
    } catch {
      /* the store may be closing */
    }
  }, 500)
}

/** Whether the mapping knows this key (handled or knowingly ignored). */
export function isMapped(protocol: CoverageProtocol, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(MAPPINGS[protocol], key)
}

/**
 * Check one protocol message. Cheap on the hot path: a hash lookup for every
 * frame, and work only for the rare key the mapping does not have.
 */
export function noteProtocol(
  protocol: CoverageProtocol,
  harness: string,
  key: string,
  options: { source?: UnhandledEvent['source']; version?: string | null } = {},
): void {
  if (!key || isMapped(protocol, key)) return
  const all = load()
  const id = `${protocol}|${key}`
  const now = Date.now()
  const known = all.get(id)
  if (known) {
    known.count += 1
    known.lastSeen = now
    save()
    return
  }
  if (all.size >= MAX_RECORDS) return
  all.set(id, {
    protocol,
    harness,
    key,
    source: options.source ?? 'live',
    version: options.version ?? null,
    firstSeen: now,
    lastSeen: now,
    count: 1,
  })
  save()
  broadcast({
    t: 'toast',
    level: 'info',
    text: `${harness} sent “${key}”, which sedano does not handle yet — listed in Settings → Unhandled events`,
  })
}

export function unhandledEvents(): UnhandledEvent[] {
  return [...load().values()].sort((a, b) => b.lastSeen - a.lastSeen)
}

/** The inventory key of a Claude stream-json frame. */
export function claudeStreamKey(rec: { type?: unknown; subtype?: unknown }): string | null {
  const type = typeof rec.type === 'string' ? rec.type : ''
  // The control channel is not part of the SDK message union: every request
  // on it is answered (see `handleControlRequest`), and responses are ours.
  if (!type || type === 'control_request' || type === 'control_response' || type === 'control_cancel_request') return null
  const subtype = typeof rec.subtype === 'string' ? rec.subtype : ''
  return type === 'system' || type === 'result' ? `stream:${type}/${subtype}` : `stream:${type}`
}
