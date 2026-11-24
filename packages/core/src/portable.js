/**
 * The portable event: one message-level record that every agent can read.
 *
 * DSH's own log is event-sourced and implementation-shaped (steps, attempts,
 * tool plumbing). This module folds it into a small, agent-neutral record while
 * keeping a lossless "native" copy of the parameters a peer would need to
 * rebuild a runnable conversation. Nothing here interprets tool output; it only
 * keeps text and the message structure.
 */
import { digestOf } from './util.js'

export const PORTABLE_VERSION = 1

const TEXT_BLOCK = new Set(['text', 'input_text', 'output_text'])
const KEEP_BLOCK = new Set(['text', 'input_text', 'output_text', 'reasoning', 'image', 'image_url', 'file', 'document'])

/** Plain text of an OpenAI-style content array (or a bare string). */
export function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (!block || typeof block !== 'object') continue
    if (TEXT_BLOCK.has(block.type) && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'tool-call' || block.type === 'tool_use') parts.push(`[tool ${block.name ?? 'call'}]`)
  }
  return parts.join('\n').trim()
}

/** Keep only blocks that are meaningful outside this host (drop stream bookkeeping). */
export function portableBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  const out = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (KEEP_BLOCK.has(block.type)) {
      if (block.type === 'reasoning') continue // thinking stays on the origin device
      if (block.type === 'image' || block.type === 'image_url' || block.type === 'file' || block.type === 'document') {
        out.push({ type: block.type, ref: block.ref ?? block.attachmentId ?? block.url ?? undefined, mediaType: block.mediaType ?? undefined, name: block.name ?? undefined })
        continue
      }
      out.push({ type: block.type, text: block.text ?? '' })
    }
  }
  return out
}

function messageOf(event) {
  switch (event.type) {
    case 'user/message':
      return { role: 'user', message: event.data }
    case 'assistant/message':
      return { role: 'assistant', message: event.data.message ?? event.data }
    case 'tool/result':
      return { role: 'tool', message: event.data.message ?? event.data }
    case 'developer/message':
    case 'system/message':
      return null
    default:
      return null
  }
}

/**
 * Fold ONE DSH session event into a portable record, or return null when the
 * event carries no conversational meaning (steps, approvals, retries, …).
 *
 * @param {object} event committed DSH session event with `seq`, `time`, `type`, `data`.
 * @param {object} context origin identity: device, root session, parent session.
 * @returns {object|null} portable record.
 */
export function portableFromDshEvent(event, context) {
  const type = event?.type
  if (typeof type !== 'string' || typeof event.seq !== 'number') return null

  if (type === 'session/title') {
    const title = event.data?.title
    if (typeof title !== 'string' || title.trim() === '') return null
    return finish({
      kind: 'title',
      role: 'meta',
      text: title,
      ts: event.time ?? null,
    }, event, context)
  }

  if (type === 'tool/call') {
    const name = event.data?.name
    const args = event.data?.arguments
    let text = ''
    try {
      const parsed = typeof args === 'string' ? JSON.parse(args) : args
      text = typeof parsed === 'object' && parsed !== null ? JSON.stringify(parsed) : String(parsed ?? '')
    } catch {
      text = typeof args === 'string' ? args : ''
    }
    return finish({
      kind: 'tool-call',
      role: 'assistant',
      text,
      tool: { name: typeof name === 'string' ? name : 'tool', callId: event.data?.callId ?? null },
      ts: event.time ?? null,
    }, event, context)
  }

  if (type === 'tool/result') {
    const message = event.data?.message ?? {}
    return finish({
      kind: 'tool-result',
      role: 'tool',
      text: contentText(message.content),
      tool: { callId: message.toolCallId ?? event.data?.toolCallId ?? null, isError: message.isError === true },
      ts: event.time ?? null,
    }, event, context)
  }

  const folded = messageOf(event)
  if (folded === null) return null
  const message = folded.message
  if (!message || typeof message !== 'object') return null
  const blocks = portableBlocks(message.content)
  const text = contentText(message.content)
  if (text === '' && blocks.length === 0) return null
  return finish({
    kind: 'message',
    role: folded.role,
    text,
    blocks,
    messageId: typeof message.id === 'string' ? message.id : null,
    ts: event.time ?? null,
  }, event, context)
}

function finish(record, event, context) {
  const base = {
    v: PORTABLE_VERSION,
    origin: {
      device: context.device,
      session: context.session,
      root: context.root ?? context.session,
      parent: context.parent ?? null,
      seq: event.seq,
      ts: record.ts,
      eventType: event.type,
    },
    agent: context.agent ?? 'dsh',
    kind: record.kind,
    role: record.role,
    text: record.text,
    ...(record.blocks === undefined ? {} : { blocks: record.blocks }),
    ...(record.tool === undefined ? {} : { tool: record.tool }),
    ...(record.messageId === undefined ? {} : { messageId: record.messageId }),
  }
  base.id = messageKey(base)
  return base
}

/**
 * Identity of one portable record. It must be identical on every device that
 * observes the same message, so it may only use fields the origin supplied.
 */
export function messageKey(record) {
  const origin = record.origin ?? {}
  return digestOf({
    device: origin.device,
    session: origin.session,
    seq: origin.seq,
    eventType: origin.eventType,
    text: record.text,
    tool: record.tool ?? null,
  }).slice(0, 32)
}

/**
 * Order records deterministically: by origin time, then by device, then seq.
 * Two devices sorting the same set therefore produce the same conversation.
 */
export function comparePortable(a, b) {
  const at = a.origin?.ts ?? 0
  const bt = b.origin?.ts ?? 0
  if (at !== bt) return at - bt
  const ad = String(a.origin?.device ?? '')
  const bd = String(b.origin?.device ?? '')
  if (ad !== bd) return ad < bd ? -1 : 1
  const as = a.origin?.seq ?? 0
  const bs = b.origin?.seq ?? 0
  return as - bs
}

/** A human-readable label for the session this record belongs to: its first user message. */
export function titleOf(records, fallback = '同步的对话') {
  const sorted = [...records].sort(comparePortable)
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    if (sorted[i].kind === 'title' && typeof sorted[i].text === 'string' && sorted[i].text.trim() !== '') {
      return sorted[i].text.trim().slice(0, 120)
    }
  }
  for (const record of sorted) {
    if (record.role === 'user' && record.kind === 'message' && typeof record.text === 'string' && record.text.trim() !== '') {
      const first = record.text.trim().split('\n')[0]
      if (!first.startsWith('The user changed the approval policy')) return first.slice(0, 120)
    }
  }
  return fallback
}
