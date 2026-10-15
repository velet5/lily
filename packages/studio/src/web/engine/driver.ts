// The engine in its worker (chapter 08 of docs/research/wasm-engine): starts
// the core from its image, runs one compile at a time in steps, and between
// steps lets a newer request supersede it (B8: within 50 ms, without shared
// memory). What a compile lacks — a file of the page, a module — it fetches,
// then starts that compile again; the engine reuses what it already did.
// worker.ts gives it the cache and the worker's messages, the tests fakes.
import type { CompileOutcome } from '../../ipc'
import { modulesFor } from './modules'
import {
  type CompileRequest,
  type EngineExports,
  type EngineManifest,
  type EngineOutputs,
  type FromEngine,
  type LyDiagnostic,
  MAX_MEMORY,
  Need,
  Step,
  type ToEngine,
} from './protocol'

/** How long one `lily_step` may work before the worker reads its messages: well inside B8's 50 ms. */
export const STEP_MS = 10

export interface Loader {
  /** A wasm file of the engine, compiled (by streaming, from the cache). */
  module(file: string): Promise<WebAssembly.Module>
  /** Any other file of the engine. */
  bytes(file: string): Promise<Uint8Array>
}

/** What a placeholder of a split module throws: the core called a function it does not have yet. */
class Missing extends Error {
  constructor(readonly module: string) {
    super(`needs ${module}`)
  }
}

const utf8 = new TextEncoder()
const text = new TextDecoder()

export class Driver {
  private core?: WebAssembly.Module
  private image?: Uint8Array
  private engine?: EngineExports
  /** Split modules, compiled, by name: instantiated again with every new core instance. */
  private readonly split = new Map<string, WebAssembly.Module>()
  /** Parts and packs, by name: put again into every new core instance. */
  private readonly data = new Map<string, Uint8Array>()
  private latest?: CompileRequest
  private running = false
  private readonly waiting = new Map<string, (text: string | null | undefined) => void>()

  constructor(
    private readonly manifest: EngineManifest,
    private readonly loader: Loader,
    private readonly post: (message: FromEngine) => void,
    /** Returns to the worker's event loop, so that messages are read. */
    private readonly pause: () => Promise<void>,
  ) {}

  /** Fetches the core, its image and the modules preloaded with it, and starts it. */
  async start(): Promise<void> {
    const started = performance.now()
    const { wasm, image, preload } = this.manifest.core
    const [core, bytes] = await Promise.all([this.loader.module(wasm), this.loader.bytes(image)])
    this.core = core
    this.image = bytes
    await this.instantiate()
    await Promise.all(preload.map((name) => this.load(name)))
    this.post({ type: 'ready', ms: performance.now() - started })
  }

  receive(message: ToEngine): void {
    if (message.type === 'file') {
      this.waiting.get(message.path)?.(message.text)
      this.waiting.delete(message.path)
      return
    }
    this.latest = message.request
    // A compile waiting for a file stops waiting: the newer request wins.
    for (const resolve of this.waiting.values()) resolve(undefined)
    this.waiting.clear()
    if (!this.running) void this.run()
  }

  private async run(): Promise<void> {
    this.running = true
    try {
      while (this.latest) {
        const request = this.latest
        const started = performance.now()
        try {
          await this.compile(request)
        } catch (error) {
          // A module that could not be fetched (offline, never cached), or outputs that do not read:
          // the compile did not run, and the page compiles elsewhere (chapter 08 §7).
          this.finish(request, failure(request.rootFile, `The engine could not compile the score: ${messageOf(error)}`, started))
        }
        if (this.latest === request) this.latest = undefined
      }
    } finally {
      this.running = false
    }
  }

