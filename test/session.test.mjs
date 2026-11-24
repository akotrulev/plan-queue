import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { askText, parseAgents, parseBackgrounded, shortId, TranscriptReader, transcriptPath } from '../out/session.mjs'

const line = (o) => JSON.stringify(o)
const assistant = (id, content, extra = {}) => line({ type: 'assistant', isSidechain: false, message: { id, role: 'assistant', content }, ...extra })
const user = (content, extra = {}) => line({ type: 'user', isSidechain: false, message: { role: 'user', content }, ...extra })

test('agents --json rows keep what the queue reads, and tolerate junk', () => {
  const rows = parseAgents(
    JSON.stringify([
      { id: 'c6fa6816', sessionId: 'c6fa6816-cdc7-493d-8d7f-1b2ebd132202', name: 'plan-queue T4', kind: 'background', pid: 46046, state: 'working' },
      { sessionId: 'ebe0f844-b455-4a8c-9a0e-5fbb4307b808', kind: 'interactive', status: 'idle' },
      { nothing: true },
      null,
    ]),
  )
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], {
    id: 'c6fa6816',
    sessionId: 'c6fa6816-cdc7-493d-8d7f-1b2ebd132202',
    name: 'plan-queue T4',
    cwd: undefined,
    kind: 'background',
    pid: 46046,
    state: 'working',
  })
  // An interactive session has no short id of its own; it is the session id's start.
  assert.equal(rows[1].id, 'ebe0f844')
  assert.equal(rows[1].pid, undefined)
  assert.deepEqual(parseAgents('not json'), [])
  assert.deepEqual(parseAgents('{"a":1}'), [])
})

test('the short id comes from what claude --bg prints', () => {
  const out = 'Starting background service…\nbackgrounded · c6fa6816 · pq-probe2\n  claude agents             list sessions\n'
  assert.equal(parseBackgrounded(out), 'c6fa6816')
  assert.equal(parseBackgrounded('note: woke session c6fa6816 with its saved options\nbackgrounded · c6fa6816'), 'c6fa6816')
  assert.equal(parseBackgrounded('error: unknown option'), undefined)
  assert.equal(shortId('c6fa6816-cdc7-493d-8d7f-1b2ebd132202'), 'c6fa6816')
})

test('the final text is the last assistant message, across its content blocks', () => {
  const r = new TranscriptReader(() => undefined)
  r.take(assistant('m1', [{ type: 'text', text: 'Working on it.' }]))
  r.take(assistant('m1', [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }]))
  r.take(assistant('m2', [{ type: 'text', text: 'Which one?' }]))
  r.take(assistant('m2', [{ type: 'text', text: 'PLAN_QUEUE: QUESTION' }]))
  assert.equal(r.finalText, 'Which one?\nPLAN_QUEUE: QUESTION')
  assert.equal(r.lastIsError, false)
})

test('events: text, tools, failed tool results, a person\'s message and the turn end', () => {
  const r = new TranscriptReader(() => undefined)
  const ev = []
  r.take(user('Run the task.'), ev)
  r.take(user('<command-name>/model</command-name>'), ev)
  r.take(user('caveat', { isMeta: true }), ev)
  r.take(assistant('m1', [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'On it.' }]), ev)
  r.take(assistant('m1', [{ type: 'tool_use', name: 'Read', input: { file_path: '/a/b.ts' } }]), ev)
  r.take(user([{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'ENOENT\nmore' }] }]), ev)
  r.take(user([{ type: 'tool_result', content: 'fine' }]), ev)
  r.take(assistant('m9', [{ type: 'text', text: 'side' }], { isSidechain: true }), ev)
  r.take(line({ type: 'system', subtype: 'turn_duration', durationMs: 4032 }), ev)
  assert.deepEqual(ev, [
    { kind: 'prompt', text: 'Run the task.' },
    { kind: 'thinking', text: 'hmm' },
    { kind: 'text', text: 'On it.' },
    { kind: 'tool', name: 'Read', input: { file_path: '/a/b.ts' } },
    { kind: 'toolError', text: 'ENOENT\nmore' },
    { kind: 'turnEnd' },
  ])
  assert.equal(r.finalText, 'On it.')
})

