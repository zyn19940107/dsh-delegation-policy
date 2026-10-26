# @zyn19940107/dsh-delegation-policy

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that turns the
delegation policy into **executable rules** instead of prose in `AGENTS.md`.

Two shapes of delegation, two routes:

| Route | Provider | Child context | Parent receives |
|---|---|---|---|
| `search_web` | `spawn` | clean | a distilled answer + its citations |
| `think_deep` | `fork` | the parent's completed-turn prefix | a structured conclusion |
| `subagent` / `subagent_fork` | — | the caller's choice | the child's final text |

Two rules are enforced **at the point where a call is decided**, not asked for in a prompt:

- A direct `web_search` is refused outside a delegation. The guard recognises the
  `origin: 'subagent'` header on a child's session, so a delegation's own child may still search.
- Every delegated child has a **retrieval budget**. The child's `web_search` and `web_fetch`
  calls are counted at `tools/pre-execute`; past the budget the call is denied and the child is
  told to answer with what it already has.

## Why the two routes differ

`search_web` runs in a **clean** child. The retrieved corpus is the most expensive thing in a
conversation and it is re-sent every turn, so it must never enter the parent. A relay summary
would cost the parent its context and lose detail; the child has neither problem.

`think_deep` runs in a **fork** child. The fork provider seeds the child with the parent's
completed-turn prefix, so the child reasons over everything already established in the
conversation without a relay prompt. Its reasoning stays in the child's session: the tool result
carries only the structured conclusion.

Two properties of the fork provider are worth knowing before using it:

- **Only completed turns are inherited.** A fork during the parent's first turn gets an empty
  seed, which is equivalent to a fresh child.
- **The inherited history is re-sent on every child turn.** The parent saves its context; the
  child pays per turn.

## Install

From a clone:

```sh
git clone https://github.com/zyn19940107/dsh-delegation-policy
cd dsh-delegation-policy
pnpm install        # installs dev dependencies and builds lib/index.js
dsh plugin add /path/to/dsh-delegation-policy
```

Or straight from GitHub — pnpm runs the package's `prepare` script, so the bundle is built
before the Loader mounts it:

```sh
dsh plugin add github:zyn19940107/dsh-delegation-policy
```

The plugin registers a Loader row named `delegation-policy`, so its configuration is a normal
profile entry:

```yaml
- insert:
    - id: delegation-policy
      name: '@zyn19940107/dsh-delegation-policy'
      config:
        searchProvider: spawn
        maxSources: 5
        maxSnippetChars: 400
        maxChildCalls: 3
        searchTimeoutMs: 600000
        thinkProvider: fork
        maxThinkCalls: 5
        thinkTimeoutMs: 900000
        verifyRounds: 2
        verifyProvider: spawn
        verifyTimeoutMs: 600000
```

## Verification: a second child that refutes the conclusion

A child that reasons over a corpus can derive a conclusion its sources do not support — a
retrieved fact and a guessed consequence look identical from the outside. The plugin closes that
gap the way a test suite closes it: with a **separate child whose job is to refute the
conclusion**.

`think_deep` runs that pass by default:

```
think_deep(task, focus, verify?)
  └─ fork#1   reasons over this conversation      → conclusion C1
       └─ spawn#1  adversarial review of C1        → confirmed | conflict
            └─ on conflict and a round left: fork#2 revises C1 against the objections
                 └─ spawn#2 reviews the revision  → confirmed | conflict
  returns the final conclusion plus the verification record
```

The verifier is a `spawn` child, so it inherits none of the thinking child's reasoning and reads
the conclusion cold. It is told to attack the **derived** claims, and it is told how to search:
for what the thing actually *is*, not for a phrase that happens to contain its words — the
difference between "what is this for" (finds a corn-shaped hot pad holder) and "corn and this"
(finds corn).

The verification record travels with the conclusion: the number of passes, the verdict, the
problems the reviewer raised, and the sources it used. A conclusion that nobody could source is
reported as such rather than dropped silently.

