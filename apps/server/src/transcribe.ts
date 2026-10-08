import { constants, accessSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { VoiceCatalogModel, VoiceEngine, VoiceLastRun, VoiceModelFile, VoiceProvider, VoiceStatus } from '@shared'
import * as db from './db.ts'
import { which } from './which.ts'
import { cancelDownload, catalog, downloadStatus, startDownload } from './whisper-models.ts'

/**
 * Speech to text for the composer microphone.
 *
 * The normal provider is `whisper-cli` (whisper.cpp): one process and one model
 * file on this machine, with no server, account, quota or network request.
 * An explicitly configured OpenAI-compatible localhost endpoint is retained for
 * people who already run one, but sedano never scans ports or requires it.
 *
 * Nothing leaves the machine: the audio is handed to a local process or a local
 * HTTP server, and the transcript comes back as text.
 */
const MODEL_DIRS = [
  ...(process.env.SEDANO_VOICE_MODELS ? [process.env.SEDANO_VOICE_MODELS] : []),
  join(process.env.HOME ?? '', '.cache/whisper-cpp'),
  join(process.env.HOME ?? '', '.cache/whisper.cpp'),
  join(dirname(process.execPath), 'models'),
  '/opt/homebrew/share/whisper.cpp/models',
]

const KV_PROVIDER = 'voice.provider'
const KV_MODEL = 'voice.model'
const KV_ENDPOINT = 'voice.endpoint'
const KV_LANGUAGE = 'voice.language'

export interface VoiceConfig {
  provider: VoiceProvider
  model: string | null
  endpoint: string | null
  language: string
}

/** The engines are a fixed pair; what changes is whether this machine has them. */
const PROVIDERS: VoiceProvider[] = ['auto', 'whisper-cli', 'openai']

function asProvider(value: string | null): VoiceProvider {
  return PROVIDERS.includes(value as VoiceProvider) ? (value as VoiceProvider) : 'auto'
}

let cached: { at: number; status: VoiceStatus } | null = null
const CACHE_MS = 15_000

/**
 * A Finder-launched macOS app inherits the system PATH, not the login shell's.
 * Homebrew is therefore invisible even when the executable is already present.
 * Resolve the user's installation explicitly, and also honour binaries shipped
 * beside the compiled sidecar so a distributor can bundle static builds later.
 */
function executable(name: string, override?: string): string | null {
  const onPath = which(name)
  const candidates = [
    override,
    onPath,
    join(dirname(process.execPath), name),
    join(process.env.HOME ?? '', '.local', 'bin', name),
    join(process.env.HOME ?? '', '.bin', name),
    join('/opt/homebrew/bin', name),
    join('/usr/local/bin', name),
  ].filter(Boolean) as string[]

  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      /* keep looking */
    }
  }
  return null
}

function whisperBinary(): string | null {
  return (
    executable('whisper-cli', process.env.SEDANO_WHISPER_BIN) ??
    executable('whisper-cpp', process.env.SEDANO_WHISPER_BIN)
  )
}

function ffmpegBinary(): string | null {
  return executable('ffmpeg', process.env.SEDANO_FFMPEG_BIN)
}

/** Bigger is better, and turbo is better still: best quality per second. */
function rank(name: string): number {
  if (/large-v3-turbo/i.test(name)) return 5
  if (/large/i.test(name)) return 4
  if (/medium/i.test(name)) return 3
  if (/small/i.test(name)) return 2
  if (/base/i.test(name)) return 1
  return 0
}

/**
 * Every whisper.cpp model this machine has, best first.
 *
 * The selector used to show the one file the server had picked, which answers
 * "what is in use" and not "what can I use" — and those were exactly the two
 * questions a picker with nothing in it raises. Listing them is also what makes
 * choosing one possible at all.
 */
export function whisperModels(): VoiceModelFile[] {
  const found: VoiceModelFile[] = []
  const seen = new Set<string>()
  for (const dir of MODEL_DIRS) {
    try {
      if (!statSync(dir).isDirectory()) continue
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.bin')) continue
        const path = join(dir, name)
        if (seen.has(path)) continue
        seen.add(path)
        found.push({ path, label: name, bytes: statSync(path).size })
      }
    } catch {
      /* directory missing, or unreadable: it simply contributes nothing */
    }
  }
  return found.sort((a, b) => rank(b.label) - rank(a.label) || a.label.localeCompare(b.label))
}

function whisperModel(): string | null {
  return whisperModels()[0]?.path ?? null
}

/** Where downloads go: the first model directory, which is also where the curl hint points. */
const DOWNLOAD_DIR = MODEL_DIRS[0]!

