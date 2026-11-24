#!/usr/bin/env node
/**
 * Generate the plugin market index that dsh-go reads.
 *
 * Two source shapes are supported:
 *  - npm: the packages are published, so the index points at exact versions.
 *  - git: nothing is published, and each entry pins the repository commit that
 *    CI built, which is how a phone installs straight from GitHub.
 *
 * The output is validated with DSH's own format-1 parser before it is written,
 * so a broken index fails the build instead of the app.
 */
import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1])

const repo = args.get('repo') ?? 'Aplus-Nexus/dsh-sync'
const commit = args.get('commit') ?? currentCommit()

function currentCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return '0'.repeat(40)
  }
}
const outFile = args.get('out') ?? join(root, 'site', 'market-index.json')
const pages = args.get('pages') ?? `https://${repo.split('/')[0].toLowerCase()}.github.io/${repo.split('/')[1]}`
const version = JSON.parse(readFileSync(join(root, 'packages', 'dsh-plugin', 'package.json'), 'utf8')).version
const published = args.get('source') === 'npm'
const timestamp = Number(args.get('timestamp') ?? Math.floor(Date.now() / 1000))

const source = published ? { type: 'npm' } : { type: 'git', url: `https://github.com/${repo}`, commit, path: 'packages/dsh-plugin' }

const index = {
  format: 1,
  title: { en: 'DSH Sync', zh: 'DSH 消息云同步' },
  description: {
    en: 'Message-level, end-to-end encrypted conversation sync across phones, desktops and other agents.',
    zh: '消息级、端到端加密的对话同步，跨手机、电脑与其他智能体。',
  },
  metadata: {
    categories: {
      sync: { title: { en: 'Sync', zh: '同步' } },
      tools: { title: { en: 'Tools', zh: '工具' } },
    },
    labels: {
      native: { title: { en: 'Native UI', zh: '原生界面' } },
      encrypted: { title: { en: 'End-to-end encrypted', zh: '端到端加密' } },
      'no-server': { title: { en: 'No server', zh: '无需服务器' } },
      mcp: { title: { en: 'MCP', zh: 'MCP' } },
    },
    sortKeys: {
      stars: { title: { en: 'Popularity', zh: '热度' }, order: 'desc' },
    },
  },
  plugins: [
    {
      name: '@aplus-nexus/dsh-sync',
      title: { en: 'Message sync', zh: '消息云同步' },
      description: {
        en: 'Push every DSH message to your own private repository, encrypted with a passphrase only your devices know. Another phone, your desktop, or a Codex session can pull the same conversation and keep going.',
        zh: '把每条 DSH 消息推进你自己的私有仓库，用只有你的设备知道的口令端到端加密。另一台手机、你的电脑，或一个 Codex 会话都能拉下同一段对话继续聊。',
      },
      icon: `${pages}/assets/icon-256.png`,
      author: 'Aplus-Nexus',
      homepage: `https://github.com/${repo}`,
      repository: { url: `https://github.com/${repo}`, directory: 'packages/dsh-plugin' },
      metadata: {
        category: 'sync',
        keywords: ['sync', 'dsh-go', 'encryption', 'codex', 'mcp', 'conversation'],
        labels: ['native', 'encrypted', 'no-server'],
        sortKeys: { stars: 1 },
      },
      versions: [
        {
          version,
          publishTimestamp: timestamp,
          source,
          engines: { dsh: '>=0.2.1-rc.2 <0.3.0-0' },
        },
      ],
    },
  ],
}

// Validate with DSH's own parser when it is installed (CI installs it).
let validated = false
try {
  const { parseMarketIndex } = await import('@deepseek-ai/dsh-plugin-market-index')
  parseMarketIndex(index, `${pages}/market-index.json`)
  validated = true
} catch (error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') {
    process.stdout.write('market: parser not installed, writing without validation\n')
  } else {
    validated = false
    throw error
  }
}

await mkdir(dirname(outFile), { recursive: true })
await writeFile(outFile, `${JSON.stringify(index, null, 2)}\n`)
process.stdout.write(`market index -> ${outFile}${validated ? ' (validated)' : ''}\n`)
