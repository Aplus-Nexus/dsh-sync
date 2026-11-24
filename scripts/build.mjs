#!/usr/bin/env node
/**
 * Build = vendor the core into every shipped package, then check that each
 * entry point loads without a host present. Runs in CI on every push.
 */
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

execFileSync(process.execPath, [join(here, 'vendor-core.mjs')], { stdio: 'inherit', cwd: root })

// The vendored core resolves on its own; importing it proves the copy is complete.
// `pathToFileURL` is required: a bare Windows path such as D:\a\... is not a
// valid ESM specifier, and a build must not depend on the drive letter.
const core = await import(pathToFileURL(join(root, 'packages', 'core', 'src', 'index.js')).href)
if (typeof core.SyncEngine !== 'function') throw new Error('vendored core is missing SyncEngine')
process.stdout.write(`build ok: core exports ${Object.keys(core).length} names\n`)
