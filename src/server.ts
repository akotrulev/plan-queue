import * as crypto from 'crypto'
import * as fs from 'fs/promises'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import * as vscode from 'vscode'
import type { Plan } from './plan'
import type { Queue } from './queue'
import type { StateStore } from './state'
import type { PlanTree } from './tree'

/**
 * A local control endpoint, so something other than the sidebar — an LLM over
 * MCP, or the `pq` command — can start and watch plans. It speaks MCP's
 * Streamable HTTP in its plainest form (JSON-RPC in, JSON out), which is all
 * a tool-only server needs, so no SDK is bundled.
 *
 * It only listens on 127.0.0.1, refuses browser requests, and wants a bearer
 * token that never leaves this machine's secret storage and `~/.plan-queue`.
 */

const TOKEN_KEY = 'planQueue.serverToken'
export const DISCOVERY_FILE = path.join(os.homedir(), '.plan-queue', 'server.json')

interface Tool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run: (args: Record<string, any>) => Promise<unknown>
}

class ToolError extends Error {}

const INSTRUCTIONS = [
  'Plan Queue runs the tasks of a plan file (docs/plans/*.md) through Claude Code, one fresh session per task.',
  'list_plans shows what exists; run_plan starts one and returns at once, then poll plan_status.',
  'Tasks that declare `Depends on:` run in parallel when their dependencies are done.',
  'A task whose status is "waiting" has asked a question (see its `question`): answer it with reply.',
  'A task whose status is "paused" keeps its session: resume carries on in it.',
  'Do not start a plan from inside one of its own tasks.',
].join(' ')

