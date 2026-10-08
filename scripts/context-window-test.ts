#!/usr/bin/env bun
/**
 * Pure context-window and token-total checks, per harness: no harness is
 * launched and no account is queried. The shapes are the ones each CLI really
 * writes (see the comments on each case for where they were read).
 */
import { Meter, guessContextWindow, reportedContextWindow, resolveContextWindow } from '../apps/server/src/metrics.ts'
import { acpCostUsd, acpPromptUsage } from '../apps/server/src/harnesses/acp/driver.ts'
import { parseCommandCodeContextDocs } from '../apps/server/src/harnesses/commandcode/adapter.ts'
import { modelsForVersions } from '../apps/server/src/harnesses/claude/adapter.ts'
import { usageValue } from '@shared'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ContextMeter } from '../apps/ui/src/components/Chrome.tsx'
import { fixtureContextReported } from '../apps/ui/src/fixtures.ts'

const failures: string[] = []
let checks = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  checks += 1
  if (!ok) failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
}

/* ------------------------------- claude ---------------------------------- */

// [reported model, selected alias, context tokens, expected window]
const cases: Array<[string, string | null, number, number]> = [
  ['claude-opus-5-5', 'opus[1m]', 100_000, 1_000_000],
  ['claude-fable-5-1', 'fable[1m]', 100_000, 1_000_000],
  // Claude Code's own table: Opus 4.7+ runs 1M natively, so plain `opus` is 1M.
  ['claude-opus-5-5', 'opus', 100_000, 1_000_000],
  ['claude-opus-4-7', 'opus', 100_000, 1_000_000],
  ['claude-sonnet-5', 'sonnet', 100_000, 1_000_000],
  ['claude-fable-5-1', 'fable', 100_000, 1_000_000],
  // Models whose default really is 200k.
  ['claude-opus-4-6', 'opus', 100_000, 200_000],
  ['claude-opus-4-20250514', null, 100_000, 200_000],
  ['claude-sonnet-4-6', 'sonnet', 100_000, 200_000],
  ['claude-haiku-4-5-20251001', 'haiku', 100_000, 200_000],
  // `[1m]` on a 200k model is the 1M option.
  ['claude-sonnet-4-6', 'sonnet[1m]', 100_000, 1_000_000],
  // An explicit 1M choice of another family does not leak onto this one.
  ['claude-sonnet-4-6', 'opus[1m]', 100_000, 200_000],
  // Occupancy above a 200k default is proof of the 1M window.
  ['claude-opus-4-6', 'opus', 216_000, 1_000_000],
  // Reattach after a restart: the transcript is read back before the CLI has
  // named its model, so the session's stored model decides (was: no window).
  [null as unknown as string, 'claude-opus-5-5', 49_799, 1_000_000],
  [null as unknown as string, 'claude-haiku-4-5-20251001', 49_799, 200_000],
  // Not a Claude model: no invented window.
  ['gpt-5.6-luna', null, 260_000, 0],
]
for (const [reported, selected, used, expected] of cases) {
  const actual = resolveContextWindow(reported, selected, used)
  check(`claude window ${reported} / ${selected} / ${used}`, actual === expected, { actual, expected })
}
check('no window is guessed for other harnesses’ models', guessContextWindow('gemini-2.5-pro') === 0 && guessContextWindow('grok-4.6') === 0)

// The live session this was found on: `--model opus`, and the CLI's result said
// `modelUsage["claude-opus-5-5"].contextWindow: 1000000` while Sedano drew 200k.
const liveModelUsage = {
  'claude-opus-5-5': { inputTokens: 39470, outputTokens: 1028962, contextWindow: 1000000, maxOutputTokens: 128000 },
}
check('the window the CLI states is read from modelUsage', reportedContextWindow(liveModelUsage, 'claude-opus-5-5') === 1_000_000)
check(
  "the running model's entry wins over a subagent's model",
  reportedContextWindow(
    { 'claude-haiku-4-5-20251001': { contextWindow: 200_000 }, 'claude-opus-5-5': { contextWindow: 1_000_000 } },
    'claude-opus-5-5',
  ) === 1_000_000,
)
check('a single entry is used before the model is known', reportedContextWindow({ 'claude-haiku-4-5': { contextWindow: 200_000 } }, null) === 200_000)
check('no modelUsage is no window', reportedContextWindow(undefined, 'claude-opus-5-5') === 0)

