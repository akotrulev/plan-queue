import { spawn, type ChildProcess } from 'child_process'
import * as vscode from 'vscode'
import type { Task } from './plan'

import { SENTINEL_BAD, SENTINEL_OK, verdict } from './verdict'

export { SENTINEL_BAD, SENTINEL_OK }

const UNATTENDED_NOTE = [
  'You are running unattended as one task in a queue. Nobody is watching live,',
  'so make the reasonable call and write it down rather than stopping to ask.',
  'Only when you genuinely cannot go on without a person, end your message with the question',
  'and neither line below: the queue pauses this task and brings the answer back to this session.',
  "Run the task's own gate before you finish.",
  `End your final message with a line that is exactly "${SENTINEL_OK}" when the task`,
  `landed and its gate passed, or "${SENTINEL_BAD} <one-line reason>" when it did not.`,
].join(' ')

export interface RunResult {
  ok: boolean
  reason?: string
  costUsd?: number
  durationMs: number
  sessionId?: string
  cancelled?: boolean
  /** The turn ended without either sentinel: the agent is asking something. */
  waiting?: boolean
  /** The agent's final message when it is waiting — the question, in context. */
  question?: string
}

/** Continue a task's session with the person's answer instead of starting it afresh. */
export interface Resume {
  sessionId: string
  reply: string
}

export interface RunConfig {
  claudePath: string
  model: string
  permissionMode: string
  allowedTools: string[]
  budgetUsd: number
  requireSentinel: boolean
  useAgentFromPlan: boolean
  extraArgs: string[]
}

export function readConfig(): RunConfig {
  const c = vscode.workspace.getConfiguration('planQueue')
  return {
    claudePath: c.get<string>('claudePath', 'claude'),
    model: c.get<string>('model', ''),
    permissionMode: c.get<string>('permissionMode', 'acceptEdits'),
    allowedTools: c.get<string[]>('allowedTools', []),
    budgetUsd: c.get<number>('budgetUsd', 0),
    requireSentinel: c.get<boolean>('requireSentinel', true),
    useAgentFromPlan: c.get<boolean>('useAgentFromPlan', true),
    extraArgs: c.get<string[]>('extraArgs', []),
  }
}

let agentCache: { key: string; names: string[] } | undefined

/**
 * Which agents this install actually has. The probe is rejected on argument
 * validation, before any model call, so it costs nothing.
 */
export async function availableAgents(claudePath: string, cwd: string): Promise<string[]> {
  const key = `${claudePath} ${cwd}`
  if (agentCache?.key === key) return agentCache.names
  const names = await new Promise<string[]>((resolve) => {
    const child = spawn(claudePath, ['--agent', '__plan_queue_probe__', '-p', 'x'], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buf = ''
    child.stdout.on('data', (d) => (buf += d))
    child.stderr.on('data', (d) => (buf += d))
    child.on('error', () => resolve([]))
    child.on('close', () => {
      const m = buf.match(/Available agents:\s*(.+)/)
      resolve(m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [])
    })
  })
  agentCache = { key, names }
  return names
}

/** The plan's role name mapped onto an agent this install has, or undefined. */
export function matchAgent(want: string, available: string[]): string | undefined {
  if (!want) return undefined
  const lower = want.toLowerCase()
  return (
    available.find((a) => a.toLowerCase() === lower) ??
    available.find((a) => a.toLowerCase().endsWith(`:${lower}`)) ??
    available.find((a) => a.toLowerCase().startsWith(`${lower}:`))
  )
}

/** The prompt exactly as the CLI will receive it. */
export async function composePrompt(task: Task, cfg: RunConfig, cwd: string): Promise<string> {
  if (!task.agent || !cfg.useAgentFromPlan) return task.prompt
  const agent = matchAgent(task.agent, await availableAgents(cfg.claudePath, cwd))
  if (agent) return task.prompt
  return (
    `This task belongs to the \`${task.agent}\` role; that agent is not installed here, ` +
    `so run it yourself in that role.\n\n${task.prompt}`
  )
}

export interface RunHandle {
  result: Promise<RunResult>
  cancel(): void
  /**
   * Hand the running task another user message. Delivered on the same stdin
   * stream the prompt went down, so it lands in the turn already in flight.
   * Returns false when the task is not (or no longer) accepting input.
   */
  send(text: string): boolean
}

/** One stream-json user message, as the CLI expects it on stdin. */
function userMessage(text: string): string {
  return (
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    }) + '\n'
  )
}

