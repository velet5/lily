import * as assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { Driver, outcomeOf } from '../src/web/engine/driver'
import { EngineHost, type EngineWorker } from '../src/web/engine/host'
import { manifestFiles, modulesFor, packFor } from '../src/web/engine/modules'
import { type EngineManifest, type FromEngine, Need, Step, type ToEngine } from '../src/web/engine/protocol'

// Runs under `node --test` from out/test/ (npm run test:unit in packages/studio/).
// The engine's host on the web (chapter 08 of docs/research/wasm-engine), with
// a scripted engine in place of the wasm, which does not exist yet.

const MANIFEST: EngineManifest = {
  version: 1,
  core: { wasm: 'core.1.wasm', image: 'core.1.image', preload: ['emmentaler-20'] },
  modules: {
    'emmentaler-20': { kind: 'pack', file: 'emmentaler-20.1.pack' },
    'emmentaler-14': { kind: 'pack', file: 'emmentaler-14.1.pack' },
    'emmentaler-16': { kind: 'pack', file: 'emmentaler-16.1.pack' },
    chords: { kind: 'part', file: 'chords.1.part' },
    'chord-names': { kind: 'split', file: 'chord-names.1.wasm' },
    tablature: { kind: 'split', file: 'tablature.1.wasm' },
    'ly/articulate.ly': { kind: 'part', file: 'articulate.1.part' },
    pdf: { kind: 'wasm', file: 'pdf.1.wasm' },
  },
}

describe('modulesFor', () => {
  test('fetches with the core what a score names', () => {
    const source = '\\include "articulate.ly"\n\\new ChordNames \\chordmode { c1 }\n\\new TabStaff { \\grace c8 d1 }'
    assert.deepEqual(modulesFor(source, MANIFEST), ['chords', 'chord-names', 'tablature', 'emmentaler-14', 'ly/articulate.ly'])
  })

  test('the pack of a staff size, but not one the core has, nor a module the build lacks', () => {
    assert.deepEqual(modulesFor('#(set-global-staff-size 15.87)', MANIFEST), ['emmentaler-16'])
    assert.deepEqual(modulesFor('#(set-global-staff-size 20)', MANIFEST), [])
    assert.deepEqual(modulesFor('\\partCombine \\a \\b \\include "my.ily"', MANIFEST), [])
  })

  test('packFor takes the nearest optical size', () => {
    assert.equal(packFor(10), 'emmentaler-11')
    assert.equal(packFor(17.82), 'emmentaler-18')
    assert.equal(packFor(30), 'emmentaler-26')
  })

  test('manifestFiles lists every file the cache may keep', () => {
    assert.equal(manifestFiles(MANIFEST).length, 2 + Object.keys(MANIFEST.modules).length)
  })
})

const bytes = (text: string) => new TextEncoder().encode(text)

describe('outcomeOf', () => {
  test('the outputs as the renderer takes a compile', () => {
    const diagnostics = [{ file: '/s/score.ly', line: 3, column: 5, severity: 'error', message: 'syntax error' }]
    const outputs = new Map([
      ['stderr', bytes('score.ly:3:5: error: syntax error\n')],
      ['diagnostics.json', bytes(JSON.stringify(diagnostics))],
      ['score-1.svg', bytes('<svg>1</svg>')],
      ['score-2.svg', bytes('<svg>2</svg>')],
      ['score.midi', new Uint8Array([0x4d, 0x54])],
      ['score.timing.json', bytes('{"events":[],"bars":[]}')],
    ])
    const outcome = outcomeOf('/s/score.ly', outputs, 12)
    assert.equal(outcome.state, 'failed')
    assert.deepEqual(outcome.diagnostics, diagnostics)
    assert.equal(outcome.errorCount, 1)
    assert.deepEqual(outcome.svg, ['<svg>1</svg>', '<svg>2</svg>'])
    assert.deepEqual(outcome.midi, ['score.midi'])
    assert.deepEqual([...(outcome.midiData ?? [])], [0x4d, 0x54])
    assert.deepEqual(outcome.timing, { events: [], bars: [] })
  })

  test('no diagnostics: ok', () => {
    assert.equal(outcomeOf('/s/score.ly', new Map([['score.svg', bytes('<svg/>')]]), 1).state, 'ok')
  })
})

/**
 * An engine in JavaScript behind the ABI of protocol.ts: each compile runs
 * `script`, one entry a step. A step returns Step.More, asks for a file or a
 * split module, traps, or ends with a page that names what it was given.
 */
type Action = 'more' | 'trap' | { file: string } | { placeholder: string } | 'done'
let script: Action[] = []
let instances = 0
let splitInstances = 0

