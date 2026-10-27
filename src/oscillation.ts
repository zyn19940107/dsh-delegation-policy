/**
 * Watching for a model that keeps revising the same point.
 *
 * A model that reasons over a hard question sometimes argues itself in a
 * circle: it asserts a direction, revises it, and asserts the first direction
 * again. The revisions are visible in the stream it produces — in the
 * reasoning it writes and in the text it puts in the conversation — so they
 * can be counted while the turn is running.
 *
 * Counting is not a diagnosis. A model that checks itself once is being
 * careful; a model that checks itself five times on one point is going in
 * circles. The count is reported, never acted on: the plugin does not interrupt
 * a turn on the strength of a marker count, because the same markers appear in
 * honest self-correction and the cost of a false positive is a reasoning turn
 * cut off mid-thought.
 *
 * @module @local/dsh-delegation-policy/oscillation
 */

/**
 * How many self-revisions in one turn count as going in circles.
 *
 * Measured on recorded turns: an ordinary long turn produced 10 of the precise
 * markers below, the turn that went in circles produced 20. The threshold sits
 * between them, so an ordinary turn is not reported.
 */
export const DEFAULT_OSCILLATION_THRESHOLD = 12

/**
 * Phrases a model writes when it revises a point it has already made.
 *
 * The list is deliberately narrow. Measured on recorded turns, a looser list —
 * one that counted "actually" and "其实" wherever they appeared — scored 34
 * markers on an ordinary turn and 54 on the turn that was going in circles:
 * too close to tell apart, and every ordinary turn would have been reported.
 * The phrases below mark a change of mind rather than an aside.
 */
export const CORRECTION_MARKERS: readonly string[] = [
  'let me reconsider',
  'on second thought',
  'hmm wait',
  'wait —',
  'wait,',
  '等等',
  '不对',
  '重新想想',
  '我想错',
]

/** The longest marker, used to carry text across stream boundaries. */
const LONGEST_MARKER = Math.max(...CORRECTION_MARKERS.map((marker) => marker.length))

/** How much text is carried forward, so a marker split across chunks is found. */
const CARRY = LONGEST_MARKER - 1

/**
 * Count the correction markers in one stretch of text.
 *
 * @param text - the text to scan.
 * @returns how many markers it contains.
 */
export function countCorrectionMarkers(text: string): number {
  const lower = text.toLowerCase()
  let count = 0
  for (const marker of CORRECTION_MARKERS) {
    let from = 0
    for (;;) {
      const at = lower.indexOf(marker, from)
      if (at < 0) break
      count += 1
      from = at + marker.length
    }
  }
  return count
}

/** What the tracker knows about one agent. */
interface AgentReading {
  /** The turn the count belongs to. */
  turn: number
  /** How many markers the turn has produced. */
  count: number
  /** The tail of the scanned text, carried into the next chunk. */
  carry: string
  /** Whether the threshold crossing has already been reported. */
  reported: boolean
}

/** The parent's reading, as a tool call reports it. */
export interface OscillationReading {
  /** How many correction markers this turn has produced. */
  count: number
  /** Whether the count has reached the threshold. */
  overThreshold: boolean
  /** The turn the count belongs to. */
  turn: number
}

/**
 * What to do when a turn has revised itself past the threshold.
 *
 * - `observe` counts and reports; the turn is never interrupted.
 * - `interrupt` refuses the next tool call once per turn, with the count in the
 *   refusal, so the model is told to settle the point instead of re-deriving it.
 */
export type OscillationAction = 'observe' | 'interrupt'

/**
 * Build a guard that interrupts a turn that has gone in circles.
 *
 * The refusal happens once per turn: the count stays high for the rest of the
 * turn, and refusing every call would wedge the model.
 *
 * @param tracker - the counter.
 * @param threshold - how many revisions count as going in circles.
 * @param action - what to do when the threshold is reached.
 * @returns the guard.
 */
export function createOscillationGuard(
  tracker: OscillationTracker,
  threshold: number,
  action: OscillationAction,
): (execution: { agent?: { session: { id: string } } }) => string | undefined {
  return (execution) => {
    if (action !== 'interrupt') return undefined
    const agent = execution.agent
    if (agent === undefined) return undefined
    const reading = tracker.reading(agent.session.id, threshold)
    if (!reading.overThreshold) return undefined
    if (!tracker.claimReport(agent.session.id, reading.turn)) return undefined
    return `This turn has revised itself ${reading.count} times on the same point, so the reasoning `
      + 'is going in circles. Settle it now: state the answer you are most confident in and the one '
      + 'question still open, and continue from there. If the point needs a judgement, delegate it with '
      + 'think_deep instead of re-deriving it here.'
  }
}

/**
 * Counts correction markers per agent and per turn.
 *
 * The tracker follows the stream, so a marker that a model writes across two
 * chunks is still found: the tail of the previous chunk is carried into the
 * next scan, and a marker that ends inside the new chunk is counted once.
 */
export class OscillationTracker {
  private readonly agents = new Map<string, AgentReading>()

  /**
   * Feed one streamed fragment.
   *
   * @param sessionId - the agent's session id.
   * @param turn - the turn the fragment belongs to.
   * @param text - the fragment.
   * @returns the agent's reading after the fragment.
   */
  observe(sessionId: string, turn: number, text: string): OscillationReading {
    let reading = this.agents.get(sessionId)
    if (reading === undefined || reading.turn !== turn) {
      reading = { turn, count: 0, carry: '', reported: false }
      this.agents.set(sessionId, reading)
    }
    const region = reading.carry + text
    const lower = region.toLowerCase()
    for (const marker of CORRECTION_MARKERS) {
      let from = 0
      for (;;) {
        const at = lower.indexOf(marker, from)
        if (at < 0) break
        // A marker that ends inside the new text is new; one that sits wholly
        // in the carry was counted when it arrived.
        if (at + marker.length > reading.carry.length) reading.count += 1
        from = at + marker.length
      }
    }
    reading.carry = region.length > CARRY ? region.slice(region.length - CARRY) : region
    return { count: reading.count, overThreshold: false, turn: reading.turn }
  }

  /**
   * The reading of one agent.
   *
   * @param sessionId - the agent's session id.
   * @returns the count and whether it reached the threshold.
   */
  reading(sessionId: string, threshold: number): OscillationReading {
    const reading = this.agents.get(sessionId)
    if (reading === undefined) return { count: 0, overThreshold: false, turn: 0 }
    return { count: reading.count, overThreshold: reading.count >= threshold, turn: reading.turn }
  }

  /**
   * Whether the threshold crossing has not been reported yet for this turn.
   *
   * @param sessionId - the agent's session id.
   * @param turn - the turn to report on.
   * @returns true when the caller should report and then mark it reported.
   */
  claimReport(sessionId: string, turn: number): boolean {
    const reading = this.agents.get(sessionId)
    if (reading === undefined || reading.turn !== turn || reading.reported) return false
    reading.reported = true
    return true
  }
}
