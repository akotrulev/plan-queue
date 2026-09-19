import * as vscode from 'vscode'
import type { Plan, Task } from './plan'

export type Status = 'pending' | 'running' | 'done' | 'blocked' | 'failed' | 'skipped'

export interface TaskState {
  status: Status
  /** Why it is blocked or failed — the sentinel's reason, or the gate's. */
  reason?: string
  /** The prompt hash as it was when the task last ran, so a later rewrite shows up. */
  ranHash?: string
  finishedAt?: number
  costUsd?: number
  durationMs?: number
  sessionId?: string
}

export interface PlanState {
  /** Task ids in the order you want them run. Ids the plan no longer has are dropped on read. */
  order: string[]
  tasks: Record<string, TaskState>
}

const KEY = 'planQueue.state.v1'

type Store = Record<string, PlanState>

/**
 * Per-workspace, on this machine only. Nothing is written into the repo, so a
 * plan file stays exactly as its author left it.
 */
export class StateStore {
  private store: Store

  constructor(private readonly memento: vscode.Memento) {
    this.store = memento.get<Store>(KEY) ?? {}
  }

  private async save(): Promise<void> {
    await this.memento.update(KEY, this.store)
  }

  private planState(path: string): PlanState {
    if (!this.store[path]) this.store[path] = { order: [], tasks: {} }
    return this.store[path]
  }

  /**
   * The tasks of a freshly read plan, in your order. A task the plan gained
   * since you last reordered keeps its position relative to the plan's own
   * sequence rather than being appended to the end.
   */
  ordered(plan: Plan): Task[] {
    const saved = this.planState(plan.path).order
    const byId = new Map(plan.tasks.map((t) => [t.id, t]))

    const out: Task[] = []
    const taken = new Set<string>()
    for (const id of saved) {
      const t = byId.get(id)
      if (t) {
        out.push(t)
        taken.add(id)
      }
    }
    // Insert anything new where the plan itself puts it.
    plan.tasks.forEach((t, planIndex) => {
      if (taken.has(t.id)) return
      const before = plan.tasks.slice(0, planIndex).map((p) => p.id)
      let at = out.length
      for (let i = 0; i < out.length; i++) {
        if (!before.includes(out[i].id)) {
          at = i
          break
        }
      }
      out.splice(at, 0, t)
    })
    return out
  }

  get(path: string, id: string): TaskState {
    return this.planState(path).tasks[id] ?? { status: 'pending' }
  }

  async set(path: string, id: string, patch: Partial<TaskState>): Promise<void> {
    const tasks = this.planState(path).tasks
    tasks[id] = { ...(tasks[id] ?? { status: 'pending' }), ...patch }
    await this.save()
  }

  async setOrder(path: string, order: string[]): Promise<void> {
    this.planState(path).order = order
    await this.save()
  }

  async restoreOrder(path: string): Promise<void> {
    this.planState(path).order = []
    await this.save()
  }

  async resetPlan(path: string): Promise<void> {
    this.planState(path).tasks = {}
    await this.save()
  }

  /** Clear any 'running' left behind by a window that closed mid-task. */
  async clearRunning(): Promise<void> {
    for (const plan of Object.values(this.store)) {
      for (const [id, task] of Object.entries(plan.tasks)) {
        if (task.status === 'running') plan.tasks[id] = { ...task, status: 'pending' }
      }
    }
    await this.save()
  }
}
