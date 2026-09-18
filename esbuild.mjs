// Bundles the extension into dist/extension.js (DECISIONS D12).
//
//   node esbuild.mjs                one-off development build
//   node esbuild.mjs --watch        rebuild on change
//   node esbuild.mjs --production   minified, no source maps (used for packaging)
//   node esbuild.mjs --tests        also build the extension-host tests into out/test/
import * as esbuild from 'esbuild'
import { readdirSync } from 'node:fs'

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')
const tests = process.argv.includes('--tests')

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  // `vscode` is provided by the extension host; `mocha` by @vscode/test-cli.
  external: ['vscode', 'mocha'],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
}

/** @type {import('esbuild').BuildOptions[]} */
const builds = [
  { ...shared, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' },
]

if (tests) {
  // Only top-level test/*.test.ts files run inside the extension host.
  const hostTests = readdirSync('test')
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => `test/${name}`)
  builds.push({ ...shared, entryPoints: hostTests, outdir: 'out/test' })
}

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)))
  await Promise.all(contexts.map((context) => context.watch()))
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)))
}
