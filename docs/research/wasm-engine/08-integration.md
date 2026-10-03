# 08 — The wasm build, its modules, the worker and offline caching

Chapter 08 of the investigation into an engine of our own (chapter 00 sets
the budgets and the test set, chapter 01 maps LilyPond's source, chapters
02–07 design the parser, the Scheme interpreter, the music model, the
layout, the SVG and PDF output, and MIDI). It measures how to build Rust
for the smallest wasm (§1), splits the engine into a core and modules
fetched on demand (§2), measures what loading costs in the browsers (§3),
designs the worker that runs it (§4), caches it for offline use (§5), keeps
the diagnostics in the format the apps already read (§6), and says how Lily
Studio on the web (D55) loads it (§7). It records no decision; D56 (step
11) will.

The host side was written with this chapter, in `packages/studio`:
`src/web/engine/` (the protocol and the wasm ABI, the triggers that fetch
modules early, the driver that runs the engine in steps, the worker and
the page's host), `esbuild.mjs --site`, which bundles `engine.worker.js`
and copies the engine's files under hashed names, and
`test/engine.test.ts`. No page loads it yet, and without an engine build
`--site` writes what it wrote before plus `engine.worker.js`.

Everything marked **[measured]** was taken on 2026-10-03 on the M1 Max of
chapter 00 with rustc 1.97.0 (stable) and 1.98.0-nightly (2026-05-24),
Binaryen 133 (`wasm-opt`, `wasm-split`), Node 24.14, Playwright 1.59.1 with
its headless Chromium 147.0.7727.15 and WebKit 26.4, and brotli 1.2 at
`-q 11`. KB is 1,000 bytes. The probes are the earlier chapters' own:
chapter 03's Scheme prototype (2,233 lines of Rust), chapter 07's MIDI
writer (551 lines, `no_std`) and chapter 06's `pdfmin` (129 lines, with
`pdf-writer` and `miniz_oxide`). The recipes are in Appendix A. Projections
onto the phones use chapter 00's factors (× 1/0.45 for the Android
reference, × 1/0.85 for the iPhone 12). What was not measured and not found
in a primary source is marked *unconfirmed*.

## 1. The Rust-to-wasm build

### 1.1 Target and features

`wasm32-unknown-unknown`, with the C ABI over linear memory and no
`wasm-bindgen`: the engine exchanges bytes and strings (§4.2), which needs
no generated glue, and the host's JavaScript is 7.7 KB in all (§3.1).
rustc 1.97 enables by default, for this target, exactly the features of
chapter 00 §1.1 **[measured]** (`rustc --print cfg --target
wasm32-unknown-unknown`): `bulk-memory`, `multivalue`, `mutable-globals`,
`nontrapping-fptoint`, `reference-types` and `sign-ext`. Fixed-width SIMD
(`+simd128`, Safari 16.4) is allowed by §1.1 but not enabled: what it saves
in skyline merging and what auto-vectorisation adds in size is for step 10
to measure.

`wasm-opt` must be given the same features, not `-all`: a module optimised
with `-all` used encodings that Node 24 refused to load **[measured]**
(`unknown import kind 0x7e`). Appendix A has the flags.

### 1.2 What the size settings do

**[measured]**, bytes of each probe for `wasm32-unknown-unknown`. *z* is
chapter 03's and 06's profile: `opt-level = "z"`, `lto = true`,
`codegen-units = 1`, `panic = "abort"`, `strip = true`. Each row changes one
thing; *+Oz* is `wasm-opt -Oz` after it. *ia* builds the standard library
with the program, on nightly, with `-Cpanic=immediate-abort`: a panic is
the `unreachable` instruction, with no message, location or formatting.

| Probe | Build | Raw | gzip -9 | brotli |
| --- | --- | --- | --- | --- |
| Scheme | z | 157,997 | 69,069 | 60,460 |
| | z, `lto = "off"` | 157,997 | 69,051 | 60,537 |
| | z, `codegen-units = 16` | 162,490 | 69,862 | 60,852 |
| | `opt-level = "s"` | 166,589 | 72,240 | 62,630 |
| | `opt-level = 3` | 182,536 | 76,114 | 65,027 |
| | 3 +O3 | 162,550 | 73,099 | 63,119 |
| | z +Oz | 138,022 | 67,315 | 59,038 |
| | z ia | 123,301 | 57,876 | 51,074 |
| | **z ia +Oz** | **106,754** | **55,669** | **49,176** |
| MIDI | z | 21,262 | 9,600 | 8,183 |
| | z, `codegen-units = 16` | 21,386 | 9,564 | 8,128 |
| | `opt-level = 3` | 26,941 | 11,601 | 9,613 |
| | z +Oz | 16,695 | 8,360 | 7,080 |
| | **z ia +Oz** | **13,803** | **7,048** | **6,095** |
| `pdfmin` | z | 131,677 | 59,056 | 52,028 |
| | z, `codegen-units = 16` | 137,609 | 60,465 | 52,769 |
| | `opt-level = 3` | 151,970 | 62,605 | 53,768 |
| | z +Oz | 112,557 | 56,813 | 50,091 |
| | **z ia +Oz** | **73,115** | **40,795** | **37,218** |

What it says:

- **`opt-level = "z"` is the smallest**; `s` is 4–7 % bigger, 3 is 15–27 %
  bigger.
