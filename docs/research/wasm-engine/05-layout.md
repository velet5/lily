# 05 — A layout engine that stays fast on phone CPUs

Chapter 05 of the investigation into an engine of our own (chapter 00 sets
the budgets and the test set, chapter 01 maps LilyPond's source, chapters
02–04 design the parser, the Scheme interpreter and the music model). It
measures what LilyPond's layout costs on the 30 scores of chapter 00 and
where that time goes (§2), tries LilyPond's own switches for cheaper beams,
slurs, skylines and page breaking against the comparator (§2.4), measures
what each edit of chapter 00 §6.2 changes on the page (§3), and designs
spacing, line and page breaking, beams, slurs, ties, collisions and
skylines (§5), re-layout of only the parts an edit changes (§6), and a
time limit per edit (§7). It records no decision; D56 (step 11) will.

Everything refers to LilyPond at tag `v2.26.0` (commit
`3596756be0fac1f81066a99d2054329212172b2d`). **[measured]** marks what was
taken on 2026-10-03 on the M1 Max of chapter 00 with `GNU LilyPond 2.26.0
(running Guile 3.0)` of Homebrew, its time tracer (`-dtime-trace-file`) and
macOS's `sample`; the recipes are in Appendix A. Projections onto the phones
use chapter 00's factors (× 1/0.45 for the Android reference's CPU, × 1.5
for wasm) until step 10 measures.

## 1. How LilyPond lays out a score

What chapter 01 calls families L1–L5 and E1–E4, as a compile runs them. The
names in quotes are the phases of LilyPond's time tracer (§2.1).

- **Grobs and their properties** (L1). Engravers make grobs during
  translation (chapter 04 §9). A grob's property is looked up in the values
  set on it, then in the `\override` stack it was made with, then in
  `define-grobs.scm`'s defaults; a value that is a procedure is a
  *callback*, called on first read and cached. Most of layout is such
  callbacks, C++ ones (`MAKE_SCHEME_CALLBACK`) and Scheme ones from
  `output-lib.scm` and `bar-line.scm`, all called through Guile. A callback
  that must answer before the line breaks are known (a height for spacing
  staves) has a *pure* variant, kept beside the *unpure* one in an
  `unpure-pure-container`.
- **"Break items", "Handle dependencies", "Fix up refpoints",
  "before-line-breaking"** (`system.cc`, `paper-score.cc`): items at a
  possible break get their prebroken copies (before and after the break),
  and each grob's `before-line-breaking` callback runs.
- **"springs-and-rods"** (L3): the `SpacingSpanner` (`spacing-spanner.cc`,
  `spacing-basic.cc`, `note-spacing.cc`, `staff-spacing.cc`) puts a *spring*
  between neighbouring columns, its length from the shortest note playing
  there and optical corrections (stem directions, accidentals), and the
  `Separation_item`s put *rods* (minimum distances) between columns from
  their horizontal skylines. This is where every glyph's extent is first
  needed, so fonts load here.
- **"page-breaking"** (L3, L4, L5): `ly:optimal-breaking`
  (`optimal-page-breaking.cc` on `page-breaking.cc`) does all of the rest:
  - line breaking by `Constrained_breaking`, a dynamic program over the
    breakpoints (bar lines, unless forbidden) that asks `Simple_spacer` for
    the force of every candidate line `(i, j)`, stopping a row when a line
    gets too long, and keeps for each breakpoint and number of systems the
    best predecessor;
  - page breaking, which tries numbers of systems and pages around the ideal
    one and spaces each candidate with `Page_spacer`, a dynamic program over
    systems whose heights are pure estimates;
  - `System::break_into_pieces` for the chosen breaks: spanners are copied
    per system and every grob link is rewritten to the broken copies
    (`break-substitution.cc`);
  - then the stencils of every system, which calls the unpure callbacks:
    stems, beams (`Beam_scoring_problem`: up to 16 × 16 candidate end
    positions, 32 × 32 for a knee or collisions and 48 × 48 for both,
    scored best-first in a priority queue, cheap scorers before expensive
    ones),
    slurs (`Slur_score_state`: end points on a half-space grid within
    `region-size` = 4 staff spaces of a base attachment, about 80 Béziers,
    also best-first), ties (`Tie_formatting_problem`), dots, accidentals and
    note collisions;
  - vertical skylines of every grob (`stencil-integral.cc` turns a stencil's
    outline into boxes, `skyline.cc` merges them into *buildings*), the
    placement of outside-staff objects (`axis-group-interface.cc`: by
    priority, left to right in passes, each grob raised until it clears the
    staff and every skyline already placed), staff distances in a system
    (`align-interface.cc`), and systems and titles on each page
    (`page-layout-problem.cc`, springs and rods again, vertically).
- **"output-stencils"**: chapter 06's.

## 2. What layout costs on the test set

### 2.1 Time per phase

**[measured]**: each score compiled as the user does (`--svg
-dpoint-and-click`, no glyph cache) with LilyPond's time tracer, median of
three runs, in ms. *Layout* is "springs-and-rods", the small phases before
it and "page-breaking": everything between translation and writing pages.
The census (`c5.ly` in Appendix A, after page breaking) counts the pages,
the systems, the columns that were spaced, the most columns in one system,
the live grobs (a grob that suicided is not counted) and how many of them
may be placed outside the staff (they have `outside-staff-interface`).

| ID | Translate | Springs and rods | Page breaking | Layout | Pages | Systems | Columns | Most in a system | Live grobs | Most in a system | Outside-staff |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T01 | 2.6 | 9.0 | 3.5 | 12.5 | 1 | 1 | 9 | 9 | 60 | 60 | 0 |
| T02 | 11.0 | 26.2 | 18.2 | 44.6 | 2 | 3 | 29 | 14 | 332 | 153 | 3 |
| T03 | 3.7 | 9.9 | 3.4 | 13.4 | 1 | 1 | 12 | 12 | 74 | 74 | 0 |
| T04 | 30.7 | 43.2 | 8.3 | 51.5 | 1 | 1 | 33 | 33 | 429 | 429 | 5 |
| T05 | 14.2 | 29.7 | 11.8 | 41.5 | 1 | 2 | 58 | 33 | 502 | 289 | 29 |
| T06 | 5.0 | 30.5 | 2.8 | 33.4 | 1 | 1 | 14 | 14 | 162 | 162 | 0 |
| T07 | 29.1 | 28.3 | 9.8 | 38.1 | 1 | 1 | 43 | 43 | 552 | 552 | 19 |
| T08 | 11.2 | 11.7 | 16.4 | 28.2 | 1 | 1 | 39 | 39 | 268 | 268 | 28 |
| T09 | 7.8 | 35.9 | 6.9 | 42.9 | 1 | 1 | 25 | 25 | 187 | 187 | 4 |
| T10 | 4.7 | 12.6 | 4.8 | 17.4 | 1 | 1 | 20 | 20 | 121 | 121 | 5 |
| T11 | 10.4 | 11.6 | 18.4 | 30.1 | 1 | 1 | 28 | 28 | 198 | 198 | 0 |
| T12 | 46.9 | 44.4 | 31.2 | 75.7 | 1 | 5 | 159 | 35 | 1,115 | 264 | 40 |
| T13 | 2.1 | 22.4 | 2.7 | 25.1 | 1 | 1 | 7 | 7 | 45 | 45 | 2 |
| T14 | 1.6 | 6.8 | 3.5 | 10.3 | 1 | 1 | 5 | 5 | 32 | 32 | 0 |
| T15 | 14.3 | 8.5 | 1.7 | 10.2 | 1 | 1 | 7 | 7 | 49 | 49 | 4 |
| T16 | 2.1 | 6.9 | 3.2 | 10.2 | 1 | 1 | 6 | 6 | 43 | 43 | 0 |
| T17 | 13.4 | 26.5 | 15.3 | 42.0 | 2 | 4 | 54 | 26 | 351 | 161 | 5 |
| T18 | 5.2 | 12.7 | 4.0 | 16.7 | 1 | 1 | 21 | 21 | 143 | 143 | 13 |
| T19 | 3.2 | 9.6 | 3.7 | 13.3 | 1 | 1 | 13 | 13 | 90 | 90 | 0 |
| T20 | 4.4 | 19.5 | 5.8 | 25.3 | 1 | 2 | 14 | 10 | 169 | 117 | 1 |
| T21 | 7.2 | 12.9 | 16.7 | 29.6 | 1 | 1 | 18 | 18 | 153 | 153 | 0 |
| T22 | 55.6 | 25.9 | 10.1 | 36.0 | 1 | 1 | 30 | 30 | 488 | 488 | 32 |
| T23 | 43.3 | 23.0 | 47.8 | 70.8 | 1 | 2 | 53 | 30 | 727 | 404 | 13 |
| T24 | 165.1 | 68.8 | 98.3 | 167.2 | 2 | 6 | 226 | 52 | 3,419 | 793 | 15 |
| T25 | 45.7 | 38.5 | 22.3 | 60.8 | 1 | 1 | 52 | 52 | 704 | 704 | 20 |
| T26 | 39.3 | 16.2 | 13.1 | 29.3 | 1 | 1 | 27 | 27 | 408 | 408 | 67 |
| T27 | 33.3 | 16.6 | 14.8 | 31.3 | 1 | 1 | 17 | 17 | 396 | 396 | 32 |
| T28 | 48.9 | 50.2 | 31.2 | 81.4 | 1 | 1 | 62 | 62 | 1,061 | 1,061 | 93 |
| T29 | 197.5 | 123.2 | 52.8 | 176.0 | 1 | 1 | 54 | 54 | 3,175 | 3,175 | 321 |
| T30 | 88.6 | 35.4 | 39.6 | 75.1 | 1 | 2 | 104 | 63 | 1,763 | 1,100 | 15 |
| **All** | 948 | 817 | 522 | 1,340 | 33 | 48 | 1,239 | | 17,216 | | 766 |

