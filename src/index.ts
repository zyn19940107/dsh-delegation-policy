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
import { checkChildBudget, createChildBudget, createWebGuard } from './guard.js'
import {
  applySearchTool,
  DEFAULT_MAX_CHILD_CALLS,
  DEFAULT_MAX_SNIPPET_CHARS,
  DEFAULT_MAX_SOURCES,
  DEFAULT_SEARCH_PROVIDER,
  DEFAULT_SEARCH_TIMEOUT_MS,
} from './search.js'
import {
  DEFAULT_CONFLICT_SEARCH_CALLS,
} from './think.js'
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
 * The delegation policy, as the model should see it.
 *
 * The two dedicated tools carry constraints the generic delegation tools do
 * not — a clean context, a reading budget, a conclusion-only result, a
 * verification pass — so they are the default for the two shapes of work they
 * cover. The policy says when to reach for each route and when not to delegate
 * at all, so that delegation is the agent's own judgement rather than something
 * the user has to ask for.
 *
 * This text is part of the system prompt and is re-sent every turn, so it
 * stays as short as the policy allows.
 */
export const DELEGATION_GUIDANCE = [
  'Delegation:',
  '- search_web: web search, delegated to a subagent with a clean context. Use it for any fact that '
  + 'lives outside this conversation. It returns a distilled answer and its citations, and the retrieved '
  + 'pages never enter this conversation. It is the only route to the web from this conversation — a '
  + 'direct page fetch is refused here, and the subagent is the one that reads the pages. Before '
  + 'searching, check what the local source already answers: for a question about this codebase or the '
  + 'running runtime, the installed source is more authoritative than any published document.',
  '- think_deep: a hard question delegated to a subagent that inherits this conversation, reasons over '
  + 'it at length, and is then checked by a second subagent that tries to refute the conclusion. Use it '
  + 'whenever the question asks for a judgement — a recommendation, a comparison, a trade-off, a design, '
  + 'a risk analysis — and not only for a fact. Judging from your own reading is where a small model is '
  + 'weakest; the second opinion and the verification pass are what make the answer trustworthy. The '
  + 'pipeline retrieves the external knowledge first, in its own child, so the reasoning starts from '
  + 'material rather than from memory. It returns a structured conclusion with what was retrieved and a '
  + 'verification record.',
  '- subagent: a fresh subagent for a self-contained task that needs neither of the above.',
  'These are the rules for delegation. Do not go looking for them elsewhere — not in a policy document, '
  + 'not in a README, not in this plugin\'s source: the tools are already in your tool table and the '
  + 'rules are already here.',
  'Reach for these on your own — the user should not have to ask for delegation. When you have decided '
  + 'that a fact is external, dispatch the search now: reading the rules, the tool list, or the local '
  + 'files first is not the work.',
  'A task that mixes a '
  + 'judgement with mechanical work is two tasks: delegate the judgement first, with the judgement in '
  + 'the focus, and do the work yourself afterwards. A continuous edit is not a reason to reason inside '
  + 'it — "where does this part actually end, which way does the force go, which alternative is better" '
  + 'is a question whatever else the turn is doing.',
  'Do not delegate when one grep, one file read, or one small edit answers the question on its own, when '
  + 'the next step depends entirely on the result, or when delegating would break one continuous edit '
  + 'into fragments.',
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
  /** Whether a delegated thought retrieves before it reasons. */
  retrieveFirst: Volatile<boolean>
  /** Retrieval calls a pass aimed at the contradictions may make. */
  conflictSearchCalls: Volatile<number>
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
  conflictSearchCalls: z.number().step(1).min(0).default(DEFAULT_CONFLICT_SEARCH_CALLS).volatile(),
})

/**
 * Register the delegation routes, the prompt guidance, and the rules enforced
 * at the execution point.
 *
 * @param ctx - the plugin context supplying the registries.
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // One budget for every delegated child. A child this plugin started carries
  // the limit of its route; a child some other tool started still carries the
  // default, so a delegation policy is not bypassed by taking another route to
  // the same place.
  const budget = createChildBudget(Math.max(config.maxChildCalls.get(), config.maxThinkCalls.get()))

  ctx.systemPrompt.section({
    name: 'tool:delegation-routes',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text: ({ scope }) => ctx.tools.get('search_web', scope) === undefined
      && ctx.tools.get('think_deep', scope) === undefined
      ? ''
      : DELEGATION_GUIDANCE,
  })

  ctx.tools.guard(createWebGuard())

  ctx.on('tools/pre-execute', async (
    exec: ToolExecution,
    next,
  ): Promise<PreToolDecision> => {
    const denial = checkChildBudget(budget, exec)
    if (denial !== undefined) return { kind: 'deny', reason: denial }
    return next()
  })

  applySearchTool(ctx, {
    provider: config.searchProvider.get(),
    maxSources: config.maxSources.get(),
    maxSnippetChars: config.maxSnippetChars.get(),
    maxChildCalls: config.maxChildCalls.get(),
    timeoutMs: config.searchTimeoutMs.get(),
  }, budget)

  applyThinkTool(ctx, {
    provider: config.thinkProvider.get(),
    maxChildCalls: config.maxThinkCalls.get(),
    timeoutMs: config.thinkTimeoutMs.get(),
    verifyRounds: config.verifyRounds.get(),
    verifyProvider: config.verifyProvider.get(),
    verifyTimeoutMs: config.verifyTimeoutMs.get(),
    conflictSearchCalls: config.conflictSearchCalls.get(),
    search: {
      provider: config.searchProvider.get(),
      maxSources: config.maxSources.get(),
      maxSnippetChars: config.maxSnippetChars.get(),
      maxChildCalls: config.maxChildCalls.get(),
      timeoutMs: config.searchTimeoutMs.get(),
    },
  }, budget)
}