// The picker: a family that is natively 1M gets one row that says so.
const claudeRows = modelsForVersions({ opus: '5.5', sonnet: '4.6', haiku: '4.5', fable: '5.1' })
check('native-1M Opus is one row labelled 1M', claudeRows.filter((m) => m.id.startsWith('opus')).map((m) => `${m.id}=${m.label}`).join() === 'opus=Opus 5.5 · 1M (latest)', claudeRows)
check('native-1M Fable is one row labelled 1M', claudeRows.filter((m) => m.id.startsWith('fable')).map((m) => m.id).join() === 'fable', claudeRows)
check('a 200k Sonnet is not labelled 1M', claudeRows.find((m) => m.id === 'sonnet')?.label === 'Sonnet 4.6 (latest)', claudeRows)
const olderRows = modelsForVersions({ opus: '4.6' })
check('a 200k Opus keeps its explicit 1M row', olderRows.some((m) => m.id === 'opus[1m]') && olderRows.some((m) => m.id === 'opus'), olderRows)
const unknownRows = modelsForVersions({})
check('an unknown version keeps both rows', unknownRows.some((m) => m.id === 'opus[1m]') && unknownRows.some((m) => m.id === 'opus'), unknownRows)

/* -------------------------------- meter ---------------------------------- */

{
  // A turn with two calls reported one by one, then the turn's summed total.
  const meter = new Meter()
  meter.beginTurn()
  meter.addUsage({ input: 2, cacheRead: 40_000, cacheWrite: 1_000, output: 300 })
  meter.addUsage({ input: 3, cacheRead: 41_000, cacheWrite: 500, output: 200 })
  meter.commitTurn({ input: 5, cacheRead: 81_000, cacheWrite: 1_500, output: 500 })
  meter.endTurn()
  const snap = meter.snapshot()
  check("the conversation's size is the last call's, not the turn's sum", snap.contextTokens === 41_503, snap)
  check('per-call totals are not counted again by the turn total', snap.cacheReadTokens === 81_000 && snap.inputTokens === 5, snap)
  check('the output is the calls’ output', snap.outputTokens === 500, snap)
}
{
  // A harness that only reports the turn's total (grok, gemini, Command Code's
  // result): totals and output, and no size at all.
  const meter = new Meter()
  meter.beginTurn()
  meter.commitTurn({ input: 158_453, cacheRead: 69_120, output: 2_204 })
  const snap = meter.snapshot()
  check('a turn total is never drawn as the conversation’s size', snap.contextTokens === 0, snap)
  check('its totals and output are still counted', snap.inputTokens === 158_453 && snap.outputTokens === 2_204, snap)
}
{
  // After a restart the transcript is read back with no turn open: its output
  // counts, so "Output 0" no longer sits beside millions of cached input.
  const meter = new Meter()
  meter.addUsage({ input: 1, cacheRead: 44_000, output: 305 })
  meter.addUsage({ input: 1, cacheRead: 45_000, output: 281 })
  check('output read back from the transcript is counted', meter.snapshot().outputTokens === 586, meter.snapshot())
  // Output arriving after the turn's commit (the transcript lags the stream).
  meter.beginTurn()
  meter.addUsage({ output: 10 })
  meter.commitTurn(null)
  meter.addUsage({ output: 7 })
  meter.endTurn()
  check('late per-message output is kept, not dropped', meter.snapshot().outputTokens === 603, meter.snapshot())
}
{
  // Speed: an idle session shows the last turn's average, not 0 tok/s.
  const meter = new Meter()
  meter.beginTurn()
  ;(meter as unknown as { turnStart: number }).turnStart = Date.now() - 4_000
  meter.addTokens(400)
  meter.commitTurn({ output: 400 })
  meter.endTurn()
  const snap = meter.snapshot()
  check('an idle session keeps the last turn’s average speed', snap.tpsAvg >= 90 && snap.tpsAvg <= 110, snap)
}

/* --------------------------------- ACP ----------------------------------- */

