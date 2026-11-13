// One Claude Code session as the lot-map picture, read from its transcript. A command, not a server.
//
//   node companion/session-frame.ts --transcript /path/to/session.jsonl [--tail-bytes N] [--now <epoch ms>]
//       [--theme dark|light] [--stale-after-s N] [--language en]
//
// It reads the one file it is given (never "the newest", never a folder listing), builds the map's Board from the
// transcript's rows with the mod's own code (classify, setupFrom, drawMap, foldRows, describeNow from hooks/map.ts),
// and prints one JSON object. It reads only: no network, no file writes, no child processes, no npm dependency.
// A label is what `classify` or the mod's own words make of a call: a name, never content.
//
// Ideas taken from forks of alexeyw/lot-map (all MIT, Copyright (c) 2026 Aleksei Volodin; no fork code was run):
// - Samuel-VV-NL/lot-map companion/server.mjs: a transcript becomes a Board and the frame {svg, now, session, rows};
//   the resolver that adds `.ts` to the mod's extensionless imports. Rewritten here with node:module registerHooks and
//   limited to imports made from hooks/. Its newest-session targeting, HTTP server, browser launch and Wiki station
//   are not used.
// - chrisw-impactlab/lot-map branch dev-session-viewer (viewer/hooks/transcript.ts): viewing one named session from
//   its transcript; steps keyed by request id; a subagent's (isSidechain) calls start from Agents; a turn ends at the
//   `turn_duration` system row; a compaction is a row on Model; context a hook added shows when, never what.
// - isbeorn/lot-map codex/activity.ts: unfinished activity whose newest evidence is old reads "unknown", and the
//   picture is drawn as of the last evidence instead of moving on as if live.
// Timing lanes (isbeorn's drawLanes) are not built: see companion/README.md.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { registerHooks } from 'node:module'

import type { Board, Entry, StationId, Status } from '../types/index.d.ts'

// ---- the mod's own code -------------------------------------------------------------------------

// The mod's files import './text' without an extension, as its engine allows; Node needs the `.ts`.
// Only imports made from inside hooks/ are touched.
const HOOKS_URL = new URL('../hooks/', import.meta.url).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    const fromHooks = typeof context.parentURL === 'string' && context.parentURL.startsWith(HOOKS_URL)
    if (fromHooks && /^\.\.?\//.test(specifier) && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})
const lotMap: typeof import('../hooks/map.ts') = await import(new URL('../hooks/map.ts', import.meta.url).href)
const { classify, clean, describeNow, drawMap, foldRows, setupFrom, shortModel, taskNotice, taskOf } = lotMap
type Setup = ReturnType<typeof setupFrom>

// ---- arguments ----------------------------------------------------------------------------------

const MIB = 1024 * 1024
const LANGUAGES = new Set(['en', 'ru', 'es', 'fr', 'de', 'it', 'pt'])
/** How many entries the board keeps, as the mod does; counts go on counting. */
const KEEP = 80

type Options = {
  transcript: string
  tailBytes: number
  now: number | undefined
  theme: 'dark' | 'light' | undefined
  staleAfterS: number
  language: string
}

class Refusal extends Error {}

function parseArgs(argv: readonly string[]): Options {
  const seen = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    const m = /^--([a-z-]+)(?:=(.*))?$/s.exec(arg)
    if (m === null) throw new Refusal(`unexpected argument at position ${i + 1}`)
    const name = m[1] ?? ''
    if (!['transcript', 'tail-bytes', 'now', 'theme', 'stale-after-s', 'language'].includes(name)) throw new Refusal(`unknown option --${name}`)
    if (seen.has(name)) throw new Refusal(`--${name} given twice`)
    const value = m[2] ?? argv[++i]
    if (value === undefined || value === '') throw new Refusal(`--${name} needs a value`)
    seen.set(name, value)
  }
  const transcript = seen.get('transcript')
  if (transcript === undefined) throw new Refusal('--transcript is required')
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = seen.get(name)
    if (raw === undefined) return fallback
    if (!/^\d+$/.test(raw)) throw new Refusal(`--${name} must be a whole number`)
    const n = Number(raw)
    if (n < min || n > max) throw new Refusal(`--${name} must be between ${min} and ${max}`)
    return n
  }
  const theme = seen.get('theme')
  if (theme !== undefined && theme !== 'dark' && theme !== 'light') throw new Refusal('--theme must be dark or light')
  const language = seen.get('language') ?? 'en'
  if (!LANGUAGES.has(language)) throw new Refusal(`--language must be one of ${[...LANGUAGES].join(', ')}`)
  return {
    transcript,
    tailBytes: integer('tail-bytes', 8 * MIB, 1, 1024 * MIB),
    now: seen.has('now') ? integer('now', 0, 0, 8.64e15) : undefined,
    theme,
    staleAfterS: integer('stale-after-s', 600, 1, 7 * 24 * 3600),
    language,
  }
}

