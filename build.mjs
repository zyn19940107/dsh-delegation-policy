/**
 * Standalone build for @zyn19940107/dsh-delegation-policy.
 *
 * Two artifacts come out of this build. The host half is plain ESM with the
 * harness packages left as imports: the Loader resolves them from the profile,
 * exactly as it does for an official plugin. The browser half is the same
 * source compiled for the web, with React and the shared client packages left
 * as imports the browser's module table already carries — the browser never
 * downloads a second React.
 *
 * Run: node build.mjs
 */

import { build } from 'esbuild'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

/** Harness packages the host half imports instead of bundling. */
const HOST_EXTERNALS = Object.keys(manifest.peerDependencies ?? {})

/**
 * Packages the browser's module table already carries.
 *
 * The web client seeds these into its frozen module table, so a client bundle
 * that imports one of them resolves it from there instead of shipping its own
 * copy. Anything else the browser half imports is bundled into it.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/** The package name the browser's module loader registers this bundle under. */
const CLIENT_ID = '@zyn19940107/dsh-delegation-policy'

const outDir = join(root, 'lib')
await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

await build({
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(outDir, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'es2024',
  format: 'esm',
  external: HOST_EXTERNALS,
  logLevel: 'info',
})

// The browser loads a client bundle as a classic script and hands it a
// `require` that resolves a specifier against the browser's module table.
// The bundle therefore ships as CommonJS inside the loader's registration
// wrapper: a bare specifier stays a synchronous `require`, because the
// table answers it from the platform's seeded modules or from another
// package's row, and only a package-local chunk would need the
// asynchronous form.
const clientBundle = await build({
  entryPoints: [join(root, 'src/client/index.tsx')],
  bundle: true,
  platform: 'browser',
  target: 'es2024',
  format: 'cjs',
  jsx: 'automatic',
  external: CLIENT_EXTERNALS,
  write: false,
  logLevel: 'info',
})
const clientCode = clientBundle.outputFiles[0].text
await writeFile(
  join(outDir, 'client.js'),
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(CLIENT_ID)}, factory: (require) => {\n`
  + 'var module = { exports: {} }; var exports = module.exports;\n'
  + clientCode
  + '\nreturn module.exports; } });\n',
  'utf8',
)

console.log('build: wrote lib/index.js and lib/client.js')
