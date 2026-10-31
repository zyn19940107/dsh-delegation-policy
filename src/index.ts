/**
 * The delegation policy, as executable rules instead of prose.
 *
 * Three routes, one per shape of delegation:
 *
 * - `search_web` — web search, delegated to a clean-context child. The
 *   retrieved corpus stays in the child; the parent receives a distilled answer
 *   and its citations.
 * - `think_deep` — long reasoning, delegated to a child that inherits this
 *   conversation. The child's reasoning stays in the child; the parent receives
 *   a structured conclusion.
 * - The generic `subagent` / `subagent_fork` — for self-contained work that
 *   needs none of the above.
 *
 * Five rules are enforced at the point where a call is decided rather than
 * asked for in a prompt: a direct web tool is refused outside a delegation, a
 * delegated child that reasons may not fetch pages, every delegated child has
 * a reading budget, a turn handed to a delegated thought may do nothing else,
 * and a turn that ends without classifying its question is pulled back.
 *
 * @module @local/dsh-delegation-policy
 */

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import {
  applyClassifyTool,
  JudgementGate,
  NEEDS_CLASSIFICATION,
  NEEDS_DELEGATION,
} from './classify.js'
import {
  checkChildBudget,
  createChildBudget,
  createNoRedelegationGuard,
  createThoughtOnlyGuard,
  createWebGuard,
  ThoughtRoute,
} from './guard.js'
import { DEFAULT_WATCH_MAX_CHARS } from './watch.js'
import {
  DEFAULT_KEYWORD_AGENT_PROVIDER,
  DEFAULT_KEYWORD_COUNT,
  DEFAULT_KEYWORD_SEARCH_CALLS,
} from './keywords.js'
import {
  applySearchTool,
  DEFAULT_MAX_CHILD_CALLS,
  DEFAULT_MAX_SNIPPET_CHARS,
  DEFAULT_MAX_SOURCES,
  DEFAULT_SEARCH_PROVIDER,
  DEFAULT_SEARCH_TIMEOUT_MS,
} from './search.js'
import {
  applyThinkTool,
  DEFAULT_MAX_THINK_CALLS,
  DEFAULT_THINK_PROVIDER,
  DEFAULT_THINK_TIMEOUT_MS,
} from './think.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'delegation-policy'

/**
 * Services this plugin needs: the tool registry, the delegation seam, the agent
 * registry that resolves a continuable child, and prompt assembly.
 */
export const inject = ['tools', 'subagents', 'systemPrompt', 'agents']

/**
 * The delegation policy, as the model should see it.
 *
 * The two dedicated tools carry constraints the generic delegation tools do
 * not — a clean context, a reading budget, a conclusion-only result — so they
 * are the default for the two shapes of work they cover. The policy says when
 * to reach for each route and when not to delegate at all, so that delegation
 * is the agent's own judgement rather than something the user has to ask for.
 *
 * This text is part of the system prompt and is re-sent every turn, so it
 * stays as short as the policy allows.
 */