function fakeEngine(imports: WebAssembly.Imports) {
  instances++
  const memory = new WebAssembly.Memory({ initial: 4 })
  let next = 8
  const view = () => new Uint8Array(memory.buffer)
  // Four-byte aligned, as the out-parameters are u32.
  const alloc = (len: number) => {
    const at = next
    next = (next + len + 3) & ~3
    return at
  }
  const string = (at: number, len: number) => new TextDecoder().decode(view().subarray(at, at + len))
  const files = new Map<string, string | null>()
  let step = 0
  let need = { kind: 0, name: '' }
  let outputs: [string, Uint8Array][] = []
  const write = (at: number, ...words: number[]) => new Uint32Array(memory.buffer, at, words.length).set(words)
  const place = (data: Uint8Array) => {
    const at = alloc(data.length)
    view().set(data, at)
    return at
  }
  return {
    memory,
    lily_alloc: alloc,
    lily_free: () => {},
    lily_start: () => 0,
    lily_put: (kind: number, name: number, nameLen: number, data: number, dataLen: number) =>
      void (kind === Need.File && files.set(string(name, nameLen), data === 0 ? null : string(data, dataLen))),
    lily_compile: () => void (step = 0),
    lily_step: () => {
      const action = script[step]
      if (action === 'more') return (step++, Step.More)
      if (action === 'trap') throw new WebAssembly.RuntimeError('unreachable')
      if (action === 'done') {
        outputs = [['score.svg', bytes(`<svg>${[...files].map(([k, v]) => `${k}=${v}`).join(' ')}</svg>`)]]
        return Step.Done
      }
      if ('file' in action) {
        if (files.has(action.file)) return (step++, Step.More)
        need = { kind: Need.File, name: action.file }
        return Step.Needs
      }
      const placeholder = (imports[`placeholder.${action.placeholder}`] as Record<string, () => void> | undefined)?.['0']
      if (placeholder && !splitLoaded) placeholder()
      return (step++, Step.More)
    },
    lily_needs: (out: number) => {
      const name = bytes(need.name)
      write(out, need.kind, place(name), name.length)
    },
    lily_outputs: () => outputs.length,
    lily_output: (i: number, out: number) => {
      const [name, data] = outputs[i]
      const encoded = bytes(name)
      write(out, place(encoded), encoded.length, place(data), data.length)
    },
  }
}
let splitLoaded = false

const CORE = { core: true } as unknown as WebAssembly.Module
const SPLIT = { split: true } as unknown as WebAssembly.Module
const real = { instantiate: WebAssembly.instantiate, imports: WebAssembly.Module.imports }

function driver(pause: () => Promise<void> = async () => {}, unreachable: string[] = []) {
  const posted: FromEngine[] = []
  const loader = {
    module: async (file: string) => (file === MANIFEST.core.wasm ? CORE : SPLIT),
    bytes: async (file: string) => {
      if (unreachable.includes(file)) throw new Error(`${file}: 503 Service Unavailable`)
      return new Uint8Array(4)
    },
  }
  return { posted, driver: new Driver(MANIFEST, loader, (message) => posted.push(message), pause) }
}

const request = (revision: number, files: Record<string, string> = { '/s/score.ly': '{ c }' }) =>
  ({ type: 'compile', request: { revision, rootFile: '/s/score.ly', files, visiblePage: 1 } }) as ToEngine

