\version "2.24.0"

% The sample score of the end-to-end pass (test/e2e/smoke.test.ts) and of the
% README screenshots: two staves, lyrics, a page of its own for the coda, MIDI.

\header {
  title = "Sample"
  composer = "lily"
  tagline = ##f
}

melody = \relative c'' {
  \key g \major
  \time 3/4
  g4 a b | d2 b4 | a4( g) fis | g2. |
  \pageBreak
  b4 c d | e2 d4 | c4 b a | g2. \bar "|."
}

words = \lyricmode {
  One two three, go -- ing, up and down __ here.
  Four five six, turn -- ing, down and home now.
}

bass = \relative c {
  \clef bass
  \key g \major
  \time 3/4
  g2. | b2. | d2. | g,2. |
  g'2. | c,2. | d2. | g,2. \bar "|."
}

\score {
  <<
    \new Staff \new Voice = "tune" { \melody }
    \new Lyrics \lyricsto "tune" { \words }
    \new Staff { \bass }
  >>
  \layout { }
  \midi { \tempo 4 = 96 }
}
