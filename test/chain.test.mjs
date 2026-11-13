import { test } from 'node:test'
import assert from 'node:assert/strict'
import { namesPlan, successors } from '../out/chain.mjs'
import { parsePlanText, parseRunsAfter } from '../out/plan.mjs'

test('a ref names a plan by its whole name or its number', () => {
  assert.ok(namesPlan('156', '/r/docs/plans/156-next-step.md'))
  assert.ok(namesPlan('156-next-step', '/r/docs/plans/156-next-step.md'))
  assert.ok(namesPlan('156-next-step.md', '/r/docs/plans/implemented/156-next-step.md'))
  assert.ok(namesPlan('storefront', '/r/docs/plans/storefront.md'))
  assert.ok(!namesPlan('15', '/r/docs/plans/156-next-step.md'))
  assert.ok(!namesPlan('1560', '/r/docs/plans/156-next-step.md'))
})

test('Runs after: reads the leading list and stops at prose', () => {
  assert.deepEqual(parseRunsAfter('**Runs after:** 156'), ['156'])
  assert.deepEqual(parseRunsAfter('> **Runs after:** 156'), ['156'])
  assert.deepEqual(parseRunsAfter('**Runs after**: 156, 157 and 158.'), ['156', '157', '158'])
  assert.deepEqual(parseRunsAfter('- Runs after: plan 156 & `157-cost`'), ['156', '157-cost'])
  assert.deepEqual(parseRunsAfter('Runs after: [156](156-next-step.md)'), ['156'])
  assert.deepEqual(
    parseRunsAfter('**Runs after:** 159 (the whole plan), which itself runs after the adviser plans 156, 157 and 158'),
    ['159'],
  )
  assert.deepEqual(parseRunsAfter('Runs after: none'), [])
  assert.deepEqual(parseRunsAfter('**Runs after:** 156. Plan Queue starts this plan by itself once 156 has merged.'), ['156'])
  assert.deepEqual(parseRunsAfter('Runs after: 156-a.md'), ['156-a.md'])
  assert.equal(parseRunsAfter('Runs after the adviser plans land.'), undefined)
  assert.equal(parseRunsAfter('It runs after: 156'), undefined)
})

test('the plan keeps the first Runs after: outside the prompts', () => {
  const plan = parsePlanText(
    [
      '# 157 — cost',
      '',
      '```',
      'Runs after: 999',
      '```',
      '**Runs after:** 156',
      'Runs after: 155',
      '',
      '## Prompts',
      '',
      '### B1 — x (`be-node`, `be`)',
      '',
      '> Runs after: 100',
    ].join('\n'),
    '/r/docs/plans/157-cost.md',
  )
  assert.deepEqual(plan.runsAfter, ['156'])
  assert.equal(plan.tasks[0].prompt, 'Runs after: 100')
  assert.equal(parsePlanText('# x\n\n## Prompts\n', '/x.md').runsAfter, undefined)
})

const P = (name, extra = {}) => ({
  path: `/r/docs/plans/${name}.md`,
  left: 3,
  running: false,
  hasWorktree: false,
  ...extra,
})

test('the plan naming the merged one starts; others do not', () => {
  const merged = '/r/docs/plans/156-a.md'
  const got = successors(merged, [
    P('156-a', { left: 0 }),
    P('157-b', { runsAfter: ['156'] }),
    P('158-c', { runsAfter: ['157'] }),
    P('159-d'),
  ])
  assert.deepEqual(got, [{ path: '/r/docs/plans/157-b.md', start: true }])
})

test('a plan naming several waits for the last of them', () => {
  const merged = '/r/docs/plans/156-a.md'
  const plans = [P('156-a', { left: 0 }), P('157-b'), P('158-c', { runsAfter: ['156', '157'] })]
  assert.deepEqual(successors(merged, plans), [
    { path: '/r/docs/plans/158-c.md', start: false, reason: 'it still waits for 157' },
  ])
  plans[1].left = 0
  assert.deepEqual(successors(merged, plans), [{ path: '/r/docs/plans/158-c.md', start: true }])
})

test('the merged plan counts as finished even if its file still lists tasks', () => {
  // Moved to implemented/ with its prompts kept: state no longer keys on it.
  const got = successors('/r/docs/plans/156-a.md', [
    P('156-a', { path: '/r/docs/plans/implemented/156-a.md', left: 2 }),
    P('157-b', { runsAfter: ['156'] }),
  ])
  assert.deepEqual(got, [{ path: '/r/docs/plans/157-b.md', start: true }])
})

test('nothing left, running, an old worktree or an unknown name holds a plan back', () => {
  const merged = '/r/docs/plans/156-a.md'
  const got = successors(merged, [
    P('157-done', { runsAfter: ['156'], left: 0 }),
    P('157-live', { runsAfter: ['156'], running: true }),
    P('157-wt', { runsAfter: ['156'], hasWorktree: true }),
    P('157-typo', { runsAfter: ['156', '999'] }),
  ])
  assert.deepEqual(
    got.map((s) => [s.path.split('/').pop(), s.start]),
    [
      ['157-live.md', false],
      ['157-wt.md', false],
      ['157-typo.md', false],
    ],
  )
  assert.match(got[2].reason, /999, which matches no plan/)
})
