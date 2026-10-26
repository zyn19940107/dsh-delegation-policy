/**
 * Projecting a delegated child's result into the parent's view.
 *
 * These functions are pure so that the decision can be tested without a
 * runtime: the driver's stop reason is not a reliable signal that a child
 * failed, and a child's answer must not be discarded because of it.
 *
 * @module @local/dsh-delegation-policy/project
 */

/** The part of a delegated run's result these projections read. */
export interface DelegatedResult {
  /** The child's structured value, when it delivered one. */
  readonly structured?: unknown
  /** The content of the child's last non-empty assistant message. */
  readonly output: unknown
  /** The driver's terminal reason for the run. */
  readonly stopReason: string
  /** The driver's detail, when it had one. */
  readonly diagnostic?: string
}

/** The parent's view of one delegated thought. */
export interface ThinkProjection {
  conclusion: string
  keyPoints: string[]
  assumptions: string[]
  risks: string[]
}

/** The parent's view of one delegated search. */
export interface SearchProjection {
  answer: string
  sources: { url: string, title?: string, snippet?: string, publishedAt?: string }[]
  truncated: boolean
}

/** The parent's view of one verification pass. */
export interface VerdictProjection {
  verdict: 'confirmed' | 'conflict'
  problems: string[]
  evidence: { url: string, title?: string, snippet?: string }[]
}

/**
 * Read the text blocks of a child's final assistant message.
 *
 * @param output - the run's output value.
 * @returns the child's text, empty when it produced none.
 */
export function readFinalText(output: unknown): string {
  if (!Array.isArray(output)) return ''
  const parts: string[] = []
  for (const block of output) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as { type?: unknown, text?: unknown }
    if (record.type === 'text' && typeof record.text === 'string' && record.text.length > 0) {
      parts.push(record.text)
    }
  }
  return parts.join('\n\n').trim()
}

/**
 * Read one string array out of a structured value.
 *
 * @param value - the child's structured value.
 * @param key - the field to read.
 * @returns the strings in the field, empty when it is absent or not a list.
 */
