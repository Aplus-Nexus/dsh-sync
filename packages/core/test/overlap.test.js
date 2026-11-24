import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SyncEngine } from '../src/engine.js'
import { FolderBackend, MemoryBackend } from '../src/backends.js'
import { nativePath, encodeNativeChunk, parseNativeName } from '../src/store.js'

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'dsh-sync-overlap-'))
}

function record(device, session, seq, text) {
  return {
    id: `id-${device}-${session}-${seq}`,
    origin: { device, session, root: session, parent: null, seq, ts: 1000 + seq, eventType: 'user/message' },
    agent: 'dsh',
    kind: 'message',
    role: 'user',
    text,
  }
}

test('an overlapping chunk is read once, not twice', async () => {
  const backend = new MemoryBackend()
  const dirA = await tempDir()
  const dirB = await tempDir()
  try {
    const a = new SyncEngine({ backend, statePath: join(dirA, 'a.json'), device: 'phone-a' })
    await a.open({ passphrase: 'a long shared passphrase' })
    await a.push([record('phone-a', 's1', 0, 'one'), record('phone-a', 's1', 1, 'two')])
    // Simulate an interrupted push that later re-sent a longer range.
    await a.push([record('phone-a', 's1', 0, 'one'), record('phone-a', 's1', 1, 'two'), record('phone-a', 's1', 2, 'three')])

    const b = new SyncEngine({ backend, statePath: join(dirB, 'b.json'), device: 'laptop' })
    await b.open({ passphrase: 'a long shared passphrase' })
    const pulled = await b.pull()
    assert.equal(pulled.records.length, 3)
    assert.deepEqual(pulled.records.map((r) => r.text).sort(), ['one', 'three', 'two'])
    assert.ok(pulled.duplicates >= 2, `expected duplicates to be reported, got ${pulled.duplicates}`)
  } finally {
    await rm(dirA, { recursive: true, force: true })
    await rm(dirB, { recursive: true, force: true })
  }
})

test('compaction removes a chunk fully covered by a longer one', async () => {
  const backend = new MemoryBackend()
  const dir = await tempDir()
  try {
    const a = new SyncEngine({ backend, statePath: join(dir, 'a.json'), device: 'phone-a' })
    await a.open({ passphrase: 'a long shared passphrase' })
    await a.push([record('phone-a', 's1', 0, 'one')])
    await a.push([record('phone-a', 's1', 0, 'one'), record('phone-a', 's1', 1, 'two')])
    const before = [...backend.files.keys()].filter((path) => path.startsWith('data/'))
    assert.equal(before.length, 2)

    const result = await a.compact()
    assert.equal(result.removed, 1)
    const after = [...backend.files.keys()].filter((path) => path.startsWith('data/'))
    assert.equal(after.length, 1)
    assert.match(after[0], /000000-000001\.jsonl\.enc$/)

    // Reading still works and still yields both messages.
    const b = new SyncEngine({ backend, statePath: join(dir, 'b.json'), device: 'laptop' })
    await b.open({ passphrase: 'a long shared passphrase' })
    const pulled = await b.pull()
    assert.deepEqual(pulled.records.map((r) => r.text).sort(), ['one', 'two'])
    assert.equal(pulled.duplicates, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a range covered by the union of two chunks is compacted', async () => {
  const backend = new MemoryBackend()
  const dir = await tempDir()
  try {
    const a = new SyncEngine({ backend, statePath: join(dir, 'a.json'), device: 'phone-a' })
    await a.open({ passphrase: 'a long shared passphrase' })
    // Three chunks whose ranges overlap without any single one covering the others.
    await a.push([record('phone-a', 's1', 0, 'a'), record('phone-a', 's1', 1, 'b')])
    await a.push([record('phone-a', 's1', 2, 'c'), record('phone-a', 's1', 3, 'd')])
    await a.push([record('phone-a', 's1', 0, 'a'), record('phone-a', 's1', 1, 'b'), record('phone-a', 's1', 2, 'c'), record('phone-a', 's1', 3, 'd')])
    const before = [...backend.files.keys()].filter((path) => path.startsWith('data/'))
    assert.equal(before.length, 3)

    const result = await a.compact()
    // The longest chunk covers 0-3; the two slices are fully inside it.
    assert.equal(result.removed, 2)
    const after = [...backend.files.keys()].filter((path) => path.startsWith('data/'))
    assert.equal(after.length, 1)
    const pulled = await (async () => {
      const b = new SyncEngine({ backend, statePath: join(dir, 'b.json'), device: 'laptop' })
      await b.open({ passphrase: 'a long shared passphrase' })
      return b.pull()
    })()
    assert.deepEqual(pulled.records.map((r) => r.text).sort(), ['a', 'b', 'c', 'd'])
    assert.equal(pulled.duplicates, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('compaction keeps non-overlapping ranges and different devices', async () => {
  const backend = new MemoryBackend()
  const dir = await tempDir()
  try {
    const a = new SyncEngine({ backend, statePath: join(dir, 'a.json'), device: 'phone-a' })
    await a.open({ passphrase: 'a long shared passphrase' })
    await a.push([record('phone-a', 's1', 0, 'one')])
    await a.push([record('phone-a', 's1', 1, 'two')])
    const b = new SyncEngine({ backend, statePath: join(dir, 'b.json'), device: 'phone-b' })
    await b.open({ passphrase: 'a long shared passphrase' })
    await b.push([record('phone-b', 's1', 0, 'from b')])

    const result = await a.compact()
    assert.equal(result.removed, 0)
    const dataChunks = [...backend.files.keys()].filter((path) => path.startsWith('data/'))
    assert.equal(dataChunks.length, 3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a native chunk covered by a longer one is compacted too', async () => {
  const root = await tempDir()
  try {
    const backend = new FolderBackend(join(root, 'repo'))
    const a = new SyncEngine({ backend, statePath: join(root, 'a.json'), device: 'phone-a' })
    await a.open({ passphrase: 'a long shared passphrase' })
    const short = nativePath('session-x', 'phone-a', 0, 2)
    const long = nativePath('session-x', 'phone-a', 0, 9)
    await a.backend.write(short, encodeNativeChunk(a.key, short, '{"type":"session","id":"session-x"}\n'))
    await a.backend.write(long, encodeNativeChunk(a.key, long, '{"type":"session","id":"session-x"}\n'))
    const result = await a.compact()
    assert.equal(result.removed, 1)
    const left = (await a.backend.list('native/')).map((entry) => entry.path)
    assert.deepEqual(left, [long])
    assert.deepEqual(parseNativeName(left[0].split('/').pop()), { first: 0, last: 9 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
