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
    'Then deliver your result with the structured_output tool:',
    '- keywords: the search terms, most important first.',
    '- rationale: one sentence saying which part of the answer each term is for.',
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
  return { keywords, rationale }
}

/**
 * Run the extractor and return the search terms it found.
 *
 * The extractor reads the delegated child's transcript and names what to look
 * up. It is not a reader itself: the web guard refuses it every page-fetching
 * tool, so it carries no reading budget.
 *
 * @param ctx - the plugin context supplying the registries.
 * @param config - the resolved extractor configuration.
 * @param parent - the agent the extraction runs on behalf of.
 * @param signal - the caller's signal.
 * @param transcript - what the delegated child wrote: its reasoning and its answer.
 * @returns the search terms.
 */
export async function runKeywordExtractor(
  ctx: Context,
  config: KeywordConfig,
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
  try {
    const result = await run.result
    return projectKeywords(result.structured, config.maxKeywords)
  } finally {
    await run.dispose()
  }
}