- **LTO and codegen units hardly matter here.** With LTO off the Scheme
  prototype came out byte for byte the same, and 16 codegen units cost
  0.6–4.5 % raw. These probes are one crate or three; the engine will be a
  dozen, where cross-crate inlining counts more. LTO and one codegen unit
  stay: they cost build time only.
- **`wasm-opt -Oz` takes 13–22 % of the raw bytes but only 2–14 % of the
  brotli bytes**: much of what it removes, brotli had already compressed
  away. It stays, because B3 counts raw bytes (compiled code and memory
  on iOS, chapter 00 §2.1).
- **Panic strings are the largest single saving**: with `wasm-opt`, 23 %,
  17 % and 35 % raw and 17 %, 14 % and 26 % brotli. What goes is
  `core::fmt` reached from panics, the messages and the source locations,
  even in the `no_std` MIDI probe, which had its own panic handler. The
  prototype also got faster: 550 ms for chapter 03's eight benchmarks
  against 631 (b5 and b7 by 22–23 %), because bounds checks no longer branch
  to formatting code. The speed build (3 +O3) takes 459 ms at 162,550
  bytes. Its gain is in std's string and allocator code (b4–b6), not in
  the VM loop (b1–b3, within 3 %).

### 1.3 The profile

```toml
# The engine's Cargo workspace (step 11 creates it; step 10's crate uses it).
[profile.wasm]
inherits = "release"
opt-level = "z"
lto = "fat"
codegen-units = 1
panic = "abort"
strip = true

# For wasm-split (§2.3): the same with the name section kept.
[profile.wasm-names]
inherits = "wasm"
strip = false
```

```sh
RUSTFLAGS="-Zunstable-options -Cpanic=immediate-abort -Clink-arg=--max-memory=268435456" \
  cargo +nightly-2026-05-24 build --profile wasm-names --target wasm32-unknown-unknown \
  -Zbuild-std=std,core,alloc,panic_abort
wasm-split …              # §2.3, on the build with names
wasm-opt -Oz $FEATURES --strip-debug --strip-producers   # each output of wasm-split
```

- **A pinned nightly for the wasm build only.** `-Zbuild-std` and
  `-Cpanic=immediate-abort` are unstable. The toolchain is pinned in the
  engine's `rust-toolchain.toml` for this one build. Native builds, tests
  and Lily Studio's crates stay on stable. If the pinned nightly ever has to
  go, the stable build of the same code is 14–26 % bigger in brotli and still
  inside B1 (§2.2).
- **A panic is a trap.** The worker sees a `RuntimeError`, starts a new
  instance and reports the compile as one that did not run (§4.5). There is
  no message. For a bug report, a second build with messages (stable,
  `panic = "abort"` and a panic hook that passes the message to an
  import) is published beside the core as `core-debug`. The page loads it
  instead when asked (`?engine=debug`). It is not part of any budget.
- **The memory maximum.** `--max-memory=268435456` declares B4's 256 MiB.
  A score that needs more makes the allocator fail, the engine trap, and
  the driver report *The score needs more memory than the engine may use
  (256 MiB).* instead of iOS killing the tab (chapter 00 §1). The stack
  stays Rust's 1 MiB: the Scheme interpreter keeps its stacks on the heap
  (chapter 03 §5.3).
- **Speed where it counts.** Chapter 03 asked to build the hot primitives
  for speed. A per-crate `opt-level` override (`[profile.wasm.package.X]`)
  is the only way Cargo offers. Whether it survives fat LTO, which
  optimises the merged module at one level, is *unconfirmed*, and is for
  step 10 to try once the interpreter is a crate of its own. The
  measurement above says where the speed went: into std's generic string
  and allocation code. So the interpreter's hot paths should avoid it (its
  own arenas, byte-level string search) rather than build everything at
  level 3, which costs 52 % in size.

## 2. A core and modules on demand

### 2.1 The core against B1 and B3

What chapters 02–07 budgeted for the core, in brotli KB (B1). Raw wasm is
converted at the prototype's measured 0.45 brotli bytes per raw byte, after
`wasm-opt`:

| Part | Chapter | Must | Goal | Estimated now |
| --- | --- | --- | --- | --- |
| Parser | 02 §5.8 (250 / 150 KB raw) | ≈ 110 | ≈ 70 | — |
| Scheme interpreter | 03 §7 | 250 | 180 | 140–190 |
| Core image (data) | 03 §7 | 450 | 300 | 300–450 |
| Music model, contexts, translators | 04 §12 | 180 | 120 | 150–195 (340–430 KB raw) |
| Layout and the core's notation | 05 §9 | 450 | 300 | ≈ 430 (0.95 MB raw) |
| SVG writer | 06 §6 | — | — | not estimated |
| Fonts in the core (data) | 06 §8 | 120 | 80 | ≈ 70 |
| MIDI performers and writer | 07 §6 | 150 | 40 | 30–40 |
| Worker script | 08 | 10 | 5 | 2.9 measured |
| **Sum** | | **≈ 1,720** | **≈ 1,095** | **≈ 1,120–1,380**, without the parser and the writer |
| B1 | 00 | 1,500 | 1,000 | |

- **The chapters' Musts do not fit B1 together.** Their sum is 1.7 MB
  against 1.5. Step 11 has to share B1 out for good, as chapter 00 §7 says.
