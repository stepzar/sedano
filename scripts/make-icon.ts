#!/usr/bin/env bun
/**
 * Draws the sedano app icon and writes a PNG, with no image library: the mark is
 * one parent node and one child node (a session and its subagent) on an ink
 * plate. Deliberately achromatic — the UI is neutral, so the icon is too.
 *
 *   bun scripts/make-icon.ts [out.png] [size]
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const SIZE = Number(process.argv[3] ?? 1024)
const OUT = process.argv[2] ?? 'apps/desktop/src-tauri/icon-source.png'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // truecolour with alpha
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    Buffer.from(rgba.buffer, y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ---------------- geometry ---------------- */

type Shape = (x: number, y: number) => boolean

const roundedSquare = (size: number, radius: number): Shape => (x, y) => {
  const cx = Math.min(Math.max(x, radius), size - radius)
  const cy = Math.min(Math.max(y, radius), size - radius)
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2
}

const circle = (cx: number, cy: number, r: number): Shape => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r

const capsule = (x1: number, y1: number, x2: number, y2: number, r: number): Shape => (x, y) => {
  const dx = x2 - x1
  const dy = y2 - y1
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
  return (x - (x1 + t * dx)) ** 2 + (y - (y1 + t * dy)) ** 2 <= r * r
}

/** 4x4 supersampled coverage, cheap and good enough at any icon size. */
function coverage(shape: Shape, x: number, y: number): number {
  let hits = 0
  for (let sy = 0; sy < 4; sy++) {
    for (let sx = 0; sx < 4; sx++) {
      if (shape(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) hits++
    }
  }
  return hits / 16
}

function mix(base: number[], top: number[], alpha: number): number[] {
  return [
    base[0]! + (top[0]! - base[0]!) * alpha,
    base[1]! + (top[1]! - base[1]!) * alpha,
    base[2]! + (top[2]! - base[2]!) * alpha,
    base[3]! + (255 - base[3]!) * alpha,
  ]
}

/* ---------------- compose ---------------- */

const S = SIZE / 1024
const INK = [18, 18, 18, 255]
const PARENT = [242, 242, 242, 255]
const LINK = [104, 104, 104, 255]
const CHILD = [150, 150, 150, 255]

const plate = roundedSquare(SIZE, 232 * S)
const link = capsule(512 * S, 452 * S, 690 * S, 660 * S, 27 * S)
const parent = circle(500 * S, 440 * S, 126 * S)
const child = circle(690 * S, 660 * S, 70 * S)

const rgba = new Uint8Array(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let pixel = [0, 0, 0, 0]
    const plateA = coverage(plate, x, y)
    if (plateA > 0) {
      pixel = mix(pixel, INK, plateA)
      const linkA = coverage(link, x, y)
      if (linkA > 0) pixel = mix(pixel, LINK, linkA * 0.85)
      const parentA = coverage(parent, x, y)
      if (parentA > 0) pixel = mix(pixel, PARENT, parentA)
      const childA = coverage(child, x, y)
      if (childA > 0) pixel = mix(pixel, CHILD, childA)
    }
    const offset = (y * SIZE + x) * 4
    rgba[offset] = Math.round(pixel[0]!)
    rgba[offset + 1] = Math.round(pixel[1]!)
    rgba[offset + 2] = Math.round(pixel[2]!)
    rgba[offset + 3] = Math.round(pixel[3]!)
  }
}

writeFileSync(OUT, encodePng(SIZE, SIZE, rgba))
console.log(`wrote ${OUT} (${SIZE}x${SIZE})`)
