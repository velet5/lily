# 01 — LilyPond's source, mapped to our engine's modules

Chapter 01 of the investigation into an engine of our own (chapter 00 sets
the budgets and the test set). It says which of LilyPond's files make each
part of a compile, puts every C++ file of `lily/` in one family, and assigns
each family, `scm/` module and `ly/` file to the module of our engine that
must match its behavior. It also records what the 30 scores of chapter 00
actually reach. It records no decision: whether a behavior is ported to
Rust or run as Scheme is for chapters 03–05, and D56 (step 11) records the
result.

Everything refers to LilyPond's repository at tag `v2.26.0` (commit
`3596756be0fac1f81066a99d2054329212172b2d`), the version chapter 00
measured. **[measured]** marks counts and coverage taken on 2026-10-03 from
that checkout and from `GNU LilyPond 2.26.0` of Homebrew; the recipes are in
Appendix A.

## 1. What LilyPond is made of

**[measured]**

| Part | Files | Lines | What it is |
| --- | --- | --- | --- |
| `lily/*.cc`, `lexer.ll`, `parser.yy` | 450 | 112,954 | the program: parser, music model, layout, output, MIDI |
| `lily/include/` | 241 | 18,394 | its headers; read them alongside |
| `flower/*.cc` (tests left out) | 15 | 3,071 | its base library: `rational`, `interval`, `offset`, `polynomial`, `warn`, file names, `getopt-long` |
| `scm/*.scm` | 93 | 59,185 | Scheme loaded into the `(lily)` module: definitions, callbacks, markup, backends |
| `ly/*.ly` | 63 | 16,307 | LilyPond input read at start (`*-init.ly`) or included by scores |
| `ps/*.ps` | 3 | 11.7 KB | PostScript procedures of the PS backend |

What it links and loads besides: Guile 3.0 (the interpreter, and with it
`(ice-9 …)` and `(srfi …)`), Pango, HarfBuzz, FreeType and Fontconfig for
text and fonts, Cairo for the optional Cairo backend, Ghostscript to make
PDF from PostScript, and GLib for its regex functions. Fonts: Emmentaler in
eight optical sizes plus a brace font (OTF, and as SVG fonts in
`fonts/svg/` for the SVG backend), and C059, Nimbus Sans and Nimbus Mono PS
as the serif, sans and mono text fonts, chosen through Fontconfig.

The C++/Scheme surface is wide **[measured]**: 408 `LY_DEFINE` functions
and 253 `MAKE_SCHEME_CALLBACK` callbacks, most of them for grobs, 716
distinct `"ly:…"` names in the C++, and 520 distinct `ly:` names used by
`scm/` and `ly/`. C++ registers 132 translators and translator groups: 112
engravers, `Score_engraver` among them (the three ligature base classes and
`scheme-engraver.cc`, which hosts engravers written in Scheme, register
none), 16 performers, `Timing_translator`, `Mark_tracking_translator`, and
the plain `Engraver_group` and `Performer_group`. 26 more, 25 engravers and
a performer, are written in Scheme in `scheme-engravers.scm` and
`scheme-performers.scm`, among them `Chord_name_engraver`,
`Breathing_sign_engraver`, `Trill_spanner_engraver` and `Beat_performer`.
Behavior lives on both sides: a grob's defaults are in `define-grobs.scm`,
its callbacks in C++ or in `output-lib.scm`, and the engine has to match
whichever it is.

## 2. One compile, end to end

The order in which a `lilypond --svg score.ly` touches the files. The
module of our engine is in brackets (§3).

