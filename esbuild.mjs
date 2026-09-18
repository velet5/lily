// Bundles the extension into dist/extension.js (DECISIONS D12) and the headless
// checker into dist/lily-check.js (D22).
//
//   node esbuild.mjs                one-off development build
//   node esbuild.mjs --watch        rebuild on change
//   node esbuild.mjs --production   minified, no source maps (used for packaging)
//   node esbuild.mjs --tests        also build the extension-host tests into out/test/
//   node esbuild.mjs --unit         build only the pure-module tests into out/unit/
//   node esbuild.mjs --e2e          build only the release pass and the screenshot
//                                   run into out/e2e/ and out/screenshots/ (D23)
import * as esbuild from 'esbuild'
import { readdirSync, rmSync } from 'node:fs'

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')
const tests = process.argv.includes('--tests')
const unit = process.argv.includes('--unit')
const e2e = process.argv.includes('--e2e')

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
const builds = unit || e2e
  ? []
  : [
      { ...shared, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' },
      {
        ...shared,
        entryPoints: ['tools/lily-check/main.ts'],
        outfile: 'dist/lily-check.js',
        banner: { js: '#!/usr/bin/env node' },
      },
    ]

if (tests) {
  // Only top-level test/*.test.ts files run inside the extension host.
  const hostTests = readdirSync('test')
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => `test/${name}`)
  builds.push({ ...shared, entryPoints: hostTests, outdir: 'out/test' })
}

if (unit) {
  // Tests in subdirectories of test/ run under `node --test`, without an
  // extension host (DECISIONS D13), so they must not import `vscode`. test/e2e/
  // is the exception: it runs in a host, on the packaged extension.
  const unitTests = readdirSync('test', { recursive: true })
    .filter((name) => name.endsWith('.test.ts') && /[\\/]/.test(name) && !/^e2e[\\/]/.test(name))
    .map((name) => `test/${name}`)
  rmSync('out/unit', { recursive: true, force: true })
  builds.push({ ...shared, entryPoints: unitTests, outdir: 'out/unit', outbase: 'test' })
}

if (e2e) {
  builds.push({ ...shared, entryPoints: ['test/e2e/smoke.test.ts'], outdir: 'out/e2e' })
  builds.push({ ...shared, entryPoints: ['test/e2e/screenshots.ts'], outdir: 'out/screenshots' })
}

if (watch) {
  const contexts = await Promise.all(builds.map((options) => esbuild.context(options)))
  await Promise.all(contexts.map((context) => context.watch()))
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)))
}
