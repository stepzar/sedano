/**
 * ACP-backed agent sessions.
 *
 * One agent process per session, kept alive for the whole conversation: the next
 * message is another `session/prompt` on the same session id, not a new command.
 * That is what makes these agents read like a chat — the same shape claude gets
 * from print mode + `--resume`, except an ACP agent never has to restart, so its
 * context and its subagents are genuinely continuous.
 *
 * Everything the protocol streams is translated into the normalized timeline the
 * UI already renders, which is why `opencode`, `codex`, `gemini` and `grok`
 * share this file instead of one bespoke parser each.
 */
import { noteProtocol } from '../coverage.ts'
import type {
  AttachmentRef,
  EffortLevel,
  HarnessId,
  PermissionMode,
  SubagentStatus,
  TimelineEvent,
  TokenUsage,
  TokenUsageField,
} from '@shared'
import { HARNESS_LABEL, markUnreported, resultOutcomeFor, versionNumber } from '@shared'
import type { CreateOptions, Driver, DriverHooks, ModelInfo, SendResult } from '../types.ts'
import { formatFailure, isCrashReport, isStderrChatter, type FailureContext } from '../types.ts'
import { rememberCommands } from '../commands.ts'
import { withImageSupport } from '../model-images.ts'
import { AcpClient } from './client.ts'
import { attachmentBase64 } from '../../attachments.ts'
import { kvGet, kvSet } from '../../db.ts'
import { Transport, shq } from '../../transport.ts'
import { acceptEditsMayApprove } from '../workspace-scope.ts'

/** Pasted images, as ACP image content blocks. */
function imageBlocks(attachments: AttachmentRef[] | undefined): unknown[] {
  if (!attachments?.length) return []
  return attachments.flatMap((attachment) => {
    const image = attachmentBase64(attachment.id)
    if (!image) return []
    return [{ type: 'image', mimeType: image.mediaType, data: image.data }]
  })
}

export interface AcpSpec {
  /** Harness id this spec answers for (`opencode`, `codex`, ...). */
  id: string
  /** argv after the binary: `['acp']`, `['--acp']`, `[]` for a dedicated bridge. */
  args: string[]
  /**
   * The whole argv after the binary, when the flags depend on the session's own
   * options. Grok takes its model as a flag *before* its subcommand
   * (`grok agent -m grok-4.6 stdio`), which a fixed `args` cannot express.
   */
  argv?: (opts: { model: string | null; effort: EffortLevel | null }) => string[]
  /** Models to offer before the agent reports its own. */
  models: ModelInfo[]
  /** Cold starts differ wildly; gemini likes a long one. */
  initTimeoutMs?: number
  /**
   * Whose tokens the `session/prompt` usage counts. `lastCall`: the turn's
   * final model call only (codex-acp, opencode) — one call, so its input is the
   * conversation's size. `turn` (the default): every call of the turn summed
   * (grok, gemini) — never a size, only a total.
   */
  promptUsage?: 'lastCall' | 'turn'
  /** `inputTokens` includes the cached tokens (grok) rather than excluding them. */
  inputIncludesCache?: boolean
  env?: Record<string, string | undefined>
}

/** A sign-in a person has to complete, so it may take a while. */
const AUTH_TIMEOUT = 300_000

/**
 * How long a stack trace is given to finish arriving before it is reported.
 *
 * Node prints an uncaught exception as one write, but it crosses the pipe in
 * whatever chunks the OS chooses, and the first chunk is often just
 * `Error: write EPIPE`. Reporting on that line alone would throw the frames
 * away; waiting this long costs nothing a person can perceive.
 */
const CRASH_SETTLE_MS = 150

/** How many stderr lines are kept, which is several times a stack trace. */
const STDERR_TAIL = 80

/** An agent that refuses a session until somebody signs in says so this way. */
function needsSignIn(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return (
    message.includes('authentication required') ||
    message.includes('not authenticated') ||
    message.includes('unauthorized')
  )
}

/** ACP's model shape, whether it came from a handshake or from `session/new`. */
interface RawModel {
  modelId?: string
  name?: string
}

function modelInfos(models: RawModel[] | undefined): ModelInfo[] {
  return (models ?? [])
    .filter((model) => model.modelId)
    .map((model) =>
      // Labels are what these catalogs have: the agent names its models and does
      // not describe them, so the family they belong to is what says whether an
      // image can go to them (see model-images.ts).
      withImageSupport({ id: model.modelId as string, label: model.name ?? (model.modelId as string) }),
    )
}

/**
 * What the handshake already told us about the agent.
 *
 * ACP keeps a session's models in `session/new`, but every agent volunteers
 * more than the protocol asks for: gemini and codex fill in `agentInfo`, and
 * grok describes the model it is running — and the models it can run — in the
 * `initialize` result's own metadata. Reading both places costs nothing and is
 * the only way the picker can offer Grok 4.6 before anything has run, since
 * grok's `session/new` cannot be reached at all until somebody signs in.
 */
function handshakeFacts(
  init: Record<string, unknown>,
  id: string,
): { version: string | null; models: ModelInfo[]; current: string | null } {
  const info = (init as { agentInfo?: { name?: string; version?: string } }).agentInfo
  const meta = (init as { _meta?: { agentVersion?: string; modelState?: { currentModelId?: string; availableModels?: RawModel[] } } })
    ._meta
  // Only the number: `agentInfo.name` is the vendor's package name (codex-acp
  // says `@agentclientprotocol/codex-acp`), and the harness label already names it.
  const version = versionNumber(info?.version ?? meta?.agentVersion)
  return {
    version,
    models: modelInfos(meta?.modelState?.availableModels),
    current: meta?.modelState?.currentModelId ?? null,
  }
}

interface PromptUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedReadTokens?: number
  cachedWriteTokens?: number
  thoughtTokens?: number
  reasoningTokens?: number
}

interface PromptResponse {
  stopReason?: string
  usage?: PromptUsage
  _meta?: {
    /** Grok puts the standard `PromptUsage` here. */
    usage?: PromptUsage
    /** Gemini's own counters, summed over the turn's tool loop. */
    quota?: { token_count?: { input_tokens?: number; output_tokens?: number } }
  }
}

/**
 * The turn's usage, wherever this agent writes it, or null when it wrote none.
 *
 * `inputTokens` is fresh input on codex-acp and opencode, and the whole prompt
 * (cache included) on grok (`inputIncludesCache`): stored as fresh input, so
 * "Fresh input" and "From cache" never count the same tokens twice.
 */
export function acpPromptUsage(response: PromptResponse | null | undefined, spec: Pick<AcpSpec, 'inputIncludesCache'>): TokenUsage | null {
  const num = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
  const raw = response?.usage ?? response?._meta?.usage
  const quota = response?._meta?.quota?.token_count
  const input = num(raw?.inputTokens) ?? num(quota?.input_tokens)
  const output = num(raw?.outputTokens) ?? num(quota?.output_tokens)
  if (input === undefined && output === undefined) return null
  const cacheRead = num(raw?.cachedReadTokens)
  const cacheWrite = num(raw?.cachedWriteTokens)
  const reasoning = num(raw?.thoughtTokens) ?? num(raw?.reasoningTokens)
  const cached = (cacheRead ?? 0) + (cacheWrite ?? 0)
  const usage: TokenUsage = {
    input: Math.max(0, (input ?? 0) - (spec.inputIncludesCache ? cached : 0)),
    output: output ?? 0,
    cacheRead: cacheRead ?? 0,
    cacheWrite: cacheWrite ?? 0,
    reasoning: reasoning ?? 0,
  }
  const unreported: TokenUsageField[] = []
  if (input === undefined) unreported.push('input')
  if (output === undefined) unreported.push('output')
  // Optional in the schema and left out when zero (opencode), so a missing
  // cache counter on a turn that did report input is a zero, not a silence;
  // on an agent with no cache counters at all (gemini) it is a silence.
  if (!raw) unreported.push('cacheRead', 'cacheWrite')
  if (reasoning === undefined) unreported.push('reasoning')
  return markUnreported(usage, unreported)
}

/** ACP's `usage_update.cost` is `{amount, currency}`; older agents sent a bare number. */
export function acpCostUsd(cost: unknown): number | null {
  if (typeof cost === 'number' && Number.isFinite(cost)) return cost
  if (cost && typeof cost === 'object') {
    const { amount, currency } = cost as { amount?: unknown; currency?: unknown }
    if (typeof amount === 'number' && Number.isFinite(amount) && (currency === undefined || currency === 'USD')) return amount
  }
  return null
}

/* ------------------------------------------------------------------ */
/* Session config options                                              */
/* ------------------------------------------------------------------ */

/**
 * A session config option as both schema versions write it.
 *
 * The identifier was renamed `id` -> `configId` between ACP v1 and v2, and the
 * selectable values may arrive flat or grouped under headers. Reading one shape
 * only was why a model change reached agents that speak v1 and silently did
 * nothing on the ones that speak v2.
 */
interface RawConfigChoice {
  value?: string
  name?: string
}
interface RawConfigGroup {
  groupId?: string
  name?: string
  options?: RawConfigChoice[]
}
interface RawConfigOption {
  id?: string
  configId?: string
  name?: string
  category?: string
  currentValue?: string | boolean
  options?: Array<RawConfigChoice | RawConfigGroup>
}

function configIdOf(option: RawConfigOption): string | null {
  return option.configId ?? option.id ?? null
}

/** The selectable values, whether the agent grouped them or not. */
function configChoices(option: RawConfigOption): RawConfigChoice[] {
  const entries = option.options ?? []
  const grouped = entries.some((entry) => Array.isArray((entry as RawConfigGroup).options))
  if (!grouped) return entries as RawConfigChoice[]
  return entries.flatMap((entry) => (entry as RawConfigGroup).options ?? [])
}

/**
 * The option that selects the model, and the one that selects reasoning effort.
 *
 * `category` is the spec's own vocabulary (`model`, `thought_level`), and the
 * spec is explicit that it is a UX hint a client must not require: an agent that
 * names its option `model` and gives no category is still naming the model
 * selector, so the id is accepted as evidence too.
 */