/** Until the driver has nothing left to do. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

describe('Driver', () => {
  beforeEach(() => {
    instances = 0
    splitInstances = 0
    splitLoaded = false
    WebAssembly.Module.imports = (module) =>
      module === CORE ? [{ module: 'placeholder.tablature', name: '0', kind: 'function' as const }] : real.imports(module)
    WebAssembly.instantiate = (async (module: WebAssembly.Module, imports: WebAssembly.Imports) => {
      if (module === SPLIT) return (splitInstances++, (splitLoaded = true), {})
      return { exports: fakeEngine(imports) }
    }) as unknown as typeof WebAssembly.instantiate
  })
  afterEach(() => {
    WebAssembly.instantiate = real.instantiate
    WebAssembly.Module.imports = real.imports
  })

  test('starts from the image, and runs a compile in steps to its outcome', async () => {
    script = ['more', 'more', 'done']
    const { driver: engine, posted } = driver()
    await engine.start()
    assert.equal(posted[0].type, 'ready')
    engine.receive(request(1))
    await settle()
    const finished = posted[1]
    assert.equal(finished.type === 'finished' && finished.revision, 1)
    assert.deepEqual(finished.type === 'finished' && finished.outcome.svg, ['<svg>/s/score.ly={ c }</svg>'])
  })

  test('a newer request supersedes the running compile between steps', async () => {
    script = ['more', 'more', 'done']
    let pauses = 0
    const { driver: engine, posted } = driver(async () => {
      if (++pauses === 1) engine.receive(request(2, { '/s/score.ly': '{ d }' }))
    })
    await engine.start()
    engine.receive(request(1))
    await settle()
    assert.deepEqual(
      posted.slice(1).map((m) => [m.type, 'revision' in m && m.revision]),
      [
        ['superseded', 1],
        ['finished', 2],
      ],
    )
  })

  test('asks the page for a file it lacks, and compiles again with it; null is no such file', async () => {
    script = [{ file: '/s/a.ily' }, { file: '/s/b.ily' }, 'done']
    const { driver: engine, posted } = driver()
    await engine.start()
    engine.receive(request(1))
    await settle()
    assert.deepEqual(posted[1], { type: 'needs-file', revision: 1, path: '/s/a.ily' })
    engine.receive({ type: 'file', path: '/s/a.ily', text: 'e' })
    await settle()
    engine.receive({ type: 'file', path: '/s/b.ily', text: null })
    await settle()
    const finished = posted.at(-1)
    assert.deepEqual(finished?.type === 'finished' && finished.outcome.svg, ['<svg>/s/score.ly={ c } /s/a.ily=e /s/b.ily=null</svg>'])
  })

  test('a placeholder: a new instance, the split module in it, and the compile again', async () => {
    script = [{ placeholder: 'tablature' }, 'done']
    const { driver: engine, posted } = driver()
    await engine.start()
    engine.receive(request(1))
    await settle()
    assert.equal(instances, 2)
    assert.equal(splitInstances, 1)
    assert.equal(posted.at(-1)?.type, 'finished')
  })

  test('a module that cannot be fetched is a compile that did not run, and says which', async () => {
    script = ['done']
    const { driver: engine, posted } = driver(undefined, ['chords.1.part'])
    await engine.start()
    engine.receive(request(1, { '/s/score.ly': '\\chordmode { c }' }))
    await settle()
    const last = posted.at(-1)
    assert.equal(last?.type === 'finished' && last.revision, 1)
    assert.equal(last?.type === 'finished' && last.outcome.state, 'error')
    assert.match(last?.type === 'finished' ? (last.outcome.message ?? '') : '', /could not compile the score: chords\.1\.part: 503/)
    engine.receive(request(2))
    await settle()
    const next = posted.at(-1)
    assert.equal(next?.type === 'finished' && next.outcome.state, 'ok')
  })

  test('a trap is a compile that did not run, and the next one starts afresh', async () => {
    script = ['trap']
    const { driver: engine, posted } = driver()
    await engine.start()
    engine.receive(request(1))
    await settle()
    const failed = posted.at(-1)
    assert.equal(failed?.type === 'finished' && failed.outcome.state, 'error')
    assert.match(failed?.type === 'finished' ? (failed.outcome.message ?? '') : '', /The engine stopped: unreachable/)
    script = ['done']
    engine.receive(request(2))
    await settle()
    assert.equal(instances, 2)
    const last = posted.at(-1)
    assert.equal(last?.type === 'finished' && last.outcome.state, 'ok')
  })
})

describe('Driver at the memory maximum', () => {
  test('a trap with the memory full says why', async () => {
    script = ['trap']
    // The engine's memory has grown to the maximum when it traps.
    WebAssembly.instantiate = (async (_: WebAssembly.Module, imports: WebAssembly.Imports) => {
      const engine = fakeEngine(imports)
      const exports = { ...engine }
      exports.lily_step = () => {
        exports.memory = { buffer: { byteLength: 256 * 2 ** 20 } } as unknown as WebAssembly.Memory
        return engine.lily_step()
      }
      return { exports }
    }) as unknown as typeof WebAssembly.instantiate
    WebAssembly.Module.imports = () => []
    try {
      const { driver: engine, posted } = driver()
      await engine.start()
      engine.receive(request(1))
      await settle()
      const last = posted.at(-1)
      assert.match(last?.type === 'finished' ? (last.outcome.message ?? '') : '', /more memory than the engine may use \(256 MiB\)/)
    } finally {
      WebAssembly.instantiate = real.instantiate
      WebAssembly.Module.imports = real.imports
    }
  })
})

describe('EngineHost', () => {
  function host(readFile: (path: string) => Promise<string | null> = async () => null) {
    const sent: ToEngine[] = []
    const worker: EngineWorker = { onmessage: null, postMessage: (message) => sent.push(message), terminate: () => {} }
    const reply = (data: FromEngine) => worker.onmessage?.({ data } as MessageEvent<FromEngine>)
    return { host: new EngineHost(worker, readFile), sent, reply }
  }

  test('only the newest compile is answered', async () => {
    const { host: engine, reply } = host()
    const first = engine.compile('/s/score.ly', {})
    const second = engine.compile('/s/score.ly', {})
    assert.equal(await first, undefined)
    reply({ type: 'finished', revision: 2, outcome: outcomeOf('/s/score.ly', new Map(), 1) })
    assert.equal((await second)?.state, 'ok')
  })

  test('answers the engine’s questions for files with readFile', async () => {
    const { reply, sent } = host(async (path) => (path === '/s/a.ily' ? 'e' : null))
    reply({ type: 'needs-file', revision: 1, path: '/s/a.ily' })
    reply({ type: 'needs-file', revision: 1, path: '/s/none.ily' })
    await settle()
    assert.deepEqual(sent, [
      { type: 'file', path: '/s/a.ily', text: 'e' },
      { type: 'file', path: '/s/none.ily', text: null },
    ])
  })

  test('an engine that failed answers nothing, and says so', async () => {
    const { host: engine, reply } = host()
    const pending = engine.compile('/s/score.ly', {})
    reply({ type: 'failed', message: 'no wasm' })
    assert.equal(await pending, undefined)
    assert.equal(engine.failed, true)
    await assert.rejects(engine.ready, /no wasm/)
  })
})
