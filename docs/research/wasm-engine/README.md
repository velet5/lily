# An engine of our own: findings and roadmap

The investigation into a small LilyPond of our own, compiled to WebAssembly,
that parses the whole syntax, runs a score's Scheme, and writes SVG, PDF and
MIDI in the browser. Chapters 00–09 measured and designed it. This page
merges them: what they concluded (§2), the speed factors the phones gave
(§3), a size, speed and memory budget for every module (§4), the milestones
that build it, with effort, gates and test coverage (§5–§7), and the risks
(§8). [D56](../../DECISIONS.md) records the decision to build it.

The reference throughout is LilyPond 2.26.0 at tag `v2.26.0` (commit
`3596756be0fac1f81066a99d2054329212172b2d`) and chapter 00's 30 test scores
T01–T30. KB is 1,000 bytes. *Android* and *iOS* mean chapter 00 §1's
reference devices (Galaxy A54 class with Chrome; iPhone 12 with Safari 17 or
later). Nothing on this page is newly measured. Each figure cites the
chapter that measured or projected it, and §3 explains the re-projections.

## 1. The chapters

| Chapter | Subject | What it found |
| --- | --- | --- |
| [00](00-budgets.md) | Budgets and the test set | B1–B10 for the phones; 30 scores; a comparator with layers C0–C4 against LilyPond's own output; LilyPond re-renders T02 in 0.32 s and T29 in 0.91 s warm on the desktop, so a phone needs an engine that recomputes only what an edit changes |
| [01](01-reference-map.md) | LilyPond's source, mapped | 450 C++ files (113,000 lines) in eight modules of ours; what the 30 scores reach: 59 of 131 music types, 82 of 167 grobs, 48 of 199 markup commands |
| [02](02-parser.md) | Parser | a hand-written recursive-descent parser, steps P1–P12, re-parsing by toplevel item and braced block; a syntax corpus (`syntax.ly`) and an error corpus of 30 cases with LilyPond's stderr |
| [03](03-scheme.md) | Scheme | an interpreter of our own in Rust: 59 KB brotli as a prototype, as fast as s7 and 3–5 times Guile's interpreter; s7 as the fallback; LilyPond's Scheme as a heap image plus seven parts loaded on demand |
| [04](04-music-model.md) | Music model | frozen music trees, contexts, iterators and translators in Rust; checkpoints and convergence, then partitions, so an edit re-runs a few timesteps; steps N1–N8 |
| [05](05-layout.md) | Layout | LilyPond's cheaper switches save at most 6.4 % and cost fidelity, so the engine ports its searches and gets speed from doing less work per edit: cells as the unit of re-layout, the visible page first; steps Y1–Y8 |
| [06](06-output.md) | SVG, PDF, fonts | Emmentaler, not Bravura; each glyph once per page in `<defs>`, 47 % of LilyPond's bytes; font packs per optical size; PDF as a separate module of 75–90 KB; steps W1–W8 |
| [07](07-midi.md) | MIDI and playback | performers on chapter 04's translators; a writer byte-equal to LilyPond's on 39 of 42 files; oscillators stay the sound; steps M1–M8 |
| [08](08-integration.md) | Build, modules, worker, caching | the size profile (14–26 % smaller in brotli than chapter 03's builds); a core plus three kinds of module; one dedicated worker that steps the engine; Cache Storage and hashed names; Lily Studio on the web as the first host; steps K1–K7 |
| [09](09-spike.md) | A spike timed on phones | 3,348 lines of engine-shaped Rust: 38 KB brotli; on the devices cold start 111–297 ms, a one-page re-render in one frame, 1.7 MiB of memory; the Android CPU is slower than chapter 00 assumed, and the page, not the engine, fails B7 |

## 2. What the investigation concluded

D56 records these choices. Each was the result of a chapter's measurements:

1. **Our own engine, not LilyPond compiled.** LilyPond with Guile by
   Emscripten is 3.5 MB of brotli wasm and a 15.9 MB data file (03 §4.4):
   ten times B1. It also needs wasm exception handling, which chapter 00
   §1.1 leaves out. Rust, `wasm32-unknown-unknown`, `no core::fmt` on any
   core path (09 §2.1).
2. **Fidelity to LilyPond, checked by the comparator.** The engine matches
   LilyPond 2.26's output layer by layer: C0 diagnostics, C1 events, C2
   MIDI, C3 breaks, C4 positions, and C5 beam and slur shapes, which chapter
   05 §9 adds. It ports LilyPond's algorithms with their parameters and
   approximates none of them (05 §2.4).
3. **The whole syntax, with a hand-written parser** that re-parses only
   the edited item and block (02 §5.7).
4. **A Scheme interpreter of our own** with Guile's spellings and error
   texts, a precise collector, a heap image, versioned globals and an undo
   log (03 §3, §4.5). s7 is the fallback.
5. **Speed per edit from incrementality**: checkpoints and convergence in
   translation, partitions for large scores (04 §10, both (a) and (b) of
   §10.7), cells for layout (05 §6), markup kept per cell (06 §6.3).
6. **Emmentaler** as the music font, in packs per optical size; glyph
   skylines computed at first use (06 §4, §5.1).
7. **SVG in the form the apps read today**, glyphs defined once, links as
   LilyPond writes them; **PDF as a separate module** fetched at the first
   export, with its own CFF subsetter (06 §7.3).
8. **MIDI in the core**, performed after the page; oscillators as the
   sound, with an optional sample pack belonging to the player, not the
   engine (07 §5.6, 08 §2.2).
9. **One dedicated worker, no threads**, a C ABI stepped by the driver;
   modules of three kinds (data, own memory, split from the linked core by
   call graph); Cache Storage with hashed names, no service worker (08).
10. **Lily Studio on the web is the first host**, with the server's
    LilyPond as the fallback for any compile the engine cannot do (08 §7).

## 3. Projection factors

Chapters 00–07 projected desktop timings onto the Android reference at
0.45× the M1 Max, times 1.5 for wasm. Chapter 09 timed the devices (09
§5.1) and this roadmap uses its factors from here on, which is chapter 09's first step (H1, §5):

| Work | Android reference | iOS reference |
| --- | --- | --- |
| Interpreter loops (Scheme) | **0.38×** the M1 in wasm | **0.7×** (A13; conservative for the A14) |
| Code that allocates and builds outputs (translation, layout, writers) | **0.25×** | 0.7× |
| The page's DOM work | about 0.1× | about 1× |

So a desktop native time is multiplied by about **6** for the Android
reference (1.5 / 0.25), not 3.3. That is 1.8 times the chapters' figures,
and 1.18 times for Scheme. Every *now* figure of §4 is re-projected this
way. iOS's budgets are 0.6 times Android's while its device is 2.8 times as
fast on the engine's code, so **Android is the binding platform**
everywhere except memory, where iOS kills the tab (00 §1).

## 4. Budgets per module

Chapter 00's B1–B10 stand as they are. This section shares them out among
the modules for good, as chapter 00 §7 asked. *Must* gates a milestone: a
miss blocks shipping the module that caused it. *Goal* is what to design
for. *Owner* is the chapter that designs the module.

### 4.1 Download and code size (B1, B3)

The chapters' Musts summed to 1,720 KB against B1's 1,500 (08 §2.1). The
shares below sum to 1,475 KB (Must) and 995 KB (Goal). Brotli KB:

| Part | Kind | Owner | Must | Goal | Chapters asked (Must / Goal) | Estimated now |
| --- | --- | --- | --- | --- | --- | --- |
| Driver, ABI, diagnostics, Rust runtime | code | 08 | 30 | 20 | — | the spike's frame, 38 KB with its toy engine (09 §2.1) |
| Parser | code | 02 | 80 | 55 | ≈ 110 / 70 | — |
| Scheme interpreter | code | 03 | 190 | 140 | 250 / 180 | 120–160 (03 §4.2, less 08's 15 %) |
| Core image | data | 03 | 420 | 280 | 450 / 300 | 300–450 (03 §5.6) |
| Music model: values, music, contexts, iterators, translators | code | 04 | 160 | 110 | 180 / 120 | 130–165 |
| Layout and the core's notation, with their E1–E4 engravers | code | 05 | 400 | 260 | 450 / 300 | ≈ 365 |
| SVG writer and text shaping | code | 06 | 40 | 25 | — | — |
| MIDI performers and writer | code | 07 | 45 | 30 | 150 / 40 as a module | 30–40 (07 §4.2) |
| Fonts: Emmentaler-20 and three text metric packs | data | 06 | 100 | 70 | 120 / 80 | ≈ 70 (06 §5.2) |
| Worker script | JS | 08 | 10 | 5 | 10 / 5 | 3.0 measured (09 §2.1) |
| **Sum** | | | **1,475** | **995** | 1,720 / 1,095 without parser and writer | 1.05–1.3 MB (08 §2.1) |
| **B1** | | | **1,500** | **1,000** | | |

Uncompressed code (B3, 4 MB Must, 2.5 MB Goal), raw KB of `core.wasm`:
driver 80 / 50, parser 210 / 145, interpreter 500 / 380, music 420 / 290,
layout 1,100 / 700, SVG 110 / 70, MIDI 120 / 80. That sums to **2,540 /
1,715**, inside B3 with room, at the 0.38 brotli bytes per raw byte the
spike measured.

**How it is checked.** K1's build attributes each function of the
`wasm-names` build to its crate by the name's prefix, as 09 §2.1 did. It
fails when a crate exceeds its Must, or when a name contains `core::fmt::`
(step H4). The image and the packs are files and are checked by their size.

**The image decides B1's Goal.** It is the largest item and the least
certain one. At its 450 KB upper estimate the core comes to about 1.3 MB
(08 §2.1): inside B1's Must, not its Goal, which needs the image near its
280 KB. MS1 measures it first (§5).

### 4.2 Modules on demand (B2)

| Module | Kind (08 §2.2) | Must | Goal | Now |
| --- | --- | --- | --- | --- |
| Each Scheme part: `chords`, `display`, `fretted`, `diagrams`, `partcombine`, `modal`, `qr` | data | 100 | 30 | 3–21 KB of source (03 §6) |
| `syntax-case` | split | 40 | 20 | 20–35 KB raw (03 §4.2) |
| Each notation module: `chord-names`, `tablature`, `figured-bass`, `ambitus`, `pedals`, `percent` | split | 100 | 40 | — |
| Each Emmentaler optical size | data | 60 | 40 | ≈ 35 (06 §4) |
| `braces`, one pack (08 §2.4) | data | 25 | 15 | 20.7 |
| Each further text metric pack | data | 20 | 12 | ≈ 11 |
| `pdf`, without its text fonts | own memory | 500 | 100 | 75–90 projected; 52 without subsetting (06 §7) |
| Cost of splitting a module out of the core | — | 3 % | 2 % | 1.9 % (08 §2.3) |

The PDF module's text fonts are fetched with it, per style the score uses,
as the font files are (C059 Roman: 63 KB). The optional sample piano of 07
§5.6 (1 MB download, 16 MB decoded, Must) belongs to the player.

### 4.3 Re-render after an edit (B6), by phase

The provisional split of 00 §2.1, revised by what chapter 09 measured: the
page's side costs more, the SVG writer less. Milliseconds on the Android
reference. Engine phases may take twice these for E2 (reflow), as 00 §2
allows. iOS gets 0.6 times each figure.

| Phase | Owner | S Must | S Goal (p50) | L Must | L Goal (p50) | Now, re-projected (§3) |
| --- | --- | --- | --- | --- | --- | --- |
| Parse and re-parse | 02 | 20 | 8 | 40 | 15 | the spike: 0.7 ms for 532 events, Scheme included (09 §4.3) |
| Scheme in music functions and callbacks | 03 | 15 | 5 | 30 | 10 | a full compile of a median S score: 6–22 ms |
| Translation | 04 | 25 | 8 | 50 | 20 | S: E1 and E3 0–3, E2 6–47; L with partitions: E1 0–14, E2 29–106 |
| Layout | 05 | 120 | 40 | 240 | 80 | S: 11–103; L: E1 18–49, E2 252 (T24), **650 (T29)** as a straight port |
| SVG writing | 06 | 20 | 7 | 40 | 15 | 7.3 ms for four pages of L532 on the tablet (09 §4.3) |
| The page: transfer, parse and insert the changed pages | page | 50 | 25 | 50 | 30 | 17 ms for one page (one frame); about 25 ms per 45 KB page on the tablet |
| Reserve | | 0 | 7 | 50 | 30 | |
| **B6** | | **250** | **100** | **500** | **200** | |

Two rows miss: layout of T29's E2 as a straight port (650 against 480), and
translation of T24's E2 (106 against 100). This is risk R1 (§8), which MS3
and MS6 test. The page's 50 ms holds only if it updates one
changed page per task (step H2); four pages at once took 95–105 ms on the
tablet (09 §4.4).

### 4.4 Whole-score and per-unit budgets

Re-projected at §3's factors. B5b names only T02, whose first render
projects to about 110 ms of engine time (translation 18, layout 70, Scheme
and parse the rest) against 800.

| What | Owner | Must | Goal | Now, re-projected |
| --- | --- | --- | --- | --- |
| First full parse, Android | 02 | T02 40 ms, T29 150 ms | 10, 80 | — |
| Lexer and parser, native | 02 | 50 MB/s | 100 MB/s | — |
| One Scheme application, Android | 03 | 200 ns | 80 ns | 66–224 ns |
| Image restore (part of B5a) | 03 | 50 ms | 20 ms | 2 MiB copied in 0.2–1 ms on the M1 (08 §3.1) |
| Collector pause | 03 | 10 ms | 3 ms | — |
| Translation of a whole score, S / L | 04 | 60 / 250 ms | 20 / 100 | 3–99 / 58–310 |
| Layout of a whole score, S / L | 05 | 150 / 500 ms | 50 / 200 | 7–232 / 83–715 as a straight port |
| Layout per live grob | 05 | 120 µs | 40 µs | **209 µs** as a straight port (05 §8 × 1.8) |
| Longest step between cancellation checks | 05 | 20 ms | 5 ms | 17.3 ms in the spike (09 §4.5) |
| Performance and file after an edit, T29 (off B6) | 07 | 300 ms | 100 ms | ≈ 190 ms |
| One playback scheduling tick (part of B7) | 07 | 10 ms | 5 ms | ≈ 4.5 ms (07 §6; JavaScript, not re-projected) |
| Audio thread at peak polyphony, Android floor | 07 | 50 % of a core | 25 % | ≈ 21 % (07 §6; the browser's code, not re-projected) |
| Engine's part of B5a, cached | 08 | 100 ms | 30 ms | 27 ms (tablet), 12 ms (iPhone SE) measured (09 §4.1) |
| New instance after a trap | 08 | 20 ms | 5 ms | under 3 ms on the M1 |
| B8: newer edit to old compile stopped | 08 | 50 ms | 20 ms | ≤ 11 ms measured on both devices |
| One page parsed and inserted on the main thread (B7) | page | 50 ms | 20 ms | about 25 ms per 45 KB page on the tablet |
| B10: SVG bytes of a page against LilyPond's | 06 | ≤ 100 % | ≤ 50 % | 39–80 % per page, 47 % over the corpus (06 §3.3); 35–43 % in the spike (09 §4.7) |
| Exported PDF against LilyPond's | 06 | ≤ 150 % | ≤ 110 % | — |
| Restarts for a missing module, the 30 scores with triggers | 08 | 0 | 0 | — |

### 4.5 Memory (B4)

B4's Musts are 64 MB (S) and 128 MB (L) with a declared maximum of 256 MiB.
The shares below are what each module designs for, in MB. With chapter
03's Goal of 8 MB for the heap after init they sum to 28 and 56, under B4's
Goals. With its Must of 16 MB they sum to 36 and 64: 4 MB over the S
Goal, and still well inside both Musts.

| Part | Owner | S | L | Now |
| --- | --- | --- | --- | --- |
| Scheme heap after init | 03 | 8 | 8 | — |
| Scheme heap's growth during a compile | 03 | 4 | 12 | — |
| Pristine image kept for the reset | 03 | 3 | 3 | 1.5–2.5 MB estimated |
| Parse records | 02 | 1 | 2 | ≤ 2 MB for T29 estimated |
| Music, translation, checkpoints; old and new run | 04 | 2 | 8 | ≤ 4 MB for T29 estimated |
| Layout; old and new during an edit | 05 | 2 | 8 | ≤ 2.2 MB for T29 estimated |
| SVG writer's kept markup | 06 | 1 | 4 | 0.5 MB for T29 |
| MIDI performance and file | 07 | 1 | 2 | — |
| Outputs being copied out, allocator slack | 08 | 2 | 5 | — |
| The worker's JS heap | 08 | 4 | 4 | not measured (09 §7) |
| **Sum** | | **28** | **56** | the spike: 1.2–1.7 MiB of linear memory |
| **B4 Goal / Must** | | 32 / 64 | 64 / 128 | |

## 5. Milestones

Nine milestones, MS0–MS8. Each lists the chapters' steps it contains, what
it needs first, the gate that ends it, the budgets it must show on the
phones, its effort and its risks. The step names are the chapters' own:

| Prefix | Chapter | Steps |
| --- | --- | --- |
| P | 02 parser | P1–P12 (02 §6) |
| S | 03 Scheme | S1–S6, defined below from 03 §5–§6, which had no ordered list |
| N | 04 music model | N1–N8 (04 §13) |
| Y | 05 layout | Y1–Y8 (05 §10) |
| W | 06 output | W1–W8 (06 §9) |
| M | 07 MIDI | M1–M8 (07 §7) |
| K | 08 build | K1–K7 (08 §9) |
| H | 09 spike | H1–H6, which chapter 09 §8 calls P1–P6; renamed here to keep them apart from the parser's |

The Scheme steps:

- **S1** Values and heap: 8-byte values, typed arenas, the precise
  mark-sweep collector with Rust-declared roots, fixnums, bignums, exact
  rationals, flonums, UTF-8 strings with the ASCII flag; allocation epochs
  per chunk (03 §5.1).
- **S2** Reader and evaluator: the reader at a byte offset with `#{ … #}`
  as a template, the compiler to bytecode, the VM loop with its own stacks
  (proper tail calls, no wasm stack), multiple values, `*location*`,
  `catch`/`throw`, escapes, `dynamic-wind`, parameters, fluids, the cancel
  check, and Guile 3's error texts (03 §5.2–5.3).
- **S3** Globals, modules and macros: slots with versions, Guile's module
  forms, `syntax-rules`, `defmacro`, `define*`/`lambda*`, LilyPond's
  definers as native forms, and the primitives of 03 §2.6 (03 §5.4–5.5).
- **S4** The image: a native build that loads the core Scheme and runs the
  init, writes the heap with indices instead of pointers, and `lily_start`,
  which restores it (03 §5.6; this is K3).
- **S5** Undo for re-parsing: dependency tracking on global reads, the
  write barrier and the undo log by epoch, turned on (03's requirements R10
  and R11). S1–S3
  design them in; MS6 uses them.
- **S6** The parts on demand of 03 §6: compiled, fetched by trigger, loaded
  into the heap; the full `ice-9 format`, `pretty-print`, a record in place
  of GOOPS, arrays.

### MS0 — Ground work, before the engine

Everything that needs no engine, so that each later milestone has its
measuring tools on day one.

- **Steps.** K1: the engine's Cargo workspace as `packages/engine`, one
  crate per module, 08 §1.3's profiles, the pinned nightly in its own
  `rust-toolchain.toml`, `--max-memory`, the build into `dist/engine/` with
  its manifest, and the size gate of §4.1. The spike moves there and stays
  the harness's engine. H4, the `core::fmt` check. H5, the files
  precompressed at build. H6, the harness on an iPhone 12 or later over
  trusted HTTPS and on an A15-class Android phone. H2: the studio's page
  replaces only the pages that changed, the visible one first, one page
  per task. This helps LilyPond's output today too. M1: the SMF crate,
  shared with `crates/session/src/midi_export.rs`. W1: Emmentaler's eight
  sizes, the braces and the text metric packs. W2: skylines from outlines.
  The comparator gains C5 (beam and slur shapes, 05 §9) and C2b (byte
  equality), and the corpus gains M01–M12 (07 §2.3). M8: playback on the
  phones through `midi.js`.
- **Needs.** Nothing.
- **Gate.** The size gate runs on every engine build. W1's packs within §4.2,
  every glyph's extent equal to LilyPond's. W2's 663 skylines point for
  point. M1 byte-equal on 39 of 42 files, the other three explained (07
  §4.2). No main-thread task over 50 ms with L532 on the tablet (B7). On a
  real iPhone: Cache Storage after a reload, the worker's JS heap, B5c
  throttled. The M8 questions about the silent switch, interruptions and
  background tabs answered on both phones.
- **Effort.** About 3,500 lines (2,500 Rust, 1,000 TypeScript and
  JavaScript); 4–5 engineer-weeks.
- **Risks.** R6 (the page and B7), R7 (iOS unknowns), R8 (toolchain).

### MS1 — The Scheme core

Chapter 03 §7's first milestone, with what it needs of the parser and the
music values to read LilyPond's init files.

- **Steps.** S1–S4. P1–P5: sources, notes, identifiers, embedded Scheme,
  music functions and output blocks, enough for `music-functions-init.ly`'s
  assignments. N1: pitches, durations, moments and rationals as foreign
  objects with their `ly:` functions.
- **Needs.** MS0's K1.
- **Gate.** `lily-library.scm`, `music-functions.scm` and
  `music-functions-init.ly` run from an image, natively and in wasm, with
  the same results. Chapter 03's benchmarks b1–b8 give their expected
  output. The 22 error-corpus cases of P1–P5 pass C0, those of Scheme
  (21–23) worded as Guile 3 words them.
- **Budgets on the phones.** Interpreter ≤ 500 KB raw and 190 KB brotli.
  Image of what has loaded so far measured and extrapolated to the full
  init against 420 KB. Restore ≤ 50 ms. One application ≤ 200 ns on the
  Android device. Collector pause ≤ 10 ms. Heap after init ≤ 16 MB.
- **Decision point.** A miss of more than twice on the interpreter's size
  or speed brings back s7 (03 §4.5), and MS1 is planned again.
- **Effort.** 10,500–13,000 lines; 11–13 engineer-weeks.
- **Risks.** R2 (image size), R3 (Scheme speed and fidelity).

### MS2 — Music to events (C1)

- **Steps.** P6–P11: contexts and properties, markup, lyrics, repeats,
  the chord, drum and figure modes, templates and `\include`. N2–N7:
  frozen music, contexts, iteration, the translator framework with the
  playback map's performer, grace notes and context changes, volta repeats
  and lyrics. The image of the whole of `declarations-init.ly` (S4). K2:
  the ABI of 08 §4.2 over the parser and the music, run by the unchanged
  driver; the outputs `stderr` and `diagnostics.json` (08 §6).
- **Needs.** MS1.
- **Gate.** C1 = 1.0 on all 30 scores. C0 on T03 and the 30 error cases.
  `syntax.ly` parses with no error, and its token sequence equals LilyPond's
  `-ddebug-parser` trace. Translation traces per context and timestep equal
  04 Appendix A's. The corpus runs through the worker in Node (K2).
- **Budgets on the phones.** First full parse of T02 and T29. Parser ≤ 210
  KB raw. Music ≤ 420 KB raw. The full image ≤ 420 KB brotli. Translation of
  whole scores against §4.4.
- **Effort.** 11,000–14,000 lines; 11–14 engineer-weeks.
- **Risks.** R2, R4 (the long tail of features).

### MS3 — First engraving: one staff to pages

- **Steps.** W3: the SVG writer in file form, links as LilyPond writes
  them. W5: packs on demand. Y1–Y3: grobs and properties, spacing, the
  common notation, skylines and outside-staff placement, line and page
  breaking, titles. The E1–E4 engravers of those grobs.
- **Needs.** MS2; W1 and W2 from MS0.
- **Gate.** C3 and C4 pass on the 10 scores Y1–Y3 lay out (T01, T03, T05,
  T10, T13, T14, T16, T17, T18, T19). B10 on them. W3's pixels against
  LilyPond's pages, as 06 §3.3.
- **Budgets on the phones.** **Layout per live grob ≤ 120 µs on the
  Android device**, measured on these scores. B5b on T02 when it passes
  (MS4). The SVG phase against §4.3.
- **Decision point.** The straight port projects to 209 µs a grob (R1). A
  measured cost above 120 µs here means 05 §5's cheaper machinery (no
  property alists, glyph skylines once, indexed outside-staff skylines) is
  built before MS4's notation, not after.
- **Effort.** About 13,500 lines; 13–15 engineer-weeks.
- **Risks.** R1 (layout cost), R4.

### MS4 — The whole corpus engraved

- **Steps.** Y4–Y6: beams with quanting, slurs, ties, tuplets, lyrics,
  figured bass, tablature. W6: text shaped from the metric packs, and
  `OffscreenCanvas` for scripts no pack covers. K4: `wasm-split` by call
  graph, for the first notation modules that leave the core, and their
  triggers. S6 for `fretted` and `chords`.
- **Needs.** MS3.
- **Gate.** C3 and C4 on all 30 scores. C5 on the nine with beams or slurs
  (T08, T11, T12, T23–T26, T29, T30), Must ≤ 0.25 staff spaces at p95. Each
  of the 30 compiles with only its triggered modules and no restart, and
  a module left out gives a restart, not a different result.
- **Budgets on the phones.** B5b on T02. Whole-score layout against §4.4.
  The core's size against §4.1, every crate in its share.
- **Effort.** About 12,000 lines; 12–14 engineer-weeks.
- **Risks.** R1, R4, R11 (text measured by the browser).

### MS5 — MIDI

- **Steps.** M2–M6: the performer framework, dynamics with the equalizer,
  controllers and tempo, marks, drums and channel mappings,
  `\unfoldRepeats` and `articulate.ly` as a library part.
- **Needs.** MS2 (N5, N7) and M1. It runs beside MS3 and MS4.
- **Gate.** C2 = 1.0, velocities included, on the 30 scores and M01–M12.
  C2b on all 42, ties at one tick normalised. C1 against `timing.ly`'s map.
- **Budgets on the phones.** MIDI ≤ 120 KB raw and 45 KB brotli in the
  core. T29's performance after an edit ≤ 300 ms.
- **Effort.** 3,000–3,500 lines; 3–4 engineer-weeks.
- **Risks.** None beyond R4.

### MS6 — Only what an edit changes

- **Steps.** S5. The re-parse of 02 §5.7. N8: checkpoints and convergence
  first, then partitions and replay. Y7: digests, cells, the line and page
  DPs updated, the queue of 05 §7 with sub-steps. W4: markup kept per grob
  and cell. W8: the cell-replacing message in the preview. H3: the engine
  returns between systems, never once per compile.
- **Needs.** MS4 and MS5. Y7 needs a layout from scratch to compare with.
- **Gate.** Differential tests: an incremental compile equals one from
  scratch, on chapter 00's edits E1–E3 and on random edits of the 30
  scores, in every layer C0–C5. B6 on T02, T12, T24 and T29 with E1–E3, 20
  of each (00 §6.2), on both phones, phase by phase against §4.3. B8 with a
  26-page score. Memory with the old and new run against §4.5.
- **Effort.** 7,000–9,000 lines; 10–14 engineer-weeks, at a slower rate
  than a port, since the code has no LilyPond counterpart.
- **Risks.** R1 (T29's reflow in layout, T24's in translation), R5
  (incremental bugs).

### MS7 — In Lily Studio on the web

The integration milestone of 08 §7. The engine starts shipping here.

- **Steps.** K5: `Cache-Control` in D55's gateway, `persist()` after use,
  the debug build. K6: `engine.js`, live preview in the page, the server's
  live compiles off while the engine runs, the server as fallback for every
  compile the engine fails or cannot do. M7: the performance after the
  page, cancellable, `.midi` and the map posted as today, Export MIDI from
  the engine's bytes. K7: the full measurement of 00 §6 on the reference
  devices.
- **Needs.** MS6. K6 can run behind a flag (`?engine=1`) from MS4 on, for
  use while MS5 and MS6 are built; the fallback keeps the web at least as
  good as D55.
- **Gate.** D55's tests pass with the engine and with the engine refused.
  The page is driven end to end with the engine in Chromium and WebKit. A
  second visit downloads only the manifest. Rendering goes on when the
  network drops. Every budget B1–B10 on the iOS and Android references, and
  B4 and "no killed tab" on the Android floor.
- **Effort.** 2,000–3,000 lines; 3–4 engineer-weeks.
- **Risks.** R7.

### MS8 — Beyond the corpus

- **Steps.** W7, the PDF module, which can start any time after MS3's W3.
  Y8: the grobs no score reaches, by how common they are in real scores
  (`KeyCancellation`, `RehearsalMark`, `TextMark`, `PhrasingSlur`,
  `RepeatTie` first), then ancient notation and the other breakers. P12.
  The four iterators no score reaches (part combiner, quotes, percent
  repeats, `\fine`). S6's remaining parts and `syntax-case`. Each feature
  comes with a new test score from LilyPond's `input/regression/`, as 00 §4
  asks: one that covers something none of the others does.
- **Needs.** MS4 for Y8; MS3 for W7.
- **Gate.** For PDF: page count, rasterised against the engine's own SVG
  with pdf.js, lyrics and titles extracted as text, the module within §4.2,
  the file within 150 % of LilyPond's. Then Export PDF on the web comes from
  the engine. For each new score: C0–C5 as for the 30.
- **Effort.** 17,000–18,500 lines; 17–19 engineer-weeks.
- **Risks.** R4, R9 (fonts in the PDF module).

### 5.1 Order and effort

```
MS0 ─ MS1 ─ MS2 ─┬─ MS3 ─ MS4 ─┬─ MS6 ─ MS7
                 └─ MS5 ───────┘
                       MS3 ─ MS8 (W7); MS4 ─ MS8 (Y8 and the rest)
```

| Milestone | Steps | Lines | Engineer-weeks | Ends with |
| --- | --- | --- | --- | --- |
| MS0 | K1, H2, H4–H6, M1, M8, W1, W2, C5, C2b | 3,500 | 4–5 | tools, phones, packs |
| MS1 | S1–S4, P1–P5, N1 | 10,500–13,000 | 11–13 | the init files from an image |
| MS2 | P6–P11, N2–N7, K2 | 11,000–14,000 | 11–14 | C1 on 30 |
| MS3 | W3, W5, Y1–Y3 | 13,500 | 13–15 | C3, C4 on 10 |
| MS4 | Y4–Y6, W6, K4, S6 in part | 12,000 | 12–14 | C3–C5 on 30 |
| MS5 | M2–M6 | 3,000–3,500 | 3–4 | C2 on 42 |
| MS6 | S5, re-parse, N8, Y7, W4, W8, H3 | 7,000–9,000 | 10–14 | B6 on the phones |
| MS7 | K5–K7, M7 | 2,000–3,000 | 3–4 | shipped on the web |
| MS8 | W7, Y8, P12, iterators, S6 | 17,000–18,500 | 17–19 | PDF, the long tail |
| **Total** | | **80,000–90,000** | **84–102** | |

The lines come from the chapters' estimates: the interpreter 8,000–12,000
(03 §4.2), music 8,000–10,000 (04 §12), layout about 34,000 (05 §9), and the
spike's 30 raw bytes a line against 08 §2.1's core of 1.5–1.8 MB (09 §2.1).
The weeks assume 1,000 lines a week of ported, tested Rust, and 700 for MS6.
The rate is an assumption: MS1 measures it, and the plan is re-estimated
then. Through MS7, which ships the engine for the 30 scores' kind of music,
it is 63,000–72,000 lines and 67–83 weeks for one engineer. The critical
path, MS0–MS4, MS6 and MS7, is 64–79 of those weeks; a second engineer takes
MS5, W7 and the Scheme parts off it.

## 6. Test coverage

What each milestone must pass, per comparator layer, on chapter 00's 30
scores, 07's M01–M12 and 02's 30 error cases. Counts are cumulative and
every later milestone keeps them.

| Layer | MS0 | MS1 | MS2 | MS3 | MS4 | MS5 | MS6 | MS7 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| C0 diagnostics | — | 22 of 30 error cases | T03 and all 30 | | | | incremental too | from the page |
| C1 events | — | — | 30 | | | | incremental too | |
| C2 MIDI, with velocities | — | — | — | | | 42 | incremental too | Export MIDI |
| C2b MIDI bytes | 39 of 42 (M1) | | | | | 42 | | |
| C3 breaks, C4 positions | — | — | — | 10 | 30 | | incremental too | |
| C5 shapes | in the comparator | — | — | — | 9 | | incremental too | |
| Phones (09's harness) | the spike on the reference devices | b1–b8, image restore | first parse | µs a grob | B5b, sizes | T29 performance | B6, B7, B8 | B1–B10 |

Besides the layers:

- **The size gate** (K1) on every build from MS0, per crate.
- **Differential tests.** Native against wasm (MS1 on). The parser's token
  sequence against `-ddebug-parser`, translation traces against 04
  Appendix A (MS2). An incremental compile against one from scratch on
  scripted and random edits (MS6).
- **The phone gate.** Chapter 09's crate and harness measure each
  milestone's build on the devices, with the spike's frame (45 KB brotli,
  27 ms to ready on the tablet, 1–3 ms of compile) as the baseline the
  engine adds to.
- **The apps' own tests.** `test/engine.test.ts` for the driver (08 §4.6),
  D55's server tests and the page driven in Chromium and WebKit (MS7), the
  extension's preview tests and the studio's playback tests on the engine's
  output (M7).
- **Tests that need lilypond** skip without it (AGENTS.md). The reference
  captures are LilyPond 2.26.0's, made with `capture.ly` (00 Appendix A).
  A milestone that ran with captures skipped has not passed its gate.

## 7. What each module may leave out

| Module | Leaves out until MS8, or for good | Because |
| --- | --- | --- |
| Parser | P12's init-only forms | no score uses them |
| Scheme | full `call/cc`, threads, R6RS, Guile's compiler, POSIX processes, `syntax-case` in the core | 03 §2.6 |
| Music | the part combiner, quotes, percent repeats, `\fine`; 58 music types | 01 §5 |
| Layout | E5 ancient ligatures, page-turn and other breakers, 84 grobs | 01 §5, 05 §5.10 |
| Output | SMuFL fonts; markup commands beyond the 48 the scores use, diagrams, QR codes | 06 §4; on demand later |
| MIDI | performers of events no score reaches | 07 §7 |
| Build | threads, a service worker, Firefox | B9; 08 §5.5; 09 §7 |

A score that needs something left out compiles on the server's LilyPond
(08 §7), so leaving a feature out is a matter of speed, not of a wrong page.

## 8. Risks

| # | Risk | Evidence | Mitigation | Decided at |
| --- | --- | --- | --- | --- |
| R1 | Layout and translation are too slow on Android: a straight port of layout projects to 209 µs a grob against 120, T29's reflow to 650 ms against 480, and translation of T24's reflow to 106 ms against 100 | 05 §8 and 04 §10.7 at §3's factor | 05 §5's machinery: typed slots instead of alists, no Guile calls, skylines once per glyph, indexed outside-staff skylines; the visible page first; cells; partitions (b) for every L score | MS3 for layout, measured on the device; MS6 for translation |
| R2 | The core image is larger than its 420 KB share | 03 §5.6: 300–450 KB estimated | Documentation strings out; init data as generated Rust tables (chapters 04 and 05 generate them anyway); more parts on demand | MS1 |
| R3 | The interpreter is slower or less Guile-like than measured: 66–224 ns an application against 200 | 03 §4.3 at 0.38× | Hot paths in its own arenas, not std's string and allocation code (08 §1.3); the error corpus; s7 as the fallback when it misses by more than twice | MS1 |
| R4 | The long tail: real scores use what the 30 do not (58 music types, 84 grobs, 140 markup commands) | 01 §5 | The server's LilyPond as the fallback per compile; a test score added with each feature; Y8's order by how common a feature is | every milestone; MS8 |
| R5 | Incremental compiles that differ from full ones | 02 §5.7, 04 §10, 05 §6 are new designs | Differential tests on every layer, on random edits; a full compile on demand (debug build) to compare in the field | MS6 |
| R6 | The page, not the engine, misses B7 on Android | 09 §4.4: 95–105 ms for four pages | H2 in MS0: changed pages only, one per task; the cell message (W8) | MS0 |
| R7 | iOS unknowns: Cache Storage after a reload, a tab killed under memory pressure (WebKit bug 269777), B5c, the worker's JS heap; the Android floor was never run | 09 §7 | H6 in MS0 on a real iPhone 12 over HTTPS and an A15-class phone; the HTTP cache as the second layer; the 256 MiB maximum and a reported error | MS0, MS7 |
| R8 | The pinned nightly goes away or breaks | 08 §1.3 | The stable build is 14–26 % larger in brotli and still inside B1 | any time |
| R9 | Licences: the engine ports GPL code and ships GPL Scheme; the PDF module ships URW fonts under the AGPL with an embedding exception | 03 R15, 06 §5.3 | D56: the engine is GPL-3.0-or-later and a separate program for the apps; the URW fonts ship unmodified with their licence and source; checked again before W7 ships | D56; MS8 |
| R10 | LilyPond moves on (2.26 → 2.28) and the reference with it | 00 §4 pins `v2.26.0` | Upgrade deliberately: re-capture, diff the comparator's layers, port the changes as a milestone of their own | after MS7 |
| R11 | Text the metric packs do not cover is measured by the browser, so C4 may differ near it | 06 §5.3, T20 | Accepted for scripts beyond Latin, Greek and Cyrillic; T20 tracks it | MS4 |
| R12 | Effort is far above the estimate | §5.1 rests on one assumed rate | MS1 measures the rate; the plan is re-estimated then; MS7 ships the engine before the long tail | MS1 |

## 9. Open items carried forward

From 09 §7 and the chapters' *unconfirmed* points, each with the milestone
that answers it:

- Cache Storage on iOS after a reload, B5c throttled, the worker's JS heap,
  the reference devices themselves and the Android floor: MS0 (H6).
- Whether a per-crate `opt-level` survives fat LTO, and whether `+simd128`
  speeds skylines: MS3, once there is a layout crate with skylines.
- Whether Chrome's code cache keeps wasm taken from Cache Storage: MS7.
- The silent switch, interruptions, background tabs and latency for
  playback: MS0 (M8), through `midi.js`.
- The image's real size and restore time: MS1.
- The SVG writer's time per edit on the phones: MS3.
