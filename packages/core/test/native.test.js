import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLogBytes, encodeLogBytes, projectKey, encodeSegment, logPathFor, localizeHeader, tailFrom } from '../src/native.js'

const header = { type: 'session', version: 4, id: 'session-abc', createdAt: 1795446122308, cwd: '/root/workspace', isSeeded: false, delegationDepth: 0, agentPreset: 'standard' }
const events = [
  JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }),
  JSON.stringify({ type: 'user/message', seq: 1, time: 2, data: { role: 'user', content: 'hi' } }),
  JSON.stringify({ type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } }),
]

test('a DSH log round-trips byte for byte', () => {
  const bytes = encodeLogBytes(header, events)
  const parsed = parseLogBytes(bytes)
  assert.deepEqual(parsed.header, header)
  assert.deepEqual(parsed.events, events)
  assert.deepEqual(encodeLogBytes(parsed.header, parsed.events), bytes)
})

test('a log is multi-frame zstd, like the real one', () => {
  const bytes = encodeLogBytes(header, events)
  const first = bytes.readUInt32LE(0)
  assert.equal(first, 0xfd2fb528, 'starts with a zstd frame magic')
  const parsed = parseLogBytes(bytes)
  assert.equal(parsed.raw.length, 4)
})

test('project keys match DSH directory names', () => {
  assert.equal(projectKey('/root/workspace'), '--root-workspace--')
  assert.equal(projectKey('C:\\Users\\me\\code'), '--C-Users-me-code--')
  assert.equal(projectKey('/'), '--root--')
  assert.equal(projectKey('/a b'), '--a~0020b--')
})

test('session ids escape unsafe characters', () => {
  assert.equal(encodeSegment('session-abc'), 'session-abc')
  assert.equal(encodeSegment('a/b'), 'a~002Fb')
  assert.equal(encodeSegment('..'), '~002E~002E')
})

test('the log path is the one DSH writes', () => {
  assert.equal(
    logPathFor('/root/.dsh/sessions', '/root/workspace', 'session-abc'),
    '/root/.dsh/sessions/--root-workspace--/session-abc/session.v4.jsonl.zstd',
  )
})

test('a cwd that is not absolute on the reading platform is replaced', () => {
  // A Windows-style path read on a phone is not absolute, so DSH would reject the header.
  const localized = localizeHeader({ ...header, cwd: 'relative/dir' }, 'C:\\Users\\me')
  assert.equal(localized.cwd, 'C:\\Users\\me')
  assert.equal(localized.id, 'session-abc')
  assert.equal(localized.isSeeded, false)
})

test('an already-usable cwd is preserved', () => {
  const localized = localizeHeader({ ...header, cwd: 'C:\\Users\\me' }, 'fallback', (value) => value.startsWith('C:'))
  assert.equal(localized.cwd, 'C:\\Users\\me')
})

test('a POSIX cwd survives on a POSIX reader', () => {
  assert.equal(localizeHeader(header, 'fallback').cwd, '/root/workspace')
})

test('missing cwd falls back instead of crashing', () => {
  assert.equal(localizeHeader({ ...header, cwd: undefined }, '/root').cwd, '/root')
})

test('tailFrom keeps only events after a sequence number', () => {
  assert.equal(tailFrom(events, 1).length, 1)
  assert.equal(tailFrom(events, -1).length, 3)
  assert.equal(tailFrom(events, 99).length, 0)
  // an unparsable line cannot be ordered, so it is dropped rather than guessed
  assert.equal(tailFrom([...events, 'not json'], 0).length, 2)
})
