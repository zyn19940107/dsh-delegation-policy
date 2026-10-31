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

/**
 * Tools whose calls count against a child's reading budget.
 *
 * `read_page` is here as well: it pulls a page into the child's context, so
 * it is a reading call like the other two. Leaving it out would have given a
 * reader child a way around the budget.
 */
export const RETRIEVAL_TOOLS: readonly string[] = ['web_search', 'web_fetch', 'read_page']

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
  /** Children whose job is to read pages: the search children. */
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
 * Refuse a direct call to a web tool from anything but a delegated child that
 * reads pages.
 *
 * A subagent's own session header records `origin: 'subagent'`, which is what
 * separates a delegation's own child from the conversation that asked for it.
 * Among those children, only the ones registered as readers may fetch pages:
 * a child that reasons is given the material it needs instead.
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
 * The turns a delegated thought is carrying.
 *
 * A judgement handed to `think_deep` is not a step the conversation takes and
 * then continues past — it is the whole turn. The thought reasons, retrieves
 * and answers; the conversation's own agent has nothing left to do but present
 * the conclusion. Left to itself the agent does exactly what it did before this
 * guard existed: it dispatches the thought *and* a search in the same breath,
 * then spends the rest of the turn re-reading the workspace and tidying up
 * after children. Every one of those calls is the conversation redoing the work
 * the delegation already did.
 *
 * So the route is tracked per turn and enforced at the execution point: once
 * `think_deep` is dispatched, every other call in that turn is refused.
 */
export class ThoughtRoute {
  private readonly routed = new Set<string>()

  /** Record that the session's current turn was handed to a delegated thought. */
  begin(sessionId: string): void {
    this.routed.add(sessionId)
  }

  /** Forget the routing, when the thought failed or the next turn opens. */
  clear(sessionId: string): void {
    this.routed.delete(sessionId)
  }

  /** Whether the session's current turn is carried by a delegated thought. */
  has(sessionId: string): boolean {
    return this.routed.has(sessionId)
  }
}

/**
 * Refuse every call in a turn that a delegated thought is already carrying.
 *
 * `think_deep` itself stays callable so a retry is possible after a failure,
 * and so the call that establishes the routing is never refused by it. Children
 * are untouched: the rule is about the conversation that asked the question.
 *
 * @param route - the per-turn routing record.
 * @returns the guard.
 */
export function createThoughtOnlyGuard(route: ThoughtRoute): ToolGuard {
  return (execution) => {
    const agent: Agent | undefined = execution.agent
    if (agent === undefined) return undefined
    if (agent.session.header.origin === 'subagent') return undefined
    if (!route.has(agent.session.id)) return undefined
    if (execution.name === 'think_deep') return undefined
    return 'This turn was handed to think_deep, and that delegated thought carries the whole turn: it '
      + 'reasons, it retrieves, and its conclusion is the answer. Present the conclusion it returned — '
      + 'the recommendation, then its key points, assumptions and risks — as your reply. Do not call '
      + `${execution.name} or any other tool in this turn: the work it would do is already inside the `
      + 'delegated answer.'
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
