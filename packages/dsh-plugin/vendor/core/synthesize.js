/**
 * Synthesize a native DSH session log from portable records.
 *
 * A conversation produced by another agent (Codex, Claude Code, a DeepSeek
 * export) has messages but no DSH log. Without this module those messages could
 * only be read as a mirror; with it they become a real, continuable DSH
 * conversation that the app lists and the agent can keep talking in.
 *
 * The output is the same v4 shape DSH writes itself: dense events, an explicit
 * turn/step lifecycle, surface events for every message, and the settlement
 * fields a restored assistant message requires. Every generated log is validated
 * with DSH's own codec before it is handed back, so a shape mistake fails here
 * instead of on a phone.
 */
import { randomUUID } from 'node:crypto'
import { encodeLogBytes } from './native.js'

const AGENT_PRESET = 'standard'

/** A short, stable id for a synthesized session. */
export function synthesizeSessionId(seed) {
  const slug = String(seed).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return `session-import-${slug === '' ? randomUUID().slice(0, 8) : slug}`
}

/**
 * Build a v4 log from portable records.
 *
 * @param {object} options
 * @param {string} options.sessionId     target session id.
 * @param {object[]} options.records     portable records, any order.
 * @param {string} options.cwd           an absolute path on the importing device.
 * @param {string} [options.title]       unused by the log; kept for callers.
 * @param {number} [options.createdAt]   defaults to the earliest record time.
 * @param {string} [options.sourceLabel] shown as the model, e.g. `codex`.
 * @returns {{header: object, events: object[]}}
 */
export function synthesizeSession({ sessionId, records, cwd, createdAt, sourceLabel = 'imported' }) {
  if (typeof sessionId !== 'string' || sessionId === '') throw new Error('synthesizeSession needs a sessionId')
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) throw new Error('synthesizeSession needs an absolute cwd')
  const ordered = [...records]
    .filter((record) => record && typeof record.text === 'string' && record.text.trim() !== '')
    .sort(compareByTime)
  if (ordered.length === 0) throw new Error('nothing to synthesize: every record was empty')

  const header = {
    type: 'session',
    version: 4,
    id: sessionId,
    createdAt: Number.isFinite(createdAt) ? createdAt : (ordered[0].origin?.ts ?? Date.now()),
    cwd,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: AGENT_PRESET,
  }

  const events = []
  const push = (type, data, extra = {}) => {
    events.push({ type, seq: events.length, time: data.__time ?? Date.now(), data: withoutTime(data), ...extra })
  }

  // A session starts with the same bookkeeping DSH writes before its first turn.
  push('permission/preset', { preset: 'workspace-write', __time: header.createdAt })
  push('sandbox/mode', { mode: 'workspace-write', __time: header.createdAt })

  let turn = 0
  let step = 0
  let open = false
  /** Begin one turn and its single step; raise the step counter independently. */
  const openTurn = (time) => {
    turn += 1
    step = 1
    push('turn/start', { turn, __time: time })
    push('step/start', { turn, step, __time: time })
    open = true
  }
  const closeTurn = (time) => {
    if (!open) return
    push('step/end', { turn, step, __time: time })
    push('turn/end', { turn, reason: { kind: 'completed' }, __time: time })
    open = false
  }
  for (const record of ordered) {
    const time = Number.isFinite(record.origin?.ts) ? record.origin.ts : Date.now()
    if (record.kind === 'title') continue
    if (record.kind === 'tool-call' || record.kind === 'tool-result') {
      // Tool plumbing of another agent cannot be replayed faithfully here, and a
      // fabricated tool lifecycle would fail DSH's own relationship checks.
      // Its text is kept as a visible note instead of silently dropped.
      if (!open) openTurn(time)
      const who = record.kind === 'tool-call' ? `调用 ${record.tool?.name ?? '工具'}` : '工具返回'
      push('assistant/message', {
        turn,
        step,
        message: {
          role: 'assistant',
          id: randomUUID(),
          source: modelSource(sourceLabel),
          content: [{ type: 'text', text: `[${who}] ${oneLine(record.text, 400)}` }],
        },
        stream: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      }, { surfaceOp: 'append' })
      continue
    }
    const role = record.role === 'assistant' ? 'assistant' : 'user'
    if (role === 'user') {
      closeTurn(time)
      openTurn(time)
      push('user/message', {
        role: 'user',
        id: randomUUID(),
        source: { kind: 'user' },
        content: [{ type: 'text', text: record.text }],
      }, { surfaceOp: 'append' })
      open = true
      continue
    }
    if (!open) openTurn(time)
    push('assistant/message', {
      turn,
      step,
      message: {
        role: 'assistant',
        id: randomUUID(),
        source: modelSource(sourceLabel),
        content: [{ type: 'text', text: record.text }],
      },
      stream: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    }, { surfaceOp: 'append' })
  }
  closeTurn(undefined)

  return { header, events }
}

/**
 * Encode a synthesized log into the physical bytes DSH writes.
 *
 * Delegates to the one encoder so a synthesized log and an imported log can
 * never disagree about the physical layout.
 */
export function encodeSynthesizedLog(header, events) {
  return encodeLogBytes(header, events)
}

function modelSource(label) {
  return { kind: 'model', provider: label === '' ? 'imported' : label, model: label === '' ? 'imported' : label }
}

function compareByTime(a, b) {
  const at = a.origin?.ts ?? 0
  const bt = b.origin?.ts ?? 0
  if (at !== bt) return at - bt
  return (a.origin?.seq ?? 0) - (b.origin?.seq ?? 0)
}

function oneLine(text, max) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** Strip the private `__time` marker before an event is written. */
function withoutTime(data) {
  const { __time, ...rest } = data
  return rest
}
