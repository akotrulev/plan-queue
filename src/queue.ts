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
} from './git'
import { readPlan, type Task } from './plan'
import { readConfig, runGate, runTask, type Resume, type RunHandle } from './runner'
import type { PlanWorktree, StateStore } from './state'
import type { PlanTree } from './tree'

/** One plan being worked through. Several can be in flight, one per plan. */
interface Run {
  planPath: string
  title: string
  out: vscode.OutputChannel
  handle?: RunHandle
  current?: Task
  stopRequested: boolean
  /** Runs in the workspace itself rather than a worktree, so it has the folder to itself. */
  inPlace: boolean
  /** Set while the plan is paused on a task that asked something. */
  waiting?: { task: Task; answer: (reply: string | undefined) => void }
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
  private readonly channels = new Map<string, vscode.OutputChannel>()
  private lastChannel: vscode.OutputChannel | undefined

  constructor(
    private readonly state: StateStore,
    private readonly tree: PlanTree,
    private readonly status: vscode.StatusBarItem,
  ) {}

  get running(): boolean {
    return this.runs.size > 0
  }

  isRunning(planPath: string): boolean {
    return this.runs.has(planPath)
  }

  get active(): ActiveRun[] {
    return [...this.runs.values()].map((r) => ({
      planPath: r.planPath,
      title: r.title,
      task: r.waiting?.task ?? r.current,
      waiting: r.waiting !== undefined,
    }))
  }

