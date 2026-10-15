# 03 — A small Scheme and the Guile subset scores need

Chapter 03 of the investigation into an engine of our own (chapter 00 sets
the budgets and the test set, chapter 01 maps LilyPond's source, chapter 02
designs the parser). It measures what LilyPond's Scheme and the 30 scores of
chapter 00 use of Guile, statically and while compiling (§2), states what the
interpreter must provide (§3), compares s7, Chibi, Steel and a prototype of
our own built to WebAssembly (§4), designs the interpreter (§5), and splits
LilyPond's Scheme into a core and parts loaded on demand (§6). It records no
decision; D56 (step 11) will.

Everything refers to LilyPond at tag `v2.26.0` (commit
`3596756be0fac1f81066a99d2054329212172b2d`). **[measured]** marks what was
taken on 2026-10-03 on the M1 Max of chapter 00, with `GNU LilyPond 2.26.0
(running Guile 3.0)` and `guile (GNU Guile) 3.0.11` of Homebrew, wasi-sdk 34,
binaryen 133, Rust 1.97 and Node 24; the recipes are in Appendix A.

## 1. How LilyPond runs Scheme

- **Two kinds of code.** The 54 init files of `scm/` are loaded into the
  `(lily)` module from byte-compiled `.go` files (72 of the 92 installed
  files have one; the 20 without only generate documentation or serve
  debugging). Scheme in `.ly`
  input, the init files' and the score's alike, is **interpreted**:
  `parse-scm.cc` reads each `#` and `$` form with Guile's reader and
  evaluates it with `scm_primitive_eval` (`lily/parse-scm.cc:315`), which
  expands macros with `psyntax` and runs Guile's closure-generating evaluator
  `ice-9/eval.scm`. `-dcompile-scheme-code` compiles score code instead; it
  is off by default because Guile's compiler fails on long files and drops
  multiple values (comment at `parse-scm.cc:291`).
- **Guile 3's reader is written in Scheme** (`ice-9/read.scm`), so reading a
  form costs dozens of Scheme calls per datum; so does every OpenType font
  LilyPond loads, because Emmentaler keeps its glyph metrics as Scheme text
  in the `LILC`, `LILY` and `LILF` tables, read with `scm_c_read_string`
  (`open-type-font.cc:289`).
- **The C++/Scheme surface** (chapter 01 §1): 408 `LY_DEFINE` functions and
  253 callbacks; `scm/` and `ly/` use 520 distinct `ly:` names. C++ calls
  Scheme through grob property callbacks, Scheme engravers and performers,
  markup functions, music functions and the toplevel handlers.
- **Session state.** `lilypond-all` parses `declarations-init.ly` once per
  process and `session-save` records every variable; each input file then
  starts with `session-replay`, which redefines them one by one in the
  parser's module (chapter 01 §2, step 2). Chapter 00's B5a asks the engine
  to replace both by a snapshot.

## 2. What the test set uses

### 2.1 Identifiers, statically