function findConfigOption(options: RawConfigOption[], category: string, ids: string[]): RawConfigOption | null {
  return (
    options.find((option) => option.category === category) ??
    options.find((option) => {
      const id = configIdOf(option)
      return id !== null && ids.includes(id)
    }) ??
    null
  )
}

const ENCODED_EFFORT = /\[(minimal|low|medium|high|xhigh|max|ultra)\]$/i

/**
 * Values the agent reports for its current model's effort selector.
 * `default`/`auto`/`none` all mean "do not override" in sedano, so they are the
 * empty picker value rather than efforts we send back verbatim.
 */
function reportedEfforts(options: RawConfigOption[]): string[] | null {
  const effort = findConfigOption(options, 'thought_level', ['effort', 'reasoning_effort', 'thought_level'])
  if (!effort) return null
  return [...new Set(
    configChoices(effort)
      .map((choice) => choice.value?.trim())
      .filter((value): value is string => Boolean(value))
      .filter((value) => !['default', 'auto', 'none'].includes(value.toLowerCase())),
  )]
}

/**
 * Attach only capabilities the agent itself reported. A thought-level option is
 * session state and may change with the selected model, so its choices belong
 * to the current model; models whose ids encode effort already carry their own
 * exhaustive list. With no option, a plain model has no separate effort knob.
 */
function withReportedEfforts(
  models: ModelInfo[],
  current: string | null | undefined,
  options: RawConfigOption[],
): ModelInfo[] {
  const levels = reportedEfforts(options)
  return models.map((model) => {
    if (ENCODED_EFFORT.test(model.id)) return model
    const isCurrent = model.id === current || (!current && models.length === 1)
    // Session config describes only the selected model. Absence of the option
    // proves *that model* is fixed; it says nothing about the other rows.
    return isCurrent ? { ...model, efforts: levels ?? [] } : model
  })
}

/** Keep model-specific facts learned by an earlier capability scan. */
function mergeReportedModels(models: ModelInfo[], prior: ModelInfo[] | null): ModelInfo[] {
  if (!prior?.length) return models
  const byId = new Map(prior.map((model) => [model.id, model]))
  return models.map((model) => {
    const old = byId.get(model.id)
    return model.efforts === undefined && old?.efforts !== undefined
      ? { ...model, efforts: old.efforts }
      : model
  })
}

/**
 * Read effort capability for every model from an isolated, throwaway session.
 * ACP deliberately makes config options dynamic: changing the model returns a
 * new full option list. No prompt is sent, so this spends no model tokens and
 * cannot mutate a conversation the person is using.
 */
async function scanModelEfforts(
  client: AcpClient,
  sessionId: string | undefined,
  options: RawConfigOption[],
  models: ModelInfo[],
  timeout: number,
): Promise<ModelInfo[]> {
  if (!sessionId || !models.length) return models
  const modelOption = findConfigOption(options, 'model', ['model'])
  const configId = modelOption ? configIdOf(modelOption) : null
  if (!configId) return models

  const original = typeof modelOption?.currentValue === 'string' ? modelOption.currentValue : null
  const learned = new Map<string, string[]>()
  if (original) learned.set(original, reportedEfforts(options) ?? [])

  for (const model of models) {
    if (learned.has(model.id) || ENCODED_EFFORT.test(model.id)) continue
    try {
      const response = await client.request<{ configOptions?: RawConfigOption[] }>(
        'session/set_config_option',
        { sessionId, configId, type: 'id', value: model.id },
        timeout,
      )
      // A full response with no effort selector is an explicit "not adjustable".
      if (Array.isArray(response?.configOptions)) {
        learned.set(model.id, reportedEfforts(response.configOptions) ?? [])
      }
    } catch {
      // One provider/model refusal must not erase the rest of the catalog. This
      // row remains unknown and the UI keeps its effort selector disabled.
    }
  }

  if (original && models.some((model) => model.id === original)) {
    await client.request(
      'session/set_config_option',
      { sessionId, configId, type: 'id', value: original },
      timeout,
    ).catch(() => undefined)
  }

  return models.map((model) => {
    const efforts = learned.get(model.id)
    return efforts === undefined ? model : { ...model, efforts }
  })
}

interface ContentBlock {
  type?: string
  content?: { type?: string; text?: string }
  path?: string
  oldText?: string | null
  newText?: string
}

/**
 * Last models and version an agent reported, keyed by *machine and* harness.
 *
 * The same CLI on this laptop and on a server are two installations: two logins,
 * two plans, two sets of models. One list shared between them would offer a
 * server's models here and this laptop's models there, so every machine keeps
 * its own — the catalog of each environment is that environment's.
 */
const discovered = new Map<string, ModelInfo[]>()
const versions = new Map<string, string>()

/** A host name cannot contain `:`, so the machine key is unambiguous. */
function machineModelKey(host: string | null, id: string): string {
  return `${host ?? ''}:${id}`
}

export function discoveredModels(id: string, host: string | null = null): ModelInfo[] | null {
  return discovered.get(machineModelKey(host, id)) ?? null
}

/**
 * A list this harness reported on *some* machine, when the one being asked has
 * none: an agent that is not signed in over there still runs the same models
 * here, and an empty picker reads as "this harness has nothing".
 */
export function discoveredElsewhere(id: string): ModelInfo[] | null {
  for (const [key, models] of discovered) {
    if (key.endsWith(`:${id}`) && models.length) return models
  }
  return null
}

export function discoveredVersion(id: string, host: string | null = null): string | null {
  return versions.get(machineModelKey(host, id)) ?? null
}

/**
 * A model list is a fact about the installed agent, not about this run of the
 * server: it is cached in the store so a restart does not empty the picker until
 * the next session happens to report the list again.
 */
export /**
 * What each agent said about images at its last handshake, per machine. The
 * adapter reads this so the picker stops claiming image support at the harness
 * level for an agent that never offered it.
 */
const imageSupport = new Map<string, boolean>()

function rememberImageSupport(id: string, host: string | null, accepts: boolean): void {
  imageSupport.set(`${host ?? ''}:${id}`, accepts)
}

/** Whether that agent, on that machine, claimed image support. */
export function agentAcceptsImages(id: string, host: string | null): boolean | null {
  return imageSupport.get(`${host ?? ''}:${id}`) ?? null
}

function rememberModels(id: string, models: ModelInfo[], host: string | null = null): void {
  if (!models.length) return
  discovered.set(machineModelKey(host, id), models)
  persistModels()
}

/** The stored lists, as `{ machine: { harness: models } }`. */
const KV_MODELS = 'models'

function persistModels(): void {
  const out: Record<string, Record<string, ModelInfo[]>> = {}
  for (const [key, models] of discovered) {
    const at = key.indexOf(':')
    const machine = key.slice(0, at)
    const id = key.slice(at + 1)
    out[machine] = { ...(out[machine] ?? {}), [id]: models }
  }
  try {
    kvSet(KV_MODELS, JSON.stringify(out))
  } catch {
    /* the store may be read-only in a probe; the in-memory cache still works */
  }
}

/** Load the cached lists once, so capabilities can answer before any session. */
export function loadCachedModels(): void {
  try {
    const raw = kvGet(KV_MODELS)
    if (!raw) return
    const parsed = JSON.parse(raw) as Record<string, Record<string, ModelInfo[]>>
    for (const [machine, byHarness] of Object.entries(parsed ?? {})) {
      for (const [id, models] of Object.entries(byHarness ?? {})) {
        if (Array.isArray(models) && models.length) discovered.set(`${machine}:${id}`, models)
      }
    }
  } catch {
    /* ignore a cache entry we cannot read */
  }
}

/**
 * Ask an agent for its model list without running a turn.
 *
 * An ACP agent reports its models with `session/new`, so a handshake is enough —
 * no prompt, no tokens. It is the same exchange `scripts/acp-probe.ts` uses, and
 * it is how the picker knows about Codex's dozen models *before* you have ever
 * sent a message: otherwise the list only appeared after the first session of
 * that harness, which read as "Codex has one model".
 */
export async function primeModels(
  spec: AcpSpec,
  bin: string,
  cwd: string,
  host: string | null = null,
): Promise<ModelInfo[] | null> {
  const client = new AcpClient({
    host,
    command: [bin, ...(spec.argv?.({ model: null, effort: null }) ?? spec.args)],
    cwd,
    env: { ...spec.env },
    onNotification: () => undefined,
    onRequest: async () => ({}),
    onStderr: () => undefined,
  })
  const timeout = spec.initTimeoutMs ?? 45_000
  try {
    client.start()
    const init = await client.initialize(timeout)
    const facts = handshakeFacts(init, spec.id)
    // The version belongs to the machine that answered, which is the machine the
    // binary was resolved on — not necessarily this one.
    if (facts.version) versions.set(machineModelKey(host, spec.id), facts.version)
    let failure: string | null = null
    try {
      const session = await client.request<{
        sessionId?: string
        models?: { currentModelId?: string; availableModels?: RawModel[] }
        configOptions?: RawConfigOption[]
      }>('session/new', { cwd, mcpServers: [] }, timeout)
      const fromList = modelInfos(session.models?.availableModels)
      const fromOptions = (session.configOptions ?? [])
        .filter((option) => option.category === 'model' || option.id === 'model')
        .flatMap(configChoices)
        .filter((choice) => choice.value)
        .map((choice) => ({ id: choice.value as string, label: choice.name ?? (choice.value as string) }))
      const configured = findConfigOption(session.configOptions ?? [], 'model', ['model'])?.currentValue
      // `models.currentModelId` is the resolved selection (and, for agents such
      // as codex-acp, includes its current `[effort]`). The config option is the
      // stable base id. Prefer the resolved value so the launchpad can name the
      // real default and its effort before the user changes anything.
      const current = session.models?.currentModelId ?? (typeof configured === 'string' ? configured : null)
      const source = fromList.length ? fromList : fromOptions
      const marked = source.map((model) => ({
        ...model,
        isDefault: model.id === current || (!current && source.length === 1) || undefined,
      }))
      const initial = withReportedEfforts(marked, current, session.configOptions ?? [])
      const models = await scanModelEfforts(
        client,
        session.sessionId,
        session.configOptions ?? [],
        initial,
        Math.min(timeout, 10_000),
      )
      if (models.length) {
        rememberModels(spec.id, models, host)
        return models
      }
    } catch (err) {
      // An agent that wants a sign-in first still answered the handshake, and
      // that is where its models are. Never authenticate from here: a scan
      // nobody asked for must not open a browser window.
      failure = err instanceof Error ? err.message : String(err)
    }
    if (facts.models.length) {
      const models = facts.models.map((model) => ({
        ...model,
        isDefault: model.id === facts.current || (!facts.current && facts.models.length === 1) || undefined,
      }))
      rememberModels(spec.id, models, host)
      return models
    }
    if (failure) throw new Error(`${spec.id} answered the handshake but reported no models (${failure})`)
    throw new Error(`${spec.id} answered the handshake but reported no models`)
  } catch (err) {
    // The caller shows this in the picker: "asked and got nothing" is a fact the
    // person looking at an empty list needs, and it was silent before.
    if (err instanceof Error && err.message.includes('reported no models')) throw err
    throw err instanceof Error ? err : new Error(String(err))
  } finally {
    await client.close().catch(() => undefined)
  }
}

