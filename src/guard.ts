/**
 * Execution-point guards and per-child accounting.
 *
 * A delegation policy that lives only in a prompt is advice. These are the
 * rules at the point where a call is decided: which agent may search the web
 * directly, and how much a delegated child may read.
 *
 * @module @local/dsh-delegation-policy/guard
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution, ToolGuard } from '@deepseek-ai/dsh-tools'

/** Tools whose calls count against a child's retrieval budget. */
export const RETRIEVAL_TOOLS: readonly string[] = ['web_search', 'web_fetch']

/**
 * Per-child retrieval accounting.
 *
 * A child is charged by the session id it reports for itself, so the accounting
 * never depends on the spawning side's idea of that id. A child this plugin
 * started carries the limit of its route; any other delegated child carries the
 * default limit, because a delegation policy that binds only its own routes is
 * not a policy.
 */
export interface ChildBudget {
  /** Retrieval calls already made, per child session. */
  readonly calls: Map<string, number>
  /** The limit that applies to a child, by its session id. */
  readonly limits: Map<string, number>
  /** The limit for a delegated child this budget did not start. */
  defaultLimit: number
}

/**
 * Create an empty budget.
 *
 * @param defaultLimit - retrieval calls a delegated child this budget did not
 *   start may make.
 * @returns the budget.
 */
export function createChildBudget(defaultLimit: number): ChildBudget {
  return { calls: new Map(), limits: new Map(), defaultLimit }
}

/**
 * Give a child the limit of the route that started it.
 *
 * @param budget - the budget to register with.
 * @param sessionId - the child's session id.
 * @param limit - retrieval calls the child may make.
 */
export function registerChild(budget: ChildBudget, sessionId: string, limit: number): void {
  budget.limits.set(sessionId, limit)
}

/**
 * Account one retrieval call against a child's budget.
 *
 * @param budget - the budget to charge.
 * @param execution - the pending call.
 * @returns the denial reason when the budget is spent, otherwise undefined.
 */
export function checkChildBudget(
  budget: ChildBudget,
  execution: ToolExecution,
): string | undefined {
  const agent: Agent | undefined = execution.agent
  if (agent === undefined) return undefined
  const sessionId = agent.session.id
  const delegated = agent.session.header.origin === 'subagent'
  const limit = budget.limits.get(sessionId) ?? (delegated ? budget.defaultLimit : undefined)
  if (limit === undefined) return undefined
  if (!RETRIEVAL_TOOLS.includes(execution.name)) return undefined
  const used = (budget.calls.get(sessionId) ?? 0) + 1
  budget.calls.set(sessionId, used)
  if (used <= limit) return undefined
  return `This delegation has spent its reading budget: ${limit} retrieval calls. `
    + 'Answer now with what you already have — a source you did not read is better than a summary '
    + 'padded with material you did.'
}

/**
 * Forget one child: its budget ends with its run.
 *
 * @param budget - the budget to release from.
 * @param sessionId - the child's session id.
 */
export function releaseChildBudget(budget: ChildBudget, sessionId: string): void {
  budget.limits.delete(sessionId)
  budget.calls.delete(sessionId)
}

/**
 * Refuse a direct `web_search` call from anything but a delegated subagent.
 * A subagent's own session header records `origin: 'subagent'`, which is what
 * separates a delegation's own child from the conversation that asked for it.
 *
 * @param execution - the call under evaluation.
 * @returns the denial reason, or undefined to leave the call allowed.
 */
export function createSearchGuard(): ToolGuard {
  return (execution) => {
    if (execution.name !== 'web_search') return undefined
    const agent: Agent | undefined = execution.agent
    if (agent === undefined) return undefined
    if (agent.session.header.origin === 'subagent') return undefined
    return 'Direct web_search is disabled in this conversation. Use search_web instead: it delegates '
      + 'the search to a subagent and returns the distilled answer with its citations, so the retrieved '
      + 'pages never enter this conversation.'
  }
}
