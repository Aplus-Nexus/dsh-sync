/**
 * The sync engine: pushes new local events out, pulls other devices' events in,
 * and keeps a local mirror that any agent can read without DSH.
 *
 * Invariants
 *  - Chunk paths are owned by one device, so a Git merge never conflicts on a
 *    shared file; the only mutable file per session is its meta, owned by the
 *    session's origin device.
 *  - A pull never deletes or rewrites anything the device itself produced.
 *  - Importing into DSH is explicit and idempotent: a session id that already
 *    exists locally is never overwritten.
 */
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { deriveKey, keyFingerprint, open, seal } from './crypto.js'
import { decodeChunk, encodeChunks, notePath, SALT_PATH, parseChunkName, parseNativeName } from './store.js'
import { canonicalJson, digestOf, humanBytes, isoTime, nowMs, parseJson } from './util.js'
import { comparePortable, titleOf } from './portable.js'

const STATE_VERSION = 1

export class SyncEngine {
  /**
   * @param {object} options
   * @param {object} options.backend   folder / git backend.
   * @param {string} options.statePath local JSON state (device id, cursor, digests).
   * @param {string} [options.mirrorDir] where decrypted portable records are mirrored.
   * @param {string} [options.device]  device id; generated from the host name when absent.
   * @param {string} [options.agent]   agent label written on records (`dsh`, `codex`, …).
   */
  constructor(options) {
    if (!options?.backend) throw new Error('SyncEngine needs a backend')
    if (typeof options.statePath !== 'string' || options.statePath === '') throw new Error('SyncEngine needs a statePath')
    this.backend = options.backend
    this.statePath = options.statePath
    this.mirrorDir = options.mirrorDir ?? null
    this.agent = options.agent ?? 'dsh'
    this.device = options.device ?? 'device'
    this.state = null
    this.key = null
    this.log = options.log ?? (() => {})
  }

