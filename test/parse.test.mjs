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
