/**
 * Regression tests for the delegation projections.
 *
 * The defect these cover: the driver reports a run as an error when a child
 * that was asked for a structured result did not deliver one, even when the
 * child's turn completed cleanly — and it reports the child's answer in the
 * output regardless. A projection that judged the stop reason before reading
 * the output threw away a finished deliberation.
 *
 * Run: node verify/run-specs.mjs
 */

import {
  normalizeEvidence,
  projectSearchResult,
  projectThinkResult,
  projectVerdict,
  readFinalText,
  type DelegatedResult,
} from '../src/project.js'

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
  failures++
  console.log(`  FAIL ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

/**
 * A run whose child answered in prose, with the driver's error stop reason.
 *
 * @param text - the child's answer.
 * @returns the result shape.
 */
function proseResult(text: string): DelegatedResult {
  return {
    structured: undefined,
    output: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text }],
    stopReason: 'error',
  }
}

console.log('readFinalText')
check('joins text blocks', readFinalText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]) === 'a\n\nb')
check('skips reasoning blocks', readFinalText([{ type: 'reasoning', text: 'x' }, { type: 'text', text: 'y' }]) === 'y')
check('tolerates a non-array', readFinalText(undefined) === '')

console.log('projectThinkResult')
{
  const structured = projectThinkResult({
    structured: { conclusion: 'C', keyPoints: ['k1', 'k2'], assumptions: ['a'], risks: ['r'] },
    output: [],
    stopReason: 'completed',
  })
  check('reads the structured value', structured.conclusion === 'C' && structured.keyPoints.length === 2)
  check('reads the optional lists', structured.assumptions[0] === 'a' && structured.risks[0] === 'r')
}
{
  // The defect: a child that answered in prose, with the driver reporting an
  // error because no structured value was captured.
  const projected = projectThinkResult(proseResult('the answer in prose'))
  check('keeps a prose answer', projected.conclusion === 'the answer in prose')
  check('leaves the lists empty', projected.keyPoints.length === 0 && projected.risks.length === 0)
}
{
  let thrown: unknown
  try {
    projectThinkResult({ structured: undefined, output: [], stopReason: 'error', diagnostic: 'boom' })
  } catch (error) {
    thrown = error
  }
  check('throws when there is nothing at all', thrown instanceof Error)
  check('reports the stop reason', String(thrown).includes('"error"'))
  check('reports the diagnostic', String(thrown).includes('boom'))
}

console.log('projectSearchResult')
{
  const projected = projectSearchResult({
    structured: {
      answer: 'A',
      sources: [
        { url: 'https://a.example', title: 'A', snippet: 'x'.repeat(500) },
        { url: 'https://a.example', title: 'duplicate' },
        { url: 'https://b.example' },
      ],
    },
    output: [],
    stopReason: 'completed',
  }, 5, 100)
  check('reads the answer', projected.answer === 'A')
  check('drops repeated urls', projected.sources.length === 2)
  check('caps the excerpt', projected.sources[0]?.snippet?.length === 100)
}
{
  const projected = projectSearchResult(proseResult('prose answer'), 5, 100)
  check('keeps a prose answer', projected.answer === 'prose answer')
  check('reports no sources', projected.sources.length === 0)
}
{
  let thrown: unknown
  try {
    projectSearchResult({ structured: undefined, output: [], stopReason: 'aborted' }, 5, 100)
  } catch (error) {
    thrown = error
  }
  check('throws when the run produced nothing', thrown instanceof Error)
}

console.log('projectVerdict')
{
  const projected = projectVerdict({
    structured: { verdict: 'confirmed', problems: [], evidence: [{ url: 'https://a.example', title: 'A' }] },
    output: [],
    stopReason: 'completed',
  })
  check('confirms a clean verdict', projected.verdict === 'confirmed')
  check('reads the evidence', projected.evidence.length === 1)
}
{
  // A verdict that says confirmed while listing problems is a contradiction;
  // the problems win.
  const projected = projectVerdict({
    structured: { verdict: 'confirmed', problems: ['the corn part is unsupported'], evidence: [] },
    output: [],
    stopReason: 'completed',
  })
  check('treats problems as a conflict', projected.verdict === 'conflict')
  check('keeps the problems', projected.problems.length === 1)
}
{
  const projected = projectVerdict({
    structured: { verdict: 'conflict', problems: ['p1', 'p2'], evidence: [] },
    output: [],
    stopReason: 'completed',
  })
  check('reports a conflict', projected.verdict === 'conflict')
  check('keeps every problem', projected.problems.length === 2)
}
{
  // A verifier that answered in prose delivered no verdict. That is not a
  // confirmation: it is reported as a conflict with the prose as the problem.
  const projected = projectVerdict(proseResult('the conclusion overstates the source'))
  check('treats a prose verdict as a conflict', projected.verdict === 'conflict')
  check('keeps the prose as the problem', projected.problems[0] === 'the conclusion overstates the source')
}
{
  let thrown: unknown
  try {
    projectVerdict({ structured: undefined, output: [], stopReason: 'error' })
  } catch (error) {
    thrown = error
  }
  check('throws when the verifier produced nothing', thrown instanceof Error)
}

console.log('normalizeEvidence')
check('drops an entry without a url', normalizeEvidence({ evidence: [{ title: 'no url' }] }).length === 0)
check('keeps a url entry', normalizeEvidence({ evidence: [{ url: 'https://a.example' }] }).length === 1)

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
