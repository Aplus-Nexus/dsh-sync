#!/usr/bin/env node
/**
 * Validate the dsh-go native manifest and views with the official checker when
 * it is available. On a developer machine it lives in the DSH skills folder; in
 * CI it is skipped with a clear message rather than silently passing.
 */
import { execFileSync } from 'node:child_process'
import { access, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const plugin = join(root, 'packages', 'dsh-plugin')

const candidates = [
  process.env.DSH_PLUGIN_CHECKER,
  join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'skills', 'dsh-go-plugin', 'kit', 'bin', 'check.mjs'),
  join(homedir(), '.dsh', 'skills', 'dsh-go-plugin', 'kit', 'bin', 'check.mjs'),
].filter(Boolean)

const checker = await firstExisting(candidates)
if (checker === undefined) {
  process.stdout.write('check-plugin: the dsh-go plugin checker is not installed here, skipping (manifest is still validated in tests)\n')
  process.exit(0)
}

const output = execFileSync(process.execPath, [checker, plugin, '--load'], { encoding: 'utf8' })
process.stdout.write(output)

// The checker reports "错误" (error) for a broken manifest or view; "提示"
// (hint) is advisory and must not fail a build.
if (/\b错误\b|^\s*error:/m.test(output)) {
  process.stderr.write('check-plugin: the checker reported an error\n')
  process.exit(1)
}

async function firstExisting(paths) {
  for (const path of paths) {
    try {
      await access(path)
      return path
    } catch {}
  }
  return undefined
}
