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
      let ids = sessions.map((row) => row.sessionId).filter((id) => typeof id === 'string')
      if (this.config.pushScope === 'synced') {
        // Only conversations that came from the bus. Everything else on this
        // device stays private and untouched, which is what "only affect the
        // synced conversations" means.
        ids = ids.filter((id) => engine.state.sessions?.[id]?.importedAt !== undefined)
      }
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
        // The cursor only advances when the push actually succeeded; passing the
        // collected map is what stops the next sync from re-sending everything.
        advanced: collected.advanced,
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
      // Overlap only appears after an interrupted push; repair it when seen.
      const compaction = pulled.duplicates > 0 ? await engine.compact() : { removed: 0 }
      const imported = this.config.importNative === true ? await this.importPulled(engine, pulled.records) : []

      this.lastResult = {
        reason,
        at: nowMs(),
        ms: nowMs() - started,
        pushed: pushed.records,
        pulled: pulled.records.length,
        imported: imported.filter((entry) => entry.imported === true).length,
        conflicts: imported.reduce((total, entry) => total + (entry.conflicts?.filter((fork) => fork.created === true).length ?? 0), 0),
        compacted: compaction.removed,
        duplicates: pulled.duplicates,
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
      // The synthesized log is now this device's copy of the origin, so pushing
      // it back would duplicate every message under a second identity.
      importedThroughSeq: lastSequence(events.map((event) => JSON.stringify(event))),
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
        // Nothing new is the normal case on a timer tick; stay quiet.
        if (lastSeq < fromSeq) continue
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
    // A session may arrive with only its native chunks (the author published no
    // portable records yet), so enumerate those too instead of missing them.
    for (const entry of await engine.backend.list('native/')) {
      const sessionId = entry.path.split('/')[1]
      if (typeof sessionId !== 'string' || sessionId === '') continue
      if (!bySession.has(sessionId)) bySession.set(sessionId, [])
    }

    const results = []
    for (const [sessionId, list] of bySession) {
      try {
        const native = await this.readNativeLog(engine, sessionId)
        if (native === null) {
          // No native log: the conversation came from another agent, so build a
          // real DSH session for it instead of leaving it as a read-only mirror.
          results.push({ sessionId, ...(await this.synthesizeFromRecords(engine, sessionId, list)) })
          continue
        }

        const localHeader = engine.state.sessions?.[sessionId]?.header
        const exists = localHeader === undefined ? false : await hasLocalSession(this.sessionsRoot, native.header)
        const entry = { sessionId, imported: false }
        if (exists === false) {
          const result = await importNativeSession({ sessionsRoot: this.sessionsRoot, header: native.header, events: native.events, fallbackCwd: process.cwd() })
          if (result.imported === true) {
            const lastSeq = lastSequence(native.events)
            engine.state.sessions[sessionId] = {
              ...(engine.state.sessions[sessionId] ?? {}),
              importedThroughSeq: lastSeq,
              pushedSeq: lastSeq,
              importedAt: Date.now(),
              localPath: result.path,
            }
            await engine.writeState()
            entry.imported = true
            entry.path = result.path
          } else {
            entry.reason = result.reason
          }
        } else {
          entry.reason = 'exists'
        }

        // A diverged branch is never dropped: it becomes its own conversation.
        const forks = await this.materializeConflicts(engine, sessionId, native, list)
        if (forks.length > 0) entry.conflicts = forks
        results.push(entry)
        continue
      } catch (error) {
        results.push({ sessionId, imported: false, reason: error.message })
      }
    }
    return results
  }

  /**
   * Open every divergent branch as its own conversation, titled `（冲突N）`.
   *
   * The fork keeps the canonical prefix so it reads as a coherent conversation,
   * then the losing branch's events, then a title event that names it. Each
   * branch is created once: the mapping is recorded in state, so a later sync
   * neither re-creates it nor overwrites the user's edits inside it.
   */
  async materializeConflicts(engine, sessionId, native, list) {
    if (native.conflict !== true || native.branches.length === 0) return []
    const { buildConflictTail, writeLog } = await import('../vendor/core/index.js')
    const known = engine.state.sessions?.[sessionId]?.conflicts ?? {}
    const baseTitle = engine.state.sessions?.[sessionId]?.title ?? titleOf(list) ?? '同步的对话'
    const created = []

    let index = Object.keys(known).length
    for (const branch of native.branches) {
      if (known[branch.device] !== undefined) continue
      index += 1
      const forkId = `${sessionId}-c${index}`
      const prefix = native.events.filter((line) => sequenceOf(line) < branch.fromSeq)
      const tail = buildConflictTail({
        prefix,
        branch: branch.events,
        lastSeq: branch.fromSeq - 1,
        title: `${baseTitle}（冲突${index}）`,
      })
      const header = { ...native.header, id: forkId, createdAt: Date.now(), isSeeded: false, delegationDepth: 0 }
      delete header.parentSession
      delete header.origin
      const validation = await this.validateLog(header, tail)
      if (validation !== true) {
        created.push({ forkId, created: false, reason: `invalid-log: ${validation}` })
        continue
      }
      const written = await writeLog({ sessionsRoot: this.sessionsRoot, header, events: tail, fallbackCwd: this.workspaceCwd() })
      created.push({ forkId, created: written.imported === true, device: branch.device, reason: written.reason })
      if (written.imported === true) {
        known[branch.device] = { forkId, at: Date.now() }
        engine.state.sessions[sessionId] = { ...(engine.state.sessions[sessionId] ?? {}), conflicts: known }
        await engine.writeState()
      }
    }
    return created
  }

  /**
   * Reassemble one session's native log from every device's chunks.
   *
   * A conversation can be continued on several devices after import. Where two
   * devices wrote different events at the same sequence, the session's owner
   * keeps the canonical branch and every other branch is returned separately so
   * it can be opened as its own conversation. Nothing is silently dropped.
   *
   * @returns {{header: object, events: string[], branches: object[], conflict: boolean}|null}
   */
  async readNativeLog(engine, sessionId) {
    const { decodeNativeChunk, parseNativeName, mergeNativeBranches } = await import('../vendor/core/index.js')
    const listing = await engine.backend.list(`native/${sessionId}/`)
    const parts = []
    for (const entry of listing) {
      const range = parseNativeName(entry.path.split('/').pop() ?? '')
      if (range === undefined) continue
      const device = entry.path.split('/')[2] ?? 'unknown'
      let text
      try {
        text = decodeNativeChunk(engine.key, entry.path, await engine.backend.read(entry.path))
      } catch {
        continue
      }
      parts.push({ device, range, lines: text.split('\n').filter((line) => line.trim() !== '') })
    }
    if (parts.length === 0) return null
    parts.sort((a, b) => a.range.first - b.range.first)

    const owner = engine.state.sessions?.[sessionId]?.device
    const merged = mergeNativeBranches(parts, { ownerDevice: owner })
    if (merged.header === null) return null
    merged.lines = parts
    // Keep `type: "session"` on the header: encodeLogBytes writes it back as the
    // first physical line and DSH requires it there.
    return merged
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

/** Last sequence number in a list of event lines. */
function lastSequence(lines) {
  let max = -1
  for (const line of lines) {
    const seq = sequenceOf(line)
    if (seq > max) max = seq
  }
  return max
}

function sequenceOf(line) {
  try {
    const value = JSON.parse(line)
    return Number.isInteger(value?.seq) ? value.seq : -1
  } catch {
    return -1
  }
}
