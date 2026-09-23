import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verdict } from '../out/verdict.mjs'

const base = { subtype: 'success', sessionId: 'abc', requireSentinel: true }

test('the done sentinel finishes the task', () => {
  assert.deepEqual(verdict({ ...base, finalText: 'All landed.\nPLAN_QUEUE: DONE' }), { kind: 'done' })
})

test('the blocked sentinel carries its reason', () => {
  assert.deepEqual(verdict({ ...base, finalText: 'PLAN_QUEUE: BLOCKED tests fail on CI' }), {
    kind: 'blocked',
    reason: 'tests fail on CI',
  })
  assert.deepEqual(verdict({ ...base, finalText: 'PLAN_QUEUE: BLOCKED' }), { kind: 'blocked', reason: 'blocked' })
})

test('neither sentinel means the agent is asking, and the question is its message', () => {
  assert.deepEqual(verdict({ ...base, finalText: '  Should the table be soft-deleted or dropped?\n' }), {
    kind: 'waiting',
    question: 'Should the table be soft-deleted or dropped?',
  })
})

test('no session to resume, or nothing said, is a failure rather than a question', () => {
  assert.deepEqual(verdict({ ...base, sessionId: undefined, finalText: 'Which one?' }), {
    kind: 'failed',
    reason: 'no completion sentinel',
  })
  assert.deepEqual(verdict({ ...base, finalText: '   ' }), { kind: 'failed', reason: 'no completion sentinel' })
})

test('running out of turns or budget fails, even with a question on the end', () => {
  assert.deepEqual(verdict({ ...base, subtype: 'error_max_turns', finalText: 'Which one?' }), {
    kind: 'failed',
    reason: 'error_max_turns',
  })
})

test('with the sentinel not required, a clean exit is done', () => {
  assert.deepEqual(verdict({ ...base, requireSentinel: false, finalText: 'Which one?' }), { kind: 'done' })
  // Blocked still wins.
  assert.equal(verdict({ ...base, requireSentinel: false, finalText: 'PLAN_QUEUE: BLOCKED x' }).kind, 'blocked')
})
