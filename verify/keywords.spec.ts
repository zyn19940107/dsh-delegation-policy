/**
 * Regression tests for the keyword extractor and the grounding pass.
 *
 * The extractor names the parts of a conclusion that would have to be checked
 * against an outside source. Its job is to be narrow: the list drives a
 * retrieval budget, so a long list turns one targeted search into a survey of
 * the subject.
 */

import {
  buildKeywordPrompt,
  buildKeywordSearchPrompt,
  projectKeywords,
} from '../src/keywords.js'
import { buildRethinkPrompt } from '../src/think.js'

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

console.log('buildKeywordPrompt')
{
  const prompt = buildKeywordPrompt(
    {
      reasoning: 'The child weighed the queue against the direct call and settled on the direct call.',
      content: 'TypeScript 4.9 was released in November 2022 and introduced satisfies.',
    },
    3,
  )
  check('carries the reasoning', prompt.includes('weighed the queue against the direct call'))
  check('carries the answer', prompt.includes('TypeScript 4.9 was released in November 2022'))
  check('says the child wrote none when it wrote none', buildKeywordPrompt({ reasoning: '', content: '' }, 3).includes('(it wrote none)'))
  check('states the maximum', prompt.includes('at most 3 search terms'))
  check('says a term is not the claim', prompt.includes('never the claim itself'))
  check('allows fewer than the maximum', prompt.includes('Return fewer terms than the maximum'))
  check('allows none', prompt.includes('return none when'))
}

console.log('buildKeywordSearchPrompt')
{
  const prompt = buildKeywordSearchPrompt(['TS 4.9 release date', 'satisfies operator'], 3)
  check('carries the first term', prompt.includes('TS 4.9 release date'))
  check('carries the second term', prompt.includes('satisfies operator'))
  check('states the budget', prompt.includes('3 retrieval calls'))
  check('accepts that nothing covers a term', prompt.includes('No source covers this'))
  check('asks not to fill the gap', prompt.includes('rather than filled in with an inference'))
}

console.log('projectKeywords')
{
  check('keeps the terms', projectKeywords({ keywords: ['a', 'b'] }, 3).keywords.length === 2)
  check('drops the terms past the maximum', projectKeywords({ keywords: ['a', 'b', 'c', 'd'] }, 3).keywords.length === 3)
  check('drops non-strings', projectKeywords({ keywords: ['a', 7, null] }, 3).keywords.length === 1)
  check('drops empty terms', projectKeywords({ keywords: ['a', '  '] }, 3).keywords.length === 1)
  check('survives a missing list', projectKeywords({}, 3).keywords.length === 0)
  check('survives nothing at all', projectKeywords(undefined, 3).keywords.length === 0)
  check('keeps the rationale', projectKeywords({ keywords: [], rationale: 'why' }, 3).rationale === 'why')
}

console.log('buildRethinkPrompt')
{
  const prompt = buildRethinkPrompt(
    'which TypeScript version',
    'the conclusion before the check',
    ['the point that carried it'],
    { answer: 'The source says otherwise.', sources: [{ url: 'https://example.test/a', title: 'A' }] },
  )
  check('carries the question', prompt.includes('which TypeScript version'))
  check('carries the first conclusion', prompt.includes('the conclusion before the check'))
  check('carries the key points', prompt.includes('the point that carried it'))
  check('carries the material', prompt.includes('The source says otherwise.'))
  check('carries the source', prompt.includes('https://example.test/a'))
  check('says the material is not fact', prompt.includes('not as established fact'))
  check('tells the child it is continuing its own thought', prompt.includes('the same thought you were already having'))
  check('says an unsettled point stays unsettled', prompt.includes('rather than choosing a side'))
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