What it says:

- **Layout costs more than translation**: 1,340 ms against 948 ms over the
  corpus, and as much as translation in the largest scores (T24 167 ms
  against 165, T29 176 against 198).
- **Layout time is a fixed part plus a cost per grob**: a least-squares fit
  over the 30 scores gives 18 ms + 46.5 µs per live grob (R² 0.94). The
  fixed part is LilyPond loading fonts and Pango the first time a glyph's
  extent is asked for (T13, 45 grobs, spends 22 ms in springs and rods); the
  engine pays it once at start-up, in chapter 03's image and chapter 06's
  font tables. What remains is per grob.
- **The corpus is mostly single systems**: 21 of the 30 scores are one
  system on one page; T24 is the most broken (6 systems on 2 pages) and T12
  has 5. No system has more than 63 columns. Line and page breaking on long
  scores is therefore measured on a generated score as well (§2.3).
- **Few grobs are placed outside the staff** except in T29 (321: dynamics,
  scripts and instrument switches over 25 staves), T28 (93) and T26 (67).

### 2.2 Where layout time goes

**[measured]** with macOS's `sample` at 1 ms intervals on a compile that
includes the score several times (T02 and T12 twenty times, T24 and T29
eight, T30 ten; S256 is the 256-bar score of §2.3, once), with
`-dno-print-pages`. A sample counts if its stack is below
`Paper_score::process` or `Paper_book::pages` and not below translation.
It is attributed to the innermost LilyPond function on the stack that names
an algorithm (Appendix A, `prof5.py`); a sample whose stack names none is
counted with the phase it is in: springs and rods (added to horizontal
spacing), line splitting, or page breaking.

| Share of layout samples | T02 (321) | T12 (670) | T24 (692) | T29 (1,077) | T30 (328) | S256 (753) |
| --- | --- | --- | --- | --- | --- | --- |
| Skylines | 14.6 % | 13.4 % | 20.4 % | 27.6 % | 17.1 % | 18.5 % |
| Outside-staff and side positions | 4.4 % | 11.0 % | 16.0 % | 18.8 % | 18.9 % | 11.2 % |
| Beams | — | 5.8 % | 17.1 % | 2.7 % | 12.2 % | 14.7 % |
| Slurs | — | 10.4 % | — | 1.7 % | — | 2.3 % |
| Ties | — | 0.3 % | 0.4 % | 0.1 % | 0.3 % | — |
| Stems and flags | 0.3 % | 3.4 % | 4.6 % | 2.4 % | 7.6 % | 3.5 % |
| Accidentals, dots, note collisions | — | 0.9 % | 0.9 % | 1.1 % | 0.3 % | 0.8 % |
| Horizontal spacing (springs and rods) | 6.9 % | 12.5 % | 10.4 % | 11.0 % | 12.2 % | 13.4 % |
| Line breaking (`Constrained_breaking`, `Simple_spacer`) | 5.3 % | 1.5 % | 0.4 % | 0.1 % | 0.6 % | 2.3 % |
| Line splitting (`break_into_pieces`, break substitution) | 5.9 % | 6.0 % | 3.0 % | 0.6 % | 0.9 % | 7.6 % |
| Staff and system alignment | 1.6 % | 5.5 % | 10.3 % | 7.1 % | 10.4 % | 8.1 % |
| Page breaking and page spacing | 47.0 % | 24.2 % | 8.3 % | 12.6 % | 10.4 % | 10.3 % |
| Fonts and text | 14.0 % | 4.9 % | 8.1 % | 14.2 % | 9.1 % | 7.4 % |

| What the sampled frame itself is | T02 | T12 | T24 | T29 | T30 | S256 |
| --- | --- | --- | --- | --- | --- | --- |
| LilyPond's C++ | 25.2 % | 27.6 % | 22.1 % | 20.6 % | 25.6 % | 26.2 % |
| Guile runtime and VM | 14.3 % | 18.1 % | 19.7 % | 20.4 % | 24.1 % | 21.0 % |
| Other: C++ runtime, `libm`, allocation, copying | 32.4 % | 31.0 % | 30.2 % | 26.5 % | 28.0 % | 29.2 % |
| Garbage collector | 20.2 % | 12.8 % | 15.5 % | 18.5 % | 3.0 % | 13.4 % |
| `sigprocmask` and `__sigaltstack` called by `setjmp` | 4.4 % | 8.7 % | 10.4 % | 8.9 % | 15.5 % | 7.2 % |
| Text libraries (Pango, FreeType, HarfBuzz) | 3.4 % | 1.8 % | 2.2 % | 5.1 % | 3.7 % | 3.1 % |

What it says:

- **No algorithm dominates.** Skylines and outside-staff placement are the
  largest shares together (19–46 %); beams reach 17 % in T24 (131 beams),
  slurs 10 % only in T12, which is LilyPond's slur-scoring test. The
  searches chapter 01 flagged as costly (`beam-quanting.cc`,
  `slur-scoring.cc`, `tie-formatting-problem.cc`) are 0–18 % together.
- **Line breaking is cheap**: at most 5 % (T02, three systems), and 2.3 % of
  the 256-bar score with 64 systems. The dynamic program and the line
  forces are not where the time goes; laying out the chosen systems is.
- **Skylines are built more than they are used**: of the samples in
  skylines, building them from stencils (`stencil-integral.cc`, outlines
  turned into boxes) is 37 % in T29, T24 and S256 and 59 % in T12; merging,
  distances and shifts are the rest.
- **Page breaking in small scores is mostly variable lookups**: of T02's 150
  page-breaking samples, 68 are `Output_def::c_variable` and
  `read_spacing_spec` reading `\paper` variables and spacing alists again
  for every page force `Page_spacing::calc_force` evaluates.
- **A fifth to a third of layout is overhead our engine does not have**:
  the garbage collector, `setjmp`'s system calls on entering Guile (chapter
  04 §2.3) and the text libraries take 22–33 %. The rest, 67–78 %, is work
  an engine of the same algorithms in Rust would still do, Guile's share
  included, since it runs Scheme callbacks and property alists that become
  Rust code and typed fields, not nothing.

### 2.3 Scaling with the length of a score

**[measured]**: `gen.mjs` (Appendix A) writes a piano piece of 16 to 256
bars: beamed eighths with accidentals in the right hand, a slur every other
bar, a tie every third, a dynamic every fourth, chords in the left hand, a
title. Time-tracer phases, median of three runs, `-dno-print-pages`, in ms.

| Bars | Systems | Pages | Live grobs | Translate | Springs and rods | Page breaking | Layout | Layout per grob |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 16 | 4 | 1 | 1,427 | 62.3 | 43.2 | 44.1 | 87.3 | 61 µs |
| 32 | 8 | 2 | 2,863 | 118.2 | 49.6 | 95.7 | 145.3 | 51 µs |
| 64 | 16 | 3 | 5,695 | 217.0 | 102.3 | 129.6 | 231.9 | 41 µs |
| 128 | 32 | 5 | 11,420 | 409.3 | 206.4 | 258.1 | 464.5 | 41 µs |
| 256 | 64 | 10 | 22,808 | 815.2 | 374.0 | 525.1 | 899.1 | 39 µs |

Layout grows linearly with the score, at about 40 µs per grob once the
fixed part is spread: nothing in LilyPond's line or page breaking is
quadratic at these lengths, because a candidate line stops growing once it
is too long to fit (`Constrained_breaking::initialize` breaks out of the
row) and a page DP has a few systems per page. A full layout of a 20-page
score is the problem; one system or one page is not.

### 2.4 Cheaper algorithms, tried with LilyPond's own switches

