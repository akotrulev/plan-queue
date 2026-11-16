/**
 * Usage limits and transient API errors, read from what the CLI prints. Kept
 * apart from the runner, which needs VS Code, so it can be tested on its own.
 */

export type LimitStatus = 'allowed' | 'allowed_warning' | 'rejected'

export interface LimitInfo {
  status: LimitStatus
  /** When the window resets, as a millisecond epoch. */
  resetsAt?: number
  /** `five_hour`, `seven_day`, `seven_day_opus`, … */
  type?: string
  /** How much of the window is used, 0..1. */
  utilization?: number
}

const STATUSES: readonly string[] = ['allowed', 'allowed_warning', 'rejected']

/** A fraction, or a percentage the CLI sent as 0..100; absent when it is neither. */
function fraction(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined
  return v > 1 ? Math.min(v / 100, 1) : v
}

/**
 * A `rate_limit_event` message from `--output-format stream-json`:
 * `{type, rate_limit_info: {status, resetsAt (epoch seconds), rateLimitType, utilization?, ...}}`.
 * Parsed defensively: whatever is missing or unreadable is left out.
 */
export function parseRateLimitEvent(msg: unknown): LimitInfo | undefined {
  if (!msg || typeof msg !== 'object') return undefined
  const m = msg as Record<string, unknown>
  if (m.type !== 'rate_limit_event') return undefined
  const raw = m.rate_limit_info
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.status !== 'string' || !STATUSES.includes(r.status)) return undefined

  let status = r.status as LimitStatus
  // Paid extra usage is covering the window: requests still go through.
  if (status === 'rejected' && r.isUsingOverage === true) status = 'allowed'

  const info: LimitInfo = { status }
  if (typeof r.resetsAt === 'number' && Number.isFinite(r.resetsAt) && r.resetsAt > 0) {
    // Seconds, but tolerate milliseconds.
    info.resetsAt = r.resetsAt < 1e11 ? Math.round(r.resetsAt * 1000) : Math.round(r.resetsAt)
  }
  if (typeof r.rateLimitType === 'string' && r.rateLimitType) info.type = r.rateLimitType
  const u = fraction(r.utilization) ?? fraction(r.surpassedThreshold)
  if (u !== undefined) info.utilization = u
  return info
}

const LIMIT_TEXT = /you['’]ve hit your (?:[\w-]+ )?limit|hit your (?:usage )?limit|usage limit reached|(?:five|5)[- ]hour limit reached|weekly limit reached/i

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

interface Wall {
  y: number
  mo: number // 0-11
  d: number
  h: number
  mi: number
}

/** The wall clock in `zone` at `ms`; undefined for a zone Intl does not know. */
function wallIn(ms: number, zone: string): Wall | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    }).formatToParts(new Date(ms))
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value)
    const w = { y: get('year'), mo: get('month') - 1, d: get('day'), h: get('hour') % 24, mi: get('minute') }
    return Object.values(w).every(Number.isFinite) ? w : undefined
  } catch {
    return undefined
  }
}

/** The instant at which the wall clock in `zone` reads `w`; undefined for an unknown zone. */
function instantIn(w: Wall, zone: string): number | undefined {
  const guess = Date.UTC(w.y, w.mo, w.d, w.h, w.mi)
  let t = guess
  // The zone's offset depends on the instant; two passes settle it, DST edges included.
  for (let i = 0; i < 2; i++) {
    const seen = wallIn(t, zone)
    if (!seen) return undefined
    t += guess - Date.UTC(seen.y, seen.mo, seen.d, seen.h, seen.mi)
  }
  return t
}

/** The same, in the machine's own zone. */
function instantLocal(w: Wall): number {
  return new Date(w.y, w.mo, w.d, w.h, w.mi, 0, 0).getTime()
}

/**
 * When the clock next reads `hour:minute` after `now` — on `month`/`day` when
 * given, else today or tomorrow — in `zone`, or local time without one.
 */
