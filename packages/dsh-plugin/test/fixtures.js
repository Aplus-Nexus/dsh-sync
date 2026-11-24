/**
 * A realistic DSH v4 session log, built in code.
 *
 * Tests must not depend on one developer's private conversation, and a fixture
 * that only looks like JSON would not catch a format change. This builder emits
 * the same envelope DSH writes: a header line, then dense events with the
 * surface and turn/step bookkeeping the real format validates.
 */
export function sampleEvents({ sessionId = 'session-fixture', cwd = '/root/workspace', turns = 3 } = {}) {
  const events = []
  let seq = 0
  const push = (type, data, extra = {}) => {
    events.push({ type, seq, time: 1_700_000_000_000 + seq * 1000, data, ...extra })
    seq += 1
  }
  push('permission/preset', { preset: 'workspace-write' })
  push('sandbox/mode', { mode: 'danger-full-access' })
  push('approval/policy', { policy: 'never' })
  push('command/run', { command: 'init', input: '' })
  push('command/done', { command: 'init', outcome: 'ok' })
  for (let turn = 1; turn <= turns; turn += 1) {
    push('turn/start', { turn })
    push('step/start', { turn, step: 1 })
    if (turn === 1) {
      push('system/message', {
        turn,
        step: 1,
        message: { role: 'system', content: [{ type: 'text', text: 'You are a coding agent.' }], id: `sys-${turn}` },
      }, { surfaceOp: 'append' })
    }
    push('request/header', {
      turn,
      step: 1,
      header: {
        config: { provider: 'deepseek', model: 'deepseek-chat' },
        tools: [{ name: 'bash', description: 'run a command', parameters: { type: 'object', properties: {} } }],
      },
    })
    push('user/message', {
      turn,
      step: 1,
      role: 'user',
      id: `user-${turn}`,
      source: { kind: 'user' },
      content: [{ type: 'text', text: `question ${turn}: 请继续同步` }],
    }, { surfaceOp: 'append' })
    push('assistant/message', {
      turn,
      step: 1,
      message: {
        role: 'assistant',
        id: `asst-${turn}`,
        content: [
          { type: 'reasoning', text: `private thinking for turn ${turn}` },
          { type: 'text', text: `answer ${turn}` },
          { type: 'tool-call', id: `call_${turn}`, name: 'bash', arguments: '{"command":"ls"}' },
        ],
      },
    })
    push('tool/call', { turn, step: 1, callId: `call_${turn}`, name: 'bash', arguments: '{"command":"ls"}' })
    push('tool/result', {
      turn,
      step: 1,
      message: {
        role: 'tool',
        id: `tool-${turn}`,
        toolCallId: `call_${turn}`,
        content: [{ type: 'text', text: `file-${turn}.txt` }],
        isError: false,
      },
      meta: { cwd },
      sourceEventSeqs: [],
    }, { surfaceOp: 'append' })
    push('step/end', { turn, step: 1 })
    push('turn/end', { turn, reason: { kind: 'completed' } })
  }
  push('session/title', { title: '同步方案讨论', messageSeqs: [7], source: { kind: 'fallback' } })
  return events
}

export function sampleHeader({ sessionId = 'session-fixture', cwd = '/root/workspace', seeded = false } = {}) {
  return {
    type: 'session',
    version: 4,
    id: sessionId,
    createdAt: 1_700_000_000_000,
    cwd,
    isSeeded: seeded,
    delegationDepth: 0,
    agentPreset: 'standard',
  }
}

/** The events as JSONL text lines, the way DSH stores them. */
export function sampleEventLines(options) {
  return sampleEvents(options).map((event) => JSON.stringify(event))
}
