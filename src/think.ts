/**
 * The `think_deep` route: long reasoning, delegated to a child that inherits
 * this conversation.
 *
 * The fork provider seeds the child with the parent's completed-turn prefix, so
 * the child reasons over everything established here without a relay prompt.
 * Its reasoning stays in the child's session; the parent receives a structured
 * conclusion.
 *
 * @module @local/dsh-delegation-policy/think
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { registerChild, releaseChildBudget, type ChildBudget } from './guard.js'
import { delegateSearch, type SearchConfig } from './search.js'
import {
  buildKeywordSearchPrompt,
  dropAlreadySearched,
  runKeywordExtractor,
  type KeywordConfig,
} from './keywords.js'
import { buildConflictSearchPrompt, buildRefinePrompt, runVerifier } from './verify.js'
import { trimTranscript, watchChildStream, type WatchedTranscript } from './watch.js'

/** Provider that runs the thinking child. */
export const DEFAULT_THINK_PROVIDER = 'fork'

/** Default number of retrieval calls the thinking child may make. */
export const DEFAULT_MAX_THINK_CALLS = 5

/** Default number of retrieval calls the retrieving child may make. */
export const DEFAULT_RETRIEVE_MAX_CHILD_CALLS = 3

/**
 * Default retrieval calls a pass aimed at the contradictions may make.
 *
 * The pass looks up the specific points a reviewer could not support, so it needs
 * far fewer calls than a first pass over the subject.
 */
export const DEFAULT_CONFLICT_SEARCH_CALLS = 2

/**
 * Default budget for one delegated thought. The child inherits the parent's
 * history and reasons over it, so its budget covers a whole extended turn
 * rather than a single call.
 */
export const DEFAULT_THINK_TIMEOUT_MS = 900_000

/**
 * The structured result the thinking child delivers. The child calls the
 * runtime's `structured_output` tool with this schema; the driver validates
 * the value and hands it back as the run's structured result.
 */
export const THINK_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  // Only the conclusion is required. A child that reports fewer sections is
  // still a usable answer; the missing ones read as empty.
  required: ['conclusion'],
  properties: {
    conclusion: {
      type: 'string',
      description: 'The recommended answer, stated directly.',
    },
    keyPoints: {
      type: 'array',
      description: 'The points that carry the conclusion.',
      items: { type: 'string' },
    },
    assumptions: {
      type: 'array',
      description: 'What the conclusion rests on that could be wrong.',
      items: { type: 'string' },
    },
    risks: {
      type: 'array',
      description: 'What would make the conclusion fail, and when.',
      items: { type: 'string' },
    },
  },
}

/** Model-facing `think_deep` arguments. */
interface ThinkDeepArgs {
  task: string
  focus?: string
  verify?: boolean
}

/** What the pipeline retrieved before the thinking started. */
export interface RetrievedKnowledge {
  answer: string
  sources: { url: string, title?: string }[]
}

/** What the verification passes found. */
export interface ThinkVerification {
  rounds: number
  verdict: 'confirmed' | 'conflict'
  problems: string[]
  evidence: { url: string, title?: string, snippet?: string }[]
}

/**
 * The canonical `think_deep` output value.
 *
 * What the parent receives is the second round's reasoning. The knowledge the
 * pipeline retrieved along the way stays inside the pipeline: it was gathered
 * to change the thinking, and handing it to the parent as well would give the
 * parent a corpus it did not ask for and a second account of the same facts.
 */
interface ThinkDeepOutput {
  conclusion: string
  keyPoints: string[]
  assumptions: string[]
  risks: string[]
  verification?: ThinkVerification
}

/** Thinking route configuration. */
export interface ThinkConfig {
  provider: string
  maxChildCalls: number
  timeoutMs: number
  verifyRounds: number
  verifyProvider: string
  verifyTimeoutMs: number
  /** Retrieval calls a pass aimed at the contradictions may make. */
  conflictSearchCalls: number
  /** The extractor that names what a conclusion would have to be checked against. */
  keywords: KeywordConfig
  /** Retrieval calls the grounding pass may make. */
  keywordSearchCalls: number
  /** How much of the delegated child's transcript the extractor is given. */
  watchMaxChars: number
  search: SearchConfig
}

/**
 * Validate the model's arguments.
 *
 * @param args - the schema-validated arguments.
 * @returns the accepted arguments.
 */
