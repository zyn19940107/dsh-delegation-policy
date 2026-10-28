/**
 * Bundle and run the plugin's specs.
 *
 * The specs are TypeScript, so esbuild bundles them to plain ESM first. Each
 * spec runs in its own process: a spec that ends with `process.exit` must not
 * take the next one with it.
 *
 * Run: node verify/run-specs.mjs
 */

import { build } from 'esbuild'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// The bundle is written inside the package: the system temp directory is not
// writable by the esbuild child process here.
const work = join(root, 'verify', '.build')
const specs = ['projection.spec.ts', 'budget.spec.ts', 'prompt.spec.ts', 'guard.spec.ts']

try {
  await mkdir(work, { recursive: true })
  for (const spec of specs) {
    const outfile = join(work, spec.replace(/\.ts$/u, '.mjs'))
    await build({
      entryPoints: [join(root, 'verify', spec)],
      outfile,
      bundle: true,
      platform: 'node',
      target: 'es2024',
      format: 'esm',
      // The workspace packages stay external: one of them reads its own
      // package.json by relative path, which the bundle would break.
      external: ['@deepseek-ai/*'],
      logLevel: 'warning',
    })
    const run = spawnSync(process.execPath, [outfile], { stdio: 'inherit' })
    if (run.status !== 0) {
      console.error(`\n${spec} failed`)
      process.exit(run.status ?? 1)
    }
  }
  console.log('\nall specs passed')
} finally {
  await rm(work, { recursive: true, force: true })
}
