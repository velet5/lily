# 00 — Mobile budgets and the test set

Chapter 00 of the investigation into an engine of our own: a small
LilyPond, compiled to WebAssembly, that parses the whole syntax, runs its
Scheme, and writes SVG, PDF and MIDI in the browser. This chapter fixes what
"small" and "fast" mean on a phone, and the 30 scores that every later
chapter is measured on. It records no decision; D56 will, with the roadmap (step 11).

Everything marked **[measured]** was run on 2026-10-03 on an Apple M1 Max
(64 GB) with `GNU LilyPond 2.26.0 (running Guile 3.0)` from Homebrew. The
recipes are in §5 and Appendix A; the phone numbers are budgets, not
measurements, until chapter 09 (step 10) times a prototype on the devices.

## 1. Target devices and browsers

| | iOS reference | Android reference | Android floor |
| --- | --- | --- | --- |
| Device | iPhone 12 (A14, 4 GB) | Galaxy A54 class (Exynos 1380, 6–8 GB) | Galaxy A15 class (Helio G99, 4 GB) |
| Browser | Safari, iOS 17 and later | Chrome, the last two stable versions | Chrome, the last two stable versions |
| Single-core speed vs. the M1 Max we measured on | ≈ 0.85× | ≈ 0.45× | ≈ 0.3× |
| Role | budgets must hold | budgets must hold | must not crash; budgets ×2 |

The speed column is the ratio of approximate public Geekbench 6 single-core
scores; it only serves to project §3's desktop numbers until step 10 replaces
it with timings. An engine's work is single-threaded (B9), so only one core
counts.

