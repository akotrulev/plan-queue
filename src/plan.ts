import * as fs from 'fs/promises'
import * as crypto from 'crypto'

export interface Task {
  /** The heading's id, e.g. "T3". Stable across edits; it is what order and status key on. */
  id: string
  title: string
  /** The agent named in the heading's trailing parens, e.g. "fe-react". Empty when none. */
  agent: string
  /** The blockquote body, unwrapped. This is the prompt, verbatim. */
  prompt: string
  /** sha1 of the prompt, so a task rewritten by an earlier task is visible as changed. */
  hash: string
  /** 1-based line of the task's heading, for "open the prompt in the plan". */
  line: number
}

export interface Plan {
  /** Absolute path. */
  path: string
  title: string
  tasks: Task[]
}

const PROMPTS_HEADING = /^##\s+Prompts\b/i
const TASK_HEADING = /^###\s+(.+)$/
const ANY_H2 = /^##\s/

/** "T3 — the PDP, the cart page (`fe-react`, `fe`)" -> id, title, agent. */
function parseHeading(text: string): { id: string; title: string; agent: string } {
  // Some plans write "### Prompt B1 — …" or "### Task 4 — …".
  let rest = text.trim().replace(/^(prompt|task)\s+/i, '')

  // A trailing "(`agent`, `stack`)" names the agent. A trailing parenthetical
  // that is anything else — "(§9)", "(see below)" — belongs to the title.
  let agent = ''
  const parens = rest.match(/\(([^)]*)\)\s*$/)
  if (parens) {
    const candidate = parens[1].split(',')[0].replace(/`/g, '').trim()
    if (/^[a-z][a-z0-9]*(?:[:_-][a-z0-9]+)*$/i.test(candidate)) {
      agent = candidate
      rest = rest.slice(0, parens.index).trim()
    }
  }

  // The id is the first token; the separator after it is an em dash, en dash or hyphen.
  const split = rest.match(/^(\S+)\s*[—–-]\s*(.*)$/)
  const id = (split ? split[1] : rest.split(/\s+/)[0]).replace(/[`:.]/g, '').trim()
  const title = split ? split[2].trim() : ''

  return { id, title, agent }
}

function trim(lines: string[]): string[] {
  const out = [...lines]
  while (out.length && out[0].trim() === '') out.shift()
  while (out.length && out[out.length - 1].trim() === '') out.pop()
  return out
}

/**
 * The prompt under a task heading, in either shape plans use: a blockquote, or
 * a fenced code block. Prose under the heading is neither — that is a
 * placeholder for a prompt somebody has not written yet, and it is not a task.
 */
function extractPrompt(lines: string[]): string | undefined {
  const body = trim(lines)
  if (!body.length) return undefined

  if (body[0].startsWith('>')) {
    // Lines that drop out of the quote (a fenced block inside it) are kept as-is.
    return trim(body.map((l) => (l.startsWith('>') ? l.replace(/^>\s?/, '') : l))).join('\n')
  }

  const fence = body[0].match(/^(`{3,}|~{3,})/)
  if (fence) {
    const close = new RegExp(`^${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`)
    const end = body.findIndex((l, i) => i > 0 && close.test(l))
    return trim(body.slice(1, end < 0 ? undefined : end)).join('\n')
  }

  return undefined
}

export function parsePlanText(text: string, path: string): Plan {
  const lines = text.split(/\r?\n/)
  const tasks: Task[] = []

  let title = path.split('/').pop() ?? path
  const h1 = lines.find((l) => /^#\s/.test(l))
  if (h1) title = h1.replace(/^#\s+/, '').trim()

  let inPrompts = false
  let current: { id: string; title: string; agent: string; line: number } | null = null
  let buffer: string[] = []

  const flush = () => {
    if (!current) return
    const prompt = extractPrompt(buffer)
    if (prompt && prompt.trim()) {
      tasks.push({
        ...current,
        prompt,
        hash: crypto.createHash('sha1').update(prompt).digest('hex').slice(0, 12),
      })
    }
    current = null
    buffer = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (ANY_H2.test(line)) {
      flush()
      inPrompts = PROMPTS_HEADING.test(line)
      continue
    }
    if (!inPrompts) continue

    const heading = line.match(TASK_HEADING)
    if (heading) {
      flush()
      const parsed = parseHeading(heading[1])
      // "### B1, C1, C2" names three prompts nobody has written yet, not a task.
      if (parsed.id && !parsed.id.includes(',')) current = { ...parsed, line: i + 1 }
      continue
    }
    if (current) buffer.push(line)
  }
  flush()

  return { path, title, tasks }
}

export async function readPlan(path: string): Promise<Plan> {
  return parsePlanText(await fs.readFile(path, 'utf8'), path)
}

/** True when the file is worth listing at all. */
export function looksLikeAPlan(text: string): boolean {
  return text.split(/\r?\n/).some((l) => PROMPTS_HEADING.test(l))
}
