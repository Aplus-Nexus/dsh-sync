import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { synthesizeSession, synthesizeSessionId, encodeSynthesizedLog } from '../src/synthesize.js'
import { parseLogBytes as parseLog } from '../src/native.js'

const CWD = '/root/workspace'

function record(role, text, ts, extra = {}) {
  return { kind: 'message', role, text, origin: { ts, seq: ts }, agent: 'codex', ...extra }
}

test('a conversation from another agent becomes a dense v4 log', () => {
  const records = [record('user', '第一句', 1000), record('assistant', '第二句', 2000), record('user', '第三句', 3000), record('assistant', '第四句', 4000)]
  const { header, events } = synthesizeSession({ sessionId: 'session-import-x', records, cwd: CWD, sourceLabel: 'codex' })
  assert.equal(header.version, 4)
  assert.equal(header.isSeeded, false)
  assert.equal(header.cwd, CWD)
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index))
  assert.deepEqual(events.map((event) => event.type), [
    'permission/preset',
    'sandbox/mode',
    'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
    'turn/start', 'step/start', 'user/message', 'assistant/message', 'step/end', 'turn/end',
  ])
})

test('each turn restarts its step numbering at one', () => {
  const { events } = synthesizeSession({
    sessionId: 'session-import-y',
    records: [record('user', 'a', 1), record('assistant', 'b', 2), record('user', 'c', 3), record('assistant', 'd', 4)],
    cwd: CWD,
  })
  const steps = events.filter((event) => event.type === 'step/start').map((event) => event.data.step)
  assert.deepEqual(steps, [1, 1])
  const turns = events.filter((event) => event.type === 'turn/start').map((event) => event.data.turn)
  assert.deepEqual(turns, [1, 2])
})

test('every message on the surface carries a source and an id', () => {
  const { events } = synthesizeSession({ sessionId: 'session-import-z', records: [record('user', 'a', 1), record('assistant', 'b', 2)], cwd: CWD })
  for (const event of events.filter((item) => item.type.endsWith('/message'))) {
    const message = event.type === 'user/message' ? event.data : event.data.message
    assert.equal(typeof message.id, 'string')
    assert.notEqual(message.id, '')
    assert.equal(typeof message.source.kind, 'string')
    assert.notEqual(message.source.kind, 'plugin')
  }
  assert.equal(events.filter((item) => item.type === 'assistant/message').every((item) => Array.isArray(item.data.stream)), true)
})

test('tool plumbing is kept as a visible note, never faked as a lifecycle', () => {
  const records = [
    record('user', '看一下目录', 1),
    { kind: 'tool-call', role: 'assistant', text: '{"command":"ls"}', tool: { name: 'bash' }, origin: { ts: 2, seq: 2 } },
    { kind: 'tool-result', role: 'tool', text: 'a.txt', tool: {}, origin: { ts: 3, seq: 3 } },
    record('assistant', '有一个文件。', 4),
  ]
  const { events } = synthesizeSession({ sessionId: 'session-import-tools', records, cwd: CWD })
  const text = events.filter((event) => event.type === 'assistant/message').map((event) => event.data.message.content[0].text).join('\n')
  assert.match(text, /\[调用 bash\]/)
  assert.match(text, /\[工具返回\]/)
  // A fabricated tool call would need a real call/result pair; this log has none.
  assert.equal(events.some((event) => event.type === 'tool/call'), false)
})

test('an assistant-only conversation still gets a turn', () => {
  const { events } = synthesizeSession({ sessionId: 'session-import-a', records: [record('assistant', '只有我说话', 1)], cwd: CWD })
  assert.equal(events[2].type, 'turn/start')
  assert.equal(events.at(-1).type, 'turn/end')
})

test('empty records are refused instead of producing a broken log', () => {
  assert.throws(() => synthesizeSession({ sessionId: 's', records: [record('user', '   ', 1)], cwd: CWD }), /nothing to synthesize/)
  assert.throws(() => synthesizeSession({ sessionId: 's', records: [], cwd: CWD }), /nothing to synthesize/)
})

test('a relative cwd is refused rather than written', () => {
  assert.throws(() => synthesizeSession({ sessionId: 's', records: [record('user', 'a', 1)], cwd: 'relative/path' }), /absolute cwd/)
})

test('the encoded log is the same physical shape DSH writes', () => {
  const { header, events } = synthesizeSession({ sessionId: 'session-import-bytes', records: [record('user', 'a', 1), record('assistant', 'b', 2)], cwd: CWD })
  const bytes = encodeSynthesizedLog(header, events)
  assert.equal(bytes.readUInt32LE(0), 0xfd2fb528, 'starts with a zstd frame')
  const parsed = parseLog(bytes)
  assert.equal(parsed.header.id, 'session-import-bytes')
  assert.equal(parsed.events.length, events.length)
})

test('the synthesized body contains no private reasoning', () => {
  const records = [record('user', 'a', 1), { ...record('assistant', 'answer', 2), blocks: [{ type: 'reasoning', text: 'private thoughts' }] }]
  const { events } = synthesizeSession({ sessionId: 'session-import-p', records, cwd: CWD })
  assert.equal(JSON.stringify(events).includes('private thoughts'), false)
})

test('a session id is derived from the source and stays path-safe', () => {
  assert.equal(synthesizeSessionId('codex/2026-11-24 10:00'), 'session-import-codex-2026-11-24-10-00')
  assert.match(synthesizeSessionId(''), /^session-import-[0-9a-f]{8}$/)
})
