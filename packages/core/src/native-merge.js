/**
 * Merge the native logs several devices published for one session.
 *
 * Two devices can continue the same conversation at the same time: both append
 * at sequence N+1 and the two append bodies differ. Silently keeping whichever
 * chunk happened to sort first would destroy one of them, so this module makes
 * the split explicit.
 *
 * The rule is deliberate and one-directional: **the session's owner keeps the
 * canonical branch**. Every other branch is handed back so the caller can open
 * it as its own conversation, marked as a conflict. That is what makes "this
 * phone is the source of truth" true even when another device wrote later.
 */
import { createHash } from 'node:crypto'

function lineHash(line) {
  return createHash('sha256').update(line).digest('hex').slice(0, 16)
}

/**
 * @param {object[]} parts `{ device, lines }` where `lines` is the decoded log
 *   (a header line may be present in any part).
 * @param {object} [options]
 * @param {string} [options.ownerDevice] the device whose branch stays canonical.
 * @returns {{header: object|null, events: string[], branches: {device: string, fromSeq: number, events: string[]}[], conflict: boolean}}
 */
export function mergeNativeBranches(parts, { ownerDevice } = {}) {
  let header = null
  const bySeq = new Map()

  for (const part of parts) {
    for (const line of part.lines) {
      if (line.trim() === '') continue
      let value
      try {
        value = JSON.parse(line)
      } catch {
        continue
      }
      if (value?.type === 'session' && typeof value.id === 'string') {
        if (header === null) header = value
        else if (header.id !== value.id) throw new Error(`one session directory holds two session ids: ${header.id} and ${value.id}`)
        continue
      }
      if (!Number.isInteger(value?.seq)) continue
      if (!bySeq.has(value.seq)) bySeq.set(value.seq, new Map())
      bySeq.get(value.seq).set(part.device, line)
    }
  }
  if (header === null) return { header: null, events: [], branches: [], conflict: false }

  // The device that published the first event is the author when the caller
  // does not know the owner: it is the only device that can have sequence 0.
  const canonical = ownerDevice ?? bySeq.get(0)?.keys().next().value ?? [...bySeq.values()][0]?.keys().next().value

  const events = []
  const branchLines = new Map()
  const branchStart = new Map()
  let conflict = false

  const seqs = [...bySeq.keys()].sort((a, b) => a - b)
  for (const seq of seqs) {
    const candidates = bySeq.get(seq)
    const distinct = new Set([...candidates.values()].map(lineHash))
    const winner = candidates.get(canonical) ?? candidates.get([...candidates.keys()].sort()[0])
    events.push(winner)
    if (distinct.size <= 1) continue
    conflict = true
    for (const [device, line] of candidates) {
      if (device === canonical) continue
      if (lineHash(line) === lineHash(winner)) continue
      if (!branchLines.has(device)) {
        branchLines.set(device, [])
        branchStart.set(device, seq)
      }
      branchLines.get(device).push(line)
    }
  }

  const branches = [...branchLines.entries()]
    .map(([device, lines]) => ({ device, fromSeq: branchStart.get(device), events: lines }))
    .sort((a, b) => a.fromSeq - b.fromSeq || (a.device < b.device ? -1 : 1))

  return { header, events, branches, conflict }
}

/**
 * Build the tail of a conflict copy: the canonical prefix, then the losing
 * branch, then a title event that names the copy.
 *
 * @param {object} options
 * @param {string[]} options.prefix   canonical lines before the divergence.
 * @param {string[]} options.branch   the losing branch's lines, in order.
 * @param {number} options.lastSeq    the last sequence in `prefix`, or -1.
 * @param {string} options.title      the title to show, e.g. `原名（冲突1）`.
 * @param {number} [options.now]
 * @returns {string[]} lines forming a dense, valid log body.
 */
export function buildConflictTail({ prefix, branch, lastSeq, title, now = Date.now() }) {
  const lines = [...prefix, ...branch]
  // A title event is not a surface event, so it carries no `surfaceOp`; DSH's
  // own log has none either.
  const titleSeq = lastSeq + branch.length + 1
  lines.push(JSON.stringify({
    type: 'session/title',
    seq: titleSeq,
    time: now,
    data: { title, messageSeqs: [], source: { kind: 'user' } },
  }))
  return lines
}
