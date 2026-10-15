// The error corpus of docs/research/wasm-engine/02-parser.md: each errors/*.ly
// is compiled as chapter 00 captures a score, and lilypond's stderr is kept
// beside it as *.err, the reference for layer C0.
//
//   node capture-errors.mjs           compare with the *.err files
//   node capture-errors.mjs --update  rewrite them
//
// The *.err files were captured with GNU LilyPond 2.26.0. Without lilypond the
// comparison is skipped, which verifies nothing.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const dir = path.join(path.dirname(new URL(import.meta.url).pathname), 'errors')
const update = process.argv.includes('--update')

if (spawnSync('lilypond', ['--version']).error) {
  console.log('lilypond not found: error corpus not checked')
  process.exit(0)
}

const out = mkdtempSync(path.join(tmpdir(), 'lily-errors-'))
let failed = 0
for (const file of readdirSync(dir).filter((f) => f.endsWith('.ly')).sort()) {
  const base = file.slice(0, -'.ly'.length)
  const run = spawnSync(
    'lilypond',
    ['--loglevel=WARNING', '--svg', '-dpoint-and-click', '-o', path.join(out, base), file],
    { cwd: dir, encoding: 'utf8', env: { ...process.env, LANGUAGE: 'en' } },
  )
  // lilypond names the score by its absolute path: keep it relative to this
  // directory, and lilypond's data directory as <datadir>.
  const stderr = run.stderr
    .replaceAll(`${dir}/`, '')
    .replaceAll(dir, '.')
    .replace(/[^\s:'`]*\/share\/lilypond\/[\d.]+\//g, '<datadir>/')
  const expected = path.join(dir, `${base}.err`)
  if (update) {
    writeFileSync(expected, stderr)
    continue
  }
  if (readFileSync(expected, 'utf8') !== stderr) {
    console.log(`${file}: stderr differs from ${base}.err`)
    failed++
  }
}
rmSync(out, { recursive: true, force: true })
if (failed) process.exit(1)