/**
 * Added/removed line counts for a diff block.
 *
 * Multiset difference rather than a real LCS: an ACP agent can hand us a whole
 * file, and a quadratic diff on a big one would freeze the turn. The counts are
 * therefore approximate for files that shuffle many identical lines — which is
 * exactly the trade the harness itself makes when it reports line stats.
 */
function countDiff(oldText: string | null | undefined, newText: string): { added: number; removed: number } {
  const before = (oldText ?? '').split('\n')
  const after = newText.split('\n')
  const pool = new Map<string, number>()
  for (const line of before) pool.set(line, (pool.get(line) ?? 0) + 1)
  let added = 0
  for (const line of after) {
    const left = pool.get(line) ?? 0
    if (left > 0) pool.set(line, left - 1)
    else added += 1
  }
  let removed = 0
  for (const left of pool.values()) removed += left
  return { added: Math.max(0, added - 1), removed: Math.max(0, removed - 1) }
}

function excerpt(text: string | null | undefined, limit = 40): string[] {
  if (!text) return []
  const lines = text.split('\n')
  if (lines.length <= limit) return lines
  return [...lines.slice(0, limit - 1), `… ${lines.length - limit + 1} more lines`]
}

function previewFor(path: string, oldText: string | null | undefined, newText: string): string {
  const body: string[] = [`--- ${path}`, `+++ ${path}`]
  if (oldText) for (const line of excerpt(oldText, 20)) body.push(`-${line}`)
  for (const line of excerpt(newText, 20)) body.push(`+${line}`)
  return body.join('\n')
}

/** Flatten whatever a tool call carries into something readable in a card. */
function toolText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const raw of content as ContentBlock[]) {
    if (!raw || typeof raw !== 'object') continue
    if (raw.type === 'content' && raw.content?.text) parts.push(raw.content.text)
    else if (raw.type === 'diff' && raw.path) parts.push(`${raw.path} (${raw.newText ? 'updated' : 'empty'})`)
    else if (raw.type === 'terminal') parts.push('(terminal output)')
  }
  return parts.join('\n').trim()
}

/**
 * The files a call names in ACP `locations` — what makes its path clickable.
 * `undefined` when the update says nothing, so a later update without them
 * does not wipe what an earlier one said.
 */
function locationPaths(locations: unknown): string[] | undefined {
  if (!Array.isArray(locations)) return undefined
  const paths = locations
    .map((location) => (location && typeof location === 'object' ? (location as { path?: unknown }).path : null))
    .filter((path): path is string => typeof path === 'string' && path.length > 0)
  return [...new Set(paths)]
}

/** The part of a `session/request_permission` tool call this client reads. */
interface AcpPermissionCall {
  toolCallId?: string
  title?: string
  kind?: string
  locations?: unknown
  content?: unknown
  rawInput?: unknown
}

/** Input keys agents use for the file a call touches. */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'abs_path', 'absolute_path', 'notebook_path', 'old_path', 'new_path', 'source', 'destination']

/**
 * Every file a permission request names: its `locations`, the paths of its
 * diffs, the path-like fields of its raw input (and the keys of a `changes`
 * map, Codex's shape) and what the call's own earlier updates said. The union,
 * because a file named anywhere is a file the call may touch.
 */
function permissionPaths(call: AcpPermissionCall | undefined, known: string[] | undefined): string[] {
  const found = new Set<string>([...(locationPaths(call?.locations) ?? []), ...(known ?? [])])
  if (Array.isArray(call?.content)) {
    for (const item of call.content as Array<{ type?: unknown; path?: unknown }>) {
      if (item?.type === 'diff' && typeof item.path === 'string' && item.path) found.add(item.path)
    }
  }
  const input = call?.rawInput
  if (input && typeof input === 'object') {
    const record = input as Record<string, unknown>
    for (const key of PATH_KEYS) {
      if (typeof record[key] === 'string' && record[key]) found.add(record[key] as string)
    }
    if (Array.isArray(record.paths)) {
      for (const path of record.paths) if (typeof path === 'string' && path) found.add(path)
    }
    if (record.changes && typeof record.changes === 'object' && !Array.isArray(record.changes)) {
      for (const path of Object.keys(record.changes)) if (path) found.add(path)
    }
  }
  return [...found]
}

/**
 * A form elicitation read as a question, when it is one.
 *
 * The protocol hands us a schema, not a widget: a single property whose value is
 * a choice (`oneOf`, `anyOf`, `enum`) or a boolean can be drawn as options, and
 * that is what most questions in practice are ("which approach?", "shall I
 * continue?"). Everything else returns null and is declined upstream.
 */
function readElicitation(
  message: string | undefined,
  schema: { properties?: Record<string, unknown>; required?: string[] } | undefined,
): {
  header?: string
  field: string
  boolean?: boolean
  options: Array<{ id: string; label: string; description?: string }>
} | null {
  void message
  const properties = schema?.properties ?? {}
  const names = Object.keys(properties)
  if (names.length !== 1) return null
  const field = names[0]!
  const spec = (properties[field] ?? {}) as Record<string, unknown>
  if (spec.type === 'boolean') {
    return {
      field,
      boolean: true,
      options: [
        { id: 'true', label: typeof spec.title === 'string' ? spec.title : 'Yes' },
        { id: 'false', label: 'No' },
      ],
    }
  }
  const titled = (spec.oneOf ?? spec.anyOf) as Array<Record<string, unknown>> | undefined
  const plain = spec.enum as unknown[] | undefined
  const options = titled
    ? titled
        .filter((choice) => choice && typeof choice.const === 'string')
        .map((choice) => ({
          id: String(choice.const),
          label: typeof choice.title === 'string' ? choice.title : String(choice.const),
          description: typeof choice.description === 'string' ? choice.description : undefined,
        }))
    : (plain ?? [])
        .filter((value) => typeof value === 'string')
        .map((value) => ({ id: String(value), label: String(value) }))
  if (!options.length) return null
  return { header: typeof spec.title === 'string' ? spec.title : undefined, field, options }
}

/** How long a config change may take before it counts as unanswered. */
const CONFIG_TIMEOUT = 20_000

/**
 * A setting this agent cannot take while it is running.
 *
 * Not a failure: the change is real, it just needs a fresh process. Kept apart
 * from a refusal so the two never read the same in the transcript.
 */
class UnsupportedLive extends Error {}

/** JSON-RPC's own "I do not have that method" (-32601), by code or by words. */
function isUnknownMethod(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase()
  return (
    message.includes('-32601') ||
    message.includes('method not found') ||
    message.includes('unknown method') ||
    message.includes('unsupported method') ||
    message.includes('not supported')
  )
}

/** A request we cannot honour because it asked for something we did not offer. */
export class InvalidParams extends Error {
  /** The JSON-RPC code for a request the protocol says is invalid. */
  readonly code = -32602
}

/**
 * What each permission kind means, in the words the card shows under an option.
 * The protocol's kinds are the vocabulary; nobody should have to learn them.
 */
function describePermission(kind: string | undefined): string | undefined {
  switch (kind) {
    case 'allow_once':
      return 'just this time'
    case 'allow_always':
      return 'and stop asking for this one'
    case 'reject_once':
      return 'not this time'
    case 'reject_always':
      return 'never for this one'
    default:
      return undefined
  }
}

/**
 * How a question stopped waiting.
 *
 * All three end the same way for the protocol — an option was chosen, or none
 * was — but they do not end the same way in the transcript. A stop, an interrupt
 * or a restart is already written there by the manager, which closes the stored
 * request and emits the terminal `tool_result` itself; writing a second one from
 * here would draw the same ending twice. An answer naming an option the agent
 * never offered is the one case nothing else records, so it is the one case this
 * file writes: the request was taken as answered, and without this the card
 * would sit there with no result under it forever.
 */
interface Decision {
  /** The option that was picked, or null when none was. */
  chosen: string | null
  /** True only for an answer naming an option that was never offered. */
  invalid: boolean
}

