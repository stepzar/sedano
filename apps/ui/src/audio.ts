/** Audio helpers for the microphone's local whisper.cpp path. */

const TARGET_RATE = 16_000

/**
 * Downsample mono float PCM without pulling an audio codec into the desktop
 * bundle. Each output sample is the average of its source interval; averaging
 * avoids the harsh aliasing that taking every Nth sample creates for speech.
 */
export function resampleMono(chunks: Float32Array[], inputRate: number, outputRate = TARGET_RATE): Float32Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  if (!length) return new Float32Array()

  const input = new Float32Array(length)
  let at = 0
  for (const chunk of chunks) {
    input.set(chunk, at)
    at += chunk.length
  }
  if (inputRate === outputRate) return input

  const ratio = inputRate / outputRate
  const output = new Float32Array(Math.max(1, Math.floor(input.length / ratio)))
  for (let index = 0; index < output.length; index += 1) {
    const from = Math.floor(index * ratio)
    const to = Math.max(from + 1, Math.min(input.length, Math.floor((index + 1) * ratio)))
    let sum = 0
    for (let source = from; source < to; source += 1) sum += input[source]
    output[index] = sum / (to - from)
  }
  return output
}

/** A standards-compliant mono 16-bit PCM WAV that whisper.cpp reads directly. */
export function wavBlob(chunks: Float32Array[], inputRate: number): Blob {
  const samples = resampleMono(chunks, inputRate)
  const bytes = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(bytes)
  const write = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
  }

  write(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, TARGET_RATE, true)
  view.setUint32(28, TARGET_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, samples.length * 2, true)

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index]))
    view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
  }
  return new Blob([bytes], { type: 'audio/wav' })
}

