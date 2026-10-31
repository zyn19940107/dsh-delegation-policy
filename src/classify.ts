/**
 * Making the main agent say whether a question is a judgement.
 *
 * The agent itself decides: it calls `classify_question` and states its
 * conclusion. The plugin does not classify on its behalf — a policy that
 * classifies behind the model's back is a policy the model never learns, and
 * it would answer a question the agent was never shown.
 *
 * What the plugin does is make the decision unavoidable. A turn that ends
 * without a classification is pulled back, and a turn classified as a
 * judgement may not end before a delegated thought has answered it.
 *
 * @module @local/dsh-delegation-policy/classify
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolExecution } from '@deepseek-ai/dsh-tools'

/** Field the main agent's classification is written to. */
export const CLASSIFY_FIELD = 'judgement'

/** What one turn has been told so far. */
export interface TurnJudgement {
  /** Whether the agent classified this turn. */
  classified: boolean
  /** What the agent concluded: the question asks for a judgement. */
  verdict: boolean
  /** Why the agent concluded so. */
  reason: string
  /** Whether a delegated thought answered this turn. */
  delegated: boolean
  /** How many times this turn was pulled back. */
  pullbacks: number
}

/** What the classifier tool reports back to the agent. */
export interface ClassifyQuestionOutput {
  /** The agent's own conclusion, as recorded. */
  judgement: boolean
  /** Why the agent concluded so. */
  reason: string
  /** Whether the plugin recorded the conclusion. */
  recorded: boolean
}

/**
 * The agent's argument for the classification tool.
 */
export interface ClassifyQuestionArgs {
  /** The question as the agent read it. */
  question: string
  /** Whether the question asks for a judgement. */
  judgement: boolean
  /** Why. */
  reason: string
}

/**
 * Read the agent's classification out of a tool call.
 *
 * @param value - the parsed arguments.
 * @returns the classification, or undefined when the call does not carry one.
 */
export function parseClassifyArgs(value: unknown): ClassifyQuestionArgs | undefined {
  const record = (value ?? {}) as Record<string, unknown>
  const question = record.question
  const judgement = record.judgement
  if (typeof question !== 'string' || question.trim() === '') return undefined
  if (typeof judgement !== 'boolean') return undefined
  const reason = typeof record.reason === 'string' ? record.reason : ''
  return { question: question.trim(), judgement, reason: reason.trim() }
}

/**
 * What one conversation has been told about the turn in progress.
 *
 * The state is kept per session and cleared when the next turn opens, so the
 * next turn starts without a classification and has to make one again.
 */
export class JudgementGate {
  private readonly turns = new Map<string, TurnJudgement>()

  /**
   * The turn's state.
   *
   * @param sessionId - the agent's session id.
   * @returns the state, with a fresh one when the turn has said nothing yet.
   */
  state(sessionId: string): TurnJudgement {
    return this.turns.get(sessionId) ?? {
      classified: false,
      verdict: false,
      reason: '',
      delegated: false,
      pullbacks: 0,
    }
  }

  /**
   * Record the agent's classification.
   *
   * @param sessionId - the agent's session id.
   * @param verdict - whether the question asks for a judgement.
   * @param reason - why the agent concluded so.
   */
  markClassified(sessionId: string, verdict: boolean, reason: string): void {
    const state = this.state(sessionId)
    this.turns.set(sessionId, { ...state, classified: true, verdict, reason })
  }

  /**
   * Record that a delegated thought answered this turn.
   *
   * @param sessionId - the agent's session id.
   */
  markDelegated(sessionId: string): void {
    const state = this.state(sessionId)
    this.turns.set(sessionId, { ...state, delegated: true })
  }

  /**
   * Record that the turn was pulled back.
   *
   * @param sessionId - the agent's session id.
   * @returns how many times this turn has been pulled back.
   */
  pullback(sessionId: string): number {
    const state = this.state(sessionId)
    const pullbacks = state.pullbacks + 1
    this.turns.set(sessionId, { ...state, pullbacks })
    return pullbacks
  }

  /**
   * Forget the turn, so the next one starts clean.
   *
   * @param sessionId - the agent's session id.
   */
  clear(sessionId: string): void {
    this.turns.delete(sessionId)
  }
}

/**
 * What the turn is missing, as the agent is told.
 *
 * The wording follows the web guard: it names the tool, says why, and gives
 * the alternative action.
 */
export const NEEDS_CLASSIFICATION = 'This turn has not classified the question yet. Call classify_question '
  + 'first, with your own conclusion about whether the question asks for a judgement — a recommendation, '
  + 'a comparison, a trade-off, a design, a risk analysis, or a "what should we do". Then answer from that '
  + 'classification: a judgement is delegated with think_deep, anything else is answered here.'

/** What a judged turn is told when it ends without a delegated thought. */
export const NEEDS_DELEGATION = 'This question was classified as a judgement, so the answer is not yours to '
  + 'write from what you already have. Call think_deep with the question, wait for its verified conclusion, '
  + 'and write the answer from that result.'

/**
 * Register the classification tool.
 *
 * The tool records the agent's conclusion; it decides nothing itself. A call
 * that carries no conclusion is refused, so the agent cannot mark the
 * question classified without saying what it concluded.
 *
 * @param ctx - the plugin context supplying the registries.
 * @param gate - the state the classification is recorded in.
 */
export function applyClassifyTool(ctx: Context, gate: JudgementGate): void {
  ctx.tools.register(defineTool({
    name: 'classify_question',
    description: 'State whether the question you are answering is a judgement — a recommendation, a comparison, '
      + 'a trade-off, a design, a risk analysis, or a "what should we do" — and why. Every turn classifies its '
      + 'question before it may end. A judgement is answered by delegating it to think_deep; anything else is '
      + 'answered here. Your conclusion is what decides the route, so state the one you actually hold.',
    parameters: {
      question: {
        type: 'string',
        required: true,
        description: 'The question as you read it.',
      },
      judgement: {
        type: 'boolean',
        required: true,
        description: 'Whether the question asks for a judgement.',
      },
      reason: {
        type: 'string',
        required: true,
        description: 'Why you concluded so.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          judgement: { type: 'boolean', required: true },
          reason: { type: 'string', required: true },
          recorded: { type: 'boolean', required: true },
        },
      },
      render: (_args: { [key: string]: unknown }, value: unknown) => {
        const output = value as ClassifyQuestionOutput
        return [{ type: 'text', text: output.judgement
          ? `Recorded: this is a judgement (${output.reason}). Answer it with think_deep.`
          : `Recorded: this is not a judgement (${output.reason}). Answer it here.` }]
      },
    },
    async execute(args, exec: ToolExecution) {
      const parsed = parseClassifyArgs(args)
      if (parsed === undefined) {
        throw new Error('classify_question needs the question and a boolean judgement')
      }
      const agent: Agent | undefined = exec.agent
      if (agent !== undefined) gate.markClassified(agent.session.id, parsed.judgement, parsed.reason)
      return {
        judgement: parsed.judgement,
        reason: parsed.reason,
        recorded: agent !== undefined,
      }
    },
  }))
}
