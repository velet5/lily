# 09 — A stripped-down build timed on phones

Chapter 09 of the investigation into an engine of our own. Chapter 00 set
the budgets and the test set; chapters 01–07 design the parser, the Scheme
interpreter, the music model, the layout, the output and MIDI; chapter 08
designs the wasm build, the worker and the caching. This chapter builds a
small engine with chapter 08's settings (§1), measures its size (§2), and
runs it on two devices through the studio's own engine worker (§3). It
records cold start, first render, re-render, main-thread time, superseded
work and memory against chapter 00's budgets (§4–§6). It corrects chapter
00's speed factors with timings (§5.1), and lists what was not measured
(§7). It records no decision; D56 (step 11) will.

The crate is `packages/studio/crates/engine-spike/`, a member of Lily
Studio's Cargo workspace. Chapter 08 §1.3's `wasm` and `wasm-names`
profiles are now in `packages/studio/Cargo.toml`. `harness/` holds the
build script, the page, its server and the desktop driver. Appendix A has
the recipes.

Everything marked **[measured]** was taken on 2026-10-03 and 2026-10-04
with rustc 1.98.0-nightly (2026-05-24) and 1.97.0 stable, Binaryen 133,
Node 24.14, brotli 1.2 at `-q 11` and Playwright 1.59.1 (headless Chromium
147.0.7727.15 and WebKit 26.4) on chapter 00's M1 Max. The devices are in
§3. KB is 1,000 bytes. What was not measured and not found in a primary
source is marked *unconfirmed*.

## 1. The crate

### 1.1 What it does

3,348 lines of Rust as `rustfmt` formats it, `std` only, no dependencies:

| Module | Lines | What | Stands in for |
| --- | --- | --- | --- |
| `music.rs` | 837 | Hand-written recursive descent over the source: notes with Dutch names, rests, skips, durations and dots; `\relative`; variables; `\include` (asked of the host); `\header`; `\clef`, `\time`, `\key`, `\bar`, `\break`, `\pageBreak`; `\score`, `\new`; `#` and `$` Scheme. Errors in LilyPond's words, at LilyPond's columns | chapter 02's parser |
| `scheme.rs` | 992 | A reader, a pass that resolves variables to frame slots or globals, and an evaluator. Tail calls are proper through a loop (chapter 00 §1.1), deep recursion is bounded by stack use, and errors are reported instead of trapping. 42 primitives, among them `define`, `lambda`, named `let`, `cond`, `map`, `apply` and `set-global-staff-size` | chapter 03's interpreter |
| `layout.rs` | 784 | One staff. Columns spaced by duration, bar lines where measures fill, accidentals by measure and key, stems, flags, dots, ledger lines, clef, key and time signatures. Lines are broken by a dynamic programme over measures (least squared stretch, forced breaks kept) and justified; pages are filled from the top | chapters 04 and 05, much reduced |
| `svg.rs`, `font.rs` | 202 | Chapter 06's form: each glyph's outline once in `<defs>`, `<use>`d where it is drawn, one path per line thickness, and notes and rests linked as LilyPond links them. The font is a data module (`lily_put`) cut from LilyPond's `emmentaler-20.svg` at build time, so no outline is kept in the crate | chapter 06's writer and font packs |
| `lib.rs`, `text.rs` | 533 | Chapter 08 §4.2's C ABI, without `wasm-bindgen`. Outputs `stderr` in LilyPond's format and `diagnostics.json`. Numbers and text are written without `core::fmt` | chapter 08's core |

What it leaves out: beams, slurs, ties, chords, voices, more than one staff,
lyrics, markup, collisions, vertical spacing, MIDI, and any reuse between
compiles. **Every compile parses, evaluates, lays out and writes
everything again.** It is a measuring instrument, not the start of the
engine. What it measures is the frame the engine will run in: the build,
the ABI, the worker, the transfer to the page, the page's DOM, and the
devices' speed at this kind of code.

The image (`lily_start`) is a five-line Scheme prelude, evaluated. The
interpreter's globals are snapshotted after it and restored before every
compile, so a score's Scheme does not outlive it (chapter 00 §2.1, B5).
Chapter 03 §5.6's image is a heap restored without evaluation. The spike
does not try that.

