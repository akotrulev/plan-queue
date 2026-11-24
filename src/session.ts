import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * Reading Claude Code's background sessions from the outside: what
 * `claude agents --json` says about them, and what their transcript says
 * happened. Kept apart from VS Code so it can be tested on its own.
 */

/** One row of `claude agents --json --all`. */
export interface SessionEntry {
  /** The short id `claude attach`, `stop` and `rm` take: the session id's first eight characters. */
  id: string
  sessionId: string
  name?: string
  cwd?: string
  kind?: string
  /** Set while the session's process is alive. */
  pid?: number
  /** 'working', 'blocked' (a permission prompt or a question waits on a person) or 'done' (the turn ended). */
  state?: string
}

export function parseAgents(json: string): SessionEntry[] {
  let rows: unknown
  try {
    rows = JSON.parse(json)
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  const out: SessionEntry[] = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    if (typeof o.sessionId !== 'string') continue
    out.push({
      id: typeof o.id === 'string' ? o.id : o.sessionId.slice(0, 8),
      sessionId: o.sessionId,
      name: typeof o.name === 'string' ? o.name : undefined,
      cwd: typeof o.cwd === 'string' ? o.cwd : undefined,
      kind: typeof o.kind === 'string' ? o.kind : undefined,
      pid: typeof o.pid === 'number' ? o.pid : undefined,
      state: typeof o.state === 'string' ? o.state : undefined,
    })
  }
  return out
}

/** The short id from what `claude --bg` prints: `backgrounded · c6fa6816 · name`. */
export function parseBackgrounded(stdout: string): string | undefined {
  return stdout.match(/backgrounded\s*·\s*([0-9a-f]{6,})/)?.[1]
}

/** The short id of a session id, as `claude attach` takes it. */
export const shortId = (sessionId: string) => sessionId.slice(0, 8)

/** Where Claude Code keeps a session's transcript, or undefined when it is not there (yet). */
export function transcriptPath(cwd: string, sessionId: string, configDir = defaultConfigDir()): string | undefined {
  const projects = path.join(configDir, 'projects')
  const guess = path.join(projects, cwd.replace(/[^A-Za-z0-9]/g, '-'), `${sessionId}.jsonl`)
  if (fs.existsSync(guess)) return guess
  try {
    for (const dir of fs.readdirSync(projects)) {
      const p = path.join(projects, dir, `${sessionId}.jsonl`)
      if (fs.existsSync(p)) return p
    }
  } catch {
    // No projects folder.
  }
  return undefined
}

function defaultConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
}

/** What a transcript line means to the queue's log. */
export type TranscriptEvent =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; name: string; input: unknown }
  | { kind: 'toolError'; text: string }
  /** A person's message: typed into the session, or sent by the queue. */
  | { kind: 'prompt'; text: string }
  /** The turn ended: Claude Code wrote its turn summary. */
  | { kind: 'turnEnd' }

/** An AskUserQuestion call as plain text: each question, then its options. */
export function askText(input: unknown): string {
  const qs = (input as { questions?: unknown })?.questions
  if (!Array.isArray(qs)) return 'It is asking you something in its session.'
  return qs
    .map((q) => {
      const options = Array.isArray(q?.options)
        ? q.options.map((o: { label?: unknown }) => String(o?.label ?? '')).filter(Boolean)
        : []
      return `${String(q?.question ?? '')}${options.length ? `\n  — ${options.join(' / ')}` : ''}`
    })
    .join('\n')
}

/** Text of a tool result or message content, wherever it sits. */
export function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).filter(Boolean).join('\n')
  }
  return ''
}

/**
 * Reads a transcript as it grows, from a byte offset on. Keeps what the queue
 * needs at a turn's end: the last assistant message's text, whether it was an
 * API error, and the session's running cost.
 */
