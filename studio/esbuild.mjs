// Bundles Lily Studio's main process into dist/main.js, its preload script
// into dist/preload.js (DECISIONS D28), and the renderer script with Monaco
// and Monaco's worker into dist/renderer/ (D29). renderer/index.html and
// layout.css are loaded as they are.
//
//   node esbuild.mjs                one-off development build
//   node esbuild.mjs --watch        rebuild on change
//   node esbuild.mjs --production   minified, no source maps
//   node esbuild.mjs --tests        test/*.test.ts → out/test/, for node --test
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
  // Loaded by a <script> tag from a sandboxed page: one classic script, with
  // Monaco's CSS beside it as app.css and its icon font as a file.
  {
    ...shared,
    entryPoints: { app: 'src/renderer/index.ts' },
    outdir: 'dist/renderer',
    format: 'iife',
    platform: 'browser',
    target: 'chrome140',
    external: [],
    loader: { '.ttf': 'file' },
  },
  {
    ...shared,
    entryPoints: { 'editor.worker': 'monaco-editor/editor/editor.worker' },
    outdir: 'dist/renderer',
    format: 'iife',
    platform: 'browser',
    target: 'chrome140',
    external: [],
  },
]

if (tests) {
  // Tests import only modules without `electron` or the DOM.
  builds.splice(0, builds.length, {
    ...shared,
    entryPoints: readdirSync('test')
      .filter((name) => name.endsWith('.test.ts'))
      .map((name) => `test/${name}`),
    outdir: 'out/test',
    logLevel: 'warning',
  })
}

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch()
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)))
}