test('cost comes from the last cost-state line; an API error message is flagged', () => {
  const r = new TranscriptReader(() => undefined)
  r.take(line({ type: 'cost-state', totalCostUSD: 0.004 }))
  r.take(line({ type: 'cost-state', totalCostUSD: 0.0047 }))
  assert.equal(r.costUsd, 0.0047)
  r.take(assistant('e1', [{ type: 'text', text: "You've hit your limit · resets 5pm" }], { isApiErrorMessage: true }))
  assert.equal(r.lastIsError, true)
  r.take(assistant('m3', [{ type: 'text', text: 'ok' }]))
  assert.equal(r.lastIsError, false)
})

test('reading a growing transcript picks up where it left off, across a split line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pq-session-'))
  const file = path.join(dir, 't.jsonl')
  const a = user('hello') + '\n'
  const b = assistant('m1', [{ type: 'text', text: 'hi' }])
  fs.writeFileSync(file, a + b.slice(0, 20))
  const r = new TranscriptReader(() => file)
  assert.deepEqual(r.read(), [{ kind: 'prompt', text: 'hello' }])
  fs.appendFileSync(file, b.slice(20) + '\n')
  assert.deepEqual(r.read(), [{ kind: 'text', text: 'hi' }])
  assert.deepEqual(r.read(), [])
  // Started at the end, it sees only what comes after.
  const late = new TranscriptReader(() => file, TranscriptReader.sizeOf(file))
  fs.appendFileSync(file, line({ type: 'system', subtype: 'turn_duration' }) + '\n')
  assert.deepEqual(late.read(), [{ kind: 'turnEnd' }])
  fs.rmSync(dir, { recursive: true })
})

test('the transcript is found under the cwd\'s project folder, or any project folder', () => {
  const config = fs.mkdtempSync(path.join(os.tmpdir(), 'pq-config-'))
  const sid = 'c6fa6816-cdc7-493d-8d7f-1b2ebd132202'
  const proj = path.join(config, 'projects', '-Users-me-projects-shop--worktrees-orders')
  fs.mkdirSync(proj, { recursive: true })
  fs.writeFileSync(path.join(proj, `${sid}.jsonl`), '')
  assert.equal(transcriptPath('/Users/me/projects/shop/.worktrees/orders', sid, config), path.join(proj, `${sid}.jsonl`))
  assert.equal(transcriptPath('/somewhere/else', sid, config), path.join(proj, `${sid}.jsonl`))
  assert.equal(transcriptPath('/x', 'nope', config), undefined)
  fs.rmSync(config, { recursive: true })
})

test('an AskUserQuestion is pending until its result comes back, as plain text with its options', () => {
  const r = new TranscriptReader(() => undefined)
  const input = {
    questions: [
      { question: 'Which colour do you prefer?', header: 'Colour', options: [{ label: 'Red' }, { label: 'Green' }, { label: 'Blue' }] },
    ],
  }
  r.take(assistant('m1', [{ type: 'tool_use', id: 'tu1', name: 'AskUserQuestion', input }]))
  assert.equal(r.pendingAsk, 'Which colour do you prefer?\n  — Red / Green / Blue')
  r.take(user([{ type: 'tool_result', tool_use_id: 'other', content: 'x' }]))
  assert.ok(r.pendingAsk)
  r.take(user([{ type: 'tool_result', tool_use_id: 'tu1', content: 'Your questions have been answered: "Which colour do you prefer?"="Red".' }]))
  assert.equal(r.pendingAsk, undefined)
  assert.equal(askText({}), 'It is asking you something in its session.')
  assert.equal(askText({ questions: [{ question: 'Go?' }] }), 'Go?')
})
