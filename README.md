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

Each task is one Claude Code **background session** (`claude --bg`), so each
gets a genuinely fresh context, and each is the real interactive Claude Code:
you can open it in a terminal, watch it work, answer its prompts and type into
it, while the queue drives it — starts it with the task's prompt, judges how its
turn ended, follows up, and stops it.

- **A tab per task, when it matters.** A task's session opens as an editor tab
  beside your files — as the Claude Code extension opens a session — named
  after the task (`T3 · Orders API`) and running `claude attach <session>`: the
  full Claude Code UI on that session. By default a tab opens only when the
  task **asks you something**, when it **fails or is blocked**, or when **you
  click it**. Tabs the queue opens open **behind** the one you are on: the
  session you are reading or typing into stays in view. A task that needs you
  also says so in the tree, the status bar and a notification.
- **Clicking a task** brings its tab forward when it has one open, opens its
  session when it has one (running, waiting, blocked or failed), and otherwise
  opens its prompt in the plan — which the task's inline button does for every
  task.
- **When a task passes**, its session is stopped and its tab closes. **When one
  fails or is blocked**, its tab stays and attaches again — which wakes the
  stopped session — so the whole conversation is there to review in Claude
  Code itself; closing the tab stops the session again, and so does running the
  task again. While a session is stopped mid-plan (paused, or between the
  queue's follow-ups) its tab shows the task's transcript, and re-attaches by
  itself when the queue resumes it. Closing a running task's tab leaves its
  session running.
- `planQueue.sessionTerminals` chooses when tabs open by themselves:
  `whenNeeded` (default), `onStart` (every task as it starts) or `never`.
  `planQueue.sessionTerminalLocation` puts them in the terminal panel instead
  of the editor.
- The queue watches the session through `claude agents --json` and reads its
  transcript, so the plan's log still shows what it says and the tools it calls.

- **Run queue** starts at the first task that is not done or skipped.
- **Run from here** starts at the task you picked; **Run this task only** runs
  exactly one.
- **Stop** stops the task's session (`claude stop`) and leaves the task
  pending — in the view title it stops every running plan; on a plan, just that
  one. A gate runs in a process group of its own, so Stop also takes down what
  it started: a dev server, a test watcher.
- **Pause** (the pause button on a running task, on a plan, or in the view
  title for every plan) interrupts the task but keeps its session: the task
  goes to `paused`, and its changes stay in the tree. See
  [Pausing and resuming](#pausing-and-resuming).
- **Open a running task's session** (the speech-bubble button in the view
  title, `cmd+alt+m` / `ctrl+alt+m`, or the command palette) opens the session
  of the task in flight — pick one when several are running — so you can
  interject by typing into it. What you type shows in the log with a `>` prefix.

An appended system prompt asks every task to end its final message with one
line of its own:

| Line | Means |
|---|---|
| `PLAN_QUEUE: DONE` | its work landed — the task is done (a test it believes wrong is written down, not a reason to stop) |
| `PLAN_QUEUE: BLOCKED <reason>` | the work cannot go on at all (merge conflict, missing dependency or credential), never just a red test — the queue halts with the reason on the task |
| `PLAN_QUEUE: QUESTION` | the message above it is a question for you — [the task waits](#when-a-task-asks-you-something) |

A sentinel only counts on a line of its own (bold or backticks are fine), and
the last one wins, so a message that merely mentions `PLAN_QUEUE: DONE` is not
taken for it. A turn that ends on an API error the session could not get past
also halts the queue. Two failures do not: a [usage limit](#when-the-usage-limit-is-hit) pauses
the task, and a [temporary API error](#when-the-usage-limit-is-hit) is retried
first.

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
  the log, and a notification shows the gist with an **Open session** button.
- Only that task waits. Other tasks and plans keep running, and the plan's
  worktree stays as it is.
- Its session stays up. **Answer by typing into it** — the task's terminal, or
  **Reply** (the notification, the task's inline button, right-click, or
  `ctrl+alt+m`), which opens it. The queue sees the session carry on, follows
  the new turn, and judges it as usual (sentinel, gate, commit); the plan
  carries on.
- An answer can also come from outside the session — `pq reply`, the MCP
  `reply` tool, or the reply box, which *Reply* offers when the session is no
  longer running. The queue then stops the session and resumes it in the
  background with the answer (`claude --bg --resume <session>`), so the agent
  keeps its full context.
- Stopping the plan, or closing the window, leaves the task waiting, and its
  session up. Answer it later and the plan starts again from that task.

A task that needs you asks with Claude Code's own question picker
(`AskUserQuestion`), offering the likely answers as options — the appended
system prompt tells it to, and keeps `PLAN_QUEUE: QUESTION` for when that tool
is not there. The session stops **mid-turn** on it, as it does on a permission
prompt for a command that is not on the allowlist. The task shows as
`waiting · needs you in its session`, with the question and its options in the
tooltip and the notification; open its tab (a click on the task, or the
notification), pick an option (or type your own), and the task goes back to
working.
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

### Pausing and resuming

*Pause* stops the task's session (`claude stop`) and keeps its conversation. A
paused task is orange in the tree, and its plan shows `paused T3`.

- **Resume** (the task's inline button, or right-click) carries on in the same
  session (`claude --bg --resume <session>`), told it was paused and to check
  anything that was cut off — a test run, say — before relying on it. Running
  the plan again does the same: a paused task always resumes its session rather
  than starting over.
- Pausing a plan pauses all its working tasks and starts nothing new. Pausing
  one task leaves the rest of the plan running, but tasks that wait for it — by
  order or by `Depends on:` — keep waiting.
- A task paused mid-gate resumes its session to finish, and the gate runs again.
- **Closing the window pauses.** The session id is saved the moment a task's
  session starts, so a task cut off by VS Code closing — or crashing — is
  `paused` when the window opens again, not `pending`. Run or resume the plan
  to pick it up. Nothing is resumed automatically unless you turn on
  `planQueue.resumeOnOpen`: then every plan with a task the window closing
  paused starts again a few seconds after the window opens, and those tasks
  resume their sessions. Tasks you paused by hand stay paused.
- A paused task's changes stay in the worktree, and are not stashed if another
  task fails. A task that passes beside it is committed with them in it.
- A task waiting for your reply is not paused; it stays waiting.
- A session that ends mid-turn by itself — `/exit` typed into it, or
  `claude stop` from a shell — leaves its task paused, to resume the same way.

### When the usage limit is hit

When Claude Code reaches your account's 5-hour or weekly limit, the queue does
not fail the task. It pauses it, and carries on by itself once the limit resets.

- The task goes to `paused` with `usage limit (five_hour) · resumes 03:02`. Its
  session and its changes are kept, nothing is stashed, and the plan is not
  halted. No error is shown.
- The reset time comes from the message the session ended its turn on (`resets 3am`, `resets 15:30`, `resets Nov 21, 10am (Europe/Sofia)`;
  the zone in parentheses is honoured, local time is used without one). If there
  is no time, the queue waits 30 minutes for a 5-hour limit and 6 hours for a
  weekly one, and looks again.
- The limit belongs to the account, so it is shared. While it is on, no plan
  starts a new task until the reset plus `planQueue.limitResumeDelaySeconds`
  (120), and the status bar shows `usage limit until 03:02`. Tasks you start by
  hand with *Run now* still go.
- Running or resuming a plan during the limit does not start it. It says when
  it will, and starts then.
- After that, every plan with a limit-paused task, or one you tried to start, is
  taken up again. Only the paused tasks resume, in their own sessions, plus
  whatever is ready; a `blocked` or `failed` task is not run again, and if one
  stopped the plan, nothing else starts. Plans already running are woken to
  start what the limit held back. If the limit comes back, tasks pause again.
  The same happens when a window is opened after the reset. A plan that is
  mid-stop, or a task still pausing, is tried once more a few seconds later;
  otherwise the reason is written to the plan's log.
- **Stop** and **Pause** drop all of this for the plan, even when they land
  just as the limit cuts the turn off: its limit-paused tasks become ordinary
  paused tasks, it is not started at the reset, and only you resume them.
  Pausing one limit-paused task does the same for that task.
- Turn it off with `planQueue.resumeAfterLimit`. Tasks still pause, and nothing
  new starts while the limit is on, but you resume them yourself.
- `planQueue.limitStartThreshold` no longer applies: background sessions do
  not report how full a usage window is.

A turn cut off by a temporary API error (overloaded, a 5xx, a dropped
connection; never a 4xx such as a prompt that is too long or a bad key) is
retried in the same session: after 1 minute, then after 5. Set
the number of retries with `planQueue.transientRetries` (2). Stop and Pause end
the wait. Only when the retries are used up does the task fail as usual.

### Logs

Each plan has an output channel, **Plan Queue — <plan title>**, which does not
pop up while the tasks' own tabs are there (*Show the log* opens it). It shows what
the model says and, for each tool call, what it did — `$ pnpm test`,
`Edit src/cart.ts`, `Grep TODO in src` — plus `✗` and the first line of any tool
call that failed. Thinking is left out unless `planQueue.logThinking` is on.

Every run of a task also writes a **transcript** of its own: every turn, the
gate, the commit or the stash. *Show the log* on a task opens its latest one,
even after the window that ran it has closed. The last ten per task are kept, in
VS Code's storage for this workspace.

### When a command needs permission

Anything not on `planQueue.allowedTools` (and not covered by the permission
mode) asks in the task's session, as Claude Code always does. The task shows as
waiting until you answer in its terminal; nothing else is held up. To let a
command through without asking next time, add it to the allowlist — or answer
the prompt with Claude Code's own "don't ask again", which it saves in the
project's settings.

### Taking a task over by hand

Right-click a task for *Resume the task's session in a terminal*: it opens
`claude --resume <session>` in the task's folder (the plan's worktree when it
has one), with the whole context of the run. Finish it there, then mark the
task done (or reset it) so the queue moves on. Sessions are named
`plan-queue <plan> <task>`, so they are easy to tell apart in `claude --resume`.

## Parallel plans, in worktrees

With the workspace in a git repository, **each plan runs on a branch of its
own in a worktree of its own**, so you can start several plans at once.
`planQueue.worktrees` has to stay on there: a Claude Code background session
that edits a checkout first moves itself into a worktree of its own, so a task
run in the workspace itself would not change it. Outside a git repository,
plans run in the workspace, one at a time. Tasks within a plan run one after
another unless they declare `Depends on:` (see above), since each normally
builds on the one before.

- The first run of a plan cuts `plan-queue/<plan>-<hash>` from the branch the
  workspace is on and checks it out under `planQueue.worktreeRoot` (default:
  `<repo>/.claude/worktrees/plan-queue-<plan>-<hash>`). Under
  `.claude/worktrees/`, Claude Code counts a session as isolated already, so the
  task edits the plan's worktree itself; the folder is also trusted along with
  the repository, and kept out of `git status` through `.git/info/exclude`. A
  root elsewhere works, but each task's edits then land in a worktree Claude
  Code makes for it. The plan has to be committed for its worktree to see it;
  if it is not, you are asked whether to commit just that file.
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

### One plan after another

A plan that must wait for another says so above its prompts:

```markdown
# 157 — Adviser cost on Sonnet

**Runs after:** 156
```

When plan 156's branch merges, every plan whose `Runs after:` names it starts
by itself, cut from the branch that now holds 156. A chain is each plan naming
the one before it: 157 after 156, 158 after 157.

- A name is the plan's file name without `.md`, or its start up to a hyphen:
  `156` names `156-next-step-and-card-answers.md`; `15` does not.
- Several names (`156, 157 and 158`) wait for the last of them: the plan starts
  when the final one merges and the rest have nothing left to run.
- Only the leading list is read. `159 (the whole plan), which itself runs after
  156` names 159 alone. The colon is required, so a sentence starting "Runs
  after the …" is prose.
- It starts only after a real merge, so it needs `planQueue.worktrees` and
  `planQueue.mergeWhenDone`. A failed or conflicting merge starts nothing.
- A plan that is already running, has nothing left, or already has a worktree
  (cut before the merge, so without it) is not started; the finished plan's log
  says why. So is one naming a plan that does not exist.
- Starting a plan by hand ignores the line. The tree shows it as `after 156`.
- Turn it off with `planQueue.startPlansAfterMerge`.

### Running unattended: the backlog

The backlog is an ordered list of plans for Plan Queue to run by itself — for
the hours you are asleep or away, when your usage windows would otherwise go
unused. VS Code has to stay open.

- Right-click a plan for **Add to the backlog**, **Remove from the backlog**,
  **Move up in the backlog** or **Move down in the backlog**. The tree shows
  `backlog #2` in the plan's description. **Plan Queue: Show the backlog** in
  the command palette lists it in order.
- The list is kept per workspace, on this machine, like the rest of the state.

A **sweep** looks at the backlog and starts what it can. It runs when a plan
finishes, when a [usage limit](#when-the-usage-limit-is-hit) lifts, a few
seconds after the window opens, and every `planQueue.backlog.sweepMinutes`
(default 5; 0 turns the interval off). A sweep goes through the backlog in
order:

- **While a usage limit is on, it does nothing.** The sweep after the reset
  starts the plans, after the plans the limit paused have been resumed.
- It starts plans until `planQueue.backlog.maxPlans` (default 1) backlog plans
  are running. A backlog plan you started by hand counts.
- It skips a plan that is already running.
- It skips a plan that has nothing left to run. When every task is done or
  skipped, the plan is taken off the backlog; with worktrees, only once it has
  merged (no worktree left).
- It skips a plan that is **stuck**: a task is `blocked`, `failed`, or
  `waiting` for a reply, or paused. You are told once for each stuck state, and
  the log says so too (**Plan Queue — backlog**). Fix the task and the next
  sweep takes the plan up again. A task paused by the usage limit is not stuck.
  A task paused by the window closing is not stuck while `resumeOnOpen` is on.
  Any other paused task is, because nothing would resume it.
- It skips a plan whose `Runs after:` names a plan that still has tasks left or
  is running, or names no plan. See [One plan after another](#one-plan-after-another).
- It skips a plan whose file has uncommitted changes. Starting it would ask you
  to commit it and wait, so it says so in the log and in a notice instead.
- **A plan you stopped is not started again.** Stop, or pausing a plan or a
  task, keeps that plan out of the sweeps until you start it, resume it, or add
  it to the backlog again. This is remembered while the window is open; a
  restart forgets it, and a stopped plan with pending tasks then runs again.
- The scheduler does not start the same plan twice within 5 minutes, so a plan
  that fails to get going is not retried in a loop.

Plans start through the same path as **Run queue**, so worktrees, the setup
command and the gate behave as always. `planQueue.backlog.enabled` turns the
scheduler off; an empty backlog does nothing anyway.

**Resume on open.** With `planQueue.resumeOnOpen` on (default off), a plan with
a task that the window closing paused is resumed once, shortly after the window
opens, with or without the backlog. Tasks paused by hand are left alone. Tasks
paused by a usage limit are not touched either: the limit timer resumes them,
and a plan that is already running is never started twice. If the limit is
still on when the window opens, the plan starts at the reset.

Together: put the plans on the backlog, leave the window open, and each
usage-limit stop becomes a pause that lifts by itself, followed by the next
plan in line.

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
| `list_plans` | plans, progress, which tasks are waiting or blocked, backlog position |
| `plan_status` | every task: status, dependencies, cost, the question a waiting task asked |
| `run_plan` | start a plan (optionally `from_task`); returns at once |
| `run_task` | run one task; `now` starts it beside a running plan |
| `reply` | answer a waiting task |
| `message` | answer a waiting task; a working one takes messages only in its session |
| `get_log` | the last lines of the plan's log, or of one task's transcript |
| `stop` | stop one plan or all |
| `pause` | pause a task, a plan, or all, keeping each session |
| `resume` | carry on after a pause, in the same session |
| `backlog_list` | the backlog in order, with progress and what is stuck |
| `backlog_add` | put a plan on the backlog, at the end or at a position |
| `backlog_remove` | take a plan off the backlog |

The same calls from a shell, which is also what an LLM with only a Bash tool
can use:

```
pq list
pq run storefront                # a path, file name or title; a fragment is enough
pq status storefront
pq reply storefront T3 use soft-delete
pq pause storefront T3           # or the whole plan: pq pause storefront
pq resume storefront T3
pq task storefront T5 --now
pq log storefront 120
pq log storefront T3             # that task's latest transcript
pq backlog                       # the backlog, in order
pq backlog add storefront 1      # first in line; omit the position for the end
pq backlog remove storefront
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

The default is `--permission-mode acceptEdits` with an allowlist
(`planQueue.allowedTools`). File edits are accepted, allowlisted commands run,
and **anything else asks in the task's session** — the task waits until you
answer there. For a backlog that runs overnight, widen the allowlist so nothing
waits on you, or use `auto` or `bypassPermissions` in the setting.

## It spends money

Every task is a real model call; the tree shows what each task cost, read
from the session's own accounting when its turn is done. There is no per-task
ceiling: `--max-budget-usd` works only with `claude -p`, so
`planQueue.budgetUsd` no longer applies.

## Settings

| Setting | Default | Does |
|---|---|---|
| `planQueue.planGlob` | `docs/plans/**/*.md` | Which files to list |
| `planQueue.claudePath` | `claude` | Path to the CLI |
| `planQueue.model` | — | `--model` for every task |
| `planQueue.permissionMode` | `acceptEdits` | `--permission-mode` each session starts with |
| `planQueue.sessionTerminals` | `whenNeeded` | When a task's tab opens by itself: `whenNeeded` (a question or a failure), `onStart`, `never` |
| `planQueue.sessionTerminalLocation` | `editor` | Where it opens: an editor tab, or the terminal `panel` |
| `planQueue.allowedTools` | a working set | Commands allowed without a prompt |
| `planQueue.gateCommand` | — | Shell check after each task |
| `planQueue.gateTimeoutMinutes` | `30` | Kill a gate or setup command after this long; 0 is no limit |
| `planQueue.gateRetries` | `1` | Times a failed gate's output is handed back to the task to fix |
| `planQueue.stashFailedWork` | `true` | Stash what a task that did not pass left in its worktree |
| `planQueue.resumeAfterLimit` | `true` | Pause tasks at the usage limit and carry on after the reset |
| `planQueue.limitResumeDelaySeconds` | `120` | Wait this long after the reset before resuming |
| `planQueue.resumeOnOpen` | `false` | When the window opens, resume plans whose tasks the window closing paused |
| `planQueue.backlog.enabled` | `true` | Start the plans on the backlog by itself |
| `planQueue.backlog.maxPlans` | `1` | Backlog plans running at once |
| `planQueue.backlog.sweepMinutes` | `5` | How often the backlog looks for a plan to start; 0 is off |
| `planQueue.transientRetries` | `2` | Retries (after 1 min, then 5) of a turn cut off by an API error |
| `planQueue.stopOnFailure` | `true` | Halt the queue on a failed task |
| `planQueue.requireSentinel` | `true` | Require `PLAN_QUEUE: DONE`; a missing one is asked about once |
| `planQueue.useAgentFromPlan` | `true` | Honour the heading's agent |
| `planQueue.extraArgs` | `[]` | Extra arguments for the `claude --bg` that starts each session |
| `planQueue.logThinking` | `false` | Include the model's thinking in the log |
| `planQueue.worktrees` | `true` | One worktree and branch per plan, so plans run in parallel; required in a git repository |
| `planQueue.worktreeRoot` | — | Where worktrees go; empty is `<repo>/.claude/worktrees/` |
| `planQueue.worktreeSetupCommand` | — | Run once in a new worktree, e.g. `npm ci` |
| `planQueue.mergeWhenDone` | `true` | Merge the branch back when the plan is done |
| `planQueue.startPlansAfterMerge` | `true` | Start the plans whose `Runs after:` names a plan that just merged |
| `planQueue.maxParallelTasks` | `3` | Tasks of one plan working at once; only `Depends on:` tasks ever overlap |
| `planQueue.server.enabled` | `false` | Serve the local MCP / `pq` endpoint |
| `planQueue.server.port` | `47321` | Its port |
