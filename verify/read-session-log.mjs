/**
 * Decompress every frame of a DSH session log and search the whole thing.
 *
 * A session log is a concatenation of independently written zstd frames, so a
 * whole-buffer decompress only yields the first one. This walks the file,
 * finds every frame boundary, and decodes each frame on its own.
 *
 * Usage: node read-session-log.mjs <path-to.log.zstd> [grep-pattern]
 */

import { readFile } from 'node:fs/promises'
import zlib from 'node:zlib'

const path = process.argv[2]
const pattern = process.argv[3]
const data = await readFile(path)

/** Zstd frame magic. */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
/** Skippable-frame magic range: 0x184D2A50..0x184D2A5F. */
const SKIPPABLE_BASE = 0x184d2a50

/**
 * Locate the frame boundaries in the file.
 *
 * @param bytes - the whole file.
 * @returns the offsets of every frame's magic number.
 */
function findFrameOffsets(bytes) {
  const offsets = []
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] === ZSTD_MAGIC[0] && bytes[i + 1] === ZSTD_MAGIC[1]
      && bytes[i + 2] === ZSTD_MAGIC[2] && bytes[i + 3] === ZSTD_MAGIC[3]) {
      offsets.push(i)
    }
  }
  return offsets
}

const offsets = findFrameOffsets(data)
console.log(`file: ${path}`)
console.log(`size: ${data.length}, zstd frames found: ${offsets.length}`)
console.log(`frame offsets: ${offsets.slice(0, 30).join(', ')}${offsets.length > 30 ? ' ...' : ''}`)

/**
 * Decode one frame, given the bytes from its magic to the next one.
 *
 * @param bytes - the file.
 * @param start - the frame's magic offset.
 * @param end - the next frame's magic offset, or the end of file.
 * @returns the decompressed text, or null when the frame does not decode.
 */
function decodeFrame(bytes, start, end) {
  const slice = bytes.subarray(start, end)
  try {
    return zlib.zstdDecompressSync(slice).toString('utf8')
  } catch {
    return null
  }
}

const parts = []
let decoded = 0
let failed = 0
for (let i = 0; i < offsets.length; i++) {
  const start = offsets[i]
  const end = i + 1 < offsets.length ? offsets[i + 1] : data.length
  const text = decodeFrame(data, start, end)
  if (text === null) {
    failed++
    continue
  }
  decoded++
  parts.push(text)
}

const whole = parts.join('')
console.log(`frames decoded: ${decoded}, failed: ${failed}, total text: ${whole.length} chars`)

if (pattern !== undefined) {
  const re = new RegExp(pattern, 'u')
  const lines = whole.split('\n').filter((line) => re.test(line))
  console.log(`\n=== ${lines.length} lines matching /${pattern}/ ===`)
  for (const line of lines.slice(0, 30)) console.log(`  ${line.slice(0, 700)}`)
} else {
  console.log('\n=== first 1500 chars ===')
  console.log(whole.slice(0, 1500))
}
