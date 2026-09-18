// Unpacks the VSIX that `npm run vsix` wrote into .vscode-test/vsix/, where the
// `e2e` configuration of .vscode-test.mjs loads it as the extension (D23).
//
//   node scripts/unpack-vsix.mjs
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'

const { name, version } = JSON.parse(readFileSync('package.json', 'utf8'))
const vsix = `${name}-${version}.vsix`
const target = '.vscode-test/vsix'

if (!existsSync(vsix)) {
  console.error(`${vsix} not found; run \`npm run vsix\` first.`)
  process.exit(1)
}
rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
// A VSIX is a zip. bsdtar (Windows, macOS) reads zip; GNU tar (Linux) does not.
if (process.platform === 'linux') execFileSync('unzip', ['-q', vsix, '-d', target])
else execFileSync('tar', ['-xf', vsix, '-C', target])
console.log(`${vsix} → ${target}/extension`)
