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
- **Stop** kills the running task and leaves it pending.
- **Message the running task** (the speech-bubble button in the view title, `cmd+alt+m` /
  `ctrl+alt+m`, or the command palette) types into the task already in flight —
  the same as interjecting in an interactive session. The task's stdin stays
  open for the whole run, so the message lands in the turn that is running, not
  after it. What you send is echoed into the log with a `>` prefix.

A task counts as done only when its final message ends with `PLAN_QUEUE: DONE`
— an appended system prompt asks for it. `PLAN_QUEUE: BLOCKED <reason>`, a
missing sentinel, or a non-zero exit all halt the queue with the reason on the
task. Turn that off with `planQueue.requireSentinel` if you would rather trust
the exit code alone.

`planQueue.gateCommand` runs after every task in the workspace root — e.g.
`ssh shanks "cd ~/projects/agentic-shop && pnpm test"` — and a non-zero exit
fails the task even when the model claimed success.

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

## Headless equivalent

`~/bin/plan-queue` is the same runner as a shell script, for a machine with no
editor open. The extension does not depend on it.
