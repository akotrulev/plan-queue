import * as vscode from 'vscode'
import { stopSession } from './runner'
import { shortId } from './session'

/** When a task's session gets a terminal of its own. */
type Mode = 'onStart' | 'whenNeeded' | 'never'

interface Open {
  terminal: vscode.Terminal
  sessionId: string
  /** Runs `claude attach` in a loop that outlives the session, waiting on Enter to attach again. */
  looped: boolean
  /** Woken after its task failed, for review: closing the tab stops the session again. */
  review?: { cwd: string }
}

/**
 * `claude attach` ends when its session stops — as it does once its task is
 * done — and clears its screen as it goes. In a loop the tab stays: it shows
 * the task's transcript ($2) in its place, and Enter attaches again; the queue
 * presses it when it starts the session again. $3 is the session id.
 */
const ATTACH_LOOP =
  'while :; do "$0" attach "$1"; ' +
  'if [ -f "$2" ]; then printf "\\033[2J\\033[3J\\033[H"; cat "$2"; fi; ' +
  'printf "\\n\\033[2m— the session has stopped (claude --resume %s). Press Enter to attach again, or close this tab.\\033[0m\\n" "$3"; ' +
  'read -r _ || exit 0; done'

/**
 * One VS Code terminal per task, running `claude attach` on the task's
 * background session — the full Claude Code UI, driven by the queue, in an
 * editor tab by default. Closing it leaves the session running; the queue
 * still owns it.
 */
export class SessionTerminals implements vscode.Disposable {
  private readonly open = new Map<string, Open>()
  /** `claude` run in a folder that Claude Code has not trusted yet, keyed by folder. */
  private readonly trusting = new Map<string, vscode.Terminal>()
  private readonly closing: vscode.Disposable

  constructor(
    private readonly claudePath: () => string,
    /** The task's latest Plan Queue transcript, shown once its session has stopped. */
    private readonly logFile: (planPath: string, taskId: string) => string | undefined,
  ) {
    this.closing = vscode.window.onDidCloseTerminal((t) => {
      for (const [key, o] of this.open) {
        if (o.terminal !== t) continue
        this.open.delete(key)
        if (o.review) stopSession(this.claudePath(), shortId(o.sessionId), o.review.cwd)
      }
      for (const [cwd, o] of this.trusting) if (o === t) this.trusting.delete(cwd)
    })
  }

  private mode(): Mode {
    return vscode.workspace.getConfiguration('planQueue').get<Mode>('sessionTerminals', 'onStart')
  }

  /**
   * Where a new terminal goes: an editor tab beside the files, as the Claude
   * Code extension opens a session, or the terminal panel. Opening one never
   * takes the keyboard; showing it does when asked to.
   */
  private location(): vscode.TerminalOptions['location'] {
    return vscode.workspace.getConfiguration('planQueue').get<string>('sessionTerminalLocation', 'editor') === 'panel'
      ? vscode.TerminalLocation.Panel
      : { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }
  }

  /**
   * A session came up or needs a person. Per planQueue.sessionTerminals, its
   * terminal is opened in the background as it starts, and brought forward —
   * without taking the keyboard — when it waits on a person.
   */
  onSession(e: {
    planPath: string
    taskId: string
    title: string
    sessionId: string
    cwd: string
    attention: boolean
    launched: boolean
  }): void {
    const mode = this.mode()
    const had = this.open.get(`${e.planPath}#${e.taskId}`)
    // Started again after it stopped: its tab, waiting in the loop, attaches again in place.
    if (e.launched && had?.looped && had.sessionId === e.sessionId && had.terminal.exitStatus === undefined) {
      had.terminal.sendText('', true)
    }
    if (mode === 'never' || (mode === 'whenNeeded' && !e.attention)) return
    const t = this.ensure(e)
    if (e.attention) t.show(true)
  }

