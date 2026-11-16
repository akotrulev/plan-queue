import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'
import { decide, inserted, moved, INTERRUPTED, type BacklogPlan } from './backlog'
import { isDirty, repoRoot } from './git'
import { looksLikeAPlan, parsePlanText } from './plan'
import type { Queue } from './queue'
import type { StateStore } from './state'
import type { PlanTree } from './tree'

/** Waits after a trigger before sweeping, so what just happened has settled. */
const DEBOUNCE_MS = 1500
/** The same plan is not started by the scheduler again within this time. */
const RESTART_COOLDOWN_MS = 5 * 60_000
/** First sweep after the window opens, once the workspace has loaded. */
const STARTUP_MS = 5000

/**
 * The plan backlog: an ordered list of plans to run unattended, and the sweep
 * that starts them. It keeps nothing but the list; what is stuck or stopped is
 * read from the queue's state each time.
 */
export class BacklogRunner implements vscode.Disposable {
  private readonly subs: vscode.Disposable[] = []
  private readonly changeEmitter = new vscode.EventEmitter<void>()
  readonly onDidChange = this.changeEmitter.event
  /** Stopped or paused by hand this session. */
  private readonly stopped = new Set<string>()
  /** Stuck states already reported: plan path to the text that was reported. */
  private readonly told = new Map<string, string>()
  /** Plans already reported as not committed. */
  private readonly toldCommit = new Set<string>()
  private readonly started = new Map<string, number>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private interval: ReturnType<typeof setInterval> | undefined
  private startup: ReturnType<typeof setTimeout> | undefined
  private chain: Promise<void> = Promise.resolve()
  private queued = false
  private disposed = false

