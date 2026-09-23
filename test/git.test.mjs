import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
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
} from '../out/git.mjs'

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

/** A throwaway repo on `main` with one commit, and a folder beside it for worktrees. */
function scratchRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-queue-')))
  const repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  sh(repo, 'init', '-q', '-b', 'main')
  sh(repo, 'config', 'user.email', 'test@example.com')
  sh(repo, 'config', 'user.name', 'test')
  sh(repo, 'config', 'commit.gpgsign', 'false')
  sh(repo, 'config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n')
  sh(repo, 'add', '-A')
  sh(repo, 'commit', '-q', '-m', 'init')
  return { root, repo }
}

const wtFor = (root, slug) => ({ dir: path.join(root, 'wt', slug), branch: `plan-queue/${slug}`, base: 'main' })

test('slugFor is stable, safe, and tells same-named plans apart', () => {
  const a = slugFor('docs/plans/My Plan.md')
  assert.match(a, /^my-plan-[0-9a-f]{6}$/)
  assert.equal(slugFor('docs/plans/My Plan.md'), a)
  assert.notEqual(slugFor('docs/a/plan.md'), slugFor('docs/b/plan.md'))
  assert.match(slugFor('docs/plans/!!!.md'), /^plan-[0-9a-f]{6}$/)
})

test('repoRoot and currentBranch read the checkout', async () => {
  const { root, repo } = scratchRepo()
  assert.equal(path.resolve(await repoRoot(repo)).toLowerCase(), repo.toLowerCase())
  assert.equal(await repoRoot(root), undefined)
  assert.equal(await currentBranch(repo), 'main')
})

test('an uncommitted plan is dirty until commitFile commits just that file', async () => {
  const { repo } = scratchRepo()
  fs.writeFileSync(path.join(repo, 'plan.md'), '# plan\n')
  fs.writeFileSync(path.join(repo, 'other.txt'), 'leave me\n')
  assert.equal(await isDirty(repo, path.join(repo, 'plan.md')), true)
  await commitFile(repo, path.join(repo, 'plan.md'), 'add plan')
  assert.equal(await isDirty(repo, path.join(repo, 'plan.md')), false)
  assert.match(sh(repo, 'status', '--porcelain'), /\?\? other\.txt/)
})

test('two plans in two worktrees both merge back into main', async () => {
  const { root, repo } = scratchRepo()
  const a = wtFor(root, 'a')
  const b = wtFor(root, 'b')
  assert.deepEqual(await ensureWorktree(repo, a), { created: true })
  assert.deepEqual(await ensureWorktree(repo, b), { created: true })
  // A second run of the same plan reuses its worktree.
  assert.deepEqual(await ensureWorktree(repo, a), { created: false })

  fs.writeFileSync(path.join(a.dir, 'a.txt'), 'from a\n')
  fs.writeFileSync(path.join(b.dir, 'b.txt'), 'from b\n')
  assert.equal(await commitAll(a.dir, 'a: T1'), true)
  assert.equal(await commitAll(a.dir, 'a: nothing'), false)
  assert.equal(await commitAll(b.dir, 'b: T1'), true)

  // Finishing together: the merges are serialized, not raced.
  const [ma, mb] = await Promise.all([mergeBranch(repo, a, 'merge a'), mergeBranch(repo, b, 'merge b')])
  assert.deepEqual(ma, { ok: true })
  assert.deepEqual(mb, { ok: true })
  assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'from a\n')
  assert.equal(fs.readFileSync(path.join(repo, 'b.txt'), 'utf8'), 'from b\n')

  assert.equal(await removeWorktree(repo, a), true)
  assert.equal(await removeWorktree(repo, b), true)
  assert.equal(fs.existsSync(a.dir), false)
  assert.equal(sh(repo, 'branch', '--list', 'plan-queue/*'), '')
})

test('a conflicting merge is aborted and the branch is kept', async () => {
  const { root, repo } = scratchRepo()
  const a = wtFor(root, 'a')
  await ensureWorktree(repo, a)
  fs.writeFileSync(path.join(a.dir, 'README.md'), 'plan says this\n')
  await commitAll(a.dir, 'a: T1')
  fs.writeFileSync(path.join(repo, 'README.md'), 'main says that\n')
  sh(repo, 'commit', '-q', '-am', 'main moved on')

  const m = await mergeBranch(repo, a, 'merge a')
  assert.equal(m.ok, false)
  assert.equal(m.reason, 'merge conflict')
  assert.equal(sh(repo, 'status', '--porcelain'), '')
  assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8'), 'main says that\n')
  assert.equal(sh(repo, 'branch', '--list', a.branch).replace('+', '').trim(), a.branch)
})

test('no merge when the main checkout has moved to another branch', async () => {
  const { root, repo } = scratchRepo()
  const a = wtFor(root, 'a')
  await ensureWorktree(repo, a)
  sh(repo, 'checkout', '-q', '-b', 'elsewhere')
  const m = await mergeBranch(repo, a, 'merge a')
  assert.equal(m.ok, false)
  assert.match(m.reason, /on elsewhere, not main/)
})

test('a worktree folder deleted by hand is recreated on its branch', async () => {
  const { root, repo } = scratchRepo()
  const a = wtFor(root, 'a')
  await ensureWorktree(repo, a)
  fs.writeFileSync(path.join(a.dir, 'a.txt'), 'kept\n')
  await commitAll(a.dir, 'a: T1')
  fs.rmSync(a.dir, { recursive: true, force: true })

  assert.deepEqual(await ensureWorktree(repo, a), { created: true })
  assert.equal(fs.readFileSync(path.join(a.dir, 'a.txt'), 'utf8'), 'kept\n')
})
