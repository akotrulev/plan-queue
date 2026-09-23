import { spawn } from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

export function git(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + String(e) }))
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() }))
  })
}

async function must(args: string[], cwd: string): Promise<string> {
  const r = await git(args, cwd)
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr || r.stdout || `exit ${r.code}`}`)
  return r.stdout
}

/** The repository's top-level directory, or undefined when `dir` is not in one. */
export async function repoRoot(dir: string): Promise<string | undefined> {
  const r = await git(['rev-parse', '--show-toplevel'], dir)
  return r.code === 0 && r.stdout ? path.resolve(r.stdout) : undefined
}

/** The branch checked out in `dir`, or undefined on a detached HEAD. */
export async function currentBranch(dir: string): Promise<string | undefined> {
  const r = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], dir)
  return r.code === 0 && r.stdout ? r.stdout : undefined
}

/**
 * A branch- and directory-safe name for a plan: its file name, plus a short
 * hash of its repo-relative path so two `plan.md`s in different folders do not
 * collide.
 */
export function slugFor(relPath: string): string {
  const normal = relPath.split(path.sep).join('/')
  const base = normal
    .split('/')
    .pop()!
    .replace(/\.md$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const hash = crypto.createHash('sha1').update(normal).digest('hex').slice(0, 6)
  return `${base || 'plan'}-${hash}`
}

/** True when the path has uncommitted changes, or is not tracked at all. */
export async function isDirty(repo: string, file: string): Promise<boolean> {
  const r = await git(['status', '--porcelain', '--', file], repo)
  return r.code !== 0 || r.stdout.length > 0
}

/** Commit exactly one file, leaving whatever else is staged or modified alone. */
export async function commitFile(repo: string, file: string, message: string): Promise<void> {
  await must(['add', '--', file], repo)
  await must(['commit', '--only', '-m', message, '--', file], repo)
}

export interface Worktree {
  /** Absolute path of the worktree's top level. */
  dir: string
  branch: string
  /** The branch it was cut from, and the one it merges back into. */
  base: string
}

/**
 * Create the plan's worktree, or reuse the one a previous (stopped or failed)
 * run left behind so the queue picks up where it was.
 */
export async function ensureWorktree(repo: string, want: Worktree): Promise<{ created: boolean }> {
  // A worktree whose folder was deleted by hand is still listed, and still
  // holds its branch, until it is pruned.
  await git(['worktree', 'prune'], repo)
  const list = await must(['worktree', 'list', '--porcelain'], repo)
  const existing = list
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => path.resolve(l.slice('worktree '.length)))
  if (existing.some((d) => samePath(d, want.dir))) return { created: false }

  await fs.mkdir(path.dirname(want.dir), { recursive: true })

  const hasBranch = (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${want.branch}`], repo)).code === 0
  if (hasBranch) await must(['worktree', 'add', want.dir, want.branch], repo)
  else await must(['worktree', 'add', '-b', want.branch, want.dir, want.base], repo)
  return { created: true }
}

/** Stage and commit everything in the worktree. False when there was nothing to commit. */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  await must(['add', '-A'], dir)
  const staged = await git(['diff', '--cached', '--quiet'], dir)
  if (staged.code === 0) return false
  await must(['commit', '-m', message], dir)
  return true
}

let mergeLock: Promise<unknown> = Promise.resolve()

/**
 * Merge the plan's branch into its base, in the main checkout. Merges are
 * serialized: two plans finishing at once would otherwise race on one index.
 * A conflict is aborted, so the main checkout is never left mid-merge.
 */
export function mergeBranch(repo: string, wt: Worktree, message: string): Promise<{ ok: boolean; reason?: string }> {
  const run = mergeLock.then(async () => {
    const on = await currentBranch(repo)
    if (on !== wt.base) {
      return { ok: false, reason: `the main checkout is on ${on ?? 'a detached HEAD'}, not ${wt.base}` }
    }
    const r = await git(['merge', '--no-ff', '-m', message, wt.branch], repo)
    if (r.code === 0) return { ok: true }
    const mid = await git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], repo)
    if (mid.code === 0) await git(['merge', '--abort'], repo)
    const why = (r.stdout + '\n' + r.stderr).includes('CONFLICT') ? 'merge conflict' : r.stderr || r.stdout
    return { ok: false, reason: why.split('\n').slice(0, 3).join(' ') }
  })
  mergeLock = run.catch(() => undefined)
  return run
}

/**
 * Remove the worktree and delete its branch. `force` also drops unmerged work.
 * False when the folder could not be removed — a file held open, usually.
 */
export async function removeWorktree(repo: string, wt: Worktree, force = false): Promise<boolean> {
  const removed = await git(['worktree', 'remove', ...(force ? ['--force'] : []), wt.dir], repo)
  await git(['worktree', 'prune'], repo)
  await git(['branch', force ? '-D' : '-d', wt.branch], repo)
  return removed.code === 0
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const r = path.resolve(p)
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}
