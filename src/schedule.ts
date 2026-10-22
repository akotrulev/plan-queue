import type { Task } from './plan'

export interface ScheduleInput {
  /** The plan's tasks in the order you want them run. */
  ordered: Task[]
  status: (id: string) => string
  /** Tasks this run has already started — whatever came of them. */
  attempted: ReadonlySet<string>
  /** Tasks with a process (or a pending reply) right now. */
  live: ReadonlySet<string>
  /** Start here: tasks before it count as satisfied. */
  fromId?: string
  /** Run exactly this task and nothing else. */
  onlyId?: string
}

const settled = (status: string) => status === 'done' || status === 'skipped'

/**
 * What can start now. A task with a `Depends on:` line waits for exactly those
 * tasks to be done; one without waits for every task before it, which is the
 * sequential queue it always was. Such an implicit wait is also released by a
 * task that was attempted and failed, so that with `stopOnFailure` off the
 * queue still carries on past it. A declared dependency never is. A paused
 * task releases nothing: it is unfinished work, not a failure.
 */
export function readyTasks(input: ScheduleInput): Task[] {
  const { ordered, status, attempted, live, fromId, onlyId } = input

  if (onlyId) {
    const t = ordered.find((x) => x.id === onlyId)
    return t && !live.has(t.id) && !attempted.has(t.id) ? [t] : []
  }

  const index = new Map(ordered.map((t, i) => [t.id, i]))
  const from = fromId === undefined ? 0 : index.get(fromId) ?? 0
  const out: Task[] = []

  ordered.forEach((task, i) => {
    if (i < from || live.has(task.id) || attempted.has(task.id)) return
    const st = status(task.id)
    if (settled(st)) return

    const declared = task.deps?.filter((d) => d !== task.id && index.has(d))
    const explicit = declared !== undefined && (declared.length > 0 || task.deps!.length === 0)

    const unmet = explicit
      ? declared!.some((d) => (index.get(d)! >= from ? !settled(status(d)) : false))
      : ordered.some(
          (t, j) =>
            j >= from &&
            j < i &&
            !settled(status(t.id)) &&
            (live.has(t.id) || !attempted.has(t.id) || status(t.id) === 'paused'),
        )
    if (!unmet) out.push(task)
  })
  return out
}

/** Dependencies a task names that the plan does not have — worth a line in the log. */
export function unknownDeps(task: Task, ordered: Task[]): string[] {
  const ids = new Set(ordered.map((t) => t.id))
  return (task.deps ?? []).filter((d) => !ids.has(d))
}