// ---- reading the end of one file ----------------------------------------------------------------

type Tail = {
  size: number
  start: number
  /** The lines read whole, in order. */
  lines: string[]
  /** The last line had no line end yet: the file was being written. */
  openEnd: boolean
}

/** The end of the file as it was when it was opened: from the first whole line inside the last `tailBytes`. */
function readTail(path: string, tailBytes: number): Tail {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    throw new Refusal(code === 'ENOENT' ? 'transcript not found' : `transcript cannot be opened (${code ?? 'error'})`)
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Refusal('transcript is not a regular file')
    // The size at this moment: what a live session writes afterwards waits for the next run.
    const size = stat.size
    if (size === 0) throw new Refusal('transcript is empty')
    const start = Math.max(0, size - tailBytes)
    const buf = Buffer.alloc(size - start)
    let got = 0
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got)
      if (n === 0) break
      got += n
    }
    let body = buf.subarray(0, got)
    if (start > 0) {
      // The read began inside a line: that line is not ours to guess at.
      const nl = body.indexOf(10)
      if (nl < 0) throw new Refusal(`no whole line in the last ${tailBytes} bytes`)
      body = body.subarray(nl + 1)
    }
    const text = body.toString('utf8')
    const openEnd = text.length > 0 && !text.endsWith('\n')
    const lines = text.split('\n')
    if (!openEnd) lines.pop()
    return { size, start, lines, openEnd }
  } finally {
    closeSync(fd)
  }
}

// ---- transcript rows into a Board ---------------------------------------------------------------

type Rec = Readonly<Record<string, unknown>>
const isObj = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const blocksOf = (rec: Rec): Rec[] => {
  const content = isObj(rec.message) ? rec.message.content : undefined
  return Array.isArray(content) ? content.filter(isObj) : []
}
const textOf = (rec: Rec): string => {
  const content = isObj(rec.message) ? rec.message.content : undefined
  if (typeof content === 'string') return content
  return blocksOf(rec).filter(b => b.type === 'text').map(b => str(b.text)).join('\n')
}
const isFault = (s: Status): boolean => s === 'err' || s === 'block'

/** The main loop's key; a subagent's loop is keyed by its agent id. */
const MAIN = ''

type Step = { entry: Entry; requestId: string; index: number }

class Reader {
  readonly board: Board & { entries: Entry[]; counts: Partial<Record<StationId, number>>; faults: Partial<Record<StationId, number>> }
  /** Calls without an answer yet, by tool_use id. */
  private readonly open = new Map<string, Entry>()
  private readonly toolName = new Map<string, string>()
  /** `Agent` calls still going: each is a subagent at work. */
  private readonly agentCalls = new Set<string>()
  /** Subagent loops whose own rows are in this file (isSidechain) and whose end was not read. */
  private readonly loops = new Set<string>()
  private readonly steps = new Map<string, Step>()
  private readonly checks = new Map<string, Entry>()
  private model: string | undefined
  /** Whether the main loop's turn is going, has ended, or was not seen start or end in the part read. */
  turn: 'unknown' | 'open' | 'ended' = 'unknown'
  private askedAt: number | undefined
  /** How long each answer took, from the message to it: the pane shows that one time on an answer's row. */
  readonly turnMs = new Map<string, number>()
  sessionId: string | undefined
  firstAt: number | undefined
  lastAt: number | undefined
  rows = 0
  unreadable = 0
  /** Results whose call was made before the part that was read. */
  orphans = 0
  lastInputTokens: number | undefined
  private ids = 0
  private readonly setup: Setup

  constructor(setup: Setup) {
    this.setup = setup
    this.board = { entries: [], counts: {}, faults: {}, agents: [] }
  }

