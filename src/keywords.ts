/**
 * The keyword extractor: what a conclusion needs looked up.
 *
 * A delegated thought produces a conclusion, and some of it does not rest on
 * anything the conversation established. This module asks a separate child,
 * running on a model chosen for the job rather than for the reasoning, which
 * parts of the conclusion would have to be checked against the outside world.
 *
 * The answer is a short list of search terms. It is deliberately small: the
 * list drives a retrieval budget, and a long list turns one targeted search
 * into a survey of the subject.
 *
 * @module @local/dsh-delegation-policy/keywords
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { WatchedTranscript } from './watch.js'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { registerChild, releaseChildBudget, type ChildBudget } from './guard.js'
import { readStringList } from './project.js'

/** Provider that runs the extractor. */
export const DEFAULT_KEYWORD_AGENT_PROVIDER = 'spawn'

/** How many search terms the extractor may return. */
export const DEFAULT_KEYWORD_COUNT = 3

/**
 * Default retrieval calls the grounding pass may make.
 *
 * The pass looks up a handful of named terms, so it needs fewer calls than a
 * survey of the subject.
 */
export const DEFAULT_KEYWORD_SEARCH_CALLS = 3

/**
 * The structured result the extractor delivers.
 *
 * The child calls the runtime's `structured_output` tool with this schema; the
 * driver validates the value and hands it back as the run's structured result.
 */
export const KEYWORD_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['keywords', 'rationale'],
  properties: {
    keywords: {
      type: 'array',
      description: 'The search terms, most important first. Empty when the conclusion needs no lookup.',
      items: { type: 'string' },
    },
    rationale: {
      type: 'string',
      description: 'One sentence: which part of the conclusion each term is for.',
    },
    alreadySearched: {
      type: 'array',
      description: 'What the delegated child already looked up on its own, as short phrases. Empty when '
        + 'it looked nothing up. The pipeline uses this to keep the next round from searching the same '
        + 'thing twice.',
      items: { type: 'string' },
    },
  },
}

/** Extractor configuration. */
export interface KeywordConfig {
  /** The subagent provider that runs the extractor. */
  agentProvider: string
  /** The model provider the extractor runs on; inherited when unset. */
  modelProvider?: string
  /** The model the extractor runs on; inherited when unset. */
  model?: string
  /** How many search terms the extractor may return. */
  maxKeywords: number
  /** How many retrieval calls the extractor may make. */
  maxChildCalls: number
}

/**
 * Build the extractor's instruction.
 *
 * The extractor is the monitor of the delegated child's own work: it reads the
 * reasoning and the answer the child wrote, and names the terms that would
 * have to be looked up before anyone could rely on them. It is asked about the
 * text in front of it, and about nothing else.
 *
 * @param transcript - what the delegated child wrote: its reasoning and its answer.
 * @param maxKeywords - how many search terms may be returned.
 * @returns the extractor's instruction.
 */
export function buildKeywordPrompt(
  transcript: WatchedTranscript,
  maxKeywords: number,
): string {
  return [
    'Below is the reasoning and the answer of a delegated child. Your job is to name the terms that '
    + 'would have to be looked up before anyone could rely on that answer.',
    '',
    'The child\'s reasoning:',
    transcript.reasoning.trim() === '' ? '(it wrote none)' : transcript.reasoning.trim(),
    '',
    'The child\'s answer:',
    transcript.content.trim() === '' ? '(it wrote none)' : transcript.content.trim(),
    '',
    `Return at most ${maxKeywords} search terms, each one a phrase someone could type into a search `
    + 'engine to check one specific part of the answer. A term names the thing to look up ("TS 4.9 '
    + 'release date"), never the claim itself ("TypeScript 4.9 was released in November 2022").',
    'Look for the parts that are derived rather than settled: a version, a date, a number, a standard, '
    + 'a product behaviour, a claim about what something is used for. An answer that rests only on '
    + 'reasoning needs no lookup.',
    'Return fewer terms than the maximum when fewer are needed, and return none when the answer '
    + 'needs no external check at all.',
    'Also report what the child already looked up on its own, if anything: it may have used a '
    + 'retrieval tool while it reasoned. Name those lookups as short phrases in `alreadySearched`, '
    + 'so the next round does not search the same thing again.',
    'Then deliver your result with the structured_output tool:',
    '- keywords: the search terms, most important first.',
    '- rationale: one sentence saying which part of the answer each term is for.',
    '- alreadySearched: what the child already looked up, as short phrases.',
  ].join('\n')
}

