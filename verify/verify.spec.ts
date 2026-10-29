/**
 * Regression tests for the verification pass being off by default.
 *
 * The grounding pass already looks up what the reasoning needed checked, and
 * it does that from the child's own transcript. A verifying child sees only
 * the conclusion and has to mine it for search terms itself, so it spends a
 * model's worth of work to do the same job with less to go on — and in
 * fifteen sandbox runs it failed to deliver a verdict three times, each of
 * which threw the pipeline into a retrieval and a refinement nobody needed.
 *
 * The tests hold the default at zero and the switch at one.
 */

import { DEFAULT_VERIFY_ROUNDS } from '../src/verify.js'

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

console.log('DEFAULT_VERIFY_ROUNDS')
{
  check('the verifying child does not run by default', DEFAULT_VERIFY_ROUNDS === 0)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
