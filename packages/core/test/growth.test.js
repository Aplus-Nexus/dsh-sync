/**
 * The bug that made a vault grow to 11 GB with a handful of conversations.
 *
 * Two defects combined:
 *  1. `push()` called `commit({})` instead of the cursor it was given, so the
 *     source cursor stayed at -1 and every sync re-collected the whole history.
 *  2. An unchanged chunk was re-sealed with a fresh random IV, so its bytes
 *     differed every time and git could not delta it.
 *
 * Either one alone is wasteful; together they mean "resend and restore the
 * entire conversation every minute". These tests pin both shut.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SyncEngine } from '../src/engine.js'
import { MemoryBackend } from '../src/backends.js'
import { DshSource } from '../src/dsh-source.js'

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'dsh-sync-growth-'))
}

function userEvent(sessionId, seq, text) {
  return {
    type: 'user/message',
    seq,
    time: 1000 + seq,
    data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' }, id: `m${seq}` },
    surfaceOp: 'append',
  }
}

function fakeHost(sessionId, events) {
  return {
    async listSessions() { return [{ header: { id: sessionId, createdAt: 1, cwd: '/root/workspace' }, live: true }] },
    async readSession() { return { session: { id: sessionId, createdAt: 1, cwd: '/root/workspace' }, events, inheritedEventCount: 0 } },
  }
}

test('the cursor advances, so a second sync with no new events pushes nothing', async () => {
  const dir = await tempDir()
  try {
    const engine = new SyncEngine({ backend: new MemoryBackend(), statePath: join(dir, 's.json'), device: 'phone' })
    await engine.open({ passphrase: 'a long shared passphrase' })
    const source = new DshSource({ sessionQuery: fakeHost('s1', [userEvent('s1', 0, 'a'), userEvent('s1', 1, 'b')]), device: 'phone' })

    const first = await source.collect(['s1'])
    assert.equal(first.records.length, 2)
    await engine.push(first.records, { advanced: first.advanced, commit: (advanced) => source.commit(advanced) })
    assert.equal(source.cursor.s1, 1, 'the cursor must record the last published sequence')

    const second = await source.collect(['s1'])
    assert.equal(second.records.length, 0, 'nothing new means nothing to send')
    const pushed = await engine.push(second.records, { advanced: second.advanced, commit: (advanced) => source.commit(advanced) })
    assert.equal(pushed.records, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('only the new tail is published on the next sync', async () => {
  const dir = await tempDir()
  try {
    const engine = new SyncEngine({ backend: new MemoryBackend(), statePath: join(dir, 's.json'), device: 'phone' })
    await engine.open({ passphrase: 'a long shared passphrase' })
    const events = [userEvent('s1', 0, 'a'), userEvent('s1', 1, 'b')]
    const source = new DshSource({ sessionQuery: fakeHost('s1', events), device: 'phone' })

    const first = await source.collect(['s1'])
    await engine.push(first.records, { advanced: first.advanced, commit: (advanced) => source.commit(advanced) })

    events.push(userEvent('s1', 2, 'c'))
    const second = await source.collect(['s1'])
    assert.equal(second.records.length, 1, 'one new message, not three')
    assert.equal(second.records[0].text, 'c')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('re-pushing identical content writes no new chunk', async () => {
  const dir = await tempDir()
  try {
    const backend = new MemoryBackend()
    const engine = new SyncEngine({ backend, statePath: join(dir, 's.json'), device: 'phone' })
    await engine.open({ passphrase: 'a long shared passphrase' })

    const record = {
      id: 'x0',
      origin: { device: 'phone', session: 's1', root: 's1', parent: null, seq: 0, ts: 1, eventType: 'user/message' },
      agent: 'dsh', kind: 'message', role: 'user', text: 'same text',
    }
    const first = await engine.push([record])
    assert.ok(first.files >= 1)
    const writesAfterFirst = backend.writeCount ?? 0

    // The same content again must not be sealed and written a second time: a new
    // IV would make it a new git blob and the vault would grow without bound.
    const second = await engine.push([record])
    assert.equal(second.files, 0, 'an unchanged chunk must not be rewritten')
    assert.equal(second.bytes, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the repository grows by the size of new messages, not by the conversation', async () => {
  const dir = await tempDir()
  try {
    const backend = new MemoryBackend()
    const engine = new SyncEngine({ backend, statePath: join(dir, 's.json'), device: 'phone' })
    await engine.open({ passphrase: 'a long shared passphrase' })

    const events = []
    for (let seq = 0; seq < 40; seq += 1) events.push(userEvent('s1', seq, `message ${seq}`))
    const source = new DshSource({ sessionQuery: fakeHost('s1', events), device: 'phone' })

    const first = await source.collect(['s1'])
    const pushedOnce = await engine.push(first.records, { advanced: first.advanced, commit: (a) => source.commit(a) })

    // Ten more syncs with no new events: the vault must not change at all.
    for (let round = 0; round < 10; round += 1) {
      const again = await source.collect(['s1'])
      await engine.push(again.records, { advanced: again.advanced, commit: (a) => source.commit(a) })
    }
    const allChunks = [...backend.files.keys()].filter((path) => path.startsWith('data/'))
    assert.equal(allChunks.length, pushedOnce.files, 'no chunk was added by an idle sync')

    // One new event grows the vault by roughly one message, not by 41.
    events.push(userEvent('s1', 40, 'one more'))
    const next = await source.collect(['s1'])
    const pushed = await engine.push(next.records, { advanced: next.advanced, commit: (a) => source.commit(a) })
    assert.equal(pushed.records, 1)
    assert.ok(pushed.bytes < pushedOnce.bytes / 2, `one message (${pushed.bytes}B) must cost far less than the first push (${pushedOnce.bytes}B)`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
