# Building the engine in Mother plan runs

[`IMPLEMENT.md`](IMPLEMENT.md) asks one session to do a whole milestone of
the roadmap ([README](README.md) §5). A milestone is 2,000–18,500 lines, which
is far more than one session can do. A plan run instead splits a
milestone into 2–12 steps and runs each step in a fresh session. This file
says how to run the roadmap that way: what to settle once, the contract every
step session works under, how sessions hand over, and MS0's steps.

`IMPLEMENT.md` stays the rule book. A step session reads its *Rules*, *Limits*
and *Where to work* sections. Only its *Scope of one run* and *Done for a
run* are replaced by what follows.

## 1. Before the first run, once

Settle these by hand. They block steps, and no step session may decide them.

| # | What | Why | Blocks |
| --- | --- | --- | --- |
| 1 | **Where `feat/engine` branches from.** Either commit or merge the D55 web work first and branch from that, or branch from `feat/studio-web`'s HEAD and accept the conflicts. | Step 1 edits `packages/studio/Cargo.toml`, `Cargo.lock` and `AGENTS.md`, and step 2 edits `packages/studio/esbuild.mjs`. The main checkout has uncommitted D55 changes to all four. | steps 1, 2 |
| 2 | **Install the toolchain**: `rustup toolchain install nightly-2026-05-24 --component rust-src --target wasm32-unknown-unknown`, and Binaryen 133 (`wasm-opt`, `wasm-split`) on the PATH or as `WASM_OPT`. | Today only a floating `nightly` is installed, and there is no `wasm-opt` or `wasm-split`. | step 2 on |
| 3 | **The SMF crate and the studio.** M1 says the crate is shared with `crates/session/src/midi_export.rs`. But the engine is GPL-3.0-or-later and the studio is MIT, and `crates/session` exists only as uncommitted D55 work. Choose one: don't share, license the crate separately, or do it later. | IMPLEMENT: the apps stay MIT and reach the engine only through the worker. | the sharing part of step 6 |
| 4 | **Yes or no to H2** (step 10). It changes `packages/common/web/preview.js`, which both apps use. | IMPLEMENT: "H2 changes the studio's page … ask first". | step 10 |
| 5 | **D56's status.** It is still `proposed`. Mark it accepted when the engine work starts, or record why not. | So that the decisions log is right. | none |

Already checked on this machine (2026-10-04): LilyPond 2.26.0 with Guile 3.0
from Homebrew, the reference version. Homebrew's build links libc++, so M1's
heap order matches 07 §4.2. Node 24, `brotli`, stable Rust. `.worktrees/` is
in the committed `.gitignore`. No `feat/engine` branch or worktree exists
yet.

## 2. The loop

For each milestone, in the order of README §5.1:

1. **Split.** Run Mother's plan split with this file and `IMPLEMENT.md` as the
   source, and name the milestone and the current
   [`progress.md`](progress.md). §5 below is MS0's split. Larger milestones
   need several splits. MS1 alone is 10,500–13,000 lines, so expect a
   split for each group of chapter steps (for example S1–S2, then S3–S4,
   then P1–P5 and N1). Each split ends with a closing step for that part.
2. **Run.** Mother gives each step's line to a fresh session, together with
   the contract of §3. A step that hits a stop point (§3, *Stop*) ends its
   session. Answer it, then resume the run from that step.
3. **Review** after each step: `git -C .worktrees/engine log --oneline`, the
   new entry in `progress.md`, and its *Skipped* line (§4).
4. **Close.** The last step of a milestone fills the milestone's section of
   `progress.md` as IMPLEMENT's *Done for a run* asks: the gates, the budgets
   against README §4, the deviations, and the device work left to do.
5. **By hand**: the device runs listed in the handoff, then answers to the
   decision points (MS1: s7, MS3: cost per grob, MS6: B6). Only then split
   the next milestone.

## 3. The contract for every step session

Mother hands each session its step line. This block goes with it unchanged:

