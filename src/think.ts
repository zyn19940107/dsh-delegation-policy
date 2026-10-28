/**
 * The `think_deep` route: long reasoning, delegated to a child that inherits
 * this conversation.
 *
 * The fork provider seeds the child with the parent's completed-turn prefix, so
 * the child reasons over everything established here without a relay prompt.
 * Its reasoning stays in the child's session; the parent receives a structured
 * conclusion.
 *
 * @module @local/dsh-delegation-policy/think
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { registerChild, releaseChildBudget, type ChildBudget } from './guard.js'
import { projectThinkResult } from './project.js'
import { delegateSearch, type SearchConfig } from './search.js'
import { buildConflictSearchPrompt, buildRefinePrompt, runVerifier } from './verify.js'

/** Provider that runs the thinking child. */
export const DEFAULT_THINK_PROVIDER = 'fork'

/** Default number of retrieval calls the thinking child may make. */
export const DEFAULT_MAX_THINK_CALLS = 5

/** Default number of retrieval calls the retrieving child may make. */
export const DEFAULT_RETRIEVE_MAX_CHILD_CALLS = 3

/**
 * Default retrieval calls a pass aimed at the contradictions may make.
 *
 * The pass looks up the specific points a reviewer could not support, so it needs
 * far fewer calls than a first pass over the subject.
 */
export const DEFAULT_CONFLICT_SEARCH_CALLS = 2

/**
 * Default budget for one delegated thought. The child inherits the parent's
 * history and reasons over it, so its budget covers a whole extended turn
 * rather than a single call.
 */
export const DEFAULT_THINK_TIMEOUT_MS = 900_000

/**
 * Tools the thinking child must not use. A child that reasons about the work
 * has no business mutating it, and a child that delegates again defeats the
 * point of delegating once.
 *
 * The list is filtered against the live registry before it is applied:
 * `tools.restrict()` rejects an unknown name, and a profile need not mount
 * every tool here.
 */
export const THINK_DENY_CANDIDATES: readonly string[] = [
  'write', 'edit', 'pwsh', 'bash',
  'spawn_teammate', 'team_task_create', 'team_task_update',
  'workflow', 'create_goal', 'update_goal',
  'schedule_create', 'schedule_update', 'schedule_delete',
  'job_kill', 'present',
  'search_web', 'think_deep',
]

/**
 * Tool names a thinking child must never see, matched by pattern.
 *
 * A profile names its shell and its file-writing tools differently — `bash`,
 * `pwsh`, `ops_bash` — so a fixed list misses whatever this profile happens
 * to mount. The names are matched instead.
 */
export const THINK_DENY_PATTERN = /^(ops_)?(bash|pwsh|shell|sh|zsh|cmd|command|powershell|write|edit|patch|apply_patch|delete|remove)$/iu

/**
 * The structured result the thinking child delivers. The child calls the
 * runtime's `structured_output` tool with this schema; the driver validates
 * the value and hands it back as the run's structured result.
 */
export const THINK_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  // Only the conclusion is required. A child that reports fewer sections is
  // still a usable answer; the missing ones read as empty.
  required: ['conclusion'],
  properties: {
    conclusion: {
      type: 'string',
      description: 'The recommended answer, stated directly.',
    },
    keyPoints: {
      type: 'array',
      description: 'The points that carry the conclusion.',
      items: { type: 'string' },
    },
    assumptions: {
      type: 'array',
      description: 'What the conclusion rests on that could be wrong.',
      items: { type: 'string' },
    },
    risks: {
      type: 'array',
      description: 'What would make the conclusion fail, and when.',
      items: { type: 'string' },
    },
  },
}

/** Model-facing `think_deep` arguments. */
interface ThinkDeepArgs {
  task: string
  focus?: string
  verify?: boolean
}

/** What the pipeline retrieved before the thinking started. */
export interface RetrievedKnowledge {
  answer: string
  sources: { url: string, title?: string }[]
}