Where LilyPond's algorithms have a cheaper setting, it can be tried on
LilyPond itself and scored with chapter 00's comparator before anything is
built. **[measured]**: chapter 00's reference capture with one more line in
the settings file per variant, compared with the plain capture on C3 and
C4 over all 30 scores; layout time (time tracer, `-dno-print-pages`) median
of five runs; beam and slur shapes from `c5dump.ly` (Appendix A), which
records each beam's `positions` and each slur's and tie's control points,
compared with the plain compile on the nine scores with beams or slurs that
matter (T08, T11, T12, T23–T26, T29, T30).

| Variant | Setting | C3 passes | C4 passes | Shapes changed | Layout ms T12 / T24 / T29 |
| --- | --- | --- | --- | --- | --- |
| v0 | none | 30 | 30 | — | 81.1 / 162.1 / 186.5 |
| v1 | `Beam.skip-quanting = ##t`: least-squares beams, no quanting | 30 | 23 | every beam of the nine scores but 2; up to 8.4 staff spaces (T29) | 75.9 / 154.4 / 183.7 |
| v2 | `Beam.details.region-size = #1` instead of 2 | 30 | 30 (Goal missed in T11, T29) | 60 of 62 beams in T29, 25 of 67 in T30, 10 of 131 in T24, by up to 1 staff space | 76.2 / 156.1 / 185.3 |
| v3 | `Slur.details.region-size = #1` instead of 4 (and `PhrasingSlur`) | 30 | 30 | no slur of 62; 4 beams of T12 by ≤ 0.11 | 78.0 / 171.9 / 177.0 |
| v4 | every stencil-based vertical skyline replaced by its extent box (`ly:grob::simple-vertical-skylines-from-extents`, 50 grob types) | 30 | 23 (T29: Δy median 4.3) | — | 76.5 / 158.2 / 191.0 |
| v5 | `page-breaking = #ly:minimal-breaking` | 29 (T02 breaks differently) | 29 | — | 76.1 / 161.0 / 184.9 |

What it says:

- **The switches save at most 6.4 %**, less than the spread between the
  fastest and the slowest of five runs of the unchanged score (7–12 % of the
  median), and four of the five cost fidelity: beams are visibly different
  with either beam setting (a staff-space step), box skylines move whole
  staves in T29, and greedy page breaking changes T02's pages. LilyPond's
  searches are already pruned (best-first, cheap scorers first); what costs is
  the machinery around each step: property lookups through Guile, allocation,
  garbage, building skylines from outlines.
- **So the engine does not approximate the engraving.** It ports
  LilyPond's searches with their parameters, makes each step cheap (§5),
  and gets its speed per edit from doing less work, not worse work (§6).
  The slur setting (v3) changed no slur on this corpus but saves nothing
  measurable either, so it stays at 4.
- **C4 does not see shapes**: a linked element is compared by its
  `translate(x, y)`, which a beam or a slur keeps when its slope or
  curvature changes. v2 passes C4 on all 30 scores although it moved 60
  beams of T29 by up to a staff space. §9 proposes a shape layer for
  chapter 00's comparator.

## 3. What an edit changes on the page

**[measured]** with `c5dump.ly` (Appendix A), which writes after page
breaking one line per system (its page, offset and first moment) and one
line per live grob caused by an event: its type, the event's
`file:line:char`, its system, its line (the `VerticalAxisGroup` of a staff,
lyrics or dynamics line it belongs to), its X and Y in the system, and a
shape (a beam's positions, a slur's or tie's control points, a stem's
extent). Each edit of chapter 00 §6.2, as chapter 04 §3 made them, is
compared with the unedited score by `diff5.mjs`: a grob is keyed by type,
`file:line:char` (moved back over text an edit inserted) and its ordinal,
and has changed if it moved by more than 0.001 staff spaces, changed shape
or changed system. A *cell* is one line of one system.

| Score | Edit | Systems changed | Line breaks (system start moments) | Cells changed | Grobs in changed cells | Grobs moved | of them horizontally | Added / removed |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T02 | E1 pitch | 1 of 3 | same | 1 of 10 | 46 of 183 | 2 | 0 | 0 / 0 |
| T02 | E2 reflow | 1 of 3 | same | 3 of 10 | 88 | 74 | 74 | 7 / 0 |
| T02 | E3 text | 0 | same | 0 | 0 | 0 | 0 | 0 / 0 |
| T12 | E1 | 1 of 5 | same | 1 of 5 | 133 of 764 | 97 | 97 | 0 / 0 |
| T12 | E2 | 3 of 5 | 0, 4, 9, 16, 20 → 0, 4, 9, 65/4, 81/4 | 3 of 5 | 407 | 407 | 313 | 10 / 0 |
| T12 | E3 | 0 | same | 0 | 0 | 0 | 0 | 0 / 0 |
| T24 | E1 | 1 of 6 | same | 1 of 19 | 197 of 2,842 | 2 | 0 | 4 / 0 |
| T24 | E2 | 3 of 6 | the last system starts at 12 instead of 11 | 7 of 19 | 1,004 | 857 | 857 | 7 / 2 |
| T24 | E3 | 0 | same | 0 | 0 | 0 | 0 | 0 / 0 |
| T29 | E1 | 1 of 1 | same | 1 of 28 | 73 of 2,596 | 5 | 1 | 0 / 0 |
| T29 | E2 | 1 of 1 | same | 27 of 28 | 2,595 | 2,588 | 2,396 | 8 / 2 |
| T29 | E3 | 0 | same | 0 | 0 | 0 | 0 | 0 / 0 |

What it says:

- **No system before the edited one ever changed**, and no page break did:
  layout can start again at the edited system.
- **A pitch edit (E1) changes one cell**, and inside it a handful of grobs
  (the stem, the beam, an accidental and what it pushed), unless the
  column's width changes: in T12 the edit made `<g b>` a second, one note
  head moved to the other side of the stem, the column widened and the
  whole system was spaced again (97 of its 133 grobs moved sideways, in
  the one staff T12 has). The 4 grobs added in T24 are two accidentals and
  their placements: the new `a` needs a natural in C minor, and the `as`
  after it its flat again; they fitted without moving anything sideways.
- **A reflow (E2) changes its cell from the edit to the end of the system,
  and the systems after it when the line breaks move** (T12, T24). In a
  one-system score every line moves sideways, since a column was added
  (T29: 27 of 28 cells). In T02 the reflow stayed within the last system.
- **A header edit (E3) changes no system**, only the title block, which is
  laid out with the page.
- **A one-system score is the hard case**: T29's single system holds all
  its 3,175 grobs, so "re-lay out the systems an edit changes" is the whole
  score for every edit; the cell, one staff's line in one system, is the
  unit that keeps E1 small there (73 grobs).

## 4. What the layout engine must do