export const DELEGATION_GUIDANCE = [
  'Delegation:',
  '- search_web: web search, delegated to a subagent with a clean context. Use it for any fact that '
  + 'lives outside this conversation. It returns a distilled answer and its citations, and the retrieved '
  + 'pages never enter this conversation. It is the only route to the web from this conversation — a '
  + 'direct page fetch is refused here, and the subagent is the one that reads the pages. Before '
  + 'searching, check what the local source already answers: for a question about this codebase or the '
  + 'running runtime, the installed source is more authoritative than any published document.',
  '- think_deep: a hard question delegated to a subagent that inherits this conversation and reasons over '
  + 'it at length. Use it whenever the question asks for a judgement — a recommendation, a comparison, '
  + 'a trade-off, a design, a risk analysis — and not only for a fact. Judging from your own reading is '
  + 'where a small model is weakest, so the judgement goes to a subagent that already holds everything '
  + 'this conversation established. It works in this order: the delegated child reasons first; a second '
  + 'subagent reads that reasoning and names the parts that would have to be checked against an outside '
  + 'source; a third subagent looks up exactly those; and the same thinking child then reconsiders with '
  + 'the retrieved material beside its own first conclusion. It returns a structured conclusion — '
  + 'recommendation, key points, assumptions, risks — while the reasoning and the retrieved material stay '
  + 'inside the pipeline.',
  '- subagent: a fresh subagent for a self-contained task that needs neither of the above.',
  '- classify_question: state whether the question you are answering is a judgement — a recommendation, a '
  + 'comparison, a trade-off, a design, a risk analysis, or a "what should we do" — and why. Every turn '
  + 'classifies its question before it may end: a judgement is answered by delegating it to think_deep, '
  + 'and anything else is answered here. Your own conclusion decides the route, so state the one you '
  + 'actually hold.',
  'These are the rules for delegation. Do not go looking for them elsewhere — not in a policy document, '
  + 'not in a README, not in this plugin\'s source: the tools are already in your tool table and the '
  + 'rules are already here.',
  'Reach for these on your own — the user should not have to ask for delegation. When you have decided '
  + 'that a fact is external, dispatch the search now: reading the rules, the tool list, or the local '
  + 'files first is not the work.',
  'A task that mixes a '
  + 'judgement with mechanical work is two tasks: delegate the judgement first, with the judgement in '
  + 'the focus, and do the work yourself afterwards. A continuous edit is not a reason to reason inside '
  + 'it — "where does this part actually end, which way does the force go, which alternative is better" '
  + 'is a question whatever else the turn is doing. This applies to turns that are *not* routed to '
  + 'think_deep. Once a turn is routed there, see the next rule.',
  'Once a turn is routed to think_deep, that delegated thought carries the whole turn: the judgement, '
  + 'every lookup it needs, and the answer itself. Your job in that turn is to present what it returned. '
  + 'Do not search, read, edit, run a command, or start another agent afterwards — a call refused after '
  + 'a thought is the plugin stopping you from redoing work the thought already did. Answer with its '
  + 'conclusion, key points, assumptions and risks.',
  'Do not delegate when one grep, one file read, or one small edit answers the question on its own, when '
  + 'the next step depends entirely on the result, or when delegating would break one continuous edit '
  + 'into fragments.',
].join('\n')

/**
 * Whether a turn must classify its question before it may end.
 *
 * On by default: a question that is a judgement is the case the delegation
 * policy exists for, and a rule that has to be switched on to apply is a rule
 * that is off.
 */
export const DEFAULT_JUDGEMENT_ENABLED = true

/**
 * How many times one turn may be pulled back before it is let through.
 *
 * The gate is a rule, not a trap. A model that will not state its conclusion
 * is let through after this many pullbacks, so a turn can always end.
 */
export const DEFAULT_JUDGEMENT_MAX_PULLBACKS = 2

/** Plugin config. */
export interface Config {
  /** Provider that runs the search child. */
  searchProvider: Volatile<string>
  /** Upper bound on sources returned to the parent. */
  maxSources: Volatile<number>
  /** Excerpt budget per source. */
  maxSnippetChars: Volatile<number>
  /** Retrieval calls a child that reads pages may make: the search child and the grounding child. */
  maxChildCalls: Volatile<number>
  /** Budget for one delegated search, in milliseconds. */
  searchTimeoutMs: Volatile<number>
  /** Provider that runs the thinking child. */
  thinkProvider: Volatile<string>
  /** Retrieval calls a delegated child this plugin did not start may make. */
  maxThinkCalls: Volatile<number>
  /** Budget for one delegated thought, in milliseconds. */
  thinkTimeoutMs: Volatile<number>
  /** The extractor that names what a conclusion would have to be checked against. */
  keywordAgentProvider: Volatile<string>
  /** The model provider the extractor runs on; the parent's when unset. */
  keywordModelProvider: Volatile<string | undefined>
  /** The model the extractor runs on; the parent's when unset. */
  keywordModel: Volatile<string | undefined>
  /** How many search terms the extractor may name. */
  keywordMaxCount: Volatile<number>
  /** Retrieval calls the grounding pass may make. */
  keywordSearchCalls: Volatile<number>
  /** Whether a turn must classify its question before it may end. */
  judgementEnabled: Volatile<boolean>
  /** How many times one turn may be pulled back before it is let through. */
  judgementMaxPullbacks: Volatile<number>
  /** How much of the delegated child's transcript the extractor is given. */
  watchMaxChars: Volatile<number>
}

