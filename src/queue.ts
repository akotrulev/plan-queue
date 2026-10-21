import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'
import {
  commitAll,
  commitFile,
  currentBranch,
  ensureWorktree,
  isDirty,
  mergeBranch,
  removeWorktree,
  repoRoot,
  slugFor,
  stashAll,
} from './git'
import { readPlan, type Task } from './plan'
import { readConfig, runGate, runTask, type LogSink, type Resume, type RunHandle } from './runner'
import { readyTasks, unknownDeps } from './schedule'
import { gateFixPrompt } from './describe'
import { NUDGE } from './verdict'
import type { PlanWorktree, StateStore } from './state'
import type { PlanTree } from './tree'

/** Output channel that also keeps the last lines, so a caller without VS Code can read the log. */
class PlanLog implements LogSink {
  private lines: string[] = []
  private partial = ''

  constructor(private readonly channel: vscode.OutputChannel) {}

  append(text: string): void {
    this.channel.append(text)
    this.track(text)
  }

  appendLine(text: string): void {
    this.channel.appendLine(text)
    this.track(text + '\n')
  }

  show(preserveFocus?: boolean): void {
    this.channel.show(preserveFocus)
  }

  dispose(): void {
    this.channel.dispose()
  }

  tail(n: number): string {
    const all = this.partial ? [...this.lines, this.partial] : this.lines
    return all.slice(-n).join('\n')
  }

  private track(text: string): void {
    const parts = (this.partial + text).split('\n')
    this.partial = parts.pop() ?? ''
    this.lines.push(...parts)
    if (this.lines.length > 2000) this.lines.splice(0, this.lines.length - 1500)
  }
}

/** Tags each line with its task, so tasks running side by side stay readable in one log. */
function tagged(out: LogSink, tag: string): LogSink {
  return {
    append: (s) => out.append(s),
    appendLine: (s) => out.appendLine(s ? `[${tag}] ${s}` : s),
  }
}

/** Writes to two logs at once: the plan's channel and the task's transcript. */
function tee(a: LogSink, b: LogSink): LogSink {
  return {
    append: (s) => {
      a.append(s)
      b.append(s)
    },
    appendLine: (s) => {
      a.appendLine(s)
      b.appendLine(s)
    },
  }
}

/** Transcripts kept per task; older ones are deleted. */
const KEEP_TRANSCRIPTS = 10

/** A task of a running plan: its process, or the question it is waiting on. */
interface Live {
  task: Task
  handle?: RunHandle
  waiting?: { answer: (reply: string | undefined) => void }
  /** Using a slot: false while it waits for a person, so that does not hold up the others. */
  busy: boolean
}

/** One plan being worked through. Several can be in flight, one per plan. */
interface Run {
  planPath: string
  title: string
  out: PlanLog
  /** Where tasks run: the plan's worktree, or the workspace folder. */
  cwd: string
  wt?: PlanWorktree
  live: Map<string, Live>
  /** Started during this run, whatever came of them. */
  attempted: Set<string>
  /** Tasks started by hand with "Run now", which skip the dependency check and the cap. */
  forced: string[]
  stopRequested: boolean
  /** A task failed and stopOnFailure is on: nothing new starts, what runs finishes. */
  halted: boolean
  /** The loop is done launching; too late to add to it. */
  closing: boolean
  /** Runs in the workspace itself rather than a worktree, so it has the folder to itself. */
  inPlace: boolean
  /** Tasks may share the working tree at the same moment. */
  parallel: boolean
  /** An answer for the task that was waiting when this run began. */
  initialReply?: { taskId: string; text: string }
  /** Passed, but not yet committed because another task was still working in the tree. */
  uncommitted: { id: string; title: string }[]
  /** Did not pass, and may have left changes in the tree that nobody has put away yet. */
  leftovers: string[]
  /** Aborted on stop: kills gates and setup commands mid-run. */
  abort: AbortController
  gitLock: Promise<unknown>
  gateLock: Promise<unknown>
  ran: number
  wake?: () => void
  kicked: boolean
}

export interface ActiveRun {
  planPath: string
  title: string
  task?: Task
  /** The task is waiting for a reply rather than working. */
  waiting: boolean
}

type RunOptions = { fromId?: string; onlyId?: string; reply?: string }

export class Queue implements vscode.Disposable {
  private readonly runs = new Map<string, Run>()
  private readonly channels = new Map<string, PlanLog>()
  private lastChannel: PlanLog | undefined