1. **Start** [driver, scheme]. `main.cc` reads the options
   (`program-option.cc`, `scm/lily.scm`'s option list), `guile-init.cc`
   starts Guile and `scm/lily.scm` loads the 54 files of
   `init-scheme-files` into `(lily)`, in that order: library files
   (`color`, `operators`, `lily-library`, `output-lib`), then
   `markup-macros` and `parser-ly-from-scheme`, then the rest, from
   `define-event-classes` to `context`. Backends, `page.scm`,
   `paper-system.scm` and `display-lily.scm` are separate Guile modules
   loaded when used.
2. **Session** [driver, parse]. `lilypond-all` (`lily.scm`) resets the
   fonts and parses `ly/declarations-init.ly` once per process: it includes
   17 `*-init.ly` files (music functions, scripts, spanners, dynamics,
   property shorthands, `\midi` and `\paper` defaults, context modifiers)
   and, inside `\layout`, `engraver-init.ly`, which defines the 43
   contexts. `session-save` then records every variable, so that each input
   file starts from this state (`session-replay` at the top of `init.ly`).
   This is the pristine snapshot that chapter 00's B5 asks the engine to keep.
   Our warm parent forks *before* this step (`worker.scm`, D25) because
   Pango may start threads, so every native request re-reads the init files
   (0.2 s, chapter 00 §3).
3. **Parse** [parse]. `ly:parse-file` (`lily-parser-scheme.cc`) parses
   `init.ly`, which replays the session, includes the `-dinclude-settings`
   files and reads the score at `\maininput`. The lexer (`lexer.ll`,
   `lily-lexer.cc`, `includable-lexer.cc`) hands `#` and `$` Scheme to
   `parse-scm.cc`; the grammar (`parser.yy`) builds music through
   `scm/ly-syntax-constructors.scm` and type-checks music function
   arguments in `music-function.cc`. Toplevel music goes to
   `collect-music-for-book`, which applies `toplevel-music-functions`
   (`lily-library.scm`); at the end of `init.ly` the collected scores make a
   book that `toplevel-book-handler` prints through `ly:book-process`.
4. **Interpret** [music]. For each score and output definition, `book.cc`
   and `score.cc` make a `Global_context` (`global-context.cc`) and an
   iterator for the music (`music-iterator.cc` and the 22 others). Moment
   by moment, iterators find or create contexts from their definitions
   (`context-def.cc`) and send stream events to them (`dispatcher.cc`); the
   translators in each context (`translator-group.cc`) hear them. Engravers
   make grobs and announce them to the engravers of their own and enclosing
   contexts (`engraver-group.cc`); `Score_engraver` collects them into a
   `System` of a `Paper_score`. Performers make audio elements, which
   `Score_performer` collects into a `Performance`.
5. **Lay out lines** [layout]. `Paper_score::process` (`paper-score.cc`)
   breaks the music into systems with `Constrained_breaking`
   (`constrained-breaking.cc`), which asks `Simple_spacer` to space every
   candidate line, from the springs and rods that the spacing code
   (`spacing-spanner.cc` and the rest of L3) set; `System::break_into_pieces`
   copies the spanners per system and rewrites their links to other grobs
   (`break-substitution.cc`). Grob properties are computed lazily the first
   time they are read (`grob-property.cc`); vertical estimates made before
   the line breaks are known use the *pure* variants of the callbacks
   (`unpure-pure-container.cc`).
6. **Lay out pages** [layout]. `Paper_book` (`paper-book.cc`) gathers the
   systems and titles of the book and calls `page-breaking`, which is
   `ly:optimal-breaking` by default (`paper-defaults-init.ly`):
   `optimal-page-breaking.cc` on `page-breaking.cc` and `page-spacing.cc`,
   with `page-layout-problem.cc` spacing staves and systems on each page.
   Titles and headers come from `titling.scm` and `titling-init.ly`, page
   stencils from `page.scm`.
7. **Write pages** [render]. `paper-book.cc` loads `(lily
   framework-<backend>)`. For SVG, `framework-svg.scm` writes one file per
   page and `output-svg.scm` writes each stencil primitive that
   `stencil-interpret.cc` walks to; each grob's stencil is wrapped in a
   `grob-cause` expression (`grob.cc`) that becomes the `<a
   xlink:href="textedit://…">` link. PDF goes through PostScript
   (`framework-ps.scm`, `output-ps.scm`, `ps/music-drawing-routines.ps`) and
   Ghostscript (`postscript->pdf` in `backend-library.scm`), or through
   Cairo with `-dbackend=cairo` (`cairo.cc`, `framework-cairo.scm`).
8. **Write MIDI** [midi]. `write-performances-midis` (`scm/midi.scm`) has
   each `Performance` written (`performance.cc`): one track per staff
   (`staff-performer.cc`, channels by `midiChannelMapping`), a control track
   for tempo and time (`control-track-performer.cc`), events in time order
   (`midi-walker.cc`), at 384 ticks per quarter, in the chunks of
   `midi-chunk.cc` and `midi-item.cc`.
9. **Diagnostics**, throughout [driver]. `flower/warn.cc` prints
   `file:line:column: severity: message`, the location and the source excerpt
   from `Input::message_location` and `Input::message_string` (`input.cc`,
   `source-file.cc`). The diagnostics parsers of the extension
   (`packages/vscode/src/diagnostics/parse.ts`) and the studio
   (`crates/engrave/src/parse.rs`, D42) read this format.

## 3. The module map

Our engine's modules are named after the chapters that design them. Every
file of `lily/` is in exactly one family, by what it does; the counts are
**[measured]**.

| Module | Chapter | Families | C++ files | C++ lines |
| --- | --- | --- | --- | --- |
| driver | 08 (build), 02 (diagnostics) | D | 21 | 4,123 |
| parse | 02 | P1–P3 | 14 | 8,957 |
| scheme | 03 | S1 | 19 | 3,557 |
| music | 04 | M1–M4 | 71 | 12,523 |
| engravers | 04 (how they run), 05 (what they make) | E1–E6 | 114 | 24,925 |
| layout | 05 | L1–L5 | 145 | 42,773 |
| render | 06 | O1–O3 | 38 | 11,528 |
| midi | 07 | I | 28 | 4,568 |
| **total** | | | **450** | **112,954** |

`flower/` serves every module; its `rational.cc` (exact moments and
alterations), `interval.cc`, `offset.cc` and `polynomial.cc` (slur and
bezier geometry) set numeric behavior that results must reproduce.

Each family below gives its file count and lines, lists its files without
`.cc`, and says what a port must reproduce.

### 3.1 driver

**D — driver, options, books and scores** (21 files, 4,123 lines):
`main`, `program-option`, `program-option-scheme`, `global-vars`,
`relocate`, `lily-version`, `profile`, `time-tracer-scheme`,
`function-documentation`, `diagnostics`, `warn-scheme`, `misc`,
`template5`, `book`, `book-scheme`, `score`, `score-scheme`, `output-def`,
`output-def-scheme`, `paper-def`, `music-output`.
Match: how a book is split into scores, bookparts and output definitions
(`book.cc`'s processing order decides the order of SVG pages and `.midi`
files, which the playback map relies on); the options our tools pass
(`--svg`, `--pdf`, `-dpoint-and-click`, `-dno-print-pages`,
`-dinclude-settings`, `--loglevel`, `-I`); `ly:warning` and `ly:error` from
Scheme (`warn-scheme.cc`). Not needed: `relocate.cc`, `profile.cc`,
`time-tracer-scheme.cc`, `function-documentation.cc` (the internals
reference).

### 3.2 parse — chapter 02

**P1 — lexer and grammar** (7 files, 7,906 lines): `lexer.ll` (1,354),
`parser.yy` (4,931), `lily-lexer`, `includable-lexer`, `lily-parser`,
`lily-parser-scheme`, `parse-scm`.
Match: the lexer's modes (notes, chords, figures, drums, lyrics, markup) and
how `\notemode`, `\lyricmode` and friends switch them; the lookahead
compensation that `init.ly`'s comments mention; `#` (read now) and `$`
(evaluated, then spliced) in `parse-scm.cc`; `ly:parser-include-string` (T16) and
`ly:parse-string-expression`; every error message of the grammar and
lexer, worded and located alike (C0, e.g. ``unknown command: `\x'`` from
the lexer, `string outside of text script or \lyricmode` from the
grammar).

**P2 — sources and locations** (5 files, 808 lines): `source-file`,
`sources`, `input`, `input-scheme`, `input-smob`.
Match: line, character and column numbering, tabs included
(`ly:input-file-line-char-column`), which the diagnostics, the
`textedit://` links and the playback map all print; the include search path.

**P3 — music functions** (2 files, 243 lines): `music-function`,
`music-function-scheme`.
Match: argument predicates, optional arguments and the fallback when a
predicate rejects one; `define-music-function`, `define-event-function`,
`define-scheme-function` and `define-void-function` themselves are macros
in `scm/music-functions.scm`.

### 3.3 scheme — chapter 03

**S1 — Guile embedding and the C++/Scheme bridge** (19 files, 3,557 lines):
`guile-init`, `lily-guile`, `lily-guile-test`, `smobs`, `protected-scm`,
`protection-pool`, `scm-hash`, `undead`, `lily-modules`, `lily-imports`,
`ly-module`, `module-scheme`, `overlay-string-port`, `deprecated-property`,
`general-scheme`, `glib-regex-scheme`, `lily-random`, `prob`, `prob-scheme`.
Match: the type predicates and conversions every `ly:` function applies to
its arguments, and their error messages; `general-scheme.cc`'s utilities
(`ly:format`, `ly:string-substitute`, `ly:string-percent-encode`,
`ly:assoc-get`, …); `lily-imports.cc`, the list of Scheme procedures that
C++ calls by name, which is the contract between the two halves; `prob.cc`,
the property object that music, stream events and paper systems build on.
Not ported: the smob, protection and GC machinery, which exists for Guile.
Chapter 03 decides the interpreter, and so whether `(ice-9 …)` and
`(srfi …)` are needed: `init.ly` uses `srfi-1` and `ice-9 pretty-print`.

### 3.4 music — chapter 04

**M1 — musical values** (8 files, 1,429 lines): `pitch`, `pitch-scheme`,
`pitch-interval`, `duration`, `duration-scheme`, `moment`, `moment-scheme`,
`scale`.
Match: a `Moment` is a main and a grace part, both exact rationals; a
`Pitch` is octave, step and an alteration that is a rational, transposed
against a `Scale`; a `Duration` is a log, dots and a scale factor.

**M2 — music expressions and events** (12 files, 1,442 lines): `music`,
`music-scheme`, `music-sequence`, `music-wrapper`, `grace-music`,
`relative-octave-music`, `relative-octave-check`, `lyric-combine-music`,
`calculated-sequential-music`, `stream-event`, `stream-event-scheme`,
`articulations`.
Match: music is a property list whose `name` picks a type from
`scm/define-music-types.scm` (131 types), with its `iterator-ctor`,
`elements-callback`, `length-callback` and `to-relative-callback`;
`\relative` and transposition; events as sent to contexts, with classes
from `define-event-classes.scm`.

**M3 — iterators** (23 files, 3,179 lines): `music-iterator`,
`simple-music-iterator`, `event-iterator`, `rhythmic-music-iterator`,
`event-chord-iterator`, `sequential-iterator`,
`simultaneous-music-iterator`, `music-wrapper-iterator`, `grace-iterator`,
`tuplet-iterator`, `context-specced-music-iterator`,
`initial-context-music-iterator`, `change-iterator`,
`apply-context-iterator`, `property-iterator`, `lyric-combine-music-iterator`,
`part-combine-iterator`, `quote-iterator`, `volta-repeat-iterator`,
`volta-specced-music-iterator`, `alternative-sequence-iterator`,
`percent-repeat-iterator`, `fine-iterator`.
Match: which moments exist and in which order (grace time before main
time), which context each event reaches, and when contexts are created and
die. This is C1: the playback map records the moment of every rhythmic
event.

**M4 — contexts and translation** (28 files, 6,473 lines): `context`,
`context-def`, `context-handle`, `context-property`, `context-scheme`,
`context-mod`, `context-mod-scheme`, `global-context`,
`global-context-scheme`, `translator`, `translator-scheme`,
`translator-ctors`, `translator-group`, `translator-group-ctors`,
`translator-dispatch-list`, `dispatcher`, `dispatcher-scheme`, `listener`,
`acceptance-set`, `nested-property`, `timing-translator`,
`mark-tracking-translator`, `engraver`, `engraver-group`, `engraver-scheme`,
`scheme-engraver`, `performer`, `performer-group`.
Match: `\consists`, `\remove`, `\accepts`, `\defaultchild`, `\alias` and
`\with`; property lookup up the context tree, and `\set`, `\unset`,
`\override` and `\revert` as stacks (`context-property.cc`, with nested
alists in `nested-property.cc`); the timestep protocol
(`start-translation-timestep`, listeners, `process-music`,
`process-acknowledged`, `stop-translation-timestep`); `make-engraver` and
`make-performer` (macros in `lily-library.scm`) with the hooks that
`timing.ly` and T15 use; `Timing_translator`'s `measurePosition`,
`measureLength` and `currentBarNumber`.

### 3.5 engravers — chapters 04 and 05

Engravers turn events into grobs. Chapter 04 designs how they run (M4);
what each one makes and links belongs to the notation it engraves in
chapter 05. A note passes many: in `$defaultlayout` the `Voice` context
consists of 48 translators, `Staff` of 34 and `Score` of 26 **[measured]**.

**E1 — notes, rests, rhythm** (35 files, 6,553 lines):
`accidental-engraver`, `ambitus-engraver`, `arpeggio-engraver`,
`chord-tremolo-engraver`, `cluster-engraver`, `collision-engraver`,
`completion-note-heads-engraver`, `completion-rest-engraver`,
`dot-column-engraver`, `dots-engraver`, `drum-note-engraver`,
`fingering-column-engraver`, `fingering-engraver`, `font-size-engraver`,
`grace-engraver`, `ledger-line-engraver`, `melody-engraver`,
`multi-measure-rest-engraver`, `new-fingering-engraver`,
`note-head-line-engraver`, `note-heads-engraver`, `note-name-engraver`,
`parenthesis-engraver`, `pitch-squash-engraver`, `pitched-trill-engraver`,
`rest-collision-engraver`, `rest-engraver`, `rhythmic-column-engraver`,
`script-column-engraver`, `script-engraver`, `script-row-engraver`,
`span-arpeggio-engraver`, `stem-engraver`, `tab-note-heads-engraver`,
`tweak-engraver`.

**E2 — beams, ties, slurs, tuplets** (10 files, 2,765 lines):
`auto-beam-engraver`, `beam-collision-engraver`, `beam-engraver`,
`laissez-vibrer-engraver`, `phrasing-slur-engraver`, `repeat-tie-engraver`,
`slur-engraver`, `template-engraver-for-beams`, `tie-engraver`,
`tuplet-engraver`. Automatic beaming also needs
`scm/auto-beam.scm`, `time-signature-settings.scm` and
`beaming-pattern.cc` (L5).

**E3 — staff, bars, marks, dynamics, text** (37 files, 8,128 lines):
`balloon-engraver`, `bar-engraver`, `bar-number-engraver`,
`caesura-engraver`, `clef-engraver`, `concurrent-hairpin-engraver`,
`cue-clef-engraver`, `double-percent-repeat-engraver`,
`dynamic-align-engraver`, `dynamic-engraver`, `episema-engraver`,
`footnote-engraver`, `grid-line-span-engraver`, `grid-point-engraver`,
`horizontal-bracket-engraver`, `instrument-name-engraver`,
`instrument-switch-engraver`, `jump-engraver`, `key-engraver`,
`mark-engraver`, `metronome-engraver`, `ottava-engraver`,
`percent-repeat-engraver`, `piano-pedal-align-engraver`,
`piano-pedal-engraver`, `repeat-acknowledge-engraver`,
`slash-repeat-engraver`, `span-bar-engraver`, `span-bar-stub-engraver`,
`staff-collecting-engraver`, `staff-symbol-engraver`,
`system-start-delimiter-engraver`, `tab-staff-symbol-engraver`,
`text-engraver`, `text-spanner-engraver`, `time-signature-engraver`,
`volta-engraver`.

**E4 — lyrics, figures, chords, frets** (9 files, 2,046 lines):
`extender-engraver`, `figured-bass-engraver`,
`figured-bass-position-engraver`, `fretboard-engraver`, `hyphen-engraver`,
`lyric-engraver`, `part-combine-engraver`, `stanza-number-align-engraver`,
`stanza-number-engraver`. Chord names are made by the Scheme
`Chord_name_engraver` from `chord-name.scm` and `chord-ignatzek-names.scm`.

**E5 — ancient notation** (7 files, 2,254 lines):
`coherent-ligature-engraver`, `gregorian-ligature-engraver`,
`kievan-ligature-engraver`, `ligature-bracket-engraver`,
`ligature-engraver`, `mensural-ligature-engraver`,
`vaticana-ligature-engraver`.

**E6 — alignment, spacing, breaking** (16 files, 3,179 lines):
`score-engraver`, `paper-column-engraver`, `axis-group-engraver`,
`vertical-align-engraver`, `break-align-engraver`,
`separating-line-group-engraver`, `spacing-engraver`,
`note-spacing-engraver`, `grace-spacing-engraver`,
`non-musical-script-column-engraver`, `pure-from-neighbor-engraver`,
`keep-alive-together-engraver`, `grob-pq-engraver`, `forbid-break-engraver`,
`spanner-break-forbid-engraver`, `page-turn-engraver`.
Match: every score uses these. They build the columns, axis groups and
alignments that layout works on, so their structure is the input to
chapter 05.

### 3.6 layout — chapter 05

**L1 — grobs and their properties** (18 files, 4,215 lines): `grob`,
`grob-scheme`, `grob-smob`, `grob-property`, `grob-closure`,
`grob-interface`, `grob-interface-scheme`, `grob-array`,
`grob-array-scheme`, `item`, `item-scheme`, `spanner`, `spanner-scheme`,
`pointer-group-interface`, `pointer-group-interface-scheme`,
`unpure-pure-container`, `break-substitution`, `dimensions-scheme`.
Match: property lookup (set values, then the `\override` stack, then
`define-grobs.scm`'s defaults, then callbacks, cached once called); pure
versus unpure callbacks; items broken at line breaks into three
(`break-visibility`) and spanners split per system; grob links rewritten to
the broken copies. 167 grob types are defined in `define-grobs.scm`, with
properties in `define-grob-properties.scm` and interfaces in
`define-grob-interfaces.scm`.

**L2 — systems, alignment and skylines** (20 files, 6,545 lines):
`system`, `paper-score`, `paper-score-scheme`, `paper-column`,
`axis-group-interface`, `axis-group-interface-scheme`, `align-interface`,
`self-alignment-interface`, `side-position-interface`,
`directional-element-interface`, `staff-symbol`, `staff-symbol-referencer`,
`staff-symbol-referencer-scheme`, `staff-grouper-interface`,
`hara-kiri-group-spanner`, `pure-from-neighbor-interface`,
`interval-minefield`, `skyline`, `skyline-pair`, `skyline-scheme`.
Match: skylines (`skyline.cc`) and how stencils produce them
(`stencil-integral.cc`, O1); outside-staff placement by priority
(`axis-group-interface.cc`, `side-position-interface.cc`); staff-to-staff
distances (`align-interface.cc`); removing empty staves
(`hara-kiri-group-spanner.cc`).

**L3 — horizontal spacing and line breaking** (18 files, 4,841 lines):
`spacing-spanner`, `spacing-basic`, `spacing-loose-columns`,
`spacing-determine-loose-columns`, `spacing-options`, `spacing-interface`,
`note-spacing`, `staff-spacing`, `separation-item`, `spaceable-grob`,
`spring`, `spring-smob`, `rod`, `simple-spacer`, `simple-spacer-scheme`,
`column-x-positions`, `constrained-breaking`, `break-alignment-interface`.
Match: the spring constants from durations (`spacing-basic.cc`), the
optical corrections of `note-spacing.cc`, the rods that keep columns apart,
`Simple_spacer`'s solution of one line, and `Constrained_breaking`'s choice
of breaks. This is C3's system breaks and most of C4's x positions.

**L4 — vertical spacing and page breaking** (16 files, 5,041 lines):
`page-breaking`, `page-breaking-scheme`, `optimal-page-breaking`,
`minimal-page-breaking`, `page-turn-page-breaking`,
`one-line-page-breaking`, `one-line-auto-height-breaking`,
`one-page-breaking`, `page-spacing`, `page-spacing-result`,
`page-layout-problem`, `page-layout-problem-scheme`, `page-marker`,
`page-marker-scheme`, `paper-system`, `paper-system-scheme`.
Match: `ly:optimal-breaking`, the default, and the `\paper` variables it
reads (`paper-defaults-init.ly`); `page-layout-problem.cc`'s springs between
systems and staves. The other breakers are chosen only by `page-breaking =`
or by options our tools do not pass.

**L5 — notation objects** (73 files, 22,131 lines): their grobs' print and
position callbacks.
Stems, beams, flags: `stem`, `stem-tremolo`, `flag`, `beam`,
`beam-quanting`, `beaming-pattern`, `least-squares`.
Slurs and ties: `slur`, `slur-scoring`, `slur-configuration`,
`slur-score-parameters`, `bezier-bow`, `tie`, `tie-column`,
`tie-configuration`, `tie-details`, `tie-formatting-problem`,
`tie-specification`, `semi-tie`, `semi-tie-column`.
Heads, dots, accidentals, collisions: `note-head`, `note-head-scheme`,
`rhythmic-head`, `note-column`, `note-column-scheme`, `note-collision`,
`rest`, `rest-collision`, `dot-column`, `dot-configuration`,
`dot-formatting-problem`, `accidental`, `accidental-placement`,
`ledger-line-spanner`, `multi-measure-rest`, `clef`, `clef-modifier`,
`key-signature-interface`.
Scripts and text-like objects: `script-interface`, `script-column`,
`fingering-column`, `arpeggio`, `breathing-sign`, `chord-name`,
`enclosing-bracket`, `balloon`, `grid-line-interface`.
Spanners and brackets: `line-spanner`, `hairpin`, `tuplet-bracket`,
`tuplet-number`, `tuplet-description`, `ottava-bracket`, `volta-bracket`,
`repeat-styler`, `percent-repeat-interface`, `horizontal-bracket`,
`bracket`, `measure-grouping-spanner`, `measure-spanner`,
`piano-pedal-bracket`, `sustain-pedal`, `system-start-delimiter`,
`lyric-extender`, `lyric-hyphen`, `vowel-transition`, `melody-spanner`,
`figured-bass-continuation`, `cluster`.
Ancient: `gregorian-ligature`, `mensural-ligature`, `vaticana-ligature`,
`kievan-ligature`.
Match: what C4 compares. The costly ones are those that score many
candidate shapes: `beam-quanting.cc` (1,401 lines), `slur-scoring.cc` and
`slur-configuration.cc`, `tie-formatting-problem.cc` (1,285); chapter 05
budgets them (T12 is the slur-scoring test).

### 3.7 render — chapter 06

**O1 — stencils and geometry** (13 files, 3,980 lines): `stencil`,
`stencil-scheme`, `stencil-expression`, `stencil-interpret`,
`stencil-integral`, `box`, `bezier`, `bezier-scheme`, `transform`,
`transform-scheme`, `lookup`, `line-interface`, `line-interface-scheme`.
Match: a stencil is an extent and an expression over the primitives listed
in `scm/define-stencil-commands.scm`; `stencil-interpret.cc` turns
`translate-stencil`, `rotate-stencil`, `color` and `grob-cause` into
offsets and output calls; `stencil-integral.cc` makes the skylines of L2,
so outside-staff spacing depends on how exactly a stencil's shape is known.

**O2 — fonts and text** (19 files, 4,641 lines): `font-metric`,
`font-metric-scheme`, `font-interface`, `font-select`, `font-config`,
`font-config-scheme`, `all-font-metrics`, `all-font-metrics-scheme`,
`modified-font-metric`, `open-type-font`, `open-type-font-scheme`,
`otf-scheme`, `pango-font`, `pango-font-scheme`, `pango-select`,
`freetype`, `freetype-error`, `ttf`, `text-interface`.
Match: glyph extents and attachment points from Emmentaler's own OTF tables
(read in `open-type-font.cc`), the optical size chosen for a staff size, and
text widths. Text goes through Pango (shaping, fallback fonts, UTF-8, T20);
the engine replaces it with a fixed set of fonts and its own shaping, so
text widths are where C4 will differ first.

**O3 — pages to files** (6 files, 2,907 lines): `paper-book`,
`paper-book-scheme`, `paper-outputter`, `paper-outputter-scheme`,
`point-and-click`, `cairo` (1,725).
Match: the SVG backend's output (in `scm/`, §4) and the point-and-click
links. `cairo.cc` writes SVG, PDF, PS and PNG with Cairo; chapter 06 reads
it for what a PDF needs, not to port.

### 3.8 midi — chapter 07

**I — MIDI** (28 files, 4,568 lines): the performers
`score-performer`, `staff-performer`, `control-track-performer`,
`note-performer`, `drum-note-performer`, `beam-performer`,
`slur-performer`, `tie-performer`, `dynamic-performer`, `key-performer`,
`lyric-performer`, `mark-performer`, `midi-cc-performer`,
`piano-pedal-performer`, `tempo-performer`, `time-signature-performer`;
the audio elements `audio-column`, `audio-element`, `audio-element-info`,
`audio-item`, `audio-staff`; the file `performance`, `performance-scheme`,
`midi-cc-announcer`, `midi-chunk`, `midi-item`, `midi-stream`,
`midi-walker`.
Match: C2. Velocities from dynamics (`dynamic-performer.cc`, with
`dynamic-default-volume` and `midiMinimumVolume`/`midiMaximumVolume`),
programs from instrument names (`scm/midi.scm`), channels per staff
(`staff-performer.cc`), tied notes merged (`tie-performer.cc`), the order of
tracks (one per staff, in creation order, after the control track), and 384
ticks per quarter. `articulate.ly` (T19) and unfolded repeats change the
music before the performers see it. The default MIDI contexts are in
`ly/performer-init.ly`.

## 4. `scm/` and `ly/`

When a module of `scm/` is loaded: *init* (in `init-scheme-files`, always),
*on use* (a Guile module loaded by the file that needs it), *backend*
(loaded for the chosen output), *docs* (only for LilyPond's own manuals).
Lines in parentheses.

| Engine module | `scm/` files |
| --- | --- |
| parse | init: `define-note-names` (1,366: note names of every input language), `chord-entry` (278: `\chordmode`), `parser-clef` (278: `\clef` names), `parser-ly-from-scheme` (170: `#{ … #}`); on use: `ly-syntax-constructors` (386: what the grammar builds, called from `lily-imports.cc`) |
| scheme | init: `lily` (1,205: options, sessions, the init list, `lilypond-all`), `lily-library` (1,848: utilities, toplevel handlers, `make-engraver`, `make-performer`), `c++` (311: type predicates of C++ types), `operators` (62), `file-cache` (28); on use: `curried-definitions` (68), `clip-region` (87), `display-lily` (314) with `define-music-display-methods` (1,426: `\displayLilyMusic`, also used by `articulate.ly`) |
| music | init: `define-music-types` (1,030), `define-music-properties` (252), `define-event-classes` (154), `define-music-callbacks` (327), `music-functions` (2,998: music utilities, accidental styles, `define-music-function`), `define-context-properties` (1,094), `context` (70), `translation-functions` (1,186: formatters held in context properties), `time-signature-settings` (1,023: beaming by time signature), `auto-beam` (179), `part-combiner` (1,081), `autochange` (100), `modal-transforms` (336) |
| engravers | init: `scheme-engravers` (2,677: 25 engravers), `chord-name` (293), `chord-ignatzek-names` (301) |
| layout | init: `define-grobs` (4,414: the 167 grob types), `define-grob-properties` (1,861), `define-grob-interfaces` (827), `output-lib` (4,291: grob callbacks and break visibilities), `bar-line` (1,366), `flag-styles` (333), `script` (572: articulation definitions), `breath` (74), `time-signature` (61), `layout-beam` (73), `layout-slur` (44), `skyline` (25), `paper` (436: paper sizes and staff size), `tablature` (383), `fret-diagrams` (1,283), `predefined-fretboards` (54), `harp-pedals` (192), `define-woodwind-diagrams` (1,215), `display-woodwind-diagrams` (1,977); on use: `accreg` (592) |
| render | init: `color` (856), `markup-macros` (501: `define-markup-command`, the `markup` macro), `markup` (160), `define-markup-commands` (7,333: 188 markup commands and 11 markup list commands **[measured]**), `stencil` (1,104), `define-stencil-commands` (72), `titling` (104), `backend-library` (625); on use: `page` (321), `paper-system` (271), `qr-code` (594); backend: `framework-svg` (129), `output-svg` (664), `framework-ps` (893), `output-ps` (402), `framework-cairo` (26), `ps-to-png` (177); generated at build time: `font-encodings` (PS only) |
| midi | init: `midi` (258: instrument names, programs, `write-performances-midis`), `scheme-performers` (124) |
| not needed | docs: `documentation-generate`, `documentation-lib`, the 13 `document-*`, `lily-sort`, `hyphenate-internal-words`, `define-paper-variables`; debugging: `to-xml`, `graphviz`, `guile-debugger` |

The `ly/` files:

| Group | Files |
| --- | --- |
| Read at every start | `init.ly` (per file), `declarations-init.ly` (per session) and what it includes: `music-functions-init.ly` (2,704: 151 functions, `\transpose`, `\tuplet`, `\tag` and `\once` among them), `toc-init.ly`, `drumpitch-init.ly`, `chord-modifiers-init.ly`, `script-init.ly`, `chord-repetition-init.ly`, `scale-definitions-init.ly`, `dynamic-scripts-init.ly`, `spanners-init.ly`, `predefined-fretboards-init.ly`, `string-tunings-init.ly`, `property-init.ly` (1,059: `\stemUp` and the other shorthands), `grace-init.ly`, `midi-init.ly` → `performer-init.ly`, `paper-defaults-init.ly` → `titling-init.ly`, `text-replacements.ly`, `context-mods-init.ly`, `ancient-init.ly`, and inside `\layout` `engraver-init.ly` (1,763) |
| Included by scores | the note-name languages (`english.ly`, `deutsch.ly`, … `arabic.ly`, `persian.ly`, `turkish-makam.ly`, `makam.ly`, `hel-arabic.ly`), `articulate.ly` (968, T19), `gregorian.ly`, `bagpipe.ly`, `swing.ly`, `event-listener.ly`, the predefined fretboards of guitar, ukulele and mandolin, the templates `satb.ly`, `ssaattbb.ly` and the `*-tkit.ly` they include |
| Not needed | `generate-documentation.ly`, `graphviz-init.ly`, `guile-debugger.ly`, `scheme-sandbox.ly`, `internal-backend-test.ly`, `lilypond-book-preamble.ly` |

## 5. What the test set reaches

**[measured]**: every score of chapter 00's test set compiled with Appendix
A's `cover.ly` as a settings file, which records what the parsed music
contains after music functions, which stream events the contexts hear, which
grobs the engravers announce, and which markup commands the music, grob
texts and headers use.

| Kind | Reached | Defined |
| --- | --- | --- |
| Music types, as parsed | 59 | 131 |
| Event classes heard by contexts | 49 | — |
| Grob types | 82, plus `System`, which every score has but is not announced | 167 |
| Markup commands | 48 (a floor: toplevel `\markup` and page titles are not walked) | 188 + 11 list commands |

Every score reaches `NoteEvent`, `SequentialMusic` and these 18 grobs:
`NoteHead`, `Stem`, `StemStub`, `NoteColumn`, `NoteSpacing`, `Clef`,
`StaffSymbol`, `LedgerLineSpanner`, `SystemStartBar`, `PaperColumn`,
`NonMusicalPaperColumn`, `SpacingSpanner`, `StaffSpacing`, `BreakAlignment`,
`BreakAlignGroup`, `LeftEdge`, `VerticalAlignment`, `VerticalAxisGroup`.
Then, in the order of how many scores use them: `BarLine` 29,
`TimeSignature` 29, `KeySignature` 28, `BarNumber` 26, `Beam` and `Flag` 17,
`Rest` 14, `Accidental`, `AccidentalPlacement`, `Dots` and `DotColumn` 12,
`SpanBar` and `StaffGrouper` 11, `TextScript` 11, then slurs, ties, tuplets,
scripts and braces (6–8), dynamics and lyrics (4–6), and 28 grobs in one or
two scores.

Events heard in five or more scores: `note-event`, `rest-event`,
`skip-event`, `beam-event`, `bar-check-event`,
`reference-time-signature-event`, `text-script-event`, `slur-event`,
`key-change-event`, `tie-event`, `tuplet-span-event`,
`articulation-event`, `lyric-event`, `absolute-dynamic-event`,
`bar-event`, `hyphen-event`, besides the context operations
`CreateContext`, `SetProperty`, `Override`, `Revert`, `ChangeParent` and
`GraceChange`. Markup commands used most: `line` 8, `bold`, `column`,
`concat` and `italic` 4.

What no score reaches, which a milestone may leave out without failing a
score (§7):

- **Families**: E5 ancient ligatures; the part combiner (`PartCombineMusic`,
  `part-combiner.scm`, `part-combine-iterator.cc`); `\quoteDuring` and cue
  notes (`QuoteMusic`, `quote-iterator.cc`); percent and slash repeats;
  `\repeat segno` and its marks; ambitus; clusters; piano pedals; fret
  diagrams and `FretBoard`; chord names (`ChordName`, though T05 enters
  chords); balloons and footnotes; staff highlights; page-turn breaking.
- **Music types** (58 of the 72 not parsed; nine more are made while
  iterating and were heard as events, and `Event`, `Music`, `SpanEvent`,
  `PostEvents` and `VoiceSeparator` are generic or internal to the
  grammar): `AdHocJumpEvent`, `AdHocMarkEvent`, `AnnotateOutputEvent`,
  `ApplyOutputEvent`, `BendAfterEvent`, `BendSpanEvent`,
  `BreakDynamicSpanEvent`, `CaesuraEvent`, `ChordSlurEvent`,
  `ClusterNoteEvent`, `CodaMarkEvent`, `DalSegnoEvent`,
  `DoublePercentEvent`, `DurationLineEvent`, `EpisemaEvent`, `FineEvent`,
  `FingerGlideEvent`, `FootnoteEvent`, `LabelEvent`, `LigatureEvent`,
  `MeasureCounterEvent`, `MeasureSpannerEvent`,
  `MultiMeasureArticulationEvent`, `NonArpeggiatoEvent`,
  `OptionalMaterialEvent`, `PageTurnEvent`, `PartCombineEvent`,
  `PartCombineMusic`, `PercentEvent`, `PercentRepeatedMusic`,
  `PesOrFlexaEvent`, `PhrasingSlurEvent`, `PolymetricTimeSignatureEvent`,
  `PolymetricTimeSignatureMusic`, `QuoteMusic`, `RehearsalMarkEvent`,
  `RelativeOctaveCheck`, `RepeatSlashEvent`, `RepeatTieEvent`,
  `ScriptEvent`, `SectionEvent`, `SectionLabelEvent`, `SegnoMarkEvent`,
  `SegnoRepeatedMusic`, `SequentialAlternativeMusic`, `SkippedMusic`,
  `SostenutoEvent`, `SpacingSectionEvent`, `StaffHighlightEvent`,
  `StaffSpanEvent`, `StrokeFingerEvent`, `SustainEvent`, `TextMarkEvent`,
  `TransposedMusic`, `TrillSpanEvent`, `UnaCordaEvent`,
  `UnfoldedSpeccedMusic`, `VowelTransitionEvent`.
- **Grobs** (84): `AccidentalCautionary`, `AccidentalSuggestion`,
  `Ambitus*`, `ApproximatePitchNoteHead`, `BalloonText`,
  `BassFigureAlignmentPositioning`, `BassFigureContinuation`, `BendAfter`,
  `BendSpanner`, `CaesuraScript`, `CenteredBarNumber*`, `ChordBracket`,
  `ChordName`, `ChordSlur`, `ChordSquare`, `ClusterSpanner*`, `CodaMark`,
  `CombineTextScript`, `ControlPoint`, `ControlPolygon`, `CueClef`,
  `CueEndClef`, `Custos`, `Divisio`, `DoublePercentRepeat*`,
  `DoubleRepeatSlash`, `DurationLine`, `Episema`, `FingerGlideSpanner`,
  `Footnote`, `FretBoard`, `GridChordName`, `GridLine`, `GridPoint`,
  `InstrumentSwitch`, `JumpScript`, `KeyCancellation`, `KievanLigature`,
  `LigatureBracket`, `LyricRepeatCount`, `MeasureCounter`,
  `MeasureGrouping`, `MeasureSpanner`, `MelodyItem`, `MensuralLigature`,
  `MultiMeasureRestScript`, `NoteName`, `OptionalMaterialBracket`,
  `Parentheses`, `PercentRepeat*`, `PhrasingSlur`, `PianoPedalBracket`,
  `RehearsalMark`, `RepeatSlash`, `RepeatTie*`, `SectionLabel`,
  `SegnoMark`, `SignumRepetitionis`, `SostenutoPedal*`, `StaffEllipsis`,
  `StaffHighlight`, `StanzaNumber`, `StrokeFinger`, `SustainPedal*`,
  `TextMark`, `TrillPitch*`, `TrillSpanner`, `UnaCordaPedal*`,
  `VaticanaLigature`, `VowelTransition`.

`KeyCancellation`, `RehearsalMark`, `TextMark`, `PhrasingSlur`,
`RepeatTie` and `\transpose` (`TransposedMusic`) are common in real scores
although the set misses them;
chapter 02's error corpus or a later score should cover them (chapter 00
§4: a score added later should cover something none of these does).

## 6. The layers of chapter 00 and the files behind them

| Layer | What makes it in LilyPond | Our code that reads it today |
| --- | --- | --- |
| C0 Diagnostics | `flower/warn.cc` (prefix and severity), `input.cc` and `source-file.cc` (location and excerpt), the messages of `lexer.ll`, `parser.yy` and `music-function.cc` for syntax, and of every engraver and iterator for the rest | `packages/vscode/src/diagnostics/parse.ts`, `packages/studio/crates/engrave/src/parse.rs` (D15, D16, D42) |
| C1 Events | M3 iterators (moments, grace time), M4 contexts and the dispatcher (`ly:add-listener`, `ly:context-events-below`), `input-scheme.cc`'s `ly:input-file-line-char-column`, all called from our `packages/common/runtime/timing.ly` (D26) | the compilers, which read the `.timing.json` and hand it to the preview's player and Lily Studio's transport (`packages/vscode/src/compile/compiler.ts`, `crates/engrave/src/compiler.rs`) |
| C2 MIDI | I, plus `scm/midi.scm`, `ly/performer-init.ly`, `ly/midi-init.ly`, and `articulate.ly` when included | `parseMidi` in `packages/common/web/midi.js` (D24), `crates/session/src/midi_export.rs` (D54), which copies lilypond's tracks unchanged |
| C3 Breaks | L3 (`constrained-breaking.cc`, `simple-spacer.cc`, the spacing files), L4 (`optimal-page-breaking.cc`, `page-layout-problem.cc`), `paper-defaults-init.ly` | the comparator of chapter 00 only |
| C4 Positions | everything of L1–L5 and the E families, O1's stencil offsets, O2's glyph and text extents, `output-svg.scm`'s `translate` and `grob-cause` | `packages/vscode/src/preview/pointAndClick.ts`, `crates/engrave/src/point_and_click.rs` (D19, D32) |

What `timing.ly` needs from the engine, if the engine runs it rather than
writing the playback map itself **[measured]** (its `ly:` calls):
`ly:add-listener`, `ly:context-events-below`, `ly:context-current-moment`,
`ly:context-property`, `ly:context-find`, `ly:context-parent`,
`ly:context-name`, `ly:context-id`, `ly:event-property`,
`ly:in-event-class?`, `ly:input-location?`,
`ly:input-file-line-char-column`, `ly:duration->moment`, `ly:duration?`,
`ly:moment?`, `ly:moment-main`, `ly:moment-grace`, `ly:parser-output-name`,
`ly:string-substitute`, `ly:string-percent-encode`, `ly:warning`; besides
`make-performer` with its `initialize`, `listeners`,
`stop-translation-timestep` and `finalize` hooks, `markup->string`, Guile
hash tables, `catch`, `format` and `with-output-to-file`. `worker.scm` and
`glyph-cache.scm` serve the native process only: the second patches
`output-svg.scm`'s font cache, whose cost per glyph drawn is the slow cold
run of chapter 00 §3.

## 7. What each later chapter takes from here

| Chapter | Reads first | Must match | May leave for later |
| --- | --- | --- | --- |
| 02 parser | P1–P3; `ly-syntax-constructors.scm`, `parser-ly-from-scheme.scm`, `define-note-names.scm`, `chord-entry.scm`, `parser-clef.scm`; `init.ly` and the parse order of `declarations-init.ly` | the music that `ly-syntax-constructors.scm` builds, locations (P2), the syntax errors of C0 | nothing: the task is the whole syntax, and every input mode is reached (`\chordmode` T05, `\figures` T06, `\drummode` T07, `\lyricmode` T04) |
| 03 Scheme | S1; `lily.scm`, `lily-library.scm`, `c++.scm`; the 520 `ly:` names `scm/` and `ly/` use; the init list (§2, step 1) | the Guile features those files and the scores use, `lily-imports.cc`'s callbacks, the session snapshot | the docs and debugging files of §4 |
| 04 music | M1–M4, E6, how E1–E5 run; `define-music-types.scm`, `define-event-classes.scm`, `define-context-properties.scm`, `engraver-init.ly`, `performer-init.ly`, `music-functions-init.ly` | C1 on all 30 scores; the 59 music types and 49 event classes of §5 | part combining, quoting, the 58 music types §5 lists as unreached |
| 05 layout | L1–L5, E1–E4; `define-grobs.scm`, `output-lib.scm`, `paper-defaults-init.ly` | C3 and C4; the 83 grobs of §5 | E5 and the 84 unreached grobs; page-turn and other breakers |
| 06 render | O1–O3; `stencil.scm`, `define-markup-commands.scm`, `framework-svg.scm`, `output-svg.scm`; for PDF `framework-ps.scm`, `output-ps.scm` and `cairo.cc`; Emmentaler's OTF tables | `grob-cause`'s link shape; the 48 markup commands of §5 | the other markup commands, diagrams, QR codes |
| 07 MIDI | I; `midi.scm`, `performer-init.ly`, `midi-init.ly`, `articulate.ly` | C2, with velocities | performers of events the set does not reach |
| 08 build | D; the options our tools pass (§3.1); `flower/warn.cc` | the diagnostics format, the outputs' file names | everything §4 marks as not needed |

## Appendix A: recipes

The checkout (blob-less, sparse; the test set's files come with
`input/regression` and `Documentation/ly-examples`):

```sh
git clone --depth 1 --branch v2.26.0 --filter=blob:none --sparse \
  https://gitlab.com/lilypond/lilypond.git lp
git -C lp sparse-checkout set lily flower scm ly ps input/regression Documentation/ly-examples
```

Counts of §1, from `lp`:

```sh
cat lily/*.cc lily/*.ll lily/*.yy | wc -l               # 112954
grep -c LY_DEFINE lily/*.cc | awk -F: '{s+=$2} END {print s}'                  # 408
grep -ho 'MAKE_SCHEME_CALLBACK[A-Z_]* *([^,]*, *[a-z_]*' lily/*.cc | wc -l     # 253
grep -ho '"ly:[^"]*"' lily/*.cc | sort -u | wc -l                              # 716
grep -ho 'ly:[a-z0-9!?<>*=/+-]*' scm/*.scm ly/*.ly | sort -u | wc -l          # 520
grep -h '^ADD_TRANSLATOR' lily/*.cc | wc -l                                    # 132
```

§3 lists every file of `lily/` exactly once, by its name without `.cc`
(`lexer.ll` and `parser.yy` with theirs). To check, from this directory
with `lp` beside it: the first command prints the files §3 misses, the
second those it lists twice; both print nothing.

```sh
ls lp/lily | sed -nE 's/\.cc$//p; /\.(ll|yy)$/p' | sort > stems
sed -n '/^## 3\./,/^## 4\./p' 01-reference-map.md | grep -oE '`[a-z0-9-]+(\.ll|\.yy)?`' \
  | tr -d '`' | sort > listed
comm -23 stems <(sort -u listed)
comm -12 stems <(uniq -d listed)
```

`cover.ly`, the settings file of §5. Each compile appends to `coverage.txt`
in the output directory, one `kind name` line per thing reached:

```sh
cd "$(dirname score.ly)" && LANGUAGE=en lilypond --loglevel=ERROR --svg \
  -dinclude-settings=/abs/cover.ly -o <out>/<id>/<base> score.ly
```

```lilypond
%% Records which music types, events, grob types and markup commands a score reaches.
#(define cover-seen (make-hash-table))
#(define (cover! kind name) (hash-set! cover-seen (cons kind name) #t))
#(define (cover-markup! m)
   (cond ((and (pair? m) (procedure? (car m)))
          (cover! 'markup (procedure-name (car m)))
          (for-each cover-markup! (cdr m)))
         ((and (pair? m) (list? m)) (for-each cover-markup! m))))
#(define (cover-music! m)
   (cover! 'music (ly:music-property m 'name))
   (for-each (lambda (p)
               (let ((v (cdr p)))
                 (cond ((ly:music? v) (cover-music! v))
                       ((and (list? v) (pair? v) (ly:music? (car v))) (for-each cover-music! v))
                       ((markup? v) (cover-markup! v)))))
             (ly:music-mutable-properties m)))
#(define cover-recorder
   (lambda (context)
   (make-engraver
    ((initialize engraver)
     (ly:add-listener
      (lambda (event) (cover! 'event (car (ly:event-property event 'class))))
      (ly:context-events-below context) 'StreamEvent))
    (acknowledgers
     ((grob-interface engraver grob source)
      (cover! 'grob (assq-ref (ly:grob-property grob 'meta) 'name))
      (let ((t (ly:grob-property-data grob 'text)))
        (when (markup? t) (cover-markup! t))))))))
\layout { \context { \Score \consists #cover-recorder } }
#(define (cover-header! h)
   (when (module? h)
     (module-for-each (lambda (k v) (let ((x (variable-ref v))) (when (markup? x) (cover-markup! x)))) h)))
#(define (cover-book! book)
   (cover-header! (ly:book-header book))
   (for-each (lambda (s) (when (ly:score? s) (cover-header! (ly:score-header s)) (cover-music! (ly:score-music s))))
             (ly:book-scores book))
   (for-each cover-book! (ly:book-book-parts book)))
#(define cover-book-handler toplevel-book-handler)
#(define (toplevel-book-handler book)
   (cover-book! book)
   (cover-book-handler book)
   (let ((port (open-file "coverage.txt" "a")))
     (hash-for-each (lambda (k v) (format port "~a ~a\n" (car k) (cdr k))) cover-seen)
     (close-port port)))
```

The totals of "Defined" in §5, from LilyPond itself:

```lilypond
#(for-each (lambda (d) (format #t "music ~a\n" (car d))) music-descriptions)       % 131
#(for-each (lambda (d) (format #t "grob ~a\n" (car d))) all-grob-descriptions)     % 167
#(let ((n 0) (l 0))
   (module-for-each
    (lambda (k v)
      (let ((x (variable-ref v)))
        (when (and (procedure? x) (markup-command-signature x))
          (if (markup-list-function? x) (set! l (1+ l)) (set! n (1+ n))))))
    (resolve-module '(lily)))
   (format #t "markup ~a list ~a\n" n l))                                          % 188, 11
#(for-each (lambda (n) (format #t "~a ~a\n" n (length (ly:context-def-lookup
             (ly:output-def-lookup $defaultlayout n) 'consists))))
           '(Voice Staff Score))                                                  % 48, 34, 26
```
