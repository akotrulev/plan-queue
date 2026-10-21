import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parsePlanText, looksLikeAPlan } from '../out/plan.mjs'

const PLAN = `# Storefront

## Something else

### Not a task

## Prompts — one per task

### T1 — the contract and the taxonomy (\`tooling-engineer\`, \`ts\`)

> Read the decisions doc.
>
> Then write the thing.

### T2 — navigation (\`be-node\`, \`be\`)

> One line only.

## After

### T3 — not in the prompts section

> ignored
`

test('finds only the tasks in the prompts section', () => {
  const plan = parsePlanText(PLAN, '/x/storefront.md')
  assert.deepEqual(plan.tasks.map((t) => t.id), ['T1', 'T2'])
  assert.equal(plan.title, 'Storefront')
})

test('splits id, title and agent', () => {
  const [t1, t2] = parsePlanText(PLAN, '/x/p.md').tasks
  assert.equal(t1.title, 'the contract and the taxonomy')
  assert.equal(t1.agent, 'tooling-engineer')
  assert.equal(t2.agent, 'be-node')
})

test('unwraps the blockquote and keeps blank lines inside it', () => {
  const [t1] = parsePlanText(PLAN, '/x/p.md').tasks
  assert.equal(t1.prompt, 'Read the decisions doc.\n\nThen write the thing.')
})

test('the hash changes when a later task rewrites the prompt', () => {
  const before = parsePlanText(PLAN, '/x/p.md').tasks[1].hash
  const after = parsePlanText(PLAN.replace('One line only.', 'Rewritten by T1.'), '/x/p.md').tasks[1].hash
  assert.notEqual(before, after)
})

test('a plain hyphen separator works too', () => {
  const plan = parsePlanText('## Prompts\n\n### A2 - a title (`fe-react`, `fe`)\n\n> body\n', '/x/p.md')
  assert.deepEqual(plan.tasks.map((t) => [t.id, t.title, t.agent]), [['A2', 'a title', 'fe-react']])
})

test('a file with no prompts section is not a plan', () => {
  assert.equal(looksLikeAPlan('# notes\n\nnothing here\n'), false)
  assert.equal(looksLikeAPlan(PLAN), true)
})

test('a trailing parenthetical that is not an agent stays in the title', () => {
  const p = parsePlanText('## Prompts\n\n### Prompt P1 — one round of tuning (§9)\n\n> body\n', '/x/p.md')
  assert.deepEqual(p.tasks.map((t) => [t.id, t.title, t.agent]), [['P1', 'one round of tuning (§9)', '']])
})

test('a fenced prompt body is read too', () => {
  const p = parsePlanText('## Prompts\n\n### Prompt B1 — record effort\n\n````\nYou are `be-node`.\nDo the thing.\n````\n', '/x/p.md')
  assert.equal(p.tasks[0].id, 'B1')
  assert.equal(p.tasks[0].prompt, 'You are `be-node`.\nDo the thing.')
})

test('a heading with prose but no prompt is not a task', () => {
  const p = parsePlanText('## Prompts\n\n### B1, C1, C2\n\nWrite these when their triggers fire.\n', '/x/p.md')
  assert.deepEqual(p.tasks, [])
})

test('reads a Depends on line, in the shapes plans write it', () => {
  const dep = (line) =>
    parsePlanText(`## Prompts\n\n### T2 — x\n\n> Do it.\n> ${line}\n`, '/x/p.md').tasks[0].deps
  assert.deepEqual(dep('Depends on: T1'), ['T1'])
  assert.deepEqual(dep('**Depends on:** T1, T3b'), ['T1', 'T3b'])
  assert.deepEqual(dep('- Depends on: `T1` and `T2`.'), ['T1', 'T2'])
  assert.deepEqual(dep('Depends on: none'), [])
  assert.deepEqual(dep('Depends on: —'), [])
})

test('a task with no Depends on line has no deps, which is not the same as none', () => {
  const [t] = parsePlanText('## Prompts\n\n### T1 — x\n\n> Do it, and it depends on the schema being there.\n', '/x/p.md').tasks
  assert.equal(t.deps, undefined)
})

test('headings inside a fenced prompt do not end it or the section', () => {
  const p = parsePlanText(
    '## Prompts\n\n### T1 — a\n\n```\nWrite this doc:\n\n## Goals\n\n### Notes\nx\n```\n\n### T2 — b\n\n> hi\n',
    '/x/p.md',
  )
  assert.deepEqual(p.tasks.map((t) => t.id), ['T1', 'T2'])
  assert.equal(p.tasks[0].prompt, 'Write this doc:\n\n## Goals\n\n### Notes\nx')
})

test('headings inside a fence quoted in a blockquote stay in the prompt', () => {
  const p = parsePlanText('## Prompts\n\n### T1 — a\n\n> Make:\n> ```md\n> ## Goals\n> ```\n\n### T2 — b\n\n> hi\n', '/x/p.md')
  assert.deepEqual(p.tasks.map((t) => t.id), ['T1', 'T2'])
  assert.match(p.tasks[0].prompt, /## Goals/)
})

test('a ## Prompts heading shown inside a fence is not the section', () => {
  const p = parsePlanText('# Notes\n\n```md\n## Prompts\n\n### T1 — a\n\n> x\n```\n', '/x/p.md')
  assert.deepEqual(p.tasks, [])
})

test('a lone word in parentheses is part of the title, not an agent', () => {
  const p = parsePlanText('## Prompts\n\n### T1 — the cart (wip)\n\n> body\n\n### T2 — x (`fe-react`)\n\n> body\n', '/x/p.md')
  assert.deepEqual(p.tasks.map((t) => [t.title, t.agent]), [['the cart (wip)', ''], ['x', 'fe-react']])
})

test('a repeated id keeps the first task and is reported', () => {
  const p = parsePlanText('## Prompts\n\n### T1 — a\n\n> x\n\n### T1 — b\n\n> y\n\n### T2 — c\n\n> z\n', '/x/p.md')
  assert.deepEqual(p.tasks.map((t) => [t.id, t.title]), [['T1', 'a'], ['T2', 'c']])
  assert.deepEqual(p.duplicates, ['T1'])
})
