import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, test, type TestContext } from 'node:test'
import { CompileService, type CompileRequest, type CompileResult } from '../../src/compile/compiler'
import { locateLilyPond } from '../../src/compile/locate'
import type { SourceBuffers } from '../../src/compile/snapshot'
import type { CompileEvent } from '../src/ipc'
import { StudioCompiler, type Compiler } from '../src/main/compileService'
import { LiveCompile } from '../src/main/liveCompile'

// Runs under `node --test` from out/test/ (npm run test:unit in studio/).

let scratch: string

before(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lily-studio-live-')))
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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A StudioCompiler stand-in: which scores were compiled, with the buffers of the moment. */
function standIn(roots: Record<string, string | undefined> = {}) {
  const compiled: { root: string; buffers: SourceBuffers }[] = []
  let current: string | undefined
  const compiler = {
    get current() {
      return current
    },
    rootFor: async (file: string) => (file in roots ? roots[file] : file),
    compile: async (root: string) => {
      current = root
      compiled.push({ root, buffers: live.buffers() })
      return undefined
    },
  }
  const live = new LiveCompile({ compiler, delayMs: 30, maxWaitMs: 90 })
  return { live, compiled }
}

describe('LiveCompile', () => {
  test('a burst of edits compiles its score once, with the unsaved texts', async () => {
    const { live, compiled } = standIn()
    live.edited('/s/score.ly', '{ c }')
    live.edited('/s/score.ly', '{ c d }')
    live.edited('/s/score.ly', '{ c d e }')
    await wait(10)
    assert.equal(compiled.length, 0)
    await wait(60)
    assert.deepEqual(compiled.map((c) => c.root), ['/s/score.ly'])
    assert.deepEqual([...compiled[0].buffers], [['/s/score.ly', '{ c d e }']])
    live.dispose()
  })

  test('typing without a pause still compiles within the longest wait', async () => {
    const { live, compiled } = standIn()
    for (let i = 0; i < 12; i++) {
      live.edited('/s/score.ly', `{ c${i} }`)
      await wait(15)
    }
    // 180 ms of typing, never 30 ms quiet: the 90 ms deadline compiled at least once.
    assert.ok(compiled.length >= 1, `compiled ${compiled.length} times`)
    live.dispose()
  })

  test('an edited include compiles the score it belongs to; one no score reaches, nothing', async () => {
    const { live, compiled } = standIn({ '/s/parts/a.ily': '/s/score.ly', '/s/parts/b.ily': undefined })
    live.edited('/s/parts/a.ily', 'a = { c }')
    live.edited('/s/score.ly', '\\include "parts/a.ily"')
    live.edited('/s/parts/b.ily', 'b = { d }')
    await wait(60)
    assert.deepEqual(compiled.map((c) => c.root), ['/s/score.ly'])
    assert.equal(compiled[0].buffers.size, 3)
    live.dispose()
  })

  test('a save or reload drops the file’s text and what was waiting for it', async () => {
    const { live, compiled } = standIn()
    live.edited('/s/score.ly', '{ c d }')
    live.edited('/s/score.ly', undefined)
    await wait(60)
    assert.equal(compiled.length, 0)
    assert.equal(live.buffers().size, 0)
  })

  test('off: edits wait, compiles read the disk; on again: they compile', async () => {
    const { live, compiled } = standIn()
    live.setEnabled(false)
    live.edited('/s/score.ly', '{ c d }')
    await wait(60)
    assert.equal(compiled.length, 0)
    assert.equal(live.buffers().size, 0)

    live.setEnabled(true)
    await wait(10)
    assert.deepEqual(compiled.map((c) => [c.root, c.buffers.size]), [['/s/score.ly', 1]])

    // Off again: the score shown compiles from disk, and what was waiting is dropped.
    live.edited('/s/score.ly', '{ c d e }')
    live.setEnabled(false)
    await wait(60)
    assert.deepEqual(compiled.map((c) => [c.root, c.buffers.size]), [['/s/score.ly', 1], ['/s/score.ly', 0]])
    live.dispose()
  })
})

describe('StudioCompiler with live buffers', () => {
  test('compiles wait for the running one; a newer request replaces the waiting one', async () => {
    const requests: CompileRequest[] = []
    const releases: (() => void)[] = []
    const compiler: Compiler = {
      compile: (request) => {
        requests.push(request)
        return new Promise<CompileResult>((resolve) => releases.push(() => resolve({
          rootFile: request.rootFile, ok: true, cancelled: false, exitCode: 0, pages: [], midi: [],
          stdout: '', stderr: '', outputDir: undefined, durationMs: 1,
        })))
      },
      export: () => Promise.reject(new Error('no export here')),
      dispose: async () => {},
    }
    let text = '{ c }'
    const events: CompileEvent[] = []
    const studio = new StudioCompiler({
      compiler,
      candidates: async () => [],
      emit: (event) => events.push(event),
      buffers: () => new Map([['/s/score.ly', text]]),
      acceleration: 'auto',
    })
    const first = studio.compile('/s/score.ly')
    await wait(0)
    text = '{ c d }'
    const replaced = studio.compile('/s/score.ly')
    text = '{ c d e }'
    const second = studio.compile('/s/score.ly')
    await wait(0)
    assert.equal(requests.length, 1, 'nothing more starts while one runs')
    releases[0]()
    assert.equal((await first)?.state, 'ok')
    await wait(0)
    assert.equal(requests.length, 2)
    releases[1]()
    // The waiting request that was replaced resolves with its successor's outcome.
    assert.equal(await replaced, await second)
    assert.deepEqual(requests.map((r) => r.buffers?.get('/s/score.ly')), ['{ c }', '{ c d e }'])
    assert.deepEqual(requests.map((r) => r.acceleration), ['auto', 'auto'])
    assert.deepEqual(events.map((e) => e.kind), ['started', 'finished', 'started', 'finished'])
  })
})

describe('Live compile with lilypond', () => {
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

  test('unsaved texts engrave, and their errors and links name the real files', async (t) => {
    if (!(await lilypond(t))) return
    const score = await write('real/score.ly', '\\version "2.24.0"\n\\include "parts/tune.ily"\n{ \\tune }\n')
    const tune = await write('real/parts/tune.ily', 'tune = { c4 d e f }\n')
    let buffers: SourceBuffers = new Map([[tune, 'tune = { c4 d \\stacato e f }\n']])
    const studio = new StudioCompiler({ compiler: service, candidates: async () => [score], emit: () => {}, buffers: () => buffers })

    const failed = await studio.compile(score)
    assert.equal(failed?.state, 'failed')
    const first = failed?.diagnostics[0]
    assert.equal(first?.file, tune)
    assert.equal(first?.line, 1)
    assert.match(first?.message ?? '', /stacato/)

    // The unsaved score adds a note; the page links to the real score, not the snapshot.
    buffers = new Map([[score, '\\version "2.24.0"\n\\include "parts/tune.ily"\n{ \\tune g4 }\n']])
    const fixed = await studio.compile(score)
    assert.equal(fixed?.state, 'ok')
    const svg = fixed?.svg.join('') ?? ''
    assert.ok(svg.includes(`textedit://${score}:3:`), 'a link to the unsaved note in score.ly')
    assert.ok(svg.includes(`textedit://${tune}:1:`), 'links to the include on disk')
    assert.ok(!svg.includes('/sources/'), 'no link to the snapshot')
    // The disk was never written.
    assert.equal(await fs.readFile(tune, 'utf8'), 'tune = { c4 d e f }\n')
  })
})
