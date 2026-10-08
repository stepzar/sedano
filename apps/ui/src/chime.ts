import { getState } from './store.ts'

/**
 * A soft chime when an agent finishes a turn.
 *
 * Synthesised rather than shipped as a file: two quiet notes on a sine wave with
 * a long release is all a "done" sounds like, and it keeps the app free of an
 * asset nobody can edit. The context is created on the first gesture because
 * browsers refuse to make a sound before one — the app gets plenty of clicks, so
 * by the time a turn ends the first note is allowed.
 */
let ctx: AudioContext | null = null
let armed = false
let restTimer: ReturnType<typeof setTimeout> | null = null
let restAt = 0

function context(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  if (!ctx) {
    try {
      ctx = new Ctor()
    } catch {
      // No audio output at all (a headless browser, a machine without a
      // device): the chime is a nicety, so it simply stays silent.
      return null
    }
  }
  return ctx
}

/**
 * Let the audio device go between chimes.
 *
 * A running context holds the output device open and keeps the audio thread
 * rendering silence for as long as the window lives — hours of work for two
 * notes. Once a gesture has unlocked it, `resume()` works without another one
 * (checked in Chromium and WebKit), so it is only running while it sounds.
 */
function rest(audio: AudioContext, afterMs: number): void {
  // Never cut a longer sound short: a quick cue during the done chime waits for it.
  const at = Date.now() + afterMs
  if (restTimer && at < restAt) return
  if (restTimer) clearTimeout(restTimer)
  restAt = at
  restTimer = setTimeout(() => {
    restTimer = null
    if (audio.state === 'running') void audio.suspend().catch(() => undefined)
  }, afterMs)
}

/** Called once, from the first thing the person does. */
export function armChime(): void {
  if (armed) return
  armed = true
  const unlock = () => {
    if (!getState().settings.chimeOnDone) return
    const audio = context()
    if (!audio) return
    audio.resume().then(() => rest(audio, 0), () => undefined)
  }
  window.addEventListener('pointerdown', unlock, { once: true })
  window.addEventListener('keydown', unlock, { once: true })
}

/** One quiet, two-note fall: nothing to look up, nothing to do about it. */
export function chime(): void {
  if (!getState().settings.chimeOnDone) return
  const audio = ctx
  // Never unlocked by a gesture, or the device is gone: stay quiet.
  if (!audio || audio.state === 'closed') return
  audio.resume().then(() => play(audio), () => undefined)
}

function play(audio: AudioContext): void {
  try {
    const now = audio.currentTime
    const master = audio.createGain()
    master.gain.setValueAtTime(0, now)
    master.gain.linearRampToValueAtTime(0.07, now + 0.02)
    master.gain.exponentialRampToValueAtTime(0.0001, now + 0.9)
    master.connect(audio.destination)
    for (const [index, frequency] of [587.33, 880].entries()) {
      const note = audio.createOscillator()
      note.type = 'sine'
      note.frequency.value = frequency
      const level = audio.createGain()
      const at = now + index * 0.12
      level.gain.setValueAtTime(0, at)
      level.gain.linearRampToValueAtTime(index === 0 ? 1 : 0.7, at + 0.03)
      level.gain.exponentialRampToValueAtTime(0.0001, at + 0.75)
      note.connect(level)
      level.connect(master)
      note.start(at)
      note.stop(at + 0.8)
    }
  } catch {
    /* a device that vanished mid-session: silence, not an error */
  }
  // The last note ends at 0.92s; a little margin before the device is let go.
  rest(audio, 1_500)
}

/** Two short notes per cue: rising for "listening", falling for "done". */
const DICTATION_NOTES = {
  start: [659.25, 987.77],
  stop: [987.77, 659.25],
} as const
const NOTE_GAP = 0.07
const NOTE_LENGTH = 0.09
/** How long a dictation cue sounds, in ms: the mic ignores audio until then. */
export const DICTATION_CUE_MS = Math.round((NOTE_GAP + NOTE_LENGTH) * 1000) + 20

/**
 * The dictation start/stop cue. Call it from the click itself: that gesture is
 * what lets the context start, even before the chime was ever unlocked.
 * Returns false when it stayed silent (turned off, or no audio device).
 */
export function dictationCue(kind: 'start' | 'stop'): boolean {
  if (getState().settings.dictationSounds === false) return false
  const audio = context()
  if (!audio || audio.state === 'closed') return false
  audio.resume().then(() => playCue(audio, DICTATION_NOTES[kind]), () => undefined)
  return true
}

function playCue(audio: AudioContext, notes: readonly number[]): void {
  try {
    const now = audio.currentTime
    for (const [index, frequency] of notes.entries()) {
      const note = audio.createOscillator()
      note.type = 'sine'
      note.frequency.value = frequency
      const level = audio.createGain()
      const at = now + index * NOTE_GAP
      // A fast attack and a short exponential tail: a soft "blip", not a beep.
      level.gain.setValueAtTime(0, at)
      level.gain.linearRampToValueAtTime(0.06, at + 0.008)
      level.gain.exponentialRampToValueAtTime(0.0001, at + NOTE_LENGTH)
      note.connect(level)
      level.connect(audio.destination)
      note.start(at)
      note.stop(at + NOTE_LENGTH + 0.01)
    }
  } catch {
    /* a device that vanished mid-session: silence, not an error */
  }
  rest(audio, 600)
}
