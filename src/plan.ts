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
  /**
   * Ids named by a `Depends on:` line in the prompt. Undefined when the prompt
   * declares none, which means "after everything before me"; an empty list
   * (`Depends on: none`) means "free to start now".
   */
  deps?: string[]
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
  /** Ids used by more than one heading. Only the first is a task; status and order key on the id. */
  duplicates: string[]
  /**
   * Plans named by a `Runs after:` line outside the prompts, e.g. `156` or
   * `156-next-step`. When the last of them merges, this plan starts by itself.
   * Undefined when the plan has no such line.
   */
  runsAfter?: string[]
}

const PROMPTS_HEADING = /^##\s+Prompts\b/i
const TASK_HEADING = /^###\s+(.+)$/
const ANY_H2 = /^##\s/

const DEPENDS_ON = /^\s*(?:[-*]\s+)?\**\s*depends\s+on\s*:?\s*\**\s*:?\s*(.+?)\s*$/im
const NOTHING = /^(none|nothing|nil|n\/a|-|—|–)$/i
// The colon is required, so a sentence that starts "Runs after the …" is prose.
const RUNS_AFTER = /^\s*(?:[-*]\s+)?\**\s*runs\s+after\s*(?:\**\s*:|:\s*\**)\s*(.+?)\s*$/i

/**
 * The plans on a `Runs after:` line. Only the leading list counts: names
 * separated by commas, `&` or `and`, each a single word (a leading "plan" is
 * dropped). The first part that is a phrase ends the list, so
 * `159 (the whole plan), which itself runs after 156` names 159 alone.
 */
export function parseRunsAfter(line: string): string[] | undefined {
  const m = line.match(RUNS_AFTER)
  if (!m) return undefined
  // A full stop ends the list: "156. Plan Queue starts this …" names 156.
  const text = m[1]
    .split(/\.(?:\s|$)/)[0]
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[`*_\[\]]/g, ' ')
  const refs: string[] = []
  for (const part of text.split(/\s*(?:[,;&]|\band\b)\s*/i)) {
    const words = part.trim().replace(/[.:]+$/, '').split(/\s+/).filter(Boolean)
    if (!words.length) continue
    if (words.length > 1 && /^plans?$/i.test(words[0])) words.shift()
    if (words.length !== 1) break
    if (NOTHING.test(words[0])) break
    refs.push(words[0])
  }
  return refs
}

/** The ids on a `Depends on:` line, or undefined when the prompt has none. */
export function parseDeps(prompt: string): string[] | undefined {
  const m = prompt.match(DEPENDS_ON)
  if (!m) return undefined
  const tokens = m[1]
    .replace(/[`*_()\[\]]/g, ' ')
    .split(/[\s,;&]+/)
    .map((t) => t.replace(/[.:]+$/, ''))
    .filter(Boolean)
  if (tokens.length === 1 && NOTHING.test(tokens[0])) return []
  return tokens.filter((t) => !/^(and|the|task|tasks|prompt|prompts)$/i.test(t))
}

/** "T3 — the PDP, the cart page (`fe-react`, `fe`)" -> id, title, agent. */
function parseHeading(text: string): { id: string; title: string; agent: string } {
  // Some plans write "### Prompt B1 — …" or "### Task 4 — …".
  let rest = text.trim().replace(/^(prompt|task)\s+/i, '')

  // A trailing "(`agent`, `stack`)" names the agent. A trailing parenthetical
  // that is anything else — "(§9)", "(see below)", "(wip)" — belongs to the title:
  // an agent is written in backticks, or paired with its stack.
  let agent = ''
  const parens = rest.match(/\(([^)]*)\)\s*$/)
  if (parens && /[`,]/.test(parens[1])) {
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
  const duplicates: string[] = []

  let title = path.split('/').pop() ?? path
  const h1 = lines.find((l) => /^#\s/.test(l))
  if (h1) title = h1.replace(/^#\s+/, '').trim()

  let inPrompts = false
  // Inside a code fence a `##` is content, not a heading. Fences quoted with `>` count.
  let fence: { ch: string; len: number } | null = null
  let current: { id: string; title: string; agent: string; line: number } | null = null
  let buffer: string[] = []
  let runsAfter: string[] | undefined

  const flush = () => {
    const head = current
    if (!head) return
    const prompt = extractPrompt(buffer)
    if (prompt && prompt.trim() && tasks.some((t) => t.id === head.id)) {
      if (!duplicates.includes(head.id)) duplicates.push(head.id)
    } else if (prompt && prompt.trim()) {
      tasks.push({
        ...head,
        prompt,
        deps: parseDeps(prompt),
        hash: crypto.createHash('sha1').update(prompt).digest('hex').slice(0, 12),
      })
    }
    current = null
    buffer = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const marker = line.replace(/^(\s*>)*\s*/, '').match(/^(`{3,}|~{3,})(.*)$/)
    if (fence) {
      if (marker && marker[1][0] === fence.ch && marker[1].length >= fence.len && !marker[2].trim()) fence = null
      if (inPrompts && current) buffer.push(line)
      continue
    }
    // A backtick fence's info string cannot contain a backtick: that is inline code.
    if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) {
      fence = { ch: marker[1][0], len: marker[1].length }
      if (inPrompts && current) buffer.push(line)
      continue
    }

    if (ANY_H2.test(line)) {
      flush()
      inPrompts = PROMPTS_HEADING.test(line)
      continue
    }
    if (!inPrompts) {
      if (!runsAfter) runsAfter = parseRunsAfter(line)
      continue
    }

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

  return { path, title, tasks, duplicates, ...(runsAfter ? { runsAfter } : {}) }
}

/**
 * `as` is the path the plan is known by. It differs from `path` when the file
 * read is the plan's copy in its worktree: status and order still key on the
 * original.
 */
export async function readPlan(path: string, as: string = path): Promise<Plan> {
  return parsePlanText(await fs.readFile(path, 'utf8'), as)
}

/** True when the file is worth listing at all. */
export function looksLikeAPlan(text: string): boolean {
  return text.split(/\r?\n/).some((l) => PROMPTS_HEADING.test(l))
}
