// Chapter 00 §6's harness, for the spike: starts engine.worker.js (the
// studio's own engine worker, chapter 08), and measures cold start (B5a),
// the first render (B5b), re-renders after edits (B6), the main thread (B7),
// a superseded compile (B8), memory (B4) and the Scheme's speed. Results are
// shown and POSTed to /result (serve.mjs).

const RUNS = 11 // the first is discarded (chapter 00 §6.1)
const params = new URLSearchParams(location.search)
const label = params.get('label') ?? ''
const out = document.getElementById('out')
const pages = document.getElementById('pages')
const log = (line) => (out.textContent += line + '\n')

// ---- The scores: one staff, T02's and T29's event counts (chapter 00 §4) ----

function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A score in \relative of `events` notes and rests, one measure per line; where each note is. */
function score(name, events, seed) {
  const rnd = random(seed)
  const NAMES = ['c', 'd', 'e', 'f', 'g', 'a', 'b']
  // Sixteenths: whole, half, dotted quarter, quarter, eighth, sixteenth.
  const DURS = [[16, '1'], [8, '2'], [6, '4.'], [4, '4'], [2, '8'], [1, '16']]
  let src = `\\version "2.26.0"\n\\header { title = #(string-append "${name}, " (number->string ${events}) " events") }\n`
  src += `#(define bars (iota ${Math.ceil(events / 6)}))\n\\relative c'' {\n  \\clef treble \\key d \\major \\time 4/4\n`
  const notes = []
  let steps = 2 * 7 // c'', where \relative c'' starts
  let left = events
  while (left > 0) {
    let line = '  '
    let room = 16
    while (room > 0 && left > 0) {
      const fits = DURS.filter(([d]) => d <= room)
      const [d, text] = fits[Math.floor(rnd() * fits.length * 0.999) % fits.length]
      room -= d
      left--
      if (rnd() < 0.08) {
        line += `r${text} `
        continue
      }
      let move = Math.floor(rnd() * 7) - 3
      // Between e' and a'': mostly on the staff.
      if (steps + move > 2 * 7 + 5 || steps + move < 7 + 2) move = -move
      steps += move
      const acc = rnd() < 0.1 ? (rnd() < 0.5 ? 'is' : 'es') : ''
      const token = `${NAMES[steps % 7]}${acc}${text}`
      notes.push({ at: src.length + line.length, token })
      line += token + ' '
    }
    src += line + '|\n'
  }
  src += '  \\bar "|."\n}\n'
  return { name, path: `/spike/${name}.ly`, src, notes }
}

const S = score('S43', 43, 2)
const L = score('L532', 532, 29)
/** For B8 only: long enough that a compile is still running 20 ms in on a desktop. */
const XL = score('XL4256', 4256, 8)
const FIB = { name: 'fib', path: '/spike/fib.ly', src: "#(define r (fib 25))\n{ c'4 }\n", notes: [] }

/** E1: the middle note a step up; E2: its token again before it (chapter 00 §6.2). */
function edit(s, kind) {
  const n = s.notes[Math.floor(s.notes.length / 2)]
  const NEXT = { c: 'd', d: 'e', e: 'f', f: 'g', g: 'a', a: 'b', b: 'c' }
  const replacement = kind === 'E1' ? NEXT[n.token[0]] + n.token.slice(1) : `${n.token} ${n.token}`
  return { ...s, src: s.src.slice(0, n.at) + replacement + s.src.slice(n.at + n.token.length) }
}

// ---- The engine's worker, as EngineHost (host.ts) drives it ----

const worker = new Worker('engine.worker.js')
let revision = 0
const pending = new Map()
const superseded = new Map()
let readyAt
const ready = new Promise((resolve, reject) => {
  worker.onmessage = ({ data }) => {
    if (data.type === 'ready') {
      readyAt = performance.now()
      resolve(data.ms)
    } else if (data.type === 'failed') {
      reject(new Error(data.message))
    } else if (data.type === 'needs-file') {
      worker.postMessage({ type: 'file', path: data.path, text: null })
    } else if (data.type === 'finished') {
      pending.get(data.revision)?.(data.outcome)
    } else if (data.type === 'superseded') {
      superseded.get(data.revision)?.(performance.now())
    }
  }
})

function compile(s) {
  const r = ++revision
  const outcome = new Promise((resolve) => pending.set(r, resolve))
  worker.postMessage({ type: 'compile', request: { revision: r, rootFile: s.path, files: { [s.path]: s.src }, visiblePage: 1 } })
  return { revision: r, outcome }
}

const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()))

