// What the page, the engine's worker and the engine's wasm exchange (chapter 08
// of docs/research/wasm-engine). Types, and the numbers of the wasm ABI.
import type { LyDiagnostic } from '@lily/common/types'
import type { CompileOutcome } from '../../ipc'

/**
 * `engine/manifest.json`, written by `esbuild.mjs --site` from what the
 * engine's build left in dist/engine/. Every file name carries a hash of its
 * bytes, so a name is never reused for other bytes and a cached file never
 * goes stale.
 */
export interface EngineManifest {
  version: 1
  /**
   * The core, fetched before the first compile, and the modules fetched with
   * it: the default font pack and the text metrics (chapter 06 §5.2).
   */
  core: { wasm: string; image: string; preload: string[] }
  /** What is fetched only when a score needs it, by name. */
  modules: Record<string, EngineModule>
}

/**
 * `split`: functions `wasm-split` took out of the core, instantiated into the
 * core's memory and table; the core imports their placeholders from
 * `placeholder.<name>`. `wasm`: a module with its own memory, such as the
 * PDF writer, dropped after use. `part`: compiled Scheme for the core's heap.
 * `pack`: a font pack.
 */
export type EngineModuleKind = 'split' | 'wasm' | 'part' | 'pack'

export interface EngineModule {
  kind: EngineModuleKind
  file: string
}

/** The page to the worker. */
export type ToEngine =
  | { type: 'compile'; request: CompileRequest }
  /** A file the engine asked for with `needs-file`; `text` is null when there is none. */
  | { type: 'file'; path: string; text: string | null }

export interface CompileRequest {
  /** Increases with every request; a newer one supersedes the running compile (B8). */
  revision: number
  /** Absolute path of the score, as the page names it. */
  rootFile: string
  /** The texts the page has: the open editors, unsaved or not. Others are asked for. */
  files: Record<string, string>
  /** The page the preview shows, 1-based: laid out first (chapter 05 §7.2). */
  visiblePage: number
}

/** The worker to the page. */
export type FromEngine =
  | { type: 'ready'; ms: number }
  | { type: 'needs-file'; revision: number; path: string }
  | { type: 'finished'; revision: number; outcome: CompileOutcome }
  | { type: 'superseded'; revision: number }
  /** The engine could not be started or crashed; the page falls back to the server's LilyPond. */
  | { type: 'failed'; message: string }

/** The core is linked with `--max-memory=268435456`: B4's declared maximum, 256 MiB. */
export const MAX_MEMORY = 256 * 2 ** 20

/** What `lily_step` returns. */
export const Step = { Done: 0, More: 1, Needs: 2 } as const

/** What `lily_needs` names, and what `lily_put` gives. */
export const Need = { File: 0, Module: 1 } as const

/**
 * The core's exports: a C ABI over linear memory, without wasm-bindgen.
 * Strings are UTF-8, given as a pointer and a length the engine allocated.
 */
export interface EngineExports {
  memory: WebAssembly.Memory
  lily_alloc(len: number): number
  lily_free(ptr: number, len: number): void
  /** Restores the heap image; every compile after a crash starts again from here. 0 when it worked. */
  lily_start(image: number, len: number): number
  /**
   * A source file (`Need.File`) or a part or pack (`Need.Module`); the engine
   * copies the bytes. `data` 0 says there is no such file.
   */
  lily_put(kind: number, name: number, nameLen: number, data: number, dataLen: number): void
  /** Starts compiling `root`; work already done for an earlier revision is reused (chapter 02 §5.7). */
  lily_compile(revision: number, root: number, rootLen: number, visiblePage: number): void
  /** Works for about `budgetMs`, then returns at a point where it can be superseded. */
  lily_step(budgetMs: number): number
  /** After `Step.Needs`: writes the kind, name pointer and name length at `out`, three u32. */
  lily_needs(out: number): void
  /** After `Step.Done`: how many output files there are. */
  lily_outputs(): number
  /** Writes the name pointer and length, then the data pointer and length, of output `i` at `out`. */
  lily_output(i: number, out: number): void
}

/**
 * The output files of a compile, as LilyPond names them beside the score:
 * `<base>.svg` or `<base>-<n>.svg`, `<base>.midi`, `<base>.timing.json`, and
 * `stderr`, written in LilyPond's own format (D6) so that every parser of it
 * reads the engine's as well, and `diagnostics.json`, the same as
 * `LyDiagnostic[]`.
 */
export type EngineOutputs = Map<string, Uint8Array>

export type { LyDiagnostic }
