import { namesPlan } from './chain'
import type { Status } from './state'

/** The reason `clearRunning` gives a task that a closing window cut off. */
export const INTERRUPTED = 'interrupted when the window closed'

export interface TaskFact {
  id: string
  status: Status
  /** Paused by the usage limit, which resumes it by itself. */
  limited: boolean
  /** Paused by the window closing. */
  interrupted: boolean
}

/** What the scheduler knows about one plan file. */
export interface BacklogPlan {
  path: string
  runsAfter?: string[]
  tasks: TaskFact[]
  running: boolean
  /** It has a worktree, so it has not merged (or never started cleanly). */
  hasWorktree: boolean
}

export interface BacklogInput {
  /** Plan paths in backlog order. */
  backlog: string[]
  /** Every plan the workspace has, backlog or not: `Runs after:` looks at them all. */
  plans: BacklogPlan[]
  maxPlans: number
  resumeOnOpen: boolean
  /** Plans the user stopped or paused by hand; they stay out until started or re-added. */
  stopped: ReadonlySet<string>
}

export interface StuckPlan {
  path: string
  /** The tasks that hold it, e.g. `T2 blocked`. Same text, same stuck state. */
  tasks: string[]
}

export interface BacklogDecision {
  /** Start these, in order, as far as there is room. */
  start: string[]
  /** How many more backlog plans may start. */
  room: number
  /** Nothing left and merged: take them off the backlog. */
  drop: string[]
  stuck: StuckPlan[]
  /** Left alone, with the reason, for the log. */
  skip: { path: string; reason: string }[]
}

const finished = (t: TaskFact) => t.status === 'done' || t.status === 'skipped'

/** The tasks that keep a plan from running unattended. */
export function stuckTasks(tasks: TaskFact[], resumeOnOpen: boolean): string[] {
  const out: string[] = []
  for (const t of tasks) {
    let stuck = false
    if (t.status === 'blocked' || t.status === 'failed' || t.status === 'waiting') stuck = true
    // The limit timer carries these. A paused task nobody will resume is stuck;
    // only a window-close pause is picked up again, and only with resumeOnOpen.
    else if (t.status === 'paused' && !t.limited) stuck = !(resumeOnOpen && t.interrupted)
    if (stuck) out.push(`${t.id} ${t.status}`)
  }
  return out
}

/**
 * What a sweep should do. Pure: the class around it gathers the facts and acts
 * on the answer.
 */
export function decide(input: BacklogInput): BacklogDecision {
  const byPath = new Map(input.plans.map((p) => [p.path, p]))
  const out: BacklogDecision = { start: [], room: 0, drop: [], stuck: [], skip: [] }
  const left = (p: BacklogPlan) => p.tasks.filter((t) => !finished(t)).length

  let running = 0
  for (const p of input.backlog) if (byPath.get(p)?.running) running++
  out.room = Math.max(0, Math.floor(input.maxPlans) - running)

  for (const p of input.backlog) {
    const plan = byPath.get(p)
    if (!plan) {
      out.skip.push({ path: p, reason: 'its file is not among the plans' })
      continue
    }
    if (plan.running) {
      out.skip.push({ path: p, reason: 'it is running' })
      continue
    }
    if (left(plan) === 0) {
      if (plan.hasWorktree) out.skip.push({ path: p, reason: 'every task is done but its branch has not merged' })
      else out.drop.push(p)
      continue
    }
    if (input.stopped.has(p)) {
      out.skip.push({ path: p, reason: 'you stopped it; start it or add it again to put it back' })
      continue
    }
    const stuck = stuckTasks(plan.tasks, input.resumeOnOpen)
    if (stuck.length) {
      out.stuck.push({ path: p, tasks: stuck })
      out.skip.push({ path: p, reason: `stuck: ${stuck.join(', ')}` })
      continue
    }
    let why: string | undefined
    for (const ref of plan.runsAfter ?? []) {
      const named = input.plans.filter((q) => q.path !== p && namesPlan(ref, q.path))
      if (!named.length) {
        why = `its Runs after: names ${ref}, which matches no plan`
        break
      }
      if (named.some((q) => q.running || left(q) > 0)) {
        why = `it waits for ${ref}`
        break
      }
    }
    if (why) {
      out.skip.push({ path: p, reason: why })
      continue
    }
    out.start.push(p)
  }
  return out
}

/** Moves `path` within `list`; false when it is not there or cannot move that way. */
export function moved(list: string[], p: string, delta: number): string[] | undefined {
  const i = list.indexOf(p)
  const j = i + delta
  if (i < 0 || j < 0 || j >= list.length) return undefined
  const next = [...list]
  ;[next[i], next[j]] = [next[j], next[i]]
  return next
}

/** Adds `path` at the 1-based `position`, or at the end; a plan already in it moves. */
export function inserted(list: string[], p: string, position?: number): string[] {
  const rest = list.filter((x) => x !== p)
  const at = position === undefined || !Number.isFinite(position) ? rest.length : Math.min(rest.length, Math.max(0, Math.floor(position) - 1))
  rest.splice(at, 0, p)
  return rest
}
