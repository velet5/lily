\version "2.24.0"

\include "parts/broken-part.ily"

\score {
  \new Staff {
	\brokenPart c4 \undefinedCommand d
    c2. c2 | c1
  }
  \layout { }
}
