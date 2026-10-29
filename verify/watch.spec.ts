/**
 * Regression tests for the child watcher.
 *
 * The watcher collects what a delegated child wrote — its reasoning and its
 * answer — and hands it to the extractor, which turns it into search terms.
 * The transcript is a working context, so it is cut at a limit; the tests
 * cover the cut and the text that says it happened.
 */

import { trimTranscript } from '../src/watch.js'

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

console.log('trimTranscript')
{
  const short = { reasoning: 'r'.repeat(100), content: 'c'.repeat(100) }
  const kept = trimTranscript(short, 8000)
  check('a short transcript is kept whole', kept.reasoning === short.reasoning)
  check('a short answer is kept whole', kept.content === short.content)

  const long = { reasoning: 'r'.repeat(10_000), content: 'c'.repeat(10_000) }
  const cut = trimTranscript(long, 1000)
  check('a long transcript is cut', cut.reasoning.length < long.reasoning.length)
  check('the reasoning is cut too', cut.content.length < long.content.length)
  check('the cut is announced in the reasoning', cut.reasoning.includes('[cut here]'))
  check('the cut is announced in the answer', cut.content.includes('[cut here]'))
  check('the cut keeps both kinds', cut.reasoning !== '' && cut.content !== '')

  const empty = trimTranscript({ reasoning: '', content: '' }, 100)
  check('an empty transcript stays empty', empty.reasoning === '' && empty.content === '')
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
