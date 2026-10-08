/**
 * A small QR code encoder: byte mode, error correction level M, versions 1–10
 * (up to 213 bytes — a pairing URL is about 60). Enough to show the phone the
 * pairing link without a dependency. Follows ISO/IEC 18004; the structure is the
 * one of Nayuki's reference encoder, reduced to what this needs.
 *
 * Returns the modules as rows of booleans (true = dark), without the quiet zone.
 */

// Level M, per version 1..10: error-correction codewords per block, and blocks.
const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26]
const BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5]
const FORMAT_M = 0

function rawModules(version: number): number {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2
    result -= (25 * align - 10) * align - 55
    if (version >= 7) result -= 36
  }
  return result
}

function dataCapacity(version: number): number {
  return Math.floor(rawModules(version) / 8) - ECC_PER_BLOCK[version - 1]! * BLOCKS[version - 1]!
}

function gfMultiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j]!, root)
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!
    }
    root = gfMultiply(root, 0x02)
  }
  return result
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0)
  for (const byte of data) {
    const factor = byte ^ result.shift()!
    result.push(0)
    divisor.forEach((coefficient, i) => (result[i]! ^= gfMultiply(coefficient, factor)))
  }
  return result
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return []
  const count = Math.floor(version / 7) + 2
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2
  const result = [6]
  for (let pos = version * 4 + 10; result.length < count; pos -= step) result.splice(1, 0, pos)
  return result
}

function bit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0
}

export function encodeQr(text: string): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)]
  let version = 1
  // Mode (4 bits) + count (8 or 16 bits) + the bytes themselves.
  while (version <= 10 && 4 + (version < 10 ? 8 : 16) + bytes.length * 8 > dataCapacity(version) * 8) version++
  if (version > 10) throw new Error('text too long for this QR encoder')

  // Data bits, terminator and padding.
  const bits: number[] = []
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, version < 10 ? 8 : 16)
  for (const byte of bytes) push(byte, 8)
  const capacityBits = dataCapacity(version) * 8
  push(0, Math.min(4, capacityBits - bits.length))
  push(0, (8 - (bits.length % 8)) % 8)
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0))

  // Split into blocks, add error correction, interleave.
  const blockCount = BLOCKS[version - 1]!
  const eccLength = ECC_PER_BLOCK[version - 1]!
  const rawCodewords = Math.floor(rawModules(version) / 8)
  const shortBlocks = blockCount - (rawCodewords % blockCount)
  const shortLength = Math.floor(rawCodewords / blockCount)
  const divisor = rsDivisor(eccLength)
  const blocks: number[][] = []
  for (let i = 0, k = 0; i < blockCount; i++) {
    const chunk = data.slice(k, k + shortLength - eccLength + (i < shortBlocks ? 0 : 1))
    k += chunk.length
    const ecc = rsRemainder(chunk, divisor)
    if (i < shortBlocks) chunk.push(0)
    blocks.push([...chunk, ...ecc])
  }
  const codewords: number[] = []
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLength - eccLength || j >= shortBlocks) codewords.push(block[i]!)
    })
  }

  // Function patterns.
  const size = version * 4 + 17
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false))
  const set = (x: number, y: number, dark: boolean) => {
    modules[y]![x] = dark
    reserved[y]![x] = true
  }
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx
        const y = cy + dy
        const distance = Math.max(Math.abs(dx), Math.abs(dy))
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, distance !== 2 && distance !== 4)
      }
    }
  }
  const align = alignmentPositions(version)
  const last = align.length - 1
  align.forEach((ax, i) =>
    align.forEach((ay, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
    }),
  )
  const drawFormat = (mask: number) => {
    const value = (FORMAT_M << 3) | mask
    let rem = value
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const format = ((value << 10) | rem) ^ 0x5412
    for (let i = 0; i <= 5; i++) set(8, i, bit(format, i))
    set(8, 7, bit(format, 6))
    set(8, 8, bit(format, 7))
    set(7, 8, bit(format, 8))
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(format, i))
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(format, i))
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(format, i))
    set(8, size - 8, true)
  }
  drawFormat(0)
  if (version >= 7) {
    let rem = version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const info = (version << 12) | rem
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      set(a, b, bit(info, i))
      set(b, a, bit(info, i))
    }
  }

  // Data, in the zigzag order.
  let index = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5
    for (let vertical = 0; vertical < size; vertical++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vertical : vertical
        if (!reserved[y]![x] && index < codewords.length * 8) {
          modules[y]![x] = bit(codewords[index >>> 3]!, 7 - (index & 7))
          index++
        }
      }
    }
  }

  // Masks: try all eight and keep the one with the lowest penalty.
  const masked = (mask: number, x: number, y: number): boolean => {
    switch (mask) {
      case 0: return (x + y) % 2 === 0
      case 1: return y % 2 === 0
      case 2: return x % 3 === 0
      case 3: return (x + y) % 3 === 0
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
    }
  }
  const applyMask = (mask: number) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) if (!reserved[y]![x] && masked(mask, x, y)) modules[y]![x] = !modules[y]![x]
    }
  }
  let best = 0
  let bestPenalty = Infinity
  for (let mask = 0; mask < 8; mask++) {
    applyMask(mask)
    drawFormat(mask)
    const score = penalty(modules)
    if (score < bestPenalty) {
      best = mask
      bestPenalty = score
    }
    applyMask(mask)
  }
  applyMask(best)
  drawFormat(best)
  return modules
}

/** Runs, 2×2 blocks and dark/light balance (rules 1, 2 and 4 of the standard). */
function penalty(modules: boolean[][]): number {
  const size = modules.length
  let score = 0
  let dark = 0
  for (let a = 0; a < size; a++) {
    let rowRun = 1
    let colRun = 1
    for (let b = 0; b < size; b++) {
      if (modules[a]![b]) dark++
      if (b > 0) {
        rowRun = modules[a]![b] === modules[a]![b - 1] ? rowRun + 1 : 1
        colRun = modules[b]![a] === modules[b - 1]![a] ? colRun + 1 : 1
        if (rowRun === 5) score += 3
        else if (rowRun > 5) score += 1
        if (colRun === 5) score += 3
        else if (colRun > 5) score += 1
      }
      if (a > 0 && b > 0) {
        const c = modules[a]![b]
        if (c === modules[a - 1]![b] && c === modules[a]![b - 1] && c === modules[a - 1]![b - 1]) score += 3
      }
    }
  }
  const total = size * size
  score += Math.ceil(Math.abs(dark * 20 - total * 10) / total - 1) * 10
  return score
}

/** One SVG path for all dark modules, with a 4-module quiet zone around them. */
export function qrSvgPath(modules: boolean[][]): { path: string; size: number } {
  let path = ''
  modules.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x + 4} ${y + 4}h1v1h-1z`
    }),
  )
  return { path, size: modules.length + 8 }
}
