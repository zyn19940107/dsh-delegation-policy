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
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolExecution, type ToolGuard } from '@deepseek-ai/dsh-tools'

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
 * the alternative action. It also says what to do when the tool is not in the
 * agent's tool list: a turn that cannot classify must still be able to end.
 */
export const NEEDS_CLASSIFICATION = 'This turn has not classified the question yet. Call classify_question '
  + 'first, with your own conclusion about whether the question asks for a judgement — a recommendation, '
  + 'a comparison, a trade-off, a design, a risk analysis, or a "what should we do". Then answer from that '
  + 'classification: a judgement is delegated with think_deep, anything else is answered here. If '
  + 'classify_question is not in your tool list, say so in your reply and answer the question anyway.'

/** What a judged turn is told when it ends without a delegated thought. */
export const NEEDS_DELEGATION = 'This question was classified as a judgement, so the answer is not yours to '
  + 'write from what you already have. Call think_deep with the question, wait for its conclusion, and write '
  + 'the answer from that result.'

/**
 * What a turn that delegates before it classifies is told.
 *
 * Two rules meet here: the gate wants the turn classified before it may end,
 * and the thought-only guard closes every other tool once a thought is on its
 * way. A model that delegates first therefore cannot classify afterwards, and
 * the turn ends with neither a classification nor a routed answer. So the
 * order is enforced instead of described: classify, then delegate.
 */
export const NEEDS_CLASSIFICATION_FIRST = 'Classify the question before you delegate it: call '
  + 'classify_question with your own conclusion about whether this is a judgement. A delegated thought '
  + 'carries the whole turn, and the tools that would let you classify afterwards are closed once it starts.'

/**
 * Refuse a delegated thought that starts before the question is classified.
 *
 * The rule belongs to the judgement gate, so it follows the gate's switch: with
 * the gate off, a turn may delegate without classifying, because nothing is
 * asking it to classify.
 *
 * @param gate - the state the classification is recorded in.
 * @param enabled - whether the judgement gate is on.
 * @returns the guard.
 */
export function createClassifyFirstGuard(
  gate: JudgementGate,
  enabled: () => boolean,
): ToolGuard {
  return (execution) => {
    if (!enabled()) return undefined
    if (execution.name !== 'think_deep') return undefined
    const agent: Agent | undefined = execution.agent
    if (agent === undefined) return undefined
    if (agent.session.header.origin === 'subagent') return undefined
    if (gate.state(agent.session.id).classified) return undefined
    return NEEDS_CLASSIFICATION_FIRST
  }
}

/**
 * The judgement gate's configuration, read when the gate runs.
 */
export interface JudgementGateConfig {
  /** Whether a turn must classify its question before it may end. */
  judgementEnabled: () => boolean
  /** How many times one turn may be pulled back before it is let through. */
  judgementMaxPullbacks: () => number
}

/**
 * Write one line to the host's standard error.
 *
 * The harness's own logger is not captured by every host, so what the gate
 * does is written where a host's stderr is always seen.
 *
 * @param line - the line to write.
 */
function log(line: string): void {
  process.stderr.write(`${line}\n`)
}

/**
 * Wire the judgement gate.
 *
 * The agent states its own classification; the plugin makes the statement
 * unavoidable by checking, at the point where the agent's answer is finished,
 * that the answer classified its question and — when the question is a
 * judgement — that a delegated thought answered it.
 *
 * The check runs on the assistant stream's closing frame rather than on the
 * turn's end. A turn ends either because a tool result concluded it or
 * because the agent simply answered, and only the second case is the one
 * worth pulling back. A step that called a tool is mid-work, not finished,
 * so the frame is ignored when the step used one.
 *
 * @param ctx - the plugin context supplying the registries.
 * @param gate - the state the classification is recorded in.
 * @param config - the gate's configuration.
 */
export function applyJudgementGate(
  ctx: Context,
  gate: JudgementGate,
  config: JudgementGateConfig,
): void {
  const tooledThisStep = new WeakMap<object, boolean>()
  // A step that called a tool is mid-work, not finished: its closing frame is
  // not the turn's last word, so the gate does not judge it.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.agent !== undefined) tooledThisStep.set(exec.agent, true)
    return next()
  })
  ctx.on('agent/assistant-stream', (payload) => {
    if (!config.judgementEnabled()) return
    const frame = payload.frame
    const agent = payload.agent
    if (frame.type !== 'end') return
    if (agent.session.header.origin === 'subagent') return
    if (tooledThisStep.get(agent) === true) {
      tooledThisStep.delete(agent)
      return
    }
    const sessionId = agent.session.id
    const state = gate.state(sessionId)
    const missing = state.classified
      ? (state.verdict && !state.delegated ? NEEDS_DELEGATION : undefined)
      : NEEDS_CLASSIFICATION
    if (missing === undefined) {
      log(`delegation-policy: the answer of session ${sessionId} passed the judgement gate `
        + `(classified=${state.classified}, judgement=${state.verdict}, delegated=${state.delegated})`)
      // The state is not cleared here. A turn has one closing frame per step,
      // and a step that used a tool is not the turn's last word — clearing on
      // the first frame would make the second frame find nothing classified
      // and pull the agent back for no reason. The state is cleared when the
      // next turn opens.
      return
    }
    // A turn that cannot classify must still be able to end. The tool is
    // registered by this plugin, so a pullback is only worth sending when the
    // agent can act on it.
    if (ctx.tools.get('classify_question') === undefined) {
      log(`delegation-policy: session ${sessionId} ends without a classification, but `
        + 'classify_question is not registered — the gate cannot ask for one')
      return
    }
    const pullbacks = gate.pullback(sessionId)
    log(`delegation-policy: the answer of session ${sessionId} was pulled back (${pullbacks}): `
      + (missing === NEEDS_CLASSIFICATION ? 'no classification' : 'no delegated thought'))
    if (pullbacks > config.judgementMaxPullbacks()) {
      // A turn that keeps refusing to classify is let through: the gate is a
      // rule, not a trap, and a model that cannot state its conclusion must
      // still be able to answer.
      gate.clear(sessionId)
      return
    }
    agent.steer(createUserMessage({
      content: [{ type: 'text', text: missing }],
      source: { kind: 'system-prompt' },
    }))
  })

  // A turn starts over: what the previous turn classified says nothing about
  // this one, and the question may be a different kind.
  ctx.on('agent/pre-step', async (payload, next) => {
    if (payload.step === 1) {
      gate.clear(payload.agent.session.id)
    }
    return next()
  })
}

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
