import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, describe, test, type TestContext } from 'node:test'
import { quiet } from '../../media/preview.js'
import { CompileService, type CompileRequest, type CompileResult } from '../../src/compile/compiler'
import { LilyPondNotFoundError, locateLilyPond } from '../../src/compile/locate'
import { charToCharacter, parseTextEdit } from '../../src/preview/pointAndClick'
import { Access } from '../src/files'
import type { CompileEvent, CompileOutcome } from '../src/ipc'
import { StudioCompiler } from '../src/main/compileService'
import { previewUpdate } from '../src/renderer/preview'

// Runs under `node --test` from out/test/ (npm run test:unit in studio/).

let scratch: string

before(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'lily-studio-preview-')))
})

after(async () => {
  if (scratch) await fs.rm(scratch, { recursive: true, force: true })
})

function outcome(partial: Partial<CompileOutcome>): CompileOutcome {
  return { state: 'ok', rootFile: '/s/score.ly', diagnostics: [], errorCount: 0, warningCount: 0, pages: [], svg: [], midi: [], durationMs: 1, ...partial }
}

describe('previewUpdate', () => {
  const page = ['<svg/>']

  test('the pages of a run are shown, with a note when it had errors', () => {
    assert.deepEqual(previewUpdate(outcome({ svg: page }), false), { show: true })
    assert.deepEqual(previewUpdate(outcome({ state: 'failed', svg: page }), true), {
      show: true,
      note: 'The score has errors, so this may be incomplete.',
    })
  })

  test('a run without pages keeps what is on screen and says why', () => {
    assert.deepEqual(previewUpdate(outcome({ state: 'failed' }), true), {
      show: false,
      note: 'The score has errors. Showing the last version that engraved.',
    })
    assert.deepEqual(previewUpdate(outcome({ state: 'failed' }), false), {
      show: false,
      note: 'The score has errors. Fix them to see it here.',
    })
    assert.deepEqual(previewUpdate(outcome({}), false), { show: false, note: 'LilyPond produced no pages.' })
    assert.deepEqual(previewUpdate(outcome({ state: 'no-lilypond' }), true), { show: false, note: undefined })
    assert.deepEqual(previewUpdate(outcome({ state: 'no-root' }), true), { show: false })
  })

  test("preview.js's quiet() drops LilyPond's inline styles before parsing", () => {
    const svg = '<svg><style>a{}</style><a style="color:inherit;" xlink:href="textedit:///a.ly:1:2:2"><path d="M0"/></a></svg>'
    assert.equal(quiet(svg), '<svg><a xlink:href="textedit:///a.ly:1:2:2"><path d="M0"/></a></svg>')
  })
})

describe('StudioCompiler: the pages for the preview', () => {
  function studio(pages: string[]) {
    const events: CompileEvent[] = []
    const compiler = new StudioCompiler({
      compiler: {
        compile: async (request: CompileRequest): Promise<CompileResult> => ({
          rootFile: request.rootFile, ok: true, cancelled: false, exitCode: 0, pages, midi: [],
          stdout: '', stderr: '', outputDir: undefined, durationMs: 1,
        }),
        dispose: async () => {},
      },
      candidates: async () => [],
      emit: (event) => events.push(event),
    })
    return { compiler, events }
  }

  test('the SVG text is read before the outcome is sent', async () => {
    const first = path.join(scratch, 'score-1.svg')
    const second = path.join(scratch, 'score-2.svg')
    await fs.writeFile(first, '<svg>1</svg>')
    await fs.writeFile(second, '<svg>2</svg>')
    const { compiler, events } = studio([first, second])
    const result = await compiler.compile(path.join(scratch, 'score.ly'))
    assert.deepEqual(result?.svg, ['<svg>1</svg>', '<svg>2</svg>'])
    assert.deepEqual(events.at(-1), { kind: 'finished', outcome: result })
  })

  test('pages that are gone already leave none', async () => {
    const { compiler } = studio([path.join(scratch, 'gone.svg')])
    const result = await compiler.compile(path.join(scratch, 'score.ly'))
    assert.equal(result?.state, 'ok')
    assert.deepEqual(result?.svg, [])
  })
})

async function lilypondOrSkip(t: TestContext): Promise<boolean> {
  try {
    await locateLilyPond({ configuredPath: process.env.LILYPOND_PATH })
    return true
  } catch (error) {
    if (!(error instanceof LilyPondNotFoundError)) throw error
    t.skip('lilypond is not installed')
    return false
  }
}

describe('click-to-source with lilypond', () => {
  test("a note's link leads to its place in the included file", async (t) => {
    if (!(await lilypondOrSkip(t))) return
    const include = path.join(scratch, 'parts', 'tune.ily')
    await fs.mkdir(path.dirname(include), { recursive: true })
    // A tab and an astral character before the note: CHAR counts code points.
    await fs.writeFile(include, 'tune = {\n\t%{𝄞%} fis\'4 g\n}\n')
    const score = path.join(scratch, 'song.ly')
    await fs.writeFile(score, '\\version "2.24.0"\n\\include "parts/tune.ily"\n{ \\tune }\n')

    const service = new CompileService()
    const compiler = new StudioCompiler({
      compiler: service,
      candidates: async () => [],
      emit: () => {},
      lilypondPath: process.env.LILYPOND_PATH,
    })
    try {
      const result = await compiler.compile(score)
      assert.equal(result?.state, 'ok', result?.message)
      const hrefs = [...result!.svg.join('\n').matchAll(/href="(textedit:[^"]*)"/g)].map(([, href]) => href)
      assert.ok(hrefs.length > 0, 'the pages carry point-and-click links')

      // As the main process answers a click: parsed, then checked against the open folder.
      const access = new Access()
      access.folder = scratch
      const locations = hrefs.map((href) => parseTextEdit(href)!).map((l) => ({ ...l, file: access.check(l.file) }))
      const line = '\t%{𝄞%} fis\'4 g'
      const fis = locations.find((l) => l.file === include && l.line === 2 && line.slice(charToCharacter(line, l.char)).startsWith('fis'))
      assert.ok(fis, `a link to fis in ${JSON.stringify(locations)}`)

      // A file outside the open folder is refused.
      access.folder = path.join(scratch, 'elsewhere')
      assert.throws(() => access.check(include), /outside the open folder/)
    } finally {
      await compiler.dispose()
    }
  })
})