`lily_step` works through parse, layout and then one page at a time,
returning after the pass in which `budgetMs` ran out. Parsing and layout are
not split. A score that needs a file it was not given returns `Step.Needs`.
The driver asks the page, and the compile starts again (chapter 08 §4.4).
The first page carries a comment with the phases' times and the linear
memory, `<!--lily-spike {…}-->`, which is how the harness reads them through
the unchanged `CompileOutcome`.

### 1.2 Tests

`cargo test -p lily-engine-spike` (9 tests, `tests/spike.rs`) runs the
engine natively through the same calls as the ABI. Scheme has to evaluate
what scores and the benchmark use, and to report errors instead of
trapping, including a non-tail recursion 100,000 deep. T01 (chapter 00 §4)
has to compile as it is: its `\include "melody.ily"` is asked for, and its
six notes are linked at the right `file:line:char:column`. A missing
include has to give LilyPond's `cannot find file` error in both forms, and
an error after a tab has to land on LilyPond's column. A score's Scheme has
to change staff size and title, and the next compile has to start from the
image again. Relative octaves, the key and accidentals, breaking into
systems and pages, and the step budget are tested as well. The browser run
of §4 is the end-to-end test: every compile on every device came back
`ok`.

## 2. Size

### 2.1 The build

**[measured]**, bytes. *ia* is chapter 08 §1.3's build: nightly,
`-Cpanic=immediate-abort`, `-Zbuild-std`, `opt-level = "z"`, fat LTO, one
codegen unit, `--max-memory=268435456`. *+Oz* is `wasm-opt -Oz` with chapter
00 §1.1's features.

| Build | Raw | gzip -9 | brotli |
| --- | --- | --- | --- |
| stable, `panic = "abort"`, z | 141,247 | 53,491 | 45,552 |
| stable, z +Oz | 119,543 | 52,837 | 45,165 |
| ia, z | 121,480 | 44,967 | 38,476 |
| **ia, z +Oz (served)** | **100,414** | **44,142** | **37,958** |
| ia with `+simd128`, z +Oz | 99,566 | 43,926 | 37,894 |
| ia, `opt-level = 3` +O3 | 150,461 | 58,067 | 48,006 |

What a page downloads before the engine is ready (B1):

| File | Raw | brotli |
| --- | --- | --- |
| `core.wasm` | 100,414 | 37,958 |
| `core.image` (the prelude) | 347 | 214 |
| `emmentaler-20.pack` (31 glyphs) | 10,300 | 3,693 |
| `engine.worker.js` (`esbuild.mjs --site --production`) | 8,024 | 3,033 |
| **Sum** | **119,085** | **44,898** |

Where the code goes **[measured]**, from the `wasm-names` build through the
same `wasm-opt -Oz` with names kept: the code section is 95,420 bytes. 81,540
of it (85 %) is the crate's own functions, with the generic `std` code they
instantiate (`Vec`, `BTreeMap`, `Rc`, strings) inlined into them. Then
7,876 bytes of other `std`, `core` and `alloc`, 4,697 of `dlmalloc`, 628 of
compiler builtins and 591 of `core::fmt`. The data section is 3.6 KB.

What it says:

- **Chapter 08's settings hold on a crate of the engine's shape.** Panic
  strings cost 19 % raw and 19 % brotli here, as chapter 08 §1.2 measured on
  its probes (14–26 % brotli). `wasm-opt -Oz` takes 17 % raw and 1.3 %
  brotli.
- **Almost all of the wasm is the engine's own code.** With panics as traps
  and no `core::fmt` on any path the engine uses, the fixed Rust runtime is
  about 14 KB raw: the allocator, std's remaining glue and the builtins.
  Chapter 03 §4.2 measured 60 KB of fixed runtime in its prototype, 35 KB of
  it formatting and float printing. Writing numbers without `core::fmt` and
  reading decimals without `str::parse::<f64>` (`text.rs`,
  `scheme::number`) is what removes it. The engine should keep that rule:
  no `format!`, `write!` or float `Display` on any path the core reaches.
- **`+simd128` changes nothing.** 0.8 % smaller raw, nothing vectorised.
  Whether chapter 05's skylines gain from it can only be measured on code
  that has skylines. Its speed was not measured (§7).
- **The speed build costs 50 % raw** (26 % brotli), as chapter 08 §1.2 found.
  §5.1 shows where the time went on the phones. None of it is a reason to
  build for speed.
