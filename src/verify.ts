/**
 * The verification pass of a delegated thought.
 *
 * A child that reasons over a corpus can derive a conclusion its sources do
 * not support — a retrieved fact and a guessed consequence look identical from
 * the outside. The verifier is a separate child with a clean context and an
 * adversarial role: it is handed the conclusion and asked to refute it, and
 * what it reports back is a list of specific unsupported claims.
 *
 * The verifier is a `spawn` child, so it shares the thinking child's model and
 * inherits none of its reasoning.
 *
 * @module @local/dsh-delegation-policy/verify
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { releaseChildBudget, type ChildBudget } from './guard.js'
import { projectVerdict, type VerdictProjection } from './project.js'

/** Provider that runs the verifier. */
export const DEFAULT_VERIFY_PROVIDER = 'spawn'

/**
 * Default number of verification passes a delegated thought may run.
 *
 * One pass is the typical cost: one thinking child and one verifying child. A
 * second pass happens only when the first found a conflict, and it adds the
 * refinement of the conclusion plus one more verification.
 */
export const DEFAULT_VERIFY_ROUNDS = 2

/** Default budget for one verification pass, in milliseconds. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 600_000

/** Tools the verifier may use. */
export const VERIFIER_TOOLS: readonly string[] = ['web_search', 'web_fetch']

/**
 * The structured result the verifier delivers. The child calls the runtime's
 * `structured_output` tool with this schema; the driver validates the value
 * and hands it back as the run's structured result.
 */
export const VERIFIER_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'problems', 'evidence'],
  properties: {
    verdict: {
      type: 'string',
      enum: ['confirmed', 'conflict'],
      description: 'conflict when any part of the conclusion is unsupported or contradicted.',
    },
    problems: {
      type: 'array',
      description: 'One entry per unsupported or contradicted part of the conclusion.',
      items: { type: 'string' },
    },
    evidence: {
      type: 'array',
      description: 'The sources the verifier actually used.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['url'],
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          snippet: { type: 'string' },
        },
      },
    },
  },
}

/** Verification configuration. */
export interface VerifyConfig {
  provider: string
  timeoutMs: number
}

/**
 * Build the verifier's instruction.
 *
 * The verifier is told to refute rather than to agree, and it is told which
 * claims to attack: the derived ones. A retrieved fact and a guessed
 * consequence read alike from the outside, so the derived part is where the
 * hallucination lives.
 *
 * @param conclusion - the conclusion under review.
 * @param keyPoints - the points that carry the conclusion.
 * @param task - the question the conclusion answers.
 * @param maxCalls - the retrieval calls the verifier has.
 * @returns the verifier's instruction.
 */
export function buildVerifierPrompt(
  conclusion: string,
  keyPoints: readonly string[],
  task: string,
  maxCalls: number,
): string {
  return [
    'You are an adversarial reviewer. Your job is to REFUTE the conclusion below, not to agree with it. '
    + 'A conclusion that survives your review is a conclusion someone can rely on; a conclusion you let '
    + 'through because it sounded right is worse than no conclusion at all.',
    '',
    'The question it answers:',
    task,
    '',
    'The conclusion under review:',
    conclusion,
    '',
    ...keyPoints.length > 0
      ? ['The points that carry it:', ...keyPoints.map((point) => `- ${point}`), '']
      : [],
    'Search the web and check every part of the conclusion that is DERIVED rather than retrieved. '
    + 'A claim like "X is a Y" is safe only if a source says so. If the sources say "X looks like Y" or '
    + '"X is shaped like Y", the rest of the sentence is a guess, and a guess is a problem.',
    'Search for the real use and the real purpose of the subject, not for a phrase that happens to '
    + 'contain its words. If something is called "corn-shaped", searching "what is this for" finds what '
    + 'it actually is, while searching "corn and this" only finds corn.',
    `You have a reading budget of ${maxCalls} retrieval calls. Spend them on the specific claims you are `
    + 'checking, not on the subject in general.',
    'Then deliver your result with the structured_output tool:',
    '- verdict: "conflict" when any part of the conclusion is unsupported or contradicted; "confirmed" '
    + 'only when the sources support the whole of it.',
    '- problems: one entry per unsupported or contradicted part. Quote the exact sentence from the '
    + 'conclusion and state what the sources actually say instead. Empty when there is no problem.',
    '- evidence: the two to five sources you actually used.',
    'Do not soften a problem into a suggestion. A part you cannot source is a problem, even when you '
    + 'believe it is probably right.',
  ].join('\n')
}

/**
 * Build the instruction that asks for a corrected conclusion.
 *
 * @param task - the question being answered.
 * @param conclusion - the conclusion under challenge.
 * @param problems - the verifier's objections.
 * @param evidence - the sources the verifier used.
 * @returns the refinement instruction.
 */
export function buildRefinePrompt(
  task: string,
  conclusion: string,
  problems: readonly string[],
  evidence: readonly { url: string, title?: string, snippet?: string }[],
): string {
  const lines: string[] = [
    'A reviewer checked the conclusion below against its sources and found parts it cannot support. '
    + 'Produce a corrected conclusion.',
    '',
    'The question being answered:',
    task,
    '',
    'The conclusion under challenge:',
    conclusion,
    '',
    'Problems the reviewer raised:',
    ...problems.map((problem) => `- ${problem}`),
    '',
    'What the sources actually say:',
    ...evidence.map((item) => `- [${item.title ?? item.url}](${item.url})${item.snippet === undefined ? '' : ` — ${item.snippet}`}`),
    '',
    'Address every problem. Remove or downgrade each part the sources do not support: a claim that '
    + 'cannot be sourced must not survive as an assertion, and a guess must be marked as a guess. Keep '
    + 'the parts the sources do support, and keep the structure you were asked for: conclusion, key '
    + 'points, assumptions, risks.',
    'Then deliver your result with the structured_output tool.',
  ]
  return lines.join('\n')
}

/**
 * Run one verification pass.
 *
 * @param ctx - the plugin context supplying the registries.
 * @param config - the resolved verification configuration.
 * @param budget - the budget that covers this route's children.
 * @param parent - the agent the verification runs on behalf of.
 * @param signal - the caller's signal.
 * @param conclusion - the conclusion under review.
 * @param keyPoints - the points that carry the conclusion.
 * @param task - the question the conclusion answers.
 * @param maxCalls - the retrieval calls the verifier has.
 * @returns the verdict.
 */
export async function runVerifier(
  ctx: Context,
  config: VerifyConfig,
  budget: ChildBudget,
  parent: NonNullable<Parameters<typeof ctx.subagents.start>[1]>['parent'],
  signal: AbortSignal,
  conclusion: string,
  keyPoints: readonly string[],
  task: string,
  maxCalls: number,
): Promise<VerdictProjection> {
  const run = await ctx.subagents.start(config.provider, {
    parent,
    prompt: [{
      type: 'text',
      text: buildVerifierPrompt(conclusion, keyPoints, task, maxCalls),
    }] as ContentBlock[],
    signal,
    outputSchema: VERIFIER_OUTPUT_SCHEMA,
    toolFilter: { allow: [...VERIFIER_TOOLS] },
  })
  budget.sessions.add(run.id)
  try {
    const result = await run.result
    return projectVerdict(result)
  } finally {
    releaseChildBudget(budget, run.id)
    await run.dispose()
  }
}