/** What the verification passes found. */
export interface ThinkVerification {
  rounds: number
  verdict: 'confirmed' | 'conflict'
  problems: string[]
  evidence: { url: string, title?: string, snippet?: string }[]
}

/** The canonical `think_deep` output value. */
interface ThinkDeepOutput {
  conclusion: string
  keyPoints: string[]
  assumptions: string[]
  risks: string[]
  verification?: ThinkVerification
  /** What a retrieval pass aimed at the contradictions found, when one ran. */
  conflictRetrieved?: RetrievedKnowledge
}

/** Thinking route configuration. */
export interface ThinkConfig {
  provider: string
  maxChildCalls: number
  timeoutMs: number
  verifyRounds: number
  verifyProvider: string
  verifyTimeoutMs: number
  /** Retrieval calls a pass aimed at the contradictions may make. */
  conflictSearchCalls: number
  search: SearchConfig
}

/**
 * Validate the model's arguments.
 *
 * @param args - the schema-validated arguments.
 * @returns the accepted arguments.
 */
export function parseThinkDeepArgs(args: ThinkDeepArgs): ThinkDeepArgs {
  if (typeof args.task !== 'string' || args.task.trim().length === 0) {
    throw new Error('task must be a non-empty string')
  }
  return {
    task: args.task,
    ...args.focus !== undefined ? { focus: args.focus } : {},
    ...args.verify !== undefined ? { verify: args.verify } : {},
  }
}

/**
 * Format the parent's view of one delegated thought.
 *
 * @param value - the canonical output value.
 * @returns the model-facing text.
 */
export function formatThinkDeepOutput(value: ThinkDeepOutput): string {
  const parts: string[] = []
  if (value.conclusion.length > 0) parts.push(value.conclusion)
  if (value.keyPoints.length > 0) {
    parts.push(`Key points:\n${value.keyPoints.map((point) => `- ${point}`).join('\n')}`)
  }
  if (value.assumptions.length > 0) {
    parts.push(`Assumptions:\n${value.assumptions.map((item) => `- ${item}`).join('\n')}`)
  }
  if (value.risks.length > 0) {
    parts.push(`Risks:\n${value.risks.map((item) => `- ${item}`).join('\n')}`)
  }
  if (value.conflictRetrieved !== undefined) {
    const lines = ['Retrieved for the disputed points only:']
    if (value.conflictRetrieved.answer.length > 0) lines.push(value.conflictRetrieved.answer)
    if (value.conflictRetrieved.sources.length > 0) {
      lines.push(`Sources:\n${
        value.conflictRetrieved.sources.map((source) => `- [${source.title ?? source.url}](${source.url})`).join('\n')
      }`)
    }
    parts.push(lines.join('\n'))
  }
  if (value.verification !== undefined) {
    const { rounds, verdict, problems, evidence } = value.verification
    const head = verdict === 'confirmed'
      ? `Verified against ${evidence.length} source(s) over ${rounds} pass(es): no unsupported part found.`
      : `Verification found ${problems.length} unsupported part(s) over ${rounds} pass(es).`
    const lines = [head]
    if (problems.length > 0) {
      lines.push(`Problems:\n${problems.map((problem) => `- ${problem}`).join('\n')}`)
    }
    if (evidence.length > 0) {
      lines.push(`Verification sources:\n${
        evidence.map((item) => `- [${item.title ?? item.url}](${item.url})`).join('\n')
      }`)
    }
    parts.push(lines.join('\n'))
  }
  return parts.join('\n\n')
}

/**
 * Build the thinking child's instruction. The child is told to deliver a
 * conclusion, not a transcript of its own reasoning.
 *
 * When the pipeline retrieved external knowledge before the thinking started,
 * the child is given that material — and told to treat it as material rather
 * than as fact.
 *
 * @param task - what to think through.
 * @param focus - what the conclusion must settle, when the caller narrowed it.
 * @param maxCalls - the retrieval calls the child has.
 * @param retrieved - the external knowledge the pipeline gathered first.
 * @returns the child's instruction.
 */
