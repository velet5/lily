import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, test, type TestContext } from 'node:test'
import { CompileService, type CompileResult, type ExportRequest, type ExportResult } from '../../src/compile/compiler'
import { LilyPondNotFoundError, locateLilyPond } from '../../src/compile/locate'
import { StudioCompiler, type Compiler } from '../src/main/compileService'

// The PDF tab's compile and Export PDF (DECISIONS D33). Runs under `node --test`
// from out/test/ (npm run test:unit in studio/).

let scratch: string

before(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lily-studio-pdf-test-')))
  await fs.mkdir(path.join(scratch, 'tmp'))
})

after(async () => {
  if (scratch) await fs.rm(scratch, { recursive: true, force: true })
})

/** A fresh folder with `score.ly` in it, and what is in the folder. */
async function folder(name: string, text = '\\version "2.24.0"\n{ c4 }\n') {
  const dir = path.join(scratch, name)
  await fs.mkdir(dir, { recursive: true })
  const score = path.join(dir, 'score.ly')
  await fs.writeFile(score, text)
  return { score, listing: async () => (await fs.readdir(dir)).sort() }
}

/** A CompileService stand-in whose PDF export writes `score.pdf` holding `bytes`, as lilypond would. */
function setup(answer: (request: ExportRequest) => { bytes?: string; partial?: Partial<CompileResult> } | Error = () => ({ bytes: '%PDF-1' })) {
  const exports: ExportRequest[] = []
  const compiles: string[] = []
  const compiler: Compiler = {
    compile: async (request) => {
      compiles.push(request.rootFile)
      return { rootFile: request.rootFile, ok: true, cancelled: false, exitCode: 0, pages: [], midi: [], stdout: '', stderr: '', outputDir: undefined, durationMs: 1 }
    },
    export: async (request): Promise<ExportResult> => {
      exports.push(request)
      const reply = answer(request)
      if (reply instanceof Error) throw reply
      const exported: string[] = []
      if (reply.bytes !== undefined) {
        const file = path.join(request.targetDir!, `${path.basename(request.rootFile, '.ly')}.pdf`)
        await fs.writeFile(file, reply.bytes)
        exported.push(file)
      }
      return {
        rootFile: request.rootFile, ok: true, cancelled: false, exitCode: 0, pages: [], midi: [],
        stdout: '', stderr: '', outputDir: undefined, durationMs: 3, exported, ...reply.partial,
      }
    },
    dispose: async () => {},
  }
  const tmpRoot = path.join(scratch, 'tmp')
  const studio = new StudioCompiler({ compiler, candidates: async () => [], emit: () => {}, tmpRoot })
  return { studio, exports, compiles, tmpRoot }
}

const text = (data: Uint8Array | undefined) => Buffer.from(data ?? []).toString()

