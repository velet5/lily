# Implementing the engine: the prompt for each run

Paste everything below the line into a new chat to run the next milestone.
Repeat it for every milestone: each run reads `progress.md` to find where to
start, and writes to it when it ends.

---

Implement our own LilyPond engine in WebAssembly, following the roadmap in
[`docs/research/wasm-engine/README.md`](README.md) and decision D56 in
[`docs/DECISIONS.md`](../../DECISIONS.md).

## Scope of one run

The roadmap has nine milestones, MS0–MS8 (README §5). Do **one milestone per
run**. To find which one, read `docs/research/wasm-engine/progress.md`. If it
does not exist, start with MS0 and create it. If a milestone is too big for
one run, finish whole steps, record them, and leave the rest for the next run.

## Read first

Point at these documents; do not copy them:

- [`README.md`](README.md), the roadmap: §5 milestones (steps, needs, gate),
  §6 test coverage, §7 what each module may leave out, §8 risks, and §4 for
  the budgets to measure.
- D56 in [`docs/DECISIONS.md`](../../DECISIONS.md), and
  [`AGENTS.md`](../../../AGENTS.md).
- The chapters behind this milestone's steps:

  | Prefix | Chapter |
  | --- | --- |
  | P | [02-parser.md](02-parser.md) |
  | S | README §5 (built from [03-scheme.md](03-scheme.md)) |
  | N | [04-music-model.md](04-music-model.md) |
  | Y | [05-layout.md](05-layout.md) |
  | W | [06-output.md](06-output.md) |
  | M | [07-midi.md](07-midi.md) |
  | K | [08-integration.md](08-integration.md) |
  | H | [09-spike.md](09-spike.md) §8, where they are called P1–P6 |

  Chapter [00-budgets.md](00-budgets.md) has the test scores, the comparator
  (§5, Appendix A) and how to measure on phones (§6).
  [01-reference-map.md](01-reference-map.md) says which LilyPond files each
  module must match.
- What already exists:
  - `packages/studio/crates/engine-spike/` and its `harness/`;
  - `packages/studio/src/web/engine/`, the host side: driver, worker,
    protocol, triggers;
  - `packages/studio/test/engine.test.ts`.

## Where to work

- Use a git worktree, `.worktrees/engine`, on branch `feat/engine`. Make sure
  `.worktrees/` is in `.gitignore`.
- The main checkout may hold uncommitted Lily Studio web work (D55). Never
  touch, stage or commit it.
- If a step needs that code (H2 changes the studio's page; MS7 builds on
  D55), ask first.

## Limits: measure them, don't be stopped by them

The budgets in README §4 (download size, wasm size, memory, time per edit)
are **not gates for now**. We will shrink the engine later.

- Measure every budget the milestone names, and write the numbers into
  `progress.md` next to the budget.
- K1's size check **reports**, per crate, instead of failing the build.
- Do not spend effort on size or speed beyond plain good code. Avoid nothing
  for size reasons alone: `core::fmt` and `format!` are allowed.
- The decision points of README §5 (MS1: s7 instead of our interpreter; MS3:
  cost per grob; MS6: B6) are reported in the handoff. Do not re-plan or
  switch on them alone; ask.

What still holds, because it is about working at all, not about size:

- Only the wasm features of Safari 17 (00 §1.1): no threads, wasm tail calls,
  exception handling or GC. One dedicated worker, no `SharedArrayBuffer`.
- The declared maximum memory of 256 MiB, so a too-large score is an error,
  not a killed tab.
- The engine yields between steps so a newer edit can stop an older compile.

## Rules

- **The reference is LilyPond 2.26.0** (tag `v2.26.0`, commit
  `3596756be0fac1f81066a99d2054329212172b2d`).
  - Port LilyPond's algorithms with their parameters, and never approximate
    them (05 §2.4).
  - Judge results with chapter 00's comparator, layers C0–C5. These are the
    gates.
  - Test scores from LilyPond's repository are fetched as 00 §4 says. Never
    copy them into the repository.
- **The engine lives in `packages/engine`**, licensed GPL-3.0-or-later.
  - It has its own Cargo workspace.
  - Its `rust-toolchain.toml` pins `nightly-2026-05-24` for the wasm build
    only. Native builds and tests use stable.
  - Use the profiles in 08 §1.3.
- **The apps stay MIT.** They reach the engine only through the worker
  protocol in `packages/studio/src/web/engine/`.
- **Diagnostics come out in today's formats**: LilyPond's stderr and
  `LyDiagnostic[]` (08 §6). Don't change the apps' parsers (D6, D42).
- **Tests that need lilypond skip themselves when it is not installed.** A
  run with skipped tests has verified nothing; say so.
- **Phones**: measure with chapter 09's harness. If you cannot reach a real
  device, don't claim a phone number. List exactly what must be run, and on
  which device.
- **New decisions** go in `docs/DECISIONS.md` as D57 and up.
- **Update `AGENTS.md`** when the repository's layout changes (K1 adds a
  fourth package).
- **Commit** each step once its tests pass, with conventional messages, for
  example `feat(engine): …`. The author is velet592@gmail.com. Don't push or
  open PRs unless asked.

## Done for a run

1. The milestone's gate from README §5 passes on the comparator's layers and
   tests. If it doesn't, give a precise list of what failed and why. Budget
   misses are recorded, not failures.
2. `docs/research/wasm-engine/progress.md` gets one section for the
   milestone:
   - what was built, with commits;
   - each gate, passed or failed;
   - each budget, measured against README §4;
   - anything that deviated from the roadmap.
3. All work is committed in the worktree.
4. The run ends with a short handoff: the next milestone or step, and
   anything that must be done by hand (phones, lilypond captures, D55).
