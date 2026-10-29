/**
 * Regression tests for the prompts the pipeline builds.
 *
 * The retrieval step is the pipeline's first step: the question is answered
 * from material a child gathered, not from what the model remembers. The
 * prompts carry that material into the thinking child, and they tell the child
 * to treat it as material rather than as fact.
 */

import { buildThinkChildPrompt, formatThinkDeepOutput } from '../src/think.js'
import { buildRefinePrompt, buildConflictSearchPrompt } from '../src/verify.js'
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

console.log('buildThinkChildPrompt')
{
  const plain = buildThinkChildPrompt('what should we do', undefined)
  check('has no retrieval section', !plain.includes('External knowledge'))
  check('no longer asks for structured_output', !plain.includes('structured_output'))
  // The child is not invited to go looking. It keeps its tools, but the
  // prompt does not hand it a reading budget to spend.
  check('offers no retrieval budget', !plain.includes('retrieval calls'))
  check('says the retrieval is not its task', plain.includes('the retrieval is not your task'))
}
{
  const prompt = buildThinkChildPrompt('what should we do', 'the migration order')
  check('keeps the conversation instruction', prompt.includes('full context of this conversation'))
  check('carries no retrieval material of its own', !prompt.includes('External knowledge'))
  check('does not offer a reading budget', !prompt.includes('reading budget'))
}

console.log('formatThinkDeepOutput')
{
  const text = formatThinkDeepOutput({
    conclusion: 'Use the queue only for the slow consumers.',
    keyPoints: ['the slow consumer sets the need'],
    assumptions: ['the traffic is bursty'],
    risks: ['the queue adds a failure mode'],
  })
  check('carries the conclusion', text.includes('Use the queue only for the slow consumers.'))
  check('carries the key points', text.includes('the slow consumer sets the need'))
  check('carries the assumptions', text.includes('the traffic is bursty'))
  check('carries the risks', text.includes('the queue adds a failure mode'))
  // The knowledge the pipeline retrieved stays inside the pipeline. The parent
  // receives the delegated answer, not a second copy of the corpus.
  check('does not hand the parent a retrieved corpus', !text.includes('Retrieved for those points'))
  check('does not list the search terms', !text.includes('Checked against sources for'))
  check('tells the parent to answer with it', text.includes('Answer the user with it'))
}

console.log('buildConflictSearchPrompt')
{
  const prompt = buildConflictSearchPrompt([
    'the conclusion says the clip grips the cob at both ends; no source describes two arms',
    'the claim that the spacing is fixed is unsupported',
  ], 2)
  check('carries the first problem', prompt.includes('grips the cob at both ends'))
  check('carries the second problem', prompt.includes('the spacing is fixed is unsupported'))
  check('asks for those points only', prompt.includes('Look up ONLY those parts'))
  check('states the budget', prompt.includes('2 retrieval calls'))
  check('accepts that the record settles nothing', prompt.includes('does not settle this'))
  check('asks not to fill the gap with an inference', prompt.includes('not filled in with an inference'))
}

console.log('buildRefinePrompt')
{
  const prompt = buildRefinePrompt(
    'what should we do',
    'the old conclusion',
    ['the source does not say that'],
    [{ url: 'https://example.test/a', title: 'A' }],
    { answer: 'The record does not settle this.', sources: [{ url: 'https://example.test/c' }] },
  )
  check('carries the objections', prompt.includes('the source does not say that'))
  check('carries the reviewer evidence', prompt.includes('https://example.test/a'))
  check('carries the conflict material', prompt.includes('The record does not settle this.'))
  check('carries the conflict source', prompt.includes('https://example.test/c'))
  check('says the material is not fact', prompt.includes('not as established fact'))
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
