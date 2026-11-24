import { spawn, type ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as vscode from 'vscode'
import type { Task } from './plan'

import { isTransient, limitFromText, type LimitInfo } from './limits'
import { Tail, toolSummary } from './describe'
import {
  parseAgents,
  parseBackgrounded,
  shortId,
  TranscriptReader,
  transcriptPath,
  type SessionEntry,
  type TranscriptEvent,
} from './session'
import { SENTINEL_ASK, SENTINEL_BAD, SENTINEL_OK, verdict } from './verdict'

export { SENTINEL_ASK, SENTINEL_BAD, SENTINEL_OK }

const SESSION_NOTE = [
  'You are running as one task in a queue, in a background session a person may or may not',
  'be watching. Make the reasonable call and write it down rather than stopping to ask.',
  "If the task defines a gate, run it before you finish.",
  'A red test means the code is wrong: fix the code. If you believe a test itself is wrong,',
  'leave it as it is, write down why in the plan and in your final message, and still finish.',
  `End your final message with a line that is exactly "${SENTINEL_OK}" when the task's work`,
  `landed, or "${SENTINEL_BAD} <one-line reason>" only when the work cannot go on at all`,
  '(a merge conflict, a missing dependency or credential) — never because a test is red.',
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
  /** Interrupted by a pause: the session is kept, to be resumed later. */
  paused?: boolean
  /** The agent is asking a person something, or ended with no sentinel (see `silent`). */
  waiting?: boolean
  /** No sentinel at all: the queue asks the agent once what it meant before waiting on a person. */
  silent?: boolean
  /** The agent's final message when it is waiting — the question, in context. */
  question?: string
  /**
   * The turn failed on the account's usage limit: a `rejected` rate-limit event
   * came in, or the failure text says so. Not an ordinary failure.
   */
  limited?: LimitInfo
  /** The turn failed on a temporary API error (overloaded, 5xx, a dropped connection) and is worth retrying. */
  transient?: boolean
  /** Allowlist entries that would have let through the calls this turn was denied. */
  denied: string[]
}

/** Continue a task's session with a message, instead of starting it afresh. */
export interface Resume {
  sessionId: string
  reply: string
  /** Why, for the log's header: "resumed with your reply". */
  label?: string
  /**
   * The person already carried the session on by typing into it: send
   * nothing, only watch the turn, reading its transcript from this offset.
   */
  adopt?: { offset: number }
}

export interface TaskRunOptions {
  resume?: Resume
  /** Several tasks of the plan may share the tree right now. */
  parallel?: boolean
  /** The session's display name, so `claude --resume` can tell plans apart. */
  sessionName?: string
  /**
   * Called as soon as the session is up, long before the result, so a window
   * that closes mid-task still knows which session to resume, and a terminal
   * can be attached to it.
   */
  onSession?: (sessionId: string) => void
  /**
   * The session stopped mid-turn on something only a person can answer in it
   * — a permission prompt, a question — with what it last said; undefined
   * once it carries on.
   */
  onBlocked?: (question: string | undefined) => void
  /**
   * Claude Code will not start a session in this folder until a person
   * accepts its trust prompt there; undefined once it has started.
   */
  onUntrusted?: (cwd: string | undefined) => void
}

export interface RunConfig {
  claudePath: string
  model: string
  permissionMode: string
  allowedTools: string[]
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
   * Stop the session's turn, keeping its conversation so it can be resumed.
   * `now` changes nothing any more — a background session is stopped by its
   * own command — and stays for callers that close the window.
   */
  pause(now?: boolean): void
  /**
   * Hand the running task another message. A background session takes what
   * is typed into it, not what is sent from outside mid-turn, so this is
   * always false: the person types into the task's session instead.
   */
  send(text: string): boolean
}

/** How often a session's state and transcript are looked at. */
const POLL_MS = 2000

/** `claude <args>` to completion. */
export function cli(
  claudePath: string,
  args: string[],
  cwd: string,
  timeoutMs = 30_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(claudePath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + String(e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/**
 * `claude stop <id>` that outlives the window: closing VS Code pauses what is
 * running, and the extension host may be gone before a child it waits on ends.
 */
export function stopSession(claudePath: string, id: string, cwd: string): void {
  try {
    const child = spawn(claudePath, ['stop', id], { cwd, stdio: 'ignore', detached: OWN_GROUP })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // Nothing to stop it with.
  }
}

let listing: { at: number; key: string; sessions: Promise<SessionEntry[] | undefined> } | undefined

/**
 * Every background session, as `claude agents --json --all` lists them. One
 * call serves every task polling within the same second. Undefined when the
 * listing failed, which says nothing about any one session.
 */
export function listSessions(claudePath: string, cwd: string): Promise<SessionEntry[] | undefined> {
  if (listing && listing.key === claudePath && Date.now() - listing.at < POLL_MS / 2) return listing.sessions
  const sessions = cli(claudePath, ['agents', '--json', '--all'], cwd, 15_000).then((r) =>
    r.code === 0 ? parseAgents(r.stdout) : undefined,
  )
  listing = { at: Date.now(), key: claudePath, sessions }
  return sessions
}

/**
 * Stop a session and wait for its process to be gone: a session still on its
 * way out is resumed as a copy, and it writes its cost as it exits.
 */
export async function stopAndWait(claudePath: string, id: string, cwd: string): Promise<void> {
  await cli(claudePath, ['stop', id], cwd)
  for (let i = 0; i < 30; i++) {
    listing = undefined
    const s = (await listSessions(claudePath, cwd))?.find((e) => e.id === id)
    if (!s?.pid) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

/** A session that is alive right now, or undefined. */
export async function liveSession(claudePath: string, cwd: string, sessionId: string): Promise<SessionEntry | undefined> {
  const s = (await listSessions(claudePath, cwd))?.find((e) => e.sessionId === sessionId)
  return s?.pid ? s : undefined
}

/**
 * Resolves once a person carries a waiting session on by themselves — types
 * into it, so it starts working, or its transcript gains a message. Gives the
 * transcript's offset from before that message, for the queue to read the new
 * turn from. Undefined when the signal fires first.
 */
export async function answeredInSession(
  claudePath: string,
  cwd: string,
  sessionId: string,
  signal: AbortSignal,
): Promise<number | undefined> {
  const locate = () => transcriptPath(cwd, sessionId)
  const start = TranscriptReader.sizeOf(locate())
  const reader = new TranscriptReader(locate, start)
  while (!signal.aborted) {
    if (reader.read().some((e) => e.kind === 'prompt')) return start
    const s = (await listSessions(claudePath, cwd))?.find((e) => e.sessionId === sessionId)
    // Not 'blocked': a turn that ended on a question is blocked too, on the person.
    if (s?.pid && s.state === 'working') return start
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, POLL_MS)
      signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
    })
  }
  return undefined
}

/** `claude --bg` refused the folder: it has not been trusted in Claude Code. */
const untrusted = (r: { stdout: string; stderr: string }) => /workspace not trusted/i.test(`${r.stdout}\n${r.stderr}`)

export function runTask(
  task: Task,
  cfg: RunConfig,
  cwd: string,
  out: LogSink,
  opts: TaskRunOptions = {},
): RunHandle {
  const { resume, parallel = false } = opts
  let cancelled = false
  let paused = false
  // The background session's short id, once it has one.
  let short: string | undefined
  // Cuts the poll's sleep short on a cancel or a pause.
  let wake: (() => void) | undefined
  let pending = ''
  let column = 0

  const flush = () => {
    if (pending) out.appendLine(pending)
    pending = ''
    column = 0
  }

  const write = (s: string) => {
    // The channel is line-oriented; long lines break at a space, or at 160 regardless.
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

  const stop = () => {
    if (short) stopSession(cfg.claudePath, short, cwd)
  }

  const result = (async (): Promise<RunResult> => {
    const started = Date.now()
    const agent = cfg.useAgentFromPlan
      ? matchAgent(task.agent, await availableAgents(cfg.claudePath, cwd))
      : undefined
    const prompt = resume ? resume.reply : await composePrompt(task, cfg, cwd)

    out.appendLine('')
    out.appendLine(
      `=== ${task.id} — ${task.title}  [${agent || task.agent || 'default'}]` +
        (resume ? `  (${resume.label ?? 'resumed with your reply'})` : ''),
    )
    out.appendLine(`    ${new Date().toLocaleTimeString()}  ${cwd}`)
    out.appendLine('')

    if (cancelled) return { ok: false, cancelled: true, durationMs: 0, reason: 'cancelled', denied: [] }
    if (paused) return { ok: false, paused: true, durationMs: 0, reason: 'paused', denied: [] }

    let sessionId = resume?.sessionId
    let file: string | undefined
    // Looked for again if it moves: a session that enters a worktree of its own
    // is filed under that worktree's project from then on.
    const locate = () => {
      if (!file || !fs.existsSync(file)) file = sessionId ? transcriptPath(cwd, sessionId) : undefined
      return file
    }
    let reader: TranscriptReader
    let costAtStart = 0

    if (resume?.adopt) {
      // The person already carried the session on from its terminal: only watch it.
      short = shortId(resume.sessionId)
      reader = new TranscriptReader(locate, resume.adopt.offset)
      opts.onSession?.(resume.sessionId)
    } else {
      let offset = 0
      const known = resume ? (await listSessions(cfg.claudePath, cwd))?.find((e) => e.sessionId === resume.sessionId) : undefined
      if (resume) {
        // What the session had spent and written before this turn.
        const before = new TranscriptReader(locate)
        before.read()
        costAtStart = before.costUsd ?? 0
        offset = before.offset
        // A message goes into a session that is not running; one that is waiting on a reply is.
        if (known?.pid) await stopAndWait(cfg.claudePath, known.id, cwd)
      }
      const args = ['--bg']
      if (known) {
        // A background session keeps the options it started with; passing any starts a copy.
        args.push('--resume', known.sessionId)
      } else {
        args.push(
          '--permission-mode',
          cfg.permissionMode,
          '--name',
          opts.sessionName ?? `plan-queue ${task.id}`,
          '--append-system-prompt',
          parallel ? `${SESSION_NOTE} ${PARALLEL_NOTE}` : SESSION_NOTE,
        )
        if (resume) args.push('--resume', resume.sessionId)
        if (agent) args.push('--agent', agent)
        if (cfg.model) args.push('--model', cfg.model)
        args.push(...cfg.extraArgs)
        if (cfg.allowedTools.length) args.push('--allowedTools', ...cfg.allowedTools)
      }
      // `--` ends the variadic --allowedTools; the prompt is the positional after it.
      args.push('--', prompt)
      let launched = await cli(cfg.claudePath, args, cwd, 120_000)
      if (untrusted(launched)) {
        // Claude Code runs a background session only in a folder it trusts — a
        // new plan worktree is not one yet. A refused start costs nothing, so it
        // is tried again until the person accepts the trust prompt.
        flush()
        out.appendLine(`  Claude Code does not trust ${cwd} yet: accept its trust prompt in the terminal that opened.`)
        opts.onUntrusted?.(cwd)
        while (untrusted(launched)) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, 3000)
            wake = () => {
              clearTimeout(t)
              resolve()
            }
          })
          wake = undefined
          if (cancelled || paused) {
            opts.onUntrusted?.(undefined)
            const r = { durationMs: Date.now() - started, sessionId, denied: [] as string[] }
            return cancelled ? { ...r, ok: false, cancelled: true, reason: 'cancelled' } : { ...r, ok: false, paused: true, reason: 'paused' }
          }
          launched = await cli(cfg.claudePath, args, cwd, 120_000)
        }
        opts.onUntrusted?.(undefined)
      }
      short = parseBackgrounded(`${launched.stdout}\n${launched.stderr}`)
      if (!short) {
        const reason =
          `${launched.stderr}\n${launched.stdout}`.trim().split('\n').slice(-3).join(' ') ||
          `claude --bg exited ${launched.code}`
        out.appendLine(`--- ${task.id} FAILED to start its session: ${reason}`)
        return { ok: false, reason, transient: isTransient(reason), durationMs: Date.now() - started, sessionId, denied: [] }
      }
      // The listing names the full session id; give it a moment to show up.
      let entry: SessionEntry | undefined
      for (let i = 0; i < 15 && !entry; i++) {
        entry = (await listSessions(cfg.claudePath, cwd))?.find((e) => e.id === short)
        if (!entry) await new Promise((r) => setTimeout(r, 1000))
      }
      const id = entry?.sessionId ?? (resume && short === shortId(resume.sessionId) ? resume.sessionId : undefined)
      if (!id) {
        out.appendLine(`--- ${task.id} FAILED: session ${short} started but never showed up in claude agents`)
        stop()
        return { ok: false, reason: 'session not found', durationMs: Date.now() - started, denied: [] }
      }
      if (id !== sessionId) {
        // A copy, or a fresh session: its transcript is its own.
        sessionId = id
        file = undefined
        offset = 0
        costAtStart = 0
      }
      opts.onSession?.(id)
      flush()
      out.appendLine(`  session ${short} · claude attach ${short}`)
      reader = new TranscriptReader(locate, offset)
      if (cancelled || paused) stop()
    }

    const log = (e: TranscriptEvent) => {
      switch (e.kind) {
        case 'text':
          write(e.text)
          flush()
          break
        case 'thinking':
          if (cfg.logThinking) {
            write(e.text)
            flush()
          }
          break
        case 'tool':
          flush()
          out.appendLine(`  · ${toolSummary(e.name, e.input, cwd)}`)
          break
        case 'toolError': {
          const first = e.text.trim().split('\n')[0] ?? ''
          flush()
          out.appendLine(`    ✗ ${first.length > 200 ? first.slice(0, 199) + '…' : first}`)
          break
        }
        case 'prompt':
          // The queue's own message is already in the header.
          if (e.text.trim() === prompt.trim()) break
          flush()
          out.appendLine(`  > ${e.text.trim().split('\n').slice(0, 6).join('\n  > ')}`)
          break
      }
    }

    // Watch the session until its turn ends, it is stopped, or it goes away.
    const launchedAt = Date.now()
    let seenWorking = Boolean(resume?.adopt)
    let blocked = false
    // Polls in a row the session has been blocked: a turn ending on a question
    // shows as blocked a moment before its end is written, so one is not enough.
    let blockedStreak = 0
    let ended = false
    let gone = false
    let doneStreak = 0
    let missing = 0
    for (;;) {
      for (const e of reader.read()) {
        log(e)
        if (e.kind === 'turnEnd') ended = true
      }
      if (ended || cancelled || paused) break
      const list = await listSessions(cfg.claudePath, cwd)
      const entry = list?.find((e) => e.id === short)
      if (list && !entry) {
        if (++missing >= 5) gone = true
      } else if (entry) {
        missing = 0
        if (entry.state === 'working' || entry.state === 'blocked') {
          seenWorking = true
          doneStreak = 0
          blockedStreak = entry.state === 'blocked' ? blockedStreak + 1 : 0
          if (entry.state === 'blocked' && !blocked && blockedStreak >= 2) {
            blocked = true
            flush()
            out.appendLine(`  … waiting on you in its session (claude attach ${short})`)
            opts.onBlocked?.(reader.finalText.trim() || 'It is waiting on a permission prompt or a question in its session.')
          } else if (entry.state === 'working' && blocked) {
            blocked = false
            opts.onBlocked?.(undefined)
          }
        } else if (!entry.pid && (seenWorking || Date.now() - launchedAt > 30_000)) {
          // Its process ended mid-turn: stopped from outside, or /exit typed into it.
          gone = true
        } else if (entry.state === 'done' && (seenWorking || Date.now() - launchedAt > 30_000)) {
          // A turn that ended without its summary line: settled once it stays done.
          if (++doneStreak >= 3) ended = true
        }
      }
      if (gone || ended) break
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, POLL_MS)
        wake = () => {
          clearTimeout(t)
          resolve()
        }
      })
      wake = undefined
    }
    for (const e of reader.read()) {
      log(e)
      if (e.kind === 'turnEnd') ended = true
    }
    if (blocked) opts.onBlocked?.(undefined)
    flush()

    const durationMs = Date.now() - started
    const finalText = reader.finalText
    const v = verdict({ finalText, sessionId, requireSentinel: cfg.requireSentinel })
    // A session left waiting on a person stays up; any other is done with this turn
    // and is stopped, which is also when it writes what it has cost.
    const keep = !cancelled && !paused && !gone && !reader.lastIsError && (v.kind === 'waiting' || v.kind === 'silent')
    if (!keep && short) {
      await stopAndWait(cfg.claudePath, short, cwd)
      for (const e of reader.read()) log(e)
      flush()
    }
    const costEnd = reader.costUsd
    // A turn left waiting has no cost written yet; the turn that follows it counts both.
    const costUsd = keep || costEnd === undefined ? undefined : costEnd >= costAtStart ? costEnd - costAtStart : costEnd
    const base = { durationMs, costUsd, sessionId, denied: [] as string[] }

    if (cancelled) {
      out.appendLine(`\n--- ${task.id} cancelled`)
      return { ...base, ok: false, cancelled: true, reason: 'cancelled' }
    }
    if (paused) {
      out.appendLine(`\n--- ${task.id} paused; resuming it picks up this session`)
      return { ...base, ok: false, paused: true, reason: 'paused' }
    }
    if (gone && !ended) {
      out.appendLine(`\n--- ${task.id}: its session ended before its turn did; resuming it picks up the session`)
      return { ...base, ok: false, paused: true, reason: 'session ended' }
    }

    if (reader.lastIsError) {
      // The turn ended on an API error the CLI could not get past.
      const limited = limitFromText(finalText, Date.now())
      if (limited) {
        out.appendLine(`\n--- ${task.id} hit the usage limit${limited.type ? ` (${limited.type})` : ''}`)
        return { ...base, ok: false, limited, reason: 'usage limit' }
      }
      const reason = finalText.trim().split('\n').slice(-3).join(' ') || 'API error'
      out.appendLine(`\n--- ${task.id} FAILED: ${reason}`)
      return { ...base, ok: false, reason, transient: isTransient(finalText) }
    }

    if (v.kind === 'failed' || v.kind === 'blocked') {
      out.appendLine(`\n--- ${task.id} ${v.kind === 'blocked' ? 'BLOCKED' : 'FAILED'}: ${v.reason}`)
      return { ...base, ok: false, reason: v.reason }
    }
    if (v.kind === 'silent') {
      out.appendLine(`\n--- ${task.id} ended without a sentinel`)
      return { ...base, ok: false, waiting: true, silent: true, question: v.text, reason: 'no completion sentinel' }
    }
    if (v.kind === 'waiting') {
      // The session stays up, so the answer can be typed straight into it.
      out.appendLine(`\n--- ${task.id} WAITING FOR YOUR REPLY — answer in its session (claude attach ${short})`)
      return { ...base, ok: false, waiting: true, question: v.question, reason: 'waiting for reply' }
    }

    // Stopped above, not removed: a failed gate may still hand it the gate's output.
    // The queue takes it off the agents list once the task is done for good.
    out.appendLine(
      `\n--- ${task.id} ok${costUsd !== undefined ? `  $${costUsd.toFixed(3)}` : ''}` +
        `  ${(durationMs / 1000).toFixed(0)}s`,
    )
    return { ...base, ok: true }
  })()

  return {
    result,
    cancel() {
      cancelled = true
      wake?.()
      stop()
    },
    pause() {
      if (cancelled || paused) return
      paused = true
      wake?.()
      stop()
    },
    send() {
      return false
    },
  }
}

/** Take a finished task's session off the agents list. Its conversation stays resumable. */
export function forgetSession(claudePath: string, sessionId: string, cwd: string): void {
  const id = shortId(sessionId)
  void cli(claudePath, ['stop', id], cwd).then(() => cli(claudePath, ['rm', id], cwd))
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