export class TranscriptReader {
  private partial = ''
  /** The id of the last assistant message seen, and its text so far (one line per content block). */
  private lastId: string | undefined
  private lastText = ''
  /** The last assistant message was an API error the CLI wrote in place of a reply. */
  lastIsError = false
  /** An AskUserQuestion the session is showing and nobody has answered yet, as text. */
  pendingAsk: string | undefined
  private pendingAskId: string | undefined
  /** `totalCostUSD` of the last cost-state line read. */
  costUsd: number | undefined

  constructor(
    /** Read on demand, so a transcript that does not exist yet is found once it does. */
    private readonly locate: () => string | undefined,
    public offset = 0,
  ) {}

  /** The final message of the turn, as `--print` would have returned it. */
  get finalText(): string {
    return this.lastText
  }

  /** The file's size now, to start a reader at its end. */
  static sizeOf(file: string | undefined): number {
    try {
      return file ? fs.statSync(file).size : 0
    } catch {
      return 0
    }
  }

  /** Whatever was appended since the last read. */
  read(): TranscriptEvent[] {
    const file = this.locate()
    if (!file) return []
    let chunk = ''
    try {
      const size = fs.statSync(file).size
      if (size < this.offset) this.offset = 0
      if (size === this.offset) return []
      const fd = fs.openSync(file, 'r')
      try {
        const buf = Buffer.alloc(size - this.offset)
        fs.readSync(fd, buf, 0, buf.length, this.offset)
        this.offset = size
        chunk = buf.toString('utf8')
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return []
    }
    const text = this.partial + chunk
    const lines = text.split('\n')
    this.partial = lines.pop() ?? ''
    const events: TranscriptEvent[] = []
    for (const line of lines) if (line.trim()) this.take(line, events)
    return events
  }

  /** One line, appended to `events`. Public for tests. */
  take(line: string, events: TranscriptEvent[] = []): TranscriptEvent[] {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      return events
    }
    if (msg.type === 'cost-state' && typeof msg.totalCostUSD === 'number') {
      this.costUsd = msg.totalCostUSD
    } else if (msg.type === 'system' && msg.subtype === 'turn_duration') {
      events.push({ kind: 'turnEnd' })
    } else if (msg.type === 'assistant' && !msg.isSidechain) {
      const id = msg.message?.id
      if (id !== this.lastId) {
        this.lastId = id
        this.lastText = ''
      }
      this.lastIsError = msg.isApiErrorMessage === true || msg.error !== undefined
      for (const b of Array.isArray(msg.message?.content) ? msg.message.content : []) {
        if (b?.type === 'text' && typeof b.text === 'string') {
          this.lastText = this.lastText ? `${this.lastText}\n${b.text}` : b.text
          events.push({ kind: 'text', text: b.text })
        } else if (b?.type === 'thinking' && typeof b.thinking === 'string' && b.thinking) {
          events.push({ kind: 'thinking', text: b.thinking })
        } else if (b?.type === 'tool_use') {
          events.push({ kind: 'tool', name: String(b.name ?? ''), input: b.input })
          if (b.name === 'AskUserQuestion') {
            this.pendingAsk = askText(b.input)
            this.pendingAskId = b.id
          }
        }
      }
    } else if (msg.type === 'user' && !msg.isSidechain && !msg.isMeta) {
      const content = msg.message?.content
      if (typeof content === 'string') {
        // Command output and the like ride in user lines wrapped in tags; a person's message does not.
        if (content.trim() && !content.trimStart().startsWith('<')) events.push({ kind: 'prompt', text: content })
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'tool_result' && this.pendingAskId !== undefined && b.tool_use_id === this.pendingAskId) {
            this.pendingAsk = undefined
            this.pendingAskId = undefined
          }
          if (b?.type === 'tool_result' && b.is_error) {
            events.push({ kind: 'toolError', text: contentText(b.content) })
          } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim() && !b.text.trimStart().startsWith('<')) {
            events.push({ kind: 'prompt', text: b.text })
          }
        }
      }
    }
    return events
  }
}
