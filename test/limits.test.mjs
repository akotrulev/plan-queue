import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRateLimitEvent, limitFromText, isTransient, LimitGate, WEEKLY_FALLBACK_MS } from '../out/limits.mjs'

const ev = (info) => ({ type: 'rate_limit_event', rate_limit_info: info })

test('parses a rejected event, seconds to milliseconds', () => {
  const i = parseRateLimitEvent(ev({ status: 'rejected', resetsAt: 1760000000, rateLimitType: 'five_hour' }))
  assert.deepEqual(i, { status: 'rejected', resetsAt: 1760000000000, type: 'five_hour' })
})

test('normalises utilization given as a fraction or a percentage', () => {
  assert.equal(parseRateLimitEvent(ev({ status: 'allowed_warning', utilization: 0.8 })).utilization, 0.8)
  assert.equal(parseRateLimitEvent(ev({ status: 'allowed_warning', utilization: 85 })).utilization, 0.85)
  assert.equal(parseRateLimitEvent(ev({ status: 'allowed_warning' })).utilization, undefined)
})

test('ignores other messages and bad shapes', () => {
  assert.equal(parseRateLimitEvent({ type: 'result' }), undefined)
  assert.equal(parseRateLimitEvent(null), undefined)
  assert.equal(parseRateLimitEvent(ev({ status: 'nonsense' })), undefined)
  assert.equal(parseRateLimitEvent({ type: 'rate_limit_event' }), undefined)
})

test('rejected while overage covers it counts as allowed', () => {
  assert.equal(parseRateLimitEvent(ev({ status: 'rejected', isUsingOverage: true })).status, 'allowed')
})

test('limitFromText: epoch form', () => {
  const i = limitFromText('Claude AI usage limit reached|1760000000', 0)
  assert.equal(i.status, 'rejected')
  assert.equal(i.resetsAt, 1760000000000)
})

test('limitFromText: clock times, next occurrence, local', () => {
  const now = new Date(2026, 10, 16, 1, 0, 0).getTime()
  const a = limitFromText("You've hit your limit · resets 3am", now)
  assert.equal(a.resetsAt, new Date(2026, 10, 16, 3, 0, 0).getTime())
  const b = limitFromText("You've hit your limit · resets 3:30pm", now)
  assert.equal(b.resetsAt, new Date(2026, 10, 16, 15, 30, 0).getTime())
  const later = new Date(2026, 10, 16, 4, 0, 0).getTime()
  assert.equal(limitFromText("You've hit your limit · resets 3am", later).resetsAt, new Date(2026, 10, 17, 3, 0, 0).getTime())
  assert.equal(limitFromText('12am', now), undefined)
  assert.equal(limitFromText("You've hit your limit · resets 12am", now).resetsAt, new Date(2026, 10, 17, 0, 0, 0).getTime())
})

test('limitFromText: 24-hour time, local', () => {
  const now = new Date(2026, 10, 16, 1, 0, 0).getTime()
  assert.equal(limitFromText('You hit your limit · resets 15:30', now).resetsAt, new Date(2026, 10, 16, 15, 30, 0).getTime())
  assert.equal(limitFromText('You hit your limit · resets 0:15', now).resetsAt, new Date(2026, 10, 17, 0, 15, 0).getTime())
  assert.equal(limitFromText('You hit your limit · resets 25:00', now).resetsAt, undefined)
})

test('limitFromText: month and day, local', () => {
  const now = new Date(2026, 10, 16, 1, 0, 0).getTime()
  const i = limitFromText("You've hit your weekly limit · resets Nov 21, 10am", now)
  assert.equal(i.resetsAt, new Date(2026, 10, 21, 10, 0, 0).getTime())
  assert.equal(i.type, 'seven_day')
  // A date that has passed means next year.
  const j = limitFromText("You've hit your limit · resets Jan 3, 9am", now)
  assert.equal(j.resetsAt, new Date(2027, 0, 3, 9, 0, 0).getTime())
})

test('limitFromText: the zone in parentheses is honoured', () => {
  const now = Date.UTC(2026, 10, 16, 10, 0, 0)
  // Sofia is UTC+2 in November.
  assert.equal(limitFromText("You've hit your limit · resets 3:30pm (Europe/Sofia)", now).resetsAt, Date.UTC(2026, 10, 16, 13, 30))
  assert.equal(limitFromText("You've hit your limit · resets 3am (Europe/Sofia)", now).resetsAt, Date.UTC(2026, 10, 17, 1, 0))
  assert.equal(limitFromText("You've hit your limit · resets Nov 21, 10am (Europe/Sofia)", now).resetsAt, Date.UTC(2026, 10, 21, 8, 0))
  // New York is UTC-5 then.
  assert.equal(limitFromText("You've hit your limit · resets 15:30 (America/New_York)", now).resetsAt, Date.UTC(2026, 10, 16, 20, 30))
  // An unknown zone falls back to local time rather than failing.
  const local = new Date(2026, 10, 16, 15, 30).getTime()
  assert.equal(limitFromText("resets 3:30pm (Nowhere/Land) · You've hit your limit", new Date(2026, 10, 16, 1).getTime()).resetsAt, local)
})

