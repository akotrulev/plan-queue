# Plan Queue

A VS Code sidebar for the plans in `docs/plans/`: see every task, reorder them,
and run them through Claude Code one after another — **one fresh context window
per task**, unattended, stopping at the first failure.

It exists because the workflow it automates is otherwise manual: run a prompt,
wait, `/clear`, paste the next one.

## The three rules it is built around

1. **A prompt is living text.** The plan file is re-read from disk immediately
   before every task starts, never snapshotted when you press Run. A task that
   rewrites the prompts below it — because what landed differs from what the
   plan predicted — changes what actually runs next. A task whose prompt was
   rewritten after it ran is marked `prompt rewritten` in the tree.
2. **Order is yours, and it keys on the task id.** Drag to reorder, or use
   *Move up* / *Move down*. Because the order is a list of ids and not indexes,
   a task that rewrites the plan below it cannot scramble your ordering. *Restore
   the plan's own order* puts it back.
3. **Nothing is written into your repo.** Order, status, cost and duration live
   in VS Code's per-workspace storage on this machine. Plan files stay exactly as
   their author left them, and there is no state file to commit or gitignore.

## Install

Search **Plan Queue** in the Extensions view (`cmd+shift+X`), or:

```
code --install-extension akotrulev.plan-queue
```

Updates then arrive automatically wherever you have it installed.

### From source

```
git clone https://github.com/akotrulev/plan-queue ~/projects/plan-queue
cd ~/projects/plan-queue && npm install && npm run package
code --install-extension plan-queue.vsix
```

`npm run package` also typechecks and runs the parser tests.

### Releasing

`npm version patch && git push --follow-tags`. The release workflow publishes
to the Marketplace only when `package.json`'s version differs from what the
Marketplace already serves, so ordinary pushes to `main` just build and test.
It needs a `VSCE_PAT` repository secret; without one, a version bump fails at
the publish step and you can upload the vsix by hand instead.

## What it reads

Any file matching `planQueue.planGlob` (default `docs/plans/**/*.md`) that has a
`## Prompts` section. Inside it, one `###` heading per task:

```markdown
## Prompts — one per task

### T1 — the contract and the taxonomy (`tooling-engineer`, `ts`)

> Read the decisions doc, then write the schema.
>
> Gate: `pnpm build && pnpm test`.
```

- **The id** is the first token of the heading (`T1`, `A3`, `T6b`). A leading
  `Prompt ` or `Task ` is ignored. `### B1, C1, C2` names prompts nobody has
  written yet and is not listed.
- **The agent**, when the heading ends in `(`agent`, `stack`)`, is passed to
  `--agent` if this install has it. If it does not — the name is a plugin agent
  you have not installed — the role is named in the prompt instead, so the task
  still runs. Any other trailing parenthetical is treated as part of the title.
- **The prompt** is the blockquote under the heading, or a fenced code block.
  A heading with neither is a placeholder, not a task.

Verified against seven real plans of different vintages.

## Running

Each task is one `claude -p` invocation, so each gets a genuinely fresh context.

- **Run queue** starts at the first task that is not done or skipped.
- **Run from here** starts at the task you picked; **Run this task only** runs
  exactly one.
- **Stop** kills the running task and leaves it pending — in the view title it
  stops every running plan; on a plan, just that one.
- **Message the running task** (the speech-bubble button in the view title, `cmd+alt+m` /
  `ctrl+alt+m`, or the command palette) types into the task already in flight —
  the same as interjecting in an interactive session. The task's stdin stays
  open for the whole run, so the message lands in the turn that is running, not
  after it. What you send is echoed into the log with a `>` prefix.

A task counts as done only when its final message ends with `PLAN_QUEUE: DONE`
— an appended system prompt asks for it. `PLAN_QUEUE: BLOCKED <reason>`, running
out of turns or budget, or a non-zero exit all halt the queue with the reason on
the task. Turn the sentinel off with `planQueue.requireSentinel` if you would
rather trust the exit code alone.

### When a task asks you something

A task that ends its turn with **neither** sentinel has stopped to ask a person
something (the appended system prompt tells it to, and to do so only when it
genuinely cannot go on). Instead of failing, the task goes to **waiting for
reply**:

- It turns yellow in the tree, its question is in the tooltip and at the end of
  the log, and a notification shows the gist with a **Reply** button.
- Only that plan pauses. Other plans keep running, and the plan's worktree stays
  as it is.
