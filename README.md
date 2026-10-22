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
- **Dependencies**, optionally: a line `Depends on: T1, T2` inside the prompt
  (`**Depends on:** T1`, a bullet, `none` all work). See
  [Parallel tasks](#parallel-tasks-in-one-plan).

Verified against seven real plans of different vintages.

## Running

Each task is one `claude -p` invocation, so each gets a genuinely fresh context.

- **Run queue** starts at the first task that is not done or skipped.
- **Run from here** starts at the task you picked; **Run this task only** runs
  exactly one.
- **Stop** kills the running task and leaves it pending — in the view title it
  stops every running plan; on a plan, just that one. Each task (and each gate)
  runs in a process group of its own, so Stop also takes down what it started:
  a dev server, a test watcher. The same happens when a task ends normally.
- **Message the running task** (the speech-bubble button in the view title, `cmd+alt+m` /
  `ctrl+alt+m`, or the command palette) types into the task already in flight —
  the same as interjecting in an interactive session. The task's stdin stays
  open for the whole run, so the message lands in the turn that is running, not
  after it. What you send is echoed into the log with a `>` prefix.

An appended system prompt asks every task to end its final message with one
line of its own:

| Line | Means |
|---|---|
| `PLAN_QUEUE: DONE` | landed, and its gate passed — the task is done |
| `PLAN_QUEUE: BLOCKED <reason>` | it could not finish — the queue halts with the reason on the task |
| `PLAN_QUEUE: QUESTION` | the message above it is a question for you — [the task waits](#when-a-task-asks-you-something) |

A sentinel only counts on a line of its own (bold or backticks are fine), and
the last one wins, so a message that merely mentions `PLAN_QUEUE: DONE` is not
taken for it. Running out of turns or budget, or a non-zero exit, also halt the
queue.

A turn that ends with **no** sentinel — usually a task that finished and forgot
the line — is not left hanging: the queue resumes the session once and asks it
to say which it is. Only if that reply has no sentinel either does the task wait
for you. Turn sentinels off with `planQueue.requireSentinel` if you would rather
trust the exit code alone.

### Parallel tasks in one plan

A task with no `Depends on:` line waits for every task before it, so a plan
that never uses the line runs exactly as before: one task at a time, in order.
A task that declares `Depends on:` waits only for those tasks, and starts the
moment they are done — so tasks that share a dependency run together, up to
`planQueue.maxParallelTasks` (default 3) working at once:

```markdown
### T1 — the schema        (no line: first, alone)
### T2 — the API           > Depends on: T1
### T3 — the CLI           > Depends on: T1
### T4 — docs and close-out > Depends on: T2, T3
```

`Depends on: none` makes a task free to start immediately, beside the first.
Dependencies are re-read with the rest of the plan before every scheduling
decision. A dependency the plan does not have is noted in the log and ignored;
a line with no task ids in it is ignored too, so prose such as "Depends on: the
schema" cannot make a task start early.

- **They share the plan's working tree.** Give parallel tasks disjoint files.
  Each is told so, and told not to stash, reset, checkout or commit; the queue
  commits for them. Because a commit would otherwise sweep up a neighbour's
  half-written files, tasks that pass while another is still working wait, and
  are committed together when the last of them finishes (their ids all appear in
  the commit message).
- **Gates run one at a time**, so two never test the same half-edited tree.
- **A failure stops new starts** (with `stopOnFailure`); tasks already going are
  left to finish. A task that named the failed one as a dependency never starts.
- **A task waiting for your reply does not hold a slot**, though it still blocks
  everything that depends on it.
- **Run this task now** (right-click a task of a running plan) starts it
  alongside the others, ignoring its dependencies and the cap, after asking if
  it is not yet ready. The tasks already running keep going.
- Output from parallel tasks is tagged `[T2]` in the plan's log.

### When a task asks you something

A task that ends its turn with `PLAN_QUEUE: QUESTION` has stopped to ask a
person something (the appended system prompt tells it to do so only when it
genuinely cannot go on). So does one that ended with no sentinel and still gave
none when asked. Instead of failing, the task goes to **waiting for reply**:

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

`planQueue.gateCommand` (e.g. `pnpm test`) runs after every task in the task's
folder — the plan's worktree when it has one — and a non-zero exit fails the
task even when the model claimed success. A gate that runs longer than
`planQueue.gateTimeoutMinutes` (default 30) is killed and fails the task;
stopping the plan kills it too, and the task goes back to pending.

A failed gate is not the end of the task. Its output (the last 12 KB) is handed
back to the **same session** — which still has everything it learned doing the
work — with a request to fix the cause and run the gate itself. The gate then
runs again. `planQueue.gateRetries` (default 1) sets how many times; 0 fails the
task at once.

### Logs

Each plan has an output channel, **Plan Queue — <plan title>**. It shows what
the model says and, for each tool call, what it did — `$ pnpm test`,
`Edit src/cart.ts`, `Grep TODO in src` — plus `✗` and the first line of any tool
call that failed. Thinking is left out unless `planQueue.logThinking` is on.

Every run of a task also writes a **transcript** of its own: every turn, the
gate, the commit or the stash. *Show the log* on a task opens its latest one,
even after the window that ran it has closed. The last ten per task are kept, in
VS Code's storage for this workspace.

### When a command is denied

Anything not on `planQueue.allowedTools` is denied rather than waiting for a
prompt. The queue reads which calls were denied, logs them, and names the
allowlist entry that would have let each one through — `Bash(terraform:*)`
for a command, the tool's name otherwise. When the task did not finish, the
entries are on the task (*denied …*) and the error notification has an
**Allow** button; right-click the task for *Allow the tools this task was
denied*. They are added wherever `allowedTools` is set now; run the task again
to use them.

### Taking a task over by hand

Right-click a task for *Resume the task's session in a terminal*: it opens
`claude --resume <session>` in the task's folder (the plan's worktree when it
has one), with the whole context of the run. Finish it there, then mark the
task done (or reset it) so the queue moves on. Sessions are named
`plan-queue <plan> <task>`, so they are easy to tell apart in `claude --resume`.

## Parallel plans, in worktrees

With `planQueue.worktrees` on (the default) and the workspace in a git
repository, **each plan runs on a branch of its own in a worktree of its own**,
so you can start several plans at once. Tasks within a plan run one after
another unless they declare `Depends on:` (see above), since each normally
builds on the one before.

- The first run of a plan cuts `plan-queue/<plan>-<hash>` from the branch the
  workspace is on and checks it out under `planQueue.worktreeRoot` (default: a
  sibling folder, `<repo>.plan-queue/`). The plan has to be committed for its
  worktree to see it; if it is not, you are asked whether to commit just that file.
- `planQueue.worktreeSetupCommand` (e.g. `npm ci`) runs once in a new worktree,
  since it starts with only what is committed.
- Every task that passes — sentinel and gate — is committed on the plan's branch.
- A task that does not pass — blocked, gate failed, or stopped — may have left
  half its work in the tree. Once no other task of the plan is in the tree, it
  is **stashed** (`git stash`, untracked files included), so the next task and
  the next commit start from what passed. The log names the stash;
  `git stash apply <ref>` brings it back. Turn this off with
  `planQueue.stashFailedWork`. When a task fails while another is still working
  beside it, the two cannot be told apart: the next commit carries both, and
  its message says so.
- When every task is done or skipped, the branch is merged into the branch it
  was cut from with `--no-ff`, and the worktree and branch are removed. The
  merge happens in the main checkout, which has to still be on that branch;
  merges from plans finishing together are serialized.
- A task may move or rename its own plan in the worktree (filing it under
  `implemented/`, say); the queue follows it there and still merges.
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

## Driving it from Claude Code

Plan Queue can serve a small local endpoint so that something other than the
sidebar — Claude Code over MCP, or a shell — can list, start, watch, answer and
stop plans. It is **off by default**.

Run **Plan Queue: Connect Claude Code** from the command palette. It turns the
server on (`planQueue.server.enabled`), installs the `pq` command into
`~/.local/bin`, and registers the server with `claude mcp add` — for all your
projects or just this one, as you choose. New Claude Code sessions then have
these tools:

| Tool | Does |
|---|---|
| `list_plans` | plans, progress, which tasks are waiting or blocked |
| `plan_status` | every task: status, dependencies, cost, the question a waiting task asked |
| `run_plan` | start a plan (optionally `from_task`); returns at once |
| `run_task` | run one task; `now` starts it beside a running plan |
| `reply` | answer a waiting task |
| `message` | type into a task that is working |
| `get_log` | the last lines of the plan's log, or of one task's transcript |
| `stop` | stop one plan or all |

The same calls from a shell, which is also what an LLM with only a Bash tool
can use:

```
pq list
pq run storefront                # a path, file name or title; a fragment is enough
pq status storefront
pq reply storefront T3 use soft-delete
pq task storefront T5 --now
pq log storefront 120
pq log storefront T3             # that task's latest transcript
```

- It listens on `127.0.0.1` only, refuses requests that carry a browser
  `Origin`, and requires a bearer token. The token is kept in VS Code's secret
  storage and in `~/.plan-queue/server.json` (mode 0600), which `pq` reads.
- Anyone holding the token can start model calls and edits in this workspace.
  Treat `claude mcp add --scope user` accordingly: every Claude Code session you
  open will be able to do it.
- It serves the workspace of the window that started it. With several VS Code
  windows open, only the first gets the port (`planQueue.server.port`, default
  47321).
- Tasks the queue launches inherit your Claude Code MCP config, so they can see
  these tools too. A plan that is already running refuses to be started again,
  but a task should not start its own plan.
- Starting a plan whose file is not committed still raises the same
  confirmation box in VS Code, and waits for you.

## Permissions

Plan Queue does nothing in an **untrusted** workspace (VS Code's Workspace
Trust): a plan's prompts run with file edits and an allowlist of shell commands,
and `gateCommand`, `worktreeSetupCommand`, `claudePath` and `extraArgs` can come
from the folder's own `.vscode/settings.json`. Trust the folder first.

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
| `planQueue.gateTimeoutMinutes` | `30` | Kill a gate or setup command after this long; 0 is no limit |
| `planQueue.gateRetries` | `1` | Times a failed gate's output is handed back to the task to fix |
| `planQueue.stashFailedWork` | `true` | Stash what a task that did not pass left in its worktree |
| `planQueue.stopOnFailure` | `true` | Halt the queue on a failed task |
| `planQueue.requireSentinel` | `true` | Require `PLAN_QUEUE: DONE`; a missing one is asked about once |
| `planQueue.useAgentFromPlan` | `true` | Honour the heading's agent |
| `planQueue.extraArgs` | `[]` | Extra `claude` arguments |
| `planQueue.logThinking` | `false` | Include the model's thinking in the log |
| `planQueue.worktrees` | `true` | One worktree and branch per plan, so plans run in parallel |
| `planQueue.worktreeRoot` | — | Where worktrees go; empty is `<repo>.plan-queue/` beside the repo |
| `planQueue.worktreeSetupCommand` | — | Run once in a new worktree, e.g. `npm ci` |
| `planQueue.mergeWhenDone` | `true` | Merge the branch back when the plan is done |
| `planQueue.maxParallelTasks` | `3` | Tasks of one plan working at once; only `Depends on:` tasks ever overlap |
| `planQueue.server.enabled` | `false` | Serve the local MCP / `pq` endpoint |
| `planQueue.server.port` | `47321` | Its port |
