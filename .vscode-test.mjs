import { defineConfig } from '@vscode/test-cli'

const mocha = { ui: 'tdd', timeout: 20000 }
const packaged = {
  extensionDevelopmentPath: '.vscode-test/vsix/extension',
  workspaceFolder: 'test/e2e/workspace',
}
const screenshotPort = process.env.SCREENSHOT_PORT ?? '9339'

export default defineConfig([
  {
    // Extension-host tests on the working tree; built by `node esbuild.mjs --tests`.
    label: 'host',
    // The smoke test asserts lazy activation, so it must run before any test that
    // opens a LilyPond document. Glob order is not sorted; array order is kept.
    files: ['out/test/smoke.test.js', 'out/test/**/*.test.js'],
    workspaceFolder: 'test/fixtures',
    mocha,
  },
  {
    // The release pass on the unpacked VSIX (DECISIONS D23); run it with
    // `npm run test:e2e`, which packages and unpacks first.
    label: 'e2e',
    files: 'out/e2e/**/*.test.js',
    ...packaged,
    mocha: { ...mocha, timeout: 60000 },
  },
  {
    // Rewrites docs/images/*.png for the README: `npm run screenshots`.
    label: 'screenshots',
    files: 'out/screenshots/screenshots.js',
    ...packaged,
    launchArgs: [`--remote-debugging-port=${screenshotPort}`],
    env: { SCREENSHOT_PORT: screenshotPort },
    mocha: { ...mocha, timeout: 120000 },
  },
])