function nextReset(now: number, hour: number, minute: number, zone?: string, month?: number, day?: number): number | undefined {
  const here = (zone ? wallIn(now, zone) : undefined) ?? (() => {
    const d = new Date(now)
    return { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes() }
  })()
  const useZone = zone && wallIn(now, zone) ? zone : undefined
  const at = (y: number, mo: number, d: number) => {
    const w = { y, mo, d, h: hour, mi: minute }
    return useZone ? instantIn(w, useZone) : instantLocal(w)
  }
  if (month !== undefined && day !== undefined) {
    let t = at(here.y, month, day)
    // A date already past (by more than a day, to forgive clock skew) means next year.
    if (t !== undefined && t < now - 86_400_000) t = at(here.y + 1, month, day)
    return t
  }
  const today = at(here.y, here.mo, here.d)
  if (today !== undefined && today > now) return today
  return at(here.y, here.mo, here.d + 1)
}

/** How long to wait when a weekly or 7-day limit gives no reset time. */
export const WEEKLY_FALLBACK_MS = 6 * 3_600_000

const CLOCK = new RegExp(
  String.raw`resets?\s+(?:at\s+)?(?:(?:on\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:at\s+)?)?` +
    String.raw`(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?m\.?)?(?![\w:])\s*(?:\(([A-Za-z][\w+\-]*(?:\/[\w+\-]+)*)\))?`,
  'i',
)

/**
 * A limit the CLI printed as text: "You've hit your limit · resets 3am",
 * "resets 3:30pm (Europe/Sofia)", "resets Nov 21, 10am (Europe/Sofia)",
 * "resets 15:30", "Claude AI usage limit reached|1760000000".
 * The reset time, when there is one, is the next such time after `now`, in the
 * zone named in parentheses or, without one, local time. When no time can be
 * read, a weekly limit gets a longer wait than a five-hour one.
 */
export function limitFromText(text: string, now: number): LimitInfo | undefined {
  if (!LIMIT_TEXT.test(text)) return undefined
  const info: LimitInfo = { status: 'rejected' }

  const epoch = text.match(/usage limit reached\|(\d{9,13})/i)
  if (epoch) {
    const n = Number(epoch[1])
    info.resetsAt = n < 1e11 ? n * 1000 : n
    return info
  }
  const lower = text.toLowerCase()
  const weekly = /weekly|seven[_ -]day|7[- ]day/.test(lower)
  if (weekly) info.type = 'seven_day'
  else if (/five[_ -]hour|5[- ]hour/.test(lower)) info.type = 'five_hour'

  const m = text.match(CLOCK)
  if (m) {
    const month = m[1] ? MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) : undefined
    const day = m[2] ? Number(m[2]) : undefined
    const meridiem = m[5]?.toLowerCase()
    let h = Number(m[3])
    const min = m[4] ? Number(m[4]) : 0
    // "3am", "3:30pm", or a 24-hour "15:30"; a bare number is not a time.
    let valid = min < 60 && (meridiem ? h >= 1 && h <= 12 : m[4] !== undefined && h <= 23)
    if (m[1] && (month === undefined || month < 0 || day === undefined || day < 1 || day > 31)) valid = false
    if (valid) {
      if (meridiem) h = (h % 12) + (meridiem === 'p' ? 12 : 0)
      const at = nextReset(now, h, min, m[6], month !== undefined && month >= 0 ? month : undefined, day)
      if (at !== undefined) info.resetsAt = at
    }
  }
  if (info.resetsAt === undefined && weekly) info.resetsAt = now + WEEKLY_FALLBACK_MS
  return info
}

/**
 * Errors worth retrying: overloaded, a 5xx, a dropped connection. A 4xx — a
 * prompt too long, a bad key — is not, however the CLI words it.
 */
const TRANSIENT =
  /overloaded|\b(?:api error|http|status(?: code)?)\W{0,4}5\d\d\b|\b5\d\d\s+(?:internal server error|bad gateway|service unavailable|gateway time-?out)|econnreset|etimedout|econnrefused|enotfound|eai_again|fetch failed|request timed out|socket hang up|connection error|internal server error|bad gateway|service unavailable|gateway time-?out/i
const CLIENT_ERROR = /\b(?:api error|http|status(?: code)?)\W{0,4}4\d\d\b/i

