import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, test, type TestContext } from 'node:test'
import { CompileService, orderPages } from '../../src/compile/compiler'
import { LilyPondNotFoundError, locateLilyPond } from '../../src/compile/locate'

// Runs under `node --test` from out/unit/compile/ (npm run test:unit).
const fixtures = path.resolve(__dirname, '../../../test/fixtures')

let scratch: string
let lilypondInstalled = false

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'lily-test-'))
  lilypondInstalled = await locateLilyPond().then(
    () => true,
    () => false,
  )
})

after(() => fs.rm(scratch, { recursive: true, force: true }))

/** The compile tests need the real binary; skip, rather than fail, without it. */
function needsLilyPond(t: TestContext): boolean {
  if (!lilypondInstalled) t.skip('lilypond is not installed')
  return lilypondInstalled
}

async function exists(target: string): Promise<boolean> {
  return fs.stat(target).then(
    () => true,
    () => false,
  )
}

async function fakeExecutable(dir: string, name = 'lilypond'): Promise<string> {
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, name)
  await fs.writeFile(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return file
}

describe('locateLilyPond', { skip: process.platform === 'win32' && 'uses POSIX file modes' }, () => {
  const nowhere = { env: { PATH: '' }, wellKnownDirs: [] }

  test('finds lilypond on PATH, skipping entries that are not executable files', async () => {
    const root = await fs.mkdtemp(path.join(scratch, 'path-'))
    await fs.mkdir(path.join(root, 'a', 'lilypond'), { recursive: true }) // a directory
    await fs.mkdir(path.join(root, 'b'))
    await fs.writeFile(path.join(root, 'b', 'lilypond'), '', { mode: 0o644 }) // not executable
    const real = await fakeExecutable(path.join(root, 'c'))

    const PATH = ['a', 'b', 'c'].map((dir) => path.join(root, dir)).join(path.delimiter)
    const found = await locateLilyPond({ env: { PATH }, wellKnownDirs: [] })
    assert.deepEqual(found, { path: real, source: 'path' })
  })

  test('the setting wins over PATH and may name the file, its directory or the install root', async () => {
    const root = await fs.mkdtemp(path.join(scratch, 'setting-'))
    const onPath = await fakeExecutable(path.join(root, 'on-path'))
    const custom = await fakeExecutable(path.join(root, 'custom install', 'bin'))
    const env = { PATH: path.dirname(onPath) }

    for (const configuredPath of [custom, path.dirname(custom), path.join(root, 'custom install')]) {
      const found = await locateLilyPond({ configuredPath, env, wellKnownDirs: [] })
      assert.deepEqual(found, { path: custom, source: 'setting' }, configuredPath)
    }
  })

  test('a bare command name in the setting is looked up on PATH', async () => {
    const root = await fs.mkdtemp(path.join(scratch, 'bare-'))
    const versioned = await fakeExecutable(root, 'lilypond-2.24')
    const found = await locateLilyPond({
      configuredPath: ' lilypond-2.24 ',
      env: { PATH: root },
      wellKnownDirs: [],
    })
    assert.deepEqual(found, { path: versioned, source: 'setting' })
  })

  test('a setting that does not resolve is an error, not a silent fallback to PATH', async () => {
    const root = await fs.mkdtemp(path.join(scratch, 'broken-'))
    await fakeExecutable(root)
    const configuredPath = path.join(root, 'missing', 'lilypond')
    await assert.rejects(
      locateLilyPond({ configuredPath, env: { PATH: root }, wellKnownDirs: [] }),
      (error: unknown) =>
        error instanceof LilyPondNotFoundError && error.configuredPath === configuredPath,
    )
  })

  test('falls back to well-known directories, then reports not found', async () => {
    const root = await fs.mkdtemp(path.join(scratch, 'known-'))
    const real = await fakeExecutable(root)
    assert.deepEqual(await locateLilyPond({ env: { PATH: '' }, wellKnownDirs: [root] }), {
      path: real,
      source: 'well-known',
    })
    await assert.rejects(
      locateLilyPond(nowhere),
      (error: unknown) =>
        error instanceof LilyPondNotFoundError && error.configuredPath === undefined,
    )
  })
})

