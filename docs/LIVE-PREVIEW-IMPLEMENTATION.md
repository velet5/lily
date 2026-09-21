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
