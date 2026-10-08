import type { HarnessId, ModelInfo, PermissionMode } from '@shared'

/**
 * The approval modes each harness can actually be asked for.
 *
 * `PermissionMode` is the union of everything any protocol ever needed, and the
 * pickers used to offer all six to everybody — including Command Code, whose
 * headless mode has no channel to ask a question down, so `manual` was a promise
 * the CLI could not keep. Claude Code's CLI really does take all six; every
 * other harness treats `manual` as `default` and `auto` as `acceptEdits`, so
 * those two rows only ever duplicated the ones above them.
 *
 * The server is the source: `permissionModesFor()` in
 * `apps/server/src/harnesses/registry.ts` holds the reasoning and the vendor
 * evidence, and publishes the answer as `HarnessInfo.permissionModes`. The table
 * below is only what to believe when the server did not say — that field is
 * optional precisely so a UI can sit in front of an older server — and it is the
 * one place allowed to know a harness by name. Components go through
 * `permissionModeOptions` and never branch on a harness themselves.
 */
const ALIASED_MODES: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions']

const FALLBACK_MODES: Partial<Record<HarnessId, PermissionMode[]>> = {
  claude: ['default', 'acceptEdits', 'auto', 'manual', 'plan', 'bypassPermissions'],
  shell: [],
}

/**
 * The modes a picker shows, including one it is already set to.
 *
 * A session stored before a mode was withdrawn still carries it, and a select
 * whose value is not among its options shows nothing at all — which would read
 * as "no mode", not as "a mode we no longer offer". So the current value stays
 * in the list until it is changed away from.
 *
 * `offered` is what the server published for this harness on this machine. An
 * empty list is an answer — a terminal tab approves nothing — so only an absent
 * one falls back.
 */
export function permissionModeOptions(
  harness: HarnessId,
  current: PermissionMode,
  offered?: PermissionMode[],
): PermissionMode[] {
  const modes = offered ?? FALLBACK_MODES[harness] ?? ALIASED_MODES
  return modes.includes(current) ? modes : [...modes, current]
}

/**
 * Model ids, read as what they are.
 *
 * The agents hand out ids, not prose: `opencode-go/kimi-k2.7-code`,
 * `gpt-5.6-sol[high]`, `opencode-zen/muse-spark-1.3-free`. Printed as they come,
 * every row starts with the same identifier prefix — "opencode-go/…" nineteen
 * times over — and the part that tells them apart is lost off the right edge.
 *
 * So a row is rebuilt: the model's own name first, humanised, and the thing that
 * is the same on every row — the provider or plan the id starts with — pushed to
 * the end as a small tag. The same reading gives the effort: where a catalog
 * encodes it in the id (`sol[high]`), the row is the model and the effort is a
 * property of it, which is exactly how the harness wants to be asked.
 */

/** The effort words catalogs use inside an id. Anything else in `[…]` stays. */
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']

/** Words to keep uppercased when a name is humanised. */
const ACRONYMS = new Set(['gpt', 'glm', 'ai', 'vl', 'moe', 'llm', 'k2', 'm2', 'm3', 'omni'])

export interface ModelChoice {
  /** What is stored and sent: for an encoded effort, the base id plus its bracket. */
  id: string
  /** The id without the provider prefix and without the effort. */
  base: string
  /** The effort this exact id carries, when the catalog encodes one. */
  effort: string | null
  /** Whether this catalog represents effort inside the model id (`id[high]`). */
  encodedEffort: boolean
  /** The model's own name, humanised. */
  label: string
  /** Provider or plan, short, for the end of the row. */
  suffix: string | null
  /** The model the harness says it will use when no override is sent. */
  isDefault: boolean
  /** Current effort when the default is one encoded catalog row. */
  defaultEffort: string | null
}

/**
 * Claude Code stores a stable alias (`opus`, `fable[1m]`) but reports the
 * concrete model that actually ran (`claude-opus-5-5`). They are two views of
 * the same selection. Matching them here keeps the alias' label and effort
 * capabilities without replacing the truthful resolved id in the session.
 *
 * The rule is deliberately narrow: two concrete versions never match one
 * another, and no other harness' ids are folded by family.
 */
function claudeAliasFamily(id: string): string | null {
  const alias = /^(opus|sonnet|haiku|fable)(?:\[1m\])?$/.exec(id.toLowerCase())
  return alias?.[1] ?? null
}

function resolvedClaudeFamily(id: string): string | null {
  return /^claude-(opus|sonnet|haiku|fable)-/i.exec(id)?.[1]?.toLowerCase() ?? null
}

