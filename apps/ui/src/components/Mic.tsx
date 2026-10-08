import { useEffect, useRef, useState } from 'react'
import type { VoiceStatus } from '@shared'
import { wavBlob } from '../audio.ts'
import { DICTATION_CUE_MS, dictationCue } from '../chime.ts'
import { apiHttp, notify } from '../store.ts'
import { IconMic, IconSpinner } from './Icons.tsx'

type Phase = 'idle' | 'recording' | 'working'

/**
 * Dictation with the machine's own speech model.
 *
 * The audio never leaves the computer: Web Audio makes 16 kHz mono PCM, the
 * server hands that WAV to an on-device model and returns text. There is no
 * speech server and no ffmpeg step in the normal path. Recording ends when you
 * click it again, or at the cap below — it
 * used to stop after ~1.4s of quiet, which ended the recording the moment you
 * paused to think.
 */
const MAX_SECONDS = 120

interface PcmRecording {
  context: AudioContext
  source: MediaStreamAudioSourceNode
  processor: ScriptProcessorNode
  sink: GainNode
  chunks: Float32Array[]
}

export function MicButton({
  voice,
  onText,
  disabled,
}: {
  voice?: VoiceStatus | null
  onText: (text: string) => void
  disabled?: boolean
}) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [seconds, setSeconds] = useState(0)
  const recorder = useRef<PcmRecording | null>(null)
  const stream = useRef<MediaStream | null>(null)
  const startedAt = useRef(0)
  const elapsedTimer = useRef<number | null>(null)

  const ready = voice?.ready ?? false

  const cleanup = () => {
    if (elapsedTimer.current) clearInterval(elapsedTimer.current)
    elapsedTimer.current = null
    if (recorder.current) {
      recorder.current.processor.disconnect()
      recorder.current.source.disconnect()
      recorder.current.sink.disconnect()
      void recorder.current.context.close().catch(() => undefined)
      recorder.current = null
    }
    stream.current?.getTracks().forEach((track) => track.stop())
    stream.current = null
    setPhase('idle')
    setSeconds(0)
  }

  useEffect(() => cleanup, [])

  const finish = async (): Promise<void> => {
    const recording = recorder.current
    if (!recording) return
    recorder.current = null
    recording.processor.disconnect()
    recording.source.disconnect()
    recording.sink.disconnect()
    // Capture is already disconnected, so the cue cannot end up in the clip.
    dictationCue('stop')
    await recording.context.close().catch(() => undefined)
    const blob = wavBlob(recording.chunks, recording.context.sampleRate)
    cleanup()
    if (blob.size < 2048) return
    setPhase('working')
    try {
      const res = await fetch(apiHttp('/api/transcribe'), {
        method: 'POST',
        headers: { 'content-type': blob.type || 'audio/webm' },
        body: blob,
      })
      const data = (await res.json()) as { text?: string; error?: string }
      if (!res.ok || data.error) throw new Error(data.error ?? `transcription failed (${res.status})`)
      const text = (data.text ?? '').trim()
      if (text) onText(text)
      else notify('info', 'Nothing was recognised in that recording')
    } catch (err) {
      notify('error', err instanceof Error ? err.message : String(err))
    } finally {
      setPhase('idle')
    }
  }


  const start = async (): Promise<void> => {
    if (!ready) {
      notify('error', voice?.detail ? `Dictation unavailable — ${voice.detail}` : 'Dictation unavailable')
      return
    }
    // WKWebView exposes no `mediaDevices` at all until the bundle declares
    // NSMicrophoneUsageDescription, so say what is actually wrong instead of
    // surfacing "undefined is not an object".
    if (!navigator.mediaDevices?.getUserMedia) {
      notify(
        'error',
        'No microphone in this webview — allow sedano in System Settings › Privacy & Security › Microphone, then reopen the app.',
      )
      return
    }
    // Played from the click itself (the gesture that lets audio start), and kept
    // out of the recording: audio that arrives before the cue has finished is
    // dropped, so the blip is never transcribed as speech.
    const captureFrom = dictationCue('start') ? Date.now() + DICTATION_CUE_MS : 0
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.current = media
      const context = new AudioContext()
      // A user click created it, so WebKit is allowed to resume immediately;
      // doing it explicitly avoids a recording that stays silently suspended.
      await context.resume()
      const source = context.createMediaStreamSource(media)
      const processor = context.createScriptProcessor(4096, 1, 1)
      const sink = context.createGain()
      const chunks: Float32Array[] = []
      sink.gain.value = 0
      processor.onaudioprocess = (event) => {
        // A buffer arrives once it is full, so it began one buffer-length ago.
        const began = Date.now() - event.inputBuffer.duration * 1000
        if (began < captureFrom) return
        chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
      }
      source.connect(processor)
      // WebKit only drives ScriptProcessor while it reaches a destination. A
      // zero-gain node keeps that processing graph alive without echoing the mic.
      processor.connect(sink)
      sink.connect(context.destination)
      recorder.current = { context, source, processor, sink, chunks }
      startedAt.current = Date.now()
      setPhase('recording')
      // The same tick shows the seconds and enforces the cap, the only thing that
      // stops a recording by itself. It used to be a per-frame loop, which ran
      // at display rate for the whole recording and paused with the window.
      elapsedTimer.current = window.setInterval(() => {
        const elapsed = Date.now() - startedAt.current
        if (recorder.current && elapsed > MAX_SECONDS * 1000) {
          void finish()
          return
        }
        setSeconds(Math.round(elapsed / 1000))
      }, 250)
    } catch (err) {
      cleanup()
      notify('error', `Microphone unavailable: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const label =
    phase === 'recording'
      ? `Recording ${seconds}s — click to stop`
      : phase === 'working'
        ? 'Transcribing…'
        : ready
          ? `Dictate (${voice?.detail ?? 'Local Model'})`
          : 'Dictation unavailable'

  return (
    <button
      className={`mic${phase === 'recording' ? ' recording' : ''}`}
      title={label}
      disabled={disabled || phase === 'working'}
      onClick={() => (phase === 'recording' ? void finish() : void start())}
    >
      {phase === 'working' ? <IconSpinner className="spin" /> : <IconMic />}
      {phase === 'recording' ? <span className="mic-time">{seconds}s</span> : null}
    </button>
  )
}
