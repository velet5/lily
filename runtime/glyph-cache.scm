;; Private 2.26.0 classic SVG hook. The host verifies output-svg.scm's SHA-256
;; before loading this file; this second guard also protects manual loading.
(use-modules (lily output-svg))
(define lily-preview-cache-installed? #f)
(when (equal? (lilypond-version) "2.26.0")
  (let* ((module (resolve-module '(lily output-svg)))
         (original (module-ref module 'cache-font #f)))
    (when (and (procedure? original)
               (equal? (procedure-minimum-arity original) '(3 0 #f)))
      (let ((cache (make-hash-table)))
        (call-after-session (lambda () (hash-clear! cache)))
        (module-set! module 'cache-font
          (lambda (font size glyph)
            ;; Lists change cumulative horizontal advance. Unknown types also
            ;; retain the original behavior, including its errors.
            (if (not (string? glyph))
                (original font size glyph)
                (let* ((key (list font size glyph))
                       (value (hash-ref cache key #f)))
                  (or value
                      (let ((value (original font size glyph)))
                        (hash-set! cache key value)
                        value))))))
        (set! lily-preview-cache-installed? #t)))))