- **The scale.** 3,300 lines of engine-shaped Rust are 100 KB raw and 38 KB
  brotli: about 30 raw bytes and 11 brotli bytes per formatted line. Chapter
  08 §2.1 estimates the core at 1.5–1.8 MB raw with these settings. At this
  rate that is 50,000–60,000 lines, the order of chapters 02–07's
  estimates. B1 (1.5 MB brotli) and B3 (4 MB raw) hold with room if the
  ratio holds.

## 3. Devices and method

| | iOS | Android |
| --- | --- | --- |
| Device | iPhone SE, 2nd generation (`iPhone12,8`) | Amazon Fire Max 11 (`KFSNWI`) |
| Chip, memory | A13 Bionic, 3 GB | MediaTek MT8188 (2 × Cortex-A78 and 6 × A55, *unconfirmed*), 3.8 GB visible (**[measured]**, `/proc/meminfo`) |
| Browser | Safari 18.1.1, iOS 18.1.1 | Silk 150.1.168 (Chromium 150.0.7871), Fire OS 8 (Android 11) |
| `hardwareConcurrency`, `deviceMemory` | 4, — | 8, 4 |
| Against chapter 00 §1 | one generation older than the iOS reference (iPhone 12, A14) | a tablet, not a phone, running Silk, not Chrome. Its fast cores are of the Android reference's type (Galaxy A54: 4 × A78 at 2.4 GHz; here 2 × A78 at 2.2 GHz, *unconfirmed*) |
| Connection | Wi-Fi, `http://<the Mac's LAN address>:8471/` | USB, `adb reverse`, `http://localhost:8471/` |
| Secure context, Cache Storage | no: repeat visits come from the HTTP cache (`immutable`) | yes |

The harness (`harness/index.html`, `harness.js`) starts the studio's
`engine.worker.js` as `esbuild.mjs --site --production` builds it. That is
chapter 08's worker and driver, unchanged, with the spike's files copied
under hashed names. `serve.mjs` serves it with brotli and chapter 08 §5.1's
`Cache-Control`, without COOP or COEP (B9). Each visit runs this sequence
and POSTs the result:

1. B5a, the engine `ready` against the navigation's start.
2. B5b, the first render of S43.
3. `(fib 25)` six times, for the interpreter's speed.
4. B6, eleven compiles each of edits E1 and E2 (chapter 00 §6.2) on S43 and
   L532, the first discarded.
5. B8, a compile of S43 sent 20 ms into a compile of XL4256, five times.

A render runs from posting the compile to the end of the first
`requestAnimationFrame` callback after the pages replaced the old ones in
the DOM (chapter 00 §6.1).

The scores are generated (`score()` in `harness.js`): one staff in
`\relative c''`, D major, 4/4, mixed durations from whole notes to
sixteenths, 8 % rests, 10 % accidentals, one measure per source line, and a
title and a `#(define …)` evaluated by the Scheme. **S43** has T02's 43
events, **L532** has T29's 532, and **XL4256** (8 × 532) is used only for
B8. Each is valid LilyPond. They have chapter 00's event counts, not its
scores: T02 and T29 need staves, lyrics and voices that the spike does not
have.

Each device ran six visits: the iPhone through `devicectl` launching
Safari, the tablet through `adb` launching Silk. The tables give the
median over visits of each visit's p50 and p95. Chapter 00 §6.1's
conditions (charge above 50 %, low-power mode off, other apps closed) were
not checked. The desktop rows are the same harness in Playwright's
Chromium and WebKit (`measure.mjs`), six visits each.

## 4. Results

### 4.1 Cold start (B5a, B5c)

**[measured]**, milliseconds. *Ready* is from the navigation's start to
the worker's `ready`. *Engine* is the driver's own part of it: core and
image from the cache, compile, instantiate, `lily_start`, font pack.

| | Fire Max 11 | iPhone SE | Chromium (M1) | WebKit (M1) |
| --- | --- | --- | --- | --- |
| First visit, nothing cached: ready / engine | 1,029 / 255 ¹ | 346 / 65 ² | 32 / 10.5 ² | 68 / 14 ² |
| Repeat visit: ready / engine | **297 / 27** (Cache Storage) | **111 / 12** (HTTP cache) | 20 / 3.2 (Cache Storage) | 29 / 9 (HTTP cache) ³ |

