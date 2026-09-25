// First-run LilyPond detection and the guided setup behind it (DECISIONS
// D37). Finds lilypond as the extension does (locate.ts, D9), asks it for its
// version, and keeps the one a user chose in the studio's settings file. No
// `electron` here, so the tests run it under plain Node; main.ts adds the
// dialogs and the links.
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { locateLilyPond, LilyPondNotFoundError, type BinarySource } from '../../../src/compile/locate'

/** The oldest LilyPond the templates and the sample compile with. */
export const MINIMUM_VERSION = '2.24.0'

/**
 * What the welcome screen and the setup say about LilyPond. `ready`: found
 * and new enough. `missing`: not found, or the chosen path is not lilypond.
 * `too-old` and `broken`: found, but older than MINIMUM_VERSION, or it did
 * not answer `--version`.
 */
export interface LilyPondStatus {
  state: 'ready' | 'missing' | 'too-old' | 'broken'
  /** The executable, when one was found. */
  path?: string
  version?: string
  source?: BinarySource
  /** The path chosen in the setup, when there is one. */
  chosen?: string
  /** One or two sentences for someone who has never used a terminal. */
  message: string
}

/** The pages the setup may open; main.ts opens nothing else. */
export const SETUP_LINKS = {
  download: 'https://lilypond.org/download.html',
  learn: 'https://lilypond.org/doc/v2.24/Documentation/learning/',
} as const

export type SetupLink = keyof typeof SETUP_LINKS

export interface DetectOptions {
  /** A path chosen in the setup, or `$LILYPOND_PATH`; else PATH and the usual places. */
  configuredPath?: string
  env?: NodeJS.ProcessEnv
  /** Overrides locate.ts's install directories (tests pass their own). */
  wellKnownDirs?: readonly string[]
  /** Runs `lilypond --version`; tests pass a stand-in. */
  version?(binary: string): Promise<string>
}

export async function detectLilyPond(options: DetectOptions = {}): Promise<LilyPondStatus> {
  const chosen = options.configuredPath?.trim() || undefined
  let binary: string
  let source: BinarySource
  try {
    ;({ path: binary, source } = await locateLilyPond({
      configuredPath: chosen,
      env: options.env,
      wellKnownDirs: options.wellKnownDirs,
    }))
  } catch (error) {
    if (!(error instanceof LilyPondNotFoundError)) throw error
    const message = chosen
      ? `The LilyPond you chose (${chosen}) could not be found any more. Choose it again, or install LilyPond.`
      : 'LilyPond, the program that engraves your music, is not installed on this Mac yet.'
    return { state: 'missing', message, ...(chosen ? { chosen } : {}) }
  }
  const found = { path: binary, source, ...(chosen ? { chosen } : {}) }
  let output: string
  try {
    output = await (options.version ?? runVersion)(binary)
  } catch {
    return { ...found, state: 'broken', message: `LilyPond was found at ${binary}, but it did not start. Installing it again usually helps.` }
  }
  const version = parseVersion(output)
  if (!version) {
    return { ...found, state: 'broken', message: `The program at ${binary} does not seem to be LilyPond.` }
  }
  if (compareVersions(version, MINIMUM_VERSION) < 0) {
    return {
      ...found,
      version,
      state: 'too-old',
      message: `LilyPond ${version} is installed, but Lily Studio needs ${MINIMUM_VERSION} or newer. Install the latest version.`,
    }
  }
  return { ...found, version, state: 'ready', message: `LilyPond ${version} is ready.` }
}

/** `GNU LilyPond 2.26.0 (running Guile 3.0)` → `2.26.0`. */
export function parseVersion(output: string): string | undefined {
  return /LilyPond\s+(\d+\.\d+(?:\.\d+)?)/i.exec(output)?.[1]
}

/** Negative, zero or positive, as `a` is older than, equal to or newer than `b`. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

function runVersion(binary: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, ['--version'], { timeout: 20_000, env: { ...process.env, LANGUAGE: 'en' } }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    )
  })
}

/**
 * What the setup's Choose LilyPond… dialog returned, as a path locate.ts
 * understands: an app bundle becomes the `bin` directory inside it. An
 * executable, an install directory or its `bin` directory pass as they are.
 */
export function choicePath(chosen: string): string {
  return /\.app\/?$/i.test(chosen) ? path.join(chosen, 'Contents', 'Resources', 'bin') : chosen
}

/**
 * The PATH for lilypond's children (gs for PDFs, among others). An app opened
 * from the Finder gets only `/usr/bin:/bin:/usr/sbin:/sbin`, so the
 * directories of Homebrew and MacPorts are added, and the found binary's own.
 */
export function searchPath(current: string | undefined, binaryDir?: string): string {
  const extra = process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'] : []
  const dirs = [...(binaryDir ? [binaryDir] : []), ...(current ?? '').split(path.delimiter), ...extra].filter(Boolean)
  return [...new Set(dirs)].join(path.delimiter)
}

/** The studio's settings: userData/settings.json. Only the chosen LilyPond so far. */
export interface Settings {
  lilypondPath?: string
}

export async function readSettings(file: string): Promise<Settings> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    if (typeof value !== 'object' || value === null) return {}
    const { lilypondPath } = value as Record<string, unknown>
    return typeof lilypondPath === 'string' && lilypondPath ? { lilypondPath } : {}
  } catch {
    // Missing or damaged: start again from nothing.
    return {}
  }
}

export async function writeSettings(file: string, settings: Settings): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(settings, null, 2)}\n`)
}
