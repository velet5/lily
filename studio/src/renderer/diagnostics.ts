// From compile outcomes to what the renderer shows (DECISIONS D31): markers for
// Monaco, and the compile part of the status line. No Monaco and no DOM here,
// so the tests run it under plain Node; editor.ts applies the markers.
import type { LyDiagnostic } from '../../../src/diagnostics/parse'
import { diagnosticSpan } from '../../../src/diagnostics/span'
import type { CompileEvent, CompileOutcome } from '../ipc'

/** Monaco's IMarkerData, with the severity by name; editor.ts maps it. */
export interface Marker {
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
  message: string
  severity: LyDiagnostic['severity']
}

/**
 * Markers for one file. `lineAt` returns the text of a 1-based line, or
 * undefined past the end; a diagnostic there marks the last line, so it stays
 * visible after lines were deleted.
 */
export function toMarkers(
  diagnostics: readonly LyDiagnostic[],
  lineAt: (line: number) => string | undefined,
  lineCount: number,
): Marker[] {
  return diagnostics.map((diagnostic) => {
    const line = Math.min(diagnostic.line, Math.max(1, lineCount))
    const text = lineAt(line) ?? ''
    // Past the end of the file the column no longer means anything.
    const span = diagnosticSpan(text, line === diagnostic.line ? diagnostic.column : undefined)
    // An empty line has an empty span; Monaco then widens the marker itself.
    return {
      startLineNumber: line,
      startColumn: span.start + 1,
      endLineNumber: line,
      endColumn: span.end + 1,
      message: diagnostic.message,
      severity: diagnostic.severity,
    }
  })
}

/**
 * The diagnostics of the last finished compile of each score, by file. Two
 * scores that include one file both report into it; a newer compile of a score
 * replaces only that score's diagnostics.
 */
export class DiagnosticStore {
  private readonly byRoot = new Map<string, Map<string, LyDiagnostic[]>>()

  /** Takes `outcome` in; returns the files whose diagnostics may have changed. */
  update(outcome: CompileOutcome): string[] {
    // A save that compiled nothing leaves what the last compiles found.
    if (outcome.state === 'no-root') return []
    const before = this.byRoot.get(outcome.rootFile)
    const byFile = new Map<string, LyDiagnostic[]>()
    for (const diagnostic of outcome.diagnostics) {
      const list = byFile.get(diagnostic.file) ?? []
      list.push(diagnostic)
      byFile.set(diagnostic.file, list)
    }
    this.byRoot.set(outcome.rootFile, byFile)
    return [...new Set([...(before?.keys() ?? []), ...byFile.keys()])]
  }

  for(file: string): LyDiagnostic[] {
    return [...this.byRoot.values()].flatMap((byFile) => byFile.get(file) ?? [])
  }

  /** The first error of a score's last compile, else its first warning. */
  first(rootFile: string): LyDiagnostic | undefined {
    const all = [...(this.byRoot.get(rootFile)?.values() ?? [])].flat()
    return all.find((d) => d.severity === 'error') ?? all[0]
  }
}

export type Tone = 'busy' | 'ok' | 'warning' | 'error'

export interface CompileStatus {
  text: string
  tone: Tone
  /** Longer text for the tooltip. */
  detail?: string
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

/** What the status line says about a compile; `name` shortens a path for display. */
export function compileStatus(event: CompileEvent, name: (file: string) => string): CompileStatus {
  if (event.kind === 'started') return { text: `Engraving ${name(event.rootFile)}…`, tone: 'busy' }
  const outcome = event.outcome
  const score = name(outcome.rootFile)
  switch (outcome.state) {
    case 'no-root':
      return { text: `Saved — no score includes ${score}`, tone: 'warning' }
    case 'no-lilypond':
      return { text: 'LilyPond is not installed', tone: 'error', detail: outcome.message }
    case 'error':
      return { text: 'LilyPond could not run', tone: 'error', detail: outcome.message }
    case 'ok':
    case 'failed': {
      const counts = [
        outcome.errorCount ? plural(outcome.errorCount, 'error') : '',
        outcome.warningCount ? plural(outcome.warningCount, 'warning') : '',
      ].filter(Boolean)
      const seconds = `${(outcome.durationMs / 1000).toFixed(1)} s`
      if (outcome.state === 'failed') {
        const why = counts.length ? counts.join(', ') : 'LilyPond failed'
        return { text: `${score}: ${why}`, tone: 'error', detail: outcome.message }
      }
      return counts.length
        ? { text: `${score}: engraved with ${counts.join(', ')}`, tone: 'warning' }
        : { text: `${score}: engraved in ${seconds}`, tone: 'ok' }
    }
  }
}
