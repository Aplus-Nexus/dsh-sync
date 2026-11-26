/**
 * Model configuration is the part a user most wants to carry between devices,
 * and the part most likely to leak a key. These tests pin both halves: routes
 * and catalogues travel, secrets do not, and a device never loses its own key.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load } from 'js-yaml'
import {
  readModelConfig,
  mergeModelConfig,
  stripModelSecrets,
  containsSecret,
  describeRoutes,
  profilePatchPath,
  SECRET_PLACEHOLDER,
} from '../src/models.js'

const PATCH = `
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      custom-a:
        displayName: A
        api: openai-completions
        baseURL: https://a.example/v1
        apiKey: sk-live-SHOULD-NOT-TRAVEL
        models:
          - id: model-a
            name: Model A
            contextWindow: 1000000
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: custom-a
    model: model-a
- id: ui-chat
  name: "@deepseek-ai/dsh-client-ui-chat"
  config:
    linkOpening: new-tab
- id: web
  name: "@deepseek-ai/dsh-web"
  config:
    searchProvider: deepseek-official
- id: web-search-deepseek
  name: "@deepseek-ai/dsh-web-search-deepseek"
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    model: deepseek-v4-flash
    maxTokens: 4096
`

async function patchFile(text = PATCH) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-models-'))
  const path = join(dir, 'cordis.patch.yml')
  await writeFile(path, text)
  return { dir, path }
}

test('a live api key is replaced by a placeholder', () => {
  const stripped = stripModelSecrets({ providers: { a: { apiKey: 'sk-live-123', baseURL: 'https://a' } } })
  assert.equal(stripped.providers.a.apiKey, SECRET_PLACEHOLDER)
  assert.equal(stripped.providers.a.baseURL, 'https://a')
  assert.equal(containsSecret(stripped), false)
})

test('an apiKeyEnv name is not a secret and is kept', () => {
  const stripped = stripModelSecrets({ providers: { a: { apiKeyEnv: 'MY_KEY', apiKey: 'sk-real' } } })
  assert.equal(stripped.providers.a.apiKeyEnv, 'MY_KEY')
  assert.equal(stripped.providers.a.apiKey, SECRET_PLACEHOLDER)
})

test('reading a profile extracts only the model entries', async () => {
  const { dir, path } = await patchFile()
  try {
    const config = await readModelConfig(path)
    assert.deepEqual(config.entries.map((entry) => entry.id).sort(), ['agent-default-model', 'llm-pi-ai', 'web', 'web-search-deepseek'])
    // `ui-chat` has nothing to do with models and must not travel.
    assert.equal(config.entries.some((entry) => entry.id === 'ui-chat'), false)
    assert.equal(JSON.stringify(config.entries).includes('sk-live-SHOULD-NOT-TRAVEL'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('routes include the separate search model', async () => {
  const { dir, path } = await patchFile()
  try {
    const config = await readModelConfig(path)
    const routes = describeRoutes(config.entries)
    assert.equal(routes.chat, 'custom-a / model-a')
    assert.equal(routes.searchProvider, 'deepseek-official')
    assert.equal(routes.searchModel, 'deepseek-v4-flash')
    assert.equal(routes.searchKind, 'model', 'an auxiliary-model provider is distinguishable from an API')
    assert.deepEqual(routes.providers, ['custom-a'])
    assert.equal(routes.models, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an API search provider is reported as api, not as a missing model', async () => {
  const { dir, path } = await patchFile(`
- id: agent-default-model
  config: { provider: p, model: m }
- id: web
  config: { searchProvider: deepseek-search-api }
`)
  try {
    const routes = describeRoutes((await readModelConfig(path)).entries)
    assert.equal(routes.searchKind, 'api')
    assert.equal(routes.searchModel, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a missing patch file is reported, not crashed on', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sync-models-'))
  try {
    assert.equal(await readModelConfig(join(dir, 'nope.yml')), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('merging a peer config creates an entry the device does not have', async () => {
  const { dir, path } = await patchFile('- id: ui-chat\n  config:\n    linkOpening: new-tab\n')
  try {
    const peer = {
      entries: [
        { id: 'agent-default-model', config: { provider: 'custom-a', model: 'model-a' } },
        { id: 'web-search-deepseek', config: { apiKeyEnv: 'DEEPSEEK_API_KEY', model: 'deepseek-v4-flash' } },
      ],
    }
    const result = await mergeModelConfig(path, peer.entries)
    assert.deepEqual(result.created, ['agent-default-model', 'web-search-deepseek'])
    const doc = load(await readFile(path, 'utf8'))
    assert.equal(doc.some((entry) => entry.id === 'ui-chat'), true, 'unrelated entries survive')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a shared route never overwrites the local api key', async () => {
  const { dir, path } = await patchFile()
  try {
    const peer = {
      entries: [{
        id: 'llm-pi-ai',
        config: {
          providers: {
            'custom-a': {
              displayName: 'A renamed',
              apiKey: SECRET_PLACEHOLDER,
              apiKeyEnv: 'MY_OWN_KEY',
              models: [{ id: 'model-a', name: 'Model A (peer name)' }],
            },
          },
        },
      }],
    }
    const result = await mergeModelConfig(path, peer.entries)
    assert.equal(result.updated.includes('llm-pi-ai'), true)
    const doc = load(await readFile(path, 'utf8'))
    const provider = doc.find((entry) => entry.id === 'llm-pi-ai').config.providers['custom-a']
    // The local key is still there; the peer's catalogue updates did land.
    assert.equal(provider.apiKey, 'sk-live-SHOULD-NOT-TRAVEL')
    assert.equal(provider.apiKeyEnv, 'MY_OWN_KEY')
    assert.equal(provider.displayName, 'A renamed')
    assert.equal(provider.models[0].name, 'Model A (peer name)')
    assert.ok(result.keptSecrets.some((path) => path.includes('apiKey')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a secret is never written from a placeholder', async () => {
  const { dir, path } = await patchFile('- id: ui-chat\n  config: {}\n')
  try {
    await mergeModelConfig(path, [{
      id: 'llm-pi-ai',
      config: { providers: { 'custom-a': { displayName: 'A', apiKey: SECRET_PLACEHOLDER } } },
    }])
    const text = await readFile(path, 'utf8')
    assert.equal(text.includes(SECRET_PLACEHOLDER), false, 'no placeholder may become data')
    const doc = load(text)
    const provider = doc.find((entry) => entry.id === 'llm-pi-ai').config.providers['custom-a']
    assert.equal('apiKey' in provider, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a dry run changes nothing', async () => {
  const { dir, path } = await patchFile('- id: ui-chat\n  config: {}\n')
  try {
    const before = await readFile(path, 'utf8')
    const result = await mergeModelConfig(path, [{ id: 'web', config: { searchProvider: 'x' } }], { dryRun: true })
    assert.deepEqual(result.created, ['web'])
    assert.equal(await readFile(path, 'utf8'), before)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('invalid YAML is refused instead of overwritten', async () => {
  const { dir, path } = await patchFile('not: [valid: yaml\n')
  try {
    await assert.rejects(() => mergeModelConfig(path, [{ id: 'web', config: { searchProvider: 'x' } }]), /not valid YAML|not a patch list/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('comments around entries survive a merge', async () => {
  const { dir, path } = await patchFile(`# my profile notes
# keep this
- id: llm-pi-ai
  config:
    providers:
      custom-a:
        apiKey: sk-local
- id: web
  config:
    searchProvider: old
# == dsh-sync: this device
- id: dsh-sync
  config:
    enabled: true
`)
  try {
    await mergeModelConfig(path, [{ id: 'web', config: { searchProvider: 'new' } }])
    const text = await readFile(path, 'utf8')
    assert.equal(text.includes('# my profile notes'), true, 'the user\'s header survives')
    assert.equal(text.includes('# == dsh-sync: this device'), true, 'the unrelated block\'s note survives')
    // And the voided rewrite did not lose entries.
    const doc = load(text)
    assert.equal(doc.some((entry) => entry.id === 'dsh-sync'), true)
    assert.equal(doc.find((entry) => entry.id === 'web').config.searchProvider, 'new')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the patch path is derived from the DSH home', () => {
  // `join` is platform-specific, so compare the segments rather than a literal
  // path: the same code produces a POSIX path on Linux and a Windows one there.
  const segments = (path) => path.split(/[\\/]/).filter((part) => part !== '')
  assert.deepEqual(segments(profilePatchPath('/root/.dsh')), ['root', '.dsh', 'profiles', 'web', 'cordis.patch.yml'])
  assert.deepEqual(segments(profilePatchPath('/root/.dsh', 'tui')), ['root', '.dsh', 'profiles', 'tui', 'cordis.patch.yml'])
})