- **The estimates fit, with §1's settings.** They were made from builds
  with panic strings. Taking 15 % off the wasm parts (§1.2 measured 14–26
  % in brotli), the core comes to about 1.05–1.3 MB with a parser of 70 KB:
  inside B1's Must, near its Goal. The image is the largest item and the
  least certain one (chapter 03 §5.6). Its Goal of 300 KB decides whether
  B1's Goal is met.
- **B3 holds with room.** The raw wasm estimates (parser 150–250 KB,
  interpreter 355–480, music 340–430, layout 950, MIDI 80–100) come to
  1.9–2.2 MB, about 1.5–1.8 MB with §1's settings, against B3's Goal of
  2.5 MB.

### 2.2 Three kinds of module

What is fetched on demand is not all code, and code is not all alike:

1. **Data for the core's memory.** The image, the Scheme parts of chapter
   03 §6 (compiled, not source), the font packs of chapter 06 §5.2, and
   LilyPond's `ly/` files. The worker fetches them and hands them over with
   `lily_put` (§4.2). Nothing is linked.
2. **Code with a memory of its own.** The PDF writer (chapter 06 §7.3) takes
   the display list as bytes and returns the PDF. It is a separate wasm
   module, instantiated in the worker for an export and dropped after it, so
   its memory goes with it (B4). It carries its own allocator and runtime.
   That is part of its 37–90 KB.
3. **Code that works on the core's data.** The notation that chapter 05
   §5.10 moves out (tablature and fret diagrams, figured bass, chord names,
   ambitus, pedals, percent repeats) and the general `syntax-case` expander
   (chapter 03 §6) read and write the core's grobs, contexts and heap. They
   must run in the core's memory. Rust cannot build wasm side modules for
   `wasm32-unknown-unknown` that share a memory (Emscripten's are C and
   C++). So they come from **splitting the linked core** with Binaryen's
   `wasm-split`: one Rust program, one link, then some functions moved into
   a secondary module that imports the primary's memory, table and globals.
   In the primary they are *placeholders*, imports that run only if the
   module was not loaded.

**MIDI stays in the core.** Chapter 07 §8 proposed the MIDI part as a module
loaded at idle. Its performers run on chapter 04's translator framework and
read the music in the core's memory, so it would be of the third kind. But
Lily Studio's preview plays every compile (D35), with the map of D26. A
module that nearly every compile needs is part of the core, and at 30–40 KB
it fits B1's sum above.

### 2.3 Splitting the core, measured

**[measured]**: chapter 03's prototype built with names and §1's settings;
its 13 string and symbol primitives (`string-append`, `substring`,
`number->string`, `symbol->string` and the like) split into a secondary
module with `wasm-split --split-funcs`, then each output through `wasm-opt
-Oz`. Run in Node on chapter 03's benchmarks: first the primary alone, its
placeholders throwing; then the secondary instantiated with the primary's
exports, in the same instance.

| | Raw | gzip | brotli |
| --- | --- | --- | --- |
| Whole | 106,976 | 55,877 | 49,415 |
| Primary | 104,892 | 55,063 | 48,672 |
| Secondary | 3,766 | 1,915 | 1,695 |
| Split, together | 108,658 (+1.6 %) | 56,978 (+2.0 %) | 50,367 (+1.9 %) |

- **The primary runs alone.** b1, b2, b3, b5, b7 and b8 ran on it with
  correct results. b4 and b6 called a split function: the placeholder threw
  an ordinary JavaScript exception out of `lsb_eval`.
- **Loading the secondary is instant**: 0.03 ms to instantiate. It writes its
  functions into the shared table over the placeholders. After that, b6
  ran in 152.5 ms against 146.2 ms for the whole module, b1 in 59.2 against
  63.3, and all eight results were right.
- **A split must follow the call graph, not names.** b4 builds property
  lists and was not expected to need a string primitive. But it calls
  `number->string`, which was in the split set, so it hit a placeholder. A
  module's functions are therefore those reachable *only* from its own
  entry points. The build computes that set from the call graph, starting
  at a module's crate (one crate per module, `lily_tab::…` and so on). Every
  function the core reaches stays in the core. And the test of §4.6 runs
  every score of the corpus with only the modules its triggers name, and
  fails on any restart.
- **Order**: `wasm-split` works on the build with names, before `wasm-opt`.
  After `wasm-opt -Oz`, 2 of the 13 names were gone (merged as duplicates)
  and nothing was split.

### 2.4 The modules

| Module | Kind (§2.2) | What | Fetched | Size |
| --- | --- | --- | --- | --- |
| `core.wasm` | core | parser, interpreter, music, layout and common notation, SVG writer, MIDI and the playback map | at start | §2.1 |
| `core.image` | data | the heap after `declarations-init.ly` (chapter 03 §5.6) | at start | 300–450 KB |
| `emmentaler-20`, text metrics | data | chapter 06 §5.2's core packs | with the core (`preload`) | ≈ 70 KB |
| `emmentaler-11` … `-26` | data | the other optical sizes | `set-global-staff-size`; grace and cue notes, `\small` (`-14`) | ≈ 35 KB each |
| `braces` | data | chapter 06's four brace files as one: a trigger cannot tell which size a brace will be | `PianoStaff`, `GrandStaff`, `SystemStartBrace` | 20.7 KB |
| `chords`, `display`, `fretted`, `diagrams`, `partcombine`, `modal`, `qr` | data | chapter 03 §6's Scheme parts | their triggers (`modules.ts`) | 3–21 KB of source each |
| `ly/<file>` | data | LilyPond's includable `ly/` files | `\include "<file>"` | per file |
| `chord-names`, `tablature`, `figured-bass`, `ambitus`, `pedals`, `percent` | split | chapter 05 §5.10's notation | their triggers | ≤ 100 KB each (05 §9) |
| `syntax-case` | split | the general expander | on the form (no trigger: a restart) | 20–35 KB raw (03 §4.2) |
| `pdf` | own memory | chapter 06 §7.3's writer, with its text fonts | on export | 75–90 KB, 500 KB Must |

