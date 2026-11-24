import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryBackend, FolderBackend } from '../src/backends.js'
import { SyncEngine } from '../src/engine.js'

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'dsh-sync-test-'))
}

function record(device, session, seq, text, ts = 1000 + seq) {
  return {
    id: `id-${device}-${session}-${seq}`,
    origin: { device, session, root: session, parent: null, seq, ts, eventType: 'user/message', title: undefined },
    agent: 'dsh',
    kind: 'message',
    role: 'user',
    text,
  }
}

async function engine(backend, dir, device, passphrase = 'correct horse battery') {
  const instance = new SyncEngine({ backend, statePath: join(dir, `${device}.json`), mirrorDir: join(dir, `mirror-${device}`), device })
  await instance.open({ passphrase })
  return instance
}

test('one device pushes, another pulls the same messages', async () => {
  const backend = new MemoryBackend()
  const dirA = await tempDir()
  const dirB = await tempDir()
  const a = await engine(backend, dirA, 'phone-a')
  const b = await engine(backend, dirB, 'laptop')

  await a.push([record('phone-a', 's1', 0, 'hello'), record('phone-a', 's1', 1, 'world')])
  const pulled = await b.pull()

  assert.equal(pulled.records.length, 2)
  assert.deepEqual(pulled.records.map((r) => r.text).sort(), ['hello', 'world'])
  assert.deepEqual(a.fingerprint(), b.fingerprint())
  await rm(dirA, { recursive: true, force: true })
  await rm(dirB, { recursive: true, force: true })
})

test('a pull twice does not duplicate messages', async () => {
  const backend = new MemoryBackend()
  const dirA = await tempDir()
  const dirB = await tempDir()
  const a = await engine(backend, dirA, 'phone-a')
  const b = await engine(backend, dirB, 'laptop')
  await a.push([record('phone-a', 's1', 0, 'once')])
  assert.equal((await b.pull()).records.length, 1)
  assert.equal((await b.pull()).records.length, 0)
  await rm(dirA, { recursive: true, force: true })
  await rm(dirB, { recursive: true, force: true })
})

test('two devices exchange in both directions without overwriting', async () => {
  const backend = new MemoryBackend()
  const dirA = await tempDir()
  const dirB = await tempDir()
  const a = await engine(backend, dirA, 'phone-a')
  const b = await engine(backend, dirB, 'laptop')

  await a.push([record('phone-a', 's1', 0, 'from phone')])
  await b.pull()
  await b.push([record('laptop', 's2', 0, 'from laptop')])
  const onA = await a.pull()

  assert.equal(onA.records.length, 1)
  assert.equal(onA.records[0].text, 'from laptop')
  // each device owns its own chunk prefix
  const paths = [...backend.files.keys()].filter((p) => p.startsWith('data/'))
  assert.ok(paths.some((p) => p.includes('/phone-a/')))
  assert.ok(paths.some((p) => p.includes('/laptop/')))
  await rm(dirA, { recursive: true, force: true })
  await rm(dirB, { recursive: true, force: true })
})

test('the repository holds no plaintext', async () => {
  const backend = new MemoryBackend()
  const dir = await tempDir()
  const a = await engine(backend, dir, 'phone-a')
  await a.push([record('phone-a', 's1', 0, 'TOP-SECRET-PHRASE')])
  for (const [path, bytes] of backend.files) {
    assert.equal(bytes.includes('TOP-SECRET-PHRASE'), false, path)
    assert.equal(bytes.toString('utf8').includes('TOP-SECRET-PHRASE'), false, path)
  }
  await rm(dir, { recursive: true, force: true })
})

test('an existing salt is reused, so the key is shared', async () => {
  const backend = new MemoryBackend()
  const dirA = await tempDir()
  const dirB = await tempDir()
  const a = await engine(backend, dirA, 'phone-a', 'a long shared passphrase')
  const b = await engine(backend, dirB, 'b', 'a long shared passphrase')
  assert.equal(a.fingerprint(), b.fingerprint())
  await rm(dirA, { recursive: true, force: true })
  await rm(dirB, { recursive: true, force: true })
})

