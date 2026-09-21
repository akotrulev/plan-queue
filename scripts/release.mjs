// Prepares a release for the hand-upload path: bumps the version, builds a
// vsix, then opens both things the upload needs — the file in a file manager
// and the publisher page in a browser — so shipping is one drag.
//
//   npm run release            # patch
//   npm run release -- minor   # or major, or an exact version
//
// It stops short of pushing. Review, then `git push --follow-tags`.
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'

const bump = process.argv[2] ?? 'patch'
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' })
const version = () => JSON.parse(readFileSync('package.json', 'utf8')).version

const dirty = execFileSync('git', ['status', '--porcelain']).toString().trim()
if (dirty) {
  console.error('Working tree is not clean — commit or stash first:\n' + dirty)
  process.exit(1)
}

console.log(`\n${version()} -> bumping (${bump})`)
run('npm', ['version', bump, '-m', 'release: v%s'])
const v = version()

run('npm', ['run', 'package'])

const open = process.platform === 'darwin' ? 'open' : 'xdg-open'
try {
  run(open, process.platform === 'darwin' ? ['-R', 'plan-queue.vsix'] : ['.'])
  run(open, ['https://marketplace.visualstudio.com/manage/publishers/akotrulev'])
} catch {
  // A headless machine has no browser; the paths below are enough.
}

console.log(`
v${v} is packaged.

  1. On the publisher page, open the Plan Queue row's "..." menu and choose
     Update — not "New extension", which errors once an extension exists.
  2. Drop plan-queue.vsix in.
  3. git push --follow-tags

The Marketplace refuses a version it already serves, which is why this bumped
first. CI publishes this automatically instead, once a VSCE_PAT secret exists.
`)