¹ The server's first response compressed `core.wasm` on the fly, about
150 ms on the M1 (§7). ² With the compressed copy already in the server's
memory. ³ Playwright's WebKit keeps no Cache Storage across navigations
(chapter 08 §5.3).

- **B5a holds with room.** 297 ms on the tablet against the Android Must of
  1,200 ms and Goal of 600, 111 ms on the iPhone against 600 and 300.
- **The engine's own part is small**, as chapter 08 §3.2 projected: 27 ms on
  the tablet (projected 14 ms for the A54 from 7 ms in Chromium), 12 ms on
  the iPhone (projected 24 ms). The tablet's other 270 ms are the browser
  loading the page and starting the worker. Their split was not measured.
- **Cache Storage works on Silk**: every repeat visit found the four engine
  files (`cachedAtStart` 4). On iOS it was not tested, because the iPhone
  ran over plain http (§7).
- B5c (10 Mbit/s, 100 ms RTT) was not measured: no throttling. The first
  visits above were on a LAN or USB.

### 4.2 First render (B5b)

**[measured]**: S43, from `ready` to the page shown, median of visits and
the first visit of a fresh instance.

| | Fire Max 11 | iPhone SE | Chromium | WebKit |
| --- | --- | --- | --- | --- |
| Median of visits (worker) | 22.6 (12.7) | 15 (6) | 10.3 (2.1) | 16 (4) |
| Fresh first visit (worker) | 81.5 (52.1) | 57 (15) | — | — |

The first compile in a new browser profile costs 40–60 ms more on both
devices. The compile time it adds lands in the worker (52 ms against 13 on
the tablet): lazy compilation, as chapter 08 §3.2 found on the desktop. B5b
holds by an order of magnitude: Android Must 800 ms and Goal 400, iOS 400
and 200.

### 4.3 Re-render after an edit (B6)

**[measured]**, milliseconds, p50 / p95 of the whole render, with the
worker's part (`durationMs`) in brackets:

| Edit | Fire Max 11 | iPhone SE | Chromium | WebKit |
| --- | --- | --- | --- | --- |
| S43 E1 (pitch) | 16.8 / 33.3 (1.2) | 17 / 17 (1) | 13.2 / 26.2 (0.3) | 17 / 17 (0) |
| S43 E2 (reflow) | 16.7 / 19.5 (2.5) | 17 / 17 (1) | 13.3 / 26.3 (0.3) | 17 / 17 (0) |
| L532 E1 | **111.5 / 135.6** (12.1) | 20 / 24 (4) | 13.1 / 21.0 (2.7) | 22 / 23 (3) |
| L532 E2 | **109.7 / 137.0** (10.5) | 20 / 20 (4) | 12.9 / 22.4 (2.6) | 22 / 23 (3) |

The tablet's phases for L532 E1 (p50): parse 0.7 ms, of which Scheme 0.3,
layout 1.8, SVG 7.3. S43 is one page of 18.4 KB; L532 is four pages, 38
systems, 182 KB. WebKit's and Safari's clocks have a resolution of 1 ms.

- **The engine's work is a few milliseconds** while it recomputes
  everything: at most 12 ms for 532 events on the tablet, 4 ms on the
  iPhone. Chapter 00 §2.1's provisional Android S split gives 210 ms to
  parse, Scheme, music and layout. The spike's share of that is 1–3 ms.
  This proves nothing about the engine, which has to do far more per event
  (chapters 04 and 05), but it measures the floor: the ABI, the worker, the
  copies and the transfer cost almost nothing.
- **A one-page score renders in one frame on both devices.** S43's 17 ms
  is the wait for the next frame.
- **On the tablet the page's side dominates.** L532 takes 110 ms, of which
  the worker is 10–12. The other ~98 ms are the main thread taking the
  outcome and parsing 182 KB of SVG into four page nodes: about 25 ms per
  45 KB page. B6 holds (Android L Must 500 ms, Goal p50 200), but B7 does
  not (§4.4). The iPhone does the same work in 16 ms.

### 4.4 Main thread (B7)

**[measured]** with the Long Tasks API: the longest task during each
visit's edits. On the tablet it was **95–105 ms**, against B7's 50 ms, on
every visit. In Chromium on the M1 there was none over 50 ms. Safari and
WebKit have no Long Tasks API, so the iPhone's figure is not observable;
its 20 ms renders bound it from above.

