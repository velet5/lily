// A real CompileOutcome for the renderer's tests (DECISIONS D42): the Rust
// side's `lily-outcome` compiles a score as the app does and prints the
// outcome as the bridge receives it; the MIDI is decoded as the bridge
// decodes it. `npm run test:unit` builds it with `cargo test` first.
import { execFile } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { TestContext } from 'node:test'
import type { CompileOutcome } from '../src/ipc'

/** studio/, as out/test/ lies two levels below it. */
const studioDir = path.resolve(__dirname, '..', '..')
const binary = path.join(studioDir, 'target', 'debug', 'lily-outcome')

/**
 * The outcome of compiling `score` with the extension's runtime/, or
 * undefined after skipping `t` when lilypond is not installed. Throws when
 * lily-outcome is not built.
 */
export async function realOutcome(t: TestContext, score: string): Promise<CompileOutcome | undefined> {
  if (!fs.existsSync(binary)) throw new Error(`${binary} is missing; run \`cargo build -p lily-engrave\` in studio/`)
  const { code, stdout, stderr } = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(binary, [score, '--runtime', path.join(studioDir, '..', 'runtime')], { maxBuffer: 64 << 20 }, (error, out, err) =>
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: out, stderr: err }),
    )
  })
  if (code === 2) {
    t.skip(`lilypond did not run: ${stderr.trim()}`)
    return undefined
  }
  if (code !== 0) throw new Error(`lily-outcome exited with ${code}: ${stderr}`)
  const { midiData, ...rest } = JSON.parse(stdout) as Omit<CompileOutcome, 'midiData'> & { midiData?: string }
  return midiData === undefined ? rest : { ...rest, midiData: new Uint8Array(Buffer.from(midiData, 'base64')) }
}
