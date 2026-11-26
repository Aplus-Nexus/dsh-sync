/**
 * A native log must be published incrementally.
 *
 * It was not: on any tick that had at least one new message, `pushNative` wrote
 * a chunk starting at sequence 0 again, so every sync added a full re-encrypted
 * copy of the whole conversation to the history. That is where most of the
 * gigabytes came from.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SyncEngine } from '../vendor/core/engine.js'
import { FolderBackend } from '../vendor/core/backends.js'
import { nativePath, encodeNativeChunk, decodeNativeChunk } from '../vendor/core/index.js'
import { SyncRuntime } from '../src/runtime.js'
import { sampleHeader, sampleEventLines } from './fixtures.js'

const PASS = 'a long shared passphrase'

function runtimeFor({ dir, repo, logPath, header }) {
  const ctx = {
    get(name) {
      if (name === 'sessionPersistence') {
        return {
          root: join(dir, 'sessions'),
          async stat() { return { location: { kind: 'jsonl', path: logPath } } },
        }
      }
      if (name === 'sessionQuery') {
        return {
          async listSessions() { return [{ header, live: true }] },
          async readSession() { return { session: header, events: [], inheritedEventCount: 0 } },
        }
      }
      return undefined
    },
    on: () => () => {},
    logger: { debug() {}, info() {}, warn() {} },
  }
  const runtime = new SyncRuntime(ctx, { enabled: false, backend: 'folder', folder: repo, passphrase: PASS, deviceName: 'phone', pushScope: 'all', importNative: false }, {
    workdir: join(dir, 'w'), statePath: join(dir, 'state.json'), mirrorDir: null, exportDir: null, home: dir,
  })
  return runtime
}

test('a second native push writes only the new tail', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-native-'))
  const repo = join(dir, 'repo')
  try {
    const header = sampleHeader({ sessionId: 'session-inc' })
    const lines = sampleEventLines({ turns: 3 })
    const logPath = join(dir, 'log.v4.jsonl.zstd')
    await writeFile(logPath, encodeNativeLog(header, lines))
    const runtime = runtimeFor({ dir, repo, logPath, header })
    await runtime.open()

    await runtime.pushNative(runtime.engine, { 'session-inc': header })
    const device = runtime.device
    const first = (await runtime.engine.backend.list(`native/session-inc/${device}/`)).map((e) => e.path)
    assert.equal(first.length, 1)
    const firstRange = first[0].split('/').pop()
    assert.match(firstRange, /^000000-/)

    // Extend the log the way DSH would append a turn.
    const extended = [...lines, ...sampleEventLines({ turns: 1 }).map((line) => {
      const value = JSON.parse(line)
      return JSON.stringify({ ...value, seq: value.seq + lines.length })
    })]
    await writeFile(logPath, encodeNativeLog(header, extended))
    await runtime.pushNative(runtime.engine, { 'session-inc': header })

    const chunks = (await runtime.engine.backend.list(`native/session-inc/${device}/`)).map((e) => e.path)
    assert.equal(chunks.length, 2, 'a continuation is a new chunk, not a rewrite')
    const ranges = chunks.map((path) => path.split('/').pop()).sort()
    assert.match(ranges[1], /^0000\d\d-/, 'the second chunk starts after the first, not at zero')

    // The first chunk was not rewritten: its bytes are unchanged on disk.
    const firstBytes = await runtime.engine.backend.read(first[0])
    const text = decodeNativeChunk(runtime.engine.key, first[0], firstBytes)
    assert.ok(JSON.parse(text.split('\n')[1]).seq === 0, 'the first chunk still begins at sequence 0')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an idle native push writes nothing at all', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-native-'))
  const repo = join(dir, 'repo')
  try {
    const header = sampleHeader({ sessionId: 'session-idle' })
    const logPath = join(dir, 'log.v4.jsonl.zstd')
    await writeFile(logPath, encodeNativeLog(header, sampleEventLines({ turns: 2 })))
    const runtime = runtimeFor({ dir, repo, logPath, header })
    await runtime.open()

    await runtime.pushNative(runtime.engine, { 'session-idle': header })
    const device = runtime.device
    const before = await runtime.engine.backend.list(`native/session-idle/${device}/`)
    for (let i = 0; i < 5; i += 1) await runtime.pushNative(runtime.engine, { 'session-idle': header })
    const after = await runtime.engine.backend.list(`native/session-idle/${device}/`)
    assert.equal(after.length, before.length, 'repeated pushes with no new events add nothing')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

import { encodeLogBytes } from '../vendor/core/native.js'

function encodeNativeLog(header, eventLines) {
  return encodeLogBytes(header, eventLines)
}
