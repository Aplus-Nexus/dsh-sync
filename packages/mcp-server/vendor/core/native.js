/**
 * Native DSH session logs: byte-faithful copy in, byte-faithful copy out.
 *
 * The point of this module is that importing a conversation on another device
 * does NOT re-synthesize it. It restores the origin device's own log, so DSH
 * validates and replays exactly what the author wrote — tool calls, images and
 * subagent lineage included. The only field ever rewritten is `cwd`, and only
 * when the origin path is not absolute on the receiving platform.
 */
import { isAbsolute, join } from 'node:path'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'

export const LOG_HEADER_TYPE = 'session'

/** DSH's project directory key: separators become `-`, unsafe units become `~XXXX`. */
export function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/** DSH's path segment escaping for session ids. */
export function encodeSegment(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
    else out += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/** Where a session log lives under a DSH home: `<sessions>/<project>/<id>/session.v4.jsonl.zstd`. */
export function logPathFor(sessionsRoot, cwd, sessionId, version = 4) {
  return join(sessionsRoot, projectKey(cwd), encodeSegment(sessionId), `session.v${version}.jsonl.zstd`)
}

/** Decompress a DSH log (zstd frames concatenate transparently) into `{ header, lines }`. */
export function parseLogBytes(bytes) {
  const text = zstdDecompressSync(Buffer.from(bytes)).toString('utf8')
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  if (lines.length === 0) throw new Error('session log is empty')
  const header = JSON.parse(lines[0])
  if (header?.type !== LOG_HEADER_TYPE) throw new Error('session log does not start with a session header')
  return { header, events: lines.slice(1), raw: lines }
}

/** Encode a header + event lines back into the exact physical layout DSH writes. */
export function encodeLogBytes(header, events) {
  const headerLine = `${JSON.stringify(header)}\n`
  const headerFrame = zstdCompressSync(Buffer.from(headerLine, 'utf8'))
  if (events.length === 0) return headerFrame
  const bodyFrame = zstdCompressSync(Buffer.from(`${events.join('\n')}\n`, 'utf8'))
  return Buffer.concat([headerFrame, bodyFrame])
}

/**
 * Make one foreign header safe to write on this device.
 *
 * The check uses the *reading* platform, because that is the platform whose
 * `isAbsolute` DSH validates the header with: a POSIX path is absolute on both
 * families, while `C:\...` is not absolute on a phone and must fall back.
 */
export function localizeHeader(header, fallbackCwd, isAbsoluteFn = isAbsolute) {
  const cwd = header?.cwd
  if (typeof cwd !== 'string' || cwd === '') return { ...header, cwd: fallbackCwd }
  if (isAbsoluteFn(cwd)) return header
  return { ...header, cwd: fallbackCwd }
}

/** Split a raw log into the part already known (by seq) and the new tail. */
export function tailFrom(rawEvents, afterSeq) {
  if (afterSeq === undefined || afterSeq < 0) return rawEvents
  const out = []
  for (const line of rawEvents) {
    let seq
    try {
      seq = JSON.parse(line).seq
    } catch {
      continue
    }
    if (typeof seq === 'number' && seq > afterSeq) out.push(line)
  }
  return out
}

/** Header identity fields that decide whether a local log can be adopted verbatim. */
export function headerSummary(header) {
  return {
    id: header?.id,
    createdAt: header?.createdAt,
    cwd: header?.cwd,
    isSeeded: header?.isSeeded === true,
    parentSession: header?.parentSession ?? null,
    origin: header?.origin ?? null,
    delegationDepth: header?.delegationDepth ?? 0,
    agentPreset: header?.agentPreset ?? null,
    version: header?.version ?? 4,
  }
}
