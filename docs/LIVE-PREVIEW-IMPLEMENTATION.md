# Live preview implementation and validation

Implemented 2026-09-21, following [the research](LIVE-PREVIEW-RESEARCH.md).
[D25](DECISIONS.md#d25--unsaved-accelerated-live-preview) records the conventions
that supersede the original save-only pipeline.

The extension now compiles unsaved root/include snapshots after a 150 ms idle
interval. A maximum-wait timer and a queue with one running and one replaceable
pending revision prevent starvation. Source paths and positions are remapped
before pages are hashed, so links, diagnostics, and unchanged-page reuse survive
fresh temporary directories. Diagnostics are suppressed if relevant documents
or compilation settings changed while the result was being produced.

The main speedup comes from caching classic SVG named glyph conversion, guarded
by the exact LilyPond 2.26.0 backend hash and a Scheme version/arity check. The
warm path forks a fresh child from a parent that has not initialized fonts.
This gives up some of the research sequential worker's speed in exchange for
isolating arbitrary per-score Scheme mutations. It does not reuse engraving
results. Unknown backends and custom arguments fall back to ordinary spawning;
exports and the headless checker always use ordinary spawning.

## Compile-service measurements

Installed Homebrew LilyPond 2.26.0 / Guile 3.0, macOS arm64. Run alone with:

```sh
node scripts/benchmark-preview.mjs > docs/research/live-preview/implementation-results.json
```

The script generates the same repeated-phrase probes as the research: small =
one staff × 8 bars; medium = two staves × 64 bars and two pages. Each mode runs
once initially, then three measured times; the table reports the median of
those three. Modes run sequentially with warm filesystem caches. The auto path
makes a new editor snapshot every time and includes source-path normalization.
Every measured run asserts clean stderr and byte-identical SVG **and MIDI**
against ordinary LilyPond. Raw timings and first-run costs are retained in
[implementation-results.json](research/live-preview/implementation-results.json).

| Compile path | Small | Medium |
| --- | ---: | ---: |
| Ordinary spawning, disk input | 653 ms | 5,644 ms |
| Guarded glyph cache, fresh process | 373 ms | 672 ms |
| Warm parent + isolated child + unsaved snapshot | 268 ms | 563 ms |

This is about 2.4× / 10× faster for the two synthetic scores. Snapshot creation
was 0–1 ms in these runs; path remapping is included in total compile time.
The first warm request was 387 / 675 ms after the capability probe was already
cached. The initial cache request additionally paid about 120 ms for that probe.
These are compile-service timings, excluding debounce, extension-host work,
webview transfer and paint. They are not production-wide latency guarantees.

## Editor and packaged-extension validation

The extension-host tests exercise a real webview and the installed LilyPond:
unsaved includes redraw the root without changing disk, forward navigation
finds their notes, identical refreshes report two reused DOM pages, and older
source revisions cannot publish stale diagnostics. Existing tests cover backward
navigation, zoom/page controls, diagnostics, MIDI playback and explicit exports.

One observed unsaved-include edit took **415 ms** from applying the editor edit
to receiving the rendered acknowledgment (including a 150 ms debounce, 229 ms
compile, and browser/host overhead). This test score changes from one short
system to two pages; it is different from the synthetic performance probes.
The test polls acknowledgments every 50 ms, so this is an upper-bound observation,
not a sub-millisecond paint measurement. A deliberately incomplete score with
a 400 ms Scheme sleep, followed by a fix while compiling, took 1,504 ms: the
running request and its ordinary retry finish before the newest revision runs.

`PreviewPanel.latency` exposes compile/snapshot time, host preparation time,
host-to-render acknowledgment time, busy-period duration, engine and reused-page
count. The acknowledgment waits for two animation frames. It indicates a paint
opportunity, not GPU/compositor completion; hidden webviews can delay it. The
test also measures elapsed time directly from the editor edit.
[Raw editor observations](research/live-preview/implementation-editor-results.json)
retain both scenarios.

The production paths are checked against plain output for existing fixtures
(includes, lyrics, titles, multiple pages and MIDI), plus multiple books,
percussion, tablature, different glyph sizes, markup music glyphs, text ligatures,
and a score overriding the backend hook. Further tests cover nested/absolute
includes, same-line source columns, Unicode/space paths, symlink aliases,
relative `-I`, computed-include refusal, unknown-version fallback, configured
binary replacement, destructive Scheme isolation, crashes, timeout/cancellation
and recovery. Timing tests exercise sustained edits and pending replacement.

The release check packages/unpacks the VSIX, requires both Scheme runtime files,
and verifies that the shipped preview actually uses the warm engine. A silent
fallback therefore cannot hide a packaging omission.

Final validation: **235 unit tests, 44 extension-host tests, and 7 packaged
release tests passed, with zero skipped tests**, plus types, lint and grammar
snapshots. The full `npm test` pipeline used a temporary host launch configuration
with `--remote-debugging-port=9347` and a local DevTools session holding
`Emulation.setFocusEmulationEnabled({enabled:true})`. This was needed because
macOS left the automated VS Code window unfocused, making the existing native
comment/typing smoke commands no-ops. Their original assertions and implementation
were unchanged. The ordinary `npm run test:e2e` passed without focus emulation.
The temporary configuration was removed; production code opens no debug port.

## Concrete limits

- Only the exact tested 2.26.0 classic backend is accelerated. Other versions
  still preview through ordinary processes. macOS arm64 was tested; Windows
  spawning and Linux warm behavior have not been exercised locally.
- Custom third-party music fonts and arbitrary runtime backend mutation are
  not covered by these fixtures. Set `lily.preview.acceleration` to `off` for
  such projects if output differs. The installed LilyPond files are untouched.
- Literal includes and known search paths are snapshotted. Known computed
  includes/Scheme include APIs with dirty buffers produce an editing diagnostic.
  Arbitrarily concealed Scheme I/O and source-filename-derived resources are
  outside this model; save those projects before compiling. External processes
  editing disk files are not part of an atomic filesystem snapshot.
- Exports retain their existing disk semantics: they save the root, and dirty
  includes must be saved explicitly. Preview commands never force a save.
- Failed optimized compiles retry once with ordinary LilyPond, which adds
  latency while a score is incomplete. A worker and its fallback have separate
  timeouts of 60 seconds. Closing the preview cancels its running process group.
- DOM/index reuse does not skip engraving, and the host still sends all page
  strings. No cropped MIDI, passage preview or measure-level compiler rewrite
  is introduced: the demonstrated glyph bottleneck no longer warrants that
  complexity for these probes.

## Follow-up: a real four-page vocal/piano score

The small synthetic results did not predict the user's editing latency for
`как-молоды-мы-были-4-pages.ly`. Their installed extension log confirmed the warm
engine was active, with successful compiles taking 1.9–2.0 seconds. This score
has 48 written bars, four staff definitions, chords, several lyric lines and
closing text. It produces four pages and has no MIDI block. The source file
was read and compiled without modifying it on disk; its hash is in the results.

Profiling the original cache found about 885 ms in `output-stencils` and
610 ms in processing the book's layout. The broader `Output svg` span was
1,034 ms, including page breaking; these inclusive times overlap and must not
be added. [Profile summary](research/live-preview/choir-profile.json).

The follow-up caches the font's definitions and each glyph's XML in addition
to the existing named-glyph output. Upstream extraction still runs for every
list-valued request, retaining advance, offsets, empty glyphs and scaling.
Every wrapped function is guarded and caches clear at session end. This avoids
scanning a whole SVG font for each new glyph/size while retaining byte-identical
output. Snapshot mapping also bypasses line rescanning when no include was
rewritten, and matches LilyPond's lowercase URI encoding. The latter fixes
unnecessary page replacement when switching between saved and unsaved files
with Cyrillic names or reserved punctuation.

Same machine and LilyPond 2.26.0, one initial run followed by three measured
runs. The standalone benchmark ran without concurrent tests:

| Path | Median compile time |
| --- | ---: |
| Ordinary LilyPond | 17,253 ms |
| Updated glyph/font-data cache, fresh process | 1,536 ms |
| Updated warm worker, with unsaved snapshot | 1,372 ms |

All four SVG pages were **byte-identical** to ordinary LilyPond in every run,
including source links. MIDI preservation was verified separately by the
fixtures, since this score emits none. [Raw results](research/live-preview/choir-results.json).
Reproduce against the local source with:

```sh
node scripts/benchmark-preview.mjs '/Volumes/T5/Choir/Sheets/как-молоды-мы-были-4-pages.ly'
```

Two disposable VS Code hosts compared the previously installed extension with
the updated packaged VSIX. Each opened the same original file, then alternated
one melody pitch through three unsaved edits. Measurements include the default
150 ms debounce, host work and the webview's two-frame acknowledgment, polled
every 10 ms. Both runs asserted four rendered pages, no diagnostics, the warm
engine, working forward navigation and unchanged disk contents; edits were
reverted without saving.

| Editor measurement | Previously installed | Updated VSIX |
| --- | ---: | ---: |
| Median compile during edits | 1,964 ms | 1,409 ms |
| Median edit → rendered acknowledgment | 2,198 ms | 1,638 ms |
| Initial open → rendered acknowledgment | 2,424 ms | 2,003 ms |
| Unchanged pages reused on first unsaved edit | 0 | 3 |

[Before observations](research/live-preview/choir-editor-before.json) and
[after observations](research/live-preview/choir-editor-after.json) include
source/runtime hashes and each sample. This is about a 25% reduction in editing
latency from the first implementation, **not instant or sub-second preview**.
Full-score engraving remains the limiting operation; a separate passage mode
would be needed to investigate a substantially lower latency target for this
score. No score content, pagination or playback was removed to obtain these
numbers.

Follow-up validation: 237 unit tests, 45 extension-host tests, 7 packaged release
tests, and both real-score editor probes passed with zero skips. Types, lint
and grammar checks passed. The full host suite again used temporary focus
emulation for its existing native editor smoke tests; the release tests and
real-score probes did not need it. New regressions compare glyph-string
advances/offsets/spaces across sizes and fonts, verify exact SVG/MIDI for
Unicode/URI-reserved filenames, and verify DOM reuse and navigation after saving
a Cyrillic-named score.
