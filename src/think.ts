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
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { releaseChildBudget, type ChildBudget } from './guard.js'
import { projectThinkResult } from './project.js'

/** Provider that runs the thinking child. */
export const DEFAULT_THINK_PROVIDER = 'fork'

/** Default number of retrieval calls the thinking child may make. */
export const DEFAULT_MAX_THINK_CALLS = 5

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
}

/** The canonical `think_deep` output value. */
interface ThinkDeepOutput {
  conclusion: string
  keyPoints: string[]
  assumptions: string[]
  risks: string[]
}

/** Thinking route configuration. */
export interface ThinkConfig {
  provider: string
  maxChildCalls: number
  timeoutMs: number
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
  return parts.join('\n\n')
}

/**
 * Build the thinking child's instruction. The child is told to deliver a
 * conclusion, not a transcript of its own reasoning.
 *
 * @param task - what to think through.
 * @param focus - what the conclusion must settle, when the caller narrowed it.
 * @param maxCalls - the retrieval calls the child has.
 * @returns the child's instruction.
 */
export function buildThinkChildPrompt(task: string, focus: string | undefined, maxCalls: number): string {
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
export function applyThinkTool(ctx: Context, config: ThinkConfig, budget: ChildBudget): void {
  // The names this child accepts, learned from a restriction failure. The
  // child's scope cannot be derived before the spawn, and the failure names
  // every tool the child accepts.
  let knownChildTools: Set<string> | undefined
  ctx.tools.register(defineTool({
    name: 'think_deep',
    description: 'Delegate a hard question to a subagent that inherits this conversation and reasons over '
      + 'it at length. It returns a structured conclusion — recommendation, key points, assumptions, and '
      + 'risks — while its reasoning stays in the child.',
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
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatThinkDeepOutput(value as ThinkDeepOutput) }],
    },
    // A delegated thought is a foreground operation on the parent's behalf.
    isConcurrencySafe: () => false,
    timeoutMs: config.timeoutMs,
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
      const candidates = knownChildTools === undefined
        ? THINK_DENY_CANDIDATES.filter((name) => ctx.tools.get(name, parent) !== undefined)
        : THINK_DENY_CANDIDATES.filter((name) => knownChildTools!.has(name))
      const base = {
        parent,
        prompt: [{
          type: 'text',
          text: buildThinkChildPrompt(parsed.task, parsed.focus, config.maxChildCalls),
        }] as ContentBlock[],
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
      budget.sessions.add(run.id)
      try {
        const result = await run.result
        return projectThinkResult(result)
      } finally {
        releaseChildBudget(budget, run.id)
        await run.dispose()
      }
    },
    presentCall: (args) => {
      const task = (args as ThinkDeepArgs).task
      return { card: 'generic', title: task, kind: 'search', rawInput: task }
    },
  }))
}