// codex-acp: `buildPromptUsage(lastTokenUsage)`, input already without cache.
const codex = acpPromptUsage(
  { usage: { totalTokens: 60_500, inputTokens: 12_000, cachedReadTokens: 48_000, outputTokens: 500, thoughtTokens: 120 } },
  {},
)
check('codex: fresh input and cache are kept apart', codex?.input === 12_000 && codex?.cacheRead === 48_000 && codex?.reasoning === 120, codex)
// opencode: cache counters left out when zero.
const opencode = acpPromptUsage({ usage: { inputTokens: 900, outputTokens: 40, totalTokens: 940 } }, {})
check('opencode: an omitted cache counter is a zero', opencode?.cacheRead === 0 && usageValue(opencode!, 'cacheRead') === 0, opencode)
check('opencode: an omitted thought counter is unknown', usageValue(opencode!, 'reasoning') === null, opencode)
// grok: `_meta.usage`, input is the full prompt sum including the cache.
const grok = acpPromptUsage(
  { _meta: { usage: { inputTokens: 158_453, outputTokens: 2_204, cachedReadTokens: 69_120, reasoningTokens: 1_207 } } },
  { inputIncludesCache: true },
)
check('grok: usage is read from _meta, with the cached part split out', grok?.input === 158_453 - 69_120 && grok?.cacheRead === 69_120 && grok?.output === 2_204, grok)
// gemini: no `usage`, only its own quota counters.
const gemini = acpPromptUsage({ stopReason: 'end_turn', _meta: { quota: { token_count: { input_tokens: 5_000, output_tokens: 300 } } } }, {})
check('gemini: usage is read from _meta.quota', gemini?.input === 5_000 && gemini?.output === 300, gemini)
check('gemini: it has no cache counters, so they are unknown', usageValue(gemini!, 'cacheRead') === null, gemini)
check('no usage at all is no usage', acpPromptUsage({ stopReason: 'end_turn' }, {}) === null)
check('ACP cost as the schema writes it', acpCostUsd({ amount: 0.42, currency: 'USD' }) === 0.42)
check('ACP cost as a bare number', acpCostUsd(0.0123) === 0.0123)
check('ACP cost in another currency is not read as dollars', acpCostUsd({ amount: 3, currency: 'EUR' }) === null)

/* ----------------------------- Command Code ------------------------------ */

// The installed CLI's own table (`reference/models.md`), as it ships.
const docs = [
  '| Id (use EXACTLY this) | Name | Context | Efforts | $/1M in/out · cache read | Min plan | Best for |',
  '|---|---|---|---|---|---|---|',
  '| `deepseek/deepseek-v4-pro` | DeepSeek V4 Pro (latest) | 1M | high, max | $0.66/$1.98 | Go and above | x |',
  '| `gpt-5.6-sol` | GPT-5.6 Sol | 1.05M | low, high | $1/$2 | Pro | x |',
  '| `moonshotai/Kimi-K2.6` | Kimi K2.6 | 256K | — | $0.95/$4 | Go and above | x |',
  '| `claude-haiku-4-5-20251001` | Haiku 4.5 | 200K | — | $1/$5 | Go and above | x |',
].join('\n')
const windows = parseCommandCodeContextDocs(docs)
check('Command Code windows are read from its own table', windows.get('deepseek/deepseek-v4-pro') === 1_000_000 && windows.get('gpt-5.6-sol') === 1_050_000 && windows.get('moonshotai/kimi-k2.6') === 256_000 && windows.get('claude-haiku-4-5-20251001') === 200_000, [...windows])

/* ---------------------------------- UI ----------------------------------- */

const live = {
  ...fixtureContextReported,
  harness: 'claude' as const,
  metrics: { ...fixtureContextReported.metrics!, contextWindow: 200_000, contextTokens: 216_600 },
}
const markup = renderToStaticMarkup(createElement(ContextMeter, { session: live }))
check('a live 1M session never shows 100% of 200k', markup.includes('≈22%') && !markup.includes('100%'))
const stated = {
  ...fixtureContextReported,
  harness: 'claude' as const,
  metrics: { ...fixtureContextReported.metrics!, contextWindow: 1_000_000, contextTokens: 44_780, contextWindowInferred: false },
}
const statedMarkup = renderToStaticMarkup(createElement(ContextMeter, { session: stated }))
check('a window the CLI stated is drawn as 1M, without "≈"', statedMarkup.includes('>4%<') && !statedMarkup.includes('≈'), statedMarkup)

if (failures.length) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  console.error(`context-window-test: FAILED (${failures.length} of ${checks})`)
  process.exit(1)
}
console.log(`context-window-test: PASSED (${checks} checks)`)
