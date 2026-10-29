/**
 * Regression tests for the web guard.
 *
 * The guard refuses the tools that can pull a page into the parent
 * conversation. It used to refuse only `web_search`, and a model answered
 * "what does this page say" by fetching it directly: the page landed in the
 * conversation that the delegation exists to keep clean. The subagent reads the
 * pages; the parent gets the answer.
 */

import {
  createChildBudget,
  createNoRedelegationGuard,
  createWebGuard,
  markReader,
  PARENT_DENIED_WEB_TOOLS,
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

console.log('createWebGuard')
{
  const guard = createWebGuard(createChildBudget(3))
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
  const guard = createWebGuard(budget)
  check('allows a reader child to search', guard(execution('searcher', 'subagent', 'web_search')) === undefined)
  check('allows a reader child to fetch', guard(execution('searcher', 'subagent', 'web_fetch')) === undefined)
  check('allows a reader child to read a page', guard(execution('searcher', 'subagent', 'read_page')) === undefined)
  check('refuses the search of a child that reasons', guard(execution('thinker', 'subagent', 'web_search')) !== undefined)
  check('refuses the fetch of a child that reasons', guard(execution('thinker', 'subagent', 'web_fetch')) !== undefined)
  check('refuses the page read of a child that reasons', guard(execution('thinker', 'subagent', 'read_page')) !== undefined)
}
{
  const guard = createWebGuard(createChildBudget(3))
  const denial = guard(execution('p', 'user', 'web_fetch'))
  check('points the caller at search_web', denial !== undefined && denial.includes('search_web'))
  check('names the tool it refused', denial !== undefined && denial.includes('web_fetch'))
}
{
  check('the denied set covers the search', PARENT_DENIED_WEB_TOOLS.includes('web_search'))
  check('the denied set covers the fetch', PARENT_DENIED_WEB_TOOLS.includes('web_fetch'))
  check('the denied set covers the page reader', PARENT_DENIED_WEB_TOOLS.includes('read_page'))
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

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
