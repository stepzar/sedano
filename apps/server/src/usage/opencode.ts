/**
 * Opencode has no subscription window: it bills the provider keys you configured,
 * so there is no "5h/7d" to read. What it does have is a local record of what
 * those keys have cost, which is the number worth showing instead of an apology.
 *
 * `opencode stats` prints a small table; we take the one figure the panel can
 * use. It is a local spend reading, not a quota — and it is spawned
 * asynchronously with a kill timer, because it is a whole CLI, not a file read.
 */
import type { LimitSnapshot } from '@shared'
import { which } from '../which.ts'

const CACHE_MS = 10 * 60_000
const RUN_TIMEOUT_MS = 15_000

let cached: { at: number; value: LimitSnapshot } | null = null

function empty(now: number, note: string): LimitSnapshot {
  return { harness: 'opencode', plan: null, windows: [], credits: null, updatedAt: now, error: null, note }
}

/** Run the CLI and collect stdout, killing it if it hangs. */
async function runStats(bin: string): Promise<string> {
  try {
    const proc = Bun.spawn([bin, 'stats', '--pure'], { stdout: 'pipe', stderr: 'ignore' })
    const timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
    }, RUN_TIMEOUT_MS)
    const text = await new Response(proc.stdout).text()
    await proc.exited
    clearTimeout(timer)
    return text
  } catch {
    return ''
  }
}

export async function fetchOpencodeUsage(force = false): Promise<LimitSnapshot> {
  const now = Date.now()
  if (!force && cached && now - cached.at < CACHE_MS) return cached.value

  const bin = which('opencode')
  if (!bin) {
    const value = empty(now, 'Not Installed')
    cached = { at: now, value }
    return value
  }

  const output = await runStats(bin)
  const cost = /Total Cost\s+\$([0-9][0-9.,]*)/.exec(output)?.[1]
  // The note is a tag, not a sentence: the limits panel is a reading you glance
  // at, and a line of prose where a number belongs is something to read instead
  // of something to see. The balance drops the word "spent" for the same reason
  // — the row it sits in is already labelled.
  const value: LimitSnapshot = cost
    ? {
        harness: 'opencode',
        plan: 'Pay-per-use',
        windows: [],
        credits: { hasCredits: true, unlimited: false, balance: `$${cost}` },
        updatedAt: now,
        error: null,
        note: null,
      }
    : empty(now, 'No Quota · Billed To Your Own Keys')
  cached = { at: now, value }
  return value
}