  private async compile(request: CompileRequest): Promise<void> {
    const started = performance.now()
    const superseded = () => this.latest !== request
    // What the sources name is fetched before the first step, not on the engine's request.
    const sources = Object.values(request.files).join('\n')
    await Promise.all(modulesFor(sources, this.manifest).map((name) => this.load(name)))
    this.begin(request)
    for (;;) {
      if (superseded()) return this.post({ type: 'superseded', revision: request.revision })
      let step: number
      try {
        step = this.exports().lily_step(STEP_MS)
      } catch (error) {
        // A placeholder, or the engine stopped (`panic = "immediate-abort"` traps). Its state
        // cannot be trusted after either: a new instance starts from the image.
        const full = this.exports().memory.buffer.byteLength > MAX_MEMORY - 2 ** 20
        await this.instantiate()
        if (!(error instanceof Missing)) {
          const message = full
            ? `The score needs more memory than the engine may use (${MAX_MEMORY / 2 ** 20} MiB).`
            : `The engine stopped: ${messageOf(error)}`
          return this.finish(request, failure(request.rootFile, message, started))
        }
        await this.load(error.module)
        this.begin(request)
        continue
      }
      if (step === Step.Done) return this.finish(request, outcomeOf(request.rootFile, this.outputs(), performance.now() - started))
      if (step === Step.Needs) {
        const [kind, name] = this.needs()
        if (kind === Need.File) {
          const answer = await this.ask(request, name)
          if (answer === undefined) continue
          this.put(Need.File, name, answer === null ? null : utf8.encode(answer))
        } else {
          await this.load(name)
        }
        this.begin(request)
        continue
      }
      await this.pause()
    }
  }

  private finish(request: CompileRequest, outcome: CompileOutcome): void {
    this.post({ type: 'finished', revision: request.revision, outcome })
  }

  /** Gives the engine the request's texts and starts its compile. */
  private begin(request: CompileRequest): void {
    for (const [path, source] of Object.entries(request.files)) this.put(Need.File, path, utf8.encode(source))
    const engine = this.exports()
    const [root, rootLen] = this.copy(utf8.encode(request.rootFile))
    engine.lily_compile(request.revision, root, rootLen, request.visiblePage)
    engine.lily_free(root, rootLen)
  }

  /** Asks the page for a file; undefined when a newer request came first. */
  private ask(request: CompileRequest, path: string): Promise<string | null | undefined> {
    return new Promise((resolve) => {
      this.waiting.set(path, resolve)
      this.post({ type: 'needs-file', revision: request.revision, path })
    })
  }

  /** Fetches a module of the manifest once; split modules join the core, the rest is put into it. */
  private async load(name: string): Promise<void> {
    if (this.split.has(name) || this.data.has(name)) return
    const module = this.manifest.modules[name]
    if (!module) throw new Error(`The engine asked for ${name}, which it was not built with.`)
    if (module.kind === 'split') {
      const compiled = await this.loader.module(module.file)
      this.split.set(name, compiled)
      await WebAssembly.instantiate(compiled, { primary: this.exports() as unknown as WebAssembly.ModuleImports })
    } else if (module.kind === 'part' || module.kind === 'pack') {
      const bytes = await this.loader.bytes(module.file)
      this.data.set(name, bytes)
      this.put(Need.Module, name, bytes)
    } else {
      throw new Error(`${name} is a module of its own, not a part of a compile.`)
    }
  }

  /** A new instance of the core from its image, with every split module and part loaded so far. */
  private async instantiate(): Promise<void> {
    const core = this.core
    const image = this.image
    if (!core || !image) throw new Error('The engine has not been started.')
    // A placeholder of split module `m` is imported from `placeholder.m` (wasm-split's namespaces).
    const imports: WebAssembly.Imports = { env: { lily_now: () => performance.now() } }
    for (const entry of WebAssembly.Module.imports(core)) {
      if (!entry.module.startsWith('placeholder.')) continue
      const name = entry.module.slice('placeholder.'.length)
      imports[entry.module] ??= {}
      imports[entry.module][entry.name] = () => {
        throw new Missing(name)
      }
    }
    this.engine = (await WebAssembly.instantiate(core, imports)).exports as unknown as EngineExports
    for (const module of this.split.values()) await WebAssembly.instantiate(module, { primary: this.engine as unknown as WebAssembly.ModuleImports })
    const [at, len] = this.copy(image)
    const started = this.engine.lily_start(at, len)
    this.engine.lily_free(at, len)
    if (started !== 0) throw new Error(`The engine's image did not start (${started}).`)
    for (const [name, bytes] of this.data) this.put(Need.Module, name, bytes)
  }