  private add(start: Partial<Entry> & Pick<Entry, 'station' | 'label' | 'startedAt'>, id?: string, uncounted = false): Entry {
    const status = start.status ?? 'run'
    const entry: Entry = {
      id: id ?? `r${++this.ids}`,
      station: start.station,
      label: clean(start.label),
      from: start.from ?? 'core',
      startedAt: start.startedAt,
      status,
      ...(status !== 'run' ? { endedAt: start.endedAt ?? start.startedAt } : {}),
      ...(start.agentId !== undefined ? { agentId: start.agentId } : {}),
      ...(start.mark !== undefined ? { mark: start.mark } : {}),
    }
    const b = this.board
    b.entries.push(entry)
    if (b.entries.length > KEEP) {
      // The newest rows, and beside them every background task still going, as the mod keeps them.
      const from = b.entries.length - KEEP
      b.entries = b.entries.filter((e, i) => i >= from || (e.status === 'run' && e.task !== undefined))
    }
    if (!uncounted) b.counts[entry.station] = (b.counts[entry.station] ?? 0) + 1
    if (isFault(status) && entry.station !== 'you') b.faults[entry.station] = (b.faults[entry.station] ?? 0) + 1
    return entry
  }

  private close(entry: Entry | undefined, status: Status, at: number): void {
    if (entry === undefined || entry.status !== 'run') return
    entry.status = status
    entry.endedAt = Math.max(at, entry.startedAt)
    if (isFault(status) && entry.station !== 'you') this.board.faults[entry.station] = (this.board.faults[entry.station] ?? 0) + 1
  }

  /** Calls of the main loop that never reported back and started no background task: a turn that ended ends them. */
  private closeCoreRuns(at: number): void {
    for (const e of this.board.entries) if (e.status === 'run' && e.from === 'core' && e.task === undefined) this.close(e, 'ok', at)
    for (const [id, e] of this.open) if (e.status !== 'run') this.open.delete(id)
    for (const id of [...this.agentCalls]) if (this.open.get(id) === undefined) this.agentCalls.delete(id)
  }

  /** A subagent loop is over: it leaves Agents, and a call of its that never reported back ends. */
  private endLoop(loop: string, at: number): void {
    if (!this.loops.delete(loop)) return
    for (const e of this.board.entries) if (e.status === 'run' && e.agentId === loop) this.close(e, 'ok', at)
  }

  private settle(task: string, status: Status, at: number): void {
    const held = this.board.entries.find(e => e.task === task && e.status === 'run')
    if (held !== undefined) {
      this.close(held, status, at)
      for (const [id, e] of this.open) if (e === held) {
        this.open.delete(id)
        this.agentCalls.delete(id)
      }
    }
    this.endLoop(task, at)
  }

  private step(loop: string, requestId: string, model: string, at: number): void {
    const before = this.steps.get(loop)
    if (before?.requestId === requestId) return
    const isMain = loop === MAIN
    if (before !== undefined) this.close(before.entry, 'ok', at)
    if (isMain && this.model !== undefined && this.model !== model) {
      this.add({ station: 'model', label: `${shortModel(this.model)} → ${shortModel(model)}`, status: 'ok', mark: 'switch', startedAt: at }, undefined, true)
      this.board.switchedAt = at
    }
    const index = (before?.index ?? 0) + 1
    const label = `${shortModel(model)} · ${this.setup.t.step(index)}${isMain ? '' : ` · ${this.setup.t.subagent}`}`
    const entry = this.add(isMain ? { station: 'model', label, startedAt: at } : { station: 'model', label, from: 'agents', agentId: loop, startedAt: at })
    if (isMain) {
      this.model = model
      this.board.model = model
      this.board.step = index
    }
    this.steps.set(loop, { entry, requestId, index })
  }

