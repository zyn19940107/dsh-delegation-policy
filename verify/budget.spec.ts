/**
 * Regression tests for the retrieval budget.
 *
 * The defect these cover: the budget was keyed by the id the spawning side
 * believed the child had, and a child that was not registered under that id was
 * never charged. Three of eight search children in the sandbox made 8, 12 and
 * 45 retrieval calls without a single denial, and the child that made 45 calls
 * carried 216 KB of retrieved material — about 66K tokens — into its context.
 *
 * The budget is now charged by the session id the executing agent reports for
 * itself, and it covers every delegated child, not only the children this
 * plugin started.
 */

import { checkChildBudget, createChildBudget, registerChild, releaseChildBudget } from '../src/guard.js'

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
  return {
    name,
    agent: { session: { id: sessionId, header: { origin } } },
  }
}

console.log('checkChildBudget')
{
  // A child this plugin started carries the limit of its route.
  const budget = createChildBudget(5)
  registerChild(budget, 'child-1', 3)
  check('allows the first call', checkChildBudget(budget, execution('child-1', 'subagent', 'web_search')) === undefined)
  check('allows the second call', checkChildBudget(budget, execution('child-1', 'subagent', 'web_fetch')) === undefined)
  check('allows the third call', checkChildBudget(budget, execution('child-1', 'subagent', 'web_search')) === undefined)
  const denial = checkChildBudget(budget, execution('child-1', 'subagent', 'web_fetch'))
  check('denies the fourth call', denial !== undefined, denial)
  check('the denial names the limit', denial !== undefined && denial.includes('3 retrieval calls'))
}
{
  // A delegated child this plugin did not start is still charged, with the
  // default limit. A policy that binds only its own routes is not a policy.
  const budget = createChildBudget(2)
  check('allows the first call', checkChildBudget(budget, execution('other', 'subagent', 'web_search')) === undefined)
  check('allows the second call', checkChildBudget(budget, execution('other', 'subagent', 'web_search')) === undefined)
  const denial = checkChildBudget(budget, execution('other', 'subagent', 'web_search'))
  check('denies the third call', denial !== undefined, denial)
  check('the denial names the default limit', denial !== undefined && denial.includes('2 retrieval calls'))
}
{
  // The parent conversation is not a delegated child: it is not charged, and
  // the delegation routes are not what it uses to reach the web.
  const budget = createChildBudget(2)
  check('does not charge the parent', checkChildBudget(budget, execution('parent', 'user', 'web_search')) === undefined)
  check('does not charge the parent twice', checkChildBudget(budget, execution('parent', 'user', 'web_search')) === undefined)
}
{
  // A tool that is not a reading call is not charged. `read_page` pulls a page
  // into the child's context, so it is a reading call like the other two.
  const budget = createChildBudget(1)
  registerChild(budget, 'child-2', 1)
  check('does not charge a non-retrieval call', checkChildBudget(budget, execution('child-2', 'subagent', 'read')) === undefined)
  check('charges read_page as a reading call', checkChildBudget(budget, execution('child-2', 'subagent', 'read_page')) === undefined)
  check('denies the second reading call', checkChildBudget(budget, execution('child-2', 'subagent', 'web_fetch')) !== undefined)
}
{
  // A released child stops being charged.
  const budget = createChildBudget(5)
  registerChild(budget, 'child-3', 1)
  checkChildBudget(budget, execution('child-3', 'subagent', 'web_search'))
  releaseChildBudget(budget, 'child-3')
  check('forgets a released child', checkChildBudget(budget, execution('child-3', 'subagent', 'web_search')) === undefined)
}
{
  // Two children are accounted separately.
  const budget = createChildBudget(1)
  checkChildBudget(budget, execution('a', 'subagent', 'web_search'))
  check('the other child has its own allowance', checkChildBudget(budget, execution('b', 'subagent', 'web_search')) === undefined)
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
