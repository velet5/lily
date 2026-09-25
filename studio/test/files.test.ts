import * as assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, test, type TestContext } from 'node:test'
import { promisify } from 'node:util'
import { locateLilyPond } from '../../src/compile/locate'
import { Access, createFromTemplate, isInside, listFolder, readScore, unusedName, writeScore } from '../src/files'
import { fileRows } from '../src/renderer/files'
import { TEMPLATES } from '../src/templates'

// Runs under `node --test` from out/test/ (npm run test:unit in studio/).

let scratch: string

before(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lily-studio-test-')))
})

after(async () => {
  if (scratch) await fs.rm(scratch, { recursive: true, force: true })
})

async function touch(relative: string, text = ''): Promise<string> {
  const file = path.join(scratch, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
  return file
}

describe('listFolder', () => {
  test('lists LilyPond files, a directory’s files before its subdirectories', async () => {
    const folder = path.join(scratch, 'list')
    for (const name of [
      'list/Score 10.ly',
      'list/score 2.ly',
      'list/b/part.ily',
      'list/a/deep/x/y/z/too-deep.ly',
      'list/a/deep/x/y/fits.ly',
      'list/a/defs.lyi',
      'list/readme.txt',
      'list/.hidden/secret.ly',
      'list/.dot.ly',
      'list/node_modules/pkg/index.ly',
    ]) {
      await touch(name)
    }
    const listing = await listFolder(folder)
    assert.equal(listing.folder, folder)
    assert.equal(listing.name, 'list')
    assert.equal(listing.truncated, false)
    assert.deepEqual(
      listing.files.map((f) => f.relative),
      ['score 2.ly', 'Score 10.ly', 'a/defs.lyi', 'a/deep/x/y/fits.ly', 'b/part.ily'],
    )
    assert.equal(listing.files[0]?.path, path.join(folder, 'score 2.ly'))
  })

  test('an empty or missing folder has no files', async () => {
    await fs.mkdir(path.join(scratch, 'empty'))
    assert.deepEqual((await listFolder(path.join(scratch, 'empty'))).files, [])
    assert.deepEqual((await listFolder(path.join(scratch, 'missing'))).files, [])
  })
})

describe('fileRows', () => {
  test('adds a heading for each directory once, indented by depth', () => {
    const files = ['main.ly', 'parts/violin.ily', 'parts/strings/viola.ily', 'parts/strings/cello.ily', 'z.ily'].map(
      (relative) => ({ relative, path: `/f/${relative}` }),
    )
    assert.deepEqual(
      fileRows(files).map((row) => `${'  '.repeat(row.depth)}${row.kind === 'directory' ? `${row.name}/` : row.name}`),
      ['main.ly', 'parts/', '  violin.ily', '  strings/', '    viola.ily', '    cello.ily', 'z.ily'],
    )
  })

  test('a sibling directory gets its own heading', () => {
    const files = ['a/x/1.ly', 'a/y/2.ly'].map((relative) => ({ relative, path: `/f/${relative}` }))
    assert.deepEqual(
      fileRows(files).map((row) => [row.kind, row.name, row.depth]),
      [
        ['directory', 'a', 0],
        ['directory', 'x', 1],
        ['file', '1.ly', 2],
        ['directory', 'y', 1],
        ['file', '2.ly', 2],
      ],
    )
  })
})

describe('Access', () => {
  test('isInside accepts the folder and its descendants only', () => {
    assert.ok(isInside('/music', '/music'))
    assert.ok(isInside('/music', '/music/a/b.ly'))
    assert.ok(!isInside('/music', '/music-old/b.ly'))
    assert.ok(!isInside('/music', '/music/../etc/b.ly'))
    assert.ok(!isInside('/music', '/'))
  })

  test('allows the open folder and picked files, nothing else', () => {
    const access = new Access()
    assert.throws(() => access.check('/music/a.ly'), /outside the open folder/)
    access.folder = '/music'
    assert.equal(access.check('/music/sub/a.ly'), '/music/sub/a.ly')
    assert.throws(() => access.check('/music/../secret/a.ly'), /outside the open folder/)
    assert.throws(() => access.check('/elsewhere/b.ly'), /outside the open folder/)
    access.allowFile('/elsewhere/b.ly')
    assert.equal(access.check('/elsewhere/b.ly'), '/elsewhere/b.ly')
    assert.throws(() => access.check('/elsewhere/c.ly'), /outside the open folder/)
  })

  test('rejects relative paths, non-strings and files that are not scores', () => {
    const access = new Access()
    access.folder = '/music'
    assert.throws(() => access.check('a.ly'), /absolute path/)
    assert.throws(() => access.check(42), /absolute path/)
    assert.throws(() => access.check('/music/notes.txt'), /Not a LilyPond file/)
  })
})

describe('reading, writing and new scores', () => {
  test('writeScore and readScore round-trip UTF-8 text', async () => {
    const file = path.join(scratch, 'round.ly')
    const text = '\\header { title = "Für Elise — ♩" }\r\n{ c4 }\n'
    await writeScore(file, text)
    assert.equal(await readScore(file), text)
  })

  test('unusedName counts up past existing files', async () => {
    const folder = path.join(scratch, 'names')
    await fs.mkdir(folder)
    assert.equal(await unusedName(folder), path.join(folder, 'Untitled.ly'))
    await touch('names/Untitled.ly')
    await touch('names/Untitled 2.ly')
    assert.equal(await unusedName(folder), path.join(folder, 'Untitled 3.ly'))
  })

  test('createFromTemplate writes the template, replacing a file the dialog confirmed', async () => {
    const file = await touch('new/piece.ly', 'old')
    await createFromTemplate(file, 'piano')
    assert.equal(await readScore(file), TEMPLATES.find((t) => t.id === 'piano')?.text)
    await assert.rejects(createFromTemplate(file, 'nope' as never), /Unknown template/)
  })

  test('every template compiles without errors or warnings', async (t: TestContext) => {
    const lilypond = await locateLilyPond().catch(() => undefined)
    if (!lilypond) return t.skip('lilypond is not installed')
    const run = promisify(execFile)
    for (const template of TEMPLATES) {
      const file = path.join(scratch, 'templates', `${template.id}.ly`)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await createFromTemplate(file, template.id)
      const { stderr }: { stderr: string } = await run(lilypond.path, ['--loglevel=WARNING', '-dno-point-and-click', '-o', path.dirname(file), file])
      assert.equal(stderr.trim(), '', `${template.id}: ${stderr}`)
    }
  })
})
