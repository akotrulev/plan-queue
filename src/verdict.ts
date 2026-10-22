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
  `If the task's work landed (a test you believe is wrong, written down, does not stop it), reply with only "${SENTINEL_OK}".`,
  `If the work cannot go on at all (a merge conflict, a missing dependency or credential — never just a red test), reply with only "${SENTINEL_BAD} <one-line reason>".`,
  `If you need an answer from a person, restate the question briefly and end with a line "${SENTINEL_ASK}".`,
  'Do not do any more work in this reply.',
].join(' ')

/** Sent to a paused task when it is resumed: the session picks up where it was cut off. */
export const RESUMED = [
  'The queue paused this task part-way through, and has now resumed it in the same session.',
  'A tool call cut off by the pause shows as rejected or declined: that was the pause, not a person refusing it, so run it again if it is still needed.',
  'Whatever else was running when it paused — a command, a test run — was interrupted too; check its state before relying on it.',
  'Carry on from where you stopped. If the work had in fact already landed, say so.',
  `End as before, with "${SENTINEL_OK}", "${SENTINEL_BAD} <one-line reason>" or a question and "${SENTINEL_ASK}".`,
].join(' ')
