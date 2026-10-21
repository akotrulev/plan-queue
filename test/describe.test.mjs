import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allowRuleFor, gateFixPrompt, Tail, toolSummary } from '../out/describe.mjs'

test('a tool call reads as what it did', () => {
  assert.equal(toolSummary('Bash', { command: 'pnpm test --filter api' }, '/w'), '$ pnpm test --filter api')
  assert.equal(toolSummary('Edit', { file_path: '/w/src/a.ts' }, '/w'), 'Edit src/a.ts')
  assert.equal(toolSummary('Read', { file_path: '/elsewhere/b.ts' }, '/w'), 'Read /elsewhere/b.ts')
  assert.equal(toolSummary('Grep', { pattern: 'TODO', path: '/w/src' }, '/w'), 'Grep TODO in src')
  assert.equal(toolSummary('TodoWrite', { todos: [] }, '/w'), 'TodoWrite')
  assert.equal(toolSummary('mcp__x__y', {}, '/w'), 'mcp__x__y')
})

test('a long or multi-line command is kept to one line', () => {
  const s = toolSummary('Bash', { command: 'cat <<EOF\n' + 'x'.repeat(300) + '\nEOF' }, '/w')
  assert.ok(!s.includes('\n'))
  assert.ok(s.length <= 163)
  assert.ok(s.endsWith('…'))
})

test('a denied command suggests the allowlist entry that would let it through', () => {
  assert.equal(allowRuleFor({ tool_name: 'Bash', tool_input: { command: 'terraform plan -out x' } }), 'Bash(terraform:*)')
  assert.equal(allowRuleFor({ tool_name: 'Bash', tool_input: { command: 'CI=1 FOO=bar make test' } }), 'Bash(make:*)')
  assert.equal(allowRuleFor({ tool_name: 'WebFetch', tool_input: { url: 'https://x' } }), 'WebFetch')
  assert.equal(allowRuleFor({ tool_name: 'Bash', tool_input: { command: '  ' } }), undefined)
  assert.equal(allowRuleFor({}), undefined)
})

test('the gate fix prompt carries the command, its output and the attempt', () => {
  const p = gateFixPrompt('pnpm test', 'FAIL src/a.test.ts\n  expected 1', 1, 2)
  assert.match(p, /attempt 1 of 2/)
  assert.match(p, /\$ pnpm test\nFAIL src\/a\.test\.ts/)
  assert.match(p, /PLAN_QUEUE: DONE/)
  assert.match(gateFixPrompt('x', '   ', 1, 1), /\(no output\)/)
})

test('Tail keeps the end, cut at a line boundary', () => {
  const t = new Tail(20)
  for (let i = 0; i < 10; i++) t.push(`line ${i}\n`)
  const s = t.toString()
  assert.ok(s.startsWith('…\n'))
  assert.ok(s.endsWith('line 9\n'))
  assert.ok(!s.includes('line 0'))
  const short = new Tail(100)
  short.push('ok\n')
  assert.equal(short.toString(), 'ok\n')
})
