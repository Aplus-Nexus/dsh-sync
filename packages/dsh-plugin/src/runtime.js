/**
 * The bridge between one DSH host and the sync engine.
 *
 * Responsibilities, in order of importance:
 *  1. never block the agent loop — every network or disk step is attempted in
 *     the background and a failure only shows up as a status line;
 *  2. be idempotent — a session that already exists locally is never rewritten;
 *  3. be honest — the panel reports what actually happened last, not a guess.
 */
import { mkdir } from 'node:fs/promises'
import {
  DshSource,
  EmptySource,
  FolderBackend,
  GitBackend,
  SyncEngine,
  deviceIdFrom,
  hasLocalSession,
  importNativeSession,
  nowMs,
  parseLogBytes,
  readPortableSession,
  tailFrom,
  titleOf,
} from '../vendor/core/index.js'
import { isAbsolute, join, win32 } from 'node:path'

export class SyncRuntime {
  constructor(ctx, config, paths) {
    this.ctx = ctx
    this.config = config
    this.paths = paths
    this.engine = null
    this.source = null
    this.timer = null
    this.running = null
    this.lastError = null
    this.lastResult = null
    this.device = deviceIdFrom(config.deviceName !== '' ? config.deviceName : defaultDeviceName())
  }

  get sessionsRoot() {
    const fromQuery = this.ctx.get('sessionPersistence')?.root
    if (typeof fromQuery === 'string') return fromQuery
    return join(process.env.DSH_HOME ?? `${process.env.HOME ?? '.'}/.dsh`, 'sessions')
  }

  backend() {
    if (this.config.backend === 'folder') {
      if (this.config.folder === '') throw new Error('先把同步文件夹填上')
      return new FolderBackend(this.config.folder)
    }
    if (this.config.repoUrl === '') throw new Error('先把数据仓库地址填上')
    return new GitBackend({
      url: this.config.repoUrl,
      workdir: this.paths.workdir,
      token: this.config.token,
      branch: this.config.branch,
      identity: `dsh-sync ${this.device} <sync@localhost>`,
    })
  }

  /** Open the engine; safe to call often, it memoizes. */
  async open() {
    if (this.engine !== null) return this.engine
    if (this.config.passphrase.length < 8) throw new Error('同步口令太短：至少 8 个字符')
    await mkdir(join(this.paths.statePath, '..'), { recursive: true })
    const engine = new SyncEngine({
      backend: this.backend(),
      statePath: this.paths.statePath,
      mirrorDir: this.config.mirror === true ? this.paths.mirrorDir : null,
      device: this.device,
      agent: 'dsh',
      log: (message) => this.ctx.logger?.debug?.(`dsh-sync: ${message}`),
    })
    await engine.open({ passphrase: this.config.passphrase })
    // The engine remembers the device id it was created with; adopt it so a
    // hostname change never makes this device look like a new one.
    this.device = engine.device
    this.engine = engine
    const sessionQuery = this.ctx.get('sessionQuery')
    this.source = sessionQuery === undefined
      ? new EmptySource()
      : new DshSource({ sessionQuery, events: this.ctx, device: this.device, cursor: engine.state.cursor })
    return engine
  }