export class AcpDriver implements Driver {
  private client: AcpClient | null = null
  private sessionId: string | null = null
  private stopped = false
  private text = ''
  private thought = ''
  private readonly toolNames = new Map<string, string>()
  /** When each call started and what it was published as, for its update and result. */
  private readonly toolCalls = new Map<string, { at: number; title: string; kind?: string; input: unknown; paths?: string[] }>()
  private readonly toolPaths = new Map<string, string>()
  private promptStartedAt = 0
  private busy = false
  /**
   * The cost this turn was told, if it was told one at all.
   *
   * `session/prompt` never carries a price; the agents that know one publish it
   * in `usage_update`. Remembering it here is what lets the turn's result event
   * say whether its `costUsd` is a figure or a placeholder.
   */
  private turnCostUsd: number | null = null
  private modelOverride: string | null
  /**
   * True while the agent replays a reopened conversation. sedano already has
   * that history in its own store, so rendering the replay would show every old
   * message a second time.
   */
  private replaying = false
  /** A user message being replayed by `session/load`, committed at its end. */
  private replayedUser = ''
  /** Commits a replay whose agent kept streaming after answering `session/load`. */
  private replayTimer: ReturnType<typeof setTimeout> | null = null
  /** The handshake result, kept for the methods it advertised. */
  private init: Record<string, unknown> = {}
  private authMethods: Array<{ id?: string; name?: string }> = []
  /** Where the agent runs, so its file requests are answered on the right machine. */
  private readonly transport: Transport
  /** Whether the agent said it can read an image (see `initialize`). */
  private acceptsImages = false
  /** The config option the model is, when the agent names one. */
  private modelOptionId: string | null = null
  /** The config option reasoning effort is (`thought_level`), when it exists. */
  private effortOptionId: string | null = null
  /** The catalog may encode effort in its model ids while config uses two selectors. */
  private reportedModelIds = new Set<string>()
  private configModelValues = new Set<string>()
  private configEffortValues = new Set<string>()
  private configuration: Promise<void> | null = null
  private configurationError: string | null = null
  /**
   * The model the *agent* says it is running.
   *
   * Never the one that was asked for: a session opens on whatever the agent's
   * own config says, an alias resolves to something else, and a change can be
   * refused — so an answer is labelled with this or with nothing at all.
   */
  private currentModel: string | null = null
  /** Permission requests turned into questions, waiting for an answer. */
  private readonly questions = new Map<
    string,
    { resolve(value: Decision): void; options: Array<{ id: string; label: string; description?: string }> }
  >()

  /**
   * stderr that is not chatter, waiting to be judged as a whole.
   *
   * A Node crash arrives as a dozen lines across several chunks, so no single
   * line is a stack trace. The block is what gets classified; the debounce below
   * is what lets the last frame land before it is.
   */
  private crashBuffer = ''
  private crashTimer: ReturnType<typeof setTimeout> | null = null
  /** One crash report per process: the frames keep coming after the first line. */
  private crashReported = false
  /**
   * The exit handler already put this process' death in front of the person.
   * The turn it killed fails with the same news a moment later (its pending
   * request is rejected with "agent exited"), and saying it twice is noise.
   */
  private exitReported = false
  /**
   * Every stderr line as it was printed, indentation included.
   *
   * The client keeps a tail of its own but trims each line, which is fine for a
   * one-line diagnostic and wrong for a stack trace: the indentation is how a
   * frame is told from a message. This tail is what a failure carries, so what
   * the reader copies is what the process actually wrote.
   */
  private stderrRaw: string[] = []

  constructor(
    private readonly opts: CreateOptions,
    private readonly hooks: DriverHooks,
    private readonly spec: AcpSpec,
    private readonly bin: string,
  ) {
    this.modelOverride = opts.model
    this.transport = new Transport(opts.host)
  }

  /** Who and what to name in a failure, filled in once for every call site. */
  private get failureContext(): FailureContext {
    return {
      harness: HARNESS_LABEL[this.spec.id as HarnessId] ?? this.spec.id,
      bin: this.bin,
      host: this.opts.host,
    }
  }

  /**
   * Everything the agent wrote to stderr, judged as a block rather than a line.
   *
   * Chatter is kept out of the block but never deleted — the client's own
   * `diagnostics` tail still has every line, and that tail is what a later exit
   * failure carries. What gets promoted to an error is only a report that looks
   * like an uncaught exception, because that is the one stderr shape that means
   * the program stopped working rather than talked about itself.
   */
  private onStderr(text: string): void {
    if (this.stopped) return
    const lines = text.replace(/\n+$/, '').split('\n')
    for (const line of lines) {
      if (!line.trim() && !this.stderrRaw.length) continue
      this.stderrRaw.push(line)
    }
    if (this.stderrRaw.length > STDERR_TAIL) this.stderrRaw.splice(0, this.stderrRaw.length - STDERR_TAIL)
    if (this.crashReported) return
    // Detection reads only the lines that are not chatter: a deprecation notice
    // holding the word "Error" must not conjure a stack trace out of nothing.
    const kept = lines.filter((line) => !isStderrChatter(line)).join('\n')
    if (!kept.trim()) return
    this.crashBuffer = `${this.crashBuffer}${this.crashBuffer ? '\n' : ''}${kept}`
    if (!isCrashReport(this.crashBuffer)) return
    if (this.crashTimer) clearTimeout(this.crashTimer)
    this.crashTimer = setTimeout(() => this.flushCrash(), CRASH_SETTLE_MS)
  }

  /** Report the crash once, with every line the agent printed around it. */
  private flushCrash(): void {
    this.crashTimer = null
    if (this.crashReported || this.stopped) return
    if (!isCrashReport(this.crashBuffer)) return
    this.crashReported = true
    this.crashBuffer = ''
    // Everything it printed, chatter included and unedited. The notice a wrapper
    // wrote a second before it died is context, and this is the one place it
    // still exists — filtering the detail would be the silent drop this whole
    // change exists to prevent.
    this.hooks.error(formatFailure(this.stderrRaw.join('\n').trim(), this.failureContext))
  }

  get alive(): boolean {
    return !this.stopped && (this.client?.alive ?? false)
  }

  async start(): Promise<void> {
    const client = new AcpClient({
      command: [this.bin, ...(this.spec.argv?.(this.opts) ?? this.spec.args)],
      cwd: this.opts.cwd,
      host: this.opts.host,
      env: { ...this.spec.env },
      clientName: 'sedano',
      clientVersion: '0.1.0',
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params, id) => this.onRequest(method, params, id),
      onStderr: (text) => this.onStderr(text),
      onExit: (code) => {
        if (this.stopped) return
        // A trace still inside the debounce when the process died: report it now
        // rather than let the exit be the only thing anybody sees.
        if (this.crashTimer) {
          clearTimeout(this.crashTimer)
          this.flushCrash()
        }
        this.hooks.status('stopped')
        this.hooks.event({
          k: 'system',
          subtype: 'agent-exit',
          text: `${this.spec.id} stopped (exit ${code ?? 'signal'}). Your next message starts it again.`,
        })
        // An agent that walked out mid-turn is a failure, not a note. It used to
        // be only the line above — grey, folded into the turn, and silent about
        // everything the process had printed on its way out. A crash already
        // reported says all of this and more, so it is not said twice.
        if (this.crashReported) this.exitReported = true
        if (this.crashReported || code === 0 || code === null) return
        this.exitReported = true
        this.hooks.error(
          formatFailure(
            `${this.spec.id} exited with code ${code}${this.stderrRaw.length ? `\n${this.stderrRaw.join('\n').trim()}` : ''}`,
            this.failureContext,
          ),
        )
        this.hooks.status('error')
      },
    })
    this.client = client
    client.start()

    const initTimeout = this.spec.initTimeoutMs ?? 60_000
    const init = await client.initialize()
    const facts = handshakeFacts(init, this.spec.id)
    if (facts.version) versions.set(machineModelKey(this.opts.host, this.spec.id), facts.version)
    // The handshake is a real answer about this installation, so it is worth
    // keeping even if the session below never opens (grok before a sign-in).
    if (facts.models.length) rememberModels(this.spec.id, facts.models, this.opts.host)
    // The handshake says which model the agent is on. It is published whatever
    // was asked for: until the agent takes the override, this is the truth.
    if (facts.current) this.publishModel(facts.current)
    this.authMethods = (init as { authMethods?: Array<{ id?: string; name?: string }> }).authMethods ?? []
    this.init = init
    const capabilities = (init as { agentCapabilities?: { loadSession?: boolean } }).agentCapabilities
    const canLoad = capabilities?.loadSession === true
    // What the handshake said about images: the spec is explicit that prompt
    // content must stay within the negotiated capabilities, so an agent that
    // never claimed image support is never sent one.
    const prompt = (init as {
      agentCapabilities?: { promptCapabilities?: { image?: boolean } }
    }).agentCapabilities?.promptCapabilities
    this.acceptsImages = prompt?.image === true
    rememberImageSupport(this.spec.id, this.opts.host, this.acceptsImages)

    const reused = this.opts.nativeId && canLoad ? this.opts.nativeId : null
    if (reused) {
      this.replaying = true
      try {
        // A loaded session answers with the same shape a new one does: its
        // current model, its modes and its options. Discarding that is how a
        // reopened tab came back claiming the wrong model.
        const loaded = await this.authorized<{
          models?: { currentModelId?: string; availableModels?: Array<{ modelId?: string; name?: string }> }
          configOptions?: Array<{
            id?: string
            category?: string
            currentValue?: string
            options?: Array<{ value?: string; name?: string }>
          }>
        }>('session/load', { sessionId: reused, cwd: this.opts.cwd, mcpServers: [] }, initTimeout)
        this.absorbCapabilities(loaded ?? {})
        this.sessionId = reused
        // The history streamed before the answer; its last message has no
        // following update to close it.
        if (this.opts.replayHistory) this.commitReplay()
      } catch (error) {
        // The agent kept the id but lost the conversation: rather than failing
        // the whole tab, start a fresh session and say so in the transcript.
        this.hooks.event({
          k: 'system',
          subtype: 'session-fresh',
          text: `could not reopen the previous conversation (${error instanceof Error ? error.message : 'unknown'}) — starting a new one`,
        })
      }
    }

    if (!this.sessionId) {
      const created = await this.authorized<{
        sessionId?: string
        models?: { currentModelId?: string; availableModels?: Array<{ modelId?: string; name?: string }> }
        configOptions?: Array<{
          id?: string
          category?: string
          currentValue?: string
          type?: string
          options?: Array<{ value?: string; name?: string }>
        }>
      }>('session/new', { cwd: this.opts.cwd, mcpServers: [] }, initTimeout)
      this.sessionId = created.sessionId ?? null
      this.absorbCapabilities(created)
    }

