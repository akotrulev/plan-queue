import * as path from 'path'

/**
 * True when `ref`, from a `Runs after:` line, names the plan file at `file`:
 * its name without `.md`, or the start of it up to a hyphen. `156` names
 * `156-next-step.md`; `15` does not.
 */
export function namesPlan(ref: string, file: string): boolean {
  const base = path.basename(file).replace(/\.md$/i, '').toLowerCase()
  const r = ref.toLowerCase().replace(/\.md$/i, '')
  return base === r || base.startsWith(r + '-')
}

/** What the queue knows about one plan file when another plan has just merged. */
export interface PlanFacts {
  path: string
  runsAfter?: string[]
  /** Tasks not done or skipped. */
  left: number
  running: boolean
  /** It already has a worktree, cut before the plan that just merged. */
  hasWorktree: boolean
}

export interface Successor {
  path: string
  start: boolean
  /** Why it does not start, when it does not. */
  reason?: string
}

/**
 * The plans whose `Runs after:` names `merged`, and whether each may start now:
 * every plan it names has merged or has nothing left, it has tasks to run, it is
 * not running, and it has no worktree of its own yet (one cut before the merge
 * would not contain it).
 */
export function successors(merged: string, plans: PlanFacts[]): Successor[] {
  const out: Successor[] = []
  for (const p of plans) {
    if (p.path === merged || !p.runsAfter?.some((r) => namesPlan(r, merged))) continue
    if (p.left === 0) continue
    if (p.running) {
      out.push({ path: p.path, start: false, reason: 'it is already running' })
      continue
    }
    if (p.hasWorktree) {
      out.push({
        path: p.path,
        start: false,
        reason: 'it already has a worktree, cut before this merge; discard it or run the plan by hand',
      })
      continue
    }
    let reason: string | undefined
    for (const ref of p.runsAfter) {
      if (namesPlan(ref, merged)) continue
      const named = plans.filter((q) => q.path !== p.path && namesPlan(ref, q.path))
      if (!named.length) {
        reason = `its Runs after: names ${ref}, which matches no plan`
        break
      }
      if (named.some((q) => q.running || q.left > 0)) {
        reason = `it still waits for ${ref}`
        break
      }
    }
    out.push(reason ? { path: p.path, start: false, reason } : { path: p.path, start: true })
  }
  return out
}
