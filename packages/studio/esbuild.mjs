// Bundles Lily Studio's page into dist/web/, which Tauri serves as the app's
// frontend (DECISIONS D42): renderer/index.html and layout.css as they are,
// the renderer script with Monaco as app.js and Monaco's CSS as app.css
// (D29), and Monaco's and pdf.js's workers beside it (D33). The renderer
// carries @lily/common's grammar, language configuration and Oniguruma's
// WebAssembly inline (D30). smoke.js is the smoke test's driver, loaded only
// by `lily-studio --smoke-test` (D42). @lily/common's runtime/ and the
// studio's own are copied to dist/runtime/, which the app bundles as a
// resource: settings.ly, timing.ly for the playhead (D35) and words.ly for
// Karaoke (D133), and the warm compiler and glyph cache for live preview (D36).
// `--site` bundles the same page for the web into dist/site/ instead, which
// lily-studio-server serves (D55): src/web/transport.ts in place of the
// Tauri one, with the web's menu bar, dialogs and web.css in app.css.
// With `--site`, the engine's worker is bundled as engine.worker.js, and
// engine.js, which starts it for `?engine=1` (D171), or for any page but
// `?engine=0`'s with `--engine-default` (D174), is loaded before app.js
// by the site's copy of index.html; the engine's files, when its build
// (packages/engine/scripts/build.mjs) left them in ../engine/dist/engine/,
// are copied to dist/site/engine/ under names that carry a hash of their
// bytes (chapter 08 of docs/research/wasm-engine).
//
//   node esbuild.mjs                one-off development build
//   node esbuild.mjs --site         the web's page, dist/site/ (with --production, minified;
//                                   with --engine-default, the engine on unless refused, D174)
//   node esbuild.mjs --watch        rebuild on change
//   node esbuild.mjs --production   minified, no source maps
//   node esbuild.mjs --tests        test/*.test.ts → out/test/, for node --test
//   node esbuild.mjs --e2e          test/e2e/*.test.ts → out/test/e2e/, the packaged app's test (D37)
import * as esbuild from 'esbuild'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')
const tests = process.argv.includes('--tests')
const e2e = process.argv.includes('--e2e')
const site = process.argv.includes('--site')
// The engine runs for a page that asks nothing (D174): only once its source is public (D56, OPEN I5).
const engineDefault = process.argv.includes('--engine-default')

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

/**
 * The web's transport in place of the app's: bridge.ts imports `./transport`,
 * which on the web is src/web/transport.ts (D55).
 * @type {import('esbuild').Plugin}
 */
const webTransport = {
  name: 'web-transport',
  setup(build) {
    build.onResolve({ filter: /^\.\/transport$/ }, (args) =>
      /[\\/]src[\\/]renderer[\\/]bridge\.ts$/.test(args.importer) ? { path: resolve('src/web/transport.ts') } : undefined,
    )
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

// The web's page: browsers of the last two years, as well as the Mac's WebKit.
if (site) {
  builds.splice(
    0,
    builds.length,
    ...builds.map((options) => ({
      ...options,
      entryPoints: Object.fromEntries(Object.entries(options.entryPoints).filter(([name]) => name !== 'smoke')),
      outdir: 'dist/site',
      target: ['safari17', 'chrome120', 'firefox121'],
      plugins: [...options.plugins, webTransport],
    })),
  )
}
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
    // The engine's build precompresses each file (H5); the copy keeps it beside its hashed name.
    if (existsSync(`${from}/${file}.br`)) cpSync(`${from}/${file}.br`, `${to}/${name}.br`)
    return name
  }
  manifest.core.wasm = hashed(manifest.core.wasm)
  manifest.core.image = hashed(manifest.core.image)
  if (manifest.core.debug) manifest.core.debug = hashed(manifest.core.debug)
  for (const module of Object.values(manifest.modules)) module.file = hashed(module.file)
  // The licences keep their names, so that a page can link them (D170); the gateway has them revalidated.
  for (const file of Object.values(manifest.licenses ?? {})) cpSync(`${from}/${file}`, `${to}/${file}`)
  // LilyPond's text families as web fonts (E17, D263): fonts.css, revalidated as its name is kept, names
  // the hashed files, which a browser fetches only for text it draws in that face.
  const faces = (manifest.webFonts ?? []).map((font) => {
    font.file = hashed(font.file)
    return `@font-face { font-family: "${font.family}"; font-weight: ${font.weight}; font-style: ${font.style}; font-display: swap; src: url("${font.file}") format("opentype"); }`
  })
  writeFileSync(`${to}/fonts.css`, faces.join('\n') + '\n')
  writeFileSync(`${to}/manifest.json`, JSON.stringify(manifest))
}

