#!/usr/bin/env node
// pq — drives the Plan Queue extension from a shell, or an LLM's Bash tool.
// Talks to the extension's local control server; start it with the command
// "Plan Queue: Connect Claude Code", or set planQueue.server.enabled.
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const USAGE = `pq — control Plan Queue

  pq list                                  plans and how far each has got
  pq status <plan>                         every task: status, deps, question
  pq run <plan> [--from T3]                start a plan; returns at once
  pq task <plan> <T3> [--now]              run one task; --now starts it beside a running plan
  pq reply <plan> <T3> <text...>           answer a waiting task
  pq message <plan> [T3] -- <text...>      type into a task that is working
  pq log <plan> [T3] [lines]               tail the plan's log, or a task's transcript
  pq stop [plan]                           stop one plan, or all

<plan> is a path, file name or title; a unique fragment is enough.
Exit status is 1 when the server refuses.`

function die(message) {
  console.error(message)
  process.exit(1)
}

function connection() {
  if (process.env.PLAN_QUEUE_URL && process.env.PLAN_QUEUE_TOKEN) {
    return { url: process.env.PLAN_QUEUE_URL, token: process.env.PLAN_QUEUE_TOKEN }
  }
  try {
    return JSON.parse(readFileSync(join(homedir(), '.plan-queue', 'server.json'), 'utf8'))
  } catch {
    return die('Plan Queue is not serving. In VS Code run "Plan Queue: Connect Claude Code", or set planQueue.server.enabled.')
  }
}

async function call(name, args) {
  const { url, token } = connection()
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    })
  } catch {
    return die(`Could not reach Plan Queue at ${url}. Is the VS Code window still open?`)
  }
  if (res.status === 401) die('Plan Queue refused the token. Run "Plan Queue: Connect Claude Code" again.')
  const body = await res.json()
  if (body.error) die(body.error.message)
  const text = body.result.content.map((c) => c.text).join('\n')
  if (body.result.isError) die(text)
  return text
}

const [cmd, ...rest] = process.argv.slice(2)

/** Remove `--name` (and its value, when it takes one) from the arguments. */
function take(name, hasValue) {
  const i = rest.indexOf(name)
  if (i < 0) return undefined
  const taken = rest.splice(i, hasValue ? 2 : 1)
  return hasValue ? taken[1] : true
}

let out
switch (cmd) {
  case 'list':
    out = await call('list_plans', {})
    break
  case 'status':
    out = await call('plan_status', { plan: rest[0] })
    break
  case 'run': {
    const from = take('--from', true)
    out = await call('run_plan', { plan: rest[0], from_task: from })
    break
  }
  case 'task': {
    const now = take('--now', false) === true
    out = await call('run_task', { plan: rest[0], task: rest[1], now })
    break
  }
  case 'reply':
    out = await call('reply', { plan: rest[0], task: rest[1], text: rest.slice(2).join(' ') })
    break
  case 'message': {
    const sep = rest.indexOf('--')
    const head = sep >= 0 ? rest.slice(0, sep) : rest.slice(0, 1)
    const text = (sep >= 0 ? rest.slice(sep + 1) : rest.slice(1)).join(' ')
    out = await call('message', { plan: head[0], task: head[1], text })
    break
  }
  case 'log': {
    const lines = rest.slice(1).find((x) => /^\d+$/.test(x))
    const task = rest.slice(1).find((x) => !/^\d+$/.test(x))
    out = JSON.parse(await call('get_log', { plan: rest[0], task, lines: lines ? Number(lines) : undefined })).log
    break
  }
  case 'stop':
    out = await call('stop', { plan: rest[0] })
    break
  default:
    console.log(USAGE)
    process.exit(cmd && cmd !== 'help' && cmd !== '--help' ? 1 : 0)
}
console.log(out)
