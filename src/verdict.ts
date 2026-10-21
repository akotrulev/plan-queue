export const SENTINEL_OK = 'PLAN_QUEUE: DONE'
export const SENTINEL_BAD = 'PLAN_QUEUE: BLOCKED'
export const SENTINEL_ASK = 'PLAN_QUEUE: QUESTION'

export type Verdict =
  | { kind: 'done' }
  | { kind: 'failed'; reason: string }
  | { kind: 'blocked'; reason: string }
  /** The agent handed back to a person: the final message is its question. */
  | { kind: 'waiting'; question: string }
  /**
   * The turn ended with no sentinel at all. Usually the agent finished and
   * forgot the line; sometimes it is asking without saying so. The queue asks
   * it once which, before bothering a person.
   */
  | { kind: 'silent'; text: string }

/** A line as the model may dress it: `**PLAN_QUEUE: DONE**`, `` `PLAN_QUEUE: DONE` ``. */
function bare(line: string): string {
  return line.trim().replace(/^[*_`>\s]+|[*_`\s.!]+$/g, '')
}

/**
 * How a turn that exited cleanly ended. Kept apart from the runner, which
 * needs VS Code, so it can be tested on its own.
 *
 * A sentinel only counts on a line of its own, and the last such line wins, so
 * a message that merely mentions one ("I'll print PLAN_QUEUE: DONE once the
 * tests pass") is not taken for it.
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

  const lines = finalText.split(/\r?\n/)
  let at = -1
  let line = ''
  for (let i = lines.length - 1; i >= 0; i--) {
    const b = bare(lines[i])
    if (b.startsWith(SENTINEL_OK) || b.startsWith(SENTINEL_BAD) || b.startsWith(SENTINEL_ASK)) {
      at = i
      line = b
      break
    }
  }

  if (line.startsWith(SENTINEL_BAD)) {
    return { kind: 'blocked', reason: line.slice(SENTINEL_BAD.length).replace(/^[:\s—–-]+/, '').trim() || 'blocked' }
  }
  if (line === SENTINEL_OK || !requireSentinel) return { kind: 'done' }

  // There is nothing to answer into without a session to resume.
  const noSession = { kind: 'failed', reason: 'no completion sentinel' } as const
  if (line.startsWith(SENTINEL_ASK)) {
    const question = [...lines.slice(0, at), line.slice(SENTINEL_ASK.length).replace(/^[:\s]+/, '')]
      .join('\n')
      .trim()
    return sessionId && question ? { kind: 'waiting', question } : noSession
  }
  if (!sessionId || !finalText.trim()) return noSession
  return { kind: 'silent', text: finalText.trim() }
}

/** Sent, once, to a task that ended its turn with no sentinel. */
export const NUDGE = [
  'Your last message ended with none of the queue\'s lines, so the queue cannot tell how the task went.',
  `If the task is finished and its gate passed, reply with only "${SENTINEL_OK}".`,
  `If it cannot be finished, reply with only "${SENTINEL_BAD} <one-line reason>".`,
  `If you need an answer from a person, restate the question briefly and end with a line "${SENTINEL_ASK}".`,
  'Do not do any more work in this reply.',
].join(' ')
