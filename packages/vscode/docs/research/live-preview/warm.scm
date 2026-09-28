;; Research only: stdin requests are (absolute-source absolute-output-dir last8?).
;; No network listener; only the parent Python probe writes these requests.
(define probe-fork? (string-prefix? "fork" (getenv "LILY_PROBE_MODE")))
(when (getenv "LILY_PROBE_CACHE") (load (getenv "LILY_PROBE_CACHE")))
(unless probe-fork?
  (ly:reset-all-fonts)
  (ly:parse-init "declarations-init.ly"))
(define probe-options (ly:all-options))
(display "READY\n")
(force-output)
(let loop ()
  (let ((request (read)))
    (unless (eof-object? request)
      (let ((run
             (lambda ()
               (chdir (cadr request))
               (when (caddr request) (ly:set-option 'last "R1*8"))
               (if probe-fork?
                   (if (null? (lilypond-all (list (car request)))) 0 1)
                   (let ((status
                          (catch 'ly-file-failed
                            (lambda () (ly:parse-file (car request)) 0)
                            (lambda args 1))))
                     (ly:check-expected-warnings)
                     ((@@ (lily) session-terminate))
                     (ly:reset-options probe-options)
                     (ly:reset-all-fonts)
                     status)))))
        (let ((status
               (if probe-fork?
                   (let ((pid (primitive-fork)))
                     (if (= pid 0)
                         (primitive-exit (run))
                         (cdr (waitpid pid))))
                   (run))))
          (format #t "DONE ~a\n" status)
          (force-output)))
      (loop))))
(primitive-exit 0)
