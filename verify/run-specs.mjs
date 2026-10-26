/**
 * Bundle and run the plugin's specs.
 *
 * The specs are TypeScript, so esbuild bundles them to plain ESM first. The
 * projection module has no runtime dependencies, so the bundle stays small.
 *
 * Run: node verify/run-specs.mjs
 */

import { build } from 'esbuild'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// The bundle is written inside the package: the system temp directory is not
// writable by the esbuild child process here.
const work = join(root, 'verify', '.build')

try {
  await mkdir(work, { recursive: true })
  const outfile = join(work, 'projection.spec.mjs')
  await build({
    entryPoints: [join(root, 'verify/projection.spec.ts')],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'es2024',
    format: 'esm',
    logLevel: 'warning',
  })
  await import(pathToFileURL(outfile).href)
} finally {
  await rm(work, { recursive: true, force: true })
}