  private assistant(rec: Rec, at: number): void {
    const message = isObj(rec.message) ? rec.message : {}
    const isSide = rec.isSidechain === true
    const loop = isSide ? str(rec.agentId) || 'sidechain' : MAIN
    if (isSide) this.loops.add(loop)
    else this.turn = 'open'
    const requestId = str(rec.requestId) || str(message.id)
    const model = str(message.model)
    const isStep = requestId !== '' && model !== '' && model !== '<synthetic>'
    if (isStep) this.step(loop, requestId, model, at)
    if (!isSide && isObj(message.usage)) {
      const u = message.usage
      const n = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens].reduce<number>((sum, v) => sum + (typeof v === 'number' ? v : 0), 0)
      if (n > 0) this.lastInputTokens = n
    }
    let called = false
    for (const block of blocksOf(rec)) {
      const id = str(block.id)
      if (block.type !== 'tool_use' || id === '' || this.open.has(id)) continue
      const name = str(block.name)
      const seen = classify(name, isObj(block.input) ? (block.input as Record<string, unknown>) : {}, this.setup)
      const entry = this.add({ ...seen, ...(isSide ? { from: 'agents' as const, agentId: loop } : { from: 'core' as const }), startedAt: at })
      this.open.set(id, entry)
      this.toolName.set(id, name)
      if (name === 'Agent' && !isSide) this.agentCalls.add(id)
      called = true
    }
    // The model's step ends when it calls a tool; a step that only answers ends with the turn.
    const open = this.steps.get(loop)
    if (called && open !== undefined && open.requestId === requestId) this.close(open.entry, 'ok', at)
    if (isSide && message.stop_reason === 'end_turn') this.endLoop(loop, at)
  }

  private results(rec: Rec, at: number): void {
    const decision = isObj(rec.permissionDecision) ? rec.permissionDecision : {}
    const refused = decision.decision === 'reject' || (rec.toolDenialKind !== undefined && rec.toolDenialKind !== null)
    const result = isObj(rec.toolUseResult) ? rec.toolUseResult : undefined
    for (const block of blocksOf(rec)) {
      const id = str(block.tool_use_id)
      if (block.type !== 'tool_result' || id === '') continue
      const entry = this.open.get(id)
      if (entry === undefined) {
        this.orphans++
        continue
      }
      this.open.delete(id)
      const isError = block.is_error === true
      if (refused) {
        if (decision.source === 'hook') {
          this.add({ station: 'hooks', label: this.setup.t.stopped(this.toolName.get(id) ?? 'tool'), status: 'block', startedAt: at })
        }
        this.close(entry, 'block', at)
      } else {
        const task = isError ? undefined : taskOf(result)
        if (task !== undefined) {
          // The call started work that goes on after it answered: its row stays open under the task's id.
          entry.task = task
          this.open.set(id, entry)
          continue
        }
        this.close(entry, isError ? 'err' : 'ok', at)
      }
      this.agentCalls.delete(id)
      const agent = result === undefined ? '' : str(result.agentId)
      if (agent !== '') this.endLoop(agent, at)
      else if (this.toolName.get(id) === 'Agent' && this.agentCalls.size === 0) this.endLoop('sidechain', at)
    }
  }

  private message(at: number): void {
    // A new message clears what went wrong on the way to the last answer; a call it cut short never reports back.
    this.board.faults = {}
    const main = this.steps.get(MAIN)
    if (main !== undefined) this.close(main.entry, 'ok', at)
    this.steps.delete(MAIN)
    this.closeCoreRuns(at)
    this.add({ station: 'you', label: this.setup.t.newMessage, from: 'inbound', status: 'ok', startedAt: at })
    this.turn = 'open'
    this.askedAt = at
  }

  private turnEnd(at: number, aborted: boolean): void {
    const { t } = this.setup
    const main = this.steps.get(MAIN)
    if (main !== undefined) this.close(main.entry, 'ok', at)
    const entry = aborted
      ? this.add({ station: 'you', label: t.turnAborted, status: 'err', startedAt: at })
      : this.add({ station: 'you', label: t.answerReady, status: 'ok', mark: 'done', startedAt: at })
    if (!aborted && this.askedAt !== undefined && at > this.askedAt) this.turnMs.set(entry.id, at - this.askedAt)
    this.askedAt = undefined
    this.closeCoreRuns(at)
    this.turn = 'ended'
  }

  private user(rec: Rec, at: number): void {
    // The summary written after a compaction is the app's, not a message from a person.
    if (rec.isCompactSummary === true) return
    const text = textOf(rec)
    const origin = isObj(rec.origin) ? str(rec.origin.kind) : ''
    const notice = taskNotice(text)
    if (notice !== undefined) {
      if (notice.status !== undefined) this.settle(notice.id, notice.status, at)
      return
    }
    if (blocksOf(rec).some(b => b.type === 'tool_result')) {
      this.results(rec, at)
      return
    }
    if (/^\s*\[Request interrupted by user/.test(text)) {
      if (rec.isSidechain !== true) this.turnEnd(at, true)
      return
    }
    if (rec.isSidechain === true || text.trim() === '') return
    // A person's message, or a message another session sent in: either starts a turn.
    if (origin === 'human' || origin === 'peer') return this.message(at)
    // Any other origin, the app's own notes and wrapped command output are no message.
    if (origin !== '' || rec.isMeta === true || text.trimStart().startsWith('<')) return
    this.message(at)
  }

  private system(rec: Rec, at: number): void {
    if (rec.isSidechain === true) return
    if (rec.subtype === 'turn_duration') {
      if (this.turn !== 'ended') this.turnEnd(at, false)
    } else if (rec.subtype === 'compact_boundary') {
      this.add({ station: 'model', label: this.setup.t.compacting, status: 'ok', startedAt: at })
    }
  }

  private attachment(rec: Rec, at: number): void {
    const a = isObj(rec.attachment) ? rec.attachment : {}
    const { t } = this.setup
    if (a.type === 'queued_command') {
      const notice = taskNotice(str(a.prompt))
      if (notice?.status !== undefined) this.settle(notice.id, notice.status, at)
      return
    }
    if (a.type === 'hook_additional_context') {
      // Shown as the hook acting, and when: never what it added.
      const when = a.hookEvent === 'SessionStart' ? t.atStart : a.hookEvent === 'UserPromptSubmit' ? t.toMessage : undefined
      if (when !== undefined) this.add({ station: 'hooks', label: t.addedContext(when), status: 'ok', startedAt: at })
      return
    }
    if (a.type === 'hook_success' && a.hookEvent === 'PreToolUse' && typeof a.durationMs === 'number') {
      // A check before a call that took a moment is worth seeing; the instant ones are not. One row per call.
      const call = str(a.toolUseID)
      const tool = this.toolName.get(call)
      if (tool === undefined) return
      const had = this.checks.get(call)
      if (had !== undefined) {
        had.startedAt = Math.min(had.startedAt, at - a.durationMs)
        return
      }
      if (a.durationMs < 400) return
      this.checks.set(call, this.add({ station: 'hooks', label: t.checkBefore(tool), status: 'ok', startedAt: at - a.durationMs, endedAt: at }))
    }
  }

  read(rec: Rec): void {
    const at = Date.parse(str(rec.timestamp))
    const sid = str(rec.sessionId) || str(rec.session_id)
    if (/^[\w-]{1,64}$/.test(sid)) this.sessionId = sid
    if (Number.isNaN(at)) return
    this.rows++
    this.firstAt = this.firstAt === undefined ? at : Math.min(this.firstAt, at)
    this.lastAt = this.lastAt === undefined ? at : Math.max(this.lastAt, at)
    switch (rec.type) {
      case 'assistant':
        return this.assistant(rec, at)
      case 'user':
        return this.user(rec, at)
      case 'system':
        return this.system(rec, at)
      case 'attachment':
        return this.attachment(rec, at)
      case 'queue-operation': {
        // A notification queued while a turn ran: only the line that queues it says something.
        if (rec.operation !== 'enqueue') return
        const notice = taskNotice(str(rec.content))
        if (notice?.status !== undefined) this.settle(notice.id, notice.status, at)
        return
      }
      default:
        // Any other row is not shown.
        return
    }
  }

  finish(): void {
    const crew = this.agentCalls.size > 0 ? [...this.agentCalls] : [...this.loops]
    this.board.agents = crew
  }

  agentsRunning(): number {
    return (this.board.agents ?? []).length
  }
}

