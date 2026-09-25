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
