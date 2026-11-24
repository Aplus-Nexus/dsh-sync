/**
 * Optional extras: settings, model routes (never keys), skills, AGENTS.md and
 * the dsh-go UI file.
 *
 * These are files, not event streams, so they need a different rule from
 * messages: the newest change wins, and a secret can never leave the device.
 * The redaction list is deliberately blunt — a missed key is far worse than a
 * dropped setting.
 */
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { seal, open } from './crypto.js'
import { canonicalJson, digestOf, parseJson } from './util.js'

/** Paths that must never be published, whatever a caller asks for. */
const NEVER_SYNC = [
  /(^|\/)\.credentials\.yaml$/,
  /(^|\/)credentials([^/]*|[^/]*\/.*)$/i,
  /(^|\/)auth\.json$/,
  /(^|\/)\.env(\.[^/]*)?$/,
  /(^|\/)[^/]*token[^/]*(\/|$)/i,
  /(^|\/)[^/]*secret[^/]*(\/|$)/i,
  /(^|\/)\.git(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)sessions(\/|$)/,
  /(^|\/)storages(\/|$)/,
  /(^|\/)dsh-sync(\/|$)/,
]

/** Keys whose values are secrets in any settings document. */
const SECRET_KEY = /^(api_?key|token|secret|password|passphrase|authorization|credential|cookie)$/i

export function isSyncablePath(path) {
  return !NEVER_SYNC.some((pattern) => pattern.test(path))
}

/**
 * Remove every secret-looking value from a JSON document, keeping the shape so
 * a peer still sees that a key *exists* without learning it.
 */
export function redactSecrets(value, depth = 0) {
  if (depth > 40) return undefined
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1))
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      if (typeof item === 'string' && item !== '') out[key] = `<redacted:${item.length}>`
      continue
    }
    if (key === 'apiKeyEnv') {
      out[key] = item // an env-var *name* is not a secret
      continue
    }
    out[key] = redactSecrets(item, depth + 1)
  }
  return out
}

/**
 * Collect the extra state this device wants to publish.
 *
 * @param {object} options
 * @param {string} options.home    DSH home directory.
 * @param {boolean} [options.settings] include settings and model routes.
 * @param {boolean} [options.skills]   include skills and AGENTS.md.
 * @param {boolean} [options.ui]       include the dsh-go ui.json.
 * @returns {Promise<Array<{kind: string, name: string, payload: object}>>}
 */
export async function collectExtras({ home, settings = false, skills = false, ui = false }) {
  const out = []
  if (settings === true) {
    // Only documents that are already key-free may travel verbatim. The
    // profile patch is NOT one of them: it carries provider blocks, so it is
    // reduced to its credential-free catalogue below instead.
    for (const candidate of ['settings.yaml', 'settings.json']) {
      const text = await readFile(join(home, candidate), 'utf8').catch(() => null)
      if (text === null) continue
      const redacted = redactDocument(candidate, text)
      if (redacted === null) continue
      out.push({ kind: 'settings', name: candidate.replace(/[^A-Za-z0-9]+/g, '-'), payload: { file: candidate, text: redacted, redacted: true } })
    }
    const routes = await readProfileRoutes(home)
    if (routes !== null) out.push({ kind: 'settings', name: 'model-routes', payload: routes })
  }
  if (skills === true) {
    const agents = await readFile(join(home, 'AGENTS.md'), 'utf8').catch(() => null)
    if (agents !== null) out.push({ kind: 'skills', name: 'AGENTS.md', payload: { file: 'AGENTS.md', text: agents } })
    const skillsRoot = join(home, 'skills')
    for (const dir of await readdir(skillsRoot).catch(() => [])) {
      const skillFile = join(skillsRoot, dir, 'SKILL.md')
      const text = await readFile(skillFile, 'utf8').catch(() => null)
      if (text === null) continue
      out.push({ kind: 'skills', name: `skill-${dir}`, payload: { file: relative(home, skillFile).split(sep).join('/'), text } })
    }
  }
  if (ui === true) {
    const text = await readFile(join(home, 'dsh-go', 'ui.json'), 'utf8').catch(() => null)
    if (text !== null) out.push({ kind: 'ui', name: 'ui', payload: { file: 'dsh-go/ui.json', text } })
  }
  return out
}

/**
 * Drop any document that still contains a credential-shaped line.
 *
 * The check is intentionally coarse: a settings file is small, and losing one
 * preference is an acceptable price for never publishing a key.
 */
function redactDocument(name, text) {
  const looksSecret = /(^|\s)(api_?key|apikey|token|secret|password|passphrase|authorization|cookie)\s*[:=]\s*\S+/i.test(text)
  if (looksSecret) return null
  return text
}