test('a device with the wrong passphrase reads nothing and reports it', async () => {
  const backend = new MemoryBackend()
  const dirA = await tempDir()
  const dirB = await tempDir()
  const a = await engine(backend, dirA, 'phone-a', 'the right passphrase')
  await a.push([record('phone-a', 's1', 0, 'secret')])

  // The salt lives in the repository, so a wrong passphrase derives a different key.
  const intruder = new SyncEngine({ backend, statePath: join(dirB, 'intruder.json'), device: 'intruder' })
  await intruder.open({ passphrase: 'a completely different phrase' })
  assert.notEqual(intruder.fingerprint(), a.fingerprint())
  const pulled = await intruder.pull()
  assert.equal(pulled.records.length, 0)
  assert.ok(pulled.skipped >= 1)

  // The correct passphrase still works on the same repository.
  const right = await engine(backend, dirB, 'laptop', 'the right passphrase')
  assert.equal(right.fingerprint(), a.fingerprint())
  assert.equal((await right.pull()).records.length, 1)
  await rm(dirA, { recursive: true, force: true })
  await rm(dirB, { recursive: true, force: true })
})

test('the mirror is plain JSONL an agent can read', async () => {
  const backend = new MemoryBackend()
  const dirA = await tempDir()
  const dirB = await tempDir()
  const a = await engine(backend, dirA, 'phone-a')
  const b = await engine(backend, dirB, 'laptop')
  await a.push([record('phone-a', 's1', 0, 'mirrored text')])
  await b.pull()
  const files = await readdir(join(dirB, 'mirror-laptop'))
  assert.deepEqual(files, ['s1.jsonl'])
  await rm(dirA, { recursive: true, force: true })
  await rm(dirB, { recursive: true, force: true })
})

test('notes travel between agents', async () => {
  const backend = new MemoryBackend()
  const dirA = await tempDir()
  const dirB = await tempDir()
  const a = await engine(backend, dirA, 'phone-a')
  const b = new SyncEngine({ backend, statePath: join(dirB, 'b.json'), device: 'laptop', agent: 'codex' })
  await b.open({ passphrase: 'correct horse battery' })
  await a.addNote({ title: 'hand off', body: 'implement the parser', tags: ['todo'] })
  const notes = await b.listNotes()
  assert.equal(notes.length, 1)
  assert.equal(notes[0].title, 'hand off')
  assert.equal(notes[0].device, 'phone-a')
  await rm(dirA, { recursive: true, force: true })
  await rm(dirB, { recursive: true, force: true })
})

test('a folder backend works exactly like memory', async () => {
  const root = await tempDir()
  const dirA = await tempDir()
  const dirB = await tempDir()
  const a = await engine(new FolderBackend(root), dirA, 'phone-a')
  const b = await engine(new FolderBackend(root), dirB, 'laptop')
  await a.push([record('phone-a', 's1', 0, 'via the filesystem')])
  const pulled = await b.pull()
  assert.equal(pulled.records[0].text, 'via the filesystem')
  for (const dir of [root, dirA, dirB]) await rm(dir, { recursive: true, force: true })
})

test('a corrupted chunk is skipped, not fatal', async () => {
  const backend = new MemoryBackend()
  const dirA = await tempDir()
  const dirB = await tempDir()
  const a = await engine(backend, dirA, 'phone-a')
  const b = await engine(backend, dirB, 'laptop')
  await a.push([record('phone-a', 's1', 0, 'good')])
  const path = [...backend.files.keys()].find((p) => p.startsWith('data/'))
  const bytes = backend.files.get(path)
  bytes[bytes.length - 1] ^= 0xff
  const pulled = await b.pull()
  assert.equal(pulled.records.length, 0)
  assert.equal(pulled.skipped, 1)
  await rm(dirA, { recursive: true, force: true })
  await rm(dirB, { recursive: true, force: true })
})

test('push reports what it wrote', async () => {
  const backend = new MemoryBackend()
  const dir = await tempDir()
  const a = await engine(backend, dir, 'phone-a')
  const result = await a.push([record('phone-a', 's1', 0, 'a'), record('phone-a', 's1', 1, 'b')])
  assert.equal(result.records, 2)
  assert.ok(result.bytes > 0)
  assert.ok(result.files >= 1)
  assert.equal(a.status().pushed, 2)
  await rm(dir, { recursive: true, force: true })
})
