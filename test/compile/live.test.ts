import * as assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { after, before, test } from 'node:test'
import { CompileService } from '../../src/compile/compiler'
import { locateLilyPond } from '../../src/compile/locate'
import { parseStderr } from '../../src/diagnostics/parse'

let scratch: string
let service: CompileService
before(async () => {
  await locateLilyPond() // This suite must not silently skip acceleration coverage.
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'lily-live-'))
  service = new CompileService({ tmpRoot: scratch, runtimeDir: path.resolve('runtime') })
})
after(async () => { await service?.dispose(); if (scratch) await fs.rm(scratch, { recursive: true, force: true }) })

const content = async (files: string[]) => Promise.all(files.map(file => fs.readFile(file)))

for (const fixture of ['simple.ly', 'hello.ly', 'pages.ly', '../e2e/workspace/score.ly']) {
  test(`cache and isolated warm worker preserve SVG, links and MIDI: ${fixture}`, async () => {
    const rootFile = path.resolve('test/fixtures', fixture)
    const plain = await service.compile({ rootFile, acceleration: 'off' })
    assert.equal(plain.ok, true, plain.stderr)
    const reference = await content([...plain.pages, ...plain.midi])
    for (const acceleration of ['cache', 'auto', 'auto'] as const) {
      const fast = await service.compile({ rootFile, acceleration })
      assert.equal(fast.ok, true, fast.stderr)
      assert.equal(fast.stderr, '')
      assert.equal(fast.engine, acceleration === 'auto' ? 'warm' : 'cache', fast.fallback)
      assert.deepEqual(await content([...fast.pages, ...fast.midi]), reference)
    }
  })
}

test('multiple books, sizes, tablature, drums, ligatures and music glyphs in markup match', async () => {
  const rootFile = path.join(scratch, 'varied.ly')
  await fs.writeFile(rootFile, String.raw`\version "2.26.0"
#(set-global-staff-size 18)
\header { title = "office — ffi Áλ" tagline = ##f }
\book {
  \bookOutputSuffix "guitar"
  \markup { \musicglyph "accidentals.sharp" \fontsize #5 \musicglyph "noteheads.s0" }
  \score { << \new Staff \relative c' { c4 d e f } \new TabStaff \relative c' { c4 d e f } >> \layout {} \midi {} }
}
\book {
  \bookOutputSuffix "drums"
  \score { \new DrumStaff \drummode { bd4 sn hh cymc } \layout {} \midi {} }
}
`)
  const baseline = await service.compile({ rootFile, acceleration: 'off' })
  assert.equal(baseline.ok, true, baseline.stderr)
  assert.equal(baseline.stderr, '')
  const expected = await content([...baseline.pages, ...baseline.midi])
  for (const acceleration of ['cache', 'auto', 'auto'] as const) {
    const result = await service.compile({ rootFile, acceleration })
    assert.equal(result.ok, true, result.stderr)
    assert.equal(result.stderr, '')
    assert.equal(result.engine, acceleration === 'auto' ? 'warm' : 'cache', result.fallback)
    assert.deepEqual(await content([...result.pages, ...result.midi]), expected)
  }
})

test('unsaved root and nested/absolute includes map links and diagnostic columns to real sources', async () => {
  const rootFile = path.join(scratch, 'unicode space λ.ly')
  const part = path.join(scratch, 'part.ily')
  const nested = path.join(scratch, 'nested.ily')
  const root = `\\version "2.26.0"\n\\include ${JSON.stringify(part)} { \\music c'4 }\n`
  await fs.writeFile(rootFile, root)
  await fs.writeFile(part, 'music = { d\'4 }\n')
  await fs.writeFile(nested, "music = { e'4 }\n")
  const buffers = new Map([[rootFile, root], [part, '\\include "nested.ily"\n'], [nested, "music = { f'4 }\n"]])
  const result = await service.compile({ rootFile, buffers, acceleration: 'auto' })
  assert.equal(result.ok, true, result.stderr)
  assert.equal(result.stderr, '')
  const svg = await fs.readFile(result.pages[0], 'utf8')
  assert.ok(!svg.includes('/sources/'), 'snapshot paths must not reach the viewer')
  assert.ok(svg.includes(`textedit://${encodeURI(nested)}:1:10:11`), svg.slice(-2000))
  const note = root.split('\n')[1].indexOf("c'4")
  assert.ok(svg.includes(`textedit://${encodeURI(rootFile)}:2:${note}:${note + 1}`))
  assert.equal(await fs.readFile(part, 'utf8'), "music = { d'4 }\n", 'never save editors')
  buffers.set(rootFile, root.replace("c'4", "\\stacato c'4"))
  const bad = await service.compile({ rootFile, buffers, acceleration: 'auto' })
  assert.equal(bad.ok, false)
  const diagnostics = parseStderr(bad.stderr, { rootFile }).map(d => bad.snapshot!.diagnostic(d))
  assert.ok(diagnostics.some(d => d.file === rootFile && d.column === note + 1 && d.message.includes('stacato')), JSON.stringify(diagnostics))
})