The long task is setting four pages in one `innerHTML` and the style and
layout that follow. The engine is in the worker and cannot cause it. The
page has to stop replacing every page on every edit: D25's page reuse (pages identified by their hash), only
the pages that changed, the visible page first (chapter 08's
`visiblePage`). At ~25 ms per 45 KB page on the tablet, at most one page
per task fits under B7. B10's bound on a page's bytes bounds this cost
too.

### 4.5 Superseded work (B8)

**[measured]**: S43 sent 20 ms into XL4256's compile (26 pages, ~95 ms in
Chromium). Time until the worker answered that the older compile was
`superseded`, 30 trials per device:

| | Fire Max 11 | iPhone SE | Chromium | WebKit |
| --- | --- | --- | --- | --- |
| Range, ms | 1.9–10.8 | 1–11 | 0–11.2 | 0–3 |

Every trial was superseded between steps, within the step budget of
`STEP_MS` (10 ms) plus a page. The longest step seen on the tablet was 17.3
ms (L532's layout and first page). B8's 50 ms holds. Before pages were
written one per step, XL4256's 26 pages were one call, and the old compile
always finished before the newer one started. Chapter 05's rule that the
engine must return between systems is what B8 needs.

### 4.6 Memory (B4)

**[measured]**, the linear memory's high-water mark (`memory.size`): **1.19
MiB** after S43 and **1.69 MiB** after L532, the same on every device. B4's
Musts are 64 MB for S and 128 MB for L. The worker's JS heap was not
measured (§7). The memory holds the whole score's display list and SVG
text at once. The engine's will be larger: grobs, contexts, skylines, the
Scheme heap and the image. But the 256 MiB maximum and the instance
recycling of chapter 08 §4.5 were not approached.

### 4.7 Threads and page size (B9, B10)

- **B9 holds**: every run had one dedicated worker, `crossOriginIsolated`
  false, no `SharedArrayBuffer`.
- **B10, against LilyPond** **[measured]** (2.26.0, `--svg
  -dpoint-and-click`, the same sources): S43 is one page in both, 18,392
  bytes against 42,914 (43 %). L532 is 182 KB in four pages against 521 KB
  in two (35 % of the bytes). LilyPond's spacing is tighter and it beams
  eighths, so the pages are not comparable one to one. Per event, the
  defined-once glyphs of chapter 06 halve what LilyPond writes even with
  links on every note: B10's Goal.

## 5. What it says

### 5.1 The devices against the M1

| Work | Fire Max 11 / Chromium (M1) | iPhone SE / WebKit (M1) | Chapter 00 §1 assumed |
| --- | --- | --- | --- |
| Interpreter loop, `(fib 25)` (ms) | 333 / 126.5 = **0.38×** | 166 / 117 = **0.70×** | 0.45× (A54), 0.85× (iPhone 12) |
| Engine work, L532 (worker ms) | 12.1 / 2.7 = 0.22× | 4 / 3 ≈ 0.75× (1 ms clock) | same |
| SVG phase, L532 (ms) | 7.3 / 2.0 = 0.27× | 3 / 2 (1 ms clock) | same |
| Page side, L532 (render − worker, ms) | ~99 / ~10.4 ≈ 0.1× | ~16 / ~19 ≈ 1× | not assumed |

- **The Android factor is lower than chapter 00 assumed, and lower again
  for allocation-heavy code.** A tight interpreter loop ran at 0.38× the M1.
  Code that allocates, copies strings and builds the outputs ran at
  0.22–0.27×. If the tablet's A78 cores clock 8 % below the A54's, as
  the specifications say (*unconfirmed*), that explains only a small part.
  For step 11: **project desktop timings onto the Android reference at
  0.25×, not 0.45×**. Chapter 00 §2.1's 120 ms layout share is then 30 ms
  on the M1, not 54. On iOS **0.7×** is measured on an A13 and is
  conservative for the A14 reference.
- **The page costs more than the engine on Android.** Ten times the M1's
  time for the same `innerHTML`, against four times for the worker. B7 and
  B6 on Android depend on how many bytes of SVG the page takes per edit
  (§4.4), more than on the engine. The iPhone's DOM is as fast as the
  M1's.
- **Cold start is the browser's, not the engine's.** The engine is ready
  27 ms (tablet) or 12 ms (iPhone) after the worker starts it, cached.
  Chapter 08 §5.2's manifest round trip, measured inside those numbers over
  USB and Wi-Fi, is not worth avoiding.
- **Lazy compilation costs the first render 40–60 ms** on a fresh profile.
  That is B5b's concern, and B5b has room for it.

### 5.2 The spike's interpreter

`(fib 25)` takes 117–127 ms on the M1 in the spike's interpreter. Chapter
08 §3.1 measured 10.5 ms (first) and 5.0 ms (second) for chapter 03's
prototype, which is 10–20 times faster. The spike allocates a frame and an
argument vector per call and clones values through `Rc`. That is the cost
chapter 03 §5 designs away with arenas, a compact value and its own stacks.
The benchmark's use here is the ratio between devices, which does not
depend on the interpreter's quality. It is no argument for the spike's
evaluator, which chapter 03 replaces.

## 6. Budgets

Chapter 00 §2's budgets, as measured on the spike. *Holds* means the
spike's frame (build, worker, transfer and page) leaves the engine room
inside the Must. It does not say the engine will meet it.

| # | Must / Goal | Fire Max 11 | iPhone SE | Verdict |
| --- | --- | --- | --- | --- |
| B1 core download | 1.5 MB / 1.0 MB | 44.9 KB brotli (wasm, image, font, worker) | same | holds; the frame is 3 % of the Must |
| B3 core wasm raw | 4 MB / 2.5 MB | 100 KB | same | holds |
| B4 peak memory | S 64 MB, L 128 MB | 1.2 / 1.7 MiB linear memory | same | holds; JS heap not measured |
| B5a cold start, cached | Android 1,200 / 600 ms; iOS 600 / 300 ms | 297 ms | 111 ms (HTTP cache) | holds |
| B5b first render | Android 800 / 400; iOS 400 / 200 | 23 ms (82 ms fresh) | 15 ms (57 ms fresh) | holds |
| B5c first visit, throttled | 3 s / 2 s | not measured (1,029 ms unthrottled) | not measured (346 ms) | open |
| B6 re-render, S | Android 250 / p50 100; iOS 150 / p50 60 | p50 16.8, p95 33.3 | p50 17, p95 17 | holds; the engine's share is 1–3 ms |
| B6 re-render, L | Android 500 / p50 200; iOS 300 / p50 120 | p50 111.5, p95 137 | p50 20, p95 24 | holds; 90 % of the tablet's time is the page |
| B7 main thread | 50 ms | **95–105 ms** | not observable | **fails on Android** with four pages replaced at once (§4.4) |
| B8 superseded | 50 ms | ≤ 10.8 ms | ≤ 11 ms | holds, with pages written one per step |
| B9 threads | one worker, no SAB | yes | yes | holds |
| B10 page size | ≤ 100 % / ≤ 50 % of LilyPond's | 43 % (S43), 35 % (L532) | same | holds |

## 7. Not measured

- **The reference devices themselves.** The iPhone SE (A13) stands in for
  the iPhone 12 (A14) and is slower. The Fire Max 11 runs Silk on the
  Galaxy A54's core type at a lower clock. The Android floor (Galaxy A15
  class) was not run.
