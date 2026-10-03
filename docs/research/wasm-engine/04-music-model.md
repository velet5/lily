# 04 — A compact music model that a phone can update quickly

Chapter 04 of the investigation into an engine of our own (chapter 00 sets
the budgets and the test set, chapter 01 maps LilyPond's source, chapter 02
designs the parser, chapter 03 the Scheme interpreter). It measures what
LilyPond's music, iteration and translation amount to on the 30 scores of
chapter 00 and where translation spends its time (§2), measures what each
edit of chapter 00 §6.2 changes in the translation (§3), and designs values,
music expressions, contexts, iterators, engravers and performers (§5–§9) and
the way an edit recomputes only what it affects (§10). It records no
decision; D56 (step 11) will.

Everything refers to LilyPond at tag `v2.26.0` (commit
`3596756be0fac1f81066a99d2054329212172b2d`). **[measured]** marks what was
taken on 2026-10-03 on the M1 Max of chapter 00 with `GNU LilyPond 2.26.0
(running Guile 3.0)` of Homebrew and macOS's `sample`; the recipes are in
Appendix A. Projections onto the phones use chapter 00's factors (× 1/0.45
for the Android reference's CPU, × 1.5 for wasm) until step 10 measures.

## 1. How LilyPond interprets music

What chapter 01 calls families M1–M4 and E6, as a compile runs them:

- **Music** is a `Prob`: a type name from `scm/define-music-types.scm` (131
  types) with an immutable property list from that definition and a mutable
  one of its own. Lengths, starts and `\relative` are callbacks of the type.
  The parser builds it through `ly-syntax-constructors.scm`; music functions
  read and mutate it freely, since every reference to a variable is a copy
  (§2.1).
- **Iterators** (23 classes, chapter 01 M3) form a tree that mirrors the
  music while it is interpreted. `Global_context::iterate`
  (`global-context.cc:137`) asks the root for its `pending_moment`, sends
  `Prepare` with that moment (`:191`), lets the iterators `process` it, which
  finds or creates contexts and sends them events, and sends `OneTimeStep`
  (`:200`). A moment is a *timestep*.
- **Events** are `Stream_event`s made from the music's property list by
  `Music::to_event` (`music.cc:243`), which adds the length and turns
  articulations into events. They are broadcast by `Dispatcher`s: each
  context has an event source and an `events_below` dispatcher that hears
  the sources of all contexts below it.
- **Contexts** (chapter 01 M4) hold properties in a Scheme hash table, grob
  property overrides as stacks of nested alists, and a translator group. They
  are created by `find_create_context` (`context.cc:269`) from definitions
  (`\consists`, `\accepts`, `\defaultchild`, `\alias`) and removed when no
  iterator uses them any more.
- **Translators** (engravers and performers) follow the timestep protocol
  that `Score_engraver::one_time_step` drives: `start-translation-timestep`,
  listeners for event classes, `pre-process-music`, `process-music`, then
  announcing and acknowledging grobs until none is left
  (`Engraver_group::do_announces`, `engraver-group.cc:184`), then
  `stop-translation-timestep`. A grob made by an engraver is announced to
  the engravers of its own context and every enclosing one
  (`add_grob_to_announce`, `:101`), which acknowledge it by interface.
  Performers do the same with audio elements.
- **Every translator method is called through Guile.** The method lists that
  `Translator_group::precomputed_translator_foreach`
  (`translator-group.cc:277`) and `Engraver_dispatch_list::apply`
  (`translator-dispatch-list.cc:24`) walk hold `Method_instance`s, whose call
  is `ly_call (method_, instance_, …)` (`include/callback.hh:260`): a C++
  method reached through a Scheme procedure call and a trampoline back into
  C++. §2.3 shows what that costs.

Translation feeds back into iteration in a few places, which is why
LilyPond runs them in lockstep, one timestep at a time:

- `\lyricsto` and `\addlyrics`: the lyric combine iterator reads whether the
  associated voice is in a melisma (`melisma_busy`, `context.cc:1006`), from
  properties that the slur, tie and beam engravers and performers set
  (`slurMelismaBusy`, `tieMelismaBusy`, `beamMelismaBusy`), and reads
  `associatedVoice` and `ignoreMelismata`;
- `\applyContext` runs a procedure on a context at its moment;
- the alternatives of `\repeat volta` read `timing` and
  `alternativeRestores`; the quote iterator reads `quotedEventTypes`;
- `\change Staff` finds its target context by id at that moment.

## 2. What the test set uses

### 2.1 Music trees

**[measured]** with Appendix A's `c4.ly` in `census` mode, which walks each
score's music as the book handler receives it, after the parser and the
toplevel music functions. It also adds a `\midi` to every score, as chapter
00's capture does, so that every score has a performance.

| | All 30 scores | Largest (T29) |
| --- | --- | --- |
| Music objects | 7,926 | 1,719 |
| of them events | 3,777 | 906 |
| of them rhythmic events | 2,606 | 490 |
| Music types | 59 of 131 | 27 |
| Properties (mutable) | 30,547, 3.85 a node | 6,210 |
| Greatest depth | 19 (T24) | 14 |
| Objects reached twice | 0 | 0 |
| Objects copied from the same source text | 708 (9 %) | 107 |

- **Every reference is a copy.** No music object is reachable twice from a
  score's music, and 708 objects were made from source text another one was
  made from: a variable's music copied where it is referenced (T05's chords
  are engraved and named, T22's music is in a staff and a tablature) or a
  shorthand's definition copied at each use (`\stemDown`).
- **What a node holds**, by kind of property value: 7,926 moments (the
  `length` that LilyPond caches on every node), 6,289 origins, 3,977
  symbols, 2,661 durations, 2,140 pitches, 1,937 integers, 1,486 lists of
  music and 1,040 music values (the children), 1,305 booleans, 521 strings,
  292 symbol lists, 188 procedures, 48 markups and 737 others (empty
  lists, alists such as tweaks). Without the cached length and the origin, a
  node has 2.1 properties.
- **The common types**: `NoteEvent` 2,130 (in all 30), `OverrideProperty`
  967, `ContextSpeccedMusic` 843, `SequentialMusic` 691, `PropertySet` 568,
  `RevertProperty` 293, `EventChord` 265, `BarCheckEvent` 222,
  `SlurEvent` 195, `RestEvent` 157; 49 more types below 155 each.

Music is small: the 30 scores together have 7,926 nodes, fewer than half
of the 20,653 grobs their translation makes (§2.2).

### 2.2 Translation

**[measured]**, same run: a Score-level translator in `\layout` and in
`\midi` counts timesteps, the contexts created (with the translators their
definitions consist of), the stream events heard below the Score and the
grobs acknowledged; `time` mode (only the hooks at `initialize` and
`finalize`) times the translation, median of three runs. *Book* is
`toplevel-book-handler` for the whole book, which is translation for
`\layout` and `\midi` plus line and page breaking, with `-dno-print-pages`
(no SVG). *Bars* are the timesteps at which the Score's `measurePosition`
is zero (in T05 and T27 every timestep is one).

