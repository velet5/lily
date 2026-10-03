// Bundles Lily Studio's page into dist/web/, which Tauri serves as the app's
// frontend (DECISIONS D42): renderer/index.html and layout.css as they are,
// the renderer script with Monaco as app.js and Monaco's CSS as app.css
// (D29), and Monaco's and pdf.js's workers beside it (D33). The renderer
// carries @lily/common's grammar, language configuration and Oniguruma's
// WebAssembly inline (D30). smoke.js is the smoke test's driver, loaded only
// by `lily-studio --smoke-test` (D42). @lily/common's runtime/ is copied to
// dist/runtime/, which the app bundles as a resource: timing.ly for the
// playhead (D35), the warm compiler and glyph cache for live preview (D36).
// With `--site`, the engine's worker is bundled as engine.worker.js, and the
// engine's files, when its build left them in dist/engine/, are copied to
// dist/site/engine/ under names that carry a hash of their bytes (chapter 08
// of docs/research/wasm-engine).
//
//   node esbuild.mjs                one-off development build
//   node esbuild.mjs --watch        rebuild on change
//   node esbuild.mjs --production   minified, no source maps
//   node esbuild.mjs --tests        test/*.test.ts → out/test/, for node --test
//   node esbuild.mjs --e2e          test/e2e/*.test.ts → out/test/e2e/, the packaged app's test (D37)
import * as esbuild from 'esbuild'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  // Classic scripts and workers, loaded by <script> tags and new Worker().
  format: 'iife',
  platform: 'browser',
  // The system WebKit of macOS 14 and later.
  target: 'safari17',
  loader: { '.wasm': 'binary' },
  plugins: [jsonWithComments],
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
}

/** @type {import('esbuild').BuildOptions[]} */
const builds = [
  // Monaco's icon font is written as a file beside app.css.
  {
    ...shared,
    entryPoints: { app: 'src/renderer/index.ts', smoke: 'src/renderer/smoke.ts' },
    outdir: 'dist/web',
    loader: { ...shared.loader, '.ttf': 'file' },
  },
  {
    ...shared,
    entryPoints: { 'editor.worker': 'monaco-editor/editor/editor.worker', 'pdf.worker': 'pdfjs-dist/build/pdf.worker.mjs' },
    outdir: 'dist/web',
  },
]

/** Test files for node --test: CommonJS for Node, the same loaders. */
const nodeBuild = (dir, outdir) => ({
  ...shared,
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  entryPoints: readdirSync(dir)
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => `${dir}/${name}`),
  outdir,
  logLevel: 'warning',
})

/**
 * The engine's files and their manifest (src/web/engine/protocol.ts), as the
 * engine's build left them in `from`, copied to `to` with a hash of their
 * bytes in each name, so that a name never changes its bytes and the cache
 * never holds a stale file. Without an engine build the page compiles on the
 * server, as before.
 */
function copyEngine(from, to) {
  if (!existsSync(`${from}/manifest.json`)) return
  const manifest = JSON.parse(readFileSync(`${from}/manifest.json`, 'utf8'))
  rmSync(to, { recursive: true, force: true })
  mkdirSync(to, { recursive: true })
  const hashed = (file) => {
    const bytes = readFileSync(`${from}/${file}`)
    const name = file.replace(/(\.[^.]+)?$/, `.${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}$1`)
    writeFileSync(`${to}/${name}`, bytes)
    return name
  }
  manifest.core.wasm = hashed(manifest.core.wasm)
  manifest.core.image = hashed(manifest.core.image)
  for (const module of Object.values(manifest.modules)) module.file = hashed(module.file)
  writeFileSync(`${to}/manifest.json`, JSON.stringify(manifest))
}

// The engine runs in the web's page only (chapter 08 of docs/research/wasm-engine).
if (process.argv.includes('--site')) {
  builds.push({ ...shared, entryPoints: { 'engine.worker': 'src/web/engine/worker.ts' }, outdir: 'dist/site' })
  copyEngine('dist/engine', 'dist/site/engine')
}
// Tests import only modules without the DOM or Tauri.
if (tests) builds.splice(0, builds.length, nodeBuild('test', 'out/test'))
// Run by `npm run test:e2e` after `npm run dist`; it drives the DMG, not the sources.
if (e2e) builds.splice(0, builds.length, nodeBuild('test/e2e', 'out/test/e2e'))

if (!tests && !e2e) {
  mkdirSync('dist/web', { recursive: true })
  for (const name of ['index.html', 'layout.css']) cpSync(`renderer/${name}`, `dist/web/${name}`)
  // timing.ly is passed to every compile as -dinclude-settings; the playback
  // map comes from it. worker.scm and glyph-cache.scm speed up compiles (D25).
  mkdirSync('dist/runtime', { recursive: true })
  for (const name of ['timing.ly', 'worker.scm', 'glyph-cache.scm']) cpSync(`../common/runtime/${name}`, `dist/runtime/${name}`)
}

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch()
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)))
}
