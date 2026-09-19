import * as vscode from 'vscode'
import * as fs from 'fs/promises'
import { looksLikeAPlan, parsePlanText, type Plan, type Task } from './plan'
import type { StateStore, Status } from './state'

export interface PlanNode {
  kind: 'plan'
  plan: Plan
}

export interface TaskNode {
  kind: 'task'
  plan: Plan
  task: Task
  index: number
}

export type Node = PlanNode | TaskNode

const MIME = 'application/vnd.code.tree.planqueue'

const ICONS: Record<Status, { icon: string; color?: string }> = {
  pending: { icon: 'circle-outline' },
  running: { icon: 'sync~spin', color: 'charts.blue' },
  done: { icon: 'pass-filled', color: 'charts.green' },
  blocked: { icon: 'error', color: 'charts.red' },
  failed: { icon: 'error', color: 'charts.red' },
  skipped: { icon: 'circle-slash', color: 'disabledForeground' },
}

export class PlanTree
  implements vscode.TreeDataProvider<Node>, vscode.TreeDragAndDropController<Node>
{
  readonly dropMimeTypes = [MIME]
  readonly dragMimeTypes = [MIME]

  private readonly emitter = new vscode.EventEmitter<Node | undefined>()
  readonly onDidChangeTreeData = this.emitter.event

  /** Parsed plans, keyed by absolute path. Rebuilt from disk on every refresh. */
  private plans: Plan[] = []

  constructor(private readonly state: StateStore) {}

  refresh(): void {
    this.emitter.fire(undefined)
  }

  get loaded(): Plan[] {
    return this.plans
  }

  findPlan(path: string): Plan | undefined {
    return this.plans.find((p) => p.path === path)
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      this.plans = await this.discover()
      await vscode.commands.executeCommand(
        'setContext',
        'planQueue.hasPlans',
        this.plans.length > 0,
      )
      return this.plans.map((plan) => ({ kind: 'plan', plan }))
    }
    if (node.kind === 'plan') {
      return this.state
        .ordered(node.plan)
        .map((task, index) => ({ kind: 'task', plan: node.plan, task, index }))
    }
    return []
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'plan') return this.planItem(node.plan)
    return this.taskItem(node)
  }

  private planItem(plan: Plan): vscode.TreeItem {
    const tasks = this.state.ordered(plan)
    const done = tasks.filter((t) => this.state.get(plan.path, t.id).status === 'done').length
    const item = new vscode.TreeItem(
      plan.title,
      done > 0 && done < tasks.length
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed,
    )
    item.description = `${done}/${tasks.length}`
    item.contextValue = 'plan'
    item.iconPath = new vscode.ThemeIcon('notebook')
    item.resourceUri = vscode.Uri.file(plan.path)
    item.tooltip = plan.path
    return item
  }

  private taskItem(node: TaskNode): vscode.TreeItem {
    const st = this.state.get(node.plan.path, node.task.id)
    const item = new vscode.TreeItem(
      `${node.task.id} — ${node.task.title}`,
      vscode.TreeItemCollapsibleState.None,
    )

    // A task that ran and whose prompt has since been rewritten — by the task
    // before it, usually — is flagged, because what runs next is the new text.
    const rewritten = st.ranHash !== undefined && st.ranHash !== node.task.hash

    const bits: string[] = []
    if (node.task.agent) bits.push(node.task.agent)
    if (st.costUsd !== undefined) bits.push(`$${st.costUsd.toFixed(2)}`)
    if (st.durationMs) bits.push(`${Math.round(st.durationMs / 1000)}s`)
    if (rewritten) bits.push('prompt rewritten')
    if (st.reason) bits.push(st.reason)
    item.description = bits.join(' · ')

    const look = ICONS[st.status]
    item.iconPath = new vscode.ThemeIcon(
      rewritten && st.status === 'done' ? 'warning' : look.icon,
      look.color ? new vscode.ThemeColor(look.color) : undefined,
    )
    item.contextValue = `task.${st.status}`
    item.tooltip = new vscode.MarkdownString(
      [
        `**${node.task.id} — ${node.task.title}**`,
        node.task.agent ? `Agent: \`${node.task.agent}\`` : '',
        `Status: ${st.status}${st.reason ? ` — ${st.reason}` : ''}`,
        rewritten ? '\n⚠ The prompt changed since this task ran.' : '',
        '\n---\n',
        node.task.prompt.slice(0, 1200) + (node.task.prompt.length > 1200 ? '\n\n…' : ''),
      ]
        .filter(Boolean)
        .join('\n\n'),
    )
    item.command = {
      command: 'planQueue.openPrompt',
      title: 'Open the prompt in the plan',
      arguments: [node],
    }
    return item
  }

  // ---- drag and drop -------------------------------------------------------

  handleDrag(source: readonly Node[], data: vscode.DataTransfer): void {
    const tasks = source.filter((n): n is TaskNode => n.kind === 'task')
    if (!tasks.length) return
    data.set(
      MIME,
      new vscode.DataTransferItem({
        path: tasks[0].plan.path,
        ids: tasks.map((t) => t.task.id),
      }),
    )
  }

  async handleDrop(target: Node | undefined, data: vscode.DataTransfer): Promise<void> {
    const payload = data.get(MIME)?.value as { path: string; ids: string[] } | undefined
    if (!payload || !target) return

    // Reordering is within one plan: two plans are two queues.
    if (target.plan.path !== payload.path) return
    const plan = this.findPlan(payload.path)
    if (!plan) return

    const order = this.state.ordered(plan).map((t) => t.id)
    const moving = payload.ids.filter((id) => order.includes(id))
    if (!moving.length) return

    const rest = order.filter((id) => !moving.includes(id))
    let at = rest.length
    if (target.kind === 'task') {
      const i = rest.indexOf(target.task.id)
      at = i < 0 ? rest.length : i
    } else {
      at = 0
    }
    rest.splice(at, 0, ...moving)
    await this.state.setOrder(plan.path, rest)
    this.refresh()
  }

  // ---- discovery -----------------------------------------------------------

  private async discover(): Promise<Plan[]> {
    const glob = vscode.workspace.getConfiguration('planQueue').get<string>('planGlob', 'docs/plans/**/*.md')
    const uris = await vscode.workspace.findFiles(glob, '**/node_modules/**', 500)
    const plans: Plan[] = []
    for (const uri of uris) {
      try {
        const text = await fs.readFile(uri.fsPath, 'utf8')
        if (!looksLikeAPlan(text)) continue
        const plan = parsePlanText(text, uri.fsPath)
        if (plan.tasks.length) plans.push(plan)
      } catch {
        // A plan we cannot read is simply not listed.
      }
    }
    plans.sort((a, b) => a.title.localeCompare(b.title))
    return plans
  }
}