/** The official models, each with where it is on disk and how its download is going. */
function catalogModels(onDisk: VoiceModelFile[]): VoiceCatalogModel[] {
  return catalog().map((entry) => ({
    file: entry.file,
    label: entry.label,
    bytes: entry.bytes,
    hint: entry.hint,
    multilingual: entry.multilingual,
    recommended: Boolean(entry.recommended),
    path: onDisk.find((model) => model.label === entry.file)?.path ?? null,
    download: downloadStatus(entry.file),
  }))
}

export function downloadWhisperModel(file: string, onSettled: () => void): void {
  startDownload(file, DOWNLOAD_DIR, () => {
    cached = null
    onSettled()
  })
  cached = null
}

export function cancelWhisperDownload(file: string): void {
  cancelDownload(file, DOWNLOAD_DIR)
  cached = null
}

/** Only a model file this server itself lists can be deleted — never an arbitrary path. */
export function deleteWhisperModel(path: string): void {
  if (!whisperModels().some((model) => model.path === path)) throw new Error(`not a whisper model on this machine: ${path}`)
  rmSync(path, { force: true })
  if (db.kvGet(KV_MODEL) === path) db.kvSet(KV_MODEL, '')
  cached = null
}

/**
 * CPU threads for whisper-cli. The heavy work runs on the GPU (Metal is on by
 * default in the Homebrew build), so this only sizes the CPU side: the
 * performance cores on Apple Silicon, four elsewhere — its own default.
 */
let threadCount: number | null = null
function whisperThreads(): number {
  if (threadCount !== null) return threadCount
  threadCount = 4
  if (process.platform === 'darwin') {
    try {
      const out = Bun.spawnSync(['/usr/sbin/sysctl', '-n', 'hw.perflevel0.physicalcpu']).stdout.toString().trim()
      const cores = Number.parseInt(out, 10)
      if (cores > 0) threadCount = Math.min(cores, 8)
    } catch {
      /* not Apple Silicon, or no sysctl: keep the default */
    }
  }
  return threadCount
}

let lastRun: VoiceLastRun | null = null

async function probeEndpoint(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(900) })
    return res.ok
  } catch {
    return false
  }
}

export function config(): VoiceConfig {
  const endpoint = db.kvGet(KV_ENDPOINT)
  const stored = asProvider(db.kvGet(KV_PROVIDER))
  return {
    // Older builds offered "Local server" without an endpoint field. Do not
    // strand somebody on that now-useless choice after upgrading.
    provider: stored === 'openai' && !endpoint ? 'auto' : stored,
    model: db.kvGet(KV_MODEL),
    endpoint,
    language: db.kvGet(KV_LANGUAGE) ?? 'auto',
  }
}

export function setConfig(patch: Partial<VoiceConfig>): VoiceConfig {
  if (patch.provider !== undefined) {
    // Validated at the boundary: an engine nobody implements, stored, is a
    // setting the panel would show as chosen and no recording could ever use.
    if (!PROVIDERS.includes(patch.provider)) throw new Error(`unknown dictation engine: ${patch.provider}`)
    db.kvSet(KV_PROVIDER, patch.provider)
  }
  if (patch.model !== undefined) db.kvSet(KV_MODEL, patch.model ?? '')
  if (patch.endpoint !== undefined) db.kvSet(KV_ENDPOINT, patch.endpoint ?? '')
  if (patch.language !== undefined) {
    // Handed to whisper-cli as the value of `-l`: anything but a language code
    // (a value starting with `-`, say) would be read as another flag.
    if (!/^(auto|[a-z]{2,3})$/i.test(patch.language)) throw new Error(`unknown dictation language: ${patch.language}`)
    db.kvSet(KV_LANGUAGE, patch.language)
  }
  cached = null
  return config()
}

/**
 * How to install whisper.cpp here, in one line, or nothing.
 *
 * Only a command whose package manager is actually on this machine is named:
 * printing `brew install …` to somebody without brew is the same kind of
 * unearned answer as a green dot nobody checked.
 */
function whisperInstallCommand(): string | null {
  if (executable('brew')) return 'brew install whisper-cpp'
  if (which('apt-get')) return 'Build whisper.cpp from source'
  if (which('pacman')) return 'sudo pacman -S whisper.cpp'
  return null
}

