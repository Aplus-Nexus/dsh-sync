/**
 * Chunk store: the on-repository layout.
 *
 *   key/salt                 the scrypt salt (public, meaningless without the passphrase)
 *   data/<root>/<device>/<first>-<last>.jsonl.enc   immutable message chunks
 *   notes/<device>/<id>.md.enc                      shared agent notes (MCP bus)
 *
 * Chunks are named by the sequence range they cover and are never rewritten.
 * Two devices therefore never write the same path — Git merges by path, so
 * there is no shared mutable file to conflict on.
 */
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { seal, open } from './crypto.js'
import { chunkByBytes, canonicalJson, parseJsonl } from './util.js'

export const SALT_PATH = 'key/salt'
const CHUNK_BYTES = 256 * 1024
const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,120}$/

export function assertSegment(name, label) {
  if (typeof name !== 'string' || !SAFE_SEGMENT.test(name) || name === '.' || name === '..') {
    throw new Error(`${label} is not a safe path segment`)
  }
  return name
}

export function chunkPath(root, device, first, last) {
  return `data/${assertSegment(root, 'session id')}/${assertSegment(device, 'device id')}/${String(first).padStart(6, '0')}-${String(last).padStart(6, '0')}.jsonl.enc`
}

export function notePath(device, noteId) {
  return `notes/${assertSegment(device, 'device id')}/${assertSegment(noteId, 'note id')}.md.enc`
}

/**
 * Native-log path: a byte-faithful DSH log, sealed, named by the origin
 * device and the sequence span it covers. One device never writes another
 * device's prefix, so these files merge by path like everything else.
 */
export function nativePath(root, device, first, last) {
  return `native/${assertSegment(root, 'session id')}/${assertSegment(device, 'device id')}/${String(first).padStart(6, '0')}-${String(last).padStart(6, '0')}.log.zst.enc`
}

export function parseNativeName(name) {
  const match = /^(\d{6,})-(\d{6,})\.log\.zst\.enc$/.exec(name)
  if (match === null) return undefined
  return { first: Number(match[1]), last: Number(match[2]) }
}

/**
 * Seal a list of portable records into repository chunks.
 *
 * Session metadata (`{ __meta }`) is not a message and has no sequence number,
 * so it rides at the head of the first chunk instead of being sorted with the
 * messages. Chunk names describe the message range only.
 */
export function encodeChunks(key, { root, device, records }) {
  const meta = records.filter((record) => record.__meta !== undefined)
  const messages = records
    .filter((record) => record.__meta === undefined)
    .sort((a, b) => (a.origin?.seq ?? 0) - (b.origin?.seq ?? 0))
  if (messages.length === 0 && meta.length === 0) return []
  const pieces = messages.length === 0 ? [[]] : chunkByBytes(messages, CHUNK_BYTES, 500)
  const files = []
  for (const [index, piece] of pieces.entries()) {
    const head = index === 0 ? meta : []
    const first = piece.length > 0 ? piece[0].origin.seq : 0
    const last = piece.length > 0 ? piece[piece.length - 1].origin.seq : 0
    const path = chunkPath(root, device, first, last)
    const plain = [...head, ...piece].map((record) => canonicalJson(record)).join('\n') + '\n'
    // `plain` is returned so the caller can tell whether this chunk's content
    // actually changed; re-sealing identical content only adds history weight.
    files.push({ path, bytes: seal(key, Buffer.from(plain, 'utf8'), `dsh-sync:chunk:${path}`), plain, count: piece.length })
  }
  return files
}

/** Decrypt one chunk, tolerating a corrupted file by reporting it instead of throwing. */
export function decodeChunk(key, path, bytes) {
  const text = open(key, bytes, `dsh-sync:chunk:${path}`).toString('utf8')
  const records = []
  for (const value of parseJsonl(text)) {
    if (value && typeof value === 'object' && typeof value.id === 'string') records.push(value)
  }
  return records
}

/** Parse a chunk filename back into the range it covers. */
export function parseChunkName(name) {
  const match = /^(\d{6,})-(\d{6,})\.jsonl\.enc$/.exec(name)
  if (match === null) return undefined
  return { first: Number(match[1]), last: Number(match[2]) }
}

/**
 * Seal one native log slice. The name says `.zst` because the payload really is
 * compressed first; keeping encode and decode here means no caller can write a
 * `.zst` file full of uncompressed bytes.
 */
export function encodeNativeChunk(key, path, text) {
  return seal(key, zstdCompressSync(Buffer.from(text, 'utf8')), `dsh-sync:chunk:${path}`)
}

/**
 * Open one native log slice produced by {@link encodeNativeChunk}.
 *
 * The payload is always zstd-compressed: the `.zst.enc` name is the contract,
 * so a reader never has to guess from a flag whether to decompress.
 */
export function decodeNativeChunk(key, path, bytes) {
  return zstdDecompressSync(open(key, bytes, `dsh-sync:chunk:${path}`)).toString('utf8')
}