export function modelChoiceMatches(choice: ModelChoice, modelId: string): boolean {
  const wanted = readModel({ id: modelId, label: modelId })
  if (choice.base === wanted.base) return true
  const family = claudeAliasFamily(choice.base)
  // A concrete id alone cannot prove that the 1M beta variant was selected.
  // Matching it to the first family alias previously mislabeled plain `opus`
  // sessions as `opus[1m]` whenever that row came first in the catalog.
  return family !== null && !choice.base.toLowerCase().endsWith('[1m]') && family === resolvedClaudeFamily(wanted.base)
}

/** Exact id first, then the one intentional alias-to-resolved match above. */
export function findModelChoice(choices: ModelChoice[], modelId: string | null): ModelChoice | undefined {
  if (!modelId) return undefined
  const wanted = readModel({ id: modelId, label: modelId })
  return choices.find((choice) => choice.base === wanted.base) ?? choices.find((choice) => modelChoiceMatches(choice, modelId))
}

/**
 * A snapshot date at the end of a model id: `…-20251001`.
 *
 * It is the date that build was pinned, not part of the model's name, and it is
 * the single thing that makes a resolved id unreadable — "Claude Haiku 4 5
 * 20251001" is not a name anybody chose. Only a trailing eight-digit group that
 * could be a date is taken, so a model that genuinely ends in a number keeps it.
 */
const SNAPSHOT_DATE = /-(19|20)\d{6}$/

function humanise(id: string): string {
  const parts = id.replace(SNAPSHOT_DATE, '').split(/[-_/]/).filter(Boolean)
  const out: string[] = []
  for (const part of parts) {
    // A run of bare numbers is one version number the id spelled with dashes:
    // `haiku-4-5` is 4.5, not "4 5". Dots inside a part were already a version
    // and stay exactly where they are (`5.6`).
    if (/^\d+$/.test(part) && out.length && /^\d+(\.\d+)*$/.test(out[out.length - 1]!)) {
      out[out.length - 1] = `${out[out.length - 1]}.${part}`
      continue
    }
    out.push(
      ACRONYMS.has(part.toLowerCase())
        ? part.toUpperCase()
        : /^\d/.test(part)
          ? part
          : part.charAt(0).toUpperCase() + part.slice(1),
    )
  }
  return out.join(' ')
}

/**
 * A model id read as a name, for an id nobody published a label for.
 *
 * The id a session carries is the model the runtime actually resolved — the
 * driver publishes what ran rather than the alias that was asked for, because
 * the two differ and only one of them is true. That truth is unreadable
 * (`claude-haiku-4-5-20251001`), and the fix is to *render* it rather than to go
 * back to showing the alias: this is the same reading `readModel` already does,
 * exposed so a summary line or a picker row can name an id the catalog never
 * listed. An id with nothing to humanise comes back as it is — inventing a label
 * for an id we cannot read would be worse than printing it.
 */
export function modelName(id: string): string {
  return humanise(id) || id
}

/** The provider or plan an id starts with, in the short form worth showing. */
function providerTag(prefix: string): string {
  const parts = prefix.split(/[-_/]/).filter(Boolean)
  const last = parts[parts.length - 1] ?? ''
  // This is an identifier component published by the agent. It is deliberately
  // not called a plan/provider here: ACP does not assign semantics to prefixes
  // such as `opencode-go` or `opencode-zen`.
  return last || prefix
}

export function readModel(model: ModelInfo): ModelChoice {
  const raw = model.id
  const bracket = /^(.*?)\[([^\]]+)\]$/.exec(raw)
  const encoded = bracket && EFFORTS.includes(bracket[2]!.toLowerCase()) ? bracket : null
  const id = encoded ? encoded[1]! : raw
  const effort = encoded ? encoded[2]!.toLowerCase() : null
  const slash = id.indexOf('/')
  const prefix = slash > 0 ? id.slice(0, slash) : ''
  const name = slash > 0 ? id.slice(slash + 1) : id
  // The agent's own display name is metadata, not a guess. In particular ACP
  // has no standard meaning for id prefixes (`opencode-go`, `opencode-zen`), so
  // never replace a supplied label with an inferred plan or provider name.
  const supplied = model.label && model.label !== raw ? model.label : ''
  // Some ACP catalogs repeat the encoded effort in the display label. It is a
  // property controlled by the adjacent picker, not part of the model's name.
  const label = (encoded && supplied
    ? supplied.replace(/\s*\((minimal|low|medium|high|xhigh|max|ultra)\)\s*$/i, '')
    : supplied) || humanise(name) || id
  return {
    id: raw,
    base: id,
    effort,
    encodedEffort: Boolean(encoded),
    label,
    suffix: prefix ? providerTag(prefix) : null,
    isDefault: Boolean(model.isDefault),
    defaultEffort: model.isDefault ? effort : null,
  }
}