export const Config = z.object({
  searchProvider: z.string().default(DEFAULT_SEARCH_PROVIDER).volatile(),
  maxSources: z.number().step(1).min(1).default(DEFAULT_MAX_SOURCES).volatile(),
  maxSnippetChars: z.number().step(1).min(1).default(DEFAULT_MAX_SNIPPET_CHARS).volatile(),
  maxChildCalls: z.number().step(1).min(1).default(DEFAULT_MAX_CHILD_CALLS).volatile(),
  searchTimeoutMs: z.number().step(1).min(1).default(DEFAULT_SEARCH_TIMEOUT_MS).volatile(),
  thinkProvider: z.string().default(DEFAULT_THINK_PROVIDER).volatile(),
  maxThinkCalls: z.number().step(1).min(1).default(DEFAULT_MAX_THINK_CALLS).volatile(),
  thinkTimeoutMs: z.number().step(1).min(1).default(DEFAULT_THINK_TIMEOUT_MS).volatile(),
  keywordAgentProvider: z.string().default(DEFAULT_KEYWORD_AGENT_PROVIDER).volatile(),
  keywordModelProvider: z.string().volatile(),
  keywordModel: z.string().volatile(),
  keywordMaxCount: z.number().step(1).min(1).default(DEFAULT_KEYWORD_COUNT).volatile(),
  keywordSearchCalls: z.number().step(1).min(0).default(DEFAULT_KEYWORD_SEARCH_CALLS).volatile(),
  judgementEnabled: z.boolean().default(DEFAULT_JUDGEMENT_ENABLED).volatile(),
  judgementMaxPullbacks: z.number().step(1).min(1).default(DEFAULT_JUDGEMENT_MAX_PULLBACKS).volatile(),
  watchMaxChars: z.number().step(1).min(1).default(DEFAULT_WATCH_MAX_CHARS).volatile(),
})

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
 * Register the delegation routes, the prompt guidance, and the rules enforced
 * at the execution point.
 *
 * @param ctx - the plugin context supplying the registries.
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // One budget for every delegated child. A child this plugin started carries
  // the limit of its route; a child some other tool started still carries the
  // default, so a delegation policy is not bypassed by taking another route to
  // the same place.
  const budget = createChildBudget(Math.max(config.maxChildCalls.get(), config.maxThinkCalls.get()))

  ctx.systemPrompt.section({
    name: 'tool:delegation-routes',
    order: ctx.systemPrompt.getSectionOrder('TOOL_SUBAGENT'),
    text: ({ scope }) => ctx.tools.get('search_web', scope) === undefined
      && ctx.tools.get('think_deep', scope) === undefined
      ? ''
      : DELEGATION_GUIDANCE,
  })

  ctx.tools.guard(createWebGuard(budget))

  // Two different rules, and confusing them is what let a thought start
  // another thought.
  //
  // The plugin's own routes — search_web, think_deep, classify_question —
  // belong to the conversation that asked the question. No child may call
  // them, ever: a thought inside a thought is the pipeline eating itself, and
  // a child that classifies is answering a question nobody asked it.
  //
  // Ordinary orchestration is different. The conversation may start a child,
  // and so may the thinking child this plugin forked, because that child
  // reasons over the whole conversation and may need a child's help. Every
  // other child is refused there too.
  const forkSessions = new Set<string>()
  ctx.tools.guard(createNoRedelegationGuard(forkSessions))

  // A turn routed to a delegated thought has nothing left to do itself. The
  // route is recorded when `think_deep` is dispatched and enforced for the rest
  // of the turn: what the thought already answered is not asked again by the
  // conversation that asked for it.
  const thoughtRoute = new ThoughtRoute()
  ctx.tools.guard(createThoughtOnlyGuard(thoughtRoute))

  // The judgement gate. The agent states its own classification; the plugin
  // makes the statement unavoidable by checking, at the point where the agent's
  // answer is finished, that the answer classified its question and — when the
  // question is a judgement — that a delegated thought answered it.
  //
  // The check runs on the assistant stream's closing frame rather than on the
  // turn's end. A turn ends either because a tool result concluded it or
  // because the agent simply answered, and only the second case is the one
  // worth pulling back. A step that called a tool is mid-work, not finished,
  // so the frame is ignored when the step used one.
  const gate = new JudgementGate()
  const tooledThisStep = new WeakMap<object, boolean>()
  applyClassifyTool(ctx, gate)
  ctx.on('agent/assistant-stream', (payload) => {
    if (!config.judgementEnabled.get()) return
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
    const pullbacks = gate.pullback(sessionId)
    log(`delegation-policy: the answer of session ${sessionId} was pulled back (${pullbacks}): `
      + (missing === NEEDS_CLASSIFICATION ? 'no classification' : 'no delegated thought'))
    if (pullbacks > config.judgementMaxPullbacks.get()) {
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

  ctx.on('tools/pre-execute', async (
    exec: ToolExecution,
    next,
  ): Promise<PreToolDecision> => {
    if (exec.agent !== undefined) {
      tooledThisStep.set(exec.agent, true)
      // The thought is dispatched before the calls that would duplicate it, so
      // the routing is recorded here rather than when the thought returns: a
      // search issued in the same step as the thought must not slip through.
      if (exec.name === 'think_deep' && exec.agent.session.header.origin !== 'subagent') {
        thoughtRoute.begin(exec.agent.session.id)
      }
    }
    const denial = checkChildBudget(budget, exec)
    if (denial !== undefined) return { kind: 'deny', reason: denial }
    return next()
  })

  // A thought that failed did not answer the turn, so the turn keeps its tools:
  // the routing is released and the agent may recover on its own.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (exec.name === 'think_deep' && result.isError && exec.agent !== undefined) {
      thoughtRoute.clear(exec.agent.session.id)
    }
    return next()
  })

  // A turn starts over: what the previous turn classified says nothing about
  // this one, and the question may be a different kind.
  ctx.on('agent/pre-step', async (payload, next) => {
    if (payload.step === 1) {
      gate.clear(payload.agent.session.id)
      thoughtRoute.clear(payload.agent.session.id)
    }
    return next()
  })

  applySearchTool(ctx, () => ({
    provider: config.searchProvider.get(),
    maxSources: config.maxSources.get(),
    maxSnippetChars: config.maxSnippetChars.get(),
    maxChildCalls: config.maxChildCalls.get(),
    timeoutMs: config.searchTimeoutMs.get(),
  }), budget)

  applyThinkTool(ctx, () => ({
    provider: config.thinkProvider.get(),
    timeoutMs: config.thinkTimeoutMs.get(),
    keywords: {
      agentProvider: config.keywordAgentProvider.get(),
      ...config.keywordModelProvider.get() === undefined
        ? {}
        : { modelProvider: config.keywordModelProvider.get() },
      ...config.keywordModel.get() === undefined ? {} : { model: config.keywordModel.get() },
      maxKeywords: config.keywordMaxCount.get(),
    },
    keywordSearchCalls: config.keywordSearchCalls.get(),
    watchMaxChars: config.watchMaxChars.get(),
    search: {
      provider: config.searchProvider.get(),
      maxSources: config.maxSources.get(),
      maxSnippetChars: config.maxSnippetChars.get(),
      maxChildCalls: config.maxChildCalls.get(),
      timeoutMs: config.searchTimeoutMs.get(),
    },
  }), budget,
  (sessionId) => { gate.markDelegated(sessionId) },
  (sessionId) => { forkSessions.add(sessionId) })
}
