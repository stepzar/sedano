#!/usr/bin/env bun
/**
 * Hermetic gate for on-device dictation. No API, localhost server, ffmpeg,
 * microphone or operator database is touched.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

if (!process.env.SEDANO_DICTATION_SANDBOX) {
  const sandbox = mkdtempSync('/tmp/sedano-dictation-')
  const bin = join(sandbox, 'bin')
  const home = join(sandbox, 'home')
  const models = join(home, '.cache', 'whisper-cpp')
  mkdirSync(bin, { recursive: true })
  mkdirSync(models, { recursive: true })
  const whisper = join(bin, 'whisper-cli')
  writeFileSync(
    whisper,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "$SEDANO_DICTATION_SANDBOX/args"\nprintf 'dettatura locale riuscita\\n'\n`,
  )
  chmodSync(whisper, 0o755)
  writeFileSync(join(models, 'ggml-small.bin'), 'model')

  const child = Bun.spawn([process.execPath, import.meta.path], {
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      HOME: home,
      SEDANO_HOME: join(sandbox, 'data'),
      SEDANO_DICTATION_SANDBOX: sandbox,
      SEDANO_WHISPER_CATALOG: join(sandbox, 'catalog.json'),
      SEDANO_VOICE_MODELS: '',
    },
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  const code = await child.exited
  rmSync(sandbox, { recursive: true, force: true })
  process.exit(code)
}

const sandbox = process.env.SEDANO_DICTATION_SANDBOX!
const failures: string[] = []
let passed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  if (ok) {
    passed += 1
    console.log(`  ok  ${label}`)
  } else {
    failures.push(`${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

/*
 * A fake Hugging Face: serves model bytes with Range support, records the Range
 * header it was asked for, and has one route that stalls forever (to cancel).
 */
const good = new Uint8Array(300_000).map((_, index) => index % 251)
const sha = (bytes: Uint8Array): string => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
const ranges: string[] = []
const fakeHub = Bun.serve({
  port: 0,
  fetch(req) {
    const file = new URL(req.url).pathname.split('/').pop()
    if (file === 'ggml-stall.bin') {
      return new Response(new ReadableStream({ start: (controller) => controller.enqueue(good.slice(0, 1000)) }))
    }
    if (file !== 'ggml-fake-turbo.bin' && file !== 'ggml-corrupt.bin') return new Response('missing', { status: 404 })
    const range = req.headers.get('range')
    ranges.push(range ?? '')
    const from = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0
    return new Response(good.slice(from), { status: range ? 206 : 200 })
  },
})
process.env.SEDANO_WHISPER_MODEL_URL = `http://127.0.0.1:${fakeHub.port}`
const entry = (file: string, digest: string) => ({
  file,
  label: file,
  bytes: good.length,
  sha256: digest,
  hint: 'test',
  multilingual: true,
})
writeFileSync(
  join(sandbox, 'catalog.json'),
  JSON.stringify([
    entry('ggml-fake-turbo.bin', sha(good)),
    entry('ggml-corrupt.bin', '0'.repeat(64)),
    entry('ggml-stall.bin', sha(good)),
    { ...entry('ggml-small.bin', 'x'), bytes: 5 },
  ]),
)

const audio = await import('../apps/ui/src/audio.ts')
const voice = await import('../apps/server/src/transcribe.ts')

