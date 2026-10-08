import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CLAUDE_HOME } from '../paths.ts'
import { kvGet, kvSet } from '../db.ts'
import type { LimitSnapshot, LimitWindow } from '@shared'
import { windowLabel } from '@shared'

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const CACHE_MS = 60_000
/** Even a click does not ask again sooner than this: double clicks and restarts add up. */
const FORCE_FLOOR_MS = 20_000
/** A good reading stays useful for a long while: stale numbers with a note beat an empty card. */
const LAST_GOOD_MS = 12 * 60 * 60_000
const MIN_BACKOFF_MS = 5 * 60_000
const MAX_BACKOFF_MS = 30 * 60_000
const STATE_KEY = 'usage.claude'

type Reading = { at: number; value: LimitSnapshot }
type State = { cached: Reading | null; lastGood: Reading | null; blockedUntil: number; backoffMs: number }

/**
 * The endpoint's rate limit is per account and outlives this process, while
 * `bun --watch` restarts the server on every edit. Kept in memory only, each
 * restart forgot the block and the last reading and asked again at boot — which
 * is exactly how the reading got throttled. So the state is persisted.
 */
function loadState(): State {
  const empty: State = { cached: null, lastGood: null, blockedUntil: 0, backoffMs: MIN_BACKOFF_MS }
  try {
    const raw = kvGet(STATE_KEY)
    return raw ? { ...empty, ...(JSON.parse(raw) as Partial<State>) } : empty
  } catch {
    return empty
  }
}

const state = loadState()

function saveState(): void {
  kvSet(STATE_KEY, JSON.stringify(state))
}

/**
 * A keychain read can block on a GUI prompt (a locked keychain, a changed
 * binary signature) for as long as nobody clicks. With no deadline that one
 * read held `refreshLimits`' shared in-flight promise forever, and every later
 * refresh — the poller and the button — awaited it. Killed after a while instead.
 */
const RUN_TIMEOUT_MS = 10_000
const FETCH_TIMEOUT_MS = 15_000

async function run(cmd: string[]): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'ignore' })
    timer = setTimeout(() => {
      try {
        proc.kill()
      } catch {
        /* already gone */
      }
    }, RUN_TIMEOUT_MS)
    const out = await new Response(proc.stdout).text()
    await proc.exited
    return out
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type Credentials = { token: string; plan: string | null }

/** `team` + `default_claude_max_5x` -> `Team 5x`. */
function planName(oauth: Record<string, any> | undefined): string | null {
  const type = oauth?.subscriptionType
  if (typeof type !== 'string' || !type) return null
  const tier = typeof oauth?.rateLimitTier === 'string' ? oauth.rateLimitTier.match(/(\d+x)$/)?.[1] : undefined
  const name = type.charAt(0).toUpperCase() + type.slice(1)
  return tier ? `${name} ${tier}` : name
}

function fromJson(parsed: Record<string, any>): Credentials | null {
  const oauth = parsed?.claudeAiOauth ?? parsed?.oauth
  const token = oauth?.accessToken ?? parsed?.accessToken
  if (typeof token === 'string' && token.length > 10) return { token, plan: planName(oauth) }
  return null
}

/**
 * Claude Code keeps its OAuth credentials in the macOS keychain (or in
 * `~/.claude/.credentials.json` on headless installs). We read the token only
 * to call the same usage endpoint that powers `/usage`.
 */
export async function claudeCredentials(): Promise<Credentials | null> {
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.ANTHROPIC_OAUTH_TOKEN
  if (envToken) return { token: envToken, plan: null }

  const file = join(CLAUDE_HOME, '.credentials.json')
  try {
    const found = fromJson(JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>)
    if (found) return found
  } catch {
    /* not present */
  }

  const raw =
    process.platform === 'darwin'
      ? await run(['security', 'find-generic-password', '-s', 'Claude Code-credentials', '-w'])
      : await run(['secret-tool', 'lookup', 'service', 'Claude Code-credentials'])
  const trimmed = raw?.trim() ?? ''
  if (!trimmed) return null
  try {
    return fromJson(JSON.parse(trimmed) as Record<string, any>)
  } catch {
    // Older macOS installs stored the bare token.
    return process.platform === 'darwin' && trimmed.length > 10 ? { token: trimmed, plan: null } : null
  }
}

/** Known window keys returned by the usage endpoint. */
const WINDOW_KEYS: Array<{ key: string; minutes: number; label: string }> = [
  { key: 'five_hour', minutes: 300, label: '5h' },
  { key: 'seven_day', minutes: 10_080, label: '7d' },
  { key: 'seven_day_opus', minutes: 10_080, label: '7d opus' },
  { key: 'seven_day_sonnet', minutes: 10_080, label: '7d sonnet' },
  { key: 'seven_day_oauth_apps', minutes: 10_080, label: '7d apps' },
  { key: 'seven_day_cowork', minutes: 10_080, label: '7d cowork' },
  { key: 'monthly', minutes: 43_200, label: 'monthly' },
]