- Answer with **Reply** (the notification, the task's inline button, or
  right-click), or with **Message the running task** / `ctrl+alt+m`, which
  offers the reply box when the task is waiting. The answer resumes the same
  session (`claude -p --resume <session>`) in the same folder, so the agent keeps
  its full context. The task is then judged as usual (sentinel, gate, commit),
  and the plan carries on.
- Stopping the plan, or closing the window, leaves the task waiting. Reply to
  it later and the plan starts again from that task.
- Cost and duration add up across the turns of a task.

With `planQueue.requireSentinel` off, a turn that ends cleanly is done, so a
task cannot wait for a reply.

`planQueue.gateCommand` runs after every task in the task's folder (the plan's worktree when it has one) — e.g.
`ssh shanks "cd ~/projects/agentic-shop && pnpm test"` — and a non-zero exit
fails the task even when the model claimed success.

## Parallel plans, in worktrees

With `planQueue.worktrees` on (the default) and the workspace in a git
repository, **each plan runs on a branch of its own in a worktree of its own**,
so you can start several plans at once. Tasks within a plan still run one after
another, since each builds on the one before.

- The first run of a plan cuts `plan-queue/<plan>-<hash>` from the branch the
  workspace is on and checks it out under `planQueue.worktreeRoot` (default: a
  sibling folder, `<repo>.plan-queue/`). The plan has to be committed for its
  worktree to see it; if it is not, you are asked whether to commit just that file.
- `planQueue.worktreeSetupCommand` (e.g. `npm ci`) runs once in a new worktree,
  since it starts with only what is committed.
- Every task that passes — sentinel and gate — is committed on the plan's branch.
- When every task is done or skipped, the branch is merged into the branch it
  was cut from with `--no-ff`, and the worktree and branch are removed. The
  merge happens in the main checkout, which has to still be on that branch;
  merges from plans finishing together are serialized.
- A conflict (or the checkout having moved) aborts the merge and keeps the
  branch and worktree. Resolve it and run the plan again: with nothing left to
  run it retries the merge. `planQueue.mergeWhenDone` off leaves the branch for
  you to merge or open a PR from.
- A stopped or failed plan keeps its worktree, and the next run resumes there.
  While it has one, the tree, *Open the prompt* and the task runs all use the
  plan's copy in the worktree, since that is where tasks rewrite it.
- Right-click a plan for *Stop this plan*, *Open the plan's worktree in a new
  window*, or *Discard the plan's worktree and branch*. Each plan logs to its
  own output channel, **Plan Queue — <plan title>**.

With worktrees off, or outside a git repository, a plan runs in the workspace
itself and only one such plan runs at a time.

## Permissions

The default is `--permission-mode acceptEdits` with `--permission-prompts none`
and an allowlist (`planQueue.allowedTools`). File edits are accepted, allowlisted
commands run, and **anything else is denied outright rather than waiting** — so
an unattended task fails loudly instead of sitting on a prompt nobody will
answer. Widen the allowlist when a plan needs a command it does not cover;
`bypassPermissions` is available in the setting if you want it.

## It spends money

Every task is a real model call. `planQueue.budgetUsd` sets a per-task
`--max-budget-usd` ceiling; the tree shows what each task cost.

## Settings

| Setting | Default | Does |
|---|---|---|
| `planQueue.planGlob` | `docs/plans/**/*.md` | Which files to list |
| `planQueue.claudePath` | `claude` | Path to the CLI |
| `planQueue.model` | — | `--model` for every task |
| `planQueue.permissionMode` | `acceptEdits` | `--permission-mode` |
| `planQueue.allowedTools` | a working set | Commands allowed without a prompt |
| `planQueue.budgetUsd` | `0` | Per-task `--max-budget-usd`; 0 is no ceiling |
| `planQueue.gateCommand` | — | Shell check after each task |
| `planQueue.stopOnFailure` | `true` | Halt the queue on a failed task |
| `planQueue.requireSentinel` | `true` | Require `PLAN_QUEUE: DONE` |
| `planQueue.useAgentFromPlan` | `true` | Honour the heading's agent |
| `planQueue.extraArgs` | `[]` | Extra `claude` arguments |
| `planQueue.worktrees` | `true` | One worktree and branch per plan, so plans run in parallel |
| `planQueue.worktreeRoot` | — | Where worktrees go; empty is `<repo>.plan-queue/` beside the repo |
| `planQueue.worktreeSetupCommand` | — | Run once in a new worktree, e.g. `npm ci` |
| `planQueue.mergeWhenDone` | `true` | Merge the branch back when the plan is done |

## Headless equivalent

`~/bin/plan-queue` is the same runner as a shell script, for a machine with no
editor open. The extension does not depend on it.
