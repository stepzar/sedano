import type { HarnessId, LimitSnapshot } from '@shared'
import { kvGet, kvSet, loadLimits, saveLimits } from '../db.ts'
import { broadcast } from '../bus.ts'
import { HARNESS_CATALOG, getAdapter } from '../harnesses/registry.ts'
import { fetchClaudeLimits } from './claude.ts'
import { fetchCodexLimits } from './codex.ts'
import { fetchOpencodeUsage } from './opencode.ts'
import { fetchCommandCodeLimits } from './commandcode.ts'
import { which } from '../which.ts'

/**
 * The readers that take a credential from this machine and send it to the
 * vendor. Each is off until the person turns it on in Settings, and the switch
 * names exactly what would be read and where it would go. Codex and opencode
 * are not here: they read files and a CLI on this machine, nothing leaves it.
 */
export const ACCOUNT_READERS = {
  claude: {
    endpoint: 'https://api.anthropic.com/api/oauth/usage',
    credential:
      'Claude Code’s OAuth token (CLAUDE_CODE_OAUTH_TOKEN, ~/.claude/.credentials.json, or the Keychain item “Claude Code-credentials”)',
  },
  commandcode: {
    endpoint: 'https://api.commandcode.ai/alpha/billing/credits and /alpha/billing/subscriptions',
    credential: 'Command Code’s API key (~/.commandcode/auth.json)',
  },
} as const

export type AccountReader = keyof typeof ACCOUNT_READERS
const READERS_KEY = 'usage.readers'

export function accountReaders(): Record<AccountReader, boolean> {
  let stored: Partial<Record<AccountReader, unknown>> = {}
  try {
    stored = JSON.parse(kvGet(READERS_KEY) ?? '{}') as Partial<Record<AccountReader, unknown>>
  } catch {
    // An unreadable value is the default: off.
  }
  return { claude: stored.claude === true, commandcode: stored.commandcode === true }
}

export function setAccountReader(id: string, on: boolean): Record<AccountReader, boolean> {
  if (!(id in ACCOUNT_READERS)) throw new Error(`no account reader called ${id}`)
  const next = { ...accountReaders(), [id]: on }
  kvSet(READERS_KEY, JSON.stringify(next))
  return next
}

/** What the panel shows for a reader that is off: an unknown, never a zero. */
function offSnapshot(harness: AccountReader): LimitSnapshot {
  return { harness, plan: null, windows: [], credits: null, updatedAt: Date.now(), error: null, off: true }
}

let latest: LimitSnapshot[] = loadLimits()
let inflight: Promise<LimitSnapshot[]> | null = null
let inflightForced = false

/** When a harness reported live limits itself (it is the authoritative source). */
const liveAt = new Map<HarnessId, number>()
const LIVE_WINS_MS = 3 * 60_000
/** A recent reading with numbers beats an empty panel, so keep it that long. */
const STALE_OK_MS = 12 * 60 * 60_000

/**
 * Which harnesses have nothing to read, as a tag.
 *
 * Claude Code, Codex and Command Code all publish a window; the rest say so in
 * three words rather than a sentence, because this panel is a reading you glance
 * at — what you need is which harness and how much, not an explanation to read
 * instead. `refreshLimits` keeps the full reason for the log.
 */
const NO_READER: Partial<Record<HarnessId, string>> = {
  gemini: 'No Usage API',
  grok: 'No Usage API',
  freebuff: 'No Usage API',
}

let explained: LimitSnapshot[] = []

function buildExplanations(): LimitSnapshot[] {
  const now = Date.now()
  const out: LimitSnapshot[] = []
  for (const item of HARNESS_CATALOG) {
    const note = NO_READER[item.id]
    if (!note || !getAdapter(item.id) || !which(item.bin)) continue
    out.push({ harness: item.id, plan: null, windows: [], credits: null, updatedAt: now, error: null, note })
  }
  return out
}