```text
You are running one step of a plan run that builds our LilyPond engine
in WebAssembly. Your step is the line above: its title, scope and files.

Read first: docs/research/wasm-engine/PLAN-RUN.md §3–§4, and IMPLEMENT.md's
sections "Where to work", "Limits" and "Rules", which apply in full.
Then read docs/research/wasm-engine/progress.md, in the worktree, from the
end: the last entry's "Next" line and "Open" items are your handoff.
Read the chapter sections your step names, and no more than you need.

Work only in the worktree .worktrees/engine, on branch feat/engine. If it
does not exist and your step is step 1, create it with
`git worktree add .worktrees/engine -b feat/engine`. Never edit, stage or
commit anything in the main checkout.

Do only your step. Do not start the next one, even if there is time left.
If your step cannot be finished, finish whole parts, record the rest
under "Open", and stop.

Stop and report, without guessing, when:
- the step needs uncommitted D55 code, or changes the studio's page (H2);
- it would choose between the roadmap's options (s7, cheaper layout
  machinery, a module boundary), or change a convention without a
  recorded decision;
- the previous entry's "Next" does not match your step, or a file it
  says exists is missing.

Done means:
- the step's tests pass. Tests that need lilypond ran and did not skip,
  or the entry says that the step is unverified;
- every budget the step touches is measured and written down. Budgets
  are recorded, never gates;
- one or more commits with conventional messages (feat(engine): …,
  test(engine): …, docs(engine): …), author velet592@gmail.com, ending
  with the Co-Authored-By line. No push, no PR;
- one new entry at the end of progress.md, in the format of PLAN-RUN.md
  §4, committed with the work;
- a closing message of at most ten lines: what was done, what failed,
  what was skipped, and the next step.
```

## 4. `progress.md`: the handoff

Step 1 creates it. Each step adds one entry. A milestone's closing step adds
the milestone summary that IMPLEMENT asks for, above that milestone's step
entries.

```markdown
### MS0 · step 4 — Capture LilyPond's references and port the comparator

- **Commits:** abc1234 feat(engine): …, def5678 test(engine): …
- **Built:** one or two lines.
- **Tests:** `npm test -w packages/engine` (31 passed); lilypond tests ran.
- **Skipped:** none (or the exact list, and why).
- **Measured:** budget → number, against README §4 (or "none").
- **Deviations:** from the roadmap or the step's line, and why.
- **Open:** what this step left for later, as checkboxes.
- **Next:** step 5 — Add the C5 beam, slur and tie shape layer.
```

## 5. MS0's steps

MS0's step list is K1, H2, H4–H6, M1, M8, W1, W2, C5 and C2b, about
3,500 lines. Steps run in this order. Each step needs the ones before it,
unless a line says otherwise.

| # | Covers | MS0 gate item it carries | Needs first |
| --- | --- | --- | --- |
| 1 | K1 (workspace, move) | — | §1 item 1 |
| 2 | K1 (build, size report), H4 | the size report on every engine build | §1 item 2 |
| 3 | H5, H6 (desktop half) | B5c throttled (desktop half) | 2 |
| 4 | corpus, M01–M12, comparator | the tools for every later gate | 1 |
| 5 | C5 | C5 sensitive on the nine beam and slur scores | 4 |
| 6 | M1, C2b | M1 byte-equal on 39 of 42, the 3 others explained | 4; §1 item 3 for sharing |
| 7 | W1 (music packs) | every glyph's extent equal to LilyPond's | 2 |
| 8 | W1 (text packs) | W1's packs within README §4.2 | 7 |
| 9 | W2 | 663 skylines, point for point | 7 |
| 10 | H2 | B7 with L532 (desktop half) | §1 item 4 |
| 11 | close | the whole gate, the device list, the handoff | 1–10 |

Steps 4–6 depend only on step 1, so they can run before steps 2–3 if the
toolchain is not installed yet. Step 10 depends on nothing else.

Gate items that **need devices**. No session can do these. Step 11 lists
them and a person runs them with chapter 09's harness:

- the iPhone 12 or later, over trusted HTTPS: Cache Storage after a reload,
  the worker's JS heap, B5c throttled;
- the Fire Max 11 tablet: B7, no main-thread task over 50 ms with L532;
- an A15-class Android phone and the iPhone: H6's run in chapter 00 §6.1's
  full conditions;
