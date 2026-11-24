/**
 * A device that joins later must not upload its own history.
 *
 * `pushScope: 'synced'` is what makes "this phone is the source of truth, the
 * others only carry the conversations they sync" true: everything that was
 * already on the joining device stays private and unchanged.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SyncEngine } from '../vendor/core/engine.js'
import { FolderBackend } from '../vendor/core/backends.js'
import { SyncRuntime } from '../src/runtime.js'

const PASS = 'a long shared passphrase'

function ctxFor({ sessions = [], logs = new Map(), root }) {
  return {
    get(name) {
      if (name === 'sessionQuery') {
        return {
          async listSessions() { return sessions.map((header) => ({ header, live: true, persisted: true })) },
          async readSession(id) {
            const found = logs.get(id)
            if (found === undefined) throw new Error('no such session')
            return found
          },
        }
      }
      if (name === 'sessionPersistence') {
        return {
          root,
          async stat(id) {
            const found = logs.get(id)
            return found === undefined ? undefined : { location: { kind: 'jsonl', path: found.path } }
          },
        }
      }
      return undefined
    },
    on: () => () => {},
    logger: { debug() {}, info() {}, warn() {} },
  }
}

test('pushScope synced publishes only conversations that came from the bus', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-scope-'))
  const repo = join(dir, 'repo')
  const sessionsRoot = join(dir, 'sessions')
  try {
    // One conversation already exists on the joining device and must stay private.
    const privateHeader = { id: 'session-private', createdAt: 1, cwd: '/root/workspace', isSeeded: false, delegationDepth: 0, version: 4 }
    const privateLog = join(dir, 'private.v4.jsonl.zstd')
    await (await import('node:fs/promises')).writeFile(privateLog, Buffer.alloc(0))
    const logs = new Map([[privateHeader.id, { session: privateHeader, events: [{ type: 'user/message', seq: 0, time: 1, data: { role: 'user', content: [{ type: 'text', text: '我的私密旧对话' }], source: { kind: 'user' }, id: 'p1' }, surfaceOp: 'append' }], inheritedEventCount: 0, path: privateLog }]])

    const runtime = new SyncRuntime(ctxFor({ sessions: [privateHeader], logs, root: sessionsRoot }), {
      enabled: false, backend: 'folder', folder: repo, passphrase: PASS, deviceName: 'phone-b',
      pushScope: 'synced', importNative: true, intervalSec: 0,
    }, { workdir: join(dir, 'w'), statePath: join(dir, 's.json'), mirrorDir: null, exportDir: null, home: dir })

    const result = await runtime.sync('scope-test')
    assert.equal(result.pushed, 0, 'nothing of the private history is published')
    const dataChunks = await readdir(join(repo, 'data')).catch(() => [])
    assert.deepEqual(dataChunks, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a continuation of a synced conversation is still published', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-scope-'))
  const repo = join(dir, 'repo')
  const sessionsRoot = join(dir, 'sessions')
  try {
    // The owner publishes one conversation.
    const owner = new SyncEngine({ backend: new FolderBackend(repo), statePath: join(dir, 'a.json'), device: 'phone-a' })
    await owner.open({ passphrase: PASS })
    await owner.push([{
      id: 'x0',
      origin: { device: 'phone-a', session: 'session-shared', root: 'session-shared', parent: null, seq: 0, ts: 1, eventType: 'user/message' },
      agent: 'dsh', kind: 'message', role: 'user', text: '主手机上的对话',
    }])

    // The joining device sees it as synced, then writes one more turn.
    const header = { id: 'session-shared', createdAt: 1, cwd: '/root/workspace', isSeeded: false, delegationDepth: 0, version: 4 }
    const logPath = join(dir, 'shared.v4.jsonl.zstd')
    await (await import('node:fs/promises')).writeFile(logPath, Buffer.alloc(0))
    const logs = new Map([[header.id, {
      session: header,
      events: [
        { type: 'user/message', seq: 0, time: 1, data: { role: 'user', content: [{ type: 'text', text: '主手机上的对话' }], source: { kind: 'user' }, id: 'm0' }, surfaceOp: 'append' },
        { type: 'assistant/message', seq: 1, time: 2, data: { turn: 1, step: 1, message: { role: 'assistant', id: 'a1', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: '这台设备接着答的' }] }, stream: [] }, surfaceOp: 'append' },
      ],
      inheritedEventCount: 0,
      path: logPath,
    }]])

    const runtime = new SyncRuntime(ctxFor({ sessions: [header], logs, root: sessionsRoot }), {
      enabled: false, backend: 'folder', folder: repo, passphrase: PASS, deviceName: 'phone-b',
      pushScope: 'synced', importNative: true, intervalSec: 0,
    }, { workdir: join(dir, 'w'), statePath: join(dir, 'b.json'), mirrorDir: null, exportDir: null, home: dir })
    // Mark it as arriving from the bus, with the owner's prefix already known.
    await runtime.open()
    runtime.engine.state.sessions['session-shared'] = { device: 'phone-a', importedAt: Date.now(), importedThroughSeq: 0, pushedSeq: 0 }
    runtime.source.cursor['session-shared'] = 0

    const result = await runtime.sync('continuation')
    assert.ok(result.pushed >= 1, `expected the continuation to be published, pushed ${result.pushed}`)

    // The owner pulls it back and sees the new turn.
    const owner2 = new SyncEngine({ backend: new FolderBackend(repo), statePath: join(dir, 'a2.json'), device: 'phone-a-check' })
    await owner2.open({ passphrase: PASS })
    const pulled = await owner2.pull()
    assert.ok(pulled.records.some((record) => record.text === '这台设备接着答的'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('pushScope all publishes the local history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-scope-'))
  const repo = join(dir, 'repo')
  const sessionsRoot = join(dir, 'sessions')
  try {
    const header = { id: 'session-main', createdAt: 1, cwd: '/root/workspace', isSeeded: false, delegationDepth: 0, version: 4 }
    const logPath = join(dir, 'main.v4.jsonl.zstd')
    await (await import('node:fs/promises')).writeFile(logPath, Buffer.alloc(0))
    const logs = new Map([[header.id, { session: header, events: [{ type: 'user/message', seq: 0, time: 1, data: { role: 'user', content: [{ type: 'text', text: '要同步的对话' }], source: { kind: 'user' }, id: 'm1' }, surfaceOp: 'append' }], inheritedEventCount: 0, path: logPath }]])

    const runtime = new SyncRuntime(ctxFor({ sessions: [header], logs, root: sessionsRoot }), {
      enabled: false, backend: 'folder', folder: repo, passphrase: PASS, deviceName: 'phone-a',
      pushScope: 'all', importNative: true, intervalSec: 0,
    }, { workdir: join(dir, 'w'), statePath: join(dir, 's.json'), mirrorDir: null, exportDir: null, home: dir })

    const result = await runtime.sync('scope-test')
    assert.ok(result.pushed > 0)
    const chunks = await readdir(join(repo, 'data', 'session-main', runtime.device))
    assert.ok(chunks.length > 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
