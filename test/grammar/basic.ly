% Grammar snapshot input: core LilyPond syntax. Must stay compilable.
\version "2.24.0"
\language "nederlands"

%{ block comment
   c4 \relative "not a string" %}

\header {
  title = "Snapshot \"quoted\" title"
  tagline = ##f
}

\paper {
  indent = 0\mm
  ragged-right = ##t
}

melody = \relative c'' {
  \clef treble \key bes \major \time 3/4
  \tempo "Allegro" 4. = 96
  \partial 4 f,8 g |
  a4. bes8 c4~ | c2 r4 | fis!2 ges?4 | <c, e g>2.-> |
  d8[ e f g] a4( | b2) s4 | c\breve*3/8 | R2.*4 |
  c4\p\< d-. e--\! | f4-1 g^2 a_\markup { \italic dolce } |
  c4:32 q4 \tuplet 3/2 { c8 d e } |
  \repeat volta 2 { c4\( d e\) } \alternative { { f2. } { g2. } }
  \bar "|."
}

upper-voice = { c'4 d' e' f' }

words = \lyricmode {
  \set stanza = "1."
  Do re | mi, a la -- la __ _ fa4 sol2.
  \markup { \bold a } be
}

harmonies = \chordmode { c1:m7 f:maj7.9 g:sus4 d:7/fis }

rhythm = \drummode { bd4 hh8 hh sn4 r }

\score {
  <<
    \new ChordNames \harmonies
    \new Staff = "main" \with {
      instrumentName = "Flute"
      \consists Span_stem_engraver
      \override TimeSignature.break-visibility = ##(#f #t #t)
    } <<
      \new Voice = "one" { \voiceOne \melody }
      \\
      \new Voice { \voiceTwo \upper-voice }
    >>
    \new Lyrics \lyricsto "one" { \words }
    \new Staff { g'4 a' b' } \addlyrics { so la si }
    \new DrumStaff \rhythm
  >>
  \layout {
    \context {
      \Staff
      \remove "Time_signature_engraver"
      \override Stem.details.beamed-lengths = #'(4 4 3)
    }
  }
  \midi { }
}

\markup \bold word
\markup "just a string"
\markup {
  \column { "Title" \with-color #red \fontsize #2 a b c }
  % a comment in markup
}
