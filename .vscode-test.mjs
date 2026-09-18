import { defineConfig } from '@vscode/test-cli'

// Extension-host tests only; they are built by `node esbuild.mjs --tests`.
export default defineConfig({
  files: 'out/test/**/*.test.js',
  workspaceFolder: 'test/fixtures',
  mocha: { ui: 'tdd', timeout: 20000 },
})