export function runTask(
  task: Task,
  cfg: RunConfig,
  cwd: string,
  out: vscode.OutputChannel,
  resume?: Resume,
): RunHandle {
  let child: ChildProcess | undefined
  let cancelled = false
  // The partial output line, shared so a message sent mid-task can flush it
  // before printing itself.
  let pending = ''
  let column = 0

  const flush = () => {
    if (pending) out.appendLine(pending)
    pending = ''
    column = 0
  }

  const result = (async (): Promise<RunResult> => {
    const started = Date.now()
    const agent = cfg.useAgentFromPlan
      ? matchAgent(task.agent, await availableAgents(cfg.claudePath, cwd))
      : undefined
    const prompt = resume ? resume.reply : await composePrompt(task, cfg, cwd)

    const args = [
      '-p',
      '--input-format',
      'stream-json',
      '--permission-mode',
      cfg.permissionMode,
      '--permission-prompts',
      'none',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--name',
      `plan-queue ${task.id}`,
      '--append-system-prompt',
      UNATTENDED_NOTE,
    ]
    if (resume) args.push('--resume', resume.sessionId)
    if (cfg.allowedTools.length) args.push('--allowedTools', ...cfg.allowedTools)
    if (agent) args.push('--agent', agent)
    if (cfg.model) args.push('--model', cfg.model)
    if (cfg.budgetUsd > 0) args.push('--max-budget-usd', String(cfg.budgetUsd))
    args.push(...cfg.extraArgs)

    out.appendLine('')
    out.appendLine(
      `=== ${task.id} — ${task.title}  [${agent ?? task.agent ?? 'default'}]` +
        (resume ? '  (resumed with your reply)' : ''),
    )
    out.appendLine(`    ${new Date().toLocaleTimeString()}  ${cwd}`)
    out.appendLine('')

    if (cancelled) return { ok: false, cancelled: true, durationMs: 0, reason: 'cancelled' }

    child = spawn(cfg.claudePath, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    // stdin stays open for the whole run so messages can be sent mid-task; it
    // is closed when the result arrives, which is what ends the process.
    child.stdin?.on('error', () => {})
    child.stdin?.write(userMessage(prompt))

    let finalText = ''
    let costUsd: number | undefined
    let sessionId: string | undefined
    let stderr = ''
    let subtype: string | undefined

    const write = (s: string) => {
      // The channel is line-oriented; keep streamed deltas readable rather than
      // one token per line.
      for (const ch of s) {
        if (ch === '\n' || column > 100) {
          out.appendLine(pending)
          pending = ''
          column = 0
          if (ch === '\n') continue
        }
        pending += ch
        column++
      }
    }

    const handle = (line: string) => {
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        return
      }
      if (msg.type === 'system' && msg.session_id) sessionId = msg.session_id
      if (msg.type === 'stream_event' && msg.event?.type === 'content_block_delta') {
        write(msg.event.delta?.text ?? msg.event.delta?.thinking ?? '')
      } else if (msg.type === 'assistant') {
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'tool_use') {
            flush()
            out.appendLine(`  · ${block.name}`)
          }
        }
      } else if (msg.type === 'result') {
        flush()
        finalText = typeof msg.result === 'string' ? msg.result : finalText
        subtype = typeof msg.subtype === 'string' ? msg.subtype : undefined
        child?.stdin?.end()
        if (typeof msg.total_cost_usd === 'number') costUsd = msg.total_cost_usd
        if (msg.session_id) sessionId = msg.session_id
      }
    }

    let buf = ''
    child.stdout?.on('data', (d: Buffer) => {
      buf += d.toString()
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        if (line.trim()) handle(line)
      }
    })
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()))

    const code = await new Promise<number>((resolve) => {
      child!.on('error', (e) => {
        stderr += String(e)
        resolve(-1)
      })
      child!.on('close', (c) => resolve(c ?? -1))
    })
    flush()
    const durationMs = Date.now() - started

    if (cancelled) {
      out.appendLine(`\n--- ${task.id} cancelled`)
      return { ok: false, cancelled: true, durationMs, reason: 'cancelled', sessionId }
    }
    if (code !== 0) {
      const reason = stderr.trim().split('\n').slice(-3).join(' ') || `claude exited ${code}`
      out.appendLine(`\n--- ${task.id} FAILED: ${reason}`)
      return { ok: false, reason, durationMs, costUsd, sessionId }
    }

    const v = verdict({ finalText, subtype, sessionId, requireSentinel: cfg.requireSentinel })
    if (v.kind === 'failed' || v.kind === 'blocked') {
      out.appendLine(`\n--- ${task.id} ${v.kind === 'blocked' ? 'BLOCKED' : 'FAILED'}: ${v.reason}`)
      return { ok: false, reason: v.reason, durationMs, costUsd, sessionId }
    }
    if (v.kind === 'waiting') {
      out.appendLine(`\n--- ${task.id} WAITING FOR YOUR REPLY — Plan Queue: Reply to the task`)
      return {
        ok: false,
        waiting: true,
        question: v.question,
        reason: 'waiting for reply',
        durationMs,
        costUsd,
        sessionId,
      }
    }

    out.appendLine(
      `\n--- ${task.id} ok${costUsd !== undefined ? `  $${costUsd.toFixed(3)}` : ''}` +
        `  ${(durationMs / 1000).toFixed(0)}s`,
    )
    return { ok: true, durationMs, costUsd, sessionId }
  })()

  return {
    result,
    cancel() {
      cancelled = true
      child?.stdin?.end()
      child?.kill('SIGTERM')
      setTimeout(() => child?.kill('SIGKILL'), 3000)
    },
    send(text: string) {
      const trimmed = text.trim()
      if (!trimmed || cancelled) return false
      const stdin = child?.stdin
      if (!stdin || !stdin.writable || stdin.writableEnded) return false
      flush()
      out.appendLine(`  > ${trimmed.split('\n').join('\n  > ')}`)
      return stdin.write(userMessage(trimmed))
    },
  }
}

/** The optional post-task gate. Runs in the workspace, inherits your shell. */
export function runGate(command: string, cwd: string, out: vscode.OutputChannel): Promise<boolean> {
  return new Promise((resolve) => {
    out.appendLine(`  gate: ${command}`)
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (d: Buffer) => out.append(d.toString()))
    child.stderr.on('data', (d: Buffer) => out.append(d.toString()))
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}
