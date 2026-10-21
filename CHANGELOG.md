# Changelog

## Unreleased

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
