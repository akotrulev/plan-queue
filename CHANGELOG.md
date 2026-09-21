# Changelog

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