  constructor(
    private readonly state: StateStore,
    private readonly tree: PlanTree,
    private readonly status: vscode.StatusBarItem,
    /** Where task transcripts go; none are kept without it. */
    private readonly logDir?: string,
  ) {}

  get running(): boolean {
    return this.runs.size > 0
  }

  isRunning(planPath: string): boolean {
    return this.runs.has(planPath)
  }

  /** The tasks live in a plan right now, with whether each is waiting on a person. */
  liveTasks(planPath: string): { task: Task; waiting: boolean }[] {
    return [...(this.runs.get(planPath)?.live.values() ?? [])].map((l) => ({
      task: l.task,
      waiting: l.waiting !== undefined,
    }))
  }

  /** One entry per task in flight; a plan still preparing has one without a task. */
  get active(): ActiveRun[] {
    return [...this.runs.values()].flatMap((r): ActiveRun[] =>
      r.live.size
        ? [...r.live.values()].map((l) => ({
            planPath: r.planPath,
            title: r.title,
            task: l.task,
            waiting: l.waiting !== undefined,
          }))
        : [{ planPath: r.planPath, title: r.title, task: undefined, waiting: false }],
    )
  }

  /** Each plan logs to a channel of its own, so parallel runs do not interleave. */
  private channel(planPath: string, title: string): PlanLog {
    let out = this.channels.get(planPath)
    if (!out) {
      out = new PlanLog(vscode.window.createOutputChannel(`Plan Queue — ${title}`))
      this.channels.set(planPath, out)
    }
    return out
  }

  /** The plan's log, or the one written to most recently. */
  showLog(planPath?: string): void {
    const out = (planPath && this.channels.get(planPath)) || this.lastChannel
    if (out) out.show()
    else void vscode.window.showInformationMessage('Plan Queue has not run anything yet.')
  }

  /** The last lines of a plan's log, or of one task's latest transcript. */
  tail(planPath: string, lines: number, taskId?: string): string {
    if (taskId) {
      const file = this.state.get(planPath, taskId).logFile
      try {
        return file ? fs.readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n') : ''
      } catch {
        return ''
      }
    }
    return this.channels.get(planPath)?.tail(lines) ?? ''
  }