/** The model most people want, and where it really lives. */
const DEFAULT_MODEL_FILE = 'ggml-large-v3-turbo-q5_0.bin'
const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${DEFAULT_MODEL_FILE}`

/**
 * Both engines, described by what this machine actually has.
 *
 * Nothing here is a guess and nothing here installs anything. `install` is a
 * command to read and run yourself: pulling a 550 MB model or invoking a package
 * manager from a settings panel is work the user should see happening in a
 * terminal, and a progress bar we could not honestly drive would be worse than
 * the line that does the job.
 */
export async function voiceEngines(): Promise<VoiceEngine[]> {
  const cfg = config()
  const bin = whisperBinary()
  const models = whisperModels()
  const missingWhisper: string[] = []
  if (!bin) missingWhisper.push('whisper-cli')
  if (!models.length) missingWhisper.push('a model file')

  const install = !bin ? whisperInstallCommand() : null
  const modelCommand = models.length
    ? null
    : `curl -L --create-dirs -o ${MODEL_DIRS[0]}/${DEFAULT_MODEL_FILE} ${MODEL_URL}`

  const whisper: VoiceEngine = {
    id: 'whisper-cli',
    label: 'whisper.cpp',
    ready: Boolean(bin && models.length),
    detail: bin
      ? `${models.length} on-device model${models.length === 1 ? '' : 's'} · no speech server required`
      : 'Not installed on this machine',
    missing: missingWhisper.length ? `Missing ${missingWhisper.join(', ')}` : null,
    install: modelCommand ?? install,
    models,
    catalog: catalogModels(models),
  }

  // A server is an advanced opt-in. Guessing four localhost ports made an
  // ordinary on-device setup look broken and added a second of noise to every
  // refresh. Only probe the endpoint somebody actually configured.
  const live = cfg.endpoint && (await probeEndpoint(cfg.endpoint)) ? cfg.endpoint : null

  const server: VoiceEngine = {
    id: 'openai',
    label: 'Local speech server',
    ready: live !== null,
    detail: live ? `Answering at ${live}` : 'Optional · no server configured',
    missing: live ? null : 'No endpoint configured (on-device dictation does not need one)',
    endpoint: live,
    // Deliberately not an install: this engine is a server you run, and there is
    // no command this app could run for you that would be honest about what it
    // starts, where it listens and when it stops.
    install: null,
  }

  return [whisper, server]
}

/** Where a request for one audio file will actually be sent. */
export async function resolveVoice(force = false): Promise<VoiceStatus> {
  // The last run changes without invalidating anything else, so it is added fresh.
  if (!force && cached && Date.now() - cached.at < CACHE_MS) return { ...cached.status, lastRun }
  const cfg = config()

  // One inventory for the panel and for the routing decision. They used to be
  // computed separately, which is how the panel could say an engine was there
  // while a recording went somewhere else.
  const engines = await voiceEngines()
  const whisper = engines.find((engine) => engine.id === 'whisper-cli')!
  const server = engines.find((engine) => engine.id === 'openai')!

  // `auto` means on-device. A server is only ever used when explicitly chosen;
  // otherwise an unavailable optional service made a local model look as if it
  // depended on localhost ports.
  const order = cfg.provider === 'openai' ? [server] : [whisper]
  const chosen = order.find((engine) => engine.ready) ?? null

  const base = { language: cfg.language, configured: cfg.provider, engines }

  let status: VoiceStatus
  if (chosen === whisper) {
    // An explicitly chosen model file wins over the best one found, which is
    // what makes the model list in Settings a choice rather than a readout.
    const model = (cfg.model && whisper.models?.some((file) => file.path === cfg.model) ? cfg.model : null) ?? whisperModel()!
    status = {
      ...base,
      provider: 'whisper-cli',
      model,
      endpoint: null,
      ready: true,
      detail: `On-device · ${model.split('/').pop()} · no server or quota`,
    }
  } else if (chosen === server) {
    const endpoint = server.endpoint ?? cfg.endpoint
    status = {
      ...base,
      provider: 'openai',
      model: cfg.model,
      endpoint,
      ready: true,
      detail: `openai-compatible · ${endpoint}`,
    }
  } else {
    // Nothing usable: say which engine was asked for and what it is missing,
    // never a bare "unavailable" that leaves the user with nothing to act on.
    const asked = cfg.provider === 'openai' ? server : whisper
    status = {
      ...base,
      provider: 'none',
      model: null,
      endpoint: null,
      ready: false,
      detail: asked.missing ?? 'On-device dictation is unavailable',
    }
  }

  cached = { at: Date.now(), status }
  return { ...status, lastRun }
}

/**
 * How long one recording may take to convert or transcribe. A wedged ffmpeg or
 * whisper-cli used to hold its HTTP request, its temp directory and a
 * multi-gigabyte model in memory for good; the next recording then started a
 * second one beside it.
 */
const STT_TIMEOUT_MS = 180_000

/** Kill a helper process that outlives the deadline; returns the disarm. */
function deadline(proc: { kill(): void }): () => void {
  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      /* already gone */
    }
  }, STT_TIMEOUT_MS)
  return () => clearTimeout(timer)
}

function extensionFor(mime: string): string {
  if (mime.includes('ogg')) return 'ogg'
  if (mime.includes('mp4') || mime.includes('m4a')) return 'm4a'
  if (mime.includes('wav')) return 'wav'
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3'
  return 'webm'
}

/** 16 kHz mono PCM is what whisper.cpp wants. */
async function toWav(input: string, output: string): Promise<void> {
  const ffmpeg = ffmpegBinary()
  if (!ffmpeg) throw new Error('ffmpeg not found: needed to convert the recording')
  const proc = Bun.spawn([ffmpeg, '-y', '-loglevel', 'error', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output], {
    stdout: 'ignore',
    stderr: 'pipe',
  })
  const disarm = deadline(proc)
  // Drained while it runs, not after: a chatty ffmpeg that fills the pipe
  // would otherwise block on its own stderr and never exit.
  const stderr = new Response(proc.stderr).text()
  const code = await proc.exited
  disarm()
  if (code !== 0) {
    const detail = await stderr
    throw new Error(`ffmpeg failed: ${detail.trim().split('\n').slice(-1)[0] ?? code}`)
  }
}

async function viaWhisperCli(audio: Uint8Array, mime: string, model: string, language: string): Promise<string> {
  const bin = whisperBinary()
  if (!bin) throw new Error('whisper-cli is not installed')
  const dir = mkdtempSync(join(tmpdir(), 'sedano-stt-'))
  try {
    // Distinct names: when the recording is already a wav, writing the
    // converted file over the input makes ffmpeg refuse the output entirely.
    const raw = join(dir, `input.${extensionFor(mime)}`)
    const wav = join(dir, 'clip.wav')
    writeFileSync(raw, audio)
    // The composer records 16 kHz mono PCM itself, so the normal path has no
    // ffmpeg dependency. Keep conversion only for older clients that still send
    // a compressed MediaRecorder blob.
    if (mime.includes('wav')) writeFileSync(wav, audio)
    else await toWav(raw, wav)
    const args = [
      bin,
      '-m',
      model,
      '-f',
      wav,
      '-nt',
      '-np',
      '-t',
      String(whisperThreads()),
      '-l',
      language === 'auto' ? 'auto' : language,
    ]
    const started = Date.now()
    const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'ignore', env: { ...process.env, NO_COLOR: '1' } })
    const disarm = deadline(proc)
    const text = await new Response(proc.stdout).text()
    const code = await proc.exited
    disarm()
    if (code !== 0) throw new Error(`whisper-cli exited with code ${code}`)
    // 16 kHz mono 16-bit PCM is 32,000 bytes a second, after the 44-byte header.
    const audioSeconds = Math.max(0, statSync(wav).size - 44) / 32_000
    lastRun = { model: model.split('/').pop() ?? model, ms: Date.now() - started, audioSeconds, at: Date.now() }
    return text
      .split('\n')
      // whisper-cli prints timing lines first; keep the actual transcript.
      .filter((line) => !/^\[[\d:.]+\s*-->/.test(line.trim()))
      .join(' ')
      .trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function viaEndpoint(
  audio: Uint8Array,
  mime: string,
  endpoint: string,
  model: string | null,
  language: string,
): Promise<string> {
  const form = new FormData()
  form.append('file', new Blob([audio as BlobPart], { type: mime }), `clip.${extensionFor(mime)}`)
  form.append('model', model ?? 'whisper-1')
  form.append('response_format', 'json')
  if (language && language !== 'auto') form.append('language', language)
  const res = await fetch(`${endpoint}/v1/audio/transcriptions`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(STT_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`transcription failed: ${res.status} ${await res.text()}`)
  const data = (await res.json()) as { text?: string }
  return (data.text ?? '').trim()
}

/**
 * One transcription at a time. Each whisper-cli run loads its model (up to a
 * few GB) into memory; two recordings sent back to back used to load two
 * copies side by side and slow both. Later ones wait their turn, in order, and
 * a failure does not block the queue behind it.
 */
let transcribing: Promise<unknown> = Promise.resolve()

export function transcribe(audio: Uint8Array, mime: string): Promise<string> {
  const run = transcribing.then(
    () => transcribeNow(audio, mime),
    () => transcribeNow(audio, mime),
  )
  transcribing = run.catch(() => undefined)
  return run
}

async function transcribeNow(audio: Uint8Array, mime: string): Promise<string> {
  const cfg = config()
  const status = await resolveVoice()
  if (!status.ready) throw new Error(`no local speech model available — ${status.detail}`)

  if (status.provider === 'openai' && status.endpoint) {
    return viaEndpoint(audio, mime, status.endpoint, cfg.model, cfg.language)
  }
  if (!status.model) throw new Error('no whisper model configured')
  return viaWhisperCli(audio, mime, status.model, cfg.language)
}
