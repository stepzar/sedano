import { readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join } from 'node:path'
import { CODEX_HOME } from '../paths.ts'
import type { LimitSnapshot, TokenUsage } from '@shared'
import { windowLabel } from '@shared'

const ROLLOUT_ROOT = join(CODEX_HOME, 'sessions')
const TAIL_BYTES = 512 * 1024
const CACHE_MS = 20_000

let cached: { at: number; value: CodexSnapshot } | null = null

export interface CodexRolloutStats {
  usage: TokenUsage
  contextWindow: number
  limits: LimitSnapshot | null
  updatedAt: number
  rolloutPath: string
}

function newestRollouts(limit = 12): string[] {
  const out: Array<{ path: string; mtime: number }> = []
  const walk = (dir: string, depth: number) => {
    if (depth > 4) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full, depth + 1)
      else if (name.endsWith('.jsonl')) out.push({ path: full, mtime: st.mtimeMs })
    }
  }
  walk(ROLLOUT_ROOT, 0)
  return out
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((e) => e.path)
}

function readTail(path: string, bytes = TAIL_BYTES): string {
  const st = statSync(path)
  const start = Math.max(0, st.size - bytes)
  const length = st.size - start
  if (length <= 0) return ''
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(length)
    readSync(fd, buf, 0, length, start)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function mapUsage(info: any): TokenUsage {
  const u = info ?? {}
  return {
    input: Number(u.input_tokens ?? 0),
    output: Number(u.output_tokens ?? 0),
    cacheRead: Number(u.cached_input_tokens ?? 0),
    cacheWrite: Number(u.cache_write_input_tokens ?? 0),
    reasoning: Number(u.reasoning_output_tokens ?? 0),
  }
}

/**
 * Codes the backend can report instead of a percentage. Human wording matters:
 * "credits exhausted" is information, a raw snake_case code looks like a bug.
 */
const REASON_TEXT: Record<string, string> = {
  workspace_member_credits_depleted: 'workspace credits exhausted',
  workspace_credits_depleted: 'workspace credits exhausted',
  personal_credits_depleted: 'personal credits exhausted',
  rate_limit_reached: 'rate limit reached',
  rate_limit_exceeded: 'rate limit exceeded',
}

export function humanizeReason(code: string): string {
  return REASON_TEXT[code] ?? code.replace(/_/g, ' ')
}

function mapLimits(rateLimits: any, plan: string | null): LimitSnapshot | null {
  if (!rateLimits) return null
  const windows = []
  for (const bucket of ['primary', 'secondary'] as const) {
    const b = rateLimits[bucket]
    if (!b || typeof b.used_percent !== 'number') continue
    const minutes = Number(b.window_minutes ?? 0)
    windows.push({
      usedPercent: Math.max(0, Math.min(100, Number(b.used_percent))),
      windowMinutes: minutes,
      resetsAt: typeof b.resets_at === 'number' ? b.resets_at * 1000 : null,
      label: windowLabel(minutes),
    })
  }
  return {
    harness: 'codex',
    plan: typeof rateLimits.plan_type === 'string' ? rateLimits.plan_type : plan,
    windows,
    credits: rateLimits.credits
      ? {
          hasCredits: Boolean(rateLimits.credits.has_credits),
          unlimited: Boolean(rateLimits.credits.unlimited),
          balance: rateLimits.credits.balance != null ? String(rateLimits.credits.balance) : null,
        }
      : null,
    updatedAt: Date.now(),
    error: rateLimits.rate_limit_reached_type
      ? humanizeReason(String(rateLimits.rate_limit_reached_type))
      : null,
  }
}

/**
 * Codex writes `token_count` events (with token usage, the model context window
 * and the rate-limit buckets) into its rollout files while a session runs, so we
 * can read live usage without asking the CLI anything.
 */
export function readCodexRollout(path: string): CodexRolloutStats | null {
  let text: string
  try {
    text = readTail(path)
  } catch {
    return null
  }
  const lines = text.split('\n')
  let found: CodexRolloutStats | null = null
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.includes('token_count')) {
      if (!found && line.includes('"model_context_window"')) {
        // keep scanning for the token_count payload
      }
      continue
    }
    let parsed: any
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    const payload = parsed?.payload
    if (payload?.type !== 'token_count') continue
    const info = payload.info ?? {}
    found = {
      usage: mapUsage(info.total_token_usage ?? info.last_token_usage),
      contextWindow: Number(info.model_context_window ?? 0),
      limits: mapLimits(payload.rate_limits, payload.rate_limits?.plan_type ?? null),
      updatedAt: Date.parse(parsed.timestamp ?? '') || Date.now(),
      rolloutPath: path,
    }
    break
  }
  return found
}

export interface CodexSnapshot {
  limits: LimitSnapshot | null
  usage: TokenUsage
  contextWindow: number
}

export function codexSnapshot(force = false): CodexSnapshot {
  const now = Date.now()
  if (!force && cached && now - cached.at < CACHE_MS) return cached.value

  let best: CodexRolloutStats | null = null
  for (const path of newestRollouts()) {
    const stats = readCodexRollout(path)
    if (stats) {
      best = stats
      // Prefer a rollout that actually carries rate-limit buckets.
      if (stats.limits) break
    }
  }
  const value: CodexSnapshot = {
    limits: best?.limits ?? null,
    usage: best?.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    contextWindow: best?.contextWindow ?? 0,
  }
  cached = { at: now, value }
  return value
}

export function fetchCodexLimits(force = false): LimitSnapshot | null {
  return codexSnapshot(force).limits
}
