# Architecture brief

This document records what we learned from studying
[VSLilyPond](https://marketplace.visualstudio.com/items?itemName=lhl2617.vslilypond)
and how our extension is laid out in response. The reasoning behind each choice
lives in [DECISIONS.md](DECISIONS.md).

Sources studied (September 2026): the marketplace page, and a source read of
`lhl2617/VSLilyPond` @ `37c0970` (v1.7.3, last commit 2021-09-11) together with
the four extensions it depends on. Facts marked **[verified]** were reproduced
locally against LilyPond 2.26.0 on macOS; the probe inputs are listed in
[Appendix A](#appendix-a-verified-lilypond-behaviour).

## 1. How VSLilyPond is built

### 1.1 It is five extensions, not one

VSLilyPond's `package.json` declares four `extensionDependencies`. The core
extension contributes no grammar, no snippets, no preview and no formatter:

| Capability | Provided by | Mechanism | License |
| --- | --- | --- | --- |
| Compile, error squiggles, MIDI in/out | `lhl2617.vslilypond` (core) | spawns `lilypond`; `jzz` for MIDI | CC BY-NC 3.0 |
| Syntax highlighting, language id `lilypond` (`.ly`, `.ily`) | `jeandeaual.lilypond-syntax` | 2.5k-line TextMate YAML grammar, Scheme builtins scraped from lilypond.org | CC BY-NC 3.0 |
| "IntelliSense / AutoComplete" | `lhl2617.lilypond-snippets` | a static `snippets.json` (1415 entries) scraped from the v2.22 command index with Puppeteer | MIT |
| Preview + point-and-click | `lhl2617.lilypond-pdf-preview` | custom editor for `*.pdf` wrapping a patched pdf.js | MIT |
| Formatting | `lhl2617.lilypond-formatter` | shells out to `python-ly` (bundled binary or user Python) | MIT |

Everything was last touched in 2021 (the syntax extension in 2022) and was
tested against LilyPond 2.22.

### 1.2 Core extension (`src/`, ~1.6k lines)

- `extension.ts` — `activate()` checks the binary with `command-exists`; **if
  it is missing it shows an error and returns**, so no command is registered.
  Otherwise it registers 14 commands and wires listeners. The two feature
  gates (`compileOnSave`, `intellisense.enabled`) are read once here, so
  toggling them needs a window reload; other settings are re-read per call.
- `lilypond.ts` — the *compile* path. `compile()` spawns
  `lilypond --loglevel=WARNING <extra args> <file>` with `cwd` set to the
  file's directory, so PDF/MIDI land **next to the source**. One module-level
  `compileProcess`; a new compile `SIGKILL`s the old one. stdout/stderr are
  appended to an output channel; a transient status-bar item shows
  "Compiling…" / "Compilation Failed". The compile path produces **no
  diagnostics**.
- `intellisense.ts` — the *lint* path (despite the name, it is diagnostics
  only). On every text change, debounced 500 ms, it spawns a **second**
  `lilypond` with `--define-default=backend=null -dmidi-extension=tmp -`,
  pipes the buffer to stdin, regex-parses stderr
  (`file:line:col: (error|warning): msg`) into a `DiagnosticCollection`, then
  deletes the stray `-.tmp` MIDI file from the source directory.
- `midi-in.ts`, `midi-out.ts` — MIDI keyboard entry and playback through
  `jzz`, surfaced as status-bar buttons. About half of the codebase.
- Root-file handling is a manual setting (`pathToMainCompilationFile`,
  relative to the workspace folder) plus `compileMainFileOnSave`.

### 1.3 Preview extension

A `CustomReadonlyEditorProvider` registered for `*.pdf`. The webview hosts
pdf.js, which a build script patches to **render every page eagerly**
(the source comments: "Takes a lot of memory… TODO: wrestle with this") so
that annotation links exist in the DOM. The webview scans for
`textedit://path:line:char:col` links and posts each one to the host, which
keeps a `file → line → [{col, elementID}]` map. A `FileSystemWatcher` on the
PDF triggers a full reload.

- Backward (score → code): click a link → host opens the document at the
  position.
- Forward (code → score): **a command palette entry**
  (`Go to PDF location from Cursor`) that looks up the nearest element on the
  cursor's line and highlights it for 3 s. There is no cursor tracking.

### 1.4 Data flow

```
edit ──500ms──▶ lilypond (backend=null, stdin) ──stderr──▶ Diagnostics
save ─────────▶ lilypond (PDF next to source)  ──stderr──▶ Output channel
                        │
                        ▼ file on disk
   user opens PDF ─▶ custom editor ─▶ FileSystemWatcher ─▶ pdf.js full reload
```

The two halves never talk to each other. The compiler does not know whether a
preview exists; the preview does not know a compile happened, only that a file
changed.

## 2. Ergonomic gaps

| # | Gap | Cause | Our answer |
| --- | --- | --- | --- |
| G1 | No preview command or button. The user compiles, finds the PDF in the explorer, picks "LilyPond PDF Preview" from *Open With…*, and drags it into a side column. | Preview is a generic custom editor for any `*.pdf`, decoupled from compile. | One command opens a webview panel `ViewColumn.Beside`; it owns its compile. (D4) |
| G2 | Refresh reloads the whole document through pdf.js; all pages are rendered eagerly for point-and-click; scroll is restored by hand. | PDF needs a JS renderer; links only exist for rendered pages. | SVG is DOM: swap page nodes, keep scroll, links are plain `<a>` elements. (D1) |
| G3 | Two compilers run per edit/save cycle with separate kill logic, channels and arg handling. | Lint and compile are separate modules. | One compile service; diagnostics are a by-product of the preview compile. (D3) |
| G4 | **[verified]** On LilyPond 2.26 the lint run prints `warning: ignoring option -dbackend="null"`, performs a *full* compile per keystroke burst, and leaves `-.pdf` in the user's folder. | `backend=null` was removed upstream; extension unmaintained since 2021. | No as-you-type compiles; never write into the source tree. (D3, D5) |
| G5 | Build artefacts (`.pdf`, `.midi`, `-.tmp`) litter the source directory. | `cwd`-relative default output. | Per-run temp directory; explicit export commands. (D5) |
| G6 | Diagnostics squiggle from column 0 to the error column, and appear only from the lint path — a failed *save* compile shows nothing in the editor. | `new Range(line, 0, line, col)`; compile path only writes to a channel. | Token-width ranges with correct column conversion, from the same run that feeds the preview. (D6) |
| G7 | "IntelliSense" is a flat snippet list frozen at v2.22: no context (`\new` vs `\override`), no hover, 1415 entries including `!` and `%`. | Scraped once from HTML docs. | Data generated from the *installed* LilyPond; context-aware providers. (D8) |
| G8 | Five extensions to install; the grammar and the core are **CC BY-NC**, which blocks reuse. | Historical split. | One extension, independently authored grammar, permissive license. (D2) |
| G9 | No editor-title buttons, menus or keybindings; the UI is status-bar text and the command palette. Forward sync is palette-only. | — | Editor-title actions, webview toolbar, cursor-driven highlight. (D4, D7) |
| G10 | Missing binary ⇒ `activate()` returns early, so every command fails with "command not found". The on-save and lint toggles are read once at activation ("Reload required"). | — | Always register commands; resolve binary lazily; react to `onDidChangeConfiguration`. (D9) |
| G11 | Root file must be configured by hand per workspace. | — | Infer the root from `\include` relationships, setting as override. (D10) |
| G12 | No way to drive it headlessly; an agent cannot compile and read errors. | Logic is tied to `vscode` APIs and module-level state. | Compile core has no `vscode` import; CLI + MCP wrap it. (D11) |

Deliberately **not** carried over: MIDI keyboard input, MIDI playback and
`python-ly` formatting. They account for most of VSLilyPond's code and
dependencies (`jzz`, bundled Python binaries) and none of what was asked for.
MIDI *export* stays, because it is free (D5).

## 3. Our architecture

### 3.1 Shape

One extension, one compile pipeline, consumers that subscribe to its results.

```
                         ┌────────────────────────────────────┐
  save / command ──────▶ │ CompileService  (no vscode import)  │
                         │  locate binary → spawn --svg → tmp  │
                         │  cancel stale run → collect result  │
                         └──────────────┬─────────────────────┘
                                        │ CompileResult
        ┌───────────────┬───────────────┼────────────────┬──────────────┐
        ▼               ▼               ▼                ▼              ▼
   Diagnostics     Output channel   Status bar     PreviewPanel     CLI / MCP
   (Problems)                                       (webview)        (JSON)
                                                        ▲  │
                                   cursor → highlight ──┘  └── click → reveal
```

`CompileResult` is the single contract between the layers:

```ts
interface CompileResult {
  rootFile: string            // absolute path that was compiled
  ok: boolean                 // exit code 0
  cancelled: boolean          // superseded by a newer run
  pages: string[]             // absolute SVG paths, in page order
  midi: string[]              // any .midi files produced
  stderr: string              // raw, unmodified
  diagnostics: LyDiagnostic[] // parsed from stderr, vscode-free shape
  durationMs: number
}
```

### 3.2 Planned layout

```
src/
  extension.ts          activation, command + listener wiring only
  compile/
    locate.ts           setting → PATH → well-known install dirs
    service.ts          spawn, temp dir, cancellation, page ordering
    stderr.ts           stderr → LyDiagnostic[] (pure function)
    rootFile.ts         \include graph → root resolution
  diagnostics.ts        LyDiagnostic → vscode.Diagnostic, status bar, channel
  preview/
    panel.ts            WebviewPanel lifecycle, message protocol
    sync.ts             textedit link index, cursor ↔ element mapping
  language/
    completion.ts       context-aware completion
    hover.ts
  cli.ts                headless entry (step 11)
  mcp.ts                minimal MCP server (step 11)
media/                  webview script + css (no framework)
syntaxes/               lilypond.tmLanguage.json (authored here)
snippets/
data/                   generated lilypond-data.json
scripts/                data extraction from the installed lilypond
```

Rule: nothing under `src/compile/` may import `vscode`. That is what lets the
CLI and MCP server (step 11) reuse the exact code path the editor uses, and
lets it be unit-tested without an extension host.

### 3.3 Compile invocation

```
lilypond --loglevel=WARNING --svg -dpoint-and-click \
         -o <tmp>/<run-id>/<basename>  <root file>
cwd = dirname(root file)      # so relative \include keeps working
```

Facts the implementation must respect, all **[verified]**:

- `--svg` selects the classic SVG backend. Using `-dbackend=svg` instead also
  works but adds a locationless `warning: ignoring unsupported formats (pdf)`
  line to every run.
- Output naming: one page ⇒ `<base>.svg`; several ⇒ `<base>-1.svg`,
  `<base>-2.svg`, … Sort **numerically** (`-10` after `-9`). A fresh directory
  per run is required, otherwise a score that shrinks from two pages to one
  leaves a stale `-2.svg` behind.
- A run with errors frequently still exits 1 **and** writes SVG. Show the
  pages and the diagnostics together; only keep the previous render when no
  page was produced.
- `\midi {}` in the source yields `<base>.midi` in the same directory at no
  extra cost.
- The source must be compiled **from disk**. Feeding stdin makes every
  location read `-:line:col` and every link point at `-`.

### 3.4 Preview webview

- SVG pages are inlined into the DOM (not `<img>`), because the classic
  backend paints with `fill="currentColor"` / `stroke="currentColor"`
  **[verified]**: setting CSS `color` from the VS Code theme variables themes
  the score with zero SVG rewriting. A "paper" mode (black on white) is the
  same mechanism with fixed colours.
- Strict CSP: `default-src 'none'`; scripts by nonce only; styles from
  `webview.cspSource`; no `unsafe-inline` script. Inline SVG therefore cannot
  execute anything a score might smuggle in.
- Refresh replaces page nodes in place and restores `scrollTop` as a fraction
  of page height, so zoom + position survive recompiles.
  `retainContextWhenHidden` is not needed; state is small and re-sent.
- Point-and-click links are `<a xlink:href="textedit://…">`. The webview
  intercepts clicks, `preventDefault`s, and posts the href to the host.

### 3.5 Location formats

Two different column conventions come out of LilyPond, **[verified]** with
tab- and Unicode-bearing inputs:

| Source | Format | Line | Column |
| --- | --- | --- | --- |
| stderr | `path:LINE:COL: error\|warning: msg` | 1-based | **1-based, tabs expanded to 8**, counted in code points |
| stderr (rare) | `path:LINE: warning: msg` (no column; message may span lines) | 1-based | — |
| stderr | `warning: …` / `fatal error: …` (no location) | — | — |
| SVG link | `textedit://PATH:LINE:CHAR:COLUMN` | 1-based | `CHAR` is **0-based code points, tabs not expanded**; `COLUMN` is the tab-expanded 1-based form |

Consequences:

- For links, use `CHAR` directly as the VS Code character (adjust only for
  astral-plane characters, which count as two UTF-16 units).
- For stderr, convert `COL` back to a character offset by walking the actual
  line text and expanding tabs. VSLilyPond skips this, so its squiggles drift
  on tab-indented files.
- `PATH` in links is percent-encoded (`src%20dir`) and absolute. Parse from
  the **right** (`:(\d+):(\d+):(\d+)$`) — Windows paths contain a colon.
- stderr follows each located message with two context lines (source excerpt
  and a caret-aligned continuation). They are not messages; skip them.

### 3.6 What triggers a compile

Save of a `lilypond` document (debounced), the explicit recompile command, and
opening the preview. Never a keystroke. A full compile of a trivial score costs
~0.4 s here and real scores take seconds; running that per edit is what made
the original feel heavy, and with `backend=null` gone there is no cheap
syntax-only mode to fall back on.

## 4. Handoff to implementation

Repository state after this brief: git is initialised on `main` and contains
only `docs/`. There is no `package.json`, `.gitignore` or source yet.

Where each piece of upcoming work should look first:

| Work | Read |
| --- | --- |
| Extension skeleton, language id, bundling | §3.2, D2, D9, D12 (name/prefix still *proposed*) |
| Grammar and snippets | D2 — **do not copy** from the CC BY-NC grammar |
| Compile service | §3.3, D3, D5; keep `src/compile/**` free of `vscode` |
| Diagnostics | §3.5 (stderr rows), D6 |
| Preview panel, refresh on save | §3.4, §3.6, D1, D4, D10 |
| Score ↔ source sync | §3.5 (SVG link row), D7 |
| IntelliSense data | D8 (includes the verified Scheme recipe) |
| CLI / MCP for agents | §3.1 `CompileResult`, D11 |

Appendix A is reproducible: each row is a one-line `lilypond` invocation on a
two- or three-line input, and should be re-run when the minimum supported
LilyPond version changes.

## Appendix A: verified LilyPond behaviour

Probes run with `GNU LilyPond 2.26.0 (running Guile 3.0)`:

| Probe | Observation |
| --- | --- |
| Two-page score, `-dbackend=svg -dpoint-and-click -o out/score` | `score-1.svg`, `score-2.svg`, `score.midi`; extra `ignoring unsupported formats (pdf)` warning |
| Same with `--svg` | Same files, no extra warning |
| Same with `-dbackend=cairo --svg` | Files produced, **0** `textedit` links, **0** `currentColor`, glyphs as `<defs>` paths |
| `-dno-point-and-click` | 0 links |
| Source with `\foo` (unknown command) | exit 1, located `error:` lines, `fatal error: failed files`, and `bad.svg` **still written** |
| Source path containing a space, included `.ily` | link path is absolute, percent-encoded, and points at the `.ily` |
| Tab before the error token | stderr column = tab-expanded + 1 (`3:14` for char index 6) |
| `é ♪` before the token | stderr column counts code points, not bytes (`2:35` for char 34, byte 37) |
| Tab + Unicode before notes | links `2:31:33`, `2:34:36`, `2:36:38` ⇒ `CHAR` 0-based unexpanded, `COLUMN` 1-based expanded |
| stdin with `-dbackend=null` | `warning: ignoring option -dbackend="null"`, locations as `-:3:14`, **`-.pdf` written to cwd** |
| No `\version` | `file:1: warning:` with no column and a multi-line message |
| Trivial score wall time | ≈ 0.43 s |
| Scheme introspection from a `.ly` file | 167 grobs, 43 contexts, 199 music functions with docstrings and signatures (recipe in DECISIONS D8) |
