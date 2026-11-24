import test from 'node:test'
import assert from 'node:assert/strict'
import { zstdDecompressSync } from 'node:zlib'
import { portableFromDshEvent, comparePortable, titleOf, contentText } from '../src/portable.js'
import { encodeLogBytes, parseLogBytes, projectKey, encodeSegment, logPathFor, localizeHeader, tailFrom } from '../src/native.js'

const ctx = { device: 'phone-a', session: 'session-1', root: 'session-1', parent: null, agent: 'dsh' }

test('a user message becomes a portable record', () => {
  const record = portableFromDshEvent({
    type: 'user/message',
    seq: 12,
    time: 1_700_000_000_000,
    data: { role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' }, id: 'm1' },
  }, ctx)
  assert.equal(record.kind, 'message')
  assert.equal(record.role, 'user')
  assert.equal(record.text, '你好')
  assert.equal(record.origin.seq, 12)
  assert.equal(record.origin.device, 'phone-a')
  assert.match(record.id, /^[0-9a-f]{32}$/)
})

test('the same message on two devices gets the same id', () => {
  const event = { type: 'user/message', seq: 3, time: 5, data: { role: 'user', content: 'hi' } }
  const a = portableFromDshEvent(event, ctx)
  const b = portableFromDshEvent(event, { ...ctx, agent: 'codex' })
  assert.equal(a.id, b.id)
})

test('a different message gets a different id', () => {
  const base = { type: 'user/message', seq: 3, time: 5, data: { role: 'user', content: 'hi' } }
  const other = { ...base, seq: 4 }
  assert.notEqual(portableFromDshEvent(base, ctx).id, portableFromDshEvent(other, ctx).id)
})

test('bookkeeping events are skipped', () => {
  for (const type of ['step/start', 'step/end', 'turn/start', 'turn/end', 'approval/asked', 'llm/retry', 'request/header']) {
    assert.equal(portableFromDshEvent({ type, seq: 1, time: 1, data: {} }, ctx), null, type)
  }
})

test('tool calls keep their name and arguments', () => {
  const record = portableFromDshEvent({
    type: 'tool/call',
    seq: 20,
    time: 7,
    data: { name: 'bash', arguments: '{"command":"ls"}', callId: 'call_1' },
  }, ctx)
  assert.equal(record.kind, 'tool-call')
  assert.equal(record.tool.name, 'bash')
  assert.equal(record.text, '{"command":"ls"}')
})

test('reasoning is not shipped between devices', () => {
  const record = portableFromDshEvent({
    type: 'assistant/message',
    seq: 21,
    time: 8,
    data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: 'private thoughts' }, { type: 'text', text: 'answer' }] } },
  }, ctx)
  assert.equal(record.text, 'answer')
  assert.equal(JSON.stringify(record).includes('private thoughts'), false)
})

test('images keep a reference, not the bytes', () => {
  const record = portableFromDshEvent({
    type: 'user/message',
    seq: 22,
    time: 9,
    data: { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', ref: 'sha256:abc', mediaType: 'image/png' }] },
  }, ctx)
  assert.deepEqual(record.blocks[1], { type: 'image', ref: 'sha256:abc', mediaType: 'image/png', name: undefined })
})

test('session titles are portable', () => {
  const record = portableFromDshEvent({ type: 'session/title', seq: 9, time: 10, data: { title: '设计同步方案' } }, ctx)
  assert.equal(record.kind, 'title')
  assert.equal(record.text, '设计同步方案')
})

test('ordering is stable and time-first', () => {
  const early = { origin: { ts: 1, device: 'b', seq: 1 } }
  const late = { origin: { ts: 9, device: 'a', seq: 2 } }
  const tie = { origin: { ts: 9, device: 'b', seq: 1 } }
  assert.deepEqual([late, early, tie].sort(comparePortable), [early, late, tie])
})

test('a title prefers the newest explicit title', () => {
  const records = [
    { kind: 'title', role: 'meta', text: 'old', origin: { ts: 1, device: 'a', seq: 1 } },
    { kind: 'title', role: 'meta', text: 'new', origin: { ts: 2, device: 'a', seq: 2 } },
  ]
  assert.equal(titleOf(records), 'new')
})

test('contentText flattens both block shapes', () => {
  assert.equal(contentText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(contentText('plain'), 'plain')
  assert.equal(contentText([{ type: 'tool-call', name: 'bash' }]), '[tool bash]')
})