describe('StudioCompiler: the PDF tab', () => {
  test('a PDF is compiled into a private directory that is gone afterwards', async () => {
    const { score, listing } = await folder('private')
    const { studio, exports, tmpRoot } = setup()
    const outcome = await studio.pdf(score)
    assert.equal(outcome?.state, 'ok')
    assert.deepEqual(outcome?.files.map((f) => [f.name, text(f.data)]), [['score.pdf', '%PDF-1']])
    assert.equal(exports[0].format, 'pdf')
    assert.equal(exports[0].acceleration, 'off')
    assert.notEqual(path.dirname(exports[0].targetDir!), path.dirname(score))
    assert.deepEqual(await fs.readdir(tmpRoot), [])
    // Nothing next to the score until Export PDF is asked for.
    assert.deepEqual(await listing(), ['score.ly'])
  })

  test('the PDF is kept until the score compiles again', async () => {
    const { score } = await folder('kept')
    let version = 0
    const { studio, exports } = setup(() => ({ bytes: `%PDF-${++version}` }))
    const first = await studio.pdf(score)
    assert.equal(await studio.pdf(score), first)
    assert.equal(exports.length, 1)
    await studio.compile(score)
    assert.equal(text((await studio.pdf(score))?.files[0].data), '%PDF-2')
    assert.equal(exports.length, 2)
  })

  test('a PDF with errors shows what was written but is not kept', async () => {
    const { score } = await folder('failed')
    const { studio, exports } = setup(() => ({
      bytes: '%PDF-partial',
      partial: { ok: false, exitCode: 1, stderr: `${score}:2:3: error: unknown command: \`\\stacato'\n` },
    }))
    const outcome = await studio.pdf(score)
    assert.equal(outcome?.state, 'failed')
    assert.equal(outcome?.errorCount, 1)
    assert.equal(outcome?.files.length, 1)
    await studio.pdf(score)
    assert.equal(exports.length, 2)
  })

  test('lilypond that cannot run is reported, not thrown', async () => {
    const { score } = await folder('missing')
    const { studio } = setup(() => new LilyPondNotFoundError('LilyPond was not found.'))
    const outcome = await studio.pdf(score)
    assert.equal(outcome?.state, 'no-lilypond')
    assert.equal(outcome?.message, 'LilyPond was not found.')
    assert.deepEqual(outcome?.files, [])
  })

  test('a superseded PDF compile resolves undefined', async () => {
    const { score } = await folder('cancelled')
    const { studio } = setup(() => ({ partial: { cancelled: true } }))
    assert.equal(await studio.pdf(score), undefined)
  })
})

describe('StudioCompiler: Export PDF', () => {
  test('writes the PDF on screen next to the score without compiling again', async () => {
    const { score, listing } = await folder('export')
    const { studio, exports } = setup()
    await studio.pdf(score)
    assert.deepEqual(await studio.exportPdf(score), [path.join(path.dirname(score), 'score.pdf')])
    assert.equal(exports.length, 1)
    assert.deepEqual(await listing(), ['score.ly', 'score.pdf'])
    assert.equal(await fs.readFile(path.join(path.dirname(score), 'score.pdf'), 'utf8'), '%PDF-1')
  })

  test('compiles first when the score changed since, and replaces the old file', async () => {
    const { score } = await folder('export-again')
    let version = 0
    const { studio, exports } = setup(() => ({ bytes: `%PDF-${++version}` }))
    await studio.exportPdf(score)
    await studio.compile(score)
    await studio.exportPdf(score)
    assert.equal(exports.length, 2)
    assert.equal(await fs.readFile(path.join(path.dirname(score), 'score.pdf'), 'utf8'), '%PDF-2')
  })

  test('refuses a score with errors and writes nothing', async () => {
    const { score, listing } = await folder('export-failed')
    const { studio } = setup(() => ({ bytes: '%PDF-partial', partial: { ok: false, exitCode: 1, stderr: `${score}:2:3: error: oops\n` } }))
    await assert.rejects(studio.exportPdf(score), /has errors/)
    assert.deepEqual(await listing(), ['score.ly'])
  })
})

describe('StudioCompiler: PDF with lilypond', () => {
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

  test('a real score gives a PDF on screen, and one next to it only when exported', async (t) => {
    if (!(await lilypond(t))) return
    const { score, listing } = await folder('real')
    const studio = new StudioCompiler({ compiler: service, candidates: async () => [], emit: () => {} })
    const outcome = await studio.pdf(score)
    assert.equal(outcome?.state, 'ok', outcome?.message)
    assert.deepEqual(outcome?.files.map((f) => f.name), ['score.pdf'])
    assert.equal(text(outcome?.files[0].data.subarray(0, 5)), '%PDF-')
    assert.deepEqual(await listing(), ['score.ly'])

    await studio.exportPdf(score)
    assert.deepEqual(await listing(), ['score.ly', 'score.pdf'])
    assert.equal((await fs.readFile(path.join(path.dirname(score), 'score.pdf'))).subarray(0, 5).toString(), '%PDF-')
  })
})
