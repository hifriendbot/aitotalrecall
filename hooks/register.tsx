import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderInput } from 'claude-code'

import type {
  RecallCall,
  RecallCallKind,
  RecallItem,
  RecallLifetime,
  RecallRule,
  RecallSource,
  RecallStats,
  RecallTab,
} from '../types'

// ---------------------------------------------------------------------------
// State: everything a drawing reads lives in $.state so a hot reload keeps it.
// ---------------------------------------------------------------------------

/** The product name as drawn. One place to change it. */
const BRAND = 'AI Total Recall'
const PANE = 'aitotalrecall'
/** The short slash command, and the long one that always works. */
const CMD = 'recall'
const CMD_LONG = 'aitotalrecall'

const recalled = atom({ plugin: 'aitotalrecall', key: 'recalled' } as const, [] as RecallItem[])
const learned = atom({ plugin: 'aitotalrecall', key: 'learned' } as const, [] as RecallItem[])
const rules = atom({ plugin: 'aitotalrecall', key: 'rules' } as const, [] as RecallRule[])
const calls = atom({ plugin: 'aitotalrecall', key: 'calls' } as const, {} as Record<string, RecallCall>)
const tab = atom({ plugin: 'aitotalrecall', key: 'tab' } as const, 'recalled' as RecallTab)
const expanded = atom({ plugin: 'aitotalrecall', key: 'expanded' } as const, '')
const pulse = atom({ plugin: 'aitotalrecall', key: 'pulse' } as const, [] as number[])
const isBandHidden = atom({ plugin: 'aitotalrecall', key: 'isBandHidden' } as const, false)
const lifetime = atom({ plugin: 'aitotalrecall', key: 'lifetime' } as const, {
  recalls: 0,
  saves: 0,
  sessions: 0,
} as RecallLifetime)
const stats = atom({ plugin: 'aitotalrecall', key: 'stats' } as const, {
  recalls: 0,
  saves: 0,
  contextLoads: 0,
  lastEvent: '',
  lastAt: 0,
  isBusy: false,
  project: '',
  flash: '',
  turn: 0,
  isConnected: true,
} as RecallStats)

const MAX_ITEMS = 200
const MAX_CALLS = 300
const PULSE_LEN = 24
const SERVER = 'mcp__cogmemai__'
const RECALL = 'mcp__cogmemai__recall_memories'
const CONTEXT = 'mcp__cogmemai__get_project_context'
const PREFLIGHT = 'mcp__cogmemai__preflight'
const SAVE = 'mcp__cogmemai__save_memory'
const SAVE_RULE = 'mcp__cogmemai__save_rule'
const SAVE_CORRECTION = 'mcp__cogmemai__save_correction'

const SETUP_LINE = 'npx cogmemai-mcp@latest setup'

// ---------------------------------------------------------------------------
// Parsing the memory server's answers. Every parser is defensive: a result
// we cannot read leaves the lists alone and never touches the tool's answer.
// ---------------------------------------------------------------------------

type Loose = Record<string, unknown>

function textOf(ran: unknown): string {
  const r = ran as Loose | null
  if (!r || r.deny !== undefined) return ''
  if (typeof r.text === 'string' && r.text) return r.text
  const result = r.result as unknown
  if (typeof result === 'string') return result
  if (Array.isArray(result)) {
    return result.map(b => (typeof (b as Loose)?.text === 'string' ? String((b as Loose).text) : '')).join('\n')
  }
  const content = (result as Loose | null)?.content
  if (Array.isArray(content)) {
    return content.map(b => (typeof (b as Loose)?.text === 'string' ? String((b as Loose).text) : '')).join('\n')
  }
  try {
    return JSON.stringify(result)
  } catch {
    return ''
  }
}

function parseJson(text: string): Loose | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as unknown
    return value && typeof value === 'object' ? (value as Loose) : null
  } catch {
    return null
  }
}

