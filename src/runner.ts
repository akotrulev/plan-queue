import { spawn, type ChildProcess } from 'child_process'
import * as vscode from 'vscode'
import type { Task } from './plan'

import { allowRuleFor, Tail, toolSummary } from './describe'
import { SENTINEL_ASK, SENTINEL_BAD, SENTINEL_OK, verdict } from './verdict'

export { SENTINEL_ASK, SENTINEL_BAD, SENTINEL_OK }

const UNATTENDED_NOTE = [
  'You are running unattended as one task in a queue. Nobody is watching live,',
  'so make the reasonable call and write it down rather than stopping to ask.',
  "If the task defines a gate, run it before you finish.",
  `End your final message with a line that is exactly "${SENTINEL_OK}" when the task`,
  `landed and its gate passed, or "${SENTINEL_BAD} <one-line reason>" when it did not.`,
  'Only when you genuinely cannot go on without a person, end your message with the question',
  `and then a line that is exactly "${SENTINEL_ASK}": the queue pauses this task and brings`,
  'the answer back to this session.',
].join(' ')

/**
 * Children get a process group of their own, so stopping a task also stops
 * what it started — a dev server, a test watcher — and not only the CLI.
 */
const OWN_GROUP = process.platform !== 'win32'

/** SIGTERM the group, then SIGKILL whatever ignored it. */
function reap(child: ChildProcess | undefined): void {
  killTree(child, 'SIGTERM')
  setTimeout(() => killTree(child, 'SIGKILL'), 3000).unref()
}

function killTree(child: ChildProcess | undefined, signal: NodeJS.Signals): void {
  if (!child?.pid) return
  try {
    if (OWN_GROUP) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    // Already gone.
  }
}

/** Where a task's output goes: an output channel, or anything shaped like one. */
export interface LogSink {
  append(text: string): void
  appendLine(text: string): void
}

/** Added when several tasks of one plan may be running in the same working tree. */
const PARALLEL_NOTE = [
  'Other tasks of this plan may be running at the same time in this same working tree.',
  'Touch only the files your task owns. Do not run git stash, reset, checkout, clean or rebase,',
  'and do not commit: the queue commits for you once the tasks that are running have finished.',
].join(' ')

export interface RunResult {
  ok: boolean
  reason?: string
  costUsd?: number
  durationMs: number
  sessionId?: string
  cancelled?: boolean
  /** The agent is asking a person something, or ended with no sentinel (see `silent`). */
  waiting?: boolean
  /** No sentinel at all: the queue asks the agent once what it meant before waiting on a person. */
  silent?: boolean
  /** The agent's final message when it is waiting — the question, in context. */
  question?: string
  /** Allowlist entries that would have let through the calls this turn was denied. */
  denied: string[]
}

/** Continue a task's session with a message, instead of starting it afresh. */
export interface Resume {
  sessionId: string
  reply: string
  /** Why, for the log's header: "resumed with your reply". */
  label?: string
}