**[measured]** with Appendix A's `static.scm`, run inside LilyPond so that
`(lily)` and the `#{ … #}` reader exist. It reads every form of 69 of the 91
`scm/` files (the 22 that only generate documentation or serve debugging,
chapter 01 §4, left out),
the Scheme of 56 `ly/` files (all but the six chapter 01 marks as not
needed: the `#` and `$` forms, found outside comments and strings and read
with Guile's reader at their byte offset) and of the 30 scores with their 8
included files. It records each symbol in code position that is bound in
`(lily)` and not lexically bound around it (`lambda`, the `define` forms,
`let` and its variants, `do`, `receive`, music-function formals; `quote`d
data and `case` labels skipped), with the module that provides the binding.
Counts are distinct identifiers, with their uses in parentheses.

| Provider | `scm/` (69 files) | `ly/` (56 files) | 30 scores + 8 includes | All |
| --- | --- | --- | --- | --- |
| R7RS-small (Guile's own binding of an R7RS name) | 178 (21,625) | 87 (4,011) | 26 (212) | **181** |
| Guile core beyond R7RS | 216 (2,275) | 51 (252) | 2 (16) | **223** |
| SRFIs (`srfi-1` 46, `srfi-11` 2, `srfi-2` 1) | 44 (325) | 22 (35) | 0 | **49** |
| `(ice-9 …)` modules | 19 (176) | 3 (5) | 2 (2) | **20** |
| GOOPS | 8 (47) | 0 | 1 (1) | **8** |
| LilyPond Scheme | 1,420 (9,068) | 290 (2,300) | 32 (109) | 1,538 |
| LilyPond C++ (`ly:` primitives) | 594 (5,849) | 102 (1,062) | 26 (64) | 609 |

So LilyPond's Scheme needs **481 identifiers from Guile**: 181 of
R7RS-small's 335 (141 of them from `(scheme base)`), 223 of Guile's own, 49
from SRFIs and 28 from Guile's modules. The scores themselves need almost
nothing: 89 identifiers in all, of which the only ones beyond R7RS-small and
LilyPond are `@@` (T23, T26, T28's `cary-layout.ily`: reaching a private
binding of `(lily)`), `use-modules`, and `match` and `match-let` (both in
T15). The one GOOPS name in the scores, `initialize`, is a clause of
`make-engraver` in T15 that the census cannot tell from GOOPS's procedure.
What scores do with Scheme is call LilyPond: 58 of their 89 identifiers are
LilyPond's Scheme, macros and `ly:` functions.

R7RS-small identifiers no file uses include `call/cc`
(`call-with-current-continuation`), `define-record-type`, `guard`, `raise`,
`with-exception-handler`, `define-values`, `case-lambda`, promises
(`delay-force`, `make-promise`), bytevectors, `string-map`,
`string-for-each`, `vector-map`, the `char-ci` and `string-ci` comparisons
and binary I/O.

### 2.2 Guile beyond R7RS-small, by feature

The 223 Guile core identifiers and the 77 from SRFIs, `ice-9` and GOOPS, by
what they are for. A number after a name is how many files of `scm/` and
`ly/` use it, when more than one; *Files* is how many use any name of the
row.

| Feature | Identifiers | Files |
| --- | --- | --- |
| Modules | `define-module` 16, `use-modules` 38, `define-public` 68, `export`, `@@` 12 (34 uses in `music-functions-init.ly`), `current-module` 10, `module-define!`, `module-ref`, `module-set!`, `module-defined?`, `module-variable`, `resolve-module`, `module-for-each`, `module-map`, `variable-ref`, `variable-set!`, `variable-bound?`, `defined?`, `eval` 6, `primitive-eval` (`property-init.ly`), `eval-string` | 88 |
| Macros | `define-syntax-rule` 5, `syntax-case` 4 (`define-syntax-function` in `music-functions.scm`, `assert`, `curried-definitions.scm`, `accreg.scm`), `defmacro`, `defmacro-public`, `defmacro*-public` (`define-markup-command`, `markup`, `markup-lambda`, `with-music-match`), `define-macro` (`parser-ly-from-scheme.scm`), `syntax`, `quasisyntax`, `datum->syntax`, `syntax->datum`, `gensym`, `eval-when` | 13 |
| Optional and keyword arguments | `define*` 9, `lambda*`, `define*-public` 14, `let-keywords`, `keyword?`, `keyword->symbol` | 21 |
| Pattern matching | `match`, `match-lambda`, `match-let`, `match-let*`, `match-lambda*` (`ice-9 match`, a `syntax-rules` macro) | 13 |
| Lists | `acons` 19, `assq-ref` 10, `assoc-ref`, `assv-ref`, `assoc-set!` 7, `assq-set!`, `assq-remove!`, `assoc-remove!`, `cons*` 9, `iota` 18, `reverse!` 17, `append!` 6, `delq`, `delete`, `filter` 25, `filter!`, `list-head`, `last-pair`, `list-index`, `sort` 14, `sort!`, `stable-sort`, `map-in-order`, `rassoc`; SRFI-1: `fold` 18, `any` 16, `every` 14, `append-map` 14, `count` 13, `first`…`sixth`, `last`, `remove`, `take`, `drop`, `span`, `break`, `partition`, `filter-map`, `reduce`, `delete-duplicates`, `lset-union`, `lset-difference`, `list-tabulate`, `alist-delete`, `alist-copy`, `split-at`, `concatenate`, `zip` and some `!` forms | 60 |
| Strings | `string-join` 12, `string-split` 10, `string-concatenate` 8, `string-null?` 8, `string-contains`, `string-index`, `string-prefix?`, `string-suffix?`, `string-trim-right`, `string-trim-both`, `string-delete`, `string-count`, `string-capitalize`, `string-pad-right`, `string-take`, `string-drop`, `string-tokenize`, `substring/shared`, `string=`, `reverse-list->string`, `object->string`, `char-set:letter` | 27 |
| Formatting | `format`, which `(lily)` binds to Guile's `simple-format` (`lily.scm:548`: `~a`, `~s`, `~%`, `~~` only); the full `ice-9 format` in `display-lily.scm` and the backends (`~4f`, `~{ ~}`, `~^`, `~v`), and called as `ice9-format` for roman numerals (`~@r`, `lily-library.scm:1166`) and `~,1f` (`define-markup-commands.scm:5093`); `pretty-print` 6 | — |
| Hash tables and properties | `make-hash-table` 11, `hash-ref`, `hash-set!`, `hashq-ref` 9, `hashq-set!`, `hashv-ref`, `hashq-create-handle!`, `hash-get-handle`, `hash-fold`, `hash-for-each`, `hash-map->list`, `hash-clear!`, `hash-count`, `hashx-ref`; `make-weak-key-hash-table` (`lily.scm`); `make-object-property` 3, `object-property` 6, `set-object-property!` 6; `procedure-property`, `set-procedure-property!`, `procedure-name` 7, `make-procedure-with-setter` (`lily-library.scm`) | 28 |
| Errors, escapes, dynamic state | `catch` 6, `throw` 6, `scm-error`, `warn`; `call-with-escape-continuation` and `dynamic-wind` (`articulate.ly`), `let-escape-continuation` (`define-markup-commands.scm`); `make-parameter` and `parameterize` (`display-lily.scm`, `define-music-display-methods.scm`, `music-functions.scm`), `make-fluid` and `fluid-ref` (`lily.scm`) | 14 |
| Numbers | `1+` 25, `1-` 22, `ash`, `logior`, `logxor`, `logcount`, `logbit?`, `integer-length`, `exact->inexact`, `inexact->exact` 8, `inf?`, `euclidean-remainder`, `ceiling-quotient`; besides, exact rationals throughout: `/` in 34 files (moments; `time-signature-settings.scm` 16 times, `paper.scm` 12), `numerator`, `denominator` | 16 |
| Arrays | `make-array`, `array-ref`, `array-set!`, `array-dimensions`, `array-copy`, `array->list`, `transpose-array`, `make-shared-array` | 4 |
| GOOPS | `define-method` on `+ - * / <` for moments (`operators.scm`), `define-class` for regex matches (`lily-library.scm`), both in `part-combiner.scm`; `slot-ref`, `slot-set!`, `class-of`, `make`, `is-a?` | 3 |
| Regular expressions | `make-regexp`, `regexp-exec` (`output-svg.scm`) | 1 |
| Files and processes | `open-file`, `basename`, `dirname`, `mkdir`, `getenv`, `getcwd`, `stat`, `copy-file`, `primitive-fork`, `waitpid` …: the driver (`lily.scm`), `backend-library.scm`, the backends, and file names in `lily-library.scm`, `music-functions-init.ly` and `event-listener.ly` | 8 |
| Reader and debugger hooks | `read-hash-extend` and `set-port-line!` (`#{` in `parser-ly-from-scheme.scm`), `debug-enable` (`lily.scm`) | 2 |

### 2.3 Scheme calls per compile

**[measured]** with Appendix A's `census.ly`, a settings file that installs
a Guile VM apply hook (the `debug` engine, trace level 1) at the top of
`init.ly` and counts every procedure application by entry address and name,
in two phases: **parse** (until the first book handler call) and **book**
(interpreting, layout, MIDI; pages are not printed, `-dno-print-pages`, so
the SVG backend is left out). Calls the compiler inlined (`car`, `+`, `eq?`
in compiled code) are not applications and are not counted. Thousands of
applications:

| Score | parse: all | of which reading and expanding | LilyPond procedures | book: all | of which reading font tables | C++ callbacks | LilyPond procedures |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T01 | 26 | 10 | 0.6 | 374 | 342 | 5.2 | 2.6 |
| T02 | 61 | 11 | 3.5 | 419 | 342 | 24 | 9.1 |
| T03 | 27 | 10 | 0.7 | 376 | 342 | 6.7 | 2.9 |
| T04 | 79 | 11 | 9.3 | 813 | 684 | 45 | 16 |
| T05 | 53 | 11 | 5.4 | 431 | 342 | 31 | 10 |
| T06 | 34 | 11 | 2.2 | 742 | 684 | 9.2 | 4.3 |
| T07 | 89 | 11 | 8.9 | 534 | 342 | 70 | 32 |
| T08 | 52 | 11 | 3.5 | 398 | 342 | 20 | 5.6 |
| T09 | 50 | 11 | 3.2 | 1,097 | 1,026 | 14 | 4.2 |
| T10 | 31 | 11 | 1.4 | 388 | 342 | 9.8 | 4.7 |
| T11 | 34 | 10 | 2.4 | 608 | 540 | 19 | 6.6 |
| T12 | 92 | 11 | 12 | 860 | 684 | 79 | 20 |
| T13 | 39 | 11 | 0.7 | 582 | 540 | 4.5 | 2.9 |
| T14 | 39 | 13 | 0.6 | 371 | 342 | 3.3 | 2.3 |
| T15 | 125 | 77 | 2.0 | 425 | 342 | 3.7 | 3.1 |
| T16 | 25 | 11 | 0.6 | 369 | 342 | 3.7 | 1.9 |
| T17 | 52 | 1.2 | 5.2 | 424 | 342 | 28 | 11 |
| T18 | 50 | 10 | 1.2 | 386 | 342 | 12 | 4.3 |
| T19 | 453 | 314 | 9.1 | 379 | 342 | 7.6 | 3.4 |
| T20 | 59 | 10 | 2.5 | 389 | 342 | 9.5 | 5.0 |
| T21 | 52 | 11 | 2.8 | 600 | 540 | 14 | 5.2 |
| T22 | 104 | 18 | 14 | 1,174 | 1,026 | 42 | 15 |
| T23 | 231 | 33 | 16 | 857 | 684 | 62 | 20 |
| T24 | 163 | 14 | 28 | 1,134 | 540 | 309 | 77 |
| T25 | 156 | 14 | 22 | 1,043 | 882 | 70 | 17 |
| T26 | 123 | 25 | 17 | 656 | 540 | 32 | 14 |
| T27 | 192 | 16 | 31 | 640 | 540 | 43 | 9.9 |
| T28 | 345 | 84 | 39 | 877 | 684 | 90 | 21 |
| T29 | 382 | 18 | 53 | 1,513 | 540 | 390 | 141 |
| T30 | 106 | 1.7 | 14 | 654 | 342 | 147 | 42 |

*Reading and expanding* is Guile's reader and `psyntax` working on `#`
forms (T19: the 27 KB of Scheme in `articulate.ly`; T15: its Scheme
engraver; T28: 122 nested `#{ … #}`); *reading font tables* is the
`LILC`/`LILY` tables of every Emmentaler file loaded, 171,000 applications
each (every compile loads at least two; T09 six, for its grace notes); *C++ callbacks* are `ly:`
functions and applicable C++ objects called from Scheme; *LilyPond
procedures* are applications of procedures defined in `scm/` and of closures
made by `.ly` Scheme (music functions, callbacks in scores).

What it says:

- **Most of Guile's work is overhead our engine does not have.** Of 22.8
  million applications in the 30 compiles, 16.1 million (70 %) are the
  reader and the expander, 15.3 million of them reading font tables; a
  Rust reader and binary font metrics (chapter 06) remove them. Another
  share is `session-replay`: the parse phase of T01, whose score has no
  Scheme, still applies 15,000 procedures, most of them `module-add!` and
  its helpers in `boot-9.scm` redefining the session's variables; the
  snapshot of B5a removes it.
- **What remains is LilyPond's own Scheme**: 2,400 (T16) to 194,000 (T29)
  applications of LilyPond procedures per compile, median 12,700, with the
  Guile library procedures and primitives they call: 38,000 to 851,000
  applications in all, median 99,000.
- **The book phase runs LilyPond's Scheme as callbacks.** In T24 and T29
  the C++ callbacks (309,000 and 390,000) outnumber the Scheme procedures
  they interleave with; most are grob property callbacks written in C++
  and called through Scheme. In our engine these become direct Rust calls
  (chapter 05), unless a grob's callback is a Scheme procedure.

Distinct procedures run across the 30 compiles **[measured]**: 870
LilyPond procedures (179 by every score; 238 to 467 per score), 405 `ly:`
functions called from Scheme (115 by every score), and 235 Guile
primitives, 118 by every score.

### 2.4 The `scm/` modules a compile reaches

Each `scm/` file by how many of the 30 compiles run at least one of its
procedures **[measured]**, with its size (bytes and brotli `-q 11` of the
source) and the applications counted in all 30 compiles. Files that are
data with few procedures (`define-grobs.scm`) are loaded but show no calls.

| Reached by | File: distinct procedures run, applications | Source, brotli |
| --- | --- | --- |
| all 30 | `music-functions` 164, 271k; `scheme-engravers` 60, 179k; `output-lib` 91, 57k; `lily-library` 89, 56k; `bar-line` 38, 35k; `markup-macros` 22, 23k; `define-music-types` 7, 23k; `define-markup-commands` 58 (commands and helpers, of 199 commands), 11k; `define-event-classes` 2, 11k; `c++` 38, 8.2k; `markup` 10, 6.7k; `time-signature-settings` 22, 4.1k; `stencil` 33, 4.0k; `titling` 6, 2.5k; `ly-syntax-constructors` 31, 2.5k; `paper` 14, 2.1k; `page` 11, 1.2k; `lily` 4; `paper-system` 4; `backend-library` 1 | 1,099 KB, 218 KB |
| 12–29 | `translation-functions` (29) 33, 1.9k; `time-signature` (28) 1; `define-music-callbacks` (15) 19, 15k; `parser-clef` (13) 2, 5.6k; `auto-beam` (12) 9, 23k | 87 KB, 19 KB |
| 2–7 | `color` (7), `parser-ly-from-scheme` (5: the `#{ … #}` of T19, T23, T25, T26, T28), `midi` (4), `curried-definitions` (3), `operators` (3, GOOPS: T05, T19, T26), `define-note-names` (2: `deutsch.ly` in T24, `english.ly` in T28) | 139 KB, 18 KB |
| 1 | `display-lily` (T19, through `articulate.ly`), `chord-entry` (T05), `chord-ignatzek-names` (T05), `tablature` (T22), `harp-pedals` (T29), `context` (T25) | 64 KB, 15 KB |
| none, loaded at init | `define-grobs`, `define-grob-properties`, `define-context-properties`, `define-grob-interfaces`, `define-music-properties`, `script`, `flag-styles`, `breath`, `layout-beam`, `layout-slur`, `skyline`, `define-stencil-commands`, `file-cache`, `chord-name`, `scheme-performers`, `modal-transforms`, `part-combiner`, `autochange`, `fret-diagrams`, `predefined-fretboards`, `define-woodwind-diagrams`, `display-woodwind-diagrams` | 682 KB, 119 KB |
| none, loaded on use | `define-music-display-methods`, `accreg`, `qr-code`, `clip-region`, the backends `framework-svg`, `output-svg`, `framework-ps`, `output-ps`, `framework-cairo`, `ps-to-png` | 205 KB, 42 KB |

`scm/` as a whole is 2,410 KB of source, 467 KB with brotli file by file
and 394 KB as one stream; Guile's compiled `.go` files of it are 11.0 MB,
1.37 MB with brotli. The init `.ly` files add Scheme of their own:
`music-functions-init.ly` (151 functions), `property-init.ly`,
`chord-repetition-init.ly` and the rest of chapter 01 §4, all interpreted.

### 2.5 Time spent in Scheme

A rough share, from Guile's sampling profiler (`statprof`, Appendix A) on
five scores, whose samples were few (60 to 580): of the samples after the
settings file, LilyPond's Scheme procedures took 12–22 %, Guile primitives
and library procedures 6–18 %, the reader 1–8 %, and C++ (`ly:` functions
and C++ callbacks applied from Scheme) 62–79 %. A fifth to two fifths of a
compile is Scheme in LilyPond, so the interpreter's speed matters to B6 but
does not set it alone; how much of that Scheme stays Scheme is §6's
question.

### 2.6 The Guile subset

From §2.1–2.4, what the interpreter must have for LilyPond's Scheme and the
scores, and what it may leave out:

- **Needed**: R7RS-small's core syntax and the 141 `(scheme base)` names
  used, multiple values, tail calls, `dynamic-wind`; Guile's modules as far
  as `define-module`, `use-modules`, `define-public`, `export`, `@@`,
  `current-module`, `module-define!`/`module-ref` and `eval` in a module;
  `syntax-rules` and `define-syntax-rule`, `defmacro`, `syntax-case` for
  four macros, `define*`/`lambda*` with optional and keyword arguments,
  `ice-9 match`; `catch`/`throw` with Guile's keys, escape-only
  continuations, parameters and fluids; exact rationals, `1+`, bit
  operations; SRFI-1 (46 names) and Guile's list and string procedures;
  `simple-format`; hash tables (`eq`, `eqv`, `equal`, weak keys), object
  and procedure properties, procedures with setters; keywords; string
  ports.
- **Not needed** by any file or score: full `call/cc` and delimited
  continuations, threads, records (`define-record-type` is used by no file;
  GOOPS stands in for one class), R7RS exceptions, promises, bytevectors
  (one use in `backend-library.scm`), the R6RS libraries, Guile's compiler
  and VM, its debugger and traps, `readline`, POSIX processes (only the
  native driver and the PostScript backend use them).
- **Needed by a few modules only**, which can carry it: GOOPS
  (`operators.scm`, `part-combiner.scm`, `lily-library.scm`'s regex-match
  class), regular expressions (`output-svg.scm`), arrays (`qr-code.scm`,
  `translation-functions.scm`, `define-markup-commands.scm`), the full
  `ice-9 format` (`display-lily.scm`, the backends, roman numerals),
  `pretty-print` (`display-lily.scm`).

## 3. What the interpreter must provide

From chapter 00 (budgets and the WebAssembly floor), chapter 02 §5.8 (what
the parser asks) and §2 above. **R** numbers are referred to in §4.

| # | Requirement | Why |
| --- | --- | --- |
| R1 | Builds to wasm32 with only the features of chapter 00 §1.1: no wasm tail calls, exception handling, threads or GC proposal | Safari 17 is the floor |
| R2 | Proper tail calls without wasm tail calls (a loop or trampoline in the evaluator) | LilyPond's Scheme iterates by tail recursion |
| R3 | A precise collector that never scans the native stack, with roots the engine can declare from Rust | wasm's stack is not scannable; music, grobs and contexts in Rust hold Scheme values |
| R4 | Small code: its share of B3 (4 MB uncompressed core) and B1 (1.5 MB brotli with the image and the font) | §7 |
| R5 | A heap image: the state after loading LilyPond's Scheme and init files saved at build time and restored in milliseconds | B5a; chapter 01 §2's session state |
| R6 | The Guile subset of §2.6, with Guile's own spellings (`define-module`, `@@`, `define*`, `catch`/`throw`, `1+`, keywords as `#:key`) | LilyPond's Scheme and the scores are written for Guile |
| R7 | Guile 3's wording for the common errors (`Unbound variable: x`, `In procedure car: Wrong type (expecting pair): ()`, `unexpected end of input while searching for: )`) | C0 compares the message (error corpus cases 21–23 of chapter 02) |
| R8 | A reader callable at a byte offset, returning the datum and its end, with LilyPond's `#{ … #}` read as a template | chapter 02 §5.2–5.3 |
| R9 | `*location*` during evaluation, multiple values (`#@`, `$@`), closures for template holes | chapter 02 §5.8 |
| R10 | Module variables with version numbers, a hook on reads for dependency tracking, `define`/`set!` recorded per toplevel item | chapter 02 §5.7 |
| R11 | An allocation epoch per object and a write barrier that logs mutations of objects older than the current item, so an item's effects can be undone | chapter 02 §5.7 |
| R12 | Foreign objects (pitches, durations, moments, music, contexts, grobs, stencils, output definitions) with type predicates, printing, equality and tracing; a cheap test "is this a music function, and what is its signature" | chapter 01 §3.3; chapter 02 §2.3 |
| R13 | Exact rationals and integers beyond 64 bits that never lose precision silently | moments, alterations and durations are exact (§2.2) |
| R14 | Interruptible: the evaluator checks a cancel flag at safe points | B8 (50 ms) |
| R15 | A permissive licence, compatible with both the MIT licence of this repository and the GPL v3 of the LilyPond Scheme it will run | the engine's own licence, which ships LilyPond's GPL code in its image, is for D56 |
| R16 | Fast enough that LilyPond's Scheme (§2.3) fits the Scheme share of B6 | §4.2, §7 |

R10 and R11 are the unusual ones. They are what lets chapter 02 re-parse only
the edited part: an interpreter that is not written with them has to be
changed in its variable lookup, its mutating primitives and its allocator.

## 4. The candidates

### 4.1 What was built

**[measured]** Each candidate was built for wasm32 as a module that exports
`lsb_init` (create the interpreter with its standard environment),
`lsb_alloc` and `lsb_eval` (read and evaluate a source text), and timed by
one runner in Node 24 (V8, the engine of Chrome) on eight benchmarks
(Appendix B): calls (b1 `fib 30`, b2 `tak`), tail calls (b3), property-alist
lookups as in a grob's property chain (b4), list work and multiple values
(b5), strings and symbols (b6), closures, rest arguments and `apply` (b7),
and reading and evaluating a 207 KB file of definitions (b8). Each run uses a
fresh instance; times are medians of five. Every candidate's output matched
the expected output.

- **s7** (`cm-gitlab.stanford.edu/bil/s7`, commit `d01081b`): `s7.c` with
  wasi-sdk 34, `-Oz`, `-DWITH_SYSTEM_EXTRAS=0 -DWITH_C_LOADER=0
  -DDISABLE_DEPRECATED=1 -DWITH_GMP=0`, a four-line patch (`setjmp`
  instead of `sigsetjmp`, no `getrusage`), `wasm-opt -Oz`.
- **Chibi-Scheme** (`ashinn/chibi-scheme`, commit `c4e7367`): static build
  without dynamic loading or green threads, the 10 C libraries
  `(scheme small)` needs, the 58 Scheme library files it opens.
- **Steel** (`mattwparas/steel`, commit `8ed1cbb`, `steel-core` 0.8.3) for
  `wasm32-unknown-unknown`, default features off, `opt-level="z"`, LTO,
  `panic="abort"`, `wasm-opt -Oz`; unpatched.
- **A prototype of our own**: 1,800 lines of Rust, std only, written for
  this comparison along §5's design: 8-byte values, typed arenas with a
  precise mark-sweep collector whose roots are the globals and the VM
  stack, a reader at a byte offset, a compiler that resolves lexical
  addresses and global slots and emits 8-byte bytecode with a few
  superinstructions, and one VM loop with explicit value and return stacks,
  so that neither tail nor non-tail calls use the native stack; 72
  primitives. It is throwaway: step 10 builds the measured prototype again.

### 4.2 Size

**[measured]**, bytes after `wasm-opt`:

| | Raw | gzip -9 | brotli -q 11 | Also needed at run time |
| --- | --- | --- | --- | --- |
| s7, `-Oz` | 1,249,589 | 415,713 | 330,980 | — |
| Chibi, `-Oz` | 295,785 | 115,073 | 97,432 | its Scheme libraries: 327,203 raw, 63,203 brotli |
| Steel, `z` | 2,601,285 | 843,736 | 612,865 | — (168 KB of its Scheme prelude is inside, compiled at every start) |
| Prototype, `z` | 138,022 | 67,312 | 59,038 | — |
| *For scale:* LilyPond 2.26 with Guile 3 by Emscripten (`@sightread/lilypond-wasm` 0.2.0) | 15,266,329 | — | 3,486,470 | a 15.9 MB data file |

The speed builds (`-O2`/`-O3`) are 18–60 % bigger; Steel's and the
prototype's are about 1.3 times faster, s7's and Chibi's no faster.

What dominates: in s7, its 104,734-line `s7.c`; in Steel, its VM (516 KB),
primitives (446 KB), Rust's generic code (425 KB) and 559 KB of read-only
data (the Scheme prelude and 100 KB of documentation strings), from 158
crates; in the prototype, 60 KB of fixed Rust runtime (formatting and float
printing 35 KB, allocator 8 KB), then the compiler and reader 27 KB, the VM
18 KB, the primitives 12 KB, the heap 6 KB.

**The prototype's size, extrapolated** to the interpreter of §5, from
measured deltas: 20 small Guile primitives add 3.7 KB raw (185 bytes each),
20 SRFI-1/SRFI-13-like ones 21.6 KB (half of it Rust's string searching and
Unicode case tables, paid once), exact rationals 5.5 KB. Adding 330–530
primitives, bignums (20–30 KB), inexact maths, `format`, string ports, hash
tables, `dynamic-wind` and `catch`/`throw`, the macro expander (20–35 KB),
modules, properties and Guile's error texts gives **355–480 KB raw, about
140–190 KB with brotli**, 8,000–12,000 lines of Rust.

### 4.3 Speed

**[measured]**, milliseconds. Wasm: evaluation alone in V8 on the M1 Max.
Native and Guile: process wall time, median of three, minus the empty
benchmark b0. Guile is `guile --no-auto-compile`, which interprets as it
does a score's `#` forms.

| | b1 fib | b2 tak | b3 loop | b4 alist | b5 lists | b6 strings | b7 closures | b8 load | Sum | Start-up |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| s7, wasm `-Oz` | 23.5 | 40.8 | 42.5 | 78.6 | 141.7 | 65.9 | 82.4 | 2.8 | **478** | 1.5–2.2 ms (14.5 ms for the first instance) |
| Chibi, wasm `-Oz` | 89.7 | 47.6 | 66.2 | 2,273.7 | 1,954.9 | 10,353.7 | 562.7 | 886.1 | 16,235 | 285 ms |
| Steel, wasm `z` | 303.7 | 121.5 | 260.8 | 1,795.4 | 1,069.5 | 383.3 | 1,430.4 | 143.9 | 5,508 | 176–193 ms |
| Steel, wasm `3` | 245.0 | 102.9 | 214.5 | 1,498.8 | 788.0 | 287.8 | 1,042.0 | 106.1 | 4,285 | 119–130 ms |
| Prototype, wasm `z` | 63.5 | 24.0 | 60.2 | 103.0 | 141.9 | 137.5 | 106.6 | 6.5 | **643** | 0.1–0.2 ms |
| Prototype, wasm `3` | 61.6 | 21.7 | 48.7 | 69.6 | 94.9 | 85.5 | 78.2 | 4.6 | **465** | 0.1–0.2 ms |
| s7, native | 7.7 | 31.7 | 17.7 | 41.3 | 92.3 | 30.8 | 52.4 | 0.8 | 275 | |
| Prototype, native | 42.6 | 15.8 | 37.7 | 53.9 | 64.0 | 63.6 | 49.3 | 3.3 | 330 | |
| Guile 3.0.11, interpreting | 229 | 107 | 209 | 167 | 319 | 171 | 258 | 92 | 1,552 | |

- **s7 and the prototype are 3–5 times faster than Guile's interpreter**
  and within 1.4 times of each other: s7 is faster at calls and arithmetic
  (b1), the prototype at `tak` and, in its speed build, at lists and
  closures. Their wasm builds run at 1.0–3 times their native speed.
- **Chibi is slow wherever it allocates**: its allocator walks one free list
  first-fit (`gc.c:643-671`), and its symbol table has 389 fixed buckets
  (`sexp.h:161`), so b6 takes 10 s. Its start-up loads `(scheme small)` from
  source: 285 ms.
- **Steel's call path is as fast as Guile's**, but its library is Scheme: its
  `assq` is written in Scheme (`stdlib.scm:970`), 18 times slower than
  Guile's C one on 10 million steps; `values` is `list`. Each start compiles
  its 168 KB prelude: 119–193 ms.
- A size-optimised build costs the prototype little where the VM loop
  dominates (within 10 % on b1–b3) and up to 1.6 times in string and
  allocator code (b5, b6), which is std code built for size; §8 asks
  chapter 08 to build the interpreter's hot primitives for speed.

**What this means for LilyPond's Scheme.** The prototype runs a Scheme
application in 25–85 ns in wasm on the M1 Max (b7: about 3 million
applications in 107 ms; b4: about 1.2 million in 103 ms), so 55–190 ns on
chapter 00's Android reference. With §2.3's counts of what remains Scheme
(38,000 to 851,000 applications per full compile, median 99,000), that is
**5–19 ms for a median score and 47–160 ms for T29**, a lower bound since the
counts leave out what Guile's compiler inlined. A full recompute of an S
score fits the 40 ms that chapter 00 provisionally gives Scheme and music;
an L score's does not, and needs chapter 02's re-parse and chapter 04's
incremental music model.

### 4.4 Fit

| | s7 | Chibi | Steel | Our own |
| --- | --- | --- | --- | --- |
| R1 wasm floor | **no**: `setjmp`/`longjmp` needs wasm exception handling (`-mllvm -wasm-enable-sjlj`, the legacy kind Safari 15.2 has), outside chapter 00 §1.1 | yes | yes; but `getrandom` and `js-sys` add wasm-bindgen imports to stub | yes |
| R2 tail calls | yes | yes | yes | yes |
| R3 precise GC, roots from the host | yes (`s7_gc_protect`, own stack) | yes (`sexp_gc_preserve`) | reference counting plus mark-sweep of mutable cells | yes |
| R4 size (brotli) | 331 KB | 160 KB with its libraries | 613 KB | 59 KB now, 140–190 KB complete |
| R5 heap image | none | yes natively (start 211 → 7 ms with a 595 KB image), but only with dynamic loading on 64-bit hosts (`features.h:909`): not in wasm32 | none; compiled programs serialise, the prelude is compiled at every start | designed in (§5.6) |
| R6 Guile subset | `catch`/`throw`, `define-macro`, keywords, hash tables built in; no `syntax-rules`, `syntax-case` or modules; strings are bytes (`(string-length "λx→é")` is 8) | `syntax-rules`, R7RS libraries, bignums, UTF-8; no `catch`/`throw`, `define-macro`, keywords (`#:foo` does not read) or built-in hash tables | no mutable pairs (lists are immutable vlists), only immutable hash tables, `values` is `list`, no `define-macro`, `catch`/`throw` or `format`; `display` writes `#true`; `(assq 'stencil '((stencil . 5)))` is `#f` | what §2.6 lists, nothing more |
| R7 Guile's wording | its own | its own | its own (codespan reports) | Guile's, by design |
| R8–R11 reader at an offset, locations, versioned globals, write barrier | to be added inside a 105,000-line file | to be added in its VM and allocator | to be added in a 97,000-line crate | designed in |
| R13 exact numbers | int64 and ratios; overflow becomes a float silently | bignums, ratios | bignums, ratios; `exact` of a float ≥ 2^63 saturates | rationals measured; bignums to add (20–30 KB) |
| Deep non-tail recursion in wasm | traps at about 30,000 levels (V8's stack) | error at 1,000,000 | heap stack | heap stack; 8 million values |
| R15 licence | 0BSD | BSD-3 | MIT or Apache-2.0 | ours |

Not candidates, and why:

- **Guile itself, by Emscripten.** The only Scheme that runs LilyPond's
  Scheme unchanged. `@sightread/lilypond-wasm` 0.2.0 builds LilyPond and
  Guile 3 this way: 15.3 MB of wasm, 3.5 MB with brotli, plus a 15.9 MB
  data file, and it uses wasm exception handling. Guile's collector (BDW)
  scans the stack conservatively, which Emscripten emulates by spilling;
  Guile's reader and expander are Scheme, which is §2.3's 70 %. Ten times
  B1.
- **Guile Hoot** compiles Scheme ahead of time to WasmGC with tail calls,
  which Safari has only from 18.2 (chapter 00 §1.1), and has no evaluator
  for code it did not compile; scores bring their Scheme at run time.
- **JavaScript Schemes** (BiwaScheme, LIPS): the engine's values would
  live on both sides of the wasm boundary, against R3 and B4.

### 4.5 Choice

**An interpreter of our own, in Rust**, to be recorded by D56. It is the only
candidate that meets R1, R5 and R8–R11 by construction rather than by
changing someone else's evaluator, its measured base is 59 KB brotli, and its
speed matches s7's, the fastest of the others. The runner-up is **s7**: as
fast, Guile-like in `catch`/`throw`, `define-macro` and keywords, and
permissively licensed. It fails R1 as built (exception handling for
`setjmp`) and would need Unicode strings, `syntax-rules`, modules, rationals
that do not degrade, a heap image and chapter 02's version and undo hooks;
it is the fallback if the custom interpreter's first milestone (§7) misses
its budgets. Chibi is too slow at allocating and has no image in wasm32;
Steel is 613 KB with brotli, three to four times the complete
interpreter's estimate, and differs from Guile in mutable pairs, hash
tables and multiple values, which LilyPond's Scheme uses everywhere.

## 5. Design of the interpreter

The prototype's structure, made complete. Each part names the requirements
it serves.

### 5.1 Values and heap (R3, R11, R12, R13)

- **Values** are 8-byte words: a fixnum (62 bits) when the low bit is 0,
  otherwise a tag and a payload: the immediates (`'()`, booleans,
  unspecified, end of file, characters, symbols and keywords as 32-bit
  indices) or a 32-bit index into a typed arena. A value is one wasm `i64`,
  and an error is a reserved value rather than a Rust `Result`, as in the
  prototype.
- **Arenas** per kind: pairs (two values), flonums, bignums, rationals,
  strings, vectors, closures, frames, hash tables, records and
  **foreign objects**, Rust values behind a trait with a type name, a
  printer, `equal?` and a trace method (pitches, durations, moments, music,
  contexts, grobs, stencils, output definitions; chapter 04 decides which
  stay Rust-owned and which are Scheme objects).
- **Collection**: precise, non-moving mark-sweep, at safe points only (a
  procedure's entry, between toplevel forms, at the yield points of B8), with
  roots in the global slots, the VM's stacks and a root stack that Rust code
  pushes handles onto. Nothing scans wasm's stack.
- **Epochs**: arenas allocate in chunks, and each chunk records the toplevel
  item it was allocated in (chapter 02 §5.7), so an object's epoch comes from
  its index at no cost per object. Every mutating primitive (`set-car!`,
  `vector-set!`, `hash-set!`, `set!` of a global, `set-object-property!`,
  module definition) compares the object's epoch with the current item's and
  logs `(object, slot, old value)` when it is older: R11's undo log.
- **Strings**: UTF-8 with an "all ASCII" flag, so `string-ref` is O(1) on
  the ASCII strings that are nearly all of LilyPond's, and a cached
  character index otherwise; mutable, since Guile's are.
- **Numbers**: fixnum, then bignum on overflow, exact rationals of either,
  flonums, and complex numbers as a pair of flonums (six names of
  `(scheme complex)` are used, §2.1). Moments stay chapter 04's.

### 5.2 Reader (R7, R8)

A Rust reader over UTF-8 bytes, called at a byte offset, returning the datum,
its end and the spans of its sub-forms. It reads Guile's syntax as LilyPond's
files use it: `#:keyword`, `#t`/`#f`/`#true`/`#false`, character names,
vectors, `#;`, `#| |#`, rationals (`1/4`), `#x`, `#e`/`#i`, `+inf.0`, and
`#{ … #}` by calling back into chapter 02's parser, which returns a template
(chapter 02 §5.3). Errors carry Guile's wording (`unexpected end of input
while searching for: )`). It replaces Guile's Scheme reader, and with it most
of §2.3's reading cost.

### 5.3 Compiler and evaluator (R2, R9, R14, R16)

As in the prototype: a pass that recognises special forms and resolves
lexical addresses and global slots, a pass that keeps uncaptured frames on the
VM stack, and bytecode run by one loop with explicit value and return stacks.
No call, tail or not, uses wasm's stack; `apply`, `call-with-values`, `map`
and `for-each` run inside the loop (the prototype left `map` on the Rust
stack, which V8 limits to about 1,700 nested re-entries).

- **Multiple values** as a value kind, for `#@`/`$@` and `receive`.
- **`*location*`** is a fluid the parser sets around each `#` form; procedures
  keep the span of their `lambda` for error messages and `procedure-name`.
- **Escapes**: `catch`/`throw` with Guile's keys and argument convention
  (`(key subr message args rest)`), `call-with-escape-continuation`,
  `dynamic-wind`, parameters and fluids, all by unwinding the explicit
  stacks; full `call/cc` is not provided (§2.6).
- **Cancellation** (B8): the loop counts backward jumps and calls and checks
  the cancel flag every few thousand.
- **Errors** worded as Guile 3's (`Unbound variable: x`, `In procedure car:
  Wrong type (expecting pair): ()`, `Wrong number of arguments to …`), from a
  table of templates; the `ly:` functions word their type errors as
  LilyPond's C++ does (`Wrong type argument in position 1 (expecting
  Music)`).

### 5.4 Globals and modules (R6, R10)

A global is a slot: a value, a version number that every `define` and `set!`
increments, and the module it belongs to. Modules are tables from symbols to
slots with Guile's interfaces (`define-module`, `use-modules`, `export`,
`define-public`, `@@`, `current-module`, `resolve-module`, `module-define!`,
`module-ref`, `eval` in a module), enough for `(lily)` and its six
submodules and for `session-replay`'s parser modules. Compiled code refers to
slots directly, so a global read is one load; dependency tracking (R10) is a
bit per slot read while an item is parsed, set by the global-read
instruction when tracking is on.

### 5.5 Macros

- **Native special forms**: R7RS's, Guile's (`define*`, `lambda*` with
  `#:optional`/`#:key`/`#:rest`, `define-public`, `case-lambda`, `do`,
  `quasiquote`, `while`), and LilyPond's definers that every score calls
  through (`define-music-function`, `define-scheme-function`,
  `define-event-function`, `define-void-function`, `define-markup-command`,
  `markup`, `make-engraver`, `make-performer`), so a score's Scheme rarely
  needs the general expander, and a music function carries its signature in
  its procedure header for chapter 02's classification (R12).
- **`syntax-rules`** (with ellipsis depth, literals and renaming of
  introduced bindings) and **`defmacro`/`define-macro`** in the core: `ice-9
  match` (13 files, T15) is `syntax-rules`, and `define-markup-command` is a
  `defmacro`.
- **`syntax-case`** is used by four macros only (§2.2); those become native
  forms or are expanded at build time, and `syntax-case` itself is a part
  loaded on demand (§6) for scores that use it, as none of the 30 does.

### 5.6 The image (R5)

At build time a native build of the engine loads the core Scheme of §6 and
runs `declarations-init.ly`, then writes its heap: the arenas, the symbol
table, the module tables and the compiled code, with indices instead of
pointers, so loading it is a copy into linear memory and no relocation. A
compile starts from the image and resets to it; this replaces Guile's start,
the loading of `scm/` and `session-replay` (chapter 01 §2, steps 1–2).

Its size, estimated from what `(lily)` and the parser's module reach after
init in LilyPond **[measured]** (Appendix A, a walk that also enters
Guile's own modules, so an upper bound): 57,479 pairs, 8,849 symbols with
130,844 characters, 3,486 strings with 127,104 characters (among them the
documentation strings of `define-grob-properties.scm`,
`define-context-properties.scm` and `define-music-properties.scm`, which the
image leaves out), 4,073 procedures, 82,453 hash table entries, 1,052 music
objects and 80 context definitions. At 16 bytes a pair and the bytecode of
§6's core (1.7 MB of source, documentation strings included), the image is 1.5–2.5 MB raw, **300–450
KB with brotli** (an estimate for step 10 to measure).

## 6. A minimal core and parts loaded on demand

What runs as Scheme, where it lives, and when it is loaded. Sizes are the
source's, bytes and brotli **[measured]**; compiled into the image or a part
they should be no larger.

| Part | Contents | Source, brotli | Needed by | Loaded |
| --- | --- | --- | --- | --- |
| **Core image** | `scm/` files every compile reaches (§2.4: the 20 of *all 30* and the 5 of *12–29*), the init data (`define-grobs`, `define-grob-properties`, `define-context-properties`, `define-grob-interfaces`, `define-music-properties`, `define-music-types`, `define-event-classes`, `script`, `flag-styles`, `breath`, `layout-beam`, `layout-slur`, `skyline`, `define-stencil-commands`, `color`, `define-note-names`, `parser-clef`), `curried-definitions`, `parser-ly-from-scheme`, and the state after `declarations-init.ly` | 41 files, 1,725 KB, 326 KB (`scm/` part) | every score | in the image (§5.6) |
| `chords` | `chord-entry`, `chord-name`, `chord-ignatzek-names`, `chord-modifiers-init.ly`'s tables | 34 KB, 8 KB | `\chordmode`, `\chords`, ChordNames (T05) | on the parser's mode switch |
| `display` | `display-lily`, `define-music-display-methods`, the full `ice-9 format` and `pretty-print` | 77 KB, 12 KB, plus their Rust | `\displayLilyMusic`, `\displayMusic`, `articulate.ly` (T19) | on first reference to their names |
| `fretted` | `tablature`, `fret-diagrams`, `predefined-fretboards`, the init files of fretboards and string tunings | 73 KB, 15 KB | TabStaff, FretBoards (T22) | on the context or markup command |
| `diagrams` | `define-woodwind-diagrams`, `display-woodwind-diagrams`, `harp-pedals`, `accreg` | 157 KB, 21 KB | the diagram markup commands (`harp-pedals` in T29) | on the markup command |
| `partcombine` | `part-combiner`, `autochange` (their GOOPS class as a record) | 52 KB, 11 KB | `\partCombine`, `\autoChange` | on the music function |
| `modal` | `modal-transforms` | 13 KB, 3 KB | `\modalTranspose`, `\retrograde`, `\inversion` | on the music function |
| `qr` | `qr-code` and arrays | 32 KB, 8 KB | `\qr-code` | on the markup command |
| `syntax-case` | the general expander | Rust | score macros written with `syntax-case` (none of the 30) | on the form |
| `ly/` library | the includable `ly/` files: languages, `articulate.ly`, `gregorian.ly`, `bagpipe.ly`, the templates | per file | `\include` (T19, T24, T28) | on `\include`, as files |

Out of Scheme, into Rust (other chapters):

- the backends `framework-svg`, `output-svg`, `framework-ps`, `output-ps`,
  `framework-cairo`, `ps-to-png`, and the Scheme metric tables of the fonts
  (`LILC`, `LILY`), which become binary data: chapter 06;
- `midi.scm` and `scheme-performers.scm`: chapter 07;
- `ly-syntax-constructors.scm`: chapter 02's parser builds music directly
  (chapter 04);
- `operators.scm`'s GOOPS methods on moments: moment arithmetic in the
  numeric operators, so the core has no GOOPS; `lily-library.scm`'s
  regex-match class becomes a record;
- `lily.scm`'s driver (options, files, processes) and `backend-library.scm`'s
  file handling: chapter 08's driver.

Candidates for Rust later, if B6 asks: `scheme-engravers.scm` (179,000
applications in the 30 compiles, per timestep) and `music-functions.scm`'s
music walkers (`music-map`, `music-selective-map`, `recompute-music-length`:
most of the parse phase's 216,000). Both first run as Scheme, so that their
behavior is LilyPond's.

**How a part arrives.** A Worker cannot wait for a fetch in the middle of a
call, so a compile that needs a part stops with "needs part P", the host
fetches and loads it into the heap (as compiled code, no expansion), and the
compile starts again; chapter 02 §5.7 makes the restart cheap, since the
items parsed before are reused. To make the restart rare, the host scans the
source for the triggers of the table (`\chordmode`, `\partCombine`, a
diagram command, `\include`) and fetches what they name before the first
compile. Every part is far below B2's 100 KB.

## 7. Budgets

Proposed for step 11 to confirm; the speed figures are on chapter 00's
Android reference.

| What | Must | Goal | Measured or estimated now |
| --- | --- | --- | --- |
| Interpreter code, uncompressed wasm | 600 KB | 400 KB | 138 KB measured, 355–480 KB extrapolated (§4.2) |
| Interpreter code, brotli (share of B1) | 250 KB | 180 KB | 59 KB measured, 140–190 KB extrapolated |
| Core image, brotli (share of B1) | 450 KB | 300 KB | 300–450 KB estimated (§5.6) |
| Core image restore (share of B5a) | 50 ms | 20 ms | — (a copy of 1.5–2.5 MB) |
| Each part of §6, brotli (B2) | 100 KB | 30 KB | 3–21 KB of source |
| Cost of one Scheme application | 200 ns | 80 ns | 55–190 ns projected from 25–85 ns in V8 on the M1 Max |
| Scheme of a full compile, S scores | 40 ms | 15 ms | 5–19 ms projected for the median score |
| Heap after init, linear memory | 16 MB | 8 MB | — |
| Collector pause | 10 ms | 3 ms | — (B7's 50 ms task includes it) |

The first milestone of the interpreter (for step 11's roadmap) is the
prototype grown to run `lily-library.scm`, `music-functions.scm` and
`music-functions-init.ly` from an image, checked against these budgets on the
phones of chapter 00; missing them by more than a factor of two is the signal
to reconsider s7 (§4.5).

## 8. What later chapters take from here

| Chapter | Takes |
| --- | --- |
| 04 music model | §5.1's foreign objects and epochs; that music, contexts and moments are Rust objects with Scheme faces; `music-functions.scm`'s walkers and `scheme-engravers.scm` as candidates for Rust (§6); `ly-syntax-constructors.scm` moves into the parser |
| 05 layout | grob callbacks: which `output-lib.scm` and `bar-line.scm` procedures run per grob (§2.4); C++ callbacks become direct Rust calls |
| 06 SVG, PDF, fonts | the backends and the fonts' Scheme metric tables leave Scheme (§6); 342,000 reader applications per Emmentaler size are the cost avoided |
| 07 MIDI | `midi.scm` and `scheme-performers.scm` leave Scheme |
| 08 build | the interpreter's budgets (§7); building hot primitives for speed and the rest for size (§4.3); the image built at build time (§5.6); parts as separate fetches (§6); no wasm exception handling, so no C interpreter that needs `setjmp` |
| 09 phone timings | the prototype of §4.1 with the benchmarks of Appendix B, and an image of the core, on the phones |
| 11 roadmap, D56 | the choice of §4.5 and its fallback, the parts of §6, the budgets of §7, the licence question of R15 |

## Appendix A: recipes

The LilyPond checkout and the test scores are those of chapters 00 and 01;
`corpus.tsv` lists `ID path` for the 30 scores.

**Call census** (§2.3, §2.4). Each score is compiled from its own directory
with `census.ly` as a settings file; `-dno-print-pages` leaves the SVG
backend out:

```sh
cd "$(dirname score.ly)" && CENSUS_OUT=<out>/<id>.tsv LANGUAGE=en lilypond --loglevel=ERROR \
  -dno-print-pages -dinclude-settings=/abs/census.ly -o <out>/<id> score.ly
```

```lilypond
%% Counts every Scheme procedure application of a compile, from here (the top of init.ly) on, by phase:
%% "parse" until the first book handler call, then "book" (interpreting, layout, MIDI; pages are not
%% printed with -dno-print-pages). Writes "phase count name file:line" lines to $CENSUS_OUT.
#(use-modules (system vm frame) (system vm vm) (system vm program) (system vm debug))
#(define census-tables (list (cons 'parse (make-hash-table 4096)) (cons 'book (make-hash-table 4096))))
#(define census-counts (assq-ref census-tables 'parse))
#(define (census-hook frame)
   (let* ((ip (frame-instruction-pointer frame))
          (names (or (hashv-ref census-counts ip)
                     (let ((t (make-hash-table 4))) (hashv-set! census-counts ip t) t)))
          (name (frame-procedure-name frame)))
     (hashq-set! names name (1+ (hashq-ref names name 0)))))
#(define (census-dump)
   (set-vm-trace-level! 0)
   (let ((port (open-file (getenv "CENSUS_OUT") "w")))
     (for-each
      (lambda (phase+table)
        (hash-for-each
         (lambda (ip names)
           (let* ((src (find-source-for-addr ip))
                  (where (if src (format #f "~a:~a" (source-file src) (1+ (source-line src))) "")))
             (hash-for-each (lambda (name c) (format port "~a\t~a\t~a\t~a\n" (car phase+table) c (or name "anon") where)) names)))
         (cdr phase+table)))
      census-tables)
     (close-port port))
   (set-vm-trace-level! 1))
#(define census-book-handler toplevel-book-handler)
#(define (toplevel-book-handler book)
   (set! census-counts (assq-ref census-tables 'book))
   (census-book-handler book)
   (census-dump))
#(set-vm-engine! 'debug)
#(vm-add-apply-hook! census-hook)
#(set-vm-trace-level! 1)
```

A line's procedure is LilyPond's when its source file is under
`scm/lily/`, an interpreted `.ly` closure when it is `ice-9/eval.scm`, the
reader and expander when it is `ice-9/read.scm`, `ice-9/psyntax.scm`,
`ice-9/eval-string.scm` or `system/base/language.scm` (and the primitives
these call: `read-char`, `peek-char`, `port-line`, `port-column`, the
`syntax` accessors, `set-source-properties!` and the like), a C++ callback
when it has no source and its name starts with `ly:` or `apply-smob`, a
Guile primitive when it has no source otherwise, and the census's own
overhead when it is under `system/vm/` (left out).

**Static census** (§2.1, §2.2): `static.scm`, loaded by a one-line score
`#(load "/abs/static.scm")` with `STATIC_LIST` (lines `group path`: `scm`,
`ly` or the score's ID) and `STATIC_OUT` in the environment. The R7RS-small
names are the exports of Chibi-Scheme's `lib/scheme/*.sld` for the 15
libraries of R7RS-small (335 names).

```scheme
;; Static census: for each input file, every symbol in code position (quoted data skipped) that is bound
;; in (lily), with the module that provides it. Output lines: "group file symbol provider kind count".
;; Run inside lilypond (so (lily) and the #{ #} reader exist). Env: STATIC_LIST (lines "group path"), STATIC_OUT.
(use-modules (ice-9 rdelim) (ice-9 binary-ports) (rnrs bytevectors) (srfi srfi-1) (system vm program) (system vm debug))
(define lily (resolve-module '(lily)))
(define (provider sym)
  (let ((v (module-variable lily sym)))
    (cond ((not v) #f)
          ((module-local-variable lily sym)
           (let ((x (and (variable-bound? v) (variable-ref v))))
             (cond ((macro? x) "lily-macro")
                   ((and (procedure? x) (string-prefix? "ly:" (symbol->string sym))
                         (not (and (program? x) (find-source-for-addr (program-code x))))) "c++")
                   (else "lily"))))
          (else
           (let loop ((ifs (module-uses lily)))
             (cond ((null? ifs) "unknown")
                   ((module-variable (car ifs) sym) (format #f "~a" (module-name (car ifs))))
                   (else (loop (cdr ifs)))))))))
(define (kind sym)
  (let* ((v (module-variable lily sym)) (x (and v (variable-bound? v) (variable-ref v))))
    (cond ((macro? x) "syntax") ((procedure? x) "procedure") (else "value"))))
(define counts (make-hash-table))
(define (note! group file sym) (let ((k (list group file sym))) (hash-set! counts k (1+ (hash-ref counts k 0)))))
(define (formals->list f)
  (cond ((symbol? f) (list f))
        ((pair? f) (append (formals->list (car f)) (formals->list (cdr f))))
        (else '())))
(define (param-names f) ; lambda, lambda*, define-method and music-function formals
  (let lp ((f f) (acc '()))
    (cond ((symbol? f) (cons f acc))
          ((pair? f) (lp (cdr f) (cond ((symbol? (car f)) (cons (car f) acc))
                                       ((and (pair? (car f)) (symbol? (caar f))) (cons (caar f) acc))
                                       (else acc))))
          (else acc))))
(define definers '(define define-public define* define-public* define-method define-macro defmacro
                   define-markup-command define-markup-list-command define-safe-public define-syntax-rule))
(define (walk-body group file env body) (for-each (lambda (x) (walk* group file env x)) (if (list? body) body '())))
(define (walk* group file env x)
  (cond ((symbol? x) (when (and (not (memq x env)) (module-variable lily x)) (note! group file x)))
        ((and (pair? x) (list? x))
         (let ((h (car x)))
           (when (and (symbol? h) (not (memq h env)) (module-variable lily h)) (note! group file h))
           (cond
            ((memq h '(quote)) #f)
            ((eq? h 'quasiquote) (walk-qq group file env (cdr x)))
            ((and (memq h '(lambda lambda*)) (pair? (cdr x)))
             (walk-body group file (append (param-names (cadr x)) env) (cddr x)))
            ((and (memq h definers) (pair? (cdr x)) (pair? (cadr x)))
             (let lp ((sig (cadr x)) (body (cddr x)) (env env)) ; curried (define ((f a) b) ...)
               (if (pair? (car sig))
                   (lp (car sig) body (append (param-names (cdr sig)) env))
                   (walk-body group file (append (param-names sig) env) body))))
            ((and (memq h '(define-music-function define-scheme-function define-event-function define-void-function))
                  (pair? (cdr x)))
             (walk-body group file (append (param-names (cadr x)) env) (cddr x)))
            ((and (memq h '(let let* letrec letrec*)) (pair? (cdr x)))
             (if (symbol? (cadr x))
                 (when (pair? (cddr x)) ; named let
                   (let ((vars (map (lambda (b) (if (pair? b) (car b) b)) (caddr x))))
                     (for-each (lambda (b) (when (pair? b) (walk-body group file env (cdr b)))) (caddr x))
                     (walk-body group file (cons (cadr x) (append vars env)) (cdddr x))))
                 (let ((vars (map (lambda (b) (if (pair? b) (car b) b)) (cadr x))))
                   (for-each (lambda (b) (when (pair? b) (walk-body group file (if (eq? h 'let) env (append vars env)) (cdr b)))) (cadr x))
                   (walk-body group file (append vars env) (cddr x)))))
            ((and (memq h '(let-values let*-values receive)) (pair? (cdr x)))
             (let ((vars (if (eq? h 'receive) (formals->list (cadr x))
                             (append-map (lambda (b) (if (pair? b) (formals->list (car b)) '())) (cadr x)))))
               (if (eq? h 'receive) (walk* group file env (caddr x))
                   (for-each (lambda (b) (when (pair? b) (walk-body group file env (cdr b)))) (cadr x)))
               (walk-body group file (append vars env) (if (eq? h 'receive) (cdddr x) (cddr x)))))
            ((and (eq? h 'do) (pair? (cdr x)))
             (let ((vars (map (lambda (b) (if (pair? b) (car b) b)) (cadr x))))
               (for-each (lambda (b) (when (pair? b) (walk-body group file env (cdr b)))) (cadr x))
               (walk-body group file (append vars env) (cddr x))))
            ((and (eq? h 'case) (pair? (cdr x)))
             (walk* group file env (cadr x))
             (for-each (lambda (c) (when (pair? c) (walk-body group file env (cdr c)))) (cddr x)))
            (else (walk-body group file env (if (symbol? h) (cdr x) x))))))
        ((pair? x) (let lp ((y x)) (cond ((pair? y) (walk* group file env (car y)) (lp (cdr y))) ((null? y) #f) (else (walk* group file env y)))))
        (else #f)))
(define (walk-qq group file env x)
  (cond ((and (pair? x) (memq (car x) '(unquote unquote-splicing))) (walk-body group file env (cdr x)))
        ((pair? x) (walk-qq group file env (car x)) (walk-qq group file env (cdr x)))
        (else #f)))
(define (walk group file x) (walk* group file '() x))
(define (read-all-scm group path)
  (call-with-input-file path
    (lambda (port)
      (let loop ()
        (let ((x (read port))) (unless (eof-object? x) (walk group path x) (loop)))))))
;; LilyPond input: find # and $ outside comments and strings, read one datum there with Guile's reader.
(define (read-all-ly group path)
  (let* ((bv (call-with-input-file path get-bytevector-all #:binary #t)) (n (bytevector-length bv))
         (port (open-bytevector-input-port bv)))
    (set-port-encoding! port "UTF-8")
    (define (b i) (bytevector-u8-ref bv i))
    (define (find-from i pred) (let lp ((i i)) (cond ((>= i n) n) ((pred i) i) (else (lp (1+ i))))))
    (let loop ((i 0))
      (when (< i n)
        (let ((c (b i)))
          (cond
           ((= c 37) ; %
            (if (and (< (1+ i) n) (= (b (1+ i)) 123)) ; %{
                (loop (+ 2 (find-from (+ i 2) (lambda (j) (and (= (b j) 37) (< (1+ j) n) (= (b (1+ j)) 125))))))
                (loop (find-from i (lambda (j) (= (b j) 10))))))
           ((= c 34) ; "
            (loop (1+ (let lp ((j (1+ i))) (cond ((>= j n) n) ((= (b j) 92) (lp (+ j 2))) ((= (b j) 34) j) (else (lp (1+ j))))))))
           ((and (memv c '(35 36)) (< (1+ i) n)) ; # $
            (let ((d (b (1+ i))))
              (if (memv d '(123 125)) (loop (+ i 2))
                  (let ((start (if (= d 64) (+ i 2) (1+ i))))
                    (seek port start SEEK_SET)
                    (let ((x (catch #t (lambda () (read port)) (lambda args (format (current-error-port) "read error ~a at ~a\n" path start) #f))))
                      (when x (walk group path x))
                      (loop (max (1+ i) (ftell port))))))))
           (else (loop (1+ i)))))))))
(for-each
 (lambda (line)
   (let* ((sp (string-index line #\space)) (group (substring line 0 sp)) (path (substring line (1+ sp))))
     (if (string-suffix? ".scm" path) (read-all-scm group path) (read-all-ly group path))))
 (let ((p (open-input-file (getenv "STATIC_LIST"))))
   (let lp ((acc '())) (let ((l (read-line p))) (if (eof-object? l) (reverse acc) (lp (if (string-null? l) acc (cons l acc))))))))
(let ((out (open-output-file (getenv "STATIC_OUT"))))
  (hash-for-each (lambda (k c) (format out "~a\t~a\t~a\t~a\t~a\t~a\n" (car k) (basename (cadr k)) (caddr k) (provider (caddr k)) (kind (caddr k)) c)) counts)
  (close-port out))
```

**Reachable objects after init** (§5.6): a score that walks `(lily)` and
the parser's module after `init.ly`'s session replay.

```lilypond
%% Counts what is reachable from the (lily) module and the session's parser module after init:
%% pairs, vectors, strings (and their chars), symbols, procedures, other objects.
#(use-modules (system vm program))
#(define seen (make-hash-table 200000))
#(define counts (make-hash-table))
#(define (bump! k n) (hashq-set! counts k (+ n (hashq-ref counts k 0))))
#(define (walk x) (catch #t (lambda () (walk1 x)) (lambda e (bump! (quote errors) 1))))
#(define (walk1 x)
   (cond ((or (null? x) (boolean? x) (char? x) (unspecified? x) (and (number? x) (exact? x) (integer? x) (< (abs x) (ash 1 61)))) #f)
         ((hashq-ref seen x) #f)
         (else
          (hashq-set! seen x #t)
          (cond ((pair? x) (bump! 'pairs 1) (walk (car x)) (walk (cdr x)))
                ((vector? x) (bump! 'vectors 1) (bump! 'vector-slots (vector-length x)) (let lp ((i 0)) (when (< i (vector-length x)) (walk (vector-ref x i)) (lp (1+ i)))))
                ((string? x) (bump! 'strings 1) (bump! 'string-chars (string-length x)))
                ((symbol? x) (bump! 'symbols 1) (bump! 'symbol-chars (string-length (symbol->string x))))
                ((number? x) (bump! 'other-numbers 1))
                ((procedure? x) (bump! (if (program? x) 'procedures 'applicable-other) 1))
                ((module? x) (bump! 'modules 1) (module-for-each (lambda (k v) (bump! 'bindings 1) (walk k) (when (variable-bound? v) (walk (variable-ref v)))) x))
                ((hash-table? x) (bump! 'hash-tables 1) (hash-for-each (lambda (k v) (bump! 'hash-entries 1) (walk k) (walk v)) x))
                ((ly:music? x) (bump! 'music 1) (walk (ly:music-mutable-properties x)))
                ((ly:context-def? x) (bump! 'context-defs 1))
                ((ly:output-def? x) (bump! 'output-defs 1) (walk (ly:output-def-scope x)))
                (else (bump! 'other 1))))))
#(walk (resolve-module '(lily)))
#(walk (current-module))
#(let ((l '())) (hash-for-each (lambda (k v) (set! l (cons (cons k v) l))) counts)
   (for-each (lambda (p) (format #t "~a ~a\n" (car p) (cdr p))) (sort l (lambda (a b) (string<? (symbol->string (car a)) (symbol->string (car b)))))))
#(format #t "gc-stats ~a\n" (filter (lambda (p) (memq (car p) '(heap-size heap-free-size heap-total-allocated))) (gc-stats)))
```

**Profile** (§2.5), as a settings file, with `PROF_OUT` in the
environment; Guile's `statprof` samples every 500 µs of CPU time:

```lilypond
%% Samples the compile with statprof from here on and prints self time by procedure at the end of the last book.
#(use-modules (statprof))
#(define prof-handler toplevel-book-handler)
#(define (toplevel-book-handler book)
   (prof-handler book)
   (statprof-stop)
   (let ((port (open-file (getenv "PROF_OUT") "w")))
     (statprof-display port #:style 'flat)
     (close-port port)))
#(statprof-reset 0 500 #f)
#(statprof-start)
```

## Appendix B: the benchmarks and the builds

The eight benchmarks, each printing one line (expected output in the
comment); b0 prints `ok` and is subtracted from process timings.

```scheme
;;; b1-fib.scm, prints 832040
(define (fib n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2)))))
(display (fib 30)) (newline)
;;; b2-tak.scm, prints 9
(define (tak x y z) (if (not (< y x)) z (tak (tak (- x 1) y z) (tak (- y 1) z x) (tak (- z 1) x y))))
(display (tak 22 16 8)) (newline)
;;; b3-loop.scm, prints 2999997 #t
;; tail calls: a named let and two mutually recursive procedures, 1e6 iterations each
(define (my-even? n) (if (= n 0) #t (my-odd? (- n 1))))
(define (my-odd? n) (if (= n 0) #f (my-even? (- n 1))))
(display (let loop ((i 0) (acc 0)) (if (= i 1000000) acc (loop (+ i 1) (+ acc (remainder i 7))))))
(display " ") (display (my-even? 1000000)) (newline)
;;; b4-alist.scm, prints 4679166
;; grob-property-like lookups: a chain of alists searched front to back (ly:assoc-get, ly:chain-assoc-get)
(define (make-props prefix n)
  (let loop ((i 0) (acc '()))
    (if (= i n) acc
        (loop (+ i 1) (cons (cons (string->symbol (string-append prefix (number->string i))) i) acc)))))
(define chain (list (make-props "override-" 8) (make-props "prop-" 40) (make-props "default-" 60)))
(define keys (list->vector (append (map car (car chain)) (map car (cadr chain)) (map car (caddr chain)) (list 'missing))))
(define (chain-get key chain default)
  (if (null? chain) default
      (let ((hit (assq key (car chain)))) (if hit (cdr hit) (chain-get key (cdr chain) default)))))
(define (run n)
  (let loop ((i 0) (sum 0) (chain chain))
    (if (= i n) sum
        (let ((k (vector-ref keys (remainder i (vector-length keys)))))
          (loop (+ i 1) (+ sum (chain-get k chain 0))
                (if (= (remainder i 1000) 0) (cons (list (cons 'tmp i)) (cdr chain)) chain))))))
(display (run 200000)) (newline)
;;; b5-lists.scm, prints 2186398299
;; list work: build, merge sort, map, filter, fold, reverse, append
(define (lcg-list n seed)
  (let loop ((i 0) (x seed) (acc '()))
    (if (= i n) acc (let ((y (remainder (+ (* x 1103) 12345) 65536))) (loop (+ i 1) y (cons y acc))))))
(define (split l) (if (or (null? l) (null? (cdr l))) (values l '())
  (call-with-values (lambda () (split (cddr l))) (lambda (a b) (values (cons (car l) a) (cons (cadr l) b))))))
(define (merge a b) (cond ((null? a) b) ((null? b) a) ((< (car a) (car b)) (cons (car a) (merge (cdr a) b))) (else (cons (car b) (merge a (cdr b))))))
(define (msort l) (if (or (null? l) (null? (cdr l))) l (call-with-values (lambda () (split l)) (lambda (a b) (merge (msort a) (msort b))))))
(define (filter p l) (cond ((null? l) '()) ((p (car l)) (cons (car l) (filter p (cdr l)))) (else (filter p (cdr l)))))
(define (fold f acc l) (if (null? l) acc (fold f (f (car l) acc) (cdr l))))
(define (round1 seed)
  (let* ((l (lcg-list 5000 seed)) (s (msort l)) (m (map (lambda (x) (* 2 x)) s))
         (f (filter (lambda (x) (= 0 (remainder x 3))) m)) (r (append (reverse f) f)))
    (+ (fold + 0 r) (length r) (car s))))
(display (let loop ((i 0) (acc 0)) (if (= i 10) acc (loop (+ i 1) (+ acc (round1 i)))))) (newline)
;;; b6-strings.scm, prints 1800000
;; strings and symbols: what markup, property names and format-like code do
(define (pad n) (let ((s (number->string n))) (if (< (string-length s) 5) (string-append (make-string (- 5 (string-length s)) #\0) s) s)))
(define (run n)
  (let loop ((i 0) (total 0))
    (if (= i n) total
        (let* ((s (string-append "note-" (pad i) "-" (symbol->string 'Staff)))
               (sym (string->symbol s))
               (back (symbol->string sym))
               (up (list->string (map char-upcase (string->list (substring back 0 4))))))
          (loop (+ i 1) (+ total (string-length back) (if (string=? up "NOTE") 1 0) (if (eq? sym (string->symbol s)) 1 0)))))))
(display (run 100000)) (newline)
;;; b7-closures.scm, prints 25004150000
;; higher-order code: closures, rest arguments, apply, multi-list map (music functions, callbacks)
(define (compose . fs) (if (null? fs) (lambda (x) x) (let ((f (car fs)) (g (apply compose (cdr fs)))) (lambda (x) (f (g x))))))
(define (make-adder n) (lambda (x) (+ x n)))
(define (sum . xs) (let loop ((xs xs) (acc 0)) (if (null? xs) acc (loop (cdr xs) (+ acc (car xs))))))
(define fs (map make-adder '(1 2 3 4 5 6 7 8)))
(define h (apply compose fs))
(define (run n)
  (let loop ((i 0) (acc 0))
    (if (= i n) acc
        (loop (+ i 1) (+ acc (h i) (apply sum (map (lambda (a b) (* a b)) (list i 1 2) (list 3 i 4))))))))
(display (run 100000)) (newline)
```

b8 is generated (`node gen-b8.mjs > b8-load.scm`, 207,845 bytes, prints
`416`):

```js
// b8-load.scm: a ~100 KB file of definitions, the size of an scm/ module, evaluated once (read + eval cost)
const out = []
for (let i = 0; i < 700; i++) {
  out.push(`(define (f${i} x y) (if (< x y) (cons x (list y 'sym${i} "string ${i}")) (let ((z (+ x y ${i}))) (cond ((> z 100) (* z 2)) ((= z 0) 'zero) (else (list z x y))))))`)
  out.push(`(define data${i} '((name . grob${i}) (stencil . ${i}) (X-extent ${i} . ${i + 1}) (meta (class . Item) (interfaces grob-interface item-interface))))`)
}
out.push(`(define (check i acc) (if (= i 700) acc (check (+ i 1) (+ acc (cdr (assq 'stencil (eval (string->symbol (string-append "data" (number->string i))) (interaction-environment))))))))`)
out.push('(display (+ (length (f3 1 2)) (f5 200 1))) (newline)')
process.stdout.write(out.join('\n') + '\n')
```

`run.mjs <module.wasm>`, the runner of §4.1 (Node 24):

```js
// node run.mjs <module.wasm> [bench ...]: times a Scheme interpreter built to the bench ABI.
// ABI: exports memory, lsb_init() -> i32 (0 = ok), lsb_alloc(len) -> ptr, lsb_eval(ptr, len) -> i32 (0 = ok).
// Output goes to WASI stdout, or, for a module without WASI imports, to the import env.lsb_write(ptr, len).
// Each run is a fresh instance: init is the interpreter's own start-up, eval the benchmark alone.
import { readFileSync, readdirSync } from 'node:fs'
import { WASI } from 'node:wasi'
import path from 'node:path'
const here = path.dirname(new URL(import.meta.url).pathname)
const [file, ...only] = process.argv.slice(2)
const RUNS = +(process.env.RUNS ?? 5)
const bytes = readFileSync(file)
let t = performance.now(); const mod = await WebAssembly.compile(bytes); const compileMs = performance.now() - t
const usesWasi = WebAssembly.Module.imports(mod).some((i) => i.module.startsWith('wasi'))
async function instance(out) {
  const imports = {}
  let wasi
  if (usesWasi) {
    wasi = new WASI({ version: 'preview1', args: ['lsb'], env: {}, preopens: { '/': here }, returnOnExit: true,
      stdout: out.fd, stderr: 2 })
    Object.assign(imports, wasi.getImportObject())
  }
  let inst
  const env = { lsb_write: (p, n) => { out.text += Buffer.from(inst.exports.memory.buffer, p, n).toString() },
    lsb_now: () => performance.now() }
  imports.env = new Proxy(env, { get: (o, k) => o[k] ?? (() => { throw new Error(`import env.${String(k)} called`) }) })
  for (const i of WebAssembly.Module.imports(mod)) if (i.module !== 'env' && !imports[i.module]) imports[i.module] = new Proxy({}, { get: (_, k) => () => { throw new Error(`import ${i.module}.${String(k)} called`) } })
  inst = await WebAssembly.instantiate(mod, imports)
  if (wasi) wasi.initialize(inst)
  return inst
}
const { openSync, readFileSync: rf, closeSync } = await import('node:fs')
const benches = readdirSync(here).filter((f) => /^b\d.*\.scm$/.test(f) && (only.length === 0 || only.some((o) => f.startsWith(o)))).sort()
const results = { module: path.basename(file), bytes: bytes.length, compileMs: +compileMs.toFixed(1), benches: {} }
const med = (v) => v.sort((a, b) => a - b)[v.length >> 1]
for (const b of benches) {
  const src = readFileSync(path.join(here, b))
  const inits = []; const evals = []; let output = ''; let mem = 0
  for (let r = 0; r < RUNS; r++) {
    const outPath = path.join(process.env.TMPDIR ?? '/tmp', `lsb-${process.pid}.out`)
    const out = { fd: openSync(outPath, 'w'), text: '' }
    let t0 = performance.now(); const inst = await instance(out)
    const rc0 = inst.exports.lsb_init(); const t1 = performance.now()
    const p = inst.exports.lsb_alloc(src.length)
    new Uint8Array(inst.exports.memory.buffer, p, src.length).set(src)
    const t2 = performance.now(); const rc = inst.exports.lsb_eval(p, src.length); const t3 = performance.now()
    closeSync(out.fd); output = (out.text + rf(outPath, 'utf8')).trim()
    if (rc0 !== 0 || rc !== 0) output = `ERROR init=${rc0} eval=${rc}: ${output}`
    inits.push(t1 - t0); evals.push(t3 - t2); mem = inst.exports.memory.buffer.byteLength
  }
  results.benches[b] = { output, initMs: +med(inits).toFixed(2), evalMs: +med(evals).toFixed(1), memoryMB: +(mem / 2 ** 20).toFixed(1) }
  console.error(b, JSON.stringify(results.benches[b]))
}
console.log(JSON.stringify(results))
```

The builds, with `W` the wasi-sdk 34 directory and `B` binaryen 133's
`bin`; each wasm file is validated by `wasm-opt` with only
`--mvp-features --enable-bulk-memory --enable-sign-ext
--enable-mutable-globals --enable-nontrapping-float-to-int
--enable-multivalue --enable-reference-types --enable-simd` (s7 also needs
`--enable-exception-handling`), and sizes are taken with `gzip -9` and
`brotli -q 11`:

```sh
# s7: s7.c patched for WASI (setjmp for sigsetjmp, no getrusage); lsb_s7.c wraps s7_init and s7_load_c_string
$W/bin/clang --target=wasm32-wasip1 -mexec-model=reactor -Oz -flto -fno-exceptions -mllvm -wasm-enable-sjlj \
  -DNDEBUG -DWITH_SYSTEM_EXTRAS=0 -DWITH_C_LOADER=0 -DDISABLE_DEPRECATED=1 -DWITH_GMP=0 -D_WASI_EMULATED_PROCESS_CLOCKS \
  -I. s7.c lsb_s7.c -Wl,--strip-debug -Wl,-mllvm,-wasm-enable-sjlj -lsetjmp -lwasi-emulated-process-clocks -lm -o s7.link.wasm
$B/wasm-opt -Oz --strip-debug --strip-producers --strip-target-features s7.link.wasm -o s7.wasm

# Chibi: gc sexp bignum gc_heap opcodes vm eval simplify, a clibs.c from chibi-genstatic for the 10 C libraries of
# (scheme small), about 45 lines of ENOSYS stubs for signals, fork and chown; lsb_chibi.c loads (scheme small)
CF="-Oz -flto -DNDEBUG -fno-exceptions -DSEXP_USE_DL=0 -DSEXP_USE_STATIC_LIBS=1 -DSEXP_USE_GREEN_THREADS=0 \
  -DSEXP_USE_STRICT_TOPLEVEL_BINDINGS=1 -DSEXP_USE_ALIGNED_BYTECODE=1 -DSEXP_USE_INTTYPES"
$W/bin/clang --target=wasm32-wasip1 -mexec-model=reactor $CF ... -o chibi.link.wasm && $B/wasm-opt -Oz ... -o chibi.wasm

# Steel: a cdylib on steel-core (path dependency, default-features = false, features = ["std"]),
# [profile.release] opt-level = "z", lto = true, codegen-units = 1, panic = "abort", strip = true;
# lsb_init = Engine::new() and a string port as current-output-port; lsb_eval = compile_and_run_raw_program.
# Two shims: display prints #t/#f, and eval accepts and ignores an environment (interaction-environment returns #f).
cargo build --release --target wasm32-unknown-unknown && $B/wasm-opt -Oz steel.wasm -o steel.opt.wasm

# Prototype: the same profile, std only; a speed build with opt-level = 3 and wasm-opt -O3
cargo build --lib --target wasm32-unknown-unknown --release && $B/wasm-opt -Oz custom.wasm -o custom.opt.wasm
```

Native timings are process wall time per benchmark, median of three, minus
b0's; Guile's are `guile --no-auto-compile file.scm` the same way.