// ---- the frame ----------------------------------------------------------------------------------

const iso = (ms: number): string => new Date(ms).toISOString()
const mib = (n: number): string => `${(n / MIB).toFixed(1)} MiB`

function minutes(ms: number): string {
  const s = Math.round(ms / 1000)
  return s < 120 ? `${s} s` : `${Math.round(s / 60)} min`
}

export function frame(opts: Options, observedAt: number): Record<string, unknown> {
  const tail = readTail(opts.transcript, opts.tailBytes)
  const setup = setupFrom({ language: opts.language, ...(opts.theme !== undefined ? { theme: opts.theme } : {}) })
  const reader = new Reader(setup)
  tail.lines.forEach((line, i) => {
    if (line.trim() === '') return
    let rec: unknown
    try {
      rec = JSON.parse(line)
    } catch {
      // A half-written last line of a live file is expected; any other broken line is counted.
      if (!(tail.openEnd && i === tail.lines.length - 1)) reader.unreadable++
      return
    }
    if (isObj(rec)) reader.read(rec)
    else reader.unreadable++
  })
  if (reader.rows === 0 || reader.lastAt === undefined || reader.firstAt === undefined) {
    throw new Refusal('no transcript row with a time could be read')
  }
  reader.finish()
  const board = reader.board
  const now = opts.now ?? observedAt
  const lastAt = reader.lastAt
  const age = now - lastAt
  const staleAfterMs = opts.staleAfterS * 1000
  const hasRun = board.entries.some(e => e.status === 'run')
  const isOld = age > staleAfterMs
  const unfinished = hasRun || reader.turn === 'open'
  const activity = unfinished || reader.turn === 'unknown' ? (isOld || !unfinished ? 'unknown' : 'running') : 'idle'
  const stale = activity === 'unknown' && isOld

  const { t } = setup
  // When nothing new was written for too long, what was going is not confirmed: the picture stands still at the last row.
  const svg = stale ? drawMap(board, lastAt, { ...setup, motion: 'reduced' }) : drawMap(board, now, setup)
  const said = describeNow(board, t)
  const nowLine = stale ? `Activity unknown: no new transcript row for ${minutes(age)}. Last seen: ${said}` : said

  const rows = foldRows(board.entries, 16)
    .reverse()
    .map(({ entry, times, tookMs }) => {
      const unconfirmed = stale && entry.status === 'run'
      const whole = reader.turnMs.get(entry.id)
      return {
        mark: entry.mark === 'switch' ? '◆' : unconfirmed ? '?' : entry.status === 'run' ? '●' : entry.status === 'ok' ? '·' : '✕',
        station: entry.station,
        label: entry.label,
        from: entry.from,
        status: unconfirmed ? 'unknown' : entry.status,
        times,
        took_ms: entry.endedAt === undefined ? null : whole !== undefined ? whole : tookMs,
        started_at: iso(entry.startedAt),
      }
    })

  const coverage: string[] = []
  const span = `${reader.rows} rows with a time, from ${iso(reader.firstAt)} to ${iso(lastAt)}`
  coverage.push(
    tail.start > 0
      ? `Read the last ${mib(tail.size - tail.start)} of ${mib(tail.size)}, from the first whole line: ${span}. Counts, rows and the picture cover that part only; calls started before it are not shown.`
      : `Read the whole file (${mib(tail.size)}): ${span}.`,
  )
  if (tail.openEnd) coverage.push('The last line was still being written and was left for the next read.')
  if (reader.unreadable > 0) coverage.push(`${reader.unreadable} lines could not be read as transcript rows and were skipped.`)
  if (reader.orphans > 0) coverage.push(`${reader.orphans} results answered calls made before the part that was read; they are not shown.`)
  if (stale) {
    coverage.push(
      `No new row for ${minutes(age)}, longer than ${opts.staleAfterS} s: unfinished calls are not confirmed as running (status "unknown"), and the picture is drawn still, as of the last row.`,
    )
  } else if (activity === 'unknown') {
    coverage.push('The part read shows neither the start nor the end of a turn, so whether the session works now is unknown.')
  }
  coverage.push(
    reader.lastInputTokens === undefined
      ? 'Context: the transcript does not record how full the context window is, so context_pct is null.'
      : `Context: the last request used ${reader.lastInputTokens} input tokens, but the transcript does not record the window's size, so context_pct is null.`,
  )
  coverage.push(
    'Hooks: shown only as far as the transcript records them (a check before a call of 400 ms or more, a hook that stopped a call, context a hook added at session start or to a message). Hooks that asked for permission and anything a hook said are not shown.',
  )
  coverage.push(
    'Subagents that write their own transcript files are not read: their work shows as the call that started them. Rows marked isSidechain in this file count as subagent work and start from Agents.',
  )
  if (opts.language !== 'en') coverage.push('The map and rows use the chosen language; this list and the stale notice are in English.')

  return {
    schema: 1,
    session_id: reader.sessionId ?? null,
    svg,
    now_line: nowLine,
    rows,
    context_pct: board.context === undefined ? null : Math.round(board.context),
    model: board.model === undefined ? null : shortModel(board.model),
    counts: board.counts,
    agents_running: reader.agentsRunning(),
    last_event_at: iso(lastAt),
    observed_at: iso(observedAt),
    activity,
    stale,
    coverage,
  }
}

// ---- the command --------------------------------------------------------------------------------

function main(argv: readonly string[]): number {
  try {
    const opts = parseArgs(argv)
    process.stdout.write(`${JSON.stringify(frame(opts, Date.now()))}\n`)
    return 0
  } catch (e) {
    // Never a partial picture: a refusal says why, and anything unexpected says only that it failed.
    const error = e instanceof Refusal ? e.message : `could not build the frame (${e instanceof Error ? e.name : 'error'})`
    process.stdout.write(`${JSON.stringify({ error })}\n`)
    return 2
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