/** An error worth retrying in a while. Never a usage limit. */
export function isTransient(text: string): boolean {
  if (!text) return false
  if (LIMIT_TEXT.test(text) || /rate[_ ]limit/i.test(text)) return false
  if (CLIENT_ERROR.test(text)) return false
  return TRANSIENT.test(text)
}

interface Entry {
  info: LimitInfo
  seenAt: number
}

export interface BlockOptions {
  /** 0..1; a warning at or past this blocks until the window resets. 0 is off. */
  startThreshold: number
  /** How long a rejection with no reset time blocks for. */
  fallbackMs: number
  /** Added to a known reset time, so a start waits out the same buffer a resume does. */
  resumeDelayMs?: number
}

export interface GateSnapshot {
  entries: { type: string; info: LimitInfo; seenAt: number }[]
}

/** What the account's limits say right now, per window; the longest block wins. */
export class LimitGate {
  private entries = new Map<string, Entry>()

  constructor(private readonly clock: () => number = Date.now) {}

  observe(info: LimitInfo): void {
    const key = info.type ?? 'unknown'
    const prev = this.entries.get(key)
    const now = this.clock()
    if (info.status === 'allowed') {
      this.entries.delete(key)
      return
    }
    // A warning does not demote a window that is still rejected.
    if (info.status === 'allowed_warning' && prev?.info.status === 'rejected' && (prev.info.resetsAt ?? Infinity) > now) return
    this.entries.set(key, { info: { ...info }, seenAt: now })
  }

  /** When this window stops blocking, or undefined when it does not block at all. */
  private endOf({ info, seenAt }: Entry, opts: BlockOptions): number | undefined {
    const delay = opts.resumeDelayMs ?? 0
    if (info.status === 'rejected') return info.resetsAt !== undefined ? info.resetsAt + delay : seenAt + opts.fallbackMs
    if (info.status === 'allowed_warning' && opts.startThreshold > 0 && (info.utilization ?? 0) >= opts.startThreshold) {
      return info.resetsAt !== undefined ? info.resetsAt + delay : undefined
    }
    return undefined
  }

  blockedUntil(opts: BlockOptions): number | undefined {
    const now = this.clock()
    let until: number | undefined
    for (const e of this.entries.values()) {
      const t = this.endOf(e, opts)
      if (t !== undefined && t > now && (until === undefined || t > until)) until = t
    }
    return until
  }

  /** When the longest block that was ever in force ends, expired or not; undefined when none was. */
  lastBlockEnd(opts: BlockOptions): number | undefined {
    let end: number | undefined
    for (const e of this.entries.values()) {
      const t = this.endOf(e, opts)
      if (t !== undefined && (end === undefined || t > end)) end = t
    }
    return end
  }

  /** The window behind the longest block. */
  blockedType(opts: BlockOptions): string | undefined {
    const now = this.clock()
    let best: { t: number; type?: string } | undefined
    for (const [key, { info, seenAt }] of this.entries) {
      const probe = new LimitGate(this.clock)
      probe.entries.set(key, { info, seenAt })
      const t = probe.blockedUntil(opts)
      if (t !== undefined && t > now && (!best || t > best.t)) best = { t, type: info.type }
    }
    return best?.type
  }

  clear(): void {
    this.entries.clear()
  }

  /** Forget windows whose reset has passed. */
  prune(): void {
    const now = this.clock()
    for (const [k, { info, seenAt }] of this.entries) {
      const end = info.resetsAt ?? (info.status === 'rejected' ? undefined : seenAt)
      if (end !== undefined && end <= now) this.entries.delete(k)
    }
  }

  snapshot(): GateSnapshot {
    return { entries: [...this.entries].map(([type, e]) => ({ type, info: e.info, seenAt: e.seenAt })) }
  }

  static restore(snapshot: GateSnapshot | undefined, clock: () => number = Date.now): LimitGate {
    const gate = new LimitGate(clock)
    for (const e of snapshot?.entries ?? []) {
      if (e && typeof e.type === 'string' && e.info && STATUSES.includes(e.info.status) && typeof e.seenAt === 'number') {
        gate.entries.set(e.type, { info: e.info, seenAt: e.seenAt })
      }
    }
    return gate
  }
}