  /**
   * Load state and derive the key.
   *
   * The salt belongs to the *repository*, not to a device: a new device must
   * read the salt that already exists before it is allowed to create one, or
   * two devices would derive two different keys and publish chunks nobody else
   * can read. Asking the backend to fetch first is what makes "open on a new
   * phone" work; a failure to reach the network is tolerated so that the
   * plugin can still start offline with a salt it already knows.
   */
  async open({ passphrase, saltOverride } = {}) {
    this.state = await this.readState()
    this.device = this.state.device ?? this.device
    let salt = saltOverride
    if (salt === undefined) {
      await this.backend.sync?.({ direction: 'pull', quiet: true }).catch(() => {})
      try {
        salt = (await this.backend.read(SALT_PATH)).toString('utf8').trim()
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }
    if (salt === undefined || salt === '') {
      if (typeof passphrase !== 'string' || passphrase.length < 8) throw new Error('the repository has no salt yet: set a passphrase of at least 8 characters')
      const derived = await deriveKey(passphrase)
      await this.backend.write(SALT_PATH, Buffer.from(derived.salt + '\n'))
      // Publish it immediately: the next device to open needs to find it, not race us.
      await this.backend.sync?.({ direction: 'push', message: 'sync: create key salt', quiet: true }).catch(() => {})
      this.key = derived.key
      this.state.salt = derived.salt
    } else {
      const derived = await deriveKey(passphrase, salt)
      this.key = derived.key
      if (this.state.salt !== undefined && this.state.salt !== salt) throw new Error('the passphrase produces a different salt than the one recorded; clear the local state and retry')
      this.state.salt = salt
    }
    this.state.keyFingerprint = keyFingerprint(this.key)
    this.state.version = STATE_VERSION
    this.state.device = this.device
    this.state.cursor = this.state.cursor ?? {}
    this.state.chunks = this.state.chunks ?? {}
    this.state.sessions = this.state.sessions ?? {}
    this.state.stats = this.state.stats ?? { pushed: 0, pulled: 0, bytesOut: 0, bytesIn: 0 }
    await this.writeState()
    return this
  }

  fingerprint() {
    return this.state?.keyFingerprint ?? '????????????'
  }

  async readState() {
    try {
      const text = await readFile(this.statePath, 'utf8')
      return parseJson(text, {}) ?? {}
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return {}
    }
  }

  async writeState() {
    await mkdir(dirname(this.statePath), { recursive: true })
    const tmp = `${this.statePath}.${process.pid}.tmp`
    await writeFile(tmp, JSON.stringify(this.state, null, 2))
    await rename(tmp, this.statePath)
  }

  /**
   * Push newly collected records.
   *
   * @param {object[]} records portable records with `origin`.
   * @param {object} [options]
   * @param {(advanced: object) => void} [options.commit] called after the push succeeds.
   * @param {object} [options.sessionHeaders] `{ sessionId: header }` for native import on peers.
   * @returns {{files: number, records: number, bytes: number}}
   */
  async push(records, options = {}) {
    if (records.length === 0) return { files: 0, records: 0, bytes: 0 }
    const groups = new Map()
    for (const record of records) {
      const root = record.origin?.root ?? record.origin?.session
      if (typeof root !== 'string') continue
      if (!groups.has(root)) groups.set(root, [])
      groups.get(root).push(record)
    }
    let files = 0
    let bytes = 0
    for (const [root, list] of groups) {
      const sessionId = list[0].origin?.session
      const header = options.sessionHeaders?.[sessionId]
      const withMeta = header === undefined ? list : [{ __meta: { header, device: this.device, session: sessionId, agent: this.agent } }, ...list]
      const encoded = encodeChunks(this.key, { root, device: this.device, records: withMeta.map(toChunkRecord) })
      for (const file of encoded) {
        await this.backend.write(file.path, file.bytes)
        this.state.chunks[file.path] = digestOf(file.bytes)
        bytes += file.bytes.length
        files += 1
      }
      const title = titleOf(list)
      await this.writeSessionMeta(root, {
        root,
        title,
        device: this.device,
        agent: this.agent,
        session: sessionId,
        updatedAt: nowMs(),
        records: list.length,
        firstTs: list[0]?.origin?.ts ?? nowMs(),
      })
      // Record our own push locally too, so `sessions` lists what this device
      // produced even before any peer or even our next pull sees it.
      const local = this.state.sessions[sessionId] ?? {}
      this.state.sessions[sessionId] = {
        ...local,
        device: local.device ?? this.device,
        title: local.title ?? title,
        records: (local.records ?? 0) + list.length,
        lastTs: Math.max(local.lastTs ?? 0, ...list.map((record) => record.origin?.ts ?? 0)),
      }
    }
    await this.backend.sync({ direction: 'push', message: `sync: ${records.length} message(s) from ${this.device}` })
    this.state.stats.pushed += records.length
    this.state.stats.bytesOut += bytes
    this.state.lastPushAt = nowMs()
    options.commit?.({})
    await this.writeState()
    return { files, records: records.length, bytes }
  }

  async writeSessionMeta(root, meta) {
    const path = `sessions/${root}/meta.json.enc`
    const bytes = seal(this.key, Buffer.from(canonicalJson(meta)), `dsh-sync:meta:${path}`)
    await this.backend.write(path, bytes)
  }

  /**
   * Pull everything new into the local mirror and report what arrived.
   *
   * @param {object} [options]
   * @param {(session: object) => Promise<boolean>} [options.importSession] called for sessions that are new to this device.
   * @returns {{records: object[], sessions: object[], bytes: number, skipped: number}}
   */
  async pull(options = {}) {
    await this.backend.sync({ direction: 'pull' })
    const listing = await this.backend.list('data/')
    const fresh = listing.filter((entry) => this.state.chunks[entry.path] === undefined)
    const records = []
    let bytes = 0
    let skipped = 0
    for (const entry of fresh) {
      let parsed
      try {
        parsed = decodeChunk(this.key, entry.path, await this.backend.read(entry.path))
      } catch (error) {
        skipped += 1
        this.log(`cannot read ${entry.path}: ${error.message}`)
        continue
      }
      bytes += entry.size ?? 0
      for (const raw of parsed) {
        if (raw && typeof raw === 'object' && raw.__meta !== undefined) {
          this.state.sessions[raw.__meta.session] = {
            ...(this.state.sessions[raw.__meta.session] ?? {}),
            header: raw.__meta.header,
            device: raw.__meta.device,
            importedAt: nowMs(),
          }
          continue
        }
        const record = fromChunkRecord(raw)
        if (record !== null) records.push(record)
      }
      this.state.chunks[entry.path] = digestOf(await this.backend.read(entry.path))
    }
    // An interrupted push can leave two chunks covering the same sequence range.
    // Both are intact, so the fix is at read time: one record per id.
    const unique = new Map()
    let duplicates = 0
    for (const record of records) {
      if (typeof record.id !== 'string') continue
      if (unique.has(record.id)) {
        duplicates += 1
        continue
      }
      unique.set(record.id, record)
    }
    const deduped = [...unique.values()]

    for (const record of deduped) {
      const session = record.origin?.session
      if (typeof session !== 'string') continue
      const known = this.state.sessions[session] ?? {}
      if (known.device === undefined) known.device = record.origin?.device
      known.title = known.title ?? record.origin?.title
      known.records = (known.records ?? 0) + 1
      known.lastTs = Math.max(known.lastTs ?? 0, record.origin?.ts ?? 0)
      this.state.sessions[session] = known
    }
    if (this.mirrorDir !== null) await this.writeMirror(deduped)
    this.state.stats.pulled += deduped.length
    this.state.stats.bytesIn += bytes
    this.state.lastPullAt = nowMs()
    await this.writeState()
    return { records: deduped, sessions: this.sessions(), bytes, skipped, duplicates }
  }

  /** Append pulled records to per-session JSONL files any agent can read. */
  async writeMirror(records) {
    const bySession = new Map()
    // An interrupted push can leave two chunks covering the same sequence range.
    // Both are intact, so the fix is at read time: one record per id.
    const unique = new Map()
    let duplicates = 0
    for (const record of records) {
      if (typeof record.id !== 'string') continue
      if (unique.has(record.id)) {
        duplicates += 1
        continue
      }
      unique.set(record.id, record)
    }
    const deduped = [...unique.values()]

    for (const record of deduped) {
      const session = record.origin?.session
      if (typeof session !== 'string') continue
      if (!bySession.has(session)) bySession.set(session, [])
      bySession.get(session).push(record)
    }
    for (const [session, list] of bySession) {
      const path = join(this.mirrorDir, `${session}.jsonl`)
      await mkdir(dirname(path), { recursive: true })
      const existing = await readFile(path, 'utf8').catch(() => '')
      const seen = new Set(existing.split('\n').filter((line) => line !== '').map((line) => parseJson(line)?.id).filter(Boolean))
      const lines = []
      for (const record of [...list].sort(comparePortable)) {
        if (seen.has(record.id)) continue
        seen.add(record.id)
        lines.push(canonicalJson(record))
      }
      if (lines.length === 0) continue
      await writeFile(path, existing + lines.join('\n') + '\n')
    }
  }

  /** Sessions known locally, newest activity first. */
  sessions() {
    const out = []
    for (const [sessionId, info] of Object.entries(this.state.sessions ?? {})) {
      out.push({
        sessionId,
        title: info.title ?? '同步的对话',
        device: info.device ?? 'unknown',
        records: info.records ?? 0,
        lastTs: info.lastTs ?? 0,
        imported: info.importedAt !== undefined,
      })
    }
    return out.sort((a, b) => b.lastTs - a.lastTs)
  }

  /** One line for the phone status strip. */
  status() {
    const stats = this.state?.stats ?? {}
    return {
      device: this.device,
      fingerprint: this.fingerprint(),
      sessions: this.sessions().length,
      pushed: stats.pushed ?? 0,
      pulled: stats.pulled ?? 0,
      bytesOut: humanBytes(stats.bytesOut ?? 0),
      bytesIn: humanBytes(stats.bytesIn ?? 0),
      lastPushAt: this.state?.lastPushAt ?? null,
      lastPullAt: this.state?.lastPullAt ?? null,
      backend: this.backend.describe?.() ?? this.backend.kind,
    }
  }

  /** Write a note into the shared bus (visible to every agent, including Codex). */
  async addNote({ title, body, tags = [] }) {
    const id = digestOf({ title, body, at: nowMs() }).slice(0, 16)
    const path = notePath(this.device, id)
    const payload = canonicalJson({ v: 1, id, device: this.device, agent: this.agent, title, body, tags, ts: nowMs() })
    await this.backend.write(path, seal(this.key, Buffer.from(payload), `dsh-sync:note:${path}`))
    await this.backend.sync({ direction: 'push', message: `note: ${title}` })
    return { id, path }
  }

  /** Read every note newer than a timestamp (0 = all). */
  async listNotes({ since = 0, limit = 50 } = {}) {
    const listing = await this.backend.list('notes/')
    const notes = []
    for (const entry of listing) {
      try {
        const text = open(this.key, await this.backend.read(entry.path), `dsh-sync:note:${entry.path}`).toString('utf8')
        const note = parseJson(text)
        if (note && (note.ts ?? 0) > since) notes.push(note)
      } catch {}
      if (notes.length >= limit) break
    }
    return notes.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
  }

  /**
   * Remove chunk files whose sequence range is already covered by another chunk
   * of the same session and device.
   *
   * This repairs the one redundancy an interrupted push can create: a shorter
   * chunk left behind when the next attempt re-sent a longer range. Reading is
   * already duplicate-safe; compacting keeps the repository from growing.
   *
   * @returns {{removed: number, bytes: number}}
   */
  async compact() {
    const listing = await this.backend.list('')
    const groups = new Map()
    for (const entry of listing) {
      const parts = entry.path.split('/')
      const [area, root, device, name] = parts
      if (area !== 'data' && area !== 'native') continue
      const range = area === 'data' ? parseChunkName(name ?? '') : parseNativeName(name ?? '')
      if (range === undefined) continue
      const key = `${area}/${root}/${device}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push({ path: entry.path, size: entry.size ?? 0, ...range })
    }
    const doomed = []
    for (const chunks of groups.values()) {
      // A longer chunk with the same start comes first, so it wins the coverage.
      chunks.sort((a, b) => a.first - b.first || b.last - a.last)
      let coveredTo = -1
      for (const chunk of chunks) {
        if (chunk.last <= coveredTo) {
          doomed.push(chunk)
          continue
        }
        coveredTo = Math.max(coveredTo, chunk.last)
      }
    }
    let bytes = 0
    for (const chunk of doomed) {
      bytes += chunk.size
      await this.backend.remove(chunk.path)
      delete this.state.chunks[chunk.path]
    }
    if (doomed.length > 0) {
      await this.backend.sync({ direction: 'push', message: `sync: compact ${doomed.length} overlapping chunk(s)` })
      await this.writeState()
    }
    return { removed: doomed.length, bytes }
  }

  /** Forget one local session's sync bookkeeping (does not touch the repository). */
  async forget(sessionId) {
    delete this.state.sessions[sessionId]
    delete this.state.cursor[sessionId]
    await this.writeState()
  }

  /** Remove a locally mirrored session file. */
  async removeMirror(sessionId) {
    if (this.mirrorDir === null) return
    await rm(join(this.mirrorDir, `${sessionId}.jsonl`), { force: true })
  }

  describeSession(sessionId) {
    const info = this.state?.sessions?.[sessionId]
    if (info === undefined) return null
    return { ...info, updatedText: info.lastTs ? isoTime(info.lastTs) : '—', chunkRange: undefined, parsedChunks: this.chunkRanges(sessionId) }
  }

  chunkRanges(sessionId) {
    const ranges = []
    for (const path of Object.keys(this.state?.chunks ?? {})) {
      const parts = path.split('/')
      if (parts[0] !== 'data' || parts[1] !== sessionId) continue
      const parsed = parseChunkName(parts[3] ?? '')
      if (parsed !== undefined) ranges.push({ device: parts[2], ...parsed })
    }
    return ranges.sort((a, b) => a.first - b.first)
  }
}

function toChunkRecord(value) {
  if (value.__meta !== undefined) return value
  return {
    id: value.id,
    origin: value.origin,
    agent: value.agent,
    kind: value.kind,
    role: value.role,
    text: value.text,
    blocks: value.blocks,
    tool: value.tool,
    messageId: value.messageId,
    native: value.native,
  }
}

function fromChunkRecord(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.origin !== 'object') return null
  return raw
}