- both phones: M8's questions about `midi.js` (silent switch,
  interruptions, background tabs and screen lock, latency, polyphony at
  T24 and T29).

The steps, in the plan run's format:

```text
Create the engine's Cargo workspace and move the spike into it | Worktree .worktrees/engine on feat/engine; GPL packages/engine workspace with 08 §1.3's profiles; rust-toolchain.toml pinned to nightly-2026-05-24 with native scripts on cargo +stable (D57); spike moved, removed from the studio's workspace and profiles; AGENTS.md lists a fourth package; progress.md started | packages/engine/Cargo.toml, packages/engine/rust-toolchain.toml, packages/engine/LICENSE, packages/engine/package.json, packages/engine/crates/spike/, packages/studio/Cargo.toml, packages/studio/Cargo.lock, package.json, AGENTS.md, docs/DECISIONS.md, docs/research/wasm-engine/progress.md | 90 | Moves and config only; done when the spike's native tests pass on stable from the new home and the studio's cargo test still passes
Build the engine into dist/engine with a per-crate size report | K1 build and H4: check for the pinned nightly and Binaryen; run 08 §1.3's command with --max-memory and wasm-opt -Oz into dist/engine/ with manifest.json; the studio's --site build copies from packages/engine/dist/engine; per-crate sizes against README §4.1 plus core::fmt bytes, reported and never failing | packages/engine/scripts/build.mjs, packages/engine/scripts/sizes.mjs, packages/engine/crates/spike/harness/build.sh, packages/engine/package.json, packages/studio/esbuild.mjs | 90 | One pipeline and one report; done when a single build prints the table and engine.test.ts and the site build still pass
Precompress the engine files and serve the harness over trusted HTTPS | H5 and H6 desktop half: a brotli-11 .br beside each built file, serve.mjs sends them unchanged with the right headers over HTTPS with a locally trusted certificate, harness repointed at the new dist, B5c throttled in desktop Chromium recorded | packages/engine/scripts/build.mjs, packages/engine/crates/spike/harness/serve.mjs, packages/engine/crates/spike/harness/harness.js, packages/engine/crates/spike/harness/measure.mjs, docs/research/wasm-engine/progress.md | 60 | Small edits to existing harness files; checked by serving locally and one throttled measure run
Capture LilyPond's references and port the comparator | Fetch the corpus per 00 §4 (a sparse v2.26.0 checkout outside the repo) with M01–M12 from 07 §2.3; capture.ly reference captures of all 42 scores; 00 Appendix A's score.mjs as a tested tool (a reference against itself scores 1.0, a perturbed copy scores lower) | packages/engine/tools/corpus/fetch.mjs, packages/engine/tools/corpus/corpus.tsv, packages/engine/tools/compare/capture.ly, packages/engine/tools/compare/capture.mjs, packages/engine/tools/compare/score.mjs, packages/engine/tools/compare/test/score.test.mjs | 90 | Ports scripts the chapters give in full; one capture run and self-tests
Add the C5 beam, slur and tie shape layer | Add 05's c5dump.ly to the capture and add C5 to score.mjs: each beam's positions and each slur's and tie's control points, Must ≤ 0.25 and Goal ≤ 0.05 staff spaces at p95; sensitivity tests on perturbed dumps | packages/engine/tools/compare/c5dump.ly, packages/engine/tools/compare/capture.mjs, packages/engine/tools/compare/score.mjs, packages/engine/tools/compare/test/c5.test.mjs | 75 | One layer on step 4's tool, checked on the nine scores with beams or slurs
Write the SMF crate, byte-equal on 39 of 42 files, and add C2b | M1: port 07 Appendix A's probe (stop queue, merged unisons, libc++ heap) and roundtrip into a no_std crate, with a merged-unison test of its own and the three mismatches explained per 07 §4.2; C2b (bytes, creator text left out, one-tick ties normalised) in score.mjs; sharing with the studio's midi_export.rs left to the user's decision | packages/engine/crates/smf/src/lib.rs, packages/engine/crates/smf/src/bin/roundtrip.rs, packages/engine/crates/smf/tests/roundtrip.rs, packages/engine/tools/compare/score.mjs | 120 | Ports a 253-line probe the chapter gives in full, checked against step 4's 42 captures
Pack Emmentaler's eight sizes and braces with exact extents | W1 part 1: grow the spike's pack.mjs into the pack builder (names, metrics, LILC, LILY, outlines in our encoding) for the eight sizes and the braces from LilyPond's OTFs; a Rust reader; a test that every glyph's extent equals a ly:stencil-extent capture | packages/engine/tools/packs/build.mjs, packages/engine/tools/packs/extents.ly, packages/engine/crates/fonts/src/lib.rs, packages/engine/crates/fonts/tests/extents.rs, packages/engine/scripts/build.mjs | 120 | One builder and its reader, checked against one LilyPond capture
Build the text metric packs and measure every pack | W1 part 2: 06 §5.3's text font metric packs in the same format; every pack's raw and brotli size against README §4.2 and 06 §8, in the size report and progress.md | packages/engine/tools/packs/text.mjs, packages/engine/crates/fonts/src/text.rs, packages/engine/scripts/sizes.mjs, docs/research/wasm-engine/progress.md | 60 | Reuses step 7's format for the text fonts and adds rows to an existing report
Compute glyph skylines that match skylines.ly point for point | W2: port stencil-integral.cc's outline-to-skyline procedure over step 7's outlines, once per glyph and size, checked against the 663 skylines skylines.ly writes (06 Appendix A) | packages/engine/crates/skyline/src/lib.rs, packages/engine/crates/skyline/tests/skylines_ly.rs, packages/engine/tools/packs/skylines.ly | 120 | One ported algorithm with one exact reference test
Insert changed preview pages visible first, one per frame | H2, only after the user's yes: building on D25's reuse by hash in render(), insert the visible page first and the rest one per requestAnimationFrame, stopped by a newer revision, with 'rendered' posted when the last page lands; B7 with L532 timed in desktop Chromium, the tablet left to step 11's list | packages/common/web/preview.js, packages/studio/test/preview.test.ts, packages/vscode/test/ | 90 | One function in one shared file, with existing preview tests in both apps
Close MS0: gates, budgets, device checklist and handoff | Run every MS0 gate; write progress.md's MS0 section (commits, gates, budgets against README §4, deviations); list the exact device runs (iPhone: Cache Storage after a reload, worker JS heap, B5c throttled; tablet: B7; both phones: H6 and M8's questions); hand off to MS1 | docs/research/wasm-engine/progress.md, docs/DECISIONS.md | 45 | Running checks and writing up; no new code
```

