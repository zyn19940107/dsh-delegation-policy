/**
 * Regression tests for keeping the pipeline from searching twice.
 *
 * The delegated child cannot retrieve: the web guard refuses it every
 * page-fetching tool, so the pipeline never has to reconcile the child's own
 * lookups against its own. These tests hold that line — the extractor reports
 * terms only, and the second round is handed the material the grounding pass
 * brought back rather than a list of lookups that never happens.
 */

import { projectKeywords } from '../src/keywords.js'
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

console.log('projectKeywords')
{
  const projected = projectKeywords({
    keywords: ['MySQL partitioning foreign keys'],
    rationale: 'why',
  }, 3)
  check('keeps the terms', projected.keywords.length === 1)
  check('keeps the rationale', projected.rationale === 'why')
  check('reports no lookups of its own', !('alreadySearched' in projected))
  check('ignores a lookups field the extractor no longer sends',
    projectKeywords({ keywords: [], alreadySearched: ['a'] }, 3).keywords.length === 0)
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
  check('carries the sources', prompt.includes('The source says otherwise.'))
  check('says nothing about a list of lookups', !prompt.includes('already looked up'))
  check('says nothing about looking up again', !prompt.includes('do not look it up again'))
}

if (failures > 0) {
  console.error(`\\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\\nall checks passed')
