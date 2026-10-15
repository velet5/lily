% Grammar snapshot input: the syntax that the 30 test scores of
% docs/research/wasm-engine never reach (chapter 02, §7). Must stay compilable.
\version "2.24.0"

%% Identifiers of every kind the lexer classifies by value (§2.3)
dur = #(ly:make-duration 3 1)
pit = #(ly:make-pitch 0 4 1/2)
table = #'((tempo . 60) (title . "Tabled"))
mods = \with { \consists Ambitus_engraver }
fermataUp = ^\fermata
"quoted name" = { c'4 }
mélodie = { \"quoted name" d'8 e' }
settings.size.extra = #3
hdr = \header { composer = "Someone" }

%% Music functions: optional arguments, \default, splicing and \etc
color = #(define-music-function (col music) ((color? red) ly:music?)
           #{ \override NoteHead.color = #col $music \revert NoteHead.color #})
pairUp = #(define-event-function (dir) (ly:dir?) #{ -\tweak direction #dir -. #})
twice = #(define-scheme-function (x) (number?) (* 2 x))
nothing = #(define-void-function () () (if #f #f))
colorBlue = \color #blue \etc
upTenuto = ^\tenuto
transposeUp = \transpose c d \etc
withAccent = \override Accidental.color = \etc
colorAny = \color \etc
width = #(define-scheme-function () () #{ 2\cm #})
\nothing

\markup bolditalic = \markup \bold \italic \etc
#(define-markup-command (boxed layout props text) (markup?)
   (interpret-markup layout props #{ \markup \box #text #}))

\header {
  title = \markup \bolditalic "Syntax"
  subtitle = #(assq-ref table 'title)
  tagline = ##f
}

\paper {
  line-width = 15\cm - 2\mm
  indent = 1\cm * 2
  short-indent = #(twice 3)
  left-margin = \width
}

\book {
  \bookpart {
    \header { piece = \hdr.composer }
    \score {
      \new Staff \with \mods \relative {
        \key d \major \time 2/4
        \tempo "Allegro" 4 = 60-72
        c''8 d\1 e-2 f\fermataUp g\upTenuto a b c
        \color { a4 } \color #green { b4 } \colorBlue { c4 } \colorAny \default { d4 }
        \withAccent #red cis4\pairUp #UP d!\=1( e?\=1) c='''4
        \transposeUp { c8 d } $(make-music 'SkipEvent 'duration (ly:make-duration 2))
        $@(list #{ e8 #} #{ f8 #}) <c \tweak color #red e>4:16 q2 c4\rest r R2*2
        \repeat tremolo 4 { c16 d } \repeat percent 2 { c8 d e f }
        \repeat unfold 2 { g4 } \repeat volta 2 { a4 b }
        \alternative { \volta 1 { c2 } \volta 2 { d2 } }
        \mélodie \tweak Stem.color #red e4 \tweak color #blue f |
        \once \override Staff.TimeSignature.color = #red
        \override Voice.NoteHead."color" = #blue
        \set Staff.instrumentName = \markup \boxed "Pno"
        \unset Staff.instrumentName
        \revert Staff.TimeSignature.color
        g2 \bar "|."
      }
      \layout {
        \context {
          \Staff
          \name "MyStaff"
          \alias Staff
          \type "Engraver_group"
          \description "A staff of our own"
          \defaultchild Voice
          \accepts Voice
          \denies Lyrics
        }
        \context { \Score \accepts MyStaff }
      }
    }
  }
  \bookpart {
    \score {
      <<
        \chords { c2:m7.9- c:maj9^5/+g d:sus4/fis c:1.5 }
        \new Staff \new Voice = "one" { c'4 d' e' f' }
        \new Lyrics \lyricsto "one" { "Quo" -- ted __ a_b \markup \italic it }
        \lyrics { One4 two }
        \drums { bd4 sn hh8 hh tomh4 }
        \figures { <6 4>4 <_+ [5 3]> <6\\ 5/ 4\+ 3!> <7 _!> }
        \new Staff \figuremode { <6>1 }
      >>
    }
    \markuplist \column-lines { first second }
    \markuplist { \bold "list" item }
    \markup \score { { c'4 } \layout { } }
    \markuplist \score-lines { { c'1 } }
  }
}

\include "deutsch.ly"
deutsch = \fixed c' { h4 b es as \pit c\dur \pit'8 \repeat unfold \settings.size.extra { c4*#1 } }
\markup \line { #@(list "spliced" "words") }
\score { \deutsch }
