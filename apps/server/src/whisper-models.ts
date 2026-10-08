import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { VoiceDownload } from '@shared'

/**
 * The official whisper.cpp models (ggerganov/whisper.cpp on Hugging Face) and
 * their downloads.
 *
 * Sizes and SHA-256 come from the Hugging Face LFS metadata, so a download is
 * only accepted when it is byte-for-byte the published file. Everything listed
 * is multilingual: the `.en` variants would silently drop Italian.
 */
export interface CatalogEntry {
  file: string
  label: string
  bytes: number
  sha256: string
  hint: string
  multilingual: boolean
  recommended?: boolean
}

const OFFICIAL: CatalogEntry[] = [
  {
    file: 'ggml-large-v3-turbo-q5_0.bin',
    label: 'Large v3 Turbo · q5',
    bytes: 574_041_195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
    hint: 'Fast, near-best accuracy — the best balance',
    multilingual: true,
    recommended: true,
  },
  {
    file: 'ggml-large-v3-turbo-q8_0.bin',
    label: 'Large v3 Turbo · q8',
    bytes: 874_188_075,
    sha256: '317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1',
    hint: 'Fast, a touch more precise than q5',
    multilingual: true,
  },
  {
    file: 'ggml-large-v3-turbo.bin',
    label: 'Large v3 Turbo',
    bytes: 1_624_555_275,
    sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
    hint: 'Turbo at full precision — slower to load, little gain',
    multilingual: true,
  },
  {
    file: 'ggml-large-v3-q5_0.bin',
    label: 'Large v3 · q5',
    bytes: 1_081_140_203,
    sha256: 'd75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1',
    hint: 'Most accurate, noticeably slower than Turbo',
    multilingual: true,
  },
  {
    file: 'ggml-large-v3.bin',
    label: 'Large v3',
    bytes: 3_095_033_483,
    sha256: '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2',
    hint: 'Most accurate at full precision — the slowest',
    multilingual: true,
  },
  {
    file: 'ggml-medium.bin',
    label: 'Medium',
    bytes: 1_533_763_059,
    sha256: '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208',
    hint: 'Good accuracy, slower than Turbo — rarely the better pick',
    multilingual: true,
  },
  {
    file: 'ggml-small.bin',
    label: 'Small',
    bytes: 487_601_967,
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
    hint: 'Very fast, more mistakes on names and Italian',
    multilingual: true,
  },
  {
    file: 'ggml-base.bin',
    label: 'Base',
    bytes: 147_951_465,
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
    hint: 'Fastest and smallest — rough drafts only',
    multilingual: true,
  },
]

/** A test points these at a local fake: its own catalog and its own server. */
export function catalog(): CatalogEntry[] {
  const override = process.env.SEDANO_WHISPER_CATALOG
  if (!override) return OFFICIAL
  return JSON.parse(readFileSync(override, 'utf8')) as CatalogEntry[]
}

function downloadUrl(file: string): string {
  const base = process.env.SEDANO_WHISPER_MODEL_URL ?? 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main'
  return `${base}/${file}`
}

interface Active {
  status: VoiceDownload
  abort: AbortController
}

const downloads = new Map<string, Active>()

export function downloadStatus(file: string): VoiceDownload | null {
  return downloads.get(file)?.status ?? null
}

/**
 * Start (or resume) downloading one catalog model into `dir`.
 *
 * Bytes go to `<file>.part` and are appended with an HTTP Range request, so a
 * failed or cancelled-by-network download continues where it stopped. The file
 * only takes its real name after its size and SHA-256 match the catalog, which
 * is what keeps a half-written model out of the picker.
 */
export function startDownload(file: string, dir: string, onSettled: () => void): VoiceDownload {
  const entry = catalog().find((candidate) => candidate.file === file)
  if (!entry) throw new Error(`not an official whisper.cpp model: ${file}`)
  if (existsSync(join(dir, file))) throw new Error(`${file} is already downloaded`)
  const running = downloads.get(file)
  if (running && running.status.state !== 'failed') return running.status

  const active: Active = {
    status: { received: 0, total: entry.bytes, state: 'downloading', error: null },
    abort: new AbortController(),
  }
  downloads.set(file, active)
  void fetchModel(entry, dir, active).then(
    () => {
      if (downloads.get(file) === active) downloads.delete(file)
      onSettled()
    },
    (error: unknown) => {
      if (active.abort.signal.aborted) {
        if (downloads.get(file) === active) downloads.delete(file)
      } else {
        active.status.state = 'failed'
        active.status.error = error instanceof Error ? error.message : String(error)
      }
      onSettled()
    },
  )
  return active.status
}

/** Stop a download and throw its partial bytes away. */
export function cancelDownload(file: string, dir: string): void {
  const active = downloads.get(file)
  active?.abort.abort()
  downloads.delete(file)
  rmSync(join(dir, `${file}.part`), { force: true })
}

async function* chunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  // No releaseLock(): Bun's fetch body reader does not implement it, and the
  // stream is never reused.
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    yield value
  }
}

async function fetchModel(entry: CatalogEntry, dir: string, active: Active): Promise<void> {
  mkdirSync(dir, { recursive: true })
  const part = join(dir, `${entry.file}.part`)
  let have = existsSync(part) ? statSync(part).size : 0
  if (have > entry.bytes) {
    rmSync(part, { force: true })
    have = 0
  }

  if (have < entry.bytes) {
    const response = await fetch(downloadUrl(entry.file), {
      headers: have ? { range: `bytes=${have}-` } : {},
      signal: active.abort.signal,
    })
    if (response.status !== 200 && response.status !== 206) throw new Error(`download failed: HTTP ${response.status}`)
    // A server that ignores Range sends the whole file again: start over.
    if (response.status === 200) have = 0
    if (!response.body) throw new Error('download failed: empty response')
    const handle = await open(part, have ? 'a' : 'w')
    active.status.received = have
    try {
      for await (const chunk of chunks(response.body)) {
        await handle.write(chunk)
        active.status.received += chunk.byteLength
      }
    } finally {
      await handle.close()
    }
  }

  const size = statSync(part).size
  if (size !== entry.bytes) {
    // Too short keeps the bytes for a resume; too long can never become right.
    if (size > entry.bytes) rmSync(part, { force: true })
    throw new Error(`download incomplete: ${size} of ${entry.bytes} bytes`)
  }

  active.status.state = 'verifying'
  const hasher = createHash('sha256')
  for await (const chunk of createReadStream(part)) hasher.update(chunk as Buffer)
  const digest = hasher.digest('hex')
  if (digest !== entry.sha256) {
    rmSync(part, { force: true })
    throw new Error('download corrupted: checksum does not match, the file was removed')
  }
  renameSync(part, join(dir, entry.file))
}