- **Cache Storage on iOS** (chapter 08 §5.3). The iPhone ran over plain
  http to its LAN address, which is not a secure context, so `caches` is
  missing and the worker fell back to the network and the HTTP cache. To
  check it: trust mkcert's root CA on the phone, serve with `--cert` and
  `--key`, and look for `cachedAtStart` 4 on the second visit.
- **B5c.** No network throttling was applied. Without it a first visit is
  1,029 ms on the tablet, ~150 ms of it the server compressing
  `core.wasm` once (brotli 11, measured on the M1). A server should keep
  the engine precompressed.
- **The worker's JS heap** (B4's second half). It needs the remote
  inspectors of chapter 00 §6.1, which were not attached.
- **`+simd128`'s speed**, and **per-crate `opt-level` under fat LTO**
  (chapter 08 §1.3). There is no SIMD-shaped code yet, and only one crate.
- **Background tabs and thermal throttling.** Each visit ran in the
  foreground for under ten seconds.
- **Firefox**, outside chapter 00's devices.

## 8. The ordered steps

| Step | What | Checked by |
| --- | --- | --- |
| P1 | Chapter 00's projection factors replaced: Android 0.25× for allocation-heavy code (0.38× for an interpreter loop), iOS 0.7×. Chapters 04–07's shares of B6 re-derived with them | the spike's harness on each milestone's build |
| P2 | The page updates only what changed: D25's page reuse (pages identified by their hash), the visible page first, at most one page per task (`requestAnimationFrame` per page) | B7 on the tablet with L532: no task over 50 ms |
| P3 | The engine returns between pages and systems (here: pages; chapter 05 §7.3: systems), never one call per compile | B8 with XL4256 on the tablet |
| P4 | No `core::fmt` and no float parsing from `std` on any path the core reaches; a size check that fails on `core::fmt::` in the `wasm-names` build | chapter 08 K1's size gate |
| P5 | The engine's files precompressed (brotli 11) when built; the server sends them as they are | B5c with throttling |
| P6 | The harness kept as the measuring tool: run on a real iPhone 12 or later over trusted HTTPS (Cache Storage), and on an A15-class Android phone with Chrome | chapter 00 §6.1's full conditions |