const blob = audio.wavBlob([new Float32Array(48_000).fill(0.2)], 48_000)
const bytes = new Uint8Array(await blob.arrayBuffer())
const header = new DataView(bytes.buffer)
check('the browser emits a RIFF WAV', new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF')
check('the WAV is mono', header.getUint16(22, true) === 1)
check('the WAV is 16 kHz', header.getUint32(24, true) === 16_000)
check('resampling preserves one second', header.getUint32(40, true) === 32_000)

const status = await voice.resolveVoice(true)
check('on-device dictation is ready', status.ready && status.provider === 'whisper-cli', status)
check('no server or quota is part of the route', /no server or quota/i.test(status.detail), status.detail)
check('the model on disk is selected', status.model?.endsWith('ggml-small.bin') === true, status.model)
const server = status.engines?.find((engine) => engine.id === 'openai')
check('the optional server does not scan or report ports', server?.detail === 'Optional · no server configured', server)

const text = await voice.transcribe(bytes, 'audio/wav')
check('the WAV reaches whisper directly without ffmpeg', text === 'dettatura locale riuscita', text)
const args = await Bun.file(join(sandbox, 'args')).text()
check('whisper receives the selected model', args.includes('ggml-small.bin'), args)
check('whisper receives a WAV', args.includes('clip.wav'), args)

check('whisper runs with an explicit thread count', /^-t\n\d+$/m.test(args), args)
check('and never with the GPU turned off', !args.includes('-ng'), args)
const run = (await voice.resolveVoice()).lastRun
check('the last transcription time is reported', run?.model === 'ggml-small.bin' && typeof run.ms === 'number', run)
check('with the length of the audio', Math.abs((run?.audioSeconds ?? 0) - 1) < 0.01, run)

/* Model catalog: listed, downloaded (resumed + verified), cancelled, deleted */

const whisperEngine = async () => (await voice.resolveVoice(true)).engines?.find((engine) => engine.id === 'whisper-cli')
const listed = (await whisperEngine())?.catalog ?? []
check('the catalog lists every official model', listed.length === 4, listed.map((m) => m.file))
check('a model already on disk has its path', Boolean(listed.find((m) => m.file === 'ggml-small.bin')?.path), listed)
check('a missing model has none', listed.find((m) => m.file === 'ggml-fake-turbo.bin')?.path === null, listed)

const modelsDir = join(process.env.HOME!, '.cache', 'whisper-cpp')
const settle = async (file: string): Promise<void> => {
  for (let i = 0; i < 1000; i += 1) {
    const state = (await whisperEngine())?.catalog?.find((m) => m.file === file)?.download
    if (!state || state.state === 'failed') return
    await Bun.sleep(20)
  }
}

// Half of it is already there from an interrupted run: only the rest is fetched.
writeFileSync(join(modelsDir, 'ggml-fake-turbo.bin.part'), good.slice(0, 100_000))
voice.downloadWhisperModel('ggml-fake-turbo.bin', () => undefined)
await settle('ggml-fake-turbo.bin')
check('an interrupted download resumes with a Range request', ranges[0] === 'bytes=100000-', ranges)
const fetched = (await whisperEngine())?.catalog?.find((m) => m.file === 'ggml-fake-turbo.bin')
check('a verified download becomes a usable model', Boolean(fetched?.path) && fetched?.download === null, fetched)
if (!fetched?.path) throw new Error(`download did not finish: ${JSON.stringify(fetched)}`)
check(
  'the file on disk is exactly the published one',
  sha(new Uint8Array(await Bun.file(join(modelsDir, 'ggml-fake-turbo.bin')).arrayBuffer())) === sha(good),
)

voice.downloadWhisperModel('ggml-corrupt.bin', () => undefined)
await settle('ggml-corrupt.bin')
const corrupt = (await whisperEngine())?.catalog?.find((m) => m.file === 'ggml-corrupt.bin')
check('a checksum mismatch fails the download', corrupt?.download?.state === 'failed' && !corrupt.path, corrupt)
check('and leaves no partial file behind', !existsSync(join(modelsDir, 'ggml-corrupt.bin.part')), corrupt?.download)

voice.downloadWhisperModel('ggml-stall.bin', () => undefined)
await Bun.sleep(100)
const stalled = (await whisperEngine())?.catalog?.find((m) => m.file === 'ggml-stall.bin')
check('progress is reported while downloading', stalled?.download?.state === 'downloading', stalled)
voice.cancelWhisperDownload('ggml-stall.bin')
await Bun.sleep(50)
const cancelled = (await whisperEngine())?.catalog?.find((m) => m.file === 'ggml-stall.bin')
check('a cancelled download is gone', cancelled?.download === null && !cancelled.path, cancelled)
check('with its partial bytes', !existsSync(join(modelsDir, 'ggml-stall.bin.part')))

let refused = false
try {
  voice.downloadWhisperModel('../../etc/passwd', () => undefined)
} catch {
  refused = true
}
check('a file outside the catalog is never downloaded', refused)

// Switching is instant: the next recording uses the new model.
voice.setConfig({ model: fetched?.path ?? null })
await voice.transcribe(bytes, 'audio/wav')
check('a downloaded model is used right after picking it', (await Bun.file(join(sandbox, 'args')).text()).includes('ggml-fake-turbo.bin'))
check('and the last run says so', (await voice.resolveVoice()).lastRun?.model === 'ggml-fake-turbo.bin')

let refusedDelete = false
try {
  voice.deleteWhisperModel('/etc/hosts')
} catch {
  refusedDelete = true
}
check('deleting a path that is not a listed model is refused', refusedDelete)
voice.deleteWhisperModel(fetched!.path!)
const afterDelete = await voice.resolveVoice(true)
check('a deleted model is gone from disk', !(await Bun.file(fetched!.path!).exists()))
check('and dictation falls back to what is left', afterDelete.ready && afterDelete.model?.endsWith('ggml-small.bin') === true, afterDelete.model)
fakeHub.stop(true)

if (failures.length) {
  console.error(`\ndictation-test: ${failures.length} failure(s)`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log(`\ndictation-test: PASSED (${passed} checks)`)