export function parseThinkDeepArgs(args: ThinkDeepArgs): ThinkDeepArgs {
  if (typeof args.task !== 'string' || args.task.trim().length === 0) {
    throw new Error('task must be a non-empty string')
  }
  return {
    task: args.task,
    ...args.focus !== undefined ? { focus: args.focus } : {},
    ...args.verify !== undefined ? { verify: args.verify } : {},
  }
}

/**
 * Build the instruction for the second pass over a conclusion.
 *
 * The first conclusion was reached by reasoning; the grounding pass looked up
 * what in it would have to be checked against a source. This prompt puts that
 * material beside the conclusion and asks for the conclusion to be reconsidered
 * with it, which is what "rethink" means here: the same question, the same
 * conclusion, and the external knowledge that was missing.
 *
 * @param task - the question being answered.
 * @param conclusion - the conclusion the grounding pass was aimed at.
 * @param keyPoints - the points that carry it.
 * @param retrieved - what the grounding pass found.
 * @returns the second-pass instruction.
 */
export function buildRethinkPrompt(
  task: string,
  conclusion: string,
  keyPoints: readonly string[],
  retrieved: { answer: string, sources: { url: string, title?: string }[] },
  alreadySearched: readonly string[] = [],
): string {
  return [
    'You reached the conclusion below by reasoning about a question. Parts of it would have to be '
    + 'checked against an outside source, and that check has now been done. Reconsider the conclusion '
    + 'with what the sources say, and deliver the conclusion you can stand behind now.',
    '',
    'The question being answered:',
    task,
    '',
    'The conclusion you reached:',
    conclusion,
    '',
    ...keyPoints.length > 0
      ? ['The points that carried it:', ...keyPoints.map((point) => `- ${point}`), '']
      : [],
    ...alreadySearched.length > 0
      ? [
        'What has already been looked up — do not look it up again:',
        ...alreadySearched.map((item) => `- ${item}`),
        'Anything here that the material below does not settle is still unsettled. Do not go and search '
        + 'it a second time; say that it is unsettled.',
        '',
      ]
      : [],
    'What the sources say:',
    '---',
    retrieved.answer,
    ...retrieved.sources.length > 0
      ? [`Sources: ${retrieved.sources.map((source) => (source.title === undefined ? source.url : `[${source.title}](${source.url})`)).join(', ')}`]
      : [],
    '---',
    'Treat it as retrieved material, not as established fact. Where it contradicts what you concluded, '
    + 'the conclusion changes and the reason is stated. Where the sources do not settle a point, say '
    + 'so in the conclusion rather than choosing a side.',
    'This is the same thought you were already having: you have the conclusion you reached and the '
    + 'material the check brought back. Revise where it is wrong and keep what still stands.',
  ].join('\n')
}

/**
 * Format the parent's view of one delegated thought.
 *
 * @param value - the canonical output value.
 * @returns the model-facing text.
 */
export function formatThinkDeepOutput(value: ThinkDeepOutput): string {
  const parts: string[] = []
  if (value.conclusion.length > 0) parts.push(value.conclusion)
  if (value.keyPoints.length > 0) {
    parts.push(`Key points:\n${value.keyPoints.map((point) => `- ${point}`).join('\n')}`)
  }
  if (value.assumptions.length > 0) {
    parts.push(`Assumptions:\n${value.assumptions.map((item) => `- ${item}`).join('\n')}`)
  }
  if (value.risks.length > 0) {
    parts.push(`Risks:\n${value.risks.map((item) => `- ${item}`).join('\n')}`)
  }
  if (value.verification !== undefined) {
    const { rounds, verdict, problems, evidence } = value.verification
    const head = verdict === 'confirmed'
      ? `Verified against ${evidence.length} source(s) over ${rounds} pass(es): no unsupported part found.`
      : `Verification found ${problems.length} unsupported part(s) over ${rounds} pass(es).`
    const lines = [head]
    if (problems.length > 0) {
      lines.push(`Problems:\n${problems.map((problem) => `- ${problem}`).join('\n')}`)
    }
    if (evidence.length > 0) {
      lines.push(`Verification sources:\n${
        evidence.map((item) => `- [${item.title ?? item.url}](${item.url})`).join('\n')
      }`)
    }
    parts.push(lines.join('\n'))
  }
  parts.push(
    'This is the delegated answer, already reasoned over and checked. Answer the user with it: '
    + 'state the conclusion as your own answer, and keep the key points, the assumptions and the '
    + 'risks as they are given.',
  )
  return parts.join('\n\n')
}

