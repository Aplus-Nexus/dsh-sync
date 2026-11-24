#!/usr/bin/env node
/**
 * Build the installable tarballs for a release.
 *
 * Each shipped package is packed after vendoring, so `npm i -g` on a phone or a
 * `pnpm add` in a DSH profile needs no registry access to this repository's
 * other packages. A manifest records the exact versions and digests.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const dist = join(root, 'dist')
const PACKAGES = ['packages/dsh-plugin', 'packages/mcp-server', 'packages/cli']

await rm(dist, { recursive: true, force: true })
await mkdir(dist, { recursive: true })

const entries = []
for (const dir of PACKAGES) {
  const pkgDir = join(root, dir)
  const pkg = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8'))
  // `npm pack` runs in the package directory and prints the created file name.
  const out = execFileSync('npm', ['pack', '--pack-destination', dist, '--json'], { cwd: pkgDir, encoding: 'utf8' })
  const info = JSON.parse(out)[0]
  const file = join(dist, info.filename)
  const bytes = await readFile(file)
  entries.push({
    name: pkg.name,
    version: pkg.version,
    file: info.filename,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    private: pkg.private === true,
  })
}

const manifest = {
  name: 'dsh-sync',
  version: JSON.parse(await readFile(join(root, 'packages', 'dsh-plugin', 'package.json'), 'utf8')).version,
  commit: process.env.GITHUB_SHA ?? '',
  builtAt: new Date().toISOString(),
  packages: entries,
}
await writeFile(join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

// Release notes: a short, human summary plus the exact install lines.
const notes = [
  `# dsh-sync ${manifest.version}`,
  '',
  'Message-level, end-to-end encrypted conversation sync for dsh-go, DSH and Codex.',
  '',
  '## Install',
  '',
  '```sh',
  `# in a DSH profile (phone or desktop)`,
  `pnpm add ${entries.find((entry) => entry.name === '@aplus-nexus/dsh-sync')?.file ?? 'dsh-sync.tgz'}`,
  '',
  `# the MCP bridge for Codex / Claude Code`,
  `npm i -g ${entries.find((entry) => entry.name === '@aplus-nexus/dsh-sync-mcp')?.file ?? 'dsh-sync-mcp.tgz'}`,
  '',
  `# the command line`,
  `npm i -g ${entries.find((entry) => entry.name === '@aplus-nexus/dsh-sync-cli')?.file ?? 'dsh-sync-cli.tgz'}`,
  '```',
  '',
  '## Verifying a download',
  '',
  'Compare the sha256 in `manifest.json` with the file you downloaded:',
  '',
  '```sh',
  'sha256sum dsh-sync-*.tgz',
  '```',
  '',
  '| package | version | sha256 |',
  '| --- | --- | --- |',
  ...entries.map((entry) => `| \`${entry.name}\` | ${entry.version} | \`${entry.sha256.slice(0, 16)}…\` |`),
  '',
].join('\n')
await writeFile(join(dist, 'RELEASE_NOTES.md'), notes)

process.stdout.write(`packed ${entries.length} packages into dist/\n`)
for (const entry of entries) process.stdout.write(`  ${entry.file}  ${entry.bytes} bytes\n`)
