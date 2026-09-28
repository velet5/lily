\version "2.24.0"

% Two pages, for the preview tests.
\score {
  \new Staff \relative c' {
    c4 d e f
    \pageBreak
    g1
  }
  \layout { }
}
