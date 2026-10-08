import type { SessionMetrics, TokenUsage } from '@shared'

const WINDOW_MS = 5000
/** Fallback when a harness only gives us text: ~4 characters per token. */
const CHARS_PER_TOKEN = 4

interface Stamp {
  t: number
  tokens: number
}

/**
 * Per-session live metrics.
 *
 * Tokens/sec is computed by us from the protocol instead of being asked of the
 * harness, which is why it stays correct. Claude Code reports real incremental
 * token counts while it produces thinking (`system/thinking_tokens`), and text
 * deltas are converted with a chars-per-token estimate.
 */
export class Meter {
  private stamps: Stamp[] = []
  private turnStart: number | null = null
  private firstTokenAt: number | null = null
  private turnTokens = 0
  /** Output the harness reported per message during the open turn. */
  private turnReportedOutput = 0
  /** Whether the open turn's calls were reported one by one (`addUsage`). */
  private turnMessages = false
  private committedOutput = 0
  /** The last finished turn's average, so an idle session does not read 0 tok/s. */
  private lastTpsAvg = 0
  private inputTokens = 0
  private cacheReadTokens = 0
  private cacheWriteTokens = 0
  private contextTokens = 0
  private contextWindow = 0
  private costUsd = 0
  private lastTtftMs: number | null = null

  beginTurn(): void {
    this.settleReportedOutput()
    this.turnStart = Date.now()
    this.firstTokenAt = null
    this.turnTokens = 0
    this.turnMessages = false
    this.stamps = []
  }

  endTurn(): void {
    this.rememberSpeed()
    this.settleReportedOutput()
    this.turnStart = null
    this.stamps = []
  }

  private rememberSpeed(): void {
    if (this.turnStart === null) return
    const elapsed = (Date.now() - this.turnStart) / 1000
    if (elapsed > 1 && this.turnTokens > 0) this.lastTpsAvg = this.turnTokens / elapsed
  }

  /** Output a message reported is real output even when no commit follows. */
  private settleReportedOutput(): void {
    this.committedOutput += this.turnReportedOutput
    this.turnReportedOutput = 0
  }

  /** Authoritative incremental output tokens. */
  addTokens(tokens: number): void {
    if (tokens <= 0) return
    const now = Date.now()
    if (this.firstTokenAt === null) {
      this.firstTokenAt = now
      if (this.turnStart !== null) this.lastTtftMs = now - this.turnStart
    }
    this.stamps.push({ t: now, tokens })
    this.turnTokens += tokens
    const cutoff = now - WINDOW_MS
    while (this.stamps.length > 400 || (this.stamps[0] && this.stamps[0].t < cutoff)) this.stamps.shift()
  }

  addChars(chars: number): void {
    this.addTokens(chars / CHARS_PER_TOKEN)
  }

  /**
   * One model call's usage: its input is the conversation's current size, and
   * its output is that message's.
   *
   * Only a single call's input is the size of the conversation: a turn that
   * made twelve calls reports twelve prompts added together, and reading that
   * sum as "context used" drew 673k in a conversation that held 45k. The output
   * counts toward the session total even when no turn is open (a transcript
   * read back after a restart), so Output no longer reads 0 beside input totals
   * that survived.
   */
  addUsage(usage: Partial<TokenUsage> | null | undefined): void {
    if (!usage) return
    this.addTotals(usage)
    const occupancy = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
    if (occupancy > 0) this.contextTokens = occupancy
    const output = usage.output ?? 0
    if (output > 0) {
      if (this.turnStart !== null) this.turnReportedOutput += output
      else this.committedOutput += output
    }
    if (this.turnStart !== null) this.turnMessages = true
  }

  private addTotals(usage: Partial<TokenUsage>): void {
    // Kept apart so the readout can say where the tokens actually went: fresh
    // input, a cache read (cheap) or a cache write.
    this.inputTokens += usage.input ?? 0
    this.cacheReadTokens += usage.cacheRead ?? 0
    this.cacheWriteTokens += usage.cacheWrite ?? 0
  }