The iPhone 12 is the reference because WebKit's own report of WebAssembly
memory on iOS ([bug 269777](https://bugs.webkit.org/show_bug.cgi?id=269777),
iOS 17, iPhone Xs, 12 and 14 Pro) measured it: about 1 GB can be allocated on
a page's first load, but only 300–500 MB after a reload, once as little as
28 MB on an iPhone Xs. `memory.grow()` does not fail there: the tab is killed.
That is why the memory budget (B4) is far below what the device has, and why
the engine declares a maximum (B4) instead of growing until killed.

### 1.1 WebAssembly features the core may use

The core module may use only what Safari 17 and current Chrome both ship:
the MVP, multi-value, bulk memory, sign extension, non-trapping
float-to-int, mutable globals, reference types and fixed-width SIMD (Safari
16.4). Rust builds with `panic = "abort"`, so exception handling is not
needed.

Not in the core: threads and `SharedArrayBuffer` (B9), tail calls and WasmGC
(both arrived in Safari 18.2, December 2024, so they would raise the floor to
iOS 18.2), memory64, relaxed SIMD and JSPI. Chapter 03's Scheme interpreter
therefore cannot rely on WebAssembly tail calls to make Scheme's tail calls
proper; it needs its own trampoline or loop.

## 2. Budgets

**Must** values gate a milestone: a miss blocks shipping the module that
caused it. **Goal** values are what to design for. Score classes: **S** is
T01–T23 (snippets, one or two pages, ≤ 200 events), **L** is T24–T30 (real
pieces, up to 20 staves and 532 events). Times are p95 over the runs of §6
unless the cell says p50.

| # | Budget | Measured as | iOS ref Must / Goal | Android ref Must / Goal |
| --- | --- | --- | --- | --- |
| B1 | Core download | brotli transfer size of everything needed to show T02's first page: wasm, JS glue, music font | 1.5 MB / 1.0 MB | same |
| B2 | Each on-demand module | brotli transfer size | PDF ≤ 500 KB; MIDI performers ≤ 150 KB; each Scheme library part ≤ 100 KB; each music font ≤ 60 KB | same |
| B3 | Core wasm, uncompressed | `.wasm` bytes | 4 MB / 2.5 MB | same |
| B4 | Peak memory of the engine | linear memory high-water mark plus the worker's JS heap | S: 64 MB / 32 MB; L: 128 MB / 64 MB; declared maximum 256 MiB | same |
| B5a | Cold start, cached | navigation start → engine ready, modules in the Cache Storage | 600 ms / 300 ms | 1200 ms / 600 ms |
| B5b | First render | engine ready → T02's first page in the DOM | 400 ms / 200 ms | 800 ms / 400 ms |
| B5c | First visit | navigation start → engine ready, nothing cached, 10 Mbit/s, 100 ms RTT | 3 s / 2 s | 3 s / 2 s |
| B6 | Re-render after an edit | the edit's input event → changed page in the DOM, debounce excluded (§6.2) | S: 150 ms / p50 60 ms; L: 300 ms / p50 120 ms | S: 250 ms / p50 100 ms; L: 500 ms / p50 200 ms |
| B7 | Main thread | longest task the engine causes during an edit | 50 ms | 50 ms |
| B8 | Superseded work | a newer edit arrives → the running compile stops | 50 ms | 50 ms |
| B9 | Threads | B1–B8 hold with one dedicated Worker, no `SharedArrayBuffer` | required | required |
| B10 | Page size | SVG bytes of a page vs. LilyPond's for the same page (Appendix B) | ≤ 100 % / ≤ 50 % uncompressed | same |

Edits E2 (reflow) may take twice the B6 values. The Android floor must finish
every score without the tab being killed, at twice the Android reference's
times.

### 2.1 Why these numbers

- **B1–B3, size.** For scale, **[measured]**: LilyPond's own Scheme and
  init files (`scm/` and `ly/`, 60k + 16k lines) are 2.9 MB, 475 KB with
  brotli; one Emmentaler size (`emmentaler-20.otf`) is 97 KB, 49 KB with
  brotli; `onig.wasm`, the one wasm the studio already ships, is 456 KB, 102
  KB with brotli. A core of 1.5 MB is 1.2 s at 10 Mbit/s, which leaves B5c
  room for compiling and initialising. Uncompressed size matters on its own
  (B3): Safari and Chrome compile the whole module before the first call, and
  the compiled code counts against the memory iOS allows.
- **B4, memory.** The whole native process peaks at 79–138 MB RSS on the
  corpus **[measured]**, Guile, Pango and fonts included. iOS reliably gives
  a reloaded page 300 MB for everything: the engine, the page, the inline SVG
  DOM and the audio. The engine gets less than half of what LilyPond uses,
  and a declared maximum of 256 MiB makes an oversized score a reported
  error instead of a killed tab. WebAssembly memory never shrinks, so the
  high-water mark is also what the tab keeps until the worker is recycled.
- **B5, cold start.** LilyPond's warm parent (D25) is ready 0.13 s after
  spawn, and a fork that only reads `init.ly` and a trivial score takes
  another 0.21 s **[measured]**. Projected onto the Android reference
  (0.45× and about 1.5× for wasm), that start alone would be 1.1 s; the
  engine must not repeat LilyPond's init work per run. It initialises once
  per Worker and keeps a pristine copy of its state to reset to, which is
  what `worker.scm`'s fork per request does natively (D25): each compile
  starts from the same post-init state, and nothing a score's Scheme did
  survives it.
- **B6, re-render.** 100 ms is where a reaction stops feeling instant. The
  desktop preview today re-renders T02 in 0.32 s and orchestra.ly in 0.91 s
  per request, before the 150 ms debounce (§3). Projected onto the Android
  reference, recomputing everything would take ≈ 1.1 s for T02 and ≈ 3 s for
  T29. B6 can only be met by recomputing what an edit affects (chapters 04
  and 05), which is the point of the budget. A provisional split of the
  Android S Must of 250 ms, for the roadmap (step 11) to confirm: parse 20, Scheme and
  music 40, layout 120, SVG 30, transfer to the page and DOM update 40.
- **B7–B8.** The engine runs in a Worker; what the page does with a result
  (parsing the SVG, swapping a page node, D17's page reuse) must stay below
  the 50 ms that counts as a long task. A compile superseded by a newer edit
  must stop, as the extension's live queue drops all but the newest pending
  revision (§3.6 of [ARCHITECTURE.md](../../../packages/vscode/docs/ARCHITECTURE.md)).
  Without shared memory the Worker cannot be interrupted mid-call, so the
  engine itself must yield between phases or systems often enough to see a
  cancel message within 50 ms.
- **B9, threads.** `SharedArrayBuffer`, and so wasm threads, need
  cross-origin isolation: `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` (Safari since 15.2, see
  [WebKit's notes](https://webkit.org/blog/12140/new-webkit-features-in-safari-15-2/);
  Chrome likewise). Lily Studio's server (D55) could send those headers, but
  the extension's webview and any page that embeds a score cannot rely on
  them, and on iOS shared memory adds to the fragmentation behind bug 269777.
  So the budgets hold single-threaded. Threads may speed up an optional
  module (a PDF export, a whole-book re-layout) where `crossOriginIsolated`
  is true, never the core.
- **B10, page size.** LilyPond's SVG repeats a glyph's whole path at every
  use. T29's one page is 680 KB, 38 KB gzipped **[measured]**; an inline
  page of that size costs DOM memory on every refresh. Chapter 06 decides how
  (glyphs defined once and `<use>`d); the budget is that a page must not get
  bigger than LilyPond's and should halve.

## 3. Baseline: LilyPond on the desktop today

All **[measured]** on the M1 Max, median of three runs; T03 is the error case
(exit 1). *Cold*: one ordinary compile as the user, or `lily-check`, runs it:
`lilypond --svg -dpoint-and-click -dinclude-settings=timing.ly`, no glyph cache.
*Warm*: one request to the preview's warm parent (D25: `glyph-cache.scm`,
then `worker.scm`, a fresh fork per request), median of requests 2–4. *RSS*:
peak resident set size of the cold run. SVG is all pages, raw and gzipped.

| ID | Cold s | Warm s | RSS MB | Pages | SVG KB | gzip KB |
| --- | --- | --- | --- | --- | --- | --- |
| T01 | 0.38 | 0.22 | 80 | 1 | 6 | 2 |
| T02 | 0.78 | 0.32 | 90 | 2 | 43 | 4 |
| T03 | 0.39 | 0.25 | 80 | 1 | 11 | 2 |
| T04 | 1.07 | 0.37 | 94 | 1 | 60 | 4 |
| T05 | 1.48 | 0.29 | 104 | 1 | 86 | 5 |
| T06 | 0.79 | 0.42 | 90 | 1 | 38 | 4 |
| T07 | 1.32 | 0.37 | 100 | 1 | 75 | 5 |
| T08 | 0.66 | 0.26 | 85 | 1 | 39 | 3 |
| T09 | 0.68 | 0.38 | 87 | 1 | 24 | 3 |
| T10 | 0.60 | 0.31 | 85 | 1 | 20 | 3 |
| T11 | 0.60 | 0.29 | 84 | 1 | 24 | 3 |
| T12 | 1.95 | 0.47 | 109 | 1 | 132 | 12 |
| T13 | 0.46 | 0.32 | 85 | 1 | 16 | 3 |
| T14 | 0.34 | 0.21 | 79 | 1 | 6 | 2 |
| T15 | 0.38 | 0.23 | 81 | 1 | 7 | 2 |
| T16 | 0.36 | 0.21 | 80 | 1 | 6 | 2 |
| T17 | 0.75 | 0.27 | 87 | 2 | 40 | 3 |
| T18 | 0.61 | 0.26 | 85 | 1 | 25 | 3 |
| T19 | 0.45 | 0.26 | 82 | 1 | 9 | 2 |
| T20 | 0.43 | 0.23 | 109 | 1 | 25 | 3 |
| T21 | 0.61 | 0.35 | 85 | 1 | 15 | 3 |
| T22 | 1.13 | 0.54 | 100 | 1 | 74 | 8 |
| T23 | 1.42 | 0.46 | 107 | 1 | 74 | 7 |
| T24 | 6.27 | 0.76 | 120 | 2 | 466 | 33 |
| T25 | 2.00 | 0.51 | 109 | 1 | 87 | 8 |
| T26 | 1.22 | 0.44 | 99 | 1 | 95 | 10 |
| T27 | 0.82 | 0.36 | 92 | 1 | 82 | 12 |
| T28 | 2.94 | 0.62 | 109 | 1 | 164 | 12 |
| T29 | 9.63 | 0.91 | 137 | 1 | 680 | 38 |
| T30 | 3.74 | 0.51 | 110 | 1 | 236 | 15 |

What it says:

- **Where a request's time goes.** The warm parent is ready 0.13 s after
  spawn. A cold compile *with* the glyph cache is the warm time plus about
  0.12 s (T01 0.34 s, T02 0.44 s, T24 0.86 s, T29 1.04 s), so that is
  process start and Guile's boot. Every fork then spends about 0.2 s reading
  `init.ly` and its includes before the score: `worker.scm` must fork before
  font initialisation and `declarations-init.ly`, because Pango may start
  threads. What the score itself costs is the rest: from nothing (T14) to
  about 0.7 s (T29).
- **The SVG backend dominates cold runs.** Without the glyph cache,
  `output-svg.scm` scans the whole SVG font for every glyph it draws: T24
  takes 6.27 s cold and 0.86 s with the cache, T29 9.63 s and 1.04 s. The
  engine's SVG writer must cost per glyph *kind*, not per glyph drawn.
- **No score needs threads or much memory natively**: one core, 79–137 MB
  RSS for the whole process.
- **What a phone would see with LilyPond's design**: ×1/0.45 for the CPU and
  about ×1.5 for wasm, T02 ≈ 1.1 s and T29 ≈ 3 s per edit on the Android
  reference. That is the gap B6 closes.
- Lily Studio on the web (D55) runs this same warm path on the server, so
  its re-render is these numbers plus a network round trip; it was not
  measured here.

## 4. The test set

Thirty scores in three groups. Group A is ours, in this repository. Groups B
and C are LilyPond's own, read from its repository at tag `v2.26.0` (commit
`3596756be0fac1f81066a99d2054329212172b2d`, GPL v3 / GFDL): they are fetched
when measuring and never copied here.

```sh
git clone --depth 1 --branch v2.26.0 --filter=blob:none --sparse \
  https://gitlab.com/lilypond/lilypond.git lilypond-src
git -C lilypond-src sparse-checkout set input/regression Documentation/ly-examples
```

*Events* is the number of rhythmic events in the reference capture (§5.1),
*links* the number of point-and-click links in its SVG.

| ID | File | What it exercises | Lines | Events | Links |
| --- | --- | --- | --- | --- | --- |
| **A** | `packages/vscode/test/` | | | | |
| T01 | `fixtures/hello.ly` | a trivial score: the floor of B5 | 8 | 6 | 6 |
| T02 | `e2e/workspace/score.ly` | the extension's sample: `\header`, two staves, lyrics, `\pageBreak`, `\midi`; the reference for B5b and B6 | 41 | 43 | 51 |
| T03 | `fixtures/broken.ly` | errors in a score and in the `.ily` it includes: the diagnostic format (D6, D15) | 11 | 9 | 7 |
| **B** | `input/regression/` | | | | |
| T04 | `lyric-combine.ly` | `\lyricsto`, `\addlyrics`, Lyrics contexts | 51 | 75 | 84 |
| T05 | `chord-name-entry.ly` | `\chordmode` and chord names | 43 | 105 | 133 |
| T06 | `figured-bass.ly` | `\figuremode`, FiguredBass | 31 | 42 | 45 |
| T07 | `drums.ly` | `\drummode`, DrumStaff, MIDI channel 10 | 45 | 82 | 101 |
| T08 | `tuplet-nest.ly` | nested tuplets and their brackets | 49 | 35 | 68 |
| T09 | `grace.ly` | grace notes: grace time in moments | 30 | 23 | 29 |
| T10 | `repeat-volta.ly` | `\repeat volta` with alternatives | 22 | 11 | 18 |
| T11 | `beam-cross-staff.ly` | `\change Staff`, cross-staff beams | 33 | 27 | 28 |
| T12 | `slur-scoring.ly` | slur shapes chosen by scoring: costly layout | 75 | 152 | 193 |
| T13 | `markup-syntax.ly` | the `\markup` grammar | 59 | 3 | 5 |
| T14 | `music-function.ly` | `define-music-function` | 17 | 2 | 2 |
| T15 | `scheme-engraver.ly` | engravers written in Scheme (`make-engraver`), as `timing.ly`'s performers are | 75 | 3 | 8 |
| T16 | `include-string.ly` | parsing called from Scheme (`ly:parser-include-string`) | 8 | 4 | 4 |
| T17 | `optimal-page-breaking-hstretch.ly` | page breaking, two pages | 31 | 40 | 42 |
| T18 | `midi-dynamics.ly` | dynamics as MIDI velocities | 24 | 16 | 24 |
| T19 | `midi/articulate-repeat.ly` | `articulate.ly`: Scheme rewriting music for MIDI, unfolded repeats | 23 | 4 | 4 |
| T20 | `utf-8.ly` | UTF-8 text in lyrics and markup, text fonts | 65 | 40 | 43 |
| **C** | `Documentation/ly-examples/` | | | | |
| T21 | `theory.ly` | markup-heavy page, FiguredBass, PianoStaff; turns point-and-click off | 59 | 27 | 22 |
| T22 | `tab-example.ly` | TabStaff, fretted strings | 73 | 84 | 96 |
| T23 | `aucun-snippet.ly` | mensural notation, lyrics, a music function; turns point-and-click off | 272 | 126 | 146 |
| T24 | `bach-bwv610.ly` | organ, three staves, voices crossing staves; the slowest cold run | 202 | 500 | 548 |
| T25 | `granados.ly` | dense piano writing; turns point-and-click off | 190 | 148 | 149 |
| T26 | `stockhausen-klavierstueckII.ly` | contemporary piano: cross-staff, `define-event-function`, a custom TimeSignature context | 249 | 38 | 98 |
| T27 | `bach-schenker.ly` | a Schenker graph: overrides and Scheme everywhere | 345 | 85 | 78 |
| T28 | `cary.ly` | contemporary layout from an included `.ily` | 395 | 181 | 178 |
| T29 | `orchestra.ly` | full score, 20 staves, custom contexts, staff size 10: the size ceiling | 559 | 532 | 867 |
| T30 | `sesto-full.ly` | opera full score from a shared `.ily`, custom StaffGroup contexts | 67 | 276 | 307 |

Chapter 03 counts which Guile features and `scm/` modules these scores
reach; a score added later should cover something none of these does.

## 5. Scoring against real LilyPond

The engine is compared with LilyPond through the outputs the extension
already consumes (`CompileResult`, §3.1 of ARCHITECTURE.md): SVG pages with
`textedit://` links, the `.midi` files, the playback map `timing.ly` writes
(D26), and stderr. An engine that writes these in the same form can be
scored without new tooling on LilyPond's side, and the preview, the player
and the diagnostics parser work on it unchanged.

### 5.1 The reference capture

One compile per score, as cold runs are done in §3, with Appendix A's
`capture.ly` as the settings file instead of `timing.ly`:

```sh
cd "$(dirname score.ly)" && LANGUAGE=en lilypond --loglevel=WARNING --svg \
  -dpoint-and-click -dinclude-settings=capture.ly -o <ref>/<id>/<base> score.ly
```

`capture.ly` includes `timing.ly` and changes two things, for the capture
only: every score of every book gets a `\midi` performance, so the playback
map has the events of scores that ask for no MIDI; and `point-and-click`
cannot be turned off, so T21, T23 and T25 still have links. Neither changes
the layout **[measured]**: the links of a capture sit exactly where the
plain cold run put them. A `\midi` added this way does not know contexts
that the score defines only in its `\layout` (T29, T30): LilyPond warns
`cannot create context` and plays the music in default contexts, and the
events are still recorded (532 in T29).

The capture is deterministic **[measured]**: two captures of all 30 scores
compare as identical on every layer of §5.2.

### 5.2 Layers

The comparator (Appendix A, `score.mjs`) reads a reference directory and a
candidate directory and scores each layer separately. A link is compared as
`file:line:char`, without its directory (the engine's paths differ) and
without the tab-expanded column, which is derived (§3.5 of ARCHITECTURE.md).

| Layer | Compares | Score | Must | Goal |
| --- | --- | --- | --- | --- |
| C0 Diagnostics | stderr through `parseStderr` (D15) | first error's file, line, column, severity and message equal; same error count | exact | exact |
| C1 Events | the playback map's events: performance, link, moment, grace moment, length | Dice coefficient of the two multisets | 1.0 | 1.0 |
| C2 MIDI | notes of every `.midi` (`parseMidi` of `packages/common/web/midi.js`): file, track, channel, key, program, time and duration to 0.1 ms | Dice coefficient | 1.0 | 1.0 |
| C3 Breaks | page count, and the moments where a new system starts: where the music's columns jump back left by more than 10 staff spaces, or onto a new page | pages equal; Dice of the break moments | 0.9 | 1.0 |
| C4 Positions | each linked element's `translate(x, y)`, paired in document order per link, on elements whose page agrees | median and p95 of \|Δx\| and \|Δy\| in staff spaces (the SVG's units) | median ≤ 0.5, p95 ≤ 2 | median ≤ 0.1, p95 ≤ 0.5 |

A score **passes** when every layer meets its Must; a milestone reports, per
layer, how many of the 30 pass. C0 applies to T03 only until chapter 02
adds an error corpus. `midi.js` does not keep velocities; C2 must add them
before T18 can test dynamics. A page whose SVG has no links (none in the
corpus, after the capture) can only be compared by C3's page count;
comparing rasterised pages is left as an aid for reviewing, not a gate.

The comparator expects each linked element as LilyPond writes it: `<a
xlink:href="textedit://…">` whose first child is `<g
transform="translate(x, y)">`. Chapter 06 may write pages differently (B10),
but must keep that shape for linked elements, or change the comparator with
it; the preview's point-and-click (D19) relies on the same links.

### 5.3 The comparator is sensitive enough

**[measured]**: the same captures with `\paper { line-width = 150\mm }` added
to the settings file, against the plain captures:

| Score | C1 | C2 | C3 breaks | C4 median / p95 \|Δx\| | C4 median / p95 \|Δy\| |
| --- | --- | --- | --- | --- | --- |
| T02 | 1.0 | 1.0 | 1.0 | 5.4 / 8.5 | 0 / 0 |
| T24 | 1.0 | 1.0 | 0.36 | 23.3 / 50.2 | 9.8 / 27.4 |
| T30 | 1.0 | 1.0 | 0 (one system became several) | 33.8 / 93.1 | 2.6 / 40.5 |

The music layers do not move with the layout, the layout layers do, and a
change a reader would see is one to two orders of magnitude above C4's Must.

## 6. Measuring on the phones

### 6.1 Set-up

A harness page (chapter 09, step 10) loads the engine in one dedicated
Worker, served over HTTPS **without** COOP/COEP headers, so B9 is measured
as it will be met. The phone is charged above 50 %, not in low-power mode,
with other apps closed. Every number is 10 runs, reported as p50 and p95;
the first run is discarded except where cold start is the measurement.

| Budget | Instrument |
| --- | --- |
| B1–B3 | transfer and resource sizes from the Resource Timing API; `.wasm` size on disk |
| B4 | `memory.buffer.byteLength` after the run (the high-water mark, since it never shrinks) plus the Worker's JS heap: Chrome's remote DevTools memory panel; Safari Web Inspector's Timelines › Memory over USB |
| B5a, B5c | `performance.mark('engine-ready')` in the Worker, against the navigation's `timeOrigin`; B5a after one visit, B5c after clearing the site's data, with the network throttled in remote DevTools (Android) or the Network Link Conditioner (iOS) |
| B5b, B6 | from the mark to the end of the first `requestAnimationFrame` callback after the page's node was replaced |
| B7 | Long Tasks API on Chrome; Web Inspector's main-thread timeline on Safari |
| B8 | a second edit sent 20 ms into the first one's compile; time until the Worker answers the first as cancelled |

### 6.2 Edits

Re-render is timed on T02, T12, T24 and T29, with three scripted edits, 20
of each per score. Each starts from the middle event of the capture's first
performance and edits the source at its link (`file:line:char`):

- **E1, a pitch**: the note name there goes up a step (c→d, …, b→c). One
  column changes; usually one system is re-laid out.
- **E2, a reflow**: the note's whole token is inserted again before it.
  Everything after it moves, possibly onto other systems and pages.
- **E3, a text**: a character is appended to the first string of the first
  `\header` (T02 and T29 have titles), or else to the first `\markup` string.

The time runs from dispatching the edit to the page shown (§6.1), with no
debounce: the debounce is a policy of the editor, not the engine's cost.

## 7. What the later chapters take from here

| Step | Chapter | Owns | Must show against |
| --- | --- | --- | --- |
| 2 | 01 source map | — | which LilyPond files make each layer of §5.2 |
| 3 | 02 parser | parse share of B6 (provisional 20 ms) | C0, C1; T13, T14, T16 |
| 4 | 03 Scheme | share of B1 and B3, the post-init snapshot of B5a | T14–T16, T19, T26, T27; §1.1's tail-call rule |
| 5 | 04 music model | B4; the Scheme-and-music share of B6 (40 ms) | C1, C2 |
| 6 | 05 layout | the layout share of B6 (120 ms); B8's yielding | C3, C4; T12, T24, T29 |
| 7 | 06 SVG, PDF, fonts | B10; B2's PDF and font limits | C4's link shape (§5.2) |
| 8 | 07 MIDI | B2's performer limit | C2 with velocities; T07, T18, T19 |
| 9 | 08 wasm build | B1, B3, B5, B9, §1.1 | the harness of §6 |
| 10 | 09 phone timings | measures B1–B10 on §1's devices | all of §2 |
| 11 | roadmap, D56 | splits B1 and B6 per module for good | every pass count |

## Appendix A: the capture and the comparator

`capture.ly`, the settings file of §5.1 (the `\include` takes the absolute
path of `packages/common/runtime/timing.ly`):

```lilypond
%% Reference capture only: every score of every book gets a \midi performance,
%% so timing.ly writes the score's events even when it asks for no MIDI. A
%% score without output definitions keeps its default \layout.
\include "/abs/path/to/packages/common/runtime/timing.ly"
#(define (lily-capture-kind def) (ly:output-def-lookup def 'output-def-kind #f))
#(define (lily-capture-score! score)
   (let ((defs (ly:score-output-defs score)))
     (unless (any (lambda (def) (eq? (lily-capture-kind def) 'midi)) defs)
       (when (null? defs) (ly:score-add-output-def! score (ly:output-def-clone $defaultlayout)))
       (ly:score-add-output-def! score (ly:output-def-clone $defaultmidi)))))
#(define (lily-capture-book! book)
   (for-each (lambda (score) (when (ly:score? score) (lily-capture-score! score))) (ly:book-scores book))
   (for-each lily-capture-book! (ly:book-book-parts book)))
#(define lily-capture-book-handler toplevel-book-handler)
#(define (toplevel-book-handler book) (lily-capture-book! book) (lily-capture-book-handler book))
%% Layout is compared through the point-and-click links, so a score may not turn them off.
#(define lily-capture-set-option ly:set-option)
#(define (ly:set-option key . rest)
   (unless (eq? key 'point-and-click) (apply lily-capture-set-option key rest)))
```

`score.mjs <reference dir> <candidate dir>`, which printed every number of
§5.3 (C0 is `parseStderr` on both stderrs, not repeated here):

```js
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
const { parseMidi } = createRequire(import.meta.url)('<repo>/packages/common/web/midi.js')
const files = (dir, re) => readdirSync(dir).filter((f) => re.test(f))
  .sort((a, b) => (+(a.match(/-(\d+)\.svg$/)?.[1] ?? 0)) - (+(b.match(/-(\d+)\.svg$/)?.[1] ?? 0)))
// A link without its directory and its derived COLUMN: file:line:char.
const key = (href) => href.replace(/^textedit:\/\//, '').replace(/^.*\//, '').replace(/:\d+$/, '')
function read(dir) {
  const links = new Map() // key → [{page, x, y}] in document order
  files(dir, /\.svg$/).forEach((page, p) => {
    const svg = readFileSync(path.join(dir, page), 'utf8')
    for (const m of svg.matchAll(/xlink:href="(textedit:[^"]+)">\s*<g transform="translate\(([-\d.]+), ([-\d.]+)\)">/g)) {
      const k = key(m[1]); if (!links.has(k)) links.set(k, [])
      links.get(k).push({ page: p, x: +m[2], y: +m[3] })
    }
  })
  const timing = files(dir, /\.timing\.json$/).map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')))[0] ?? []
  const events = timing.flatMap((perf, i) => perf.events.map((e) => `${i}|${key(e.href)}|${e.at}|${e.grace}|${e.length}`))
  const notes = files(dir, /\.midi?$/).flatMap((f) => parseMidi(readFileSync(path.join(dir, f))).notes
    .map((n) => `${f}|${n.track}|${n.channel}|${n.key}|${n.program}|${n.time.toFixed(4)}|${n.duration.toFixed(4)}`))
  // A system break is where the music's columns jump back to the left, or onto a new page.
  const moments = new Map()
  for (const perf of timing.slice(0, 1)) for (const e of perf.events) {
    const at = links.get(key(e.href))?.[0]; if (!at) continue
    const m = `${e.at}|${e.grace}`; const c = moments.get(m) ?? { at: e.at, grace: e.grace, x: Infinity, page: at.page }
    c.x = Math.min(c.x, at.x); moments.set(m, c)
  }
  const order = [...moments.values()].sort((a, b) => a.at - b.at || a.grace - b.grace)
  const breaks = new Set(order.filter((c, i) => i > 0 && (c.page !== order[i - 1].page || c.x < order[i - 1].x - 10))
    .map((c) => `${c.at}|${c.grace}`))
  return { pages: files(dir, /\.svg$/).length, links, events, notes, breaks }
}
// Dice coefficient of two multisets: the same music may be engraved twice (ChordNames and Staff).
const same = (a, b) => {
  const left = new Map(); for (const x of b) left.set(x, (left.get(x) ?? 0) + 1)
  const hit = a.filter((x) => left.get(x) > 0 && left.set(x, left.get(x) - 1)).length
  return a.length + b.length === 0 ? 1 : 2 * hit / (a.length + b.length)
}
const ref = read(process.argv[2]); const cand = read(process.argv[3])
const dx = []; const dy = []
for (const [k, r] of ref.links) {
  const c = cand.links.get(k); if (!c || c.length !== r.length) continue
  r.forEach((a, i) => { if (a.page === c[i].page) { dx.push(Math.abs(a.x - c[i].x)); dy.push(Math.abs(a.y - c[i].y)) } })
}
const q = (v, p) => v.length ? v.sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(p * v.length))].toFixed(3) : '-'
console.log(JSON.stringify({
  pages: [ref.pages, cand.pages],
  events: same(ref.events, cand.events).toFixed(4),
  midiNotes: same(ref.notes, cand.notes).toFixed(4),
  breaks: same([...ref.breaks], [...cand.breaks]).toFixed(4),
  linksMatched: `${dx.length}/${[...ref.links.values()].flat().length}`,
  dxMedian: q(dx, 0.5), dxP95: q(dx, 0.95), dyMedian: q(dy, 0.5), dyP95: q(dy, 0.95),
}))
```

`same` counts multiplicities: T04, T05, T22 and T29 record the same event
twice, when one piece of music is both engraved and named (ChordNames over a
Staff) or sung. Dropping one of T05's 105 events scores C1 at 0.9952.

## Appendix B: sizes on the desktop

**[measured]**, Homebrew's LilyPond 2.26.0 for arm64:

| What | Raw | brotli -q 11 |
| --- | --- | --- |
| `lilypond` executable (Guile, Pango, Cairo and fonts not included) | 6.1 MB | — |
| `share/lilypond/2.26.0/scm` + `ly` (60,459 + 16,307 lines) | 2.9 MB | 475 KB |
| `emmentaler-20.otf`, one of 8 optical sizes, plus `emmentaler-brace.otf` | 97 KB + 94 KB | 49 KB (the first) |
| `fonts/svg/` (Emmentaler as SVG fonts, used by the SVG backend) | 2.6 MB | — |
| `vscode-oniguruma/release/onig.wasm` (in Lily Studio today) | 456 KB | 102 KB |
