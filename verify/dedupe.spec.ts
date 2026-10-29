/**
 * Regression tests for keeping the pipeline from searching twice.
 *
 * The delegated child may do its own retrieval while it reasons, and those
 * lookups live in the child's session, where the parent cannot see them. The
 * extractor reports them; the pipeline then drops the terms that name the
 * same lookup and hands the list to the next round, which is told not to
 * search it again.
 *
 * A run in the sandbox searched one point — whether MySQL's partitioning and
 * foreign keys are compatible — six times in seven minutes, because the
 * second round of reasoning did not know what the first one had already
 * found. These tests hold the two halves of the fix: the terms are dropped,
 * and the list reaches the next round.
 */

import { dropAlreadySearched, projectKeywords } from '../src/keywords.js'
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
    alreadySearched: ['MySQL 8.0 partitioned table restrictions foreign keys'],
  }, 3)
  check('keeps the terms', projected.keywords.length === 1)
  check('keeps the rationale', projected.rationale === 'why')
  check('keeps what was already searched', projected.alreadySearched.length === 1)
  check('survives a missing list', projectKeywords({}, 3).alreadySearched.length === 0)
}

console.log('dropAlreadySearched')
{
  const already = ['MySQL 8.0 partitioned InnoDB table restrictions foreign keys unique keys']
  check('drops the same lookup', dropAlreadySearched(
    ['MySQL partitioning foreign key restrictions'], already,
  ).length === 0)
  check('drops a rephrasing', dropAlreadySearched(
    ['MySQL foreign keys partitioned tables restrictions'], already,
  ).length === 0)
  check('keeps a different lookup', dropAlreadySearched(
    ['PostgreSQL logical replication lag'], already,
  ).length === 1)
  check('keeps everything when nothing was searched', dropAlreadySearched(
    ['anything'], [],
  ).length === 1)
  check('does not mutate the input', (() => {
    const terms = ['a', 'b']
    dropAlreadySearched(terms, ['a'])
    return terms.length === 2 && terms[0] === 'a'
  })())
}

console.log('buildRethinkPrompt')
{
  const prompt = buildRethinkPrompt(
    'which TypeScript version',
    'the conclusion before the check',
    ['the point that carried it'],
    { answer: 'The source says otherwise.', sources: [{ url: 'https://example.test/a', title: 'A' }] },
    ['MySQL partitioning foreign keys'],
  )
  check('carries the question', prompt.includes('which TypeScript version'))
  check('carries the sources', prompt.includes('The source says otherwise.'))
  check('lists what was already looked up', prompt.includes('MySQL partitioning foreign keys'))
  check('says not to look it up again', prompt.includes('do not look it up again'))
  check('says an unsettled point stays unsettled', prompt.includes('still unsettled'))
}

{
  const prompt = buildRethinkPrompt(
    'which TypeScript version',
    'the conclusion before the check',
    [],
    { answer: 'The source says otherwise.', sources: [] },
  )
  check('says nothing about a list when there is none', !prompt.includes('already looked up'))
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
