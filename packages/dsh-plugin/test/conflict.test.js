/**
 * Two devices continuing the same conversation at the same time.
 *
 * The requirement is explicit: the session's owner stays canonical, and the
 * other device's turn is not lost — it opens as its own conversation titled
 * `（冲突1）`, once, and only for conversations that actually sync.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SyncEngine } from '../vendor/core/engine.js'
import { FolderBackend } from '../vendor/core/backends.js'
import { parseLogBytes, encodeLogBytes, nativePath, encodeNativeChunk } from '../vendor/core/index.js'
import { SyncRuntime } from '../src/runtime.js'

const PASS = 'a long shared passphrase'

function ctxFor(sessionsRoot) {
  return {
    get(name) {
      if (name === 'sessionPersistence') return { root: sessionsRoot }
      return undefined
    },
    on: () => () => {},
    logger: { debug() {}, info() {}, warn() {} },
  }
}

/** Publish one device's native slice for a session. */
async function publish(engine, { sessionId, device, header, events, fromSeq, toSeq }) {
  const lines = [`${JSON.stringify(header)}`, ...events].join('\n') + '\n'
  const target = nativePath(sessionId, device, fromSeq, toSeq)
  await engine.backend.write(target, encodeNativeChunk(engine.key, target, lines))
  await engine.backend.sync({ direction: 'push', message: `sync: ${device}` })
}

function userEvent(seq, text) {
  return JSON.stringify({ type: 'user/message', seq, time: 1000 + seq, data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' }, id: `m${seq}` }, surfaceOp: 'append' })
}

const HEADER = { type: 'session', version: 4, id: 'session-race', createdAt: 1, cwd: '/root/workspace', isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }

test('a competing turn opens as a separate conversation, once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-conflict-'))
  const repo = join(dir, 'repo')
  const sessionsRoot = join(dir, 'sessions')
  try {
    const a = new SyncEngine({ backend: new FolderBackend(repo), statePath: join(dir, 'a.json'), device: 'phone-a' })
    await a.open({ passphrase: PASS })
    // The owner publishes the conversation as it stands.
    await publish(a, { sessionId: 'session-race', device: 'phone-a', header: HEADER, events: [userEvent(0, '问题')], fromSeq: 0, toSeq: 0 })
    // Both devices answer sequence 1 at the same time, with different text.
    await publish(a, { sessionId: 'session-race', device: 'phone-a', header: HEADER, events: [userEvent(1, '手机这边的回答')], fromSeq: 1, toSeq: 1 })
    await publish(a, { sessionId: 'session-race', device: 'phone-b', header: HEADER, events: [userEvent(1, '另一台设备的回答')], fromSeq: 1, toSeq: 1 })

    const runtime = new SyncRuntime(ctxFor(sessionsRoot), { enabled: false, importNative: true }, {
      workdir: join(dir, 'w'), statePath: join(dir, 'b.json'), mirrorDir: null, exportDir: null, home: dir,
    })
    runtime.engine = new SyncEngine({ backend: new FolderBackend(repo), statePath: join(dir, 'b.json'), device: 'phone-b' })
    await runtime.engine.open({ passphrase: PASS })
    // The owner is phone-a, which is how "this phone is the source of truth" is expressed.
    runtime.engine.state.sessions['session-race'] = { device: 'phone-a', title: '同步方案讨论' }

    const pulled = await runtime.engine.pull()
    const results = await runtime.importPulled(runtime.engine, pulled.records)
    const entry = results.find((row) => row.sessionId === 'session-race')
    assert.notEqual(entry, undefined)
    assert.equal(entry.conflicts.length, 1)
    assert.equal(entry.conflicts[0].created, true)
    assert.equal(entry.conflicts[0].forkId, 'session-race-c1')

    // Canonical session keeps the owner's answer.
    const canonicalPath = join(sessionsRoot, '--root-workspace--', 'session-race', 'session.v4.jsonl.zstd')
    const canonical = parseLogBytes(await readFile(canonicalPath))
    assert.match(canonical.events.join('\n'), /手机这边的回答/)
    assert.equal(canonical.events.join('\n').includes('另一台设备的回答'), false)

    // The fork carries the losing branch and a title that names it.
    const forkDir = join(sessionsRoot, '--root-workspace--', 'session-race-c1')
    const [forkFile] = await readdir(forkDir)
    const fork = parseLogBytes(await readFile(join(forkDir, forkFile)))
    assert.equal(fork.header.id, 'session-race-c1')
    assert.match(fork.events.join('\n'), /另一台设备的回答/)
    const title = fork.events.map((line) => JSON.parse(line)).find((event) => event.type === 'session/title')
    assert.equal(title.data.title, '同步方案讨论（冲突1）')
    // Dense sequence, so DSH can read it.
    assert.deepEqual(fork.events.map((line) => JSON.parse(line).seq), fork.events.map((_, index) => index))

    // A second pull must not create a second fork.
    const again = await runtime.importPulled(runtime.engine, pulled.records)
    const second = again.find((row) => row.sessionId === 'session-race')
    assert.equal(second.conflicts, undefined)
    const dirs = await readdir(join(sessionsRoot, '--root-workspace--'))
    assert.deepEqual(dirs.sort(), ['session-race', 'session-race-c1'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a conversation with no disagreement imports without a fork', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-conflict-'))
  const repo = join(dir, 'repo')
  const sessionsRoot = join(dir, 'sessions')
  try {
    const a = new SyncEngine({ backend: new FolderBackend(repo), statePath: join(dir, 'a.json'), device: 'phone-a' })
    await a.open({ passphrase: PASS })
    await publish(a, { sessionId: 'session-calm', device: 'phone-a', header: { ...HEADER, id: 'session-calm' }, events: [userEvent(0, '问题'), userEvent(1, '回答')], fromSeq: 0, toSeq: 1 })

    const runtime = new SyncRuntime(ctxFor(sessionsRoot), { enabled: false, importNative: true }, {
      workdir: join(dir, 'w'), statePath: join(dir, 'b.json'), mirrorDir: null, exportDir: null, home: dir,
    })
    runtime.engine = new SyncEngine({ backend: new FolderBackend(repo), statePath: join(dir, 'b.json'), device: 'phone-b' })
    await runtime.engine.open({ passphrase: PASS })
    const pulled = await runtime.engine.pull()
    const entry = (await runtime.importPulled(runtime.engine, pulled.records)).find((row) => row.sessionId === 'session-calm')
    assert.equal(entry.imported, true)
    assert.equal(entry.conflicts, undefined)
    const dirs = await readdir(join(sessionsRoot, '--root-workspace--'))
    assert.deepEqual(dirs, ['session-calm'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
