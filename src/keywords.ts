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
 * The extractor is given the conclusion and the points that carry it, and
 * nothing else: it is asked which parts of a finished answer would have to be
 * checked against an outside source, which is a question about the text in
 * front of it.
 *
 * @param conclusion - the conclusion to examine.
 * @param keyPoints - the points that carry the conclusion.
 * @param maxKeywords - how many search terms may be returned.
 * @returns the extractor's instruction.
 */
export function buildKeywordPrompt(
  conclusion: string,
  keyPoints: readonly string[],
  maxKeywords: number,
): string {
  return [
    'Below is a conclusion that was reached by reasoning. Your job is to say which parts of it would '
    + 'have to be checked against an outside source before anyone could rely on it.',
    '',
    'The conclusion:',
    conclusion,
    '',
    ...keyPoints.length > 0
      ? ['The points that carry it:', ...keyPoints.map((point) => `- ${point}`), '']
      : [],
    `Return at most ${maxKeywords} search terms, each one a phrase someone could type into a search `
    + 'engine to check one specific part of the conclusion. A term names the thing to look up ("TS 4.9 '
    + 'release date"), never the claim itself ("TypeScript 4.9 was released in November 2022").',
    'Look for the parts that are derived rather than settled: a version, a date, a number, a standard, '
    + 'a product behaviour, a claim about what something is used for. A conclusion that rests only on '
    + 'reasoning needs no lookup.',
    'Return fewer terms than the maximum when fewer are needed, and return none when the conclusion '
    + 'needs no external check at all.',
    'Then deliver your result with the structured_output tool:',
    '- keywords: the search terms, most important first.',
    '- rationale: one sentence saying which part of the conclusion each term is for.',
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
 * @param ctx - the plugin context supplying the registries.
 * @param config - the resolved extractor configuration.
 * @param budget - the budget that covers this route's children.
 * @param parent - the agent the extraction runs on behalf of.
 * @param signal - the caller's signal.
 * @param conclusion - the conclusion to examine.
 * @param keyPoints - the points that carry the conclusion.
 * @returns the search terms.
 */
export async function runKeywordExtractor(
  ctx: Context,
  config: KeywordConfig,
  budget: ChildBudget,
  parent: Agent,
  signal: AbortSignal,
  conclusion: string,
  keyPoints: readonly string[],
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
      text: buildKeywordPrompt(conclusion, keyPoints, config.maxKeywords),
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