describe('orderPages', () => {
  test('sorts page numbers numerically and ignores non-SVG output', () => {
    const produced = ['score-10.svg', 'score-2.svg', 'score.midi', 'score-1.svg', 'score-9.svg']
    assert.deepEqual(orderPages(produced, 'score'), [
      'score-1.svg',
      'score-2.svg',
      'score-9.svg',
      'score-10.svg',
    ])
  })

  test('keeps a base name that itself ends in a number intact', () => {
    assert.deepEqual(orderPages(['etude-2-2.svg', 'etude-2-1.svg'], 'etude-2'), [
      'etude-2-1.svg',
      'etude-2-2.svg',
    ])
    assert.deepEqual(orderPages(['etude-2.svg'], 'etude-2'), ['etude-2.svg'])
  })

  test('places suffixed and renamed books after the main book', () => {
    const produced = ['other.svg', 'score-alto-2.svg', 'score-alto-1.svg', 'score-2.svg', 'score-1.svg']
    assert.deepEqual(orderPages(produced, 'score'), [
      'score-1.svg',
      'score-2.svg',
      'score-alto-1.svg',
      'score-alto-2.svg',
      'other.svg',
    ])
  })
})

describe('CompileService', () => {
  let service: CompileService
  let tmpRoot: string

  before(async () => {
    tmpRoot = await fs.mkdtemp(path.join(scratch, 'runs-'))
    service = new CompileService({ tmpRoot })
  })

  after(() => service.dispose())

  async function source(name: string, body: string): Promise<string> {
    const dir = await fs.mkdtemp(path.join(scratch, 'src-'))
    const file = path.join(dir, name)
    await fs.writeFile(file, `\\version "2.24.0"\n${body}\n`)
    return file
  }

  // About 30 s of work, so the run is certainly alive when killed; the timeout
  // below turns a kill that does not work into a failure instead of a long wait.
  const slowBody = "{ \\repeat unfold 400 { c'8 d' e' f' g' a' b' c'' } }"

  const killTimeout = { timeout: 15000 }

  test('compiles a score into one SVG page with point-and-click links', async (t) => {
    if (!needsLilyPond(t)) return
    const rootFile = path.join(fixtures, 'simple.ly')
    const sourceDirBefore = await fs.readdir(fixtures)

    const result = await service.compile({ rootFile })

    assert.equal(result.ok, true, result.stderr)
    assert.equal(result.cancelled, false)
    assert.equal(result.exitCode, 0)
    assert.equal(result.rootFile, rootFile)
    assert.equal(result.stderr, '')
    assert.deepEqual(result.midi, [])
    assert.ok(result.outputDir?.startsWith(tmpRoot), 'output belongs under the temp root')
    assert.deepEqual(result.pages, [path.join(result.outputDir!, 'simple.svg')])

    const svg = await fs.readFile(result.pages[0], 'utf8')
    assert.match(svg, /<svg[\s>]/)
    assert.ok(svg.includes(`textedit://${rootFile}:5:`), 'links point at the source on disk')
    assert.match(svg, /currentColor/, 'the classic backend, not cairo')

    assert.deepEqual(await fs.readdir(fixtures), sourceDirBefore, 'nothing written beside the source')
  })

  test('resolves a relative \\include against the source directory', async (t) => {
    if (!needsLilyPond(t)) return
    const result = await service.compile({ rootFile: path.join(fixtures, 'hello.ly') })
    assert.equal(result.ok, true, result.stderr)
    const svg = await fs.readFile(result.pages[0], 'utf8')
    assert.ok(svg.includes(`textedit://${path.join(fixtures, 'melody.ily')}:`))
  })

  test('returns several pages in order, plus MIDI', async (t) => {
    if (!needsLilyPond(t)) return
    const pageOf = (n: number) => `\\markup "page ${n}" \\pageBreak`
    const pages = Array.from({ length: 11 }, (_, i) => pageOf(i + 1)).join('\n')
    const rootFile = await source('multi page.ly', `${pages}\n\\score { { c'1 } \\midi { } }`)

    const result = await service.compile({ rootFile })

    assert.equal(result.ok, true, result.stderr)
    assert.deepEqual(
      result.pages.map((page) => path.basename(page)),
      Array.from({ length: 11 }, (_, i) => `multi page-${i + 1}.svg`),
    )
    assert.deepEqual(result.midi, [path.join(result.outputDir!, 'multi page.midi')])
  })

  test('a failing score reports raw English stderr and still returns its page', async (t) => {
    if (!needsLilyPond(t)) return
    const rootFile = await source('bad.ly', "{ c'4 \\foo d' }")
    const previousLang = process.env.LANG
    process.env.LANG = 'de_DE.UTF-8' // would print "Fehler:" without the override
    t.after(() => {
      if (previousLang === undefined) delete process.env.LANG
      else process.env.LANG = previousLang
    })

    const result = await service.compile({ rootFile })

    assert.equal(result.ok, false)
    assert.equal(result.cancelled, false)
    assert.equal(result.exitCode, 1)
    assert.ok(result.stderr.includes(`${rootFile}:2:7: error: unknown command: \`\\foo'`), result.stderr)
    assert.match(result.stderr, /^fatal error: failed files/m)
    assert.equal(result.pages.length, 1)
  })

  test('passes extra arguments through, one per item', async (t) => {
    if (!needsLilyPond(t)) return
    const library = await fs.mkdtemp(path.join(scratch, 'my library-'))
    await fs.writeFile(path.join(library, 'shared.ily'), "tune = { c'1 }\n")
    const rootFile = await source('uses-library.ly', '\\include "shared.ily"\n{ \\tune }')

    const without = await service.compile({ rootFile })
    assert.equal(without.ok, false)

    const result = await service.compile({
      rootFile,
      extraArgs: [`--include=${library}`, '-dno-point-and-click'],
    })
    assert.equal(result.ok, true, result.stderr)
    assert.doesNotMatch(await fs.readFile(result.pages[0], 'utf8'), /textedit:/)
  })

  test('a newer compile of the same file supersedes the one in flight', killTimeout, async (t) => {
    if (!needsLilyPond(t)) return
    const rootFile = await source('edited.ly', slowBody)
    const dirsBefore = await fs.readdir(tmpRoot)

    const first = service.compile({ rootFile })
    await new Promise((resolve) => setTimeout(resolve, 400)) // let lilypond start
    await fs.writeFile(rootFile, '\\version "2.24.0"\n{ c\'1 }\n')
    const second = service.compile({ rootFile })
    const third = service.compile({ rootFile }) // supersedes `second` before it spawns

    const [a, b, c] = await Promise.all([first, second, third])
    for (const stale of [a, b]) {
      assert.equal(stale.cancelled, true)
      assert.equal(stale.ok, false)
      assert.deepEqual(stale.pages, [])
      assert.equal(stale.outputDir, undefined)
    }
    assert.equal(c.cancelled, false)
    assert.equal(c.ok, true, c.stderr)
    assert.equal(c.pages.length, 1)
    const dirsAfter = (await fs.readdir(tmpRoot)).filter((dir) => !dirsBefore.includes(dir))
    assert.deepEqual(dirsAfter, [path.basename(c.outputDir!)], 'only the winning run keeps a directory')
  })

  test('cancel() kills the run promptly and removes its directory', killTimeout, async (t) => {
    if (!needsLilyPond(t)) return
    const rootFile = await source('slow.ly', slowBody)
    const other = service.compile({ rootFile: path.join(fixtures, 'simple.ly') })

    const pending = service.compile({ rootFile })
    await new Promise((resolve) => setTimeout(resolve, 400))
    const runDirs = await fs.readdir(tmpRoot)
    const cancelledAt = performance.now()
    service.cancel(rootFile)
    const result = await pending

    assert.equal(result.cancelled, true)
    assert.ok(performance.now() - cancelledAt < 1000, 'resolved right after the kill')
    assert.equal((await other).ok, true, 'runs of other files are left alone')
    const remaining = await fs.readdir(tmpRoot)
    assert.ok(runDirs.some((dir) => !remaining.includes(dir)), 'the killed run left no directory')
  })

  test('keeps one output directory per file and deletes them on release and dispose', async (t) => {
    if (!needsLilyPond(t)) return
    const own = new CompileService({ tmpRoot: await fs.mkdtemp(path.join(scratch, 'own-')) })
    const rootFile = path.join(fixtures, 'simple.ly')

    const first = await own.compile({ rootFile })
    assert.ok(await exists(first.pages[0]))
    const second = await own.compile({ rootFile })
    assert.notEqual(second.outputDir, first.outputDir, 'every run gets a fresh directory')
    assert.equal(await exists(first.outputDir!), false, 'the replaced run is deleted')
    assert.ok(await exists(second.pages[0]))

    const hello = await own.compile({ rootFile: path.join(fixtures, 'hello.ly') })
    await own.release(rootFile)
    assert.equal(await exists(second.outputDir!), false)
    assert.ok(await exists(hello.outputDir!))

    await own.dispose()
    assert.equal(await exists(hello.outputDir!), false)
  })

  test('dispose() kills runs in flight and leaves the temp root empty', killTimeout, async (t) => {
    if (!needsLilyPond(t)) return
    const ownRoot = await fs.mkdtemp(path.join(scratch, 'disposed-'))
    const own = new CompileService({ tmpRoot: ownRoot })
    await own.compile({ rootFile: path.join(fixtures, 'simple.ly') })
    const pending = own.compile({ rootFile: await source('slow.ly', slowBody) })
    await new Promise((resolve) => setTimeout(resolve, 400))

    await own.dispose()

    assert.equal((await pending).cancelled, true)
    assert.deepEqual(await fs.readdir(ownRoot), [])
  })

  test('export writes the PDF next to the source and nothing else', async (t) => {
    if (!needsLilyPond(t)) return
    const rootFile = await source('hymn.ly', "\\score { { c'4 d' } \\layout { } \\midi { } }")
    const dir = path.dirname(rootFile)

    const result = await service.export({ rootFile, format: 'pdf' })
    assert.equal(result.ok, true)
    assert.deepEqual(result.exported, [path.join(dir, 'hymn.pdf')])
    assert.deepEqual((await fs.readdir(dir)).sort(), ['hymn.ly', 'hymn.pdf'])
    assert.equal((await fs.readFile(result.exported[0])).subarray(0, 5).toString(), '%PDF-')
    // Point-and-click would put the author's absolute paths into the file.
    assert.equal((await fs.readFile(result.exported[0], 'latin1')).includes('textedit'), false)
    assert.deepEqual([result.pages, result.midi, result.outputDir], [[], [], undefined])
  })

  test('export writes MIDI without pages, one file per book, into a directory of choice', async (t) => {
    if (!needsLilyPond(t)) return
    const score = "\\score { { c'4 } \\layout { } \\midi { } }"
    const rootFile = await source(
      'parts.ly',
      `\\book { ${score} }\n\\book { \\bookOutputSuffix "alto" ${score} }`,
    )
    const targetDir = path.join(path.dirname(rootFile), 'out', 'midi')

    const result = await service.export({ rootFile, format: 'midi', targetDir })
    assert.deepEqual(
      result.exported,
      ['parts-alto.midi', 'parts.midi'].map((name) => path.join(targetDir, name)),
    )
    assert.equal((await fs.readFile(result.exported[1])).subarray(0, 4).toString(), 'MThd')
    assert.deepEqual(await fs.readdir(path.dirname(rootFile)), ['out', 'parts.ly'])
  })

  test('a score without \\midi exports nothing, and a broken one reports why', async (t) => {
    if (!needsLilyPond(t)) return
    const silent = await service.export({ rootFile: path.join(fixtures, 'simple.ly'), format: 'midi' })
    assert.deepEqual([silent.ok, silent.exported], [true, []])

    const broken = await service.export({
      rootFile: await source('broken.ly', '{ c4 \\nonsense }'),
      format: 'midi',
    })
    assert.equal(broken.ok, false)
    assert.match(broken.stderr, /error: unknown command: `\\nonsense'/)
  })

  test('an export leaves the preview compile and its kept pages alone', killTimeout, async (t) => {
    if (!needsLilyPond(t)) return
    const own = new CompileService({ tmpRoot: await fs.mkdtemp(path.join(scratch, 'export-')) })
    const rootFile = await source('both.ly', '{ c4 }')
    const kept = await own.compile({ rootFile })

    const [compiled, exported] = await Promise.all([
      own.compile({ rootFile }),
      own.export({ rootFile, format: 'pdf' }),
    ])
    assert.deepEqual([compiled.cancelled, exported.cancelled], [false, false])
    assert.equal(await exists(kept.outputDir!), false, 'replaced by the second compile only')
    assert.ok(await exists(compiled.pages[0]))
    assert.deepEqual(await fs.readdir(path.dirname(compiled.outputDir!)), [
      path.basename(compiled.outputDir!),
    ])
    await own.dispose()
  })

  test('cancelExport() kills the export and writes nothing', killTimeout, async (t) => {
    if (!needsLilyPond(t)) return
    const rootFile = await source('slow-export.ly', slowBody)
    const running = service.export({ rootFile, format: 'pdf' })
    await new Promise((resolve) => setTimeout(resolve, 300))
    service.cancelExport(rootFile, 'pdf')

    const result = await running
    assert.deepEqual([result.cancelled, result.exported], [true, []])
    assert.deepEqual(await fs.readdir(path.dirname(rootFile)), ['slow-export.ly'])
  })

  test('rejects with the file error when the root file does not exist', async () => {
    const rootFile = path.join(scratch, 'no-such-dir', 'score.ly')
    await assert.rejects(service.compile({ rootFile }), { code: 'ENOENT', path: rootFile })
  })

  test('rejects with LilyPondNotFoundError when the configured binary is missing', async () => {
    const missing = path.join(scratch, 'no-such-dir', 'lilypond')
    await assert.rejects(
      service.compile({ rootFile: path.join(fixtures, 'simple.ly'), lilypondPath: missing }),
      LilyPondNotFoundError,
    )
  })
})