| ID | Music nodes | of them events | Depth | Copies | Timesteps | Bars | Contexts | Translators | Stream events | Grobs | Translate, ms | MIDI translate, ms | Book, ms |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T01 | 10 | 6 | 5 | 0 | 7 | 3 | 3 | 109 | 8 | 80 | 2.5 | 0.3 | 21 |
| T02 | 95 | 70 | 8 | 0 | 19 | 9 | 6 | 199 | 80 | 368 | 11.1 | 1.5 | 65 |
| T03 | 13 | 10 | 4 | 0 | 12 | 4 | 3 | 109 | 12 | 100 | 3.4 | 0.4 | 23 |
| T04 | 109 | 62 | 11 | 12 | 30 | 2 | 10 | 337 | 109 | 520 | 29.0 | 2.2 | 91 |
| T05 | 165 | 133 | 6 | 77 | 29 | 29 | 3 | 109 | 135 | 685 | 15.2 | 1.2 | 69 |
| T06 | 69 | 43 | 6 | 0 | 12 | 3 | 5 | 115 | 54 | 193 | 4.8 | 0.5 | 46 |
| T07 | 69 | 40 | 12 | 0 | 39 | 5 | 6 | 210 | 97 | 665 | 31.4 | 2.7 | 85 |
| T08 | 81 | 47 | 8 | 0 | 36 | 4 | 3 | 109 | 81 | 341 | 11.3 | 10.9 | 54 |
| T09 | 95 | 43 | 9 | 31 | 23 | 3 | 3 | 109 | 48 | 236 | 7.4 | 0.9 | 58 |
| T10 | 27 | 14 | 7 | 0 | 12 | 4 | 3 | 109 | 36 | 165 | 4.6 | 0.6 | 29 |
| T11 | 75 | 37 | 8 | 6 | 24 | 5 | 6 | 199 | 69 | 274 | 10.4 | 11.2 | 51 |
| T12 | 448 | 268 | 10 | 11 | 137 | 27 | 9 | 397 | 476 | 1418 | 50.3 | 4.7 | 154 |
| T13 | 6 | 5 | 3 | 0 | 4 | 3 | 3 | 109 | 7 | 61 | 1.9 | 0.2 | 46 |
| T14 | 4 | 3 | 2 | 0 | 3 | 1 | 3 | 109 | 5 | 40 | 1.7 | 0.2 | 20 |
| T15 | 12 | 10 | 4 | 0 | 4 | 1 | 3 | 110 | 12 | 59 | 15.2 | 0.3 | 29 |
| T16 | 6 | 4 | 3 | 0 | 5 | 2 | 3 | 109 | 6 | 55 | 2.0 | 0.3 | 15 |
| T17 | 21 | 12 | 5 | 0 | 41 | 11 | 3 | 109 | 46 | 408 | 13.2 | 1.6 | 65 |
| T18 | 33 | 27 | 4 | 0 | 17 | 5 | 3 | 109 | 31 | 185 | 5.5 | 0.7 | 30 |
| T19 | 28 | 8 | 8 | 2 | 9 | 5 | 3 | 109 | 10 | 124 | 3.2 | 0.5 | 25 |
| T20 | 72 | 52 | 8 | 0 | 9 | 5 | 7 | 141 | 49 | 184 | 4.7 | 0.9 | 48 |
| T21 | 71 | 37 | 11 | 4 | 16 | 5 | 7 | 202 | 54 | 203 | 7.3 | 1.0 | 43 |
| T22 | 516 | 198 | 14 | 194 | 26 | 5 | 8 | 290 | 393 | 564 | 60.7 | 2.8 | 122 |
| T23 | 287 | 179 | 12 | 20 | 51 | 14 | 19 | 623 | 312 | 905 | 50.3 | 3.9 | 142 |
| T24 | 880 | 549 | 19 | 30 | 208 | 14 | 11 | 425 | 979 | 4031 | 169.2 | 16.1 | 369 |
| T25 | 678 | 199 | 13 | 84 | 49 | 4 | 11 | 425 | 678 | 842 | 46.5 | 5.1 | 132 |
| T26 | 266 | 88 | 16 | 13 | 22 | 5 | 10 | 304 | 266 | 483 | 41.8 | 4.3 | 84 |
| T27 | 922 | 152 | 14 | 48 | 16 | 16 | 18 | 773 | 1023 | 433 | 35.3 | 15.1 | 88 |
| T28 | 720 | 236 | 14 | 54 | 55 | 4 | 10 | 390 | 453 | 1196 | 51.2 | 19.8 | 162 |
| T29 | 1719 | 906 | 14 | 107 | 49 | 6 | 66 | 2060 | 1399 | 3709 | 191.1 | 31.7 | 456 |
| T30 | 429 | 339 | 10 | 15 | 93 | 10 | 15 | 519 | 392 | 2126 | 87.7 | 6.6 | 180 |
| **All** | 7,926 | 3,777 | | 708 | 1,057 | 214 | 263 | 9,027 | 7,320 | 20,653 | 969.8 | 148.2 | 2,801 |

What it says:

- **Translation is up to half of LilyPond's work after parsing**: the two
  translations take 36 % of *Book* in T12 and 49–52 % in T24, T29 and T30,
  the rest being line and page breaking.
- **Few timesteps, many translators.** T29 has 49 timesteps but 66 contexts
  that consist of 2,060 translators; in `$defaultlayout` the Score consists
  of 26, a Staff of 34, a Voice of 48, Lyrics of 8 and the staff groups of
  6–8 **[measured]**. LilyPond calls every translator that has a method for
  a phase at every timestep, whether or not it has anything to do.
- **Grobs outnumber music by 2.6 to 1**: a note makes a `NoteHead`, `Stem`,
  `StemStub`, `NoteColumn`, `NoteSpacing` and often a `Flag` (2,182 note
  heads, 2,094 stems, 1,478 flags in all), and each timestep a
  `PaperColumn` and a `NonMusicalPaperColumn` (1,057 each).
- **Property operations are a large share of the events**: of the 7,320
  stream events, 1,249 are `Revert`, 985 `Override`, 589 `SetProperty` and
  230 `CreateContext`, against 2,215 `note-event`s. Contexts change few
  properties with `\set` (at most 8 distinct ones in one context, 3.9 on
  average over the 104 contexts that set any), but one context of T27 hears
  144 overrides. The definitions set more: the Score's 121 properties, Lyrics
  14, PianoStaff 9, StaffGroup 7, Staff 6, Voice none **[measured]**.
- **Scheme translators run in every score.** Of the 26 translators written
  in Scheme (chapter 01 §1), the default Score consists of 5, Staff of 6 and
  Voice of 5 (`Text_mark_engraver`, `Skip_typesetting_engraver`,
  `Trill_spanner_engraver`, `Apply_output_engraver` among them), which is
  where `scheme-engravers.scm`'s 179,000 applications of chapter 03 §2.4
  come from.
