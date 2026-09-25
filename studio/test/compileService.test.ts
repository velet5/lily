import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, test, type TestContext } from 'node:test'
import { CompileService, type CompileRequest, type CompileResult } from '../../src/compile/compiler'
import { LilyPondNotFoundError, locateLilyPond } from '../../src/compile/locate'
import type { CompileEvent } from '../src/ipc'
import { StudioCompiler, type Compiler } from '../src/main/compileService'

// Runs under `node --test` from out/test/ (npm run test:unit in studio/).

let scratch: string

before(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lily-studio-compile-')))
  await write('solo.ly', '\\version "2.24.0"\n{ c4 }\n')
  await write('song.ly', '\\version "2.24.0"\n\\include "parts/melody.ily"\n{ \\melody }\n')
  await write('parts/melody.ily', 'melody = { g1 }\n')
  await write('parts/unused.ily', 'unused = { a1 }\n')
})

after(async () => {
  if (scratch) await fs.rm(scratch, { recursive: true, force: true })
})

async function write(relative: string, text: string): Promise<string> {
  const file = path.join(scratch, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text)
  return file
}

const at = (relative: string) => path.join(scratch, relative)

function result(request: CompileRequest, partial: Partial<CompileResult> = {}): CompileResult {
  return {
    rootFile: request.rootFile,
    ok: true,
    cancelled: false,
    exitCode: 0,
    pages: [],
    midi: [],
    stdout: '',
    stderr: '',
    outputDir: undefined,
    durationMs: 5,
    ...partial,
  }
}

/** A CompileService stand-in that answers each request with `answer`. */
function setup(answer: (request: CompileRequest) => Partial<CompileResult> | Error = () => ({})) {
  const requests: CompileRequest[] = []
  const events: CompileEvent[] = []
  const compiler: Compiler = {
    compile: async (request) => {
      requests.push(request)
      const partial = answer(request)
      if (partial instanceof Error) throw partial
      return result(request, partial)
    },
    export: () => Promise.reject(new Error('no export here')),
    dispose: async () => {},
  }
  const studio = new StudioCompiler({
    compiler,
    candidates: async () => ['solo.ly', 'song.ly', 'parts/melody.ily', 'parts/unused.ily'].map(at),
    emit: (event) => events.push(event),
  })
  return { studio, requests, events }
}

describe('StudioCompiler', () => {
  test('a saved .ly file compiles itself and reports parsed diagnostics', async () => {
    const song = at('song.ly')
    const { studio, requests, events } = setup(() => ({
      ok: false,
      exitCode: 1,
      stderr: `${song}:3:4: error: unknown command: \`\\melodyy'\n{ \\melodyy }\n   \n` +
        `parts/melody.ily:1:10: warning: bar check failed\n` +
        `fatal error: failed files: "${song}"\n`,
    }))
    const outcome = await studio.saved(song)
    assert.deepEqual(requests.map((r) => r.rootFile), [song])
    assert.equal(requests[0].acceleration, 'off')
    assert.equal(outcome?.state, 'failed')
    assert.equal(outcome?.errorCount, 1)
    assert.equal(outcome?.warningCount, 1)
    // Relative paths are resolved against the score's directory; the summary line is dropped.
    assert.deepEqual(outcome?.diagnostics.map((d) => [d.file, d.line, d.column, d.severity]), [
      [song, 3, 4, 'error'],
      [at('parts/melody.ily'), 1, 10, 'warning'],
    ])
    assert.equal(outcome?.message, undefined)
    assert.deepEqual(events, [{ kind: 'started', rootFile: song }, { kind: 'finished', outcome }])
  })

  test('a saved include compiles the score that includes it', async () => {
    const { studio, requests, events } = setup()
    const outcome = await studio.saved(at('parts/melody.ily'))
    assert.deepEqual(requests.map((r) => r.rootFile), [at('song.ly')])
    assert.equal(outcome?.state, 'ok')
    assert.equal(events.length, 2)
  })

  test('the score compiled last is preferred for a shared include', async () => {
    await write('other.ly', '\\version "2.24.0"\n\\include "parts/melody.ily"\n{ \\melody }\n')
    const { studio, requests } = setup()
    await studio.saved(at('other.ly'))
    await studio.saved(at('parts/melody.ily'))
    assert.deepEqual(requests.map((r) => r.rootFile), [at('other.ly'), at('other.ly')])
    await fs.rm(at('other.ly'))
  })

  test('an include that no score reaches compiles nothing', async () => {
    const { studio, requests, events } = setup()
    const outcome = await studio.saved(at('parts/unused.ily'))
    assert.equal(requests.length, 0)
    assert.equal(outcome?.state, 'no-root')
    assert.equal(outcome?.rootFile, at('parts/unused.ily'))
    assert.deepEqual(events, [{ kind: 'finished', outcome }])
  })

  test('a superseded compile reports nothing', async () => {
    const { studio, events } = setup(() => ({ cancelled: true }))
    assert.equal(await studio.saved(at('solo.ly')), undefined)
    assert.deepEqual(events.map((e) => e.kind), ['started'])
  })

  test('a missing lilypond and a failed start are told apart', async () => {
    const missing = setup(() => new LilyPondNotFoundError('LilyPond was not found.'))
    const outcome = await missing.studio.saved(at('solo.ly'))
    assert.equal(outcome?.state, 'no-lilypond')
    assert.equal(outcome?.message, 'LilyPond was not found.')

    const broken = setup(() => new Error('spawn EACCES'))
    assert.equal((await broken.studio.saved(at('solo.ly')))?.state, 'error')
  })

  test('a failure without a parsable error keeps the end of stderr', async () => {
    const { studio } = setup(() => ({ ok: false, exitCode: 1, stderr: 'Backtrace:\nIn procedure car: Wrong type\n' }))
    const outcome = await studio.saved(at('solo.ly'))
    assert.equal(outcome?.state, 'failed')
    assert.equal(outcome?.message, 'Backtrace:\nIn procedure car: Wrong type')
  })
})

describe('StudioCompiler with lilypond', () => {
  const service = new CompileService()
  after(() => service.dispose())

  async function lilypond(t: TestContext): Promise<boolean> {
    try {
      await locateLilyPond()
      return true
    } catch {
      t.skip('lilypond is not installed')
      return false
    }
  }

  test('a score with a mistake yields its error in the included file', async (t) => {
    if (!(await lilypond(t))) return
    const melody = await write('real/parts/tune.ily', 'tune = { c4 d \\stacato e f }\n')
    await write('real/score.ly', '\\version "2.24.0"\n\\include "parts/tune.ily"\n{ \\tune }\n')
    const events: CompileEvent[] = []
    const studio = new StudioCompiler({
      compiler: service,
      candidates: async () => [at('real/score.ly'), melody],
      emit: (event) => events.push(event),
    })
    const outcome = await studio.saved(melody)
    assert.equal(outcome?.state, 'failed')
    const first = outcome?.diagnostics[0]
    assert.equal(first?.file, melody)
    assert.equal(first?.line, 1)
    assert.equal(first?.severity, 'error')
    assert.match(first?.message ?? '', /stacato/)

    await write('real/parts/tune.ily', 'tune = { c4 d e f }\n')
    const fixed = await studio.saved(melody)
    assert.equal(fixed?.state, 'ok')
    assert.equal(fixed?.errorCount, 0)
    assert.ok(fixed && fixed.pages.length > 0)
  })
})
