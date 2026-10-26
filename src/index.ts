/**
 * The delegation policy, as executable rules instead of prose.
 *
 * Three routes, one per shape of delegation:
 *
 * - `search_web` — web search, delegated to a clean-context child. The
 *   retrieved corpus stays in the child; the parent receives a distilled answer
 *   and its citations.
 * - `think_deep` — long reasoning, delegated to a child that inherits this
 *   conversation. The child's reasoning stays in the child; the parent receives
 *   a structured conclusion.
 * - The generic `subagent` / `subagent_fork` — for self-contained work that
 *   needs none of the above.
 *
 * Two rules are enforced at the point where a call is decided rather than
 * asked for in a prompt: a direct `web_search` is refused outside a
 * delegation, and every delegated child has a retrieval budget.
 *
 * @module @local/dsh-delegation-policy
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import { checkChildBudget, createChildBudget, createSearchGuard } from './guard.js'
import {
  applySearchTool,
  DEFAULT_MAX_CHILD_CALLS,
  DEFAULT_MAX_SNIPPET_CHARS,
  DEFAULT_MAX_SOURCES,
  DEFAULT_SEARCH_PROVIDER,
  DEFAULT_SEARCH_TIMEOUT_MS,
} from './search.js'
import {
  applyThinkTool,
  DEFAULT_MAX_THINK_CALLS,
  DEFAULT_THINK_PROVIDER,
  DEFAULT_THINK_TIMEOUT_MS,
} from './think.js'
import {
  DEFAULT_VERIFY_PROVIDER,
  DEFAULT_VERIFY_ROUNDS,
  DEFAULT_VERIFY_TIMEOUT_MS,
} from './verify.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'delegation-policy'

/** Services this plugin needs: the tool registry, the delegation seam, and prompt assembly. */
export const inject = ['tools', 'subagents', 'systemPrompt']

/**
 * The routes, as the model should see them. The two dedicated tools carry
 * constraints the generic delegation tools do not — a clean context, a reading
 * budget, a conclusion-only result — so they are the default for those two
 * shapes of work.
 */
export const DELEGATION_GUIDANCE = [
  'Delegation routes:',
  '- search_web: web search, delegated to a subagent with a clean context. Use it for any fact that '
  + 'lives outside this conversation. It returns a distilled answer and its citations; the retrieved '
  + 'pages never enter this conversation. Before searching, check what the local source already '
  + 'answers: for a question about this codebase or the running runtime, the installed source is more '
  + 'authoritative than any published document.',
  '- think_deep: a hard question delegated to a subagent that inherits this conversation and reasons '
  + 'over it at length. Use it when the reasoning depends on what has already been established here, or '
  + 'when you want a second opinion on your own plan. It returns a structured conclusion — '
  + 'recommendation, key points, assumptions, risks — and its reasoning stays in the child.',
  '- subagent: a fresh subagent for a self-contained task that needs neither of the above.',
  'Prefer search_web and think_deep over the generic delegation tools for these two shapes of work.',
].join('\n')

/** Plugin config. */
export interface Config {
  /** Provider that runs the search child. */
  searchProvider: Volatile<string>
  /** Upper bound on sources returned to the parent. */
  maxSources: Volatile<number>
  /** Excerpt budget per source. */
  maxSnippetChars: Volatile<number>
  /** Retrieval calls the search child may make. */
  maxChildCalls: Volatile<number>
  /** Budget for one delegated search, in milliseconds. */
  searchTimeoutMs: Volatile<number>
  /** Provider that runs the thinking child. */
  thinkProvider: Volatile<string>
  /** Retrieval calls the thinking child may make. */
  maxThinkCalls: Volatile<number>
  /** Budget for one delegated thought, in milliseconds. */
  thinkTimeoutMs: Volatile<number>
  /** Verification passes a delegated thought may run. */
  verifyRounds: Volatile<number>
  /** Provider that runs the verifier. */
  verifyProvider: Volatile<string>
  /** Budget for one verification pass, in milliseconds. */
  verifyTimeoutMs: Volatile<number>
}

export const Config = z.object({
  searchProvider: z.string().default(DEFAULT_SEARCH_PROVIDER).volatile(),
  maxSources: z.number().step(1).min(1).default(DEFAULT_MAX_SOURCES).volatile(),
  maxSnippetChars: z.number().step(1).min(1).default(DEFAULT_MAX_SNIPPET_CHARS).volatile(),
  maxChildCalls: z.number().step(1).min(1).default(DEFAULT_MAX_CHILD_CALLS).volatile(),
  searchTimeoutMs: z.number().step(1).min(1).default(DEFAULT_SEARCH_TIMEOUT_MS).volatile(),
  thinkProvider: z.string().default(DEFAULT_THINK_PROVIDER).volatile(),
  maxThinkCalls: z.number().step(1).min(1).default(DEFAULT_MAX_THINK_CALLS).volatile(),
  thinkTimeoutMs: z.number().step(1).min(1).default(DEFAULT_THINK_TIMEOUT_MS).volatile(),
  verifyRounds: z.number().step(1).min(0).default(DEFAULT_VERIFY_ROUNDS).volatile(),
  verifyProvider: z.string().default(DEFAULT_VERIFY_PROVIDER).volatile(),
  verifyTimeoutMs: z.number().step(1).min(1).default(DEFAULT_VERIFY_TIMEOUT_MS).volatile(),
})

/**
 * Register the delegation routes, the prompt guidance, and the rules enforced
 * at the execution point.
 *
 * @param ctx - the plugin context supplying the registries.
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const searchBudget = createChildBudget(config.maxChildCalls.get())
  const thinkBudget = createChildBudget(config.maxThinkCalls.get())

  ctx.systemPrompt.section({
    name: 'tool:delegation-routes',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text: ({ scope }) => ctx.tools.get('search_web', scope) === undefined
      && ctx.tools.get('think_deep', scope) === undefined
      ? ''
      : DELEGATION_GUIDANCE,
  })

  ctx.tools.guard(createSearchGuard())

  ctx.on('tools/pre-execute', async (
    exec: ToolExecution,
    next,
  ): Promise<PreToolDecision> => {
    for (const budget of [searchBudget, thinkBudget]) {
      const denial = checkChildBudget(budget, exec)
      if (denial !== undefined) return { kind: 'deny', reason: denial }
    }
    return next()
  })

  applySearchTool(ctx, {
    provider: config.searchProvider.get(),
    maxSources: config.maxSources.get(),
    maxSnippetChars: config.maxSnippetChars.get(),
    maxChildCalls: config.maxChildCalls.get(),
    timeoutMs: config.searchTimeoutMs.get(),
  }, searchBudget)

  applyThinkTool(ctx, {
    provider: config.thinkProvider.get(),
    maxChildCalls: config.maxThinkCalls.get(),
    timeoutMs: config.thinkTimeoutMs.get(),
    verifyRounds: config.verifyRounds.get(),
    verifyProvider: config.verifyProvider.get(),
    verifyTimeoutMs: config.verifyTimeoutMs.get(),
  }, thinkBudget)
}