/**
 * Build the brief for the retrieval pass that runs on the extracted terms.
 *
 * @param keywords - the terms the extractor returned.
 * @param maxCalls - the retrieval calls the child has.
 * @returns the child's instruction.
 */
export function buildKeywordSearchPrompt(
  keywords: readonly string[],
  maxCalls: number,
): string {
  return [
    'Look up the following terms and report what the sources actually say about each one.',
    '',
    'The terms:',
    ...keywords.map((keyword) => `- ${keyword}`),
    '',
    `You have a reading budget of ${maxCalls} retrieval calls. Spend them on these terms, not on the `
    + 'subject in general.',
    'Report for each term what the sources say, and say plainly when they do not settle it. "No source '
    + 'covers this" is a valid and useful answer: a term that nothing covers has to be reported as '
    + 'unresolved rather than filled in with an inference.',
    'Then deliver your result with the structured_output tool.',
  ].join('\n')
}

/** What the extractor found. */
export interface KeywordProjection {
  /** The search terms. */
  keywords: string[]
  /** Why they were chosen. */
  rationale: string
  /** What the delegated child had already looked up on its own. */
  alreadySearched: string[]
}

/**
 * Project the extractor's structured result.
 *
 * @param value - the structured result.
 * @param maxKeywords - how many terms are kept.
 * @returns the projected terms.
 */
export function projectKeywords(value: unknown, maxKeywords: number): KeywordProjection {
  const record = (value ?? {}) as Record<string, unknown>
  const keywords = readStringList(value, 'keywords')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, maxKeywords)
  const rationale = typeof record.rationale === 'string' ? record.rationale : ''
  const alreadySearched = readStringList(value, 'alreadySearched')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return { keywords, rationale, alreadySearched }
}

/**
 * Drop the terms that have already been looked up.
 *
 * The delegated child may have done its own retrieval while it reasoned, and
 * the pipeline does its own. Searching the same point twice costs a whole
 * round and buys nothing, so a term that the child already covered is not
 * searched again.
 *
 * The comparison is on the words, not on the strings: two phrasings of the
 * same lookup share most of their words, and the ones that do not are two
 * different lookups. A term that shares half its words with something
 * already searched is treated as the same lookup.
 *
 * @param keywords - the terms the extractor named.
 * @param alreadySearched - what has been looked up already.
 * @returns the terms that are still worth searching.
 */
export function dropAlreadySearched(
  keywords: readonly string[],
  alreadySearched: readonly string[],
): string[] {
  if (alreadySearched.length === 0) return [...keywords]
  const words = (text: string): Set<string> => new Set(
    text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 1),
  )
  const seen = alreadySearched.map((item) => words(item))
  return keywords.filter((keyword) => {
    const own = words(keyword)
    if (own.size === 0) return true
    for (const other of seen) {
      let shared = 0
      for (const word of own) if (other.has(word)) shared += 1
      if (shared * 2 >= own.size) return false
    }
    return true
  })
}

/**
 * Run the extractor and return the search terms it found.
 *
 * @param ctx - the plugin context supplying the registries.
 * @param config - the resolved extractor configuration.
 * @param budget - the budget that covers this route's children.
 * @param parent - the agent the extraction runs on behalf of.
 * @param signal - the caller's signal.
 * @param transcript - what the delegated child wrote: its reasoning and its answer.
 * @returns the search terms.
 */
export async function runKeywordExtractor(
  ctx: Context,
  config: KeywordConfig,
  budget: ChildBudget,
  parent: Agent,
  signal: AbortSignal,
  transcript: WatchedTranscript,
): Promise<KeywordProjection> {
  const agentOptions = config.model === undefined && config.modelProvider === undefined
    ? undefined
    : {
      ...config.modelProvider === undefined ? {} : { provider: config.modelProvider },
      ...config.model === undefined ? {} : { model: config.model },
    }
  const run = await ctx.subagents.start(config.agentProvider, {
    parent,
    prompt: [{
      type: 'text',
      text: buildKeywordPrompt(transcript, config.maxKeywords),
    }] as ContentBlock[],
    signal,
    outputSchema: KEYWORD_OUTPUT_SCHEMA,
    ...agentOptions === undefined ? {} : { agentOptions },
  })
  registerChild(budget, run.id, config.maxChildCalls)
  try {
    const result = await run.result
    return projectKeywords(result.structured, config.maxKeywords)
  } finally {
    releaseChildBudget(budget, run.id)
    await run.dispose()
  }
}