  constructor(
    private readonly state: StateStore,
    private readonly queue: Queue,
    private readonly tree: PlanTree,
    private readonly log: { appendLine(text: string): void },
  ) {
    this.subs.push(
      queue.onRunEnded(() => this.trigger()),
      queue.onLimitCleared(() => this.trigger()),
      queue.onRunStarted((p) => this.stopped.delete(p)),
      queue.onPlanStopped((ps) => {
        for (const p of ps) this.stopped.add(p)
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('planQueue.backlog')) this.arm()
      }),
    )
    this.arm()
    this.startup = setTimeout(() => {
      this.startup = undefined
      void this.afterActivation()
    }, STARTUP_MS)
  }

  // ---- the list --------------------------------------------------------------

  list(): string[] {
    return this.state.backlog()
  }

  /** 1-based position, or undefined when the plan is not in the backlog. */
  position(planPath: string): number | undefined {
    const i = this.list().indexOf(planPath)
    return i < 0 ? undefined : i + 1
  }

  async add(planPath: string, position?: number): Promise<number> {
    // Adding it again is asking for it to run: forget that it was stopped.
    this.stopped.delete(planPath)
    this.told.delete(planPath)
    this.toldCommit.delete(planPath)
    const next = inserted(this.list(), planPath, position)
    await this.save(next)
    this.trigger()
    return next.indexOf(planPath) + 1
  }

  async remove(planPath: string): Promise<boolean> {
    const list = this.list()
    if (!list.includes(planPath)) return false
    await this.save(list.filter((p) => p !== planPath))
    return true
  }

  async move(planPath: string, delta: number): Promise<boolean> {
    const next = moved(this.list(), planPath, delta)
    if (!next) return false
    await this.save(next)
    return true
  }

  private async save(list: string[]): Promise<void> {
    await this.state.setBacklog(list)
    this.tree.refresh()
    this.changeEmitter.fire()
  }

  // ---- sweeping --------------------------------------------------------------

  private config() {
    const c = vscode.workspace.getConfiguration('planQueue')
    return {
      enabled: c.get<boolean>('backlog.enabled', true),
      maxPlans: Math.max(1, Math.floor(Number(c.get<number>('backlog.maxPlans', 1))) || 1),
      sweepMinutes: Math.max(0, Number(c.get<number>('backlog.sweepMinutes', 5)) || 0),
      resumeOnOpen: c.get<boolean>('resumeOnOpen', false),
    }
  }

  /** (Re)start the interval from the settings. */
  private arm(): void {
    if (this.interval) clearInterval(this.interval)
    this.interval = undefined
    const { sweepMinutes } = this.config()
    if (sweepMinutes > 0) this.interval = setInterval(() => this.trigger(), sweepMinutes * 60_000)
  }

  /** Ask for a sweep soon. Several asks in a row are one sweep. */
  trigger(): void {
    if (this.disposed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.sweep()
    }, DEBOUNCE_MS)
  }

  /** One sweep at a time: a sweep asked for while another runs follows it, once. */
  sweep(): Promise<void> {
    if (this.queued) return this.chain
    this.queued = true
    this.chain = this.chain.then(async () => {
      this.queued = false
      if (this.disposed) return
      try {
        await this.sweepOnce()
      } catch (e) {
        this.log.appendLine(`backlog: sweep failed: ${e instanceof Error ? e.message : e}`)
      }
    })
    return this.chain
  }

  private async afterActivation(): Promise<void> {
    if (this.disposed) return
    if (this.config().resumeOnOpen) await this.resumeInterrupted().catch((e) => this.log.appendLine(`resume on open failed: ${e}`))
    await this.sweep()
  }

  /** Plans with a task the window closing paused, which `resumeOnOpen` carries on. */
  async resumeInterrupted(): Promise<string[]> {
    const resumed: string[] = []
    for (const p of this.state.planPaths()) {
      if (this.queue.isRunning(p) || !this.state.interruptedTasks(p).length) continue
      try {
        await fs.promises.access(this.state.livePlanPath(p))
      } catch {
        continue
      }
      const r = this.queue.start(p)
      if (r.ok) {
        resumed.push(p)
        this.log.appendLine(`resume on open: ${path.basename(p)} (${this.state.interruptedTasks(p).join(', ')})`)
      } else this.log.appendLine(`resume on open: ${path.basename(p)} did not start: ${r.reason}`)
    }
    return resumed
  }

  private async facts(): Promise<BacklogPlan[]> {
    const glob = vscode.workspace.getConfiguration('planQueue').get<string>('planGlob', 'docs/plans/**/*.md')
    const uris = await vscode.workspace.findFiles(glob, '**/node_modules/**', 2000)
    const plans: BacklogPlan[] = []
    for (const uri of uris) {
      try {
        const file = uri.fsPath
        const text = await fs.promises.readFile(file, 'utf8')
        if (!looksLikeAPlan(text)) continue
        const live = this.state.livePlanPath(file)
        const parsed = live === file ? parsePlanText(text, file) : parsePlanText(await fs.promises.readFile(live, 'utf8').catch(() => text), file)
        plans.push({
          path: file,
          runsAfter: parsed.runsAfter,
          tasks: parsed.tasks.map((t) => {
            const st = this.state.get(file, t.id)
            return {
              id: t.id,
              status: st.status,
              limited: st.limitedUntil !== undefined,
              interrupted: st.reason === INTERRUPTED,
            }
          }),
          running: this.queue.isRunning(file),
          hasWorktree: !!this.state.worktree(file),
        })
      } catch {
        // A plan we cannot read is not one we can start.
      }
    }
    return plans
  }

  private async sweepOnce(): Promise<void> {
    const cfg = this.config()
    const backlog = this.list()
    if (!cfg.enabled || !backlog.length) return
    // Nothing starts while the account is at its limit; onLimitCleared sweeps again.
    if (this.queue.limitState().until !== undefined) return

    const plans = await this.facts()
    const d = decide({ backlog, plans, maxPlans: cfg.maxPlans, resumeOnOpen: cfg.resumeOnOpen, stopped: this.stopped })

    if (d.drop.length) {
      for (const p of d.drop) this.log.appendLine(`backlog: ${path.basename(p)} is done and merged; taken off the backlog`)
      const gone = new Set(d.drop)
      await this.save(this.list().filter((p) => !gone.has(p)))
    }

    // A stuck plan is reported once per stuck state; one that has recovered may be reported again later.
    const stuckNow = new Set(d.stuck.map((s) => s.path))
    for (const p of [...this.told.keys()]) if (!stuckNow.has(p)) this.told.delete(p)
    for (const s of d.stuck) {
      const text = s.tasks.join(', ')
      if (this.told.get(s.path) === text) continue
      this.told.set(s.path, text)
      const title = plans.find((p) => p.path === s.path) ? path.basename(s.path) : s.path
      this.log.appendLine(`backlog: ${title} is stuck (${text}) and is skipped`)
      void vscode.window.showWarningMessage(`Plan Queue — ${title} is stuck on the backlog (${text}). It is skipped until that is fixed.`)
    }

    let room = d.room
    const now = Date.now()
    for (const p of d.start) {
      if (room <= 0) break
      const name = path.basename(p)
      const last = this.started.get(p)
      if (last !== undefined && now - last < RESTART_COOLDOWN_MS) {
        this.log.appendLine(`backlog: ${name} was started ${Math.round((now - last) / 1000)}s ago; not again yet`)
        continue
      }
      if (await this.needsCommit(p)) {
        this.log.appendLine(`backlog: ${name} has uncommitted changes, so starting it would ask you to commit it; skipped`)
        if (!this.toldCommit.has(p)) {
          this.toldCommit.add(p)
          void vscode.window.showWarningMessage(`Plan Queue — ${name} is on the backlog but not committed. Commit it, or run it by hand.`)
        }
        continue
      }
      this.toldCommit.delete(p)
      const r = this.queue.start(p)
      if (r.ok) {
        this.started.set(p, now)
        room--
        this.log.appendLine(`backlog: started ${name}`)
      } else {
        this.log.appendLine(`backlog: ${name} did not start: ${r.reason}`)
        // The limit came on, or something else holds it; the next trigger looks again.
        if (this.queue.limitState().until !== undefined) break
      }
    }
    for (const s of d.skip) if (!s.reason.startsWith('stuck')) this.log.appendLine(`backlog: ${path.basename(s.path)} skipped: ${s.reason}`)
  }

  /**
   * True when starting the plan would raise the "commit the plan" box: the
   * same conditions `prepareWorktree` checks before it asks.
   */
  private async needsCommit(planPath: string): Promise<boolean> {
    try {
      if (this.state.worktree(planPath)) return false
      if (!vscode.workspace.getConfiguration('planQueue').get<boolean>('worktrees', true)) return false
      const folder =
        vscode.workspace.getWorkspaceFolder(vscode.Uri.file(planPath))?.uri.fsPath ??
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      if (!folder) return false
      const repo = await repoRoot(folder)
      if (!repo) return false
      const rel = path.relative(repo, planPath)
      if (rel.startsWith('..') || path.isAbsolute(rel)) return false
      return await isDirty(repo, planPath)
    } catch {
      return false
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    if (this.startup) clearTimeout(this.startup)
    if (this.interval) clearInterval(this.interval)
    this.timer = this.startup = this.interval = undefined
    this.subs.forEach((s) => s.dispose())
    this.changeEmitter.dispose()
  }
}
