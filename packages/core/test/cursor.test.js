/**
 * The cursor must survive a restart.
 *
 * `open()` reads the cursor from the state file, so if nothing ever writes it
 * the next process starts at -1 and republishes every conversation. That was
 * the other half of the growth bug: the in-memory cursor advanced during a
 * run, then vanished when the engine restarted.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SyncEngine } from '../src/engine.js'
import { MemoryBackend } from '../src/backends.js'
import { DshSource } from '../src/dsh-source.js'

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

test('a pushed cursor is on disk, so a fresh engine resumes from it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-cursor-'))
  const backend = new MemoryBackend()
  const statePath = join(dir, 'state.json')
  try {
    const first = new SyncEngine({ backend, statePath, device: 'phone' })
    await first.open({ passphrase: 'a long shared passphrase' })
    const advanced = { s1: 41 }
    await first.push([record('phone', 's1', 41, 'latest')], { advanced, commit: () => {} })

    // A new process reads the same state file.
    const second = new SyncEngine({ backend, statePath, device: 'phone' })
    await second.open({ passphrase: 'a long shared passphrase' })
    assert.equal(second.state.cursor.s1, 41, 'the cursor must be durable')

    // And a source built from it collects nothing more.
    const source = new DshSource({
      sessionQuery: {
        async listSessions() { return [{ header: { id: 's1' } }] },
        async readSession() {
          return {
            session: { id: 's1' },
            inheritedEventCount: 0,
            events: [{ type: 'user/message', seq: 41, time: 1, data: { role: 'user', content: 'latest', source: { kind: 'user' }, id: 'm41' }, surfaceOp: 'append' }],
          }
        },
      },
      device: 'phone',
      cursor: second.state.cursor,
    })
    assert.equal((await source.collect(['s1'])).records.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a push without a cursor does not clobber the stored one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-cursor-'))
  try {
    const statePath = join(dir, 'state.json')
    const engine = new SyncEngine({ backend: new MemoryBackend(), statePath, device: 'phone' })
    await engine.open({ passphrase: 'a long shared passphrase' })
    await engine.push([record('phone', 's1', 5, 'x')], { advanced: { s1: 5 }, commit: () => {} })
    // No `advanced` at all, as an older caller would do.
    await engine.push([record('phone', 's2', 0, 'y')], {})
    assert.equal(engine.state.cursor.s1, 5)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