  /**
   * Claude Code starts a background session only in a folder it trusts. While
   * one is needed, a terminal runs `claude` there, where its trust prompt is
   * answered; it is closed once the session has started.
   */
  trust(cwd: string, needed: boolean): void {
    const had = this.trusting.get(cwd)
    if (!needed) {
      had?.dispose()
      this.trusting.delete(cwd)
      return
    }
    if (had && had.exitStatus === undefined) return had.show(false)
    const terminal = vscode.window.createTerminal({
      name: `Trust · ${cwd.split(/[\\/]/).pop()}`,
      shellPath: this.claudePath(),
      cwd,
      iconPath: new vscode.ThemeIcon('shield'),
      location: this.location(),
      isTransient: true,
    })
    this.trusting.set(cwd, terminal)
    terminal.show(false)
  }

  /**
   * The task is over. One that passed has nothing left to look at: its tab
   * closes. One that failed keeps its tab, attached again — which wakes its
   * stopped session — so the whole conversation is there to review, in Claude
   * Code itself; closing the tab stops it again.
   */
  ended(e: { planPath: string; taskId: string; title: string; sessionId: string; cwd: string; ok: boolean }): void {
    const key = `${e.planPath}#${e.taskId}`
    const had = this.open.get(key)
    if (e.ok) {
      had?.terminal.dispose()
      this.open.delete(key)
      return
    }
    if (this.mode() === 'never' && !had) return
    this.review(e, false)
  }

  /** A failed task's stopped session, woken in its tab to look through. */
  review(e: { planPath: string; taskId: string; title: string; sessionId: string; cwd: string }, focus: boolean): void {
    const had = this.open.get(`${e.planPath}#${e.taskId}`)
    if (had?.looped && had.sessionId === e.sessionId && had.terminal.exitStatus === undefined) {
      // Already reviewing: just show it. Otherwise the loop is waiting on Enter
      // once `claude attach` has finished exiting.
      if (!had.review) {
        had.review = { cwd: e.cwd }
        setTimeout(() => had.terminal.sendText('', true), 1500)
      }
      had.terminal.show(!focus)
      return
    }
    const t = this.ensure(e)
    const now = this.open.get(`${e.planPath}#${e.taskId}`)
    if (now) now.review = { cwd: e.cwd }
    t.show(!focus)
  }

  /** Open the task's session in a terminal and put the cursor in it. */
  show(e: { planPath: string; taskId: string; title: string; sessionId: string; cwd: string }): void {
    this.ensure(e).show(false)
  }

  private ensure(e: { planPath: string; taskId: string; title: string; sessionId: string; cwd: string }): vscode.Terminal {
    const key = `${e.planPath}#${e.taskId}`
    const had = this.open.get(key)
    // The same session's tab is kept; another run of the task gets a tab of its own.
    if (had && had.sessionId === e.sessionId && had.terminal.exitStatus === undefined) return had.terminal
    had?.terminal.dispose()
    // No sh on Windows: there the tab closes with the session.
    const looped = process.platform !== 'win32'
    const terminal = vscode.window.createTerminal({
      name: `${e.taskId} · ${e.title}`,
      ...(looped
        ? {
            shellPath: '/bin/sh',
            shellArgs: [
              '-c',
              ATTACH_LOOP,
              this.claudePath(),
              shortId(e.sessionId),
              this.logFile(e.planPath, e.taskId) ?? '',
              e.sessionId,
            ],
          }
        : { shellPath: this.claudePath(), shellArgs: ['attach', shortId(e.sessionId)] }),
      cwd: e.cwd,
      iconPath: new vscode.ThemeIcon('hubot'),
      location: this.location(),
      // A reload restores nothing: the queue opens what it still runs.
      isTransient: true,
    })
    this.open.set(key, { terminal, sessionId: e.sessionId, looped })
    return terminal
  }

  dispose(): void {
    this.closing.dispose()
    // Sessions woken for review outlive the window otherwise.
    for (const o of this.open.values()) {
      if (o.review) stopSession(this.claudePath(), shortId(o.sessionId), o.review.cwd)
    }
  }
}
