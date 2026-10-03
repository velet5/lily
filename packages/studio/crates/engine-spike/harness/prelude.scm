;; The spike's image: Scheme every compile starts from (lily_start). The real
;; image is a heap restored as bytes (chapter 03 §5.6); this one is evaluated.
(define (fib n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2)))))
(define (iota n) (let loop ((i (- n 1)) (acc '())) (if (< i 0) acc (loop (- i 1) (cons i acc)))))
(define (twice x) (* 2 x))