  /** Each plan logs to a channel of its own, so parallel runs do not interleave. */
  private channel(planPath: string, title: string): vscode.OutputChannel {
    let out = this.channels.get(planPath)
    if (!out) {
      out = vscode.window.createOutputChannel(`Plan Queue — ${title}`)
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

  /**
   * Send a message to the task running right now in that plan — into the turn
   * in flight, or, when the task is waiting on a question, as the answer. False
   * when nothing is running there, or the task is past the point of taking input.
   */
  send(planPath: string, text: string): boolean {
    const run = this.runs.get(planPath)
    if (run?.waiting && text.trim()) {
      run.waiting.answer(text.trim())
      return true
    }
    return run?.handle?.send(text) ?? false
  }

  /**
   * Answer a task that is waiting. If its plan is not running — the window was
   * closed while it waited — the plan is started again from that task, and the
   * answer resumes the task's session.
   */
  reply(planPath: string, taskId: string, text: string): boolean {
    const run = this.runs.get(planPath)
    if (run) return run.waiting?.task.id === taskId && this.send(planPath, text)
    void this.run(planPath, { fromId: taskId, reply: text })
    return true
  }

  /** Stop one plan's run, or every run when no plan is given. */
  stop(planPath?: string): void {
    for (const run of this.runs.values()) {
      if (planPath && run.planPath !== planPath) continue
      run.stopRequested = true
      run.handle?.cancel()
      // A plan paused on a question stops too; the task stays waiting.
      run.waiting?.answer(undefined)
    }
  }

  dispose(): void {
    this.stop()
    for (const out of this.channels.values()) out.dispose()
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
      stopRequested: false,
      inPlace: false,
    }
    // Claim the slot before the first await below, so a double click cannot start it twice.
    this.runs.set(planPath, run)
    this.lastChannel = run.out
    await this.changed()
    run.out.show(true)

    let ran = 0
    let wt: PlanWorktree | undefined
    try {
      const prepared = await this.prepareWorktree(run, folder)
      if (prepared === 'cancelled') return
      wt = prepared
      if (!wt) {
        if ([...this.runs.values()].some((r) => r !== run && r.inPlace)) {
          void vscode.window.showWarningMessage(
            'Plan Queue is already running a plan in the workspace itself. Turn on planQueue.worktrees to run plans in parallel.',
          )
          return
        }
        run.inPlace = true
      }

      ran = await this.loop(run, wt, wt?.cwd ?? folder, opts)
      if (wt && !run.stopRequested) await this.mergeIfDone(run, wt)
    } catch (e) {
      void vscode.window.showErrorMessage(
        `Plan Queue — ${title} failed: ${e instanceof Error ? e.message : e}`,
      )
    } finally {
      this.runs.delete(planPath)
      await this.changed()
      if (ran && !run.stopRequested) {
        void vscode.window.showInformationMessage(`Plan Queue — ${title}: finished ${ran} task(s).`)
      }
    }
  }

  private async loop(
    run: Run,
    wt: PlanWorktree | undefined,
    cwd: string,
    opts: RunOptions,
  ): Promise<number> {
    const { planPath, out } = run
    let started = opts.fromId === undefined
    let ran = 0
    const done: string[] = []
    let reply = opts.reply

    for (;;) {
      if (run.stopRequested) break

      // Re-read, every iteration. This is the point of the whole design.
      const plan = await readPlan(wt?.planPath ?? planPath, planPath)
      const ordered = this.state.ordered(plan)

      let next: Task | undefined
      for (const task of ordered) {
        if (opts.onlyId) {
          if (task.id !== opts.onlyId) continue
          next = task
          break
        }
        if (!started) {
          if (task.id !== opts.fromId) continue
          started = true
        }
        if (done.includes(task.id)) continue
        const st = this.state.get(planPath, task.id)
        if (st.status === 'done' || st.status === 'skipped') continue
        next = task
        break
      }
      if (!next) break

      // A task that asked something picks up its own session once answered;
      // the plan waits here meanwhile, and other plans carry on.
      const before = this.state.get(planPath, next.id)
      let resume: Resume | undefined
      if (before.status === 'waiting' && before.sessionId) {
        const answer = reply ?? (await this.awaitReply(run, next, before.question ?? ''))
        reply = undefined
        if (answer === undefined) break
        out.appendLine(`  > ${answer.split('\n').join('\n  > ')}`)
        resume = { sessionId: before.sessionId, reply: answer }
      }

      const cfg = readConfig()
      await this.state.set(planPath, next.id, {
        status: 'running',
        reason: undefined,
        question: undefined,
        ranHash: next.hash,
      })
      run.current = next
      await this.changed()

      run.handle = runTask(next, cfg, cwd, out, resume)
      const result = await run.handle.result
      run.handle = undefined

      // Cost and time add up across the turns of one task.
      const costUsd =
        resume && before.costUsd !== undefined && result.costUsd !== undefined
          ? before.costUsd + result.costUsd
          : result.costUsd
      const durationMs = result.durationMs + (resume ? before.durationMs ?? 0 : 0)

      if (result.cancelled) {
        // An interrupted answer leaves the question open; a fresh task goes back to pending.
        await this.state.set(
          planPath,
          next.id,
          resume
            ? { status: 'waiting', reason: 'waiting for reply', question: before.question }
            : { status: 'pending' },
        )
        run.current = undefined
        await this.changed()
        break
      }

      if (result.waiting) {
        await this.state.set(planPath, next.id, {
          status: 'waiting',
          reason: 'waiting for reply',
          question: result.question,
          sessionId: result.sessionId,
          costUsd,
          durationMs,
        })
        run.current = undefined
        await this.changed()
        // Round again: the same task comes up, and waits for the answer.
        continue
      }

      let ok = result.ok
      let reason = result.reason
      const gate = vscode.workspace.getConfiguration('planQueue').get<string>('gateCommand', '')
      if (ok && gate.trim()) {
        ok = await runGate(gate, cwd, out)
        if (!ok) reason = 'gate failed'
      }
      // Each task lands as a commit on the plan's branch, whatever the task did
      // about committing itself, so the merge carries everything that passed.
      if (ok && wt) {
        try {
          if (await commitAll(wt.dir, `plan-queue: ${next.id} — ${next.title}`)) {
            out.appendLine(`  committed on ${wt.branch}`)
          }
        } catch (e) {
          ok = false
          reason = `commit failed: ${e instanceof Error ? e.message : e}`
        }
      }

      await this.state.set(planPath, next.id, {
        status: ok ? 'done' : 'blocked',
        reason: ok ? undefined : reason,
        finishedAt: Date.now(),
        costUsd,
        durationMs,
        sessionId: result.sessionId,
      })
      run.current = undefined
      await this.changed()
      done.push(next.id)
      ran++

      if (!ok) {
        const stopOnFailure = vscode.workspace
          .getConfiguration('planQueue')
          .get<boolean>('stopOnFailure', true)
        void vscode.window
          .showErrorMessage(`Plan Queue — ${next.id} did not finish: ${reason ?? 'unknown'}`, 'Show log')
          .then((pick) => pick && out.show())
        if (stopOnFailure) break
      }
      if (opts.onlyId) break
    }
    return ran
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
      if (created) await this.setUp(existing, out)
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

    await this.setUp(wt, out)
    // Recorded only once it is usable, so a failed setup is retried next run.
    await this.state.setWorktree(planPath, wt)
    return wt
  }

  /** A worktree holds only what is committed; the setup command rebuilds the rest. */
  private async setUp(wt: PlanWorktree, out: vscode.OutputChannel): Promise<void> {
    const setup = vscode.workspace.getConfiguration('planQueue').get<string>('worktreeSetupCommand', '')
    if (!setup.trim()) return
    out.appendLine('  setting up the worktree')
    if (!(await runGate(setup, wt.cwd, out))) {
      throw new Error(`the worktree setup command failed in ${wt.cwd}`)
    }
  }

  /** Pause the plan until the task's question is answered, or the plan is stopped. */
  private async awaitReply(run: Run, task: Task, question: string): Promise<string | undefined> {
    const answer = new Promise<string | undefined>((resolve) => {
      run.waiting = {
        task,
        answer: (reply) => {
          run.waiting = undefined
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
      const waiting = runs.filter((r) => r.waiting).length
      const one = runs[0]
      this.status.text =
        runs.length === 1
          ? one.waiting
            ? `$(comment-discussion) ${one.waiting.task.id} needs a reply`
            : `$(sync~spin) ${one.current?.id ?? one.title}`
          : `$(sync~spin) ${runs.length} plans${waiting ? ` · ${waiting} waiting` : ''}`
      this.status.tooltip = runs
        .map((r) =>
          r.waiting
            ? `${r.title} — ${r.waiting.task.id} is waiting for your reply`
            : `${r.title} — ${r.current ? `${r.current.id} ${r.current.title}` : 'preparing'}`,
        )
        .join('\n')
      this.status.show()
    }
    this.tree.refresh()
  }
}