test('Scheme mutation cannot leak between forked requests', async () => {
  const rootFile = path.join(scratch, 'isolated.ly')
  await fs.writeFile(rootFile, '\\version "2.26.0"\n#(module-define! (resolve-module \'(lily)) \'preview-test-leak 42)\n{ c1 }\n')
  const first = await service.compile({ rootFile, acceleration: 'auto' })
  assert.equal(first.ok, true, first.stderr)
  assert.equal(first.engine, 'warm', first.fallback)
  await fs.writeFile(rootFile, '\\version "2.26.0"\n#(if (module-defined? (resolve-module \'(lily)) \'preview-test-leak) (ly:error "leaked state"))\n{ c1 }\n')
  const second = await service.compile({ rootFile, acceleration: 'auto' })
  assert.equal(second.ok, true, second.stderr)
  assert.equal(second.engine, 'warm', second.fallback)
})

test('computed includes with dirty buffers fail explicitly; custom options use ordinary spawning', async () => {
  const rootFile = path.join(scratch, 'computed.ly')
  const text = '\\version "2.26.0"\n\\include #(string-append "part" ".ily")\n{ \\music }\n'
  await fs.writeFile(rootFile, text)
  const unavailable = await service.compile({ rootFile, buffers: new Map([[rootFile, text]]) })
  assert.equal(unavailable.ok, false)
  assert.match(unavailable.stderr, /computed/)
  const result = await service.compile({ rootFile, acceleration: 'auto', extraArgs: ['-dno-point-and-click'] })
  assert.equal(result.ok, true, result.stderr)
  assert.equal(result.engine, 'spawn')
})

test('a crashing score falls back and cannot poison later requests', async () => {
  const rootFile = path.join(scratch, 'crash.ly')
  await fs.writeFile(rootFile, '\\version "2.26.0"\n#(primitive-exit 7)\n')
  const crash = await service.compile({ rootFile, acceleration: 'auto' })
  assert.equal(crash.ok, false)
  assert.equal(crash.engine, 'spawn')
  assert.match(crash.fallback!, /Warm compiler failed/)
  await fs.writeFile(rootFile, '\\version "2.26.0"\n{ c1 }\n')
  const recovered = await service.compile({ rootFile, acceleration: 'auto' })
  assert.equal(recovered.ok, true, recovered.stderr)
  assert.equal(recovered.engine, 'cache', 'failed worker configurations stay disabled')
})

test('warm cancellation kills the child and a subsequent request starts cleanly', async () => {
  const rootFile = path.join(scratch, 'cancel.ly')
  await fs.writeFile(rootFile, '\\version "2.26.0"\n{ c1 }\n')
  assert.equal((await service.compile({ rootFile, acceleration: 'auto' })).engine, 'warm')
  await fs.writeFile(rootFile, '\\version "2.26.0"\n#(sleep 30)\n{ c1 }\n')
  const running = service.compile({ rootFile, acceleration: 'auto' })
  const timer = setTimeout(() => service.cancel(rootFile), 100)
  const result = await running
  clearTimeout(timer)
  assert.equal(result.cancelled, true)
  assert.deepEqual(result.pages, [])
  await fs.writeFile(rootFile, '\\version "2.26.0"\n{ d1 }\n')
  const recovered = await service.compile({ rootFile, acceleration: 'auto', extraArgs: ['-I', scratch] })
  assert.equal(recovered.ok, true, recovered.stderr)
  assert.equal(recovered.engine, 'warm', recovered.fallback)
})

