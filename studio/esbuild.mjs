// Bundles Lily Studio's main process into dist/main.js, its preload script
// into dist/preload.js (DECISIONS D28), and the renderer script with Monaco
// and Monaco's worker into dist/renderer/ (D29). renderer/index.html and
// layout.css are loaded as they are. The renderer carries the extension's
// grammar, language configuration and Oniguruma's WebAssembly inline (D30),
// and pdf.js, whose worker is bundled beside it (D33). The extension's
// runtime/ is copied to dist/runtime/: timing.ly for the playhead (D35), the
// warm compiler and glyph cache for live preview (D36).
//
//   node esbuild.mjs                one-off development build
//   node esbuild.mjs --watch        rebuild on change
//   node esbuild.mjs --production   minified, no source maps
//   node esbuild.mjs --tests        test/*.test.ts → out/test/, for node --test
//   node esbuild.mjs --e2e          test/e2e/*.test.ts → out/test/e2e/, the packaged app's test (D37)
import * as esbuild from 'esbuild'
import { cpSync, mkdirSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')
const tests = process.argv.includes('--tests')
const e2e = process.argv.includes('--e2e')

/**
 * language-configuration.json has comments, which esbuild's JSON loader
 * rejects. A JSON-with-comments object is a JavaScript expression, so it is
 * loaded as one.
 * @type {import('esbuild').Plugin}
 */
const jsonWithComments = {
  name: 'json-with-comments',
  setup(build) {
    build.onLoad({ filter: /[\\/]language-configuration\.json$/ }, async (args) => ({
      contents: `export default (${await readFile(args.path, 'utf8')})`,
      loader: 'js',
    }))
  },
}

/** @type {import('esbuild').BuildOptions} */
const shared = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  // Provided by the Electron runtime.
  external: ['electron'],
  loader: { '.wasm': 'binary' },
  plugins: [jsonWithComments],
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
    loader: { ...shared.loader, '.ttf': 'file' },
  },
  {
    ...shared,
    // pdf.js's worker for the PDF tab (D33), loaded as a classic worker.
    entryPoints: { 'editor.worker': 'monaco-editor/editor/editor.worker', 'pdf.worker': 'pdfjs-dist/build/pdf.worker.mjs' },
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

if (e2e) {
  // Run by `npm run test:e2e` after `npm run dist`; it drives the DMG, not the sources.
  builds.splice(0, builds.length, {
    ...shared,
    entryPoints: readdirSync('test/e2e')
      .filter((name) => name.endsWith('.test.ts'))
      .map((name) => `test/e2e/${name}`),
    outdir: 'out/test/e2e',
    logLevel: 'warning',
  })
}

if (!tests && !e2e) {
  // timing.ly is passed to every compile as -dinclude-settings; the playback
  // map comes from it. worker.scm and glyph-cache.scm speed up compiles (D25).
  mkdirSync('dist/runtime', { recursive: true })
  for (const name of ['timing.ly', 'worker.scm', 'glyph-cache.scm']) cpSync(`../runtime/${name}`, `dist/runtime/${name}`)
}

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch()
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)))
}