/**
 * The web's index.html: engine.js before app.js (08 §7, D171), so that the
 * engine's worker starts fetching while app.js loads; both deferred, so they
 * run in that order. With the engine's files, its fonts.css (E17, D263),
 * whose faces draw the text of any page, the server's too.
 */
function sitePage(html, fonts = existsSync('../engine/dist/engine/manifest.json')) {
  const app = '<script src="app.js" defer></script>'
  if (!html.includes(app)) throw new Error(`renderer/index.html has no ${app}`)
  const viewport = '<meta name="viewport" content="width=device-width, initial-scale=1" />'
  if (!html.includes(viewport)) throw new Error(`renderer/index.html has no ${viewport}`)
  // Opens full screen from the iPad's Home Screen, as an app.
  const homeScreen = '<meta name="apple-mobile-web-app-capable" content="yes" />\n    <meta name="apple-mobile-web-app-title" content="Lily" />\n    <link rel="apple-touch-icon" href="icon.png" />'
  const page = html
    .replace(viewport, `${viewport}\n    ${homeScreen}`)
    .replace(app, `<script src="engine.js" defer></script>\n    ${app}`)
  const css = '<link rel="stylesheet" href="layout.css" />'
  if (!fonts) return page
  if (!page.includes(css)) throw new Error(`renderer/index.html has no ${css}`)
  return page.replace(css, `${css}\n    <link rel="stylesheet" href="engine/fonts.css" />`)
}

// The engine runs in the web's page only (chapter 08 of docs/research/wasm-engine).
if (process.argv.includes('--site')) {
  builds.push({
    ...shared,
    entryPoints: { 'engine.worker': 'src/web/engine/worker.ts', engine: 'src/web/engine/engine.ts' },
    outdir: 'dist/site',
    define: { LILY_ENGINE_DEFAULT: String(engineDefault) },
  })
  copyEngine('../engine/dist/engine', 'dist/site/engine')
}
// Tests import only modules without the DOM or Tauri.
if (tests) builds.splice(0, builds.length, nodeBuild('test', 'out/test'))
// Run by `npm run test:e2e` after `npm run dist`; it drives the DMG, not the sources.
if (e2e) builds.splice(0, builds.length, nodeBuild('test/e2e', 'out/test/e2e'))

if (!tests && !e2e) {
  const page = site ? 'dist/site' : 'dist/web'
  mkdirSync(page, { recursive: true })
  cpSync('renderer/layout.css', `${page}/layout.css`)
  if (site) cpSync('build/icon.png', `${page}/icon.png`)
  writeFileSync(`${page}/index.html`, site ? sitePage(readFileSync('renderer/index.html', 'utf8')) : readFileSync('renderer/index.html'))
}

// settings.ly is passed to every compile as -dinclude-settings, and includes
// timing.ly, the playback map, and words.ly, Karaoke's words, which only the
// studio has. worker.scm and glyph-cache.scm speed up compiles (D25). The
// tests take them from here too: lily-outcome compiles with this directory.
mkdirSync('dist/runtime', { recursive: true })
for (const name of ['timing.ly', 'worker.scm', 'glyph-cache.scm']) cpSync(`../common/runtime/${name}`, `dist/runtime/${name}`)
for (const name of ['settings.ly', 'words.ly']) cpSync(`runtime/${name}`, `dist/runtime/${name}`)

if (watch) {
  for (const options of builds) await (await esbuild.context(options)).watch()
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)))
}