/**
 * Build the thinking child's instruction. The child is told to deliver a
 * conclusion, not a transcript of its own reasoning.
 *
 * When the pipeline retrieved external knowledge before the thinking started,
 * the child is given that material — and told to treat it as material rather
 * than as fact.
 *
 * @param task - what to think through.
 * @param focus - what the conclusion must settle, when the caller narrowed it.
 * @returns the child's instruction.
 */
export function buildThinkChildPrompt(
  task: string,
  focus: string | undefined,
): string {
  const parts: string[] = [`Think this through thoroughly: ${task}`]
  if (focus !== undefined && focus.trim().length > 0) {
    parts.push(`The conclusion must settle this: ${focus}`)
  }
  parts.push(
    'You have the full context of this conversation, including everything already established and every '
    + 'earlier conclusion. Use it: check the premises, weigh the alternatives, and build on what is '
    + 'already settled instead of re-deriving it.',
    'Your job is to think, not to look things up. The external knowledge this question needs is '
    + 'gathered for you and arrives with the material; the retrieval is not your task.',
  )
  parts.push(
    'Give a recommendation, not a survey. Say plainly when the evidence does not settle the question, '
    + 'and when you are uncertain.',
    'Do not narrate your reasoning process and do not report what you considered and rejected. The parent '
    + 'sees only your answer.',
  )
  return parts.join('\n\n')
}

/**
 * How the thinking child must end its answer.
 *
 * A continuable child has no `structured_output` tool — the runtime installs
 * that tool only for a one-shot structured run — so the pipeline reads the
 * answer from the child's text. The child is told to close with one fenced
 * JSON block; {@link parseThinkAnswer} reads it, and falls back to treating the
 * whole answer as the conclusion when it is missing or malformed.
 */
export const THINK_ANSWER_CONTRACT = [
  'End your answer with exactly one fenced JSON block, and nothing after it:',
  '```json',
  '{"conclusion": "…", "keyPoints": ["…"], "assumptions": ["…"], "risks": ["…"]}',
  '```',
  'Every field is required. `conclusion` is the recommendation itself, in a few sentences. `keyPoints` '
  + 'are the three to five points that carry it, one sentence each. `assumptions` are what the '
  + 'conclusion rests on that could be wrong. `risks` are what would make it fail, and at what scale.',
].join('\n')

/**
 * What the thinking child must not do with its turn.
 *
 * The child holds the parent's permissions, so nothing stops it from turning a
 * question into a project. One delegated thought here wrote a four-hundred-line
 * decision document into the workspace — the parent then spent the rest of the
 * turn finding it, reading it, and deleting it. The answer is the deliverable;
 * the workspace belongs to the conversation that asked.
 */
export const THINK_CHILD_RULES = [
  'This is a question, not a job. Your whole deliverable is the answer in your reply.',
  'Do not create, edit, move or delete files, and do not run a command that changes the workspace. '
  + 'The parent keeps the workspace, and anything that has to be written or edited is the parent\'s work.',
  'Do not write the answer to a file and do not hand back a document. Answer in the reply body only.',
].join('\n')

/**
 * Compose the instruction one thinking round receives: the round's own prompt,
 * the rules that keep the turn a question rather than a project, and the answer
 * contract.
 *
 * @param childPrompt - the prompt for this round.
 * @returns the instruction text handed to the thinking child.
 */
export function composeThinkChildPrompt(childPrompt: string): string {
  return `${childPrompt}\n\n${THINK_CHILD_RULES}\n\n${THINK_ANSWER_CONTRACT}`
}

/**
 * Read the last JSON block in a child's answer.
 *
 * The contract asks for one block at the end, but a model may write an example
 * block earlier in its answer, so the last block that parses is the answer.
 *
 * @param text - the child's answer.
 * @returns the parsed object, or undefined when no block parses.
 */
function lastAnswerBlock(text: string): Record<string, unknown> | undefined {
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/gu
  let found: Record<string, unknown> | undefined
  for (const match of text.matchAll(fence)) {
    const body = match[1]
    if (body === undefined) continue
    try {
      const parsed: unknown = JSON.parse(body)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        found = parsed as Record<string, unknown>
      }
    } catch {
      // A block that does not parse is not the answer; keep looking.
    }
  }
  if (found !== undefined) return found
  const open = text.lastIndexOf('{')
  const close = text.lastIndexOf('}')
  if (open < 0 || close <= open) return undefined
  try {
    const parsed: unknown = JSON.parse(text.slice(open, close + 1))
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Fall through: the caller treats the whole answer as the conclusion.
  }
  return undefined
}

