%% Where every note of the MIDI is on the page (DECISIONS D26). Passed to the
%% preview compile as -dinclude-settings, so it is parsed before the score and
%% its top-level \midi block becomes part of every \midi block of the score.
%%
%% The performer sits in the Score context of the MIDI performance and hears
%% every rhythmic event of every voice below it: notes, rests, skips, lyrics.
%% For each it records the moment in the performance (which is what the .midi
%% file is made from, unfolded repeats included) and the same textedit link
%% that the SVG backend writes for the grob the event caused, so the webview
%% can find the element again by its href. Bar starts are recorded from the
%% timing variables. The file <output-name>.timing.json, one array entry per
%% \midi performance in the order lilypond writes the .midi files, lands in the
%% output directory, where lilypond has changed to. Nothing here may fail a
%% compile: everything that writes is wrapped, and an error only loses the map.

#(begin
  (define lily-timing-performances '())
  (define lily-timing-output-name #f)

  (define (lily-timing-json-string text)
    (string-append
     "\""
     (string-concatenate
      (map (lambda (char)
             (case char
               ((#\") "\\\"")
               ((#\\) "\\\\")
               ((#\newline) "\\n")
               ((#\return) "\\r")
               ((#\tab) "\\t")
               (else (if (< (char->integer char) 32)
                         (format #f "\\u~4,'0x" (char->integer char))
                         (string char)))))
           (string->list text)))
     "\""))

  (define (lily-timing-json-number value)
    (let ((inexact (exact->inexact value)))
      (if (and (integer? inexact) (< (abs inexact) 1e15))
          (number->string (inexact->exact inexact))
          (number->string inexact))))

  ;; The link the SVG backend writes for a grob that `origin` caused
  ;; (grob-cause in output-svg.scm), spelled the same way.
  (define (lily-timing-href origin)
    (let* ((location (ly:input-file-line-char-column origin))
           (raw-file (car location))
           (file (if (is-absolute? raw-file)
                     raw-file
                     (string-append (ly-getcwd) "/" raw-file))))
      (format #f "textedit://~a:~a:~a:~a"
              (ly:string-percent-encode (ly:string-substitute "\\" "/" file))
              (cadr location)
              (caddr location)
              (1+ (cadddr location)))))

  ;; ly:duration-length became ly:duration->moment in 2.25.
  (define lily-timing-duration->moment
    (if (defined? 'ly:duration->moment) ly:duration->moment ly:duration-length))

  (define (lily-timing-main moment) (ly:moment-main moment))

  (define (lily-timing-grace moment) (ly:moment-grace moment))

  (define (lily-timing-event->json event)
    (format #f "{\"href\":~a,\"at\":~a,\"grace\":~a,\"length\":~a}"
            (lily-timing-json-string (car event))
            (lily-timing-json-number (cadr event))
            (lily-timing-json-number (caddr event))
            (lily-timing-json-number (cadddr event))))

  (define (lily-timing-bar->json bar)
    (format #f "{\"at\":~a,\"number\":~a}"
            (lily-timing-json-number (car bar))
            (lily-timing-json-number (cdr bar))))

  (define (lily-timing-performance->json performance)
    (format #f "{\"events\":[~a],\"bars\":[~a]}"
            (string-join (map lily-timing-event->json (car performance)) ",")
            (string-join (map lily-timing-bar->json (cdr performance)) ",")))

  (define (lily-timing-write! events bars)
    (let ((name (ly:parser-output-name)))
      ;; One file per lilypond run; a second file in the same process starts over.
      (unless (equal? name lily-timing-output-name)
        (set! lily-timing-output-name name)
        (set! lily-timing-performances '()))
      (set! lily-timing-performances
            (append lily-timing-performances (list (cons events bars))))
      (with-output-to-file (string-append (basename name) ".timing.json")
        (lambda ()
          (display "[")
          (display (string-join (map lily-timing-performance->json lily-timing-performances) ","))
          (display "]\n")))))

  (define (Lily_timing_performer context)
    (let ((events '())
          (bars '())
          (last-bar #f))
      (make-performer
       ((initialize performer)
        (ly:add-listener
         (lambda (event)
           ;; An error here would fail the compile; it only loses the map.
           (when events
             (catch #t
               (lambda ()
                 (let ((origin (ly:event-property event 'origin))
                       (duration (ly:event-property event 'duration #f)))
                   (when (ly:input-location? origin)
                     (let ((now (ly:context-current-moment context))
                           (length (if (ly:duration? duration)
                                       (lily-timing-duration->moment duration)
                                       ZERO-MOMENT)))
                       ;; A grace note's length counts in grace time; the
                       ;; webview knows from `grace` which it is. A syllable
                       ;; has a length of its own that says nothing about its
                       ;; note: 0 means "until the next moment".
                       (set! events
                             (cons (list (lily-timing-href origin)
                                         (lily-timing-main now)
                                         (lily-timing-grace now)
                                         (if (ly:in-event-class? event 'lyric-event)
                                             0
                                             (lily-timing-main length)))
                                   events))))))
               (lambda (key . args)
                 (ly:warning "playback map: ~a ~a" key args)
                 (set! events #f)))))
         (ly:context-events-below context)
         'rhythmic-event))
       ((stop-translation-timestep performer)
        (let ((number (ly:context-property context 'currentBarNumber #f))
              (position (ly:context-property context 'measurePosition #f)))
          (when (and (integer? number) (ly:moment? position) (not (equal? number last-bar)))
            (set! last-bar number)
            ;; The bar began measurePosition ago, whether or not anything happened then.
            (set! bars (cons (cons (- (lily-timing-main (ly:context-current-moment context))
                                      (lily-timing-main position))
                                   number)
                             bars)))))
       ((finalize performer)
        (catch #t
          (lambda () (when events (lily-timing-write! (reverse events) (reverse bars))))
          (lambda (key . args)
            (ly:warning "could not write the playback map: ~a ~a" key args)))))))
)

\midi {
  \context {
    \Score
    \consists #Lily_timing_performer
  }
}
