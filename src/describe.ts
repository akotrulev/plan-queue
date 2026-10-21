import * as path from 'path'

/**
 * Plain-text helpers for the log and for what the queue says to a task. No
 * VS Code here, so they can be tested on their own.
 */

function clip(text: string, max: number): string {
  const one = text.replace(/\s*\n\s*/g, ' ⏎ ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

/** One line for a tool call: what it ran or touched, not just its name. */
export function toolSummary(name: string, input: any, cwd: string): string {
  const rel = (p: unknown) => {
    if (typeof p !== 'string') return ''
    const r = path.relative(cwd, p)
    return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : p
  }
  const i = input ?? {}
  switch (name) {
    case 'Bash':
      return `$ ${clip(String(i.command ?? ''), 160)}`
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return `${name} ${rel(i.file_path ?? i.notebook_path)}`
    case 'Grep':
      return `Grep ${clip(String(i.pattern ?? ''), 80)}${i.path ? ` in ${rel(i.path)}` : ''}`
    case 'Glob':
      return `Glob ${clip(String(i.pattern ?? ''), 80)}`
    case 'WebFetch':
      return `WebFetch ${clip(String(i.url ?? ''), 120)}`
    case 'WebSearch':
      return `WebSearch ${clip(String(i.query ?? ''), 120)}`
    case 'Task':
    case 'Agent':
      return `${name} ${clip(String(i.description ?? i.subagent_type ?? ''), 100)}`
    case 'TodoWrite':
      return 'TodoWrite'
    default: {
      const json = JSON.stringify(i)
      return json && json !== '{}' ? `${name} ${clip(json, 120)}` : name
    }
  }
}

/** Leading `FOO=bar` assignments are not the command. */
function firstCommand(command: string): string | undefined {
  const tokens = command.trim().split(/\s+/)
  return tokens.find((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t))
}

/**
 * The allowlist entry that would have let a denied call through, in the shape
 * `--allowedTools` takes: `Bash(terraform:*)` for a command, the tool's name
 * for anything else.
 */
export function allowRuleFor(denial: { tool_name?: string; tool_input?: any }): string | undefined {
  const name = denial.tool_name
  if (!name) return undefined
  if (name === 'Bash') {
    const cmd = firstCommand(String(denial.tool_input?.command ?? ''))
    if (!cmd) return undefined
    // `./scripts/x.sh` and `/usr/bin/x` are allowed by their path.
    return `Bash(${cmd.replace(/[()]/g, '')}:*)`
  }
  return name
}

/** What the task is told when the queue's gate fails after it said it was done. */
export function gateFixPrompt(command: string, output: string, attempt: number, of: number): string {
  return [
    `The queue ran its gate after your task and it failed (attempt ${attempt} of ${of}):`,
    '',
    '```',
    `$ ${command}`,
    output.trim() || '(no output)',
    '```',
    '',
    'Fix what made it fail — not the gate — and run the gate yourself before you finish.',
    'End as before: a line "PLAN_QUEUE: DONE" when it passes, or "PLAN_QUEUE: BLOCKED <reason>" when you cannot make it pass.',
  ].join('\n')
}

/** Keeps the last lines of a stream, for handing a gate's output back to a task. */
export class Tail {
  private text = ''
  constructor(private readonly maxChars = 12_000) {}

  push(chunk: string): void {
    this.text += chunk
    if (this.text.length > this.maxChars * 2) this.text = this.text.slice(-this.maxChars)
  }

  toString(): string {
    const t = this.text.length > this.maxChars ? this.text.slice(-this.maxChars) : this.text
    const cut = t.length < this.text.length ? t.indexOf('\n') + 1 : 0
    return (cut ? '…\n' : '') + t.slice(cut)
  }
}
