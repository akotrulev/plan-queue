import * as vscode from 'vscode'
import { readPlan, type Task } from './plan'
import { readConfig, runGate, runTask, type RunHandle } from './runner'
import type { StateStore } from './state'
import type { PlanTree } from './tree'

export class Queue {
  private handle: RunHandle | undefined
  private stopRequested = false

  constructor(
    private readonly state: StateStore,
    private readonly tree: PlanTree,
    private readonly out: vscode.OutputChannel,
    private readonly status: vscode.StatusBarItem,
  ) {}

  get running(): boolean {
    return this.handle !== undefined
  }

  stop(): void {
    this.stopRequested = true
    this.handle?.cancel()
  }

  /**
   * Run tasks of one plan, starting at `fromId` (or the first task that is not
   * done or skipped). `onlyId` runs exactly one task.
   *
   * The plan file is re-read from disk before every task, so a task that
   * rewrites the prompts below it changes what actually runs next.
   */
  async run(planPath: string, opts: { fromId?: string; onlyId?: string } = {}): Promise<void> {
    if (this.running) {
      void vscode.window.showWarningMessage('Plan Queue is already running a task.')
      return
    }
    this.stopRequested = false
    await vscode.commands.executeCommand('setContext', 'planQueue.running', true)
    this.out.show(true)

    const cwd =
      vscode.workspace.getWorkspaceFolder(vscode.Uri.file(planPath))?.uri.fsPath ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!cwd) {
      void vscode.window.showErrorMessage('Plan Queue needs an open workspace folder.')
      await this.finish()
      return
    }

    let started = opts.fromId === undefined
    let ran = 0
    let done: string[] = []

    try {
      for (;;) {
        if (this.stopRequested) break

        // Re-read, every iteration. This is the point of the whole design.
        const plan = await readPlan(planPath)
        const ordered = this.state.ordered(plan)

        let next: Task | undefined
        for (const task of ordered) {
          if (opts.onlyId) {
            if (task.id === opts.onlyId) next = task
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

        const cfg = readConfig()
        await this.state.set(planPath, next.id, {
          status: 'running',
          reason: undefined,
          ranHash: next.hash,
        })
        this.tree.refresh()
        this.status.text = `$(sync~spin) ${next.id}`
        this.status.tooltip = `Plan Queue — ${next.id} ${next.title}`
        this.status.show()

        this.handle = runTask(next, cfg, cwd, this.out)
        const result = await this.handle.result
        this.handle = undefined

        if (result.cancelled) {
          await this.state.set(planPath, next.id, { status: 'pending' })
          this.tree.refresh()
          break
        }

        let ok = result.ok
        let reason = result.reason
        const gate = vscode.workspace.getConfiguration('planQueue').get<string>('gateCommand', '')
        if (ok && gate.trim()) {
          ok = await runGate(gate, cwd, this.out)
          if (!ok) reason = 'gate failed'
        }

        await this.state.set(planPath, next.id, {
          status: ok ? 'done' : 'blocked',
          reason: ok ? undefined : reason,
          finishedAt: Date.now(),
          costUsd: result.costUsd,
          durationMs: result.durationMs,
          sessionId: result.sessionId,
        })
        this.tree.refresh()
        done.push(next.id)
        ran++

        if (!ok) {
          const stopOnFailure = vscode.workspace
            .getConfiguration('planQueue')
            .get<boolean>('stopOnFailure', true)
          void vscode.window.showErrorMessage(
            `Plan Queue — ${next.id} did not finish: ${reason ?? 'unknown'}`,
            'Show log',
          ).then((pick) => pick && this.out.show())
          if (stopOnFailure) break
        }
        if (opts.onlyId) break
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`Plan Queue failed: ${e instanceof Error ? e.message : e}`)
    } finally {
      await this.finish()
      if (ran && !this.stopRequested) {
        void vscode.window.showInformationMessage(`Plan Queue — finished ${ran} task(s).`)
      }
    }
  }

  private async finish(): Promise<void> {
    this.handle = undefined
    this.status.hide()
    await vscode.commands.executeCommand('setContext', 'planQueue.running', false)
    this.tree.refresh()
  }
}
