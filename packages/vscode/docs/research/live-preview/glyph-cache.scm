;; Research-only wrapper around a private LilyPond 2.26 SVG function.
;; Cache named glyphs only; list glyphs update cumulative horizontal advance
;; and must follow the original path. Each process handles one compilation.
(use-modules (lily output-svg))
(let* ((module (resolve-module '(lily output-svg)))
       (original (module-ref module 'cache-font))
       (cache (make-hash-table)))
  (call-after-session (lambda () (hash-clear! cache)))
  (module-set! module 'cache-font
    (lambda (font size glyph)
      (if (list? glyph)
          (original font size glyph)
          (let* ((key (list font size glyph))
                 (value (hash-ref cache key #f)))
            (or value
                (let ((value (original font size glyph)))
                  (hash-set! cache key value)
                  value)))))))
