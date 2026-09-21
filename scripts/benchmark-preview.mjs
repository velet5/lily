// Reproducible compile-service latency, including snapshot and path remapping.
// Run alone: node scripts/benchmark-preview.mjs > results.json
// Browser/debounce are measured separately by the extension-host tests.
import { build } from 'esbuild'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'lily-benchmark-'))
await build({ entryPoints: ['src/compile/compiler.ts'], outfile: path.join(scratch, 'compiler.cjs'), bundle: true, platform: 'node', format: 'cjs' })
const { CompileService } = createRequire(import.meta.url)(path.join(scratch, 'compiler.cjs'))
const service = new CompileService({ tmpRoot: scratch, runtimeDir: path.resolve('runtime') })
const digest = async files => Promise.all(files.map(async file => createHash('sha256').update(await fs.readFile(file)).digest('hex')))
const rows = []
try {
  for (const [score, staves, bars] of [['small', 1, 8], ['medium', 2, 64]]) {
    const music = Array.from({ length: bars / 4 }, () => "c8( d e f) g4-. e | d4 f a2 | g8 f e d c2 | e4 g c,2 |").join(' ')
    const staff = `\\new Staff \\relative c' { \\time 4/4 ${music} }\n`
    const text = `\\version "2.26.0"\n\\header { tagline = ##f }\n\\score { <<\n${staff.repeat(staves)}>> \\layout {}\n\\midi { \\tempo 4 = 100 }\n}\n`
    const rootFile = path.join(scratch, `${score}.ly`)
    await fs.writeFile(rootFile, text)
    let reference
    for (const acceleration of ['off', 'cache', 'auto']) {
      const runs = []
      for (let repeat = 0; repeat < 4; repeat++) {
        const result = await service.compile({ rootFile, acceleration,
          ...(acceleration === 'auto' ? { buffers: new Map([[rootFile, text]]) } : {}) })
        if (!result.ok || result.stderr || result.fallback) throw new Error(JSON.stringify(result))
        const expected = acceleration === 'auto' ? 'warm' : acceleration === 'cache' ? 'cache' : 'spawn'
        if (result.engine !== expected) throw new Error(`Expected ${expected}, got ${result.engine}`)
        const hashes = await digest([...result.pages, ...result.midi])
        reference ??= hashes
        if (JSON.stringify(reference) !== JSON.stringify(hashes)) throw new Error('Output differs')
        runs.push({ durationMs: result.durationMs, snapshotMs: result.snapshotMs, pages: result.pages.length, svgAndMidiIdentical: true })
      }
      rows.push({ score, acceleration, first: runs[0], medianMs: runs.slice(1).map(r => r.durationMs).sort((a, b) => a - b)[1], runs: runs.slice(1) })
    }
  }
  process.stdout.write(JSON.stringify({ date: new Date().toISOString(), platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    method: 'One initial run then median of three, modes run sequentially, warm filesystem caches. Auto includes a new unsaved snapshot each time. Compile-service timings exclude debounce/editor/browser; first auto includes parent startup.', results: rows }, null, 2) + '\n')
} finally { await service.dispose(); await fs.rm(scratch, { recursive: true, force: true }) }
