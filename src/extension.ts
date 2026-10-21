import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import * as vscode from 'vscode'
import { readPlan } from './plan'
import { Queue } from './queue'
import { composePrompt, readConfig } from './runner'
import { ControlServer } from './server'
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

  const serverLog = vscode.window.createOutputChannel('Plan Queue — control')
  const server = new ControlServer(context, queue, tree, state, serverLog)
  const serverEnabled = () => vscode.workspace.getConfiguration('planQueue').get<boolean>('server.enabled', false)
  if (serverEnabled()) {
    void server.start().then(() => installCli(context, serverLog))
  }
  await vscode.commands.executeCommand('setContext', 'planQueue.running', false)

  // A plan edited by hand — or rewritten by the task before this one — shows up
  // in the tree without a manual refresh. Watched: the plan glob in each
  // workspace folder, and each plan's copy in its worktree, which lives outside
  // the workspace. A burst of saves is one refresh.
  let refreshTimer: NodeJS.Timeout | undefined
  const refreshSoon = () => {
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => tree.refresh(), 300)
  }
  const watch = (pattern: vscode.GlobPattern) => {
    const w = vscode.workspace.createFileSystemWatcher(pattern)
    w.onDidChange(refreshSoon)
    w.onDidCreate(refreshSoon)
    w.onDidDelete(refreshSoon)
    return w
  }
  let planWatchers: vscode.FileSystemWatcher[] = []
  const watchPlans = () => {
    planWatchers.forEach((w) => w.dispose())
    const glob = vscode.workspace.getConfiguration('planQueue').get<string>('planGlob', 'docs/plans/**/*.md')
    planWatchers = (vscode.workspace.workspaceFolders ?? []).map((f) => watch(new vscode.RelativePattern(f, glob)))
  }
  watchPlans()
  const worktreeWatchers = new Map<string, vscode.FileSystemWatcher>()
  const watchWorktrees = () => {
    const want = new Set(state.worktrees().map((wt) => wt.planPath))
    for (const [p, w] of worktreeWatchers) {
      if (!want.has(p)) {
        w.dispose()
        worktreeWatchers.delete(p)
      }
    }
    for (const p of want) {
      if (!worktreeWatchers.has(p)) {
        worktreeWatchers.set(p, watch(new vscode.RelativePattern(vscode.Uri.file(path.dirname(p)), path.basename(p))))
      }
    }
  }
  watchWorktrees()
  const treeChanged = tree.onDidChangeTreeData(() => watchWorktrees())

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
    server,
    serverLog,
    status,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('planQueue.planGlob')) {
        watchPlans()
        tree.refresh()
      }
      if (e.affectsConfiguration('planQueue.server')) {
        void server.stop().then(() => (serverEnabled() ? server.start() : undefined))
      }
    }),
    view,
    treeChanged,
    { dispose: () => [...planWatchers, ...worktreeWatchers.values()].forEach((w) => w.dispose()) },
    { dispose: () => refreshTimer && clearTimeout(refreshTimer) },

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

    vscode.commands.registerCommand('planQueue.runTaskNow', async (node?: Node) => {
      const t = asTask(node)
      if (!t) return
      const r = await queue.runNow(t.plan.path, t.task.id)
      if (!r.ok && r.reason !== 'cancelled') {
        void vscode.window.showWarningMessage(`Plan Queue — ${t.task.id} not started: ${r.reason}.`)
      }
    }),

    vscode.commands.registerCommand('planQueue.connectClaude', async () => {
      const pick = await vscode.window.showInformationMessage(
        'Let Claude Code start and watch plans through Plan Queue? Any session that has this connection can run plans in this workspace, which means model calls and edits on your behalf.',
        { modal: true },
        'Register for all projects',
        'Register for this project only',
      )
      if (!pick) return
      await vscode.workspace
        .getConfiguration('planQueue')
        .update('server.enabled', true, vscode.ConfigurationTarget.Global)
      if (!(await server.start())) {
        void vscode.window.showErrorMessage(
          'Plan Queue could not listen on its port. Another window may hold it; change planQueue.server.port.',
        )
        return
      }
      const cli = await installCli(context, serverLog)
      const scope = pick === 'Register for all projects' ? 'user' : 'local'
      const claude = readConfig().claudePath
      const token = await server.getToken()
      const terminal = vscode.window.createTerminal({ name: 'Plan Queue — connect', cwd: vscode.workspace.workspaceFolders?.[0]?.uri })
      terminal.show()
      terminal.sendText(`${claude} mcp remove plan-queue --scope ${scope} >/dev/null 2>&1; ${claude} mcp add --transport http --scope ${scope} plan-queue ${server.url} --header "Authorization: Bearer ${token}"`)
      void vscode.window.showInformationMessage(
        `Plan Queue is serving on ${server.url}. New Claude Code sessions will have its tools.` +
          (cli ? ` The pq command is at ${cli}.` : ''),
      )
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
      if (!queue.send(target.planPath, message, target.task?.id)) {
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

const CLI_MARKER = '// pq — drives the Plan Queue extension'

/**
 * Put the `pq` command on the user's PATH-by-convention (~/.local/bin). The
 * script is one self-contained file, so it is copied rather than linked and
 * survives the extension's folder changing on update. A `pq` that is not ours
 * is left alone.
 */
async function installCli(context: vscode.ExtensionContext, log: vscode.OutputChannel): Promise<string | undefined> {
  if (process.platform === 'win32') return undefined
  const target = path.join(os.homedir(), '.local', 'bin', 'pq')
  try {
    const source = await fs.readFile(context.asAbsolutePath('cli/pq.mjs'), 'utf8')
    const existing = await fs.readFile(target, 'utf8').catch(() => undefined)
    if (existing !== undefined && !existing.includes(CLI_MARKER)) {
      log.appendLine(`pq: ${target} exists and is not Plan Queue's; left alone`)
      return undefined
    }
    if (existing !== source) {
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, source, { mode: 0o755 })
      await fs.chmod(target, 0o755)
    }
    return target
  } catch (e) {
    log.appendLine(`pq: could not install: ${e instanceof Error ? e.message : e}`)
    return undefined
  }
}