  private exports(): EngineExports {
    if (!this.engine) throw new Error('The engine has not been started.')
    return this.engine
  }

  /** Copies `bytes` into memory the engine allocated; the caller frees it. */
  private copy(bytes: Uint8Array): [number, number] {
    const engine = this.exports()
    const at = engine.lily_alloc(bytes.length)
    new Uint8Array(engine.memory.buffer, at, bytes.length).set(bytes)
    return [at, bytes.length]
  }

  /** Gives the engine a file or a module; `null`: there is no such file. */
  private put(kind: number, name: string, bytes: Uint8Array | null): void {
    const engine = this.exports()
    const [at, len] = this.copy(utf8.encode(name))
    const [data, dataLen] = bytes ? this.copy(bytes) : [0, 0]
    engine.lily_put(kind, at, len, data, dataLen)
    engine.lily_free(at, len)
    if (bytes) engine.lily_free(data, dataLen)
  }

  /** What `Step.Needs` asks for: its kind and name. */
  private needs(): [number, string] {
    const engine = this.exports()
    const out = engine.lily_alloc(12)
    engine.lily_needs(out)
    const [kind, at, len] = new Uint32Array(engine.memory.buffer, out, 3)
    const name = text.decode(new Uint8Array(engine.memory.buffer, at, len))
    engine.lily_free(out, 12)
    return [kind, name]
  }

  /** The output files, copied out of the engine's memory. */
  private outputs(): EngineOutputs {
    const engine = this.exports()
    const out = engine.lily_alloc(16)
    const files: EngineOutputs = new Map()
    for (let i = 0; i < engine.lily_outputs(); i++) {
      engine.lily_output(i, out)
      const [name, nameLen, data, dataLen] = new Uint32Array(engine.memory.buffer, out, 4)
      files.set(text.decode(new Uint8Array(engine.memory.buffer, name, nameLen)), new Uint8Array(engine.memory.buffer, data, dataLen).slice())
    }
    engine.lily_free(out, 16)
    return files
  }
}

/**
 * A compile's outputs as the renderer takes a compile from the Rust side
 * (ipc.ts): diagnostics in the shape `parseStderr` gives them, pages in the
 * order the engine wrote them, the first MIDI file and its playback map.
 * `stderr` is left to logs and to chapter 00's comparator (C0).
 */
export function outcomeOf(rootFile: string, outputs: EngineOutputs, durationMs: number): CompileOutcome {
  const read = (name: string) => text.decode(outputs.get(name))
  const names = [...outputs.keys()]
  const pages = names.filter((name) => name.endsWith('.svg'))
  const midi = names.filter((name) => /\.midi?$/.test(name))
  const diagnostics: LyDiagnostic[] = outputs.has('diagnostics.json') ? JSON.parse(read('diagnostics.json')) : []
  const errorCount = diagnostics.filter((d) => d.severity === 'error').length
  const timing = names.find((name) => name.endsWith('.timing.json'))
  return {
    state: errorCount > 0 ? 'failed' : 'ok',
    rootFile,
    diagnostics,
    errorCount,
    warningCount: diagnostics.length - errorCount,
    pages,
    svg: pages.map(read),
    midi,
    ...(midi.length > 0 ? { midiData: outputs.get(midi[0]) } : {}),
    ...(timing ? { timing: JSON.parse(read(timing)) } : {}),
    durationMs,
  }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A compile that did not run, as the renderer shows one: `message` says why. */
function failure(rootFile: string, message: string, started: number): CompileOutcome {
  return {
    state: 'error',
    rootFile,
    diagnostics: [],
    errorCount: 0,
    warningCount: 0,
    pages: [],
    svg: [],
    midi: [],
    durationMs: performance.now() - started,
    message,
  }
}
