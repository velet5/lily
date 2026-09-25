// Bundles Lily Studio's main process into dist/main.js and its preload script
// into dist/preload.js (DECISIONS D28). renderer/ is loaded as it is.
//
//   node esbuild.mjs                one-off development build
//   node esbuild.mjs --watch        rebuild on change
//   node esbuild.mjs --production   minified, no source maps
import * as esbuild from 'esbuild'

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  // Provided by the Electron runtime.
  external: ['electron'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
}

/** @type {import('esbuild').BuildOptions[]} */
const builds = [
  { ...shared, entryPoints: ['src/main.ts'], outfile: 'dist/main.js' },
  // A sandboxed preload is one CommonJS file that may only require `electron`.
  { ...shared, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.js' },
]

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch()
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)))
}
