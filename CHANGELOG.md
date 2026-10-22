# Changelog

## 0.3.1

- **A plan that moves itself still merges.** A task may move or rename its own
  plan inside the worktree — a close-out filing it under `implemented/`. The
  queue now follows it (same name under the plan's folder, or a rename git
  detects) instead of failing on the old path and never merging. A plan that
  was deleted rather than moved stops with that said in the log.
- A plan that fails outside a task now writes the reason to its log, not only
  to a notification.

## 0.3.0

- **Parallel tasks in one plan.** A task that declares `Depends on: T1, T2` in
  its prompt starts as soon as those are done, so tasks sharing a dependency run
  together (`planQueue.maxParallelTasks`, default 3). Plans without such lines
  run one task at a time, as before. Tasks share the plan's working tree; passing
  tasks are committed together once none is still working, and gates run one at
  a time.
- *Run this task now* starts a task alongside a running plan, ignoring
  dependencies and the cap.
- A task waiting for a reply no longer holds a slot, and each waiting task of a
  plan is answered separately. *Message the running task* now asks which task
  when several are going.
- **Control from Claude Code.** An opt-in local endpoint
  (`planQueue.server.enabled`, command *Connect Claude Code*) exposes MCP tools
  — `list_plans`, `plan_status`, `run_plan`, `run_task`, `reply`, `message`,
  `get_log`, `stop` — and a `pq` shell command that calls the same endpoint.
- A fenced code block in a prompt that contains `##` or `###` lines no longer
  cuts the prompt short or drops the tasks after it.
- Plan Queue is disabled in untrusted and virtual workspaces.
- **A failed gate goes back to the task.** Its output is handed to the same
  session to fix, then the gate runs again (`planQueue.gateRetries`, default 1).
- **Denied commands are named.** The log, the task and the error notification
  show the allowlist entry each denied call needed (`Bash(terraform:*)`), with
  an **Allow** button and a task action that adds them.
- **Resume a task's session in a terminal** — `claude --resume` in the task's
  folder — to finish it by hand. Sessions are named `plan-queue <plan> <task>`.
- **Better logs.** Tool calls show what they ran or touched (`$ pnpm test`,
  `Edit src/a.ts`), failed tool calls are marked `✗`, thinking is left out
  (`planQueue.logThinking`), and long lines break at a space.
- **Task transcripts.** Each run of a task is written to a file of its own;
  *Show the log* on a task opens it, and `get_log` / `pq log <plan> <task>` read
  it, after the window has closed.
- **A forgotten sentinel no longer stalls a plan.** A turn that ends with no
  `PLAN_QUEUE:` line is asked once, in the same session, whether it is done,
  blocked or asking; only a second silence waits for a person. Tasks now mark a
  question with `PLAN_QUEUE: QUESTION`.
- Sentinels only count on a line of their own, and the last one wins, so a
  message that mentions one is not mistaken for it.
- **Stop takes down the whole task.** Tasks and gates run in their own process
  group; stopping one, or its ending, also stops the servers and watchers it
  started.
- `planQueue.gateTimeoutMinutes` (default 30) kills a hung gate or worktree
  setup command; Stop kills a running gate.
- **What a failed task leaves behind is stashed** in the plan's worktree, so it
  no longer rides into the next task's commit (`planQueue.stashFailedWork`).
- The cost of a stopped turn is kept.
- A trailing `(wip)` or `(optional)` in a task heading stays in the title
  instead of being taken for an agent.
- A task id used by two headings is flagged on the plan; only the first runs.
- The tree follows edits to a plan's copy in its worktree, and refreshes once
  per burst of saves.
- Packaging no longer ships the test builds in `out/`.

## 0.2.0

- **Parallel plans.** Each plan runs on its own branch in its own git worktree
  (`planQueue.worktrees`, on by default), so several plans can run at once.
  Each passing task is committed there; when the plan is done the branch is
  merged `--no-ff` into the branch it was cut from and the worktree removed. A
  conflict aborts the merge and keeps the branch for you.
- New settings `planQueue.worktreeRoot`, `planQueue.worktreeSetupCommand` and
  `planQueue.mergeWhenDone`.
- New plan actions: *Stop this plan*, *Open the plan's worktree*, *Discard the
  plan's worktree and branch*. Each plan logs to its own output channel.
- **Answer a task's question.** A task that ends its turn with neither sentinel
  now waits for a reply instead of failing. Only its plan pauses; *Reply to the
  task* (or *Message the running task*) resumes the same session with your
  answer. A waiting task survives a stop or a window reload.
- Running out of turns or budget is now reported as that, not as a missing
  sentinel.
- *Run this task only* now finds its task wherever it sits in the order.

## 0.1.0

First public release.

- A sidebar listing every plan under `planQueue.planGlob` and every task in its
  `## Prompts` section, with per-task status, cost and duration.
- Run the whole queue, run from a task, or run one task — each as its own
  `claude -p` invocation, so each gets a fresh context window.
- The plan file is re-read from disk before every task, so a task that rewrites
  the prompts below it changes what actually runs next.
- Reorder by drag, or *Move up* / *Move down*; ordering keys on task id and
  survives a rewritten plan.
- **Message the running task** — interject into the turn already in flight,
  from the view title, `cmd+alt+m` / `ctrl+alt+m`, or the command palette.
- `planQueue.gateCommand` runs after each task and fails it on a non-zero exit,
  whatever the model claimed.