A verifier that answered in prose delivered no verdict, and that is not a confirmation: the pass
is reported as a conflict with the prose as the objection.

Verification costs one extra child and one extra round trip. Pass `verify: false` for a cheap
question, or set `verifyRounds: 0` in the configuration to turn the pass off entirely.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `searchProvider` | `spawn` | provider that runs the search child |
| `maxSources` | `5` | sources returned to the parent |
| `maxSnippetChars` | `400` | excerpt budget per source |
| `maxChildCalls` | `3` | retrieval calls the search child may make |
| `searchTimeoutMs` | `600000` | budget for one delegated search |
| `thinkProvider` | `fork` | provider that runs the thinking child |
| `maxThinkCalls` | `5` | retrieval calls the thinking child may make |
| `thinkTimeoutMs` | `900000` | budget for one delegated thought |
| `verifyRounds` | `2` | verification passes a delegated thought may run |
| `verifyProvider` | `spawn` | provider that runs the verifier |
| `verifyTimeoutMs` | `600000` | budget for one verification pass |

The search backend is a separate concern: **this plugin never chooses one.** Point
`web.searchProvider` at whatever the profile already pins.

## The thinking child's tool set

A child that reasons about the work has no business mutating it, so the thinking child runs with
the mutating tools restricted — `write`, `edit`, `pwsh`, `present`, `workflow`, and the delegation
tools themselves are denied, leaving 22 of the profile's 30 tools.

Resolving that list is subtle. `tools.restrict()` rejects a name the child does not know, and the
child's scope is **neither** the parent's scope **nor** the global view — a name the parent can see
(`schedule_create`) may still be unknown to the child, and a name in the global view
(`search_web`) may be invisible to the parent's scope. So the list is seeded from the parent's
scope, and when the child rejects it, the failure names every tool the child accepts; the plugin
recovers that list, remembers it, and retries. The failed spawn publishes no child, so the retry
is safe, and later delegations restrict on the first attempt.

## When the child answers in prose

A child asked for a structured result may answer in prose instead of calling `structured_output`.
The driver reports that run as an error even when its turn completed cleanly, and it reports the
child's answer in the output regardless. The projection therefore reads the answer **before** it
judges the stop reason: a finished deliberation is not discarded because the child skipped a tool
call.

The projections live in `src/project.ts` as pure functions, so that decision is testable without a
runtime.

## Measured behaviour

Sandbox runs on `MiniMax-M3.1-Flash-Preview`:

- `search_web`: the child's corpus stays out of the parent; the parent's context stayed flat at
  1–2% across a search.
- `think_deep`: a 2m40s delegated thought left the parent at 2% context while the child's session
  log grew past 86 KB. The parent received the conclusion, key points, assumptions, and risks —
  nothing else.

The saving is not free: the cost moves from the parent's context into the child's turns and
wall-clock time.

## Layout

```
src/index.ts     entry: registers both tools, the guard, the budgets, the prompt section
src/search.ts    search_web: spawn child, budgeted retrieval, projection
src/think.ts     think_deep: fork child, tool restriction, projection
src/project.ts   pure projections from a child's result to the parent's view
src/guard.ts     the execution-point rules: the search guard, the retrieval budget
verify/          specs and session-log readers
```

`verify/read-session-log.mjs` decodes a DSH session log — a concatenation of independently written
zstd frames, so a whole-buffer decompress yields only the first one. `verify/summarize-log.mjs`
reports the tools an agent was offered, the calls it made, and what its final message contained.

## Development

```sh
pnpm install        # install dependencies and build
pnpm run build      # bundle src/index.ts to lib/index.js
pnpm run typecheck  # tsc --noEmit
node verify/run-specs.mjs
```

The specs cover the projections, including the case this plugin exists to survive: a child that
answers in prose while the driver reports an error.

## License

MIT
