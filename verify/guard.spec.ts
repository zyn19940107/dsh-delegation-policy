/**
 * Regression tests for the web guard.
 *
 * The guard refuses the tools that can pull a page into the parent
 * conversation. It used to refuse only `web_search`, and a model answered
 * "what does this page say" by fetching it directly: the page landed in the
 * conversation that the delegation exists to keep clean. The subagent reads the
 * pages; the parent gets the answer.
 */

import { createWebGuard, PARENT_DENIED_WEB_TOOLS } from '../src/guard.js'

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
  const guard = createWebGuard()
  check('refuses web_search in the parent', guard(execution('p', 'user', 'web_search')) !== undefined)
  check('refuses web_fetch in the parent', guard(execution('p', 'user', 'web_fetch')) !== undefined)
  check('refuses read_page in the parent', guard(execution('p', 'user', 'read_page')) !== undefined)
  check('leaves other tools alone', guard(execution('p', 'user', 'read')) === undefined)
  check('leaves a local file read alone', guard(execution('p', 'user', 'ops_read_files')) === undefined)
}
{
  const guard = createWebGuard()
  check('allows a delegated child to search', guard(execution('c', 'subagent', 'web_search')) === undefined)
  check('allows a delegated child to fetch', guard(execution('c', 'subagent', 'web_fetch')) === undefined)
  check('allows a delegated child to read a page', guard(execution('c', 'subagent', 'read_page')) === undefined)
}
{
  const guard = createWebGuard()
  const denial = guard(execution('p', 'user', 'web_fetch'))
  check('points the caller at search_web', denial !== undefined && denial.includes('search_web'))
  check('names the tool it refused', denial !== undefined && denial.includes('web_fetch'))
}
{
  check('the denied set covers the search', PARENT_DENIED_WEB_TOOLS.includes('web_search'))
  check('the denied set covers the fetch', PARENT_DENIED_WEB_TOOLS.includes('web_fetch'))
  check('the denied set covers the page reader', PARENT_DENIED_WEB_TOOLS.includes('read_page'))
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