export function buildThinkChildPrompt(
  task: string,
  focus: string | undefined,
  maxCalls: number,
): string {
  const parts: string[] = [`Think this through thoroughly: ${task}`]
  if (focus !== undefined && focus.trim().length > 0) {
    parts.push(`The conclusion must settle this: ${focus}`)
  }
  parts.push(
    'You have the full context of this conversation, including everything already established and every '
    + 'earlier conclusion. Use it: check the premises, weigh the alternatives, and build on what is '
    + 'already settled instead of re-deriving it.',
    `You have a reading budget of ${maxCalls} retrieval calls if you need to check something external. `
    + 'Spend them only on what the conversation does not already settle.',
  )
  parts.push(
    'Then deliver your result with the structured_output tool:',
    '- conclusion: the recommended answer, stated directly in a few sentences. Give a recommendation, not '
    + 'a survey. Say plainly when the evidence does not settle the question, and when you are uncertain.',
    '- keyPoints: the three to five points that carry the conclusion, one sentence each.',
    '- assumptions: what the conclusion rests on that could be wrong.',
    '- risks: what would make this recommendation fail, and at what scale or under what condition.',
    'Do not narrate your reasoning process and do not report what you considered and rejected. The parent '
    + 'sees only this structured result.',
  )
  return parts.join('\n\n')
}

/**
 * Recognize a failed tool restriction.
 *
 * @param error - the thrown value.
 * @returns true when the failure came from an unknown name in a tool filter.
 */
function isRestrictionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('tools.restrict()') && message.includes('unknown')
}

/**
 * Recover the child's own restrictable names from a restriction failure.
 *
 * The failure message names every tool the child can be restricted to. That
 * list is the only precise source of the child's scope: the parent's scope and
 * the global view both differ from it, and `tools.restrict` rejects a name the
 * child does not know.
 *
 * @param error - the thrown value.
 * @param candidates - the names this route wants to deny.
 * @returns the deny list the child will accept, or undefined when the message
 *   does not carry a name list.
 */
function denyFromRestrictionFailure(
  error: unknown,
  candidates: readonly string[],
): string[] | undefined {
  const message = error instanceof Error ? error.message : String(error)
  const match = /known global tools: ([^\n]+)/u.exec(message)
  if (match === null) return undefined
  const known = new Set(
    match[1]!.split(',').map((entry) => entry.trim().replace(/^"|"$/gu, '')),
  )
  const deny = candidates.filter((name) => known.has(name))
  return deny.length > 0 ? deny : undefined
}

/**
 * Register the `think_deep` tool.
 *
 * @param ctx - the plugin context supplying the registries.
 * @param config - the resolved thinking configuration.
 * @param budget - the budget that covers this route's children.
 */
