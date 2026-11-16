import test from 'node:test'
import assert from 'node:assert/strict'
import { decide, stuckTasks, moved, inserted } from '../out/backlog.mjs'

const T = (id, status = 'pending', extra = {}) => ({ id, status, limited: false, interrupted: false, ...extra })
const P = (name, over = {}) => ({
  path: `/r/docs/plans/${name}.md`,
  tasks: [T('T1')],
  running: false,
  hasWorktree: false,
  ...over,
})
const path = (n) => `/r/docs/plans/${n}.md`
const run = (backlog, plans, over = {}) =>
  decide({ backlog: backlog.map(path), plans, maxPlans: 1, resumeOnOpen: false, stopped: new Set(), ...over })
const names = (xs) => xs.map((p) => p.split('/').pop().replace('.md', ''))

test('starts the first plan in order, as far as there is room', () => {
  const d = run(['b', 'a', 'c'], [P('a'), P('b'), P('c')], { maxPlans: 2 })
  assert.deepEqual(names(d.start), ['b', 'a', 'c'])
  assert.equal(d.room, 2)
})

test('a running backlog plan uses up room and is not started again', () => {
  const d = run(['a', 'b'], [P('a', { running: true }), P('b')])
  assert.equal(d.room, 0)
  assert.deepEqual(d.skip.map((s) => s.reason), ['it is running'])
  const e = run(['a', 'b'], [P('a', { running: true }), P('b')], { maxPlans: 2 })
  assert.equal(e.room, 1)
})

test('a running plan that is off the backlog does not use room', () => {
  const d = run(['b'], [P('a', { running: true }), P('b')])
  assert.equal(d.room, 1)
})

test('blocked, failed and waiting tasks make a plan stuck', () => {
  for (const status of ['blocked', 'failed', 'waiting']) {
    const d = run(['a'], [P('a', { tasks: [T('T1', 'done'), T('T2', status)] })])
    assert.deepEqual(d.start, [])
    assert.deepEqual(d.stuck, [{ path: path('a'), tasks: [`T2 ${status}`] }])
  }
})

test('a limit-paused task is not stuck', () => {
  assert.deepEqual(stuckTasks([T('T1', 'paused', { limited: true })], false), [])
  const d = run(['a'], [P('a', { tasks: [T('T1', 'paused', { limited: true })] })])
  assert.deepEqual(names(d.start), ['a'])
})

test('another paused task is stuck, unless the window closing paused it and resumeOnOpen is on', () => {
  assert.deepEqual(stuckTasks([T('T1', 'paused')], false), ['T1 paused'])
  assert.deepEqual(stuckTasks([T('T1', 'paused', { interrupted: true })], false), ['T1 paused'])
  assert.deepEqual(stuckTasks([T('T1', 'paused', { interrupted: true })], true), [])
  assert.deepEqual(stuckTasks([T('T1', 'paused')], true), ['T1 paused'])
})

test('a plan with nothing left is dropped once merged, kept while its worktree remains', () => {
  const done = [T('T1', 'done'), T('T2', 'skipped')]
  const d = run(['a', 'b'], [P('a', { tasks: done }), P('b', { tasks: done, hasWorktree: true })])
  assert.deepEqual(names(d.drop), ['a'])
  assert.deepEqual(d.start, [])
  assert.match(d.skip[0].reason, /has not merged/)
})

test('a plan the user stopped is skipped, and stuck states are not reported for it', () => {
  const d = run(['a'], [P('a', { tasks: [T('T1', 'failed')] })], { stopped: new Set([path('a')]) })
  assert.deepEqual(d.start, [])
  assert.deepEqual(d.stuck, [])
  assert.match(d.skip[0].reason, /you stopped it/)
})

test('Runs after: waits for a predecessor that still has tasks', () => {
  const d = run(['b'], [P('a'), P('b', { runsAfter: ['a'] })])
  assert.deepEqual(d.start, [])
  assert.match(d.skip[0].reason, /waits for a/)
})

test('Runs after: starts once the predecessor is finished, and waits while it runs', () => {
  const fin = P('a', { tasks: [T('T1', 'done')] })
  assert.deepEqual(names(run(['b'], [fin, P('b', { runsAfter: ['a'] })]).start), ['b'])
  const live = P('a', { tasks: [T('T1', 'done')], running: true })
  assert.deepEqual(run(['b'], [live, P('b', { runsAfter: ['a'] })]).start, [])
})

test('Runs after: a successor behind its predecessor on the backlog waits for it, whatever the room', () => {
  const d = run(['a', 'b'], [P('a'), P('b', { runsAfter: ['a'] })], { maxPlans: 2 })
  assert.deepEqual(names(d.start), ['a'])
})

test('Runs after: naming no plan holds the plan back', () => {
  const d = run(['b'], [P('b', { runsAfter: ['zzz'] })])
  assert.deepEqual(d.start, [])
  assert.match(d.skip[0].reason, /matches no plan/)
})

test('a plan the workspace no longer has is skipped but kept', () => {
  const d = run(['gone'], [])
  assert.deepEqual(d.drop, [])
  assert.deepEqual(d.start, [])
})

test('moved swaps with a neighbour and refuses at the ends', () => {
  assert.deepEqual(moved(['a', 'b', 'c'], 'b', -1), ['b', 'a', 'c'])
  assert.deepEqual(moved(['a', 'b', 'c'], 'b', 1), ['a', 'c', 'b'])
  assert.equal(moved(['a', 'b'], 'a', -1), undefined)
  assert.equal(moved(['a', 'b'], 'b', 1), undefined)
  assert.equal(moved(['a'], 'x', 1), undefined)
})

test('inserted adds at the end, at a 1-based position, and moves a plan already there', () => {
  assert.deepEqual(inserted(['a', 'b'], 'c'), ['a', 'b', 'c'])
  assert.deepEqual(inserted(['a', 'b'], 'c', 1), ['c', 'a', 'b'])
  assert.deepEqual(inserted(['a', 'b'], 'c', 99), ['a', 'b', 'c'])
  assert.deepEqual(inserted(['a', 'b', 'c'], 'c', 1), ['c', 'a', 'b'])
  assert.deepEqual(inserted(['a', 'b'], 'a'), ['b', 'a'])
})