test('worker and fallback timeouts are bounded and subsequent compiles recover', async () => {
  const rootFile = path.join(scratch, 'timeout.ly')
  await fs.writeFile(rootFile, '\\version "2.26.0"\n{ c1 }\n')
  await service.compile({ rootFile, acceleration: 'auto' })
  await fs.writeFile(rootFile, '\\version "2.26.0"\n#(sleep 30)\n{ c1 }\n')
  const start = performance.now()
  const result = await service.compile({ rootFile, acceleration: 'auto', timeoutMs: 100 })
  assert.equal(result.ok, false)
  assert.match(result.stderr, /timed out/)
  assert.ok(performance.now() - start < 5000)
  await fs.writeFile(rootFile, '\\version "2.26.0"\n{ c1 }\n')
  const recovered = await service.compile({ rootFile, acceleration: 'auto' })
  assert.equal(recovered.ok, true, recovered.stderr)
})

test('dirty includes reached through a symlink and relative -I retain their search paths', async () => {
  const library = path.join(scratch, 'library')
  await fs.mkdir(library)
  const part = path.join(library, 'notes.ily')
  await fs.writeFile(part, "music = { c'1 }\n")
  const alias = path.join(scratch, 'linked-library')
  await fs.symlink(library, alias, 'dir')
  const rootFile = path.join(scratch, 'search.ly')
  await fs.writeFile(rootFile, '\\version "2.26.0"\n\\include "notes.ily"\n{ \\music }\n')
  const buffers = new Map([[path.join(alias, 'notes.ily'), "music = { d'1 }\n"]])
  const result = await service.compile({ rootFile, buffers, acceleration: 'auto', extraArgs: ['-I', 'library'] })
  assert.equal(result.ok, true, result.stderr)
  assert.equal(result.engine, 'warm', result.fallback)
  assert.equal(result.snapshot?.sources.get(part), "music = { d'1 }\n")
})

test('a score replacing the backend hook retains its override in cached and warm runs', async () => {
  const rootFile = path.join(scratch, 'override.ly')
  await fs.writeFile(rootFile, String.raw`\version "2.26.0"
#(let* ((m (resolve-module '(lily output-svg)))
        (original (module-ref m 'cache-font)))
   (module-set! m 'cache-font
     (lambda (font size glyph)
       (original font size (if (equal? glyph "noteheads.s2") "noteheads.s0" glyph)))))
{ c'4 d' e' f' }
`)
  const plain = await service.compile({ rootFile, acceleration: 'off' })
  assert.equal(plain.ok, true, plain.stderr)
  const reference = await content(plain.pages)
  for (const acceleration of ['cache', 'auto'] as const) {
    const result = await service.compile({ rootFile, acceleration })
    assert.equal(result.ok, true, result.stderr)
    assert.equal(result.stderr, '')
    assert.deepEqual(await content(result.pages), reference)
  }
})

test('unknown versions spawn normally and replacing the configured binary invalidates the probe', async () => {
  const binary = await locateLilyPond()
  const wrapper = path.join(scratch, 'version-wrapper')
  const rootFile = path.join(scratch, 'version.ly')
  const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'"
  await fs.writeFile(rootFile, '\\version "2.26.0"\n{ c1 }\n')
  await fs.writeFile(wrapper, `#!/bin/sh\nif [ "$1" = "--loglevel=ERROR" ]; then\n  printf '2.99.0\\n/unknown/backend.scm\\n'\nelse\n  exec ${quote(binary.path)} "$@"\nfi\n`, { mode: 0o700 })
  const ordinary = await service.compile({ rootFile, lilypondPath: wrapper, acceleration: 'auto' })
  assert.equal(ordinary.ok, true, ordinary.stderr)
  assert.equal(ordinary.engine, 'spawn')
  await fs.writeFile(wrapper, `#!/bin/sh\nexec ${quote(binary.path)} "$@"\n`)
  const accelerated = await service.compile({ rootFile, lilypondPath: wrapper, acceleration: 'auto' })
  assert.equal(accelerated.ok, true, accelerated.stderr)
  assert.equal(accelerated.engine, 'warm', accelerated.fallback)
})
