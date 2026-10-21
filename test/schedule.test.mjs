import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readyTasks } from '../out/schedule.mjs'

const t = (id, deps) => ({ id, title: id, agent: '', prompt: id, hash: id, line: 1, deps })

function ready(tasks, status = {}, extra = {}) {
  return readyTasks({
    ordered: tasks,
    status: (id) => status[id] ?? 'pending',
    attempted: new Set(extra.attempted ?? []),
    live: new Set(extra.live ?? []),
    fromId: extra.fromId,
    onlyId: extra.onlyId,
  }).map((x) => x.id)
}

test('a plan with no Depends on lines runs one task at a time, in order', () => {
  const plan = [t('T1'), t('T2'), t('T3')]
  assert.deepEqual(ready(plan), ['T1'])
  assert.deepEqual(ready(plan, { T1: 'done' }), ['T2'])
  assert.deepEqual(ready(plan, { T1: 'done', T2: 'skipped' }), ['T3'])
})

test('the next task does not start while the one before it is still running', () => {
  const plan = [t('T1'), t('T2')]
  assert.deepEqual(ready(plan, { T1: 'running' }, { attempted: ['T1'], live: ['T1'] }), [])
})

test('tasks that depend on the same thing start together', () => {
  const plan = [t('T1', []), t('T2', ['T1']), t('T3', ['T1']), t('T4', ['T2', 'T3'])]
  assert.deepEqual(ready(plan), ['T1'])
  assert.deepEqual(ready(plan, { T1: 'done' }), ['T2', 'T3'])
  assert.deepEqual(ready(plan, { T1: 'done', T2: 'done' }, { attempted: ['T2', 'T3'], live: ['T3'] }), [])
  assert.deepEqual(ready(plan, { T1: 'done', T2: 'done', T3: 'done' }), ['T4'])
})

test('Depends on: none starts at once, beside the first task', () => {
  assert.deepEqual(ready([t('T1'), t('T2', [])]), ['T1', 'T2'])
})

test('a failed task holds back what declared it, but not what follows it in a plain queue', () => {
  // T2 named T1, so it waits for it for good; T3 declares nothing of the kind.
  assert.deepEqual(ready([t('T1'), t('T2', ['T1']), t('T3', [])], { T1: 'blocked' }, { attempted: ['T1'] }), ['T3'])
  // With stopOnFailure off, an undeclared successor carries on past a failure.
  assert.deepEqual(ready([t('T1'), t('T2')], { T1: 'blocked' }, { attempted: ['T1'] }), ['T2'])
})

test('a failed task is not tried again in the same run', () => {
  assert.deepEqual(ready([t('T1')], { T1: 'blocked' }, { attempted: ['T1'] }), [])
})

test('a dependency the plan does not have is ignored, and a prose-only line falls back to order', () => {
  const plan = [t('T1'), t('T2', ['the', 'schema'])]
  assert.deepEqual(ready(plan), ['T1'])
  assert.deepEqual(ready(plan, { T1: 'done' }), ['T2'])
})

test('a task that asked something is picked up again and blocks what follows', () => {
  const plan = [t('T1'), t('T2')]
  assert.deepEqual(ready(plan, { T1: 'waiting' }), ['T1'])
  assert.deepEqual(ready(plan, { T1: 'waiting' }, { attempted: ['T1'], live: ['T1'] }), [])
})

test('from a task, everything before it counts as settled', () => {
  const plan = [t('T1'), t('T2', ['T1']), t('T3')]
  assert.deepEqual(ready(plan, {}, { fromId: 'T2' }), ['T2'])
})

test('only runs exactly one task, whatever it depends on', () => {
  const plan = [t('T1'), t('T2', ['T1'])]
  assert.deepEqual(ready(plan, {}, { onlyId: 'T2' }), ['T2'])
  assert.deepEqual(ready(plan, {}, { onlyId: 'T2', attempted: ['T2'] }), [])
})
