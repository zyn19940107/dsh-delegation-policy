/**
 * The `search_web` route: web search, delegated to a clean-context child.
 *
 * The provider this route delegates to is whatever the profile already pins;
 * this module never chooses a search backend itself.
 *
 * @module @local/dsh-delegation-policy/search
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { registerChild, releaseChildBudget, type ChildBudget } from './guard.js'
import { normalizeSources, projectSearchResult, type SearchProjection } from './project.js'

/** Provider that runs the search child. */
export const DEFAULT_SEARCH_PROVIDER = 'spawn'

/** Tools the search child may use. Everything else is filtered out of its view. */
export const CHILD_TOOLS: readonly string[] = ['web_search', 'web_fetch']

/** Default cap on sources the parent receives from one search. */
export const DEFAULT_MAX_SOURCES = 5

/** Default cap on excerpt characters kept per source. */
export const DEFAULT_MAX_SNIPPET_CHARS = 400

/** Default number of retrieval calls the search child may make in one search. */
export const DEFAULT_MAX_CHILD_CALLS = 3

/**
 * Default budget for one delegated search. The child runs a search, may fetch
 * a page or two, and writes a summary: several model turns on the provider, so
 * the budget has to cover a whole child turn rather than one HTTP call.
 */
export const DEFAULT_SEARCH_TIMEOUT_MS = 600_000

/**
 * The structured result the search child delivers. The child calls the
 * runtime's `structured_output` tool with this schema; the driver validates
 * the value and hands it back as the run's structured result.
 */
export const CHILD_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'sources'],
  properties: {
    answer: {
      type: 'string',
      description: 'What the sources actually say about the query, in a few sentences.',
    },
    sources: {
      type: 'array',
      description: 'The sources that were actually used.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['url'],
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          snippet: { type: 'string' },
          publishedAt: { type: 'string' },
        },
      },
    },
  },
}

/** Model-facing `search_web` arguments. */
interface SearchWebArgs {
  query: string
  focus?: string
  maxSources?: number
}

/** One source as the parent receives it. */
interface SearchWebSource {
  url: string
  title?: string
  snippet?: string
  publishedAt?: string
}

/** The canonical `search_web` output value. */
interface SearchWebOutput {
  answer: string
  sources: SearchWebSource[]
  truncated: boolean
}

/** Search route configuration. */
export interface SearchConfig {
  provider: string
  maxSources: number
  maxSnippetChars: number
  maxChildCalls: number
  timeoutMs: number
}

/**
 * Validate the model's arguments. The schema already enforces the types; this
 * rejects a blank query and bounds the requested source count.
 *
 * @param args - the schema-validated arguments.
 * @param maxSources - the deployment's cap on returned sources.
 * @returns the accepted arguments.
 */
export function parseSearchWebArgs(args: SearchWebArgs, maxSources: number): SearchWebArgs {
  if (typeof args.query !== 'string' || args.query.trim().length === 0) {
    throw new Error('query must be a non-empty string')
  }
  const requested = args.maxSources
  if (requested !== undefined && (!Number.isInteger(requested) || requested < 1)) {
    throw new Error('maxSources must be a positive integer')
  }
  return {
    query: args.query,
    ...args.focus !== undefined ? { focus: args.focus } : {},
    ...requested !== undefined ? { maxSources: Math.min(requested, maxSources) } : {},
  }
}

/**
 * Format the parent's view of one search: the child's answer, then the
 * sources it used.
 *
 * @param value - the canonical output value.
 * @returns the model-facing text.
 */
export function formatSearchWebOutput(value: SearchWebOutput): string {
  const parts: string[] = []
  if (value.answer.length > 0) parts.push(value.answer)
  if (value.sources.length > 0) {
    const lines = value.sources.map((source) => {
      const label = source.title ?? hostnameOf(source.url)
      const meta: string[] = []
      if (source.snippet !== undefined) meta.push(source.snippet)
      if (source.publishedAt !== undefined) meta.push(`(${source.publishedAt})`)
      const suffix = meta.length > 0 ? ` — ${meta.join(' ')}` : ''
      return `- [${label}](${source.url})${suffix}`
    })
    parts.push(`Sources:\n${lines.join('\n')}`)
  }
  parts.push('Cite the relevant URLs above as markdown links in your answer.')
  return parts.join('\n\n')
}

/**
 * Display label for a source: its title, else its hostname.
 *
 * @param url - the source URL.
 * @returns the label.
 */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/**
 * Build the search child's instruction. The child is told to report a
 * conclusion, not to relay a corpus, and it is told the reading budget it has.
 *
 * @param query - what to search for.
 * @param focus - what the answer must cover, when the caller narrowed it.
 * @param maxCalls - the retrieval calls the child has.
 * @returns the child's instruction.
 */
