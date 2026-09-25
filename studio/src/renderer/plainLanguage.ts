// Plain-language summaries of lilypond's messages (DECISIONS D37): what went
// wrong and what to try, for someone who reads music, not compiler output.
// The markers and the status line show them above lilypond's own words. No
// DOM here, so the tests run it under plain Node.
import type { LyDiagnostic } from '../../../src/diagnostics/parse'

interface Rule {
  pattern: RegExp
  /** From the match to one or two short sentences. */
  explain(match: RegExpExecArray): string
}

/** Quoted as lilypond quotes: `name'. */
const QUOTED = '[`‘\']([^\'’]*)[\'’]'

const RULES: Rule[] = [
  {
    pattern: new RegExp(`^unknown command: ${QUOTED}`),
    explain: (m) => `“${m[1]}” is not a LilyPond command. Check its spelling, or whether a backslash is missing or extra.`,
  },
  {
    pattern: /^not a note name: (\S+)/,
    explain: (m) =>
      `“${m[1]}” is not a note. Notes are written in lowercase Dutch names: c d e f g a b, with -is for sharp and -es for flat (fis, bes).`,
  },
  {
    pattern: /^string outside of text script/,
    explain: () => 'Text stands among the notes. Put text above or below a note with ^"…" or _"…", or remove it.',
  },
  {
    pattern: /^syntax error, unexpected end of input/,
    explain: () => 'The score ends too early. A closing brace } is probably missing.',
  },
  {
    pattern: /^syntax error, unexpected '}'/,
    explain: () => 'There is a closing brace } too many, or something just before it is incomplete.',
  },
  {
    pattern: /^syntax error/,
    explain: () => 'LilyPond could not read the music here. Look for a typing mistake at this spot or just before it.',
  },
  {
    pattern: /^not a duration/,
    explain: () => 'This duration does not exist. Use 1, 2, 4, 8, 16, 32 or 64, with dots for dotted notes (4.).',
  },
  {
    pattern: new RegExp(`^cannot find file: ${QUOTED}`),
    explain: (m) => `The file “${m[1]}” named in \\include was not found. Check the name and that it is in the score's folder.`,
  },
  {
    pattern: /^bar check failed/,
    explain: () => 'The notes before this bar line do not fill the bar exactly. Count the beats in this bar and the one before it.',
  },
  {
    pattern: /^unterminated slur/,
    explain: () => 'A slur starts here with ( but never ends. Add ) after the last note of the slur.',
  },
  {
    pattern: /^cannot end slur/,
    explain: () => 'A slur ends here with ) but none was started. Add ( after the first note of the slur, or remove this ).',
  },
  {
    pattern: /^unterminated tie/,
    explain: () => 'A tie ~ here is not followed by the same note. Tie a note only to the same pitch.',
  },
  {
    pattern: /^unterminated (crescendo|decrescendo|diminuendo)/,
    explain: (m) => `A ${m[1]} starts here but never ends. End it with \\! or with a dynamic such as \\f.`,
  },
  {
    pattern: /^no \\version statement found/,
    explain: () => 'The first line should say which LilyPond version the score was written for. Add the \\version line this message suggests.',
  },
  {
    pattern: /^wrong type for argument/,
    explain: () => 'A command got the wrong kind of value, for example \\time 3 instead of \\time 3/4.',
  },
  {
    pattern: /^errors found, ignoring music expression/,
    explain: () => 'Because of the error above, this piece of music was left out.',
  },
]

/** The plain-language summary of a diagnostic, when its message is a known one. */
export function explain(diagnostic: Pick<LyDiagnostic, 'message'>): string | undefined {
  for (const rule of RULES) {
    const match = rule.pattern.exec(diagnostic.message)
    if (match) return rule.explain(match)
  }
  return undefined
}

/** A marker's text: the summary first, then what LilyPond said. */
export function markerMessage(diagnostic: Pick<LyDiagnostic, 'message'>): string {
  const plain = explain(diagnostic)
  return plain ? `${plain}\n\nLilyPond says: ${diagnostic.message}` : diagnostic.message
}