`src/web/engine/modules.ts` holds the triggers. `modulesFor(source,
manifest)` scans the texts of a compile for what they name, so the worker
fetches those modules before the first step. A miss costs one restart, not
a wrong result (§4.4).

## 3. Loading and cold start

### 3.1 Measured

**[measured]**: a page starts a dedicated worker, which takes a module from
Cache Storage (or fetches it and puts it there), compiles it with
`WebAssembly.compileStreaming`, instantiates it, and copies a 2 MiB image
into a fresh memory. The 107 KB module is the Scheme prototype; *eval* is
its `(fib 25)` run twice in the same instance. The 2.6 and 3.9 MB modules
are chapter 03's Steel builds, which stand in for a core at B3's Goal and
Must. Milliseconds, the first visit and then the median of visits 3–7.
WebKit's timers have a resolution of 1 ms. Its later visits fetched from
the network, not the cache (§5.3).

| | Chromium 147 | | | WebKit 26.4 | | |
| --- | --- | --- | --- | --- | --- | --- |
| Module | 107 KB | 2.6 MB | 3.9 MB | 107 KB | 2.6 MB | 3.9 MB |
| Worker started | 3.2 / 2.6 | 2.8 / 2.5 | 3.0 / 2.7 | 3 / 3 | 4 / 2 | 4 / 3 |
| Fetch and put / cache match | 3.2 / 0.4 | 10.3 / 0.4 | 13.5 / 0.5 | 2 / 2 | 6 / 4 | 8 / 6 |
| `compileStreaming` | 0.5 / 0.5 | 2.8 / 3.1 | 3.0 / 2.9 | 1 / 1 | 13 / 12 | 9 / 9 |
| Instantiate | 0.1 / 0.1 | 0.2 / 0.3 | 0.3 / 0.2 | 1 / 0 | 1 / 2 | 1 / 2 |
| Image copied, 2 MiB | 0.2 / 0.2 | 0.2 / 0.1 | 0.2 / 0.2 | 1 / 1 | 0 / 0 | 0 / 0 |
| First eval / second | 10.5 / 5.0 | | | 12 / 10 | | |

`engine.worker.js`, as `esbuild.mjs --site --production` builds it: 7,656
bytes, 2,875 with brotli.

### 3.2 What it says

- **Compiling is lazy in both browsers.** 3–13 ms for 2.6–3.9 MB says no
  engine compiled the whole module up front. Functions compile on first
  call. The prototype's first `(fib 25)` took twice as long as its second
  in Chromium. That cost lands in B5b, the first render, not in B5a.
  Chapter 00 §2.1 assumed the whole module is compiled before the first
  call, so B3 still bounds the work, but it is spread out. Step 10 times
  the first render on the phones, where tiering may differ.
- **The engine's share of B5a is small.** Worker, cache, compile,
  instantiate and image for the 2.6 MB module: about 7 ms in Chromium and
  20 ms in WebKit on the M1. That projects to about 14 ms on the Android
  reference and 24 ms on the iPhone 12. Add one round trip for the manifest (§5.2): 100 ms in B5c's
  conditions. All of it fits B5a's 600 ms Must many times over. What decides
  B5a for Lily Studio on the web is its own page: `app.js` is 5.2 MB, 1.10
  MB with brotli (Monaco), and with pdf.js's worker, Monaco's worker, the
  icon font and the CSS the page is about 1.58 MB with brotli **[measured]**,
  as large as the engine's core.
