% Grammar snapshot input: embedded Scheme. Must stay compilable.
\version "2.24.0"

#(set-global-staff-size 18)
#(define my-number -1.5)
#(define (double x) ; a Scheme comment, not a LilyPond one
   #! Guile block comment with (unbalanced "stuff
   !#
   (* 2 x))

#(define-public settings
   `((name . "quoted \"data\"") (size . ,(double 7)) (flag . #t) (hex . #x1F)))

accent =
#(define-music-function (music) (ly:music?)
   "Docstring with a ) paren."
   (let* ((ch #\a)
          (kw #:key))
     (if (ly:music? music)
         #{ \override NoteHead.color = #red $music -> \revert NoteHead.color #}
         music)))

\paper {
  #(set-paper-size "a4")
  top-margin = #(* 2 5)
}

\score {
  \new Staff {
    \set Staff.instrumentName = #"Oboe"
    \override Staff.TimeSignature.stencil = ##f
    \override Score.BarNumber.break-visibility = #'#(#f #t #t)
    \override TextScript.extra-offset = #'(1 . -2.5)
    \once \override NoteHead.color = #(rgb-color 1 0 0)
    \tweak font-size #-2 c'4 \accent d'4 $(make-music 'SkipEvent 'duration (ly:make-duration 2)) c'4
    c'4 #(if #f #f)
  }
}
