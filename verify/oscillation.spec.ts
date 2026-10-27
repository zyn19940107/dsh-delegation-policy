/**
 * Regression tests for the self-revision counter.
 *
 * The counter watches the stream for a model that keeps revising the same
 * point. It is a measurement, not a diagnosis: the markers it looks for appear
 * in honest self-correction too, which is why nothing is acted on.
 *
 * The marker list is narrow on purpose: measured on recorded turns, a list that
 * counted "actually" wherever it appeared scored 34 markers on an ordinary turn
 * and 54 on the turn that was going in circles — too close to tell apart.
 */

import { countCorrectionMarkers, OscillationTracker } from '../src/oscillation.js'

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

console.log('countCorrectionMarkers')
{
  check('counts a revision', countCorrectionMarkers('Wait, that is not right') === 1)
  check('counts a Chinese revision', countCorrectionMarkers('等等，这个不对') === 2)
  check('counts each occurrence', countCorrectionMarkers('Wait, wait, wait — hmm wait') === 4)
  check('ignores ordinary text', countCorrectionMarkers('The answer is 42, plainly.') === 0)
  check('ignores "actually" as an adverb', countCorrectionMarkers('which models are actually configured') === 0)
  check('ignores "其实" as an aside', countCorrectionMarkers('其实这个产品还在维护') === 0)
  check('counts "actually" only when it revises', countCorrectionMarkers('Actually, that is not right') === 0)
}

console.log('OscillationTracker')
{
  const tracker = new OscillationTracker()
  tracker.observe('a', 1, 'Wait, that is ')
  const second = tracker.observe('a', 1, 'not right. Let me reconsider.')
  check('counts revisions across chunks', second.count === 2, `count=${second.count}`)
  check('does not report over the threshold yet', second.overThreshold === false)
}
{
  // A marker split across two chunks is found once, not twice.
  const tracker = new OscillationTracker()
  tracker.observe('a', 1, 'the price is 42. Wa')
  const second = tracker.observe('a', 1, 'it, it is 43.')
  check('finds a marker split across chunks', second.count === 1, `count=${second.count}`)
}
{
  // The same marker wholly inside the carried tail is not counted twice.
  const tracker = new OscillationTracker()
  tracker.observe('a', 1, '等等, 等等, 等等, 等等, 等等, 等等, ')
  const second = tracker.observe('a', 1, 'and more text here')
  check('does not count the carry twice', second.count === 6, `count=${second.count}`)
}
{
  // A new turn starts from zero.
  const tracker = new OscillationTracker()
  tracker.observe('a', 1, 'Wait, let me reconsider')
  const next = tracker.observe('a', 2, 'a clean sentence')
  check('resets on a new turn', next.count === 0, `count=${next.count}`)
}
{
  // Two agents are counted apart.
  const tracker = new OscillationTracker()
  tracker.observe('a', 1, 'Wait')
  const other = tracker.observe('b', 1, '不对')
  check('keeps agents apart', other.count === 1, `count=${other.count}`)
}
{
  // The threshold crossing is reported once per turn.
  const tracker = new OscillationTracker()
  tracker.observe('a', 1, 'Wait,')
  tracker.observe('a', 1, '不对')
  tracker.observe('a', 1, '等等')
  check('claims the report once', tracker.claimReport('a', 1) === true)
  check('does not claim it twice', tracker.claimReport('a', 1) === false)
  const reading = tracker.reading('a', 3)
  check('reports the count', reading.count === 3, `count=${reading.count}`)
  check('reports the threshold', reading.overThreshold === true)
}
{
  const tracker = new OscillationTracker()
  const reading = tracker.reading('unknown', 3)
  check('an unknown agent has no reading', reading.count === 0 && reading.overThreshold === false)
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
