;; Private 2.26.0 classic SVG hook. The host verifies output-svg.scm's SHA-256
;; before loading this file; this second guard also protects manual loading.
(use-modules (lily output-svg) (ice-9 regex))
(define lily-preview-cache-installed? #f)
(when (equal? (lilypond-version) "2.26.0")
  (let* ((module (resolve-module '(lily output-svg)))
         (original (module-ref module 'cache-font #f))
         (defs (module-ref module 'svg-defs #f))
         (extract (module-ref module 'extract-glyph #f))
         (element-regexp (module-ref module 'glyph-element-regexp #f)))
    (when (and (procedure? original)
               (equal? (procedure-minimum-arity original) '(3 0 #f))
               (procedure? defs)
               (equal? (procedure-minimum-arity defs) '(1 0 #f))
               (procedure? extract)
               (equal? (procedure-minimum-arity extract) '(3 0 #t))
               (procedure? element-regexp)
               (equal? (procedure-minimum-arity element-regexp) '(1 0 #f)))
      (let ((cache (make-hash-table))
            (definitions (make-hash-table))
            (elements (make-hash-table)))
        (call-after-session
          (lambda ()
            (hash-clear! cache)
            (hash-clear! definitions)
            (hash-clear! elements)))
        ;; cached-file-contents returns the same string within a session. Keep
        ;; its defs once, instead of scanning/copying the SVG font per glyph.
        (module-set! module 'svg-defs
          (lambda (font)
            (or (hashq-ref definitions font #f)
                (let ((value (defs font)))
                  (hashq-set! definitions font value)
                  value))))
        ;; Cache the glyph's XML, not its positioned output. The upstream
        ;; extractor still runs for every request, including cumulative advance,
        ;; offsets, scaling, spaces and errors. Its regex now scans one element
        ;; instead of the entire font, even when a glyph is used at a new size.
        (module-set! module 'extract-glyph
          (lambda (all-glyphs name size . rest)
            (let* ((font-cache
                     (or (hashq-ref elements all-glyphs #f)
                         (let ((table (make-hash-table)))
                           (hashq-set! elements all-glyphs table)
                           table)))
                   (element
                     (or (hash-ref font-cache name #f)
                         (let ((match (regexp-exec
                                        (element-regexp (regexp-quote name))
                                        all-glyphs)))
                           (if match
                               (let ((value (match:substring match)))
                                 (hash-set! font-cache name value)
                                 value)
                               all-glyphs)))))
              (apply extract element name size rest))))
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
