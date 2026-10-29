/**
 * Watching a delegated child as it writes.
 *
 * A child that runs in this process publishes its stream on its own scope, so
 * what it reasons and what it answers can be watched as they are written rather
 * than only recovered from its structured result. The watcher hands that
 * transcript to the extractor, which is the child that turns it into search
 * terms; the parent receives the knowledge those terms bring back, not the
 * child's deliberation.
 *
 * The watch is bounded. A child that writes a long deliberation would
 * otherwise fill the extractor's prompt with material nobody asked for, so the
 * transcript is cut at a limit and says so.
 *
 * @module @local/dsh-delegation-policy/watch
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

/** What a watched child writes, kept apart by kind. */
export interface WatchedTranscript {
  /** The child's reasoning. */
  reasoning: string
  /** The child's answer. */
  content: string
}

/** The watcher of one child. */
export interface ChildWatcher {
  /** What the child wrote so far. */
  transcript: () => WatchedTranscript
  /** Stop watching. */
  stop: () => void
}

/**
 * How much of a child's transcript the extractor is given.
 *
 * The extractor's prompt is a working context, not a transcript: a child that
 * wrote a long deliberation would otherwise crowd out the question the
 * extractor is answering.
 */
export const DEFAULT_WATCH_MAX_CHARS = 8000

/**
 * Cut a transcript to a limit, saying so when it is cut.
 *
 * @param transcript - what the child wrote.
 * @param maxChars - the limit on the whole text.
 * @returns the trimmed transcript.
 */
export function trimTranscript(transcript: WatchedTranscript, maxChars: number): WatchedTranscript {
  const total = transcript.reasoning.length + transcript.content.length
  if (total <= maxChars) return transcript
  const reasoning = transcript.reasoning.slice(0, Math.floor(maxChars * 0.6))
  const content = transcript.content.slice(0, Math.floor(maxChars * 0.4))
  return {
    reasoning: `${reasoning}\n[cut here]`,
    content: `${content}\n[cut here]`,
  }
}

/**
 * Watch one child's stream.
 *
 * A child that runs out of process has no stream to watch, and the watcher
 * then watches nothing: the extractor is given nothing, which is the same
 * position it was in before the watch existed.
 *
 * @param child - the published child, when it runs in this process.
 * @returns the watcher.
 */
export function watchChildStream(child: Agent | undefined): ChildWatcher {
  const transcript: WatchedTranscript = { reasoning: '', content: '' }
  if (child === undefined) {
    return {
      transcript: () => transcript,
      stop: () => {},
    }
  }
  const off = child.ctx.on('agent/assistant-stream', (payload) => {
    const frame = payload.frame
    if (frame.type !== 'chunk') return
    const chunk = frame.chunk
    if (chunk.type === 'reasoning-delta') transcript.reasoning += chunk.text
    else if (chunk.type === 'text-delta') transcript.content += chunk.text
  })
  return {
    transcript: () => transcript,
    stop: () => { off() },
  }
}