- **MIDI translation is cheaper**: a MIDI Staff consists of fewer
  translators (T29's 59 MIDI contexts consist of 242) and makes no grobs;
  0.2–31.7 ms.

### 2.3 Where translation time goes

**[measured]** with macOS's `sample` at 1 ms intervals on a compile that
includes T29 twelve times (and T24 eight times), so that translation runs
long enough to sample; the samples inside `Global_context::iterate` are
attributed to the function at the top of the stack (*self*) and to the
outermost translation phase below `iterate` on the stack (Appendix A,
`prof2.py`).

| Self time inside translation | T29 (1,289 samples) | T24 (311 samples) |
| --- | --- | --- |
| `sigprocmask` and `__sigaltstack` called by `setjmp` | 53.5 % | 51.4 % |
| Guile runtime and VM | 14.0 % | 11.3 % |
| LilyPond's C++ | 13.3 % | 13.2 % |
| Garbage collector | 7.8 % | 10.3 % |
| Other (C++ runtime, `dynamic_cast`, locks, allocation) | 11.4 % | 13.8 % |

| Phase, inclusive | T29 | T24 |
| --- | --- | --- |
| Translator methods called per timestep (`precomputed_translator_foreach`) | 52.1 % | 53.1 % |
| Acknowledgers (`Engraver_dispatch_list::apply`) | 26.1 % | 26.4 % |
| Iterators | 13.7 % | 14.5 % |
| Creating and removing contexts | 1.9 % | 2.6 % |

What it says:

- **Half of translation is the cost of entering Guile.** Each translator
  method is a Scheme call (§1), Guile's `scm_call_n` calls `setjmp` on every
  entry (`libguile/vm.c` in Guile's repository), and macOS's `setjmp` also
  saves the signal mask: two system calls per call. Of T29's samples in
  `setjmp`, 400 come from `precomputed_translator_foreach`, 203 from
  `Engraver_dispatch_list::apply` and the rest from the other places where
  C++ calls Scheme (type checks, listeners, `Dispatcher::dispatch`); Guile's
  frame between them is not on the sampled stacks. glibc's `setjmp` does not
  save the signal mask, so on Linux this share should be smaller; it was not
  measured.
- **What is left is mostly calls, not engraving.** LilyPond's own C++ is
  13 % of translation, Guile's runtime (Scheme engravers, property alists,
  the call machinery) 11–14 %, garbage collection 8–10 %.
- **The basis for projecting our engine.** An engine whose translators are
  Rust called directly, with the same work to do, would spend at most what
  LilyPond spends in its C++ and in Guile's runtime: 27 % of the measured
  translation (T29: 52 ms of 191). Projected onto the Android reference,
  full translation costs 0.27 × 3.3 ≈ 0.9 times LilyPond's desktop time:
  T02 10 ms, T12 45 ms, T22 55 ms, T24 152 ms, T29 172 ms. This is the
  basis of §10.7 and §12, and an upper bound only as far as Rust engravers
  do no more work than LilyPond's C++ and Scheme do; step 10 measures.

## 3. What an edit changes

**[measured]** with `c4.ly` in `trace` mode, which adds an engraver to every
context of `$defaultlayout` (custom contexts derived from them inherit it)
and writes, for the first `\layout` translation, one line per event (its
class and pitch, duration, text, direction and similar properties, without
its origin) attributed to the deepest context that heard it, one line per
grob announced (its type, the context of the engraver that made it, and its
cause's digest), and at each bar start a digest of every context's values
of 268 translation properties (all 277 but those that hold the current
column, bar line or similar grobs). Each score of chapter 00 §6.2's
edit set is compiled unedited (E0) and with each edit, from a copy in one
directory (Appendix A, `edits.mjs`), and `diff.mjs` compares each edit's
trace with E0's. Two compiles of E0 compare equal.

The edits follow chapter 00 §6.2 at the middle event of the capture's first
performance, or the first one after it whose text starts with a note name
(T24's middle event is a bare `16`). When the note is inside a chord, E2
inserts the whole chord, so that time moves as E2 intends. The notes: T02
`b4` (bar 5), T12 the `g` of `<g b>`, T24 a `g` of the right hand (in
`deutsch.ly` names, so E1 makes it `a`), T29 the `f` of `<aes f>` in the
first trumpets' part.

| Score | Edit | Timesteps before → after | First – last changed moment | Timesteps changed | Context-timesteps changed | Contexts changed | Bar starts with a changed state |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T02 | E1 pitch | 19 → 19 | 3 | 1 | 1 of 82 | 1 of 6 | 1 of 9 (the edited bar's own) |
| T02 | E2 reflow | 19 → 21 | 13/4 – 25/4 | 12 | 25 of 92 | 5 of 6 | 4 of 9 |
| T02 | E3 text | 19 → 19 | — | 0 | 0 of 82 | 0 | 0 of 9 |
| T12 | E1 | 137 → 137 | 21/2 | 1 | 1 of 325 | 1 of 9 | 0 of 27 |
| T12 | E2 | 137 → 143 | 21/2 – 217/8 | 95 | 173 of 385 | 6 of 9 | 17 of 28 |
| T12 | E3 | 137 → 137 | — | 0 | 0 of 325 | 0 | 0 of 27 |
| T24 | E1 | 208 → 208 | 25/4 – 13/2 | 2 | 4 of 852 | 2 of 9 | 0 of 14 |
| T24 | E2 | 208 → 209 | 13/2 – 53/4 | 26 | 52 of 865 | 5 of 9 | 7 of 14 |
| T24 | E3 | 208 → 208 | — | 0 | 0 of 852 | 0 | 0 of 14 |
| T29 | E1 | 49 → 49 | 11/8 | 1 | 1 of 749 | 1 of 66 | 0 of 6 |
| T29 | E2 | 49 → 50 | 11/8 – 17/4 | 13 | 43 of 780 | 27 of 66 | 4 of 6 |
| T29 | E3 | 49 → 49 | — | 0 | 0 of 749 | 0 | 0 of 6 |

The contexts changed, by context: T24 E1 the edited voice and its staff at 2
timesteps each (an accidental later in the bar); T24 E2 the voice at 26
timesteps, its staff 13, the Score 5, the other two staves 4 each; T29 E2
the trumpet's voice 13, its staff 4, the Score 2, and each of the other 24
staves exactly 1, the last timestep, where the final bar line now stands
later; T12 E2 the edited voice 76, the Score 46, the staff 23 (T12 is one
staff whose voices follow each other).

What it says:

- **A pitch changes almost nothing in translation**: one or two timesteps of
  one voice and its staff, and by the next bar start every context's state is
  what it was (T02's one changed bar start is the edited bar's own). What a
  pitch edit really changes is layout, chapter 05's part.
- **A reflow changes the edited part from the edit to the end**, never
  converging, since every later event of that voice moved, but the other
  parts change only where the Score's timing does: in T29 at 2 timesteps and
  in each of the 24 other staves at 1. Recomputing every context from the
  edit to the end would redo 28 of T29's 49 timesteps in all 66 contexts;
  what actually changed is 43 context-timesteps of 780.
- **A header edit changes nothing** in translation.
- **Bars are a coarse unit in some scores**: T25 has 49 timesteps in 4 bars,
  T28 55 in 4, T29 49 in 6; a scheme that restarts at bar starts only would
  redo up to a quarter of those scores for a pitch.

## 4. What the model must do

| # | Requirement | Why |
| --- | --- | --- |
| G1 | Produce LilyPond's timesteps, contexts and events in LilyPond's order, including the feedback of §1 | C1 compares every rhythmic event's moment and link; C2 and C4 depend on the order in which contexts are made (tracks, staves) |
| G2 | Give music, events, contexts, moments, pitches and durations a Scheme face: the `ly:` functions on them that `scm/` and `ly/` use (about 110 of the 520), and LilyPond's mutable-music semantics for music functions | chapter 03 R12; music functions, `\applyContext`, Scheme engravers |
| G3 | Take the parser's output as it is: music with span origins, immutable results reused across edits, copied before a function changes them | chapter 02 §5.5, §5.7 |
| G4 | Keep the parts of B4 small: music, contexts, translator states and what incremental work keeps | chapter 00 B4 (L: 128 MB Must, everything included) |
| G5 | Recompute after an edit only the timesteps and the contexts whose input changed (§3) | B6 |
| G6 | Translate a whole score fast enough for a first render | B5b |
| G7 | Stop between timesteps when a newer edit arrives | B8 (50 ms) |
| G8 | Run translators written in Scheme (`make-engraver`, `make-performer`, `make-translator`) with the same protocol, including `timing.ly`'s | T15; D26's playback map; chapter 01 §6 |
| G9 | Report what changed to layout, as columns and lines | chapter 05 re-lays out only the systems an edit touches |

## 5. Values

LilyPond's own: a `Rational` is a sign and two `uint64_t` (24 bytes,
`flower/include/rational.hh`), a `Moment` two rationals, a `Pitch` an octave,
a step, a rational alteration and a scale pointer, a `Duration` a log, dots
and a rational factor.

```rust
struct Rational { num: i64, den: i64 }        // normalised, den > 0; den == 0 for ±∞
struct Moment { main: Rational, grace: Rational }  // 32 bytes, ordered by main then grace
struct Pitch { octave: i8, step: u8, alter: u16, scale: u8 }  // alter, scale: indices of interned values
struct Duration { log: i8, dots: u8, factor: u16 }  // factor: index of an interned rational, 0 = 1
```

- **Arithmetic is checked.** A result that does not fit `i64` becomes a
  rational of chapter 03's numbers (bignums) on the Scheme heap, so no
  moment silently differs from LilyPond's; none of the 30 scores comes near.
- **Pitches and durations are immediates.** Alterations (0, ±1/2, ±1/4,
  ±3/4, …), duration factors (`*2/3`, `R1*4`) and scales are few, so they
  are interned in tables shared by the session, and a pitch packs into 40
  bits and a duration into 32. Chapter 03's 8-byte values (§5.1 there) give
  both a tag of their own: the 2,661 durations and 2,140 pitches of §2.1
  then cost no heap object. Moments stay heap objects (two rationals), but
  the engine's own code passes them by value.
- **Transposition** follows `pitch.cc` and `scale.cc`, including
  `transpose-key-alist` and the alteration rounding of `\transpose`.

## 6. Music expressions

### 6.1 Frozen trees

The parser (chapter 02) builds each toplevel item's music into a **frozen
tree**: an array of 32-byte nodes in preorder, so that a subtree is a
contiguous range and a copy of it is one `memcpy`.

```rust
#[repr(C)]
struct Node {          // 32 bytes
    kind: u8,          // one of the 131 music types; a table generated from define-music-types.scm
    flags: u8,         // role in the parent (element, elements, articulations, other), has_extra, is_event
    aux: u16,          // small fields: direction, span-direction, digit, string number
    size: u32,         // nodes in this subtree, itself included; the next sibling is at index + size
    origin: Span,      // file: u16, start: u32, len: u16 (chapter 02 §5.1)
    payload: [u8; 12], // by kind, below
    extra: u32,        // 0, or an index into the side table of other properties (a Scheme alist)
}
```

| Kinds | Payload |
| --- | --- |
| rhythmic events (`NoteEvent`, `RestEvent`, `SkipEvent`, `LyricEvent`, `BassFigureEvent`, …) | a duration and a pitch (8 bytes); the drum type, lyric text or figure in `extra` |
| `PropertySet`, `PropertyUnset`, `OverrideProperty`, `RevertProperty` | the property's symbol (4 bytes) and its value as an 8-byte Scheme value; the grob property path in `extra` |
| `ContextSpeccedMusic` | context type and id (symbols, 4 + 4), `create-new` and search direction |
| `TimeScaledMusic` | numerator and denominator |
| repeats | the count and the kind of repeat |
| span events, articulations, scripts | the type symbol; the direction in `aux` |
| everything else | nothing; rare properties (`tweaks`, `midi-extra-velocity`, `property-operations`, `procedure`, markups) in `extra` |

Lengths and starts are not stored in the node. They are computed by Rust
code of the music types' callbacks on first use and kept in a side array of
two moments per node, built for a tree the first time it is iterated.

The music of T29 is 1,719 nodes, 55 KB; all 30 scores together 7,926 nodes,
254 KB, plus their side tables (§11).

### 6.2 The Scheme face and mutation

Music in Scheme is a foreign object (chapter 03 §5.1) holding a tree and a
node index. Reading a property whose value is an immediate (a pitch, a
duration, a symbol, a number, an origin) reads the node. Anything that could
be mutated and must stay mutated, as LilyPond's music is, needs a mutable
object:

- **Thawing.** The first time Scheme reads a property that holds music or a
  list, or sets any property, the tree under the handle's root is *thawed*
  into live music: Scheme-heap objects with property lists as LilyPond's
  `Prob` has them, and every handle into that root is forwarded to its live
  copy. Live music behaves as LilyPond's does in every respect, which is
  what music functions, `make-music` and `music-map` are written against.
- **Freezing.** When a music function returns to the parser, its result is
  frozen into the item's tree again. A function that only reads pitches and
  durations never thaws anything.
- **Copies are cheap**: LilyPond copies a variable's music at every
  reference (§2.1); a frozen subtree is shared instead, and a thaw copies it
  only when Scheme would see the difference.
- **Native operations** work on frozen trees and produce frozen trees: the
  constructors of `ly-syntax-constructors.scm` (chapter 02 builds music
  directly), `\relative` (the `to-relative-callback`s), `\transpose`,
  durations compressed by `\tuplet` and `\scaleDurations`, lengths and
  starts, and `music-functions.scm`'s walkers when they move to Rust
  (chapter 03 §6: `music-map`, `music-filter`, `recompute-music-length`).

Thawing costs a Scheme object per node and two pairs per property: up to
about 300 KB for the whole of T29 (1,719 nodes, 6,210 properties), and only
the trees Scheme mutates are thawed.

### 6.3 Identity across edits

Every frozen node carries a 64-bit digest of its kind, payload, `extra` and
its children's digests, without its origin, so that text that only moved
keeps its digest (chapter 02 §5.7 shifts the spans of an item it takes
over). The digest serves two purposes:

- deciding whether a score's music changed at all, and where: the first
  node whose digest differs between the old tree and the new one, walked in
  parallel, gives the earliest moment translation can differ (§10.1);
- naming things that translation makes. A context's or grob's *stable id*
  is a hash of the digests on the path to the music that caused it, of its
  type and of its ordinal among siblings with the same digest. Ids only let
  later stages reuse their caches (chapter 05's per-grob layout, chapter 06's
  per-glyph output); correctness never depends on them, so a collision
  costs a cache miss, not a wrong page.

## 7. Contexts

**Definitions.** The `\context` blocks of an output definition
(`engraver-init.ly`'s 43 and the score's own) compile once into immutable
`ContextDef`s: name and aliases, accepted definitions and default child, the
translator classes it consists of (Rust classes or Scheme procedures), and
its property operations. A `\with` makes a derived definition, cached by its
base and the digest of its modifications, so that 20 staves made with the
same `\with` share one.

**Instances**, in one arena per translation:

```rust
struct Context {
    def: DefId,                // u16
    id: Sym,                   // u32
    parent: CtxId,             // u32; children as first_child / next_sibling
    first_child: CtxId,
    next_sibling: CtxId,
    props: PropMap,            // persistent, below
    overrides: OverrideMap,    // grob type -> persistent stack of (path, value)
    translators: Range<u32>,   // into the arena of translator states
    stable_id: u64,            // §6.3
}
```

- **Properties** are interned at image build to `PropId: u16`: the 277
  translation properties of `define-context-properties.scm` and the grob
  names; a property a score invents (`\set Staff.foo = …`) gets an id when
  first used. A context's own properties are a **persistent** sorted array
  of `(PropId, Value)` with a 64-bit summary mask, replaced as a whole on a
  write: a lookup walks up the parents (depth ≤ 6 in the corpus) and skips
  every context whose mask lacks the property's bit. Copy-on-write is cheap
  because contexts set few properties (§2.2); the Score's 121 defaults are a
  dense table instead, since it is written rarely and read most.
- **Overrides** are stacks per context and grob type, kept as Scheme lists,
  so that a push is a cons, `\once` a push with a matching pop at the end of
  the timestep (as `Engraver_group::override` schedules it) and a snapshot a
  pointer copy. A grob made in a context takes the effective stack as its
  property chain, as LilyPond's grobs take their alist, at no copying cost.
- **Creation** ports `find_create_context`, `path_to_acceptable_context` and
  `create_context_from_event` (`context.cc`) as they are: which context an
  event reaches, and in which order contexts are made, are C1 and C2.
- **Removal**: a context whose iterators are done is finalized at the end of
  the timestep, as `check_removal` does; its record stays in the arena for
  the change list (§10.6).

## 8. Iterators

Iteration keeps LilyPond's lockstep protocol, because of the feedback of §1
and because C1 compares its result: `pending_moment`, `process`, `ok`,
`run_always`, `construct_children`, `quit`, and the global loop of
`global-context.cc:137–210` with its extra moments
(`add_moment_to_process`).

- **One enum, one arena.** The 23 iterator classes become one Rust enum;
  active iterators live in a `Vec` indexed by `u32`, with parent and child
  links as indices. An iterator of a sequence holds the index of its current
  child and the moment that child started; an event iterator only its node.
  There is at most one iterator per node (1,719 in T29), and far fewer at
  once.
- **Events are references.** An event is `(tree, node, class)` plus an
  optional overlay for properties set on the event later
  (`ly:event-set-property!`): 16 bytes, no property list copied. Its class
  is a `u8` with the ancestors of `define-event-classes.scm` as a 256-bit
  set, so that a listener for `rhythmic-event` matches a `note-event` with a
  bit test.
- **Positioning at a moment.** To resume from a checkpoint (§10.2), the
  iterator tree is rebuilt from the snapshot's positions (for each active
  iterator, its node's stable id, its child index and the moment its child
  started) against the new frozen tree. Only music after the edit's moment
  changed, so every position before it refers to the same node in the new
  tree; the cached lengths make the rebuild a walk down, never an iteration
  from the start.
- **Cancellation** (B8, G7) is checked between timesteps. At 3.5 ms per
  T29 timestep on the Android reference (§2.3's projection, 172 ms over 49
  timesteps), a newer edit stops a translation well within 50 ms.

## 9. Translators: engravers and performers

### 9.1 The framework

- **Classes are static.** Each Rust translator class declares its name,
  whether it engraves or performs, which protocol methods it has, the event
  classes it listens to (a 256-bit set), the grob interfaces it acknowledges
  at the start and end of a grob (a 256-bit set: there are 174 interfaces,
  88 defined in `define-grob-interfaces.scm` and 86 by `ADD_INTERFACE` in
  C++), and the size of its state. Methods are plain functions on the state,
  called directly: none of §2.3's Scheme hops.
- **Only translators with work run.** LilyPond calls every translator with
  a method for a phase at every timestep. Ours keeps, per translator group,
  the list of translators that must run every timestep (`Timing_translator`,
  `Bar_engraver`, the column and spacing engravers) and wakes the others only
  when one of their events arrived, a grob they acknowledge was announced, or
  they asked to stay awake (a pending tie, an open beam). Since most of
  LilyPond's translation time is per-translator calls (§2.3), this is where
  the engine saves most.
- **Acknowledging** dispatches by grob type: for each translator group and
  grob type, the list of acknowledgers is computed once (LilyPond's hash of
  class and name in `acknowledge_grobs` does the same) and is an array
  indexed by type.
- **Grob records** are what translation hands to layout: type, context,
  cause (an event or another grob), the timestep, the stable id of §6.3, and
  the property chain of §7. Their layout properties are chapter 05's.

### 9.2 Translators written in Scheme

`make-engraver`, `make-performer` and `make-translator` give an alist of
procedures (LilyPond's `Scheme_engraver`). The framework wraps it as a class
whose methods call chapter 03's interpreter, with the same wake rules: a
Scheme translator without listeners or acknowledgers for this timestep and
without a per-timestep method is not called. Their state is their closures',
on the Scheme heap; it is checkpointed through chapter 03's epochs and undo
log (R11 there), not copied.

The 16 Scheme engravers that the default Score, Staff and Voice consist of
(§2.2) run in every score; they are short (2,677 lines for all of
`scheme-engravers.scm`) and move to Rust, as chapter 03 §6 proposed. The
others (`Chord_name_engraver`, `Current_chord_text_engraver`, …) stay
Scheme and come with their parts of chapter 03 §6 (`chords`).

### 9.3 Performers and the playback map

Performers run on the same framework, making audio items instead of grobs
(chapter 07 designs them). A `\midi` performance is a translation of its
own, as in LilyPond: its contexts differ from the layout's (T29's custom
contexts do not exist in `\midi`, chapter 00 §5.1). It runs after the page
is shown, so it is not part of B6: the MIDI translation was 0.2–31.7 ms in
LilyPond (§2.2).

The playback map (D26) is written by a built-in performer that records what
`timing.ly` records, so no Scheme runs per event; `timing.ly` itself still
runs unchanged as the check that the engine supports Scheme performers
(G8), with the `ly:` functions chapter 01 §6 lists.

## 10. Recomputing only what an edit affects

### 10.1 What changed

Chapter 02 reports the changed items and blocks. For each `\score` (and each
output definition of it):

1. If the digest of its music and of its output definition is unchanged,
   its translation is kept as it is. This is E3: a header or a `\markup`
   outside the music re-runs only titles and layout.
2. Otherwise the earliest moment at which iteration can differ is the start
   of the first node whose digest changed, from the cached starts: `m_e`.

### 10.2 Checkpoints

During a translation, the engine checkpoints at every bar start, and at
least every 8 timesteps where bars are long or absent (§3: T25, T28, T29). A
checkpoint holds:

- the iterator positions (§8);
- the context tree: per context its definition, parent, id and the pointers
  to its persistent properties and override stacks, so that unchanged maps
  cost nothing;
- the states of the Rust translators that changed since the previous
  checkpoint (each state has a dirty bit, set by its methods);
- a mark in chapter 03's undo log for the Scheme heap, and a mark in the
  grob arena;
- a 64-bit digest of all of it, maintained as the state changes, per
  partition (§10.3) and for the shared level.

It also records, for each partition and timestep, the digests of the
events the partition received and of the property values it read from the
shared level, and the grobs it announced upward.

### 10.3 Partitions

The contexts of a score are split into **partitions** and a **shared
level**:

- a partition is a *line context* (one that makes a `VerticalAxisGroup`:
  Staff, RhythmicStaff, TabStaff, DrumStaff, Lyrics, ChordNames,
  FiguredBass, Dynamics, NoteNames, and custom ones such as T29's
  `MarkLine`) with everything below it;
- the shared level is the Score and the groups above line contexts
  (StaffGroup, PianoStaff, GrandStaff, ChoirStaff, and custom ones such as
  T29's `SquareStaff` and `Orchestra`);
- partitions are merged where contexts depend on each other: a Lyrics
  context with the voice of its `\lyricsto` or `associatedVoice`, two staves
  between which a voice moves with `\change Staff` (T11, T24–T27), and all of
  them when a score's own Scheme translators or `\applyContext` procedures
  might read other contexts. The `\applyContext` of the corpus is
  `ly:set-middle-C!` from `\clef` **[measured]**, which only touches its own
  context.

This is how §3's edits divide: T29's E2 changed one partition (the
trumpet's staff and voice) from the edit on, the shared level at 2
timesteps, and the other 24 partitions at the one timestep where the shared
level's end of the piece moved.

### 10.4 The run

1. Restore the last checkpoint at or before `m_e`.
2. Iterate globally from there, timestep by timestep (iteration is cheap:
   14 % of LilyPond's translation, §2.3).
3. At each timestep the shared level's translators run. A partition runs if
   it is already running, if the events it receives differ from those
   recorded, or if a property it reads from the shared level differs.
   Otherwise its recorded announcements are replayed to the shared level,
   reusing its grob records.
4. A partition that must start running at a timestep after the checkpoint
   is restored from its own checkpoint before that timestep and run forward
   on its recorded inputs: at most one checkpoint interval of catch-up.

### 10.5 Convergence

At each checkpoint after the last change in its input, a running partition
(or the shared level) whose state digest equals the old run's at the same
moment stops running: from there on its old output is valid. When nothing
runs any more and the iteration's input from there on is unchanged, the
translation stops and the old records from that moment on are spliced in.
A pitch edit (E1) converges at the next bar start, as §3 measured; a reflow
(E2) does not, in its own partition, and runs to the end there.

Correctness does not rest on the digests alone: every test of the module
compares an incremental translation with one from scratch, grob record by
grob record and event by event (N8 in §13).

### 10.6 What layout receives

A change list per score: the timesteps (columns) added and removed, and for
each timestep the partitions (lines) whose grobs were added, removed or
changed, with stable ids. Chapter 05 maps these to the systems to lay out
again. The old run's records stay valid until the new run completes, so a
cancelled run (B8) leaves the last complete result in place.

### 10.7 Work per edit

Projected onto the Android reference from §2.3 (a full translation costs
0.9 times LilyPond's desktop time) and §3 (which timesteps and contexts
re-run): **(a)** checkpoints and convergence for the whole score, without
partitions: the timesteps from the checkpoint before the edit to
convergence, in every context, counting for E1 the whole bar from its start
to the next one (§3 compared states only at bar starts, so a closer
checkpoint is not credited); **(b)** with partitions: those timesteps in
the edited partition and the shared level (their share of the score's
translators), plus the other partitions at the timesteps where the shared
level changed, with up to one checkpoint interval of catch-up each.

| Score | Full translation | E1 (a) | E1 (b) | E2 (a) | E2 (b) | E3 |
| --- | --- | --- | --- | --- | --- | --- |
| T02 | 10 ms | 3 of 19 timesteps: 1.6 ms | 58 % of the translators: 0.9 ms | 12 of 21: 5.7 ms | 3.5–5.1 ms | 0 |
| T12 | 45 ms | 4 of 137: 1.3 ms | one staff, as (a): 1.3 ms | 81 of 143: 26 ms | as (a): 26 ms | 0 |
| T24 | 152 ms | 16 of 208: 12 ms | 69 % (two staves merged by `\change Staff`): 8 ms | 113 of 209: 82 ms | 58–59 ms | 0 |
| T29 | 172 ms | 12 of 49: 42 ms | 9.6 %: 4 ms | 38 of 50: 131 ms | 16–41 ms | 0 |

Checkpoints and convergence alone suffice for the S scores and for pitch
edits; partitions are what bring a reflow in a large score (T29: 131 → 16–41
ms) under the budget of §12.

## 11. Memory

Estimated for T29, the largest score, from §2's counts:

| Part | Size | From |
| --- | --- | --- |
| Frozen music | 55 KB | 1,719 nodes × 32 bytes |
| Its side tables: starts and lengths, `extra` properties | ≤ 140 KB | 1,719 × 64 bytes, and the overrides' values and paths |
| Contexts and their properties | ≤ 30 KB | 66 contexts, few properties each (§2.2) |
| Translator states | ≤ 130 KB | 2,060 translators × ≤ 64 bytes |
| Iterators and events | ≤ 50 KB | ≤ 1,719 iterators × 16 bytes; 1,399 events × 16 bytes |
| Grob records, translation's part | ≤ 240 KB | 3,709 grobs × 64 bytes |
| Recorded inputs and announcements for replay | ≤ 100 KB | per partition and timestep |
| Checkpoints | ≤ 1.3 MB | ≤ 10 checkpoints × (states that changed + iterators); unchanged maps shared |
| **Total, one run** | **≤ 2 MB** | |
| Old and new run during an edit | ≤ 4 MB | §10.6 |

That is 3 % of B4's L Goal (64 MB); the engine's memory goes to the Scheme
heap (chapter 03: 16 MB Must after init), layout and the page.

## 12. Budgets

Proposed for step 11 to confirm; times are on chapter 00's Android
reference, and chapter 00's rule that E2 may take twice B6 applies to the
per-edit rows.

| What | Must | Goal | Now |
| --- | --- | --- | --- |
| Translation of a whole score (first render), S | 60 ms | 20 ms | 1.5–55 ms projected (§2.3) |
| Translation of a whole score, L | 250 ms | 100 ms | 32–172 ms projected |
| Translation per edit, S (E2: twice) | 25 ms | 8 ms | 0–1.6 ms for E1 and E3, 3.5–26 ms for E2 (§10.7) |
| Translation per edit, L (E2: twice) | 50 ms | 20 ms | (a) 0–42 ms for E1, 82–131 ms for E2; (b) 0–8 ms and 16–59 ms |
| Memory of music, translation and checkpoints, L | 8 MB | 4 MB | ≤ 4 MB estimated (§11) |
| Time between cancellation checks | one timestep | — | ≤ 3.5 ms a T29 timestep, projected |
| Code, uncompressed wasm: values, music, contexts, iterators, translator framework, checkpoints (engravers not included) | 450 KB | 300 KB | 8,000–10,000 lines of Rust, by LilyPond's M1–M4 and E6 (15,700 lines of C++); 340–430 KB at the 43 bytes a line of chapter 03's prototype (its 138 KB less 60 KB of Rust runtime, over 1,800 lines) |
| Same, brotli (share of B1) | 180 KB | 120 KB | — |

The per-edit budgets come from chapter 00's provisional 40 ms for Scheme
and music in an S edit (and twice that for L), less what Scheme in music
functions and grob callbacks needs. (a) meets every S row and L's E1; L's E2
needs (b).

## 13. The ordered steps

The order in which the music module should be built. *Iterable after it*
counts the scores whose music uses no iterator of a later step
**[measured]** (the music types of §2.1 per score); each step needs the
earlier ones and chapter 02's parser up to P5. A step's scores are checked
against the trace of Appendix A (per context and timestep, events and the
moments of C1) and, once performers exist, against C1 and C2 themselves.

| Step | What | LilyPond | Iterable after it |
| --- | --- | --- | --- |
| N1 | Values: rationals with checked arithmetic, moments, pitches, durations, scales, transposition; their `ly:` functions | M1: `pitch`, `duration`, `moment`, `scale`, `rational.cc` | — |
| N2 | Frozen music: the 131 types, nodes, side tables, digests; the Scheme face, thawing and freezing; lengths and starts; `\relative`, `\transpose` and the syntax constructors natively | M2, `define-music-types.scm`, `ly-syntax-constructors.scm`, `music-functions.scm`'s walkers | — |
| N3 | Contexts: definitions from output definitions with `\consists`, `\remove`, `\accepts`, `\alias`, `\defaultchild`, `\with`; instances; properties, override stacks, `\once`; creation and removal | M4: `context*`, `context-def`, `context-mod`, `context-property`, `nested-property`, `global-context` | — |
| N4 | Iteration core: the global loop; sequential (which also plays unfolded and tremolo repeats, `\partial`, `\time` and multi-measure rests, through their elements callbacks), simultaneous, event chord, event and rhythmic iterators, wrappers, context-specced and initial-context music, property operations, `\applyContext`, tuplets | M3: 13 of the 23 iterators | 15: T01, T03, T05, T06, T08, T13–T19, T21, T28, T29 |
| N5 | The translator framework: groups, listeners, acknowledgers, the timestep protocol with wake lists, `Timing_translator`, grob and audio records; Scheme translators; the playback map's performer, and the default Scheme engravers in Rust | M4: `translator*`, `engraver*`, `performer*`, `dispatcher`, `scheme-engraver`, `timing-translator`; `scheme-engravers.scm` | same 15, now with C1 |
| N6 | Grace notes and context changes: grace moments, `\change Staff` | `grace-iterator`, `change-iterator` | 22: + T09, T11, T12, T22, T25, T26, T27 |
| N7 | Volta repeats and lyrics: `\repeat volta` with alternatives and volta-specced music; `\lyricsto` and `\addlyrics` with the melisma properties of the slur, tie and beam engravers and performers | `volta-repeat-iterator`, `alternative-sequence-iterator`, `volta-specced-music-iterator`, `lyric-combine-music-iterator`; melisma in `context.cc` | 30: + T02, T04, T07, T10, T20, T23, T24, T30 |
| N8 | Incremental translation: checkpoints, digests, convergence, then partitions and replay, the change list; differential tests (incremental = from scratch) on chapter 00's edits and on random edits of the 30 scores | — | 30, timed per edit |

What the engravers make, E1–E6 of chapter 01, is chapter 05's ordered list;
N5 needs only the engravers that C1 and the playback map rely on, which are
none beyond `Timing_translator` and the melisma properties of N7. The other
four iterators, for the part combiner, quotes, percent repeats and `\fine`,
serve music no score reaches (chapter 01 §5) and come after N7 in any
order.

## 14. What later chapters take from here

| Chapter | Takes |
| --- | --- |
| 05 layout | grob records with stable ids and their property chains (§9.1); the change list of §10.6 per column and line; partitions as the unit of re-layout; that a pitch edit changes 1–2 timesteps of translation (§3), so its cost is layout's |
| 06 SVG, PDF, fonts | stable grob ids for caching output per grob |
| 07 MIDI | performers on the framework of §9; that a performance runs after the page (§9.3); the playback map's built-in performer; melisma properties for lyrics |
| 08 build | the module's code budget (§12); generated tables (music types, event classes, interfaces, properties) at build time; the default Scheme engravers in Rust; immediates for pitches and durations in chapter 03's value layout |
| 09 phone timings | in step 10's crate: frozen music, the global loop with sequential, simultaneous and event iterators, Staff and Voice with a few translators, one checkpoint and an E1 re-run; measure bytes per node, translation time per timestep, and checkpoint size and restore time against §11 and §12 |
| 11 roadmap, D56 | steps N1–N8, the budgets of §12, the choice between (a) and (b) of §10.7 for L scores |

## Appendix A: recipes

The LilyPond checkout and the test scores are those of chapters 00 and 01;
`corpus.tsv` lists `ID path` for the 30 scores. Every run is one compile
from the score's own directory with `c4.ly` as a settings file and
`-dno-print-pages`:

```sh
cd "$(dirname score.ly)" && C4_MODE=<census|time|trace> C4_OUT=<out>/<id>/c4.tsv LANGUAGE=en \
  lilypond --loglevel=ERROR -dno-print-pages -dinclude-settings=/abs/c4.ly -o <out>/<id>/<base> score.ly
```

§2.1 and §2.2 are one `census` run and three `time` runs per score, and
*Bars* the distinct moments of `S` lines in a `trace` run; T03 exits 1, as
it must, after its lines are written. §3 is a `trace` run of
each `edits/<id>-E<n>.ly`. Each of these runs writes TSV lines: `music`,
`type`, `prop`, `kind` (the music census), `timesteps`, `contexts`,
`translators`, `events`, `grobs`, `translate-ms` per pass, `book-ms`; in
`trace` mode `P` (a pass), `E`, `G` and `S`.

`c4.ly`:

```lilypond
%% Chapter 04's settings file. C4_MODE selects what it records, C4_OUT where:
%%   census  the music trees as parsed, and the translation of each score
%%           (timesteps, contexts, translators, events, grobs) for \layout and \midi
%%   time    translation time only: Score-level hooks at initialize and finalize
%%   trace   one line per event heard by a context and per grob announced, with
%%           the moment and the context, and a digest of every context's
%%           properties at each bar start: for diffing two compiles
#(begin
  (use-modules (ice-9 format))
  (define c4-mode (string->symbol (or (getenv "C4_MODE") "census")))
  (define c4-port (open-file (or (getenv "C4_OUT") "c4.out") "a"))
  (define (c4-line . xs)
    (display (string-join (map (lambda (x) (if (string? x) x (format #f "~a" x))) xs) "\t") c4-port)
    (newline c4-port))
  (define (c4-now) (get-internal-real-time))
  (define (c4-ms t0 t1) (/ (exact->inexact (- t1 t0)) (/ internal-time-units-per-second 1000)))
  (define c4-pass 0)
  (define (c4-count! table key n) (hash-set! table key (+ n (hash-ref table key 0))))
  (define (c4-dump! section table)
    (hash-for-each (lambda (k v) (c4-line section k v)) table))

  ;; --- the music trees, as the book handler receives them -------------------
  (define c4-music (make-hash-table))   ; counters
  (define c4-types (make-hash-table))   ; music type -> nodes
  (define c4-props (make-hash-table))   ; property name -> nodes having it
  (define c4-kinds (make-hash-table))   ; kind of a property value -> count
  (define c4-origins (make-hash-table)) ; (type . location) of every node seen
  (define (c4-kind v)
    (cond ((ly:music? v) 'music) ((ly:duration? v) 'duration) ((ly:pitch? v) 'pitch)
          ((ly:moment? v) 'moment) ((ly:input-location? v) 'origin) ((boolean? v) 'boolean)
          ((exact-integer? v) 'integer) ((number? v) 'number) ((symbol? v) 'symbol)
          ((string? v) 'string) ((procedure? v) 'procedure) ((null? v) 'empty)
          ((and (pair? v) (ly:music? (car v))) 'music-list)
          ((markup? v) 'markup)
          ((and (list? v) (every symbol? v)) 'symbol-list)
          ((pair? v) 'other-pair) (else 'other)))
  (define (c4-walk-music! m depth seen)
    (c4-count! c4-music 'references 1)
    (if (hashq-ref seen m)
        (c4-count! c4-music 'shared-references 1)
        (let ((props (ly:music-mutable-properties m)))
          (hashq-set! seen m #t)
          (c4-count! c4-music 'nodes 1)
          (when (memq 'event (ly:music-property m 'types)) (c4-count! c4-music 'event-nodes 1))
          (when (memq 'rhythmic-event (ly:music-property m 'types)) (c4-count! c4-music 'rhythmic-nodes 1))
          (hash-set! c4-music 'max-depth (max depth (hash-ref c4-music 'max-depth 0)))
          (c4-count! c4-types (ly:music-property m 'name) 1)
          ;; A node made from the same source text as an earlier one is a copy:
          ;; LilyPond copies a variable's music wherever it is referenced.
          (let ((origin (ly:music-property m 'origin #f)))
            (when (ly:input-location? origin)
              (let ((key (cons (ly:music-property m 'name) (ly:input-file-line-char-column origin))))
                (if (hash-ref c4-origins key)
                    (c4-count! c4-music 'copied-nodes 1)
                    (hash-set! c4-origins key #t)))))
          (c4-count! c4-music 'properties (length props))
          (for-each
           (lambda (p)
             (let ((v (cdr p)))
               (c4-count! c4-props (car p) 1)
               (c4-count! c4-kinds (c4-kind v) 1)
               (cond ((ly:music? v) (c4-walk-music! v (1+ depth) seen))
                     ((and (pair? v) (list? v) (ly:music? (car v)))
                      (for-each (lambda (x) (when (ly:music? x) (c4-walk-music! x (1+ depth) seen))) v)))))
           props))))
  (define (c4-book! book)
    (for-each (lambda (s)
                (when (ly:score? s)
                  (c4-count! c4-music 'scores 1)
                  (c4-walk-music! (ly:score-music s) 1 (make-hash-table))))
              (ly:book-scores book))
    (for-each c4-book! (ly:book-book-parts book)))
  ;; Every score gets a \midi performance, as in chapter 00's capture.
  (define (c4-add-midi! score)
    (let ((defs (ly:score-output-defs score)))
      (unless (any (lambda (def) (eq? (ly:output-def-lookup def 'output-def-kind #f) 'midi)) defs)
        (when (null? defs) (ly:score-add-output-def! score (ly:output-def-clone $defaultlayout)))
        (ly:score-add-output-def! score (ly:output-def-clone $defaultmidi)))))
  (define (c4-add-midis! book)
    (for-each (lambda (s) (when (ly:score? s) (c4-add-midi! s))) (ly:book-scores book))
    (for-each c4-add-midis! (ly:book-book-parts book)))
  (define c4-book-handler toplevel-book-handler)
  (set! toplevel-book-handler
        (lambda (book)
          (c4-add-midis! book)
          (when (eq? c4-mode 'census) (c4-book! book))
          (let ((t0 (c4-now)))
            (c4-book-handler book)
            (c4-line "book-ms" "all" (c4-ms t0 (c4-now))))
          (when (eq? c4-mode 'census)
            (c4-dump! "music" c4-music) (c4-dump! "type" c4-types)
            (c4-dump! "prop" c4-props) (c4-dump! "kind" c4-kinds))
          (force-output c4-port)))

  ;; --- digests for the trace ------------------------------------------------
  (define c4-labels (make-hash-table))
  (define c4-label-counts (make-hash-table))
  (define (c4-label ctx)
    (or (hashq-ref c4-labels ctx)
        (let* ((name (ly:context-name ctx))
               (n (hashq-ref c4-label-counts name 0))
               (id (ly:context-id ctx))
               (l (format #f "~a#~a~a" name n (if (and (string? id) (not (string-null? id))) (string-append "=" id) ""))))
          (hashq-set! c4-label-counts name (1+ n))
          (hashq-set! c4-labels ctx l)
          l)))
  (define (c4-digest v depth)
    (cond ((> depth 4) "…")
          ((ly:grob? v) (format #f "<~a>" (grob::name v)))
          ((ly:context? v) (format #f "<~a>" (c4-label v)))
          ((ly:stream-event? v) (format #f "<ev ~a>" (car (ly:event-property v 'class))))
          ((ly:music? v) (format #f "<m ~a>" (ly:music-property v 'name)))
          ((ly:input-location? v) "<loc>")
          ((procedure? v) "<p>")
          ((ly:grob-array? v) (format #f "<ga ~a>" (ly:grob-array-length v)))
          ((pair? v) (string-append "(" (c4-digest (car v) (1+ depth)) " . " (c4-digest (cdr v) (1+ depth)) ")"))
          ((vector? v) (c4-digest (vector->list v) depth))
          ((hash-table? v) "<hash>")
          ((or (number? v) (symbol? v) (boolean? v) (char? v) (keyword? v) (null? v)
               (ly:moment? v) (ly:pitch? v) (ly:duration? v))
           (format #f "~a" v))
          ((string? v) (if (> (string-length v) 80) (number->string (string-hash v)) v))
          (else "<other>")))
  (define (c4-event-digest ev)
    (let ((cls (car (ly:event-property ev 'class))))
      (string-join
       (map (lambda (key) (c4-digest (ly:event-property ev key '()) 0))
            (case cls
              ((SetProperty UnsetProperty) '(symbol value once))
              ((Override Revert) '(symbol property-path value once))
              ((CreateContext) '(type id))
              ((ChangeParent) '(context))
              (else '(pitch duration drum-type text span-direction articulation-type tremolo-type alteration figure))))
       " ")))
  (define c4-score #f) ; the moment is the Score's: a context may be gone when an event reaches it
  ;; An engraver hears the events of its context and of the contexts below it:
  ;; an event is the deepest hearer's, written when the timestep ends.
  (define c4-heard (make-hash-table))
  (define c4-heard-order '())
  (define (c4-depth ctx) (let loop ((c ctx) (n 0)) (if c (loop (ly:context-parent c) (1+ n)) n)))
  (define (c4-event-line ctx ev)
    (let ((old (hashq-ref c4-heard ev)))
      (unless old (set! c4-heard-order (cons ev c4-heard-order)))
      (when (or (not old) (> (c4-depth ctx) (c4-depth old)))
        (hashq-set! c4-heard ev ctx))))
  (define (c4-flush-events!)
    (let ((now (ly:context-current-moment c4-score)))
      (for-each (lambda (ev)
                  (c4-line "E" (ly:moment-main now) (ly:moment-grace now) (c4-label (hashq-ref c4-heard ev))
                           (car (ly:event-property ev 'class)) (c4-event-digest ev)))
                (reverse c4-heard-order))
      (set! c4-heard-order '())
      (hash-clear! c4-heard)))
  ;; Events are heard by an engraver in every context: listeners added to a
  ;; context's event source by hand outlive the context and crash LilyPond.
  (define (c4-context-recorder context)
    (make-engraver
     ((initialize engraver) (c4-label context))
     (listeners
      ((music-event engraver event) (c4-event-line context event))
      ((SetProperty engraver event) (c4-event-line context event))
      ((UnsetProperty engraver event) (c4-event-line context event))
      ((Override engraver event) (c4-event-line context event))
      ((Revert engraver event) (c4-event-line context event)))))
  (when (eq? c4-mode 'trace)
    (for-each
     (lambda (entry)
       (let ((def (cdr entry)))
         (when (ly:context-def? def)
           (ly:output-def-set-variable!
            $defaultlayout (car entry)
            (ly:context-def-modify def (ly:make-context-mod (list (list 'consists c4-context-recorder))))))))
     (ly:module->alist (ly:output-def-scope $defaultlayout))))
  (define (c4-contexts ctx)
    (cons ctx (append-map c4-contexts (ly:context-children ctx))))
  (define c4-state-properties
    (filter (lambda (s) (not (memq s '(currentCommandColumn currentMusicalColumn currentBarLine
                                       busyGrobs stavesFound breakableSeparationItem
                                       hasStaffSpacing measureStartNow rootSystem
                                       lastChord))))
            all-translation-properties))
  (define (c4-state! score)
    (for-each
     (lambda (ctx)
       (let ((now (ly:context-current-moment ctx)))
         (c4-line "S" (ly:moment-main now) (ly:moment-grace now) (c4-label ctx)
                  (string-hash
                   (string-join (map (lambda (s) (c4-digest (ly:context-property ctx s '()) 0))
                                     c4-state-properties) "|")))))
     (c4-contexts score)))

  ;; --- the Score-level recorders --------------------------------------------
  (define (c4-recorder kind)
    (lambda (context)
      ;; The Score is made during the first timestep, after that timestep started.
      (let ((t0 0) (steps 1)
            (events (make-hash-table)) (grobs (make-hash-table))
            (made (make-hash-table)) (consists 0) (live-max 0))
        (define (seen-context! ctx)
          (unless (hashq-ref made ctx)
            (hashq-set! made ctx #t)
            (let* ((def (ly:output-def-lookup (ly:context-output-def ctx) (ly:context-name ctx) #f)))
              (when (ly:context-def? def)
                (set! consists (+ consists (length (ly:context-def-lookup def 'consists))))))))
        (make-translator
         ((initialize translator)
          (set! c4-pass (1+ c4-pass))
          (set! t0 (c4-now))
          (case c4-mode
            ((census)
             (seen-context! context)
             (ly:add-listener
              (lambda (ev)
                (c4-count! events (car (ly:event-property ev 'class)) 1))
              (ly:context-events-below context) 'StreamEvent)
             (ly:add-listener
              (lambda (ev) (seen-context! (ly:event-property ev 'context)))
              (ly:context-events-below context) 'AnnounceNewContext))
            ((trace)
             (c4-line "P" c4-pass kind)
             (set! c4-score context))))
         ((start-translation-timestep translator)
          (set! steps (1+ steps)))
         (acknowledgers
          ((grob-interface translator grob source)
           (case c4-mode
             ((census) (c4-count! grobs (grob::name grob) 1))
             ((trace)
              (let ((now (ly:context-current-moment context))
                    (cause (ly:grob-property grob 'cause #f)))
                (c4-line "G" (ly:moment-main now) (ly:moment-grace now)
                         (c4-label (ly:translator-context source)) (grob::name grob)
                         (if (ly:stream-event? cause) (c4-event-digest cause) "")))))))
         ((stop-translation-timestep translator)
          (case c4-mode
            ((census)
             (let ((live (c4-contexts context)))
               (set! live-max (max live-max (length live)))))
            ((trace)
             (c4-flush-events!)
             (let ((pos (ly:context-property context 'measurePosition #f)))
               (when (and (ly:moment? pos) (zero? (ly:moment-main pos)) (zero? (ly:moment-grace pos)))
                 (c4-state! context))))))
         ((finalize translator)
          (let ((ms (c4-ms t0 (c4-now))))
            (c4-line "translate-ms" kind ms)
            (c4-line "pass" kind c4-pass)
            (c4-line "timesteps" kind steps)
            (when (eq? c4-mode 'census)
              (c4-line "contexts" kind (hash-count (const #t) made))
              (c4-line "live-max" kind live-max)
              (c4-line "translators" kind consists)
              (c4-line "events" kind (hash-fold (lambda (k v a) (+ v a)) 0 events))
              (c4-line "grobs" kind (hash-fold (lambda (k v a) (+ v a)) 0 grobs))
              (hash-for-each (lambda (k v) (c4-line (format #f "ev-~a" kind) k v)) events)
              (hash-for-each (lambda (k v) (c4-line "grob" k v)) grobs))
            (force-output c4-port))))))))

\layout { \context { \Score \consists #(c4-recorder 'layout) } }
\midi { \context { \Score \consists #(c4-recorder 'midi) } }
```

Two things the trace mode had to avoid, which a port of it to our engine's
test harness should know: a listener added by hand to a context's event
source with `ly:add-listener` outlives the context and crashes LilyPond at
the end of the translation (hence an engraver in every context), and Guile's
`procedure-name` on the procedures held in some context properties
(`chordRootNamer`) is slow enough to stall a trace (hence `<p>`).

`edits.mjs` writes the edits of §3: for each of T02, T12, T24 and T29 it
reads chapter 00's capture (`<capture>/<id>/*.timing.json`), takes the first
performance's middle event, or the first after it whose source text matches
`^([a-h])(?![a-z])([',]*)(\d*\.*)`, locates it from its link's line and
character, and writes `<id>-E0.ly` (unedited), `-E1` (the letter one step up,
`a`→`h` and `h`→`c` with `deutsch.ly`), `-E2` (the note's token, or its
whole chord with the chord's duration, and a space, inserted before it) and
`-E3` (an `x` before the closing quote of the first string after the first
`\header`).

`diff.mjs <old c4.tsv> <new c4.tsv>` keeps the lines of the first pass,
groups `E` and `G` lines by moment and context, and counts the timesteps and
the (timestep, context) pairs whose sorted lines differ, the contexts with a
difference, and the bar starts at which any context's `S` digest differs:

```js
import { readFileSync } from 'node:fs'
const frac = (s) => { const [n, d] = s.split('/'); return d ? +n / +d : +n }
function read(file) {
  const steps = new Map(), states = new Map(); let pass = 0
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const f = line.split('\t')
    if (f[0] === 'P') { pass++; continue }
    if (pass !== 1 || !'EGS'.includes(f[0]) || f.length < 4) continue
    const key = `${f[1]}|${f[2]}`, into = f[0] === 'S' ? states : steps
    if (!into.has(key)) into.set(key, new Map())
    const m = into.get(key)
    if (f[0] === 'S') m.set(f[3], f[4])
    else { if (!m.has(f[3])) m.set(f[3], []); m.get(f[3]).push(f.slice(4).join('\t') + '\t' + f[0]) }
  }
  return { steps, states }
}
const a = read(process.argv[2]), b = read(process.argv[3])
const cmp = (x, y) => { const [p, q] = [x, y].map((k) => k.split('|').map(frac)); return p[0] - q[0] || p[1] - q[1] }
const keys = [...new Set([...a.steps.keys(), ...b.steps.keys()])].sort(cmp)
let stepsChanged = 0, pairsChanged = 0, pairs = 0, first = null, last = null; const contexts = new Set()
for (const k of keys) {
  const x = a.steps.get(k) ?? new Map(), y = b.steps.get(k) ?? new Map(); let any = false
  for (const c of new Set([...x.keys(), ...y.keys()])) {
    pairs++
    if ((x.get(c) ?? []).slice().sort().join('\n') !== (y.get(c) ?? []).slice().sort().join('\n')) { any = true; pairsChanged++; contexts.add(c) }
  }
  if (any) { stepsChanged++; first ??= k; last = k }
}
const bars = [...new Set([...a.states.keys(), ...b.states.keys()])].sort(cmp)
const barsChanged = bars.filter((k) => {
  const x = a.states.get(k) ?? new Map(), y = b.states.get(k) ?? new Map()
  return [...new Set([...x.keys(), ...y.keys()])].some((c) => x.get(c) !== y.get(c))
}).length
console.log(JSON.stringify({ steps: [a.steps.size, b.steps.size], first, last, stepsChanged,
  pairsChanged: `${pairsChanged}/${pairs}`, contextsChanged: contexts.size, barsChanged: `${barsChanged}/${bars.length}` }))
```

**Profile** (§2.3). The compile includes the score several times, so that
translation runs for seconds; `sample` attaches a second after it starts:

```sh
cd "$(dirname orchestra.ly)" && for i in $(seq 12); do echo '\include "orchestra.ly"'; done > prof12.ly
LANGUAGE=en lilypond --loglevel=ERROR -dno-print-pages -o /tmp/p12 prof12.ly &
sleep 1.2; sample $(pgrep -n lilypond) 6 1 -mayDie -file t29.txt
```

`prof2.py t29.txt` reads the call graph, keeps the frames below
`Global_context::iterate`, and counts each frame's self samples (its count
less its children's) by library, `sigprocmask`, `__sigaltstack` and
`setjmp` apart, and by the outermost of `precomputed_translator_foreach`,
`Engraver_dispatch_list::apply`, the iterators' `process` and context
creation and removal on its stack:

```python
import re, sys
from collections import Counter
lines = open(sys.argv[1]).read().split('\n')
start = next(i for i, l in enumerate(lines) if l.startswith('Call graph:'))
pat = re.compile(r'^([ +!:|]*)(\d+) (.+?)  \(in ([^)]+)\)')
nodes = []
for l in lines[start + 1:]:
    if not l.strip() or l.startswith('Total number'): break
    m = pat.match(l)
    if m: nodes.append((len(m.group(1)), int(m.group(2)), m.group(3).split('(')[0], m.group(4)))
parts = [('translator methods per timestep', 'Translator_group::precomputed_translator_foreach'),
         ('acknowledgers', 'Engraver_dispatch_list::apply'),
         ('iterators', 'Music_iterator::process|_iterator::process|Sequential_iterator|Simultaneous_music_iterator'),
         ('context creation and removal', 'Context::create_context|Context::check_removal|Context::create_context_from_event')]
total = 0; selfk = Counter(); incl = Counter(); stack = []
for i, (d, c, f, lib) in enumerate(nodes):
    while stack and stack[-1][0] >= d: stack.pop()
    stack.append((d, f)); names = [s[1] for s in stack]
    roots = sum(1 for n in names if n.startswith('Global_context::iterate'))
    if roots == 0: continue
    if f.startswith('Global_context::iterate') and roots == 1: total += c
    kids = 0; j = i + 1
    while j < len(nodes) and nodes[j][0] > d:
        if nodes[j][0] == min(n[0] for n in nodes[i + 1:j + 1]): kids += nodes[j][1]
        j += 1
    s = c - kids
    if s <= 0: continue
    if f in ('sigprocmask', '__sigaltstack', 'setjmp', '_setjmp', 'sigsetjmp'): k = 'setjmp signal-mask syscalls'
    elif 'libgc' in lib or f.startswith('GC_'): k = 'garbage collector'
    elif 'libguile' in lib: k = 'Guile runtime and VM'
    elif lib == 'lilypond': k = "LilyPond's C++"
    else: k = 'other'
    selfk[k] += s
    for name, rx in parts:
        if any(re.search(rx, n) for n in names): incl[name] += s; break
print('total', total)
for k, v in selfk.most_common(): print(f'{v:6} {100 * v / total:5.1f}%  {k}')
for k, v in incl.most_common(): print(f'{v:6} {100 * v / total:5.1f}%  {k}')
```

The other figures: the translators each default context consists of are
`(length (ly:context-def-lookup (ly:output-def-lookup $defaultlayout 'Voice)
'consists))` and so on, and their property operations the same with
`'property-ops`; the procedures of the corpus's `ApplyContext` music are
`(procedure-name (ly:music-property m 'procedure))` over the music walked
as in `c4-walk-music!`; the iterator features each score needs (§13) are
the music types of its census and the iterator each type names in
`define-music-types.scm` (unfolded and tremolo repeats use the sequential
iterator).
