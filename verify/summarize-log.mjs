/**
 * Summarize one DSH session log: the tools the agent was offered, the calls it
 * made, and what its final assistant message contained.
 *
 * Usage: node summarize-log.mjs <path-to.log.zstd>
 */

import { readFile } from 'node:fs/promises'
import zlib from 'node:zlib'

const path = process.argv[2]
const data = await readFile(path)

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const offsets = []
for (let i = 0; i + 4 <= data.length; i++) {
  if (data[i] === ZSTD_MAGIC[0] && data[i + 1] === ZSTD_MAGIC[1]
    && data[i + 2] === ZSTD_MAGIC[2] && data[i + 3] === ZSTD_MAGIC[3]) {
    offsets.push(i)
  }
}

const parts = []
for (let i = 0; i < offsets.length; i++) {
  const start = offsets[i]
  const end = i + 1 < offsets.length ? offsets[i + 1] : data.length
  try {
    parts.push(zlib.zstdDecompressSync(data.subarray(start, end)).toString('utf8'))
  } catch {
    // A frame that does not decode contributes nothing; the rest still does.
  }
}

const events = parts.join('').split('\n').filter((line) => line.trim().length > 0)
  .map((line) => {
    try {
      return JSON.parse(line)
    } catch {
      return null
    }
  }).filter((event) => event !== null)

const header = events.find((event) => event.type === 'request/header')
const toolNames = header?.data?.header?.tools?.map((tool) => tool.name) ?? []
console.log(`=== tools offered to this agent (${toolNames.length}) ===`)
console.log(toolNames.join(', '))
console.log(`\nstructured_output offered: ${toolNames.includes('structured_output')}`)

const calls = events.filter((event) => event.type === 'tool/call')
console.log(`\n=== tool calls made (${calls.length}) ===`)
for (const call of calls) {
  const args = call.data.arguments ?? ''
  console.log(`  seq ${call.seq} step ${call.data.step}  ${call.data.name}  ${args.slice(0, 110)}`)
}

const assistants = events.filter((event) => event.type === 'assistant/message')
const last = assistants.at(-1)
const blocks = last?.data?.message?.content ?? []
console.log(`\n=== final assistant message (seq ${last?.seq}) content blocks ===`)
for (const block of blocks) {
  const text = block.text ?? block.thinking ?? JSON.stringify(block)
  console.log(`  [${block.type}] ${String(text).slice(0, 220).replace(/\n/gu, ' ')}`)
}
console.log(`\ncalled structured_output: ${calls.some((call) => call.data.name === 'structured_output')}`)

const turnEnd = events.find((event) => event.type === 'turn/end')
console.log(`turn/end reason: ${JSON.stringify(turnEnd?.data?.reason)}`)