## 9. What later chapters take

| Chapter | Takes |
| --- | --- |
| 11 roadmap, D56 | the speed factors of §5.1 for every projection; B7's failure and its remedy (P2) as a requirement on the page, not the engine; the measured frame of §6 (45 KB brotli, 27 ms ready, 1–3 ms per compile of the frame itself) as each milestone's baseline; the crate and harness as the phone gate of every milestone; the open items of §7, chief among them Cache Storage on iOS |

## Appendix A: recipes

**Build.** Binaryen 133's `wasm-opt` on the PATH, or given as `WASM_OPT`.
LilyPond installed, for the font:

```sh
packages/studio/crates/engine-spike/harness/build.sh     # VARIANT=ia (default) | stable | simd; SITE=0 skips the site
```

It runs `cargo +nightly build -p lily-engine-spike --lib --profile wasm
--target wasm32-unknown-unknown -Zbuild-std=std,core,alloc,panic_abort`
with `RUSTFLAGS="-Zunstable-options -Cpanic=immediate-abort
-Clink-arg=--max-memory=268435456"`, then `wasm-opt -Oz` with the six
features. It writes `dist/engine/` (`core.wasm`, `core.image` from
`prelude.scm`, `emmentaler-20.pack` cut by `pack.mjs`, and `manifest.json`)
and then `node esbuild.mjs --site --production`, which copies them into
`dist/site/engine/` under hashed names beside `engine.worker.js`. It prints
raw, gzip and brotli bytes. The size table of §2.1 is the same commands
with `CARGO_PROFILE_WASM_OPT_LEVEL=3` and `wasm-opt -O3` for the speed row.

**Code breakdown** (§2.1): the `wasm-names` profile with the same flags,
`wasm-opt -Oz --debuginfo` to keep names, then each function body's size
from the code section, grouped by its name in the name section (functions
of `lily_engine_spike` and the `lily_*` exports; `dlmalloc`; `core::fmt`;
compiler builtins; the rest of `std`, `core` and `alloc`).

**Serving and the devices** (§3):

```sh
node packages/studio/crates/engine-spike/harness/serve.mjs --results <file>          # http on 8471
node …/serve.mjs --port 8472 --cert <c> --key <k> --results <file>                   # https, mkcert's
adb reverse tcp:8471 tcp:8471                                                        # Android: localhost is a secure context
adb shell am start -a android.intent.action.VIEW -d 'http://localhost:8471/?label=<l>' com.amazon.cloud9
xcrun devicectl device process launch --device <id> --terminate-existing \
  --payload-url 'http://<LAN address>:8471/?label=<l>' com.apple.mobilesafari      # needs Developer Mode and an unlocked phone
```

Each load runs the whole sequence and POSTs one JSON line. The buttons
*Run again (cached)* and *First visit (clear cache)* reload by hand.

**Desktop** (§3, the Chromium and WebKit columns), from a directory with
`playwright` 1.59.1 installed and the server running:

```sh
node packages/studio/crates/engine-spike/harness/measure.mjs http://localhost:8471/ 6
```

**B10** (§4.7): the sources of S43 and L532 from `score()` in `harness.js`,
with `iota` defined at the top, since LilyPond's Scheme lacks it, and
`lilypond --svg -dpoint-and-click`.
