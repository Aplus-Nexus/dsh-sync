/**
 * Sync the model configuration — chat routes, the provider catalogue, and the
 * separate search model — without ever moving an API key.
 *
 * Three things are deliberately distinct here:
 *
 *  - A **route** is which provider and model a conversation uses, e.g.
 *    `custom-opendesign-google / deepseek-v4.1-flash-eco`.
 *  - A **catalogue** is the list of models a provider offers (ids, names,
 *    context windows, base URLs).
 *  - A **credential** is the `apiKey` value. It never leaves a device.
 *
 * A provider block mixes all three, which is why this cannot be a plain file
 * copy: sharing the block verbatim publishes the key, and dropping the block
 * publishes nothing useful. Instead the block is parsed, the credential value is
 * replaced by a reference (`apiKeyEnv`) or removed, and everything else travels.
 *
 * The search side is separate on purpose: `web.searchProvider` selects *how*
 * a search runs, and `web-search-deepseek.model` is the auxiliary model that
 * provider uses. They are kept apart so one can change without the other.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Entry ids whose config carries model semantics. */
const MODEL_ENTRY_IDS = new Set([
  'llm-pi-ai',
  'agent-default-model',
  'web',
  'web-search-deepseek',
  'web-deepseek-api',
])

/** Keys whose *value* is a secret. A `apiKeyEnv` name is not. */
const SECRET_KEYS = new Set(['apiKey', 'token', 'secret', 'password'])

/** Marker written in place of a stripped secret, so a human sees one was there. */
export const SECRET_PLACEHOLDER = '<secret-not-synced>'

/**
 * Load the YAML parser on demand.
 *
 * `js-yaml` is declared by the packages that read a profile patch; a consumer
 * that only publishes messages (the MCP server, the sync core in a host without
 * model sync) must be able to load this module without it installed.
 */
async function yaml() {
  try {
    return await import('js-yaml')
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    throw new Error('model sync needs the "js-yaml" package; install it where this runs (npm i js-yaml)')
  }
}

/**
 * Strip secrets from a model config value, recursively.
 *
 * `apiKeyEnv` is kept: it names the environment variable (or credential ref)
 * a device resolves at runtime, which is exactly what a peer needs in order to
 * use the same route with its *own* key.
 */
export function stripModelSecrets(value, depth = 0) {
  if (depth > 30) return undefined
  if (Array.isArray(value)) return value.map((item) => stripModelSecrets(item, depth + 1))
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEYS.has(key)) {
      if (typeof item === 'string' && item !== '') out[key] = SECRET_PLACEHOLDER
      continue
    }
    out[key] = stripModelSecrets(item, depth + 1)
  }
  return out
}

/** Whether a config value still hides a real secret after stripping. */
export function containsSecret(value) {
  if (Array.isArray(value)) return value.some(containsSecret)
  if (value === null || typeof value !== 'object') return false
  return Object.entries(value).some(([key, item]) => (
    SECRET_KEYS.has(key) && typeof item === 'string' && item !== '' && item !== SECRET_PLACEHOLDER
  ) || containsSecret(item))
}

/**
 * Read the model-relevant entries out of a profile patch.
 *
 * @param {string} patchPath absolute path to `cordis.patch.yml`.
 * @returns {Promise<{entries: object[]}|null>} one `{ id, config }` per entry,
 *   with secrets replaced by a reference or a placeholder.
 */
