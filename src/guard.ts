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
 * Web tools the parent conversation may not call.
 *
 * The parent has one way to the web: `search_web`, which delegates. A tool
 * that can pull a page into the parent is a way around that delegation.
 */
export const PARENT_DENIED_WEB_TOOLS: readonly string[] = ['web_search', 'web_fetch', 'read_page']

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
  /** Children whose job is to read pages: the search and verifying children. */
  readonly readers: Set<string>
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
  return { calls: new Map(), limits: new Map(), defaultLimit, readers: new Set() }
}

/**
 * Record a child whose job is to read pages.
 *
 * The web guard refuses `web_search`, `web_fetch` and `read_page` to every
 * delegated child except these. A thinking child reasons over the conversation
 * it inherited; it does not fetch pages, and a fetch there is the reasoning
 * child doing the retrieval the pipeline already did for it.
 *
 * @param budget - the budget the child is registered with.
 * @param sessionId - the child's session id.
 */
export function markReader(budget: ChildBudget, sessionId: string): void {
  budget.readers.add(sessionId)
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
 * Refuse a direct call to a web tool from anything but a delegated subagent.
 *
 * A subagent's own session header records `origin: 'subagent'`, which is what
 * separates a delegation's own child from the conversation that asked for it.
 *
 * Every tool that can pull a page into the parent is refused, not only the
 * one that searches. A search the parent did itself is only half the problem:
 * the model answered "what does this page say" by fetching it, and the page
 * landed in the conversation that the delegation exists to keep clean.
 *
 * @param execution - the call under evaluation.
 * @returns the denial reason, or undefined to leave the call allowed.
 */
export function createWebGuard(budget: ChildBudget): ToolGuard {
  return (execution) => {
    if (!PARENT_DENIED_WEB_TOOLS.includes(execution.name)) return undefined
    const agent: Agent | undefined = execution.agent
    if (agent === undefined) return undefined
    if (agent.session.header.origin === 'subagent') {
      if (budget.readers.has(agent.session.id)) return undefined
      return `You are a delegated child that reasons; ${execution.name} is not your job. The knowledge `
        + 'this question needs is gathered for you and arrives with the material. Work from what you '
        + 'have: read the files, run the commands, and reason.'
    }
    return `Direct ${execution.name} is disabled in this conversation. Use search_web instead: it `
      + 'delegates the search to a subagent and returns the distilled answer with its citations, so the '
      + 'retrieved pages never enter this conversation. The subagent reads the pages; you get the answer.'
  }
}

/**
 * The plugin's own routes.
 *
 * These are the conversation's routes, not a child's. `think_deep` starts a
 * whole pipeline, `search_web` starts a search, and `classify_question` states
 * what the conversation's own question is about. A child that calls one of
 * them nests the pipeline inside itself: the fork inside a thought starts
 * another thought, and that thought forks again — each level invisible to the
 * parent, each level paying for the same work.
 *
 * No child may call these. There is no exception, because there is no child
 * that has a question of its own to classify or a pipeline of its own to run.
 */
export const PLUGIN_ROUTE_TOOLS: readonly string[] = [
  'search_web', 'think_deep', 'classify_question',
]

/**
 * Tools that start another agent.
 *
 * Unlike the plugin's routes, these are ordinary orchestration: a child that
 * needs a piece of work done elsewhere can ask another child to do it. Two
 * kinds of child may use them — the conversation that asked the question, and
 * the thinking child this plugin forked, which reasons over the whole
 * conversation and may want a child's help to settle a point. Every other
 * child is refused, because a chain of search children at every level searches
 * the same material again.
 */
export const ORCHESTRATION_TOOLS: readonly string[] = [
  'subagent', 'subagent_fork',
  'spawn_teammate', 'workflow',
]

/**
 * Refuse to let a delegated child start another agent.
 *
 * A child has the parent's permissions over the work — it may read, write,
 * search the web and run commands. Two things it may not do:
 *
 * - call the plugin's own routes; a thought inside a thought is the pipeline
 *   eating itself;
 * - start another agent, unless it is the thinking child, which reasons over
 *   this conversation and may need a child's help.
 *
 * The parent keeps every one of these tools. Only a child is refused.
 *
 * @param mayDelegate - the session ids of the children that may start
 *   another child: the thinking children this plugin forked.
 * @returns the guard.
 */
export function createNoRedelegationGuard(
  mayDelegate: ReadonlySet<string> = new Set(),
): ToolGuard {
  return (execution) => {
    const isRoute = PLUGIN_ROUTE_TOOLS.includes(execution.name)
    const isOrchestration = ORCHESTRATION_TOOLS.includes(execution.name)
    if (!isRoute && !isOrchestration) return undefined
    const agent: Agent | undefined = execution.agent
    if (agent === undefined) return undefined
    if (agent.session.header.origin !== 'subagent') return undefined
    const sessionId = agent.session.id
    if (isOrchestration && mayDelegate.has(sessionId)) return undefined
    if (isRoute) {
      return `${execution.name} belongs to the conversation that asked the question, and you are one of `
        + 'its delegated children. Answer with your own work: read the files, run the commands, and '
        + 'search with web_search or web_fetch. What you find belongs in your own answer.'
    }
    return `You are a delegated child, and ${execution.name} would start another agent. Do the work `
      + 'yourself: read the files, run the commands, and search with web_search or web_fetch. What you '
      + 'find belongs in your own answer, where the parent will read it.'
  }
}