    if (!this.sessionId) throw new Error(`${this.spec.id}: the agent did not return a session id`)
    this.hooks.nativeId(this.sessionId)
    // No hint at all rather than one that is not a command (see `resumeHint`).
    const hint = this.resumeHint()
    if (hint) this.hooks.resumeHint(hint)
    if (this.modelOverride && this.modelOverride !== this.currentModel) {
      // Never run a prompt under the default model while a requested model is
      // still being applied (or has been refused).
      await this.applyModel(this.modelOverride)
    }
    // Effort is a flag for the agents that take one (see `AcpSpec.argv`), so it
    // is already in this process' argv; agents that expose it as a config option
    // are told here, once the session exists.
    if (this.opts.effort && this.effortOptionId && !this.modelOverride?.endsWith(`[${this.opts.effort}]`)) {
      await this.applyEffort(this.opts.effort)
    }
    this.hooks.status('idle')
  }

  /**
   * A session call, with a sign-in in front of it when the agent asks for one.
   *
   * `session/new` is where an ACP agent decides whether you may in, and that is
   * exactly where grok answers "Authentication required": it has no stored
   * credentials until somebody signs in, and it expects the client to name one
   * of the methods it advertised. The agent runs the flow itself (grok opens the
   * browser); all this does is name the method, wait, and ask again. Sign-in
   * happens when you open a session and never from a background scan, because
   * it is a window on your screen, not something a poll may open.
   */
  private async authorized<T>(method: string, params: unknown, initTimeout: number): Promise<T> {
    try {
      return await this.client!.request<T>(method, params, initTimeout)
    } catch (error) {
      if (!needsSignIn(error)) throw error
      await this.signIn()
      return await this.client!.request<T>(method, params, initTimeout)
    }
  }

  /** Ask the agent to start one of the sign-ins it advertised. */
  private async signIn(): Promise<void> {
    const preferred = (this.init as { _meta?: { defaultAuthMethodId?: string | null } })._meta?.defaultAuthMethodId
    const methodId = preferred ?? this.authMethods.find((method) => method.id)?.id
    if (!methodId) {
      throw new Error(
        `${this.spec.id} needs a sign-in before it can run, and it did not say how to do one — run \`${this.bin} login\` and send your message again.`,
      )
    }
    this.hooks.event({
      k: 'system',
      subtype: 'auth',
      text: `${this.spec.id} needs you to sign in — it is opening its own sign-in now. \`${this.bin} login\` in a terminal does the same.`,
    })
    try {
      await this.client!.request('authenticate', { methodId }, AUTH_TIMEOUT)
    } catch (error) {
      throw new Error(
        `sign-in did not finish (${error instanceof Error ? error.message : String(error)}) — run \`${this.bin} login\` in a terminal, then send your message again.`,
      )
    }
  }

  /** Publish the model the agent reports, and remember it as the effective one. */
  private publishModel(modelId: string): void {
    this.currentModel = modelId
    this.hooks.model(modelId)
  }

  /** Model lists and modes an agent volunteers when a session opens. */
  private absorbCapabilities(created: {
    models?: { currentModelId?: string; availableModels?: Array<{ modelId?: string; name?: string }> }
    configOptions?: RawConfigOption[]
  }): void {
    const options = created.configOptions ?? []
    const fromList = (created.models?.availableModels ?? [])
      .filter((model) => model.modelId)
      .map((model) => withImageSupport({ id: model.modelId as string, label: model.name ?? (model.modelId as string) }))
    // The ids of the selectors a change has to name (see `applyConfigOption`).
    const modelOption = findConfigOption(options, 'model', ['model'])
    const effortOption = findConfigOption(options, 'thought_level', ['effort', 'reasoning_effort', 'thought_level'])
    this.modelOptionId = modelOption ? configIdOf(modelOption) : null
    this.effortOptionId = effortOption ? configIdOf(effortOption) : null
    const prior = discoveredModels(this.spec.id, this.opts.host)
    const reported = fromList.length ? fromList : (prior ?? [])
    this.reportedModelIds = new Set(reported.map((model) => model.id))
    this.configModelValues = new Set(modelOption ? configChoices(modelOption).map((choice) => choice.value ?? '') : [])
    this.configEffortValues = new Set(effortOption ? configChoices(effortOption).map((choice) => choice.value ?? '') : [])
    const fromOptions = (modelOption ? configChoices(modelOption) : [])
      .filter((choice) => choice.value)
      .map((choice) => withImageSupport({ id: choice.value as string, label: choice.name ?? (choice.value as string) }))
    const current = created.models?.currentModelId ?? this.configuredModel(options)
    const models = mergeReportedModels(
      withReportedEfforts(fromList.length ? fromList : prior?.length ? prior : fromOptions, current, options),
      prior,
    )
    if (models.length) rememberModels(this.spec.id, models, this.opts.host)
    // What the agent says it is on, which is the only model worth publishing:
    // the one that was *asked* for is published when the agent confirms it and
    // never before (see `applyModel`).
    if (current) this.publishModel(current)
  }

  /** Adopt the state a `configOptions` list reports, whoever sent it. */
  private absorbConfigOptions(options: RawConfigOption[] | undefined): void {
    // `undefined` means the agent did not report state. `[]` is reported state:
    // every previously available selector disappeared and stale ids must clear.
    if (!options) return
    const modelOption = findConfigOption(options, 'model', ['model'])
    if (modelOption) {
      const id = configIdOf(modelOption)
      if (id) this.modelOptionId = id
      this.configModelValues = new Set(configChoices(modelOption).map((choice) => choice.value ?? ''))
    }
    const effortOption = findConfigOption(options, 'thought_level', ['effort', 'reasoning_effort', 'thought_level'])
    // The returned list is authoritative and model-dependent. Clearing a stale
    // id here is what prevents an effort from model A being sent to model B.
    this.effortOptionId = effortOption ? configIdOf(effortOption) : null
    this.configEffortValues = new Set(effortOption ? configChoices(effortOption).map((choice) => choice.value ?? '') : [])
    const effective = this.configuredModel(options)
    if (effective) this.publishModel(effective)
    const current = typeof modelOption?.currentValue === 'string' ? modelOption.currentValue : this.currentModel
    const known = discoveredModels(this.spec.id, this.opts.host)
    if (known?.length && current) {
      rememberModels(this.spec.id, withReportedEfforts(known, current, options), this.opts.host)
    }
  }

  /** Rejoin only a variant the agent itself listed; other ACP agents stay plain. */
  private configuredModel(options: RawConfigOption[]): string | undefined {
    const model = findConfigOption(options, 'model', ['model'])?.currentValue
    const effort = findConfigOption(options, 'thought_level', ['effort', 'reasoning_effort', 'thought_level'])?.currentValue
    if (typeof model !== 'string') return undefined
    const variant = `${model}[${effort}]`
    return typeof effort === 'string' && this.reportedModelIds.has(variant) ? variant : model
  }

  /** A catalog id can be a pair of ACP config values (Codex ACP does this). */
  private modelSelection(modelId: string): { model: string; effort: string | null } {
    const match = modelId.match(/^(.+)\[([^\]]+)\]$/)
    if (match && this.reportedModelIds.has(modelId) && this.configModelValues.has(match[1])) {
      return { model: match[1], effort: match[2] }
    }
    return { model: modelId, effort: null }
  }

  /**
   * The command that reopens this conversation in the agent's own CLI.
   *
   * It exists so a session is never trapped in sedano: you copy it, you paste it
   * into a terminal, you carry on. So it has to be a command — `grok (ACP)` was
   * a label, and `opencode` on its own opens a *new* conversation, which is
   * worse than no hint at all. Anything that is not a runnable resume is now
   * nothing, and the UI simply shows no hint.
   *
   * Each flag below is the one its CLI's own `--help` documents:
   * `opencode -s/--session <id>`, `codex resume <SESSION_ID>`,
   * `grok -r/--resume <SESSION_ID_OR_TITLE>`. Gemini is deliberately absent: its
   * `--resume` takes `latest` or a *position* in the project's session list, not
   * an id, so no command here can promise to reopen this conversation rather
   * than whichever one happens to be newest.
   *
   * A session running on a server is resumed on that server, so the whole thing
   * is wrapped in `ssh` the way the claude and Command Code drivers do it.
   */
  private resumeHint(): string | null {
    if (!this.sessionId) return null
    const resume =
      this.spec.id === 'opencode'
        ? `opencode --session ${this.sessionId}`
        : this.spec.id === 'codex'
          ? `codex resume ${this.sessionId}`
          : this.spec.id === 'grok'
            ? `grok --resume ${this.sessionId}`
            : null
    if (!resume) return null
    const local = `cd ${this.opts.cwd} && ${resume}`
    return this.transport.remote ? `ssh ${this.opts.host} ${shq(local)}` : local
  }

  /* ---------------------------------------------------------------- */
  /* Turns                                                             */
  /* ---------------------------------------------------------------- */

  async send(text: string, attachments?: AttachmentRef[]): Promise<SendResult> {
    if (this.configuration) await this.configuration
    if (this.configurationError) return { status: 'refused', reason: this.configurationError }
    if (this.stopped) return { status: 'refused', reason: 'the driver has stopped' }
    if (!this.client || !this.sessionId) return { status: 'refused', reason: 'the ACP session is not ready' }
    if (this.busy) return { status: 'refused', reason: 'the ACP session is already running a prompt' }
    // Whatever the agent replayed has been shown already; from here on it is
    // this turn's output.
    if (this.replaying && this.opts.replayHistory) this.commitReplay()
    this.replaying = false
    this.busy = true
    this.promptStartedAt = Date.now()
    // Last turn's price says nothing about this one.
    this.turnCostUsd = null
    this.hooks.status('running')
    this.hooks.turnStarted()
    // ACP's `session/prompt` response is the *turn result*, not a delivery ack.
    // Waiting for it here held the manager's per-session lock for the whole
    // turn, so a second user message could neither enter Sedano's durable queue
    // nor be cancelled. The request has been accepted by the live ACP client at
    // this point; completion and failure continue through the normal hooks.
    void this.prompt(text, attachments).catch((error) => {
      // Off the caller's stack: an escaped rejection here would take the whole
      // server down, and a turn that failed must not stay "running".
      this.busy = false
      this.hooks.error(formatFailure(error, this.failureContext))
      this.hooks.status('error')
    })
    return { status: 'accepted' }
  }

  private async prompt(text: string, attachments?: AttachmentRef[]): Promise<SendResult> {
    const client = this.client!
    const startedAt = this.promptStartedAt
    let outcome: { stop: string; usage: TokenUsage | null } | null = null
    // The error object, not its message: the classifier reads stack frames and a
    // transport's error kind off it, and flattening it to a string first throws
    // away the only evidence of where the failure came from.
    let failure: unknown = null
    let failed = false
    try {
      const response = await client.request<PromptResponse>('session/prompt', {
        sessionId: this.sessionId,
        prompt: [
        { type: 'text', text },
        // Nothing the agent did not say it could read.
        ...(this.acceptsImages ? imageBlocks(attachments) : []),
      ],
      })
      this.flushText()
      // Usage is optional in the protocol, and an agent that reports none has
      // not told us the turn cost nothing — it has told us nothing. Zeros here
      // were added to the session's totals as if they were measurements, so the
      // absence is kept as an absence instead.
      noteProtocol('acp', this.spec.id, `stopReason:${response?.stopReason ?? 'end_turn'}`)
      outcome = {
        stop: response?.stopReason ?? 'end_turn',
        usage: acpPromptUsage(response, this.spec),
      }
    } catch (error) {
      this.flushText()
      failure = error
      failed = true
    }

    // Released before the turn is announced as finished: the moment the UI says
    // "done" is the moment you can type again, and those must be the same moment.
    this.busy = false

    if (outcome) {
      // `commitTurn` closes the turn's metrics whether or not numbers came with
      // it; the numbers themselves are only sent when the agent sent them.
      // A last-call report is one model call: it is also the conversation's size.
      if (outcome.usage && this.spec.promptUsage === 'lastCall') this.hooks.usage(outcome.usage, { perMessage: true })
      this.hooks.usage(outcome.usage ?? {}, { commitTurn: true })
      this.hooks.event({
        k: 'result',
        outcome: resultOutcomeFor(outcome.stop),
        subtype: outcome.stop,
        text: outcome.stop === 'cancelled' ? 'interrupted' : '',
        ...(outcome.usage ? { usage: outcome.usage } : {}),
        durationMs: Date.now() - startedAt,
        // ACP has no cost in `session/prompt`: the agents that know one send it
        // in `usage_update`. When none arrived, the zero is the field being
        // unavoidable rather than a price, and `costReported: false` says so.
        costUsd: this.turnCostUsd ?? 0,
        costReported: this.turnCostUsd !== null,
      })
      this.hooks.status('idle')
      // The manager already received the immediate acceptance from `send`.
      return { status: 'delivered' }
    }

    // One error, not two: `hooks.error` already writes the error event into the
    // timeline (see the manager's hooks), so emitting one here as well printed
    // every failed turn twice. For the same reason an agent that died mid-turn
    // is not reported again when its exit (or its crash) already was.
    if (!(this.exitReported && !client.alive)) {
      this.hooks.error(formatFailure(failed ? failure : 'the agent failed the turn', this.failureContext))
    }
    this.hooks.status('error')
    return {
      status: 'refused',
      reason: failure instanceof Error ? failure.message : String(failure ?? 'the agent failed the turn'),
    }
  }

  /**
   * Prose is streamed as deltas, then committed as one message. Streaming per
   * chunk would fill the timeline with hundreds of one-word events; committing
   * only at the end would make the turn look frozen.
   */
  private commitReplay(): void {
    if (this.replayTimer) clearTimeout(this.replayTimer)
    this.replayTimer = null
    this.flushReplayedUser()
    this.flushText()
  }

  private flushReplayedUser(): void {
    const text = this.replayedUser.trim()
    this.replayedUser = ''
    if (text) this.hooks.event({ k: 'user', text })
  }

  private flushText(): void {
    if (this.thought.trim()) {
      this.hooks.event({ k: 'thinking', text: this.thought.trim() })
      this.thought = ''
    }
    if (this.text.trim()) {
      // The model that answered, as the agent reported it — not the one the
      // picker asked for, which it may well have declined.
      this.hooks.event({ k: 'assistant', text: this.text.trim(), model: this.currentModel ?? undefined })
      this.text = ''
    }
  }

  private onNotification(method: string, params: unknown): void {
    noteProtocol('acp', this.spec.id, `method:${method}`)
    if (method !== 'session/update') return
    // A reopened session replays its conversation, which we already have. Its
    // metadata is not a replay: commands, mode, model and usage are current, so
    // they are let through while the history is not.
    // An imported session has no copy yet (`CreateOptions.replayHistory`): its
    // replay is the only way the conversation gets on screen, so it is let in.
    if (this.replaying && !this.opts.replayHistory) {
      const kind = String((params as { update?: { sessionUpdate?: string } } | undefined)?.update?.sessionUpdate ?? '')
      const history = [
        'user_message_chunk',
        'agent_message_chunk',
        'agent_thought_chunk',
        'tool_call',
        'tool_call_update',
      ]
      if (history.includes(kind)) return
    }
    // The spec replays before answering the load; an agent that replays after
    // it still gets its history committed once it goes quiet.
    if (this.replaying && this.opts.replayHistory) {
      if (this.replayTimer) clearTimeout(this.replayTimer)
      this.replayTimer = setTimeout(() => this.commitReplay(), 300)
    }
    const payload = params as { sessionId?: string; update?: Record<string, unknown> }
    const update = payload?.update
    if (!update || typeof update !== 'object') return
    const kind = String(update.sessionUpdate ?? '')
    noteProtocol('acp', this.spec.id, `update:${kind}`)

    switch (kind) {
      case 'available_commands_update': {
        // ACP agents advertise their own slash commands; the composer's `/` menu
        // shows exactly these, so it can never offer a command the agent lacks.
        const list =
          (update.availableCommands as Array<{ name?: string; description?: string }> | undefined) ?? []
        rememberCommands(
          this.spec.id as HarnessId,
          list
            .filter((command) => command.name)
            .map((command) => ({ name: command.name as string, description: command.description ?? '' })),
        )
        return
      }
      case 'agent_message_chunk': {
        const text = (update.content as { text?: string } | undefined)?.text ?? ''
        if (!text) return
        this.flushReplayedUser()
        this.text += text
        // Live tokens/sec comes from this delta: the manager counts every
        // delta's characters, so a second chars/4 estimate here doubled it.
        // A replayed history is not live output and streams nothing.
        if (!this.replaying) this.hooks.delta('main', 'text', text)
        return
      }
      case 'agent_thought_chunk': {
        const text = (update.content as { text?: string } | undefined)?.text ?? ''
        if (!text) return
        this.flushReplayedUser()
        this.thought += text
        if (!this.replaying) this.hooks.delta('main', 'thinking', text)
        return
      }
      // The user's own text is already on screen the moment it is sent; the
      // protocol echoing it back would render every message twice. Only an
      // imported session's replay carries messages nobody has seen yet.
      case 'user_message_chunk': {
        if (!this.replaying) return
        const text = (update.content as { text?: string } | undefined)?.text ?? ''
        if (!text) return
        this.flushText()
        this.replayedUser += text
        return
      }
      case 'tool_call': {
        const toolId = String(update.toolCallId ?? '')
        if (!toolId) return
        this.flushReplayedUser()
        // Prose that preceded the call belongs before it in the timeline.
        this.flushText()
        const title = String(update.title ?? update.kind ?? 'tool')
        const kind = typeof update.kind === 'string' && update.kind ? update.kind : undefined
        if (kind) noteProtocol('acp', this.spec.id, `toolKind:${kind}`)
        this.toolNames.set(toolId, title)
        const call = { at: Date.now(), title, kind, input: update.rawInput ?? null, paths: locationPaths(update.locations) }
        this.toolCalls.set(toolId, call)
        if (this.toolCalls.size > 500) this.toolCalls.delete(this.toolCalls.keys().next().value as string)
        this.publishTool(toolId, call)
        return
      }
      case 'tool_call_update': {
        const toolId = String(update.toolCallId ?? '')
        if (!toolId) return
        const status = String(update.status ?? '')
        // Agents often open a call with a bare title and fill in the real one,
        // its kind and its input later: the card is rewritten in place.
        const known = this.toolCalls.get(toolId)
        if (known) {
          const title = typeof update.title === 'string' && update.title ? update.title : known.title
          const kind = typeof update.kind === 'string' && update.kind ? update.kind : known.kind
          const input = update.rawInput !== undefined ? update.rawInput : known.input
          const paths = locationPaths(update.locations) ?? known.paths
          if (title !== known.title || kind !== known.kind || input !== known.input || paths?.join('\n') !== known.paths?.join('\n')) {
            Object.assign(known, { title, kind, input, paths })
            this.toolNames.set(toolId, title)
            this.publishTool(toolId, known)
          }
        }
        if (status !== 'completed' && status !== 'failed') return
        const content = update.content as ContentBlock[] | undefined
        for (const block of content ?? []) {
          if (block?.type) noteProtocol('acp', this.spec.id, `toolContent:${block.type}`)
          if (block?.type === 'diff' && block.path && typeof block.newText === 'string') {
            const counts = countDiff(block.oldText, block.newText)
            this.toolPaths.set(toolId, block.path)
            this.hooks.event({
              k: 'file_change',
              toolId,
              path: block.path,
              change: block.oldText ? 'edit' : 'create',
              added: counts.added,
              removed: counts.removed,
              preview: previewFor(block.path, block.oldText, block.newText),
            })
          }
        }
        this.hooks.event({
          k: 'tool_result',
          toolId,
          text: toolText(content) || (status === 'failed' ? 'failed' : 'done'),
          isError: status === 'failed',
          truncated: false,
          ...acpResultExtras(update.rawOutput, known?.at),
        })
        return
      }
      case 'usage_update': {
        // The harness telling us where the conversation stands: how full the
        // window is, and what it has cost. Dropping it was why a context ring
        // stayed empty on the ACP agents that report it.
        const update = payload.update as { used?: number; size?: number; cost?: unknown }
        const cost = acpCostUsd(update.cost)
        if (cost !== null) this.turnCostUsd = cost
        this.hooks.usage({}, {
          contextTokens: update.used,
          contextWindow: update.size,
          ...(cost !== null ? { costUsd: cost } : {}),
        })
        return
      }
      case 'config_option_update': {
        // The agent changing its own configuration, which from ACP v2 on is how
        // a model switch is announced. Reading it is what keeps the summary
        // showing the model that is actually running.
        this.absorbConfigOptions(update.configOptions as RawConfigOption[] | undefined)
        return
      }
      case 'current_mode_update': {
        // The agent changed its own mode: the picker must not keep claiming the
        // old one. Only a mode we know how to name is published.
        const mode = String((payload.update as { modeId?: string }).modeId ?? '')
        if (mode) this.hooks.meta({ permissionMode: mode })
        return
      }
      case 'plan': {
        const entries = (update.entries as Array<{ content?: string; status?: string }> | undefined) ?? []
        if (!entries.length) return
        const mark = (status: string | undefined) =>
          status === 'completed' ? '✓' : status === 'in_progress' ? '▸' : '·'
        // One plan at a time: the spec says a client must replace the current
        // one, so it keeps a single id and the update lands on the same row
        // instead of stacking a plan under the previous plan.
        this.hooks.event(
          {
            k: 'system',
            subtype: 'plan',
            text: entries.map((entry) => `${mark(entry.status)} ${entry.content ?? ''}`).join('\n'),
          },
          { id: `plan:${this.sessionId ?? this.spec.id}` },
        )
        return
      }
      default:
        return
    }
  }

  /**
   * Turn a permission request into a question the person can answer.
   *
   * The agent's options are the question's options (a permission in ACP is
   * exactly that: a list of choices with kinds), and the answer that comes back
   * from the UI is translated into the outcome the protocol wants. It waits —
   * which is the point: the agent is blocked on this answer, and pretending
   * otherwise was how a mode decided everything for you.
   */
  private askPermission(
    requestId: string,
    title: string,
    kind: string | undefined,
    paths: string[],
    choices: Array<{ optionId?: string; kind?: string; name?: string }>,
  ): Promise<unknown> {
    const label = kind ? kind.charAt(0).toUpperCase() + kind.slice(1) : undefined
    const detail = [label, paths.join(', ')].filter(Boolean).join(' · ') || undefined
    const options = choices
      .filter((choice) => choice.optionId)
      .map((choice) => ({
        id: choice.optionId as string,
        label: choice.name ?? (choice.optionId as string),
        description: describePermission(choice.kind),
      }))
    const decision = new Promise<Decision>((resolve) => {
      this.questions.set(requestId, { resolve, options })
    })
    this.hooks.event({
      k: 'request',
      requestId,
      kind: 'permission',
      title,
      detail,
      options: options.map((option) => ({
        id: option.id,
        label: option.label,
        hint: option.description,
        intent: choices.find((choice) => choice.optionId === option.id)?.kind?.startsWith('reject') ? 'deny' : 'allow',
      })),
      state: 'pending',
    })
    return decision.then((decided) => {
      this.questions.delete(requestId)
      const chosen = decided.chosen
      if (!chosen) {
        // The only ending nothing else records (see `Decision`): the request was
        // consumed as answered, so without a result here the card stays open on
        // a question that will never be asked again.
        if (decided.invalid) {
          this.hooks.event({
            k: 'tool_result',
            toolId: requestId,
            text: 'not answered — that was not one of the options the agent offered',
            isError: true,
            truncated: false,
          })
        }
        return { outcome: { outcome: 'cancelled' } }
      }
      return { outcome: { outcome: 'selected', optionId: chosen } }
    })
  }

  /**
   * The protocol's own question: `elicitation/create`.
   *
   * Any ACP agent can ask this — which is the whole point, because it means one
   * implementation covers every agent that speaks the protocol, today and later.
   * Form mode arrives as a restricted JSON Schema; the shapes the card can draw
   * are the ones where the schema *is* a question: a single choice (`oneOf` or
   * `enum`) or a boolean. Anything else — free text, numbers, several fields at
   * once — is declined with a reason, because drawing a form nobody asked for
   * would be worse than saying we cannot.
   */
  private askElicitation(requestId: string, params: unknown): Promise<unknown> {
    const { mode, message, requestedSchema, sessionId } = params as {
      mode?: string
      message?: string
      requestedSchema?: { properties?: Record<string, unknown>; required?: string[] }
      sessionId?: string
    }
    if (sessionId && this.sessionId && sessionId !== this.sessionId) {
      throw new Error('elicitation for another session')
    }
    if (mode !== 'form') {
      // URL mode is an out-of-band flow (OAuth and similar) and this client has
      // not advertised it. The spec asks for invalid-params rather than a generic
      // failure, because the agent sent something we said we could not do.
      throw new InvalidParams('this client supports form elicitation only')
    }
    const asked = readElicitation(message, requestedSchema)
    if (!asked) {
      this.hooks.event({
        k: 'system',
        subtype: 'question',
        text: `declined a form this client cannot draw: ${message ?? 'a question'}`,
      })
      return Promise.resolve({ action: 'decline' })
    }
    const decision = new Promise<Decision>((resolve) => {
      this.questions.set(requestId, { resolve, options: asked.options })
    })
    this.hooks.event({
      k: 'request',
      requestId,
      kind: 'question',
      title: message ?? 'Question',
      detail: asked.header,
      options: asked.options.map((option) => ({
        id: option.id,
        label: option.label,
        hint: option.description,
        intent: 'neutral' as const,
      })),
      state: 'pending',
    })
    return decision.then((decided) => {
      this.questions.delete(requestId)
      const chosen = decided.chosen
      if (!chosen) {
        // Dismissed, not refused: the spec tells those apart, and an agent may
        // retry on one and not on the other. Only the invalid answer is written
        // to the transcript here — a stop or an interrupt is the manager's to
        // record, and it already does (see `Decision`).
        if (decided.invalid) {
          this.hooks.event({
            k: 'tool_result',
            toolId: requestId,
            text: 'dismissed — that was not one of the options offered',
            isError: true,
            truncated: false,
          })
        }
        return { action: 'cancel' }
      }
      // The schema asked for a type; the answer must have it.
      const value = asked.boolean ? chosen === 'true' : chosen
      return { action: 'accept', content: { [asked.field]: value } }
    })
  }

  /** The UI's answer to a question this session is waiting on. */
  answerQuestion(toolId: string, optionId: string): void {
    const waiting = this.questions.get(toolId)
    if (!waiting) return
    this.questions.delete(toolId)
    const offered = waiting.options.some((option) => option.id === optionId)
    waiting.resolve({ chosen: offered ? optionId : null, invalid: !offered })
  }

  /**
   * The tool card, under a stable id so a later refinement (title, kind, input)
   * rewrites it rather than adding a second card. `kind` is ACP's own category
   * (read, edit, execute, search, fetch, think…); the name stays the title,
   * which is the only human-readable label the protocol has.
   */
  private publishTool(toolId: string, call: { title: string; kind?: string; input: unknown; paths?: string[] }): void {
    this.hooks.event(
      {
        k: 'tool',
        toolId,
        name: call.title,
        input: call.input,
        summary: call.title,
        ...(call.kind ? { kind: call.kind } : {}),
        ...(call.paths?.length ? { paths: call.paths } : {}),
      },
      { id: `tool:${toolId}` },
    )
  }

  private async onRequest(method: string, params: unknown, id: number | string): Promise<unknown> {
    noteProtocol('acp', this.spec.id, `method:${method}`)
    if (method === 'fs/read_text_file') {
      const { path, line, limit } = params as { path?: string; line?: number; limit?: number }
      if (!path) throw new Error('fs/read_text_file without a path')
      // Awaited: on a host this is an ssh round trip, and the agent asks for
      // files in bursts — each one used to hold the whole server's event loop.
      const text = await this.transport.readTextAsync(path)
      if (text === null) throw new Error(`cannot read ${path}`)
      if (!line && !limit) return { content: text }
      const lines = text.split('\n')
      const from = Math.max(0, (line ?? 1) - 1)
      return { content: lines.slice(from, limit ? from + limit : undefined).join('\n') }
    }

    if (method === 'fs/write_text_file') {
      const { path, content } = params as { path?: string; content?: string }
      if (!path) throw new Error('fs/write_text_file without a path')
      await this.transport.writeTextAsync(path, content ?? '')
      return {}
    }

    if (method === 'elicitation/create') {
      return this.askElicitation(String(id), params)
    }

    if (method === 'session/request_permission') {
      const { toolCall, options } = params as {
        toolCall?: AcpPermissionCall
        options?: Array<{ optionId?: string; kind?: string; name?: string }>
      }
      const choices = options ?? []
      // Preference order, not the agent's order: an agent that offers "allow
      // once" first would otherwise win every time, and "accept edits" would
      // never mean what it says.
      const pick = (kinds: string[]): string | null => {
        for (const kind of kinds) {
          const match = choices.find((choice) => choice.kind === kind)
          if (match?.optionId) return match.optionId
        }
        return null
      }
      const mode: PermissionMode = this.opts.permissionMode

      // The modes that mean "ask me" ask: the request becomes a question in the
      // transcript, with the agent's own options, and the turn waits — which is
      // what the protocol is doing anyway. The others answer by themselves only
      // within what choosing them said.
      const paths = permissionPaths(toolCall, this.toolCalls.get(toolCall?.toolCallId ?? '')?.paths)
      const ask = () => this.askPermission(String(id), toolCall?.title ?? 'Tool', toolCall?.kind, paths, choices)
      if (mode === 'manual' || mode === 'default') return ask()

      if (mode === 'plan') {
        const reject = pick(['reject_once', 'reject_always'])
        this.hooks.event({
          k: 'system',
          subtype: 'permission',
          text: `plan-only session: refused “${toolCall?.title ?? 'tool'}”`,
        })
        return reject ? { outcome: { outcome: 'selected', optionId: reject } } : { outcome: { outcome: 'cancelled' } }
      }

      // Once, never "always": an always-rule is stored by the agent and outlives
      // this session and its mode. Accept edits (and `auto`, its alias here)
      // approves only an edit inside the workspace; the rest is the person's.
      let wanted: string | null
      if (mode === 'bypassPermissions') {
        wanted = pick(['allow_once', 'allow_always'])
      } else {
        const isEdit = toolCall?.kind === 'edit'
        if (!(await acceptEditsMayApprove(this.transport, this.opts.cwd, { isEdit, paths }))) return ask()
        wanted = pick(['allow_once'])
        if (!wanted) return ask()
      }
      if (!wanted) return { outcome: { outcome: 'cancelled' } }
      const label = choices.find((choice) => choice.optionId === wanted)?.name ?? wanted
      this.hooks.event({
        k: 'system',
        subtype: 'permission',
        text: `approved “${toolCall?.title ?? 'tool'}” (${label}) — the session's mode decides, so nothing was asked`,
      })
      return { outcome: { outcome: 'selected', optionId: wanted } }
    }

    // Anything else (terminal/*, unknown extensions) is refused explicitly, so
    // the agent falls back instead of waiting forever for an answer.
    throw new Error(`${method} is not supported by sedano`)
  }

  /* ---------------------------------------------------------------- */

  /**
   * Change the model mid-session.
   *
   * The protocol has no `session/set_model`: a model is a session *config
   * option*, changed with `session/set_config_option` and the option's own id
   * (which the agent tells us when the session opens). The private method some
   * agents used to accept is tried afterwards only so that an older agent is not
   * left behind, and if neither answers the picker still works — it just takes
   * effect on the next session.
   */
  private async applyModel(modelId: string): Promise<void> {
    if (this.modelOptionId) {
      try {
        const selection = this.modelSelection(modelId)
        await this.applyConfigOption(this.modelOptionId, selection.model)
        if (selection.effort) {
          if (!this.effortOptionId || !this.configEffortValues.has(selection.effort)) {
            throw new Error(`the agent does not offer reasoning effort ${selection.effort} for ${selection.model}`)
          }
          await this.applyConfigOption(this.effortOptionId, selection.effort)
        }
        // Published from the agent's own answer, not from `modelId`: the reply
        // carries the full option state, and an agent is free to land somewhere
        // else (an alias, a fallback) than the value it was handed.
        if (this.currentModel !== modelId) {
          throw new Error(`the agent reported ${this.currentModel ?? 'no model'} after selecting ${modelId}`)
        }
        return
      } catch (error) {
        // Only an agent too old for session config options is worth a second
        // attempt; anything else is a real refusal and must reach the caller.
        if (!isUnknownMethod(error)) throw error
      }
    }
    // Not in the spec — `session/set_model` never existed there — but the agents
    // that predate session config options accept it, so it is the fallback and
    // never the first thing tried.
    await this.client?.request('session/set_model', { sessionId: this.sessionId, modelId }, CONFIG_TIMEOUT)
    this.publishModel(modelId)
  }

  /** Reasoning effort, for an agent that exposes it as a session config option. */
  private async applyEffort(effort: EffortLevel): Promise<void> {
    if (!this.effortOptionId) throw new UnsupportedLive('this agent has no reasoning-effort option')
    await this.applyConfigOption(this.effortOptionId, effort)
  }

  /**
   * `session/set_config_option`, and the state its answer reports.
   *
   * The response is the authoritative one: the spec has it carry the *full* set
   * of options with their current values, so what the agent ended up on is read
   * from there rather than assumed from what it was asked for.
   */
  private async applyConfigOption(configId: string, value: string): Promise<void> {
    const client = this.client
    if (!client) throw new UnsupportedLive('the agent is not running')
    const response = await client.request<{ configOptions?: RawConfigOption[] }>(
      'session/set_config_option',
      // `type` is required from ACP v2 on, and a v1 agent deserializes an
      // unknown type with a string payload as the value-id variant anyway.
      { sessionId: this.sessionId, configId, type: 'id', value },
      CONFIG_TIMEOUT,
    )
    this.absorbConfigOptions(response?.configOptions)
  }

  /** Say, in the transcript, that a setting was refused — and by whom. */
  private reportConfigFailure(what: string, wanted: string | null, error: unknown): void {
    // The one case where the call site knows more than the text does: nothing in
    // the agent's reply says which setting was being changed, so it is handed to
    // the classifier rather than guessed at from the message.
    this.hooks.error(
      formatFailure(error, {
        ...this.failureContext,
        because: `refused the ${what}${wanted ? ` “${wanted}”` : ''}`,
      }),
    )
  }

  /**
   * Change model / effort / approval mode on a live session.
   *
   * Three outcomes, and the difference between them is the whole point: the
   * protocol takes it (the agent's answer says so, and only then is it
   * published), the protocol cannot express it and a respawn can (dropped here,
   * applied by the next message with the new argv), or it fails — which surfaces
   * as an error instead of a summary quietly claiming a setting the agent
   * rejected.
   */
  configure(patch: Partial<Pick<CreateOptions, 'model' | 'effort' | 'permissionMode'>>): void {
    // The approval mode is ours, not the agent's: it decides how this client
    // answers `session/request_permission`, so it takes effect immediately.
    if (patch.permissionMode) this.opts.permissionMode = patch.permissionMode

    const modelChanged = patch.model !== undefined && patch.model !== this.modelOverride
    const effortChanged = patch.effort !== undefined && patch.effort !== this.opts.effort
    if (patch.model !== undefined) this.modelOverride = patch.model
    if (patch.effort !== undefined) this.opts.effort = patch.effort
    if (!modelChanged && !effortChanged) return

    this.configurationError = null
    const pending = (async () => {
      try {
        // A model cleared back to "the agent's own default" has no value to
        // send: the protocol can only select one of the offered options, so the
        // only honest way to get the default back is a fresh process without
        // `-m`. Same for an effort the agent does not expose as an option.
        if (modelChanged) {
          if (!this.modelOverride) throw new UnsupportedLive('clearing the model needs a fresh agent process')
          await this.applyModel(this.modelOverride)
        }
        if (effortChanged && (!modelChanged || !this.modelOverride?.endsWith(`[${this.opts.effort}]`))) {
          if (!this.opts.effort) throw new UnsupportedLive('clearing the reasoning effort needs a fresh agent process')
          await this.applyEffort(this.opts.effort)
        }
      } catch (error) {
        if (error instanceof UnsupportedLive || isUnknownMethod(error)) {
          this.respawnForConfig(error instanceof UnsupportedLive ? error.message : 'the agent cannot change this live')
          return
        }
        this.reportConfigFailure(modelChanged ? 'model' : 'reasoning effort', this.modelOverride, error)
        this.configurationError = error instanceof Error ? error.message : String(error)
      }
    })()
    this.configuration = pending
    void pending.finally(() => { if (this.configuration === pending) this.configuration = null })
  }

  /**
   * Drop the agent so the next message starts it with the new options.
   *
   * The conversation survives for the agents that can reopen one
   * (`loadSession`), which is why the driver is dropped rather than the change
   * refused — and the transcript says when it will take effect, because nothing
   * has changed yet.
   */
  private respawnForConfig(reason: string): void {
    this.hooks.event({
      k: 'system',
      subtype: 'config-pending',
      text: `${reason} — ${this.spec.id} restarts with the new settings on your next message`,
    })
    this.stop()
  }

  interrupt(): void {
    // The spec is explicit: a client that cancels must answer every pending
    // permission (and elicitation) with `cancelled`. Sending `session/cancel` and
    // leaving the questions unanswered left the agent blocked on a reply that
    // could never come.
    for (const [id, waiting] of this.questions) {
      this.questions.delete(id)
      waiting.resolve({ chosen: null, invalid: false })
    }
    if (!this.client || !this.sessionId) return
    this.client.notify('session/cancel', { sessionId: this.sessionId })
  }

  stop(): void {
    // Nobody is going to answer now: let the agent's pending questions go, or it
    // waits for a reply that can never come.
    for (const [id, waiting] of this.questions) {
      this.questions.delete(id)
      waiting.resolve({ chosen: null, invalid: false })
    }
    this.stopped = true
    if (this.replayTimer) clearTimeout(this.replayTimer)
    this.replayTimer = null
    // A trace still settling belongs to a session that is being taken away: the
    // timer would fire into a driver nobody is watching.
    if (this.crashTimer) clearTimeout(this.crashTimer)
    this.crashTimer = null
    void this.client?.close()
    this.client = null
  }
}

export type { SubagentStatus, TimelineEvent }

/**
 * Exit status and duration of a finished ACP call. The protocol leaves
 * `rawOutput` to the agent; the shapes seen are `exit_code`/`exitCode` and a
 * duration in ms or `{ secs, nanos }`. Without one, the duration is measured
 * from the call's announcement to its completion here.
 */
function acpResultExtras(raw: unknown, startedAt: number | undefined): { exitCode?: number; durationMs?: number } {
  const out: { exitCode?: number; durationMs?: number } = {}
  const output = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const exit = output.exit_code ?? output.exitCode
  if (typeof exit === 'number' && Number.isFinite(exit)) out.exitCode = exit
  const duration = output.duration_ms ?? output.durationMs ?? output.duration
  if (typeof duration === 'number' && Number.isFinite(duration)) out.durationMs = duration
  else if (duration && typeof duration === 'object') {
    const { secs, nanos } = duration as { secs?: unknown; nanos?: unknown }
    if (typeof secs === 'number') out.durationMs = Math.round(secs * 1000 + (typeof nanos === 'number' ? nanos / 1e6 : 0))
  }
  if (out.durationMs === undefined && startedAt !== undefined) out.durationMs = Date.now() - startedAt
  return out
}
