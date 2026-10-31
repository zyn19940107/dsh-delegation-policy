/**
 * Regression tests for the judgement gate.
 *
 * The gate makes the main agent's own classification unavoidable: a turn that
 * ends without one is pulled back, and a turn classified as a judgement may
 * not end before a delegated thought answered it. The tests cover the state
 * machine and the two refusals, because the refusals are the rule the agent
 * reads and the state machine is what decides whether it reads them.
 */

import { createClassifyFirstGuard, JudgementGate, parseClassifyArgs } from '../src/classify.js'

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

const gate = new JudgementGate()

// A turn that says nothing.
check('a fresh turn is not classified', gate.state('s1').classified === false)
check('a fresh turn has no verdict', gate.state('s1').verdict === false)
check('a fresh turn has not delegated', gate.state('s1').delegated === false)

// The agent classifies it as a judgement.
gate.markClassified('s1', true, 'it asks what we should do')
check('the classification is recorded', gate.state('s1').classified === true)
check('the verdict is recorded', gate.state('s1').verdict === true)
check('the reason is recorded', gate.state('s1').reason === 'it asks what we should do')

// The turn still has not delegated.
check('a classified turn has not delegated yet', gate.state('s1').delegated === false)

// A delegated thought answers it.
gate.markDelegated('s1')
check('the delegation is recorded', gate.state('s1').delegated === true)

// The turn passes the gate and is forgotten.
gate.clear('s1')
check('the turn is forgotten after it passes', gate.state('s1').classified === false)

// Pullbacks are counted, and a session's count is its own.
check('the first pullback is one', gate.pullback('s2') === 1)
check('the second pullback is two', gate.pullback('s2') === 2)
check('another session has its own count', gate.pullback('s3') === 1)
check('the count survives', gate.state('s2').pullbacks === 2)

// Two sessions do not share a verdict.
gate.markClassified('s4', true, 'judgement')
check('a second session is unaffected', gate.state('s5').classified === false)

// The classification is read out of the tool call.
const parsed = parseClassifyArgs({
  question: 'Should we use a queue or a stream?',
  judgement: true,
  reason: 'it asks which one to pick',
})
check('a well-formed call parses', parsed !== undefined)
check('the question is kept', parsed?.question === 'Should we use a queue or a stream?')
check('the verdict is kept', parsed?.judgement === true)
check('the reason is kept', parsed?.reason === 'it asks which one to pick')

check('a call without a question does not parse', parseClassifyArgs({ judgement: true }) === undefined)
check('a call without a verdict does not parse', parseClassifyArgs({ question: 'q' }) === undefined)
check('a call with a blank question does not parse', parseClassifyArgs({ question: '  ', judgement: true }) === undefined)
check('a missing reason is tolerated', parseClassifyArgs({ question: 'q', judgement: false })?.reason === '')

console.log('createClassifyFirstGuard')
{
  // A turn is classified before it is delegated: once a thought is on its way
  // the other tools are closed, so a delegation that skipped the classification
  // would leave the turn with neither.
  const state = new JudgementGate()
  const on = () => true
  const off = () => false
  const guard = createClassifyFirstGuard(state, on)
  check('refuses a thought before the turn is classified',
    guard(execution('d1', 'user', 'think_deep')) !== undefined)
  check('leaves the other tools alone', guard(execution('d1', 'user', 'search_web')) === undefined)
  state.markClassified('d1', true, 'it asks what we should do')
  check('allows a thought after the classification', guard(execution('d1', 'user', 'think_deep')) === undefined)
  check('leaves a child alone', guard(execution('d2', 'subagent', 'think_deep')) === undefined)
  const denial = guard(execution('d3', 'user', 'think_deep'))
  check('names the tool to call', denial !== undefined && denial.includes('classify_question'))
  check('says why the order matters', denial !== undefined && denial.includes('before you delegate'))
  // The rule belongs to the judgement gate: with the gate off, a turn may
  // delegate without classifying, because nothing asks it to classify.
  const relaxed = createClassifyFirstGuard(new JudgementGate(), off)
  check('the gate switch turns the rule off', relaxed(execution('d4', 'user', 'think_deep')) === undefined)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