  /**
   * Close a turn with the harness' turn total, if it gave one.
   *
   * A turn total is every call of the turn added up: never the conversation's
   * size. When the turn's messages were reported one by one, they were
   * counted already and the total would count them twice; it is only used for
   * a harness that reports nothing finer. The live chars/4 estimate is the last
   * resort for output nobody reported at all.
   */
  commitTurn(usage: Partial<TokenUsage> | null | undefined): void {
    this.rememberSpeed()
    if (this.turnMessages) {
      this.settleReportedOutput()
    } else {
      if (usage) this.addTotals(usage)
      const authoritative = usage?.output ?? 0
      this.committedOutput += authoritative > 0 ? authoritative : this.turnTokens
    }
    this.turnTokens = 0
    this.turnMessages = false
  }

  /**
   * Whether a harness ever told us a price / a context window at all.
   *
   * A meter that has been told nothing reads `0`, and `0` is also a perfectly
   * good answer — a free turn really does cost $0.00. The readout has to tell
   * those apart, or a harness that publishes no cost at all (Command Code
   * publishes none) shows a confident price it was never given.
   */
  private costSeen = false
  private contextSeen = false

  setContext(tokens: number, window: number): void {
    if (tokens > 0) this.contextTokens = tokens
    if (window > 0) {
      this.contextWindow = window
      this.contextSeen = true
    }
  }

  addCost(usd: number): void {
    // Being called at all is the report: a caller that was told nothing does not
    // call, so a genuine zero still counts as an answer.
    this.costSeen = true
    if (usd > 0) this.costUsd = usd
  }

  snapshot(): SessionMetrics {
    const now = Date.now()
    const cutoff = now - WINDOW_MS
    while (this.stamps.length && this.stamps[0]!.t < cutoff) this.stamps.shift()
    let tokens = 0
    for (const stamp of this.stamps) tokens += stamp.tokens
    const tps = tokens / (WINDOW_MS / 1000)
    const elapsed = this.turnStart !== null ? (now - this.turnStart) / 1000 : 0
    const tpsAvg = this.turnStart === null ? this.lastTpsAvg : elapsed > 1 ? this.turnTokens / elapsed : tps
    return {
      tps: Math.round(tps * 10) / 10,
      tpsAvg: Math.round(tpsAvg * 10) / 10,
      lastTtftMs: this.lastTtftMs,
      outputTokens: Math.round(this.committedOutput + Math.max(this.turnReportedOutput, this.turnTokens)),
      inputTokens: Math.round(this.inputTokens),
      cacheReadTokens: Math.round(this.cacheReadTokens),
      cacheWriteTokens: Math.round(this.cacheWriteTokens),
      contextTokens: Math.round(this.contextTokens),
      contextWindow: this.contextWindow,
      costUsd: this.costUsd,
      costReported: this.costSeen,
      contextReported: this.contextSeen,
      turnActive: this.turnStart !== null,
    }
  }

  /**
   * Continue from a reading taken before a restart. Only the numbers a restart
   * would otherwise lose: nothing about a turn in flight.
   */
  seed(saved: Partial<SessionMetrics>): void {
    this.inputTokens = saved.inputTokens ?? 0
    this.cacheReadTokens = saved.cacheReadTokens ?? 0
    this.cacheWriteTokens = saved.cacheWriteTokens ?? 0
    this.committedOutput = saved.outputTokens ?? 0
    this.contextTokens = saved.contextTokens ?? 0
    this.contextWindow = saved.contextWindow ?? 0
    this.contextSeen = saved.contextReported === true && this.contextWindow > 0
    this.costUsd = saved.costUsd ?? 0
    this.costSeen = saved.costReported === true
    this.lastTpsAvg = saved.tpsAvg ?? 0
    this.lastTtftMs = saved.lastTtftMs ?? null
  }

  /**
   * Forget the token counts, for a harness about to report its whole history
   * again (Claude's transcript is re-read from the top on every attach): the
   * replay rebuilds them, and keeping a seed as well would count it all twice.
   * The window and the price stay: a replay restates neither.
   */
  resetTokens(): void {
    this.inputTokens = 0
    this.cacheReadTokens = 0
    this.cacheWriteTokens = 0
    this.committedOutput = 0
    this.turnReportedOutput = 0
    this.contextTokens = 0
  }

