import * as path from 'node:path'
import { parseArgs } from 'node:util'
import { CompileService } from '../../src/compile/compiler'
import { check, type CheckReport } from './check'
import { serveMcp } from './mcp'

// `lily-check`: the editor's compile and diagnostics without an editor
// (DECISIONS D11, D22). Built to dist/lily-check.js; main.ts is the entry.

export const USAGE = `Usage:
  lily-check compile <file.ly> [options] [-- <lilypond arguments>]
  lily-check mcp

compile   Compile to SVG and report what lilypond said.
  --json             Print one JSON document instead of text.
  --out-dir <dir>    Where the pages go. Default: a directory per file under the
                     system's temp directory, emptied on every run.
  -I, --include <dir>  Add a directory to the \\include search path; repeatable.
  --lilypond <path>  The lilypond executable or its directory. Default:
                     $LILYPOND_PATH, then PATH, then the usual install places.
mcp       Serve the same check as the MCP tool "lilypond_compile" on stdio.

Exit code: 0 compiled, 1 lilypond reported errors, 2 lilypond did not run.
`

export const EXIT = { ok: 0, failed: 1, notRun: 2 } as const

export interface CliIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** For `mcp`; default to the process's own. */
  input?: NodeJS.ReadableStream
  output?: NodeJS.WritableStream
}

export interface CompileCommand {
  file: string
  json: boolean
  outDir?: string
  lilypondPath?: string
  extraArgs: string[]
}

/** Throws an `Error` whose message is fit to print above the usage. */
export function parseCompileArgs(argv: readonly string[], cwd: string): CompileCommand {
  // Everything after `--` is lilypond's, whatever it looks like.
  const split = argv.indexOf('--')
  const own = split < 0 ? argv : argv.slice(0, split)
  const passed = split < 0 ? [] : argv.slice(split + 1)
  const { values, positionals } = parseArgs({
    args: [...own],
    allowPositionals: true,
    options: {
      json: { type: 'boolean', default: false },
      'out-dir': { type: 'string' },
      include: { type: 'string', short: 'I', multiple: true, default: [] },
      lilypond: { type: 'string' },
    },
  })
  if (positionals.length !== 1) {
    throw new Error(positionals.length === 0 ? 'No file given.' : 'One file at a time, please.')
  }
  return {
    file: positionals[0],
    json: values.json,
    outDir: values['out-dir'],
    lilypondPath: values.lilypond,
    // lilypond runs in the score's directory (D15); resolve against ours.
    extraArgs: [...values.include.map((dir) => `--include=${path.resolve(cwd, dir)}`), ...passed],
  }
}

/** Runs one command and resolves with the exit code; never rejects. */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const cwd = io.cwd ?? process.cwd()
  const env = io.env ?? process.env
  const [command, ...rest] = argv

  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    io.stdout(USAGE)
    return command === undefined ? EXIT.notRun : EXIT.ok
  }
  if (command === 'mcp') {
    await serveMcp({ input: io.input ?? process.stdin, output: io.output ?? process.stdout, cwd, env })
    return EXIT.ok
  }
  if (command !== 'compile') {
    io.stderr(`Unknown command "${command}".\n\n${USAGE}`)
    return EXIT.notRun
  }

  let parsed: CompileCommand
  try {
    parsed = parseCompileArgs(rest, cwd)
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    return EXIT.notRun
  }

  const service = new CompileService()
  try {
    const report = await check(service, {
      file: parsed.file,
      cwd,
      lilypondPath: parsed.lilypondPath ?? env.LILYPOND_PATH,
      extraArgs: parsed.extraArgs,
      outDir: parsed.outDir,
    })
    io.stdout(parsed.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report, cwd))
    return report.error ? EXIT.notRun : report.ok ? EXIT.ok : EXIT.failed
  } finally {
    await service.dispose()
  }
}

/** The report for a person: lilypond's own `file:line:col:` lines, then a summary. */
export function formatReport(report: CheckReport, cwd: string): string {
  if (report.error) return `${report.error.message}\n`

  const lines: string[] = []
  for (const d of report.diagnostics) {
    const place = [path.relative(cwd, d.file) || d.file, d.line, ...(d.column ? [d.column] : [])]
    lines.push(`${place.join(':')}: ${d.severity}: ${d.message.replace(/\n/g, '\n    ')}`)
    if (d.source !== undefined) lines.push(`    ${d.source.trim()}`)
  }
  if (report.stderr) lines.push(report.stderr.trimEnd())

  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
  const seconds = (report.durationMs / 1000).toFixed(1)
  lines.push(
    `${report.ok ? 'OK' : 'FAILED'}: ${count(report.errorCount, 'error')}, ` +
      `${count(report.warningCount, 'warning')}, ${count(report.pages.length, 'page')} in ${seconds} s`,
  )
  lines.push(...[...report.pages, ...report.midi].map((file) => `  ${file}`))
  return `${lines.join('\n')}\n`
}
