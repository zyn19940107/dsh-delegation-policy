/**
 * Regression tests for the per-conversation switch.
 *
 * The plugin is mounted for a whole deployment, but a conversation may opt out
 * of it: `/dsh-delegation-policy off` takes the plugin out of that
 * conversation — its tools disappear from the model's tool table and its rules
 * stop being enforced — and `/dsh-delegation-policy on` puts it back. The
 * switch is a human command: the UI runs it and the model never sees it.
 */

import {
  applyPolicyCommand,
  POLICY_COMMAND,
  POLICY_TOOLS,
  runPolicyCommand,
  SessionPolicy,
} from '../src/policy.js'

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

/**
 * Build an agent whose tool registry records the restrictions placed on it.
 *
 * @param sessionId - the agent's session id.
 * @returns the agent and what was restricted on it.
 */
function fakeAgent(sessionId: string): {
  agent: any
  restricted: { deny?: readonly string[] }[]
  lifted: () => number
} {
  const restricted: { deny?: readonly string[] }[] = []
  let liftedCount = 0
  const agent = {
    session: { id: sessionId, header: { origin: 'user' } },
    ctx: {
      tools: {
        restrict(filter: { allow?: readonly string[]; deny?: readonly string[] }) {
          restricted.push(filter)
          return () => { liftedCount += 1 }
        },
      },
    },
  }
  return { agent, restricted, lifted: () => liftedCount }
}

/**
 * Build a command invocation for a fake agent.
 *
 * @param agent - the agent the command was issued in.
 * @param rawInput - the text after the command name.
 * @returns an invocation shaped like the runtime's.
 */
function invocation(agent: any, rawInput: string): any {
  return { agent, rawInput, attachments: [], signal: new AbortController().signal }
}

console.log('SessionPolicy')
{
  const policy = new SessionPolicy()
  check('a new conversation follows the plugin', policy.appliesTo('s1'))
  const { agent, restricted } = fakeAgent('s1')
  policy.turnOff(agent)
  check('an opted-out conversation is not governed', policy.appliesTo('s1') === false)
  check('another conversation is unaffected', policy.appliesTo('s2'))
  check('the three delegation tools are restricted away',
    restricted.length === 1
    && restricted[0]?.deny?.length === POLICY_TOOLS.length
    && POLICY_TOOLS.every((tool) => restricted[0]?.deny?.includes(tool)))
  check('the restriction covers exactly the plugin routes',
    restricted[0]?.deny?.includes('bash') === false
    && restricted[0]?.deny?.includes('read') === false)
}

console.log('turnOff / turnOn')
{
  const policy = new SessionPolicy()
  const { agent, restricted, lifted } = fakeAgent('s1')
  policy.turnOff(agent)
  policy.turnOff(agent)
  check('turning it off twice restricts once', restricted.length === 1)
  policy.turnOn('s1')
  check('turning it on lifts the restriction', lifted() === 1)
  check('the conversation follows the plugin again', policy.appliesTo('s1'))
  policy.turnOn('s1')
  check('turning it on twice lifts once', lifted() === 1)
}

console.log('runPolicyCommand')
{
  const policy = new SessionPolicy()
  const { agent, restricted, lifted } = fakeAgent('s1')

  const off = runPolicyCommand(policy, invocation(agent, 'off'))
  check('off is accepted', off.kind === 'success')
  check('off takes the plugin out of the conversation', policy.appliesTo('s1') === false)
  check('off restricts the tools away', restricted.length === 1)

  const on = runPolicyCommand(policy, invocation(agent, ' on '))
  check('on is accepted, whitespace and all', on.kind === 'success')
  check('on puts the plugin back', policy.appliesTo('s1'))
  check('on lifts the restriction', lifted() === 1)

  const garbage = runPolicyCommand(policy, invocation(agent, 'maybe'))
  check('anything else is refused', garbage.kind === 'error')
  check('the refusal names the two spellings',
    garbage.kind === 'error' && garbage.text.includes(`${POLICY_COMMAND} on`)
    && garbage.text.includes(`${POLICY_COMMAND} off`))
  check('a refused command changes nothing', policy.appliesTo('s1'))
  check('a refused command restricts nothing', restricted.length === 1)
}

console.log('applyPolicyCommand')
{
  const policy = new SessionPolicy()
  let registered: any
  const ctx = { commands: { register: (definition: any) => { registered = definition } } }
  applyPolicyCommand(ctx as any, policy)
  check('the command is registered under the plugin name', registered?.name === POLICY_COMMAND)
  check('the command advertises its input', registered?.input?.hint?.includes('on')
    && registered.input.hint.includes('off'))
  check('the command has a description', typeof registered?.description === 'string'
    && registered.description.length > 0)
  check('the command runs a handler', typeof registered?.handler === 'function')
  const { agent, restricted } = fakeAgent('s2')
  const result = registered.handler(invocation(agent, 'off'))
  check('the handler turns the plugin off', result.kind === 'success'
    && policy.appliesTo('s2') === false && restricted.length === 1)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\npolicy specs passed')
