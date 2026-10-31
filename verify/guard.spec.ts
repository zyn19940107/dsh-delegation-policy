/**
 * Regression tests for the web guard.
 *
 * The guard refuses the tools that can pull a page into the parent
 * conversation. It used to refuse only `web_search`, and a model answered
 * "what does this page say" by fetching it directly: the page landed in the
 * conversation that the delegation exists to keep clean. The subagent reads the
 * pages; the parent gets the answer.
 */

import { SessionPolicy } from '../src/policy.js'
import {
  createChildBudget,
  createNoRedelegationGuard,
  createThoughtOnlyGuard,
  createWebGuard,
  DEFAULT_WEB_TOOLS,
  markReader,
  ThoughtRoute,
} from '../src/guard.js'

let failures = 0

/**
 * Assert one condition.
 *
 * @param name - what is being asserted.
 * @param condition - the condition that must hold.
 * @param detail - what to print when it does not.
 */
function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${name}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/**
 * Build a tool execution for a fake agent.
 *
 * @param sessionId - the agent's session id.
 * @param origin - the session header's origin.
 * @param name - the tool being called.
 * @returns an execution shaped like the runtime's.
 */
function execution(sessionId: string, origin: string, name: string): any {
  return { name, agent: { session: { id: sessionId, header: { origin } } } }
}

const policy = new SessionPolicy()

console.log('createWebGuard')
{
  const guard = createWebGuard(createChildBudget(), () => DEFAULT_WEB_TOOLS, policy)
  check('refuses web_search in the parent', guard(execution('p', 'user', 'web_search')) !== undefined)
  check('refuses web_fetch in the parent', guard(execution('p', 'user', 'web_fetch')) !== undefined)
  check('refuses read_page in the parent', guard(execution('p', 'user', 'read_page')) !== undefined)
  check('leaves other tools alone', guard(execution('p', 'user', 'read')) === undefined)
  check('leaves a local file read alone', guard(execution('p', 'user', 'ops_read_files')) === undefined)
}
{
  // A child whose job is to read pages may use them; a child whose job is to
  // reason may not — its knowledge is gathered for it.
  const budget = createChildBudget(3)
  markReader(budget, 'searcher')
  const guard = createWebGuard(budget, () => DEFAULT_WEB_TOOLS, policy)
  check('allows a reader child to search', guard(execution('searcher', 'subagent', 'web_search')) === undefined)
  check('allows a reader child to fetch', guard(execution('searcher', 'subagent', 'web_fetch')) === undefined)
  check('allows a reader child to read a page', guard(execution('searcher', 'subagent', 'read_page')) === undefined)
  check('refuses the search of a child that reasons', guard(execution('thinker', 'subagent', 'web_search')) !== undefined)
  check('refuses the fetch of a child that reasons', guard(execution('thinker', 'subagent', 'web_fetch')) !== undefined)
  check('refuses the page read of a child that reasons', guard(execution('thinker', 'subagent', 'read_page')) !== undefined)
}
{
  const guard = createWebGuard(createChildBudget(), () => DEFAULT_WEB_TOOLS, policy)
  const denial = guard(execution('p', 'user', 'web_fetch'))
  check('points the caller at search_web', denial !== undefined && denial.includes('search_web'))
  check('names the tool it refused', denial !== undefined && denial.includes('web_fetch'))
}
{
  check('the denied set covers the search', DEFAULT_WEB_TOOLS.includes('web_search'))
  check('the denied set covers the fetch', DEFAULT_WEB_TOOLS.includes('web_fetch'))
  check('the denied set covers the page reader', DEFAULT_WEB_TOOLS.includes('read_page'))
  check('the denied set covers the X search', DEFAULT_WEB_TOOLS.includes('x_search'))
}
{
  // A tool another plugin brings is covered when the deployment names it.
  const guard = createWebGuard(createChildBudget(), () => ['web_search', 'browse'], policy)
  check('refuses a configured web tool in the parent', guard(execution('p', 'user', 'browse')) !== undefined)
  check('leaves a tool outside the configuration alone', guard(execution('p', 'user', 'x_search')) === undefined)
}
{
  // A conversation that opted out of the plugin is not governed by its rules.
  const optedOut = new SessionPolicy()
  const guard = createWebGuard(createChildBudget(), () => DEFAULT_WEB_TOOLS, optedOut)
  optedOut.turnOff({
    session: { id: 'quiet', header: { origin: 'user' } },
    ctx: { tools: { restrict: () => () => {} } },
  } as any)
  check('an opted-out conversation may search', guard(execution('quiet', 'user', 'web_search')) === undefined)
  check('another conversation still may not', guard(execution('p', 'user', 'web_search')) !== undefined)
}

