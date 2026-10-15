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
      (let* ((cache (make-hash-table))
             (definitions (make-hash-table))
             (elements (make-hash-table))
             (page-glyphs (make-hash-table))
             (unit-length (assq 'set-unit-length
                                (module-ref module 'stencil-dispatch-alist '())))
             ;; Chapter 06 of docs/research/wasm-engine: a glyph is written once
             ;; per page, as a <defs> at its first use, and every use is a <use>
             ;; of it. Only when the loader defined `lily-glyph-reuse?' true:
             ;; the preview's pages stay what LilyPond writes, byte for byte (D25).
             (reuse?
               (and (module-ref (current-module) 'lily-glyph-reuse? #f)
                    (pair? unit-length)
                    (procedure? (cdr unit-length))
                    (equal? (procedure-minimum-arity (cdr unit-length)) '(1 0 #f))))
             ;; dump-path's output, the only form rewritten; anything else is kept.
             (glyph-path
               (make-regexp
                 "^<path transform=\"(translate\\([^)]*\\) )?scale\\((([^,)]*), [^)]*)\\)\" d=\"([^\"]*)\" fill=\"currentColor\"/>\n$"))
             ;; Letters, digits, `.' and `-' as they are, anything else as _hex_.
             (id-part
               (lambda (text)
                 (string-concatenate
                   (map (lambda (char)
                          (if (or (char-alphabetic? char) (char-numeric? char)
                                  (memv char '(#\. #\-)))
                              (string char)
                              (string-append
                                "_" (number->string (char->integer char) 16) "_")))
                        (string->list text)))))
             ;; The id names the font file, the glyph and its scale, so a glyph
             ;; defined on two pages is the same element twice.
             (reuse
               (lambda (font glyph text)
                 (let* ((name (if (pair? glyph) (car (last-pair glyph)) glyph))
                        (match (and reuse? (string? text) (string? font) (string? name)
                                    (regexp-exec glyph-path text))))
                   (if (not match)
                       text
                       (let* ((scale (match:substring match 2))
                              (translate (match:substring match 1))
                              (id (string-append
                                    "lily-g-" (id-part (basename font ".svg"))
                                    "-" (id-part name) "-" (match:substring match 3)))
                              (use (string-append
                                     "<use xlink:href=\"#" id "\""
                                     (if translate
                                         (string-append
                                           " transform=\"" (string-trim-right translate) "\"")
                                         "")
                                     "/>\n")))
                         (if (hash-ref page-glyphs id #f)
                             use
                             (begin
                               (hash-set! page-glyphs id #t)
                               (string-append
                                 "<defs><path id=\"" id "\" transform=\"scale(" scale ")\" d=\""
                                 (match:substring match 4)
                                 "\" fill=\"currentColor\"/></defs>\n"
                                 use)))))))))
        (call-after-session
          (lambda ()
            (hash-clear! cache)
            (hash-clear! definitions)
            (hash-clear! elements)
            (hash-clear! page-glyphs)))
        ;; Every page begins with set-unit-length (framework-svg.scm), so a
        ;; page defines again what an earlier page did.
        (when reuse?
          (let ((set-unit-length (cdr unit-length)))
            (set-cdr! unit-length
              (lambda (len)
                (hash-clear! page-glyphs)
                (set-unit-length len)))))
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
            (reuse font glyph
              (if (not (string? glyph))
                  (original font size glyph)
                  (let* ((key (list font size glyph))
                         (value (hash-ref cache key #f)))
                    (or value
                        (let ((value (original font size glyph)))
                          (hash-set! cache key value)
                          value)))))))
        (set! lily-preview-cache-installed? #t)))))
