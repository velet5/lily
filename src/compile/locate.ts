import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

// Resolves the lilypond executable (DECISIONS D9): explicit setting → PATH →
// well-known install directories. Called on every compile rather than cached, so
// a settings change or a fresh install is picked up without a reload.

export type BinarySource = 'setting' | 'path' | 'well-known'

export interface LocatedBinary {
  /** Absolute path of the executable. */
  path: string
  source: BinarySource
}

export interface LocateOptions {
  /** Value of `lily.lilypond.path`; empty or undefined means "not configured". */
  configuredPath?: string
  /** Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Overrides the built-in install directories (tests pass `[]`). */
  wellKnownDirs?: readonly string[]
}

export class LilyPondNotFoundError extends Error {
  /** The configured value that failed to resolve; undefined when nothing was configured. */
  readonly configuredPath: string | undefined

  constructor(message: string, configuredPath?: string) {
    super(message)
    this.name = 'LilyPondNotFoundError'
    this.configuredPath = configuredPath
  }
}

const isWindows = process.platform === 'win32'

export async function locateLilyPond(options: LocateOptions = {}): Promise<LocatedBinary> {
  const env = options.env ?? process.env
  const configured = options.configuredPath?.trim()

  // A configured value that does not resolve is an error, not a reason to fall
  // back: silently compiling with a different binary would hide the mistake.
  if (configured) {
    const found = await resolveConfigured(configured, env)
    if (found) return { path: found, source: 'setting' }
    throw new LilyPondNotFoundError(
      `The configured LilyPond path "${configured}" is not an executable file.`,
      configured,
    )
  }

  const onPath = await findInDirs(pathDirs(env), 'lilypond')
  if (onPath) return { path: onPath, source: 'path' }

  const wellKnown = await findInDirs(options.wellKnownDirs ?? defaultInstallDirs(env), 'lilypond')
  if (wellKnown) return { path: wellKnown, source: 'well-known' }

  throw new LilyPondNotFoundError(
    'LilyPond was not found on PATH or in the usual install locations.',
  )
}

/** The setting may be an executable, an install or `bin` directory, or a bare command name. */
async function resolveConfigured(
  configured: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  const expanded = expandHome(configured)
  const isBareName = !path.isAbsolute(expanded) && !/[\\/]/.test(expanded)
  if (isBareName) return findInDirs(pathDirs(env), expanded)

  const target = path.resolve(expanded)
  if (await isDirectory(target)) {
    return findInDirs([target, path.join(target, 'bin')], 'lilypond')
  }
  return findInDirs([path.dirname(target)], path.basename(target))
}

async function findInDirs(dirs: readonly string[], name: string): Promise<string | undefined> {
  for (const dir of dirs) {
    for (const candidate of executableNames(name)) {
      const file = path.join(dir, candidate)
      if (await isExecutableFile(file)) return file
    }
  }
  return undefined
}

function executableNames(name: string): string[] {
  if (!isWindows || /\.exe$/i.test(name)) return [name]
  return [`${name}.exe`, name]
}

function pathDirs(env: NodeJS.ProcessEnv): string[] {
  // On Windows the variable is usually spelled `Path`; only process.env itself
  // is case-insensitive, a copy of it is not.
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH')
  const value = key ? env[key] : undefined
  return (value ?? '').split(path.delimiter).filter((dir) => dir.length > 0)
}

function defaultInstallDirs(env: NodeJS.ProcessEnv): string[] {
  switch (process.platform) {
    case 'darwin':
      // A VS Code started from the Dock may not see the shell's PATH additions.
      return [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/opt/local/bin',
        '/Applications/LilyPond.app/Contents/Resources/bin',
      ]
    case 'win32':
      return [env['ProgramFiles'], env['ProgramFiles(x86)']]
        .filter((root): root is string => Boolean(root))
        .map((root) => path.join(root, 'LilyPond', 'usr', 'bin'))
    default:
      return ['/usr/local/bin', '/usr/bin', path.join(os.homedir(), '.local', 'bin')]
  }
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2))
  return value
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory()
  } catch {
    return false
  }
}

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    if (!(await fs.stat(file)).isFile()) return false
    await fs.access(file, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}
