import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { CompileService } from '../../src/compile/compiler'
import { LilyPondNotFoundError, locateLilyPond } from '../../src/compile/locate'
import { StudioCompiler } from '../src/main/compileService'
import {
  choicePath,
  compareVersions,
  detectLilyPond,
  parseVersion,
  readSettings,
  searchPath,
  writeSettings,
} from '../src/main/lilypondSetup'
import { SAMPLE } from '../src/templates'

// Runs under `node --test` from out/test/ (npm run test:unit in studio/).

let scratch: string
/** A directory with an executable `lilypond` that only has to exist; `version` answers for it. */
let bin: string

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'lily-studio-setup-'))
  bin = path.join(scratch, 'LilyPond', 'bin')
  await fs.mkdir(bin, { recursive: true })
  await fs.writeFile(path.join(bin, 'lilypond'), '#!/bin/sh\n', { mode: 0o755 })
})

after(() => fs.rm(scratch, { recursive: true, force: true }))

const nowhere = { env: { PATH: '' }, wellKnownDirs: [] }
const answers = (output: string) => async () => output

describe('detectLilyPond', () => {
  test('ready when found and new enough', async () => {
    const status = await detectLilyPond({ ...nowhere, wellKnownDirs: [bin], version: answers('GNU LilyPond 2.26.0 (running Guile 3.0)\n') })
    assert.deepEqual(
      { state: status.state, version: status.version, path: status.path, source: status.source },
      { state: 'ready', version: '2.26.0', path: path.join(bin, 'lilypond'), source: 'well-known' },
    )
    assert.equal(status.message, 'LilyPond 2.26.0 is ready.')
  })

  test('missing, in plain words', async () => {
    const status = await detectLilyPond(nowhere)
    assert.equal(status.state, 'missing')
    assert.match(status.message, /not installed on this Mac/)
    assert.equal(status.path, undefined)
  })

  test('a chosen path that went away is named', async () => {
    const status = await detectLilyPond({ ...nowhere, configuredPath: path.join(scratch, 'gone') })
    assert.equal(status.state, 'missing')
    assert.equal(status.chosen, path.join(scratch, 'gone'))
    assert.match(status.message, /could not be found any more/)
  })

  test('a chosen install folder is looked into', async () => {
    const status = await detectLilyPond({ ...nowhere, configuredPath: path.dirname(bin), version: answers('GNU LilyPond 2.24.4\n') })
    assert.deepEqual([status.state, status.source, status.version], ['ready', 'setting', '2.24.4'])
  })

  test('too old, broken, or not LilyPond', async () => {
    const found = { ...nowhere, wellKnownDirs: [bin] }
    const old = await detectLilyPond({ ...found, version: answers('GNU LilyPond 2.22.2\n') })
    assert.deepEqual([old.state, old.version], ['too-old', '2.22.2'])
    assert.match(old.message, /needs 2\.24\.0 or newer/)
    const broken = await detectLilyPond({ ...found, version: () => Promise.reject(new Error('killed')) })
    assert.equal(broken.state, 'broken')
    assert.equal((await detectLilyPond({ ...found, version: answers('hello\n') })).state, 'broken')
  })

  test('the real lilypond, when installed', async (t) => {
    const status = await detectLilyPond({ configuredPath: process.env.LILYPOND_PATH })
    if (status.state === 'missing') return t.skip('lilypond is not installed')
    assert.equal(status.state, 'ready', status.message)
    assert.match(status.version ?? '', /^2\.\d+/)
  })
})

describe('setup helpers', () => {
  test('versions', () => {
    assert.equal(parseVersion('GNU LilyPond 2.24.4 (running Guile 2.2)'), '2.24.4')
    assert.equal(parseVersion('lilypond 2.25'), '2.25')
    assert.equal(parseVersion('Usage: foo'), undefined)
    assert.ok(compareVersions('2.24.0', '2.24') === 0)
    assert.ok(compareVersions('2.23.99', '2.24.0') < 0)
    assert.ok(compareVersions('2.100.0', '2.24.0') > 0)
  })

  test('an app bundle is looked into', () => {
    assert.equal(choicePath('/Applications/LilyPond.app'), '/Applications/LilyPond.app/Contents/Resources/bin')
    assert.equal(choicePath('/Applications/lilypond-2.24.4'), '/Applications/lilypond-2.24.4')
  })

  test('the search path keeps order, adds the binary first, drops repeats', () => {
    const joined = searchPath(['/usr/bin', '/bin', '/usr/bin'].join(path.delimiter), '/x/bin').split(path.delimiter)
    assert.deepEqual(joined.slice(0, 3), ['/x/bin', '/usr/bin', '/bin'])
    assert.equal(new Set(joined).size, joined.length)
    if (process.platform === 'darwin') assert.ok(joined.includes('/opt/homebrew/bin'))
  })

  test('settings survive a round trip, and a damaged file reads as none', async () => {
    const file = path.join(scratch, 'user', 'settings.json')
    assert.deepEqual(await readSettings(file), {})
    await writeSettings(file, { lilypondPath: '/opt/lily/bin' })
    assert.deepEqual(await readSettings(file), { lilypondPath: '/opt/lily/bin' })
    await fs.writeFile(file, '{ nope')
    assert.deepEqual(await readSettings(file), {})
    await fs.writeFile(file, '{ "lilypondPath": 3 }')
    assert.deepEqual(await readSettings(file), {})
  })
})

describe('the sample score', () => {
  test('engraves without a warning, with music to play', async (t) => {
    try {
      await locateLilyPond({ configuredPath: process.env.LILYPOND_PATH })
    } catch (error) {
      if (!(error instanceof LilyPondNotFoundError)) throw error
      return t.skip('lilypond is not installed')
    }
    const score = path.join(scratch, SAMPLE.name)
    await fs.writeFile(score, SAMPLE.text)
    const service = new CompileService()
    const compiler = new StudioCompiler({ compiler: service, candidates: async () => [], emit: () => {}, lilypondPath: () => process.env.LILYPOND_PATH })
    try {
      const outcome = await compiler.compile(score)
      assert.equal(outcome?.state, 'ok', outcome?.message)
      assert.deepEqual(outcome.diagnostics, [])
      assert.ok(outcome.svg.length > 0 && outcome.midiData, 'pages and MIDI')
    } finally {
      await compiler.dispose()
    }
  })
})
