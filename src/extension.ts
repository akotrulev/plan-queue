import * as vscode from 'vscode'
import { readPlan } from './plan'
import { Queue } from './queue'
import { composePrompt, readConfig } from './runner'
import { StateStore } from './state'
import { PlanTree, type Node, type TaskNode } from './tree'

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const state = new StateStore(context.workspaceState)
  await state.clearRunning()

  const out = vscode.window.createOutputChannel('Plan Queue')
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  status.command = 'planQueue.showLog'

  const tree = new PlanTree(state)
  const view = vscode.window.createTreeView('planQueue.tasks', {
    treeDataProvider: tree,
    dragAndDropController: tree,
    canSelectMany: true,
    showCollapseAll: true,
  })

  const queue = new Queue(state, tree, out, status)
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
    const plan = await readPlan(t.plan.path)
    const order = state.ordered(plan).map((x) => x.id)
    const i = order.indexOf(t.task.id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= order.length) return
    ;[order[i], order[j]] = [order[j], order[i]]
    await state.setOrder(plan.path, order)
    tree.refresh()
  }

  context.subscriptions.push(
    out,
    status,
    view,
    watcher,

    vscode.commands.registerCommand('planQueue.refresh', () => tree.refresh()),

    vscode.commands.registerCommand('planQueue.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', 'planQueue'),
    ),

    vscode.commands.registerCommand('planQueue.showLog', () => out.show()),

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

    vscode.commands.registerCommand('planQueue.sendMessage', async (text?: string) => {
      if (!queue.running) {
        void vscode.window.showWarningMessage('Plan Queue is not running a task.')
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
      if (!queue.send(message)) {
        void vscode.window.showWarningMessage(
          'Plan Queue could not deliver that — the task is no longer taking input.',
        )
        return
      }
      out.show(true)
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
      const doc = await vscode.workspace.openTextDocument(t.plan.path)
      const editor = await vscode.window.showTextDocument(doc, { preview: true })
      // Re-find the heading: the line may have moved since the tree was built.
      const fresh = (await readPlan(t.plan.path)).tasks.find((x) => x.id === t.task.id)
      const line = Math.max(0, (fresh?.line ?? t.task.line) - 1)
      const pos = new vscode.Position(line, 0)
      editor.selection = new vscode.Selection(pos, pos)
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter)
    }),

    vscode.commands.registerCommand('planQueue.previewPrompt', async (node?: Node) => {
      const t = asTask(node)
      if (!t) return
      const cwd =
        vscode.workspace.getWorkspaceFolder(vscode.Uri.file(t.plan.path))?.uri.fsPath ??
        vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
        process.cwd()
      const fresh = (await readPlan(t.plan.path)).tasks.find((x) => x.id === t.task.id) ?? t.task
      const text = await composePrompt(fresh, readConfig(), cwd)
      const doc = await vscode.workspace.openTextDocument({ content: text, language: 'markdown' })
      await vscode.window.showTextDocument(doc, { preview: true })
    }),
  )
}

export function deactivate(): void {
  // Nothing: a running task is killed with the extension host.
}
