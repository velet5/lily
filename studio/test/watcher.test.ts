import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, afterEach, before, describe, test } from 'node:test'
import { ScoreWatcher, type FileChange } from '../src/main/watcher'

// Runs under `node --test` from out/test/ (npm run test:unit in studio/),
// against the real file system and its change events.

let scratch: string
let count = 0

before(async () => {
  // realpath: os.tmpdir() is a symlink on macOS and the include graph is canonical.
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lily-studio-watch-')))
})

after(async () => {
  if (scratch) await fs.rm(scratch, { recursive: true, force: true })
})

interface Report {
  changes: FileChange[]
  score: boolean
}

/** A watcher on a fresh directory, with its reports queued for `next`. */
async function setUp(files: Record<string, string>) {
  const dir = path.join(scratch, `case-${++count}`)
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true })
    await fs.writeFile(path.join(dir, name), text)
  }
  const reports: Report[] = []
  let wake: (() => void) | undefined
  const watcher = new ScoreWatcher({
    delayMs: 50,
    onChange: (changes, score) => {
      reports.push({ changes, score })
      wake?.()
    },
  })
  watchers.push(watcher)
  // fs.watch on macOS can report events from just before the watch started.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150))
  return {
    at: (name: string) => path.join(dir, name),
    watcher,
    reports,
    settle,
    /** The next report, or undefined when none comes within `ms`. */
    async next(ms = 3000): Promise<Report | undefined> {
      if (reports.length === 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms)
          wake = () => {
            clearTimeout(timer)
            resolve()
          }
        })
        wake = undefined
      }
      return reports.shift()
    },
  }
}

const watchers: ScoreWatcher[] = []
afterEach(() => {
  for (const watcher of watchers.splice(0)) watcher.dispose()
})

const SCORE = '\\version "2.24.0"\n\\include "parts/melody.ily"\n{ \\melody }\n'

describe('ScoreWatcher', () => {
  test('reports a change to an open file under the path the editor used', async () => {
    const t = await setUp({ 'solo.ly': '{ c }\n' })
    await t.watcher.open(t.at('solo.ly'), '{ c }\n')
    await t.settle()
    t.reports.length = 0
    await fs.writeFile(t.at('solo.ly'), '{ d }\n')
    assert.deepEqual(await t.next(), { changes: [{ file: t.at('solo.ly'), exists: true }], score: false })
  })

  test('does not report the studio’s own save, or a write of the same text', async () => {
    const t = await setUp({ 'solo.ly': '{ c }\n' })
    await t.watcher.open(t.at('solo.ly'), '{ c }\n')
    await t.settle()
    t.reports.length = 0
    await t.watcher.writing(t.at('solo.ly'), '{ e }\n')
    await fs.writeFile(t.at('solo.ly'), '{ e }\n')
    await fs.writeFile(t.at('solo.ly'), '{ e }\n')
    assert.equal(await t.next(500), undefined)
  })

  test('reports a burst of writes once, when it settles', async () => {
    const t = await setUp({ 'solo.ly': '{ c }\n' })
    await t.watcher.open(t.at('solo.ly'), '{ c }\n')
    await t.settle()
    t.reports.length = 0
    for (const note of ['d', 'e', 'f']) await fs.writeFile(t.at('solo.ly'), `{ ${note} }\n`)
    assert.deepEqual((await t.next())?.changes, [{ file: t.at('solo.ly'), exists: true }])
    assert.equal(await t.next(300), undefined)
  })

  test('an include of the watched score changing asks for a compile', async () => {
    const t = await setUp({ 'song.ly': SCORE, 'parts/melody.ily': 'melody = { c1 }\n' })
    await t.watcher.watchScore(t.at('song.ly'))
    assert.equal(t.watcher.score, t.at('song.ly'))
    await t.settle()
    t.reports.length = 0
    await fs.writeFile(t.at('parts/melody.ily'), 'melody = { d1 }\n')
    assert.deepEqual(await t.next(), { changes: [{ file: t.at('parts/melody.ily'), exists: true }], score: true })
  })

  test('an editor that saves by renaming over the file is still seen, twice', async () => {
    const t = await setUp({ 'song.ly': SCORE, 'parts/melody.ily': 'melody = { c1 }\n' })
    await t.watcher.watchScore(t.at('song.ly'))
    await t.settle()
    t.reports.length = 0
    for (const note of ['d', 'e']) {
      await fs.writeFile(t.at('parts/.melody.tmp'), `melody = { ${note}1 }\n`)
      await fs.rename(t.at('parts/.melody.tmp'), t.at('parts/melody.ily'))
      assert.equal((await t.next())?.score, true, `after saving ${note}`)
    }
  })

  test('a missing include that appears asks for a compile; a deleted one too', async () => {
    const t = await setUp({ 'song.ly': SCORE, 'parts/other.ily': '' })
    await t.watcher.watchScore(t.at('song.ly'))
    await t.settle()
    t.reports.length = 0
    await fs.writeFile(t.at('parts/melody.ily'), 'melody = { c1 }\n')
    assert.deepEqual(await t.next(), { changes: [{ file: t.at('parts/melody.ily'), exists: true }], score: true })
    await fs.rm(t.at('parts/melody.ily'))
    assert.deepEqual(await t.next(), { changes: [{ file: t.at('parts/melody.ily'), exists: false }], score: true })
  })

  test('another score replaces the first; files open in the editor stay watched', async () => {
    const t = await setUp({ 'song.ly': SCORE, 'parts/melody.ily': 'melody = { c1 }\n', 'solo.ly': '{ c }\n' })
    await t.watcher.open(t.at('song.ly'), SCORE)
    await t.watcher.watchScore(t.at('song.ly'))
    await t.watcher.watchScore(t.at('solo.ly'))
    await t.settle()
    t.reports.length = 0
    await fs.writeFile(t.at('parts/melody.ily'), 'melody = { d1 }\n')
    assert.equal(await t.next(500), undefined)
    await fs.writeFile(t.at('song.ly'), `${SCORE}% edited\n`)
    assert.deepEqual(await t.next(), { changes: [{ file: t.at('song.ly'), exists: true }], score: false })
    await fs.writeFile(t.at('solo.ly'), '{ d }\n')
    assert.deepEqual(await t.next(), { changes: [{ file: t.at('solo.ly'), exists: true }], score: true })
  })

  test('says nothing after dispose', async () => {
    const t = await setUp({ 'solo.ly': '{ c }\n' })
    await t.watcher.open(t.at('solo.ly'), '{ c }\n')
    await t.settle()
    t.reports.length = 0
    t.watcher.dispose()
    await fs.writeFile(t.at('solo.ly'), '{ d }\n')
    assert.equal(await t.next(300), undefined)
  })
})