/** One compile to the page shown: edit dispatched → pages in the DOM → the next frame's callback. */
async function render(s) {
  const started = performance.now()
  const outcome = await compile(s).outcome
  if (outcome.state !== 'ok') throw new Error(`${s.name}: ${outcome.message ?? JSON.stringify(outcome.diagnostics)}`)
  pages.innerHTML = outcome.svg.join('')
  await frame()
  const stats = JSON.parse(outcome.svg[0].match(/<!--lily-spike (\{.*?\})-->/)[1])
  return { ms: performance.now() - started, workerMs: outcome.durationMs, bytes: outcome.svg.reduce((n, p) => n + p.length, 0), ...stats }
}

const quantile = (values, q) => {
  const v = [...values].sort((a, b) => a - b)
  return v[Math.min(v.length - 1, Math.floor(q * v.length))]
}
const summary = (runs, key) => {
  const v = runs.slice(1).map((r) => r[key])
  return { p50: +quantile(v, 0.5).toFixed(2), p95: +quantile(v, 0.95).toFixed(2), max: +Math.max(...v).toFixed(2) }
}

async function cachedFiles() {
  try {
    return (await (await caches.open('lily-engine')).keys()).length
  } catch {
    return null
  }
}

let longest = 0
try {
  new PerformanceObserver((list) => list.getEntries().forEach((e) => (longest = Math.max(longest, e.duration)))).observe({ type: 'longtask', buffered: true })
} catch {
  longest = null
}

async function run() {
  const result = {
    label,
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    secure: isSecureContext,
    crossOriginIsolated,
    cachedAtStart: await cachedFiles(),
  }
  result.engineStartMs = +(await ready).toFixed(2)
  result.b5aReadyMs = +readyAt.toFixed(2)
  log(`ready ${result.b5aReadyMs.toFixed(1)} ms after navigation start (engine ${result.engineStartMs} ms), cached files at start: ${result.cachedAtStart}`)

  const first = await render(S)
  result.b5bFirstRender = first
  log(`first render of S43 ${first.ms.toFixed(1)} ms (worker ${first.workerMs.toFixed(1)}, ${first.bytes} bytes of SVG)`)

  const fib = []
  for (let i = 0; i < 6; i++) fib.push(await render(FIB))
  result.schemeFib25 = summary(fib, 'schemeMs')
  log(`(fib 25): p50 ${result.schemeFib25.p50} ms`)

  result.edits = {}
  for (const s of [S, L]) {
    for (const kind of ['E1', 'E2']) {
      const edited = edit(s, kind)
      const runs = []
      for (let i = 0; i < RUNS; i++) runs.push(await render(i % 2 ? s : edited))
      const keys = ['ms', 'workerMs', 'parseMs', 'schemeMs', 'layoutMs', 'svgMs', 'longestStepMs']
      result.edits[`${s.name} ${kind}`] = { ...Object.fromEntries(keys.map((k) => [k, summary(runs, k)])), pages: runs[0].pages, systems: runs[0].systems, bytes: runs[0].bytes, memory: Math.max(...runs.map((r) => r.memory)) }
      const e = result.edits[`${s.name} ${kind}`]
      log(`${s.name} ${kind}: p50 ${e.ms.p50} / p95 ${e.ms.p95} ms (parse ${e.parseMs.p50}, layout ${e.layoutMs.p50}, svg ${e.svgMs.p50}, longest step ${e.longestStepMs.max}), ${e.pages} pages`)
    }
  }

  // B8: a newer edit 20 ms into XL4256's compile; how long until the worker stops working on the
  // first, superseded between steps or finished.
  const b8 = []
  for (let i = 0; i < 5; i++) {
    const big = compile(XL)
    const dropped = new Promise((resolve) => superseded.set(big.revision, () => resolve('superseded')))
    await new Promise((resolve) => setTimeout(resolve, 20))
    const sent = performance.now()
    const next = compile(S)
    const how = await Promise.race([dropped, big.outcome.then(() => 'finished')])
    b8.push({ ms: +(performance.now() - sent).toFixed(2), how })
    await next.outcome
  }
  result.b8 = b8
  log(`B8: ${b8.map((b) => `${b.ms} (${b.how})`).join(', ')} ms`)

  result.b4MemoryBytes = Math.max(...Object.values(result.edits).map((e) => e.memory))
  result.b7LongestTaskMs = longest
  log(`memory ${(result.b4MemoryBytes / 2 ** 20).toFixed(1)} MiB; longest main-thread task ${longest ?? 'not observable'}`)

  try {
    await fetch('result', { method: 'POST', body: JSON.stringify(result) })
    log('sent.')
  } catch (error) {
    log(`not sent: ${error}`)
  }
  window.spikeResult = result
}

document.getElementById('again').onclick = () => location.reload()
document.getElementById('cold').onclick = async () => {
  try {
    await caches.delete('lily-engine')
  } catch {}
  location.reload()
}
run().catch((error) => {
  log(`failed: ${error.message}`)
  window.spikeResult = { label, error: error.message }
})