console.log('createNoRedelegationGuard')
{
  // Two different rules. The plugin's own routes belong to the conversation
  // that asked the question, so no child may call them — not even the thinking
  // child. Ordinary orchestration is allowed for the thinking child alone.
  const thinking = new Set(['think-1'])
  const guard = createNoRedelegationGuard(thinking)
  check('refuses search_web in a child', guard(execution('c', 'subagent', 'search_web')) !== undefined)
  check('refuses think_deep in a child', guard(execution('c', 'subagent', 'think_deep')) !== undefined)
  check('refuses classify_question in a child', guard(execution('c', 'subagent', 'classify_question')) !== undefined)
  check('refuses subagent in a child', guard(execution('c', 'subagent', 'subagent')) !== undefined)
  check('refuses subagent_fork in a child', guard(execution('c', 'subagent', 'subagent_fork')) !== undefined)
  check('leaves the parent\'s own tools alone', guard(execution('p', 'user', 'search_web')) === undefined)
  check('leaves the parent\'s subagent alone', guard(execution('p', 'user', 'subagent')) === undefined)
  check('allows the thinking child to start a child', guard(execution('think-1', 'subagent', 'subagent')) === undefined)
  check('allows the thinking child to fork', guard(execution('think-1', 'subagent', 'subagent_fork')) === undefined)
  // A thought inside a thought is the pipeline eating itself, so the thinking
  // child is refused these even though it may start a child.
  check('refuses a search inside the thinking child', guard(execution('think-1', 'subagent', 'search_web')) !== undefined)
  check('refuses a thought inside the thinking child', guard(execution('think-1', 'subagent', 'think_deep')) !== undefined)
  check('refuses a classification inside the thinking child', guard(execution('think-1', 'subagent', 'classify_question')) !== undefined)
  check('leaves a child\'s own web search alone', guard(execution('c', 'subagent', 'web_search')) === undefined)
  check('leaves a child\'s page fetch alone', guard(execution('c', 'subagent', 'web_fetch')) === undefined)
  check('leaves the other tools alone', guard(execution('c', 'subagent', 'read')) === undefined)
}
{
  const denial = createNoRedelegationGuard()(execution('c', 'subagent', 'classify_question'))
  check('names the tool it refused', denial !== undefined && denial.includes('classify_question'))
  check('says the route belongs to the conversation', denial !== undefined && denial.includes('conversation'))
}
{
  const denial = createNoRedelegationGuard()(execution('c', 'subagent', 'subagent'))
  check('tells a child to do the work itself', denial !== undefined && denial.includes('yourself'))
}

console.log('createThoughtOnlyGuard')
{
  // A turn handed to a delegated thought has nothing left to do itself. The
  // routing is recorded when think_deep is dispatched, so a search issued in
  // the same step as the thought is refused rather than dispatched alongside it.
  const route = new ThoughtRoute()
  const guard = createThoughtOnlyGuard(route, policy)
  check('leaves a turn alone before it routes', guard(execution('p', 'user', 'search_web')) === undefined)
  route.begin('p')
  const denial = guard(execution('p', 'user', 'search_web'))
  check('refuses a search after the thought was dispatched', denial !== undefined)
  check('refuses a file edit after the thought was dispatched', guard(execution('p', 'user', 'write')) !== undefined)
  check('refuses a shell command after the thought was dispatched', guard(execution('p', 'user', 'ops_bash')) !== undefined)
  check('refuses starting another agent after the thought was dispatched', guard(execution('p', 'user', 'subagent')) !== undefined)
  check('keeps think_deep itself callable', guard(execution('p', 'user', 'think_deep')) === undefined)
  check('says the thought carries the turn', denial !== undefined && denial.includes('carries the whole turn'))
  check('says what to do instead', denial !== undefined && denial.includes('Present the conclusion'))
  check('names the tool it refused', denial !== undefined && denial.includes('search_web'))
  // Children are untouched: the rule is about the conversation that asked.
  check('leaves a child alone', guard(execution('c', 'subagent', 'search_web')) === undefined)
  // A new turn clears the routing, and a failed thought releases the turn.
  route.clear('p')
  check('leaves the next turn alone', guard(execution('p', 'user', 'search_web')) === undefined)
  route.begin('p')
  route.clear('p')
  check('releases the turn when the thought failed', guard(execution('p', 'user', 'ops_bash')) === undefined)
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