  get hasContextWindow(): boolean {
    return this.contextWindow > 0
  }

  get hasContextTokens(): boolean {
    return this.contextTokens > 0
  }

  get isTurnActive(): boolean {
    return this.turnStart !== null
  }
}

/**
 * The window Claude Code gives a model when no `[1m]` suffix is asked for.
 *
 * Read from the CLI's own model table (`context:{window:…, native_1m}` in the
 * 2.1.x binary): Opus 4.7 and later, Sonnet 5 and later, Fable and Mythos run
 * 1M natively, so plain `--model opus` is already a 1M session and a "200k"
 * readout for it was wrong by five times. Older models default to 200k. This
 * is only the estimate until the CLI reports the real one (`modelUsage`).
 */
function claudeDefaultWindow(model: string): number {
  const match = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?:\b|-)/i.exec(model)
  if (!match) return model.toLowerCase().startsWith('claude') ? 200_000 : 0
  const family = match[1]!.toLowerCase()
  const version = Number(match[2]) + Number(match[3] ?? 0) / 10
  if (family === 'fable' || family === 'mythos') return 1_000_000
  if (family === 'opus' && version >= 4.7) return 1_000_000
  if (family === 'sonnet' && version >= 5) return 1_000_000
  return 200_000
}

/**
 * The context window of a model, when it is a fact and not a guess.
 *
 * `0` means "unknown on purpose": a model nobody here has heard of gets no
 * percentage, because a window invented at 200k turned a real reading into
 * nonsense — "547.0k used · 100% of 200.0k" — and a wrong number is worse than
 * no number. Only Claude's are known here (from its CLI's own table); every
 * other harness states its window or has none (see the manager's usage hook).
 */
export function guessContextWindow(model: string | null | undefined): number {
  if (!model) return 0
  if (/\[1m\]|[-/]1m\b/i.test(model)) return 1_000_000
  return claudeDefaultWindow(model)
}

/**
 * The window Claude Code states for the model it ran, from a `result` frame's
 * `modelUsage` (`{"claude-opus-5-5": {"contextWindow": 1000000, …}}`). The
 * running model's entry is preferred: a subagent on another model has its own.
 */
export function reportedContextWindow(modelUsage: unknown, model: string | null): number {
  if (!modelUsage || typeof modelUsage !== 'object') return 0
  const entries = Object.entries(modelUsage as Record<string, { contextWindow?: unknown }>)
  const own = entries.find(([id]) => model && (id === model || id.replace(/\[1m\]$/i, '') === model))
  const pick = own ?? (entries.length === 1 ? entries[0] : undefined)
  const window = pick?.[1]?.contextWindow
  return typeof window === 'number' && window > 0 ? window : 0
}

/** Keep an explicit extended-context choice when the CLI reports only the base
 * model id. If actual input exceeds the default window, that is also direct
 * evidence that the default cannot be the denominator. Unknown families stay
 * unknown rather than acquiring an invented capacity. */
export function resolveContextWindow(
  reportedModel: string | null | undefined,
  selectedModel: string | null | undefined,
  contextTokens = 0,
): number {
  const reported = guessContextWindow(reportedModel)
  const selected = guessContextWindow(selectedModel)
  // Before the CLI has named its model — a transcript read back on reattach
  // comes before any stream frame — the session's own model is the best there
  // is (after a restart it is the concrete id the CLI last confirmed).
  if (!reportedModel) return selected
  const selectedFamily = /(?:^|[-/])(opus|sonnet|fable)(?:\[|[-/]|$)/i.exec(selectedModel ?? '')?.[1]?.toLowerCase()
  if (selected === 1_000_000 && selectedFamily &&
      (reportedModel ?? '').toLowerCase().includes(selectedFamily)) return 1_000_000
  if (reported && contextTokens > reported) {
    if ((reportedModel ?? '').toLowerCase().startsWith('claude-') && contextTokens <= 1_000_000) return 1_000_000
    return 0
  }
  return reported
}
