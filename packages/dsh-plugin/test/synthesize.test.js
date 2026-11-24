/**
 * A conversation that only exists on the bus (Codex, Claude Code, an imported
 * transcript) must still become a native DSH session on every device that
 * pulls it — otherwise "sync across agents" would only mean "read-only copy".
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SyncEngine } from '../vendor/core/engine.js'
import { FolderBackend } from '../vendor/core/backends.js'
import { parseLogBytes } from '../vendor/core/native.js'
import { SyncRuntime } from '../src/runtime.js'

const PASS = 'a long shared passphrase'

function silentCtx({ sessionsRoot } = {}) {
  return {
    get(name) {
      if (name === 'sessionPersistence' && sessionsRoot !== undefined) return { root: sessionsRoot }
      return undefined
    },
    on: () => () => {},
    logger: { debug() {}, info() {}, warn() {} },
  }
}

function external(seq, role, text) {
  return {
    id: `x-${seq}`,
    origin: { device: 'laptop', session: 'codex-abc', root: 'codex-abc', parent: null, seq, ts: 1000 + seq * 1000, eventType: role === 'assistant' ? 'assistant/message' : 'user/message' },
    agent: 'codex',
    kind: 'message',
    role,
    text,
  }
}

test('a Codex conversation is imported as a continueable DSH session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-synth-'))
  const repo = join(dir, 'repo')
  const sessionsRoot = join(dir, 'sessions')
  try {
    const publisher = new SyncEngine({ backend: new FolderBackend(repo), statePath: join(dir, 'a.json'), device: 'laptop', agent: 'codex' })
    await publisher.open({ passphrase: PASS })
    await publisher.push([
      external(0, 'user', '这段是在 Codex 里聊的。'),
      external(1, 'assistant', '那它也应该能在手机上接着聊。'),
      external(2, 'user', '对，要原生的。'),
      external(3, 'assistant', '好，我把它变成原生对话。'),
    ])

    const runtime = new SyncRuntime(silentCtx({ sessionsRoot }), { enabled: false, importNative: true }, {
      workdir: join(dir, 'w'), statePath: join(dir, 'b.json'), mirrorDir: null, exportDir: null, home: dir,
    })
    runtime.engine = new SyncEngine({ backend: new FolderBackend(repo), statePath: join(dir, 'b.json'), device: 'phone-b' })
    await runtime.engine.open({ passphrase: PASS })
    const pulled = await runtime.engine.pull()
    assert.equal(pulled.records.length, 4)

    const results = await runtime.importPulled(runtime.engine, pulled.records)
    assert.equal(results.length, 1)
    assert.equal(results[0].imported, true)
    assert.equal(results[0].synthesized, true)
    assert.match(results[0].sessionId, /^session-import-codex-abc$/)

    // The written file is a real log with dense events and a full turn lifecycle.
    const parsed = parseLogBytes(await readFile(results[0].path))
    assert.equal(parsed.header.id, 'session-import-codex-abc')
    assert.deepEqual(parsed.events.map((_, index) => JSON.parse(parsed.events[index]).seq), parsed.events.map((_, index) => index))
    const types = parsed.events.map((line) => JSON.parse(line).type)
    assert.ok(types.includes('turn/start'))
    assert.ok(types.includes('user/message'))
    assert.ok(types.includes('assistant/message'))
    assert.equal(types.at(-1), 'turn/end')
    const body = parsed.events.join('\n')
    assert.match(body, /Codex 里聊的/)
    assert.match(body, /变成原生对话/)

    // A second pull must not create a second copy.
    const again = await runtime.importPulled(runtime.engine, pulled.records)
    assert.equal(again[0].imported, false)
    assert.equal(again[0].reason, 'exists')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a DSH-origin conversation still imports its own native log, not a synthesis', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-synth-'))
  const repo = join(dir, 'repo')
  const sessionsRoot = join(dir, 'sessions')
  try {
    const { synthesizeSession, writeLog, parseLogBytes: parse, encodeLogBytes } = await import('../vendor/core/index.js')
    // Publish a real native log under a DSH-shaped session id.
    const publisher = new SyncEngine({ backend: new FolderBackend(repo), statePath: join(dir, 'a.json'), device: 'phone-a' })
    await publisher.open({ passphrase: PASS })
    const { header, events } = synthesizeSession({ sessionId: 'session-real', records: [{ kind: 'message', role: 'user', text: 'hi', origin: { ts: 1, seq: 0 } }], cwd: '/tmp' })
    const { nativePath, encodeNativeChunk } = await import('../vendor/core/index.js')
    const target = nativePath('session-real', 'phone-a', 0, events.length - 1)
    const chunk = [`${JSON.stringify(header)}`, ...events.map((event) => JSON.stringify(event))].join('\n') + '\n'
    await publisher.backend.write(target, encodeNativeChunk(publisher.key, target, chunk))
    await publisher.backend.sync({ direction: 'push', message: 'a' })

    const runtime = new SyncRuntime(silentCtx({ sessionsRoot }), { enabled: false, importNative: true }, {
      workdir: join(dir, 'w'), statePath: join(dir, 'b.json'), mirrorDir: null, exportDir: null, home: dir,
    })
    runtime.engine = new SyncEngine({ backend: new FolderBackend(repo), statePath: join(dir, 'b.json'), device: 'phone-b' })
    await runtime.engine.open({ passphrase: PASS })
    const pulled = await runtime.engine.pull()
    // A native chunk alone publishes no portable records, so the pull has none;
    // the plugin learns about the session from the native prefix instead.
    const results = pulled.records.length === 0
      ? await runtime.importPulled(runtime.engine, [{ origin: { session: 'session-real' }, text: 'hi', kind: 'message', role: 'user' }])
      : await runtime.importPulled(runtime.engine, pulled.records)
    const imported = results.find((entry) => entry.imported === true)
    assert.notEqual(imported, undefined)
    assert.equal(imported.sessionId, 'session-real')
    assert.equal(imported.synthesized, undefined)
    const parsed = parse(await readFile(imported.path))
    assert.equal(parsed.header.id, 'session-real')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