test('limitFromText: weekly limits with no time wait longer', () => {
  assert.equal(limitFromText("You've hit your weekly limit", 1000).resetsAt, 1000 + WEEKLY_FALLBACK_MS)
  assert.equal(limitFromText("You've hit your 7-day limit", 1000).resetsAt, 1000 + WEEKLY_FALLBACK_MS)
  assert.equal(limitFromText("You've hit your 5-hour limit", 1000).resetsAt, undefined)
})

test('limitFromText: no reset time, and unrelated text', () => {
  const i = limitFromText('usage limit reached', 0)
  assert.equal(i.status, 'rejected')
  assert.equal(i.resetsAt, undefined)
  assert.equal(limitFromText('all good', 0), undefined)
})

test('isTransient', () => {
  for (const t of ['API Error: 529 overloaded_error', 'Error: ECONNRESET', 'fetch failed', 'Request timed out', 'socket hang up', '503 Service Unavailable'])
    assert.equal(isTransient(t), true, t)
  assert.equal(isTransient("You've hit your limit · resets 3am"), false)
  assert.equal(isTransient('API Error: usage limit reached'), false)
  assert.equal(isTransient('a test failed'), false)
  for (const t of ['API Error: 400 prompt is too long', 'API Error: 401 invalid x-api-key', 'API Error: 403 forbidden', 'API Error: 404 not found'])
    assert.equal(isTransient(t), false, t)
  assert.equal(isTransient('ran 500 tests, 3 failed'), false)
  assert.equal(isTransient('wrote 503 lines'), false)
  assert.equal(isTransient('API Error: 500 Internal server error'), true)
  assert.equal(isTransient('API Error: 502'), true)
  assert.equal(isTransient(''), false)
})

const OPTS = { startThreshold: 0, fallbackMs: 60_000 }

test('gate: rejected blocks until resetsAt, then expires', () => {
  let now = 1000
  const g = new LimitGate(() => now)
  g.observe({ status: 'rejected', resetsAt: 5000, type: 'five_hour' })
  assert.equal(g.blockedUntil(OPTS), 5000)
  now = 5000
  assert.equal(g.blockedUntil(OPTS), undefined)
})

test('gate: a resume delay is added to a known reset', () => {
  let now = 1000
  const g = new LimitGate(() => now)
  const o = { ...OPTS, resumeDelayMs: 500 }
  g.observe({ status: 'rejected', resetsAt: 5000, type: 'five_hour' })
  assert.equal(g.blockedUntil(o), 5500)
  assert.equal(g.lastBlockEnd(o), 5500)
  now = 5200
  assert.equal(g.blockedUntil(o), 5500)
  now = 5500
  assert.equal(g.blockedUntil(o), undefined)
})

test('gate: rejected with no reset uses the fallback', () => {
  const g = new LimitGate(() => 1000)
  g.observe({ status: 'rejected' })
  assert.equal(g.blockedUntil(OPTS), 61_000)
})

test('gate: warnings block only past the threshold', () => {
  const g = new LimitGate(() => 1000)
  g.observe({ status: 'allowed_warning', resetsAt: 9000, type: 'five_hour', utilization: 0.9 })
  assert.equal(g.blockedUntil(OPTS), undefined)
  assert.equal(g.blockedUntil({ ...OPTS, startThreshold: 0.95 }), undefined)
  assert.equal(g.blockedUntil({ ...OPTS, startThreshold: 0.9 }), 9000)
})

test('gate: longest block wins; allowed clears a window', () => {
  const g = new LimitGate(() => 1000)
  g.observe({ status: 'rejected', resetsAt: 5000, type: 'five_hour' })
  g.observe({ status: 'rejected', resetsAt: 90_000, type: 'seven_day' })
  assert.equal(g.blockedUntil(OPTS), 90_000)
  assert.equal(g.blockedType(OPTS), 'seven_day')
  g.observe({ status: 'allowed', type: 'seven_day' })
  assert.equal(g.blockedUntil(OPTS), 5000)
  g.clear()
  assert.equal(g.blockedUntil(OPTS), undefined)
})

test('gate: a warning does not demote a rejected window', () => {
  const g = new LimitGate(() => 1000)
  g.observe({ status: 'rejected', resetsAt: 5000, type: 'five_hour' })
  g.observe({ status: 'allowed_warning', resetsAt: 5000, type: 'five_hour', utilization: 0.5 })
  assert.equal(g.blockedUntil(OPTS), 5000)
})

test('gate: snapshot and restore', () => {
  const g = new LimitGate(() => 1000)
  g.observe({ status: 'rejected', resetsAt: 5000, type: 'five_hour' })
  const r = LimitGate.restore(JSON.parse(JSON.stringify(g.snapshot())), () => 2000)
  assert.equal(r.blockedUntil(OPTS), 5000)
  assert.equal(LimitGate.restore(undefined).blockedUntil(OPTS), undefined)
})
