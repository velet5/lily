// The engine's dedicated worker, bundled by `esbuild.mjs --site` as
// engine.worker.js (chapter 08 of docs/research/wasm-engine). It reads
// engine/manifest.json, keeps every file the manifest names in Cache Storage
// so that a second visit, or one without a network, downloads nothing, and
// drives the engine (driver.ts) with the page's messages.
import { Driver, type Loader } from './driver'
import { CACHE, ENGINE_DIR, manifestFiles } from './modules'
import type { EngineManifest, FromEngine, ToEngine } from './protocol'

/** The worker's global scope, as far as it is used here; the DOM's types describe a window. */
interface Scope {
  location: { href: string }
  onmessage: ((event: MessageEvent<ToEngine>) => void) | null
  postMessage(message: FromEngine, transfer?: Transferable[]): void
}
const scope = self as unknown as Scope

const url = (file: string) => new URL(ENGINE_DIR + file, scope.location.href).href

/** Cache Storage, when the browser lets this origin have it (not in every private window). */
async function cache(): Promise<Cache | undefined> {
  try {
    return await caches.open(CACHE)
  } catch {
    return undefined
  }
}

/** A file of the engine: from the cache, else from the network into the cache. Names carry their hash. */
async function fetchCached(file: string): Promise<Response> {
  const store = await cache()
  const hit = await store?.match(url(file))
  if (hit) return hit
  const response = await fetch(url(file))
  if (!response.ok) throw new Error(`${file}: ${response.status} ${response.statusText}`)
  await store?.put(url(file), response.clone()).catch(() => {})
  return response
}

/** The manifest from the network, so that a new build is seen at once; the cached one offline. */
async function manifest(): Promise<EngineManifest> {
  const store = await cache()
  try {
    const response = await fetch(url('manifest.json'), { cache: 'no-cache' })
    if (!response.ok) throw new Error(`manifest.json: ${response.status}`)
    await store?.put(url('manifest.json'), response.clone()).catch(() => {})
    return await response.json()
  } catch (error) {
    const cached = await store?.match(url('manifest.json'))
    if (!cached) throw error
    return cached.json()
  }
}

/** Drops what an older build left in the cache. */
async function prune(current: EngineManifest): Promise<void> {
  const store = await cache()
  if (!store) return
  const keep = new Set([...manifestFiles(current), 'manifest.json'].map(url))
  for (const request of await store.keys()) if (!keep.has(request.url)) await store.delete(request)
}

const loader: Loader = {
  // Streaming needs `application/wasm`; a server that sends another type gets the slower way.
  module: (file) =>
    WebAssembly.compileStreaming(fetchCached(file)).catch(async () => WebAssembly.compile(await (await fetchCached(file)).arrayBuffer())),
  bytes: async (file) => new Uint8Array(await (await fetchCached(file)).arrayBuffer()),
}

/** A task of its own, after the messages that came meanwhile: how a compile in steps can be superseded. */
const channel = new MessageChannel()
const resumes: (() => void)[] = []
channel.port1.onmessage = () => resumes.shift()?.()
const pause = () =>
  new Promise<void>((resolve) => {
    resumes.push(resolve)
    channel.port2.postMessage(null)
  })

function post(message: FromEngine): void {
  const midi = message.type === 'finished' ? message.outcome.midiData : undefined
  scope.postMessage(message, midi ? [midi.buffer as ArrayBuffer] : [])
}

const early: ToEngine[] = []
scope.onmessage = (event) => early.push(event.data)

async function start(): Promise<void> {
  try {
    const current = await manifest()
    const driver = new Driver(current, loader, post, pause)
    await driver.start()
    scope.onmessage = (event) => driver.receive(event.data)
    early.forEach((message) => driver.receive(message))
    void prune(current)
  } catch (error) {
    post({ type: 'failed', message: error instanceof Error ? error.message : String(error) })
  }
}

void start()
