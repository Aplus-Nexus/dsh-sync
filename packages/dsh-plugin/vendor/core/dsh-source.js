/**
 * DSH live sync: follow the local Session store and turn committed events into
 * portable records on a schedule the caller controls.
 *
 * This module is host-agnostic: it takes any object shaped like DSH's
 * `sessionQuery` (`listSessions`, `readSession`) and an optional event emitter
 * (`on('session/event')`), so the same code runs in the dsh-go engine, in the
 * desktop DSH, and in tests.
 */
import { portableFromDshEvent } from './portable.js'

/** Extract the origin identity of one DSH session header. */
export function originOf(header) {
  const session = header.id
  return {
    root: header.rootSession ?? header.parentSession ?? session,
    parent: header.parentSession ?? null,
    session,
    depth: Number.isInteger(header.delegationDepth) ? header.delegationDepth : 0,
  }
}

/**
 * Read one session's full event log through `sessionQuery.readSession`, then
 * fold it. Returns portable records and the origin map needed for reassembly.
 */
export async function readPortableSession(sessionQuery, sessionId, device) {
  const snapshot = await sessionQuery.readSession(sessionId)
  const header = snapshot.session ?? {}
  const origin = originOf(header)
  const records = []
  for (const event of snapshot.events ?? []) {
    const record = portableFromDshEvent(event, { device, session: origin.session, root: origin.root, parent: origin.parent })
    if (record !== null) records.push(record)
  }
  return { header, origin, records, inheritedEventCount: snapshot.inheritedEventCount ?? 0 }
}

/**
 * A stand-in for a host with no session store: it lists nothing and collects
 * nothing. The engine then still pulls, mirrors and imports — the plugin works
 * read-only instead of refusing to start on an unexpected host.
 */
export class EmptySource {
  device = 'unknown'
  cursor = {}

  async list() {
    return []
  }

  async collect() {
    return { records: [], advanced: {} }
  }

  commit() {}

  snapshotCursor() {
    return {}
  }
}

/**
 * A cursor that remembers, per local session, the highest sequence number
 * already exported, so a pull only reads what is new.
 */
export class DshSource {
  constructor({ sessionQuery, events, device, cursor = {} }) {
    if (!sessionQuery || typeof sessionQuery.readSession !== 'function') throw new Error('DshSource needs sessionQuery.readSession')
    this.sessionQuery = sessionQuery
    this.events = events
    this.device = device
    this.cursor = { ...cursor }
    this.listeners = []
    this.dirty = new Set()
  }

  /** Attach to DSH's `session/event` hook; returns a disposer. */
  attach(ctx) {
    if (!ctx || typeof ctx.on !== 'function') return () => {}
    const off = ctx.on('session/event', (session, event) => {
      const id = session?.id ?? session?.session?.id
      if (typeof id !== 'string') return
      const seq = typeof event?.seq === 'number' ? event.seq : -1
      const seen = this.cursor[id] ?? -1
      if (seq <= seen) return
      this.dirty.add(id)
      for (const listener of this.listeners) {
        try {
          listener(id)
        } catch {}
      }
    })
    this.listeners.push(off)
    return () => {
      if (typeof off === 'function') off()
    }
  }

  /** Sessions that changed since the last drain. */
  takeDirty() {
    const out = [...this.dirty]
    this.dirty.clear()
    return out
  }

  /**
   * List local sessions newest-first.
   *
   * DSH returns an array of `{ header, live, persisted }`; a bare
   * `{ id: header }` map is also accepted so a minimal host or a test stub
   * does not have to imitate every field.
   */
  async list() {
    if (typeof this.sessionQuery.listSessions !== 'function') return []
    const rows = await this.sessionQuery.listSessions()
    if (Array.isArray(rows)) {
      return rows.map((row) => ({
        sessionId: row.header?.id ?? row.id,
        createdAt: row.header?.createdAt ?? row.createdAt ?? 0,
        title: row.title ?? undefined,
        header: row.header ?? {},
      })).filter((row) => typeof row.sessionId === 'string')
    }
    if (rows !== null && typeof rows === 'object') {
      return Object.values(rows).map((header) => ({
        sessionId: header?.id,
        createdAt: header?.createdAt ?? 0,
        header,
      })).filter((row) => typeof row.sessionId === 'string')
    }
    return []
  }

  /**
   * Collect records newer than the stored cursor for the given sessions.
   * Writes the advanced cursor back into `this.cursor` only on success.
   */
  async collect(sessionIds, { full = false } = {}) {
    const batch = []
    const advanced = {}
    for (const sessionId of sessionIds) {
      const { header, origin, records } = await readPortableSession(this.sessionQuery, sessionId, this.device)
      const seen = full ? -1 : this.cursor[sessionId] ?? -1
      const fresh = records.filter((record) => record.origin.seq > seen)
      if (fresh.length === 0) continue
      for (const record of fresh) {
        record.origin.rootId = origin.root
        record.origin.depth = origin.depth
        record.origin.title = header.title ?? undefined
        batch.push(record)
      }
      advanced[sessionId] = Math.max(...records.map((record) => record.origin.seq))
    }
    return { records: batch, advanced }
  }

  commit(advanced) {
    for (const [sessionId, seq] of Object.entries(advanced)) {
      this.cursor[sessionId] = Math.max(this.cursor[sessionId] ?? -1, seq)
    }
  }

  snapshotCursor() {
    return { ...this.cursor }
  }
}
