import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LimitSnapshot } from '@shared'
import { windowLabel } from '@shared'

/**
 * Command Code's own account, read from its API.
 *
 * Its CLI keeps credits and windows behind an account endpoint rather than in a
 * local file, which is why this used to be a note saying nothing could be read.
 * The key is the one `cmd login` already wrote (`~/.commandcode/auth.json`), and
 * the endpoints are the ones its own `/usage` overlay calls — the same numbers,
 * in the shape this app already shows for Claude Code.
 */
const API_BASE = 'https://api.commandcode.ai'
const CACHE_MS = 60_000

interface AuthFile {
  apiKey?: string
  userName?: string
}

interface CreditsResponse {
  credits?: { monthlyCredits?: number; purchasedCredits?: number; freeCredits?: number }
  windowLimits?: {
    fiveHour?: { used?: number; cap?: number; resetAt?: number }
    weekly?: { used?: number; cap?: number; resetAt?: number }
  }
}

interface SubscriptionResponse {
  data?: { planId?: string; status?: string }
}

let cached: { at: number; value: LimitSnapshot } | null = null

/** The key `cmd login` wrote, on this machine. */
export function commandCodeAuth(): AuthFile | null {
  const path = process.env.COMMANDCODE_AUTH_FILE ?? join(homedir(), '.commandcode', 'auth.json')
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AuthFile
  } catch {
    return null
  }
}

async function get<T>(path: string, key: string): Promise<T | null> {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(12_000),
    })
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  }
}

function window(
  label: string,
  minutes: number,
  window: { used?: number; cap?: number; resetAt?: number } | undefined,
): LimitSnapshot['windows'][number] | null {
  const cap = window?.cap ?? 0
  if (!cap) return null
  return {
    label: windowLabel(minutes),
    windowMinutes: minutes,
    usedPercent: Math.min(100, Math.max(0, ((window?.used ?? 0) / cap) * 100)),
    resetsAt: window?.resetAt ?? null,
  }
}

/** What the plan is called, when the id is one of the readable ones. */
function planName(id: string | undefined): string | null {
  if (!id) return null
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export async function fetchCommandCodeLimits(force = false): Promise<LimitSnapshot | null> {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.value
  const auth = commandCodeAuth()
  if (!auth?.apiKey) return null
  const [credits, subscription] = await Promise.all([
    get<CreditsResponse>('/alpha/billing/credits', auth.apiKey),
    get<SubscriptionResponse>('/alpha/billing/subscriptions', auth.apiKey),
  ])
  if (!credits) return null
  const windows = [
    window('5h', 300, credits.windowLimits?.fiveHour),
    window('7d', 10_080, credits.windowLimits?.weekly),
  ].filter((item): item is NonNullable<typeof item> => item !== null)
  const money = credits.credits ?? {}
  const balance = (money.monthlyCredits ?? 0) + (money.purchasedCredits ?? 0) + (money.freeCredits ?? 0)
  const value: LimitSnapshot = {
    harness: 'commandcode',
    plan: planName(subscription?.data?.planId) ?? auth.userName ?? null,
    windows,
    credits: {
      hasCredits: balance > 0,
      unlimited: false,
      balance: `$${balance.toFixed(2)}`,
    },
    updatedAt: Date.now(),
    error: null,
  }
  cached = { at: Date.now(), value }
  return value
}