  /**
   * A file of its own for one run of a task — every turn, the gate, the commit —
   * so it can be read after the window that ran it has closed.
   */
  private transcript(run: Run, task: Task): { sink: LogSink; file?: string; close(): void } {
    const none = { sink: { append() {}, appendLine() {} }, close() {} }
    if (!this.logDir) return none
    try {
      const dir = path.join(this.logDir, slugFor(vscode.workspace.asRelativePath(run.planPath)))
      fs.mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const file = path.join(dir, `${task.id}-${stamp}.log`)
      const old = fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(`${task.id}-`) && f.endsWith('.log'))
        .sort()
      for (const f of old.slice(0, Math.max(0, old.length - KEEP_TRANSCRIPTS + 1))) {
        fs.rmSync(path.join(dir, f), { force: true })
      }
      const stream = fs.createWriteStream(file, { flags: 'a' })
      stream.on('error', () => undefined)
      return {
        sink: { append: (s) => void stream.write(s), appendLine: (s) => void stream.write(s + '\n') },
        file,
        close: () => stream.end(),
      }
    } catch {
      return none
    }
  }

  /**
   * Send a message to a task running right now — into the turn in flight, or,
   * when the task is waiting on a question, as the answer. Without a task id it
   * goes to the plan's only live task. False when there is no such task, or it
   * is past the point of taking input.
   */
  send(planPath: string, text: string, taskId?: string): boolean {
    const run = this.runs.get(planPath)
    if (!run) return false
    const live = taskId ? run.live.get(taskId) : run.live.size === 1 ? [...run.live.values()][0] : undefined
    if (!live) return false
    if (live.waiting && text.trim()) {
      live.waiting.answer(text.trim())
      return true
    }
    return live.handle?.send(text) ?? false
  }

  /**
   * Answer a task that is waiting. If its plan is not running — the window was
   * closed while it waited — the plan is started again from that task, and the
   * answer resumes the task's session.
   */
  reply(planPath: string, taskId: string, text: string): boolean {
    const run = this.runs.get(planPath)
    if (run) return run.live.get(taskId)?.waiting !== undefined && this.send(planPath, text, taskId)
    void this.run(planPath, { fromId: taskId, reply: text })
    return true
  }

  /** Stop one plan's run, or every run when no plan is given. */
  stop(planPath?: string): void {
    for (const run of this.runs.values()) {
      if (planPath && run.planPath !== planPath) continue
      run.stopRequested = true
      run.abort.abort()
      for (const live of run.live.values()) {
        live.handle?.cancel()
        // A task paused on a question stops too; it stays waiting.
        live.waiting?.answer(undefined)
      }
      this.kick(run)
    }
  }

  dispose(): void {
    this.stop()
    for (const out of this.channels.values()) out.dispose()
  }

  private kick(run: Run): void {
    if (run.wake) {
      const w = run.wake
      run.wake = undefined
      w()
    } else run.kicked = true
  }

  /**
   * Start a plan without waiting for it to finish. Says why when it cannot —
   * the answer to give a caller that is not looking at the VS Code window.
   */
  start(planPath: string, opts: RunOptions = {}): { ok: true } | { ok: false; reason: string } {
    if (this.runs.has(planPath)) return { ok: false, reason: 'this plan is already running' }
    if (!vscode.workspace.workspaceFolders?.length) return { ok: false, reason: 'no workspace folder is open' }
    void this.run(planPath, opts)
    return { ok: true }
  }

  /**
   * Start one task of a plan that is running, now, whatever it depends on and
   * however many tasks are already going. For a plan that is not running it is
   * the same as running that task alone.
   */
  async runNow(planPath: string, taskId: string, confirm = true): Promise<{ ok: true } | { ok: false; reason: string }> {
    const run = this.runs.get(planPath)
    if (!run) return this.start(planPath, { onlyId: taskId })
    if (run.closing) return { ok: false, reason: 'the plan is finishing; run the task again in a moment' }
    if (run.live.has(taskId)) return { ok: false, reason: `${taskId} is already running` }
    const st = this.state.get(planPath, taskId).status
    if (st === 'done' || st === 'skipped') return { ok: false, reason: `${taskId} is already ${st}` }

    const plan = await readPlan(run.wt?.planPath ?? planPath, planPath)
    const ordered = this.state.ordered(plan)
    const ready = readyTasks({
      ordered,
      status: (id) => this.state.get(planPath, id).status,
      attempted: run.attempted,
      live: new Set(run.live.keys()),
    })
    if (confirm && !ready.some((t) => t.id === taskId)) {
      const pick = await vscode.window.showWarningMessage(
        `${taskId} is waiting on tasks that are not done yet. Run it now anyway?`,
        'Run now',
      )
      if (pick !== 'Run now') return { ok: false, reason: 'cancelled' }
    }
    if (run.closing || run.live.has(taskId)) return { ok: false, reason: 'the plan has moved on; try again' }
    run.attempted.delete(taskId)
    run.parallel = true
    run.forced.push(taskId)
    this.kick(run)
    return { ok: true }
  }

  /**
   * Run tasks of one plan, starting at `fromId` (or the first task that is not
   * done or skipped). `onlyId` runs exactly one task.
   *
   * The plan file is re-read from disk before every task, so a task that
   * rewrites the prompts below it changes what actually runs next.
   *
   * With worktrees on, the plan runs on a branch of its own in a worktree of
   * its own, so other plans can run at the same time; once every task is done
   * or skipped, the branch is merged back into the one it was cut from.
   */
  async run(planPath: string, opts: RunOptions = {}): Promise<void> {
    if (this.runs.has(planPath)) {
      void vscode.window.showWarningMessage('Plan Queue is already running this plan.')
      return
    }

    const folder =
      vscode.workspace.getWorkspaceFolder(vscode.Uri.file(planPath))?.uri.fsPath ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!folder) {
      void vscode.window.showErrorMessage('Plan Queue needs an open workspace folder.')
      return
    }

    const title = (await readPlan(this.state.livePlanPath(planPath), planPath).catch(() => undefined))?.title ?? path.basename(planPath)
    const run: Run = {
      planPath,
      title,
      out: this.channel(planPath, title),
      cwd: folder,
      live: new Map(),
      attempted: new Set(),
      forced: [],
      stopRequested: false,
      halted: false,
      closing: false,
      inPlace: false,
      parallel: false,
      initialReply:
        opts.reply !== undefined && opts.fromId ? { taskId: opts.fromId, text: opts.reply } : undefined,
      uncommitted: [],
      leftovers: [],
      abort: new AbortController(),
      gitLock: Promise.resolve(),
      gateLock: Promise.resolve(),
      ran: 0,
      kicked: false,
    }
    // Claim the slot before the first await below, so a double click cannot start it twice.
    this.runs.set(planPath, run)
    this.lastChannel = run.out
    await this.changed()
    run.out.show(true)

    try {
      const prepared = await this.prepareWorktree(run, folder)
      if (prepared === 'cancelled') return
      run.wt = prepared
      if (!prepared) {
        if ([...this.runs.values()].some((r) => r !== run && r.inPlace)) {
          void vscode.window.showWarningMessage(
            'Plan Queue is already running a plan in the workspace itself. Turn on planQueue.worktrees to run plans in parallel.',
          )
          return
        }
        run.inPlace = true
      }
      run.cwd = prepared?.cwd ?? folder

      await this.loop(run, opts)
      if (run.wt && !run.stopRequested) await this.mergeIfDone(run, run.wt)
    } catch (e) {
      void vscode.window.showErrorMessage(
        `Plan Queue — ${title} failed: ${e instanceof Error ? e.message : e}`,
      )
    } finally {
      run.closing = true
      this.runs.delete(planPath)
      await this.changed()
      if (run.ran && !run.stopRequested) {
        void vscode.window.showInformationMessage(`Plan Queue — ${title}: finished ${run.ran} task(s).`)
      }
    }
  }

  /**
   * Start whatever is ready, up to `maxParallelTasks` at once, and wait for
   * something to change: a task ending, a reply arriving, a stop, a task started
   * by hand. A task that declares `Depends on:` waits for exactly those tasks;
   * one that does not waits for everything before it, so a plan with no such
   * lines runs one task at a time, as it always did.
   */
  private async loop(run: Run, opts: RunOptions): Promise<void> {
    const { planPath, out } = run

    for (;;) {
      // Tasks started by hand skip the dependency check and the cap.
      while (run.forced.length && !run.stopRequested) {
        const id = run.forced.shift()!
        const task = this.state.ordered(await readPlan(run.wt?.planPath ?? planPath, planPath)).find((t) => t.id === id)
        if (task && !run.live.has(id)) this.launch(run, task)
      }

      if (!run.stopRequested && !run.halted) {
        // Re-read, every pass. This is the point of the whole design.
        const plan = await readPlan(run.wt?.planPath ?? planPath, planPath)
        const ordered = this.state.ordered(plan)
        const cfg = readConfig()
        run.parallel = run.parallel || (cfg.maxParallelTasks > 1 && ordered.some((t) => t.deps !== undefined))

        for (const task of ordered) {
          const missing = unknownDeps(task, ordered)
          if (missing.length && !run.attempted.has(task.id)) {
            out.appendLine(`  ${task.id}: depends on ${missing.join(', ')}, which the plan does not have`)
          }
        }

        const ready = readyTasks({
          ordered,
          status: (id) => this.state.get(planPath, id).status,
          attempted: run.attempted,
          live: new Set(run.live.keys()),
          fromId: opts.fromId,
          onlyId: opts.onlyId,
        })
        let busy = [...run.live.values()].filter((l) => l.busy).length
        for (const task of ready) {
          if (busy >= cfg.maxParallelTasks) break
          this.launch(run, task)
          busy++
        }
      }

      if (run.live.size === 0 && (!run.forced.length || run.stopRequested)) break
      await new Promise<void>((resolve) => {
        if (run.kicked) {
          run.kicked = false
          resolve()
        } else run.wake = resolve
      })
    }
    run.closing = true
  }

  /** Start a task without waiting for it; it tells the loop when it is done. */
  private launch(run: Run, task: Task): void {
    const live: Live = { task, busy: true }
    run.live.set(task.id, live)
    run.attempted.add(task.id)
    void this.changed()
    this.execute(run, live)
      .catch((e) => {
        run.halted = true
        run.out.appendLine(`\n--- ${task.id} ERROR: ${e instanceof Error ? e.message : e}`)
        void vscode.window.showErrorMessage(
          `Plan Queue — ${task.id} failed: ${e instanceof Error ? e.message : e}`,
        )
      })
      .finally(() => {
        run.live.delete(task.id)
        void this.changed()
        this.kick(run)
      })
  }

  /** One task, logged to a transcript of its own as well as the plan's channel. */
  private async execute(run: Run, live: Live): Promise<void> {
    const { planPath } = run
    const task = live.task
    const log = this.transcript(run, task)
    if (log.file) await this.state.set(planPath, task.id, { logFile: log.file })
    try {
      await this.turns(run, live, tee(run.parallel ? tagged(run.out, task.id) : run.out, log.sink))
    } finally {
      log.close()
    }
  }

  /** One task, from its first turn to its verdict, including any questions it asks on the way. */
  private async turns(run: Run, live: Live, out: LogSink): Promise<void> {
    const { planPath, wt } = run
    const task = live.task
    let reply = run.initialReply?.taskId === task.id ? run.initialReply.text : undefined
    if (reply !== undefined) run.initialReply = undefined
    // The queue's own follow-ups in the same session: once about a missing
    // sentinel, and up to gateRetries times with a failed gate's output.
    let followUp: { text: string; label: string } | undefined
    let nudged = false
    let gateFixes = 0
    let denied: string[] = []

    for (;;) {
      const before = this.state.get(planPath, task.id)
      let resume: (Resume & { kind: 'reply' | 'queue' }) | undefined
      if (followUp && before.sessionId) {
        resume = { sessionId: before.sessionId, reply: followUp.text, label: followUp.label, kind: 'queue' }
        followUp = undefined
      } else if (before.status === 'waiting' && before.sessionId) {
        // A task that asked something picks up its own session once answered;
        // it waits here meanwhile, and the rest of the plan, and other plans, carry on.
        live.busy = false
        this.kick(run)
        const answer = reply ?? (await this.awaitReply(run, live, before.question ?? ''))
        reply = undefined
        live.busy = true
        if (answer === undefined) return
        out.appendLine(`  > ${answer.split('\n').join('\n  > ')}`)
        resume = { sessionId: before.sessionId, reply: answer, label: 'resumed with your reply', kind: 'reply' }
      }

      const cfg = readConfig()
      await this.state.set(planPath, task.id, {
        status: 'running',
        reason: undefined,
        question: undefined,
        ranHash: task.hash,
      })
      await this.changed()

      live.handle = runTask(task, cfg, run.cwd, out, {
        resume,
        parallel: run.parallel,
        sessionName: `plan-queue ${run.title} ${task.id}`,
      })
      const result = await live.handle.result
      live.handle = undefined
      denied = [...new Set([...denied, ...result.denied])]

      // Cost and time add up across the turns of one task.
      const costUsd =
        resume && before.costUsd !== undefined && result.costUsd !== undefined
          ? before.costUsd + result.costUsd
          : result.costUsd ?? (resume ? before.costUsd : undefined)
      const durationMs = result.durationMs + (resume ? before.durationMs ?? 0 : 0)

      if (result.cancelled) {
        // An interrupted answer leaves the question open; anything else goes back to pending.
        const reopen = resume?.kind === 'reply'
        await this.state.set(
          planPath,
          task.id,
          reopen
            ? { status: 'waiting', reason: 'waiting for reply', question: before.question, costUsd, durationMs, denied }
            : { status: 'pending', costUsd, durationMs, denied },
        )
        if (!reopen) await this.leaveBehind(run, live, out)
        await this.changed()
        return
      }

      if (result.silent && !nudged) {
        nudged = true
        out.appendLine('  no sentinel; asking the task whether it is done, blocked or asking something')
        followUp = { text: NUDGE, label: 'asked about its missing sentinel' }
        await this.state.set(planPath, task.id, { sessionId: result.sessionId, costUsd, durationMs })
        continue
      }

      if (result.waiting) {
        await this.state.set(planPath, task.id, {
          status: 'waiting',
          reason: 'waiting for reply',
          question: result.question,
          sessionId: result.sessionId,
          costUsd,
          durationMs,
          denied,
        })
        await this.changed()
        // Round again: the same task comes up, and waits for the answer.
        continue
      }

      let ok = result.ok
      let reason = result.reason
      const c = vscode.workspace.getConfiguration('planQueue')
      const gate = c.get<string>('gateCommand', '')
      if (ok && gate.trim()) {
        // One gate at a time: two against the same tree would each see the other's half-made edits.
        const gated = run.gateLock.then(() =>
          runGate(gate, run.cwd, out, {
            timeoutMs: c.get<number>('gateTimeoutMinutes', 30) * 60_000,
            signal: run.abort.signal,
          }),
        )
        run.gateLock = gated.catch(() => undefined)
        const g = await gated
        ok = g.ok
        if (!ok) reason = g.timedOut ? 'gate timed out' : 'gate failed'
        const retries = Math.max(0, c.get<number>('gateRetries', 1))
        if (!ok && !run.stopRequested && result.sessionId && gateFixes < retries) {
          // Hand the gate's output back to the session that did the work, rather
          // than throwing that context away.
          gateFixes++
          out.appendLine(`  ${reason}; handing its output back to the task (${gateFixes} of ${retries})`)
          followUp = {
            text: gateFixPrompt(gate, g.output, gateFixes, retries),
            label: `gate failed — output handed back, ${gateFixes} of ${retries}`,
          }
          await this.state.set(planPath, task.id, { sessionId: result.sessionId, costUsd, durationMs })
          continue
        }
        if (run.stopRequested) {
          // Stopped mid-gate: the work is unverified, so it is not done.
          await this.state.set(planPath, task.id, { status: 'pending', costUsd, durationMs })
          await this.leaveBehind(run, live, out)
          await this.changed()
          return
        }
      }

      // Each passing task lands on the plan's branch, whatever the task did about
      // committing itself, so the merge carries everything that passed. Tasks that
      // share the tree commit together, once the last of them has finished.
      live.busy = false
      if (ok && wt) {
        run.uncommitted.push({ id: task.id, title: task.title })
        if ([...run.live.values()].some((l) => l !== live && l.busy)) {
          out.appendLine('  commit deferred: another task is still working in the tree')
        } else {
          try {
            const note = await this.settle(run, wt, false)
            if (note) out.appendLine(`  ${note}`)
          } catch (e) {
            ok = false
            reason = `commit failed: ${e instanceof Error ? e.message : e}`
          }
        }
      }

      if (!ok && denied.length) reason = `${reason ?? 'blocked'} · denied ${denied.join(', ')}`
      await this.state.set(planPath, task.id, {
        status: ok ? 'done' : 'blocked',
        reason: ok ? undefined : reason,
        finishedAt: Date.now(),
        costUsd,
        durationMs,
        sessionId: result.sessionId,
        denied,
      })
      await this.changed()
      run.ran++

      if (!ok) {
        await this.leaveBehind(run, live, out)
        const allow = denied.length ? `Allow ${denied.join(', ')}` : undefined
        void vscode.window
          .showErrorMessage(
            `Plan Queue — ${task.id} did not finish: ${reason ?? 'unknown'}`,
            'Show log',
            ...(allow ? [allow] : []),
          )
          .then(async (pick) => {
            if (pick === 'Show log') run.out.show()
            else if (pick && pick === allow) await allowTools(denied)
          })
        // Tasks already going are left to finish; nothing new starts.
        if (c.get<boolean>('stopOnFailure', true)) run.halted = true
      }
      return
    }
  }

  /**
   * A task that did not pass may have left half its work in the tree. Once
   * nothing else is in the tree, it is stashed, so the next task — and the next
   * commit — starts from what passed. With another task still there, it waits;
   * whoever settles the tree last deals with it.
   */
  private async leaveBehind(run: Run, live: Live, out: LogSink): Promise<void> {
    live.busy = false
    if (!run.wt) return
    run.leftovers.push(live.task.id)
    if ([...run.live.values()].some((l) => l !== live)) return
    try {
      const note = await this.settle(run, run.wt, true)
      if (note) out.appendLine(`  ${note}`)
    } catch (e) {
      out.appendLine(`  could not put away the leftovers: ${e instanceof Error ? e.message : e}`)
    }
  }

  /**
   * Commit what has passed since the last commit, or, when nothing has, stash
   * what failed tasks left. One at a time: it is one index. Leftovers that are
   * in the tree alongside work that passed cannot be told apart from it; that
   * commit says so.
   */
  private settle(run: Run, wt: PlanWorktree, quiet: boolean): Promise<string | undefined> {
    const job = run.gitLock.then(async () => {
      if (run.uncommitted.length) {
        const batch = run.uncommitted.splice(0)
        const left = run.leftovers.splice(0)
        const subject = `plan-queue: ${batch.map((b) => b.id).join(', ')} — ${batch.map((b) => b.title).join('; ')}`
        const message = left.length
          ? `${subject}\n\nAlso carries what ${left.join(', ')} left uncommitted in the same tree without passing.`
          : subject
        try {
          if (!(await commitAll(wt.dir, message))) return undefined
        } catch (e) {
          run.uncommitted.unshift(...batch)
          run.leftovers.unshift(...left)
          throw e
        }
        return left.length
          ? `committed on ${wt.branch}: ${subject} — WITH the leftovers of ${left.join(', ')}, which did not pass`
          : `committed on ${wt.branch}: ${subject}`
      }
      const stash = vscode.workspace.getConfiguration('planQueue').get<boolean>('stashFailedWork', true)
      if (!quiet || !run.leftovers.length || !stash) return undefined
      const left = run.leftovers.splice(0)
      const ref = await stashAll(wt.dir, `plan-queue: leftovers of ${left.join(', ')} (${run.title})`)
      return ref
        ? `${left.join(', ')} left changes behind; stashed as ${ref} (git stash apply ${ref} brings them back)`
        : undefined
    })
    run.gitLock = job.catch(() => undefined)
    return job
  }

  /**
   * The plan's worktree: the one it already has, or a new one when worktrees
   * are on and the workspace is a git checkout on a branch. Undefined means
   * run in place.
   */
  private async prepareWorktree(run: Run, folder: string): Promise<PlanWorktree | undefined | 'cancelled'> {
    const { planPath, out } = run
    const c = vscode.workspace.getConfiguration('planQueue')

    // A plan part-way through keeps its worktree, even if the setting has since
    // been turned off: its finished tasks live on that branch.
    const existing = this.state.worktree(planPath)
    if (existing) {
      const { created } = await ensureWorktree(existing.repo, existing)
      out.appendLine(`=== ${run.title}: resuming in ${existing.dir} (${existing.branch})`)
      // Its folder was deleted and has just been checked out again, bare.
      if (created) await this.setUp(run, existing)
      return existing
    }
    if (!c.get<boolean>('worktrees', true)) return undefined

    const repo = await repoRoot(folder)
    if (!repo) {
      out.appendLine(`=== ${run.title}: not a git repository, running in the workspace`)
      return undefined
    }
    const relPlan = path.relative(repo, planPath)
    if (relPlan.startsWith('..') || path.isAbsolute(relPlan)) return undefined

    const base = await currentBranch(repo)
    if (!base) {
      throw new Error('the workspace is on a detached HEAD, so there is no branch to merge the plan back into')
    }

    // The worktree is cut from the branch, so it only sees what is committed.
    if (await isDirty(repo, planPath)) {
      const pick = await vscode.window.showWarningMessage(
        `"${run.title}" has uncommitted changes. Its worktree is cut from ${base}, so the plan must be committed for its tasks to see it.`,
        { modal: true },
        'Commit the plan and run',
      )
      if (pick !== 'Commit the plan and run') return 'cancelled'
      await commitFile(repo, planPath, `plan-queue: add ${relPlan.split(path.sep).join('/')}`)
    }

    const slug = slugFor(relPlan)
    const root =
      c.get<string>('worktreeRoot', '').trim() ||
      path.join(path.dirname(repo), `${path.basename(repo)}.plan-queue`)
    const dir = path.resolve(repo, root, slug)
    const wt: PlanWorktree = {
      dir,
      branch: `plan-queue/${slug}`,
      base,
      repo,
      planPath: path.join(dir, relPlan),
      cwd: path.join(dir, path.relative(repo, folder)),
    }
    await ensureWorktree(repo, wt)
    out.appendLine(`=== ${run.title}: worktree ${dir} on ${wt.branch}, from ${base}`)

    await this.setUp(run, wt)
    // Recorded only once it is usable, so a failed setup is retried next run.
    await this.state.setWorktree(planPath, wt)
    return wt
  }

  /** A worktree holds only what is committed; the setup command rebuilds the rest. */
  private async setUp(run: Run, wt: PlanWorktree): Promise<void> {
    const c = vscode.workspace.getConfiguration('planQueue')
    const setup = c.get<string>('worktreeSetupCommand', '')
    if (!setup.trim()) return
    run.out.appendLine('  setting up the worktree')
    const { ok } = await runGate(setup, wt.cwd, run.out, {
      timeoutMs: c.get<number>('gateTimeoutMinutes', 30) * 60_000,
      signal: run.abort.signal,
    })
    if (!ok) {
      throw new Error(`the worktree setup command failed in ${wt.cwd}`)
    }
  }

  /** Hold a task until its question is answered, or the plan is stopped. */
  private async awaitReply(run: Run, live: Live, question: string): Promise<string | undefined> {
    const { task } = live
    const answer = new Promise<string | undefined>((resolve) => {
      live.waiting = {
        answer: (reply) => {
          live.waiting = undefined
          resolve(reply)
        },
      }
    })
    await this.changed()
    const gist = question
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-2)
      .join(' ')
    void vscode.window
      .showWarningMessage(
        `Plan Queue — ${task.id} (${run.title}) is asking: ${gist.length > 240 ? '…' + gist.slice(-240) : gist}`,
        'Reply',
        'Show log',
      )
      .then((pick) => {
        if (pick === 'Reply') {
          void vscode.commands.executeCommand('planQueue.reply', { planPath: run.planPath, taskId: task.id })
        } else if (pick) run.out.show()
      })
    const reply = await answer
    await this.changed()
    return reply
  }

  /** Merge the plan's branch back once nothing in the plan is left to run. */
  private async mergeIfDone(run: Run, wt: PlanWorktree): Promise<void> {
    const { planPath, out, title } = run
    const plan = await readPlan(wt.planPath, planPath)
    const left = plan.tasks.filter((t) => {
      const s = this.state.get(planPath, t.id).status
      return s !== 'done' && s !== 'skipped'
    })
    if (left.length) {
      out.appendLine(`=== ${title}: ${left.length} task(s) left; ${wt.branch} stays unmerged`)
      return
    }
    if (!vscode.workspace.getConfiguration('planQueue').get<boolean>('mergeWhenDone', true)) {
      out.appendLine(`=== ${title}: done; ${wt.branch} is ready to merge into ${wt.base}`)
      return
    }

    await commitAll(wt.dir, `plan-queue: ${title} — remaining changes`)
    out.appendLine(`=== ${title}: merging ${wt.branch} into ${wt.base}`)
    const merged = await mergeBranch(wt.repo, wt, `plan-queue: merge ${title}`)
    if (!merged.ok) {
      out.appendLine(`  not merged: ${merged.reason}`)
      void vscode.window
        .showErrorMessage(
          `Plan Queue — could not merge ${wt.branch} into ${wt.base}: ${merged.reason}. ` +
            'The branch and its worktree are kept; run the plan again to retry the merge.',
          'Show log',
        )
        .then((pick) => pick && out.show())
      return
    }

    out.appendLine(`  merged into ${wt.base}`)
    const removed = await removeWorktree(wt.repo, wt)
    if (!removed) out.appendLine(`  could not remove ${wt.dir}; delete it by hand`)
    await this.state.setWorktree(planPath, undefined)
    void vscode.window.showInformationMessage(`Plan Queue — ${title} merged into ${wt.base}.`)
  }

  /** Throw away a plan's worktree and its unmerged branch. */
  async discardWorktree(planPath: string): Promise<void> {
    const wt = this.state.worktree(planPath)
    if (!wt || this.runs.has(planPath)) return
    await removeWorktree(wt.repo, wt, true)
    await this.state.setWorktree(planPath, undefined)
    this.tree.refresh()
  }

  /** Context key, status bar and tree, after any run starts, moves on or ends. */
  private async changed(): Promise<void> {
    await vscode.commands.executeCommand('setContext', 'planQueue.running', this.runs.size > 0)
    const runs = [...this.runs.values()]
    if (!runs.length) {
      this.status.hide()
    } else {
      const lives = runs.flatMap((r) => [...r.live.values()])
      const waiting = lives.filter((l) => l.waiting).length
      const working = lives.filter((l) => !l.waiting)
      this.status.text =
        runs.length === 1
          ? waiting && !working.length
            ? `$(comment-discussion) ${lives.map((l) => l.task.id).join(', ')} ${waiting === 1 ? 'needs' : 'need'} a reply`
            : `$(sync~spin) ${working.map((l) => l.task.id).join(', ') || runs[0].title}`
          : `$(sync~spin) ${runs.length} plans${waiting ? ` · ${waiting} waiting` : ''}`
      this.status.tooltip = runs
        .map((r) => {
          const tasks = [...r.live.values()]
          return tasks.length
            ? `${r.title}\n` +
                tasks
                  .map((l) => `  ${l.task.id} ${l.task.title}${l.waiting ? ' — waiting for your reply' : ''}`)
                  .join('\n')
            : `${r.title} — preparing`
        })
        .join('\n')
      this.status.show()
    }
    this.tree.refresh()
  }
}

/**
 * Add allowlist entries where `allowedTools` is set now — the workspace's
 * value if it has one, your user settings otherwise — keeping what is there.
 */
export async function allowTools(rules: string[]): Promise<void> {
  const c = vscode.workspace.getConfiguration('planQueue')
  const current = c.get<string[]>('allowedTools', [])
  const add = rules.filter((r) => !current.includes(r))
  if (!add.length) return
  const inspect = c.inspect<string[]>('allowedTools')
  const target =
    inspect?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspect?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global
  await c.update('allowedTools', [...current, ...add], target)
  void vscode.window.showInformationMessage(
    `Plan Queue — allowed ${add.join(', ')}. Run the task again to use it.`,
  )
}
