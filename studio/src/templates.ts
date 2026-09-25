// The scores File › New starts from. Each compiles as it is with LilyPond
// 2.24 and later, so a new user sees music in the preview straight away.

export type TemplateId = 'melody' | 'song' | 'piano'

export interface Template {
  id: TemplateId
  /** Shown in the New Score menu. */
  label: string
  text: string
}

const VERSION = '\\version "2.24.0"'

export const TEMPLATES: readonly Template[] = [
  {
    id: 'melody',
    label: 'Melody',
    text: `${VERSION}

\\header {
  title = "Untitled"
}

\\relative c' {
  \\clef treble
  \\key c \\major
  \\time 4/4
  c4 d e f | g2 g | a4 a a a | g1 |
}
`,
  },
  {
    id: 'song',
    label: 'Song with Lyrics',
    text: `${VERSION}

\\header {
  title = "Untitled Song"
}

melody = \\relative c' {
  \\key g \\major
  \\time 3/4
  d4 g a | b2 a4 | g2. |
}

words = \\lyricmode {
  Sing a -- long | with me | now |
}

\\score {
  <<
    \\new Voice = "melody" { \\melody }
    \\new Lyrics \\lyricsto "melody" { \\words }
  >>
  \\layout { }
  \\midi { }
}
`,
  },
  {
    id: 'piano',
    label: 'Piano',
    text: `${VERSION}

\\header {
  title = "Untitled Piece"
}

upper = \\relative c'' {
  \\clef treble
  \\key c \\major
  \\time 4/4
  c4 e g e | f2 d |
}

lower = \\relative c {
  \\clef bass
  \\key c \\major
  \\time 4/4
  c2 g' | f2 g |
}

\\score {
  \\new PianoStaff <<
    \\new Staff = "upper" \\upper
    \\new Staff = "lower" \\lower
  >>
  \\layout { }
  \\midi { }
}
`,
  },
]

/**
 * The welcome screen's sample (DECISIONS D37): a tune everyone knows, with
 * words, chords and playback, and comments that explain each part.
 */
export const SAMPLE = {
  name: 'Ode to Joy.ly',
  text: `${VERSION}

% Lines that start with % are notes to yourself; LilyPond skips them.

\\header {
  title = "Ode to Joy"
  composer = "Ludwig van Beethoven"
}

% The tune. Letters are notes, the number after a note is its length
% (4 = quarter, 2 = half, 4. = dotted quarter, 8 = eighth), and | marks a bar.
melody = \\relative c'' {
  \\clef treble
  \\key g \\major
  \\time 4/4
  \\tempo 4 = 112
  b4 b c d | d c b a | g g a b | b4. a8 a2 |
  b4 b c d | d c b a | g g a b | a4. g8 g2 \\bar "|."
}

% The words, one syllable per note; -- joins the syllables of a word.
words = \\lyricmode {
  Joy -- ful, joy -- ful, we a -- dore thee,
  God of glo -- ry, Lord of love;
  Hearts un -- fold like flowers be -- fore thee,
  Op -- 'ning to the sun a -- bove.
}

% Chord names above the staff: 1 is a whole bar, 2 half a bar.
harmony = \\chordmode {
  g1 | c2 d | g1 | d1 |
  g1 | c2 d | g1 | d2 g |
}

\\score {
  <<
    \\new ChordNames \\harmony
    \\new Staff \\new Voice = "tune" \\melody
    \\new Lyrics \\lyricsto "tune" \\words
  >>
  \\layout { }
  % Press play under the score to hear it.
  \\midi { }
}
`,
}