function clean(text: string): string {
  return text
    .replace(/\*\*/g, '')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function isShouting(text: string): boolean {
  const letters = text.replace(/[^A-Za-z]/g, '')
  if (letters.length < 8) return false
  const upper = letters.replace(/[^A-Z]/g, '').length
  return upper / letters.length > 0.6
}

function sentenceCase(text: string): string {
  const lower = text.toLowerCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

/**
 * Memory bodies tend to open with a shouted header ("PROJECT X SHIPPED
 * Oct 29 2026 (working name...)"). Skip past it to the first plain sentence,
 * and if the whole thing shouts, speak it in sentence case.
 */
function quiet(text: string): string {
  const s = clean(text)
  const parts = s.split(/(?<=[.!?:;])\s+/)
  let i = 0
  let dropped = 0
  // A body that opens with a shouted word ("ENGRAM PROTOTYPE BUILT Oct 29 ...")
  // is headed; the header runs to the first sentence break whatever its case
  // ratio, since a lowercase aside inside it would otherwise hide it.
  const leadsWithCaps = /^[A-Z][A-Z0-9'’-]{2,}(\s|$)/.test(s)
  if (leadsWithCaps && parts.length > 1 && (parts[0]?.length ?? 0) < s.length * 0.5) {
    dropped += parts[0]?.length ?? 0
    i = 1
  }
  while (i < parts.length - 1 && isShouting(parts[i] ?? '') && dropped + (parts[i]?.length ?? 0) < s.length * 0.5) {
    dropped += parts[i]?.length ?? 0
    i += 1
  }
  const rest = parts.slice(i).join(' ').trim() || s
  if (isShouting(rest.slice(0, 80))) return sentenceCase(rest)
  return rest.charAt(0).toUpperCase() + rest.slice(1)
}

function firstWords(text: string, n = 6): string {
  const words = clean(text).split(' ').filter(Boolean)
  return words.slice(0, n).join(' ') + (words.length > n ? '…' : '')
}

function cut(text: string, max: number): string {
  if (max <= 1) return ''
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

function snippetOf(text: string, max = 220): string {
  return cut(quiet(text), max)
}

function fullOf(text: string, max = 700): string {
  return cut(clean(text), max)
}

function nameOf(subject: string): string {
  return subject.replace(/_/g, ' ')
}

function itemsFromRecall(j: Loose, at: number, turn: number, callId: string, via: RecallSource): RecallItem[] {
  const list = Array.isArray(j.memories) ? (j.memories as Loose[]) : []
  return list.map((m, index) => {
    const content = String(m.content ?? '')
    const rawId = m.id === undefined || m.id === null || m.id === '' ? '' : String(m.id)
    return {
      id: rawId || `${callId}-${index}`,
      subject: typeof m.subject === 'string' && m.subject ? m.subject : firstWords(content),
      snippet: snippetOf(content),
      full: fullOf(content),
      importance: typeof m.importance === 'number' ? m.importance : undefined,
      scope: typeof m.scope === 'string' ? m.scope : undefined,
      via,
      at,
      turn,
      callId,
    }
  })
}

function itemsFromPreflight(j: Loose, at: number, turn: number, callId: string): RecallItem[] {
  if (typeof j.prior_context !== 'string') return []
  const out: RecallItem[] = []
  for (const line of j.prior_context.split('\n')) {
    const m = /^\[(\d+)\]\s+([^:]+):\s*(.*)$/.exec(line.trim())
    if (!m) continue
    const n = m[1] ?? ''
    const subject = (m[2] ?? '').trim()
    const body = m[3] ?? ''
    out.push({
      id: `pf-${n}-${at}`,
      subject: subject === 'unknown' || !subject ? firstWords(body) : subject,
      snippet: snippetOf(body),
      full: fullOf(body),
      via: 'preflight',
      at,
      turn,
      callId,
    })
  }
  return out
}

function parseContext(
  j: Loose,
  at: number,
  turn: number,
  callId: string,
): { items: RecallItem[]; rules: RecallRule[] } {
  const items: RecallItem[] = []
  const found: RecallRule[] = []
  const text = typeof j.formatted_context === 'string' ? j.formatted_context : ''
  let section = ''
  let n = 0
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (line.startsWith('## ')) {
      section = line.slice(3).toLowerCase()
      continue
    }
    // Top-level entries only: "- [#id] ..." or "- [built-in] ...". A bare "- "
    // line is a sub-bullet inside a memory's own body and is not an entry.
    if (!line.startsWith('- [')) continue
    let rest = line.slice(2)
    const brackets: string[] = []
    let m: RegExpExecArray | null
    while ((m = /^\[([^\]]+)\]\s+/.exec(rest))) {
      brackets.push(m[1] ?? '')
      rest = rest.slice(m[0].length)
    }
    let slug = ''
    const s = /^\(([\w.-]+)\)\s+/.exec(rest)
    if (s) {
      slug = s[1] ?? ''
      rest = rest.slice(s[0].length)
    }
    n += 1
    const idTag = brackets.find(b => b.startsWith('#'))
    const scope = brackets.find(b => b === 'global' || b === 'project' || b === 'team')
    if (section.includes('rule')) {
      found.push({ slug: slug || firstWords(rest, 5), text: fullOf(rest), id: idTag?.slice(1) })
    } else {
      items.push({
        id: idTag ? idTag.slice(1) : `ctx-${n}-${at}`,
        subject: slug || firstWords(rest),
        snippet: snippetOf(rest),
        full: fullOf(rest),
        scope,
        via: 'context',
        at,
        turn,
        callId,
      })
    }
  }
  return { items, rules: found }
}

function merge(existing: RecallItem[], incoming: RecallItem[]): RecallItem[] {
  const seen = new Set(incoming.map(i => i.id))
  return [...incoming, ...existing.filter(i => !seen.has(i.id))].slice(0, MAX_ITEMS)
}

function dots(importance?: number): string {
  if (importance === undefined) return ''
  const filled = Math.max(0, Math.min(5, Math.round(importance / 2)))
  return '●'.repeat(filled) + '○'.repeat(5 - filled)
}

function baseName(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function ago(now: number, at: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  return `${h}h`
}

const BARS = '▁▂▃▄▅▆▇█'

function sparkline(values: number[], width: number): string {
  if (width <= 0 || values.length === 0) return ''
  const tail = values.slice(-width)
  if (tail.length === 0) return ''
  const max = Math.max(1, ...tail)
  return tail
    .map(v => BARS.charAt(Math.min(BARS.length - 1, Math.round((v / max) * (BARS.length - 1)))))
    .join('')
}

function glyphOf(via: RecallSource): string {
  if (via === 'saved') return '+'
  if (via === 'context') return '◇'
  if (via === 'preflight') return '◈'
  if (via === 'search') return '◉'
  return '◆'
}

function colorOf(via: RecallSource): 'success' | 'suggestion' | 'remember' | 'claude' {
  if (via === 'saved') return 'success'
  if (via === 'context') return 'suggestion'
  if (via === 'search') return 'claude'
  return 'remember'
}

// ---------------------------------------------------------------------------
// Shared engine work, as top-level functions so `$` travels only to them.
// ---------------------------------------------------------------------------

/** Reads the error flag off a tool result the way the engine sets it. */
function isErrorResult(ran: unknown): boolean {
  const r = ran as Loose | null
  return !r || r.deny !== undefined || r.isError === true
}

/** A hooked memory call answered, so the server is there whatever tool.list said. */
async function markConnected($: EngineInterface) {
  await update($, stats, cur => (cur.isConnected ? cur : { ...cur, isConnected: true }))
}

/** Clears the busy flag and closes the call's card when `next(e)` throws (an abort, a budget). */
async function abandonCall($: EngineInterface, id: string) {
  try {
    await finishCall($, id, { isError: true })
    await update($, stats, cur => ({ ...cur, isBusy: false, lastEvent: 'memory call interrupted' }))
  } catch {
    // Nothing more to do; the engine is already unwinding the call.
  }
}

async function refreshStatus($: EngineInterface) {
  const s = await read($, stats)
  if (!s.isConnected) {
    $.ui.status('◆ memory not connected · /recall setup')
    return
  }
  const r = await read($, recalled)
  const l = await read($, learned)
  if (r.length === 0 && l.length === 0) {
    $.ui.status('◆ watching for memories')
    return
  }
  $.ui.status(`◆ ${r.length} recalled · ${l.length} saved`)
}

async function bumpLifetime($: EngineInterface, field: 'recalls' | 'saves', by: number) {
  const next = await update($, lifetime, cur => ({ ...cur, [field]: (cur[field] ?? 0) + by }))
  try {
    await $.store.set('lifetime', next)
  } catch {
    // The store is a convenience; the session view does not depend on it.
  }
}

async function bumpPulse($: EngineInterface, by: number) {
  if (by <= 0) return
  await update($, pulse, cur => {
    const list = cur.length ? [...cur] : [0]
    list[list.length - 1] = (list[list.length - 1] ?? 0) + by
    return list.slice(-PULSE_LEN)
  })
}

async function flash($: EngineInterface, text: string) {
  await update($, stats, cur => ({ ...cur, flash: text }))
  $.clock.after(6000, () => {
    void update($, stats, cur => (cur.flash === text ? { ...cur, flash: '' } : cur))
  })
}

async function noteCall($: EngineInterface, id: string, kind: RecallCallKind, query: string) {
  await update($, calls, cur => {
    const next: Record<string, RecallCall> = { ...cur }
    const keys = Object.keys(next)
    if (keys.length >= MAX_CALLS) delete next[keys[0] ?? '']
    next[id] = { id, kind, query, count: 0, rules: 0, subjects: [], isDone: false, isError: false }
    return next
  })
}

async function finishCall($: EngineInterface, id: string, patch: Partial<RecallCall>) {
  await update($, calls, cur => {
    const was = cur[id]
    if (!was) return cur
    return { ...cur, [id]: { ...was, ...patch, isDone: true } }
  })
}

async function afterRecall($: EngineInterface, input: Loose, ran: unknown, via: 'recall' | 'search') {
  const id = String(input.tool_use_id ?? '')
  try {
    const now = await $.clock.now()
    const s = await read($, stats)
    const j = parseJson(textOf(ran))
    const isError = isErrorResult(ran)
    const items = j && !isError ? itemsFromRecall(j, now, s.turn, id, via) : []
    const query = typeof input.query === 'string' ? input.query : ''
    if (items.length) await update($, recalled, cur => merge(cur, items))
    if (!isError) await markConnected($)
    await finishCall($, id, { count: items.length, subjects: items.map(i => nameOf(i.subject)), isError })
    await update($, stats, cur => ({
      ...cur,
      recalls: cur.recalls + 1,
      isBusy: false,
      lastAt: now,
      lastEvent: isError
        ? 'memory server error'
        : items.length
          ? `recalled ${items.length} for “${cut(query, 28)}”`
          : `nothing for “${cut(query, 28)}”`,
    }))
    if (items.length) {
      await bumpLifetime($, 'recalls', items.length)
      await bumpPulse($, items.length)
      await flash($, `+${items.length}`)
    }
    await refreshStatus($)
  } catch {
    await update($, stats, cur => ({ ...cur, isBusy: false }))
    await finishCall($, id, {})
  }
}

async function afterPreflight($: EngineInterface, input: Loose, ran: unknown) {
  const id = String(input.tool_use_id ?? '')
  try {
    const now = await $.clock.now()
    const s = await read($, stats)
    const j = parseJson(textOf(ran))
    const isError = isErrorResult(ran)
    const items = j && !isError ? itemsFromPreflight(j, now, s.turn, id) : []
    if (items.length) await update($, recalled, cur => merge(cur, items))
    if (!isError) await markConnected($)
    await finishCall($, id, { count: items.length, subjects: items.map(i => nameOf(i.subject)), isError })
    await update($, stats, cur => ({
      ...cur,
      recalls: cur.recalls + 1,
      isBusy: false,
      lastAt: now,
      lastEvent: isError ? 'memory server error' : items.length ? `preflight found ${items.length} prior` : 'preflight clear',
    }))
    if (items.length) {
      await bumpLifetime($, 'recalls', items.length)
      await bumpPulse($, items.length)
      await flash($, `+${items.length}`)
    }
    await refreshStatus($)
  } catch {
    await update($, stats, cur => ({ ...cur, isBusy: false }))
    await finishCall($, id, {})
  }
}

async function afterContext($: EngineInterface, input: Loose, ran: unknown) {
  const id = String(input.tool_use_id ?? '')
  try {
    const now = await $.clock.now()
    const s = await read($, stats)
    const j = parseJson(textOf(ran))
    const isError = isErrorResult(ran)
    const parsed = j && !isError ? parseContext(j, now, s.turn, id) : { items: [], rules: [] }
    if (parsed.items.length) await update($, recalled, cur => merge(cur, parsed.items))
    if (parsed.rules.length) await update($, rules, () => parsed.rules)
    if (!isError) await markConnected($)
    await finishCall($, id, {
      count: parsed.items.length,
      rules: parsed.rules.length,
      subjects: parsed.items.map(i => nameOf(i.subject)),
      isError,
    })
    await update($, stats, cur => ({
      ...cur,
      contextLoads: cur.contextLoads + 1,
      isBusy: false,
      lastAt: now,
      lastEvent: isError ? 'memory server error' : `loaded ${parsed.items.length} memories, ${parsed.rules.length} rules`,
    }))
    if (parsed.items.length) {
      await bumpLifetime($, 'recalls', parsed.items.length)
      await bumpPulse($, parsed.items.length)
    }
    await refreshStatus($)
  } catch {
    await update($, stats, cur => ({ ...cur, isBusy: false }))
    await finishCall($, id, {})
  }
}

/**
 * The text and label of a save, whichever save tool made it: save_memory and
 * save_rule carry `content` and `subject`; save_correction carries
 * `wrong_approach`, `right_approach` and `context` instead.
 */
function saveWords(input: Loose): { content: string; subject: string } {
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const wrong = str(input.wrong_approach)
  const right = str(input.right_approach)
  const content =
    str(input.content) ||
    str(input.rule) ||
    str(input.text) ||
    (wrong || right ? `Wrong: ${wrong || '?'} Right: ${right || '?'}` : '')
  const subject =
    str(input.subject) || str(input.name) || str(input.context) || firstWords(right || content) || 'untitled memory'
  return { content, subject }
}

async function afterSave($: EngineInterface, input: Loose, ran: unknown, kind: 'memory' | 'rule' | 'correction'): Promise<void> {
  const id = String(input.tool_use_id ?? '')
  try {
    const isError = isErrorResult(ran)
    const now = await $.clock.now()
    const s = await read($, stats)
    const j = parseJson(textOf(ran))
    const { content, subject } = saveWords(input)
    if (isError) {
      await finishCall($, id, { isError: true, subjects: [nameOf(subject)] })
      return
    }
    await markConnected($)
    const memoryId = j && j.memory_id !== undefined ? String(j.memory_id) : j && j.rule_id !== undefined ? String(j.rule_id) : undefined
    if (kind === 'rule') {
      // A new rule is in force from now on: show it without waiting for the next context load.
      const rule: RecallRule = { slug: subject, text: fullOf(content), id: memoryId }
      await update($, rules, cur => [rule, ...cur.filter(r => (memoryId ? r.id !== memoryId : r.slug !== subject))])
    }
    const item: RecallItem = {
      id: memoryId ?? `saved-${now}`,
      subject,
      snippet: snippetOf(content),
      full: fullOf(content),
      importance: typeof input.importance === 'number' ? input.importance : undefined,
      scope: typeof input.scope === 'string' ? input.scope : undefined,
      via: 'saved',
      at: now,
      turn: s.turn,
      callId: id,
    }
    await update($, learned, cur => merge(cur, [item]))
    await finishCall($, id, { count: 1, subjects: [nameOf(subject)], memoryId })
    await update($, stats, cur => ({
      ...cur,
      saves: cur.saves + 1,
      lastAt: now,
      lastEvent: `saved “${cut(nameOf(subject), 40)}”`,
    }))
    await bumpLifetime($, 'saves', 1)
    $.ui.toast(`◆ remembered: ${cut(nameOf(subject), 60)}`)
    await refreshStatus($)
  } catch {
    await finishCall($, id, {})
  }
}

/**
 * The queries of our own searches in flight. A call this module makes from
 * one of its handlers is not run through this module's own `tool.call` hooks
 * (the engine never re-enters a plugin beneath its own call), so the search
 * records its result itself. Should the hook see the call after all, it steps
 * aside for that exact query only, so a recall the model makes at the same
 * moment is still recorded.
 */
const ownQueries = new Map<string, number>()
let searchSerial = 0

function isOwnQuery(input: Loose): boolean {
  const q = typeof input.query === 'string' ? input.query.trim() : ''
  return q !== '' && (ownQueries.get(q) ?? 0) > 0 && input.limit === 10
}

/** A zero-token memory search from the pane or /recall find. */
async function search($: EngineInterface, query: string) {
  const q = query.trim()
  if (!q) return
  if (q.length < 2) {
    $.ui.toast('◆ type at least two characters to search memory')
    return
  }
  searchSerial += 1
  const id = `search-${await $.clock.now()}-${searchSerial}`
  await update($, tab, () => 'recalled')
  await noteCall($, id, 'search', q)
  await update($, stats, cur => ({ ...cur, isBusy: true, lastEvent: `searching “${cut(q, 28)}”` }))
  ownQueries.set(q, (ownQueries.get(q) ?? 0) + 1)
  try {
    const ran = await $.tool.call({
      tool: RECALL,
      query: q,
      limit: 10,
      consent: `The user searched memory for "${q}" in the ${BRAND} pane.`,
    })
    await afterRecall($, { tool_use_id: id, query: q }, ran, 'search')
  } catch {
    await finishCall($, id, { isError: true })
    await update($, stats, cur => ({ ...cur, isBusy: false, lastEvent: 'search failed' }))
    $.ui.toast('◆ search failed: is the memory server connected?')
  } finally {
    const left = (ownQueries.get(q) ?? 1) - 1
    if (left <= 0) ownQueries.delete(q)
    else ownQueries.set(q, left)
  }
  // The redraws asked for while the handler ran were held; ask once more.
  $.ui.invalidate('ui.render')
}

async function checkConnection($: EngineInterface): Promise<boolean> {
  try {
    const tools = await $.tool.list()
    const isConnected = tools.some(t => t.name.startsWith(SERVER))
    await update($, stats, cur => ({ ...cur, isConnected }))
    return isConnected
  } catch {
    return true
  }
}

/** The slash command, shared by its short and long names. */
async function runCommand($: EngineInterface, args: string): Promise<{ text: string }> {
  const raw = args.trim()
  const arg = raw.toLowerCase()
  if (arg === 'hide') {
    await update($, isBandHidden, () => true)
    return { text: `band hidden. /${CMD} show brings it back.` }
  }
  if (arg === 'show') {
    await update($, isBandHidden, () => false)
    return { text: 'band shown.' }
  }
  if (arg === 'clear') {
    await update($, recalled, () => [])
    await update($, learned, () => [])
    await update($, expanded, () => '')
    await update($, stats, cur => ({ ...cur, recalls: 0, saves: 0, lastEvent: 'cleared', isBusy: false }))
    await refreshStatus($)
    return { text: 'session lists cleared.' }
  }
  if (arg === 'setup') {
    const isConnected = await checkConnection($)
    return {
      text: isConnected
        ? 'memory server connected. The pane fills as the assistant recalls and saves.'
        : `no memory server found. Install one, then restart the session:\n  ${SETUP_LINE}`,
    }
  }
  if (arg.startsWith('find ')) {
    const query = raw.slice(5).trim()
    await $.ui.open({ id: PANE, title: BRAND })
    await search($, query)
    return { text: `searching memory for “${cut(query, 60)}”. Results are in the pane.` }
  }
  const opened = await $.ui.open({ id: PANE, title: BRAND, focus: true })
  return {
    text: opened.isPlaced
      ? 'pane open. Tab to the search box, or r / l / u for Recalled, Learned, Rules.'
      : 'pane opens when the terminal is wider (fullscreen, 110 columns).',
  }
}

// ---------------------------------------------------------------------------
// Transcript cards: the raw JSON a memory call returns becomes one tidy row.
// ---------------------------------------------------------------------------

async function drawToolUse($: EngineInterface, e: RenderInput<'ToolUse'>): Promise<RenderElement | null> {
  const all = await read($, calls)
  const call = all[e.props.tool_use_id]
  if (!call) return null
  const { Box, Text } = $.ui.resolve(e)
  const running = e.props.isRunning || !call.isDone
  const verb =
    call.kind === 'save'
      ? running
        ? 'remembering'
        : 'remembered'
      : call.kind === 'context'
        ? running
          ? 'loading memory'
          : 'loaded memory'
        : call.kind === 'preflight'
          ? running
            ? 'checking prior work'
            : 'checked prior work'
          : running
            ? 'recalling'
            : 'recalled'
  const color = call.isError ? 'error' : call.kind === 'save' ? 'success' : 'remember'
  let tail = ''
  if (call.isError) tail = 'error'
  else if (running) tail = '…'
  else if (call.kind === 'save') tail = call.subjects[0] ? `“${call.subjects[0]}”${call.memoryId ? ` #${call.memoryId}` : ''}` : ''
  else if (call.kind === 'context') tail = `${call.count} memories · ${call.rules} rules`
  else tail = `${call.count} ${call.count === 1 ? 'memory' : 'memories'}${call.query ? ` for “${cut(call.query, 48)}”` : ''}`

  // No fixed width: the transcript column bounds the row, docked pane or not.
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={color} bold>
        {glyphOf(call.kind === 'save' ? 'saved' : call.kind === 'context' ? 'context' : call.kind === 'preflight' ? 'preflight' : call.kind === 'search' ? 'search' : 'recall')}
      </Text>
      <Text color={color} wrap="truncate-end">
        {verb}
      </Text>
      <Text dimColor wrap="truncate-end">
        {tail}
      </Text>
    </Box>
  )
}

async function drawToolResult($: EngineInterface, e: RenderInput<'ToolResult'>): Promise<RenderElement | null> {
  const all = await read($, calls)
  const call = all[e.props.tool_use_id]
  if (!call) return null
  const { Box, Text } = $.ui.resolve(e)
  if (call.isError) {
    return (
      <Box paddingLeft={2}>
        <Text color="error" wrap="truncate-end">
          the memory server returned an error; the model saw the details
        </Text>
      </Box>
    )
  }
  if (call.kind === 'save') {
    return (
      <Box paddingLeft={2}>
        <Text dimColor wrap="truncate-end">
          in the Learned tab of the {BRAND} pane
        </Text>
      </Box>
    )
  }
  if (call.kind === 'context' && call.count === 0) {
    return (
      <Box paddingLeft={2}>
        <Text dimColor wrap="truncate-end">
          {call.rules > 0 ? `${String(call.rules)} rules in force, in the Rules tab` : 'no project memories yet'}
        </Text>
      </Box>
    )
  }
  if (call.count === 0) {
    return (
      <Box paddingLeft={2}>
        <Text dimColor wrap="truncate-end">
          nothing matched
        </Text>
      </Box>
    )
  }
  const shown = call.subjects.slice(0, 4)
  const more = call.subjects.length - shown.length
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {shown.map(subject => (
        <Text dimColor wrap="truncate-end">
          · {subject}
        </Text>
      ))}
      {more > 0 ? <Text dimColor>· {String(more)} more in the {BRAND} pane</Text> : null}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// The module.
// ---------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const spec = {
      description: `${BRAND}: open the memory pane; "find <query>" searches memory; "hide" / "show" the band; "clear"; "setup"`,
      argumentHint: '[find <query>|hide|show|clear|setup]',
    }
    await $.command.register({ name: 'aitotalrecall', ...spec })
    try {
      await $.command.register({ name: 'recall', ...spec })
    } catch {
      // Another plugin or the engine owns /recall here; /aitotalrecall still works.
    }

    let saved: RecallLifetime | undefined
    try {
      saved = (await $.store.get('lifetime')) as RecallLifetime | undefined
    } catch {
      saved = undefined
    }
    // A hot reload re-runs this hook with the session's state intact: count a
    // session once, on the first start, not on every reload.
    const isReload = (await read($, stats)).project !== ''
    const life: RecallLifetime = {
      recalls: saved?.recalls ?? 0,
      saves: saved?.saves ?? 0,
      sessions: (saved?.sessions ?? 0) + (isReload ? 0 : 1),
    }
    await update($, lifetime, () => life)
    try {
      await $.store.set('lifetime', life)
    } catch {
      // see above
    }

    await update($, stats, cur => ({ ...cur, project: baseName(e.cwd), isBusy: false, flash: '' }))
    if (!isReload) await update($, pulse, () => [0])
    await checkConnection($)
    await refreshStatus($)

    // The "6s ago" labels in the pane go stale without a tick. Redraw every
    // half minute, and only while a pane of ours is actually drawn.
    $.clock.every(30_000, () => {
      void $.ui.panes().then(panes => {
        if (panes.some(p => p.isPlaced)) $.ui.invalidate('ui.render')
      })
    })

    return next(e)
  })

  // Each prompt is a turn: the pulse gets a new bar.
  on('prompt.submit', async ($, e, next) => {
    await update($, stats, cur => ({ ...cur, turn: cur.turn + 1 }))
    await update($, pulse, cur => [...cur, 0].slice(-PULSE_LEN))
    return next(e)
  })

  // --- Watching the memory server ------------------------------------------

  // Every hook below passes the tool's answer through untouched. If `next`
  // throws (the person pressed Esc, the call ran out of budget) the busy flag
  // and the card are closed before the error continues up.

  on('tool.call', { tool: RECALL }, async ($, e, next) => {
    const input = e as Loose
    if (isOwnQuery(input)) return next(e)
    const id = String(input.tool_use_id ?? '')
    await noteCall($, id, 'recall', String(input.query ?? ''))
    await update($, stats, cur => ({ ...cur, isBusy: true }))
    let ran
    try {
      ran = await next(e)
    } catch (err) {
      await abandonCall($, id)
      throw err
    }
    await afterRecall($, input, ran, 'recall')
    return ran
  })

  on('tool.call', { tool: PREFLIGHT }, async ($, e, next) => {
    const input = e as Loose
    const id = String(input.tool_use_id ?? '')
    await noteCall($, id, 'preflight', String(input.message ?? ''))
    await update($, stats, cur => ({ ...cur, isBusy: true }))
    let ran
    try {
      ran = await next(e)
    } catch (err) {
      await abandonCall($, id)
      throw err
    }
    await afterPreflight($, input, ran)
    return ran
  })

  on('tool.call', { tool: CONTEXT }, async ($, e, next) => {
    const input = e as Loose
    const id = String(input.tool_use_id ?? '')
    await noteCall($, id, 'context', String(input.context ?? ''))
    await update($, stats, cur => ({ ...cur, isBusy: true }))
    let ran
    try {
      ran = await next(e)
    } catch (err) {
      await abandonCall($, id)
      throw err
    }
    await afterContext($, input, ran)
    return ran
  })

  on('tool.call', { tool: SAVE }, async ($, e, next) => {
    const input = e as Loose
    const id = String(input.tool_use_id ?? '')
    await noteCall($, id, 'save', saveWords(input).subject)
    let ran
    try {
      ran = await next(e)
    } catch (err) {
      await abandonCall($, id)
      throw err
    }
    await afterSave($, input, ran, 'memory')
    return ran
  })
  on('tool.call', { tool: SAVE_RULE }, async ($, e, next) => {
    const input = e as Loose
    const id = String(input.tool_use_id ?? '')
    await noteCall($, id, 'save', saveWords(input).subject)
    let ran
    try {
      ran = await next(e)
    } catch (err) {
      await abandonCall($, id)
      throw err
    }
    await afterSave($, input, ran, 'rule')
    return ran
  })
  on('tool.call', { tool: SAVE_CORRECTION }, async ($, e, next) => {
    const input = e as Loose
    const id = String(input.tool_use_id ?? '')
    await noteCall($, id, 'save', saveWords(input).subject)
    let ran
    try {
      ran = await next(e)
    } catch (err) {
      await abandonCall($, id)
      throw err
    }
    await afterSave($, input, ran, 'correction')
    return ran
  })

  // --- Transcript cards -----------------------------------------------------

  on('ui.render', { component: 'ToolUse', props: { tool: RECALL } }, async ($, e, next) => (await drawToolUse($, e)) ?? next(e))
  on('ui.render', { component: 'ToolUse', props: { tool: PREFLIGHT } }, async ($, e, next) => (await drawToolUse($, e)) ?? next(e))
  on('ui.render', { component: 'ToolUse', props: { tool: CONTEXT } }, async ($, e, next) => (await drawToolUse($, e)) ?? next(e))
  on('ui.render', { component: 'ToolUse', props: { tool: SAVE } }, async ($, e, next) => (await drawToolUse($, e)) ?? next(e))
  on('ui.render', { component: 'ToolUse', props: { tool: SAVE_RULE } }, async ($, e, next) => (await drawToolUse($, e)) ?? next(e))
  on('ui.render', { component: 'ToolUse', props: { tool: SAVE_CORRECTION } }, async ($, e, next) => (await drawToolUse($, e)) ?? next(e))
  on('ui.render', { component: 'ToolResult', props: { tool: SAVE_RULE } }, async ($, e, next) => (await drawToolResult($, e)) ?? next(e))
  on('ui.render', { component: 'ToolResult', props: { tool: SAVE_CORRECTION } }, async ($, e, next) => (await drawToolResult($, e)) ?? next(e))
  on('ui.render', { component: 'ToolResult', props: { tool: RECALL } }, async ($, e, next) => (await drawToolResult($, e)) ?? next(e))
  on('ui.render', { component: 'ToolResult', props: { tool: PREFLIGHT } }, async ($, e, next) => (await drawToolResult($, e)) ?? next(e))
  on('ui.render', { component: 'ToolResult', props: { tool: CONTEXT } }, async ($, e, next) => (await drawToolResult($, e)) ?? next(e))
  on('ui.render', { component: 'ToolResult', props: { tool: SAVE } }, async ($, e, next) => (await drawToolResult($, e)) ?? next(e))

  // --- The slash command ----------------------------------------------------

  on('command.run', { command: 'aitotalrecall' }, ($, e) => runCommand($, e.args))
  on('command.run', { command: 'recall' }, ($, e) => runCommand($, e.args))

  // --- The band above the prompt -------------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isBandHidden))) return next(e)
    const s = await read($, stats)
    const r = await read($, recalled)
    const l = await read($, learned)
    const u = await read($, rules)
    const p = await read($, pulse)
    const { Box, Text, Button } = $.ui.resolve(e)
    const width = e.props.bodyColumns
    const narrow = width < 72

    if (!s.isConnected) {
      return (
        <Box width={width} flexDirection="row" alignItems="center" gap={1}>
          <Text color="remember" bold>
            ◆
          </Text>
          <Text color="remember">{BRAND.toLowerCase()}</Text>
          <Text color="warning">memory not connected</Text>
          {!narrow ? <Text dimColor>· run /recall setup</Text> : null}
          <Box flexGrow={1} />
          <Button key="hide" label="Hide" plain dimColor onPress={() => update($, isBandHidden, () => true)} />
        </Box>
      )
    }

    // Measure before drawing: every piece is sized so the row never wraps.
    // Priority when room runs out: counts and buttons, then brand, flash,
    // the last event, the hint, the sparkline.
    const brand = BRAND.toLowerCase()
    const fullCounts = `${r.length} recalled · ${l.length} saved · ${u.length} rules`
    const hint = `/${CMD} or click`
    const spark = sparkline(p, 8)
    const event = s.isBusy ? 'recalling…' : s.lastEvent
    const buttons = '[ Open ]'.length + 1 + 'Hide'.length
    let used = 1 + 1 + brand.length + 1 + fullCounts.length + 1 + buttons
    let showBrand = true
    if (used > width) {
      showBrand = false
      used -= brand.length + 1
    }
    let counts = fullCounts
    if (used > width) {
      counts = `${r.length} · ${l.length} · ${u.length}`
      used += counts.length - fullCounts.length
    }
    const showFlash = !!s.flash && used + 1 + s.flash.length <= width
    if (showFlash) used += 1 + s.flash.length
    let eventText = ''
    if (!narrow && event.length > 0) {
      const room = Math.min(48, width - used - 1)
      if (room >= 14) {
        eventText = cut(event, room)
        used += 1 + eventText.length
      }
    }
    const showHint = !narrow && used + 1 + hint.length <= width
    if (showHint) used += 1 + hint.length
    const showSpark = !narrow && spark.length > 0 && used + 1 + spark.length <= width

    return (
      <Box width={width} flexDirection="row" alignItems="center" gap={1}>
        <Text color="remember" bold>
          ◆
        </Text>
        {showBrand ? (
          <Text color="remember" wrap="truncate-end">
            {brand}
          </Text>
        ) : null}
        {showSpark ? (
          <Text color="remember" dimColor>
            {spark}
          </Text>
        ) : null}
        <Text dimColor wrap="truncate-end">
          {counts}
        </Text>
        {showFlash ? (
          <Text color="success" bold>
            {s.flash}
          </Text>
        ) : null}
        {eventText ? (
          <Text color={s.isBusy ? 'claude' : 'subtle'} italic wrap="truncate-end">
            {eventText}
          </Text>
        ) : null}
        <Box flexGrow={1} />
        {showHint ? (
          <Text dimColor wrap="truncate-end">
            {hint}
          </Text>
        ) : null}
        <Button key="open" label="Open" onPress={() => $.ui.open({ id: PANE, title: BRAND, focus: true })} />
        <Button key="hide" label="Hide" plain dimColor onPress={() => update($, isBandHidden, () => true)} />
      </Box>
    )
  })

  // --- The pane ---------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const Input = e.surface === 'mobile' ? undefined : $.ui.resolve(e).Input
    const s = await read($, stats)
    const r = await read($, recalled)
    const l = await read($, learned)
    const u = await read($, rules)
    const p = await read($, pulse)
    const life = await read($, lifetime)
    const which = await read($, tab)
    const open = await read($, expanded)
    const allCalls = await read($, calls)
    const now = await $.clock.now()
    const width = e.props.bodyColumns
    const inner = Math.max(10, width - 2)

    // Header: title, project, pulse, last event.
    const headLeft = `◆ ${BRAND.toUpperCase()} · ${s.project || 'project'}`
    const spark = sparkline(p, Math.min(12, Math.max(0, inner - headLeft.length - 2)))
    const event = s.isBusy ? 'recalling…' : s.lastEvent

    const header = (
      <Box flexDirection="column">
        <Box flexDirection="row" alignItems="center">
          <Text color="remember" bold>
            ◆ {BRAND.toUpperCase()}
          </Text>
          <Text dimColor wrap="truncate-end">
            {' · '}
            {cut(s.project || 'project', Math.max(4, inner - BRAND.length - 6))}
          </Text>
          <Box flexGrow={1} />
          <Text color="remember" dimColor>
            {spark}
          </Text>
        </Box>
        {event ? (
          <Text color={s.isBusy ? 'claude' : 'subtle'} italic wrap="truncate-end">
            {cut(event, inner)}
          </Text>
        ) : null}
      </Box>
    )

    // Not connected: the pane is the setup card.
    if (!s.isConnected) {
      return (
        <Box flexDirection="column" width={width} paddingX={1} gap={1}>
          {header}
          <Text color="warning" bold>
            No memory server is connected.
          </Text>
          <Text wrap="wrap">
            {BRAND} shows what your assistant remembers across sessions: what it recalled, what it learned, and the rules it works under. It needs a memory server to watch.
          </Text>
          <Box flexDirection="column">
            <Text dimColor>Install one, then restart the session:</Text>
            <Text color="claude">{SETUP_LINE}</Text>
          </Box>
          <Button
            key="copy-setup"
            label="Copy the command"
            hotkey="c"
            variant="primary"
            onPress={async () => {
              const copied = await $.ui.copy({ text: SETUP_LINE, surface: e.surface })
              $.ui.toast(copied.isCopied ? '◆ copied' : `◆ copy failed: ${SETUP_LINE}`)
            }}
          />
          <Button key="recheck" label="Check again" hotkey="r" plain onPress={() => checkConnection($)} />
        </Box>
      )
    }

    const searchBox = Input ? (
      <Input
        key="search"
        placeholder="search memory…"
        submitLabel="search"
        onSubmit={value => search($, value)}
      />
    ) : null

    const tabButton = (id: RecallTab, hotkey: string, label: string, count: number) => (
      <Button
        key={`tab-${id}`}
        hotkey={hotkey}
        plain
        dimColor={which !== id}
        onPress={() => update($, tab, () => id)}
      >
        <Text bold={which === id} color={which === id ? 'remember' : undefined}>
          {label}
        </Text>{' '}
        <Text dimColor>{String(count)}</Text>
      </Button>
    )

    const toggle = (id: string) => update($, expanded, cur => (cur === id ? '' : id))

    const rows: JSX.Element[] = []

    if (which === 'rules') {
      if (u.length === 0) {
        rows.push(
          <Text dimColor wrap="wrap">
            No rules loaded yet. They appear after the first project context load.
          </Text>,
        )
      }
      u.slice(0, 80).forEach((rule, index) => {
        const key = `rule-${rule.id ?? `${String(index)}-${rule.slug}`}`
        const isOpen = open === key
        rows.push(
          <Box flexDirection="column" key={`row-${key}`}>
            <Button key={key} plain onPress={() => toggle(key)}>
              <Text color="warning">{isOpen ? '▾' : '▸'} </Text>
              <Text color={isOpen ? 'warning' : undefined} bold={isOpen}>
                {cut(nameOf(rule.slug), inner - 2)}
              </Text>
            </Button>
            {isOpen ? (
              <Box paddingLeft={2} paddingBottom={1} width={inner}>
                <Text dimColor wrap="wrap">
                  {rule.text}
                </Text>
              </Box>
            ) : null}
          </Box>,
        )
      })
    } else {
      const list = which === 'learned' ? l : r
      if (list.length === 0) {
        rows.push(
          <Box flexDirection="column" gap={1}>
            <Text dimColor wrap="wrap">
              {which === 'learned'
                ? 'Nothing saved this session yet. When the assistant commits something to memory it lands here, with a toast.'
                : 'Nothing recalled yet. Memories appear here the moment the assistant looks something up, or search above.'}
            </Text>
            {which === 'recalled' ? (
              <Button
                key="recall-now"
                label="Recall what you know about this project"
                hotkey="n"
                variant="primary"
                onPress={() => search($, `${s.project} project: architecture, decisions, gotchas, preferences`)}
              />
            ) : null}
          </Box>,
        )
      }
      let lastGroup = ''
      for (const item of list.slice(0, 80)) {
        const call = item.callId ? allCalls[item.callId] : undefined
        const group =
          item.via === 'search' && call?.query
            ? `search “${cut(call.query, Math.max(4, inner - 16))}”`
            : item.via === 'context'
              ? 'loaded with the project'
              : `turn ${String(item.turn)}`
        if (group !== lastGroup && list.length > 6) {
          lastGroup = group
          rows.push(
            <Text dimColor wrap="truncate-end">
              {'── '}
              {group} {'─'.repeat(Math.max(0, inner - group.length - 5))}
            </Text>,
          )
        }
        const key = `item-${item.id}`
        const isOpen = open === key
        const scopeMark = item.scope ? ' ' + item.scope.charAt(0).toUpperCase() : ''
        const meta = `${dots(item.importance)}${scopeMark} ${ago(now, item.at)}`
        const head = `${glyphOf(item.via)} ${nameOf(item.subject)}`
        rows.push(
          <Box flexDirection="column" key={`row-${key}`} marginBottom={isOpen ? 0 : 1}>
            <Button key={key} plain onPress={() => toggle(key)}>
              <Text color={colorOf(item.via)} bold>
                {cut(head, Math.max(8, inner - meta.length - 1))}
              </Text>
              <Text dimColor>{' '.repeat(Math.max(1, inner - Math.min(head.length, inner - meta.length - 1) - meta.length))}{meta}</Text>
            </Button>
            {isOpen ? (
              <Box flexDirection="column" paddingLeft={2} paddingBottom={1} width={inner}>
                <Text dimColor wrap="truncate-end">
                  #{item.id}
                  {item.importance !== undefined ? ` · importance ${String(item.importance)}` : ''}
                  {item.scope ? ` · ${item.scope}` : ''} · via {item.via}
                </Text>
                <Box flexDirection="row" flexWrap="wrap" columnGap={2} marginBottom={1}>
                  <Button
                    key={`copy-${item.id}`}
                    label="copy"
                    hotkey="c"
                    plain
                    onPress={async () => {
                      const copied = await $.ui.copy({ text: `#${item.id} ${item.subject}: ${item.full}`, surface: e.surface })
                      $.ui.toast(copied.isCopied ? '◆ memory copied' : '◆ copy is not available on this surface')
                    }}
                  />
                  <Button
                    key={`ask-${item.id}`}
                    label="ask"
                    hotkey="a"
                    plain
                    onPress={async () => {
                      const filled = await $.prompt.fill({
                        text: `Using memory #${item.id} (${nameOf(item.subject)}), `,
                        mode: 'replace',
                      })
                      $.ui.toast(filled.isFilled ? '◆ prompt started, finish the question' : '◆ the prompt box is busy')
                    }}
                  />
                  <Button
                    key={`more-${item.id}`}
                    label="related"
                    hotkey="m"
                    plain
                    onPress={() => search($, nameOf(item.subject))}
                  />
                  <Button key={`close-${item.id}`} label="close" hotkey="x" plain dimColor onPress={() => toggle(key)} />
                </Box>
                <Text wrap="wrap">{item.full || item.snippet}</Text>
              </Box>
            ) : (
              <Text dimColor wrap="truncate-end">
                {'  '}
                {cut(item.snippet, inner - 2)}
              </Text>
            )}
          </Box>,
        )
      }
    }

    const lifeLine = `lifetime · ${life.recalls.toLocaleString()} recalled · ${life.saves.toLocaleString()} saved · ${life.sessions.toLocaleString()} ${life.sessions === 1 ? 'session' : 'sessions'} · aitotalrecall.com`

    return (
      <Box flexDirection="column" width={width} paddingX={1}>
        {header}
        {searchBox}
        <Box flexDirection="row" gap={2} marginBottom={1} marginTop={searchBox ? 1 : 0}>
          {tabButton('recalled', 'r', 'Recalled', r.length)}
          {tabButton('learned', 'l', 'Learned', l.length)}
          {tabButton('rules', 'u', 'Rules', u.length)}
        </Box>
        <Box flexDirection="column">{rows}</Box>
        <Box flexGrow={1} />
        <Text dimColor wrap="truncate-end">
          {cut(lifeLine, inner)}
        </Text>
        {e.props.isFocused ? (
          <Text dimColor wrap="truncate-end">
            r l u tabs · Tab walks rows · Enter expands · Esc back
          </Text>
        ) : null}
      </Box>
    )
  })
}