export function readStringList(value: unknown, key: string): string[] {
  if (typeof value !== 'object' || value === null) return []
  const raw = (value as Record<string, unknown>)[key]
  if (!Array.isArray(raw)) return []
  return raw.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

/**
 * Build the error for a run that produced neither a structured value nor text.
 *
 * @param result - the run's result.
 * @param subject - what the delegated run was doing, in the message.
 * @returns the error to throw.
 */
export function noResultError(result: DelegatedResult, subject: string): Error {
  const detail = result.diagnostic === undefined ? '' : `: ${result.diagnostic}`
  if (result.stopReason === 'completed') {
    return new Error(`the ${subject} subagent returned neither a structured result nor any text`)
  }
  return new Error(`the ${subject} subagent ended with "${result.stopReason}"${detail}`)
}

/**
 * Project a delegated thought into the parent's view.
 *
 * A child that was asked for a structured result may answer in prose instead
 * of calling `structured_output`. The driver reports that run as an error even
 * when its turn completed cleanly, and it reports the child's answer in the
 * output regardless — so the answer is read before the stop reason is judged.
 * A finished deliberation is not discarded because the child skipped a tool
 * call.
 *
 * @param result - the run's result.
 * @returns the parent's view of the thought.
 */
export function projectThinkResult(result: DelegatedResult): ThinkProjection {
  if (result.structured !== undefined) {
    const structured = result.structured as { conclusion?: unknown }
    return {
      conclusion: typeof structured.conclusion === 'string' ? structured.conclusion : '',
      keyPoints: readStringList(result.structured, 'keyPoints'),
      assumptions: readStringList(result.structured, 'assumptions'),
      risks: readStringList(result.structured, 'risks'),
    }
  }
  const text = readFinalText(result.output)
  if (text.length > 0) {
    return { conclusion: text, keyPoints: [], assumptions: [], risks: [] }
  }
  throw noResultError(result, 'thinking')
}

/**
 * Project a delegated search into the parent's view.
 *
 * @param result - the run's result.
 * @param limit - the deployment's cap on returned sources.
 * @param maxSnippetChars - the excerpt budget per source.
 * @returns the parent's view of the search.
 */
export function projectSearchResult(
  result: DelegatedResult,
  limit: number,
  maxSnippetChars: number,
): SearchProjection {
  if (result.structured !== undefined) {
    const structured = result.structured as { answer?: unknown }
    return {
      answer: typeof structured.answer === 'string' ? structured.answer : '',
      sources: normalizeSources(result.structured, limit, maxSnippetChars),
      truncated: normalizeSources(result.structured, limit, maxSnippetChars).length >= limit,
    }
  }
  const text = readFinalText(result.output)
  if (text.length > 0) {
    return { answer: text, sources: [], truncated: false }
  }
  throw noResultError(result, 'search')
}

/**
 * Cut an excerpt to a character budget, marking the cut.
 *
 * @param text - the excerpt.
 * @param limit - the character budget.
 * @returns the excerpt, truncated with an ellipsis when it was longer.
 */
export function truncateExcerpt(text: string, limit: number): string {
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(1, limit - 1)).trimEnd()}…`
}

/**
 * Project the child's structured sources into the parent's source list: keep
 * the fields that carry information, cut each excerpt to the budget, drop
 * repeats by URL, and cap the count.
 *
 * @param value - the child's structured result.
 * @param maxSources - the deployment's cap on returned sources.
 * @param maxSnippetChars - the excerpt budget per source.
 * @returns the accepted sources, in the child's order.
 */
export function normalizeSources(
  value: unknown,
  maxSources: number,
  maxSnippetChars: number,
): { url: string, title?: string, snippet?: string, publishedAt?: string }[] {
  if (typeof value !== 'object' || value === null) return []
  const raw = (value as { sources?: unknown }).sources
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const sources: { url: string, title?: string, snippet?: string, publishedAt?: string }[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const url = record['url']
    if (typeof url !== 'string' || url.length === 0 || seen.has(url)) continue
    seen.add(url)
    const title = record['title']
    const snippet = record['snippet']
    const publishedAt = record['publishedAt']
    sources.push({
      url,
      ...typeof title === 'string' && title.length > 0 ? { title } : {},
      ...typeof snippet === 'string' && snippet.length > 0
        ? { snippet: truncateExcerpt(snippet, maxSnippetChars) }
        : {},
      ...typeof publishedAt === 'string' && publishedAt.length > 0 ? { publishedAt } : {},
    })
    if (sources.length >= maxSources) break
  }
  return sources
}

/**
 * Project a verification pass into the parent's view.
 *
 * A verifier that answered in prose did not deliver a verdict. That is not a
 * confirmation: the pass is reported as a conflict, and the prose becomes the
 * objection, because "no verdict" must not be read as "nothing to fix".
 *
 * @param result - the run's result.
 * @returns the parent's view of the verdict.
 */
export function projectVerdict(result: DelegatedResult): VerdictProjection {
  if (result.structured !== undefined) {
    const structured = result.structured as { verdict?: unknown }
    const problems = readStringList(result.structured, 'problems')
    const verdict = structured.verdict === 'confirmed' && problems.length === 0
      ? 'confirmed'
      : 'conflict'
    return { verdict, problems, evidence: normalizeEvidence(result.structured) }
  }
  const text = readFinalText(result.output)
  if (text.length === 0) throw noResultError(result, 'verifying')
  return { verdict: 'conflict', problems: [text], evidence: [] }
}

/**
 * Project a verifier's evidence into the parent's evidence list.
 *
 * @param value - the child's structured result.
 * @returns the accepted sources.
 */
export function normalizeEvidence(
  value: unknown,
): { url: string, title?: string, snippet?: string }[] {
  if (typeof value !== 'object' || value === null) return []
  const raw = (value as { evidence?: unknown }).evidence
  if (!Array.isArray(raw)) return []
  const sources: { url: string, title?: string, snippet?: string }[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const url = record['url']
    if (typeof url !== 'string' || url.length === 0) continue
    const title = record['title']
    const snippet = record['snippet']
    sources.push({
      url,
      ...typeof title === 'string' && title.length > 0 ? { title } : {},
      ...typeof snippet === 'string' && snippet.length > 0 ? { snippet } : {},
    })
  }
  return sources
}