export function buildSearchChildPrompt(query: string, focus: string | undefined, maxCalls: number): string {
  const parts: string[] = [`Search the web for: ${query}`]
  if (focus !== undefined && focus.trim().length > 0) {
    parts.push(`Only report what matters for this question: ${focus}`)
  }
  parts.push(
    'Use the web_search tool to find candidate sources. When a snippet is not enough to answer the '
    + 'question, use web_fetch to read the most promising page.',
    `You have a reading budget of ${maxCalls} retrieval calls. Spend it on the most promising sources, `
    + 'then answer — a source you did not read is better than a summary padded with material you did.',
    'Then deliver your result with the structured_output tool:',
    '- answer: two to six sentences stating what the sources actually say. Include concrete names, '
    + 'versions, numbers, and dates. Say plainly when the sources disagree, or when the web has no answer.',
    '- sources: the two to five sources you actually used, each with its url, its title, and a '
    + 'one-sentence snippet under 200 characters that supports the answer.',
    'Do not paste long excerpts. Do not list a source you did not use.',
  )
  return parts.join('\n\n')
}

/**
 * Run one delegated search child and project its result.
 *
 * @param ctx - the plugin context supplying the registries.
 * @param config - the resolved search configuration.
 * @param budget - the budget that covers this route's children.
 * @param parent - the agent the search runs on behalf of.
 * @param signal - the caller's signal.
 * @param prompt - the child's instruction.
 * @param maxCalls - the retrieval calls the child has; defaults to the route's limit.
 * @returns the parent's view of what the child found.
 */
export async function delegateSearch(
  ctx: Context,
  config: SearchConfig,
  budget: ChildBudget,
  parent: Agent,
  signal: AbortSignal,
  prompt: string,
  maxCalls: number = config.maxChildCalls,
): Promise<SearchProjection> {
  const run = await ctx.subagents.start(config.provider, {
    parent,
    prompt: [{ type: 'text', text: prompt }] as ContentBlock[],
    signal,
    outputSchema: CHILD_OUTPUT_SCHEMA,
    toolFilter: { allow: [...CHILD_TOOLS] },
  })
  registerChild(budget, run.id, maxCalls)
  try {
    const result = await run.result
    return projectSearchResult(result, config.maxSources, config.maxSnippetChars)
  } finally {
    releaseChildBudget(budget, run.id)
    await run.dispose()
  }
}

/**
 * Register the `search_web` tool.
 *
 * The configuration is read when a call runs, not when the tool is registered:
 * the settings page writes the plugin's limits at runtime, and the next
 * delegated search must use what the page last saved.
 *
 * @param ctx - the plugin context supplying the registries.
 * @param readConfig - the reader for the current search configuration.
 * @param budget - the budget that covers this route's children.
 * @returns the budget, so the caller can release children against it.
 */
export function applySearchTool(
  ctx: Context,
  readConfig: () => SearchConfig,
  budget: ChildBudget,
): void {
  const registered = readConfig()
  ctx.tools.register(defineTool({
    name: 'search_web',
    description: 'Search the web for current information. Use it for any fact that lives outside this '
      + 'conversation; the user need not ask for it, and once you have decided a fact is external, '
      + 'dispatch the search now rather than reading around it first. The search runs in a delegated '
      + 'subagent, which reads what it needs and returns a concise answer plus the sources it used.',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'What to search for.',
      },
      focus: {
        type: 'string',
        description: 'What the answer must cover, when the query is broader than the question.',
      },
      maxSources: {
        type: 'number',
        description: `How many sources to return; at most ${registered.maxSources}.`,
      },
    },
    output: {
      schema: {
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
                snippet: { type: 'string' },
                publishedAt: { type: 'string' },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: formatSearchWebOutput(value as SearchWebOutput) }],
    },
    // A delegated search is a foreground operation on the parent's behalf.
    isConcurrencySafe: () => false,
    timeoutMs: registered.timeoutMs,
    async execute(args, exec) {
      const config = readConfig()
      const parsed = parseSearchWebArgs(args as SearchWebArgs, config.maxSources)
      const parent = exec.agent
      if (parent === undefined) {
        throw new Error('search_web needs an agent to delegate from')
      }
      const limit = parsed.maxSources ?? config.maxSources
      const projection = await delegateSearch(
        ctx,
        { ...config, maxSources: limit },
        budget,
        parent,
        exec.signal,
        buildSearchChildPrompt(parsed.query, parsed.focus, config.maxChildCalls),
      )
      return {
        answer: projection.answer,
        sources: projection.sources,
        truncated: projection.truncated,
      }
    },
    presentCall: (args) => {
      const query = (args as SearchWebArgs).query
      return { card: 'generic', title: query, kind: 'search', rawInput: query }
    },
  }))
}