export function currentLimits(): LimitSnapshot[] {
  if (!explained.length) explained = buildExplanations()
  // A reader that is off shows that it is off — not the numbers an earlier poll
  // left in the store. A reading the running harness reported itself (a live
  // one) is not a poll and still counts.
  const readers = accountReaders()
  const shown = latest.filter(
    (snapshot) => !(snapshot.harness in readers) || readers[snapshot.harness as AccountReader] || liveAt.has(snapshot.harness),
  )
  const off = (Object.keys(readers) as AccountReader[])
    .filter((id) => !readers[id] && !shown.some((snapshot) => snapshot.harness === id) && installed(id))
    .map(offSnapshot)
  // Harnesses that do report take precedence: a note is only ever an answer for
  // the ones that cannot.
  const missing = explained.filter((note) => ![...shown, ...off].some((snapshot) => snapshot.harness === note.harness))
  return [...shown, ...off, ...missing]
}

/** Whether this machine has the harness at all: no switch talk for a tool you do not use. */
function installed(harness: HarnessId): boolean {
  const item = HARNESS_CATALOG.find((entry) => entry.id === harness)
  return Boolean(item && getAdapter(harness) && which(item.bin))
}

/** Publish limits observed directly on a running harness stream. */
export function publishLimits(snapshot: LimitSnapshot): void {
  liveAt.set(snapshot.harness, snapshot.updatedAt)
  latest = [snapshot, ...latest.filter((s) => s.harness !== snapshot.harness)]
  saveLimits(snapshot)
  // `currentLimits()`, not `latest`: the harnesses that have no quota to report
  // exist only in the explanations, so broadcasting the raw list published four
  // harnesses where the periodic broadcast published six. The panel then gained
  // and lost two sections on every poll — the rows under them moving 151px while
  // someone was reading them. One list, from one place, or the readout flickers.
  broadcast({ t: 'limits', limits: currentLimits() })
}

function isLiveFresh(harness: HarnessId): boolean {
  return Date.now() - (liveAt.get(harness) ?? 0) < LIVE_WINS_MS
}

export async function refreshLimits(force = false): Promise<LimitSnapshot[]> {
  if (inflight) {
    const wasForced = inflightForced
    const result = await inflight
    if (!force || wasForced) return result
    // A click made during the background poll still deserves a forced read.
    if (inflight) return inflight
  }
  inflightForced = force
  inflight = (async () => {
    const readers = accountReaders()
    const results = await Promise.allSettled([
      readers.claude ? fetchClaudeLimits(force) : null,
      Promise.resolve(fetchCodexLimits(force)),
      fetchOpencodeUsage(force),
      readers.commandcode ? fetchCommandCodeLimits(force) : null,
    ])
    const fetched: LimitSnapshot[] = []
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) fetched.push(result.value)
    }

    const snapshots: LimitSnapshot[] = []
    for (const previous of latest) {
      const fresh = fetched.find((s) => s.harness === previous.harness)
      if (!fresh) {
        snapshots.push(previous)
        continue
      }
      // Even a manual refresh must not replace an authoritative live reading
      // with a credential/file poll. We still run the poll; the UI explains
      // when the live reading was already the newest available answer.
      if (isLiveFresh(previous.harness) && !previous.error) {
        snapshots.push(previous)
        continue
      }
      // The poll failed but we still hold a recent real reading: keep the
      // numbers and surface the reason instead of blanking the panel. The
      // reading's own timestamp is preserved so staleness stays visible.
      if (previous.windows.length && !fresh.windows.length && fresh.error) {
        const age = Date.now() - previous.updatedAt
        if (age < STALE_OK_MS) {
          snapshots.push({ ...previous, error: fresh.error })
          continue
        }
      }
      snapshots.push(fresh)
    }
    for (const fresh of fetched) {
      if (!snapshots.some((s) => s.harness === fresh.harness)) snapshots.push(fresh)
    }

    latest = snapshots
    for (const snapshot of snapshots) saveLimits(snapshot)
    // Same reason as in `publishLimits`: one list, including the harnesses whose
    // answer is that they have nothing to answer.
    broadcast({ t: 'limits', limits: currentLimits() })
    return snapshots
  })()
  try {
    return await inflight
  } finally {
    inflight = null
    inflightForced = false
  }
}

/** Five minutes: the usage endpoint throttles, and a limit does not move that fast. */
export function startLimitPoller(intervalMs = 300_000): void {
  // Not forced: `bun --watch` restarts on every edit, and a forced read per
  // restart is what got the Claude endpoint to throttle us. The caches decide.
  void refreshLimits(false)
  setInterval(() => void refreshLimits(false), intervalMs)
}