- **Code caching.** Chrome keeps compiled wasm in its code cache when the
  module was compiled by streaming, is at least 128 KB, and TurboFan has
  finished with it ([V8](https://v8.dev/blog/wasm-code-caching)). Whether a
  response from Cache Storage qualifies as one from the HTTP cache does is
  *unconfirmed*. With lazy compilation it decides how soon a revisit runs at
  full speed, not when the engine is ready.
- **Restarting is cheap.** A new instance and the image copy take under
  3 ms. That is what §4.5 does after every trap, and what makes it
  reasonable never to trust an instance that trapped.

## 4. The worker

### 4.1 One dedicated worker

The engine runs in one dedicated worker per page (B9), started from
`engine.worker.js` beside the page. It needs no `SharedArrayBuffer`, so no
COOP or COEP headers: chapter 00 §2.1 explains why. The worker is a
classic script (esbuild's `iife`) and works in every browser of chapter
00 §1. Everything the engine does is in it: fetching and caching its files
(§5), the compiles, and later the PDF module. The page sends texts and
receives `CompileOutcome`s.

### 4.2 Protocol and ABI

`src/web/engine/protocol.ts`. The page sends `compile` (a revision, the root
file, the texts of the open editors, the page the preview shows) and `file`
(the answer to a question). The worker sends `ready`, `needs-file`,
`finished` with a `CompileOutcome` (§6), `superseded`, and `failed` when the
engine cannot start. The MIDI bytes are transferred, not copied.

The core exports a C ABI. Strings are UTF-8, given as a pointer and a length
in memory the engine allocated:

| Export | What |
| --- | --- |
| `memory` | linear memory, at most 256 MiB |
| `lily_alloc`, `lily_free` | memory for what the host copies in or reads out |
| `lily_start(image)` | restores the image (chapter 03 §5.6); 0 when it worked |
| `lily_put(kind, name, data)` | a source file (`kind` 0; data 0: no such file) or a module's data (`kind` 1) |
| `lily_compile(revision, root, visiblePage)` | starts a compile; work done for an earlier revision is reused (chapter 02 §5.7, chapter 04 §10) |
| `lily_step(budgetMs)` | works for about `budgetMs`: 0 done, 1 more, 2 needs something |
| `lily_needs(out)` | what it needs: kind, name pointer, name length |
| `lily_outputs()`, `lily_output(i, out)` | the output files: name and data, pointer and length each |

Its only import is `env.lily_now()`, the clock for the step budget. A
split module's placeholders are imported from `placeholder.<module>`.

### 4.3 Steps, and a newer edit

Without shared memory the worker cannot be interrupted during a call. So
the engine works in steps of `STEP_MS` (10 ms), returning at the points
chapters 04 §8 and 05 §7.3 call cancellation checks. Between steps the
driver gives back control with a `MessageChannel` message to itself. A
message from the page that came meanwhile is handled first. If it is a
newer compile, the running one ends with `superseded` and the newer one
starts. B8's 50 ms is then the step budget, one task, and the longest
step the engine cannot split (chapter 05 §9: 20 ms Must). The page's host
(`host.ts`) answers only the newest compile and resolves the others with
`undefined`, as the extension's live queue keeps only the newest revision.

### 4.4 What a compile lacks

When the engine needs something it does not have, `lily_step` returns 2:

- **A file** (`\include` of the score's own files): the worker asks the
  page, which reads it as it reads any file (on the web, `read_file` from the
  user's worker on the server). If there is no such file the answer is
  `null`, and the engine reports LilyPond's own error for it.
- **A module**: the worker fetches it from the manifest and puts it into
  the core, or instantiates it into the core's memory if it is a split
  module. If it cannot be fetched (offline, never cached), the compile ends
  as one that did not run (`state: 'error'`, *The engine could not compile
  the score: …*, naming the file), and the page compiles elsewhere (§7).

Then the compile starts again with the same revision. Chapter 03 §6
designed this restart because a worker cannot wait for a fetch in the
middle of a call. It is cheap because the parser and the music model reuse
what the first attempt did. The triggers of §2.4 fetch modules before the
first step, so on the corpus the restart should be for score includes only.

### 4.5 Traps and placeholders

A trap (`unreachable` from a panic, or a failed allocation at the maximum)
and a placeholder's exception both unwind out of `lily_step` through the
engine's frames. That skips whatever the Rust code was in the middle of,
including restoring its shadow stack pointer, a global the host cannot see
to reset. So the driver never calls an instance that unwound again. It
instantiates the core anew, instantiates every split module loaded so far
into it, restores the image, and puts the data modules back. That takes
under 3 ms (§3.1). The new memory also gives back the old one's high-water
mark, which WebAssembly never shrinks (B4). Then it either loads the
missing module and starts the compile again, or reports the compile as one
that did not run: `state: 'error'` with *The engine stopped: …*, or the
memory message of §1.3 when memory was at its maximum. The next compile
runs on the new instance.

### 4.6 Tests

`test/engine.test.ts` (16 tests, with `npm run test:unit` in
`packages/studio`) runs the driver against an engine written in JavaScript
behind the same ABI. Each test scripts the engine's steps. A compile runs in
steps to its outcome. A newer request supersedes the running one between
steps. A missing file is asked of the page, and `null` passes to the engine
as no such file. A placeholder leads to a new instance with the split module
in it. A trap is a compile that did not run, and the next one starts afresh.
A trap at the memory maximum says so. A module that cannot be fetched ends
its compile with a message, and the next compile runs. They also cover the triggers, the
outcome's mapping, and the host's answers.

**[measured]** end to end: a 27,196-byte stand-in engine in Rust (Appendix
A), built with §1's settings, went through `esbuild.mjs --site`'s
`copyEngine` with a 2 MiB image, a Scheme part and a font pack, and was run
by the built `engine.worker.js` in Chromium and WebKit. The page sent a
compile and, 5 ms later, a newer one. In both browsers the first was
superseded. The second asked for its two includes, one of which did not
exist, and finished with LilyPond's diagnostic for the missing file. The
SVG showed the image, the part fetched by trigger and the preloaded pack.

## 5. Caching for offline use

### 5.1 Two layers

- **Names that carry their hash.** `esbuild.mjs --site` copies the engine's
  build (`dist/engine/` and its `manifest.json`) to `dist/site/engine/`.
  Each file is named `<name>.<12 hex digits of SHA-256>.<ext>`, and the
  manifest is rewritten to match. A URL never changes its bytes, so a
  cached file is never stale and never needs revalidating.
- **Cache Storage, kept by the worker.** `worker.ts` takes every engine file
  from the cache `lily-engine`, and fetches and stores it on a miss. It does
  not need a service worker. It works on the first visit, before any service
  worker could control the page, and in a page that never has one.
- **The HTTP cache behind it.** The server should send `Cache-Control:
  public, max-age=31536000, immutable` for `engine/*` and `no-cache` for
  `engine/manifest.json`. Then a browser that does not keep Cache Storage
  (§5.3) still downloads the core once. D55's gateway serves `dist/site/`
  through `ServeDir` with no `Cache-Control`. Adding it belongs to §7's
  integration.

### 5.2 The manifest

On every start the worker fetches `engine/manifest.json` with `cache:
'no-cache'`, so a new build is seen at the next start. It keeps a copy in
the cache and uses that copy when the network fails, so an engine that was
used once starts offline. After it is ready, it deletes from the cache
every file the current manifest does not name: an old build's. The cost is
one round trip at each start (§3.2). If step 10 finds that too slow on the
phones, the worker can start from the cached manifest and check for a new
one in the background. A new build would then arrive one visit late, which
needs the page and the worker to agree on the protocol across versions.

### 5.3 Verified

**[measured]** with the stand-in engine of §4.6. Second visit, with the
server answering 503 for everything under `engine/`:

- **Chromium**: no engine file was fetched at all. The manifest, core, image,
  part and pack all came from the cache, and the same two compiles gave the
  same results.
- **WebKit (Playwright's build 26.4)**: the second visit failed with
  `manifest.json: 503`. Cache Storage was empty after a navigation. A
  separate test showed that this build keeps nothing in Cache Storage
  across a navigation, whether the page or a worker wrote it, in an
  ephemeral or a persistent context. Chromium kept every case. This looks
  like a property of the test browser and not of Safari. Safari 17 counts
  the Cache API in its storage policy
  ([WebKit](https://webkit.org/blog/14403/updates-to-storage-policy/)).
  But it is *unconfirmed* until step 10 reloads on an iPhone. The HTTP
  cache of §5.1 is the second line if it holds.

### 5.4 Eviction

Offline is best effort:

- Safari deletes all script-writable storage of a site, the Cache API
  included, after seven days of Safari use without interaction with the
  site. Web apps added to the home screen have their own count
  ([WebKit](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)).
  Since Safari 17 a browser app's origin may use up to 60 % of the disk.
  Origins are evicted whole, least recently used first, and
  `navigator.storage.persist()` asks to be kept
  ([WebKit](https://webkit.org/blog/14403/updates-to-storage-policy/)).
- Chrome evicts best-effort storage under pressure, and grants `persist()`
  on its own heuristics.

The host may ask for persistence once the user has used the engine, not on
the first visit. An evicted engine is downloaded again (B5c). Lily Studio on
the web compiles on the server meanwhile (§7).

### 5.5 No service worker yet

A service worker would let a page *open* offline. Lily Studio's page on the
web cannot work offline: the scores are on the server, signing in needs it,
and so does the socket (D55). The page is also `no-store`, and a service
worker controlling `/` would have to handle the sign-in redirects. What
offline means for the engine is covered without one. Rendering goes on
when the network drops after the page loaded, and a revisit downloads
nothing but the manifest. A service worker belongs to a page that can open
offline, with its scores kept in the browser (OPFS or IndexedDB). It would
precache the manifest's core on install, serve `engine/` from the same
cache first and the page's shell from the network first. Nothing like that
is planned. The extension's webview cannot register a service worker; it
would load the engine from the VSIX's own files, where there is nothing to
download.

## 6. The existing error format

The apps read diagnostics as `LyDiagnostic` (`@lily/common/types`). The
extension parses them from LilyPond's stderr (D6). Lily Studio's Rust port
does the same (D42), and the renderer takes them in a `CompileOutcome`
(`src/ipc.ts`). The engine keeps all of this:

- **It writes both forms from one list.** `stderr` is in LilyPond's own
  format: `file:line:column: error: message`, the source line, and the
  caret line, with columns 1-based in code points and tabs expanded to 8 (D6,
  ARCHITECTURE §3.5). `diagnostics.json` is the same list as
  `LyDiagnostic[]`. The page reads `diagnostics.json`, so neither the page
  nor `packages/common` needs a stderr parser. Chapter 00's C0 checks that
  `parseStderr` of the engine's `stderr` equals its `diagnostics.json`, and
  equals `parseStderr` of LilyPond's stderr for the same score.
- **The outcome is the one the renderer takes.** `outcomeOf` (`driver.ts`)
  maps the output files: `failed` when there is an error, else `ok`. `svg`
  holds the pages in the order the engine wrote them (`<base>.svg` or
  `<base>-<n>.svg`), with their `textedit://` links (chapter 06 keeps them).
  `midiData` is the first `.midi` file and `timing` the `.timing.json` map
  (D26). So the preview, the diagnostics pane and the player work on it
  unchanged.
- **When the engine itself fails**, the outcome has `state: 'error'` and a
  `message`, as for a LilyPond that did not run. The renderer already shows
  that.
- **Names.** The paths in diagnostics and links are those the page gave in
  the request: on the web, the workspace paths the editor opened. So a link
  opens the file the editor has.

## 7. How Lily Studio on the web loads it

D55 serves `dist/site/` from `lily-studio-server`. It runs LilyPond in a
sandboxed worker per user and sends compiles back over the socket. The
engine joins it this way, as the roadmap's integration milestone (step
11):

1. **Build.** The engine's own build (cargo, `wasm-split`, `wasm-opt`, the
   image writer) leaves `dist/engine/` with a `manifest.json` in the format
   of `protocol.ts`, with names without hashes. `node esbuild.mjs --site`
   then does what this chapter added: it bundles `engine.worker.js` and
   copies the files to `dist/site/engine/` with hashed names. Without
   `dist/engine/` nothing is copied, and the page compiles on the server as
   it does today.
2. **Server.** Nothing is required. `ServeDir` already serves the files
   without sign-in, like the page's scripts. `tower-http` uses `mime_guess`,
   which maps `.wasm` to `application/wasm`, so streaming compilation works.
   D55's Content Security Policy already allows `'wasm-unsafe-eval'`,
   `worker-src 'self'` and `connect-src 'self'`. To add: the
   `Cache-Control` of §5.1.
3. **Start.** The page starts the engine before anything else, so the
   worker's fetches run beside `app.js`'s 1.1 MB. A small `engine.js` entry
   loaded before `app.js` creates `EngineHost.start(readFile)`. `readFile`
   is the transport's `read_file`. It does this only when the page is
   hosted.
4. **Live preview.** While the engine is ready, the web transport handles
   D36's live compiles in the page. On `edited` it compiles with the
   editors' texts through `EngineHost.compile`. The outcome goes to the
   renderer as a compile event, as the socket's would. The server's own live
   compiles are switched off with `set_live`, so they do not run twice.
   Saved compiles (D31), Export PDF (D33) and Export MIDI (D54) stay on the
   server until the PDF module (chapter 06 W7) and the engine's MIDI (chapter
   07 M7) are there.
5. **Fallback.** If the engine fails to start, the host reports `failed`.
   If a compile ends in `state: 'error'`, or a score needs what the engine
   does not do yet, the transport sends that revision to the server as
   today. The web never gets worse than D55.
6. **What it gains.** Edits render without a round trip and without the
   server's CPU, which D55 does not limit per worker. A score's Scheme then
   runs in the user's own browser. D55 has to sandbox LilyPond with
   bubblewrap because a score is a program that can read and write files.
   The engine gives Scheme no file system, only what the host hands it.

## 8. Budgets

Proposed for step 11 to confirm. Times are on chapter 00's Android
reference unless they say otherwise.

| What | Must | Goal | Now |
| --- | --- | --- | --- |
| B3: core wasm, raw | 4 MB | 2.5 MB | 1.5–1.8 MB estimated (§2.1) |
| B1: core download, brotli | 1.5 MB | 1.0 MB | 1.05–1.3 MB estimated (§2.1) |
| Worker script, brotli | 10 KB | 5 KB | 2.9 KB measured |
| Size saved by §1's settings against chapter 03's, brotli | — | — | 14–26 % measured |
| Cost of splitting a module out | 3 % | 2 % | 1.9 % brotli, 1.6 % raw measured (§2.3) |
| Engine's part of B5a: worker started to ready, cached, without the manifest's round trip | 100 ms | 30 ms | ≈ 14 ms Android, ≈ 24 ms iPhone, projected from 7 ms (Chromium) and 20 ms (WebKit) on the M1 |
| New instance after a trap, with the image | 20 ms | 5 ms | < 3 ms on the M1 |
| B8: newer edit to the running compile stopped | 50 ms | 20 ms | step budget 10 ms plus the engine's longest step (chapter 05 §9) |
| Restarts on the 30 scores, with the triggers | 0 | 0 | not yet (§4.6's test) |
| Second visit, online: what is downloaded | the manifest | the manifest | as specified (Chromium, §5.3) |
| Second visit, engine files unreachable | compiles | compiles | Chromium yes; WebKit not verified (§5.3) |

## 9. The ordered steps

| Step | What | Checked by |
| --- | --- | --- |
| K1 | The engine's Cargo workspace: one crate per module, §1.3's profiles, the pinned nightly, the features, `--max-memory`; a build script that writes `dist/engine/` and its manifest | sizes against §8 and §2.1 on every build, failing when a Must is exceeded |
| K2 | The ABI of §4.2 in Rust over chapter 02's parser and the first milestones of chapters 03–06; the driver of this chapter, unchanged | `test/engine.test.ts`; the corpus through the worker in Node against chapter 00's comparator |
| K3 | The image: a native build that runs the init and writes the heap; `lily_start` | B5a's image share; compiles from the image equal compiles from source |
| K4 | `wasm-split` per module crate, from the call graph (§2.3); triggers in `modules.ts` for every module | each of the 30 compiles with only its triggered modules and no restart; each module's absence gives a restart, not a different result |
| K5 | Caching: `Cache-Control` in D55's gateway; `persist()` after use; the debug build of §1.3 | §5.3's second visit in Chromium; Safari on the iPhone in step 10 |
| K6 | Lily Studio on the web: `engine.js`, live preview in the page, fallback to the server (§7) | the D55 tests, plus the page driven with the engine and with the engine refused |
| K7 | Phones, with step 10: B5a, B5b with lazy compilation, B5c, Cache Storage after a reload on iOS, the effect of `+simd128` | chapter 00 §6's harness |

K1 and K2 come first, with chapters 02–06's first milestones. K4 waits for
the first module that leaves the core: chapter 05's tablature or chapter
03's `chords`.

## 10. What later chapters take from here

| Chapter | Takes |
| --- | --- |
| 09 phone timings | §1.3's settings for step 10's crate, the ABI of §4.2 so it runs in this chapter's worker, and §3.1's measurements repeated on the phones: worker start, cache match, compile, instantiate, first and second render; Cache Storage after a reload on iOS (§5.3); `+simd128` |
| 11 roadmap, D56 | steps K1–K7; the budgets of §8; the sharing out of B1 that §2.1 shows is needed; the three kinds of module and the split by call graph (§2.2–§2.3); MIDI in the core and one `braces` pack (refining chapters 07 and 06); the pinned nightly; Lily Studio on the web as the first host (§7) |

## Appendix A: recipes

The probes are those of chapters 03, 06 and 07 (their Appendix A and B),
copied, with `target/` removed. `B` is Binaryen 133's `bin/`.

**The size matrix** (§1.2), `matrix.sh`, in bash:

```sh
size() { printf "%s\t%s\t%s\n" $(wc -c <"$1") $(gzip -9c "$1" | wc -c) $(brotli -q 11 -c "$1" | wc -c); }
F="--enable-bulk-memory --enable-sign-ext --enable-mutable-globals --enable-nontrapping-float-to-int --enable-multivalue --enable-reference-types"
# One row: a crate, a toolchain, an opt-level and LTO by environment, extra flags.
( cd $crate && CARGO_TARGET_DIR=$out CARGO_PROFILE_RELEASE_OPT_LEVEL=$opt CARGO_PROFILE_RELEASE_LTO=$lto \
  CARGO_PROFILE_RELEASE_CODEGEN_UNITS=$cgu RUSTFLAGS="$flags" cargo +$tc build -q --lib --release \
  --target wasm32-unknown-unknown $std )
# ia: tc=nightly flags="-Zunstable-options -Cpanic=immediate-abort" std="-Zbuild-std=std,core,alloc,panic_abort"
$B/wasm-opt -Oz $F --strip-debug --strip-producers $wasm -o $wasm.Oz.wasm   # +Oz; -O3 likewise
```

Speed of the three Scheme builds: chapter 03's `bench/run.mjs <module>` with
`RUNS=5`.

**The split** (§2.3): the prototype with `--profile names` (its
`strip = false` profile) and the *ia* flags; the 13 primitives are the
functions whose mangled names match `5prims[0-9]+p_[a-z0-9_]*(str|sym|char)`
in `wasm-dis`'s output.

```sh
$B/wasm-split custom.wasm --split --split-funcs=$(paste -sd, split.txt) \
  -o1 primary.wasm -o2 secondary.wasm --export-prefix='%' --placeholdermap $F
for f in primary secondary; do $B/wasm-opt -Oz $F --strip-debug $f.wasm -o $f.min.wasm; done
```

`splitrun.mjs` instantiates `primary.min.wasm` with `env.lsb_write` and a
`placeholder.deferred` namespace whose every function throws a `Needs`
error. It runs each benchmark with `lsb_init`, `lsb_alloc` and `lsb_eval`.
Then it instantiates `secondary.min.wasm` with `{ primary: <the primary's
exports by the names the secondary imports> }`, and runs b6, b8 and b1
again, then the same on the whole module.

**Loading** (§3.1), `compile.mjs`: a Node server for `site/` with
`content-type: application/wasm` and `cache-control: no-cache`; for each
browser and module, a new context and seven visits. The page's
`measure(file, cached)` starts `new Worker('worker.js')` and posts the
absolute start time. The worker does this:

```js
const cache = await caches.open('engine-v1')
let response = cached ? await cache.match(file) : undefined
if (!response) { response = await fetch(file); await cache.put(file, response.clone()) }
const module = await WebAssembly.compileStreaming(response)            // timed
const instance = await WebAssembly.instantiate(module, stubs)          // timed
const memory = new WebAssembly.Memory({ initial: 64, maximum: 4096 })
memory.grow(32); new Uint8Array(memory.buffer).set(new Uint8Array(2 << 20).fill(7), 64 << 16)   // timed
// For the prototype: lsb_init, then (fib 25) evaluated twice, each timed.
```

**End to end** (§4.6, §5.3): the stand-in engine is a `cdylib` of 131
lines. It implements §4.2's exports over a `BTreeMap` of files and modules.
For three steps it busy-waits for the budget, reading `lily_now`. Then it
asks for each `\include` of the root it was not given (kind 0), and for
`chords` when the root has `\chordmode` (kind 1). Then it writes `stderr`, a
`diagnostics.json` with LilyPond's `cannot find file` error for an include
answered `null`, and a page naming what it was given. Built with §1.3's
flags and `wasm-opt -Oz`, it is 27,196 bytes. With its 2 MiB image, a part
and a pack in `packages/studio/dist/engine/`, `node esbuild.mjs --site
--production` gave `dist/site/engine/` and `engine.worker.js`. Both were
copied out and served by `e2e.mjs`, which can refuse `engine/*` with a 503.
The page script plays `EngineHost`'s part: compile 1 on `ready`, compile 2
5 ms later, `needs-file` answered from `{ '/s/inc.ily': 'e4' }` or `null`.
`dist/engine/` and `dist/site/engine/` were removed afterwards.