/**
 * The models to offer: one row per model, not one per effort.
 *
 * A catalog that ships `sol[low] … sol[ultra]` is six ways to ask for one model,
 * and listing them as six models hid the choice that was actually being made.
 */
export function modelChoices(models: ModelInfo[]): ModelChoice[] {
  const seen = new Map<string, ModelChoice>()
  for (const model of models) {
    const choice = readModel(model)
    const known = seen.get(choice.base)
    if (!known) {
      seen.set(choice.base, choice.encodedEffort ? { ...choice, id: choice.base, effort: null } : choice)
      continue
    }
    if (choice.isDefault) {
      known.isDefault = true
      known.defaultEffort = choice.effort
    }
    if (choice.encodedEffort && !known.encodedEffort) {
      seen.set(choice.base, {
        ...choice,
        id: choice.base,
        effort: null,
        isDefault: known.isDefault || choice.isDefault,
        defaultEffort: choice.defaultEffort ?? known.defaultEffort,
      })
    }
  }
  return [...seen.values()]
}

/** One answer for every harness, independent of how its adapter reports effort. */
export interface EffortCapability {
  /** False means the adapter has not established whether an override is legal. */
  known: boolean
  /** [] with known=true means this model has no adjustable effort. */
  levels: string[]
  fixed: boolean
}

/**
 * Normalize the two real catalog shapes: a declared `efforts` list (Claude,
 * Command Code, some ACP agents) or distinct `model[effort]` ids (Codex ACP).
 * The model catalog remains the authority; a harness name or model family
 * never grants effort values by itself. Merging both shapes also tolerates a
 * partially refreshed catalog without hiding an effort explicitly listed in
 * an id.
 */
export function effortCapability(models: ModelInfo[], base: string): EffortCapability {
  const levels: string[] = []
  let known = false
  for (const model of models) {
    const choice = readModel(model)
    if (choice.base !== base) continue
    if (model.efforts !== undefined) {
      known = true
      for (const level of model.efforts) {
        if (level && !levels.includes(level)) levels.push(level)
      }
    }
    if (choice.effort !== null) {
      known = true
      if (!levels.includes(choice.effort)) levels.push(choice.effort)
    }
  }
  return { known, levels, fixed: known && levels.length === 0 }
}

/**
 * The effort picker's rows. The word "Effort" is left out: the picker carries
 * a brain icon and a tooltip, and the composer bar has no width to spare.
 * `Unknown` is kept apart from `Default`: a catalog that said nothing is not
 * one that said "this model has no effort knob".
 */
export function effortOptions(
  capability: Pick<EffortCapability, 'levels' | 'fixed'>,
  encodedEffort: boolean,
): { value: string; label: string }[] {
  if (capability.levels.length) {
    return [
      ...(encodedEffort ? [] : [{ value: '', label: 'Auto' }]),
      ...capability.levels.map((level) => ({ value: level, label: `${level[0]!.toUpperCase()}${level.slice(1)}` })),
    ]
  }
  // Unknown is not permission to guess. A guessed `max` is exactly what made
  // OpenCode reject models whose dynamic config contains no effort selector.
  return [{ value: '', label: capability.fixed ? 'Default' : 'Unknown' }]
}

/** Compatibility helpers for consumers that only need one part of the answer. */
export function effortsFor(models: ModelInfo[], base: string): string[] {
  return effortCapability(models, base).levels
}

export function effortsAreKnown(models: ModelInfo[], base: string): boolean {
  return effortCapability(models, base).known
}

/** Drop a remembered explicit effort when this machine's catalog cannot back it. */
export function supportedEffort(models: ModelInfo[], model: string | null, effort: string | null): string | null {
  if (!effort) return null
  const selected = model
    ? findModelChoice(modelChoices(models), model)
    : modelChoices(models).find((choice) => choice.isDefault)
  if (!selected || selected.encodedEffort) return null
  return effortCapability(models, selected.base).levels.includes(effort) ? effort : null
}

/** The id to send for a model and one of its efforts. */
export function modelWithEffort(choice: ModelChoice | undefined, effort: string | null): string | null {
  if (!choice) return effort
  if (!choice.encodedEffort || !effort) return choice.base || null
  return `${choice.base}[${effort}]`
}