export function normalizeWindows(payload: Record<string, any>): LimitWindow[] {
  // `utilization` is a percentage (94.0 alongside `limits[].percent: 94`). It used
  // to be guessed per payload, which read 0% + 1% as a fraction: 100%, "Limit Reached".
  const windows: LimitWindow[] = []
  const push = (key: string, label: string, minutes: number, value: any) => {
    if (!value || typeof value !== 'object') return
    const used = value.utilization ?? value.used_percent ?? value.percent
    if (typeof used !== 'number') return
    const percent = used
    const resetsRaw = value.resets_at ?? value.resetsAt ?? null
    let resetsAt: number | null = null
    if (typeof resetsRaw === 'number') resetsAt = resetsRaw < 1e12 ? resetsRaw * 1000 : resetsRaw
    else if (typeof resetsRaw === 'string') {
      const parsed = Date.parse(resetsRaw)
      resetsAt = Number.isNaN(parsed) ? null : parsed
    }
    windows.push({
      usedPercent: Math.max(0, Math.min(100, percent)),
      windowMinutes: minutes,
      resetsAt,
      // Explicit label from the payload wins, otherwise derive from minutes.
      label: (typeof value.label === 'string' && value.label) || label || windowLabel(minutes),
    })
  }

  for (const spec of WINDOW_KEYS) push(spec.key, spec.label, spec.minutes, payload[spec.key])

  // Unknown extra windows, so a new plan shape still shows up — but only once
  // it is actually in use. The endpoint ships opaque keys ("nimbus quill") that
  // sit at 0% forever; a row whose name means nothing at 0% is worse than no row.
  for (const [key, value] of Object.entries(payload)) {
    if (WINDOW_KEYS.some((w) => w.key === key)) continue
    if (!value || typeof value !== 'object') continue
    if (key.startsWith('extra') || key === 'credits' || key === 'spend') continue
    const before = windows.length
    push(key, key.replace(/_/g, ' '), 0, value)
    if (windows.length > before && windows[windows.length - 1]!.usedPercent <= 0) windows.pop()
  }
  return windows
}

/**
 * When a poll fails we still know the last real numbers. Returning them with a
 * note is far more useful (and honest) than replacing the panel with "n/a". The
 * reading keeps its own `updatedAt`, so its age stays visible.
 */
function degraded(error: string, now: number): LimitSnapshot {
  const good = state.lastGood
  if (good && now - good.at < LAST_GOOD_MS) {
    const age = Math.round((now - good.at) / 60_000)
    return { ...good.value, error: `${error} · last reading ${age}m ago` }
  }
  return { harness: 'claude', plan: null, windows: [], credits: null, updatedAt: now, error }
}

function retryAfterMs(res: Response): number {
  const header = res.headers.get('retry-after')
  if (header) {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
    const date = Date.parse(header)
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  }
  return state.backoffMs
}

function remember(now: number, value: LimitSnapshot): LimitSnapshot {
  state.cached = { at: now, value }
  if (value.windows.length && !value.error) state.lastGood = { at: now, value }
  saveState()
  return value
}

export async function fetchClaudeLimits(force = false): Promise<LimitSnapshot> {
  const now = Date.now()
  const cached = state.cached
  if (cached && now - cached.at < (force ? FORCE_FLOOR_MS : CACHE_MS)) return cached.value
  if (now < state.blockedUntil) {
    const minutes = Math.ceil((state.blockedUntil - now) / 60_000)
    return degraded(`usage endpoint rate limited, retrying in ${minutes}m`, now)
  }

  const credentials = await claudeCredentials()
  if (!credentials) return remember(now, degraded('no oauth token found (keychain or ~/.claude/.credentials.json)', now))

  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${credentials.token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) {
      if (res.status === 429 || res.status === 503) {
        state.blockedUntil = now + retryAfterMs(res)
        state.backoffMs = Math.min(MAX_BACKOFF_MS, state.backoffMs * 2)
      }
      return remember(now, degraded(`usage endpoint returned ${res.status}`, now))
    }
    state.backoffMs = MIN_BACKOFF_MS
    state.blockedUntil = 0
    const payload = (await res.json()) as Record<string, any>
    const windows = normalizeWindows(payload)
    if (!windows.length) return remember(now, degraded('usage endpoint returned no windows', now))
    return remember(now, {
      harness: 'claude',
      plan: credentials.plan,
      windows,
      credits: payload?.extra_usage
        ? {
            hasCredits: Boolean(payload.extra_usage.is_enabled),
            unlimited: false,
            balance: payload.extra_usage.monthly_limit != null ? String(payload.extra_usage.monthly_limit) : null,
          }
        : null,
      updatedAt: now,
      error: null,
    })
  } catch (err) {
    return remember(now, degraded(err instanceof Error ? err.message : String(err), now))
  }
}