  /** Start the periodic loop and the turn-end hook. */
  start() {
    if (this.config.enabled !== true) return
    if (this.config.intervalSec > 0) {
      this.timer = setInterval(() => {
        void this.sync('timer').catch((error) => {
          this.lastError = { message: error.message, at: nowMs() }
        })
      }, Math.max(15, this.config.intervalSec) * 1000)
      this.timer.unref?.()
    }
    if (this.config.pushOnTurnEnd === true && typeof this.ctx.on === 'function') {
      this.ctx.on('session/event', (_session, event) => {
        if (event?.type !== 'turn/end') return
        void this.sync('turn-end').catch(() => {})
      })
    }
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /** One full round: push what is new locally, then pull and import what is new elsewhere. */
  async sync(reason = 'manual') {
    if (this.running !== null) return this.running
    this.running = (async () => {
      const engine = await this.open()
      const started = nowMs()

      // ---- push -------------------------------------------------------
      const sessions = await this.source.list()
      const ids = sessions.map((row) => row.sessionId).filter((id) => typeof id === 'string')
      const collected = await this.source.collect(ids)
      // A session this device imported already exists on the bus under its
      // origin device. Re-pushing its prefix would duplicate every message
      // under a second identity, so only genuinely new events go out.
      const importedThrough = this.importedPrefixes()
      collected.records = collected.records.filter((record) => {
        const floor = importedThrough[record.origin?.session]
        return floor === undefined || (record.origin?.seq ?? 0) > floor
      })
      const headers = {}
      for (const sessionId of new Set(collected.records.map((record) => record.origin.session))) {
        try {
          headers[sessionId] = (await readPortableSession(this.ctx.get('sessionQuery'), sessionId, this.device)).header
        } catch {}
      }
      const pushed = await engine.push(collected.records, {
        sessionHeaders: headers,
        commit: (advanced) => this.source.commit(advanced),
      })
      await this.pushNative(engine, headers)

      // ---- extras (opt-in) --------------------------------------------
      let extrasOut = []
      if (this.config.syncSettings === true || this.config.syncSkills === true) {
        const { collectExtras, publishExtras } = await import('../vendor/core/index.js')
        const items = await collectExtras({
          home: this.paths.home ?? process.env.DSH_HOME ?? `${process.env.HOME}/.dsh`,
          settings: this.config.syncSettings === true,
          skills: this.config.syncSkills === true,
          ui: this.config.syncSkills === true,
        })
        extrasOut = await publishExtras(engine, items)
      }

      // ---- pull -------------------------------------------------------
      const pulled = await engine.pull()
      const imported = this.config.importNative === true ? await this.importPulled(engine, pulled.records) : []

      this.lastResult = {
        reason,
        at: nowMs(),
        ms: nowMs() - started,
        pushed: pushed.records,
        pulled: pulled.records.length,
        imported: imported.filter((entry) => entry.imported === true).length,
        extras: extrasOut.length,
        skipped: pulled.skipped,
      }
      this.lastError = null
      return this.lastResult
    })()
    try {
      return await this.running
    } finally {
      this.running = null
    }
  }

  /**
   * Create a native, continuable DSH session for a conversation that has no
   * DSH log of its own (Codex, Claude Code, an imported transcript).
   *
   * The synthesized log is validated with DSH's codec before it is written, and
   * the session stays untouched on every later sync.
   */
  async synthesizeFromRecords(engine, sessionId, records) {
    const { synthesizeSession, synthesizeSessionId, writeLog } = await import('../vendor/core/index.js')
    const targetId = synthesizeSessionId(sessionId)
    const cwd = this.workspaceCwd()
    const existing = await hasLocalSession(this.sessionsRoot, { id: targetId, cwd })
    if (existing !== false) return { imported: false, reason: 'exists' }
    const { header, events } = synthesizeSession({
      sessionId: targetId,
      records,
      cwd,
      sourceLabel: records[0]?.agent === 'codex' ? 'codex' : (records[0]?.agent ?? 'imported'),
    })
    const validation = await this.validateLog(header, events)
    if (validation !== true) return { imported: false, reason: `invalid-log: ${validation}` }
    const result = await writeLog({ sessionsRoot: this.sessionsRoot, header, events })
    engine.state.sessions[sessionId] = {
      ...(engine.state.sessions[sessionId] ?? {}),
      synthesizedId: targetId,
      importedAt: Date.now(),
    }
    await engine.writeState()
    return { imported: result.imported, path: result.path, sessionId: result.sessionId ?? targetId, synthesized: true, reason: result.reason }
  }

  /**
   * An absolute working directory on this device.
   *
   * A synthesized header must carry a cwd the *reading* platform accepts, so
   * the host's own path is used verbatim rather than forced to POSIX.
   */
  workspaceCwd() {
    const candidate = process.env.DSH_SYNC_CWD ?? process.cwd()
    if (isAbsolute(candidate) || win32.isAbsolute(candidate)) return candidate
    return win32.isAbsolute(process.cwd()) ? process.cwd() : '/'
  }

  /**
   * Ask DSH's own session codec whether a log is valid.
   *
   * The codec is optional: a host without it skips the check rather than
   * refusing to import, and the caller reports that honestly.
   */
  async validateLog(header, events) {
    let catalog
    try {
      catalog = await import('@deepseek-ai/dsh-session-format-catalog')
    } catch {
      return true
    }
    try {
      const restore = catalog.sessionFormatCatalog.createRestore(header, { recovery: 'recoverable', validation: 'current' })
      for (const event of events) restore.decodeRow(event, { emitEvent() {}, emitRun() {} })
      restore.finish()
      return true
    } catch (error) {
      return error.message
    }
  }

  /** How far each imported session was already present when it arrived here. */
  importedPrefixes() {
    const out = {}
    for (const [sessionId, info] of Object.entries(this.engine?.state?.sessions ?? {})) {
      if (info.importedThroughSeq !== undefined) out[sessionId] = info.importedThroughSeq
    }
    return out
  }

  /**
   * Push the origin device's own native log, byte for byte, so a peer can
   * import a real conversation instead of a reconstruction. Only the tail past
   * the last pushed sequence number is written, so this stays incremental, and
   * an imported session starts after the prefix that came from its author.
   */
  async pushNative(engine, headers) {
    const { nativePath, encodeNativeChunk } = await import('../vendor/core/index.js')
    for (const [sessionId, header] of Object.entries(headers ?? {})) {
      try {
        const bytes = await this.nativeLogBytes(sessionId)
        if (bytes === null) {
          this.ctx.logger?.warn?.(`dsh-sync: no local log path for ${sessionId}`)
          continue
        }
        const parsed = parseLogBytes(bytes)
        const state = engine.state.sessions?.[sessionId] ?? {}
        const known = Number.isInteger(state.pushedSeq) ? state.pushedSeq : state.importedThroughSeq
        const fromSeq = Number.isInteger(known) ? known + 1 : 0
        const lastSeq = parsed.events[parsed.events.length - 1] === undefined
          ? -1
          : (JSON.parse(parsed.events[parsed.events.length - 1]).seq ?? parsed.events.length - 1)
        if (lastSeq < fromSeq) {
          this.ctx.logger?.warn?.(`dsh-sync: nothing new for ${sessionId} (last ${lastSeq}, pushed ${fromSeq - 1})`)
          continue
        }
        const tail = tailFrom(parsed.events, fromSeq - 1)
        const chunk = [`${JSON.stringify(parsed.header)}`, ...tail].join('\n') + '\n'
        const target = nativePath(parsed.header.id ?? sessionId, this.device, fromSeq, lastSeq)
        await engine.backend.write(target, encodeNativeChunk(engine.key, target, chunk))
        engine.state.sessions[sessionId] = {
          ...(engine.state.sessions[sessionId] ?? {}),
          pushedSeq: lastSeq,
          nativeHeader: parsed.header,
        }
      } catch (error) {
        // Loud enough to debug, quiet enough not to nag a user every minute.
        this.lastError = this.lastError ?? { message: error.message, at: Date.now() }
        this.ctx.logger?.warn?.(`dsh-sync: native push skipped for ${sessionId}: ${error.message}`)
      }
    }
    await engine.backend.sync({ direction: 'push', message: `sync: native logs from ${this.device}` })
    await engine.writeState()
  }

  /**
   * The raw bytes of one local log.
   *
   * Persistence knows the path of a session it created; a session this device
   * imported is not in that index yet on every host, so the path recorded at
   * import time is the fallback.
   */
  async nativeLogBytes(sessionId) {
    const persistence = this.ctx.get('sessionPersistence')
    const located = persistence?.stat === undefined ? undefined : await persistence.stat(sessionId).catch(() => undefined)
    const candidate = located?.location?.path ?? this.engine?.state?.sessions?.[sessionId]?.localPath
    if (typeof candidate !== 'string') return null
    const { readFile } = await import('node:fs/promises')
    return readFile(candidate).catch(() => null)
  }

  /** Import every session this device has never seen, newest first. */
  async importPulled(engine, records) {
    const bySession = new Map()
    for (const record of records) {
      const session = record.origin?.session
      if (typeof session !== 'string') continue
      if (!bySession.has(session)) bySession.set(session, [])
      bySession.get(session).push(record)
    }
    const results = []
    for (const [sessionId, list] of bySession) {
      const header = engine.state.sessions?.[sessionId]?.header
      const exists = header === undefined || typeof header !== 'object'
        ? false
        : await hasLocalSession(this.sessionsRoot, header)
      if (exists !== false) {
        results.push({ sessionId, imported: false, reason: 'exists' })
        continue
      }
      try {
        const native = await this.readNativeLog(engine, sessionId)
        if (native !== null) {
          const result = await importNativeSession({ sessionsRoot: this.sessionsRoot, header: native.header, events: native.events, fallbackCwd: process.cwd() })
          if (result.imported === true) {
            const lastSeq = native.events.reduce((max, line) => {
              try {
                const seq = JSON.parse(line).seq
                return Number.isInteger(seq) && seq > max ? seq : max
              } catch {
                return max
              }
            }, -1)
            engine.state.sessions[sessionId] = {
              ...(engine.state.sessions[sessionId] ?? {}),
              importedThroughSeq: lastSeq,
              pushedSeq: lastSeq,
              importedAt: Date.now(),
              localPath: result.path,
            }
            await engine.writeState()
          }
          results.push({ sessionId, ...result })
          continue
        }
        // No native log: the conversation came from another agent, so build a
        // real DSH session for it instead of leaving it as a read-only mirror.
        const synth = await this.synthesizeFromRecords(engine, sessionId, list)
        results.push({ sessionId, ...synth })
        continue
      } catch (error) {
        results.push({ sessionId, imported: false, reason: error.message })
      }
    }
    return results
  }

  /**
   * Reassemble one session's native log from every device's chunks.
   *
   * A conversation can be continued on a second device after import, so chunks
   * from several devices have to merge. Events are keyed by their sequence
   * number: the author's prefix wins, a continuation fills in after it, and a
   * duplicated event can never appear twice in the restored log.
   */
  async readNativeLog(engine, sessionId) {
    const { decodeNativeChunk, parseNativeName } = await import('../vendor/core/index.js')
    const listing = await engine.backend.list(`native/${sessionId}/`)
    const parts = []
    for (const entry of listing) {
      const range = parseNativeName(entry.path.split('/').pop() ?? '')
      if (range !== undefined) parts.push({ range, path: entry.path })
    }
    if (parts.length === 0) return null
    parts.sort((a, b) => a.range.first - b.range.first)
    const bySeq = new Map()
    let header = null
    for (const part of parts) {
      let text
      try {
        text = decodeNativeChunk(engine.key, part.path, await engine.backend.read(part.path))
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue
        let value
        try {
          value = JSON.parse(line)
        } catch {
          continue
        }
        if (value?.type === 'session' && value.id !== undefined) {
          // The first chunk's header is the author's own; a later device's
          // chunk only carries the same header again, never a different one.
          if (header === null) header = value
          else if (header.id !== value.id) throw new Error(`session ${sessionId} has chunks for two different sessions`)
          continue
        }
        if (Number.isInteger(value?.seq) && !bySeq.has(value.seq)) bySeq.set(value.seq, line)
      }
    }
    if (header === null) return null
    const events = [...bySeq.entries()].sort((a, b) => a[0] - b[0]).map((entry) => entry[1])
    // Keep `type: "session"` on the header: encodeLogBytes writes it back as
    // the first physical line and DSH requires it there.
    return { header, events }
  }

  /** Title list for the panel, merging local and remote knowledge. */
  async sessionRows() {
    const engine = await this.open()
    return engine.sessions()
  }

  status() {
    const base = {
      device: this.device,
      enabled: this.config.enabled,
      backend: this.config.backend,
      running: this.running !== null,
      lastError: this.lastError,
      lastResult: this.lastResult,
      fingerprint: this.engine?.fingerprint() ?? null,
      totals: this.engine?.status() ?? null,
    }
    return base
  }
}

function defaultDeviceName() {
  const host = process.env.DSH_DEVICE_NAME ?? process.env.HOSTNAME ?? 'phone'
  return host
}

export { titleOf }
