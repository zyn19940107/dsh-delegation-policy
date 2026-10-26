/**
 * Regression tests for the prompts the pipeline builds.
 *
 * The retrieval step is the pipeline's first step: the question is answered
 * from material a child gathered, not from what the model remembers. The
 * prompts carry that material into the thinking child, and they tell the child
 * to treat it as material rather than as fact.
 */

import { buildRetrievalPrompt } from '../src/search.js'
import { buildThinkChildPrompt } from '../src/think.js'
import { buildRefinePrompt } from '../src/verify.js'
import { DELEGATION_GUIDANCE } from '../src/index.js'

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

console.log('buildRetrievalPrompt')
{
  const prompt = buildRetrievalPrompt('does the widget support mode X', 'the version that added it', 3)
  check('carries the question', prompt.includes('does the widget support mode X'))
  check('carries the focus', prompt.includes('the version that added it'))
  check('states the reading budget', prompt.includes('3 retrieval calls'))
  check('asks for material, not a conclusion', prompt.includes('not a recommendation and not a conclusion'))
  check('names the search tool', prompt.includes('web_search'))
}

console.log('buildThinkChildPrompt')
{
  const plain = buildThinkChildPrompt('what should we do', undefined, 5)
  check('has no retrieval section without material', !plain.includes('External knowledge'))
  check('still asks for the structured result', plain.includes('structured_output'))
}
{
  const prompt = buildThinkChildPrompt('what should we do', 'the migration order', 5, {
    answer: 'The widget shipped mode X in 4.2.',
    sources: [{ url: 'https://example.test/rel', title: 'Release notes' }],
  })
  check('carries the retrieved material', prompt.includes('The widget shipped mode X in 4.2.'))
  check('carries the source', prompt.includes('https://example.test/rel'))
  check('says the material is not fact', prompt.includes('not as established fact'))
  check('keeps the conversation instruction', prompt.includes('full context of this conversation'))
}

console.log('buildRefinePrompt')
{
  const prompt = buildRefinePrompt(
    'what should we do',
    'the old conclusion',
    ['the source does not say that'],
    [{ url: 'https://example.test/a', title: 'A' }],
    { answer: 'The source says otherwise.', sources: [{ url: 'https://example.test/b' }] },
  )
  check('carries the objections', prompt.includes('the source does not say that'))
  check('carries the reviewer evidence', prompt.includes('https://example.test/a'))
  check('carries the retrieved material', prompt.includes('The source says otherwise.'))
  check('carries the retrieved source', prompt.includes('https://example.test/b'))
  check('asks for a corrected conclusion', prompt.includes('corrected conclusion'))
}

console.log('DELEGATION_GUIDANCE')
{
  check('says the agent reaches for delegation on its own', DELEGATION_GUIDANCE.includes('Reach for these on your own'))
  check('names the judgement trigger', DELEGATION_GUIDANCE.includes('asks for a judgement'))
  check('separates a judgement from the work around it', DELEGATION_GUIDANCE.includes('is two tasks'))
  check('says a continuous edit is not a reason to reason inside it', DELEGATION_GUIDANCE.includes('not a reason to reason inside'))
  // The exemption that was read too widely: it covered the whole task instead
  // of the edit, and a model used it to reason inside a continuous edit.
  check('drops the over-broad exemption wording', !DELEGATION_GUIDANCE.includes('split up a continuous edit'))
  check('keeps the fragment exemption, scoped to the edit', DELEGATION_GUIDANCE.includes('break one continuous edit into fragments'))
  // A model that had decided a fact was external answered "let me check the
  // delegation policy" instead of dispatching the search, and the turn was
  // interrupted there. The rules now say where they are, and that a decided
  // fact goes to the search now.
  check('says the rules are the whole of it', DELEGATION_GUIDANCE.includes('These are the rules for delegation'))
  check('forbids going looking for the rules', DELEGATION_GUIDANCE.includes('Do not go looking for them elsewhere'))
  check('names the plugin source as a place not to look', DELEGATION_GUIDANCE.includes("not in this plugin's source"))
  check('says a decided external fact is dispatched now', DELEGATION_GUIDANCE.includes('dispatch the search now'))
  check('scopes the read exemption to answering the question', DELEGATION_GUIDANCE.includes('answers the question on its own'))
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
