/**
 * Small shared helpers: canonical JSON, digests, ids, time.
 * No third-party dependencies — the sync core must run on a phone.
 */
import { createHash, randomBytes } from 'node:crypto'

export function sha256(input) {
  return createHash('sha256').update(input).digest('hex')
}

export function digestOf(value) {
  return sha256(canonicalJson(value))
}

/**
 * Stable JSON: object keys sorted, no whitespace. Two devices must produce the
 * same byte string for the same logical value, otherwise digests disagree.
 */
export function canonicalJson(value) {
  return JSON.stringify(sortValue(value))
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue
      out[key] = sortValue(value[key])
    }
    return out
  }
  return value
}

export function b64u(buf) {
  return Buffer.from(buf).toString('base64url')
}

export function unb64u(text) {
  return Buffer.from(text, 'base64url')
}

export function randomId(bytes = 12) {
  return randomBytes(bytes).toString('hex')
}

export function nowMs() {
  return Date.now()
}

export function parseJson(text, fallback = undefined) {
  try {
    return JSON.parse(text)
  } catch {
    return fallback
  }
}

export function parseJsonl(text) {
  const out = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const value = parseJson(trimmed)
    if (value !== undefined) out.push(value)
  }
  return out
}

/** Split a list into chunks by an approximate serialized byte budget. */
export function chunkByBytes(items, limitBytes, maxItems = 500) {
  const chunks = []
  let current = []
  let size = 0
  for (const item of items) {
    const itemSize = Buffer.byteLength(JSON.stringify(item)) + 1
    if (current.length > 0 && (size + itemSize > limitBytes || current.length >= maxItems)) {
      chunks.push(current)
      current = []
      size = 0
    }
    current.push(item)
    size += itemSize
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}

/** Format a byte count for the tiny phone panel. */
export function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function isoTime(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** A stable short device id derived from a human name. */
export function deviceIdFrom(name) {
  const slug = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return slug === '' ? `dev-${randomId(4)}` : slug
}