## 6. Why the split looks like this

These points came from checking the split against the chapters and the
repository. Later splits should keep them in mind.

- **The reference captures come before M1.** M1's gate (39 of 42 files
  byte for byte) and C2b both compare against LilyPond's MIDI files for the
  42 scores. So step 4 captures them first.
- **`rust-toolchain.toml` and "native builds use stable" don't fit
  together without help.** A toolchain file applies to every `cargo`
  command in its directory. Step 1 pins the nightly there, and the
  package's scripts run native builds and tests with `cargo +stable`.
  Record this as D57.
- **The spike is MIT today.** It sits in the studio's workspace
  (`license = "MIT"`). It becomes GPL-3.0-or-later when it moves. The author
  holds the copyright, so this is a note, not a blocker.
- **The studio's `--site` build copies `dist/engine/` relative to
  `packages/studio`.** After the move, the engine is built in
  `packages/engine`, so step 2 changes that one path.
- **Two IMPLEMENT rules override the chapters.** 08 §9 makes the K1 size
  check fail on a Must, but IMPLEMENT says it only reports. H4 forbids
  `core::fmt`, but IMPLEMENT allows it. So H4 becomes a byte count in the
  report.
- **H2 is smaller than it sounds.** `render()` in `preview.js` already
  reuses pages by hash (D25). What is new is the order (the visible page
  first) and inserting one page per frame.
- **Generated data stays generated.** Font packs and the scores fetched
  from LilyPond are built or fetched, never committed (00 §4). Emmentaler
  comes from the installed LilyPond's `fonts/otf/`.