/** Model routes from the profile patch, with every key value stripped. */
async function readProfileRoutes(home) {
  const patch = await readFile(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8').catch(() => null)
  if (patch === null) return null
  // The patch is YAML, and a model provider block mixes a catalogue with a
  // credential reference. Without a YAML dependency the honest operation is to
  // share only the non-secret model catalogue, never a whole provider block.
  const kept = []
  let keeping = false
  for (const line of patch.split('\n')) {
    if (/^\s*-?\s*(id|name|model|models|displayName|baseURL|contextWindow|provider)\s*:/i.test(line)) {
      keeping = !/apiKey|token|secret|password/i.test(line)
    } else if (/^\s+(- )?/.test(line) && line.trim() !== '') {
      keeping = keeping && !/apiKey|token|secret|password/i.test(line)
    } else {
      keeping = false
    }
    if (keeping) kept.push(line)
  }
  if (kept.length === 0) return null
  return { file: 'profiles/web/cordis.patch.yml', text: kept.join('\n'), redacted: true }
}

/**
 * Publish the collected extras into the repository.
 *
 * Each item is written under its own device and name, so two devices never
 * overwrite each other's copy; a puller chooses the newest by `updatedAt`.
 */
export async function publishExtras(engine, items) {
  const stamp = Date.now()
  const written = []
  for (const item of items) {
    const path = `extras/${item.kind}/${engine.device}-${item.name}.json.enc`
    const body = { v: 1, kind: item.kind, name: item.name, device: engine.device, updatedAt: stamp, payload: item.payload }
    await engine.backend.write(path, seal(engine.key, Buffer.from(canonicalJson(body), 'utf8'), `dsh-sync:extra:${path}`))
    written.push({ path, kind: item.kind, name: item.name, digest: digestOf(body) })
  }
  if (written.length > 0) await engine.backend.sync({ direction: 'push', message: `sync: extras from ${engine.device}` })
  return written
}

/** Read every published extra of one kind, newest first. */
export async function readExtras(engine, kind) {
  const listing = await engine.backend.list(`extras/${kind}/`)
  const out = []
  for (const entry of listing) {
    try {
      const text = open(engine.key, await engine.backend.read(entry.path), `dsh-sync:extra:${entry.path}`).toString('utf8')
      const value = parseJson(text)
      if (value !== null && value !== undefined && value.kind === kind) out.push(value)
    } catch {}
  }
  return out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

/**
 * Restore the newest extra of each name into the DSH home.
 *
 * Rules, in order of importance:
 *  - a file that differs from the incoming copy is NEVER overwritten; the
 *    incoming text is written next to it as `<file>.remote` and reported as a
 *    conflict, so a person decides;
 *  - an identical file is left alone (no spurious writes);
 *  - `dryRun` reports exactly what would happen.
 *
 * Comparing file timestamps would be guesswork across filesystems with
 * different mtime resolution, so this uses content only.
 */
export async function restoreExtras(engine, { home, kinds = ['settings', 'skills', 'ui'], dryRun = false }) {
  const applied = []
  const conflicts = []
  for (const kind of kinds) {
    const items = await readExtras(engine, kind)
    const newest = new Map()
    for (const item of items) {
      const key = `${item.name}:${item.payload?.file ?? ''}`
      if (!newest.has(key)) newest.set(key, item)
    }
    for (const item of newest.values()) {
      const target = item.payload?.file
      if (typeof target !== 'string' || !isSyncablePath(target)) continue
      const full = join(home, target)
      const existing = await readFile(full, 'utf8').catch(() => undefined)
      const incoming = item.payload.text ?? ''
      if (existing === incoming) continue
      if (existing !== undefined) {
        conflicts.push({ kind, file: target, device: item.device })
        if (dryRun) continue
        await mkdir(dirname(full), { recursive: true })
        await writeFile(`${full}.remote`, incoming)
        continue
      }
      applied.push({ kind, file: target, bytes: Buffer.byteLength(incoming), device: item.device })
      if (dryRun) continue
      await mkdir(dirname(full), { recursive: true })
      await writeFile(full, incoming)
    }
  }
  return Object.assign(applied, { applied, conflicts })
}

/** Remove this device's extras of one kind (used when a user opts back out). */
export async function removeExtras(engine, kind) {
  const listing = await engine.backend.list(`extras/${kind}/`)
  for (const entry of listing) {
    if (!entry.path.includes(`/${engine.device}-`)) continue
    await engine.backend.remove(entry.path)
  }
  await engine.backend.sync?.({ direction: 'push', message: 'sync: drop extras' })
}
