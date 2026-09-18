import { defineConfig } from '@vscode/test-cli'

// Extension-host tests only; they are built by `node esbuild.mjs --tests`.
export default defineConfig({
  // The smoke test asserts lazy activation, so it must run before any test that
  // opens a LilyPond document. Glob order is not sorted; array order is kept.
  files: ['out/test/smoke.test.js', 'out/test/**/*.test.js'],
  workspaceFolder: 'test/fixtures',
  mocha: { ui: 'tdd', timeout: 20000 },
})
