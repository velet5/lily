# 02 — A small parser for the whole syntax

Chapter 02 of the investigation into an engine of our own (chapter 00 sets
the budgets and the test set, chapter 01 maps LilyPond's source). It takes
LilyPond's lexer and grammar apart (§2, §3), measures what the 30 scores of
chapter 00 use of them (§4), and designs a hand-written Rust parser that
covers the same syntax, builds the same music, reports the same errors and
re-parses only what an edit touches (§5). §6 orders the syntax into steps for
the roadmap, and §7 describes the test material this step adds to the
repository: a syntax corpus that reaches every nonterminal of the grammar and
an error corpus for layer C0. It records no decision; D56 (step 11) will.

Everything refers to LilyPond at tag `v2.26.0` (commit
`3596756be0fac1f81066a99d2054329212172b2d`). **[measured]** marks what was
taken on 2026-10-03 from that checkout and from `GNU LilyPond 2.26.0
(running Guile 3.0)` of Homebrew on the M1 Max of chapter 00; the recipes are
in Appendix A.

## 1. What LilyPond's parser is made of

**[measured]**

| File | Lines | What it is |
| --- | --- | --- |
| `lily/lexer.ll` | 1,354 | Flex lexer: 14 start conditions (13 `%x` and `INITIAL`) |
| `lily/parser.yy` | 4,931 | Bison grammar: 189 nonterminals, 601 productions (plus 32 mid-rule actions), 108 token declarations, LALR(1) with `%define parse.error verbose` |
| `lily/lily-lexer.cc` | 387 | the 45 keywords, scopes, identifier lookup, pitch-name tables |
| `lily/includable-lexer.cc` | 140 | the stack of input buffers for `\include` |
| `lily/parse-scm.cc` | 376 | reading and evaluating embedded Scheme, Guile error reports |
| `lily/lily-parser.cc`, `lily-parser-scheme.cc` | 298 + 420 | the parser object; 16 Scheme functions (`ly:parse-file`, `ly:parser-include-string`, `ly:parse-string-expression`, …) |
| `lily/music-function.cc` | 174 | calling a music function, its type checks |
| `scm/ly-syntax-constructors.scm` | 386 | 30 public constructors the grammar's actions call to build music |
| `scm/parser-ly-from-scheme.scm` | 170 | the `#{ … #}` reader extension |

Read side by side, they are not a parser of text in the usual sense. Three
loops run through the Scheme interpreter while the file is read, and each
decides how the following text is split up:

1. **The lexer classifies `\name` by the value bound to it.** `\foo` becomes
   one of 14 token kinds (`MUSIC_FUNCTION`, `EVENT_IDENTIFIER`,
   `PITCH_IDENTIFIER`, `MARKUP_FUNCTION`, …) according to what `foo` holds at
   that moment, and the grammar has different rules for each (§2.3).
2. **Music functions steer the grammar with their signatures.** When the
   lexer returns a function, it queues one synthetic token per parameter,
   carrying the parameter's type predicate. The grammar calls the predicates
   while it parses, and their answers decide which tokens form an argument,
   whether an optional argument was given, and how the tokens are re-read
   (§3.2).
3. **Scheme is read by Guile and can re-enter the parser.** `#` reads one
   datum with Guile's reader and the grammar evaluates it when the rule that
   holds it is reduced; `$` is evaluated by the lexer at once. A `#{ … #}`
   inside Scheme is parsed again, by a clone of the parser, every time it is
   evaluated (§2.4).

The grammar's actions also have effects that later tokens see: an assignment
defines its variable as soon as it is reduced, `\include` switches the input
buffer from inside the lexer, and blocks push and pop lexer modes. A parser
of LilyPond must therefore run alongside the Scheme interpreter of chapter
03; it cannot parse a file first and evaluate it afterwards.

## 2. The lexer

### 2.1 Modes

The lexer's start conditions, and what pushes each one:

| Mode | Pushed by | A bare word is |
| --- | --- | --- |
| `notes` | the start of every file and of `#{ … #}`, `\notemode`, `\with { … }`, context definitions and music inside output definitions, `\score` in markup; `\drummode`/`\drums` with the table `drumPitchNames` | a pitch name of the current language (`NOTENAME_PITCH`), a drum name (`DRUM_PITCH`), `r`/`s` (`RESTNAME`), `R`, `q`, else a `SYMBOL` |
| `chords` | `\chordmode`, `\chords` | a pitch (`TONICNAME_PITCH`), a chord modifier (`m`, `dim`, `maj`, … from `chordmodifiers`), else a `SYMBOL`; `-` `:` `^` `/` `/+` are chord operators |
| `figures` | `\figuremode`, `\figures` | a `SYMBOL`; `<` `>` open and close a figure, `_` is a blank, `+ - !` runs are alterations, `\+ \! \\ /` modify a figure |
| `lyrics` | `\lyricmode`, `\lyrics`, `\addlyrics`, `\lyricsto` | a run of characters but white space, digits and `{ } " # $ \`, not starting with `\| * . =`; `_` inside it becomes a space; `--` and `__` are hyphen and extender |
| `markup` | `\markup`, `\markuplist` | any run of characters but white space and `{ } " # $ \`; `\name` is looked up as a markup command first |
| `INITIAL` | the bodies of output definitions (`\paper`, `\layout`, `\midi`) | a `SYMBOL` (property names such as `line-width`) |
| `quote`, `commandquote` | `"` and `\"` | string contents; `\n \t \\ \" \'` are escapes, any other backslash is kept |
| `longcomment` | `%{` | comment text up to `%}` |
| `incl`, `version`, `sourcefilename`, `sourcefileline` | `\include`, `\version`, `\sourcefilename`, `\sourcefileline` | the one argument these take |
| `maininput` | `\maininput` in `init.ly` | the boundary between `init.ly` and the score |

Every mode but the string modes treats `%` at the start of a token as a
comment, `"` as a string, and `#` or `$` as Scheme; `{` and `}` are tokens in
all of them. So brace structure, strings, comments and Scheme extents can be
found without knowing the mode. The one exception is a `%` in the middle of a
word: in lyrics and markup `a%b` is one word, in notes it is `a` followed by
a comment.

The grammar switches modes in mid-rule actions, which must run before Bison
reads the next token. That is why some rules look odd (`markup_mode_word`,
`music_or_context_def`, the comments around `\maininput` in `init.ly`): each
exists so that the token after a mode switch is lexed in the new mode.

### 2.2 Words, numbers and strings

- A letter is `[a-zA-Z]` or any byte from `0x80` up, so every non-ASCII
  character is a letter: `mélodie` is a word and `\mélodie` a command. A
  word is letters with single `-` or `_` between them; a command is `\` and a
  word.
- `\` followed by one character, or a lone special character, is a
  *shorthand* looked up as an identifier: `\(`, `\[`, `\<`, `\!`, `~`, `(`,
  `[`, `|`. They are defined in the init files like any other variable.
- Numbers: `UNSIGNED` (`4`), `FRACTION` (`3/4`), `REAL` (`1.5`, `-2`, `.5`),
  `E_UNSIGNED` (`\1`, a string number). Durations, multipliers (`*3/2`),
  tremolos (`:16`) and dimensions (`2\cm`, a number followed by a
  `NUMBER_IDENTIFIER`) are built by the grammar from these.
- Input is checked to be UTF-8 (`non-UTF-8 input` is a warning) and a byte
  order mark is skipped.

### 2.3 How `\name` becomes a token

`scan_escaped_word` and `scan_scm_id` (`lexer.ll`) with
`try_special_identifiers` (`parser.yy`) decide, in this order:

1. In markup mode only: `\score` and `\score-lines` are keywords, and a
   markup command or markup list command found by `lookup-markup-command`
   becomes `MARKUP_FUNCTION` or `MARKUP_LIST_FUNCTION`, followed by one
   `EXPECT_MARKUP`, `EXPECT_MARKUP_LIST` or `EXPECT_SCM` token per argument.
   A markup command shadows a keyword or variable of the same name.
2. One of the 45 keywords (`\score`, `\new`, `\override`, `\etc`, …) is its
   own token. `\version`, `\include`, `\maininput`, `\sourcefilename` and
   `\sourcefileline` are handled by the lexer and never reach the grammar.
3. Otherwise the name is looked up through the scopes, from the innermost
   (a `\header`, `\paper`, `\layout` or `\midi` block being read) out to
   the file's module. Not found: ``unknown command: `\foo'``, and the token
   is a `STRING`, which usually adds a second error (§3.4).
4. A music function becomes `MUSIC_FUNCTION`, `EVENT_FUNCTION` or
   `SCM_FUNCTION`, by whether its result predicate is `ly:music?`,
   `ly:event?` or anything else, followed by its argument tokens (§3.2).
5. Any other value becomes `BOOK_IDENTIFIER`, `NUMBER_IDENTIFIER`,
   `EVENT_IDENTIFIER` (music that is a post-event), `MUSIC_IDENTIFIER`,
   `PITCH_IDENTIFIER`, `DURATION_IDENTIFIER`, `LOOKUP_IDENTIFIER` (an alist,
   for `\name.key`), `MODULE_IDENTIFIER` (a module, such as a header) or
   `SCM_IDENTIFIER` (context definitions and modifications, output
   definitions, scores, anything else). Music, books, scores and definitions
   are copied on every use.

Bare words go through tables instead: the pitch names of the current
language (`\language` replaces them; `define-note-names.scm` holds 1,366
lines of them), `drumPitchNames` and `chordmodifiers`. At the top level the
lexer is in notes mode, so a variable cannot be named after a note: `a = { c8
}` is ``syntax error, unexpected NOTENAME_PITCH`` **[measured]**.

### 2.4 Scheme: `#`, `$`, `#@`, `$@` and `#{ … #}`

- **`#`** hands the text from the next byte to Guile's `read` on a port laid
  over the source, which consumes exactly one datum. The token
  (`SCM_TOKEN`) carries the unevaluated form; the grammar evaluates it with
  `eval_scm_token` when it reduces the rule that holds it, with the fluid
  `*location*` set to the datum's position.
- **`$`** is read the same way and evaluated by the lexer at once. Its value
  is then classified like the value of a `\name` (§2.3): `$(make-music …)`
  is a `MUSIC_IDENTIFIER`, a markup procedure in markup mode is a
  `MARKUP_FUNCTION`.
- **`#@` and `$@`** evaluate to a list whose elements become several tokens.
- **`#{ … #}`** is a Guile reader extension (`parser-ly-from-scheme.scm`).
  At read time it copies the text up to `#}` and turns each `#` or `$` form
  inside it into a closure keyed by its byte offset, so the inner Scheme sees
  the outer lexical variables. At evaluation time `ly:parser-clone` makes a
  new parser and `ly:parse-string-expression` parses the text, starting at the
  synthetic token `EMBEDDED_LILY`; the inner Scheme is taken from the
  closures instead of being read again (`closures_` in `parse-scm.cc`). The
  text is parsed again on every evaluation: a music function whose body is a
  `#{ … #}` re-parses it at each call.

Scheme errors are caught: the form evaluates to *unspecified*, the file is
marked as failed, and the report reads `Guile signaled an error for the
expression beginning here` followed by Guile's own message (§3.4).

### 2.5 Sources: `\include`, included strings and locations

- **`\include`** is handled by the lexer: its argument is a string, a
  `\name` holding a string, or a `#`/`$` form evaluating to one, and the file
  is pushed as a new input buffer. An include can therefore stand anywhere a
  token can, in the middle of music. With `relative-includes` (on by default
  in 2.26) the file is looked for in the directory of the including file,
  then along the search path: the directory lilypond was started in, the
  `-I` directories, and LilyPond's own `ly/`, `ps/`, `scm/` and font
  directories (corpus case 07 prints it).
- **`ly:parser-include-string`** pushes a string as an input buffer named
  `<included string>` (T16); `ly:parser-parse-string` and
  `ly:parse-string-expression` parse a string with a new parser.
- **Locations** (`input.cc`, `source-file.cc`, P2 of chapter 01) are byte
  ranges in a source file. Diagnostics print `file:line:column`, with the
  column counted in characters and tabs expanded to multiples of 8
  **[measured]** (corpus cases 26 and 27); the `textedit://` links and the
  playback map print line, character and column.

## 3. The grammar

### 3.1 Areas

**[measured]**: the grammar's productions by area, by the line ranges of
`parser.yy`, and how many of them the 30 scores reach (main files, their
includes and the `#{ … #}` they evaluate) and all inputs together (the 30,
the init files and the three grammar snapshot inputs of §7).

| Area | `parser.yy` lines | Nonterminals | Productions | By the 30 | By all inputs |
| --- | --- | --- | --- | --- | --- |
| toplevel, assignments, embedded Scheme | 408–816 | 20 | 90 | 40 | 57 |
| partial functions (`\etc`) | 817–940 | 2 | 21 | 2 | 3 |
| context definitions | 941–1017 | 3 | 7 | 6 | 6 |
| books, scores, output definitions | 1018–1450 | 14 | 48 | 24 | 31 |
| music: sequences, repeats, contexts, `\with`, lyrics combining | 1451–1776 | 26 | 63 | 52 | 55 |
| music function argument lists | 1777–2660 | 18 | 96 | 37 | 46 |
| mode switches, property operations, strings, symbols | 2661–3104 | 23 | 70 | 49 | 56 |
| chords, post-events, scripts, pitches | 3105–3498 | 26 | 68 | 51 | 57 |
| durations, tremolo, figured bass | 3499–3712 | 14 | 36 | 30 | 32 |
| notes, rests, lyrics, chord-mode chords | 3713–3924 | 11 | 27 | 24 | 26 |
| numbers | 3925–4049 | 9 | 24 | 12 | 17 |
| markup | 4050–4355 | 23 | 51 | 32 | 41 |
| **total** | | **189** | **601** | **359** | **427** |

The 30 scores reach 171 of the 189 nonterminals, the init files 3 more, and
the grammar snapshot inputs (the syntax corpus of §7 above all) the
remaining 15. The 174 productions no input
reaches are mostly variants of the argument-list rules for one token kind
after another (§3.2), `error` productions, and partial functions.

What the actions build: music through the constructors of
`ly-syntax-constructors.scm` (`sequential-music`, `context-create`,
`property-override`, `repeat`, `lyric-combine`, `music-function`,
`argument-error`, …) and through `make-music` directly for events; books,
scores and output definitions as C++ objects; and toplevel results handed to
the handlers of `lily-library.scm` (`toplevel-music-handler`,
`toplevel-score-handler`, `toplevel-text-handler`, `toplevel-book-handler`,
and their `book-` and `bookpart-` counterparts), which collect the scores
that the end of `init.ly` turns into a book.

### 3.2 Music function arguments

A third of the productions (96) parse the arguments of music, event and
Scheme functions. `scan_scm_id` queues, after the function's token,
`EXPECT_SCM` with the predicate for each parameter (preceded by
`EXPECT_OPTIONAL` with the default when the parameter is optional) and
`EXPECT_NO_MORE_ARGS`, in reverse order, so the grammar sees the last
parameter first and nests the argument list inside out. Then:

- **An argument is the longest unit that can start there**: a Scheme value,
  music (`{ … }`, a function call, a note with its duration and
  post-events), a pitch, a duration, a number with its unit, a string, a
  word, a symbol list (`Staff.TimeSignature`), markup, or a post-event. The
  grammar tries readings in a fixed order and asks the predicate: a word may
  be a string, a symbol or a symbol list (`try_word_variants`); a pitch or a
  duration may become a note if the predicate wants music
  (`make_music_from_simple`); `4` may be a number, a duration or a note.
- **`REPARSE`**: when the reading the predicate accepts is not the one the
  grammar took, the action pushes the token back with its new kind and a
  `REPARSE` token, and the grammar reads it again.
- **`BACKUP`**: when an optional argument's predicate rejects what is there
  and a mandatory parameter follows, the optional argument takes its default
  and the value is pushed back, after a `BACKUP` token, for the next
  parameter. Several optional parameters in a row are skipped together.
  Trailing optional parameters can only be skipped with `\default`.
- **`\etc`** ends the argument list early and makes a partial function
  (`colorBlue = \color #blue \etc`); `\override … = \etc`, `\set … = \etc`,
  `\repeat` and script directions can be partial too.
- **A rejected argument** gives `wrong type for argument N.  Expecting X,
  found Y` (`argument-error`), located at the argument, and the call
  evaluates to nothing.

Pushed-back tokens keep their values, so no Scheme is evaluated twice. In
the 30 scores, `BACKUP` occurs in 20 and `REPARSE` in 18 **[measured]**
(§4): predicate-driven re-reading is everyday syntax (`\relative` with and
without a pitch, `\tuplet 3/2` with an optional span, `\key g \major`), not
a corner case.

### 3.3 State carried from one token to the next

What a parse carries besides the Bison stack, all of which a re-parse that
starts in the middle of a file must restore:

- the lexer's mode stack and, for notes and chords, the pitch-name table
  stack (`\language` changes the table for the rest of the file);
- the scope stack: the file's module, and the module of a `\header` block
  or output definition while inside it; assignments define into the
  innermost scope at once;
- **the default duration**: a note without one takes the previous note's,
  in parse order and across toplevel items: after `first = { c8 }`,
  `second = { d }` holds `d8` **[measured]**;
- the default tremolo (`:` alone repeats the last `:16`);
- the queue of synthetic tokens (§3.2), the input buffer stack, the error
  flag, and `$current-book`, `$defaultpaper`, `$defaultlayout`,
  `$defaultmidi`, `$defaultheader`, which the actions read and set.

**When `$` runs.** Bison reads one token ahead before it reduces most rules,
so a `$` right after an assignment is evaluated before the assignment is
made. **[measured]**: after `num = 1`, `mus = { c4 }`, `str = "s"` and
`fun = \relative { c4 }`, a `$(defined? '…)` on the next line sees the
variable undefined; after `scm = #5` and `mkp = \markup \bold z` it sees it
defined, because Bison reduces those states without reading ahead.

### 3.4 Errors

Errors come from three places, and C0 compares all of them:

- **The lexer**: unknown command, undefined shorthand, unterminated string or
  comment, `quoted string expected after \version`, `cannot find file`,
  non-UTF-8 input.
- **Bison**: `syntax error, unexpected X`, where X is the token's display
  name from `parser.yy` (`'}'`, `NOTENAME_PITCH`, `"\\header"`, `end of
  input`), and `, expecting A or B` when four or fewer tokens could follow.
  Recovery uses `error` productions in toplevel, `embedded_lilypond`,
  `music_list`, `score_body`, `book_body`, `bookpart_body` and
  `output_def_body`; Bison reports no new syntax error until three tokens
  have been shifted after one.
- **Actions**: grammar checks (`octave marks must precede duration`, `not a
  duration`, `bad grob property path`, `\paper cannot be used in \score, use
  \layout instead`, `not a context mod`, …), argument errors, warnings
  (`Unattached ArticulationEvent`, `deprecated: missing '.' in property
  path`), and Scheme errors.

What the error corpus of §7 showed **[measured]**:

- An unknown `\command` gives two errors at the same place: the lexer's
  ``unknown command: `\foo'`` and, because it returns a `STRING`, the
  grammar's `string outside of text script or \lyricmode` (cases 01, 24–28,
  and T03).
- Inside `#{ … #}` the line is right, but on the line where `#{` starts the
  column counts from the character after `#{`, and the excerpt is the
  embedded text; `error in #{ ... #}` follows, located at the call (24).
- A Scheme read error prints Guile's `unexpected end of input while
  searching for: )` and is followed by a spurious `syntax error, unexpected
  EVENT_IDENTIFIER` (21).
- A wrong markup command argument is reported and then aborts the whole file
  with a Guile error in `reverse!`, without `fatal error: failed files` (20).
- An unterminated string at the end of a file is reported as `EOF found
  inside string`, then `syntax error, unexpected end of input, expecting
  \header` (03), one of the few `expecting` lists the corpus produces.

## 4. What the test set uses

**[measured]** with `-ddebug-parser` (Appendix A), which traces every token
the grammar reads and every rule it reduces, from `\maininput` on. Counts are
of the main file and its includes, without the five Scheme forms at the end
of `init.ly` that every trace shares.

- The 30 scores give the grammar 15,836 tokens of 100 kinds. Parsing the
  init files of a session (`declarations-init.ly` and what it includes) takes
  9,897 tokens, more than any score and 62 % of all 30 together: the
  post-init snapshot of chapter 00 (B5a) saves a phone that parse.
- Identifiers by kind (tokens, scores using them): `MUSIC_FUNCTION` 572 in
  26, `EVENT_IDENTIFIER` 538 in 17, `MUSIC_IDENTIFIER` 493 in 20,
  `MARKUP_FUNCTION` 143 in 9, `PITCH_IDENTIFIER` 92 in 6, `SCM_IDENTIFIER` 59
  in 11, `LOOKUP_IDENTIFIER` 57 in 9, `NUMBER_IDENTIFIER` 16 in 7,
  `EVENT_FUNCTION` 12 in 1, `DURATION_IDENTIFIER` 3 in 2, `SCM_FUNCTION` 2 in
  2; none uses `MODULE_IDENTIFIER`, `BOOK_IDENTIFIER` or
  `MARKUP_LIST_FUNCTION`.
- Argument machinery: 1,020 `EXPECT_SCM` in 27 scores, 238 `EXPECT_OPTIONAL`
  in 23, 281 `BACKUP` in 20, 311 `REPARSE` in 18, 152 `SYMBOL_LIST` in 12;
  `\default` and `\etc` once each (`\default` only in the init files).
- `#` forms: 420 in 26 scores. `$`: none. `#{ … #}`: in the sources of 3
  scores (T23, T26 and T28's `cary-layout.ily`), and evaluated 139 times
  while parsing 4 (T25 calls one from the init files): 1, 3, 13 and 122
  nested parses, 1,829 tokens.
- Toplevel items (assignments and toplevel expressions): 2 to 49 per score.
  In 10 of the 23 snippets one item holds 85 % or more of the tokens (T12:
  508 of 520); in the real pieces the largest item holds 18–47 % (T29: 691
  of 3,895), except T28 (88 %, one `\score`).

The parse phase, timed natively from the settings file to the first book
handler call (Appendix A): the main file, its includes, its Scheme and the
music functions it calls. Median of three runs, milliseconds, main-file
tokens beside them.

| Score | Tokens | ms | Score | Tokens | ms | Score | Tokens | ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T01 | 30 | 1.0 | T11 | 122 | 2.1 | T21 | 199 | 4.4 |
| T02 | 228 | 2.6 | T12 | 520 | 3.9 | T22 | 409 | 4.5 |
| T03 | 31 | 1.0 | T13 | 211 | 1.1 | T23 | 855 | 9.6 |
| T04 | 191 | 3.6 | T14 | 27 | 0.9 | T24 | 1,159 | 14.9 |
| T05 | 169 | 2.9 | T15 | 60 | 2.6 | T25 | 950 | 16.3 |
| T06 | 125 | 2.1 | T16 | 21 | 0.7 | T26 | 969 | 7.0 |
| T07 | 179 | 4.0 | T17 | 57 | 2.5 | T27 | 1,170 | 16.3 |
| T08 | 263 | 2.7 | T18 | 61 | 1.4 | T28 | 2,565 | 30.8 |
| T09 | 121 | 2.3 | T19 | 98 | 9.7 | T29 | 3,895 | 24.7 |
| T10 | 61 | 1.2 | T20 | 119 | 2.4 | T30 | 971 | 4.9 |

Time follows Scheme, not tokens: T19 has 98 tokens but includes
`articulate.ly`, whose 27 KB of Scheme definitions take most of its 9.7 ms;
T28 evaluates 138 `#` forms and 122 `#{ … #}`. Projected onto the Android
reference as chapter 00 does (×1/0.45 for the CPU, ×1.5 for wasm), a full
re-parse would cost up to 32 ms for an S score (T19) and 103 ms for an L
score (T28), against chapter 00's provisional 20 ms for parsing. Re-parsing
everything after each edit does not fit; re-parsing what changed does
(§5.7).

## 5. Our parser

### 5.1 From LilyPond's files to our modules

| LilyPond | Our parse module |
| --- | --- |
| start conditions of `lexer.ll` | `Mode` (notes, chords, figures, lyrics, markup, initial), passed by the parser on each call; drum mode is notes with another table; strings, comments and the `\include`/`\version` arguments are sub-scanners, not modes |
| keyword table, `scan_escaped_word`, `scan_scm_id`, `try_special_identifiers` | `classify(name, env) -> TokenKind`, one function |
| `includable-lexer.cc`, `sources.cc` | a stack of `(file, offset)` cursors in the token stream; the search path of §2.5 |
| `parse-scm.cc`, `parser-ly-from-scheme.scm` | chapter 03's reader, called at a byte offset, returning a datum and its end; `#{ … #}` read as a template (§5.3) |
| `parser.yy`: 189 nonterminals | recursive descent, one function per area of §3.1 |
| the 96 argument-list productions, `BACKUP`, `REPARSE`, `MYBACKUP`, `MYREPARSE` | one loop over the signature, on a token cursor that can be rewound (§5.3) |
| `ly-syntax-constructors.scm`, the actions' `make-music` | constructors of chapter 04's music model, or the same Scheme functions if chapter 04 keeps them in Scheme |
| `input.cc`, `source-file.cc` | `Span { file: u16, start: u32, end: u32 }` and a line table per file; line, character and column computed when printed |
| `lily-parser.cc`, `lily-parser-scheme.cc` | the `Parser` session, and the 16 Scheme functions of `lily-parser-scheme.cc` on it |
| `music-function.cc` | applying a function and checking its result |

### 5.2 Lexer

A pull lexer over UTF-8 bytes: `next(cursor, mode) -> Token`, where a token is
a kind (`u8`), a span and, for numbers, strings, words and Scheme, an index
into a side table of values. Tokens are cached by `(offset, mode)` in the
cursor, so a rewind re-reads cached tokens and evaluates no `$` twice.

- Words, numbers and specials follow §2.2 byte for byte, with flex's
  longest-match rules written out (`r-.` is a rest and a script; `4.` is a
  dotted duration in notes but `4.5` a real; `-1` is a fingering after a
  note and a number after `=`).
- Pitch names come from the tables of `define-note-names.scm`, already
  hashed in the post-init snapshot; `\language` swaps the table pointer.
- `#` and `$` call the reader of chapter 03 at the byte after the sigil;
  the lexer stores the datum, and evaluates it only for `$`.
- Diagnostics are produced with LilyPond's exact wording and located by
  span; line, character and column are computed from the line table when a
  message or a link is printed, never stored.

The lexer and the line tables touch only bytes: no allocation per token
beyond the token array, which is 12 bytes a token (T29's
3,895 tokens are 47 KB).

### 5.3 Parser

Recursive descent, top-down, with LilyPond's grammar areas as functions:
`toplevel`, `assignment`, `book`, `score`, `output_def`, `header`,
`context_def`, `context_mods`, `music`, `composite_music`, `event_chord`,
`post_events`, `pitch_or_music`, `duration`, `chord_mode`, `figures`,
`lyrics`, `markup`, `property_operation`, `arguments`. Each function chooses
the mode for the tokens it reads, so a mode switch always happens before the
next token is lexed: the lookahead problem of §2.1 does not arise.

Music function arguments (replacing §3.2's 96 productions and the
`BACKUP`/`REPARSE` tokens):

```text
arguments(signature):
  for each parameter p, left to right:
    if p is optional and the next token is \default: take p's default; continue
    if the next token is \etc: return a partial call
    mark = cursor.mark()
    unit = parse_argument_unit()        # the longest unit of §3.2, values evaluated once
    for reading in readings(unit):      # LilyPond's order: as is, symbol list, symbol,
      if p.predicate(reading): take it  #   note made from pitch or duration, …
    else if p is optional and a mandatory parameter follows:
      take the defaults of p and of the optional parameters after it in this run
      cursor.reset(mark)                # the unit is read again for the next parameter
    else: argument error at unit's span (LilyPond's message), mark the call as failed
```

A rewind replays cached tokens, whose values are already evaluated, which is
what `BACKUP` does by pushing values back as tokens. The order of readings
and of the predicate calls must be LilyPond's, because predicates are
Scheme and may have effects; the trace of `-ddebug-parser` shows them.

`#{ … #}` is parsed once into a *template*: the token stream of its text,
with each inner `#`/`$` form a hole bound to its closure. Evaluating it
elaborates the template in the caller's environment, without lexing again.
That keeps LilyPond's semantics (the text is interpreted on every call, with
the identifiers of that moment) and removes the cost of T28's 122 re-parses.

### 5.4 Compatibility with Bison's timing

Two behaviors of the LALR(1) parser are visible to scores and must be
reproduced where a test shows them:

- **`$` after an assignment** (§3.3). The assignment rule reads one token
  past its value, and so runs a following `$`, except after a Scheme value
  and after markup in the cases measured. A table of value kinds, filled
  from tests like those of §3.3, decides whether `assignment` peeks before it
  defines.
- **`#` is evaluated when its rule is reduced**, which can be after the next
  token was lexed. Only the order relative to a following `$` can show this;
  the parser evaluates a `#` form when the construct holding it is complete,
  and a test of §3.3's kind fixes each case found to differ.

Both matter only when a `$` follows; no score of the set has one.

### 5.5 Output

The parse produces what LilyPond's parser hands on: for each toplevel item,
music (with an `origin` span on every music object, which the iterators turn
into events and the engravers into grob causes, and so into C1's links),
scores, books, output definitions, headers and markup, and the calls to the
toplevel handlers. Origins are spans, not lines, so text that only moves
keeps its music: links are computed from the current line table when the
SVG and the playback map are written.

### 5.6 Errors

- The messages of the lexer, the grammar's actions, argument checks and
  Scheme errors are LilyPond's strings, located like LilyPond's (an action's
  `@$` is its first token's start; argument errors are at the argument).
  Scheme errors need chapter 03's interpreter to word its common errors as
  Guile 3 does (`Unbound variable: x`, `In procedure car: Wrong type
  (expecting pair): ()`), since C0 compares the message.
- Syntax errors print `syntax error, unexpected X` with X in Bison's display
  names. Bison adds `expecting …` only when four or fewer tokens could
  follow; the parser computes its expected set at each error point, and the
  error corpus fixes the cases where LilyPond prints a list.
- Recovery resynchronises where LilyPond's `error` productions do (§3.4):
  inside a music list, skip to the next token that can start music or to the
  closing brace; at toplevel and in blocks, to the next item. C0 counts
  errors, so recovery is tested against the corpus.
- Reproduce, don't fix: the column inside `#{ … #}`, the doubled unknown
  command, the spurious error after a Scheme read error. The abort after a
  wrong markup argument (case 20) is the exception: the engine reports the
  first error and continues, and C0 still matches: Guile's abort message is
  not in LilyPond's diagnostic format, so `parseStderr` does not count it.

### 5.7 Re-parsing only the edited part

The unit of reuse is the **toplevel item** (an assignment or a toplevel
expression), and inside an item the **braced block** (`{ … }`, `<< … >>`,
`\with { … }`, a markup block). A parse records, for each:

- its span, and the end of the last token it *examined*, lookahead included;
- its **entry state** (§3.3): mode, pitch table, scope, default duration,
  default tremolo;
- its **dependencies**: the module variables it read, each with a version
  number that every `define` or `set!` of that variable increments;
- its **effects**: the variables it defined or set, and an undo log of
  mutations of objects that existed before it started (§5.8 asks chapter 03
  for both);
- its **result** (music, definitions, handler calls), immutable, and its
  exit default duration.

After an edit of bytes `[a, b)`:

1. Items whose examined range ends before `a` are kept as they are.
2. From the first item that is not, undo the effects of the old items in
   reverse order (their undo logs), then parse forward from that item's
   start.
3. Inside an item being parsed, a braced block whose text is unchanged and
   whose entry state and dependencies match a recorded one is not parsed
   again: its recorded result is used (copied before a music function may
   change it, as `\relative` changes its argument).
4. After the edit, at every item boundary where the parser's state equals
   the old parse's state at the shifted old boundary, an old item whose
   dependencies are unchanged and that had no effects on objects is taken
   over with its spans shifted, and its definitions are replayed.
5. The end of `init.ly` (collecting the books) always runs again; it is
   cheap.

Then the work per edit is the innermost block that changed, the functions
around it in its item, and the items that read a variable it redefined. On
the edits of chapter 00 §6.2: E1 (a pitch in an instrument variable of T29)
re-parses one block of that variable, re-applies the variable's functions
(`\relative`), and re-runs the `\score` that reads it; E2 does the same with
a different exit duration, which is compared and propagates only if it
changed; E3 (a header string) re-parses the `\header` item and nothing that
reads no header. An item without matching state, such as one after
`#(set-global-staff-size 20)` was edited, is parsed again with everything
after it; such forms usually stand at the top of a file.

Cancellation (B8) checks for a newer edit between items and between blocks.

### 5.8 Budgets and what chapter 03 must provide

Budgets proposed for step 11 to confirm (the provisional 20 ms is chapter
00's):

| What | Must | Goal |
| --- | --- | --- |
| Lexer and parser alone, native | 50 MB/s (T29's 15 KB in 0.3 ms) | 100 MB/s |
| Parse share of B6 per edit, Android reference, S | 20 ms | 8 ms |
| Parse share of B6 per edit, Android reference, L | 40 ms | 15 ms |
| First full parse, Android reference | T02 40 ms, T29 150 ms | T02 10 ms, T29 80 ms |
| Memory of the parse records | ≤ 2 MB for T29 | ≤ 1 MB |
| Code, uncompressed wasm, parse module | 250 KB | 150 KB |

Lexing and parsing are cheap; the time is Scheme (§4), which is why the
reuse of §5.7 and the template cache of §5.3 are the budget's mechanisms.
The parser's demands on chapter 03's interpreter:

- a reader callable at a byte offset that returns the datum and its end,
  reads LilyPond's `#{ … #}` as a template, and words its errors like
  Guile's (`unexpected end of input while searching for: )`);
- evaluation with `*location*`, multiple values for `#@`/`$@`, closures for
  template holes, and Guile 3's wording for common errors;
- module variables with version numbers, a hook on every read for
  dependency tracking, and `define`/`set!` recorded per item;
- an allocation epoch per object and a write barrier that logs mutations of
  objects older than the current item, so an item's effects can be undone;
- a cheap way to ask "is this procedure a music function, and what is its
  signature" (the classification of §2.3 happens for every `\name`);
- the post-init snapshot (B5a) including the pitch tables, the keyword and
  shorthand bindings, and the 151 music functions of
  `music-functions-init.ly`, so a phone never parses the init files.

## 6. The ordered syntax list

The order in which the parse module should support the syntax. Each step
names the LilyPond rules it covers and the error corpus cases that test it;
*parseable after it* counts the scores whose main-file tokens and nested
parses need no later step, and names those it adds **[measured]** (the token
kinds of each score, mapped to the steps as in Appendix A). Every step needs
the earlier ones, and every score calls music functions of the init files,
so no score parses before P5.

| Step | Syntax | LilyPond | Corpus | Parseable after it |
| --- | --- | --- | --- | --- |
| P1 | Sources: UTF-8, BOM, line table, `%` and `%{ %}` comments, strings and escapes, `\version`; spans and line/character/column with tabs | `lexer.ll` common rules, `input.cc`, `source-file.cc` | errors 03–06, 26, 27 | 0 |
| P2 | Notes core: `{ }`, `<< >>`, pitches of the current language, `'` `,`, `!` `?`, octave check `=`, durations with dots and `*n/m`, `r` `s` `R` `q`, chords `< >`, post-events `- ^ _`, fingerings, `\1`, `:n` tremolo, bare toplevel music | `event_chord`, `pitch_or_music`, `chord_body`, `post_event`, `duration` | errors 08–10, 12–14, 30 | 0 |
| P3 | Identifiers: `name = value`, `"name" =`, `name.path =`, `\name`, `\"name"`, shorthands, classification of §2.3, `\name.key` lookups | `assignment`, `identifier_init`, `lookup`, `try_special_identifiers` | errors 01, 02 | 0 |
| P4 | Embedded Scheme: `#`, `$`, `#@`, `$@`, toplevel Scheme, Scheme as values and arguments, Bison's timing of §5.4 | `embedded_scm*`, `parse-scm.cc` | errors 21–23 | 0 |
| P5 | Music functions: signatures, predicates, optional arguments, `\default`, rewinds, symbol lists, argument errors; output blocks `\score`, `\header`, `\layout`, `\paper`, `\midi`, `\book`, `\bookpart`, number expressions and units | `function_arglist*`, `music_function_call`, `score_block`, `output_def`, `book_block`, `number_expression` | errors 11, 17, 18, 28 | 2: T14, T16 |
| P6 | Contexts and properties: `\new`, `\context`, `= "id"`, `\with`, context definitions and their mods, `\change`, `\set`, `\unset`, `\override`, `\revert`, property paths | `context_prefix`, `context_def_spec_block`, `context_mod`, `music_property_def`, `grob_prop_path` | errors 15, 16, 29 | 11: + T01, T03, T08, T09, T11, T12, T15, T18, T22 |
| P7 | Markup: markup mode, commands by signature, lists, braced lists, Scheme markup, `\markuplist`, `\score` and `\score-lines` in markup, markup in scripts, `\markup name = …` | `full_markup`, `markup_*` | errors 19, 20 | 13: + T13, T27 |
| P8 | Lyrics: `\lyricmode`, `\lyrics`, `\addlyrics`, `\lyricsto`, syllables with durations, `--`, `__`, `_`, quoted and markup syllables | `lyric_mode_music`, `new_lyrics`, `lyric_element` | — | 14: + T20 |
| P9 | `\repeat` and `\alternative`, `\tempo`, `\rest`, `\sequential`, `\simultaneous`, `\notemode` | `repeated_music`, `tempo_event`, `mode_changing_head` | — | 22: + T02, T04, T10, T17, T19, T24, T29, T30 |
| P10 | Chord, drum and figure modes: `\chordmode`, `\chords`, modifiers, `:`, `^`, `/`, `/+`, steps; `\drummode`, `\drums`; `\figuremode`, `\figures`, figure syntax | `new_chord`, `chord_item`, `bass_figure`, `figure_list` | — | 26: + T05, T06, T07, T21 |
| P11 | `#{ … #}` as templates, `\include` (string, `\name`, Scheme; search path), `ly:parser-include-string`, `ly:parse-string-expression`, `\etc` partial functions and markup | `embedded_lilypond`, `parser-ly-from-scheme.scm`, `partial_function` | errors 07, 24, 25 | 30: + T23, T25, T26, T28 |
| P12 | Rare and init-only: `\sourcefilename`, `\sourcefileline`, `\maininput`, `\markuplist` identifiers, `\lyricsto Type = "id"`, `embedded_lilypond_number`, `*#scheme` multipliers, `expect-error` | the remaining productions | `syntax.ly` | 30 |

P1–P4 make no score parseable; the error corpus tests them, and every step
can be checked against the token sequence of LilyPond's `-ddebug-parser`
trace of the same file, which a recursive-descent parser can emit too. The re-parsing of §5.7 is not
a step of this list: it wraps P2–P11 once P5 exists, and is measured from
then on.

## 7. Test material added by this step

- **`packages/common/test/grammar/syntax.ly`**: a compilable score
  (`lilypond` reports nothing) that uses what the 30 scores do not: every
  identifier kind, partial functions and partial markup, `\default`, `$`,
  `#@` and `$@`, `#{ … #}` with markup and numbers inside, `\book` and
  `\bookpart`, context definitions with all their mods, all four special
  modes, `\markuplist`, `\score-lines`, number expressions with units,
  multipliers from Scheme, quoted strings in property paths, a non-ASCII
  variable name and `\include`. With the 30 scores, the init files and the
  two existing snapshot inputs it reaches all 189 nonterminals and 427 of
  the 601 productions **[measured]**. As a grammar snapshot input, it is
  compared by `npm run test:grammar` like the others (D14).
- **`packages/common/test/parser/errors/`**: 30 erroneous inputs, one
  error class each (lexer, grammar, actions, function arguments, markup,
  Scheme reading and evaluation, `#{ … #}`, included strings, columns with
  tabs and UTF-8, error counts, warnings), each with LilyPond 2.26's stderr
  beside it (`*.err`, paths made relative). This is the error corpus
  chapter 00 asked for: C0 now applies to these 30 and to T03.
  `node packages/common/test/parser/capture-errors.mjs` checks them against
  the installed lilypond, `--update` rewrites them; without lilypond it
  verifies nothing.
- **TextMate grammar fixes** that the syntax corpus exposed in
  `packages/common/syntaxes/lilypond.tmLanguage.json`: a `\markup` inside
  `#{ … #}` swallowed the `#}`, leaving the rest of the file inside Scheme;
  `\markup … \etc` never ended; commands and variables with non-ASCII
  letters (`\mélodie`) were split; `\"name"` and `\=` were not commands;
  assignments after `{` (`\header { title = … }`) and with a path
  (`name.key =`) were not scoped. The existing snapshots are unchanged.

## 8. What later chapters take from here

| Chapter | Takes |
| --- | --- |
| 03 Scheme | the reader and interpreter requirements of §5.8; Guile 3's wording of the errors in errors 21–23; the 16 Scheme functions of `lily-parser-scheme.cc`; that 151 init functions and the pitch tables belong in the snapshot |
| 04 music model | §5.5's output: music with span origins, immutable results reused across edits and copied before functions change them; the constructors of `ly-syntax-constructors.scm`; the default duration as parser state |
| 05 layout | nothing directly; edits arrive as changed items and blocks (§5.7) |
| 08 build | the parse module's size budget (§5.8); lexer tables generated at build time from `define-note-names.scm` and the keyword list |
| 09 phone timings | the parse share of B6 and the first full parse of §5.8, on T02, T12, T24 and T29 |
| 11 roadmap | the steps P1–P12 of §6 and their test material; the budgets of §5.8 |

## Appendix A: recipes

The LilyPond checkout and the test scores are those of chapters 00 and 01.

**Traces.** `-ddebug-parser` turns on Bison's trace when `\maininput` is
reached, so the init files are not traced; each test score is traced from
its own directory:

```sh
cd "$(dirname score.ly)" && LANGUAGE=en lilypond -ddebug-parser -dno-print-pages \
  -o <out>/<id> score.ly 2> <trace>/<id>.txt
```

The init files are traced as a score that includes a copy of
`declarations-init.ly` without its two `session-*` lines:

```sh
D=$(lilypond -e '(begin (display (ly:get-option (quote datadir))) (exit 0))')/ly
sed -e '/session-start-record/d' -e '/(session-save)/d' "$D/declarations-init.ly" > decl-copy.ly
printf '#(define (call-after-session thunk) (thunk))\n\\include "decl-copy.ly"\n' > init-trace.ly
LANGUAGE=en lilypond -ddebug-parser -dno-print-pages -o out init-trace.ly 2> INIT.txt
```

**Counting.** A token is a `Next token is token X` line that follows
`Reading a token` (Bison repeats the line when it re-examines a lookahead).
A production is reached when `Reducing stack by rule N` is followed by
`-> $$ = nterm X` with X not a mid-rule `$@n`. `Starting parse` opens a
nested parse (`#{ … #}`) until `Cleanup: popping nterm start_symbol`; the
parse that starts after the main one ends is the tail of `init.ly`, left
out. Toplevel items are the reductions to `lilypond`. In Python:

```python
import re, collections
tok = re.compile(r"Next token is token (\S+|'.') \(")
red = re.compile(r"Reducing stack by rule (\d+) \(line (\d+)\):")
lhs = re.compile(r"-> \$\$ = nterm (\S+) ")
def count(path):
    segs = collections.defaultdict(lambda: {'toks': collections.Counter(), 'rules': set()})
    stack, main_done, reading, rule = ['main'], False, False, None
    for l in open(path, errors='replace'):
        if 'Starting parse' in l:
            stack.append('tail' if main_done and not stack else 'nested'); continue
        cur = stack[-1] if stack else 'after'
        if l.startswith('Reading a token'): reading = True; continue
        m = tok.search(l)
        if m and (reading or 'Parsing...' in l): segs[cur]['toks'][m.group(1)] += 1
        if m or 'Now at end of input' in l: reading = False
        if (m := red.search(l)): rule = int(m.group(1))
        elif (m := lhs.search(l)) and rule is not None:
            if not m.group(1).startswith('$@'): segs[cur]['rules'].add(rule)
            rule = None
        if l.startswith('Cleanup: popping nterm start_symbol') and stack:
            if stack.pop() == 'main': main_done = True
    return segs
```

The 601 productions and 32 mid-rule actions were counted from the section
between the two `%%` lines of `parser.yy`, with comments and action blocks
removed, splitting rules at `:`, `|` and `;`. Bison numbers the mid-rule
actions as rules of their own, so its rule numbers in the traces (up to 616)
are not production counts.

**Steps of §6.** Each token kind the traces show is assigned to the first
step that introduces it: notes tokens to P2 (`'{'`, `NOTENAME_PITCH`,
`UNSIGNED`, `RESTNAME`, `FRACTION`, `'='`, `STRING`, …), identifier kinds to
P3, `SCM_TOKEN` and `SCM_IDENTIFIER` to P4, function and argument tokens and
the output-block keywords to P5, context and property keywords to P6, markup
tokens to P7, lyric tokens to P8, `\repeat`, `\alternative`, `\tempo`,
`\rest`, `\sequential`, `\simultaneous` and `\notemode` to P9, chord, drum and
figure tokens to P10, and nested parses to P11. A score is parseable after
the highest step among its tokens.

**Parse-phase timing**, the settings file `ptime.ly`, run three times per
score with `-dno-print-pages -dinclude-settings=ptime.ly` and
`PTIME_OUT`/`PTIME_ID` in the environment; Guile 3 counts internal time in
nanoseconds:

```lilypond
#(define ptime-start (get-internal-real-time))
#(define ptime-done #f)
#(define ptime-handler toplevel-book-handler)
#(define (toplevel-book-handler book)
   (unless ptime-done
     (set! ptime-done #t)
     (let ((port (open-file (getenv "PTIME_OUT") "a")))
       (format port "~a ~a\n" (getenv "PTIME_ID")
               (/ (- (get-internal-real-time) ptime-start) 1e6))
       (close-port port)))
   (ptime-handler book))
```

**Bison's timing of `$`** (§3.3), as a score:

```lilypond
num = 1
$(begin (display (list 'num (defined? 'num))) (newline))
scm = #5
$(begin (display (list 'scm (defined? 'scm))) (newline))
```

prints `(num #f)` and `(scm #t)`; likewise `mus = { c4 }`, `str = "s"` and
`fun = \relative { c4 }` give `#f`, `mkp = \markup \bold z` gives `#t`.
