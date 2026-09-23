import * as vscode from 'vscode'
import { readPlan } from './plan'
import { Queue } from './queue'
import { composePrompt, readConfig } from './runner'
import { StateStore } from './state'
import { PlanTree, type Node, type TaskNode } from './tree'

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const state = new StateStore(context.workspaceState)
  await state.clearRunning()

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  status.command = 'planQueue.showLog'

  const tree = new PlanTree(state)
  const view = vscode.window.createTreeView('planQueue.tasks', {
    treeDataProvider: tree,
    dragAndDropController: tree,
    canSelectMany: true,
    showCollapseAll: true,
  })

  const queue = new Queue(state, tree, status)
  tree.isRunning = (planPath) => queue.isRunning(planPath)
  await vscode.commands.executeCommand('setContext', 'planQueue.running', false)

  // A plan edited by hand — or rewritten by the task before this one — shows up
  // in the tree without a manual refresh.
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.md')
  const onChange = (uri: vscode.Uri) => {
    if (tree.findPlan(uri.fsPath) || uri.fsPath.includes('/plans/')) tree.refresh()
  }
  watcher.onDidChange(onChange)
  watcher.onDidCreate(onChange)
  watcher.onDidDelete(onChange)

  /** The plan a command applies to: the node's, or the only one, or asked for. */
  const resolvePlanPath = async (node?: Node): Promise<string | undefined> => {
    if (node) return node.plan.path
    const plans = tree.loaded.length ? tree.loaded : await tree.getChildren().then(() => tree.loaded)
    if (plans.length === 1) return plans[0].path
    const pick = await vscode.window.showQuickPick(
      plans.map((p) => ({ label: p.title, description: vscode.workspace.asRelativePath(p.path), path: p.path })),
      { placeHolder: 'Which plan?' },
    )
    return pick?.path
  }

  const asTask = (node?: Node): TaskNode | undefined =>
    node && node.kind === 'task' ? node : undefined

  const reorder = async (node: Node | undefined, delta: number) => {
    const t = asTask(node)
    if (!t) return
    const plan = await readPlan(state.livePlanPath(t.plan.path), t.plan.path)
    const order = state.ordered(plan).map((x) => x.id)
    const i = order.indexOf(t.task.id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= order.length) return
    ;[order[i], order[j]] = [order[j], order[i]]
    await state.setOrder(plan.path, order)
    tree.refresh()
  }

  /**
   * Answer a task that is waiting on a question. The log is shown first, since
   * the question in full is there; the box carries its last lines.
   */
  const askReply = async (planPath: string, taskId: string) => {
    const st = state.get(planPath, taskId)
    if (st.status !== 'waiting') {
      void vscode.window.showInformationMessage(`Plan Queue — ${taskId} is not waiting for a reply.`)
      return
    }
    queue.showLog(planPath)
    const gist = (st.question ?? '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-2)
      .join(' ')
    const text = await vscode.window.showInputBox({
      title: `Reply to ${taskId}`,
      prompt: gist.length > 300 ? '…' + gist.slice(-300) : gist || 'The task is waiting for your answer.',
      placeHolder: 'Your answer; the task carries on in the same session',
      ignoreFocusOut: true,
    })
    if (!text?.trim()) return
    if (!queue.reply(planPath, taskId, text)) {
      void vscode.window.showWarningMessage(`Plan Queue — ${taskId} is no longer waiting for a reply.`)
    }
  }

  context.subscriptions.push(
    queue,
    status,
    view,
    watcher,

    vscode.commands.registerCommand('planQueue.refresh', () => tree.refresh()),

    vscode.commands.registerCommand('planQueue.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'planQueue'),
    ),

    vscode.commands.registerCommand('planQueue.showLog', (node?: Node) => queue.showLog(node?.plan.path)),

    vscode.commands.registerCommand('planQueue.runQueue', async (node?: Node) => {
      const path = await resolvePlanPath(node)
      if (path) await queue.run(path)
    }),

    vscode.commands.registerCommand('planQueue.runFromHere', async (node?: Node) => {
      const t = asTask(node)
      if (t) await queue.run(t.plan.path, { fromId: t.task.id })
    }),

    vscode.commands.registerCommand('planQueue.runTask', async (node?: Node) => {
      const t = asTask(node)
      if (t) await queue.run(t.plan.path, { onlyId: t.task.id })
    }),

    vscode.commands.registerCommand('planQueue.stop', () => queue.stop()),

    vscode.commands.registerCommand('planQueue.stopPlan', (node?: Node) => {
      if (node) queue.stop(node.plan.path)
    }),

    vscode.commands.registerCommand('planQueue.openWorktree', async (node?: Node) => {
      const wt = node && state.worktree(node.plan.path)
      if (wt) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wt.dir), { forceNewWindow: true })
    }),

    vscode.commands.registerCommand('planQueue.discardWorktree', async (node?: Node) => {
      const wt = node && state.worktree(node.plan.path)
      if (!wt || queue.isRunning(node.plan.path)) return
      const yes = await vscode.window.showWarningMessage(
        `Delete the worktree at ${wt.dir} and the branch ${wt.branch}? Work on it that is not merged is lost. Task statuses are kept.`,
        { modal: true },
        'Discard',
      )
      if (yes === 'Discard') await queue.discardWorktree(node.plan.path)
    }),

    vscode.commands.registerCommand(
      'planQueue.reply',
      async (arg?: Node | { planPath: string; taskId: string }) => {
        // From the tree it is a node; from the "is asking" notification, plain ids.
        const t = arg && 'kind' in arg ? asTask(arg) : undefined
        const target = t ? { planPath: t.plan.path, taskId: t.task.id } : arg && !('kind' in arg) ? arg : undefined
        if (target) await askReply(target.planPath, target.taskId)
      },
    ),

    vscode.commands.registerCommand('planQueue.sendMessage', async (text?: string) => {
      const active = queue.active
      if (!active.length) {
        void vscode.window.showWarningMessage('Plan Queue is not running a task.')
        return
      }
      const target =
        active.length === 1
          ? active[0]
          : (
              await vscode.window.showQuickPick(
                active.map((r) => ({
                  label: r.task ? `${r.task.id} — ${r.task.title}` : 'preparing',
                  description: r.waiting ? `${r.title} · waiting for your reply` : r.title,
                  run: r,
                })),
                { placeHolder: 'Which running task?' },
              )
            )?.run
      if (!target) return
      // A task that asked something gets the reply box, with its question.
      if (target.waiting && target.task && text === undefined) {
        await askReply(target.planPath, target.task.id)
        return
      }
      const message =
        text ??
        (await vscode.window.showInputBox({
          title: 'Message the running task',
          prompt: 'Goes to the task in flight, like typing into its session.',
          placeHolder: 'e.g. skip the migration for now, just stub it',
          ignoreFocusOut: true,
        }))
      if (!message?.trim()) return
      if (!queue.send(target.planPath, message)) {
        void vscode.window.showWarningMessage(
          'Plan Queue could not deliver that — the task is no longer taking input.',
        )
        return
      }
      queue.showLog(target.planPath)
    }),

    vscode.commands.registerCommand('planQueue.toggleSkip', async (node?: Node) => {
      const t = asTask(node)
      if (!t) return
      const st = state.get(t.plan.path, t.task.id)
      await state.set(t.plan.path, t.task.id, {
        status: st.status === 'skipped' ? 'pending' : 'skipped',
        reason: undefined,
      })
      tree.refresh()
    }),

    vscode.commands.registerCommand('planQueue.markDone', async (node?: Node) => {
      const t = asTask(node)
      if (!t) return
      await state.set(t.plan.path, t.task.id, {
        status: 'done',
        reason: undefined,
        question: undefined,
        ranHash: t.task.hash,
      })
      tree.refresh()
    }),

    vscode.commands.registerCommand('planQueue.resetTask', async (node?: Node) => {
      const t = asTask(node)
      if (!t) return
      await state.set(t.plan.path, t.task.id, {
        status: 'pending',
        reason: undefined,
        question: undefined,
        ranHash: undefined,
        costUsd: undefined,
        durationMs: undefined,
      })
      tree.refresh()
    }),

    vscode.commands.registerCommand('planQueue.resetPlan', async (node?: Node) => {
      const path = await resolvePlanPath(node)
      if (!path) return
      const yes = await vscode.window.showWarningMessage(
        'Reset every task in this plan to pending?',
        { modal: true },
        'Reset',
      )
      if (yes !== 'Reset') return
      await state.resetPlan(path)
      tree.refresh()
    }),

    vscode.commands.registerCommand('planQueue.restoreOrder', async (node?: Node) => {
      const path = await resolvePlanPath(node)
      if (!path) return
      await state.restoreOrder(path)
      tree.refresh()
    }),

    vscode.commands.registerCommand('planQueue.moveUp', (node?: Node) => reorder(node, -1)),
    vscode.commands.registerCommand('planQueue.moveDown', (node?: Node) => reorder(node, 1)),

    vscode.commands.registerCommand('planQueue.openPrompt', async (node?: Node) => {
      const t = asTask(node)
      if (!t) return
      // While the plan has a worktree, its copy there is the one tasks read.
      const live = state.livePlanPath(t.plan.path)
      const doc = await vscode.workspace.openTextDocument(live)
      const editor = await vscode.window.showTextDocument(doc, { preview: true })
      // Re-find the heading: the line may have moved since the tree was built.
      const fresh = (await readPlan(live, t.plan.path)).tasks.find((x) => x.id === t.task.id)
      const line = Math.max(0, (fresh?.line ?? t.task.line) - 1)
      const pos = new vscode.Position(line, 0)
      editor.selection = new vscode.Selection(pos, pos)
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter)
    }),

    vscode.commands.registerCommand('planQueue.previewPrompt', async (node?: Node) => {
      const t = asTask(node)
      if (!t) return
      const cwd =
        state.worktree(t.plan.path)?.cwd ??
        vscode.workspace.getWorkspaceFolder(vscode.Uri.file(t.plan.path))?.uri.fsPath ??
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
        process.cwd()
      const fresh = (await readPlan(state.livePlanPath(t.plan.path), t.plan.path)).tasks.find((x) => x.id === t.task.id) ?? t.task
      const text = await composePrompt(fresh, readConfig(), cwd)
      const doc = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' })
      await vscode.window.showTextDocument(doc, { preview: true })
    }),
  )
}

export function deactivate(): void {
  // Nothing: running tasks are stopped when the queue is disposed.
}
