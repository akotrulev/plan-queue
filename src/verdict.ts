export const SENTINEL_OK = 'PLAN_QUEUE: DONE'
export const SENTINEL_BAD = 'PLAN_QUEUE: BLOCKED'

export type Verdict =
  | { kind: 'done' }
  | { kind: 'failed'; reason: string }
  | { kind: 'blocked'; reason: string }
  /** The agent handed back to a person: the final message is its question. */
  | { kind: 'waiting'; question: string }

/**
 * How a turn that exited cleanly ended. Kept apart from the runner, which
 * needs VS Code, so it can be tested on its own.
 */
export function verdict(opts: {
  finalText: string
  /** The result message's subtype: 'success', or why the run was cut short. */
  subtype?: string
  sessionId?: string
  requireSentinel: boolean
}): Verdict {
  const { finalText, subtype, sessionId, requireSentinel } = opts

  // Out of turns or budget is a failure, not a question.
  if (subtype && subtype !== 'success') return { kind: 'failed', reason: subtype }

  const bad = finalText.match(new RegExp(`${SENTINEL_BAD}[:\\s]*(.*)`))
  if (bad) return { kind: 'blocked', reason: bad[1].trim() || 'blocked' }

  if (!requireSentinel || finalText.includes(SENTINEL_OK)) return { kind: 'done' }

  // Neither sentinel: the agent stopped to ask. With a session to resume it
  // waits for an answer; without one there is nothing to answer into.
  if (!sessionId || !finalText.trim()) return { kind: 'failed', reason: 'no completion sentinel' }
  return { kind: 'waiting', question: finalText.trim() }
}
