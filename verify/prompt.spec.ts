/**
 * Regression tests for the prompts the pipeline builds.
 *
 * The pipeline reasons first and grounds afterwards: the delegated child
 * reaches a conclusion on its own, a second child names the parts of it that
 * would have to be checked against an outside source, and the thinking child
 * then reconsiders with that material beside its own first conclusion. The
 * prompts carry the material across and tell the child to treat it as
 * material rather than as fact.
 */

import { buildThinkChildPrompt, composeThinkChildPrompt, formatThinkDeepOutput } from '../src/think.js'
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

console.log('composeThinkChildPrompt')
{
  // One delegated thought answered a question by writing a 400-line document
  // into the workspace; the parent then spent the turn finding and deleting it.
  // The answer is the whole deliverable, so the rules say so before the child
  // starts and the contract still closes the reply.
  const text = composeThinkChildPrompt(buildThinkChildPrompt('what should we do', undefined))
  check('says the turn is a question, not a job', text.includes('This is a question, not a job'))
  check('forbids writing files', text.includes('Do not create, edit, move or delete files'))
  check('forbids changing the workspace', text.includes('do not run a command that changes the workspace'))
  check('forbids handing back a document', text.includes('do not hand back a document'))
  check('still ends with the answer contract', text.includes('End your answer with exactly one fenced JSON block'))
  check('keeps the round prompt', text.includes('Think this through thoroughly: what should we do'))
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
  // A routed turn belongs to the delegated thought: the conversation's agent
  // presents the conclusion instead of dispatching the same work again.
  check('says a routed thought carries the whole turn', DELEGATION_GUIDANCE.includes('carries the whole turn'))
  check('forbids working after the thought', DELEGATION_GUIDANCE.includes('Do not search, read, edit'))
  check('says to present the delegated conclusion', DELEGATION_GUIDANCE.includes('Answer with its conclusion'))
  // The guidance used to describe a pipeline that runs the other way round —
  // retrieve first, then reason — and promised a subagent that refutes the
  // conclusion. The pipeline reasons first and grounds afterwards, and the
  // verifying child does not run by default.
  check('does not claim the knowledge comes first', !DELEGATION_GUIDANCE.includes('retrieves the external knowledge first'))
  check('does not promise a refuting subagent', !DELEGATION_GUIDANCE.includes('tries to refute'))
  check('states the order the pipeline runs in', DELEGATION_GUIDANCE.includes('reasons first'))
  // Every turn classifies its question: the gate pulls back a turn that ends
  // without one, whatever the question looks like.
  check('says every turn classifies', DELEGATION_GUIDANCE.includes('Every turn'))
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
