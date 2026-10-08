import { readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Adapter, CreateOptions, Driver, DriverHooks, ModelInfo } from '../types.ts'
import { modelTakesImages } from '../model-images.ts'
import { effortsForCommandCodeModel } from './efforts.ts'
import { findBinary } from '../terminal/presets.ts'
import { CommandCodeDriver } from './session.ts'
import { Transport, shq } from '../../transport.ts'
import { kvGet, kvSet } from '../../db.ts'

/**
 * Command Code as a first-class harness.
 *
 * It has no ACP server, but its headless mode is a clean NDJSON stream, which is
 * the same shape Claude's print mode gives us — so it gets its own small adapter
 * instead of being forced through a bridge it does not speak.
 */
const BIN_NAMES = ['cmd', 'command-code']

const DEFAULT_MODELS: ModelInfo[] = [
  { id: '', label: 'Default (from Command Code Config)', isDefault: true },
]

let models: ModelInfo[] = DEFAULT_MODELS
/**
 * What the CLI on each host reports, kept per machine.
 *
 * Its model list used to be offered on this machine only — "a host's build may
 * differ" — which meant the picker on a server showed nothing at all, forever.
 * The honest version is to ask that machine's CLI, which is what this is: the
 * same `--list-models`, run over the transport, cached per host.
 */
const modelsByHost = new Map<string, ModelInfo[]>()
const MODELS_CACHE_KEY = 'commandcode-models-v1'
try {
  const saved = JSON.parse(kvGet(MODELS_CACHE_KEY) ?? '{}') as Record<string, ModelInfo[]>
  for (const [host, list] of Object.entries(saved)) {
    if (!Array.isArray(list) || list.length < 2) continue
    if (host === '') models = list
    else modelsByHost.set(host, list)
  }
} catch { /* a damaged cache must not prevent startup */ }

function persistModels(): void {
  try {
    kvSet(MODELS_CACHE_KEY, JSON.stringify({ '': models, ...Object.fromEntries(modelsByHost) }))
  } catch { /* a read-only store still permits an in-memory catalog */ }
}

function resolveBin(): string | null {
  for (const name of BIN_NAMES) {
    const found = findBinary(name)
    if (found) return found
  }
  return null
}

/** `cmd --list-models` prints `<id>   <description>` rows under category headings. */
const EFFORT_WORDS = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
const MODEL_DOCS = ['bundled', 'command-code-knowledge', 'reference', 'models.md']

/**
 * Command Code ships the exact table its own `/model` and `/effort` controls
 * use. Reading its generated markdown keeps Sedano current with the installed
 * CLI without network calls or a duplicated release-specific capability map.
 */
export function parseCommandCodeEffortDocs(markdown: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('| `')) continue
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
    const id = /^`(.+)`$/.exec(cells[0] ?? '')?.[1]
    if (!id) continue
    const efforts = (cells[3] ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter((value) => EFFORT_WORDS.has(value))
    out.set(id.toLowerCase(), efforts)
  }
  return out
}

/**
 * Each model's context window, from the same table's "Context" column (`1M`,
 * `1.05M`, `256K`). The CLI states a window only when it compacts, so this is
 * the window its own meter divides by, read from its own install.
 */
export function parseCommandCodeContextDocs(markdown: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('| `')) continue
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim())
    const id = /^`(.+)`$/.exec(cells[0] ?? '')?.[1]
    const size = /^(\d+(?:\.\d+)?)\s*([KM])$/i.exec(cells[2] ?? '')
    if (!id || !size) continue
    out.set(id.toLowerCase(), Math.round(Number(size[1]) * (size[2]!.toUpperCase() === 'M' ? 1_000_000 : 1_000)))
  }
  return out
}

/** Context windows per machine ('' is this one), learned with the model list. */
const windowsByHost = new Map<string, Map<string, number>>()

function localModelDocs(bin: string): string {
  try {
    return readFileSync(join(dirname(realpathSync(bin)), ...MODEL_DOCS), 'utf8')
  } catch {
    return ''
  }
}

function remoteModelDocs(transport: Transport, bin: string): string {
  try {
    const resolved = transport.exec(`realpath ${shq(bin)}`, { timeoutMs: 8_000 }).stdout.trim() || bin
    return transport.readText(join(dirname(resolved), ...MODEL_DOCS)) ?? ''
  } catch {
    return ''
  }
}