/**
 * Project a thinking child's answer into the canonical output value.
 *
 * A child that ignored the contract still produced an answer, and losing it
 * would lose the thought. Its whole text becomes the conclusion and the other
 * fields are empty, which the parent reads as "no key points were given".
 *
 * @param text - the child's answer.
 * @returns the canonical output value.
 */
export function parseThinkAnswer(text: string): ThinkDeepOutput {
  const record = lastAnswerBlock(text)
  if (record === undefined) {
    return { conclusion: text.trim(), keyPoints: [], assumptions: [], risks: [] }
  }
  const one = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  const many = (value: unknown): string[] => (Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
    : [])
  const conclusion = one(record['conclusion'])
  if (conclusion === '') {
    return { conclusion: text.trim(), keyPoints: [], assumptions: [], risks: [] }
  }
  return {
    conclusion,
    keyPoints: many(record['keyPoints']),
    assumptions: many(record['assumptions']),
    risks: many(record['risks']),
  }
}

/**
 * Wait for one turn of a continuable child to finish.
 *
 * The inbox accepts a message before its turn starts, so waiting for idle
 * alone can return while the child is still between turns. The wait therefore
 * gives the turn a moment to open, and accepts a child that finishes so fast
 * it was never observed running.
 *
 * @param agent - the child's live agent, when it is resident.
 * @param signal - the caller's cancellation.
 */
async function waitForChildTurn(agent: Agent | undefined, signal: AbortSignal): Promise<void> {
  if (agent === undefined) throw new Error('the thinking child is not resident in this process')
  const deadline = Date.now() + 5_000
  while (agent.status !== 'running' && Date.now() < deadline) {
    signal.throwIfAborted()
    await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
  }
  await agent.whenIdle()
  signal.throwIfAborted()
}

/**
 * Register the `think_deep` tool.
 *
 * The configuration is read when a call runs, not when the tool is registered:
 * the settings page writes the extractor's model and term count at runtime,
 * and the next delegated thought must use what the page last saved.
 *
 * @param ctx - the plugin context supplying the registries.
 * @param readConfig - the reader for the current thinking configuration.
 * @param budget - the budget that covers this route's children.
 * @param onAnswered - called with the answering agent's session id once a
 * delegated thought has produced a conclusion, so a turn that delegated can be
 * recognised as one that did.
 * @param onForked - called with the session id of each thinking child, which
 * is the one kind of child allowed to start another child of its own.
 */