export async function readModelConfig(patchPath) {
  let text
  try {
    text = await readFile(patchPath, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  const { load } = await yaml()
  let doc
  try {
    doc = load(text)
  } catch {
    return null
  }
  if (!Array.isArray(doc)) return null
  const entries = []
  for (const entry of doc) {
    if (!entry || typeof entry !== 'object') continue
    const id = entry.id
    if (typeof id !== 'string' || !MODEL_ENTRY_IDS.has(id)) continue
    if (entry.config === undefined) continue
    entries.push({ id, config: stripModelSecrets(entry.config) })
  }
  return entries.length === 0 ? null : { entries }
}

/**
 * Merge model entries into a live patch document.
 *
 * Rules, in order:
 *  1. an entry the peer publishes is created if this device does not have it;
 *  2. an existing entry has its **non-secret** fields updated and its secret
 *     fields left alone — a device keeps its own key for a shared route;
 *  3. an entry this device has and the peer does not is **kept**, never deleted;
 *  4. a secret placeholder is never written as a value.
 *
 * @param {string} patchPath
 * @param {object[]} incoming entries from a peer.
 * @param {object} [options]
 * @param {boolean} [options.dryRun]
 * @returns {Promise<{created: string[], updated: string[], keptSecrets: string[]}>}
 */
/**
 * Collect the comment lines of a patch document, keyed by the entry they sit
 * above. A document written by a person usually has notes about each block; a
 * rewrite must put them back or the merge silently destroys them.
 */
export function collectComments(text) {
  const blocks = new Map()
  let current = null
  let pending = []
  for (const line of text.split('\n')) {
    if (line.trim().startsWith('#')) {
      pending.push(line)
      continue
    }
    const entry = /^-\s*id\s*:\s*['"]?(\S+)['"]?\s*$/u.exec(line.trim())
    if (entry !== null) {
      current = entry[1]
      if (pending.length > 0) blocks.set(current, pending.slice())
      pending = []
      continue
    }
    if (line.trim() === '' && pending.length > 0) {
      // A blank line keeps the comment attached to whatever follows.
      continue
    }
    if (!line.startsWith(' ') && line.trim() !== '' && pending.length > 0) {
      // A top-level line that is not an entry starts its own group.
      pending = []
    }
  }
  if (pending.length > 0) blocks.set('__trailing__', pending)
  return blocks
}

/** Put the collected comment lines back above the entry they belong to. */
export function applyComments(doc, comments, dumpFn) {
  const lines = []
  for (const entry of doc) {
    const id = typeof entry?.id === 'string' ? entry.id : undefined
    if (id !== undefined && comments.has(id)) lines.push(...comments.get(id))
    lines.push(...dumpEntry(entry, dumpFn).split('\n').filter((line) => line !== ''))
  }
  if (comments.has('__trailing__')) lines.push(...comments.get('__trailing__'))
  return `${lines.join('\n')}\n`
}

/** Dump one entry as a YAML list item, without a document-level `-` marker. */
function dumpEntry(entry, dump) {
  // `js-yaml` has no per-item dump, so dump a one-item list and keep its lead.
  return dump([entry], { lineWidth: 120, noRefs: true }).trimEnd()
}

export async function mergeModelConfig(patchPath, incoming, { dryRun = false } = {}) {
  const result = { created: [], updated: [], keptSecrets: [], unchanged: 0 }
  const { load, dump } = await yaml()
  const text = await readFile(patchPath, 'utf8').catch(() => '')
  const comments = collectComments(text)
  let doc = []
  try {
    doc = load(text) ?? []
  } catch {
    throw new Error(`${patchPath} is not valid YAML; refusing to merge into it`)
  }
  if (!Array.isArray(doc)) throw new Error(`${patchPath} is not a patch list; refusing to merge into it`)

  for (const entry of incoming ?? []) {
    if (typeof entry?.id !== 'string') continue
    const target = doc.find((item) => item !== null && typeof item === 'object' && item.id === entry.id)
    if (target === undefined || target === null) {
      doc.push({ id: entry.id, config: withoutPlaceholders(entry.config) })
      result.created.push(entry.id)
      continue
    }
    const current = target.config ?? {}
    const merged = mergeValue(current, entry.config, result.keptSecrets, entry.id)
    if (JSON.stringify(merged) === JSON.stringify(current)) continue
    target.config = merged
    result.updated.push(entry.id)
  }

  result.unchanged = (incoming ?? []).length - result.created.length - result.updated.length
  if (dryRun) return result
  if (result.created.length === 0 && result.updated.length === 0) return result
  await mkdir(dirname(patchPath), { recursive: true })
  await writeFile(patchPath, applyComments(doc, comments, dump))


  return result
}

/**
 * Deep-merge a peer's value into the local one.
 *
 * The local value wins for every secret, and an absent local key is filled
 * from the peer only when the peer value is not a placeholder.
 */
function mergeValue(local, remote, keptSecrets, entryId, path = '') {
  if (remote === SECRET_PLACEHOLDER) {
    if (local === undefined) return undefined
    keptSecrets.push(`${entryId}.${path}`)
    return local
  }
  if (remote === null || typeof remote !== 'object' || Array.isArray(remote)) return remote
  const base = local !== null && typeof local === 'object' && !Array.isArray(local) ? { ...local } : {}
  for (const [key, value] of Object.entries(remote)) {
    const childPath = path === '' ? key : `${path}.${key}`
    if (SECRET_KEYS.has(key) || value === SECRET_PLACEHOLDER) {
      if (base[key] !== undefined && base[key] !== '') keptSecrets.push(`${entryId}.${childPath}`)
      // A key is never taken from a peer: this device sets its own.
      continue
    }
    const merged = mergeValue(base[key], value, keptSecrets, entryId, childPath)
    if (merged !== undefined) base[key] = merged
  }
  return base
}

/** Remove placeholder values entirely, so they are never written as data. */
function withoutPlaceholders(value) {
  if (value === SECRET_PLACEHOLDER) return undefined
  if (Array.isArray(value)) return value.map(withoutPlaceholders).filter((item) => item !== undefined)
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    const cleaned = withoutPlaceholders(item)
    if (cleaned !== undefined) out[key] = cleaned
  }
  return out
}

/** A one-line summary of the routes a config describes, for the phone panel. */
export function describeRoutes(entries) {
  const chat = entries?.find((entry) => entry.id === 'agent-default-model')?.config
  const web = entries?.find((entry) => entry.id === 'web')?.config
  const searchModel = entries?.find((entry) => entry.id === 'web-search-deepseek')?.config
  // `deepseek-search-api` is a dedicated retrieval API, not a model route; only
  // the `deepseek-official` provider runs an auxiliary model that can be set.
  const searchKind = web?.searchProvider === 'deepseek-official' ? 'model' : 'api'
  const providers = entries?.find((entry) => entry.id === 'llm-pi-ai')?.config?.providers ?? {}
  return {
    chat: chat === undefined ? null : `${chat.provider ?? '?'} / ${chat.model ?? '?'}`,
    searchProvider: web?.searchProvider ?? null,
    searchKind,
    searchModel: searchModel?.model ?? null,
    providers: Object.keys(providers),
    models: Object.values(providers).reduce((total, provider) => total + (provider?.models?.length ?? 0), 0),
  }
}

/** The path of a profile's patch file, given a DSH home and profile name. */
export function profilePatchPath(home, profile = 'web') {
  return join(home, 'profiles', profile, 'cordis.patch.yml')
}
