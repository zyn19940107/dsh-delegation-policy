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
 * itself, and it covers every child this plugin started that reads.
 */

import { checkChildBudget, createChildBudget, DEFAULT_WEB_TOOLS, registerChild, releaseChildBudget } from '../src/guard.js'

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

/** The tools that reach the network, as the plugin reads them. */
const webTools = (): readonly string[] => DEFAULT_WEB_TOOLS

console.log('checkChildBudget')
{
  // A child this plugin started carries the limit of its route.
  const budget = createChildBudget()
  registerChild(budget, 'child-1', 3)
  check('allows the first call', checkChildBudget(budget, execution('child-1', 'subagent', 'web_search'), webTools) === undefined)
  check('allows the second call', checkChildBudget(budget, execution('child-1', 'subagent', 'web_fetch'), webTools) === undefined)
  check('allows the third call', checkChildBudget(budget, execution('child-1', 'subagent', 'web_search'), webTools) === undefined)
  const denial = checkChildBudget(budget, execution('child-1', 'subagent', 'web_fetch'), webTools)
  check('denies the fourth call', denial !== undefined, denial)
  check('the denial names the limit', denial !== undefined && denial.includes('3 retrieval calls'))
}
{
  // A child some other route started is not charged: it may not read at all,
  // because the web guard refuses every tool that reaches the network to a
  // child that only reasons. There is no allowance to spend.
  const budget = createChildBudget()
  check('does not charge an unregistered child', checkChildBudget(budget, execution('other', 'subagent', 'web_search'), webTools) === undefined)
  check('does not charge it twice either', checkChildBudget(budget, execution('other', 'subagent', 'web_search'), webTools) === undefined)
}
{
  // The parent conversation is not a delegated child: it is not charged, and
  // the delegation routes are not what it uses to reach the web.
  const budget = createChildBudget()
  check('does not charge the parent', checkChildBudget(budget, execution('parent', 'user', 'web_search'), webTools) === undefined)
  check('does not charge the parent twice', checkChildBudget(budget, execution('parent', 'user', 'web_search'), webTools) === undefined)
}
{
  // A tool that is not a reading call is not charged. `read_page` and
  // `x_search` pull a page into the child's context, so they are reading
  // calls like the other two.
  const budget = createChildBudget()
  registerChild(budget, 'child-2', 1)
  check('does not charge a non-retrieval call', checkChildBudget(budget, execution('child-2', 'subagent', 'read'), webTools) === undefined)
  check('charges read_page as a reading call', checkChildBudget(budget, execution('child-2', 'subagent', 'read_page'), webTools) === undefined)
  check('denies the second reading call', checkChildBudget(budget, execution('child-2', 'subagent', 'web_fetch'), webTools) !== undefined)
}
{
  // x_search reaches the network, so it is charged like any other reading call.
  const budget = createChildBudget()
  registerChild(budget, 'child-x', 1)
  check('charges x_search as a reading call', checkChildBudget(budget, execution('child-x', 'subagent', 'x_search'), webTools) === undefined)
  check('denies the call after it', checkChildBudget(budget, execution('child-x', 'subagent', 'x_search'), webTools) !== undefined)
}
{
  // A deployment that names another network tool in its configuration gets it
  // charged too.
  const budget = createChildBudget()
  registerChild(budget, 'child-c', 1)
  const configured = (): readonly string[] => ['web_search', 'browse']
  check('charges a configured web tool', checkChildBudget(budget, execution('child-c', 'subagent', 'browse'), configured) === undefined)
  check('does not charge a tool outside the configuration', checkChildBudget(budget, execution('child-c', 'subagent', 'x_search'), configured) === undefined)
}
{
  // A released child stops being charged.
  const budget = createChildBudget()
  registerChild(budget, 'child-3', 1)
  checkChildBudget(budget, execution('child-3', 'subagent', 'web_search'), webTools)
  releaseChildBudget(budget, 'child-3')
  check('forgets a released child', checkChildBudget(budget, execution('child-3', 'subagent', 'web_search'), webTools) === undefined)
}
{
  // Two children are accounted separately.
  const budget = createChildBudget()
  registerChild(budget, 'a', 1)
  checkChildBudget(budget, execution('a', 'subagent', 'web_search'), webTools)
  check('the other child has its own allowance', checkChildBudget(budget, execution('b', 'subagent', 'web_search'), webTools) === undefined)
}

console.log(failures === 0 ? '\\nall checks passed' : `\\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