export interface TaskRunOptions {
  resume?: Resume
  /** Several tasks of the plan may share the tree right now. */
  parallel?: boolean
  /** The session's display name, so `claude --resume` can tell plans apart. */
  sessionName?: string
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
  maxParallelTasks: number
  logThinking: boolean
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
    maxParallelTasks: Math.max(1, c.get<number>('maxParallelTasks', 3)),
    logThinking: c.get<boolean>('logThinking', false),
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
  out: LogSink,
  opts: TaskRunOptions = {},
): RunHandle {
  const { resume, parallel = false } = opts
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
      opts.sessionName ?? `plan-queue ${task.id}`,
      '--append-system-prompt',
      parallel ? `${UNATTENDED_NOTE} ${PARALLEL_NOTE}` : UNATTENDED_NOTE,
    ]
    if (resume) args.push('--resume', resume.sessionId)
    if (cfg.allowedTools.length) args.push('--allowedTools', ...cfg.allowedTools)
    if (agent) args.push('--agent', agent)
    if (cfg.model) args.push('--model', cfg.model)
    if (cfg.budgetUsd > 0) args.push('--max-budget-usd', String(cfg.budgetUsd))
    args.push(...cfg.extraArgs)

    out.appendLine('')
    out.appendLine(
      `=== ${task.id} — ${task.title}  [${agent || task.agent || 'default'}]` +
        (resume ? `  (${resume.label ?? 'resumed with your reply'})` : ''),
    )
    out.appendLine(`    ${new Date().toLocaleTimeString()}  ${cwd}`)
    out.appendLine('')

    if (cancelled) return { ok: false, cancelled: true, durationMs: 0, reason: 'cancelled', denied: [] }

    child = spawn(cfg.claudePath, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: OWN_GROUP })
    // stdin stays open for the whole run so messages can be sent mid-task; it
    // is closed when the result arrives, which is what ends the process.
    child.stdin?.on('error', () => {})
    child.stdin?.write(userMessage(prompt))

    let finalText = ''
    let costUsd: number | undefined
    let sessionId: string | undefined
    let stderr = ''
    let subtype: string | undefined
    const denied: string[] = []

    const write = (s: string) => {
      // The channel is line-oriented; keep streamed deltas readable rather than
      // one token per line. Long lines break at a space, or at 160 regardless.
      for (const ch of s) {
        if (ch === '\n' || (column >= 100 && ch === ' ') || column >= 160) {
          out.appendLine(pending)
          pending = ''
          column = 0
          if (ch === '\n' || ch === ' ') continue
        }
        pending += ch
        column++
      }
    }

    /** First line of a tool result's text, wherever the CLI put it. */
    const resultText = (content: unknown): string => {
      if (typeof content === 'string') return content
      if (Array.isArray(content)) return content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n')
      return ''
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
        const d = msg.event.delta
        write(d?.text ?? (cfg.logThinking ? d?.thinking : undefined) ?? '')
      } else if (msg.type === 'assistant') {
        for (const block of msg.message?.content ?? []) {
          if (block.type === 'tool_use') {
            flush()
            out.appendLine(`  · ${toolSummary(block.name, block.input, cwd)}`)
          }
        }
      } else if (msg.type === 'user') {
        // A tool that failed is worth a line; one that worked is already implied.
        for (const block of Array.isArray(msg.message?.content) ? msg.message.content : []) {
          if (block?.type === 'tool_result' && block.is_error) {
            const first = resultText(block.content).trim().split('\n')[0] ?? ''
            flush()
            out.appendLine(`    ✗ ${first.length > 200 ? first.slice(0, 199) + '…' : first}`)
          }
        }
      } else if (msg.type === 'result') {
        for (const d of Array.isArray(msg.permission_denials) ? msg.permission_denials : []) {
          const rule = allowRuleFor(d)
          if (rule && !denied.includes(rule)) denied.push(rule)
        }
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

    // Whatever the task left running in the background goes with it — and has
    // to, since a leftover holding stdout open would keep 'close' from firing.
    child.on('exit', () => reap(child))
    const code = await new Promise<number>((resolve) => {
      child!.on('error', (e) => {
        stderr += String(e)
        resolve(-1)
      })
      child!.on('close', (c) => resolve(c ?? -1))
    })
    flush()
    const durationMs = Date.now() - started
    if (denied.length) {
      out.appendLine(`  denied (not on planQueue.allowedTools): ${denied.join(', ')}`)
    }

    if (cancelled) {
      out.appendLine(`\n--- ${task.id} cancelled`)
      return { ok: false, cancelled: true, durationMs, reason: 'cancelled', sessionId, denied }
    }
    if (code !== 0) {
      const reason = stderr.trim().split('\n').slice(-3).join(' ') || `claude exited ${code}`
      out.appendLine(`\n--- ${task.id} FAILED: ${reason}`)
      return { ok: false, reason, durationMs, costUsd, sessionId, denied }
    }

    const v = verdict({ finalText, subtype, sessionId, requireSentinel: cfg.requireSentinel })
    if (v.kind === 'failed' || v.kind === 'blocked') {
      out.appendLine(`\n--- ${task.id} ${v.kind === 'blocked' ? 'BLOCKED' : 'FAILED'}: ${v.reason}`)
      return { ok: false, reason: v.reason, durationMs, costUsd, sessionId, denied }
    }
    if (v.kind === 'silent') {
      out.appendLine(`\n--- ${task.id} ended without a sentinel`)
      return {
        ok: false,
        waiting: true,
        silent: true,
        question: v.text,
        reason: 'no completion sentinel',
        durationMs,
        costUsd,
        sessionId,
        denied,
      }
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
        denied,
      }
    }

    out.appendLine(
      `\n--- ${task.id} ok${costUsd !== undefined ? `  $${costUsd.toFixed(3)}` : ''}` +
        `  ${(durationMs / 1000).toFixed(0)}s`,
    )
    return { ok: true, durationMs, costUsd, sessionId, denied }
  })()

  return {
    result,
    cancel() {
      cancelled = true
      child?.stdin?.end()
      reap(child)
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

export interface GateOptions {
  /** Kill it after this long and count it as failed. 0 or absent: no limit. */
  timeoutMs?: number
  /** Kill it when the plan is stopped. */
  signal?: AbortSignal
}

export interface GateResult {
  ok: boolean
  /** The end of what it printed, for handing back to the task. */
  output: string
  timedOut?: boolean
  stopped?: boolean
}

/**
 * A shell command that passes or fails — the post-task gate, or a worktree's
 * setup. Runs in its own process group, so a timeout or a stop takes down
 * everything it started.
 */
export function runGate(command: string, cwd: string, out: LogSink, opts: GateOptions = {}): Promise<GateResult> {
  return new Promise((resolve) => {
    if (opts.signal?.aborted) return resolve({ ok: false, output: '', stopped: true })
    out.appendLine(`  gate: ${command}`)
    const tail = new Tail()
    let timedOut = false
    let stopped = false
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], detached: OWN_GROUP })
    const kill = (why: string) => {
      out.appendLine(`  gate ${why}`)
      tail.push(`\n[the queue killed the gate: ${why}]\n`)
      reap(child)
    }
    child.on('exit', () => reap(child))
    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            const s = Math.round(opts.timeoutMs! / 1000)
            kill(`timed out after ${s < 120 ? `${s}s` : `${Math.round(s / 60)} min`}`)
          }, opts.timeoutMs)
        : undefined
    const onAbort = () => {
      stopped = true
      kill('stopped')
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    const take = (d: Buffer) => {
      const text = d.toString()
      out.append(text)
      tail.push(text)
    }
    child.stdout.on('data', take)
    child.stderr.on('data', take)
    const done = (ok: boolean) => {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ ok, output: tail.toString(), timedOut, stopped })
    }
    child.on('error', (e) => {
      tail.push(String(e))
      done(false)
    })
    child.on('close', (code) => done(code === 0 && !timedOut && !stopped))
  })
}