export class ControlServer implements vscode.Disposable {
  private server?: http.Server
  private token = ''
  private port = 0
  private readonly tools: Tool[]

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly queue: Queue,
    private readonly tree: PlanTree,
    private readonly state: StateStore,
    private readonly log: vscode.OutputChannel,
  ) {
    this.tools = this.defineTools()
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}/mcp`
  }

  get listening(): boolean {
    return this.server?.listening ?? false
  }

  async getToken(): Promise<string> {
    if (this.token) return this.token
    let token = await this.context.secrets.get(TOKEN_KEY)
    if (!token) {
      token = crypto.randomBytes(24).toString('hex')
      await this.context.secrets.store(TOKEN_KEY, token)
    }
    this.token = token
    return token
  }

  /** Listen, if not already. False when the port is taken — usually another window's server. */
  async start(): Promise<boolean> {
    if (this.listening) return true
    const token = await this.getToken()
    this.port = vscode.workspace.getConfiguration('planQueue').get<number>('server.port', 47321)

    const server = http.createServer((req, res) => void this.handle(req, res))
    const ok = await new Promise<boolean>((resolve) => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        this.log.appendLine(`control server: ${e.code === 'EADDRINUSE' ? `port ${this.port} is in use` : e.message}`)
        resolve(false)
      })
      server.listen(this.port, '127.0.0.1', () => resolve(true))
    })
    if (!ok) return false
    this.server = server

    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    await fs.mkdir(path.dirname(DISCOVERY_FILE), { recursive: true })
    await fs.writeFile(
      DISCOVERY_FILE,
      JSON.stringify({ url: this.url, token, port: this.port, workspace: folder, pid: process.pid }, null, 2),
      { mode: 0o600 },
    )
    await fs.chmod(DISCOVERY_FILE, 0o600).catch(() => undefined)
    this.log.appendLine(`control server: listening on ${this.url}`)
    return true
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = undefined
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
    // Only remove the discovery file if it is still ours.
    try {
      const mine = JSON.parse(await fs.readFile(DISCOVERY_FILE, 'utf8')).pid === process.pid
      if (mine) await fs.rm(DISCOVERY_FILE)
    } catch {
      // Gone already, or someone else's.
    }
  }

  dispose(): void {
    void this.stop()
  }

  // ---- HTTP ---------------------------------------------------------------

  private authorised(req: http.IncomingMessage): boolean {
    // A page in a browser can reach localhost; it cannot be allowed to drive this.
    if (req.headers.origin) return false
    const host = (req.headers.host ?? '').toLowerCase()
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return false
    const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''))
    const want = Buffer.from(this.token)
    return given.length === want.length && crypto.timingSafeEqual(given, want)
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const send = (code: number, body?: unknown) => {
      res.writeHead(code, body === undefined ? {} : { 'content-type': 'application/json' })
      res.end(body === undefined ? undefined : JSON.stringify(body))
    }
    try {
      if (!this.authorised(req)) return send(401, { error: 'unauthorised' })
      if (req.url !== '/mcp') return send(404, { error: 'not found' })
      // No server-initiated stream: this server only answers.
      if (req.method !== 'POST') return send(405, { error: 'POST only' })

      let raw = ''
      for await (const chunk of req) {
        raw += chunk
        if (raw.length > 1_000_000) return send(413, { error: 'too large' })
      }
      let message: unknown
      try {
        message = JSON.parse(raw)
      } catch {
        return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
      }

      if (Array.isArray(message)) {
        const replies = (await Promise.all(message.map((m) => this.rpc(m)))).filter((r) => r !== undefined)
        return replies.length ? send(200, replies) : send(202)
      }
      const reply = await this.rpc(message)
      return reply === undefined ? send(202) : send(200, reply)
    } catch (e) {
      this.log.appendLine(`control server: ${e instanceof Error ? e.stack ?? e.message : e}`)
      send(500, { error: 'internal error' })
    }
  }

  /** One JSON-RPC message; undefined for a notification, which gets no reply. */
  private async rpc(message: any): Promise<unknown> {
    const id = message?.id
    const reply = (result: unknown) => ({ jsonrpc: '2.0', id, result })
    const fail = (code: number, text: string) => ({ jsonrpc: '2.0', id, error: { code, message: text } })
    if (id === undefined || id === null) return undefined

    switch (message.method) {
      case 'initialize':
        return reply({
          protocolVersion: message.params?.protocolVersion ?? '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'plan-queue', version: String(this.context.extension.packageJSON.version) },
          instructions: INSTRUCTIONS,
        })
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply({
          tools: this.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        })
      case 'tools/call': {
        const tool = this.tools.find((t) => t.name === message.params?.name)
        if (!tool) return fail(-32602, `unknown tool ${message.params?.name}`)
        try {
          const out = await tool.run(message.params?.arguments ?? {})
          return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] })
        } catch (e) {
          if (!(e instanceof ToolError)) this.log.appendLine(`control server: ${tool.name}: ${e}`)
          return reply({ content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true })
        }
      }
      default:
        return fail(-32601, `method not found: ${message.method}`)
    }
  }

  // ---- tools --------------------------------------------------------------

  private async plans(): Promise<Plan[]> {
    await this.tree.getChildren()
    return this.tree.loaded
  }

  private rel(plan: Plan): string {
    return vscode.workspace.asRelativePath(plan.path)
  }

  private async resolve(ref: unknown): Promise<Plan> {
    if (typeof ref !== 'string' || !ref.trim()) throw new ToolError('plan is required: a path or title from list_plans')
    const want = ref.trim().toLowerCase()
    const plans = await this.plans()
    const by = (test: (p: Plan) => boolean) => plans.filter(test)
    const exact = by((p) => this.rel(p).toLowerCase() === want || p.path.toLowerCase() === want)
    const found =
      exact.length === 1
        ? exact
        : by((p) => path.basename(p.path, '.md').toLowerCase() === want || p.title.toLowerCase() === want).length === 1
          ? by((p) => path.basename(p.path, '.md').toLowerCase() === want || p.title.toLowerCase() === want)
          : by((p) => this.rel(p).toLowerCase().includes(want) || p.title.toLowerCase().includes(want))
    if (found.length === 1) return found[0]
    throw new ToolError(
      found.length
        ? `"${ref}" matches ${found.length} plans: ${found.map((p) => this.rel(p)).join(', ')}`
        : `no plan matches "${ref}"; known: ${plans.map((p) => this.rel(p)).join(', ') || 'none'}`,
    )
  }

  private snapshot(plan: Plan) {
    const tasks = this.state.ordered(plan)
    const live = new Map(this.queue.liveTasks(plan.path).map((l) => [l.task.id, l]))
    const wt = this.state.worktree(plan.path)
    return {
      plan: this.rel(plan),
      title: plan.title,
      running: this.queue.isRunning(plan.path),
      branch: wt?.branch,
      tasks: tasks.map((t) => {
        const st = this.state.get(plan.path, t.id)
        return {
          id: t.id,
          title: t.title,
          agent: t.agent || undefined,
          dependsOn: t.deps,
          status: st.status,
          working: live.has(t.id) && !live.get(t.id)!.waiting ? true : undefined,
          reason: st.reason,
          question: st.status === 'waiting' ? st.question : undefined,
          denied: st.denied?.length ? st.denied : undefined,
          costUsd: st.costUsd,
          seconds: st.durationMs ? Math.round(st.durationMs / 1000) : undefined,
        }
      }),
    }
  }

  private defineTools(): Tool[] {
    const planArg = { type: 'string', description: 'Workspace-relative path, file name or title of the plan, as list_plans shows.' }
    const taskArg = { type: 'string', description: 'Task id, e.g. T3.' }
    const started = (r: { ok: true } | { ok: false; reason: string }, what: string) => {
      if (!r.ok) throw new ToolError(`not started: ${r.reason}`)
      return { started: what, next: 'Poll plan_status; a task with status "waiting" needs reply.' }
    }

    return [
      {
        name: 'list_plans',
        description: 'List the plans in this workspace, with how far each has got.',
        inputSchema: { type: 'object', properties: {} },
        run: async () =>
          (await this.plans()).map((p) => {
            const s = this.snapshot(p)
            return {
              plan: s.plan,
              title: s.title,
              running: s.running,
              done: s.tasks.filter((t) => t.status === 'done').length,
              total: s.tasks.length,
              waiting: s.tasks.filter((t) => t.status === 'waiting').map((t) => t.id),
              blocked: s.tasks.filter((t) => t.status === 'blocked').map((t) => t.id),
              paused: s.tasks.filter((t) => t.status === 'paused').map((t) => t.id),
            }
          }),
      },
      {
        name: 'plan_status',
        description:
          'Every task of a plan with its status, dependencies, cost, and, for a waiting task, the question it asked.',
        inputSchema: { type: 'object', properties: { plan: planArg }, required: ['plan'] },
        run: async (a) => this.snapshot(await this.resolve(a.plan)),
      },
      {
        name: 'run_plan',
        description:
          'Start a plan running and return at once. Tasks run one fresh Claude session each; those that declare `Depends on:` run in parallel once their dependencies are done. Stops at the first failure.',
        inputSchema: {
          type: 'object',
          properties: { plan: planArg, from_task: { type: 'string', description: 'Start at this task instead of the first unfinished one.' } },
          required: ['plan'],
        },
        run: async (a) => {
          const plan = await this.resolve(a.plan)
          return started(this.queue.start(plan.path, a.from_task ? { fromId: String(a.from_task) } : {}), this.rel(plan))
        },
      },
      {
        name: 'run_task',
        description:
          'Run one task of a plan. With now=true on a plan that is already running, start it immediately alongside the others, ignoring its dependencies and the parallel cap.',
        inputSchema: {
          type: 'object',
          properties: { plan: planArg, task: taskArg, now: { type: 'boolean' } },
          required: ['plan', 'task'],
        },
        run: async (a) => {
          const plan = await this.resolve(a.plan)
          const id = String(a.task)
          if (!plan.tasks.some((t) => t.id === id)) throw new ToolError(`${this.rel(plan)} has no task ${id}`)
          const r = a.now ? await this.queue.runNow(plan.path, id, false) : this.queue.start(plan.path, { onlyId: id })
          return started(r, `${this.rel(plan)} ${id}`)
        },
      },
      {
        name: 'stop',
        description: 'Stop a plan, or every plan when none is named. Running tasks are killed and go back to pending; waiting tasks stay waiting.',
        inputSchema: { type: 'object', properties: { plan: planArg } },
        run: async (a) => {
          const plan = a.plan ? await this.resolve(a.plan) : undefined
          this.queue.stop(plan?.path)
          return { stopped: plan ? this.rel(plan) : 'all' }
        },
      },
      {
        name: 'pause',
        description:
          'Pause one task, a whole plan, or every plan when none is named. A paused task is interrupted with its session kept, and its changes stay in the tree; resume carries on in that session. Waiting tasks stay waiting.',
        inputSchema: { type: 'object', properties: { plan: planArg, task: taskArg } },
        run: async (a) => {
          const plan = a.plan ? await this.resolve(a.plan) : undefined
          if (a.task && !plan) throw new ToolError('name the plan the task belongs to')
          if (!this.queue.pause(plan?.path, a.task ? String(a.task) : undefined)) {
            throw new ToolError(a.task ? `${a.task} is not working right now` : 'nothing is running')
          }
          return { pausing: [plan ? this.rel(plan) : 'all', a.task].filter(Boolean).join(' ') }
        },
      },
      {
        name: 'resume',
        description:
          'Carry on after a pause. A plan that is not running starts again (from the task, when named), and each paused task resumes its own session. On a running plan, a paused task starts again now.',
        inputSchema: { type: 'object', properties: { plan: planArg, task: taskArg }, required: ['plan'] },
        run: async (a) => {
          const plan = await this.resolve(a.plan)
          const id = a.task ? String(a.task) : undefined
          if (id && !plan.tasks.some((t) => t.id === id)) throw new ToolError(`${this.rel(plan)} has no task ${id}`)
          return started(this.queue.resume(plan.path, id), [this.rel(plan), id].filter(Boolean).join(' '))
        },
      },
      {
        name: 'reply',
        description: 'Answer a task whose status is "waiting". It resumes in the same session with your answer.',
        inputSchema: {
          type: 'object',
          properties: { plan: planArg, task: taskArg, text: { type: 'string' } },
          required: ['plan', 'task', 'text'],
        },
        run: async (a) => {
          const plan = await this.resolve(a.plan)
          const id = String(a.task)
          if (this.state.get(plan.path, id).status !== 'waiting') throw new ToolError(`${id} is not waiting for a reply`)
          if (!String(a.text ?? '').trim()) throw new ToolError('text is empty')
          if (!this.queue.reply(plan.path, id, String(a.text))) throw new ToolError(`${id} is no longer waiting`)
          return { replied: id }
        },
      },
      {
        name: 'message',
        description: 'Send a message into a task that is working right now, like typing into its session. Omit task when the plan has only one running.',
        inputSchema: {
          type: 'object',
          properties: { plan: planArg, task: taskArg, text: { type: 'string' } },
          required: ['plan', 'text'],
        },
        run: async (a) => {
          const plan = await this.resolve(a.plan)
          if (!this.queue.send(plan.path, String(a.text ?? ''), a.task ? String(a.task) : undefined)) {
            throw new ToolError('no such running task, or it is no longer taking input; name the task if several are running')
          }
          return { sent: true }
        },
      },
      {
        name: 'get_log',
        description:
          "The last lines of a plan's log — what its tasks printed, the commands they ran, failed tool calls, gate output — or, with task, that task's latest transcript, which survives a VS Code restart.",
        inputSchema: {
          type: 'object',
          properties: {
            plan: planArg,
            task: { type: 'string', description: 'Read this task\'s transcript instead of the plan\'s log.' },
            lines: { type: 'number', description: 'Default 80, at most 500.' },
          },
          required: ['plan'],
        },
        run: async (a) => {
          const plan = await this.resolve(a.plan)
          const n = Math.min(500, Math.max(1, Number(a.lines) || 80))
          return { log: this.queue.tail(plan.path, n, a.task ? String(a.task) : undefined) }
        },
      },
    ]
  }
}
