import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeNativeBranches, buildConflictTail } from '../src/native-merge.js'

const header = (id = 'session-x') => JSON.stringify({ type: 'session', version: 4, id, createdAt: 1, cwd: '/tmp', isSeeded: false, delegationDepth: 0 })
const msg = (seq, text) => JSON.stringify({ type: 'user/message', seq, time: seq, data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' }, id: `m${seq}` }, surfaceOp: 'append' })

test('one device alone merges into one branch with no conflict', () => {
  const parts = [{ device: 'phone-a', lines: [header(), msg(0, 'hi'), msg(1, 'there')] }]
  const merged = mergeNativeBranches(parts)
  assert.equal(merged.conflict, false)
  assert.deepEqual(merged.branches, [])
  assert.deepEqual(merged.events, [msg(0, 'hi'), msg(1, 'there')])
  assert.equal(merged.header.id, 'session-x')
})

test('two devices agreeing produce no conflict', () => {
  const parts = [
    { device: 'phone-a', lines: [header(), msg(0, 'hi'), msg(1, 'a')] },
    { device: 'phone-b', lines: [msg(0, 'hi'), msg(1, 'a')] },
  ]
  const merged = mergeNativeBranches(parts)
  assert.equal(merged.conflict, false)
  assert.equal(merged.events.length, 2)
})

test('a divergent append keeps the owner and hands back the other branch', () => {
  const parts = [
    { device: 'phone-a', lines: [header(), msg(0, 'question'), msg(1, 'answer from the phone')] },
    { device: 'phone-b', lines: [msg(1, 'answer from the laptop')] },
  ]
  const merged = mergeNativeBranches(parts, { ownerDevice: 'phone-a' })
  assert.equal(merged.conflict, true)
  assert.equal(merged.branches.length, 1)
  assert.equal(merged.branches[0].device, 'phone-b')
  assert.equal(merged.branches[0].fromSeq, 1)
  assert.deepEqual(merged.branches[0].events, [msg(1, 'answer from the laptop')])
  // The owner's text stays canonical.
  assert.equal(merged.events[1], msg(1, 'answer from the phone'))
})

test('a peer append the owner never wrote is simply merged, not a conflict', () => {
  const parts = [
    { device: 'phone-a', lines: [header(), msg(0, 'q')] },
    { device: 'phone-b', lines: [msg(1, 'later but not the owner')] },
  ]
  const merged = mergeNativeBranches(parts, { ownerDevice: 'phone-a' })
  // Only one device has sequence 1, so there is nothing to arbitrate.
  assert.equal(merged.conflict, false)
  assert.deepEqual(merged.events, [msg(0, 'q'), msg(1, 'later but not the owner')])
})

test('a collision at several sequences is one branch, ordered', () => {
  const parts = [
    { device: 'phone-a', lines: [header(), msg(0, 'q'), msg(1, 'a1'), msg(2, 'a2')] },
    { device: 'phone-b', lines: [msg(1, 'b1'), msg(2, 'b2')] },
  ]
  const merged = mergeNativeBranches(parts, { ownerDevice: 'phone-a' })
  assert.equal(merged.conflict, true)
  assert.equal(merged.branches.length, 1)
  assert.deepEqual(merged.branches[0].events, [msg(1, 'b1'), msg(2, 'b2')])
  assert.deepEqual(merged.events, [msg(0, 'q'), msg(1, 'a1'), msg(2, 'a2')])
})

test('the author is inferred from sequence zero when no owner is given', () => {
  const parts = [
    { device: 'phone-b', lines: [msg(1, 'from b')] },
    { device: 'phone-a', lines: [header(), msg(0, 'q'), msg(1, 'from a')] },
  ]
  const merged = mergeNativeBranches(parts)
  assert.equal(merged.events[1], msg(1, 'from a'))
  assert.equal(merged.branches[0].device, 'phone-b')
})

test('a session directory holding two ids is an error, not a silent pick', () => {
  assert.throws(() => mergeNativeBranches([
    { device: 'a', lines: [header('session-1')] },
    { device: 'b', lines: [header('session-2')] },
  ]), /two session ids/)
})

test('a conflict copy is dense and ends with a readable title', () => {
  const tail = buildConflictTail({
    prefix: [msg(0, 'q')],
    branch: [msg(1, 'b1'), msg(2, 'b2')],
    lastSeq: 0,
    title: '原名（冲突1）',
    now: 99,
  })
  assert.equal(tail.length, 4)
  const parsed = tail.map((line) => JSON.parse(line))
  assert.deepEqual(parsed.map((event) => event.seq), [0, 1, 2, 3])
  const title = parsed.at(-1)
  assert.equal(title.type, 'session/title')
  assert.equal(title.data.title, '原名（冲突1）')
  assert.deepEqual(title.data.messageSeqs, [])
  assert.equal(title.data.source.kind, 'user')
  assert.equal('surfaceOp' in title, false)
})