export function applyThinkTool(
  ctx: Context,
  config: ThinkConfig,
  budget: ChildBudget,
): void {
  // The names this child accepts, learned from a restriction failure. The
  // child's scope cannot be derived before the spawn, and the failure names
  // every tool the child accepts.
  let knownChildTools: Set<string> | undefined
  ctx.tools.register(defineTool({
    name: 'think_deep',
    description: 'Delegate a hard question to a subagent that inherits this conversation and reasons over '
      + 'it at length. The pipeline retrieves the external knowledge first, in its own child, so the '
      + 'reasoning starts from material rather than from memory; a second subagent then tries to refute '
      + 'the conclusion. Use it whenever the question asks for a judgement — a recommendation, a '
      + 'comparison, a trade-off, a design, a risk analysis — and not only for a fact; the user need not '
      + 'ask for it. A task that mixes a judgement with mechanical work is two tasks: delegate the '
      + 'judgement first, with the judgement in the focus, and do the work afterwards — a continuous edit '
      + 'is not a reason to reason inside it. It returns a structured conclusion — recommendation, key '
      + 'points, assumptions, and risks — with what was retrieved and a verification record, while the '
      + 'reasoning stays in the child.',
    parameters: {
      task: {
        type: 'string',
        required: true,
        description: 'The question to think through.',
      },
      focus: {
        type: 'string',
        description: 'What the conclusion must settle, when the task is broader than the question.',
      },
      verify: {
        type: 'boolean',
        description: 'Set false to skip the verification pass. Verification costs one more subagent and '
          + 'one more round trip; it is what catches a conclusion the sources do not support.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          conclusion: { type: 'string', required: true },
          keyPoints: { type: 'array', required: true, items: { type: 'string' } },
          assumptions: { type: 'array', required: true, items: { type: 'string' } },
          risks: { type: 'array', required: true, items: { type: 'string' } },
          conflictRetrieved: {
            type: 'object',
            additionalProperties: false,
            properties: {
              answer: { type: 'string', required: true },
              sources: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    url: { type: 'string', required: true },
                    title: { type: 'string' },
                  },
                },
              },
            },
          },
          verification: {
            type: 'object',
            additionalProperties: false,
            properties: {
              rounds: { type: 'number', required: true },
              verdict: { type: 'string', required: true, enum: ['confirmed', 'conflict'] },
              problems: { type: 'array', required: true, items: { type: 'string' } },
              evidence: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    url: { type: 'string', required: true },
                    title: { type: 'string' },
                    snippet: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatThinkDeepOutput(value as ThinkDeepOutput) }],
    },
    // A delegated thought is a foreground operation on the parent's behalf.
    // Its deadline covers the whole pipeline: the retrieving child, then one
    // thinking child, then a verifier per round, and a retrieval pass aimed at
    // the contradictions whenever a verifier found any.
    isConcurrencySafe: () => false,
    timeoutMs: config.timeoutMs
      + config.verifyTimeoutMs * Math.max(1, config.verifyRounds)
      + (config.conflictSearchCalls > 0 ? config.search.timeoutMs : 0),
    async execute(args, exec) {
      const parsed = parseThinkDeepArgs(args as ThinkDeepArgs)
      const parent = exec.agent
      if (parent === undefined) {
        throw new Error('think_deep needs an agent to delegate from')
      }
      // The child's restrictable names are not knowable before the spawn: the
      // child's scope is neither the parent's scope nor the global view, and
      // `tools.restrict` rejects a name the child does not know. The list is
      // therefore seeded from the parent's scope — which is non-empty and may
      // over-reach — and corrected from the failure that an over-reaching name
      // produces. The corrected set is remembered, so later delegations
      // restrict on the first attempt.
      //
      // The shell and file-writing tools are picked by name from the parent's
      // own visible set, because a profile names them differently.
      const patterned = ctx.tools.schemas(parent)
        .map((schema) => schema.name)
        .filter((name) => THINK_DENY_PATTERN.test(name))
      const candidates = knownChildTools === undefined
        ? [...new Set([
          ...THINK_DENY_CANDIDATES.filter((name) => ctx.tools.get(name, parent) !== undefined),
          ...patterned,
        ])]
        : [...new Set([
          ...THINK_DENY_CANDIDATES.filter((name) => knownChildTools!.has(name)),
          // A name the child does not know cannot be denied, and the child
          // cannot call it either.
          ...patterned.filter((name) => knownChildTools!.has(name)),
        ])]
      const maxRounds = parsed.verify === false ? 0 : config.verifyRounds

      // No retrieval happens here. The thinking child is a fork: it inherits
      // this conversation, including anything the parent already searched for,
      // so retrieving again would read the same material twice and put a second
      // corpus in the prompt that the parent never asked for. The parent's
      // `search_web` is the way external knowledge enters; the retrieval that
      // belongs to this pipeline is the one aimed at a verifier's objections.
      let prompt = buildThinkChildPrompt(parsed.task, parsed.focus, config.maxChildCalls)
      let conclusion = ''
      let keyPoints: string[] = []
      let assumptions: string[] = []
      let risks: string[] = []
      let verification: ThinkVerification | undefined

      let conflictRetrieved: RetrievedKnowledge | undefined
      for (let round = 1; round <= Math.max(1, maxRounds); round++) {
        const base = {
          parent,
          prompt: [{ type: 'text', text: prompt }] as ContentBlock[],
          signal: exec.signal,
          outputSchema: THINK_OUTPUT_SCHEMA,
        }
        let run
        try {
          run = await ctx.subagents.start(
            config.provider,
            candidates.length > 0 ? { ...base, toolFilter: { deny: candidates } } : base,
          )
        } catch (error: unknown) {
          if (!isRestrictionFailure(error)) throw error
          // The failed spawn published no child, so retrying is safe. The child's
          // own restrictable names are recovered from the failure and used
          // instead; a thought must never die because a profile's scopes
          // disagree.
          const corrected = denyFromRestrictionFailure(error, THINK_DENY_CANDIDATES)
          if (corrected !== undefined) knownChildTools = new Set(corrected)
          run = await ctx.subagents.start(
            config.provider,
            corrected === undefined ? base : { ...base, toolFilter: { deny: corrected } },
          )
        }
        registerChild(budget, run.id, config.maxChildCalls)
        let projected: ThinkDeepOutput
        try {
          projected = projectThinkResult(await run.result)
        } finally {
          releaseChildBudget(budget, run.id)
          await run.dispose()
        }
        // The thinking child's own self-revisions: it is a separate agent with
        // its own stream, and how many times it argued with itself is a fact
        // about the reasoning that the conclusion came out of.
        conclusion = projected.conclusion
        keyPoints = projected.keyPoints
        assumptions = projected.assumptions
        risks = projected.risks

        if (maxRounds === 0) break
        // The verifier is a separate child with a clean context and an
        // adversarial role: it is handed the conclusion and asked to refute it.
        const verdict = await runVerifier(
          ctx,
          { provider: config.verifyProvider, timeoutMs: config.verifyTimeoutMs },
          budget,
          parent,
          exec.signal,
          conclusion,
          keyPoints,
          parsed.task,
          config.maxChildCalls,
        )
        verification = {
          rounds: round,
          verdict: verdict.verdict,
          problems: verdict.problems,
          evidence: verdict.evidence,
        }
        if (verdict.verdict !== 'conflict') break
        if (round >= maxRounds) break
        // The problems name the exact parts of the conclusion that failed, so
        // the retrieval pass looks those up instead of re-reading the subject
        // the first pass already covered.
        const conflictSearch = await delegateSearch(
          ctx,
          config.search,
          budget,
          parent,
          exec.signal,
          buildConflictSearchPrompt(verdict.problems, config.conflictSearchCalls),
          config.conflictSearchCalls,
        )
        conflictRetrieved = {
          answer: conflictSearch.answer,
          sources: conflictSearch.sources.map((source) => ({
            url: source.url,
            ...source.title === undefined ? {} : { title: source.title },
          })),
        }
        prompt = buildRefinePrompt(
          parsed.task,
          conclusion,
          verdict.problems,
          verdict.evidence,
          conflictRetrieved,
        )
      }

      return {
        conclusion,
        keyPoints,
        assumptions,
        risks,
        ...verification !== undefined ? { verification } : {},
        ...conflictRetrieved !== undefined ? { conflictRetrieved } : {},
      }
    },
    presentCall: (args) => {
      const task = (args as ThinkDeepArgs).task
      return { card: 'generic', title: task, kind: 'search', rawInput: task }
    },
  }))
}