export function applyThinkTool(
  ctx: Context,
  readConfig: () => ThinkConfig,
  budget: ChildBudget,
  onAnswered?: (sessionId: string) => void,
  onForked?: (sessionId: string) => void,
): void {
  const registered = readConfig()
  ctx.tools.register(defineTool({
    name: 'think_deep',
    description: 'Delegate a hard question to a subagent that inherits this conversation and reasons over '
      + 'it at length. The pipeline retrieves the external knowledge first, in its own child, so the '
      + 'reasoning starts from material rather than from memory; a second subagent then tries to refute '
      + 'the conclusion. Use it whenever the question asks for a judgement — a recommendation, a '
      + 'comparison, a trade-off, a design, a risk analysis — and not only for a fact; the user need not '
      + 'ask for it. A task that mixes a judgement with mechanical work is two tasks: delegate the '
      + 'judgement first, with the judgement in the focus, and do the work afterwards — a continuous edit '
      + 'is not a reason to reason inside it. It returns a structured conclusion — recommendation, key '
      + 'points, assumptions, and risks — with what was retrieved and a verification record, while the '
      + 'reasoning stays in the child.',
    parameters: {
      task: {
        type: 'string',
        required: true,
        description: 'The question to think through.',
      },
      focus: {
        type: 'string',
        description: 'What the conclusion must settle, when the task is broader than the question.',
      },
      verify: {
        type: 'boolean',
        description: 'Set false to skip the verification pass. Verification costs one more subagent and '
          + 'one more round trip; it is what catches a conclusion the sources do not support.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          conclusion: { type: 'string', required: true },
          keyPoints: { type: 'array', required: true, items: { type: 'string' } },
          assumptions: { type: 'array', required: true, items: { type: 'string' } },
          risks: { type: 'array', required: true, items: { type: 'string' } },
          conflictRetrieved: {
            type: 'object',
            additionalProperties: false,
            properties: {
              answer: { type: 'string', required: true },
              sources: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    url: { type: 'string', required: true },
                    title: { type: 'string' },
                  },
                },
              },
            },
          },
          keywords: { type: 'array', items: { type: 'string' } },
          keywordRetrieved: {
            type: 'object',
            additionalProperties: false,
            properties: {
              answer: { type: 'string', required: true },
              sources: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    url: { type: 'string', required: true },
                    title: { type: 'string' },
                  },
                },
              },
            },
          },
          verification: {
            type: 'object',
            additionalProperties: false,
            properties: {
              rounds: { type: 'number', required: true },
              verdict: { type: 'string', required: true, enum: ['confirmed', 'conflict'] },
              problems: { type: 'array', required: true, items: { type: 'string' } },
              evidence: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    url: { type: 'string', required: true },
                    title: { type: 'string' },
                    snippet: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatThinkDeepOutput(value as ThinkDeepOutput) }],
    },
    // A delegated thought is a foreground operation on the parent's behalf.
    // Its deadline covers the whole pipeline: the retrieving child, then one
    // thinking child, then a verifier per round, and a retrieval pass aimed at
    // the contradictions whenever a verifier found any.
    isConcurrencySafe: () => false,
    timeoutMs: registered.timeoutMs
      + registered.verifyTimeoutMs * Math.max(1, registered.verifyRounds)
      + (registered.conflictSearchCalls > 0 ? registered.search.timeoutMs : 0),
    async execute(args, exec) {
      const config = readConfig()
      const parsed = parseThinkDeepArgs(args as ThinkDeepArgs)
      const parent = exec.agent
      if (parent === undefined) {
        throw new Error('think_deep needs an agent to delegate from')
      }
      // The child runs with the same permissions the parent has. A delegated
      // child is a full agent: it may read, write, search and delegate, and
      // the policy that governs the parent governs it too. Restricting it
      // would be a rule the user never asked for, and it would make the
      // child's answer weaker than the question deserved.
      const maxRounds = parsed.verify === false ? 0 : config.verifyRounds

      // No retrieval happens here. The thinking child is a fork: it inherits
      // this conversation, including anything the parent already searched for,
      // so retrieving again would read the same material twice and put a second
      // corpus in the prompt that the parent never asked for. The parent's
      // `search_web` is the way external knowledge enters.
      //
      // What the pipeline adds is one grounding pass: a separate child names
      // the parts of the first conclusion that would have to be checked
      // against the outside world, and a retrieval pass looks up exactly those.
      // The thinking child then reconsiders with that material beside its own
      // conclusion.
      // One thinking child for the whole pipeline. The second round is that
      // same child continuing: it already holds the whole conversation and its
      // own first conclusion, so a fresh fork would re-seed the same history
      // and then reason about a conclusion it did not write. A continuable
      // child has no structured-output tool, so the answer comes back as text
      // under {@link THINK_ANSWER_CONTRACT}.
      let thinkingChildId: Parameters<typeof ctx.subagents.sendMessage>[1] | undefined
      const runThinking = async (
        childPrompt: string,
      ): Promise<{ projected: ThinkDeepOutput, transcript: WatchedTranscript }> => {
        const content = [{
          type: 'text',
          text: composeThinkChildPrompt(childPrompt),
        }] as ContentBlock[]
        if (thinkingChildId === undefined) {
          const started = await ctx.subagents.startContinuable({
            provider: config.provider,
            label: 'think_deep',
            request: { parent, prompt: content },
            signal: exec.signal,
          })
          thinkingChildId = started.childId
          registerChild(budget, started.childId, config.maxChildCalls)
          // The thinking child may start a child of its own: it reasons over
          // this conversation and may want a child's help to settle a point.
          // Every other child this plugin starts may not.
          onForked?.(started.childId)
        } else {
          await ctx.subagents.sendMessage(parent, thinkingChildId, content, { signal: exec.signal })
        }
        const agent = ctx.agents.get(thinkingChildId)
        // Watch the child's own stream. A fork child runs in this process, so
        // its reasoning and its answer can be watched as it writes them; the
        // extractor is the child that turns that transcript into search terms.
        const watcher = watchChildStream(agent)
        try {
          await waitForChildTurn(agent, exec.signal)
          const transcript = watcher.transcript()
          return { projected: parseThinkAnswer(transcript.content), transcript }
        } finally {
          watcher.stop()
        }
      }

      let prompt = buildThinkChildPrompt(parsed.task, parsed.focus)
      const first = await runThinking(prompt)
      let projected = first.projected
      let conclusion = projected.conclusion
      let keyPoints = projected.keyPoints
      let assumptions = projected.assumptions
      let risks = projected.risks
      let verification: ThinkVerification | undefined

      // The grounding pass: what in the delegated child's own work would have
      // to be checked against an outside source, looked up before the
      // conclusion is judged. The extractor reads the child's reasoning and
      // answer — the text it wrote — and names the terms to look up.
      const extracted = await runKeywordExtractor(
        ctx,
        config.keywords,
        budget,
        parent,
        exec.signal,
        trimTranscript(first.transcript, config.watchMaxChars),
      )
      // The child may have looked things up while it reasoned. Those lookups
      // are not in the parent's context, so the pipeline cannot see them by
      // itself — the extractor reports them, and the terms it names are not
      // searched again.
      const alreadySearched = extracted.alreadySearched
      const fresh = dropAlreadySearched(extracted.keywords, alreadySearched)
      let keywordRetrieved: RetrievedKnowledge | undefined
      if (fresh.length > 0) {
        const projection = await delegateSearch(
          ctx,
          { ...config.search, maxChildCalls: config.keywordSearchCalls },
          budget,
          parent,
          exec.signal,
          buildKeywordSearchPrompt(fresh, config.keywordSearchCalls),
          config.keywordSearchCalls,
        )
        keywordRetrieved = {
          answer: projection.answer,
          sources: projection.sources.map((source) => ({
            url: source.url,
            ...source.title === undefined ? {} : { title: source.title },
          })),
        }
      }
      if (keywordRetrieved !== undefined) {
        const rethought = await runThinking(
          buildRethinkPrompt(parsed.task, conclusion, keyPoints, keywordRetrieved, alreadySearched),
        )
        conclusion = rethought.projected.conclusion
        keyPoints = rethought.projected.keyPoints
        assumptions = rethought.projected.assumptions
        risks = rethought.projected.risks
      }

      let conflictRetrieved: RetrievedKnowledge | undefined
      for (let round = 1; round <= Math.max(1, maxRounds); round++) {
        if (maxRounds === 0) break
        // The verifier is a separate child with a clean context and an
        // adversarial role: it is handed the conclusion and asked to refute it.
        const verdict = await runVerifier(
          ctx,
          { provider: config.verifyProvider, timeoutMs: config.verifyTimeoutMs },
          budget,
          parent,
          exec.signal,
          conclusion,
          keyPoints,
          parsed.task,
          config.maxChildCalls,
        )
        verification = {
          rounds: round,
          verdict: verdict.verdict,
          problems: verdict.problems,
          evidence: verdict.evidence,
        }
        if (verdict.verdict !== 'conflict') break
        if (round >= maxRounds) break
        // The problems name the exact parts of the conclusion that failed, so
        // the retrieval pass looks those up instead of re-reading the subject
        // the first pass already covered.
        const conflictSearch = await delegateSearch(
          ctx,
          config.search,
          budget,
          parent,
          exec.signal,
          buildConflictSearchPrompt(verdict.problems, config.conflictSearchCalls),
          config.conflictSearchCalls,
        )
        conflictRetrieved = {
          answer: conflictSearch.answer,
          sources: conflictSearch.sources.map((source) => ({
            url: source.url,
            ...source.title === undefined ? {} : { title: source.title },
          })),
        }
        prompt = buildRefinePrompt(
          parsed.task,
          conclusion,
          verdict.problems,
          verdict.evidence,
          conflictRetrieved,
        )
      }

      // The turn has been answered by a delegated thought, so a turn that was
      // required to delegate has done what it was required to do.
      onAnswered?.(parent.session.id)

      // The thinking child is resident for as long as the pipeline needs it and
      // no longer. Releasing it here keeps a finished thought from holding a
      // continuable slot until the parent's turn closes.
      if (thinkingChildId !== undefined) {
        releaseChildBudget(budget, thinkingChildId)
        await ctx.subagents.drainContinuableChildren(parent, [thinkingChildId])
      }

      return {
        conclusion,
        keyPoints,
        assumptions,
        risks,
        ...verification !== undefined ? { verification } : {},
      }
    },
    presentCall: (args) => {
      const task = (args as ThinkDeepArgs).task
      return { card: 'generic', title: task, kind: 'search', rawInput: task }
    },
  }))
}
