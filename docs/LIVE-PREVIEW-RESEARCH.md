# Faster LilyPond previews

Implementation followed in [D25](DECISIONS.md#d25--unsaved-accelerated-live-preview);
see [implementation measurements and limits](LIVE-PREVIEW-IMPLEMENTATION.md).
The research below preserves the pre-implementation findings.

Research and local experiments, 2026-09-21. This is a proposal, not an accepted
architecture change. The extension's compile and preview code is unchanged.

The strongest result is an optimization to the existing classic SVG backend:
**cache repeated music glyph conversions**. On the two-staff test score this
reduced compilation from **5.81 s to 0.71 s**, with byte-identical SVG. Start
there, then add compilation of unsaved editor snapshots and more selective
webview updates. A warm compiler can reduce latency further. A general
incremental engraving engine would be a substantially larger project.

## What this extension currently does

The implementation has several useful foundations already:

- `src/compile/compiler.ts` produces classic SVG directly, in isolated temporary
  directories. It has cancellation and one active preview compile per root.
- `src/preview/autoPreview.ts` coalesces saves with a trailing debounce; the
  default `lily.preview.refreshDelay` is 300 ms. Only open previews are rebuilt.
- Includes determine which roots need rebuilding. This avoids unrelated builds,
  but does not cache intermediate results within a score.
- The compiler reads files from disk. `extension.ts` listens for saves, not text
  edits. Reducing compiler time alone therefore does not provide unsaved live
  preview.
- `src/preview/panel.ts` reads all SVG pages and builds their source-link index.
  `media/preview.js` calls `replaceChildren(...message.pages.map(toPage))` on each
  render: all pages are parsed, sanitized and replaced, including unchanged ones.

The latency to measure is: debounce → snapshot preparation → compiler → page
read/link indexing → webview transfer → visible paint. Current `durationMs`
measures the compile service, not that complete interval.

## Measurements

Installed Homebrew LilyPond 2.26.0, Guile 3.0, macOS 26.5.2, arm64. Two synthetic
scores use a repeated four-bar phrase with eighth notes, slurs and staccato:
small = one staff × eight bars; medium = two staves × 64 bars. The latter makes
two pages. Both normally include MIDI. These are probes, not a representative
corpus of orchestral, vocal, custom-font or Scheme-heavy scores.

Times are milliseconds, medians of three measured runs after one warm-up per
case. Fresh-process cases use warm filesystem caches; cold variants were
shuffled within each measurement round. Cache and worker experiments ran
separately, without competing benchmark processes. Editor and browser overhead
are excluded. Small differences should be treated as noise.

| Method | Small | Medium | Consequence |
| --- | ---: | ---: | --- |
| Current classic SVG invocation | 690 | 5,811 | Baseline |
| Classic SVG with experimental glyph cache | 408 | 713 | Same SVG bytes, source links and theme colors |
| Warm parent + fresh fork, with glyph cache | 278 | 572 | Same SVG; independent child per request |
| Sequential warm worker, with glyph cache | 98 | 345 | Same SVG; more shared-state management |
| Cairo SVG | 313 | 600 | No `textedit:` links or `currentColor` in tested output |
| Only last eight bars, MIDI block omitted | 682 | 1,120 | Partial score; different layout and playback scope |
| Minimal page breaking | 680 | 5,808 | Different layout; no useful speedup here |
| Disable point-and-click | 677 | 5,836 | Loses source navigation; no useful speedup here |
| Omit MIDI block | 686 | 5,829 | Loses playback; no useful speedup here |

Without the cache, a warm parent/fork took 597 / 5,742 ms, and a sequential
worker took 390 / 5,536 ms. Keeping a process warm alone therefore leaves most
of the medium score's bottleneck intact. Worker request timings exclude the
one-time startup: approximately 127 ms for the cached fork parent and 250 ms
for the cached sequential worker. Every measured worker render matched the
ordinary compiler's SVG bytes.

With a 150 ms editing debounce, the sequential-worker/cache numbers suggest
roughly 250 / 500 ms **before** snapshot and webview overhead. This is a budget
estimate, not a measured edit-to-visible-preview result.

In a separate medium-score trace, **5.31 s of 5.80 s was inside `Output svg`**.
Page breaking accounted for about 59 ms; Guile boot about 91 ms. Trace spans
nest: the large `Parse file` span includes engraving and output, so it must not
be interpreted as parser-only time. LilyPond provides
[`-dtime-trace-file`](https://lilypond.org/doc/v2.26/Documentation/contributor/tracing-processing-time)
for inspecting these stages in a Chrome-trace viewer such as Perfetto.

## 1. Optimize classic SVG first

The installed `output-svg.scm` exactly matches the
[official 2.26.0 source](https://github.com/lilypond/lilypond/blob/v2.26.0/scm/output-svg.scm).
Its `cache-font` function obtains cached font-file contents, but still extracts
the font's definitions and searches them with a glyph-specific regular
expression repeatedly. A score uses the same noteheads, accidentals and other
glyphs many times.

The research shim memoizes the resulting string for **named glyphs** using
`(font file, size, glyph name)` as the key. It deliberately bypasses list-valued
glyph requests: those use cumulative horizontal advance, so caching their final
strings in the same way would be incorrect. The cache clears at session end.

This was loaded through `-e` in experimental processes; the installed LilyPond
files were not edited. All measured output compiled without warnings. The two
synthetic scores produced byte-identical SVG. Four existing repository fixtures
also produced identical SVG, and identical MIDI where present, covering an
include, multiple pages, lyrics, titles and playback.

This is promising evidence, not a production compatibility guarantee. Before
shipping, exercise alternate music fonts, font sizes, tablature, percussion,
music glyphs inside markup, multiple books and user overrides of backend
functions. The shim uses a private Scheme function: an extension integration
needs version/capability checks and an ordinary-compiler fallback. An upstream
change that indexes font glyph data would avoid maintaining this private hook.

The source-level optimization preserves the two reasons D1 selected classic
SVG. It should be evaluated before switching rendering backends or building an
incremental compiler.

## 2. Keep a compiler warm, with explicit lifecycle rules

There is precedent: [lys](https://github.com/lyp-packages/lys) offered a long-lived
LilyPond server, and current
[Hacklily's worker implementation](https://github.com/jocelyn-stericker/hacklily/blob/aa35973bc39302b07b13878edc3e9e8d1bd585fd/server/renderer/lily-server.scm)
forks from a loaded LilyPond process. These approaches still engrave each request
again; they amortize initialization rather than incrementally updating music.

Two local probes use the classic backend, both with and without the glyph cache:

- **Warm parent, fresh fork per request:** preserves a clean parent and drops
  user state when the child exits. Initialization that can start font threads
  occurs in the child. LilyPond's own multi-file implementation observes this
  ordering; forking after Pango/font initialization can deadlock. This approach
  is Unix-specific.
- **Sequential requests in one initialized process:** resets LilyPond sessions,
  options and fonts between requests. It can save more initialization, but
  arbitrary Scheme can mutate shared state, and a crash loses the worker.
  LilyPond's [session implementation](https://github.com/lilypond/lilypond/blob/v2.26.0/scm/lily.scm)
  explicitly does not isolate all destructive mutation.

A production worker should use a private pipe with a structured protocol,
per-request output directories, timeouts, cancellation, crash recovery and
bounded lifetime. Restart when the binary or relevant configuration changes.
Keep the ordinary spawn path as a fallback, including on unverified platforms.
The small research loop is not that production worker.

## 3. Add unsaved live preview and update only changed pages

Recommended extension design, separate from compiler acceleration:

1. Capture an immutable revision of the root and relevant dirty includes after
   a short idle interval, initially around 150–250 ms. Compile a temporary
   snapshot that preserves include resolution. Remap diagnostics and SVG source
   links to original files. Never save the user's buffers as a side effect.
2. Use one running request and one replaceable pending request per root. Avoid
   repeatedly killing nearly finished builds while someone types. Results carry
   revision IDs; never let an older result overwrite a newer displayed result.
   Mark a displayed revision as updating when newer edits are pending. Publish
   diagnostics against the source revision they actually describe.
3. Send page identities/hashes with the result. Reuse unchanged page DOM and
   source-link indexes; sanitize and replace changed pages. Preserve scroll and
   zoom. Hash after stable source-path remapping so fresh snapshot paths do not
   invalidate every page. Pagination changes still require adding/removing pages.
4. Instrument each stage through a render acknowledgment and browser paint.
   The existing `rendered` message is a useful starting point, but posting it
   after synchronous layout is not proof that pixels have been painted.

Long-score page virtualization can follow profiling. Page reuse improves the
viewer and does not reduce LilyPond's engraving work. Likewise, caching the
include graph avoids repeated file reads but cannot skip engraving an affected
root. Scheme-computed includes need a conservative fallback.

D3, D15 and D18 currently assume disk-based compilation and particular
cancellation behavior. An implementation should explicitly supersede those
parts in the decision log; this research does not silently change them.

## 4. Offer focused passage preview for larger scores

LilyPond supports `showFirstLength`, `showLastLength` and
[`Score.skipTypesetting`](https://lilypond.org/doc/v2.26/Documentation/notation/skipping-corrected-music).
In 2.26 the `-dfirst=R1*8` and `-dlast=R1*8`
[command-line options](https://lilypond.org/doc/v2.26/Documentation/usage/advanced-command_002dline-options-for-lilypond)
provide convenient beginning/end previews. `R1*8` means eight whole-note
durations, which is eight bars only in 4/4.

These skip typesetting outside a passage; they do not eliminate parsing and
all context processing. They can help when engraving/layout dominates, but
cannot promise the final document's pagination. For a cursor-centered view,
mapping source positions to musical time and preserving the state of clefs,
keys, relative pitches, voices and spanning objects requires additional work.

The initial 2.26 probe combining `-dlast=R1*8` and MIDI produced programming
errors including `no current dynamic`, despite exit code zero. The reported
last-eight-bars timings therefore omit MIDI. Keep playback tied to a complete
score, and validate any passage strategy against this behavior. Do not remove
MIDI blocks from arbitrary source using a regular expression.

Use an explicit passage/draft view with full-score refinement on idle or save.
[`ly:minimal-breaking`](https://lilypond.org/doc/v2.26/Documentation/notation/page-breaking)
is another draft option for pagination-heavy inputs, but it barely helped these
tests. Test it against a real long orchestral score before adopting it.

## What is and is not incremental

I found no supported stock LilyPond 2.26 API for updating an existing engraved
score after a source edit. Its file driver parses and engraves each input again.
A resident process is therefore not a ready-made incremental compiler.

Engineering assessment: general measure-level reuse is difficult because
source text carries forward duration, relative pitch and context state;
spanners cross boundaries; Scheme can change definitions and layout behavior;
and line/page optimization can move otherwise unchanged music. Reusing only
the visually edited bar is not generally correct.

Useful intermediate forms of incrementality are feasible:

| Granularity | Practical value | Limit |
| --- | --- | --- |
| Whole root + complete dependency/configuration fingerprint | Reuse identical builds, including undo | An ordinary edit misses; Scheme can read undeclared inputs |
| Independently compiled movement or part | Rebuild only affected units | Requires explicit project structure and stable shared settings |
| SVG page | Reuse DOM and navigation indexes | Compiler still processes the score; repagination invalidates pages |
| Music subtree/context checkpoint | Potential substantial savings | Needs compiler work, dependency tracking and correctness proofs |

Separate `.ily` files are textual includes, not independently compiled object
files. `-djob-count=N` distributes multiple input files; the 2.26 driver caps
jobs at the number of files. It will not divide a single score across N cores.
`-dpreview` means a title/first-system image, not an interactive compiler mode.
`clip-regions` [extracts laid-out fragments](https://lilypond.org/doc/v2.26/Documentation/notation/extracting-fragments-of-music);
it should not be assumed to skip the earlier engraving stages.

## Suggested implementation order

1. Add latency instrumentation and validate the glyph optimization against
   representative user scores; prefer an upstream fix or a guarded opt-in shim.
2. Add unsaved snapshots, revision-aware scheduling and changed-page refresh.
3. Introduce a warm worker if measured latency still warrants its complexity.
4. Add passage preview for expensive scores, with complete-score refinement.
5. Consider structural incremental engraving only if these steps remain
   insufficient and the supported LilyPond language subset can be defined.

Immediately, setting `lily.preview.refreshDelay` below 300 can remove some
intentional wait after save. It does not accelerate LilyPond or preview unsaved
changes. The measured cache improvement is much larger on the medium score.

## Reproducing the experiments

The [probe scripts and raw results](research/live-preview/) are research assets,
not part of the extension or VSIX. Run them sequentially from this checkout,
copying scripts to a fresh temporary directory so generated scores and output
remain outside the project:

```sh
probe_dir=$(mktemp -d)
cp docs/research/live-preview/*.py docs/research/live-preview/*.scm "$probe_dir/"
python3 "$probe_dir/benchmark.py"
python3 "$probe_dir/extras.py"
python3 "$probe_dir/warm.py"
```

`LILYPOND_PATH` can select another executable. `LILY_RESEARCH_REPO` can select
the checkout containing the four validation fixtures. `benchmark.py` rejects
nonempty compiler stderr as well as failing exit codes. `extras.py` and
`warm.py` check output bytes against ordinary builds. Timings are compiler
experiments; an extension-host/browser performance test is still required.
