/**
 * Turning the plugin on and off inside one conversation.
 *
 * The plugin is mounted for a whole deployment, but a conversation may opt out
 * of it. `/dsh-delegation-policy off` takes the plugin out of the conversation
 * that ran it: the three delegation tools disappear from the model's tool
 * table, the delegation guidance leaves the system prompt, and the rules stop
 * being enforced. `/dsh-delegation-policy on` puts it back.
 *
 * The state is per conversation. One conversation opting out changes no other
 * conversation, and a new conversation starts with the plugin's normal
 * behaviour — the plugin is on unless the conversation says otherwise.
 *
 * The command is a human command: the UI runs it and the model never sees it.
 *
 * @module @local/dsh-delegation-policy/policy
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Type-only: the ctx.commands Context merge.
import type {} from '@deepseek-ai/dsh-commands'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'

/** The command that turns the plugin on and off inside one conversation. */
export const POLICY_COMMAND = 'dsh-delegation-policy'

/**
 * The plugin's own tools — the ones a conversation loses when it opts out.
 *
 * They are the plugin's routes: a search, a thought, and the classification
 * that routes a turn. With them gone, the conversation has nothing of the
 * plugin left to use, which is what "off" has to mean for the off state to be
 * more than a promise in a prompt.
 */
export const POLICY_TOOLS: readonly string[] = [
  'search_web', 'think_deep', 'classify_question',
]

/**
 * The conversations that opted out of the plugin.
 */
export class SessionPolicy {
  private readonly optedOut = new Set<string>()
  private readonly lifts = new Map<string, () => void>()

  /**
   * Whether the plugin's rules apply to this conversation.
   *
   * @param sessionId - the session's id.
   * @returns true when the conversation follows the plugin's rules.
   */
  appliesTo(sessionId: string): boolean {
    return !this.optedOut.has(sessionId)
  }

  /**
   * Take the plugin out of this conversation.
   *
   * The tools are restricted away in the agent's own scope, so the model stops
   * seeing them and the delegation guidance — which is written in terms of
   * those tools — leaves the system prompt with them.
   *
   * @param agent - the agent whose conversation opts out.
   */
  turnOff(agent: Agent): void {
    const sessionId = agent.session.id
    if (this.optedOut.has(sessionId)) return
    this.optedOut.add(sessionId)
    const lift = agent.ctx.tools.restrict({ deny: [...POLICY_TOOLS] })
    this.lifts.set(sessionId, lift)
  }

  /**
   * Put the plugin back into this conversation.
   *
   * @param sessionId - the session's id.
   */
  turnOn(sessionId: string): void {
    this.optedOut.delete(sessionId)
    const lift = this.lifts.get(sessionId)
    if (lift === undefined) return
    this.lifts.delete(sessionId)
    lift()
  }
}

/**
 * Run the policy command.
 *
 * The command takes one word: `on` or `off`. Anything else is refused with
 * the two spellings, because a command that guessed would silently leave the
 * conversation in the wrong state.
 *
 * @param policy - the per-conversation state.
 * @param invocation - the command's invocation.
 * @returns what the command reports back to the composer.
 */
export function runPolicyCommand(
  policy: SessionPolicy,
  invocation: CommandInvocation,
): CommandResult {
  const raw = invocation.rawInput.trim().toLowerCase()
  if (raw !== 'on' && raw !== 'off') {
    return {
      kind: 'error',
      text: `Use /${POLICY_COMMAND} on or /${POLICY_COMMAND} off.`,
    }
  }
  const sessionId = invocation.agent.session.id
  if (raw === 'off') {
    policy.turnOff(invocation.agent)
    return {
      kind: 'success',
      text: 'The delegation policy is off for this conversation: search_web, think_deep and '
        + 'classify_question are gone, and the rules are not enforced. Turn it back on with '
        + `/${POLICY_COMMAND} on.`,
    }
  }
  policy.turnOn(sessionId)
  return {
    kind: 'success',
    text: 'The delegation policy is on for this conversation.',
  }
}

/**
 * Register the policy command.
 *
 * @param ctx - the plugin context supplying the command registry.
 * @param policy - the per-conversation state the command writes.
 */
export function applyPolicyCommand(ctx: Context, policy: SessionPolicy): void {
  ctx.commands.register({
    name: POLICY_COMMAND,
    description: 'Turn the delegation policy on or off for this conversation.',
    input: { hint: 'on | off' },
    handler: (invocation) => runPolicyCommand(policy, invocation),
  })
}
