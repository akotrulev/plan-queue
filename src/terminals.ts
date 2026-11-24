import * as vscode from 'vscode'
import { shortId } from './session'

/** When a task's session gets a terminal of its own. */
type Mode = 'onStart' | 'whenNeeded' | 'never'

interface Open {
  terminal: vscode.Terminal
  sessionId: string
}

/**
 * One VS Code terminal per task, running `claude attach` on the task's
 * background session — the full Claude Code UI, driven by the queue. Closing
 * the terminal leaves the session running; the queue still owns it.
 */
export class SessionTerminals implements vscode.Disposable {
  private readonly open = new Map<string, Open>()
  private readonly closing: vscode.Disposable

  constructor(private readonly claudePath: () => string) {
    this.closing = vscode.window.onDidCloseTerminal((t) => {
      for (const [key, o] of this.open) if (o.terminal === t) this.open.delete(key)
    })
  }

  private mode(): Mode {
    return vscode.workspace.getConfiguration('planQueue').get<Mode>('sessionTerminals', 'onStart')
  }

  /**
   * A session came up or needs a person. Per planQueue.sessionTerminals, its
   * terminal is opened in the background as it starts, and brought forward —
   * without taking the keyboard — when it waits on a person.
   */
  onSession(e: { planPath: string; taskId: string; title: string; sessionId: string; cwd: string; attention: boolean }): void {
    const mode = this.mode()
    if (mode === 'never' || (mode === 'whenNeeded' && !e.attention)) return
    const t = this.ensure(e)
    if (e.attention) t.show(true)
  }

  /** Open the task's session in a terminal and put the cursor in it. */
  show(e: { planPath: string; taskId: string; title: string; sessionId: string; cwd: string }): void {
    this.ensure(e).show(false)
  }

  private ensure(e: { planPath: string; taskId: string; title: string; sessionId: string; cwd: string }): vscode.Terminal {
    const key = `${e.planPath}#${e.taskId}`
    const had = this.open.get(key)
    // `claude attach` ends when its session is stopped; a resumed session needs a fresh one.
    if (had && had.sessionId === e.sessionId && had.terminal.exitStatus === undefined) return had.terminal
    had?.terminal.dispose()
    const terminal = vscode.window.createTerminal({
      name: `${e.taskId} · ${e.title}`,
      shellPath: this.claudePath(),
      shellArgs: ['attach', shortId(e.sessionId)],
      cwd: e.cwd,
      iconPath: new vscode.ThemeIcon('hubot'),
      // A reload restores nothing: the queue opens what it still runs.
      isTransient: true,
    })
    this.open.set(key, { terminal, sessionId: e.sessionId })
    return terminal
  }

  dispose(): void {
    this.closing.dispose()
  }
}