| # | Requirement | Why |
| --- | --- | --- |
| Y1 | Produce LilyPond's line and page breaks and its positions: the same algorithms with the same parameters and the same order of floating-point operations where it changes a result | C3 (breaks ≥ 0.9, pages equal) and C4 (median ≤ 0.5, p95 ≤ 2 staff spaces) on all 30 scores; §2.4 shows the cheaper settings fail them |
| Y2 | Keep LilyPond's grob property model visible to Scheme: `ly:grob-property`, `\override` with procedures, `\applyOutput`, `after-line-breaking`, `\tweak`, pure and unpure callbacks | chapter 03 R12; T15, T26, T27 (Scheme everywhere); `ly:grob-*` functions of `output-lib.scm` |
| Y3 | Take chapter 04's grob records, with their stable ids, property chains and change list, as they are | chapter 04 §9.1, §10.6 |
| Y4 | Re-lay out after an edit only the cells whose input changed, and break lines and pages again from the first change | B6; §3 |
| Y5 | Lay out a whole score fast enough for a first render | B5b (T02's first page: 800 ms Must on the Android reference, everything included) |
| Y6 | Stop within B8's 50 ms when a newer edit arrives, and never hold a step longer than that | B8, B7 |
| Y7 | Bound the work of every search (beam quants, slur and tie configurations, outside-staff passes, line candidates) so that no input can take unbounded time | §7; a phone tab is killed, not slow |
| Y8 | Keep memory per grob small, and the previous layout until a new one is complete | B4; chapter 04 §10.6 |
| Y9 | Hand chapter 06 positioned stencils per grob, with stable ids, so that unchanged grobs keep their SVG | B10; chapter 06 |

## 5. Design

The engine keeps LilyPond's pipeline of §1 and its algorithms (Y1), and
changes how each step is carried out: typed data instead of property
alists, Rust calls instead of Guile calls, precomputed glyph data instead
of outlines read at run time, and caches keyed by what a result depends on
(§6).

### 5.1 Grobs and properties

- **One arena per layout.** A grob record from translation (chapter 04
  §9.1: type, context, cause, timestep, stable id, property chain) gets a
  layout part: X and Y parents as indices, an offset per axis, flags (live,
  broken piece, cross-staff), its system and cell once known, and a slot
  table of *computed* properties.
- **Typed slots, generated.** `define-grob-properties.scm` (the property
  names and types) and `define-grobs.scm` (each type's interfaces and
  defaults) become tables at build time, as chapter 04 §9.1 does for
  interfaces: each grob type gets the list of properties its interfaces
  declare, a slot per property, and a default per slot. A slot holds an
  8-byte value of chapter 03's layout (numbers, pairs of reals, booleans and
  symbols immediate) and two state bits: not computed, computing (a read in
  this state is LilyPond's "cyclic dependency" error, `grob-property.cc`),
  computed. A property a score invents (`\override NoteHead.foo`) goes to a
  side list, as LilyPond's alist would hold it.
- **Callbacks are Rust functions**, found by (type, property) in the
  generated table: the C++ callbacks of L1–L5 and the per-grob Scheme
  procedures of `output-lib.scm` and `bar-line.scm` that every score runs
  (chapter 03 §2.4: 57,000 and 35,000 applications in the 30 compiles).
  Lookup order stays LilyPond's: values set on the grob, then the
  `\override` stack it was made with (chapter 04 §7's persistent stacks,
  already a pointer per grob), then the default. A value on the stack that
  is a Scheme procedure is called through chapter 03's interpreter with a
  foreign grob object, so `\override … = #(lambda (grob) …)` and
  `\applyOutput` work unchanged (Y2).
- **Pure and unpure** are two entries of the table, as in an
  `unpure-pure-container`; a pure call caches by (property, start column,
  end column), as `Grob::pure_property_cache` does.
- **Broken grobs without copying.** LilyPond copies every spanner per
  system and rewrites every grob link to the copies (line splitting is
  1–8 % of layout, §2.2). Here a spanner's piece in a system is a *slice*
  (the original, the system, its bounding columns) made when the system is
  laid out, and a link is resolved to the slice of the reader's system when
  it is read. Items at breakable columns keep LilyPond's three versions
  (before the break, after it, unbroken), made lazily for the breakpoints
  actually chosen.

### 5.2 Horizontal spacing

- **Columns** are chapter 04's two per timestep (musical and non-musical).
  A column's *width descriptor* is what spacing needs from it: its left and
  right horizontal skylines (from its `Separation_item`s), the spring
  parameters `spacing-basic.cc` and `note-spacing.cc` compute from the
  durations around it and the optical corrections (stem directions,
  accidentals, the `StaffSpacing` of clefs and bar lines), and its
  breakability. It is keyed by a digest of its grobs' stable ids and the
  properties spacing reads, and is reused across edits when the digest is
  unchanged, even if the column moved in time (§6.2).
- **Rods and springs** are LilyPond's: the springs between neighbours from
  `Spacing_spanner`, the rods from skyline distances between columns
  (`Separation_item`), and the extra rods of spanners and loose columns
  (`spacing-loose-columns.cc`).
- **One line** is solved by a port of `Simple_spacer`: given a line width,
  the force that stretches or compresses the springs while the rods hold.
  Its floating-point order is kept, since its result is every x
  position.

### 5.3 Line breaking

- **Kept as it is**: `Constrained_breaking`'s dynamic program (§1), which
  costs 0.1–5 % of layout (§2.2) and scales linearly (§2.3), with
  `\break`, `\noBreak`, `ragged-right`, `ragged-last` and the penalties of
  `fill_line_details`.
- **Stored to be updated**: the force of each candidate line `(i, j)` (a
  line holds a few bars in the corpus, whose longest system has 63 columns) in
  a band matrix, and the DP's rows per breakpoint. An edit that changes the
  width descriptors of columns `a…b` invalidates the lines that contain one of
  them (`i < b`, `j > a`): O(L²) lines for L breakpoints per line. The DP is
  re-run from the first breakpoint whose candidate lines changed; rows before
  it are kept. Since the DP is cheap, it is always run to the end, and the
  systems it returns are compared with the old ones (§6.3).
- **Page breaking asks for line breakings** with several system counts
  (`Page_breaking::set_current_breakpoints`); the DP's table answers all of
  them, as LilyPond's `Constrained_breaking` does.

### 5.4 Stems, beams and flags

- **Beams** are a port of `Beam_scoring_problem` with its parameters
  (`region-size` 2, +2 for knees, +2 with collisions; the scorers in
  LilyPond's order, best-first), since §2.4 shows that a smaller region or
  no quanting moves beams by a staff space. Stem lengths, beam segments and
  `beaming-pattern.cc`'s subdivisions follow.
- **Bounded**: with the default `region-size` the configurations are at
  most 48 × 48 = 2,304 and the scorer runs 2,304 × 7; the priority queue is
  capped at 20,000 scorer runs per beam (Y7), so the cap binds only when a
  score raises `region-size`, and then the best complete configuration so
  far is taken and a note is logged.
- **Memoized per beam** by a digest of what it reads (its stems' x offsets
  relative to the first, their note positions and directions, the staff,
  the collisions in its range): a beam whose cell is laid out again without
  its columns moving (E1 in T24 and T29, §3) is not quanted again.

### 5.5 Slurs and ties

- **Slurs**: a port of `Slur_score_state` and `Slur_configuration` with
  `default-slur-details` (`layout-slur.scm`), including encompassed note
  columns, extra objects and the best-first scorer queue. About 80
  configurations per slur with the default `region-size` (end points every
  half staff space within 4 staff spaces); capped at 400 configurations
  and 4,000 scorer runs per slur (Y7), caps that step Y5 checks the corpus
  never reaches.
- **Ties**: a port of `Tie_formatting_problem` and its details
  (`single-tie-region-size` 4, `multi-tie-region-size` 3), including chords
  and `LaissezVibrerTie`; capped at 2,000 configurations per tie column,
  checked likewise.
- **Béziers** (`bezier.cc`, `bezier-bow.cc`, `flower/polynomial.cc`) are
  ported with their numerical methods, since the curve's control points are
  what C4's future shape layer compares.

### 5.6 Heads, dots, accidentals, rests and collisions

Ports of `note-collision.cc`, `rest-collision.cc`, `dot-column.cc` and
`dot-configuration.cc`, `accidental-placement.cc` (its stacking of
accidentals by columns), `ledger-line-spanner.cc`, `note-column.cc`. They
are 1–2 % of layout (§2.2) and need no change beyond typed properties.

### 5.7 Skylines

- **Representation**: a skyline is a vector of buildings, as in
  `skyline.cc` (start, end, height at start, slope), in f64 so that results
  match; a skyline pair (up and down) per grob that has one. Merge,
  distance, shift, raise and padding are ports.
- **Glyphs from a table**: LilyPond builds a glyph's skyline at run time
  from its outline (`stencil-integral.cc`, FreeType's path, Béziers
  approximated by boxes): 37–59 % of the skyline samples (§2.2). The
  outlines of Emmentaler never change, so chapter 06's font build computes
  each glyph's skyline pair once with the same procedure and ships it with
  the glyph's metrics: at run time a glyph's skyline is that table entry
  scaled and translated. The result is the same skyline, not an
  approximation; v4 of §2.4 shows that a box would not do.
- **Other stencils** (lines, polygons, beams as parallelograms, Bézier
  bows, rounded boxes) are made as `stencil-integral.cc` makes them; text
  from each glyph's box of the text font (chapter 06), as LilyPond's
  `Pango_font` stencils give boxes per glyph.
- **Cached per grob and per cell**: a grob's skyline is a computed property
  (§5.1); a cell's staff skyline (what outside-staff placement and staff
  distances read) is kept with the cell (§6.1).

### 5.8 Outside-staff objects and side positions

- **A port of `Axis_group_interface::skyline_spacing`**: grobs by
  `outside-staff-priority`, then left to right in passes
  (`left-to-right-polite` and the other directives), each raised by
  `avoid_outside_staff_collisions` until it clears the staff and what is
  already placed; riders move with their grob.
- **Placed skylines indexed by their horizontal extent.** LilyPond
  compares each grob with every skyline placed before it in its staff (a
  vector, so O(k²) for k grobs; outside-staff placement is 11–19 % of
  layout in the larger scores, §2.2), each comparison giving an interval
  of forbidden shifts, and moves the grob to the allowed shift nearest to
  zero. A skyline that does not overlap the grob horizontally (after the
  horizontal paddings) gives an empty interval, so the engine keeps the
  placed skylines in an index by x extent and compares the grob only with
  those that overlap it: the same intervals, so the same result. Merging
  the placed skylines into one would be cheaper but not the same, since
  the union of the intervals can leave a gap between two placed objects
  that LilyPond fills and a merged skyline would close.
- **Side positions** (`side-position-interface.cc`, scripts, fingerings,
  dynamics alignment) are ports.

### 5.9 Staves in a system, systems on a page

- **Staff distances** in a system are a port of `Align_interface` (from the
  cells' skylines, `staff-staff-spacing`, `VerticalAxisGroup` spacing
  details, `StaffGrouper`), with `hara-kiri-group-spanner.cc` removing empty
  staves.
- **Pages** are a port of `Page_spacer`, `Page_breaking` and
  `Optimal_page_breaking` with `Page_layout_problem`'s vertical springs and
  rods. The `\paper` variables and spacing alists they read are read once
  per book into a struct, instead of from the output definition's module
  for every page force (T02's 68 samples of 150, §2.2).
- **Titles and markup** (`titling.scm`, `\header`) are laid out as page
  elements; their stencils are chapter 06's markup interpreter.

### 5.10 What is left out, and where it goes

Ancient ligatures (E5), the page-turn and other breakers, and the 84 grobs
no score reaches (chapter 01 §5) come after the steps of §10. Rarely used
notation that is large in code (tablature and fret diagrams, figured bass,
chord names, ambitus, pedals, percent repeats) is built into on-demand
modules (chapter 08), fetched as chapter 03 §6 fetches Scheme parts, so the
core holds the notation of T01–T03 and the common grobs of chapter 01 §5.

## 6. Re-laying out only what an edit changes

### 6.1 Units of work

- **Columns** (§5.2): the width descriptor, reused by content digest.
- **Lines** of the breaking DP (§5.3).
- **Cells**: one line context (chapter 04 §10.3's partition: a Staff with
  its Voices, Lyrics, Dynamics, FiguredBass, ChordNames, …) in one system.
  A cell owns the layout of the grobs in it: stems, beams, slurs, ties,
  collisions, skylines, outside-staff placement, and the cell's own
  skyline. Partitions that chapter 04 merged (a voice moving between staves
  with `\change Staff`, cross-staff beams in T11 and T24–T27) are one cell
  spanning those lines.
- **Systems**: staff distances, spanners across lines (`SpanBar`,
  `SystemStartBrace`), the system's height for page breaking.
- **Pages**: the page DP's state from each page on, and page spacing.

A cell's result is valid while its *input key* is unchanged: the digests of
its grobs (stable ids and the properties they read, from chapter 04's
change list), the x positions of its columns, and the line width. 28 cells
in T29, 19 in T24, 10 in T02 (§3).

### 6.2 What an edit invalidates

From chapter 04 §10.6's change list (timesteps added and removed, and for
each timestep the partitions whose grobs changed):

1. **Columns** whose grobs changed get a new width descriptor; a column that
   only moved in time keeps it. E1 changes one or two; E2 adds a few and
   shifts the rest without changing them; E3 none.
2. **Line breaking** recomputes the lines that contain a changed column and
   re-runs the DP from there (§5.3). New breaks are compared with the old.
3. **Systems** whose first and last columns and column digests are
   unchanged keep their x positions (the line's `Simple_spacer` solution);
   otherwise the line is solved again.
4. **Cells** whose input key changed are laid out again: in an unchanged
   system, the cells of the changed partitions; in a re-solved system,
   every cell whose columns moved. E1 in T29 is one cell of 28.
5. **Staff distances** of a system are recomputed if one of its cells'
   skylines changed; its height goes to page breaking.
6. **Pages**: the page DP restarts at the page holding the first system
   whose height or content changed, and runs to the end (it is a few
   systems per page); pages whose systems and spacing come out the same
   keep their output.
7. **Titles**: an E3 edit re-lays out the title block and runs step 6 from
   the first page if the block's height changed.

### 6.3 Correctness

Reuse decides by digests, so it can only be as right as the digests are
complete. Every property a layout function reads goes through §5.1's slot
table, which records the read in debug builds; a test build compares each
cell's recorded reads with what its key covers. And every test of the
layout module also lays out from scratch and compares the two layouts grob
by grob (positions, shapes, breaks), on chapter 00's edits and on random
edits of the 30 scores (step Y7 of §10), as chapter 04's N8 does for
translation.

## 7. A time limit per edit

### 7.1 The budget

Chapter 00's provisional split of B6 gives layout 120 ms of an S edit on
the Android reference, and twice that for L scores (240 ms) by the same
proportion; E2 may take twice either. That is layout's time from receiving
chapter 04's change list to handing chapter 06 the changed grobs.

### 7.2 Order of work

The engine is told which page the preview shows: the host sends the
visible page with each edit, a small addition to the extension's preview
and Lily Studio, which keep their scroll position already (D17). Work is
queued in this order:

1. width descriptors and line breaking (whole score; cheap);
2. the cells and systems of the visible page, then that page's spacing;
3. hand the visible page to chapter 06 and the host: **the page is shown**;
4. the cells and systems of the following pages, then the preceding ones,
   page by page, each page handed over when done.

The old layout of a page stays on screen until its new one arrives
(chapter 04 §10.6 keeps the old records valid until a run completes).

### 7.3 Steps and cancellation

Every queued item is a step that ends at a point where the engine checks for a
newer edit (B8) and the time spent. The largest cell of the four edited scores
holds 284 grobs caused by events (T24, the second line of its fourth system),
about 340 live grobs: at §8's straight-port rate of 116 µs per grob that is 40
ms on the Android reference, too close to B8's 50 ms, so a cell's layout is
split into sub-steps that each end at a check: horizontal (stems, dots,
accidentals, collisions), beams, slurs and ties, skylines, outside-staff
placement by priority. Each sub-step is then a fraction of the cell's 40 ms;
step Y7 measures them against the 20 ms of §9.

### 7.4 When the budget runs out

If the visible page is not done when layout's budget is spent, the engine
keeps going: nothing is approximated (§2.4), and showing a half-laid-out
page would be worse than a late one. The budget is instead a figure that
the tests of §10 and step 10's phone timings check per edit, and the
deadline only changes the order: pages other than the visible one wait.
The caps of §5.4–§5.5 bound every search, so a step's time is bounded by
its grobs. A score whose whole layout cannot finish within chapter 00's
memory or time limits on the Android floor is the only case that ends in an
error, reported as a diagnostic, not a killed tab.

## 8. Projected cost

From §2: a straight port of LilyPond's algorithms keeps 67–78 % of its layout
samples (§2.2, without the collector, `setjmp` and the text libraries), so it
would cost 0.75 × (1/0.45) × 1.5 ≈ 2.5 times LilyPond's desktop layout time on
the Android reference, less the 18 ms fixed part (§2.1), which moves to
start-up: **116 µs per live grob**. §5's changes (no property alists or Guile
calls, glyph skylines from a table, outside-staff skylines indexed by extent,
`\paper` read once) remove a further share that only a prototype can measure;
the Goal of 40 µs per grob assumes they remove about two thirds of what remains,
which step 10 must confirm.

Per edit, the grobs to lay out again are those of the changed cells of §3,
counted live (× 1.2: §3 counted only grobs caused by events, 2,596 of
T29's 3,175), plus the line DP and the page DP, which are small (§2.2). A
whole-system re-layout is shown for comparison.

| Score | Edit | Live grobs laid out again | Straight port | At the Goal | Whole systems, straight port |
| --- | --- | --- | --- | --- | --- |
| T02 | E1 | 55 | 6 ms | 2 ms | 12 ms (106 grobs) |
| T02 | E2 | 106 | 12 ms | 4 ms | 12 ms |
| T12 | E1 | 160 | 19 ms | 6 ms | 19 ms |
| T12 | E2 | 488 | 57 ms | 20 ms | 57 ms |
| T24 | E1 | 236 | 27 ms | 9 ms | 93 ms (800 grobs) |
| T24 | E2 | 1,205 | 140 ms | 48 ms | 205 ms |
| T29 | E1 | 88 | 10 ms | 4 ms | 368 ms (3,175 grobs) |
| T29 | E2 | 3,114 | 361 ms | 125 ms | 368 ms |
| any | E3 | the title block | ≈ 1 ms | ≈ 1 ms | — |
| T02 | first render | 332 | 39 ms | 13 ms | |
| T29 | first render | 3,175 | 368 ms | 127 ms | |

Against §7.1: a straight port meets every per-edit budget of the four
scores with cells (T29 E2: 361 ms of its 480), and misses L's E1 budget for
T29 without them (368 ms against 240): cells, not systems, are the unit a
one-system orchestral page needs. The Goal leaves a factor of 2–4 of
margin for scores larger than the corpus. A first render of T02 is 39 ms of
B5b's 800.

## 9. Budgets

Proposed for step 11 to confirm; times on chapter 00's Android reference,
and E2 may take twice the per-edit rows.

| What | Must | Goal | Now |
| --- | --- | --- | --- |
| Layout of a whole score, S | 150 ms | 50 ms | 4–129 ms projected straight port (T01–T23: 32–1,115 grobs) |
| Layout of a whole score, L | 500 ms | 200 ms | 46–397 ms projected straight port (T24–T30: 396–3,419 grobs) |
| Layout per edit, S | 120 ms | 40 ms | 6–57 ms projected (§8) |
| Layout per edit, L | 240 ms | 80 ms | 10–361 ms projected (§8; E2 has 480 ms) |
| Cost per live grob, full layout | 120 µs | 40 µs | 116 µs projected straight port |
| Longest step between cancellation checks | 20 ms | 5 ms | 40 ms for the largest cell as one step (§7.3); its sub-steps not yet measured |
| Memory of layout, L (one layout, plus the previous during an edit) | 8 MB | 4 MB | ≤ 2.2 MB for T29, estimated below |
| Code, uncompressed wasm: grobs, properties, spacing, breaking, skylines and the notation of the core, its E1–E4 engravers included (E6 is chapter 04's) | 1.2 MB | 0.8 MB | about 22,000 of an estimated 34,000 lines of Rust in the core, 0.95 MB at chapter 04's 43 bytes a line |
| Same, brotli (share of B1) | 450 KB | 300 KB | — |
| Each on-demand notation module (§5.10), brotli | 100 KB | 40 KB | — |

**Memory**, estimated for T29: per live grob a layout part of 64 bytes, its
computed slots (about 12 of 8 bytes) and, for the 40 % or so that have one,
a skyline pair (two vectors of about 8 buildings of 32 bytes): about
350 bytes, 1.1 MB for 3,175 grobs; columns' width descriptors, the line DP's
band matrix, cells' skylines and the page DP below 100 KB. During an edit
the old layout of the changed cells is kept beside the new one. The
256-bar score of §2.3 (22,808 grobs) would take about 8 MB, the Must, so a
score far larger than the corpus is where layout's memory needs another
look (keeping only the visible pages' slots, recomputing the rest).

**Code**: L1–L5 (42,773 lines of C++) and E1–E4 (19,492) less what is left
out (§5.10: about 3,000 lines of ancient ligatures, other breakers and
unreached grobs) is about 59,000 lines of C++; at chapter 04's ratio of
0.57 lines of Rust per line of C++ that is about 34,000 lines of Rust, of
which the core's notation (§5.10) is about two thirds. E6 (alignment,
spacing and breaking engravers) is counted in chapter 04's budget.

**For chapter 00's comparator**: a shape layer, C5, comparing each beam's
`positions` and each slur's and tie's control points (as `c5dump.ly`
records them, with chapter 06 writing the same from the engine) with Must
≤ 0.25 and Goal ≤ 0.05 staff spaces at p95, since C4 cannot see them
(§2.4).

## 10. The ordered steps

The order in which the layout module should be built. *Scores laid out*
counts the scores whose live grobs (census of §2.1) are all of the steps so
far, and which have one system on one page until Y3. Each step needs
chapter 04's steps N1–N7 for the music, the engravers of chapter 01's
E1–E4 that make the grobs it lays out, and chapter 06's glyph metrics and
skylines; a step's scores are checked on C3, C4 and the shape layer of §9
against chapter 00's capture.

| Step | What | LilyPond | Scores laid out (cumulative) |
| --- | --- | --- | --- |
| Y1 | Grob arena, typed slots, generated tables, callbacks, pure and unpure; columns, width descriptors, springs and rods, `Simple_spacer`; one system on one page; stems, flags, rests, dots, accidentals, clefs, keys, times, bar lines, note and rest collisions, ledger lines, staff groups and braces, instrument names, multi-measure rests | L1, L3 without breaking, `system`, `paper-column`, the L5 files of these grobs, `define-grobs.scm`, `output-lib.scm`, `bar-line.scm` | 5: T01, T03, T14, T16, T19 |
| Y2 | Skylines (with glyph skylines from chapter 06), outside-staff placement with skylines indexed by extent, side positions, staff distances, empty staves; scripts, text, dynamics, hairpins, bar numbers, metronome marks, fingerings, brackets, voltas, ottavas, arpeggios | L2, `side-position-interface`, `script-*`, `hairpin`, `line-spanner`, `volta-bracket`, `ottava-bracket` | 8: + T10, T13, T18 |
| Y3 | Line breaking, page breaking and page spacing, broken items and spanner slices, titles | `constrained-breaking`, `page-*`, `optimal-page-breaking`, `break-substitution` (by slices), `titling.scm` | 10: + T05, T17 |
| Y4 | Beams with quanting and its cap, stem lengths, beaming patterns, stem tremolos | `beam`, `beam-quanting`, `beaming-pattern`, `stem-tremolo` | 13: + T07, T11, T15 |
| Y5 | Slurs, ties, laissez-vibrer ties, tuplet brackets and numbers, glissandos, voice followers | `slur*`, `bezier-bow`, `tie*`, `semi-tie*`, `tuplet-*`, `line-spanner` | 22: + T08, T09, T12, T24–T29 |
| Y6 | Lyrics (text, hyphens, extenders), figured bass, tablature heads, as on-demand modules where §5.10 says | `lyric-*`, `figured-bass-continuation`, the E4 engravers, `tablature.scm` (chapter 03's `fretted`) | 30: + T02, T04, T06, T20–T23, T30 |
| Y7 | Incremental layout: digests and input keys, reuse of width descriptors, cells, systems and pages, the line and page DPs updated, the queue of §7 with sub-steps and cancellation; differential tests (incremental = from scratch) on chapter 00's edits and random edits | — | 30, timed per edit |
| Y8 | The rest: unreached grobs of chapter 01 §5 by how common they are in real scores (`KeyCancellation`, `RehearsalMark`, `TextMark`, `PhrasingSlur`, `RepeatTie` first), ancient notation, other breakers | E5, the remaining L5 | 30 |

Y7 is last among the steps that make the 30 scores pass, because its
differential tests need a layout from scratch to compare with; its digests
and keys should nevertheless be designed with Y1's slot table, since every
property read must be recordable (§6.3).

## 11. What later chapters take from here

| Chapter | Takes |
| --- | --- |
| 06 SVG, PDF, fonts | glyph skylines computed at font build with `stencil-integral.cc`'s procedure, shipped with the metrics (§5.7); positioned stencils per grob with stable ids, handed over page by page (§7.2); the shape layer C5 to add to chapter 00's comparator (§9); text glyph boxes for skylines |
| 07 MIDI | nothing: performances run after the page (chapter 04 §9.3) |
| 08 build | the code budget of §9; on-demand notation modules (§5.10); generated tables from `define-grobs.scm` and `define-grob-properties.scm` at build time; f64 throughout layout |
| 09 phone timings | in step 10's crate: one staff of notes with stems, dots and accidentals, its columns, springs and rods, `Simple_spacer` and a skyline merge; measure µs per live grob (§9's 120 µs Must and 40 µs Goal) and a cell's re-layout after a pitch edit |
| 11 roadmap, D56 | steps Y1–Y8, the budgets of §9, the cells of §6 as the unit of re-layout, and that the engine ports LilyPond's searches instead of approximating them (§2.4) |

## Appendix A: recipes

The LilyPond checkout and the test scores are those of chapters 00 and 01;
`corpus.tsv` lists `ID path` for the 30 scores, and `edits/` holds chapter
04's edited copies (`<id>-E<n>.ly`). Scripts run from one directory.

**Phases** (§2.1, §2.3): each score compiled with the tracer, three times;
`phases.mjs` reads each trace's begin and end events and sums, per score,
"Translate" and the other phases under "layout", and "page-breaking" under
"Output svg", taking the median of the three runs:

```sh
while IFS=$'\t' read id file; do
  (cd "$(dirname "$file")" && LANGUAGE=en lilypond --loglevel=ERROR --svg -dpoint-and-click \
     -dtime-trace-file=trace$r/$id -o trace$r/$id "$file" > /dev/null 2>&1)
done < corpus.tsv          # for r in 1 2 3; trace$r/<id>.json
```

**Census** (§2.1): `c5.ly` as a settings file, with `-dno-print-pages`:

```sh
cd "$(dirname score.ly)" && C5_OUT=census/<id>.tsv LANGUAGE=en lilypond --loglevel=ERROR \
  -dno-print-pages -dinclude-settings=/abs/c5.ly -o census/<id> score.ly
```

```lilypond
%% Chapter 05's census: after page breaking, writes to C5_OUT per book the pages, the
%% systems, the columns spaced, the live grobs of all systems, those of them that may go
%% outside the staff, the most grobs and columns in one system, the systems per page,
%% and the live grobs by type. A grob that suicided has no properties left: not counted.
#(begin
  (define c5-port (open-file (or (getenv "C5_OUT") "c5.out") "a"))
  (define (c5-line . xs)
    (display (string-join (map (lambda (x) (format #f "~a" x)) xs) "\t") c5-port)
    (newline c5-port))
  (define c5-columns '())
  (define (c5-count! table key) (hash-set! table key (1+ (hash-ref table key 0))))
  (define (c5-post-process paper pages)
    (let ((types (make-hash-table)) (systems 0) (grobs 0) (outside 0) (max-grobs 0)
          (max-cols 0) (lines-per-page '()))
      (for-each
       (lambda (page)
         (let ((lines (ly:prob-property page 'lines '())) (here 0))
           (for-each
            (lambda (line)
              (let ((sys (ly:prob-property line 'system-grob #f)))
                (when (ly:grob? sys)
                  (set! systems (1+ systems)) (set! here (1+ here))
                  (let* ((all (filter grob::name (ly:grob-array->list (ly:grob-object sys 'all-elements))))
                         (cols (ly:grob-object sys 'columns)))
                    (when (ly:grob-array? cols)
                      (for-each (lambda (c) (unless (memq c c5-columns) (set! c5-columns (cons c c5-columns))))
                                (ly:grob-array->list cols)))
                    (set! grobs (+ grobs (length all)))
                    (set! max-grobs (max max-grobs (length all)))
                    (when (ly:grob-array? cols) (set! max-cols (max max-cols (ly:grob-array-length cols))))
                    (for-each
                     (lambda (g)
                       (c5-count! types (grob::name g))
                       (when (memq 'outside-staff-interface
                                   (assq-ref (ly:grob-property g 'meta) 'interfaces))
                         (set! outside (1+ outside))))
                     all)))))
            lines)
           (set! lines-per-page (cons here lines-per-page))))
       pages)
      (c5-line "book" (length pages) systems (length c5-columns) grobs outside max-grobs max-cols
               (reverse lines-per-page))
      (hash-for-each (lambda (k v) (c5-line "type" k v)) types)
      (force-output c5-port)))
  (ly:output-def-set-variable! $defaultpaper 'page-post-process c5-post-process))
```

**Profile** (§2.2), as chapter 04's, for the whole compile; S256 is
`scale/s256.ly` compiled once:

```sh
cd "$(dirname score.ly)" && for i in $(seq 8); do echo '\include "score.ly"'; done > /abs/prof/x8.ly
LANGUAGE=en lilypond --loglevel=ERROR -dno-print-pages -I "$PWD" -o /abs/prof/out /abs/prof/x8.ly &
sleep 0.3; sample $(pgrep -n lilypond) 60 1 -mayDie -file prof/<id>.txt
python3 prof5.py prof/<id>.txt
```

```python
# prof5.py <sample.txt>: self samples of layout (below Paper_score::process or Paper_book::pages,
# not below Global_context::iterate), by the innermost LilyPond function on the stack that names an
# algorithm, and by what the sampled frame itself is.
import re, sys
from collections import Counter
lines = open(sys.argv[1]).read().split('\n')
start = next(i for i, l in enumerate(lines) if l.startswith('Call graph:'))
pat = re.compile(r'^([ +!:|]*)(\d+) (.+?)  \(in ([^)]+)\)')
nodes = []
for l in lines[start + 1:]:
    if not l.strip() or l.startswith('Total number'): break
    m = pat.match(l)
    if m: nodes.append((len(m.group(1)), int(m.group(2)), m.group(3), m.group(4)))
cats = [
  ('line breaking', r'Constrained_breaking|Simple_spacer|get_line_forces|Column_x_positions'),
  ('beams', r'Beam_scoring_problem|\bBeam::|Beam_collision|Least_squares|Beaming_pattern|Beam_configuration'),
  ('slurs', r'Slur|Bezier_bow'),
  ('ties', r'Tie_formatting_problem|\bTie::|Tie_column|Tie_configuration|Semi_tie|Tie_specification|Tie_details'),
  ('stems and flags', r'\bStem::|\bFlag::|Stem_tremolo'),
  ('accidentals, dots, collisions', r'Accidental_placement|Accidental_interface|Dot_column|Dot_configuration|Dot_formatting|Note_collision|Rest_collision|Note_column|\bRest::|Ledger_line'),
  ('skylines', r'Skyline|skyline|Stencil_integral|_boxes\b|make_[a-z_]*_boxes|Building'),
  ('fonts and text', r'Pango|pango|Open_type_font|Font_metric|Text_interface|Modified_font|Font_interface|FT_|hb_'),
  ('outside-staff and side positions', r'Axis_group_interface|Side_position_interface|Self_alignment|Interval_minefield|Hara_kiri|Script_interface|Script_column|Fingering_column'),
  ('staff and system alignment', r'Align_interface|Staff_grouper|Staff_symbol'),
  ('horizontal spacing', r'Spacing_spanner|Note_spacing|Staff_spacing|Spacing_basic|Spacing_options|Separation_item|Paper_column|Spaceable_grob|\bSpring|\bRod\b|Rod::|Break_alignment|Spacing_interface|Spacing_loose'),
  ('page breaking and page spacing', r'Page_breaking|Page_layout_problem|Page_spacing|Optimal_page_breaking'),
]
phases = [('page breaking', r'Page_breaking|Paper_book::pages'), ('system stencils and skylines', r'System::get_paper_system|System::get_paper_systems'),
          ('line splitting', r'break_into_pieces|break_substitution|Break_substitution'), ('springs and rods', r'Paper_score::process')]
def selfkind(f, lib):
    if f.split('(')[0].strip() in ('sigprocmask', '__sigaltstack', 'setjmp', '_setjmp', 'sigsetjmp'): return 'setjmp signal-mask syscalls'
    if 'libgc' in lib: return 'garbage collector'
    if 'libguile' in lib: return 'Guile runtime and VM'
    if re.search(r'pango|freetype|harfbuzz|fontconfig|glib|cairo', lib): return 'text libraries (Pango, FreeType, HarfBuzz)'
    if lib == 'lilypond': return 'LilyPond C++'
    return 'other (C++ runtime, libm, allocation)'
total = 0; cat = Counter(); kind = Counter(); stack = []
for i, (d, c, f, lib) in enumerate(nodes):
    while stack and stack[-1][0] >= d: stack.pop()
    stack.append((d, f, lib))
    names = [s[1] for s in stack]
    if not any(re.search(r'Paper_score::process|Paper_book::pages', n) for n in names): continue
    if any('Global_context::iterate' in n for n in names): continue
    kids = 0; j = i + 1; md = None
    while j < len(nodes) and nodes[j][0] > d:
        if md is None: md = nodes[j][0]
        if nodes[j][0] == md: kids += nodes[j][1]
        j += 1
    s = c - kids
    if s <= 0: continue
    total += s
    k = None
    for n, l in reversed([(x[1], x[2]) for x in stack]):
        if l != 'lilypond' and not re.search(r'pango|freetype|harfbuzz', l): continue
        hit = next((name for name, rx in cats if re.search(rx, n)), None)
        if hit: k = hit; break
    if k is None:
        phase = next((ph for ph, rx in phases if any(re.search(rx, n) for n in names)), 'elsewhere')
        k = 'unattributed, in ' + phase
    cat[k] += s; kind[selfkind(f, lib)] += s
print('layout samples', total)
for k, v in cat.most_common(): print(f'{v:6} {100*v/total:5.1f}%  {k}')
print('--')
for k, v in kind.most_common(): print(f'{v:6} {100*v/total:5.1f}%  {k}')
```

In §2.2's table, "horizontal spacing" adds the samples unattributed in
springs and rods, "line splitting" is those unattributed in line
splitting, and "page breaking" adds those unattributed in page breaking.
The skyline split (building against operations) counts the skyline
samples whose innermost skyline frame is `Stencil_integral`, a `make_…_boxes`
function, a `…from_stencil` callback, `Skyline::Skyline` or
`internal_build_skyline` as building.

**Scaling** (§2.3): `node gen.mjs <bars> > scale/s<bars>.ly` for 16 to 256,
then the tracer three times each and `c5.ly` once:

```js
// gen.mjs <bars>: a piano piece of <bars> bars in 4/4 for scaling layout: beamed eighths with
// accidentals, a slur every other bar, ties, a dynamic every four bars; chords in the left hand.
let seed = 7; const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
const bars = +process.argv[2]
const names = ['c', 'd', 'e', 'f', 'g', 'a', 'b'], alt = ['', '', '', 'is', 'es']
const dyn = ['\\p', '\\mf', '\\f', '\\pp']
let rh = '', lh = ''
for (let b = 0; b < bars; b++) {
  const notes = Array.from({ length: 8 }, () => names[rnd(7)] + alt[rnd(5)] + ["'", "''", "'"][rnd(3)])
  if (b % 2 === 0) { notes[0] += '8('; notes[3] += ')' } else notes[0] += '8'
  if (b % 4 === 0) notes[0] += dyn[(b / 4) % 4]
  if (b % 3 === 2) notes[7] += '~'
  rh += notes.join(' ') + ' |\n'
  const root = names[rnd(7)]
  lh += `<${root} ${names[(names.indexOf(root) + 2) % 7]}>4 ${names[rnd(7)]}, <${root} ${names[(names.indexOf(root) + 4) % 7]}>2 |\n`
}
console.log(`\\version "2.26.0"\n\\header { title = "Scale ${bars}" }\n\\score {\n  \\new PianoStaff <<\n    \\new Staff { \\clef treble \\time 4/4\n${rh}    \\bar "|." }\n    \\new Staff { \\clef bass\n${lh}    }\n  >>\n  \\layout { }\n}`)
```

**Variants** (§2.4): a settings file per variant, the include of chapter
00's `capture.ly` followed by one line, run as chapter 00's capture (with
`-dtime-trace-file`) into `var/<variant>/<id>`, and scored with chapter 00's
`score.mjs` against the reference capture; a score passes C3 if its page
counts are equal and its breaks score ≥ 0.9, and C4 if all four
statistics meet the Must. The layout times are the same lines without
`capture.ly`, with `-dno-print-pages`, five runs. The shapes are
`c5dump.ly` followed by the same line, compared with `c5dump.ly` alone.

```lilypond
\layout { \context { \Score \override Beam.skip-quanting = ##t } }                          % v1
\layout { \context { \Score \override Beam.details.region-size = #1 } }                     % v2
\layout { \context { \Score \override Slur.details.region-size = #1
                            \override PhrasingSlur.details.region-size = #1 } }            % v3
\paper { page-breaking = #ly:minimal-breaking }                                              % v5
```

v4 overrides, in the `Score` context, the `vertical-skylines` of every grob
type whose default in `define-grobs.scm` is
`grob::unpure-vertical-skylines-from-stencil` or
`grob::always-vertical-skylines-from-stencil` (50 types) with
`#(ly:make-unpure-pure-container ly:grob::simple-vertical-skylines-from-extents
ly:grob::pure-simple-vertical-skylines-from-extents)`.

**Edits** (§3): `c5dump.ly` as a settings file on each `edits/<id>-E<n>.ly`
(from that directory, `-dno-print-pages`, `C5_OUT=dump/<id>-E<n>.tsv`), then
`node diff5.mjs <id> <n>`:

```lilypond
%% Chapter 05's dump: after page breaking, one line per system (page, its offset on the
%% page, the moment of its first column) and one line per live grob caused by an event
%% (type, the event's file:line:char, system, X and Y relative to the system, and a shape
%% digest: a beam's positions, a slur's or tie's control points, a stem's length, and the
%% index of the line (VerticalAxisGroup) of the system it is in).
#(begin
  (define c5-port (open-file (or (getenv "C5_OUT") "c5.out") "w"))
  (define (c5-line . xs)
    (display (string-join (map (lambda (x) (format #f "~a" x)) xs) "\t") c5-port)
    (newline c5-port))
  (define (c5-r x) (if (number? x) (/ (round (* x 1000)) 1000.0) x))
  ;; The line (VerticalAxisGroup) a grob is in: its index among the system's lines, or -1.
  (define (c5-line-of g lines)
    (let loop ((p g))
      (cond ((not (ly:grob? p)) -1)
            ((eq? (grob::name p) 'VerticalAxisGroup)
             (let ((tail (memq (or (ly:grob-original p) p) lines))) (if tail (- (length lines) (length tail)) -1)))
            (else (loop (ly:grob-parent p Y))))))
  (define (c5-shape g)
    (let ((n (grob::name g)))
      (cond ((eq? n 'Beam) (let ((p (ly:grob-property g 'positions #f))) (if (pair? p) (list (c5-r (car p)) (c5-r (cdr p))) "")))
            ((memq n '(Slur Tie PhrasingSlur)) (map (lambda (o) (cons (c5-r (car o)) (c5-r (cdr o)))) (ly:grob-property g 'control-points '())))
            ((eq? n 'Stem) (let ((e (ly:grob-extent g g Y))) (list (c5-r (car e)) (c5-r (cdr e)))))
            (else ""))))
  (ly:output-def-set-variable! $defaultpaper 'page-post-process
   (lambda (paper pages)
     (let ((sysno 0))
       (for-each
        (lambda (page pageno)
          (for-each
           (lambda (line)
             (let ((sys (ly:prob-property line 'system-grob #f)))
               (when (ly:grob? sys)
                 (let* ((cols (ly:grob-array->list (ly:grob-object sys 'columns)))
                        (when (if (pair? cols) (ly:grob-property (car cols) 'when #f) #f)))
                   (c5-line "S" sysno pageno (c5-r (ly:prob-property line 'Y-offset 0))
                            (if (ly:moment? when) (ly:moment-main when) "-") (length cols)))
                 (let ((lines (map (lambda (v) (or (ly:grob-original v) v))
                                   (filter (lambda (g) (eq? (grob::name g) 'VerticalAxisGroup))
                                           (ly:grob-array->list (ly:grob-object sys 'all-elements))))))
                 (for-each
                  (lambda (g)
                    (let ((ev (and (grob::name g) (event-cause g))))
                      (when (ly:stream-event? ev)
                        (let ((o (ly:event-property ev 'origin #f)))
                          (when (ly:input-location? o)
                            (let ((l (ly:input-file-line-char-column o)))
                              (c5-line "G" (grob::name g) (format #f "~a:~a:~a" (basename (car l)) (cadr l) (caddr l))
                                       sysno (c5-r (ly:grob-relative-coordinate g sys X))
                                       (c5-r (ly:grob-relative-coordinate g sys Y)) (c5-shape g) (c5-line-of g lines))))))))
                  (ly:grob-array->list (ly:grob-object sys 'all-elements))))
                 (set! sysno (1+ sysno)))))
           (ly:prob-property page 'lines '())))
        pages (iota (length pages))))
     (force-output c5-port))))
```

```js
// diff5.mjs <id> <n>: what edit E<n> of chapter 00 §6.2 changes in the layout of score <id>, from
// c5dump.ly's dumps of E0 and E<n>. A grob is keyed by type, its event's file:line:char (moved back
// over text the edit inserted) and its ordinal among equal keys; it changed if it moved by more than
// 0.001 staff spaces in its system, changed shape, or changed system.
import { readFileSync } from 'node:fs'
const [id, n] = process.argv.slice(2)
const src0 = readFileSync(`edits/${id}-E0.ly`, 'utf8'), srcN = readFileSync(`edits/${id}-E${n}.ly`, 'utf8')
let p = 0; while (p < src0.length && src0[p] === srcN[p]) p++
const ins = srcN.length - src0.length
const before = src0.slice(0, p).split('\n'); const eLine = before.length, eChar = before.at(-1).length
function read(file, shift) {
  const sys = [], grobs = new Map()
  for (const l of readFileSync(file, 'utf8').trim().split('\n')) {
    const f = l.split('\t')
    if (f[0] === 'S') sys.push({ page: +f[2], y: +f[3], at: f[4], cols: +f[5] })
    else if (f[0] === 'G') {
      let [file, line, ch] = f[2].split(':'); file = file.replace(/-E\d\.ly$/, '.ly'); line = +line; ch = +ch
      if (shift && line === eLine && ch >= eChar) { if (ch < eChar + ins) { ch = 'new' + ch } else ch -= ins }
      let k = f[1] + '|' + file + ':' + line + ':' + ch, i = 0
      while (grobs.has(k + '#' + i)) i++
      grobs.set(k + '#' + i, { type: f[1], sys: +f[3], x: +f[4], y: +f[5], shape: f[6] ?? '', line: +(f[7] ?? -1), ch })
    }
  }
  return { sys, grobs }
}
const a = read(`dump/${id}-E0.tsv`, false), b = read(`dump/${id}-E${n}.tsv`, true)
const changedSys = new Set(), hSys = new Set(), cells = new Set(); let moved = 0, movedX = 0, added = 0, removed = 0
for (const [k, g] of a.grobs) {
  const h = b.grobs.get(k)
  if (!h) { removed++; changedSys.add(g.sys); cells.add(g.sys + '/' + g.line); continue }
  const dx = Math.abs(g.x - h.x), dy = Math.abs(g.y - h.y)
  if (g.sys !== h.sys || dx > 0.001 || dy > 0.001 || g.shape !== h.shape) {
    moved++; changedSys.add(g.sys); cells.add(g.sys + '/' + g.line)
    if (g.sys !== h.sys || dx > 0.001) { movedX++; hSys.add(g.sys) }
  }
}
for (const [k, h] of b.grobs) if (!a.grobs.has(k)) { added++; changedSys.add(h.sys); cells.add(h.sys + '/' + h.line) }
const allCells = new Set([...a.grobs.values()].map((g) => g.sys + '/' + g.line))
const inCells = [...a.grobs.values()].filter((g) => cells.has(g.sys + '/' + g.line)).length
const breaks = (s) => s.map((x) => x.at).join(',')
console.log(JSON.stringify({ id, edit: 'E' + n, systems: [a.sys.length, b.sys.length], breaks: [breaks(a.sys), breaks(b.sys)],
  systemsChanged: [...changedSys].sort(), systemsMovedX: [...hSys].sort(), cells: `${cells.size}/${allCells.size}`,
  grobsInChangedCells: inCells, grobs: a.grobs.size, moved, movedX, added, removed }))
```