function parseModels(output: string, liveEfforts = new Map<string, string[]>()): ModelInfo[] {
  const out: ModelInfo[] = []
  for (const line of output.split('\n')) {
    const match = /^(\S+)\s{2,}(.+)$/.exec(line.trimEnd())
    if (!match) continue
    const id = match[1]!
    // A category heading is a word on a line of its own (no second column at
    // all, so it never matched), but two labels are shaped like a model row: the
    // header (`Available models · 72 models`) and the footer that points at the
    // docs (`Docs:  https://…`). Both are labels, not models.
    if (match[2]!.startsWith('\u00b7') || id.endsWith(':')) continue
    // Every other row is a model. Only the open-weight ones are `provider/model`:
    // the Claude and GPT lines are bare ids, and requiring a slash quietly hid
    // every one of them from the picker.
    out.push({
      id,
      label: id,
      images: modelTakesImages(id, match[2]!),
      // Command Code rejects the whole turn when an unsupported --effort is
      // supplied. An absent entry therefore means "do not send one", not
      // "offer every value and discover the answer by failing a run".
      efforts: liveEfforts.get(id.toLowerCase()) ?? effortsForCommandCodeModel(id) ?? [],
      isDefault: match[2]!.includes('(default)') || undefined,
    })
  }
  return out
}

/** The same listing, but run on the host by shelling out over the transport. */
async function listModelsOn(transport: Transport, bin: string): Promise<ModelInfo[]> {
  try {
    const out = transport.exec(`${shq(bin)} --list-models`, { timeoutMs: 20_000 })
    const docs = remoteModelDocs(transport, bin)
    windowsByHost.set(transport.host ?? '', parseCommandCodeContextDocs(docs))
    const parsed = parseModels(out.stdout ?? '', parseCommandCodeEffortDocs(docs))
    return parsed.length ? [...DEFAULT_MODELS, ...parsed] : DEFAULT_MODELS
  } catch {
    return DEFAULT_MODELS
  }
}

async function listModels(bin: string): Promise<ModelInfo[]> {
  try {
    const proc = Bun.spawn([bin, '--list-models'], { stdout: 'pipe', stderr: 'ignore' })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    const docs = localModelDocs(bin)
    windowsByHost.set('', parseCommandCodeContextDocs(docs))
    const parsed = parseModels(text, parseCommandCodeEffortDocs(docs))
    return parsed.length ? [...DEFAULT_MODELS, ...parsed] : DEFAULT_MODELS
  } catch {
    return DEFAULT_MODELS
  }
}

export const commandCodeAdapter: Adapter = {
  id: 'commandcode',
  label: 'Command Code',
  // Its headless mode reads a text prompt from stdin (`cmd -p`), and the CLI has
  // no way to attach an image: the content blocks its own interface builds are
  // built there, in its terminal UI, where pasting a screenshot works. The model
  // list still says which models see — that answer belongs to the model, and it
  // is what its own UI uses — but it cannot make this pipe carry an image.
  images: false,
  imagesNote:
    'Command Code\u2019s headless mode takes a text prompt — paste images in its own terminal UI (cmd) instead',

  async detect() {
    const bin = resolveBin()
    if (!bin) return { available: false, bin: null, version: null }
    // Model discovery belongs to the background sweep. Detect must never make
    // the whole machine catalog wait for `cmd --list-models`.
    return { available: true, bin, version: null }
  },

  models: (host) => (host ? (modelsByHost.get(host) ?? DEFAULT_MODELS) : models),

  /**
   * Ask this machine's CLI for its models. Called in the background when the
   * picker would otherwise offer nothing, for whatever machine that picker is
   * showing (see the manager's priming).
   */
  async refreshModels(host) {
    const bin = host ? resolveRemoteBin(host) : resolveBin()
    if (!bin) throw new Error(`Command Code not found ${host ? `on ${host}` : 'in PATH'} (looked for \`cmd\`)`)
    const listed = host
      ? await listModelsOn(new Transport(host), bin)
      : await listModels(bin)
    if (listed.length <= 1) throw new Error(`Command Code ${host ? `on ${host}` : 'on this machine'} reported no models`)
    if (host) modelsByHost.set(host, listed)
    else models = listed
    persistModels()
  },

  async create(opts: CreateOptions, hooks: DriverHooks): Promise<Driver> {
    const bin = opts.host ? resolveRemoteBin(opts.host) : resolveBin()
    if (!bin) {
      throw new Error(
        opts.host
          ? `Command Code not found on ${opts.host} (looked for \`cmd\`)`
          : 'Command Code not found in PATH (looked for `cmd`)',
      )
    }
    // This machine's table is a file read; a host's is only known once its
    // model list was fetched, and until then its window is simply not known.
    if (!opts.host && !windowsByHost.has('')) windowsByHost.set('', parseCommandCodeContextDocs(localModelDocs(bin)))
    const driver = new CommandCodeDriver(opts, hooks, bin, windowsByHost.get(opts.host ?? '') ?? new Map())
    await driver.start()
    return driver
  },
}

/** Same lookup, on the host the session will run on. */
function resolveRemoteBin(host: string): string | null {
  const transport = new Transport(host)
  for (const name of BIN_NAMES) {
    const found = transport.which(name)
    if (found) return found
  }
  return null
}
