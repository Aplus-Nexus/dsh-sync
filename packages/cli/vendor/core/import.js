/**
 * Import a foreign session as a native, continuable DSH conversation.
 *
 * Safety rules:
 *  - an existing local session id is never overwritten;
 *  - a foreign header is only rewritten where the platform requires it (`cwd`);
 *  - the write is atomic (temp file + rename) and fsynced like DSH does, so a
 *    crash mid-import cannot leave a half log that DSH would refuse to read.
 */
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { encodeLogBytes, headerSummary, localizeHeader, logPathFor } from './native.js'

export async function importNativeSession({ sessionsRoot, header, events, fallbackCwd, now = () => new Date() }) {
  const target = localizeHeader(header, fallbackCwd)
  const path = logPathFor(sessionsRoot, target.cwd, target.id, target.version ?? 4)
  const existing = await stat(path).catch(() => undefined)
  if (existing !== undefined) return { imported: false, reason: 'exists', path }
  const dir = dirname(path)
  await mkdir(dir, { recursive: true })
  const bytes = encodeLogBytes(target, events)
  const tmp = join(dir, `session.import.${process.pid}.${Math.random().toString(16).slice(2, 8)}.tmp`)
  const handle = await open(tmp, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
  return { imported: true, path, sessionId: target.id, header: headerSummary(target), digest: digestOfBytes(bytes) }
}

export function digestOfBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Read one existing local log (used to skip sessions the device already has). */
export async function hasLocalSession(sessionsRoot, header) {
  const cwd = header?.cwd
  if (typeof cwd !== 'string') return false
  const path = logPathFor(sessionsRoot, cwd, header.id, header.version ?? 4)
  const info = await stat(path).catch(() => undefined)
  return info !== undefined ? { path, size: info.size } : false
}

export async function readLocalLog(path) {
  return readFile(path)
}
