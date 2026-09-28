// Types that the extension and Lily Studio both use (DECISIONS D53): the
// diagnostics of a compile, a place in a source file and the playback map.
// Neither `vscode` nor Node, like span.ts.

export type LySeverity = 'error' | 'warning'

export interface LyDiagnostic {
  /** Absolute path; the root file for messages that carry no location. */
  file: string
  /** 1-based; 1 for messages that carry no location. */
  line: number
  /**
   * As lilypond prints it: 1-based, counted in code points with tabs advancing
   * to the next multiple of 8. Convert with `columnToCharacter`. Absent when the
   * message names only a line, or no location at all.
   */
  column?: number
  severity: LySeverity
  /** Without the severity keyword; continuation lines are joined with `\n`. */
  message: string
}

/** A place in a source file, in the numbers LilyPond prints. */
export interface SourceLocation {
  /** Absolute and decoded. */
  file: string
  /** 1-based. */
  line: number
  /** 0-based, in code points, tabs not expanded: the `CHAR` field. */
  char: number
}

/**
 * Where the notes of a MIDI file are on the pages (D26), as `runtime/timing.ly`
 * writes it: every rhythmic event of the performance with the `textedit:` link
 * of the element it produced, and the bar starts. Moments are whole notes.
 */
export interface PlaybackTiming {
  events: TimedEvent[]
  bars: TimedBar[]
  /** What each staff says about its MIDI track, in track order after the first (D48). */
  staves?: TimedStaff[]
}

export interface TimedEvent {
  href: string
  /** When the event begins in the performance; `grace` is the grace part, 0 or negative. */
  at: number
  grace: number
  /** Its written length, in grace time for a grace note. */
  length: number
}

export interface TimedBar {
  at: number
  number: number
}

export interface TimedStaff {
  /** `\new Staff = "id"`; empty when it has none. */
  id: string
  /** `instrumentName` and `shortInstrumentName` as plain text, at its first note. */
  name: string
  shortName: string
  /** The context it is in, such as `PianoStaff` or `ChoirStaff`, and which one of the score's groups; `''` and -1 at the top. */
  group: string
  groupIndex: number
  /** The clef glyph at its first note, such as `clefs.F`; `''` when it plays nothing. */
  clef: string
  clefTransposition: number
  /** The ids of the voices that played notes in it, `''` for one without. */
  voices: string[]
}
