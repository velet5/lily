# Decision log

Short records of the choices that shape the extension and, from D28 on, Lily
Studio. Context and evidence are in
[ARCHITECTURE.md](../packages/vscode/docs/ARCHITECTURE.md); gap numbers (G1…)
refer to its section 2. Paths in entries before D53 are as they were then, before
the move into `packages/`.
Add new entries at the end of their block: the apps' (D133 and up) before
D200, the engine's (D200 and up) at the bottom, as D231 sets out.
Supersede rather than rewrite.

Status values: **accepted**, **proposed** (cheap to change, not yet relied on),
**superseded by Dn**.

---

## D1 — Render the preview from LilyPond's classic SVG backend

**Status:** accepted · **Addresses:** G1, G2, G9

**Decision.** Compile with `--svg -dpoint-and-click` and display the resulting
SVG pages in a webview. PDF is an export format, not the preview format.

**Why.**
- SVG is DOM. No pdf.js (VSLilyPond ships a patched copy that renders every
  page eagerly to make links clickable), no canvas, no worker.
- Point-and-click links arrive as ordinary `<a xlink:href="textedit://…">`
  elements, so both sync directions are a query selector away.
- The backend paints with `currentColor`, so theme-aware rendering is one CSS
  property.
- Incremental refresh: replace page nodes, keep scroll and zoom.

**Rejected.**
- *Cairo backend SVG* (`-dbackend=cairo --svg`): verified to emit no
  `textedit` links and no `currentColor`. It is faster and has better font
  embedding, but it removes the two properties we chose SVG for.
- *PDF + pdf.js*: the approach we are replacing.

**Consequences.** Text in the preview uses system fonts resolved by the
webview, so lyrics/titles may differ slightly from the PDF. Acceptable for a
preview; exported PDFs are authoritative.

---

## D2 — Bundle our own grammar, snippets and language configuration

**Status:** accepted · **Addresses:** G7, G8

**Decision.** Ship a TextMate grammar, language configuration and snippets
inside this extension. No `extensionDependencies`. Use the established language
id `lilypond` for `.ly` and `.ily`.

**Why.** A single install is the main ergonomic win over a five-extension
pack. The existing grammar (`jeandeaual.lilypond-syntax`) and VSLilyPond itself
are **CC BY-NC 3.0**; we must not copy from either. The grammar is written
from the LilyPond language documentation, and keyword lists are generated from
the installed binary (D8), not lifted from the other grammar.

**Consequences.** If a user also has `lilypond-syntax` installed, two
extensions contribute the same language id and scope name. VS Code tolerates
this, but which grammar wins is not something we control (unverified), so the
README should recommend uninstalling the other one rather than guarding in
code. Embedded Scheme was first planned to delegate to `source.scheme`; D14
replaces that with built-in rules.

---

## D3 — One compile service; diagnostics are a by-product

**Status:** accepted · **Addresses:** G3, G4, G6

**Decision.** A single `CompileService` owns every `lilypond` spawn. Each run
returns one `CompileResult` (pages, MIDI, raw stderr, parsed diagnostics).
Preview, Problems panel, output channel, status bar, CLI and MCP all consume
that result. There is no separate lint process and no as-you-type compile.

**Why.** VSLilyPond runs two uncoordinated compilers. Its lint path depends on
`backend=null`, which LilyPond 2.26 ignores — verified to produce a full
compile per typing burst and a stray `-.pdf` in the user's folder. With no
cheap syntax-only mode left upstream, the honest design is one real compile at
well-defined moments (save, command, preview open).

**Rules.**
- At most one live run per root file; a newer request kills the older one and
  the older result is reported as `cancelled`, never rendered.
- `src/compile/**` must not import `vscode` (enables D11 and plain unit tests).
- Extra user arguments are an array setting, not a whitespace-split string
  (VSLilyPond's split breaks paths with spaces).

---

## D4 — Side-by-side preview that owns its compile

**Status:** accepted · **Addresses:** G1, G9

**Decision.** `Open Preview to the Side` creates a `WebviewPanel` in
`ViewColumn.Beside`, triggers a compile for the active document's root file,
and keeps focus in the editor. One panel per root file; invoking the command
again reveals the existing panel. Left pane code, right pane score.

**Why.** In VSLilyPond the preview is a generic `*.pdf` custom editor the user
must locate and arrange by hand, refreshed only by a file watcher. Tying the
panel to the compile service removes the watcher, the "Open With…" step and
the arrangement step.

**Details.** Strict CSP with nonce-only scripts; SVG inlined (needed for
`currentColor` and click interception); scroll restored as a page-relative
fraction; fit-width by default with zoom controls (step 6, toolbar in step 9).

---

## D5 — Build into a temp directory; export explicitly

**Status:** accepted · **Addresses:** G4, G5

**Decision.** Every preview compile writes to a fresh per-run directory under
the OS temp dir (`-o <tmp>/<run-id>/<basename>`), with `cwd` set to the root
file's directory so relative `\include` resolves. Directories from superseded
runs are deleted; the current one is removed when the panel closes. PDF and
MIDI reach the user's folder only through explicit export commands.

**Why.** Keeps repositories clean, and a fresh directory is the only reliable
fix for stale pages (a score shrinking from `-1/-2.svg` to a single `.svg`).

**Consequences.** MIDI export is a file copy when the score has a `\midi`
block. PDF export is a second, user-initiated run with `--pdf`.

---

## D6 — Parse stderr precisely

**Status:** accepted · **Addresses:** G6

**Decision.** `stderr.ts` is a pure function from raw stderr to
`LyDiagnostic[]`. It recognises `path:line:col: severity: msg`,
`path:line: severity: msg`, and locationless `warning:` / `fatal error:`
lines; skips the two source-context lines that follow located messages;
de-duplicates identical entries; and resolves relative paths against the
compile `cwd`.

Column handling follows ARCHITECTURE §3.5: stderr columns are 1-based,
tab-expanded (width 8), in code points, and are converted against the real
line text. The diagnostic range is widened to the token at that position
instead of VSLilyPond's column-0-to-error span. Locationless messages attach
to line 1 of the root file so they are never silently dropped.

Diagnostics are published for every file mentioned, including `.ily`
includes, and cleared per root file on each completed (non-cancelled) run.

---

## D7 — Two-way sync is automatic

**Status:** accepted · **Addresses:** G9

**Decision.** Score → code: clicking a notehead reveals the position in the
editor column (opening the file if needed, including `.ily` files). Code →
score: moving the cursor highlights the nearest element at or before it on
that line, debounced; no command required, with a setting to turn it off.

**Details.** The link index (`file → line → [{char, elementId}]`) is built in
the host from the SVG text at compile time rather than posted link-by-link
from the webview as VSLilyPond does. Use the `CHAR` field of
`textedit://PATH:LINE:CHAR:COLUMN`; decode the percent-encoded path; parse
numbers from the right so Windows drive colons survive.

---

## D8 — IntelliSense data is generated from the installed LilyPond

**Status:** accepted · **Addresses:** G7

**Decision.** A script asks the installed `lilypond` (via Scheme) for music
functions, contexts, grobs, properties and their docstrings, and writes
`data/completions.json`, which is committed and shipped. Completion is
context-aware (after `\`, after `\new`/`\context`, inside `\override` /
`\set`), and hover shows the docstring.

**Why.** VSLilyPond's completion is a static snippet file scraped from the
v2.22 HTML index: no context, no hover, already four minor versions stale.
Generating from the binary keeps data and compiler in step and avoids
scraping.

**Feasibility (verified on 2.26).** From a `#(…)` block inside a `.ly` file:
- grobs: `all-grob-descriptions` (167 entries, each with its property alist);
- contexts: `(ly:output-find-context-def $defaultlayout)` (43);
- music functions: scan `(current-module)` **and** `(module-uses
  (current-module))` for values satisfying `ly:music-function?` (199, incl.
  `relative`). Scanning `(resolve-module '(lily))` alone finds none;
- docs: `(procedure-documentation (ly:music-function-extract f))`,
  signature via `ly:music-function-signature`;
- properties: `(object-property 'stencil 'backend-doc)` and
  `'backend-type?`.

Docstrings contain Texinfo markup (`@var{music}`, `@code{…}`); the generator
converts it to Markdown.

**Consequences.** The committed JSON records the LilyPond version it came
from. Regeneration is a developer task, not a runtime one.

---

## D9 — Degrade gracefully and react to configuration live

**Status:** accepted · **Addresses:** G10

**Decision.** Activation never depends on the binary. Commands are always
registered; highlighting, snippets and completion work without LilyPond. The
binary is resolved on first compile: explicit setting → `PATH` → well-known
install locations (Homebrew, `/Applications/LilyPond.app`, Program Files). On
failure show one actionable message with *Open Settings* / *Download* buttons.
Settings changes apply immediately through `onDidChangeConfiguration`; nothing
requires a reload.

---

## D10 — Resolve the root file automatically

**Status:** accepted · **Addresses:** G11

**Decision.** When a saved file is not itself a score being previewed, find
the root by scanning workspace `.ly` files for `\include` chains that reach
it. Preference order: explicit setting → a root with an open preview → the
unique including file → ask once and remember per workspace. A `.ly` file
with an open preview is always its own root.

---

## D11 — Headless surface for agents (Codex)

**Status:** accepted · **Addresses:** G12

**Decision.** Because the compile core is `vscode`-free (D3), step 11 wraps it
in a CLI (`compile <file> --json`) and a minimal MCP server that return the
same `CompileResult` JSON: diagnostics with 1-based line/column plus SVG
paths. An `AGENTS.md` tells Codex how to run the loop: write → compile → read
diagnostics → fix.

**Why here.** Recording it now keeps steps 4–5 from leaking `vscode` types
into the compile and stderr modules.

---

## D12 — Toolchain and naming

**Status:** proposed (naming) / accepted (toolchain)

- TypeScript, bundled with **esbuild** into a single `dist/extension.js`;
  webview assets are plain JS/CSS under `media/`, no UI framework.
- Tests: `vitest` (or `node:test`) for pure modules — stderr parser, link
  parser, root resolution, grammar snapshots; `@vscode/test-electron` only for
  the activation smoke test.
- Runtime dependencies: none planned. VSLilyPond's `jzz`, `file-type`,
  `command-exists` and pdf.js all fall away with the features we dropped.
- Minimum LilyPond: 2.24 (`--svg` with the classic backend and the link
  format were verified on 2.26; 2.22 is untested and out of scope).
- License: MIT (nothing is derived from the CC BY-NC sources).
- Working name **Lily**; command and setting prefix `lily.` (for example
  `lily.preview.openToSide`, `lily.compile.onSave`). The name is a
  placeholder: step 2 may change it freely, but it must be settled before
  step 9 adds keybindings and menus.

---

## D13 — Skeleton conventions

**Status:** accepted (tooling, language configuration) / proposed (identity)

- **Identity.** The D12 working name is kept: package `lily`, prefix `lily.`.
  `publisher` is the placeholder `lily-dev`; nothing hard-codes it (the smoke
  test derives the extension id from `package.json`). Both still have to be
  settled before step 9.
- **Engine floor.** `engines.vscode` is `^1.100.0` with `@types/vscode` pinned
  to `~1.100.0`; raise the two together. Activation relies on the implicit
  `onLanguage:lilypond` event, so there is no `activationEvents` entry.
- **Two test tiers.** Extension-host tests are the top-level `test/*.test.ts`
  files, bundled to `out/test/` by `esbuild.mjs --tests` and run by
  `@vscode/test-cli` (`npm test`, mocha `tdd` UI, workspace `test/fixtures`).
  Pure-module tests (D12) must live elsewhere — beside the source or under
  `test/unit/` — and their runner must not pick up `test/*.test.ts`.
- **Type checking is separate from bundling.** `tsc --noEmit` checks `src` and
  `test`; esbuild emits. TypeScript 7, `module: preserve`.
- **Language configuration.** `<`/`>` are not brackets (unpaired in `\<`,
  `\>`, `->`); `<<`/`>>` and `#{`/`#}` are. `(` and `[` are matched but not
  auto-closed, because slurs and beams close several notes later. `wordPattern`
  includes the leading backslash, so `\relative` is one word — completion in
  step 10 should replace that whole range.

---

## D14 — Grammar and snippet conventions

**Status:** accepted · **Refines:** D2

- **Provenance.** `syntaxes/lilypond.tmLanguage.json` is written by hand from
  the LilyPond Notation Reference and checked against LilyPond 2.26; nothing
  comes from the CC BY-NC grammar. Scope name `source.lilypond`.
- **Few names, one generic rule.** Only closed, structural sets are listed by
  name: file directives, block keywords, `\repeat` and its types, context and
  property keywords, input modes, dynamics, Scheme special forms. Every other
  `\command` — built-in or user-defined, the grammar cannot tell — is
  `support.function.command.lilypond`. Telling them apart is the job of the
  generated data in step 10 (D8), not of longer lists here.
- **Modes are the only nested rules.** `{ }`, `<< >>`, `< >`, slurs and beams
  are flat tokens, so an unbalanced bracket never bleeds into the rest of the
  file. Three constructs do nest, because words inside them must not be read
  as pitches: lyric blocks (`\lyricmode`, `\lyrics`, `\lyricsto`,
  `\addlyrics`), `\markup`/`\markuplist`, and Scheme. `\chordmode`,
  `\drummode` and `\figuremode` have no mode of their own: chord modifiers
  (`c:m7`) are matched everywhere, drum and figure names stay unscoped.
- **Scheme is built in.** `#` or `$` introduces exactly one datum; lists nest,
  quoted lists are data (no call head), unquote returns to code, and
  `#{ … #}` re-enters the LilyPond rules. We do **not** include
  `source.scheme` (this replaces the D2 note): VS Code ships no Scheme
  grammar, so snapshots could not cover that path, a foreign grammar may
  tokenise `(` without nesting and break datum-end detection, and none of them
  knows `#{ #}`. No `embeddedLanguages` mapping either, for the same reason.
- **Known limits.** A binding or parameter list head (`((x 1))`, `(music)`) is
  scoped as a call. Verified with the binary: `#! … !#` is a comment only
  inside an s-expression, not at the top level of a `.ly` file.
- **Snippets.** A snippet that inserts a command uses the command itself as
  its prefix, backslash included (`\score`, `\new Staff`). `wordPattern`
  (D13) makes `\sco` one word, so accepting replaces the typed backslash
  instead of doubling it; a bare `score` prefix would not. Snippets without a
  leading command use plain words (`lily`, `var`, `voices`). In bodies a
  literal backslash before `$` is written `\\\\$` in JSON. Step 10's completion
  provider should not re-offer what these snippets already cover.
- **Tests.** `npm run test:grammar` (`vscode-tmgrammar-snap`) compares
  `test/grammar/*.ly` against the `.snap` beside each file; it runs in
  `pretest`, without an extension host. The inputs must stay compilable
  (`lilypond test/grammar/basic.ly` is clean) so they document real syntax.
  After an intended grammar change run `npm run test:grammar:update` and
  review the `.snap` diff like code. `test/snippets.test.ts` expands every
  snippet in the extension host. `.vscode-test.mjs` lists `smoke.test.js`
  first, because its lazy-activation assertion fails once any other test has
  opened a LilyPond document.

---

## D15 — Compile service conventions

**Status:** accepted · **Refines:** D3, D5, D9, D13

- **Files.** `src/compile/compiler.ts` exports `CompileService`
  (ARCHITECTURE §3.2 first called the file `service.ts`), `locate.ts` exports
  `locateLilyPond`. `src/config.ts` is the only reader of `lily.*` settings and
  the only one of the three that imports `vscode`; the service takes plain
  values (`{ rootFile, lilypondPath, extraArgs }`).
- **Rejections vs. results.** `compile()` rejects when the root file is not
  readable (the plain `ENOENT`/`EACCES` error; checked first, because a missing
  source *directory* would otherwise surface as `spawn lilypond ENOENT`), when
  lilypond cannot be located (`LilyPondNotFoundError`, carrying the offending
  `configuredPath` for the D9 message) or when it cannot be started.
  Everything lilypond itself reports is a result with `ok: false` and raw
  stderr.
- **A configured path that does not resolve is an error.** It never falls back
  to `PATH`: compiling with a different binary than the one asked for would
  hide the mistake. The setting accepts the executable, its directory, the
  install root (`<root>/bin/lilypond`), `~/…`, or a bare command name looked up
  on `PATH`. The binary is located on every compile and not cached (D9).
- **Cancellation.** Runs are keyed by absolute root path. A newer `compile()`
  or `cancel()` marks the older run and `SIGKILL`s it; that promise resolves
  with `cancelled: true`, no pages and its directory already deleted. The new
  run does not wait for the old process to exit (separate directories).
- **Directory lifetime.** One `fs.mkdtemp(<tmp>/lily-)` per run. The service
  keeps the last completed run per root and deletes it when the next run of
  that root completes, on `release(rootFile)` (preview closed) or on
  `dispose()`. Consumers therefore read `pages` when the result arrives and
  hold the SVG text, not the paths. A headless caller (step 11) that wants the
  files to outlive the process simply does not call `dispose()`.
- **Page order.** All `*.svg` in the run directory are pages: the root's own
  stems first, ordered by a numeric-aware comparison of the part after the base
  name (so `-10` follows `-9` and a base such as `etude-2` is not mistaken for
  page 2), then stems renamed by `\bookOutputName`.
- **English stderr.** The child gets `LANGUAGE=en` because lilypond translates
  the severity keywords; `LC_ALL=C` was rejected since it also changes how
  non-ASCII paths are decoded. Step 5's parser may rely on English keywords.
- **User arguments** go before `-o`, so they can switch features off
  (`-dno-point-and-click`) but the output location is always ours (D5).
- **Settings scope.** `lily.lilypond.path` is `machine-overridable`,
  `lily.compile.extraArgs` is `resource`. The manifest does **not** declare
  `capabilities.untrustedWorkspaces`, so VS Code disables the extension in
  Restricted Mode — the safe default, since compiling a `.ly` file executes
  its embedded Scheme. Declaring `"limited"` later (to keep highlighting in
  untrusted folders) requires gating every compile on
  `vscode.workspace.isTrusted` and listing both settings under
  `restrictedConfigurations`.
- **Unit-test tier (settles the D12/D13 open point).** `node:test`, no new
  dependency. `node esbuild.mjs --unit` bundles every `*.test.ts` in a
  *subdirectory* of `test/` into `out/unit/`, and `npm run test:unit` runs
  them; top-level `test/*.test.ts` stay extension-host tests. Compile tests
  use the real binary and skip (not fail) when it is absent; step 12's CI must
  install LilyPond or they silently stop covering anything.
- **Not verified.** Windows: `.exe` lookup, `Program Files` directories,
  backslashes in `-o`, and `SIGKILL` semantics are written from documentation,
  not run.

---

## D16 — Diagnostics conventions

**Status:** accepted · **Refines:** D3, D6, D9

- **Files.** `src/diagnostics/parse.ts` (pure, no `vscode`; D6 called it
  `compile/stderr.ts`) and `src/diagnostics/publish.ts` (`CompileReporter`).
- **Not a field of `CompileResult`.** ARCHITECTURE §3.1 first listed
  `diagnostics` there. The service keeps returning raw stderr and consumers
  call `parseStderr(result.stderr, { rootFile })`: a pure function of data the
  result already carries, so the service stays a process runner and the CLI
  (step 11) makes the same one-line call.
- **`LyDiagnostic` keeps lilypond's numbers.** `line` and `column` are 1-based
  as printed (the JSON contract of D11). `columnToCharacter(lineText, column)`
  and `diagnosticSpan(lineText, column?)` map them onto real text: tab stops of
  8, code points → UTF-16 units, then widened to the token — `\command`, string,
  word with its octave and duration marks, or the balanced `#( … )` for Scheme
  errors, which lilypond reports at the parenthesis. At whitespace or end of
  line the span covers one character so it never collapses. Line-only and
  locationless messages span the line without its indentation.
- **Line text comes from disk**, not the editor buffer: it is what lilypond
  compiled. If the file cannot be read, the raw column is used.
- **Message assembly.** A block runs from one header line to the next. Its two
  context lines are recognised by width (ARCHITECTURE §3.5); every other line
  joins the message with `\n`. Blank lines and `continuing, cross fingers` are
  dropped. `programming error` is a warning whose message keeps that prefix.
  Lines before the first header (Guile notes, backtraces) are only in the
  output channel.
- **Locations that are not files.** Text parsed by Scheme
  (`ly:parser-include-string`, `ly:parse-string-expression`) is reported as
  `<included string>:1:6: error: …` or `<string>:…`. Such a message goes to
  line 1 of the root file, without a column, and ends with
  `(in <included string>, line 1, column 6)`; it must not become a diagnostic
  on a file that does not exist.
- **`fatal error: failed files: …`** ends every failed run. It is dropped when
  another error explains the failure and kept when it is the only one, so a
  failure is never silent (D6) and never duplicated at line 1.
- **Ownership.** The reporter remembers what each root reported per file and
  replaces exactly that on the root's next completed run; an `.ily` shared by
  two roots shows the de-duplicated union. Cancelled runs and runs that could
  not start leave diagnostics untouched.
- **Status bar** (`lily.compileStatus`, right side, only while a LilyPond
  editor is active) follows the most recently *started* run: idle → click
  compiles; spinning while compiling; `$(check)`, or error/warning counts with
  the matching background → click opens Problems; start failure → click opens
  the output. The **output channel** "LilyPond" gets a timestamped line per
  run, the raw stdout/stderr and a one-line summary; it is never revealed
  automatically.
- **Failures to start** (D9): `LilyPondNotFoundError` shows one message with
  *Open Settings* / *Download*, and not a second one while the first is open;
  anything else shows the error with *Show Output*. `reporter.run()` never
  rejects.
- **Commands added here**, because diagnostics need a trigger: `lily.compile`
  and `lily.showOutput`, palette only. Step 9 owns menus, keybindings and
  `when` clauses.
- **Tests.** `test/diagnostics/parse.test.ts` uses verbatim 2.26 stderr plus
  one real compile that maps every message back onto its source token.
  `test/diagnostics.test.ts` (extension host, skipped without the binary)
  drives `lily.compile` on `test/fixtures/broken.ly`, which is broken on
  purpose together with `parts/broken-part.ily`. The status bar and channel
  have no readable API and are not covered.
- **Not verified.** Windows path output, and LilyPond older than 2.26 (which
  may print relative paths; they resolve against the root's directory).

---

## D17 — Preview panel conventions

**Status:** accepted · **Refines:** D1, D4, D5, D13

- **Files.** `src/preview/panel.ts` (`previewHtml`, `PreviewPanel`,
  `PreviewManager`, the `HostMessage` / `WebviewMessage` types),
  `media/preview.js`, `media/preview.css`. The command is
  `lily.preview.openToSide`; menus and keys are in D20.
- **Types-only `vscode`.** `panel.ts` never calls into `vscode`: `extension.ts`
  hands the manager a `createPanel(title)` closure (`ViewColumn.Beside`,
  `preserveFocus`) and the asset URIs. The whole lifecycle therefore runs under
  `node --test` against a fake `WebviewPanel` (`test/preview/panel.test.ts`);
  `test/preview.test.ts` covers the real webview in the extension host.
- **One pipeline.** `extension.ts` passes *every* compile of a previewed root to
  `preview.follow(run)`, whatever started it, so step 7 only has to trigger
  compiles. Opening a preview compiles; revealing one that already shows pages
  does not. The panel reads the SVG text as soon as the result arrives and keeps
  the text, never the paths (D15). Closing it calls `compiler.release(root)`.
- **What is shown.** Pages, when a run wrote any, also a failed one (plus a
  note). A failed run without pages keeps the previous render and says so;
  cancelled runs change nothing; "busy" counts followed runs, so it lasts until
  the successor ends. Notes are composed on the host and sent as
  `{ type: 'status', busy, note }`.
- **CSP.** `default-src 'none'; img-src data:; style-src <cspSource>;
  script-src 'nonce-…'`, `localResourceRoots` = `media/` only. No inline style
  either: the webview sets sizes through the CSSOM (`style.setProperty`), which
  a CSP does not restrict.
- **Untrusted SVG.** A `.ly` file can put arbitrary markup into its output. The
  webview parses each page with `DOMParser`, keeps only an allow-list of drawing
  elements, drops `on*` and `style` attributes, and keeps an `href` only when it
  is `textedit:`/`http(s):`/`mailto:` on `<a>`, a bitmap `data:` URI on
  `<image>`, or a same-document `#id` elsewhere. `width`/`height` are removed so
  CSS sizes the page from its `viewBox`. Before parsing, inline styles are cut
  from the text, only because Chromium otherwise logs one CSP violation per
  notehead.
- **Zoom is relative to fit-width.** `1` means "page width = pane width" and is
  labelled *Fit*; range 0.25–4; a resized pane keeps the proportion. Controls:
  the −/Fit/+ group (part of the toolbar since D20), `+` `-` `0`, Ctrl/Cmd+wheel (also a trackpad
  pinch, anchored at the pointer), and the host message
  `{ type: 'zoom', action: 'in' | 'out' | 'fit' }` behind `PreviewPanel.zoom()`
  for step 9's commands.
- **Scroll anchor.** A position is `{ page, offset }` — page index plus a
  fraction of that page's height — together with the horizontal centre as a
  fraction of the scroll width. It is captured before and restored after every
  refresh, zoom and resize, and saved with `vscode.setState` on scroll. VS Code
  destroys a hidden webview; on reload the script posts `ready`, the host
  re-sends colours, pages and status, and the saved anchor and zoom are applied.
  A score that got shorter lands at the end of its last page.
- **`rendered` handshake.** After each render the webview posts
  `{ type: 'rendered', revision, pages }`; `PreviewPanel.whenRendered()`
  resolves once the latest revision is drawn. The tests rely on it, and step 8
  can use it to know when the link index is current.
- **`textedit:` links are inert for now.** The webview `preventDefault`s every
  click on an `<a>`, so nothing navigates; step 8 turns `textedit:` links into
  reveal requests. VS Code's own webview click handler runs regardless of
  `preventDefault` and hands `http(s):` and `mailto:` links (from `\with-url`)
  to its opener, ignoring every other scheme (read in the 1.138 sources, not
  clicked through), so those need no code of ours.
- **Colours.** `lily.preview.colors`: `theme` (default; `currentColor` on the
  editor background, D1) or `paper` (black on white pages). Applied live.
- **`activate()` returns `{ previews }`** (`LilyApi`), so extension-host tests
  can reach a panel.
- **Not done here.** No `WebviewPanelSerializer`: previews are not restored
  after a window reload (it would need a compile at startup). The panel icon
  came with D20.
- **Verified** by loading the real script and stylesheet in headless Chrome
  under the same policy: a hostile SVG (script, `onload`, `foreignObject`,
  `javascript:` link, SMIL) left nothing behind, a refresh kept `scrollY`
  exactly, a zoom kept the point at mid-viewport, the left edge of a zoomed
  page stayed reachable, and a reload returned to the saved place and zoom. The
  harness was not kept; scroll events needed a synthetic dispatch there.

---

## D18 — Refresh-on-save conventions

**Status:** accepted · **Refines:** D3, D4, D9, D10

- **Files.** `src/preview/autoPreview.ts` (`AutoPreview`; no `vscode` import,
  the host is an interface, so the timing runs under `node --test` on the mock
  clock) and `src/compile/rootFile.ts` (`parseIncludes`, `includeClosure`,
  `rootsIncluding`, `includeDirsFromArgs`; no `vscode`, D3). `extension.ts`
  owns the single `onDidSaveTextDocument` listener.
- **A save refreshes open previews, nothing else.** Without a preview a save
  costs nothing: no compile, no include scan. Diagnostics of a file that is not
  previewed update through `LilyPond: Compile`. This narrows ARCHITECTURE §3.6,
  which had every save of a `lilypond` document compile.
- **Root resolution walks down from the previewed roots**, not up from the
  saved file. For each open preview the `\include` closure of its root is read
  from disk on every save (no cache, D9); the roots whose closure holds the
  saved file are refreshed — all of them when two previews share an `.ily`. This
  is D10's "a root with an open preview" rule and needs no workspace scan. The
  saved file's language does not matter, only its path. D10's other rules
  (explicit setting, unique including file, ask once) apply when an `.ily`
  *without* a previewed root is compiled or previewed; that is still not
  implemented: `lily.compile` and `lily.preview.openToSide` treat the active
  file as the root.
- **Include lookup** mirrors lilypond 2.26 **[verified]**: the including file's
  directory, then the root's directory, then `-I dir` / `-Idir` /
  `--include dir` / `--include=dir` from `lily.compile.extraArgs`. Every
  existing candidate counts as an edge, since a false edge costs one recompile
  and a missing one a stale preview. Paths are compared after `realpath`
  (symlinks, `/var` → `/private/var`, case-insensitive volumes). Names that
  resolve nowhere (`english.ly`) are ignored. The scanner skips `%` and
  `%{ %}` comments and strings; a file name computed in Scheme is not seen.
- **Debounce.** Trailing edge, one timer per root, `lily.preview.refreshDelay`
  (default 300 ms, 0–5000). Save All of a root and three includes is one
  compile. When the timer fires the setting and the preview are checked again.
- **Stale runs.** The service already kills the root's in-flight run when the
  refresh starts (D3); the stale run is not killed earlier, at save time, so
  the panel's busy state does not flicker during the delay.
- **One compile per save, whoever saves.** `compileRoot()` in `extension.ts`
  calls `autoPreview.compileStarted(root)` first: it drops the root's waiting
  refresh, and a save whose roots are still being resolved skips a root whose
  compile started after it (logical clock). That is what keeps
  `LilyPond: Compile` on a dirty previewed file — which saves, then compiles —
  from being superseded by a refresh of its own save. The extension-host test
  for it fails without the rule, which also confirms that VS Code delivers
  `onDidSaveTextDocument` before `document.save()` resolves.
- **The refresh compiles what is on disk** and saves nothing: when an include
  is saved while the root has unsaved edits, the root's editor is left alone.
- **Settings.** `lily.preview.refreshOnSave` (default `true`) and
  `lily.preview.refreshDelay`, both `window` scope, read on every save.
  `activate()` now returns `{ previews, autoPreview }`.
- **Found on the way, not fixed here.** lilypond changes into the `-o`
  directory before it reads the input **[verified]**, so a *relative* `-I lib`
  in `lily.compile.extraArgs` is searched under our temp directory and never
  matches; absolute directories work. The fix belongs in
  `src/compile/compiler.ts` (resolve relative `-I` arguments against the root's
  directory before spawning). Also: a bare top-level `\music` directly after
  the `\include` that defines it fails with `unknown command`, because the
  lexer reads it before the include is processed; `{ \music }` works.

---

## D19 — Point-and-click conventions

**Status:** accepted · **Refines:** D7, D17

- **Files.** `src/preview/pointAndClick.ts` (`parseTextEdit`, `LinkIndex`,
  `canonicalFile`, `charToCharacter` / `characterToChar`; no `vscode` import —
  ARCHITECTURE §3.2 first called it `sync.ts`). The protocol is in `panel.ts`,
  the DOM side in `media/preview.js`, the editor side in `extension.ts`.
- **Elements are addressed by their href.** D7 planned an index of element ids;
  the webview sanitises and rebuilds the DOM, so ids would have to be invented
  on both sides and kept in step. Instead `LinkIndex.build(pages)` reads the
  `textedit:` hrefs from the SVG text when a result arrives (file → line →
  links by `CHAR`), a lookup answers with hrefs, and the webview keeps a
  `href → <a> elements` map per render. A music variable used twice is one
  href and both places are marked.
- **Score → code.** A click on a `textedit:` link posts
  `{ type: 'reveal', href }`. The panel parses it (`parseTextEdit`: numbers from
  the right, percent-decoded, absolute paths only) and the manager hands the
  location to `PreviewHost.revealSource`. `extension.ts` opens the file — root
  or `.ily` — in the column that already has a tab for it, else a visible
  editor column other than the preview's, else column One; the cursor lands on
  the token and the editor takes the focus, since the click means "edit this".
  `CHAR` is converted against the line text of the *buffer*. A link can name
  any local path (a `.ly` file can write its own with `\with-url`); opening a
  text document on the user's click is all it can do with that.
- **Code → score.** `onDidChangeTextEditorSelection` and
  `onDidChangeActiveTextEditor` feed `PreviewManager.followCursor()`, which
  waits `CURSOR_DELAY_MS` (100 ms) and calls `showCursor()`: the cursor becomes
  `{ canonical file, 1-based line, CHAR }` and every panel looks it up. The
  match is the nearest link at or before the cursor on its line (D7), and —
  added here — the line's first link when the cursor is left of it, so *Home*
  still shows where the line is. A line without links clears the mark. Only
  `lilypond` documents on disk count; the preview taking the focus (no active
  editor) changes nothing. The panel posts
  `{ type: 'highlight', hrefs, reveal }` and the webview answers
  `{ type: 'highlighted', elements }` (`PreviewPanel.highlighted`, used by the
  tests).
- **`reveal` scrolls only when needed**, centring the first marked element if
  it is not fully inside the viewport (24 px margin). After a refresh or a
  webview reload the panel marks its remembered cursor again with
  `reveal: false`, so the restored scroll position (D17) wins. A cursor placed
  before the first render is marked by that render, also without scrolling.
  Neither does the cursor move that a click causes: the panel remembers the
  clicked location and marks it with `reveal: false`, otherwise a note clicked
  within the margin of the pane's edge would jump away from under the mouse.
- **Same file, different spelling.** LilyPond prints paths as given; the editor
  may reach the file through a symlink. Index keys and cursors both go through
  `canonicalFile()` (`realpath`, falling back to the resolved path; lower-cased
  on Windows, where VS Code lower-cases the drive letter).
- **Positions are those of the last compile.** Editing without saving shifts
  the text under the links; both directions then land near, not on, the token
  until the next save refreshes the preview (D18). Not compensated.
- **Look.** `preview.js` adds the class `source` to `textedit:` links (pointer
  cursor, link colour on hover) and `current` to the marked ones: link colour
  through `color` (the backend paints with `currentColor`, D1) plus a 2 px
  non-scaling stroke on paths, so a notehead is findable at fit-width. Paper
  mode uses a fixed blue. Hit testing is left at the default:
  `pointer-events: bounding-box` makes hollow noteheads easier to hit but lets a
  slur's box swallow the notes under it.
- **Setting.** `lily.preview.followCursor` (default `true`, `window` scope, read
  on every event). Switching it off clears the mark; switching it on marks the
  current cursor. Clicking a note works regardless. `activate()` now returns
  `{ previews, autoPreview, revealSource }`.
- **Tests.** `test/preview/pointAndClick.test.ts` (verbatim 2.26 hrefs, and a
  real compile with a tab, an astral character, a space and a non-ASCII letter
  in the paths, mapping every token to its link and back), protocol and
  debounce tests in `test/preview/panel.test.ts`, and the extension-host suite
  `test/pointAndClick.test.ts`, where the real webview marks notes of an
  include. A real DOM click cannot be produced there; it was checked by loading
  `preview.js` and `preview.css` in headless Chrome under the same CSP (click →
  `reveal` with the href, `\with-url` links still prevented, mark visible in
  both colour modes). The harness was not kept.
- **Not verified.** Windows link spelling (`textedit:///C:/…` is handled from
  documentation). Grobs other than noteheads, scripts and text were not
  surveyed: whatever carries a `textedit:` link is clickable and markable.

---

## D20 — Command surface conventions

**Status:** accepted · **Refines:** D4, D5, D12, D17 · **Addresses:** G9

- **Files.** `src/commands.ts` registers every `lily.*` command
  (`registerCommands(host)`; `extension.ts` keeps `compileRoot`, the listeners
  and `revealSource`). `package.json` holds the menus, keybindings and `when`
  clauses; `media/icons/preview.svg` / `preview-dark.svg` are the icon of
  `Open Preview to the Side` and of the preview's tab (D17 had none).
- **Commands.** `lily.compile`, `lily.showOutput`, `lily.preview.openToSide`,
  `lily.preview.refresh`, `lily.preview.zoomIn` / `zoomOut` / `zoomFit`,
  `lily.preview.nextPage` / `previousPage`, `lily.export.pdf`,
  `lily.export.midi`. Compile, preview and export take an optional file `Uri`
  and resolve with their result (the tests use that).
- **What a command is about.** Compile, preview and export: the `Uri` argument,
  else the root of the *active* preview, else the active editor. A preview's
  title bar passes the webview's own `webview-panel:` URI, which is ignored.
  Zoom, page and refresh: `PreviewManager.target(file)` — the active preview,
  else the preview of the active editor's file, else the only preview. So
  *Refresh Preview* from an editor that shows an `.ily` recompiles the score
  that is on screen, while `lily.compile` still treats the active file as the
  root (D18). With several previews and nothing to choose by, the user is asked
  to focus one.
- **Where they appear.** A LilyPond editor's title bar has the preview button;
  *Compile*, *Export PDF* and *Export MIDI* are in its `…` menu. The preview's
  title bar has *Refresh Preview* and *Export PDF*; MIDI, zoom, pages and
  *Show Output* are in its `…` menu. The explorer and tab context menus offer
  the preview and the exports for `.ly` / `.ily` files. In the palette, compile
  and export need a LilyPond editor or a focused preview, and the preview's own
  commands need `lily.previewOpen`, a context key that `extension.ts` keeps
  true while any preview is open. `activeWebviewPanelId == 'lily.preview'` is
  the `when` clause for "the preview has the focus".
- **Keys.** `Ctrl/Cmd+K V` opens the preview (as Markdown does) and
  `Ctrl/Cmd+K B` compiles, or refreshes when the preview has the focus: chords
  under `Ctrl/Cmd+K` shadow no built-in binding, which `Ctrl+Alt+B` (secondary
  side bar) would. `Alt+PageDown` / `Alt+PageUp` turn pages in a focused
  preview. Zoom stays inside the webview (`+` `-` `0`, Ctrl/Cmd+wheel, D17): a
  contributed key would fire together with the webview's own handler.
- **Webview toolbar.** A fixed 32 px bar at the top of the preview replaces
  D17's floating zoom group: refresh, `‹ 1 / 3 ›` (hidden for one page),
  `− Fit +`, *PDF*, *MIDI*. Text glyphs, no icon font, so the CSP is unchanged.
  Fixed rather than sticky, because a zoomed score scrolls sideways. The cursor
  reveal (D19) treats the bar as outside the viewport. Below 400 px the gaps
  shrink so the export buttons stay visible.
- **Pages.** "The page" is the one under the toolbar — the row `32 + 16 + 1` px
  below the pane's top — or the last one once scrolled to the end, since a short
  last page never gets there. *Next* puts the following page's top on that row;
  *Previous* first returns to the top of the current page when more than 8 px
  into it. The arithmetic (`pageAt`, `stepPage`) is in the pure half of
  `preview.js`.
- **Protocol.** Host → webview `{ type: 'page', action: 'next' | 'previous' }`.
  Webview → host `{ type: 'view', page, pages, zoom }` whenever the toolbar
  shows something new (`PreviewPanel.view`; nothing but the tests reads it yet)
  and `{ type: 'command', command }` for the three buttons only the host can
  serve. `command` is one of `refresh` / `exportPdf` / `exportMidi`; the panel
  drops anything else and `commands.ts` maps the name to a command id, so a
  score's markup can never name a VS Code command.
- **Export** (D5). `CompileService.export({ rootFile, format, targetDir? })` is
  a second run in its own temp directory and its own `live` slot: it neither
  kills a preview compile nor replaces the kept pages, and only a newer export
  of the same file and format supersedes it (`cancelExport()` serves the
  notification's *Cancel*). PDF runs with `--pdf -dno-point-and-click`, so the
  file carries no `textedit:` links with the author's paths; MIDI runs with
  `-dno-print-pages`, which engraves nothing and still writes what `\midi`
  asks for **[verified on 2.26]**. D5 planned MIDI as a copy from the preview
  run; a run of its own costs a fraction of a second and cannot hand out a
  stale or already deleted file. Every `.pdf` / `.mid(i)` the run wrote is
  copied next to the source under lilypond's own names (`score.pdf`,
  `score-alto.pdf`), replacing older files as `lilypond score.ly` would. A
  dirty document is saved first. The run goes through `reporter.run()`, so
  errors reach the Problems panel and the output channel (summary: `n files`),
  but never through `compileRoot()`: it has no pages to show. Outcome messages
  offer *Open* (system viewer) and *Reveal*; a score without `\midi` is told
  which block to add.
- **Tests.** `test/commands.test.ts` (extension host) checks the manifest
  against the registered commands — every menu and keybinding names a
  contributed command and has a `when` — and drives zoom, page turns, refresh
  and both exports, reading the real webview's `view` reports.
  `test/compile/compiler.test.ts` covers `export()`;
  `test/preview/panel.test.ts` the protocol, `target()` and the pager
  arithmetic. The toolbar's look was checked once in headless Chrome at 600 px
  and 340 px in both themes; the harness was not kept.
- **Verified against the VS Code 1.138 bundle.** `activeWebviewPanelId` holds
  the viewType as the extension gave it (`lily.preview`), not the prefixed one
  a tab's `TabInputWebview.viewType` shows; and neither the workbench nor a
  built-in extension binds `Ctrl/Cmd+K B`.
- **Not verified.** That a preview's title bar really passes a
  `webview-panel:` URI was read in the VS Code sources, not observed; without an
  argument the active preview is used anyway. Menus and keybindings cannot be
  invoked from a test, only checked for consistency. Windows and Linux key
  handling was not tried.
- **Not done here.** No save dialog or export directory setting (`targetDir`
  exists in the service for step 11's CLI). D10's root resolution for a compile
  started in an `.ily` is still open.

---

## D21 — IntelliSense conventions

**Status:** accepted · **Refines:** D8, D13, D14 · **Addresses:** G7

- **Files.** `scripts/gen-completions.mjs` writes `data/completions.json`
  (D8 called it `lilypond-data.json`); `src/intellisense/data.ts` declares its
  shape and indexes it, `completion.ts` and `hover.ts` decide what to show, and
  `provider.ts` is the only file that imports `vscode`. `extension.ts` calls
  `registerIntelliSense(context.extensionPath)`. None of it needs the binary
  (D9). The data is read on the first completion or hover, not at activation.
- **Generating.** `npm run gen:completions` (binary: first argument, else
  `$LILYPOND`, else `lilypond` on `PATH`). LilyPond runs a Scheme block that
  dumps raw facts as JSON into a temp directory; the script turns Texinfo into
  Markdown, builds signatures and sorts. The file has one entry per line, sorted
  by name, so a regeneration diffs by entry. `test/intellisense/data.test.ts`
  fails when a category vanishes or a Texinfo construct is left unconverted —
  run it after regenerating with a new LilyPond version. From 2.26.0: 196 music
  functions, 332 predefined commands, 47 keywords, 182 markup commands, 43
  contexts, 167 grobs, 334 grob and 236 context properties; ≈ 430 kB.
- **What the binary cannot tell.** The lexer's reserved words (`\new`,
  `\score`, `\override`, …) are not Scheme values; the script lists them by
  hand with a one-line description each. Anything the binary does report under
  the same name wins. Parameter names are not available either (Guile reports
  `a b c`), so a signature shows types — `\relative [pitch] (music)`, brackets
  for optional — and the docstring names the parameters.
- **Commands.** One list, four kinds: `function` (with signature and return
  kind), `music` (predefined identifiers such as `\stemUp`, `\staccato`, `\f`,
  context modifications, durations; with their expansion from
  `music->lily-string` when it is short and holds no printed Scheme object —
  `#<hash-table 10ac…>` would change with every run), `keyword`, `markup`. A name that is
  also a markup command (`\tiny`, `\override`, `\score`) keeps one entry with a
  `markup` sub-entry. User properties only: internal grob properties are
  dropped, and a grob's properties are the union over its interfaces, the ones
  its description sets (`defaults`) sorted first.
- **Where completion answers** (`completionsAt(index, textBefore)`; the
  provider passes the last 60 lines, so a construct may be split over lines):
  after `\` every command, the whole `\word` replaced (D13); after `\new`,
  `\context`, `\change` the contexts; after `\context {` a `\Context`; after
  `\override`, `\revert`, `\overrideProperty`, `\tweak`, `\hide`, `\omit` first
  grobs and contexts, after `Context.` grobs, after `Grob.` its properties
  (`\tweak` also takes a bare property); after `\set`, `\unset` context
  properties and contexts. Nothing in comments and strings, below
  `Grob.property`, or after the second backslash of `\\`.
- **Trigger characters** are `\`, `.` and space, so that `\new ` and
  `\override NoteHead.` open the list unasked. Everywhere else the provider
  returns `undefined` for them, and nothing pops up between notes (tested in
  the host).
- **Snippets win (D14).** Commands that a snippet prefix spells exactly
  (`\score`, `\relative`, …) are read from `snippets/lilypond.json` at load
  time and not offered again; hover still documents them.
- **`\markup` is a guess.** `inMarkup()` looks for an open brace, or a run of
  commands, after the last `\markup`. It only reorders the list (markup
  commands first inside, last outside) and picks which meaning of a shared
  name to show; it never hides anything.
- **Hover.** `\command` anywhere outside comments and strings. A bare word only
  in a property path — next to a dot, right after one of the commands above, or
  (properties) before `=` — because `Rest`, `Staff`, `color` and `text` are
  also lyrics.
- **Not done here.** No completion of Scheme (`#'symbol`, `ly:` functions), of
  `\include` paths, of `\clef`/`\bar`/`\language` arguments, of engraver names
  after `\consists`, of user-defined variables, nor signature help. No setting
  switches IntelliSense off; `editor.quickSuggestions` and
  `editor.hover.enabled` can be set per language. Step 12's `.vscodeignore`
  must keep `data/` and `snippets/`.

---

## D22 — Headless checker conventions

**Status:** accepted · **Refines:** D5, D11, D15, D16 · **Addresses:** G12

- **Files.** `tools/lily-check/` (ARCHITECTURE §3.2 first put it in `src/`):
  `check.ts` turns one compile into a `CheckReport`, `cli.ts` parses arguments and
  prints, `mcp.ts` serves, `main.ts` is the three-line entry, kept apart so that
  tests can import the CLI without running it. One bundle,
  `dist/lily-check.js`, with `compile` and `mcp` as subcommands; `bin` in
  package.json names it. No `vscode` import anywhere under `tools/`.
- **One report for both surfaces.** `CheckReport` is `CompileResult` without the
  raw streams plus `parseStderr`'s diagnostics (the same one-line call the editor
  makes, D16), `errorCount` and `warningCount`. `ok` is exit code 0. When
  lilypond never ran, `error.code` is `file-not-found`, `lilypond-not-found` or
  `failed`, and the report keeps its shape with empty lists. `check()` never
  rejects. Raw `stderr` is included only for a failed run with no parsed error
  (a crash, a Guile backtrace), where it is all there is.
- **`source` and `token`.** Each diagnostic with a column also carries its source
  line and the token `diagnosticSpan` finds there. `line` and `column` stay as
  lilypond prints them (D11), but the column counts tab stops and code points, so
  an agent indexing the line with it lands in the wrong place [verified on
  `broken.ly`: column 24 behind a tab]. Column-less messages get neither: a bare
  message sits at line 1 of the root, which it says nothing about.
- **Pages outlive the process, in one place.** Supersedes the note in D15 that a
  headless caller simply does not `dispose()`: an agent compiles dozens of times,
  and each run would leave a directory. Pages and MIDI are copied to
  `<tmp>/lily-check/<base>-<sha1 of the root path, 8 hex>/`, which is emptied
  first, and the run's own directory is released. `--out-dir` / `outDir` names
  another place; that one is only written into, never emptied, since the caller
  may have named a directory with other things in it. Nothing goes next to the
  source (D5).
- **CLI.** `lily-check compile <file> [--json] [--out-dir d] [-I d]… [--lilypond
  p] [-- lilypond args]`. `-I` is resolved against the caller's directory,
  because lilypond runs in the score's (D15). `$LILYPOND_PATH` stands in for
  `lily.lilypond.path`. With `--json`, stdout is exactly one JSON document,
  also when lilypond never ran; usage errors go to stderr. Exit codes: 0
  compiled, 1 lilypond reported errors, 2 lilypond did not run or bad usage.
  Without `--json` the diagnostics are printed the way lilypond prints them,
  paths relative to the working directory, then a verdict line and the pages.
- **MCP server.** Hand-written JSON-RPC over newline-delimited stdio:
  `initialize`, `ping`, `tools/list`, `tools/call`, `notifications/cancelled`.
  The SDK was rejected: it would be the project's only runtime dependency, for
  five methods. A known protocol version is echoed, otherwise the newest of
  2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05 is offered. One tool,
  `lilypond_compile` (`file`, `extraArgs?`, `outDir?`), whose result is the
  report as text and as `structuredContent`. `isError` is set only when lilypond
  never ran or the arguments are wrong: compile errors are the tool's product,
  not its failure. An unknown tool is a protocol error (−32602), as the
  specification asks. Calls run concurrently so that `ping` and cancellation get
  through; a cancelled call kills its compile and, per the specification, gets
  no response, while a call superseded by a newer one for the same file (D15)
  gets a `cancelled: true` report. At end of input, calls still running are
  answered before the server stops, so requests can be piped in.
- **AGENTS.md.** The score loop comes first and stands alone, so it can be copied
  into a score repository: compile the root, fix the first error, recompile.
  It documents `codex mcp add`; the syntax was read in the Codex sources (0.155
  is installed here) but the server was **not** registered or driven from a
  Codex session, since that means changing the user's `~/.codex/config.toml`.
  A project-scoped `.codex/config.toml` was tried and dropped: `codex mcp list`
  does not show project servers, so it could not be checked.
- **Verified** with lilypond 2.26.0: both fixtures through the built bundle
  (exit 0 and 1), a score in a directory with a space using `-I`, a missing file,
  a wrong `--lilypond`, the MCP handshake and a tool call piped into
  `lily-check mcp`, and a cancelled half-minute compile that stops within a
  second. Windows was not tried.
- **Not done here.** No PDF/MIDI export from the CLI (`CompileService.export`
  and its `targetDir` are ready for it), no PNG for agents that can look at
  images, no reading of `lily.*` from `.vscode/settings.json` (pass `-I` and
  `--lilypond`), no lookup tool over `data/completions.json`. Step 12's
  `.vscodeignore` must keep `dist/lily-check.js` if the checker is to ship inside
  the extension; its source map need not.

---

## D23 — Release conventions

**Status:** accepted · **Refines:** D12, D13, D15, D21, D22

- **The VSIX is an allow-list.** `.vscodeignore` excludes everything and lets
  back in what is loaded at run time: the two bundles (no source maps),
  `media/`, the grammar, the snippets, `data/completions.json`,
  `language-configuration.json`, README, CHANGELOG, LICENSE, `AGENTS.md` (it
  documents the shipped `dist/lily-check.js`) and `docs/images/*.png`. 20 files,
  about 1 MB, of which the three screenshots are 0.9 MB. A new run-time
  directory must be added there; forgetting it fails the release pass below,
  not the other suites, which run on the working tree.
- **Packaging.** `npm run vsix` is `vsce package --no-dependencies
  --no-rewrite-relative-links --allow-missing-repository`; `vscode:prepublish`
  runs the production build first. There are no run-time dependencies to pack
  (D12). There was no `repository` at 0.1.0, so README links could not be
  rewritten to a remote: images ship inside the VSIX, and the README links only
  to files that ship (`AGENTS.md`) or to https. The repository is
  github.com/velet5/lily since D24; the packaging is unchanged. `publisher` is still the placeholder
  `lily-dev` (D12) and `private: true` stays, against an accidental
  `npm publish`. **Nothing was published.** Before publishing: a real publisher,
  a `repository`, a 128 px `icon`, and then the images can leave the VSIX.
- **Release pass** (`npm run test:e2e`, `test/e2e/smoke.test.ts`). Packages the
  VSIX, unpacks it into `.vscode-test/vsix/` (`scripts/unpack-vsix.mjs`) and
  starts the host with `extensionDevelopmentPath` on the unpacked copy, so every
  assertion is about the files a user installs: the file list, then
  `test/e2e/workspace/score.ly` (two staves, lyrics, two pages, MIDI) through
  preview, completion and hover, a saved mistake and its fix, PDF and MIDI
  export, and the shipped `lily-check`. It does **not** skip without lilypond.
  `test/e2e/` is the one subdirectory of `test/` that is not a `node:test` suite
  (D13, D15); `esbuild.mjs --unit` leaves it out and `--e2e` builds it.
  `.vscode-test.mjs` now holds three labelled configurations, and `npm test`
  runs only `host`.
- **Screenshots are taken, not drawn.** `npm run screenshots` runs
  `test/e2e/screenshots.ts` in the same packaged host, started with
  `--remote-debugging-port`, and captures the workbench window over the DevTools
  protocol (`Emulation.setDeviceMetricsOverride` 1440×860 at 2×, then
  `Page.captureScreenshot`; the webview is part of the capture). It needs no
  screen-recording permission and uses the host's default theme. Retake them
  when the toolbar, the status bar item or the sample score changes. The file is
  not named `*.test.ts`, so no test run picks it up.
- **Lint is oxlint**, default rule set, `--deny-warnings`, part of `pretest`.
  typescript-eslint 8 requires `typescript <6.1` and this project is on 7 (D12),
  so ESLint with type-aware rules is not available; oxlint has no TypeScript
  dependency. Two rules are off, with the reasons in `.oxlintrc.json`:
  `unicorn/no-useless-spread` flags the three places where a live collection is
  copied because the loop shrinks it — following the advice would skip every
  other element — and `no-control-regex` flags the sentinels of
  `gen-completions.mjs`. No formatter is enforced.
- **CI** (`.github/workflows/ci.yml`, Ubuntu, Node 22): types, lint, grammar
  snapshots, unit tests, extension-host tests and the release pass under
  `xvfb-run`, then the VSIX as an artifact. It installs the official LilyPond
  2.26.0 binary (cached) rather than the distribution's 2.24, because 2.26 is
  what every `[verified]` in this file refers to, and it fails before the tests
  if `lilypond --version` does not run: the compile tests skip themselves
  without the binary (D15) and would otherwise pass while covering nothing.
- **Verified** on macOS with lilypond 2.26.0 and VS Code 1.138: `npm test`
  (lint clean, grammar snapshots, 192 unit and 40 host tests), `npm run
  test:e2e` (6 tests), `npm run screenshots`, and that the release pass fails
  when `data/completions.json` is taken out of the VSIX. **Not verified:** the
  workflow itself — the repository has no remote, so it has never run; the
  LilyPond download URL was checked to resolve, but not the official binary on
  the Ubuntu runner, nor the tests against 2.24. Installing the VSIX into a
  regular VS Code was not done either, since that changes the user's editor;
  the unpacked copy in a development host is the nearest thing.
- **Version** 0.1.0, the first packaged one; `CHANGELOG.md` starts there. The
  README names the install directory `lily-dev.lily-<version>`, and the release
  pass checks that it matches `package.json`.

---

## D24 — MIDI playback conventions

**Status:** accepted · **Refines:** D5, D12, D17, D20 · **Supersedes** the
playback part of *Out of scope*

- **Decision.** The score is played by the webviews themselves, with a Standard
  MIDI File parser and a small Web Audio synthesizer written for this extension
  (`media/midi.js`, plain JS like the rest of `media/`, D12). No `jzz`, no
  system MIDI port, no SoundFont: VSLilyPond's playback needed a native module
  and a synthesizer the user had to have; a General MIDI SoundFont is 10–150 MB
  and would have to be licensed and shipped. Two oscillators and an envelope per
  note are enough to hear whether the rhythm and the harmony are what was meant,
  which is what proof-listening a score is for. The synthesizer can be replaced
  later without touching the parser, the player or the protocol.
- **Files.** `media/midi.js`: `parseMidi` (bytes → notes with the channel state
  they began in; a tempo map; the sustain pedal and pitch bend resolved),
  `Synth` (any `BaseAudioContext`, one voice per General MIDI family, drums on
  channel 10, a limiter so a tutti chord does not clip), `Player` (play, pause,
  stop, seek; schedules 0.4 s ahead of the audio clock every 50 ms). The first
  half is pure and is what `test/midi/midi.test.ts` loads; the player runs
  there against a fake context. `src/midi/player.ts` and `media/player.js` /
  `player.css` are the viewer of `.mid` / `.midi` files.
- **Where playback lives.** In the preview, because the compile that draws the
  pages writes the MIDI at no cost (§3.3): `PreviewPanel.update()` reads the
  first `.midi` of the run as base64 and posts `{ type: 'midi', data }`; a
  failed run without one keeps the previous file, as it keeps the pages; a good
  run without `\midi` clears it; a score of `\midi` alone has no pages and still
  plays. The same bytes again (a refresh that changed only the layout) are not
  re-sent, so the music plays on. The toolbar gains `▶ ■ ──── 0:07 / 0:24`
  between the zoom group and the exports; the slider goes below 680 px and the
  time below 540 px, the buttons stay. `Space` in the preview plays or pauses.
- **Exported files.** A custom read-only editor, `lily.midiPlayer`, opens
  `*.mid` and `*.midi` (priority `default`: VS Code has nothing for them but
  "the file is binary"). It shows the title lilypond writes into the first
  track, the length, and a table of tracks with their General MIDI instrument
  names — the names `midiInstrument` takes. A file system watcher on the file
  re-sends it, so an export while the player is open is heard on the next play.
  The export notification's *Open* is *Play* for MIDI and opens this editor; a
  PDF still goes to the system viewer.
- **Commands** (D20). `lily.midi.play` (*Play or Pause MIDI*): the `Uri`
  argument's preview, else the target preview (D20: the active one, the active
  editor's, or the only one); without one it opens the preview of the
  compilable document and plays once compiled. A score without MIDI is told
  which block to add. `lily.midi.stop`. Both in the palette, the editor's `…`
  menu (play) and the preview's `…` menu. No keybinding: the webview's `Space`
  is the key, and a contributed one would fire together with it.
- **Sound needs a click.** VS Code's windows run with Chromium's
  `autoplayPolicy: 'user-gesture-required'` and delegate `autoplay` to the
  webview iframe **[verified in the 1.138 bundle]**: an `AudioContext` stays
  `suspended` until the user has clicked or typed in that webview once. A
  button in the toolbar is such a gesture; a command from the palette is not,
  the first time. `Player.play()` then resolves with `false` and the webview
  shows *Click ▶ to play* in the note area and reports `blocked: true` in
  `{ type: 'playback', state, position, duration, blocked }`, which
  `PreviewPanel.playback` / `MidiPlayerPanel.playback` keep. The tests, which
  cannot click, accept `playing` or `blocked` and assert on the duration, which
  proves the shipped parser read the file. **[verified]** in the host tests:
  a command-driven play is `blocked` there.
- **Hidden webviews.** A preview behind another tab is destroyed (D17), and its
  music with it. `PreviewPanel.play()` on a hidden panel reveals it and plays
  on the next `ready`. Playback does not survive a window reload either.
- **Phones** (added with chapter 07 of `docs/research/wasm-engine`). The
  first ▶ sets `navigator.audioSession.type` to `playback` where it exists
  (Safari 16.4 and later). Without it, Safari treats the music as ambient
  sound, which is silent while an iPhone's ring switch is on silent and stops
  in the background. When the system stops the audio clock under a playing
  `Player` (Safari's and Chrome 136's `interrupted` state during a call, or
  `suspended`), the player pauses where the music was, so ▶, a gesture,
  resumes it. **Verified** with fakes in `test/midi/midi.test.ts`, and in
  Playwright's WebKit 26.4 and Chromium 147: the session became `playback`,
  and `suspend()` under a playing T02 paused it at 1.44 s. Not tried on a
  phone (step 10).
- **Untrusted input.** A `.midi` file is parsed by hand in the webview, never
  `eval`ed; track names are set as `textContent`. The parser throws on anything
  that is not a metrical SMF 0/1, and the message is shown instead of a player.
  The viewer's CSP is the preview's without `img-src`.
- **Verified** in headless Chrome with an `OfflineAudioContext`: the sample
  score renders without NaN at a peak of 0.48, a twenty-note fortissimo chord
  at 0.71 (the limiter holds), and every General MIDI family and drum sounds.
  How it *sounds* was not judged by ear; the harmonic tables are a first cut.
- **Not done here.** No highlighting of the notes as they play and no "play
  from the cursor": lilypond's MIDI carries no source positions, so that needs
  a mapping from the SVG's `textedit:` links to the note list, a later step.
  No tempo or volume control, no metronome, no choice among several `\midi`
  files of one score (the first is played), and no playback from the CLI.

---

## Out of scope

MIDI keyboard input and `python-ly` formatting. MIDI playback was out of scope
until step 12 and is D24.

---

## D25 — Unsaved, accelerated live preview

**Status:** accepted · **Supersedes:** the disk-only/save-only and editor
cancellation portions of D3, D15 and D18; the disk-only diagnostic text rule in
D16 and page-replacement rule in D17 · **Refines:** D1, D5, D19, D24

- **Default behavior.** Preview/Compile reads an immutable capture of dirty
  editor buffers without saving them. `refreshOnChange` defaults to true and
  requires the existing `refreshOnSave` master switch. The delay is now 150 ms.
  A separate maximum-wait timer fires within 750 ms of a typing burst (or the
  configured delay when longer). A `LiveQueue` owns one running and one
  replaceable pending callback per root, including manual requests. It waits
  for panel/reporter consumption before starting the successor. Low-level
  `CompileService.compile()` keeps its cancellation contract for CLI/MCP and
  explicit disposal. Closing a preview drops pending work and kills its run.
- **Revisions.** Buffers and document versions are captured synchronously at
  the start of the queued callback. Literal dependencies are followed through
  those buffers. Completed results may advance the visible score while newer
  edits wait, with an Updating indicator. They cannot overtake a later result.
  Diagnostics use captured text and are published only if the relevant open
  document versions and compile settings still match; an edit clears obsolete
  diagnostics immediately. Config changes queue a new preview.
- **Snapshots.** `src/compile/snapshot.ts` writes the root and resolved literal
  include closure into the run directory, rewriting include string tokens to
  absolute snapshot paths. Each text is read once. Editor buffers are captured
  together; external disk changes do not have filesystem-wide transaction
  semantics. Search order stays including directory, root directory, then `-I`;
  built-in library includes remain on LilyPond's search path. Symlink aliases
  resolve dirty buffers too. Exact replacement offsets map SVG links (CHAR and
  tab-expanded COLUMN) and parsed diagnostics back to original files, including
  notes after an include on the same line. Raw stderr remains raw in the log.
  Normalized SVG is written before hashing and delivered to every preview.
- **Conservative boundary.** A known computed include or Scheme include API
  with dirty buffers fails explicitly instead of silently mixing in stale disk
  content. Dependency scheduling treats known computed includes conservatively.
  Arbitrary Scheme file I/O, dynamically hidden include APIs, and programs
  deriving resources from their source filename cannot be fully snapshotted;
  save these projects before compiling. Untitled buffers still need filenames.
- **Acceleration gate.** `runtime/glyph-cache.scm` caches only string-valued
  music glyph output. Font definitions and individual glyph XML are also cached,
  so new sizes and list-valued requests do not repeatedly scan entire SVG fonts.
  List requests still call the original extractor on every invocation, preserving
  cumulative advance, offsets, spaces and scaling. Unknown types and missing
  glyphs keep original behavior. All caches clear at session end, and every
  wrapped private function has an arity guard. A host probe requires LilyPond **2.26.0** and
  SHA-256 `82b4a568e196239557fba92670dc0d9a685edae129dc0625fc1f1ef65a70e6d2`
  for the installed `lily/output-svg.scm`. The hash is checked each request;
  the shim also guards version/arity. Installed files are never edited.
  Unknown versions/patched backends, missing resources and custom options
  beyond include directories use ordinary spawning. `preview.acceleration`
  selects `auto`, `cache` or `off`; there is no acceleration in exports or the
  headless checker. Arbitrary runtime backend mutation/custom music fonts remain
  a reason to choose `off` despite the compatibility checks.
- **Warm isolation.** `auto` on Unix uses a parent that has loaded the backend
  but has **not** called `ly:reset-all-fonts` or parsed declarations-init. Each
  request forks and calls `lilypond-all` in the child, following LilyPond's own
  pre-Pango fork ordering. Fonts, sessions, options and arbitrary score Scheme
  die with that child; no sequential shared-state worker is shipped. The private
  protocol accepts only an integer request id plus source/output path strings
  on stdin (read, never eval); fd 3 carries READY/DONE responses and is closed in
  the child. Score stdout/stderr go to per-request files. No network listener.
- **Lifetime and recovery.** Parent identity includes binary realpath, size,
  modification time, environment, arguments and root. A worker is replaced
  after 32 requests or five minutes, or stopped after one idle minute. At most
  four parents are retained; capacity falls back to spawning if all are busy.
  Startup is limited to ten seconds and a compile to sixty seconds. Cancellation
  kills the Unix process group, including a stuck child. Protocol errors,
  crashes and worker timeouts disable that worker configuration and retry with
  ordinary LilyPond. A failed optimized score is also retried without the shim
  (syntax errors therefore cost an extra run). Fallback has its own sixty-second
  timeout; `CompileRequest.timeoutMs` permits shorter tests. A changed binary
  or configuration can start a fresh worker. Windows uses spawning.
- **Viewer reuse.** SHA-256 of normalized SVG identifies each page. The host
  retains unchanged per-page `LinkIndex` objects and combines them; the webview
  retains same-position page DOM and cached link lists, sanitizing only changed
  pages. Removed pages drop out of both indexes. All page text is still sent in
  the message. Scroll/zoom/theme behavior is unchanged, and identical MIDI is
  not resent. Whole-score playback is always retained; no passage cropping.
  Snapshot path encoding matches LilyPond's lowercase UTF-8 escapes, including
  URI-reserved punctuation, so saving a Cyrillic-named file retains identical
  page hashes. Files without rewritten includes retain their original source
  positions directly, avoiding a whole-source scan for each link.
- **Timing.** `CompileResult` adds engine, fallback reason and snapshot time;
  `PreviewPanel.latency` records host preparation, host-to-ack time, busy-period
  time and reused-page count. The rendered acknowledgment follows two animation
  frames, approximating a paint opportunity, not measuring GPU completion.
  Hidden webviews can delay it. The benchmark and measurements live in
  [LIVE-PREVIEW-IMPLEMENTATION.md](../packages/vscode/docs/LIVE-PREVIEW-IMPLEMENTATION.md).
- **Packaging.** `runtime/*.scm` is explicitly allowed into the VSIX. The release
  test checks both files and asserts that the packaged preview actually used
  the warm engine, so a silent fallback cannot mask a missing resource.

---

## D26 — Playback position: the notes as they play

**Status:** accepted · **Refines:** D19, D24, D25 · **Supersedes** the
"no highlighting of the notes as they play" line of D24

- **Decision.** While the preview plays, the elements that sound are marked,
  a bar slides through the system at the pace of the music, the toolbar shows
  the bar number and the pane scrolls to the system being played. The map
  from the MIDI to the page comes from lilypond itself: `runtime/timing.ly`,
  passed to every preview compile as `-dinclude-settings`, is parsed before
  the score, and its top-level `\midi` block adds a Scheme performer to the
  `Score` context of every `\midi` block of the score.
- **The performer.** It listens to `rhythmic-event` on `ly:context-events-below`
  of the Score, so it hears every note, rest, skip and syllable of every voice.
  For each event with an input location it records the `textedit:` link that
  the SVG backend writes for the grob the event causes, spelled the same way
  (`grob-cause` in `output-svg.scm`: absolute path, `ly:string-percent-encode`,
  `CHAR`, `COLUMN + 1`), the moment of the performance as main and grace part
  in whole notes, and the written length (a syllable's is 0: it lasts to the
  next moment). At every time step where `currentBarNumber` changes it records
  the bar's start (`now − measurePosition`, so a pickup gives bar 1 a positive
  start and nothing before it). `finalize` writes `<output-name>.timing.json`
  into the output directory, which lilypond has changed to: a JSON array with
  one entry per `\midi` performance, in the order the `.midi` files are
  written. Everything is wrapped in `catch`; an error loses the map, never the
  compile. `ly:duration-length` is used where `ly:duration->moment` (2.25+) is
  missing.
- **Why a performer.** The `.midi` file is made from the performance's
  timeline, which differs from the layout's under `\unfoldRepeats`; a
  performer sees that timeline, and the origin links are the same on both
  sides. *Rejected:* an engraver writing moments into `output-attributes`
  (notation moments, wrong under `\unfoldRepeats`); matching MIDI notes to
  noteheads by order (chords, ties, rests and voices break it);
  `event-listener.ly` (no origins).
- **Host.** `CompileResult.timing` names the map when a preview compile with a
  runtime directory produced one; exports and the CLI (no runtime directory)
  get none. `orderOutputs` orders the MIDI files as lilypond wrote them
  (`<base>`, `-1`, `-2`, …), so entry *n* of the map is file *n*, and the
  snapshot's link rewrite (`SourceSnapshot.links`, D25) is applied to the map
  as to the pages. `PreviewPanel` reads the entry of the file it plays and
  posts `{ type: 'midi', data, timing }`; the message is re-sent when the map
  changes although the bytes did not (an edit that moved the notes' source
  positions), and `timing: null` without a map. The webview reports `timed`
  in `{ type: 'playback' }`: whether it found the map's notes on its pages.
- **Time.** `momentTime(midi, at, grace)` in `media/midi.js` converts a moment
  through the file's tempo map: lilypond writes a quarter as `division` ticks,
  so a whole is `division × 4`, and a grace note plays at 11/48 of its written
  length ahead of its note **[measured on 2.26 with 4th, 8th, 16th and 32nd
  graces at two tempi]**.
- **Webview.** The timeline is built on the first draw and dropped by every
  render; an element's box is cached per page node as fractions of the page,
  which survive zoom, so a reused page (D25) is not measured again. An href
  drawn as often as it is played (`\repeat unfold`, a variable used twice) is
  paired up in reading order (D118); drawn once, it is that place every time
  (a repeat unfolded in the MIDI only); anything else takes the place on the
  system playing then nearest the cursor (D120). A *moment* is the events
  that begin together: its x is the leftmost centre of their elements, its
  extent their union. A *system* ends
  where the next moment lies on another page or more than 1 % of the page
  width to the left; its band is the union of its moments plus a margin. The
  cursor interpolates between a moment and the next of the same system and
  waits at a system's last. Sounding events (begun, not ended; a prefix
  maximum of ends bounds the search) get the class `playing`; the `.playhead`
  div lives inside the page it is on (`.page` is `position: relative`) and is
  placed through the CSSOM. Colours: `--vscode-charts-orange`, `#d9480f` on
  paper. The bar label uses the bar starts, counting evenly through bars in
  which nothing began. The view is scrolled to the cursor (D19's reveal) when
  the system changes, on play and after a seek; never while the slider is
  dragged. Everything is cleared when stopped and kept when paused.
- **Not done.** No click-to-seek ("play from here"); no position in the
  standalone player (no pages); a user `-dinclude-settings` in `extraArgs`
  replaces ours and `-dno-point-and-click` leaves nothing to find, both
  silently without a playhead; cross-staff and polymetric scores were not
  surveyed.
- **Verified.** `test/compile/compiler.test.ts` compiles the sample score as
  a snapshot and checks every event's link is on a page and names the real
  file; `test/preview/panel.test.ts` covers the protocol and the pure
  functions; `test/commands.test.ts` sees `timed` from the real webview; a
  headless Chrome harness with the real scripts and the sample score (not
  kept) showed, at a seek to 2 s, *bar 2*, the playhead through the d2, its
  syllable and the bass note on page 1, and at 9 s *bar 5* on page 2 with the
  pane scrolled to it.

---

## D27 — The preview follows the focused score

**Status:** accepted · **Refines:** D4, D10, D17

- **Decision.** When a `.ly` file gets the focus, the open preview turns to
  its score in the same tab: title, pages, MIDI and cursor mark are replaced,
  and it compiles. With several editors open, the preview shows the file that
  has, or last had, the focus. `lily.preview.followEditor` (default `true`)
  turns it off.
- **Why.** Opening one preview per score and arranging the tabs by hand is
  what D4 set out to avoid; moving between the scores of a project is the
  common case, and one preview column is what the layout has room for.
- **What does not turn it.** An `.ily` or any other extension (a part is not a
  score, and D10 already finds its root); a file that a previewed root
  `\include`s, found with `rootsIncluding` without D25's conservative
  fallback, so a root with a computed include still lets the preview turn; a
  file that is not on disk; the preview itself getting the focus.
- **Several previews.** D4's one panel per root stays: a file that has a
  preview of its own keeps it. `PreviewManager` keeps its panels in the order
  they were last opened, revealed, retargeted or had their file focused; the
  last of them is the one that turns. The others stay where they are.
- **Retargeting.** `PreviewPanel.retarget()` changes `rootFile` and the title,
  drops everything of the old score and posts `{ type: 'clear' }` (the webview
  empties the pages and forgets the saved scroll place, but keeps the zoom)
  and an empty `midi`. A generation counter makes a run of the old root that
  ends afterwards show nothing; the host cancels that root's pending refresh
  and queued compile and releases its build directory, as when a panel
  closes. A webview hidden while it turned is sent `clear` again on `ready`,
  since its saved place belongs to the old score.
- **Verified** by `test/preview/panel.test.ts` (the manager's order, the late
  run, the hidden webview) and `test/preview.test.ts` (a real switch from
  `pages.ly` to `simple.ly` redraws one page in the same tab; `melody.ily`
  leaves it).

---

## D28 — Lily Studio: an Electron shell with a fixed layout

**Status:** proposed; the shell is replaced by D42 · **Refines:** D1, D12

- **Decision.** Lily Studio, an editor for LilyPond scores aimed at people who
  do not program, is a separate Electron application in `studio/`, with its
  own `package.json`, lock file and `node_modules`. It is not a fork or a
  build of VS Code, and it does not host the extension. It opens one window
  whose layout is fixed: a 240 px file list on the left, the editor and the
  preview sharing the rest in equal halves, a status line along the bottom.
  Panes cannot be moved, resized, hidden, split or tabbed.
- **Why not VS Code itself.** A stripped-down Code-OSS build or
  `vscode-web` brings the workbench (activity bar, panels, settings, the
  extension host) that the studio exists to leave out, and keeping a fork up to
  date costs more than the whole studio. What the studio needs from VS Code is
  the editor, which ships separately as Monaco, and the TextMate grammar, which
  `vscode-textmate` reads. Everything else is the extension's own code: the
  vscode-free modules under `src/compile/`, `src/diagnostics/parse.ts` and
  `src/preview/` (the rule of AGENTS.md is what makes them reusable here), and
  the webview scripts in `media/`.
- **Processes.** `src/main.ts` is the main process; later steps put file
  access, compiling and watching there. The renderer (`renderer/`) is
  sandboxed, with context isolation and no Node integration, and a CSP that
  allows only its own files; it reaches the main process only through
  `window.studio`, exposed by `src/preload.ts`, one named IPC channel per
  call. It never navigates or opens windows. A second launch focuses the
  existing window, and closing the window quits, on macOS too.
- **Build.** `studio/esbuild.mjs` bundles `src/main.ts` and `src/preload.ts`
  into `studio/dist/` as CommonJS with `electron` external; it may import from
  the extension's `src/` by relative path. `renderer/` is loaded as written
  until it needs a bundle. The root `tsconfig.json`, `.vscodeignore` and the
  extension's tests do not see `studio/`; root `npm run lint` does.
- **Verified.** `cd studio && npm install && npm test` builds and starts
  Electron 44 with `--smoke-test`: the window loads hidden, the three panes
  (`data-pane="files|editor|preview"`) are checked to be present, at least
  100 px each and left to right, `window.studio` exists, and the process exits
  0 or 1 with a JSON report. `npm run check-types` in `studio/` is clean.
  macOS only; not in CI yet.
- **Not done here.** Monaco, files, compiling, preview, PDF, watching, MIDI,
  live preview and packaging are the following steps.

---

## D29 — Lily Studio: Monaco, the file list and file access

**Status:** proposed · **Refines:** D28

- **Editor.** The editor pane is Monaco 0.57 (`monaco-editor/editor` with
  `features/register.all`, no bundled languages), created by
  `studio/src/renderer/editor.ts`. Each opened file keeps its own model under
  `Uri.file(path)` with language id `lilypond` (highlighted as in D30), so unsaved edits survive switching files. A file is unsaved while its
  model's alternative version id differs from the one last written; undoing
  back to the saved text clears the mark. The theme follows the system.
- **Renderer bundle.** `studio/esbuild.mjs` now also bundles
  `src/renderer/index.ts` into `dist/renderer/app.js` (a classic IIFE script,
  Monaco's CSS as `app.css`, the codicon font as a file) and Monaco's worker
  into `dist/renderer/editor.worker.js`, which `MonacoEnvironment.getWorker`
  starts from `file://`. The CSP gains `worker-src 'self'` and
  `style-src 'unsafe-inline'`, because Monaco inserts `<style>` elements;
  scripts stay `'self'` only.
- **File access.** Paths reach the main process only through `window.studio`
  (`studio/src/ipc.ts` names the channels). `studio/src/files.ts` holds an
  `Access` that allows the folder opened with a dialog and single files picked
  in one; every read and write is checked against it, so the renderer cannot
  name an arbitrary path. A file once read stays allowed, so a score left open
  in the editor can still be saved after another folder is opened. Only `.ly`, `.ily` and `.lyi` files are listed,
  read or written. The list descends at most four directories, skips hidden
  entries, `node_modules`, `out` and `dist`, and stops at 500 files. Files are
  written as UTF-8 exactly as the editor holds them.
- **New scores.** File › New Score… (and the New button) offers the templates
  of `studio/src/templates.ts` — Melody, Song with Lyrics, Piano — then a save
  dialog that proposes `Untitled.ly` (or `Untitled 2.ly` …) in the open folder.
  A score saved elsewhere makes its own folder the open one. Each template
  compiles with LilyPond 2.24 without warnings; a test checks that.
- **Unsaved changes.** Marked with `●` after the name in the file list and the
  editor header, and with the macOS close-button dot (`setDocumentEdited`).
  Closing the window with unsaved changes asks Save / Don't Save / Cancel;
  Save saves every unsaved file and closes only when all writes succeeded.
- **Menu.** The application menu has only File (New Score, Open Score, Open
  Folder, Save, Save All, Close), Edit (the standard roles, so copy, paste and
  undo reach Monaco) and Window. Menu items send a command to the renderer,
  which calls the same IPC as its buttons.
- **Verified.** In `studio/`: `npm run test:unit` (listing, access checks,
  tree rows, templates compiled with lilypond when installed) and
  `npm run test:smoke`, which opens a scratch folder in the hidden window,
  checks the file list, opens a score in Monaco, types into it, sees both
  unsaved marks, saves through the menu command and reads the file back.
  `npm test` runs both.

## D30 — Lily Studio: highlighting from the extension's grammar

**Status:** proposed · **Refines:** D2, D29

- **One grammar.** Lily Studio highlights with the extension's own
  `syntaxes/lilypond.tmLanguage.json` and takes comments, brackets,
  auto-closing, word pattern and indentation from `language-configuration.json`;
  neither is copied or rewritten for Monaco, so a grammar fix reaches both
  editors. `studio/src/renderer/grammar.ts` loads the grammar with
  vscode-textmate 9 and vscode-oniguruma 2 (Oniguruma as WebAssembly) and gives
  Monaco a `TokensProvider` whose state is the grammar's `StateStack`. A line
  that takes more than 500 ms stays partly uncoloured.
- **Scopes to Monaco tokens.** Monaco themes colour one token name per piece,
  not a scope stack, so each piece gets the theme key of its innermost scope
  that has a colour (`punctuation.*` and `meta.*` have none, so a string's
  quotes are coloured as the string). Inside a comment or string, `.comment` or
  `.string` is appended when the key does not already start with it: Monaco
  reads those words to skip brackets and auto-closing there, and the theme
  ignores the extra segment. A test checks that every scope the grammar names,
  other than punctuation and meta, has a colour.
- **Themes.** `lilypond-light` and `lilypond-dark` inherit Monaco's `vs` and
  `vs-dark` and colour the keys like VS Code's Light+ and Dark+, so a score
  looks as it does in the extension. The editor still follows the system.
- **Bundling.** esbuild inlines the grammar, the configuration and
  `onig.wasm` (the `binary` loader) into `app.js`; nothing is fetched at run
  time. `language-configuration.json` has comments, which esbuild's JSON loader
  rejects, so `studio/esbuild.mjs` loads it as a JavaScript expression. The CSP
  gains `'wasm-unsafe-eval'` in `script-src`, which permits compiling
  WebAssembly and not `eval`.
- **Verified.** `npm run test:unit` in `studio/` tokenizes lines with the same
  WebAssembly under node (notes, durations, rests, strings, a block comment and
  Scheme across lines) and checks the themes and the converted configuration;
  `npm run test:smoke` checks in the window that a brace, the version string
  and a duration are drawn in three different colours.

## D31 — Lily Studio: compile on save, markers and the status line

**Status:** proposed · **Refines:** D6, D10, D16, D28

- **When.** Writing a file through `saveFile` compiles, in the main process,
  after the write has succeeded; the save itself does not wait. Nothing
  compiles on open or while typing (live preview comes later). Save All
  compiles once per file saved; a newer compile of the same score kills the
  older one (`CompileService`), whose result is dropped.
- **Which score.** `studio/src/main/compileService.ts` (`StudioCompiler`, no
  `electron`): a `.ly` file is its own score. An `.ily`/`.lyi` belongs to the
  scores whose `\include` chains reach it (`rootsIncluding`, D18): the score
  compiled last first, then the open folder's `.ly` files in list order; the
  first match is compiled. When none reaches it, nothing runs and the status
  line says so. D10's “ask once” is left out.
- **How.** The extension's `CompileService` with its defaults, SVG output and
  point-and-click, `acceleration: 'off'` (the warm engines need the
  extension's `runtime/`); lilypond is found as in the extension, or through
  `$LILYPOND_PATH`. stderr goes through `parseStderr`. The kept pages live
  in the OS temp directory until the next compile of that score or quit
  (`dispose` on `will-quit`).
- **IPC.** Main → renderer on `studio:compile`: `{ kind: 'started', rootFile }`
  and `{ kind: 'finished', outcome }`, where `CompileOutcome` (`src/ipc.ts`)
  has `state` (`ok`, `failed`, `no-root`, `no-lilypond`, `error`), the parsed
  diagnostics, their counts, `pages`, `midi` and, when lilypond did not run
  or failed without a parsable error, a `message` (the last 12 lines of
  stderr in the second case).
- **Markers.** `studio/src/renderer/diagnostics.ts` keeps each score's last
  diagnostics by file, so a newer compile of one score replaces only its own,
  and turns them into Monaco markers (owner `lilypond`) over
  `diagnosticSpan`'s token, on the model's current text; a file opened later
  is marked when it opens. The column and span functions moved from
  `src/diagnostics/parse.ts` to `src/diagnostics/span.ts`, which imports no
  Node module, because the renderer bundle cannot resolve `node:path`;
  `parse.ts` re-exports them, so no caller changed.
- **Status line.** Messages stay on the left; the right side shows the last
  compile in words: “Engraving score.ly…”, “score.ly: engraved in 0.8 s”,
  “score.ly: engraved with 1 warning”, “score.ly: 2 errors” (red),
  “LilyPond is not installed”. Clicking it on errors or warnings opens the
  file of the first error (else warning) and puts the cursor there.
- **Verified.** `npm run test:unit` in `studio/`: root resolution, parsing,
  cancelled and failed starts against a stand-in `CompileService`, and one
  real compile of a score whose include has a misspelt command (skipped
  without lilypond); markers, the store and the status texts. `npm run
  test:smoke` saves in the window, waits for the status, types `\stacato` on a
  line of its own, saves, and sees the red status and an error squiggle.

## D32 — Lily Studio: the SVG preview and click-to-source

**Status:** proposed · **Refines:** D7, D17, D19, D31

- **What is shown.** The preview pane shows the SVG pages of the last finished
  compile, whichever score that was; another score starts at its top, the same
  score keeps its place (preview.js's page anchor). Pages of any run are shown,
  a failed one with a note that it may be incomplete; a run without pages
  keeps what is on screen and says why in the note or the empty pane
  (`previewUpdate` in `studio/src/renderer/preview.ts`). The pages are white
  paper in both themes, fitted to the pane's width; −, Fit and + in the pane
  header and Ctrl/Cmd + wheel zoom with preview.js's steps.
- **Shared with the extension.** The renderer bundles `media/preview.js` and
  uses its exported half: zoom steps, the scroll anchor, `quiet` and
  `sanitize` (moved into that half for this; the webview is unchanged) and
  `isSourceLink`. The styles are adapted from `media/preview.css` into
  `studio/renderer/layout.css` rather than loaded, because that file styles a
  whole webview (`body`, `#toolbar`) with `--vscode-*` colours.
- **Pages over IPC.** `StudioCompiler` reads the pages' text into the
  outcome's new `svg` field before it sends `finished`, as the extension's
  panel does, because the run's directory is emptied when the next compile of
  the score ends. The sandboxed renderer never reads the temp directory.
- **Click-to-source.** A click on an element with a `textedit:` link marks it
  and calls `studio.revealSource(href)` (`studio:reveal-source`). The main
  process parses it with `parseTextEdit` and passes the file through the
  `Access` check, so a link cannot name a file the studio may not open (a note
  from lilypond's own `ly/` files is refused, and the status line says why).
  The renderer opens the file and puts the cursor at `CHAR` with
  `charToCharacter`, on the editor's current text. The `CHAR` conversions moved
  from `src/preview/pointAndClick.ts` to the Node-free `span.ts`, which
  `pointAndClick.ts` re-exports. The other direction of D19 (the cursor
  highlights the notes) is not done.
- **Verified.** `npm run test:unit` in `studio/`: `previewUpdate`, `quiet`,
  the pages read into the outcome (and none when they are gone), and one real
  compile whose link to a note in an include after a tab and an astral
  character leads to that note (skipped without lilypond). `npm run
  test:smoke` waits for the page in the window, clicks the note `d` and sees
  the editor's cursor on its line.

## D33 — Lily Studio: the PDF tab and Export PDF

**Status:** proposed · **Refines:** D5, D31, D32

- **The switch.** The preview pane's header has an SVG/PDF switch. SVG is the
  pane of D32 and stays the default; PDF shows the same score (the one of the
  last finished compile) as the PDF lilypond writes, and has Export PDF in
  the header in place of the zoom buttons. The PDF is fitted to the pane's
  width and redrawn when the pane resizes; it has no zoom and no links, as a
  PDF made for handing on carries no point-and-click (D5's export flags).
- **A separate compile.** The PDF comes from its own run, `CompileService.export`
  with `format: 'pdf'` (`--pdf -dno-point-and-click`), into a private
  directory under the OS temp directory that is deleted once the bytes are
  read, so nothing is written next to the score. It is its own slot in
  `CompileService`, so it neither cancels nor is cancelled by the SVG compile.
  It runs only while the PDF tab is shown: a finished compile marks the PDF
  out of date, and showing the tab compiles it.
- **Main process.** `StudioCompiler.pdf(rootFile)` (`studio/src/main/compileService.ts`)
  keeps each score's PDF that engraved, or the run in flight, until the score
  compiles again; one with errors is shown, with a note, but not kept. The
  bytes go to the renderer as a `PdfOutcome` (`studio:compile-pdf`), one entry
  per book, named as lilypond names them; the root file passes the `Access`
  check first.
- **Export PDF.** `studio:export-pdf` writes the kept PDF, or compiles it
  first when the score changed since, into the score's directory, replacing a
  file of the same name, and the status line names the files. A PDF with
  errors is refused and nothing is written. This is the only way a PDF
  reaches the user's folder.
- **pdf.js.** `pdfjs-dist` 5 is bundled into `app.js` and its worker into
  `dist/renderer/pdf.worker.js` by `studio/esbuild.mjs`, loaded as a classic
  worker through `GlobalWorkerOptions.workerPort` (the CSP's `worker-src
  'self'` allows it). Documents are opened from the bytes, with `useWasm:
  false`, so nothing is fetched; LilyPond's PDFs embed their fonts. Pages are
  drawn on canvases at the device pixel ratio (`studio/src/renderer/pdfView.ts`).
- **Verified.** `npm run test:unit` in `studio/` (`test/pdfExport.test.ts`): the
  private directory is gone and the score's folder untouched after a PDF
  compile, the PDF is kept until the next compile, a PDF with errors is shown
  and not kept, a missing lilypond is reported, Export PDF writes next to the
  score without compiling again, compiles again after a change, refuses a
  score with errors, and one real compile and export (skipped without
  lilypond). `npm run test:smoke` switches to PDF, waits for a drawn canvas,
  checks no PDF was written, presses Export PDF and finds `smoke.pdf`.

## D34 — Lily Studio: reload and recompile on changes made on disk

**Status:** proposed · **Refines:** D10, D18, D29, D31

- **What is watched.** `ScoreWatcher` (`studio/src/main/watcher.ts`, no
  `electron`) watches every file the editor opened (each `studio:read-file`
  adds one) and the score compiled last: its `\include` graph and, for each
  include that was not found, every path lilypond would look for it at, so a
  missing part that appears joins the score. The graph comes from
  `includeGraph` in `src/compile/rootFile.ts`, which is `includeClosure` plus
  those `missing` paths. Each finished compile watches its score again, as an
  edit may have added or removed an include; another score replaces the
  previous one's files, but open files stay watched.
- **How.** One `fs.watch` per directory, not per file: a watch on a file ends
  when an editor saves by writing a temporary file and renaming it over the
  original. Events are debounced (150 ms) and a file counts as changed only
  when its text differs from what was last seen, so repeated events, a write
  of the same text and the studio's own saves (`writing` before the write)
  are not changes. A file that cannot be read is reported as gone.
- **Reload.** The main process sends the changes the renderer may open
  (`Access`) on `studio:files-changed`. An open file without unsaved edits is
  read again and replaces the editor's text as one undoable edit that counts
  as saved, and the view keeps its place. With unsaved edits it asks first
  (`studio:confirm-reload`, a native dialog: Reload or Keep My Changes, the
  default); keeping them leaves the file unsaved, and the next save replaces
  the other version. A deleted open file stays open with a note in the status
  line; saving writes it again.
- **Recompile.** When a changed file belongs to the watched score, the main
  process compiles that score from disk, as a save would; files outside it
  (an open score that is not the one shown) are only reloaded. The preview
  shows what is on disk, so unsaved edits that were kept are not in it.
- **Verified.** `npm run test:unit` in `studio/` (`test/watcher.test.ts`, on
  the real file system): a change to an open file under the path the editor
  used, no report for the studio's own save or a write of the same text, one
  report for a burst, an include of the score, two saves by rename, a missing
  include appearing and being deleted, a second score replacing the first
  while open files stay watched, nothing after dispose. `test/compile/rootFile.test.ts`
  covers `includeGraph`'s missing paths. `npm run test:smoke` writes the score
  from outside: the editor reloads it and it compiles again; with unsaved
  edits it asks, and the smoke test's answer keeps them.

## D35 — Lily Studio: MIDI playback and the notes as they play

**Status:** proposed · **Refines:** D24, D26, D32

- **What plays.** The MIDI of the last finished compile, the first file of the
  run as in the extension (D24), with the same rules: a run that did not
  happen keeps the music, another score replaces it, a failed run without
  MIDI keeps it, a good run without `\midi` clears it, and the same bytes
  again play on, remapped when only the map changed (`playbackChange` in
  `studio/src/renderer/player.ts`). A transport under both preview views,
  so it plays in the PDF tab too: ▶/❚❚, ■, a position slider, the bar and
  `0:03 / 0:08`. Without MIDI the buttons are disabled and ▶'s tooltip says
  which block to add. Space plays or pauses while the preview has the focus;
  in the editor it types a space.
- **Shared code.** The renderer bundles `media/midi.js` (parser, synthesizer,
  player) unchanged. The D26 timeline, which was inside the webview half of
  `media/preview.js`, moved into its pure half as `timelineOf(timing,
  duration, sourceLinks, box, time)`; the webview calls it as before. The
  studio ports only the webview's glue: element boxes cached per page as
  fractions, `playing` on what sounds, a `.playhead` inside the page, the
  bar label and scrolling the pane to a new system (never while the slider
  is dragged). Behind the PDF tab the pages have no size, so the timeline is
  built only once they are shown. `media/player.js` and `src/midi/player.ts`
  (the `.mid` viewer) have no studio counterpart: the studio does not open
  `.mid` files.
- **Main process.** `CompileService` gets a runtime directory, `dist/runtime/`,
  into which `studio/esbuild.mjs` copies `runtime/timing.ly`, so every
  compile writes the playback map (acceleration stays off; the other
  runtime files come with live preview). `StudioCompiler` reads the first
  MIDI file and its map entry (`readTiming`, now exported from
  `src/preview/panel.ts`) with the pages into `CompileOutcome.midiData` and
  `timing`, because the run's directory is emptied by the next compile. A
  map that cannot be read only loses the playhead.
- **Sound.** Electron allows audio without a user gesture, so D24's
  *Click ▶ to play* does not apply; a context that still does not start is
  reported in the status line.
- **Not done.** No click-to-seek, tempo, volume or choice among several
  `\midi` files, as in D26/D24. Colours are the paper colour of D26 in
  both themes, as the pages are paper.
- **Verified.** `npm run test:unit` in `studio/` (`test/player.test.ts`):
  `playbackChange`, `timelineOf` on made-up boxes, the MIDI and map read
  with the pages (and a broken map dropped), and a real compile whose MIDI
  parses to the four notes and 0:04, every map event's link is on the page
  and bar 2 is at 2 s (skipped without lilypond). `npm run test:smoke`
  plays a score with `\midi`, pauses a second in, finds a note marked,
  the playhead on its page and *bar 1*, and stop clears them.

## D36 — Lily Studio: live preview of unsaved edits

**Status:** proposed · **Refines:** D25, D31, D34, D35

- **What.** While the status line's switch is on (**Live preview: On**, the
  default, kept in the window's `localStorage`), the preview shows the
  editor's unsaved texts. D31's “nothing compiles while typing” no longer
  holds. Switching it off compiles the score shown last from disk, so the
  preview shows the saved files again. Switching it on compiles what the
  unsaved files belong to.
- **Texts.** On every edit the editor sends the file's text on
  `studio:edited`, or `null` once it matches the disk again (a save, an undo
  back to it, or a D34 reload). `LiveCompile` (`studio/src/main/liveCompile.ts`,
  no `electron`) keeps these texts. It keeps them while the switch is off too,
  so switching on needs no new edit. The main process takes only files that
  `Access` allows. The save handler does not clear a text: an edit made during
  the write would be lost. The renderer's message after the save clears it.
- **When.** D25's timing: a compile 150 ms after the last edit, and at most
  750 ms after the first edit of a burst. The edited files resolve to their
  scores with `rootFor`, as a save does (D31), with the unsaved texts. An
  include that no score reaches compiles nothing and is not reported. A save
  or reload drops what was waiting for that file.
- **How.** Every SVG compile of `StudioCompiler` goes through a `LiveQueue`
  (`src/preview/liveQueue.ts`): live, save and disk-change compiles alike. So
  there is one running and one replaceable waiting compile per score, and
  typing never kills a run that is about to finish. The texts are read when a
  compile starts (`buffers`) and passed to `CompileService`. The service
  writes them into a `SourceSnapshot` (`src/compile/snapshot.ts`), and never
  writes them next to the score. Links in the pages and the playback map
  already name the real files. Diagnostics are mapped back with
  `snapshot.diagnostic`, as `src/diagnostics/publish.ts` does.
- **Acceleration.** The studio's SVG compiles now use `acceleration: 'auto'`
  (`src/compile/accelerator.ts`). `esbuild.mjs` copies `runtime/worker.scm`
  and `glyph-cache.scm` next to `timing.ly`. D25's gate applies unchanged.
  With LilyPond 2.26.0 and the checked backend, a warm, forked worker
  compiles. Anything else falls back to ordinary spawning. The PDF tab and
  Export PDF still compile the saved files, without acceleration (D33).
- **Not done.** Markers from a live compile are placed on the text as it is
  when the compile arrives, not on the version that was compiled. D25's
  version check is left out. Edits arrive within 150–750 ms, so marks drift
  by at most the characters typed since. There is no Updating indicator
  beyond D31's “Engraving…”. The preview's page reuse (D25's hashes) is not
  ported: each result redraws its pages.
- **Verified.** `npm run test:unit` in `studio/` (`test/liveCompile.test.ts`)
  covers the following. A burst compiles once, with the last text. Typing
  without a pause compiles by the deadline. An include compiles its score,
  and an unreached include compiles nothing. A save drops the waiting
  compile. Off, on and off again behave as described above. The queue: a run
  in progress is not joined, the waiting request is replaced, and buffers and
  `auto` are passed. With real lilypond, an unsaved error in an include is
  reported in the real `.ily`. An unsaved note links to the real score. The
  disk is untouched. `npm run test:smoke` replaces the text without saving
  and sees 8 notes; switched off, the 4 on disk; on again, 8.

---

## D37 — Lily Studio: first run, plain words, and a macOS DMG

**Status:** proposed · **Refines:** D9, D28, D31

- **Welcome screen.** While no score is open, the editor pane shows
  `studio/src/renderer/welcome.ts`: Open the Sample Score, New Score…,
  Open Score…, Open Folder…, four first steps (write, see, listen, fix), and
  whether LilyPond is ready. Help › Welcome shows it again over an open
  score, with Back to the Score. The sample (`SAMPLE` in `templates.ts`, Ode
  to Joy with words, chords and `\midi`) is written to
  `~/Documents/Lily Studio/Ode to Joy.ly` with `wx`, so an edited copy is
  opened, never replaced.
- **LilyPond setup.** `studio/src/main/lilypondSetup.ts` (no `electron`)
  finds lilypond with `locateLilyPond` (D9), runs `--version` and says
  `ready`, `missing`, `too-old` (before 2.24.0, what the templates need) or
  `broken`, each with a sentence for a non-programmer. Every launch checks;
  when it is not ready, the setup dialog opens: download from lilypond.org,
  move the folder to Applications, Choose LilyPond… (a folder, its `bin`, the
  executable or an `.app`), Check Again, with Homebrew as a side note. A
  choice that is lilypond is kept in `userData/settings.json` and wins over
  `$LILYPOND_PATH`. The renderer can open only the two `SETUP_LINKS`. A
  compile that found no LilyPond is repeated once a check finds it. The main
  process adds Homebrew's and MacPorts' `bin` and lilypond's own directory to
  `PATH`, since an app opened from the Finder has `/usr/bin:/bin:…` only.
- **Plain words.** `studio/src/renderer/plainLanguage.ts` maps lilypond's
  common messages (unknown command, not a note name, text among notes,
  syntax errors, durations, missing includes, bar checks, slurs, ties,
  hairpins, `\version`, wrong argument types) to what went wrong and what to
  try. A marker leads with it and keeps “LilyPond says: …”. A banner above the
  preview names the first error (else warning), its line and file and the
  summary; a click shows it in the editor. Unknown messages are shown as
  lilypond wrote them. “LilyPond is not installed” in the banner or the
  status line opens the setup.
- **Package.** `studio/electron-builder.yml`: `npm run dist` bundles with
  `--production` and writes `release/Lily Studio-<version>-<arch>.dmg`, the
  host's architecture only. Only `package.json`, `dist/` and `renderer/` are
  packaged, without source maps. `dist/runtime/` is unpacked from the asar
  archive, as lilypond reads it; `main.ts` rewrites `app.asar` to
  `app.asar.unpacked` in that path. The app is ad-hoc signed (`identity: '-'`,
  no hardened runtime), so another Mac opens it with right-click › Open.
  Developer ID signing, notarization, an icon and a universal build are not
  done.
- **Verified.** `npm run test:unit` in `studio/` (`test/lilypondSetup.test.ts`,
  `test/plainLanguage.test.ts`): each setup state, the chosen folder, the
  version parse, PATH, the settings file, every rule against lilypond 2.26's
  text, the banner, and the sample engraving with no diagnostics and MIDI.
  `npm run test:smoke` sees the welcome screen with LilyPond found and the
  error explained in the banner. `npm run test:e2e` builds the DMG, mounts it,
  checks the Applications link, copies the app out, verifies its signature
  and the unpacked runtime, and runs the installed app's smoke test with the
  Finder's bare PATH.

---

## D38 — Lily Studio: Developer ID signing and notarization

**Status:** proposed · **Refines:** D37

- **Signing.** `npm run dist` in `studio/` signs with the Developer ID
  Application certificate of team KTSS95TY2K, named in
  `electron-builder.yml`. The hardened runtime is on, since Apple notarizes
  nothing else. `build/entitlements.mac.plist` allows V8's JIT and
  executable memory, for JavaScript and the grammar's WebAssembly. lilypond
  is a separate, separately signed process and needs no entitlement.
- **Notarization.** The app and the DMG around it are each uploaded to
  Apple and stapled. electron-builder does the app, `scripts/notarize-dmg.mjs`
  the DMG, which is signed for this (`dmg.sign`). Both read the
  `notarytool store-credentials` profile named in `APPLE_KEYCHAIN_PROFILE`
  (`lily-notary`, set by the script), so no Apple ID or password is in
  the repository or the environment. A downloaded DMG and the app from it
  open without a warning, offline too.
- **Bundle ID.** `io.github.velet5.lily-studio`, a name the author controls,
  in place of D37's `org.lilypond.lily-studio`. `userData` follows the
  product name and does not move.
- **Without the certificate.** `npm run dist:local` builds as D37 did:
  ad-hoc, no hardened runtime, not notarized.
- **Verified.** `npm run test:e2e` also checks the Developer ID authority,
  the hardened runtime, the stapled ticket (`stapler validate`) and
  `spctl --assess` reporting “Notarized Developer ID”. It skips these for a
  `dist:local` build. The installed app's smoke test passes with the
  hardened runtime on: compiles, the warm lilypond worker, PDF and playback.

---

## D39 — Lily Studio: the preview follows the editor

**Status:** proposed · **Refines:** D31, D32, D36

- **What.** Opening or switching to a file shows its score in the preview,
  without a save. D31 compiled only on save, and the preview showed whichever
  compile finished last, so a late compile of another score could take it
  over. Now the preview, the player, the PDF tab and D37's banner show only
  the compiles of the editor's score. The status line and the markers still
  take every compile.
- **How.** The renderer calls `studio:show-score` with the file. The main
  process resolves the score with `rootFor` (D31, so an include of the shown
  score keeps it) and answers with it. It then re-sends that score's last
  outcome, if it has one, and compiles the score anyway, with live
  preview's texts. An include may have changed on disk while another score
  was shown, and only the shown score is watched (D34). The main process
  keeps the last outcomes of 8 scores. A slower answer about a file the
  editor has already left is dropped.
- **Switching.** On a switch to another score, its pages and PDF replace the
  old ones at once when kept, else “Engraving…” until they arrive. The music
  stops. A file that no score includes shows a note saying so, and no pages.
- **Smoke test.** It now runs in a private `userData` directory. The
  single-instance lock belongs to that directory, so an open Lily Studio no
  longer ends the test at once with exit code 0 and no report. The user's
  settings are not read or written. The run may take 90 s.
- **Verified.** `npm run test:smoke`: `smoke.ly` shows its pages on opening,
  before any save. `second.ly` replaces them. `parts/melody.ily`, which no
  score includes, shows the note. Back to `smoke.ly`, its pages return as they
  were, unsaved text included. Not covered: D36's live check does not
  replace the whole text as it means to (select-all does not take in the
  editor). It passes on the notes of line 2, which are the same either way.

---

## D40 — Lily Studio: a resizable sidebar, and Claude Code and Codex in it

**Status:** proposed · **Refines:** D28, D34

- **Sidebar.** The left column is now a sidebar: the file list on top, the
  agents' accordion below it. Its right edge drags to set its width
  (180–640 px, always leaving 480 px to the editor and the preview), and the
  edge between the files and the accordion drags to share its height (the
  files keep at least 96 px, an open fold at least 140 px). Both edges are
  focusable separators that the arrow keys move by 16 px, or 64 px with Shift,
  and a double-click puts them back. The width, the height and the open fold
  are kept in the window's `localStorage`, like live preview's switch (D36). The
  editor and the preview are still fixed; D28's "cannot be resized" now
  holds only for them.
- **Accordion.** Two folds, *Agent chats* and *Agent setup*, one open at a
  time or none. With none open, only the two headers stay under the files.
- **Which agents.** Claude Code (`claude`) and Codex (`codex`), as the user
  installed and signed in to them. Lily Studio does not bundle them, log in
  for them, or hold keys. An app opened from the Finder has a bare PATH, so
  `src/main/agents.ts` asks the login shell for its PATH once (`$SHELL -ilc`,
  5 s), then adds the installers' usual directories. Codex from npm needs
  `node` from that PATH too. *Agent setup* shows each agent's path and
  version, lets the user choose the executable, and takes an optional model.
  Both are kept in `settings.json` under `agents`.
- **One process per turn.** Each message runs the agent headless in the open
  folder, and the session continues on the next message:
  `claude -p <prompt> --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools … [--resume <id>]`,
  or `codex exec [resume <id>] --json --skip-git-repo-check -c sandbox_mode="workspace-write" -c approval_policy="never" <prompt>`.
  `codex exec resume` takes neither `--sandbox` nor `--cd`, so the sandbox
  is given as config and the folder as the working directory. The JSONL is
  read into chat entries: what the agent said, one line per tool call ("Edited
  melody.ily", "Ran lilypond …"), and errors. The rest (thinking, reasoning,
  todo lists, token counts) is dropped. Stop ends the agent's process group.
- **Permissions.** No one is at a terminal to approve a tool while the agent
  works, so the limits are set beforehand. Claude Code accepts edits inside
  the folder, and may run only `lilypond` (by name and by the found path).
  Anything else is denied and shown in the chat as "Not allowed in Lily
  Studio: …". Codex runs in its own `workspace-write` sandbox: commands write
  only in the folder and the temp directory, without network. There is no
  switch for more access.
- **What the agent is told.** A chat's first turn starts with instructions:
  the user may not be a programmer, edit the files in place, check the score
  with the found LilyPond into the temp directory (never next to the sources),
  fix the first error first, and do not delete bar checks (AGENTS.md's loop).
  Every turn names the file in the editor and quotes the selected lines, when
  there are any (4 000 characters at most).
- **Unsaved edits.** A message saves every unsaved file first, and says so in
  the status line, so the agent edits what the editor shows. The agent's
  writes then come back through D34: open files reload, the shown score
  compiles again. After each turn the folder is listed again, so new files
  appear.
- **Chats.** Kept in `userData/chats.json`, 200 at most, per folder. An
  agent's session can be resumed only from the folder it ran in. The list
  shows the open folder's chats, newest first. A message with no chat open
  starts a new chat with the agent chosen above the list. An agent that is not
  set up keeps the message and says why in the chat. Deleting a chat asks
  first and does not delete the agent's own session files.
- **Code.** `src/main/agents.ts` (finding, arguments, prompt, parsing,
  running), `src/main/chats.ts` (the store) and `src/main/agentChats.ts` (a
  turn from message to entries) import neither `electron` nor the DOM.
  `src/renderer/sidebar.ts` and `src/renderer/agents.ts` are the UI. The IPC
  channels are `studio:agent-status`, `studio:choose-agent`,
  `studio:set-agent-model`, `studio:chat-list|get|send|stop|delete` and, from
  main to renderer, `studio:chat-event`.
- **Verified.** `npm run test:unit` in `studio/`: the arguments, prompt and
  JSONL parsing (lines captured from Claude Code 2.1.282 and Codex 0.157.0),
  detection, runs that end, crash or are stopped, a two-turn chat that
  resumes its session, the store, the settings and the sidebar's limits.
  `npm run test:smoke`: dragging the edge 80 px widens the sidebar by 80 px;
  a stand-in `claude` script is found in *Agent setup*, answers in *Agent
  chats*, writes `agent.ly`, which then appears in the file list, and resumes
  on the second message. By hand, outside the window: `AgentChats` with the
  real Claude Code and Codex, one turn each in a scratch folder ("make the
  last note a half note and add an a"). Each read, edited and compiled the
  score with the found LilyPond into the temp directory, with no denials and
  nothing written next to it. That check found that the output directory
  must exist before the turn: the studio creates it, since `mkdir` is denied.
  Resuming was checked with the CLIs directly. Not covered: the real agents
  inside the window, and the packaged app (`npm run test:e2e`).

---

## D41 — Lily Studio: the agent in the selection's context menu

**Status:** proposed · **Refines:** D40

- **What.** With text selected, the editor's context menu starts with three
  items (`SELECTION_ACTIONS` in `studio/src/renderer/agents.ts`):
  - *Ask Agent About Selection…* (⌥⌘I) opens *Agent chats* and puts the
    cursor in the message box.
  - *Explain Selection with Agent* sends "Explain what the selected lines
    do, in plain words … Do not change any files."
  - *Fix Selection with Agent* sends "Find and fix what is wrong in the
    selected lines, then check that the score compiles."

  Without a selection they are not in the menu. ⌥⌘I is not bound in Monaco,
  and the studio's menu has no developer tools on it.
- **Where it goes.** To the open chat, unless its agent is still working, in
  which case to a new chat with the agent chosen in the list. The selection
  goes as D40 sends it: the file, the line numbers and the text. A menu item
  leaves a draft in the message box as it is.
- **What goes along, shown.** A line above the message box says what goes
  with a message, "With lines 3–4 of melody.ily" or "With melody.ily". It
  follows the editor's selection and file.
- **Context menu styling.** Monaco drew its context menu in a shadow root,
  which `app.css` does not reach, so the menu had no background and its items
  lay over the code (Cut, Copy and Paste too, before this). The editor now has
  `useShadowDOM: false`.
- **Verified.** `npm run test:unit`: the label and the items.
  `npm run test:smoke`: ⌘A in the editor shows "With lines 1–5 of smoke.ly";
  a right-click lists the three items; *Explain Selection with Agent* sends
  its prompt in the open chat, and the stand-in agent receives the selection.
  A screenshot of the menu shows it opaque. Monaco's menu takes a mouse-up
  only a moment after it opens, so the test waits 500 ms before clicking.

---

## D42 — Lily Studio: Tauri, with the main process in Rust

**Status:** proposed · **Replaces:** the Electron shell of D28 · **Refines:** D29–D41

- **Decision.** Lily Studio is a Tauri 2 app. Electron, electron-builder and
  the preload script are gone; the page (`renderer/`, `src/renderer/`) is the
  same page, in the system's WebKit instead of Chromium. Everything the
  Electron main process did is Rust, in a Cargo workspace in `studio/`:
  - `crates/engrave` (`lily-engrave`): compiling, the warm worker and glyph
    cache, the include graph, unsaved snapshots, lilypond's stderr, live
    preview, the watch on the files, file access, the LilyPond setup, the
    settings and the templates.
  - `crates/agents` (`lily-agents`): Claude Code and Codex, and the chats.
  - `src-tauri` (`lily-studio`): the window, the menu, AppKit's dialogs, and
    one command per call of the page.
  The two crates do not depend on Tauri, as the TS modules did not import
  `electron`; `cargo test` runs them.
- **The cost.** The studio no longer shares the extension's compiler, parser
  and include graph (`src/compile/`, `src/diagnostics/parse.ts`); it has a
  Rust port of them. A change to one must be made in the other. The renderer
  still shares `span.ts`, `media/preview.js`, `media/midi.js`, the grammar and
  the language configuration.
- **Why.** An app of 13.6 MB instead of about 250 (a 9.7 MB DMG), and one
  process fewer.
- **The bridge.** `src/renderer/bridge.ts` gives the page the `studio` object
  it had, over `invoke`. What the Rust side starts itself (menu commands,
  compiles, changes on disk, chat entries) comes on one `Channel`. MIDI and
  PDF bytes travel as base64. A command's error rejects with its message.
  `edited`, `set_live` and `set_dirty` are synchronous commands: Tauri runs
  those in order on the main thread, whereas async commands may overtake each
  other, and a burst of typing then left live preview with an older text.
- **No PATH of the process.** The Electron studio widened `process.env.PATH`
  for lilypond's helpers. `lily-engrave`'s `SearchPath` is one shared value
  that every lilypond it starts gets as its `PATH`; the process's own is not
  changed. Agents get the login shell's PATH on top of it (D40).
- **Live preview's texts.** `LiveTexts` holds the unsaved texts. It is made
  first and handed to both the compiler, which reads it, and `LiveCompile`,
  which fills it and asks the compiler to compile.
- **Dialogs.** Straight from AppKit (`objc2-app-kit`): one panel that takes
  the LilyPond folder, the `.app` or the program, messages above the list,
  hidden files for the agents' programs, the unsaved-changes dot in the close
  button. The alerts keep their answers: Save is the default on closing, Keep
  My Changes when a file changed on disk.
- **Files.** Settings and chats stay in `~/Library/Application Support/Lily
  Studio/`, where Electron kept them, so they carry over. The Content Security
  Policy moved from the page to `tauri.conf.json`, with `style-src` left as it
  is for Monaco's `<style>` elements. `runtime/` is a bundle resource,
  `Contents/Resources/runtime/`.
- **Package.** `tauri build` makes and signs the `.app` with the hardened
  runtime; `scripts/dmg.mjs` notarizes and staples it, then makes, signs,
  notarizes and staples the DMG (Tauri's DMG step builds the app again and
  would drop its ticket). The DMG has the app and a link to Applications,
  without positioned icons. The V8 entitlements of D38 are gone: WebKit's JIT
  runs in the system's own process. The icon is a placeholder
  (`build/icon.svg`) until the studio has its own. macOS 14 or later.
- **Smoke test.** `lily-studio --smoke-test` opens the window hidden and loads
  `src/renderer/smoke.ts` into it, which drives the page as smokeTest.ts did
  from outside and reports through `smoke_*` commands that answer only in that
  mode. It types through `document.execCommand('insertText')` and sends ⌘A as
  a key event to Monaco's input. WebKit runs no animation frames in a hidden
  window, and Monaco, pdf.js and the playhead draw in them, so the smoke
  window gets a timer in their place; background throttling is off for it.
  The window is never shown: a test must not take over the screen.
- **Verified.** `cargo test --workspace`: 181 tests (the TS tests of the
  removed modules, ported, and more), with lilypond 2.26.0 and the warm
  worker. `npm run test:unit`'s node tests, 37, for the renderer; the ones that
  need a real outcome get it from `lily-outcome`, a binary of `lily-engrave`.
  `npm run test:smoke` passes every step of D28–D41's smoke test.
  `cargo clippy -D warnings`, `cargo fmt`, `tsc` and the repository's lint are
  clean. The e2e test with a `dist:local` DMG: it mounts, the installed app's
  signature verifies, its runtime files are there, and it passes the smoke
  test with the Finder's bare PATH. Tauri refuses to start from a path that
  goes through a symlink, so the test installs into the real path of the temp
  directory (`/var` is a link to `/private/var`). Not run: `npm run dist`,
  which notarizes with Apple.

---

## D43 — Lily Studio: permission mode and model under the message box

**Status:** proposed · **Refines:** D40

- **What.** Under the message box, left of Send, two menus: what the agent may
  do, and its model. Both apply from the next message on, in a new chat or
  the open one.
- **Permission mode.** D40 had one fixed set of limits and "no switch for
  more access"; there are now three, sent with each message
  (`ChatMessage.permission`, `edit` when missing or unknown):
  - *Read only*: Claude Code with `--permission-mode default` and only
    `Read Glob Grep LS TodoWrite` allowed, so edits and commands are denied;
    Codex in its `read-only` sandbox. The turn's prompt says it is read-only,
    so the agent does not try.
  - *Edit files*: D40's limits, unchanged, and the default.
  - *Full access*: Claude Code with `--permission-mode bypassPermissions`,
    Codex with `sandbox_mode="danger-full-access"`. Nothing is asked or
    limited; the menu turns the warning colour and its tooltip says so.

  The choice is kept in the window's `localStorage`
  (`lily-studio.permission`), like the agent of a new chat. It is not kept
  per chat: it is about the next message, not about the chat.
- **Model.** The menu offers the agent's default, the usual models (Claude
  Code's aliases `opus`, `sonnet`, `haiku`; Codex's `gpt-5-codex`, `gpt-5`)
  and, when the setup's Model field holds another, that one. It is the same
  setting as that field (`settings.json`, D40), for the open chat's agent or
  the one chosen for a new chat; changing either updates the other.
- **Verified.** `cargo test -p lily-agents`: each mode's arguments for both
  agents, the read-only line of the prompt, and a message's permission read
  from the renderer. `npm run test:unit`: the modes and the model choices.
  `npm run test:smoke`: every agent step passes with the menus in place (the
  sidebar-drag step fails on `main` too). Not covered: the real agents in
  each mode.

---

## D44 — Lily Studio: Add MIDI

**Status:** proposed · **Refines:** D35

- **What.** While the score shown has no MIDI, the transport under the preview
  shows **Add MIDI** beside its disabled ▶. It appears only after a compile of
  that score came back without MIDI, never before the first, and not when the
  MIDI could not be read. ▶'s tooltip points to it.
- **Where the block goes** (`addMidiBlock` in `studio/src/renderer/midiBlock.ts`,
  pure, found without compiling). Every `\score` without a `\midi` of its own
  (at the score's top level, not inside its music or in a `\markup \score`)
  gets `\midi { }`: on its own line after the score's last `\layout { … }`,
  indented as that line is; before the closing `}`, together with
  `\layout { }`, when there is no `\layout`, because a score with only `\midi`
  is no longer engraved; on the same line when the score is on one line.
  Music outside any `\score` is engraved but not played, and **[verified]** a
  top-level `\midi { }` does not change that on 2.26, so each top-level music
  expression is wrapped in `\score { … \layout { } \midi { } }`, indented two
  spaces. A tokenizer that knows comments, strings, Scheme and `#{ #}` finds
  the blocks; it does not parse music. Top-level assignments, `\version`,
  `\header`, `\paper`, `\markup` and the like are not music. A file with
  neither `\score` nor music (its score is in an `\include`) is told where the
  block goes instead; a score that has `\midi` already is told so.
- **How.** The root file is opened in the editor and changed there as one
  undoable edit, with the cursor on the new `\midi`. With live preview on, the
  live compile picks it up; off, the file is saved, which compiles it. The
  music does not start by itself: the click that added the block is spent
  before the compile ends, and ▶ is next to it.
- **Verified.** `studio/test/midiBlock.test.ts`: the placements, comments and
  strings, several scores, top-level music and assignments, CRLF, and two
  results compiled by lilypond with MIDI and pages. `npm run test:smoke`: Add
  MIDI shows for the unsaved `{ c4 … }`, a click wraps it, and the live
  compile's MIDI enables ▶ (the sidebar-drag step fails on `main` too).
- **Not done.** The extension's preview only names the block to add. A
  `\score` in an `\include`d file is not looked for.

## D45 — Lily Studio: parts, mutes and a start bar for playback

**Status:** proposed · **Refines:** D35, D26

- **What.** **Parts** at the right of the transport opens a fold above it.
  It has one row per part. A part is a MIDI track with notes, which lilypond
  writes one per staff; the tracks have no names, so the rows say "Part N"
  and the instrument the score gives them. Each row has **On/Muted** and an
  instrument: *As written* or a General MIDI program from a short list by
  family (piano, harpsichord, organ, mallets, strings, guitars, woodwinds,
  brass, choir, synths). A drum kit keeps its kit and can only be muted.
  Below the parts is **Start at bar**, and **Play as written** clears
  everything.
- **Start bar.** Right-click a bar in the SVG preview to get *Play from bar
  N*, *Start playback at bar N* and, when a mark is set, *Start from the
  beginning*. The bar is found from the moment on the system under the
  pointer that is at or left of it (`momentAt`), and the mark then snaps to
  that bar's start. A green flag marks it on the pages, and `from bar N ✕` in
  the transport clears it. ▶ from stopped starts there, so Stop and the end
  of the music go back to it. A bar that is played twice starts where it is
  first played. A bar that no longer exists is shown struck through and is
  ignored.
- **How it plays.** `mixMidi` (`studio/src/renderer/playbackSetup.ts`, pure)
  leaves out the muted parts' notes and gives the others the chosen program.
  The player loads the result, and a change during playback reloads it and
  seeks back to where it was. `media/midi.js`, which the extension shares, is
  unchanged.
- **Kept.** Each score's setup is saved in `playback.json` in the studio's
  data folder, beside `settings.json`, keyed by the root file's path (only as
  a key; nothing is read from it). It holds parts by track index and the
  start bar, and is read when the score's music is next loaded. The Rust side
  keeps only that shape and the 200 setups changed most recently. Nothing is
  written next to the score.
- **Verified.** `studio/test/playbackSetup.test.ts` (with a real compile's
  MIDI and bar map) and `playback.rs`'s tests. `npm run test:smoke`: the fold
  lists the part, mutes it and sets a flute. A right-click on the last note
  offers bar 2, and ▶ then starts at 0:04. The setup is read back from the
  Rust side, and *Play as written* forgets it.
- **Not done.** Parts are keyed by track index, so adding or removing a staff
  above a part moves its setting to another part. Muted parts' notes are
  still marked on the pages as they pass. There is no solo or setting a mark
  by clicking on the PDF. Per-part volume came with D121.

## D46 — Lily Studio: images pasted into the agent chats

**Status:** proposed · **Refines:** D40

- **What.** An image pasted into the chat's message box (⌘V), or dropped on
  it, shows as a thumbnail above the box with ✕ to remove it. It goes with the
  next message, and a message may be only images. A paste with an image takes
  the image and leaves out the text that comes with it, such as the address a
  browser copies. PNG, JPEG, GIF and WebP up to 10 MB each, six per message;
  the renderer says why it refuses anything else, and the Rust side checks
  again.
- **Kept.** The Rust side saves the images as `chat-images/<chat id>/<uuid>.<ext>`
  beside chats.json, so they outlive the turn, and the user's entry keeps
  their paths (`images`). The chat shows them through `chat_image`, which
  reads only files under `chat-images/`. Deleting the chat deletes them. A
  new chat of only images is titled "Image".
- **To the agents.** The prompt lists the files in `<attachments>`. Codex also
  attaches each with `--image`, which takes several values, so a `--` ends the
  options before the session and the prompt. Claude Code gets `--add-dir`
  for the images' directory, so that its Read tool may open them under every
  permission (D43).
- **Verified.** `crates/agents/tests/agents.rs`: the arguments for both
  agents, the prompt, and a send through a stand-in (saved, shown, refused
  types and counts, deleted with the chat). `test/agents.test.ts`:
  `imageRefusal`. `npm run test:smoke`: a PNG pasted through a
  `ClipboardEvent` shows above the box, is sent, shows in the chat, and the
  stand-in receives `--add-dir`. By hand, with a red PNG: Claude Code
  (`-p … --add-dir`, read-only tools) and Codex (`exec --image … --`) both
  answer "Red".
- **Not done.** Images are not scaled down before they are sent. A file
  dropped from the Finder that is not an image is ignored without a word.

## D47 — Lily Studio: text size of the agent chats

**Status:** proposed · **Refines:** D40

- **What.** A− and A+ at the right end of the chat toolbar, in the list and in
  an open chat, set the chat's text size: 11, 12, 13, 14, 15, 16, 18, 20 or
  22 px, each button greyed out at its end. ⌘+ (or ⌘=), ⌘− and ⌘0 do the same
  while the focus is in the chats fold; ⌘0 goes back to the default. The app
  menu has no accelerator on these keys, and the webview's own zoom keys are
  off. The default went from 12 to 13 px, the size of the rest of the window.
- **Kept.** In the window's `localStorage` (`lily-studio.chatFontSize`), like
  `lily-studio.permission`. A missing value or one that is not a number gives
  the default; one out of range is brought within the steps. The renderer sets
  `--chat-font-size` on the fold's body: messages, notes, the list and the
  message box use it, and the secondary text (tool lines, "is working", the
  context line, the menus under the box, Send) 1 px less. The toolbar stays at
  12 px so the buttons do not move under the pointer.
- **Verified.** `test/agents.test.ts`: `stepChatFont` and `chatFontSize`.
- **Not done.** No reset button; ⌘0 is the reset. Not checked by hand in the
  running app.

## D48 — Lily Studio: parts named after their staves

**Status:** proposed · **Refines:** D45, D26

- **What.** The Parts fold names each part instead of "Part N": "S.A",
  "Tenor", "Piano · G clef", "Piano · F clef", "Violin one", "Flute". The
  tooltip still says "Part N, written for …".
- **Where from.** A MIDI track says little: lilypond names it
  `<staff id>:<first voice id>` and nothing more. `runtime/timing.ly` now also
  has a performer in each MIDI `Staff` and `Voice` and writes `staves` into the
  playback map: per staff its id, `instrumentName` and `shortInstrumentName`
  as plain text (at its first note), the group it is in (`PianoStaff`,
  `ChoirStaff`, … and which one), its clef at its first note and the ids of
  the voices that played. **[verified]** on 2.26: the tracks after the first
  follow the staves in the order lilypond makes them, whenever each starts to
  sound, and a staff with only rests still has a track; `\clef` is set in the
  MIDI Staff, whose own `instrumentName` default is "bright acoustic", which
  is taken for none. The map is used only when it has one staff per track.
- **Naming** (`partNames` in `studio/src/renderer/playbackSetup.ts`, pure), in
  order: the instrument name the score gives; the choir voices its voices, or
  else the staff, are named after (`sopranos`, `altoTwo`, `T`), abbreviated
  and joined by a dot when several; in a PianoStaff or GrandStaff, the
  instrument and the clef; an id of the staff or of its only voice that is
  more than a number or `up`/`down`/`rh`…; in a ChoirStaff, a guess from the
  clef and the voices ("S.A" and "T.B" for two voices, Soprano/Alto/Tenor/Bass
  for one); otherwise the instrument, with the clef when another part has it
  too. Names still alike get a number. Without the map, the track's name gives
  the ids and the pitches the clef.
- **Verified.** `studio/test/playbackSetup.test.ts`: each rule, the fallback
  without a map, and a real compile of a choir, a piano and a flute. The
  extension's unit tests pass with the new `timing.ly`.
- **Not done.** DrumStaff, TabStaff and RhythmicStaff have no staff performer,
  so a score with them is named from the tracks alone. The name is the one at
  the staff's first note.

## D49 — Lily Studio: recent folders and scores

**Status:** proposed · **Refines:** D37, D29

- **What.** The welcome screen lists the folders and scores opened last,
  under Recent: the name, the directory it is in (home as `~`), and an outline
  of a folder or a page. A click opens it as Open Folder or Open Score would;
  ✕, shown on hover, takes one off the list; Clear empties it. File › Open
  Recent has the same entries, a name alone unless two share it, and Clear
  Menu.
- **Kept.** `recent.json` beside settings.json (`studio/src-tauri/src/recent.rs`):
  ten entries, newest first, each path once, with its kind and when it was
  opened. Every open ends in `open_folder_at` (a dialog, New Score, the
  sample, the list itself), which adds the chosen score, or else the folder.
  A broken file loads what it can.
- **Gone entries** stay, dimmed and marked Not found, since a disk that is not
  connected comes back. Opening one is refused with where it was, above the
  list or, from the menu, in the status line. `open_recent` opens only paths
  on the list.
- **Verified.** `recent.rs` and `menu.rs` tests; `test/welcome.test.ts`:
  `recentLabel`. `npm run test:smoke` passes its steps with the list in place.
- **Not done.** No smoke step for the list itself, and not checked by hand.
  macOS's own recent documents and the Dock menu are not used.

## D50 — Lily Studio: the agents' check directory

**Status:** proposed · **Refines:** D40, D43

- **Why.** Under *Edit files*, Claude Code tended to check a score with
  `cd <check dir> 2>/dev/null || mkdir -p <check dir> && lilypond …`, which
  was denied and shown as "Not allowed in Lily Studio".
- **What.** The first turn's instructions say the check directory exists
  already (the studio makes it before each turn) and that the lilypond
  command is to be run on its own, without `cd`, `mkdir`, `&&`, `||`, pipes or
  redirections. Claude Code under *Edit files* also gets `--add-dir` for that
  directory and `Bash(mkdir -p <check dir>:*)`.
- **[verified]** with Claude Code: `cd X`, `mkdir -p X` and `mkdir -p X &&
  lilypond …` are allowed with these arguments, but `cd X || …` is denied
  whatever is allowed, `Bash(cd:*)` included, so only the instruction helps
  there. With the new instructions, Sonnet ran the check alone and nothing
  was denied.
- **Smoke test.** The stand-in agent says "with an image" only for an
  `--add-dir` of `chat-images`, since every edit turn now has one.

## D51 — Playback position: what is heard, not what is rendered

**Status:** accepted · **Refines:** D24, D26, D35, D45

- **Symptom.** During playback the marked notes and the playhead ran ahead of
  the sound, by a constant amount that depends on the output device.
- **Cause [measured].** `Player.position` was the audio clock,
  `context.currentTime`, which is when a sample is rendered; it is heard
  `outputLatency + baseLatency` later. In Lily Studio's WKWebView on macOS
  with Bluetooth headphones as the output, `outputLatency` is 0.160 s and
  `baseLatency` 0.0027 s, so everything the position drives (marks,
  playhead, bar, time, slider) was 163 ms early. `getOutputTimestamp()` does
  not help there: its `contextTime` trails `currentTime` by one render
  quantum only. The map is not at fault: for scores with `\tempo` changes,
  a fermata, grace notes (`\acciaccatura`, `\appoggiatura`, `\grace`),
  tuplets and `\unfoldRepeats` in two staves, every event's `momentTime` was
  within 0.01 ms of a note-on in the MIDI, so there is no drift with time or
  tempo.
- **Decision.** `media/midi.js`'s `Player` has three clocks: `scheduled`, the
  music on the audio clock, which notes are scheduled against (unchanged);
  `latency`, `outputLatency + baseLatency`, read every time because the
  device can change, and 0 where the browser does not report it; and
  `position`, `scheduled − latency`, held at the start of playback until the
  first sample is heard and at most the duration. Everything shown uses
  `position`, so the extension's preview, its `.mid` player and the studio
  are fixed together. A pause and the studio's remix (D45) go on from
  `scheduled`: what was rendered up to there is still heard after the stop,
  so going on from `position` would play the last `latency` twice. Playback
  stops when the end is heard, not when it is rendered, so the last notes
  keep their marks.
- **Rejected.** A user setting for the offset (the browser knows the device's
  latency and a setting would be wrong after switching to the speakers);
  `getOutputTimestamp()` (see above).
- **Verified.** `test/midi/midi.test.ts`: with `outputLatency` 0.16 the
  schedule is unchanged, the position waits at the start and then trails the
  clock by the latency, a pause keeps the clock position, playback ends only
  once the end is heard, and an unreported latency counts as 0.

## D52 — Lily Studio: the agent asks, the user allows or denies

**Status:** proposed · **Refines:** D40, D43, D50

- **Why.** Under *Edit files*, a command outside D40's limits (`magick` on a
  PDF, `python3 -c …`, a file in `~/Downloads`) was denied without asking
  and reported only at the end of the turn as "Not allowed in Lily Studio".
  The user's only way on was *Full access*.
- **What.** Claude Code under *Edit files* asks the user instead. The chat
  shows the question with the whole command or path, the agent's own words
  for it, and *Allow*, *Allow for This Chat* (when Claude Code suggested a
  rule or directory for it; the tooltip names them) and *Deny*. The turn
  waits for the answer; Stop still ends it. The answer is kept in the chat
  as an entry ("Allowed: Ran magick …", "Denied: …"). A chat waiting for an
  answer says so in the list and under its log.
- **How.** Claude Code runs with `--input-format stream-json
  --permission-prompt-tool stdio`: the prompt is a user message on stdin,
  and what the limits do not allow comes on stdout as a `control_request`
  of subtype `can_use_tool`. The answer is a `control_response` on stdin:
  `allow` with the input unchanged, or `deny` with a message the agent reads.
  Any other control request is answered with an error, so that nothing
  waits forever. Stdin is closed at the turn's `result`, which ends the
  process. Denials the user answered are not repeated as "Not allowed".
- **Allow for This Chat.** Claude Code's `permission_suggestions` go back
  with the answer as `updatedPermissions`, destination `session`, so the
  running turn does not ask again. The rules and directories are kept in
  the chat (`allowedTools`, `allowedDirs` in chats.json) and later *Edit
  files* turns of the chat get them as `--allowedTools` and `--add-dir`.
  Claude Code decides how wide a suggestion is: a prefix (`magick:*`) or
  the exact command.
- **Not changed.** *Read only* still denies without asking: it promises
  that nothing changes. *Full access* asks nothing. Codex cannot ask:
  `codex exec` has no approval channel, so it keeps its sandbox (D40).
- **[verified]** with Claude Code 2.1.283: without
  `--permission-prompt-tool stdio` a command is denied without a request;
  with `-p <prompt>` as an argument and stream-json input, the prompt is
  not read and the process waits. Allow, deny and `updatedPermissions`
  with destination `session` were accepted, and the answers took effect.
- **Tests.** `cargo test -p lily-agents`: the arguments, the parsed
  request, the three answers, and a two-turn chat with a stand-in that
  waits on stdin: the question is listed while pending, "always" is kept
  and given to the next turn, an answered denial is not repeated, and stdin
  closes at the result. `npm run test:smoke`: the stand-in asks to run
  `magick`, the card shows the command, Allow lets it go on.

---

## D53 — One repository, three packages

**Status:** proposed · **Refines:** D28, D42

- **Decision.** The repository is an npm workspace of three packages:
  `packages/common` (`@lily/common`, private), `packages/vscode` (`lily`, the
  extension; its name, publisher and ID are unchanged) and `packages/studio`
  (`lily-studio`). One `package-lock.json` at the root; `docs/DECISIONS.md`,
  `AGENTS.md`, the lint configuration, `tsconfig.base.json` and CI stay at the
  root. The files were moved with `git mv`, so `git log --follow` finds their
  history.
- **Why.** The studio reached into the extension with paths like
  `../../../src/diagnostics/span`, and nothing said which of the extension's
  files the studio depended on. Deleting the repository and starting two was
  considered; the code they share would then have had to be copied or
  published.
- **What is common.** Only what both apps use: `src/span.ts`; `src/types.ts`
  (`LyDiagnostic`, `SourceLocation`, the playback map, formerly in
  `diagnostics/parse.ts`, `preview/pointAndClick.ts` and `preview/panel.ts`,
  which re-export what the extension imports from them); `src/textedit.ts`
  (`parseTextEdit`, which Lily Studio's tests use); `web/preview.js` and
  `web/midi.js`, with the `.d.ts` files that were the studio's
  `previewScript.d.ts`; the grammar and its snapshot tests, the language
  configuration and `runtime/`. The rest of `media/`, the snippets, the
  completion data, the compiler and `lily-check` stay with the extension.
- **Imports.** `@lily/common/span`, `/types`, `/textedit`, `/web/*`,
  `/syntaxes/*`, `/language-configuration.json`, `/runtime/*`, through the
  package's `exports`, which point at the sources: there is no build step, and
  esbuild bundles them as it did. `span.ts` and `types.ts` import neither
  `vscode` nor Node.
- **The VSIX.** `vsce` packages only `packages/vscode`, so the extension's
  `esbuild.mjs` copies the common files into `dist/`: `dist/web/`,
  `dist/runtime/`, `dist/syntaxes/` and `dist/language-configuration.json`
  (again on change under `--watch`). `contributes`, `extension.ts` and
  `.vscodeignore` name the new places. The webviews' `localResourceRoots` are
  `media/` and `dist/web/` (`assets.roots`). The VSIX no longer carries
  `docs/DECISIONS.md`; the shipped live-preview notes link to it on GitHub.
- **The studio.** Its `esbuild.mjs` copies `runtime/` from `packages/common`.
  The Rust tests compile the extension's test scores
  (`packages/vscode/test/fixtures`, `test/e2e/workspace/score.ly`) and use
  `packages/common/runtime`. The Cargo workspace stays in `packages/studio`.
- **AGENTS.md.** The compile-and-fix loop is `packages/vscode/AGENTS.md`,
  still in the VSIX; the root `AGENTS.md` is about working on the repository.
- **CI.** Types and lint cover all three packages; grammar, unit, host and
  release tests are the extension's, as before. The studio is not built in CI.
- **Verified.** `npm run check-types`, `npm run lint` and `npm run
  test:grammar` at the root. In `packages/vscode`: 253 unit tests, and
  `npm run test:e2e` (7 tests) on a VSIX whose file list differs from the old
  one only by the moved paths and `docs/DECISIONS.md`. The extension-host
  suite timed out in 13–14 webview tests in a full run on this machine, as it
  did on `main` before the move; each of those suites passes on its own. In
  `packages/studio`: 202 Rust and 68 renderer tests, `cargo fmt` and `clippy`.
  Its smoke test passes every step but one, "dragging the sidebar's edge by 80
  px changed its width from 640 to 640", which fails the same way on `main`
  before the move. A fresh checkout needs `node esbuild.mjs` in the studio
  before `cargo test`, which wants `dist/runtime`; that was so before as well.

## D54 — Lily Studio: Export MIDI, without the muted parts if wanted

**Status:** proposed · **Refines:** D45, D35 · **Refined by:** D136 (the Parts fold's instruments written; the web's engine's music waited for)

- **What.** *File › Export MIDI…* and **Export MIDI…** at the foot of the
  Parts fold save the music the transport plays: the bytes of the last
  compile's first MIDI file, with live preview's unsaved edits if it made
  them. A save panel asks where. It opens on the score's folder with the
  score's name and `.mid`, and asks before it replaces a file. Export PDF
  writes next to the score without asking (D33). A MIDI file is more often
  made in versions, with and without parts, so the user names it here.
- **Muted parts.** While the Parts fold mutes some parts, the save panel has
  a checkbox, checked at first: *Leave out the muted part Tenor*, or *the
  muted parts S.A and Bass*, or *the 4 muted parts* when there are more than
  three. Checked, the muted parts' tracks are left out of the file. Unchecked,
  the file is lilypond's. When every part is muted there is no checkbox: a
  file of only the control track would be silent. The status line says
  *Exported ode.mid, without the 2 muted parts*.
- **How.** The renderer sends the bytes (base64), the root file (checked like
  any path) and the muted parts' tracks and names (`mutedParts`, in
  `playbackSetup.ts`). `src-tauri/src/midi_export.rs` drops the `MTrk`
  chunks at those indexes, counting `MTrk` chunks only, as midi.js does. It
  sets the header's track count to the tracks that remain. Every other byte
  stays as lilypond wrote it. The checkbox is an `NSButton` in the panel's
  accessory view (`dialogs::save_checking`). The smoke test answers no panel
  and takes the suggestion with the box checked.
- **Not done.** The instruments chosen in the fold are not written into the
  file: their program changes are in the tracks lilypond wrote, and rewriting
  them means rewriting events, not chunks. The start bar is ignored too. A
  score with several `\score` blocks exports only the first one's MIDI, which
  is the one the transport plays. The extension has no Export MIDI.
- **Verified.** `midi_export.rs`'s tests drop a track from the extension's
  `sample.midi` (a control track and three staves), keep the other chunks
  byte for byte, and refuse a file that is not MIDI, is cut short, or would
  have no tracks left. `playbackSetup.test.ts` covers `mutedParts`. In
  `npm run test:smoke`, *File › Export MIDI…* with the only part muted writes
  `smoke.mid` with its two tracks. The panel and its checkbox were not seen
  in a run.

---

## D55 — Lily Studio on the web: a gateway, and a sandboxed worker per user

**Status:** proposed · **Refines:** D42, D28, D29 · **Leaves out:** D40 on the web

- **What.** `packages/studio/crates/server` builds `lily-studio-server`, which
  serves the studio's page to browsers for many users. `serve` runs the
  gateway: accounts, sign-in, the page and its files, and a WebSocket per
  page. Each signed-in user gets a worker, `lily-studio-server worker`, which
  does for one page what the app's main process does for its window. It
  runs the same compiler, live preview, watcher, recent list and playback
  setups. The page is the app's renderer: `node esbuild.mjs --site` bundles
  it into `dist/site/`. The agents (D40, D41) are not on the web; MCP may
  bring an agent there later.
- **Shared with the app.** The Tauri-free part of `src-tauri` moved to
  `crates/session` (`lily-session`): `Studio` (was `state.rs`),
  `playback.rs`, `recent.rs`, `midi_export.rs`, and `ops.rs`, the commands'
  bodies without their dialogs. `src-tauri/src/commands.rs` now opens a
  panel and calls `ops`; the worker calls the same `ops` with what the
  page's dialogs chose. `Studio` sends events to a sink, the app's channel
  or the worker's stdout. It spawns on the runtime it was built on. The
  smoke folder is the app's own managed state.
- **Accounts.** `users.json` in the data directory: a name, a random id that
  names the user's directory, and an Argon2 hash. `lily-studio-server user
  add|password|remove|list` manages accounts, and the running server reads
  the file again when it changes. `--signup` lets anyone create an account.
  A session is a random token in an HttpOnly, SameSite=Lax cookie, Secure
  with `--secure-cookies`. `sessions.json` keeps only its SHA-256, for 30
  days. A new password or a removed account signs the user out. After five
  wrong passwords a name waits a minute, and an unknown name costs a hash
  too. Every POST and the socket must come from this host, checked by the
  Origin header, else the Referer.
- **A user's files.** `users/<id>/scores/` is all the page may touch. It is
  shown as *My Scores*, and the sample is written there. `users/<id>/studio/`
  is the app's userData: settings, playback setups, the recent list.
  `Access::rooted` allows the whole workspace and nothing outside it,
  whatever was opened, so a page that reconnects needs nothing granted again.
- **The sandbox.** A score is a program: LilyPond runs its Scheme, which can
  read and write any file the process can. So each worker, and the lilypond
  it runs, starts under bubblewrap (`--sandbox bwrap`, the default `auto`).
  The sandbox shows `/usr`, `/bin`, `/lib*`, `/etc`, `/opt`, the program, the
  runtime and LilyPond's install read-only. It hides the data directory under
  a tmpfs and shows the user's own directory read-write inside it. It
  unshares every namespace, network included, drops all capabilities and
  has its own `/tmp`. `--sandbox-bind` shows more directories. The server
  will not start when bubblewrap is missing or fails a probe run.
  `--sandbox none` is for development on a Mac, or for users who trust each
  other, and the server warns at start. In Docker, bubblewrap needs
  `seccomp`, `apparmor` and `systempaths` unconfined. The `Dockerfile` in
  `packages/studio` says how.
- **Workers.** One per user, started when a page connects and stopped after
  `--idle-minutes` (15) without one. At most `--max-workers` (32) run, and
  the longest idle one makes room. A worker serves one page at a time, as
  the app has one window. A second tab takes it over, and the first is told
  so and can take it back. The gateway passes lines both ways without
  reading them: `{id, command, args}` in, `{id, ok|error}` and `{event}` out.
  The gateway itself adds `hello` (the user and the worker's instance),
  `replaced` and `closed`. The worker answers `edited`, `set_live` and
  `set_dirty` before reading the next line, as Tauri runs the app's
  synchronous commands in order.
- **The page.** `src/renderer/bridge.ts` talks to a `Transport`
  (`src/ipc.ts`): `src/renderer/transport.ts` for the app, and
  `src/web/transport.ts`, which `--site` puts in its place. The web
  transport answers the commands the app answers with a panel by asking
  first with its own dialogs (`src/web/dialogs.ts`). There is a browser of
  My Scores that opens a score or a folder, makes folders and names a new
  score, and questions with buttons and a checkbox. It then passes the path
  to the worker. A PDF or MIDI file it exports is downloaded too. A menu bar
  (`src/web/menubar.ts`) takes the app menu's place, and adds *Upload
  Scores…* (`.ly`, `.ily`, `.lyi`, 2 MB each, replacing a file only when
  asked) and *Download Score*. ⌘S, ⌥⌘S, ⌘O and ⇧⌘O work. Closing the tab
  with unsaved changes asks first. After a reconnect the page gives the
  worker its open folder and the live preview switch again. The setup
  dialog only says how the server's LilyPond is, and the agents' accordion
  is hidden.
- **Not done.** Files cannot be renamed or deleted on the web. A worker has
  no memory or CPU limit beyond the machine's. Run the server under systemd
  or in a container with limits. Sessions are not bound to an address. The
  server speaks plain HTTP; put a proxy that terminates HTTPS in front, and
  forward the Host header.
- **Verified.** On a Mac with `--sandbox none`, `crates/server/tests/server.rs`
  runs the binary end to end. It covers accounts made with `user add`,
  sign-in refused from another origin and with a wrong password, and the
  socket. It covers browse, folders, upload, download and new score without
  replacing, and paths outside the workspace refused however they are
  spelled. It covers a compile with lilypond, a second tab taking the worker
  over, a second user unable to read the first's score, and sign-out.
  Unit tests cover users, sessions, the sign-in page, the origin check and
  bubblewrap's arguments, and `test/web.test.ts` covers the shortcuts and
  the checkbox's words. In Chromium (Playwright), the page was driven end
  to end: sign-up, the sample engraved, the dialogs, ⌘S, upload, download,
  Export MIDI, and a second tab. In the Docker image on Linux, with
  bubblewrap, a worker started under `bwrap` and engraved the sample with
  LilyPond 2.24.1. That one user cannot reach another's files from a score's
  Scheme was not tried under bubblewrap.

---

## D56 — An engine of our own: LilyPond in WebAssembly

**Status:** accepted · **Refines:** D1, D24, D26, D42, D53, D55

- **What.** We build our own engine: a small LilyPond in Rust, compiled to
  WebAssembly, that runs in the browser. It parses the whole syntax, runs a
  score's Scheme, lays the music out as LilyPond does, and writes SVG pages,
  MIDI and the playback map (D26). PDF comes from a module fetched at the
  first export. LilyPond 2.26.0 is the reference: the engine's output is
  compared with LilyPond's layer by layer (diagnostics, events, MIDI, breaks,
  positions, beam and slur shapes) on 30 test scores. The investigation is
  `docs/research/wasm-engine/`, chapters 00–09. Its README is the roadmap:
  budgets per module, milestones MS0–MS8, effort, risks and test coverage.
- **Why.** LilyPond re-renders a two-page score in 0.32 s and an orchestral
  page in 0.91 s on the desktop, before any network round trip. On a
  mid-range Android phone that would be seconds per edit. LilyPond itself in
  wasm (Guile by Emscripten) is 3.5 MB of brotli and a 15.9 MB data file,
  ten times the core's 1.5 MB budget, and needs wasm exception handling,
  which Safari 17 lacks. An engine that recomputes only what an edit changes
  can fit 250 ms per edit there. A spike of the engine's shape
  (`packages/engine/crates/spike`, D57), run through the studio's worker
  on an iPhone and an Android tablet, was 38 KB of brotli wasm, ready
  111–297 ms after navigation, and re-rendered a page in one frame. And a
  score's Scheme run in the user's browser gets no file system, which D55
  needs bubblewrap for.
- **The parts.** A hand-written parser that re-parses only the edited item
  and block. A Scheme interpreter of our own, with Guile's spellings and
  error texts, a precise collector, a heap image of LilyPond's Scheme after
  init, versioned globals and an undo log. s7 is the fallback if the
  interpreter's first milestone misses its budgets by more than twice. A
  music model of frozen trees, contexts and translators, with checkpoints,
  convergence and partitions. A layout that ports LilyPond's searches with
  their parameters and approximates none, re-laying out cells, the visible
  page first. Emmentaler in packs per optical size, each glyph defined once
  per page, links as LilyPond writes them (D1). MIDI performers in the core,
  run after the page. Oscillators stay the sound (D24); a sampled piano
  would be the player's optional pack. PDF in its own wasm module with its
  own CFF subsetter.
- **The build.** `wasm32-unknown-unknown`, `opt-level = "z"`, fat LTO,
  `-Cpanic=immediate-abort` and `-Zbuild-std` on a pinned nightly (stable is
  14–26 % larger and still fits). No `core::fmt` on any core path. A
  declared maximum of 256 MiB. Only the wasm features Safari 17 has: no
  threads, wasm tail calls, exception handling or GC. One dedicated worker
  per page steps the engine through a C ABI, so a newer edit stops an older
  compile within 50 ms. Modules on demand are data (the image, Scheme parts,
  font packs), code with its own memory (PDF), or code split from the linked
  core by call graph with `wasm-split`. Files carry their hash and are kept
  in Cache Storage, without a service worker. Diagnostics come in
  LilyPond's stderr format and as `LyDiagnostic[]`, so the apps read them
  unchanged (D42's parser included).
- **Budgets.** Chapter 00's B1–B10 stand. The README shares them out per
  module: the core's 1.5 MB of brotli, and the 250 ms per edit of a small
  score on Android, by phase. Projections use the factors the phones gave:
  0.25× the M1 for allocating code and 0.38× for an interpreter loop on
  Android, 0.7× on iOS. Android is the binding platform. The page, not the
  engine, failed the 50 ms main-thread budget in the spike, so the page
  inserts one changed page per task.
- **Where.** A fourth package, `packages/engine`, with its own Cargo
  workspace and `rust-toolchain.toml`, so the nightly touches nothing else
  (refines D53). MS0's first step creates it and moves the spike into it;
  AGENTS.md changes then.
- **Hosts.** Lily Studio on the web first (D55). The page compiles with the
  engine while it is ready, and sends any compile the engine fails or cannot
  do to the server's LilyPond, so the web never gets worse than D55. The
  desktop app and the extension keep LilyPond. Whether they adopt the engine
  is decided after MS7, on their own measurements. LilyPond stays the
  reference, and the authority for exports until the engine's pass the
  gates.
- **Licence.** The engine ports LilyPond's C++ and carries LilyPond's Scheme
  and `ly/` files in its image, so it is GPL-3.0-or-later. Its font packs
  take Emmentaler under the GPL with the font exception. The apps stay MIT.
  The page talks to the engine only through the worker's messages, and the
  MIT worker script that calls its exports may be distributed with it under
  the GPL. The source is this repository at the commit the engine's manifest
  names. The PDF module ships the URW text fonts unmodified, with their AGPL
  licence and source; their exception covers embedding them in PDFs. That is
  checked again before the PDF module ships. The engine's SMF crate is not
  shared with the studio's `midi_export.rs` (D54), which stays MIT with
  its own chunk walk.
- **Decision points.** Every milestone ends on the comparator's layers and
  on the phones, through chapter 09's harness. Three can change the plan:
  MS1 (the interpreter's size and speed, else s7), MS3 (layout at most 120
  µs a grob on Android, where a straight port projects to 209) and MS6 (B6
  phase by phase on four scores and three kinds of edit).
- **Not done.** Nothing is built beyond the spike and chapter 08's host side
  in `packages/studio/src/web/engine/`, which no page loads yet. Not
  measured: Cache Storage on iOS after a reload, a throttled first visit,
  the worker's JS heap, and the Android floor device. The effort is
  estimated at 80,000–90,000 lines of Rust and 84–102 engineer-weeks, 67–83
  of them to ship on the web, at an assumed rate that MS1 measures.

---

## D57 — The engine's workspace: a pinned nightly for the wasm build, stable for the rest

**Status:** accepted · **Refines:** D53, D56

- **What.** `packages/engine` (`lily-engine`, GPL-3.0-or-later, with the
  GPL's text in its `LICENSE`) is the fourth package of the npm workspace
  and its own Cargo workspace. Its `Cargo.toml` holds the profiles of chapter
  08 §1.3, `wasm` and `wasm-names`, which left the studio's workspace. Its
  `rust-toolchain.toml` pins `nightly-2026-05-24` with `rust-src` and the
  `wasm32-unknown-unknown` target, for `-Zbuild-std` and
  `-Cpanic=immediate-abort`.
- **Stable for the rest.** A toolchain file applies to every `cargo` run in
  its directory, so the package's scripts name stable: `npm test` runs
  `cargo +stable test --workspace` and `npm run lint:rust` runs `fmt` and
  `clippy` on `+stable`. Only the wasm build uses the pin. A bare `cargo`
  in `packages/engine` makes rustup install the pinned nightly first. The
  studio's crates never see the nightly.
- **The spike.** `packages/studio/crates/engine-spike` moved with `git mv`
  to `packages/engine/crates/spike`, so `git log --follow` finds its history.
  Its crate keeps its name, `lily-engine-spike`, and becomes GPL-3.0-or-later
  with the workspace; it was MIT, and its author holds the copyright.
- **The root.** `npm test` runs the engine's tests after the studio's.
  `npm run check-types` passes `--if-present`, since the engine has no
  TypeScript. CI is unchanged: it builds no Rust.
- **The build.** `npm run build` (`scripts/build.mjs`) checks for the pinned
  nightly and Binaryen's `wasm-opt`, builds `packages/engine/dist/engine/`,
  which the studio's `esbuild.mjs --site` copies, and prints
  `scripts/sizes.mjs`'s report. The report never fails a build, as
  IMPLEMENT.md says against 08 §9 and README §4.1, and H4 is a count of
  `core::fmt` bytes in it.
- **Since.** `serve.mjs` serves the studio's `dist/site` over HTTPS (MS0
  step 3), and chapter 09 and D56 name the spike's new path.
- **Verified.** In `packages/engine`, `npm test` (the spike's 9 tests) and
  `npm run lint:rust` on stable. The studio's `cargo test --workspace`
  without the spike.

---

## D58 — The preview inserts changed pages one per frame, the one in view first

**Status:** accepted · **Refines:** D25 (viewer reuse, timing) · **Addresses:**
H2 of the engine's roadmap (09 §8 P2, README R6)

- **Why.** 09 §4.4 measured the tablet's main thread at 95–105 ms when four
  pages were replaced in one task, against B7's 50 ms. About 25 ms went to
  each 45 KB page, so at most one page fits in a task.
- **What.** `render()` in `packages/common/web/preview.js` keeps D25's reuse
  by hash. Of the changed pages, it parses and inserts the one at the middle
  of the view in the message's own task. The others go in one per
  `requestAnimationFrame`, outwards from it, the page below before the one
  above (`insertionOrder`). Until its turn, a changed page's old node stays
  in place. An added page is held by an empty `.page`, sized from its
  viewBox (`pageRatio`), so the scroll position holds. `pageHashes`
  describes the nodes on screen, so a newer render reuses only what is
  really there.
- **Stopping.** A newer revision or a `clear` stops the insertion. Each
  page that goes in re-indexes the links, re-marks the cursor's hrefs (the
  webview now keeps the last `highlight`'s) and drops the playhead's map.
- **Timing.** 'rendered' is posted two frames after the last page is in. A
  render that changes n pages acknowledges about n − 1 frames later than
  before, and `renderMs` includes them.
- **Not the studio, yet.** Lily Studio's `ScorePreview.render()` replaces
  every page and does not use this `render()`. Reuse by hash and this order
  come to the studio's page in a step of their own, before or with D55's
  commit, since the engine's pages will land there. **Since D137 the studio's
  page inserts its pages so, reusing a page by its text.**
- **Verified.** `insertionOrder` and `pageRatio` in the extension's unit
  tests; its extension-host tests, page reuse included, on LilyPond 2.26.0.
  `packages/engine/crates/spike/harness/pages.mjs` times B7 for the webview
  in Chromium and checks the order and the stopping (progress.md, MS0
  step 10).

---

## D59 — The engine's reference is Homebrew's arm64 LilyPond 2.26.0 on macOS

**Status:** accepted · **Refines:** D56

- **What.** "LilyPond's values", which the engine must reproduce, are those
  of one build: LilyPond 2.26.0 with Guile 3.0 from Homebrew, for arm64
  macOS. Every reference capture of MS0 (`$LILY_CORPUS/ref`, `extents.ly`,
  `skylines.ly`) comes from it, and a capture from another build is not a
  reference.
- **Why.** Two of MS0's gates are exact, and both carry that build's last
  bits. The glyph skylines (W2) depend on the multiply-adds clang fuses in
  `skyline.cc` and on libc++'s `std::sort` order of ties. M1's byte equality
  depends on libc++'s heap, which orders the note-offs at one tick. A
  LilyPond built with GCC and libstdc++, or for x86-64 without FMA, gives
  other last bits and other ties. The engine ports the fused expressions
  (`libm`'s `fma`) and libc++'s sort and heap, so it matches this build on
  every machine, wasm included.
- **Consequences.** Captures are made on an arm64 Mac with Homebrew's
  2.26.0; `capture.mjs` already refuses any other version, but not another
  build. A Linux reference (CI, D55's server) would need its own captures
  and could fail W2 and M1's exact tests where this build passes.
- **Not done.** libstdc++'s heap and a GCC build were not tried. Whether a
  later layer (C4's positions, C5's shapes) moves by the fused bits is not
  known until the engine lays out. progress.md, MS0's summary.

## D60 — The engine's own `assert` and `define-syntax-function` stand in for LilyPond's `syntax-case` macros

**Status:** accepted · **Refines:** D56

- **What.** The engine's Scheme expands `syntax-rules`, `defmacro` and
  `define-macro`, not `syntax-case` (chapter 03 §5.5). `(lily)` has two
  macros written in Rust (`crates/scheme/src/expand.rs`) that expand as
  the `syntax-case` definitions of LilyPond 2.26.0 do: `assert`
  (`lily-library.scm`) and `define-syntax-function`
  (`music-functions.scm`). Loading a file treats a `define-syntax` or
  `define-syntax-public` whose transformer is not `syntax-rules` in one of
  two ways:
  - **The name is one of these natives where the file is loaded.** The
    native macro stays and the transformer is not evaluated;
    `define-syntax-public` still exports it. This is how both files load in
    `(lily)`.
  - **Any other name.** The macro is defined with its transformer kept
    unevaluated, and a use of it is a syntax error that names D60.

  A procedure made by `define-syntax-function` carries the music
  function's signature, the unevaluated `(type predicate …)`, in its code's
  header (`Vm::procedure_header`), so chapter 02's classification of
  `\name` can read it without calling anything (03 §5.5).

  Step 10b adds a third: `lily.scm` imports `(lily curried-definitions)`
  into `(lily)`, whose `define`, `define*`, `define-public` and
  `define*-public` take a curried head, `(define ((f a) b) …)`, and which
  `lily-library.scm` and `music-functions.scm` use. That module is the
  engine's own, made with every VM and used by `(lily)`; its four forms are
  native macros that rewrite a curried head as
  `curried-definitions.scm`'s do, a docstring moved to the outermost
  procedure, and give any other form to the core keyword.
- **Why.** Only four macros of LilyPond's Scheme use `syntax-case`
  (03 §2.2), and psyntax is the largest part of Guile's expander. The two
  of the core files are fixed text that LilyPond's music functions all go
  through, so a native form costs a few hundred lines and expands as fast
  as a core form, where `syntax-case` would cost its expander and its
  syntax objects in every image.
- **Consequences.** A LilyPond after 2.26.0 that changes either definition
  is not followed by the engine until the native one is changed too.
  `tests/macros.rs` reads both definitions from the installed LilyPond and
  runs the same programs in guile, which expands them, and in the engine,
  which keeps its own, so such a change shows there; `tests/library.rs`
  loads both files with the curried forms. The other `syntax-case` macro
  (`accreg.scm`) and any in a score fail when used, with the error above.
  `define-markup-command` and `markup` are `defmacro`s in
  `markup-macros.scm` and expand as such.
- **Not done.** `syntax-case` as a part loaded on demand (03 §6), for
  scores that use it. progress.md, MS1 steps 9 and 10b. **Done by D273**
  (MS8 step 11): the refusal is gone, the four native macros stay.

## D61 — The music model's values are LilyPond's to the bit, with checked arithmetic, and its `ly:` functions are its own crate's primitives

**Status:** accepted · **Refines:** D56

- **What.** `crates/music` (`lily_engine_music`, chapter 04's N1 so far)
  holds moments, durations, pitches and scales as foreign objects of the
  engine's Scheme, with the `ly:` functions of `moment-scheme.cc`,
  `duration-scheme.cc`, `pitch-scheme.cc` and `scale.cc`.
  - **Its primitives are its own.** The music crate depends on the Scheme
    crate, not the other way round, and gives a VM its table of primitives
    with `Vm::define_primitives`, which numbers them after the Scheme crate's
    own in the order the tables come. Such a primitive works on a `Cx`
    through its public methods (the heap, a global's value, Guile's
    errors). The parser and the later music steps add theirs the same way.
  - **A rational is held as LilyPond holds it**: a sign from −2 to 2 and two
    unsigned magnitudes, not chapter 04 §5's `{num: i64, den: i64}`, so its
    infinities, its not-a-number and what its layout leaks are LilyPond's: a
    moment's default zero grace part divided by zero is +∞, an infinity's
    numerator is ±2 and grows when multiplied, NaN compares equal to any
    positive number. What LilyPond leaves to the compiler is arm64's (D59):
    a shift counts modulo 32, a negative double becomes 0 as a `size_t`.
  - **Arithmetic is checked.** Where LilyPond's 64-bit arithmetic would
    wrap, the `ly:` function throws `numerical-overflow`; chapter 04 §5's
    rationals of bignums on the Scheme heap are not built. A product is
    reduced before it is multiplied, so it overflows only when its result
    does not fit.
- **Why.** Ported as it is, `Rational` gives LilyPond's results on every
  edge without a case for each, which a capture of the calls can check
  exactly (`tools/compare/n1-calls.ly`). An overflow is visible where a wrap
  would make a moment silently differ, and none of the 30 scores comes near
  one (04 §5); a second, bignum form of every rational would cost code in
  every arithmetic path for none of them. A crate of its own keeps the
  music model's bytes its own in the size report (README §4.1).
- **Consequences.** A score whose moments overflow fails where LilyPond goes
  on with a wrong one. A heap image (S4) gives a primitive the same number
  only if the same tables are defined in the same order. Pitches and
  durations are heap objects, not chapter 04 §5's immediates of 40 and 32
  bits, until a step measures what they cost. progress.md, MS1 step 11.

## D62 — The image holds every word as it is, and every foreign type saves itself or fails the write

**Status:** accepted · **Refines:** D56, D61

- **What.** `Vm::write_image` collects, then writes the VM at rest: the
  symbols, each arena chunk by chunk with its epoch and live bits and its
  objects' words unchanged, the compiled code, the slots and modules, and
  the VM's own values (`crates/scheme/src/image.rs`). `Vm::restore` puts
  each object back at its index, so no value is relocated.
  - **The code is outside the heap.** Templates are shared by `Rc`, so the
    image numbers those the closures reach, each after its children, and
    writes an instruction as a code and two operands, as the VM last
    rewrote it.
  - **A foreign type saves itself.** `Foreign::save` writes what it holds
    and returns true; the default returns false and fails the write with
    `ImageError::Unsaved`. A `Loader`, found by the type's `type_name`,
    reads it back. Another crate gives its primitives and loaders to
    `Vm::restore` as an `Extension` (the music crate's `EXTENSION`), in the
    order its primitives were defined: a signature of the primitive tables'
    names and arities in the header refuses any other.
  - **Rebuilt, not written:** the symbol table's index and each hash
    table's index over its entries. The entries keep their order and their
    hashes, which for `eq?` and `eqv?` are of the words and still hold.
- **Why.** Chapter 03 §5.6 asks for a copy with no relocation, and values
  already hold indices, not pointers. A save that a type must write keeps a
  new foreign type of a later crate from being left out of the image
  silently: the build's write fails instead. Keying loaders by type name
  needs no registry of numbers across crates.
- **Consequences.** Every later foreign type (music, contexts, grobs,
  stencils) implements `save` and gives a loader before an image can hold
  it. An image is read only by the build that wrote it (its format number
  and the primitives' signature); its body is not checked further. What a
  probe prints must not show heap indices (a procedure without a name),
  since a VM loaded from source and one restored need not number their
  objects alike. progress.md, MS1 step 12a.

## D63 — The engine's C0 keeps a third copy of `parseStderr`, held to the extension's by a fixture, and reads the error corpus through `@lily/common`'s exports

**Status:** accepted · **Refines:** D6, D16, D42, D53, D56

- **What.** `packages/engine/tools/compare/stderr.mjs` is the extension's
  `parseStderr` (`packages/vscode/src/diagnostics/parse.ts`) with
  `@lily/common/span`'s `displayWidth`, line for line in plain JavaScript.
  It is the third copy, beside the extension's and Lily Studio's Rust port
  (D42).
  - **A fixture ties it to the extension's.** `gen-stderr-fixture.mjs`
    (`npm run gen:stderr-fixture -w lily-engine`) loads the extension's own
    parser through the workspace as `lily/src/diagnostics/parse.ts`, by
    Node 24's type stripping, runs it on the error corpus's 30 `.err` files
    and writes `tools/compare/fixtures/parse-stderr.json`.
    `test/c0.test.mjs` holds the copy to that fixture on every run.
  - **The corpus is read through `@lily/common`'s exports.** The package
    exports `./test/parser/errors/*`. `stderr.mjs` resolves the first case,
    `@lily/common/test/parser/errors/01-unknown-command.ly`, and takes its
    directory, since Node no longer resolves an export of a directory. No
    tool reaches into another package by a relative path, and a test
    checks that.
- **Why.** The engine's tools are plain JavaScript that `node` runs without
  a build, and the extension's parser is TypeScript in a package that
  exports nothing. Importing it on every test run would tie the engine's
  tests to the extension's sources and to type stripping, which still
  warns. The fixture needs them only when it is written. Moving the parser
  into `@lily/common` would change the apps' parsers, which 08 §6 and D42
  keep as they are, for a copy only the engine's tools use.
- **Consequences.** A change to the extension's `parseStderr` is made in
  three places: the extension, the studio's Rust port (D42), and
  `stderr.mjs`, followed by `npm run gen:stderr-fixture`. The fixture
  catches a copy that drifts only on what the 30 files exercise, and only
  once it is written again. The engine resolves `@lily/common` and `lily`
  through the root workspace, as `score.mjs` already resolved
  `@lily/common/web/midi.js`, without declaring them in its
  `package.json`. progress.md, MS1 step 14.

## D64 — C0 counts warnings as well as errors, and a parser alone is scored without the warnings of processing

**Status:** accepted · **Refines:** D56, D63

- **What.** C0 (chapter 00 §5.2) passes when two things hold:
  - the first diagnostic, of either severity, is equal on both sides in
    its file without the directory, line, column, severity and message;
  - the counts of errors are equal, and so are the counts of warnings.

  00 §5.2's "same error count" is read as both severities. The Dice of all
  the diagnostics is reported as `all` and not judged.
  - **`--parse-only`** (`parseOnly`) leaves out, on both sides, the
    warnings LilyPond gives while it processes a score, after parsing:
    `skipping zero-duration score` and `to suppress this, consider adding a
    spacer rest` (`PROCESSING` in `score.mjs`). In the error corpus, only
    cases 17, 18 and 30 have them. Every MS1 run of the corpus uses it.
    From the step whose engine processes the scores it parses, C0 runs
    without it.
  - **`Unattached ArticulationEvent` stays counted.** It is the parser's:
    LilyPond 2.26.0 gives it for `x = { -. c4 }` alone, with no music to
    process. So case 30 under P2 must give its two warnings.
- **Why.** The corpus has warnings on purpose: the lexer's non-UTF-8 input
  (06), the parser's deprecated property path (29) and unattached events
  (30). Counting errors alone would pass those three on an empty stderr.
  The two processing warnings come from a stage that MS1 does not have.
  Counting them would fail 17, 18 and 30 for a reason outside the parser,
  so they are left out by message rather than by severity, and everything
  else is kept.
- **Consequences.** `PROCESSING` is a closed list: a processing message
  that a later case shows is added there, with its case. In 17 and 18 the
  first diagnostic is the error, so its message and location are what P5
  must match. In case 20, `parseStderr` appends Guile's abort (`ERROR: In
  procedure ly:parse-file: …`) to the first error's message. It is not a
  separate diagnostic, so P7 must print it, or C0 fails case 20 on the
  message (02 §5.6 has it as not counted). progress.md, MS1 step 14.

## D65 — P5 gives Scheme a minimal music value of the music crate's, and N2 replaces it behind the same face

**Status:** accepted · **Refines:** D60, D61

- **What.** MS1 step 18a reached the plan's stop point for music values.
  The user chose a minimal music value over moving N2's frozen music
  forward (2026-10-05).
  - **`crates/music` holds it** (`music.rs`), beside N1's values:
    - `Music`: a type's name and `types`, and a mutable property alist;
    - `MusicFunction`: a signature and a procedure;
    - the primitives `ly:make-music`, `ly:music?`, `ly:event?` (a
      post-event), `ly:music-property`, `ly:music-set-property!`,
      `ly:music-mutable-properties`, `ly:music-deep-copy`,
      `ly:make-music-function`, `ly:music-function?`,
      `ly:music-function-signature` and `ly:music-function-extract`;
    - `define-music-types.scm`'s `make-music`, over a table of each type's
      name and `types` that `define_music_types` reads from that file as
      data.
  - **The parser depends on the music crate.** It keeps its syntax
    (`Held`) for what assignments define. It makes music values where
    Scheme is given music: a predicate, a function's argument, a default.
    Those values carry the properties the syntax holds, set in the order
    LilyPond's actions set them. A value a function gives back is held as
    `MusicKind::Value`.
  - **A music function is classified by its signature.**
    `scan_scm_id` compares the predicate of its result with `ly:music?`
    and `ly:event?` by identity, as LilyPond does. That replaces reading
    D60's procedure header, which the parser no longer reads.
  - **`Vm::define_primitives` exports what it defines,** as `LY_DEFINE`
    exports LilyPond's from `(lily)`. A file's module did not see N1's
    `ly:` functions before.
- **Why.** Case 17 cannot pass without music values:
  - defining `\transpose` evaluates `(make-music 'Music)`;
  - before `"d"` is checked, LilyPond calls `ly:pitch?` on the NoteEvent
    that `make_music_from_simple` makes of `c`;
  - it then calls `ly:music?` on `{ c4 }`.

  N2's frozen music is several thousand lines and its own steps, which
  R12's 6,000–9,000 for part 3 cannot absorb.
- **Consequences.**
  - These are not here:
    - a type's other immutable properties (callbacks, iterators);
    - `origin`, lengths and starts;
    - `equal?` of music;
    - calling a music function from Scheme.
  - So a music object prints shorter than LilyPond's, and an
    articulation's properties (`dashDot`'s) are missing.
  - `Held` syntax that Scheme reaches through `#x` is not music yet.
  - N2 replaces the representation and keeps the Scheme face.

  progress.md, MS1 step 18a.

## D66 — Init files are parsed by the engine's parser and kept as LilyPond's session keeps them

**Status:** accepted · **Refines:** D56, D62, D65

- **What.** MS1 step 19 puts `ly/music-functions-init.ly` into
  `scheme.image`. The native image writer loads `lily-library.scm`,
  `c++.scm` and `music-functions.scm` into `(lily)`, in `lily.scm`'s order,
  then parses and runs the init file with the engine's own parser
  (`lily_engine_parser::parse_init`):
  - **The init file gets a module of its own,** like a file's, without the
    stand-ins a file's module gets (the shorthands, `$defaultpaper` and the
    other output definitions), since those are what init files define.
  - **Its variables are recorded as `session-save` records them:** each
    one put in front of `(lily)`'s `lilypond-declarations` as `(name #t
    module . value)`, beside `define-session`'s `(name #f module .
    value)`. A file that fails records nothing.
  - **Each file's module is given them as `session-replay` gives them**
    (`Env::new`): every recorded variable is defined in the file's module
    with its recorded value.
  - **`c++.scm` is loaded whole,** since the signatures name its
    predicates. `(lily)` gains `ly:dir?`, and `ly:context-mod?` false
    until P6. Its `ly:` primitives are exported, as `LY_DEFINE` exports
    LilyPond's.
- **Why.** Chapter 03's R5 and 02 §5.8 ask for the post-init snapshot, so
  that a phone never parses an init file. Parsing the file with the
  parser that parses scores tests both on 2,700 lines of LilyPond's own
  input, where extracting its Scheme forms would not. Keeping LilyPond's
  record, rather than a module of the engine's design, leaves
  `session-replay`'s place for the other init files when they run.
- **Consequences.** The image holds the 159 music functions of the file,
  and `tools/bench/test/image.test.mjs` checks their names and signatures
  against LilyPond 2.26.0. LilyPond adds the recorded variable object to a
  file's module, so a file's `set!` of it is seen by the init file's code
  until the session ends. The engine defines a variable of the file's own,
  so the init file's code never sees it. The replay does not make the
  file's module use the modules the init file used (`lilypond-interfaces`).
  Every parse defines the 163 recorded variables again. progress.md, MS1
  step 19.

## D67 — Music is frozen into trees behind D65's face, and the C++ callbacks of later steps are named placeholders

**Status:** accepted · **Refines:** D61, D62, D65

- **What.** MS2 step 2 replaces D65's music value with N2's frozen music
  (04 §6.1–§6.2), in `crates/music`:
  - **The 131 types are a table generated at build time.** `build.rs`
    reads `music-descriptions` from the installed LilyPond 2.26.0's
    `define-music-types.scm` (or `LILY_SCM`) into `types.rs`' `TYPES`,
    never committed: each type's name, its `types`, and its other
    properties but `description` as the Scheme text of their values. A
    type's *kind* is its index, by name as the file sorts them. Without
    LilyPond the table is empty. `define_music_types(vm)` evaluates the
    values in `(lily)` into `%music-properties`, LilyPond's
    `music-name-to-property-table`: `name` first, then the file's order.
    So `tests/support` loads it after `lily-library.scm` and
    `define-music-callbacks.scm`, in `lily.scm`'s order.
  - **Music is live or frozen.** Live music is D65's: a kind if its type
    is one of the 131, its immutable property list and its mutable one.
    Frozen music is a handle of a node of a `Tree`, a foreign object that
    nothing changes once it is made:
    - nodes in preorder, 24 bytes each: kind, property count, subtree
      size, first property, digest;
    - each node's properties in a side table, in its list's order. Music
      and non-empty lists of music are held as the node's children, and
      any other value as it is;
    - the immutable list of each kind it holds.
  - **Freezing and thawing.** The parser freezes the music it makes and a
    music function's result when it returns. Music frozen already is
    copied into the new tree. A handle thaws in place into live music when
    Scheme reads a property that is a list or music, sets any property,
    or calls `ly:music-mutable-properties` on it: its lists are copied,
    and its music becomes new handles of its children, which thaw in
    turn. `ly:music-deep-copy` of a handle is a new handle of the same
    node. What is no list and no music is read from the node, and a
    handle prints from its node.
  - **Digests** (04 §6.3): FNV over the kind, each property's name and
    value, and the children's digests. `origin` is left out. A value's
    lists and vectors are taken item by item, as far as 4,096 items so a
    circular one ends, music in them by its type's name, and anything
    else as `write` writes it.
  - **Placeholders.** The 39 C++ callbacks the types name
    (`types.rs`' `PLACEHOLDERS`) are primitives with LilyPond's names and
    arities. When called, each throws `misc-error`, `not in the engine
    before …`, naming the step that brings it:
    - lengths and starts: MS2 step 3;
    - `\relative`'s callbacks: step 5;
    - iterators: N4, N6 or N7, and three after N7 (part combining,
      percent repeats, `\fine`).

    A later step replaces a placeholder's function under the same name
    and arity, so the image's signature of primitives (D62) stays the same.
    A callback of layout or MIDI (MS3–MS5) that a later file names is added
    the same way.
- **Why.** 04 §6 puts music in trees that are cheap to copy and compare,
  so that native operations (lengths, `\relative`, iterators) can work on
  them and translation can find what an edit changed. Thawing in place
  keeps D65's face: every primitive gives what it gave, and live music is
  still what music functions and `music-functions.scm` are written
  against. A table from the installed file keeps its 131 entries
  LilyPond's without a copy in the repository. A placeholder keeps the
  types' property lists LilyPond's (`procedure?`, its name) long before
  its step, and a call of it fails by name instead of with an unbound
  variable.
- **Consequences.**
  - Music prints its type's whole immutable list, LilyPond's, less the
    `display-methods` that part 2's `display-lily.scm` adds. D65 printed
    only `name` and `types`.
  - Where frozen music differs from LilyPond's:
    - music held twice in one tree becomes two copies;
    - music that Scheme still holds separately from its frozen parent is
      no longer that parent's;
    - two handles of one node thaw into two objects;
    - a list that mixes music with other values is held as a value, its
      music live;
    - music of a type outside the 131 (`ly:make-music` of a list of its
      own) or music that holds itself stays live.
  - 04 §6.1's payloads by kind (durations and pitches in the node) and
    origins as spans are not built. Every property is a Scheme value in
    the side table, 24 bytes each, beside the 24-byte node.
  - The parser freezes each music it makes, so the tree of a parent is
    copied once per level, until MS2 step 4 builds trees directly.

  progress.md, MS2 step 2.

## D68 — Lengths and starts are native, and a primitive leaves what needs Scheme to a fallback it tail-calls

**Status:** accepted · **Refines:** D62, D65, D67

- **What.** MS2 step 3 gives music its lengths, starts, `origin` and
  `equal?` (04 §6.1, §6.3), in `crates/music`:
  - **Native, for live and frozen music alike.** `ly:music-length`,
    `ly:music-start` and the 10 callbacks of D67's placeholders for them,
    with `ly:music::duration-length-callback`, are primitives under
    LilyPond's names (`length.rs`' `CALLBACKS`). They read music through a
    view that never thaws (`music.rs`' `At`), and a callback is known as
    one of these by the primitive it is (`Heap::primitive_name`).
  - **A tree keeps its nodes' lengths and starts** in a side array, filled
    as they are computed and not saved in an image. A node's is kept only
    if its computation read no live music, which Scheme could still
    change.
  - **What needs Scheme goes to Scheme.** A primitive cannot call a
    procedure, so `Cx::tail_call` lets it name one that the VM calls in its
    place, in tail position. When a computation reaches a procedure of
    Scheme (the `elements-callback` of the repeats' calculated sequences,
    or a callback of the user's), the primitive
    calls its fallback, `%` and its name, which `length.rs`' prelude
    defines in `(lily)` as the C++ is written. The fallback asks for each
    element's length or start again, natively where it can be. It reads
    elements as new handles (`%music-children`), and gives an
    `elements-callback` a new handle of a frozen node, so a frozen tree is
    never thawed for its length.
  - **`equal?` is `Prob::equal_p`:** the immutable lists, then the mutable
    ones, entry by entry in order, `origin` left out, keys `eq?` and values
    `equal?`, frozen children read in place.
  - **`origin` is an `Input`** (`input.rs`, moved from the parser's
    `Location`): a source's number, the span's bytes and the place it
    prints, saved in an image. `Tree::origin` gives a node's span.
    `ly:music-deep-copy` with an origin sets it as `set_origin` does,
    replacing an entry where it is (D65 put it in front).
  - **Identity (04 §6.3):** `first_difference` walks two trees past equal
    digests to the first pair of nodes that differ in kind, own properties
    or children, and `Tree::identity` hashes the digests on a node's path,
    each with its ordinal among siblings of the same digest.
  - **`ly:music-property` has its setter** (`LY_DEFINE_WITH_SETTER`), so
    `(set! (ly:music-property m 'key) v)` works, as `make-unfolded-set`
    needs. `%music-freeze!` and `%music-frozen?` give probes and tests
    frozen music without the parser.
- **Why.** Lengths are read by every iterator (N4), so they must not cost
  a thaw or a call into Scheme where the music's own types need neither;
  only repeats and the user's callbacks do. A tail call keeps the native
  primitives under LilyPond's names and arities, as D67 promised, and
  makes them right when they are called from Scheme too
  (`recompute-music-length` calls a type's callback directly).
- **Consequences.**
  - The fallbacks are about 70 lines of Scheme in `(lily)`, with `%` names
    beside LilyPond's.
  - An `elements-callback` given a frozen node gets a new handle of it,
    not the music its parent holds; one that compares the music by `eq?`
    would see a difference.
  - LilyPond's programming error for an element that is no music is not
    printed; the element is left out as LilyPond leaves it.
  - An identity changes with any edit inside an ancestor, since the
    ancestors' digests are on the path. N8, which uses identities, decides
    whether that is what 04 §6.3 means.

  progress.md, MS2 step 3.

## D69 — The parser makes music from its syntax where LilyPond hands music on, and defines music, not syntax

**Status:** accepted · **Refines:** D65, D67, D68

- **What.** MS2 step 4 makes the parser's music natively (04 §6.2, 02
  §5.5):
  - **The constructors are Rust** (`crates/music/src/constructors.rs`):
    `make-music`, `MY_MAKE_MUSIC`, `add_post_events`, `ly:set-origin!`
    and the constructors of `ly-syntax-constructors.scm` that P2–P5's
    actions call. They make live music with its properties in the order
    LilyPond's code sets them; `%music-properties`, their table, is now
    public in `(lily)` so that a file's module reaches it.
  - **The parser keeps its spanned syntax** (D65's split) and makes music
    of it where LilyPond's grammar hands music on: a function's or a
    predicate's argument, an assignment's value, and a score's music
    (`Parse::music`). Each object gets its `origin` at its span, the
    rules' post-events are attached as `reverse_music_list` and
    `post_event_cons` attach them, and the whole is frozen once, so an
    item's music is one tree. Values a function returns, `\name` copies and
    `#` forms' music are placed as LilyPond places them (`music-function`,
    `scan_escaped_word`, `eval_scm`).
  - **No syntax is held in a module.** D65's `Held` is gone: an assignment
    defines music (frozen), a `PostEvents` music for several post-events,
    or a pitch of the music crate's, and the shorthands of
    `declarations-init.ly`'s stand-ins are music. Scheme reaches them
    through `#x` as LilyPond's, and `\name` classifies them by their kind.
- **Why.** Building at the hand-off points needs no change to the
  recursive descent and its diagnostics, which read the syntax, and builds
  each tree once rather than copying a child's tree at every level (D67's
  consequence). The trees then equal LilyPond's node for node, which MS2's
  gate compares.
- **Consequences.**
  - Music is built from the syntax after its rules are reduced, so the
    grammar's own checks of music (`takes_post_events`, `Unattached`) still
    read the syntax; they and the constructors must agree.
  - An origin is an `Input` with its place's text per node: about 40 bytes
    a node more than 04 §6.1's span in the node, until N8 or the budgets
    ask for the span alone.
  - An `Input` names a file of the parse that made it, so music made by
    another parse (the init's, or the image's) names a file this parse may
    not have. K2's sources (part 2) own them.
  - `scan_escaped_word` places the variable's music itself before it is
    copied; the engine places only the copy, so `#x` after `\x` still sees
    the definition's origin.

  progress.md, MS2 step 4.

## D70 — `\relative` and transposition are native walks; operators and music functions get Guile's dispatch; warnings go to the parser

**Status:** accepted · **Refines:** D67, D68

- **What.** MS2 step 5 runs `music-functions-init.ly`'s bodies on frozen
  music (04 §13):
  - **`ly:music-transpose` and `ly:make-music-relative!` are native**
    (`crates/music/src/transpose.rs`, `relative.rs`), ports of
    `Prob::transpose` and `Music::to_relative_octave`, with
    `ly:transpose-key-alist` and the five C++ `to-relative-callback`s that
    were D67's placeholders. They change the music in place, as
    LilyPond's do, so frozen music is thawed as the walk reaches it and
    frozen again when the function returns to the parser (D67).
  - **A walk that would reach Scheme is left to a fallback** in `(lily)`,
    tail-called as D68's lengths are. Which music `\relative` reaches does
    not depend on the pitches, so this is known before anything changes.
    `KeyChangeEvent`'s `(lambda (x p) p)` is native: it is recognised as
    the value of its type's own entry in `%music-properties`.
  - **`operators.scm`'s methods are native** (`operators.rs`): the scheme
    crate's `+`, `-`, `*`, `/` and comparisons ask an extension's
    `operators` (`Extension::operators`, `Vm::set_operators`) where they
    would raise a wrong type, as GOOPS methods extend Guile's primitive
    generics. Each method calls the `ly:` function `operators.scm` calls.
  - **Music functions are applicable** (`Foreign::applicable`): a call of
    one from Scheme calls `%music-function-call`, `Music_function::call`
    in Scheme, with the function first; `procedure?` is true of it, as of
    Guile's applicable smobs.
  - **The warnings of `warn-scheme.cc`, `input-scheme.cc` and
    `ly:parser-error` are Scheme over a box** (`warn.rs`): each keeps its
    kind, location and text in `%diagnostics`, and the parser takes them
    after every Scheme call into its diagnostics, with the excerpt of its
    sources; messages are left out, as `--loglevel=WARNING` leaves them.
  - Also: `ly:set-origin!`, `ly:music-duration-length`,
    `ly:music-duration-compress`, `ly:music-list?`, `prob-scheme.cc`'s
    functions for music, the unpure-pure container, and Guile's
    `unspecified?`, which `c++.scm`'s `void?` calls.
- **Why.** GOOPS's generic functions, applicable smobs and the parser's
  sources are each larger than what the bodies need of them: a native
  table of `operators.scm`'s 20 methods, one trait method, and a box the
  parser empties keep the bodies running from source and from the image
  with no stand-in of LilyPond's Scheme. The native walks keep `\relative`
  and `\transpose`, which every score of the corpus runs, out of the
  interpreter.
- **Consequences.**
  - `operators.scm` is not loaded: its methods are fixed in Rust. A file
    that adds a method with `define-method` still fails, as before.
  - A warning's place in stderr is the end of the Scheme call that gave
    it, after what that call wrote to the error port; 08 §6's one list
    (part 2, K2) orders them.
  - A parser error without a location is placed at the lexer's last
    token, the lookahead if there is one, which is LilyPond's
    `here_input` only as far as the engine's parser reads ahead as Bison.
  - The unpure-pure container's `ly:pure-call` and `ly:unpure-call` are
    Scheme until layout (MS3) calls them natively.

  progress.md, MS2 step 5.

## D71 — Context modifications are the music crate's; context definitions are stand-ins until N3; a node's span ends at its last token's location

**Status:** accepted · **Refines:** D69

- **What.** MS2 step 6 parses contexts (P6, part 1, 02 §6):
  - **`Context_mod` is the music crate's** (`crates/music/src/context_mod.rs`),
    with `ly:make-context-mod`, `ly:context-mod?`, `ly:add-context-mod`
    and `ly:get-context-mods`. `ly:context-mod?` leaves the scheme crate,
    where it was false. A context mod keeps its list last first and gives
    it in order, a fresh list each time; `\name` copies it, as
    `try_special_identifiers` does, and the copy adds to its own list.
    `ly:context-mod-apply!` needs contexts and comes with N3.
  - **`\new` and `\context` are music the parser builds** where it hands
    music on (D69), with `context-create` and `context-find-or-create`
    (`Maker::context_specification`); `\change` with `context-change`.
  - **`\context { … }` gives a stand-in** (`output_def::ContextDef`, typed
    `Context_def`), which holds its mods in a context mod, and an output
    definition takes it without `assign_context_def`. N3 (part 2) makes
    context definitions of the mods and replaces it.
  - **Music in `\with` is made a context mod by
    `context-mod-music-handler`,** and by `lily-library.scm`'s
    `context-mod-from-music` while `declarations-init.ly`, which defines
    the handler as that function, is not loaded (part 2).
  - **A node's span ends where its last token is located** (`Token::loc`),
    not where its text ends, as Bison's `@$` does: a `#` form is located at
    its `#`, so `\change Staff = #"ab"` ends after the `#`, as LilyPond's
    origin does.
  - **The notes mode a mid-rule action pushes** (`\with {`, and music or
    `\context` in an output definition) is counted until its rule pops it,
    so that a syntax error inside leaves `Unfinished main input`, as
    LilyPond's does.
- **Why.** Context mods are values of music (`property-operations`) and of
  function arguments, so they belong with music. Context definitions are
  N3's model, whose module boundary part 2's split asks the user about;
  until then a stand-in keeps the parser's syntax and errors LilyPond's
  without choosing that boundary.
- **Consequences.**
  - `\layout { \context { \Staff … } }` needs `engraver-init.ly`'s
    definitions (part 2): until then `\Staff` is an unknown command.
  - A context definition is not yet put into its output definition, nor
    is music in an output definition handed to `output-def-music-handler`
    (`context-defs-from-music`, which needs `ly:output-find-context-def`).
  - A mod of an unknown tag in `\context { }` gives LilyPond's
    `programming error: unknown context mod tag` at the parse; the stand-in
    gives none until N3.
  - Spans that ended at a `#` form's text before end at its `#`; no test of
    P1–P5 changed.

  progress.md, MS2 step 6.

## D72 — Property operations follow Bison's paths and pushes; the test library brings `color.scm` and the grobs' names forward

**Status:** accepted · **Refines:** D69, D71

- **What.** MS2 step 7 parses property operations (P6, part 2, 02 §6):
  - **`\set`, `\unset`, `\override` and `\revert` are music the parser
    builds** where it hands music on (D69), with `property-set`,
    `property-unset`, `property-override` and `property-revert`
    (`Maker::property_set` and the others): the operation and its
    `ContextSpeccedMusic` both placed at the whole call, as `ly:set-origin!`
    and a syntax function's call place them. `property-set`'s and
    `property-override`'s signatures are checked in the parser, where
    Bison's action calls them, with `wrong type for argument` at the call.
  - **A path's context is `Bottom` when it begins with a grob,** a symbol
    whose object property `is-grob?` is true; the parser asks
    `object-property`, which `define-grobs.scm` sets.
  - **`simple_revert_context` pushes back** the rest of its first part as
    an `SCM_IDENTIFIER` (`Lexer::push_extra`), which is read as a token
    and traced as LilyPond's is. `revert_arg`'s `BACKUP` with `SCM_ARG` or
    `SYMBOL_LIST` are a loop instead: the lexer never gives them, so the
    token compare leaves them out (tokens.mjs).
  - **`\with { … }` and `\context { … }` take `property_operation`:**
    `(assign …)`, `(unset …)`, `(push …)` and `(pop …)` mods; an output
    definition's body takes `\override` and the others as music
    (`music_assign`), which is where Bison's recovery resumes after an
    error in a definition.
  - **The parser's test library (`tests/support`), and so the image,**
    loads `color.scm` whole, first, as `lily.scm` does, and gives the
    names of `define-grobs.scm`'s `all-grob-descriptions-data`, read and
    not evaluated, the object property `is-grob?`. Both are part 2's
    files; part 2 loads them whole and drops the names' stand-in.
- **Why.** Every `\override Grob.property` and `\revert Grob.property`
  with no context, the common form, depends on the grobs' names, and
  cases 16 and 29 on `#red`. `color.scm` loads as it is, and the names are
  the only part of `define-grobs.scm` the parser asks for, while the
  descriptions name the backend's callbacks of later milestones.
- **Consequences.**
  - `scheme.image` grows by 181,366 raw and 25,439 brotli bytes, mostly
    `color.scm`'s color lists, which the full init holds anyway.
  - `\tweak`, `\once` and the other functions whose paths
    `check-grob-path` checks still need `define-grob-properties.scm`'s
    `backend-type?` (part 2); `\applyOutput` now gives LilyPond's output.
  - The engine counts the modes that rules push rather than keeping
    LilyPond's stack, so after an error in a `\context { … }` inside an
    output definition, the mode the input after it is lexed in can differ
    from LilyPond's (`{ c4 }` after `\layout { \context { \Foo \revert
    … } }`).

  progress.md, MS2 step 7.

## D73 — Contexts are a module of the music crate, with LilyPond's primitives as their only Scheme face

**Status:** accepted · **Refines:** D71

- **What.** N3's module boundary (04 §7), the user's answer at MS2 part 2's
  split:
  - **Contexts live in `crates/music`** (`lily_engine_music`), as modules
    beside music and context mods: context definitions in part 2
    (`context_def.rs`), their instances in part 3. No crate of their own, so
    no new row in `PARTS`: they are charged to *Music model* with the rest of
    the crate.
  - **Their Scheme face is LilyPond's own primitives and nothing else:**
    `ly:context-def?`, `ly:context-def-lookup`, `ly:context-def-modify`,
    `ly:context-mod-apply!`, `ly:output-find-context-def` and the others
    part 2's files call; `ly:context?`, `ly:context-property`,
    `ly:context-set-property!` and the rest of the instances' with part 3.
    No engine-only procedure is exported to Scheme.
  - **A context definition holds its translators as LilyPond names them**
    (Rust classes by symbol, Scheme translators as procedures or alists),
    without the translator framework, whose boundary part 3's split asks.
  - D71's stand-in (`output_def::ContextDef` in the parser) is replaced by
    the music crate's `ContextDef`.
- **Why.** Context definitions are values of context mods, output
  definitions and music (`\context`, `\with`), all of which are already the
  music crate's (D71). Keeping LilyPond's primitives as the only face keeps
  the init files and the 82 recorded functions running as they are.
- **Consequences.**
  - The *Music model* row (420 / 290 KB raw, 160 / 110 brotli) carries N3 in
    part 2 and N3's instances in part 3, and every closing step from part
    2 on measures it with N3 in it.
  - If part 3's translator framework ends up in a crate of its own, it
    reaches contexts through the music crate's Rust API, not through Scheme.

  progress.md, MS2 step 9.

## D74 — The parts on demand load from source on their trigger, with stubs in the core until then

**Status:** accepted · **Refines:** D66

- **What.** How 03 §6's parts on demand (`chords`, `display`, `fretted`,
  `diagrams`, `partcombine`, `modal`) are present before S6 and K4, the
  user's answers at MS2 part 2's split:
  - **They are not in the image.** The image holds 03 §6's core: the core
    files of `lily.scm`'s list, and `declarations-init.ly` with 18 of its
    21 includes. R2's 420 KB brotli is measured on the core alone.
  - **They load from source on their trigger** (03 §6's table): `chords`
    on the parser's switch to chord mode, `display` on the first reference
    to its names, `fretted` and `diagrams` on their context or markup
    command, `partcombine` and `modal` on their music function. A part's
    `.scm` files are read and evaluated in the instance, in `lily.scm`'s
    order. They are not compiled ahead and not fetched as modules: that is
    S6's and K4's work.
  - **Every name a part defines is bound in the core to a stub until the
    part loads.** The names come from a table the build generates from the
    installed part files' toplevel definitions (never committed). Calling a
    stub procedure or using a stub value as data loads the part. The load
    rebinds the names, and the call or use then goes on.
  - **The init never forces a stub.** A reference at load stores the stub
    (`engraver-init.ly`'s `chordNameFunction = #ignatzek-chord-names`,
    `chordNameExceptions`, `stringTunings`, `tablatureFormat`,
    `predefinedDiagramTable` in `\Score`). A call at load returns a stub of
    its result (`property-init.ly`'s `(chord-name:markup 'english)`). What
    reads the stored value forces it later, so a score with no chords and
    no tablature never loads them.
  - **The init files that belong to a part run when it loads,** after its
    `.scm` files and not in the image: `chord-modifiers-init.ly` with
    `chords`, and `predefined-fretboards-init.ly` and
    `string-tunings-init.ly` with `fretted`.
  - **Until S6 the source arrives as source files.** Natively it is read
    from LilyPond 2.26.0's `scm/` and `ly/`, as the build reads them now.
    In wasm it is given with `lily_put` (kind 0), or asked for through
    `lily_step`'s 2 and `lily_needs`, as an `\include` is. 08 §4.2's ABI
    does not change.
  - `display-lily` comes with the `display` part and replaces
    `music-functions.scm`'s empty stand-in.
- **Why.** The user chose loading from source over loading the parts into
  the image and charging them apart. The init reaches `chords` and `fretted`
  at load, and the stubs stop those references from pulling both into the
  image, which then holds what every score needs and no more.
- **Consequences.**
  - The first score that reaches a part pays the part's load from source:
    34–157 KB of 03 §6's sources. Part 3's closing step measures it on T05
    (`chords`), T19 (`display`), T22 (`fretted`) and T29 (`diagrams`).
  - Part 2's gate reads "the 21 files it includes" as the 18 in the image
    and the three run with their parts, and checks those three by loading
    their parts.
  - A part that needs what S6 adds records what is missing, and the items
    that need it wait: the full `ice-9 format`, `pretty-print`,
    `partcombine`'s GOOPS class as a record. So do the init's uses of a
    stub other than storing or calling it.
  - S6 and K4 replace the stubs with K4's placeholders and the "needs part
    P" restart (03 §6), behind the same triggers.

  progress.md, MS2 step 9.

## D75 — `lily.scm`'s init data loads whole; what it reaches of later files comes as their definitions or as placeholders

**Status:** accepted · **Refines:** D67, D72, D74

- **What.** MS2 step 12 loads 03 §6's init data into `(lily)` from the
  installed LilyPond 2.26.0, whole and in `lily.scm`'s order (`color.scm`,
  `define-event-classes.scm`, `define-note-names.scm`, `skyline.scm`,
  `define-music-properties.scm`, `define-context-properties.scm`,
  `breath.scm`, `script.scm`, `layout-beam.scm`, `parser-clef.scm`,
  `layout-slur.scm`, `flag-styles.scm`, `define-grob-properties.scm`,
  `define-grobs.scm`, `define-grob-interfaces.scm`,
  `define-stencil-commands.scm`), among the library files the image already
  had (`tests/support`'s `FILES`):
  - **D72's stand-ins are gone:** `define-grobs.scm` gives the grobs
    `is-grob?`, and `color.scm` loads where `lily.scm` loads it.
  - **`output-lib.scm` and `markup-macros.scm` load whole too,** where
    `lily.scm` loads them (its library list, before every data file), though
    the split put them in step 13: `define-grobs.scm`, `script.scm` and
    `breath.scm` call or store about a hundred of `output-lib.scm`'s
    procedures as they load, and make markup with `markup-macros.scm`'s
    commands.
  - **What the data reaches of files a later step loads comes as their
    definitions** (`LATER`), read from the installed files as the library's
    own definitions are: six markup commands of `define-markup-commands.scm`
    (`line`, `draw-circle`, `null`, `with-dimension-from`,
    `with-true-dimension`, `musicglyph`), `stencil.scm`'s
    `parenthesize-stencil`, `time-signature-settings.scm`'s
    `time-signature->fraction` and two of `bar-line.scm`'s callbacks. Step
    13 loads those files whole and drops them. The two of `tablature.scm`
    (`tab-note-head::print`, `::handle-ties`), which is the `fretted` part,
    are placeholders that throw until step 13's D74 stubs.
  - **The C++ callbacks of layout the files store are D67's named
    placeholders** (`crates/music/src/grob.rs`): 227 primitives with
    LilyPond 2.26.0's names and arities, as its `procedure-minimum-arity`
    gives them, that throw `not in the engine before layout (MS3)`. An
    `Extension` now gives its primitives as slices, so the music crate's
    restore is `&[PRIMS, grob::PRIMS]`.
  - **The C++ the files call as they load is in `(lily)`** (`lily.rs`):
    `ly:add-interface` and `ly:all-grob-interfaces` (a `hashq` table of
    `(name doc props)`), `ly:register-stencil-expression` and
    `ly:all-stencil-expressions` (a list, `stencil-head?` set),
    `ly:dimension?` (`number?`), and the nine predicates of C++ types the
    engine does not have yet (`ly:grob?`, `ly:stencil?`, `ly:context?` and
    the rest), false of every value. `ly:error` throws `misc-error` where
    LilyPond prints `fatal error:` and exits, and replaces `lily.rs`'
    `%session-error`. The expander gains `(ice-9 optargs)`' `defmacro*` and
    `defmacro*-public`, a `lambda*` with a rest argument skips what is not a
    keyword, as Guile's does, and `module-export!` is Guile's.
  - **The core's image no longer carries the pitch names' text,** as MS2
    step 10 made it: it is `LILYCORE` and the interpreter's image, and
    `Engine::start` takes the names from `(lily)`'s `language-pitch-names`
    (`NoteNames::of_vm`).
- **Why.** The init data is plain data, and loading it as it is keeps every
  table LilyPond's: `tools/bench/probe-data.scm` writes what the files
  define (every grob description, property type, script, clef, color and
  interface the Scheme adds) the same in LilyPond, from source and from the
  image natively and in wasm. Loading the two library files whole, in their
  place, costs less than finding and copying a hundred definitions, and
  copies of the few later definitions keep the stored procedures LilyPond's
  until their files load.
- **Consequences.**
  - The image is 1,727,827 raw and 277,017 brotli bytes (step 11: 850,093
    and 123,875), before the rest of `lily.scm`'s files and the init.
  - LilyPond's C++ registers 84 interfaces of its own (`ADD_INTERFACE`),
    which come with layout's classes; `ly:all-grob-interfaces` holds the 88
    `define-grob-interfaces.scm` adds.
  - `supported-clefs` and `c0-pitch-alist` lack `moderntab`, which
    `tablature.scm` adds when the `fretted` part loads.

  progress.md, MS2 step 12.

## D76 — `lily.scm`'s core files load whole; the parts' names are stubs that load the part from the host's source when called

**Status:** accepted · **Refines:** D74, D75

- **What.** MS2 step 13 loads the rest of 03 §6's core into `(lily)`, from
  the installed LilyPond 2.26.0, whole and in `lily.scm`'s order
  (`tests/support`'s `FILES`): `parser-ly-from-scheme.scm`,
  `file-cache.scm`, `markup.scm`, `define-markup-commands.scm`,
  `stencil.scm`, `time-signature.scm`, `time-signature-settings.scm`,
  `auto-beam.scm`, `translation-functions.scm`, `bar-line.scm`,
  `scheme-engravers.scm`, `titling.scm`, `paper.scm` and `context.scm`, with
  the modules `(lily page)` and `(lily paper-system)` that `titling.scm`
  uses. D75's `LATER` copies are gone.
  - **Left out, as 03 §6 says:** `operators.scm` (GOOPS on moments, D70),
    `midi.scm` and `scheme-performers.scm` (chapter 07),
    `font-encodings.scm` (the PostScript backend's glyph tables, chapter
    06) and `backend-library.scm` (the driver's file handling, chapter 08;
    it imports `(lily ps-to-png)`).
  - **`#{ … #}` stays the reader's** (`LilyScan`):
    `parser-ly-from-scheme.scm`'s `(read-hash-extend #\{
    read-lily-expression)` sets a flag of the VM, kept in the image, after
    which `eval_text` and `read` read `#{` as LilyScan reads it. Any other
    character is refused. Its `read-lily-expression-internal` is defined
    and needs `ly:parser-clone` (P11).
  - **The parts' stubs (D74)** are made by the image writer from a table
    it reads out of the installed part files: every name defined by
    `define-public`, `define*-public` or `define-session-public`, and a
    markup command's `name-markup` and `make-name-markup`, bound in the
    part's module (`(lily)`, or `(lily display-lily)` for `display`) to a
    procedure named as the definition. Calling one loads the part's files
    into `(lily)` with `read` and `primitive-eval`, each file once, and
    calls the definition the load bound. `lily.scm`'s `ly:load` reads
    through the same source, as `display-lily.scm` loads
    `define-music-display-methods.scm` with it. A stored stub (the
    `fretted` callbacks in `all-grob-descriptions`) forwards. **`qr`**
    (`qr-code.scm`) is a seventh part, since `define-markup-commands.scm`
    imports its `qr-encode`; `accreg.scm` is a module a score uses by name
    and has no stubs.
  - **The source of a part's files is the host's**
    (`Vm::set_part_source`), not the image's: natively the runner and the
    bench read LilyPond's `scm/lily/`. Without it a stub's call throws
    `needs <file>, which the host has not given`.
  - **What the files call of the C++ at load:** `ly:pt`, `ly:mm`, `ly:cm`,
    `ly:inch` and `ly:bp` (millimetres, as `dimensions.hh` computes them);
    `ly:make-stencil` and `ly:stencil?` over a stencil that holds its
    expression and extents (`empty-stencil`, `point-stencil`);
    `ly:register-translator`, which keeps `scheme-engravers.scm`'s 33
    translators in a table for part 3; `ly:score?` false of every value;
    `ly:text-interface::interpret-markup` a layout placeholder (D75).
    Guile's `(srfi srfi-2)` (`and-let*`), `(ice-9 list)`, `sort-list`,
    `save-module-excursion`, and `(srfi srfi-13)` and `(ice-9 control)` as
    empty modules: the engine's string procedures are in `(guile)`, as
    Guile 3's are, and `define-markup-commands.scm` uses nothing of
    `(ice-9 control)`. `music-name-to-property-table` is made beside
    `%music-properties`, for the `display` part's methods.
- **Why.** As D75: the files load as they are, so what they define is
  LilyPond's, and the function probe measures it. A stub that loads its
  part on a call keeps the part out of the image (D74), and the names that
  the core stores, such as the `fretted` callbacks, stay procedures with
  LilyPond's names.
- **Consequences.**
  - `scheme.image` is 2,414,581 raw and 369,050 brotli (step 12: 277,017),
    before the whole init (step 16), against R2's 420 KB.
  - The function probe gives LilyPond's output for 116 of the 159
    functions; 43 are recorded, each with the step or part it needs.
  - The core (wasm) has no part source yet: a stub called there fails.
    D74's `lily_put` and `lily_needs` path is step 16's.
  - A stub of a value (`*indent*`, `default-part-combine-mark-alist`) is a
    procedure too, so a use of it as data before its part loads is wrong;
    D74 records such uses. `display-lily-music` calls a stub before it uses
    `*indent*`, so it works.
  - Loading `partcombine` needs GOOPS accessors and methods (S6), and
    `qr` the `rnrs` bytevectors and `ice-9 iconv`.

  progress.md, MS2 step 13.

## D77 — Context definitions are immutable values of the music crate; init files share their session; the capture runs the init files the definitions read

**Status:** accepted · **Refines:** D71, D73, D74

- **What.** MS2 step 15 builds N3's context definitions (04 §7) where D73
  puts them:
  - **`ContextDef` is the music crate's** (`crates/music/src/context_def.rs`)
    and immutable: a definition is built from its base and the mods added
    to it in order (`make_context_def`), where LilyPond clones one and
    adds the mods to the clone, `add_context_mod` and `acceptance-set.cc`
    ported as they are. Its translators are `Translator::Class`, a C++
    class by its symbol, or `Translator::Scheme`, a procedure or an alist,
    in `get_translator_names`' order. A definition derived by a context
    modification (`ly:context-def-modify`, and part 3's `\new … \with`) is
    cached in its base by the digest of the mods, checked with `equal?`,
    so the same `\with` gives one definition. A mod of no known tag is
    LilyPond's `programming error: unknown context mod tag`.
  - **`Output_def` moves to the music crate** (`output_def.rs`): its scope,
    a module, with LilyPond's Scheme face for what context definitions
    need, `ly:output-def?`, `ly:output-def-lookup`, `ly:output-def-scope`,
    `ly:output-def-set-variable!`, `ly:output-find-context-def` and
    `ly:output-description`, and `find_context_def` for part 3. It has no
    parent yet. Context definitions and output definitions are kept in an
    image. **`ly:context-mod-apply!`** checks its context first, as
    LilyPond does, which no value is until part 3 makes contexts.
  - **The parser's stand-ins (D71) are gone:** `\context { … }` makes a
    `ContextDef` placed at the block, an output definition binds it to its
    name (`assign_context_def`) and hands its music to
    `output-def-music-handler`, and music in `\with` goes to
    `context-mod-music-handler` only. `declarations-init.ly`'s two lines
    that define the handlers are parsed as an init file of the library
    (`tests/support`'s `HANDLERS`), brought forward from step 16.
  - **Init files share a session, as they share `declarations-init.ly`'s
    module:** `parse_init` gives an init file the variables the ones before
    it recorded, and the stand-ins of the three default output definitions
    where none is recorded, and records only what it defined or changed. A
    file keeps a default the session gives (`define_defaults`). An init
    file is not warned of a missing `\version`.
  - **Brought forward for the init files the definitions read:**
    `ly:parser-define!` (step 16's), kept in a box and defined in the
    parser's innermost scope when the Scheme returns, and
    `ly:wide-char->utf-8`.
  - **The capture** (`tools/compare/contexts.ly`, run as it is by LilyPond
    2.26.0 and by the engine, `contexts.mjs`) dumps `$defaultlayout`'s and
    `$defaultmidi`'s definitions. The engine's come from
    `tests/support`'s `context_defaults`: what of `declarations-init.ly`'s
    includes they read, in its order (`drumpitch-init.ly`,
    `chord-modifiers-init.ly`, `default-fret-table`,
    `string-tunings-init.ly`, `property-init.ly`'s `\cadenzaOn`,
    `\englishChords` and `\stemUp`, `midi-init.ly` before its `\midi`,
    `context-mods-init.ly`), then `engraver-init.ly` inside
    `declarations-init.ly`'s `\layout` and `performer-init.ly` inside
    `midi-init.ly`'s `\midi`, each on its own lines, so that the places are
    LilyPond's. The parser's runner takes them with `--contexts`.
- **Why.** An immutable definition is what 04 §7 asks for, and nothing but
  `eq?` tells it from LilyPond's clones; the cache is what lets twenty
  staves share one. The output definitions go with the definitions they
  hold, as part 3's `path_to_acceptable_context` needs both. The init files'
  shared module is LilyPond's own, and without it `engraver-init.ly` could
  not use `property-init.ly`'s `\stemUp` or `context-mods-init.ly`'s
  `\EnableGregorianDivisiones`.
- **Consequences.**
  - The 79 definitions (`engraver-init.ly`'s 43, `performer-init.ly`'s 36)
    equal LilyPond's, 1,844 lines, but one: TabStaff's `Slur`
    `control-points` is `tablature.scm`'s
    `slur::move-closer-to-tab-note-heads`, an unpure-pure container of the
    `fretted` part, and so a stub until `fretted` loads (D74's stop point).
  - **The library and the image do not hold the definitions yet**:
    `$defaultlayout` and `$defaultmidi` there are the stand-ins, and the
    tests that need the definitions call `context_defaults`. D74 meets
    `engraver-init.ly` there: at load it reads `chord-modifiers-init.ly`'s
    `ignatzekExceptions` and `whiteTriangleMarkup`, which load `chords`,
    and `string-tunings-init.ly`'s `guitar-tuning`, which D74 runs when
    their parts load; `property-init.ly`'s `\englishChords` calls `chords`'
    `chord-name:markup` at load; and TabStaff stores `fretted`'s value
    above. `context_defaults` loads both parts natively. How the image's
    definitions get these is step 16's, and the user's to decide.
  - A derived definition is `eq?` to the one derived before by `equal?`
    mods, where LilyPond's are fresh; `ly:parser-define!`'s variable is
    defined when the Scheme that called it returns, not at once.
  - `context-mods-init.ly`'s `\inherit-acceptability` and
    `\enablePerStaffTiming` walk an output definition's module with
    `module-map` and `variable-set!`, which need variable objects; they are
    parsed, not run.

  progress.md, MS2 step 15.

## D78 — The image holds the whole init: `chords` and `fretted` snapshotted, variables shared by module, scores to the book handlers

**Status:** accepted · **Refines:** D66, D74, D77

- **What.** MS2 step 16 puts `declarations-init.ly` and the 21 files it
  includes into the image, run at load by the image writer
  (`crates/parser/tests/support`'s `load_library`) as one init file:
  - **`\include "file"`** (P11's, brought forward for the init files): the
    lexer lexes the file the scopes give next, under its own name
    (`Scopes::include_file`). Only `parse_init`'s scopes give files; a
    score's `\include` is still an unknown command (part 3).
  - **The user's answer on D77's question: a build-time snapshot.** The
    image writer loads `chords` and `fretted` from source before the init,
    so that `chord-modifiers-init.ly`, `predefined-fretboards-init.ly` and
    `string-tunings-init.ly` run in their places in `declarations-init.ly`
    and `engraver-init.ly` stores their values (`ignatzekExceptions`,
    `whiteTriangleMarkup`, `guitar-tuning`, `\englishChords`' markup
    procedures, TabStaff's `slur::move-closer-to-tab-note-heads`). After
    the init, every public name of the two parts is bound again to the stub
    it had, and the parts count as not loaded. The image keeps the values
    the init stored and what they reach: the stored procedures and the
    parts' private definitions they call, not the parts' public ones. A
    later load of a part runs its `.scm` files only; its init files ran in
    the image.
  - **Shared variables, not replay copies (D66):** a file's module uses the
    init file's module, searched before `(lily)`. A file's `set!` of an
    init variable changes the init's, as LilyPond's `module-add!` does, and
    `session-terminate` (lily.rs) gives every recorded variable its value
    again and runs the `call-after-session` thunks after each file
    (`lily_engine_parser::end_session`: the core's compile, the parse
    runner). `session-save` records the `define-session-public` exports as
    `define-session`'s, which `(lily)` exports to the file instead of
    LilyPond's `session-start-record`.
  - **The stand-ins are gone:** the shorthands (`SHORTHANDS`), the output
    definitions' defaults and `paper-defaults-init.ly`'s units
    (`define_defaults`). Without the init (a bare VM), an output definition
    is a new one and a shorthand is undefined, as in LilyPond without its
    init.
  - **Book handlers:** the parser hands toplevel music, scores, and a
    book's or a part's music and scores to `declarations-init.ly`'s
    handlers (`toplevel-music-handler` and the rest), and `\score` makes
    its score with `scorify-music`. `Parse::music` is gone: a file's scores
    are its `toplevel-scores` (`Parse::toplevel_scores`), after
    `toplevel-music-functions`. `Score` and `Book` are the music crate's
    (`book.rs`) with `ly:make-score`, `ly:book-add-score!` and the rest the
    handlers call. The text handlers and `toplevel-book-handler`, which
    prints the book, are not called before layout.
  - **What the init runs at load, brought forward:** `\lyricmode`'s
    syllables (P8's lexer mode, as far as `ancient-init.ly`'s `\IJ` and
    the rest; anything else in it names P8), `ly:parser-lookup` and
    `ly:parser-set-note-names` (so `\language` works), `ly:output-def-clone`,
    `module-remove!`, `(ice-9 and-let-star)`, `ly:get-option` with
    LilyPond's defaults, `ly:debug`, `ly:reset-all-fonts`, `lilypond-version`;
    `ly:optimal-breaking` and `ly:perform-text-replacements` are D67
    placeholders. A caesura takes post-events, and Guile names a lambda
    `set!` to a variable. No call at load reaches a template.
- **Why.** The user chose the snapshot over lazy stub values and over
  `chords` and `fretted` in the image: `$defaultlayout` equals LilyPond's
  whole, no property read has to check for a stub, and the image holds
  only what the init stored. Sharing the init's module is LilyPond's
  semantics and costs nothing per compile, where the replay defined 654
  variables again for each file.
- **Consequences.**
  - The image is 2,879,765 raw, 607,811 gzip -9 and 443,563 brotli
    (`core.image`): over R2's 420 KB Must by 13,483 bytes, a recorded
    miss, under the 840 KB that would be reported before part 3's split.
  - The 79 context definitions equal LilyPond's with no line recorded; the
    654 variables the init records equal LilyPond's 664 but the ten
    exports; T13's, T27's and P6's scores' tokens equal LilyPond's, and
    T08's, T09's and T18's trees.
  - A file's `define` of an init variable shadows it, where LilyPond's
    defines the shared variable; the init's code then still sees the
    init's value.
  - Music the init made has origins in init files, whose sources a parse
    does not have: the trees' dump reads the init file from `ly/`
    (`tests/support`), and a diagnostic placed there would need the same.
  - `ly:parser-lookup` reads the current module, which the parser keeps at
    its innermost scope while Scheme runs; outside a parse it reads
    whatever module is current, where LilyPond has no parser to ask.

  progress.md, MS2 step 16.

## D79 — The translator framework is a module of the music crate, with LilyPond's primitives as its only Scheme face

**Status:** accepted · **Refines:** D73

- **What.** N5's module boundary (04 §9), the user's answer at MS2 part 3's
  split:
  - **The translator framework lives in `crates/music`**
    (`lily_engine_music`), as modules beside D73's contexts and N4's
    iterators: translator classes, groups, listeners and acknowledgers,
    the timestep protocol with its wake lists, `Timing_translator`, grob
    and audio records, the Scheme translators, and the playback map's
    performer. No crate of its own, so no new row in `PARTS`: it is charged
    to *Music model* with the rest of the crate.
  - **Its Scheme face is LilyPond's own primitives and nothing else:** the
    alists of `make-engraver`, `make-performer` and `make-translator`, the
    translators `ly:register-translator` keeps (D76), and `ly:translator-*`,
    `ly:engraver-*`, `ly:context-*`, `ly:event-*` and `ly:add-listener` as
    the init, `scheme-engravers.scm`, the scores and `timing.ly` call them.
    No engine-only procedure is exported to Scheme.
  - **The playback map leaves through the core's ABI,** as
    `<name>.timing.json` among `lily_output`'s files, in `timing.ly`'s
    format (D26), and not through Scheme.
- **Why.** A context instance holds its translator group, the global
  loop drives iterators and translators in one timestep protocol, and
  events go from iterators to contexts to translators, so the three call
  each other at every timestep. In one crate they share types without a
  boundary in the middle. Charged to *Music model* either way, a crate of
  their own would only add an API between them. LilyPond's primitives as
  the only face keep `scheme-engravers.scm`, `timing.ly` and the scores'
  Scheme translators running as they are, as D73 does for contexts.
- **Consequences.**
  - The *Music model* row (420 / 290 KB raw, 160 / 110 brotli) carries N3's
    instances, N4 and N5 from part 3, and every closing step from part 3 on
    measures it with them. `sizes.mjs`' module rows for the row may name
    them as N3's does.
  - D73's consequence for a translator crate of its own does not apply.
  - Chapter 07's performers (MS4) are not decided here.

  progress.md, MS2 step 18.

## D80 — A compile asks the host for every file it lacks and parses again; LilyPond's own files are named under `<datadir>`

**Status:** accepted · **Refines:** D74, D76

- **What.** How the core gets the files a score includes and a part's
  files (MS2 step 19), through 08 §4.2's ABI as it is:
  - **A file the host was not asked for stops the compile.** `lily_step`
    returns 2 and `lily_needs` names it (kind 0). `\include` looks where
    LilyPond looks with `relative-includes`: beside the including file,
    then in the score's directory, then in LilyPond's `ly/`, asking for
    each name until the host has one; none anywhere is LilyPond's
    `cannot find file` with its search path. A part's stub asks for each
    of its part's files before any of them runs, so a part loads whole or
    not at all. Once `lily_put` gives the file (or says there is none) and
    the compile starts again, the root is parsed again from its start;
    what the stopped parse made is dropped. The studio's driver already
    starts a compile again after each answer.
  - **LilyPond's own files are named under `<datadir>`:**
    `<datadir>/ly/<file>` for an include, `<datadir>/scm/lily/<file>` for
    a part's file, as the error corpus writes LilyPond's data directory.
    The locations of their messages print the same names. The host maps
    them to LilyPond 2.26.0's files: natively `examples/compile.rs` reads
    them from disk.
  - **The stop is the interpreter's cancellation** (`Hosted::Ask`,
    `Vm::take_waiting`): it passes every `catch` of the score's Scheme, and
    the lexer then ends the input (`Lexer::waiting`).
  - **A part's own module loads the part when a file uses it**
    (`%module-hooks`, registered after the init, run by `use-modules` and
    `#:use-module` but not by `resolve-module`, which the stubs and the
    image writer call): `display`'s `with-music-match` is a macro of
    `(lily display-lily)`, which no stub can stand for, and
    `articulate.ly` uses it.
- **Why.** The parser cannot be suspended in the middle of a file, and
  making it so would change every production. Parsing again costs one
  parse up to the include per file asked for, and the files the page has
  open are put before the first step. Names under `<datadir>` cannot be a
  page's own paths, and keep LilyPond's files apart from the score's
  until K4 makes them modules.
- **Consequences.**
  - A file asked for that the page does not have costs a parse each
    candidate: a missing include asks up to three names.
  - In the studio, the page has no `<datadir>` files, so `articulate.ly`
    and the parts fail as missing until the driver answers them from the
    engine's files (K4, or before it if a step needs it).
  - A part whose file's load is stopped by another part's file it needs
    at load would be left half loaded; none of the parts does that.
  - `init.ly`'s `(use-modules (srfi srfi-1))` is now a file's, which
    `articulate.ly`'s `fold` needs. It is used before the init files'
    modules, so that their variables come first, as a file's own do in
    LilyPond (`\break` is not srfi-1's `break`).

  progress.md, MS2 step 19.

## D81 — LilyPond's regular expressions match as PCRE; what a part runs while it loads is ported; toplevel books are kept for the engine

**Status:** accepted · **Refines:** D67, D74, D78

- **What.** Three conventions of MS2 step 20:
  - **`ly:make-regex` and the `ly:regex-…` functions match as PCRE**
    (GLib's `GRegex`, which `glib-regex-scheme.cc` wraps), not POSIX: the
    first alternative and the greediest repetition that let the rest match
    win, positions are counted in characters, and an empty match moves the
    next search one character on. The matcher is the interpreter's
    (`crates/scheme/src/regex.rs`), a backtracking one over the part of
    PCRE's syntax that LilyPond's Scheme and the scores use; anything else
    is a compile error with `check_error`'s wording. `ly:regex-exec`,
    `ly:regex-exec->list` and `ly:regex-replace` are Scheme over one
    primitive, `%regex-exec`, and make `lily-library.scm`'s `<regex-match>`.
  - **A C++ function that a part calls while it loads is ported, not a
    placeholder** (D67), since a placeholder that throws would stop the
    load: `diagrams`' woodwind stencils call `ly:bezier-extract`,
    `ly:directed`, `ly:stencil-add`, `ly:stencil-rotate` and
    `ly:stencil-translate` at load, which T29's `\harp-pedal` triggers.
    They are LilyPond's: the stencil's expression and extents as
    `stencil.cc` makes them, the curve as `bezier.cc` cuts it. Their
    programming errors are not written. A C++ function that is only
    stored at parse stays a D67 placeholder: `ly:set-middle-C!`, which
    `\clef`'s `make-apply-context` stores and a context calls, until N3's
    instances.
  - **A toplevel `\book`'s book is added to the file's
    `%toplevel-books`** where LilyPond calls `toplevel-book-handler`, which
    prints it (layout's, so not called; MS2 step 16), as the toplevel
    handlers add scores to `toplevel-scores`. `Parse::toplevel_books`
    gives them in the file's order; the tree dump reads them (T17's score
    is in a `\book`), and so can the core's translation.
- **Why.** The step's line said "a POSIX extended matcher", but LilyPond
  has matched with PCRE since 2.24, and `parser-clef.scm`'s pattern and
  `define-markup-commands.scm`'s give PCRE's groups. The stencil
  primitives are small and pure; porting them now is MS3's code early, and
  splitting `diagrams` so that `harp-pedals.scm` loads alone would change
  D74's parts. The books are values the parse made that only the
  handlers' module could otherwise reach.
- **Consequences.**
  - PCRE syntax beyond the subset (look-around, named groups, inline
    flags) fails to compile until a score needs it.
  - MS3 starts with five stencil and geometry primitives it compares
    rather than writes.
  - `%toplevel-books` is a variable of each file's module that LilyPond
    does not have; a score that defines one would clash.

  progress.md, MS2 step 20.

## D82 — A part the image snapshotted keeps the image's definitions when it loads again; P10's modes are a stack of the lexer's music modes

**Status:** accepted · **Refines:** D74, D78

- **What.** Two conventions of MS2 step 21:
  - **When `chords` or `fretted` loads again after the image's init
    (D78), a `define` of a name that `(lily)` already holds a value of,
    which is no part's stub, keeps that value.** Only the parts the image
    writer loaded for the init do this (`%parts-kept`, set when it binds
    their public names to their stubs again); their public names are
    stubs and are defined anew, and the private ones keep the procedures
    and data the init's stored values already use. The image writer's
    load of them, and every load of the other parts, define every name,
    as LilyPond does.
  - **Chord, figure and drum mode are lexer modes pushed on a stack of
    music modes** (`Parser::modes`), where notes mode is the bottom: the
    parser asks for tokens in notes mode, and they are lexed in the mode
    pushed last. `\chordmode`, `\figuremode`, `\drummode` and the heads
    with a context push theirs when Bison reduces them, and so do the rules
    that push notes mode (`\notemode`, `\with { … }`, a `\with`'s music,
    music in an output definition); each pops where its rule pops it, and
    a syntax error inside leaves it pushed, as LilyPond leaves the lexer's
    state. Drum mode is notes mode with `drumPitchNames` as its only pitch
    names. `chordmodifiers` and `drumPitchNames` are read when a word is
    lexed, not copied when the mode is pushed.
- **Why.** `construct-chord-elements` compares the modifier it is given
  with `eq?` to its own `sus-modifier`. The modifier comes from
  `chordmodifiers`, which the image's init stored from the first load, so
  a second load that defined `sus-modifier` again made `c:sus4` lose its
  fourth (T05). Keeping the image's private definitions makes the second
  load what LilyPond's single load is, and costs nothing in the image,
  which holds them already. A stack of modes is how `lexer.ll` keeps its
  start conditions, and it lets every production that asks for a notes
  token stay as it is.
- **Consequences.**
  - A `define` in a snapshotted part's file whose value would differ on a
    second run (a counter, a fresh table) keeps the image's; none of the
    two parts has one.
  - A score that changes `chordmodifiers` or `drumPitchNames` inside the
    mode they serve sees the change at once, where LilyPond reads them
    again only at the next `\chordmode` or `\drummode`.

  progress.md, MS2 step 21.

## D83 — A translation's contexts share one arena with their Scheme handles; what calls Scheme runs where Rust drives the VM

**Status:** accepted · **Refines:** D73, D79

- **What.** Conventions of N3's instances, MS2 step 22 (`context.rs`,
  `override.rs`, `dispatcher.rs`, `event_class.rs` of `crates/music`):
  - **One arena per translation** (`Arena`) holds its contexts, linked by
    number, Global first, a removed one kept and marked; its dispatchers;
    its event classes; the moment; and `\once`'s finalizations. It is an
    `Rc<RefCell<…>>` shared by the translation's Scheme object, which
    traces its values, and by each context's and dispatcher's handle
    (`ly:context?`, `ly:dispatcher?`), which keeps that object alive. A
    context has one handle, made with it, so `eq?` holds. The arena is never
    borrowed across a call into Scheme, where the collector may run;
    values taken out of it for a call are rooted.
  - **What needs Scheme takes a `Host`** (the VM is one): a property's
    type check, an `apply` operation, a listener of Scheme's, LilyPond's
    warnings. It runs where Rust drives the VM, which N4's global loop
    will. A primitive cannot call Scheme (D70), so the `ly:context-*`
    primitives that check a type (`ly:context-set-property!`,
    `ly:context-unset-property`, `ly:context-pushpop-property`) are Scheme
    in `(lily)` that calls `%type-check`, LilyPond's `internal_type_check`,
    and then a `%` primitive that does not check. Rust's own checks call
    the same `%type-check`, so there is one.
  - **Event classes are numbered at build time** from
    `define-event-classes.scm` (`EVENT_CLASSES`, a class named twice kept
    where it is first, as `ly:make-event-class` finds it), and what a class
    is (it and its ancestors) is a 256-bit set. A stream event names its
    class as LilyPond's do, by `ly:make-event-class`'s list, and a class
    `define-event-class` adds is numbered when an event or a listener
    first names it.
  - **Properties are interned per translation,** a context's own kept as a
    sorted array shared until written, with a 64-bit mask; Global's and a
    context that adopts (the Score's) as a dense table.
- **Why.** Iterators, contexts and translators call each other at every
  timestep (D79): numbers into one arena avoid a heap object per link,
  and an `Rc` lets a primitive reach a context from its handle without the
  heap borrowed. LilyPond's C++ calls Scheme from inside its contexts; the
  engine's primitives cannot, so the calls go where Rust holds the VM,
  and the Scheme face keeps LilyPond's names and checks. Numbered classes
  let a Rust translator name what it hears as a constant (step 25).
- **Consequences.**
  - `ly:make-global-context`, `ly:broadcast` and `ly:make-dispatcher`,
    which would create or dispatch from a primitive, wait for N4's loop,
    which drives a translation from Rust.
  - A deprecated property (`define-deprecated-property`) is not converted:
    `%type-check` reports it as one that does not exist.
  - A class named by `ly:add-listener` before `define-event-class` defines
    it is a class of its own, without the parent given later.

  progress.md, MS2 step 22.

## D84 — Events refer to their music; the trace's recorder stands where translators will; only a traced compile translates until C1

**Status:** accepted · **Refines:** D67, D79, D83

- **What.** Conventions of N4's first part, MS2 step 23 (`iterator.rs`,
  `global.rs`, `trace.rs` of `crates/music`; the core's `compile.rs`):
  - **An event an iterator makes refers to its music** (04 §8). Its own
    properties are only what `Music::to_event` adds (`class`, `length`,
    the articulations as events, `music-cause`), handles of the music a
    frozen node holds, and what is set on it later; the music's mutable
    properties are read behind them, never copied, and a frozen node is not
    thawed. `ly:event-set-property!` puts a property in front of the music's
    rather than changing the cell LilyPond's copy shares with it.
  - **Iterators are one enum in an arena** of the translation's
    `Iteration`, one slot per music node iterated, never reused. A type's
    `iterator-ctor` names its iterator by D67's placeholder; the
    placeholders stay what Scheme gets if it calls them. Music whose
    iterator is not ported yet is iterated as simple music, which keeps its
    time, and its constructor is named in the translation's log.
  - **The translation trace's recorder is the arena's** until step 25's
    translators: contexts record `P` and `C` where the parent's translator
    group would make the new one's, and `X` where translators are
    finalized; a listener on each context's events below records `E`; the
    global loop writes a timestep's `E` lines at `OneTimeStep` and the
    Score's `X` lines at `Finish`.
  - **A compile translates only when it is traced** (`Engine::set_trace`,
    the compile example's `--trace`), until C1 needs translation (step 27):
    the scores of the `\book` blocks, then the toplevel ones, each
    `\layout` of a score (`$defaultlayout` without one), as
    `Score::book_rendering`. What the translations say goes to the output
    `trace.log`, not to `stderr`. `\midi` is not translated yet.
- **Why.** C1 and the trace compare iteration event by event, so the
  iterators keep LilyPond's protocol exactly; references keep an event at
  a few cells where LilyPond copies the music's list. The recorder in the
  arena lets the trace check N4 before N5 exists, and keeping translation
  out of untraced compiles leaves C0's stderr as it is until translators
  give LilyPond's warnings.
- **Consequences.**
  - `ly:run-translator`, `ly:interpret-music-expression`,
    `ly:make-global-context` and `ly:broadcast` have no Scheme face yet: a
    primitive cannot drive the loop (D70). `\applyContext`'s procedures,
    step 24's, are the first Scheme that broadcasts.
  - Step 25 moves the recorder's hooks to the translator groups'
    `create_child_translator`, `finalize` and the Score's timestep.

  progress.md, MS2 step 23.

## D85 — `ly:broadcast` queues until Scheme returns to the translation; an engraver group's overrides are the context's; the trace's bar starts are given until `Timing_translator`

**Status:** accepted · **Refines:** D70, D83, D84

- **What.** Conventions of N4's second part, MS2 step 24 (`iterator.rs`,
  `context.rs`, `trace.rs` of `crates/music`):
  - **`ly:broadcast` queues its event** in the arena, and the Rust that
    called Scheme from the translation (an `\applyContext` procedure, a
    Scheme listener, an `apply` operation; `context::call`) dispatches the
    queue, in order, when the call returns. A primitive cannot dispatch,
    since a listener may be Scheme (D70). Every caller of `ly:broadcast` in
    LilyPond 2.26.0's Scheme broadcasts last (`make-partial-set`,
    `make-time-signature-set`, `scheme-performers.scm`), so what listeners
    hear and when is LilyPond's.
  - **An `Engraver_group`'s `override` and `revert`** listen on the
    context's event source as handlers of the context
    (`Handler::Override`, `Handler::Revert`), connected where the parent's
    translator group makes the new context's group, for a definition whose
    group type is `Engraver_group`; a `\once`'s token is matched-popped
    with the `\once \set`s at the end of the timestep.
  - **`with_location`** is the `Host`'s `set_location` around the call.
  - **The trace's `S` lines** are written at the moments a traced compile
    is given (`Engine::set_trace_bars`, the compile example's
    `--trace-bars`), which `trace.test.mjs` takes from LilyPond's trace,
    until `Timing_translator` finds the bar starts (step 25). The
    properties translators set are named by translator in the test and not
    failed; a bar start that only a translator's moment reaches (T03's
    after its last note) is named too.
- **Why.** The queue keeps `ly:broadcast` a primitive, as LilyPond's is,
  without a Scheme face that drives dispatch; the bar starts let the
  properties that music and context definitions set be checked a step
  before the translator that finds bars exists.
- **Consequences.**
  - Code after a `ly:broadcast` in the same procedure does not yet see
    what the listeners do; none of LilyPond's reads it. A `ly:broadcast`
    outside a translation's call to Scheme is never sent.
  - Step 25 writes `S` lines where the Score's `measurePosition` is zero,
    as `trace.ly` does, and drops `--trace-bars`.

  progress.md, MS2 step 24.

## D86 — Translators are static Rust classes in groups that run only those with work; Scheme translators are held for step 26; the trace's bars are `Timing_translator`'s

**Status:** accepted · **Refines:** D67, D79, D84, D85

- **What.** Conventions of N5's first part, MS2 step 25 (`translator.rs`,
  `timing.rs`, `records.rs` of `crates/music`):
  - **A translator class is a static Rust description**
    (`TranslatorClass`): its name, whether it engraves, performs or both,
    the protocol methods it has, whether they run at every timestep, the
    event classes it hears and the grob interfaces it acknowledges by
    name, `must_be_last`, and a function that makes its state (`Work`).
    `CLASSES` lists LilyPond 2.26.0's 128 C++ classes (`ADD_TRANSLATOR`):
    `Timing_translator`, and 127 placeholders of chapters 05 and 07 (D67),
    named, with no methods and no state. A translation may add classes of
    its own (`run_translator_with`), which its names find first: the tests'.
  - **A group per context** is made when the parent's group hears the
    new context's `AnnounceNewContext`, as `create_child_translator` does;
    Global's is made by `run_translator` (`ly:make-global-translator`).
    Its translators are the definition's `consists` after the context's
    `\with`, in LilyPond's order, those of the other output filtered out. A
    name is looked up in the classes before the translators
    `ly:register-translator` keeps (LilyPond has one table, where a Scheme
    registration of a C++ name would replace it); one found in neither is
    warned of twice, as LilyPond does.
  - **Only translators with work run.** A timestep's method is called on a
    translator whose class runs always, or which is awake: it heard one of
    its events or acknowledged a grob in the timestep, or asked to stay
    awake (`Tx::stay_awake`) in the one before. `initialize` and
    `finalize` are called on every translator that has them. A class that
    resets state in `start_translation_timestep` runs always or keeps
    itself awake.
  - **A Scheme translator** (a procedure, an alist, or a name registered by
    `ly:register-translator`) is held in its group in its place and is not
    run, made or filtered by output until step 26.
  - **A method runs on its state taken out of the arena,** with what
    `Work::values` gives rooted (D83); a method that makes a value and then
    calls Scheme roots it first.
  - **Grob and audio records** are numbers in the translation's
    `Records`; grob interfaces are numbered per translation as they are
    first named, and a grob's are a 256-bit set. A translator's
    acknowledgers for a grob are called in the order its class lists them,
    where LilyPond follows the grob's list of interfaces.
  - **The Scheme face** is `ly:translator?`, `ly:translator-context`,
    `ly:translator-name`, `ly:translator-description` and
    `ly:get-all-translators`. A class's creator is a new object each time
    `ly:get-all-translators` is called, where LilyPond's is one object; its
    description has the class's events and properties, and no
    documentation or grobs (chapter 05's).
  - **The trace's `S` lines are written where the Score's
    `measurePosition` is zero**, after the Score's
    `stop_translation_timestep`, and `--trace-bars` is gone (D85). The
    trace log's lines carry their location, `file:line:column:`, as
    LilyPond's do.
- **Why.** 04 §9.1: static classes are called directly, without
  LilyPond's per-translator Scheme hops, and waking only translators with
  work is where translation saves most; LilyPond's order and filtering are
  kept so that the traces and C1 compare. Holding Scheme translators keeps
  the groups' order right before step 26 runs them.
- **Consequences.**
  - All 14 scores' timing properties and bar starts equal LilyPond's, with
    the timesteps `Timing_translator` asks for (T03's after its last note,
    the fixture's within a whole rest and a half note).
  - Step 26 makes and runs the Scheme translators in their places, with
    the same wake rules, and filters them by `is-midi` and `is-layout`.
  - A creator compared with `eq?` across two calls of
    `ly:get-all-translators` differs; nothing in LilyPond's Scheme does so.

  progress.md, MS2 step 25.

## D87 — Scheme translators run as `Scheme_engraver` in their groups; built-in performers write the playback map, and every compile translates its performances

**Status:** accepted · **Refines:** D26, D79, D84, D86

- **What.** Conventions of N5's second part, MS2 step 26
  (`scheme_translator.rs`, `playback.rs` and `translator.rs` of
  `crates/music`; the core's `compile.rs`):
  - **A Scheme translator is `Scheme_engraver`'s wrapping of an alist.**
    An item of a definition's `consists` that is a procedure, or a name
    `ly:register-translator` keeps (`scheme-engravers.scm`'s 33), is called
    with the context, and a list it gives is wrapped: its methods, its
    listeners by event class (connected in the alist's reverse order), its
    acknowledgers and end-acknowledgers by interface (an interface named
    twice keeps the last), `is-midi`, `is-layout` (true unless `is-midi`)
    and `must-be-last`. A group's slot carries its methods and whether they
    run always, for a class and a Scheme translator alike: a Scheme
    translator with a timestep method runs always; one of listeners and
    acknowledgers only, when they are called. Its handle prints as
    `#<Translator Scheme_engraver >`. `scheme-engravers.scm` runs as it is,
    in Scheme, until MS3.
  - **What a Scheme engraver does with grobs is records.**
    `ly:engraver-make-grob` makes a grob record of the context's definition
    of the grob (`Grob_property_info::updated`) with its `meta`'s
    interfaces, announced as `Engraver::announce_grob` does; its handle is
    `ly:grob?` and prints as `#<Grob TextScript >`.
    `ly:engraver-announce-end-grob`, `ly:grob-set-property!` (unchecked)
    and `ly:grob-property` (what was set, else the definition's, a callback
    not called) work on it; a Scheme acknowledger is given the grob's
    handle and the handle of the translator that made it.
    `ly:breathing-sign::set-breath-properties` is ported in Scheme. The rest
    of the grob face is MS3's.
  - **Stream events are `equal?` as `Prob::equal_p`**, `origin` skipped,
    which `listener->once-listener` relies on.
  - **A score's `format` is `(ice-9 format)`'s**, and `(lily)`'s is
    `simple-format`, as in LilyPond's Guile, where loading `(ice-9 format)`
    replaces the root module's.
  - **The playback map's performers are built in.** In a `\midi`
    translation (`run_performance`), a context whose definition is named
    `Score`, `Staff` or `Voice` gets `Lily_playback_performer`,
    `Lily_playback_staff_performer` or `Lily_playback_voice_performer`,
    last in its `consists`, where `timing.ly`'s `\consists` puts its own.
    They record what `timing.ly` records, events, bars and staves, and the
    Score's `finalize` writes the performance's JSON as `timing.ly` does. A
    file's name that is not absolute is made so with `/`: the engine has no
    current directory, so it is the root of the host's names, and
    `ly-getcwd` is empty.
  - **Every compile translates its performances.** Each score's `\midi` is
    translated, a score without one given `$defaultmidi` (and
    `$defaultlayout` before it if it has no output definition), as
    `capture.ly` gives it; the maps go out as `<name>.timing.json`, `<name>`
    the root's base name without `.ly` (`ly:parser-output-name`), through
    `lily_output`, after `stderr` and `diagnostics.json`. What a
    performance says goes to no output, so `stderr` stays the parser's and
    a traced compile's `trace.log` the `\layout` translations'. `\layout`
    is still translated only in a traced compile (D84).
  - **A file the score's Scheme writes is an output** by its name
    (`with-output-to-file`, `call-with-output-file`, kept in
    `%written-files`), in place of the engine's own of that name.
    `Engine::set_playback(false)` (the compile example's `--no-playback`)
    leaves the built-in performers out, so that `timing.ly` included
    unchanged writes the map itself: G8's check.
- **Why.** 04 §9.2–§9.3 and D79: Scheme translators keep LilyPond's
  semantics and wake rules without a Scheme face of the engine's own, and
  the playback map needs no Scheme per event. Records keep the grobs a
  Scheme engraver makes for MS3 without chapter 05's grobs. Matching the
  definitions by name, not changing `$defaultmidi`, keeps the parse as it
  is. Keeping a performance's messages out of `stderr` keeps C0 where it
  is until the `\layout` translation runs in every compile, since LilyPond
  prints each translation's warnings.
- **Consequences.**
  - The 14 scores' maps equal LilyPond's whole (C1 = 1.0), and so do
    `timing.ly`'s own in the engine (G8).
  - A definition copied from `Staff` under another name (`\name`) gets no
    staff performer, where `timing.ly`'s `\consists` would be copied with
    it.
  - Grobs of the C++ classes are not made before MS3, so a Scheme
    engraver's acknowledgers hear only grobs Scheme made: T15's
    acknowledger lines and repeated `process-acknowledged` calls are
    missing from its log.
  - A translation's warnings reach `stderr` only once the `\layout`
    translation runs in every compile (step 27 or MS3).

  progress.md, MS2 step 26.

## D88 — A budget missed on a device by more than twice gets a step in the next part; the tablet's first restore and T29's first parse get one each in part 4

**Status:** accepted · **Refines:** D56

- **What.** The user's answer to MS2 step 28's two new misses on the Android
  tablet, asked before part 4's split:
  - **A rule for the budgets measured on a device** (the first full parse,
    translation, restore, the heap after init and its pause, speed and the
    collector): a miss of a Must by more than twice, at its median over a
    closing step's visits, gets a step in the next part. The split writes
    the step and names its lead, the one the closing step's measurements
    point at; it asks the user only when they point at none. The next
    part's closing step measures it again. A miss by less than twice is
    recorded and nothing more, unless the user asks for a step. D56's s7
    point (the interpreter's size, one application) and the image's rule
    in *The plan* (over 840 KB brotli reported to the user) are unchanged.
  - **The first restore in a fresh worker gets a step in part 4,** by the
    rule: 76.5–121.8 ms on the tablet, median 102.5 against 50 ms Must
    (2.05 times). Its lead is **a cheaper first restore**: what a fresh
    worker pays over a warm restore of the same image (26.6–37.8 ms,
    within Must), not a smaller image.
  - **T29's first full parse gets a step in part 4,** by the user's word
    though under twice: 243.6–246.2 ms against 150 ms Must (1.62–1.64
    times). Its lead is **all of a part's files asked for at the first
    stop** (step 20's open item): two of its four parses fewer, about 80
    ms, leaving its last parse alone (165 ms) about 1.1 times over, which
    stays a recorded miss. A faster parse gets no step.
  - The other misses stay recorded, with no step: the first collection in
    a fresh worker (1.30–1.87 times), 346 ns per application (1.73), b5's
    pause (1.37), T29's translation over Goal (1.05), the image (1.067)
    and the driver row (1.064 raw, 1.18 brotli).
- **Why.** The first restore is the first miss on a device by more than
  twice that is not D56's s7 point, and *The plan* had a rule only for the
  image's. Twice is the roadmap's line between a miss and a problem, and a
  standing rule spares each split the question. The warm restores in fresh
  workers are within Must, so the gap is the first restore's own cost and a
  smaller image would leave most of it. Asking for a part's files at once
  was already carried from step 20 and is the largest single saving in
  T29's parse.
- **Consequences.**
  - Part 4's split writes the two steps among its own, and MS2's closing
    step measures both on the tablet as step 28 did.
  - A later closing step that finds a device miss by more than twice lists
    it with its lead for the next split, not as a question.
  - T29's first parse may still miss its Must by about 1.1 times after
    its step; that is recorded and gets no further step unless the user
    asks.

  progress.md, MS2 step 29.

## D89 — A stop asks for all of a part's files; the same compile started again goes on through what it asked before parsing again

**Status:** accepted · **Refines:** D76, D80

- **What.** How the needs loop asks the host for files (MS2 step 30),
  through 08 §4.2's ABI as it is:
  - **A compile's asked names are a queue.** A part loaded by a stub's
    call (D76) or by its module (D80) asks, through `%part-sources`, for
    every file of the part not given yet, and only then cancels the run;
    an `\include` still asks for one name, the first it lacks, as the
    search finds the next candidate only once the host has said there is
    none.
  - **One name a stop of `lily_step`, one parse a queue.** After a stop,
    `lily_step` returns 2 (`NEEDS`) for each queued name the host has not
    put yet, one per `lily_needs`, with no parse between them; it parses
    again only once the host has put them all (or said there is none). So
    a part costs one parse more, not one a file: T05 and T29 parse twice,
    not four times.
  - **The same compile started again keeps the queue:** `lily_compile`
    with the revision and root of the compile that stopped, as the
    studio's driver and the tools start it after each answer, goes on
    through the names its stop asked for. Another revision or root drops
    the queue and starts the compile afresh. `lily_compile` now reads its
    revision, which it was given and ignored before; its signature is
    unchanged.
  - **`lsb_parses`,** beside the ABI as `lsb_times` is, gives how many
    times the last compile parsed its root (`Engine::parses`), for
    `tools/compare/core.mjs`; the compile example's `--time` prints the
    stops after the names asked.
- **Why.** D80 parses a compile again after each name it asks for, and a
  part's files were asked one at a time, each from a parse that stopped at
  the same place: T29's three diagrams files cost three parses of 6–7 ms
  in Node's wasm, about a third of its first full parse. A part's files
  are known as soon as one of them is wanted, and a part loads whole or
  not at all (D76), so nothing of the parse depends on asking for them one
  by one. Keeping the host's side one name a `lily_needs` leaves the
  studio's driver, which answers a name and starts the compile again,
  unchanged (K2's stop point).
- **Consequences.**
  - A host that starts the compile again with a new revision after each
    answer loses the saving, though it still compiles: it parses again
    and is asked for the rest of the part, one stop each, as before.
  - An include's search still stops once a candidate: T19's
    `articulate.ly` asks two names at two stops, then the display part's
    two at one.
  - A host that says it has none of a part's files is still asked for
    the rest of the part at the same stop; the part then fails as D76
    says.

  progress.md, MS2 step 30.

## D90 — The restore's code is written for V8's first tier; the engine's start evaluates no Scheme

**Status:** accepted · **Refines:** D88

- **What.** How an image is read (MS2 step 31). The image's format, its
  writer, 08 §4.2's ABI and the studio's driver are unchanged:
  - **No call a value.** `ImageReader`'s readers (`take`, `u8`, `bool`,
    `u32`, `i32`, `u64`, `f64`, `value`, `count`, `bytes`, `str`) are
    `#[inline(always)]`, so the loops that read with them hold them;
    `values` and a template's instructions are each taken as one slice
    and decoded in a plain loop (`load_op` decodes nine bytes).
  - **One pass a chunk.** An arena's chunk makes each slot once, read if
    its live bit is set, else `T::default()`, where it was filled with
    defaults and then read into. Its free lists are made from the live
    bits a word at a time, in the same order (the lowest index pops
    first), in a sweep's `relist` too.
  - **The expander's aliases built at once,** collected into their
    `BTreeMap` from the pairs, which are written in their keys' order,
    not inserted one by one.
  - **`lily_start` evaluates no Scheme:** `NoteNames::of_vm` reads
    `(lily)`'s `language-pitch-names` from its slot (`Vm::slot`, which
    finds it as `(@@ (lily) language-pitch-names)` does), not through
    `eval_text`.
- **Why.** Step 31's probe (`restore.html`) found that a fresh worker's
  first restore pays V8's lazy compilation of each function it calls
  (≈ 22.9 of its 44.6 ms over a warm restore, in desktop Chromium with 4×
  CPU throttling) and runs in V8's first tier, Liftoff (≈ 22.8). Liftoff
  runs a function called once, the restore's loops, to its end, and
  calls each small function out of line, an `Option<u64>` returned
  through the shadow stack; at opt-level `z` LLVM had inlined none of the
  readers. Compile hints, the only way to ask for another tier, are not
  shipped. So the restore itself has to call less and run less. The
  pitch names took the reader, expander and compiler, compiled lazily,
  to read one variable.
- **Consequences.**
  - Code on the restore's path is written for Liftoff: no call per value,
    a slice decoded in a loop. A new loader reads with the inlined
    readers.
  - **The first compile pays what the start no longer does:** its Scheme
    compiles the reader, expander and compiler lazily. In Node the first
    compile of T01 after a start takes 2.07 ms more (14.29 against
    12.22); the start and that compile together take 26.15 against
    29.95 ms, and the start alone 11.81 against 17.73.
  - The restored heap is the same: `scheme.image` restored by the old
    and the new code and written again gives the same bytes. Its layout
    in memory differs: a template's instructions are allocated at their
    size, and the first restore grows the memory by 11,141,120 bytes,
    not 11,075,584.
  - `core.wasm` is 10,736 bytes larger raw (1,030,707) and 2,580 brotli
    (341,125), for the inlined readers.

  progress.md, MS2 step 31.

## D91 — Lyrics mode is a music mode of the parser's stack; `\addlyrics` makes its music where Bison reduces it

**Status:** accepted · **Refines:** D69, D82

- **What.** How the parser reads lyrics (P8, MS2 step 32):
  - **Lyrics mode is one of D82's music modes.** `\lyricmode` and
    `\lyrics` are heads of `mode_changed_music`, as P10's are: they push
    lyrics mode before the music's first token is lexed, and `\lyrics`
    makes `\new Lyrics` of the music with its `\with`s. `\addlyrics` and
    `\lyricsto` push it by `lyric_mode_music`'s mid-rule action, once the
    token that tells a `MUSIC_IDENTIFIER` from braces is lexed in the
    mode before; a token that starts neither is a syntax error with the
    mode left pushed, as LilyPond leaves it. The lists of lyrics mode are
    notes mode's (`music_list`), so anything music may be is read there;
    a word, a string, `\markup` or Scheme markup is a syllable
    (`lyric_element_music`), and a syllable as a function's argument is
    pushed back as a `LYRIC_ELEMENT`. The list of syllables part 2
    brought forward for `ancient-init.ly` and T02 is gone.
  - **`\addlyrics` makes its music where Bison reduces `new_lyrics`,**
    not where the music is handed on (D69): `add-lyrics`, native in
    `crates/music` beside the other constructors, takes a voice name from
    LilyPond's `get-next-unique-voice-name` when it needs one, a session
    variable's count, and the count must go in the file's order, which
    the reductions are. Its music then stands in the syntax as a music
    value. `\addlyrics` binds to the `basic_music` or the
    `contextable_music` just before it, a function's music argument
    included, as `ADDLYRICS`' precedence over `COMPOSITE` makes it.
- **Why.** LilyPond's lyrics mode differs from notes mode only in its
  lexer and in what a word means, which D82's stack already expresses;
  reading its lists by their own rules would duplicate `music_list`.
  `add-lyrics` is the one syntax constructor so far whose result depends
  on an order of calls (the unique voice names), and making music at the
  hand-off points builds it in the tree's order, not the file's: an
  `\addlyrics` inside a function's music argument, made at the call,
  would be named before one that ends before the call.
- **Consequences.**
  - A word of lyrics mode is its text with `_` made spaces wherever the
    grammar reads a word: as a syllable, an argument, and a key of a
    property path, where a word with `.` or `,` is split as
    `try_word_variants` splits it (`\override LyricText.color` in lyrics
    is one word).
  - A string's syllable is placed at its token's location, its closing
    quote, as LilyPond places it (T30).
  - `\lyricsto Type = id` is still P12's (MS8).

  progress.md, MS2 step 32.

## D92 — A template is parsed inside the procedure that runs it, through the interpreter's host call; each parse publishes itself as `%parser`

**Status:** accepted · **Refines:** D70, D80

- **What.** How `#{ … #}` templates run (P11 part 1, MS2 step 33), by
  `parser-ly-from-scheme.scm` as it is:
  - **The interpreter calls its host from a primitive.** `(%host-call
    what arg …)`, a primitive of `(lily)`, returns to the loop, which then
    calls the host's function (`Vm::set_host`, not in the image) with the
    whole VM and the arguments, still on the stack and so rooted; its value
    is the call's, and its exception the call's. The host may run the VM
    again (`Vm::apply` is reentrant). A run it leaves waiting for the host
    (D80) cancels the caller's too. A primitive of another crate gets only
    the `Cx` and still cannot call Scheme (D70): the host does, after it.
  - **The parser is that host.** `ly:parser-clone`,
    `ly:parse-string-expression`, `ly:parser-parse-string`,
    `ly:parser-has-error?` and `ly:parser-clear-error` are Scheme in
    `(lily)` that checks its arguments as `LY_ASSERT_TYPE` does and calls
    `%host-call`; each `Env` sets the host.
  - **Each parse publishes itself, as LilyPond's `f_parser` fluid.** An
    `Env` makes a `Lily_parser` value and makes it `(lily)`'s `%parser`
    while it lives, giving back the one before when it ends; it holds the
    scopes, kept as they change, and the parser sets in it, before it runs
    Scheme, its default duration and tremolo, its pitch names' language
    and whether it has an error. `ly:parser-clone` copies it with the
    closures and the location it is given.
  - **A template's parse** reads the clone's text as a source of its own,
    its lines numbered from the template's (`set_line`), and numbered apart
    from the files of the parses that run it (from 0x8000, 0x100 a depth);
    a `#` or `$` form at a byte of the closures is read for its end and
    its closure called in its place (`closures_`); music is placed at the
    clone's location (`override_input`). Its messages go to the running
    parse among its Scheme's (`%diagnostics`): placed in the template's
    text, or, at an `Input` of a running parse's, placed by that parse.
    Its error is the clone's: the running file fails by `error in #{ ...
    #}`, which `read-lily-expression-internal` reports at the call. Its
    tokens, when recorded, follow the running parse's, indented, before
    the names of what an unread lookahead pushed (`scheme?`), which Bison
    reads after the call it reduces.
  - **Templates nest 64 deep;** a 65th is Guile's `Stack overflow`.
  - **`(*location*)` of a `#` or `$` form is empty, at the byte after its
    sign,** as `eval_scm_token` steps the token's `Input` forward; it was
    the form's extent, which only a template's music shows.
- **Why.** LilyPond's own Scheme calls the parser from inside a running
  procedure, a music function's body most often, so the parse must run
  while that procedure's frames wait; the loop can reenter where a
  primitive cannot. A closure called in place of the form read again keeps
  the template's lexical environment, as LilyPond keeps it, and the
  macros' quasi-quotation that LilyPond's comment gives as the reason. The
  parser borrows the VM, so it cannot be a Scheme value itself; a value it
  keeps current is what Scheme can reach, as the fluid is. A template's
  text is named by the file it is in, so an `Input` of that file and one of
  the text would share a name and a number. LilyPond's depth is its C
  stack's, which ends in a crash; a worker must not trap: 64 deep runs in
  `core.wasm` and natively on a 1 MiB stack (about 100–150 do natively).
- **Consequences.**
  - The image holds the definitions and the new primitives (`%host-call`,
    and the music crate's `ly:number->string`, which T23's template calls),
    so the primitives after them are numbered anew; the host is set at
    each parse.
  - `NoteNames` shares its tables (`Arc`), so that a clone carries the
    running parse's.
  - A clone given no location (`(ly:parser-clone)` alone, as
    `music-functions.scm`'s `-dfirst` and `-dlast` call it, and
    `ly:parser-parse-string`) places its music in its own text, whose
    source ends with its parse: a message at that music later has its
    place and no excerpt. No score of the 30 does it.
  - `ly:parser-clear-error` of the running parse clears what it published,
    not its failure (`init.ly`'s `expect-error`, which the engine does not
    run).
  - An `\include` in a template's text finds no file: a clone has no
    host's files (D80's `include`).

  progress.md, MS2 step 33.

## D93 — A call cut short by `\etc` is read as Bison reads it and made by `ly-syntax-constructors.scm`'s own constructors, defined in `(lily)`

**Status:** accepted · **Refines:** D69, D92

- **What.** How `\etc` is parsed and what it makes (P11 part 2, MS2 step
  34):
  - **The parser reads a call that may be cut short with `etc`.** Where
    `partial_function` may stand (an assignment's value; after `\override
    path =`, `\set path =` and `\repeat kind [count]`; as a call's last
    argument), a music, event or Scheme function's call, those property
    operations, `\repeat` and a direction are read one argument at a time;
    an `\etc` where an argument is due ends the call, not taken, and the
    last argument may itself be such a call. A call read in full goes on as
    the ordinary reading of the same tokens. Each call cut short is Bison's
    `(function . arguments)`, the arguments last first, ending in `#f`
    after one that was rejected; the calls go to `partial-music-function`,
    after a direction `create-script-function`'s and, before markup cut
    short, `partial-text-script`'s first. Markup cut short (`\markup` and
    heads, then a command whose arguments end at `\etc`) gives
    `partial-markup`'s markup function, as an assignment's value, an
    argument, `\set`'s or `\override`'s value, and `\markup name = …`.
  - **What `\etc` makes is LilyPond's Scheme.** `partial-music-function`,
    `music-function`, `music-function-chain`, `partial-text-script`,
    `create-script`, `create-script-function`, `repeat`, `property-set`,
    `property-override` and `partial-markup` are defined in `(lily)` from
    `ly-syntax-constructors.scm` as they are, after `lily.scm`'s files,
    whose `define-syntax-function` they use (`tests/support`'s
    `CONSTRUCTORS`), and so are in the image. The parser's own calls of
    those constructors stay the music crate's (D69): the Scheme ones run
    only in the functions `\etc` made, when they are called.
  - **A lookahead put back records its pushes when it is read again.** A
    function's `scheme?` and `EXPECT_NO_MORE_ARGS`, recorded after its
    token, move to where the token is read again once the parser puts it
    back (`MYBACKUP`), as Bison reads them; a template run before that
    comes before them (D92).
- **Why.** Bison decides between a call and one cut short by the token
  after the arguments; reading the arguments as ever and deciding at that
  token keeps one reading of each token, and Scheme is not run twice. The
  function made must call its calls as LilyPond's does at every later call
  (the signature's tail, the calls copied at each call with `(*location*)`,
  the chain folded with its checks), which is LilyPond's own Scheme; a
  native port would need a music function whose procedure is a Rust
  closure over Scheme values, for no gain. These are LilyPond's procedures,
  not the engine's (D79).
- **Consequences.**
  - `(lily)` exports names that LilyPond keeps in `(lily
    ly-syntax-constructors)` (`repeat`, `music-function`, `property-set`,
    …), as `composed-markup-list` already was: a score's Scheme reaches
    them in the engine and not in LilyPond. None of the 30 does.
  - A template is read with `etc` where it begins with a music function,
    `\override`, `\set` or `\repeat` (`embedded_lilypond`'s
    `identifier_init_nonumber`); one that begins with a direction or an
    event function is read as post-events, and its `\etc` is a syntax
    error. No score of the 30, nor `syntax.ly`, has either.
  - P12's `DURATION_IDENTIFIER` is brought forward: a duration's value is
    one, read where an `UNSIGNED`'s duration is (`syntax.ly`'s `c\dur`).

  progress.md, MS2 step 34.

## D94 — Grace time is iterated by LilyPond's grace iterator, and `Grace_engraver`, which makes no grobs, is ported whole; traces are captured for all 30

**Status:** accepted · **Refines:** D67, D84, D86

- **What.** N6's first part, MS2 step 35 (`iterator.rs`, `grace.rs` of
  `crates/music`; `tools/compare/trace.mjs`):
  - **The grace iterator is a kind of N4's music wrapper**
    (`Wrap::Grace`), as `grace-iterator.cc`: its child is processed at the
    grace part of the moment less the music's grace start, as its main
    time; its pending moment is the child's main part moved into grace
    time at main 0; and when the moment goes into or out of grace time it
    sends `GraceChange` from its child's context first. The global loop
    and the sequential iterator's look-ahead already kept grace moments
    (step 23); `\acciaccatura`, `\appoggiatura`, `\slashedGrace` and
    `\afterGrace` are `music-functions-init.ly`'s, run as they are.
  - **`Grace_engraver` is ported whole** (`grace.rs`), the first class of
    chapter 05's engravers taken out of D67's placeholders: it makes no
    grobs. When grace time begins in its context it pushes each override
    of `graceSettings` (`(context grob property value)`) in the nearest
    context of that name at or above its own, with the type check of
    `\override`, or gives LilyPond's programming error; when grace time
    ends it pops them by their cells (`matched_pop`), newest first. It
    looks at its `initialize`, at each `GraceChange` and in
    `process_music` when the moment has changed since it last looked, so
    its class runs at every timestep (D86's `always`). It hears
    `GraceChange` on its context's events below, as every class does
    here, where LilyPond's listens on the context's event source: the
    same in the bottom contexts LilyPond's definitions put it in.
  - **The trace references are captured for all 30 scores** (`trace.mjs`'
    `SCORES`, its default), into `$LILY_CORPUS/ref/<ID>/trace.tsv`, never
    committed. `TRACED` names the scores whose traces and playback maps
    the engine's tests compare with LilyPond's (`trace.test.mjs`,
    `c1.test.mjs`): part 3's 14 and the grace scores T09, T12 and T22.
    Each later step of N6 and N7 adds the scores it brings to equality;
    step 40 makes it the 30. Overrides stay out of the trace (D84): a
    fixture (`fixtures/grace.ly`) writes the `graceSettings` it reads with
    `\applyContext` to a file, which is compared with LilyPond's.
- **Why.** The step's line asks for `graceSettings` pushed and popped where
  LilyPond does it. Nothing in the gate reads them before MS3 (overrides
  are no trace line, and a performance has no engravers), but a
  placeholder would give MS3's grace grobs the main notes' settings, and
  the class has no grob and calls no callback of a later milestone, so
  porting it whole is about a hundred lines and no guess. It runs at every
  timestep because LilyPond's `process_music` finds the grace time a
  voice with no grace notes is in while another voice has some (its
  settings pushed till its next timestep); keeping it asleep would change
  that. T29's translation natively was unchanged by it (median 11.569 →
  11.601 ms, progress.md).
- **Consequences.**
  - A chapter 05 or 07 class that makes no grobs or audio items may be
    ported whole when a step's line needs what it sets; one that makes
    them stays D67's placeholder, but for the parts a step's line names
    (step 39's melisma properties). `Grace_auto_beam_engraver`,
    `Grace_beam_engraver` and `Grace_spacing_engraver` stay placeholders.
  - `Grace_engraver` is an engraver, filtered out of a performance's
    groups: only a `\layout` translation (a traced compile, D84, D87) runs
    it.
  - A grace timestep is a timestep of its own in every context, so the
    grace scores' translations take longer than before, when graces were
    simple music iterated in main time (T09's natively 0.242 → 0.327 ms).

  progress.md, MS2 step 35.

## D95 — `\change` is LilyPond's change iterator, over iterators that know their parents; a later translator's property may be named for one score

**Status:** accepted · **Refines:** D67, D84, D94

- **What.** N6's second part, MS2 step 36 (`iterator.rs` and `context.rs`
  of `crates/music`, `assign.rs` of `crates/parser`;
  `tools/compare/trace.mjs`, `test/trace.test.mjs`):
  - **`\change Type = id` is iterated by LilyPond's change iterator**
    (`change-iterator.cc`), a kind of N4's simple iterator
    (`Simple::Change`). When it is processed it finds the context of the
    type above its own (`find_context (UP)`) and the one of that type and
    id near it (`find_context (CENTER)`), or gives LilyPond's warning
    (`cannot find context to change from: Type`, `… to: Type = id`) at the
    music's origin. Then, over each iterator of its scope in preorder, an
    iterator whose context is the first takes the second as its own
    (`substitute_context`), and one whose context is below the first has
    the branch below it moved to the second by a `ChangeParent` event
    from that branch, at the music's origin, unless it is below the second
    already. The context hears it as it has since step 22
    (`change_parent`): it leaves its parent and is added last to the new
    one, its `init_mom` the moment of the change.
  - **An iterator knows the iterator that made it** (`parent_`), so the
    scope is `where_tagged`'s: with a `change-tag` symbol, the nearest of
    the iterator and its ancestors whose music's `tags` (the nearest set)
    hold it, else the change iterator itself. `preorder_walk` goes down
    the live children: a sequence's current element, a simultaneous
    music's children, a wrapper's child.
  - **`find_context (CENTER)` is `unchecked_find`'s** in `FIND_ONLY`
    mode: below, then above, then the walk down from each context above,
    which finds a sibling staff. Before, the arena's stopped after the
    second; nothing asked it for `CENTER` until `\change`.
  - **`identifier_init` takes `context_change`** (`music_assign`'s
    `simple_music`): T25's `csh = \change Staff = "high"`, defined before
    the token after it is lexed, as LilyPond 2.26.0 does it (a `\csh` on
    the next line is known).
  - **`TRACED` gains the `\change` scores whose music has no volta
    repeat**, T11, T25, T26 and T27 (D94's list grows by the scores a step
    brings to equality). `trace.test.mjs` names the properties later
    translators set by the translator: `Stem_engraver`'s
    `stemLeftBeamCount` and `stemRightBeamCount`, which it unsets after
    `\set` sets them, and the ottava's `middleCOffset`. A property that a
    later translator sets in one score while the engine's own setters of
    it are compared in the others is named for that score only
    (`TRANSLATED_IN`): T25's `middleCPosition`, which its `\ottava`'s
    engraver sets and `\clef`'s Scheme sets in the engine.
- **Why.** The step's line asks for the change iterator as LilyPond's,
  finding the contexts up and down the tree and moving the voice's context
  in the arena. LilyPond's scope is the iterator tree's, which the
  engine's arena of iterators lacked only in its parent links; a field
  and a walk are less than any special case for the untagged `\change`
  the scores use, and the tagged one is what `\autoChange` and
  `\partCombine` send once their GOOPS loads. The arena's `find_context`
  was half of `unchecked_find`, enough for `UP`; `\change Staff = two`
  from inside staff one found nothing until it was whole. Naming
  `middleCPosition` for every score would hide a wrong `\clef` in the
  others, which set it through the engine's own Scheme.
- **Consequences.**
  - T11, T25, T26 and T27 trace as LilyPond's, but what later translators
    set, and their C1 = 1.0 with their maps equal, natively and through
    `core.wasm`. T24's `\change`s inside its `\repeat volta` wait for
    step 37's iterator; its lines after the repeat are LilyPond's but the
    repeat's end events.
  - Every iterator holds its parent's number from when it is made, a
    field more an iterator.
  - The lyric combine iterator (step 38) will take part in the walk as
    LilyPond's does, its own `substitute_context` and its lyrics'
    iterator among its children.

  progress.md, MS2 step 36.

## D96 — Volta repeats are LilyPond's three iterators and repeat styler; `Repeat_acknowledge_engraver` is ported; `ly:expect-warning` is kept in its place among the diagnostics

**Status:** accepted · **Refines:** D67, D84, D87, D94, D95

- **What.** N7's first part, MS2 step 37 (`iterator.rs`, `volta.rs`,
  `translator.rs` and `warn.rs` of `crates/music`; `diag.rs`, `scheme.rs`,
  `embedded.rs` and `lib.rs` of `crates/parser`; `compile.rs` of
  `crates/core`; `tools/compare/trace.mjs`, `test/trace.test.mjs`):
  - **`\repeat volta` and `\repeat segno` are a kind of N4's sequence**
    (`SeqKind::Repeat`, `volta-repeat-iterator.cc`) that owns its
    repeat styler (`repeat-styler.cc`): volta, segno, or null inside
    `lyric-combine-music`. Processed the first time, it reports its start
    with the span of its time in the score (`VoltaRepeatStartEvent`, or a
    segno mark); once it has ended, its return (`VoltaRepeatEndEvent` or
    `DalSegnoEvent`) unless its alternatives reported one. Its elements
    are `make-volta-set`'s, its body and an `\alternative`, as before.
  - **`\alternative` is a kind of sequence too**
    (`SeqKind::Alternatives`, `alternative-sequence-iterator.cc`) that
    uses the styler of the nearest folded repeat above, a null one if
    none. The first time it is processed it finds how its alternatives
    are presented (aligned with the repeat's start or end, each one's
    returns, in order or not, LilyPond's `missing volta specification`
    warning), asks the styler for brackets and their depth, saves the
    properties `alternativeRestores` names where they are defined, and
    reports the first alternative's start. After each element
    (`next_element`, called by the sequence's loop) it reports the
    returns of the alternative that ended, the group's end after the last,
    restores the saved properties after each but the last (with
    `measurePosition` at the alternative's grace time), and reports the
    next alternative's start (`AlternativeEvent`, or a coda mark).
  - **Volta-specced music is a kind of wrapper** (`Wrap::Volta`,
    `volta-specced-music-iterator.cc`): a child of an `\alternative` with
    brackets sends `VoltaSpanEvent`s, start and stop, to the context it
    started in, which it holds as a client like a tuplet's handler;
    elsewhere it is its child.
  - The styler's and the wrapper's events are made by `make-music` and
    `make-span-event` and sent to a context's event source, as
    `Music::send_to_context`; the iterator's property `repeat-count` is
    looked up through its ancestors' music (`internal_where_defined`).
  - **`Repeat_acknowledge_engraver` is ported whole** (`volta.rs`) and
    taken out of D67's placeholders, as D94 took `Grace_engraver`: it
    makes no grobs and sets `repeatCommands`, empty at each timestep's
    start where it is defined, with `(start-repeat n)` and `(end-repeat
    n)` added when it hears the styler's events. `repeatCommands` leaves
    `trace.test.mjs`' `TRANSLATED`, and is compared in every traced
    score.
  - **`ly:expect-warning` is a diagnostic of its own kind** (`expect` in
    `%diagnostics`, `At::Expect` in the parser's list), kept in its place
    among the others, so that order decides as in LilyPond
    (`flower/warn.cc`): a warning, an error or a programming error after
    it whose message starts with its text is not printed and takes it
    out, the first it matches; one before it is printed. An error still
    counts, so its file still fails. A template hands its expectations to
    the parse that runs it in their place. What the parse leaves unmet,
    the compile's translations may meet (`take_diagnostics`), the
    `\layout`s' and the `\midi`s' alike, which then leave it out of
    `trace.log`.
  - **The expected warnings left are LilyPond's `N expected warning(s)
    not encountered:` warning only in a compile that translated its
    `\layout`s**, a traced one, at the end of `stderr` before `failed
    files:`. A compile that translates no `\layout` (D84) does not know
    the warnings that translation gives, so it prints none of them.
  - **`TRACED` gains the volta repeats' scores**, T07, T10 and T24 (D94's
    list grows by the scores a step brings to equality).
- **Why.** The step's line asks for the three iterators with
  `repeatCommands` and the alternatives' bar numbers where LilyPond sets
  them, and `ly:expect-warning` as LilyPond's. The repeat styler is
  shared by a repeat and its alternatives in LilyPond; in the arena it is
  the repeat iterator's, reached by its number, which the alternatives
  find through D95's parent links. The segno styler is the same
  iterator's other style, a few lines, and a fixture checks it against
  LilyPond's trace; leaving it out would have made `\repeat segno` a
  repeat with volta events. `repeatCommands` is the one property a
  repeat sets in every score's trace, and its setter makes no grobs.
  Keeping an expectation in the diagnostics' order is the only way the
  parser's own messages (its Rust ones, which never pass through Scheme)
  and Scheme's are checked against it as they are given; printing an
  unmet one in a compile whose `\layout` warnings are unknown would warn
  of T15's two, which its `\layout` gives, in every untraced compile.
- **Consequences.**
  - T07, T10 and T24 trace as LilyPond's, but what later translators set,
    and their C1 = 1.0 with their maps equal (T07's map now written),
    natively and through `core.wasm`; `repeatCommands` equals LilyPond's
    in every score but T23, whose second Score (step 38) is missing.
  - T10's stderr is LilyPond's (empty), and T15's two expected warnings
    are met in its traced `\layout` translation.
  - An untraced compile never says that an expected warning is missing.
    When `\layout` is translated in every compile (D84), the warning is
    printed in every compile.
  - `warning-as-error`, which T10 sets, is still no option of the
    engine's `ly:set-option`: an unexpected warning does not fail the
    file (step 40's option table).
  - `Volta_engraver`, the bar line's engraver and `Mark_tracking_translator`
    that read these events and properties stay D67's placeholders (MS3).

  progress.md, MS2 step 37.

## D97 — `\lyricsto` and `\addlyrics` are LilyPond's lyric combine iterator, whose listeners keep their state in the translation's arena; no melisma holds a syllable back until step 39

**Status:** accepted · **Refines:** D67, D94, D95, D96

- **What.** N7's second part, MS2 step 38 (`iterator.rs`, `lyrics.rs`,
  `context.rs`, `dispatcher.rs` and `global.rs` of `crates/music`;
  `tools/compare/trace.mjs`, `test/trace.test.mjs`):
  - **`LyricCombineMusic` is iterated by LilyPond's lyric combine
    iterator** (`lyric-combine-music-iterator.cc`), a kind of N4's arena
    (`Kind::Combine`) that holds its lyrics' iterator. Its pending moment
    is never finite: it runs always while its lyrics last and the voice it
    follows cannot be removed. Its contexts made, it finds the `Lyrics`
    context at or below its lyrics' own (LilyPond's `argument of
    \lyricsto should contain Lyrics context` if none) and the voice to
    follow: `associatedVoice` and `associatedVoiceType` of the lyrics, or
    `\lyricsto`'s id and type (`Voice` by default), below Global. Each
    timestep it looks for the voice again, and when the voice heard a
    melodic event now, it sets the lyrics' `associatedVoiceContext` and
    processes its lyrics' iterator to that iterator's next moment: one
    syllable, with what comes before it. A grace note's syllable waits for
    its main note unless the lyrics' `includeGraceNotes` is set. At its
    `quit`, LilyPond's `cannot find context: Voice = id` if it had lyrics
    and never found the voice. It takes part in `preorder_walk` with its
    lyrics' iterator and has its own `substitute_context` (D95).
  - **Its three listeners are a kind of the dispatchers' listener**
    (`Listener::Combine`) **whose state is the arena's** (`lyrics.rs`,
    `Arena::combines`), since a listener is called inside a dispatch,
    which cannot reach the iterators: `set_busy` on the voice's events
    below keeps the moment of its last `melodic-event`; `forward_event`
    beside it sends each `structural-event` the voice hears (its repeats'
    and alternatives', which the repeat styler inside `\lyricsto` does not
    announce, D96) on to the lyrics' context; and `check_new_context` on
    Global's events below looks for the voice at each `CreateContext`, so
    that a voice made in a timestep gets its syllable then. The iterator
    updates what they read of it (whether its lyrics are left, whether it
    holds a context).
  - **An iterator's `quit` takes the host** and may give a warning, as
    LilyPond's `do_quit` does; it was a walk over the arena only.
  - **When the melody dies** (the voice has no parent), LilyPond drops
    its lyrics' iterator without quitting it, which keeps the `Lyrics`
    context till Guile collects the iterator; the engine quits it then,
    so that the context is removed at a known timestep.
  - **`melisma_busy` is step 39's:** until then no melisma holds a
    syllable back, so the lyric scores' traces differ from LilyPond's
    from their first open melisma on (slur, tie, or a manual beam with
    `autoBeaming` off). `ignoreMelismata` is read by nothing yet.
  - **`TRACED` gains T20** (D94's list grows by the scores a step brings
    to equality): its four `\addlyrics` meet no melisma.
- **Why.** The step's line asks for `\lyricsto` and `\addlyrics` as
  LilyPond's iterator, finding the associated voice and advancing a
  syllable when the voice starts a note. LilyPond's iterator is a
  listener of three dispatchers as well as an iterator; in the engine a
  dispatch holds the translation's arena and calls listeners by kind, as
  it calls translators (D79), so what the listeners read and write has to
  be there. Listening late, at the iterator's next `process`, would lose
  the first note of a voice made in the timestep, which is what
  `check_new_context` is for, and would put the forwarded repeat events
  after the lyrics' own. LilyPond's warnings at `quit` need the host.
  Quitting the dropped iterator differs from LilyPond only in when its
  context is let go, which LilyPond leaves to its collector.
- **Consequences.**
  - T20 traces as LilyPond's, but what later translators set, and its C1
    = 1.0 with its map equal, natively and through `core.wasm`; T02, T04,
    T23 and T30 trace as LilyPond's up to their first melisma, their
    syllables after it placed early (step 39).
  - A voice iterated after its lyrics in the same simultaneous music gives
    them no syllable, as in LilyPond: they look for its note before it is
    heard.
  - The lyrics' `Lyric_engraver`, `Extender_engraver`, `Hyphen_engraver`
    and `Lyric_performer` stay D67's placeholders (MS3, MS4).

  progress.md, MS2 step 38.

## D98 — The melisma properties are set by the parts of the slur, tie and beam translators that set them; the tie translators hear the notes that `Note_heads_engraver` and `Note_performer` would make heads and audio notes of

**Status:** accepted · **Refines:** D67, D79, D97

- **What.** N7's third part, MS2 step 39 (`melisma.rs`, new, `lyrics.rs`,
  `iterator.rs` and `translator.rs` of `crates/music`;
  `tools/compare/trace.mjs`, `test/trace.test.mjs`, `test/c1.test.mjs`):
  - **`melisma_busy`** (`context.cc`) is the engine's: a context with
    children is held if all of them are, one without if any property of
    `melismaBusyProperties` is `#t` there. The lyric combine iterator's
    `start_new_syllable` asks it of the voice it follows, unless the
    lyrics' `ignoreMelismata` is set, so a melisma holds a syllable back
    (D97's step 39).
  - **Seven of D67's placeholders get work: only what sets their melisma
    property.** `Slur_engraver` keeps the spanner ids of its open slurs,
    from `slur-event`s on their own or among a note's articulations (a
    chord's), ended before they are started, and sets `slurMelismaBusy`
    in every `process_music`; `Beam_engraver` and `Grace_beam_engraver`
    keep whether their beam is open, in main or in grace time, and set
    `beamMelismaBusy` where LilyPond's do, only when `autoBeaming` is off;
    `Slur_performer` and `Beam_performer` keep the last start and stop
    they heard now; `Tie_engraver` and `Tie_performer` keep the notes
    waiting for the notes they are tied to, each with its end, and set
    `tieMelismaBusy` at each timestep's start and when a tie is heard,
    forgetting a note past its end unless `tieWaitForNote` (so a tie to
    another pitch holds the next note back too, as LilyPond's
    `unterminated tie` does). Their grobs, their audio, their warnings
    (`unterminated tie`, `already have a beam`, `cannot end slur`, …) and
    the rest of their code stay chapter 05's and 07's. Their descriptions
    give LilyPond's properties read and written.
  - **The tie translators hear notes, as a stand-in for what they
    acknowledge.** LilyPond's `Tie_engraver` acknowledges the note heads
    `Note_heads_engraver` makes, and `Tie_performer` the audio notes
    `Note_performer` makes, both placeholders here. So each also hears
    `note-event` in its context, if the context consists a maker of them
    (`Note_heads_engraver`, `Drum_notes_engraver` or
    `Tab_note_heads_engraver`; `Note_performer`), and takes each note as
    the head or audio note those would make of it: tied to the first
    note waiting for it of an `equal?` pitch, else of the same tones; a
    tie of its own if one of its articulations is a `tie-event` or a tie
    was heard on its own now; its end its length later, in grace time its
    grace part, and for an audio note after each articulation's
    `midi-length` (a staccato's), which `Note_performer` calls. A
    translator that runs in every timestep (`Slur_engraver`, the two tie
    translators) is `always`; the beam engravers stay awake while their
    beam is open; the performers of slurs and beams wake when they hear
    one, and forget it at the timestep's end rather than the next one's
    start, which a sleeping translator is not called for.
  - **LilyPond 2.26.0 has no `Melisma_translator`:** `\melisma` and
    `\melismaEnd` set and unset `melismaBusy` (`declarations-init.ly`),
    which the engine already iterates.
  - **`TRACED` gains T02, T04, T28 and T30**, and `trace.test.mjs`
    compares `slurMelismaBusy` and `tieMelismaBusy` in every trace (no
    longer named for later translators). **`MAPPED`** (`trace.mjs`) is
    `TRACED` and T23, the scores whose playback maps equal LilyPond's;
    `c1.test.mjs` scores it, the 30.
- **Why.** The step's line ports the melisma properties and no more of
  their translators. A slur's, a beam's and a performer's melisma depend
  on events alone; a tie's on which notes wait for which, which LilyPond
  learns from grobs and audio items of later milestones. The heads and
  audio notes the stand-in takes are those LilyPond's makers make of
  every note they hear in the same context, so a tie's melisma is
  LilyPond's wherever a maker is in the tie translator's own context, as
  in LilyPond's definitions (`Voice`, `DrumVoice`, `TabVoice`,
  `NullVoice` in `\layout`; `Voice` in `\midi`, where `NullVoice` has no
  `Note_performer` and so no audio notes). Calling `midi-length` keeps a
  staccato's shorter end, which lets its tie go earlier. Listening adds
  `slur-event`, `tie-event` and `beam-event` to the classes their
  contexts hear, so a note's slur, tie or beam is broadcast on its own in
  `\midi` too, as LilyPond broadcasts it.
- **Consequences.**
  - All 30 scores: C1 = 1.0 and their maps equal, natively and through
    `core.wasm`; the traces of 29 LilyPond's, but what later translators
    set, T23's waiting for its incipits (step 40).
  - `note-event` is among the tie translators' events accepted
    (`ly:translator-description`), where LilyPond's list `tie-event`
    only.
  - A tie translator in a context without a maker, whose heads come from
    a context below (none of LilyPond's definitions), sees no notes;
    `Completion_heads_engraver`'s split notes and `completionBusy`, and
    `Drum_note_performer`'s audio notes, are not seen (none of the 30
    reaches them).
  - Translating costs a little more: three translators run in every
    timestep of every voice.

  progress.md, MS2 step 39.

## D99 — Every compile translates its `\layout`s, and what its translations say goes to `stderr`; a file's scores are translated in its order

**Status:** accepted · **Refines:** D84, D87, D96

- **What.** Conventions of MS2 step 40 (the core's `compile.rs` and
  `lib.rs`; the parser's `lib.rs`, `Parse::take_said` and
  `Parse::toplevel_scores`):
  - **Every compile translates each score's `\layout`s**, with N4's
    global loop, and not only a traced one (D84): each output definition
    of a score in turn, `capture.ly`'s `\midi` added to a score without
    one as D87 adds it. Tracing (`Engine::set_trace`) only adds the
    outputs `trace.tsv` and `trace.log`.
  - **What each translation says goes to `stderr` and
    `diagnostics.json`**, after the parser's messages, where D87 sent a
    performance's to no output: the music crate's warnings, errors and
    programming errors at their places with their excerpts, and what
    Scheme wrote to Guile's error port, placed among them by its flushes
    as the parser places its own (`take_scheme_output`) and flushed at the
    translation's end. Messages are left out, as `--loglevel=WARNING`
    leaves them. An error of a translation does not fail the file:
    LilyPond's `ly-file-failed` comes from the parser's `error_level_`
    alone. The warnings `ly:expect-warning` expects and the parse left
    unmet are carried through the translations in order, and those none
    met are warned of at the end of every compile, before `failed
    files:`, no longer only in a traced one (D96).
  - **`trace.log`** keeps what the `\layout` translations said, each
    message as it prints but without its excerpt, and the iterators they
    lacked (`unported:`); an error a translation returns to Rust is
    written there only.
  - **A file's scores are translated in its order:**
    `Parse::toplevel_scores` gives the scores of `toplevel-scores`, which
    holds the last first, reversed, as LilyPond's `Book::process` reverses
    its book's. The parser tests' music trees keep `ly:book-scores`' order,
    the last first, as `music.ly` writes them.
- **Why.** C0 on T03 compares the engine's `stderr` with the MS0
  capture's, where LilyPond translates T03's `\layout` and the `\midi`
  that `capture.ly` adds, and prints the failed bar check of each. D87
  kept a performance's messages out of `stderr` until the `\layout`
  translation ran in every compile; with both, T03's `stderr` is
  LilyPond's byte for byte. The reversed order was found at step 38: a
  file of several scores traced and mapped them last first.
- **Consequences.**
  - `stderr` of T03 and T30 LilyPond's byte for byte; T26's and T29's
    gain the `cannot create context` warnings of their `\midi`
    translations, and T15's its Scheme engraver's lines on the error port
    (but those of its acknowledgers, D87, and its stream events written
    as the engine writes them). What they still lack is layout's
    (`compressing over-full page`, `page 1 has been compressed`, T29's
    `cyclic dependency` programming errors; MS3) and `Staff_performer`'s
    (`MIDI channel wrapped around`; MS4). None of them is C0's gate.
  - Every compile pays for its `\layout` translations (progress.md, MS2
    step 40, *Measured*). `Grace_engraver`, `Repeat_acknowledge_engraver`
    and the melisma engravers run in every compile.
  - The scores of a `\book` are translated after the parse, so what they
    say follows the parser's messages, where LilyPond prints it as each
    `\book` is handled while the file is parsed; none of the 30 has a
    `\book` whose translation warns.
  - `warning-as-error` (T10's `ly:set-option`) still turns no warning
    into an error; T10 gives none.
  - In a file of several performances, `timing.ly` writes the earlier
    ones' staves with no voices (it reads them from a table each
    performance's start clears, when it writes the file after the last);
    the engine's built-in performers write each performance's own. None
    of the 30 has more than one performance.

  progress.md, MS2 step 40.

## D100 — MS2's traces are each score's own translations; a `\score` that layout translates from inside a markup is MS3's, and T23's incipits wait for it

**Status:** accepted · **Refines:** D67, D94, D99

- **What.** The user's answer at MS2 step 40's stop point (option (a)):
  - **MS2's gate item "the translation traces of all 30"** means the
    translations each score's own `\layout` and `\midi` run, as the parse
    hands them over (D99). Translations that LilyPond runs from inside its
    layout, a `\score` in a markup translated by `score-markup`
    (`ly:score-embedded-format`) when a grob that holds it prints, belong
    to MS3, which brings in `Instrument_name_engraver` and the layout
    path.
  - **T23 is the one case among the 30.** Its incipits are three `\score`s
    in the markups it sets as `Staff.instrumentName`; LilyPond translates
    them when it prints the instrument names (`Instrument_name_engraver`,
    a D67 placeholder, makes the InstrumentName grob with the markup as
    `long-text`; its stencil callback `system-start-text::print`
    interprets it; `score-markup` calls `ly:score-embedded-format`). Their
    858 S lines (`Score#1–#3`, `Staff#3–#5`, `Voice#3–#5`) follow the main
    score's `X` lines in LilyPond's trace.
  - **`TRACED` stays the 29**, all but T23, until MS3; T23 stays in
    `MAPPED` (`tools/compare/trace.mjs`), with C1 = 1.0 and its map equal,
    and `trace.test.mjs` says why it is set aside. Its reference trace
    (`$LILY_CORPUS/ref/T23/trace.tsv`) is captured whole, as before.
  - **What MS3 must do to add T23 to `TRACED`:** port
    `Instrument_name_engraver` and the InstrumentName grob, run
    `system-start-text::print` and `score-markup` when layout prints the
    instrument names, and give `ly:score-embedded-format` a translation of
    the embedded score with the score's `\layout` (copied from
    `$defaultlayout`, where `trace.ly`'s Score recorder is and its context
    recorder is not), so its S lines come after the main score's in
    LilyPond's order; then T23's trace equals LilyPond's and T23 joins
    `TRACED`.
- **Why.** The stop point of step 40 (a gate item that needs C++ callbacks
  of later milestones beyond D67's named placeholders). A stand-in now,
  translating each staff's `instrumentName` scores after its `\layout`
  translation (option (b)), would guess at the order of the layout's
  callbacks, which MS3 would replace. The incipits are not a translation
  of T23's own music: its music, events and properties at every bar start
  are LilyPond's.
- **Consequences.**
  - MS2's gate (step 42) compares the traces of the 29 and counts T23's
    as MS3's; C1 = 1.0 and the maps equal on all 30 are unchanged.
  - Any score whose markups hold a `\score` that layout prints is read
    the same way until MS3; none of the 30 but T23.
  - No code changed: `TRACED` and `MAPPED` were already the 29 and the 30
    (D98).

  progress.md, MS2 step 40.

## D101 — The corpus runs through the studio's driver in a studio test that reads the engine's build as files; the engine's tools run it by its script and read what it writes

**Status:** accepted · **Refines:** D56, D89

- **What.** The user's answer at MS2 step 41's stop point (how the engine's
  tools run the studio's worker in Node without reaching into another
  package), as built:
  - **The test is the studio's:** `packages/studio/test/engine-corpus.test.ts`,
    beside `engine.test.ts`, imports the driver, the host and the protocol
    from its own package (`src/web/engine/`) and nothing of the engine's. It
    runs the unchanged `Driver` and `EngineHost` in one process, their
    messages cloned and delivered a task later as a worker's are, the
    page's side answering `needs-file` from disk (a `<datadir>/` name from
    LilyPond's data directory) and the worker's loader reading the engine's
    files. The test sees the core's instances by wrapping
    `WebAssembly.instantiate` (as `engine.test.ts` replaces the core), and
    reads a compile's outputs through `lily_outputs` and `lily_output`
    after the driver has finished it, as the driver's own `outputs()` does.
  - **The engine's build is read as files**, from `LILY_ENGINE_DIST`, by
    default `packages/engine/dist/engine/` found from `packages/studio/`
    (the directory `esbuild.mjs --site` copies from). LilyPond's data
    directory is `LILY_DATADIR`, by default the `share/lilypond/2.26.0/` of
    the `lilypond` on the `PATH`. Without either the tests skip themselves.
  - **What it compiles:** by itself, a score of its own with an include and
    a syntax error (the studio's `npm run test:unit` runs it). With
    `LILY_ENGINE_CORPUS`, a JSON file `{ out, runs: [{ dir, files }] }`, each
    run's files in one engine, one after another, a name relative to `dir`;
    each one's outputs go to `<out>/<name without .ly>/` as `lily_output`
    names them, with `outcome.json` (state, counts, milliseconds, the names
    asked and the revisions of each start).
  - **Its entry point is the studio's script `test:engine-corpus`** (`node
    esbuild.mjs --tests && node --test out/test/engine-corpus.test.js`).
    The engine's `tools/compare/test/worker.test.mjs` writes the corpus
    file (the 30 scores and the 30 error cases), runs the script by the
    workspace's name from the repository's root (`npm run -s
    test:engine-corpus -w lily-studio`, without `NODE_TEST_CONTEXT`), and
    reads what it wrote: each output against the native core's byte for
    byte, C1 and C0 by `score.mjs`. Neither package imports the other's
    code; each reads the other's files.
- **Why.** AGENTS.md: nothing is imported by a relative path into another
  package, and no app imports or links the engine (D56). The driver is the
  studio's and MIT, `score.mjs` and the corpus the engine's and GPL, so
  the run and the judgement are in different packages, with files
  between them.
- **Consequences.**
  - The engine's `npm test` builds the studio's tests (into
    `packages/studio/out/`) and runs one of them; it needs `npm` and the
    root's `npm install`.
  - The studio's `npm run test:unit` runs core.wasm through its driver
    whenever an engine build and LilyPond 2.26.0 are there, and skips the
    corpus part, which only the engine's test asks for.
  - The test restarts a compile only as the driver does: after each answer,
    with the same revision and root (D89), which it checks.

  progress.md, MS2 step 41.

## D102 — The page gives the engine its files as bytes, not text; step 41a changes the protocol, before step 42

**Status:** accepted · **Refines:** D101 · **Changes, in step 41a:** the
page↔engine protocol (`packages/studio/src/web/engine/protocol.ts`)

- **What.** The user's answer to the first question at MS2 step 41's stop
  point (K2's: `protocol.ts` or `driver.ts` would change), option (b):
  - **A file crosses the page↔engine protocol as bytes.** The files of
    `protocol.ts`' messages, `CompileRequest.files` and the `file` answer
    to `needs-file`, carry a file's bytes (`Uint8Array`, null when there
    is no such file) instead of its text.
  - **The driver hands them to the engine unchanged**, through `lily_put`,
    which already takes bytes (08 §4.2): the ABI does not change. It no
    longer encodes them as UTF-8.
  - **The page's side makes the bytes:** an editor's text, which the page
    has as a string, encoded as UTF-8; a file from disk or from the
    server (D55) passed as it was read, undecoded.
  - **It is done by a step of its own, step 41a** (lettered as MS1's 10a
    and 10b), after step 41 and before step 42, which then needs 30–41a.
    This decision authorises the changes to `protocol.ts`, `driver.ts` and
    the page's side (`host.ts`) in step 41a only.
  - **Until step 41a, case 06** (`06-non-utf8.ly`, Latin-1) stays out of
    the driver's byte and C0 checks (`TEXT` in
    `tools/compare/test/worker.test.mjs`), its C0 held natively and
    through `lily_put` (`c0-cases.test.mjs`).
- **Why.** As text, a file that is not UTF-8 reaches the engine decoded,
  each byte that is not UTF-8 as U+FFFD, and the engine has no
  `non-UTF-8 input` to warn of, as LilyPond does: case 06's `stderr`
  through the driver is empty and its `diagnostics.json` `[]`, where
  natively and through `lily_put` it gives LilyPond's two warnings. With
  bytes, what the engine reads is what LilyPond would read, whichever way
  the page got the file, and MS2's gate item "the corpus through the
  worker in Node" holds C0 on all 30 cases, not 29. The user chose this
  over recording case 06 as read through texts (option (a)).
- **Consequences.**
  - Step 41a changes `protocol.ts`, `driver.ts` and `host.ts`, and
    `engine.test.ts` and `engine-corpus.test.ts` with them (their counts
    only grow); `TEXT` is emptied, and case 06 through the driver gives
    the native core's outputs and passes C0.
  - Where the driver reads the sources' text itself (`modulesFor`, which
    looks for what they name before the first step), it decodes the bytes
    for that alone.
  - A host that holds an editor's text must encode it; one that reads
    files must not decode them. The renderer's protocol of the Rust side
    (`ipc.ts`) is not this one and does not change.
  - Step 42 runs MS2's gate after step 41a, case 06 through the driver
    included.

  progress.md, MS2 step 41.

## D103 — The driver's outcome takes entry 0 of the playback map, as the Rust side does

**Status:** accepted · **Refines:** D26, D101

- **What.** The user's answer to the second question at MS2 step 41's stop
  point, option (a): `outcomeOf` (`packages/studio/src/web/engine/driver.ts`)
  gives `CompileOutcome.timing` as entry 0 of the `.timing.json` array
  `runtime/timing.ly` writes (one entry a performance), as the Rust side's
  `read_timing(file, 0)` (`crates/engrave/src/compile_service.rs`) does:
  its `events` and `bars`, and its `staves` when there are any. An empty
  array, an entry without `events` or `bars`, or a map that cannot be
  parsed gives no `timing`, which only costs the playhead. Before, it
  gave the whole array, where `CompileOutcome.timing` is one
  `PlaybackTiming`.
- **Why.** The renderer takes one performance's map (D26), and the two
  sides should give it the same outcome for the same outputs. Nothing
  broke yet (the engine writes no MIDI before MS4, so no outcome of the
  engine is played), but the user chose to fix it now rather than leave
  it to MS4.
- **Consequences.**
  - `engine.test.ts`' `outcomeOf` fixture is an array, and a test checks
    entry 0, an empty array, a missing `bars`, an object and a cut map;
    `engine-corpus.test.ts` checks each compile's `timing` against its
    map's entry 0.
  - Unlike `read_playback`, the driver gives the map without a MIDI file:
    the engine writes none until MS4, and without MIDI the player has
    nothing to play. MS4 decides whether the driver ties the map to a MIDI
    file as `read_playback` does.
  - `protocol.ts` and 08 §4.2's ABI are unchanged.

  progress.md, MS2 step 41.

## D104 — Layout and the SVG writer are two new crates, `layout` and `svg`; the stencils and the font face are layout's

**Status:** accepted · **Refines:** D57, D79 · **Changes, in MS3 part
1:** the engine's workspace (`packages/engine/Cargo.toml`) and
`scripts/sizes.mjs`' `PARTS`

- **What.** The user's answer 3 at MS3's split (2026-10-08), on the
  crates' layout for README §5's MS3:
  - **`crates/layout` (`lily_engine_layout`)** holds grobs and their
    properties, the engravers of MS3's grobs, registered into the music
    crate's translator framework (D79), spacing, outside-staff placement,
    line and page breaking, titles, and the layout path from a translation
    to the pages' stencils. It also holds 01 §3.7's O1 and O2: stencils,
    boxes and transforms, `lookup.cc`'s shapes, LilyPond's font metrics
    over W1's packs (`crates/fonts`), font selection and markup's text
    stencils, because layout reads their extents first. It depends on the
    scheme, music and fonts crates (part 1's step 2), and on the skyline
    crate from Y2 (part 4), and gives the image its own `Extension`, as
    the music crate does.
  - **`crates/svg` (`lily_engine_svg`)** holds W3, the writer in file
    form (06 §6.2): the walk of a stencil's expression, the outputter and
    its links, and `output-svg.scm`'s and `framework-svg.scm`'s page in
    Rust. It depends on layout, for stencils and fonts only, and on fonts.
    The preview form (W4) is MS6's and is not decided here.
  - **The core links both** and keeps only the calls behind 08 §4.2's
    ABI, which does not change: the pages leave as `<base>.svg` and
    `<base>-<n>.svg`, the packs arrive as `pack` modules.
  - **Each crate joins its README §4.1 row** in `PARTS` in the commit that
    creates it: layout in *Layout and notation* (1,100 / 700 KB raw, 400
    / 260 brotli) with `lily_engine_skyline`; svg in *SVG writer and text
    shaping* (110 / 70 raw, 40 / 25 brotli) with `lily_engine_fonts`.
    Part 1's step 2 creates layout and step 7 svg.
- **Why.** README §4.1 budgets layout and the writer as rows of their own,
  and a crate a row lets `sizes.mjs` charge them without module patterns.
  Kept out of the core, layout's code does not grow the driver row, which
  is already over Must (MS2 step 42: 85,874 raw, ≈ 35,830 brotli against
  80 / 30 KB). The writer only prints what layout made, so a crate of its
  own keeps it from reaching into layout beyond stencils and fonts, and
  MS8's PDF (W7) can sit beside it on the same stencils. Stencils and
  fonts go with layout, not with the writer, because every grob's extent
  is read from them before anything is written.
- **Consequences.**
  - The scheme crate's stand-ins for stencils (`lily.rs`' `Stencil`,
    `%make-stencil`, `ly:stencil?` and the rest) move to layout in part 1's
    step 2, and the image restores `define-markup-commands.scm`'s constant
    stencils as layout's type.
  - D67's layout placeholders in the music crate (`grob.rs`' `PRIMS`,
    `translator.rs`' classes with no work) are replaced from layout under
    the same names and arities.
  - A module that needs a crate beyond these two, or a writer that needs
    more of layout than stencils and fonts, stops for the user (progress.md,
    *The plan*'s stop points).
  - 05 §5's cheaper machinery (typed slots, generated tables) is not
    decided here: it waits for R1 (progress.md, *The plan*).

  progress.md, MS3 step 0.

## D105 — The manifest preloads W1's Emmentaler-20 as `emmentaler-20`; the spike's pack is the spike build's own

**Status:** accepted · **Refines:** D104 · **Changes, in MS3 part 1
step 5:** `packages/engine/scripts/build.mjs`, the core's `lily_put` of
`MODULE`

- **What.** The engine's build (`scripts/build.mjs`) builds W1's packs into
  `dist/engine/fonts/` first, and copies `fonts/emmentaler-20.pack` beside
  the core as `dist/engine/emmentaler-20.pack`, which the manifest names as
  the `pack` module `emmentaler-20` and preloads (06 §5.2). The core keeps
  each module's data the host puts (08 §4.2's `kind` 1) by its name and
  gives the font packs among them to layout's fonts, where `ly:system-font-load`
  and font selection find them. The spike's own pack, cut from
  `emmentaler-20.svg` for MS0's harness pages, is built only with
  `CORE=spike`, as `emmentaler-20.spike.pack`, and that build's manifest
  names it as the module `emmentaler-20` (`FONT` is read only then). The
  other packs of `fonts/` stay named by no manifest until a host asks for
  them (W5, MS3 part 4); the tests put them.
- **Why.** The core reads fonts from MS3's step 5 on, and the pack it
  reads is W1's format, not the spike's. The manifest's module name stays
  `emmentaler-20`, which `modules.ts`' `packFor` gives and the studio's
  tests use, and its file stays beside the core, where the studio's
  `esbuild.mjs --site` copies a manifest's files from, so neither
  `protocol.ts`, `driver.ts`, `host.ts` nor the studio's tests change. The
  spike's core reads only its own pack, so its build keeps giving it one.
- **Consequences.**
  - The core's download grows by W1's pack: 3,693 → 35,733 brotli bytes
    for the preloaded pack (progress.md, MS3 step 5).
  - `fonts/` gets no `.br` files: no server sends them yet.
  - A host puts its modules again into each new instance (`driver.ts`'
    `instantiate`); the core takes the same name with the same data once.

  progress.md, MS3 step 5.

## D106 — References are captured with LilyPond's own text fonts, not the machine's

**Status:** accepted (the user's answer 1 to MS3 part 1's *Waiting for the
user*) · **Changes, in MS3 part 1 step 6:**
`packages/engine/tools/compare/capture.ly`, every capture of
`$LILY_CORPUS/ref/`

- **What.** `capture.ly`, the settings file of every reference capture
  (chapter 00 §5.1), sets `property-defaults.fonts.serif`, `.sans` and
  `.typewriter` to `"LilyPond Serif"`, `"LilyPond Sans Serif"` and
  `"LilyPond Monospace"`, as `paper-defaults-init.ly:170–181` gives every
  backend but SVG. With `--svg`, LilyPond 2.26.0 gives fontconfig's
  `"serif"`, `"sans"` and `"monospace"`, which are the machine's (Times
  New Roman on this Mac). A score that sets its own fonts keeps them.
- **Why.** The references then measure and name their text in C059 and
  LilyPond's other URW fonts, which ship with LilyPond and which W1's
  text packs are cut from, so a string's extent in the engine (W6, 06
  §5.3) can be held to LilyPond's, and a reference no longer depends on
  the capturing machine's fontconfig. The other options were to keep the
  machine's text and compare everything but a string's extent, or a
  metric pack of the machine's `serif` (Monotype's font, this Mac only).
- **Consequences.**
  - All 42 captures of `$LILY_CORPUS/ref/` were made again in MS3 step 6
    (`$LILY_CORPUS/ref-before-d106/` keeps the old ones). Their MIDI
    files, playback maps and translation traces are unchanged, so MS2's
    C1 and `TRACED` are not touched; the pages' text (`font-family="LilyPond
    Serif"`), C5's dumps of 22 scores and the over-full page warnings of
    T26 and T27 (`stderr.txt`, by 0.1 and 0.7 staff spaces) changed.
  - The engine's `<text>` names the families the references name (step
    7), and step 8's markups compare a string's extent with LilyPond's.
  - A page the studio shows from LilyPond itself (`--svg` without
    `capture.ly`) still names the machine's fonts; only references
    change.

  progress.md, MS3 step 6.

## D107 — W1's text packs carry the glyph names (version 2)

**Status:** accepted · **Refines:** 06 §5.3 (W1's text metric packs) ·
**Changes, in MS3 part 1 step 8:** `packages/engine/tools/packs/text.mjs`,
`packages/engine/crates/fonts/src/text.rs`

- **What.** A text pack (`LILT`) is of version 2: after the glyphs' ink
  boxes it holds each glyph's name, the CFF charset's, which FreeType's
  `FT_Get_Glyph_Name` gives (`four`, `ffi`, `.notdef`). The reader takes
  version 2 only; the packs are built from the OTFs by every build, so no
  version 1 pack is kept anywhere.
- **Why.** LilyPond's stencil of a string is a `glyph-string` that names
  each glyph (`pango-font.cc`'s `get_glyph_desc`), and part 1's gate holds
  the markups' stencils to LilyPond's, expression and all; the PostScript
  and PDF output (W7) names the glyphs too. Deriving the names from the
  characters (the Adobe Glyph List) would guess what each font calls its
  glyphs, its ligatures among them.
- **Consequences.**
  - Each text pack grows by its names (progress.md, MS3 step 8, for the
    sizes); the three C059 packs the manifest preloads (06 §5.2) are part
    of the core's download.
  - The packs still hold measurements and names, no outline (06 §5.3's
    license note is unchanged).

  progress.md, MS3 step 8.

## D108 — A grob's record stays in the music crate; its properties, parents and bounds are layout's, and layout's engravers are classes the core passes

**Status:** accepted · **Refines:** D79, D104 · **Changes, in MS3 part
2:** `crates/music` (a per-translation slot for layout, the placeholders
shadowed), `crates/layout` (grobs and engravers), the core's `\layout`
call

- **What.** This is the user's answer 2 at MS3 part 2's split
  (2026-10-08), on where Y1's grobs live and how layout's engravers join
  the music crate's translator framework:
  - **The music crate keeps the grob record** (`records.rs`'
    `GrobRecord`). The framework makes, announces and acknowledges it
    (D79), for C++ engravers and Scheme engravers alike. It holds the
    grob's type, origin, cause, moment and interfaces, the `definition`
    alist (`updated_grob_properties`) and the `props` set on it. Its
    number is the grob's identity, and `#<Grob …>` is its handle.
  - **Layout holds the rest of the grob** (01's L1): property lookup with
    callbacks and `calculation-in-progress`, the object alist, parents and
    offsets, `Item` and `Spanner` with their bounds and columns. This
    state is per grob, keyed by the record's number, for every record. It
    lives in one slot per translation that the music crate gives as an
    opaque, generic hook and that names no layout type. Layout's `ly:grob-*`
    replace the music crate's (`ly:grob-property`,
    `ly:grob-set-property!`) under the same names and arities (D67).
  - **Layout's engravers are its own `TranslatorClass`es with `Work`.**
    They are passed through `run_translator_with`'s classes, which
    `resolve` finds before `CLASSES`; the core passes them at its
    `\layout` call. The placeholders of the same names stay in `CLASSES`
    as names, which `ly:get-all-translators` and the creators list.
- **Why.** The framework already makes records at every engraver's call,
  and Scheme engravers make them too, so a record kept in the music crate
  serves both without a trait between the crates. Putting L1 in layout
  keeps D104's line, so the music crate does not depend on layout, no
  crate is added, and the core holds a call rather than layout's code. The
  registration path is already there (MS2's translation tests use it).
- **Consequences.**
  - The music crate grows only the slot. A step that would have it name a
    layout type, or hold more of layout than the slot, stops for the user
    (progress.md, *The plan*'s module boundaries).
  - Without layout (the music crate's own tests), records keep the music
    crate's `ly:grob-property`, which calls no callback.
  - A translation that layout's code starts, such as part 3's
    `ly:score-embedded-format`, passes the same classes.

  progress.md, MS3 step 11 (*The plan*, *Settled with the user at part
  2's split*).

## D109 — A capture writes each `\header`'s entries sorted by name, and links to a relative file below `ref/<ID>`

**Status:** accepted (the user's answer at MS3 step 12a, 2026-10-08) ·
**Refines:** D106 · **Changes, in MS3 step 12a:**
`packages/engine/tools/compare/stencils.ly`, `capture.ly`, `capture.mjs`,
six `markups.scm` of `$LILY_CORPUS/ref/`

- **What.** Two captures of the same score are the same byte for byte:
  - `stencils.ly` writes each alist of a markup's property chain whose
    keys are all `header:` symbols **sorted by name** (`string<?`). The
    other alists of a chain, `marked-up-headfoot`'s literal one with its
    `page:` keys among them, keep LilyPond's order.
  - `capture.ly` makes `ly-getcwd` give `CAPTURE_CWD`, which
    `capture.mjs` sets to `<corpus dir>/ref/<ID>`, so a link to a file
    given relatively (T16's `<included string>`) names that directory
    wherever the capture goes. A capture into `ref/` is unchanged by it.
- **Why.** `titling.scm`'s `headers-property-alist-chain` makes each
  `\header`'s alist with `ly:module->alist`, a fold over the module's
  hash table (`ly-module.cc:54–70`), and Guile's `hashq` hashes a
  symbol's address, which changes from run to run even with ASLR off; so
  the order cannot be fixed from outside LilyPond. A lookup finds a key by
  name and a module's names are unique, so the order means nothing to the
  engine. And `-o` makes LilyPond change into the capture's own
  directory, which a relative file's link names. The other options were to
  compare `markups.scm` as multisets of tokens and normalise T16's
  directory in the comparison only, or to patch LilyPond.
- **Consequences.**
  - The `markups.scm` of M06, T02, T24, T27, T28 and T30 in `ref/` were
    written again in the sorted order (the old ones are in
    `device-runs/2026-10-08-ms3-step12a/ref-markups-before/`); T29's and
    M12's already were, by chance. No other file of `ref/` changed, the
    10's none.
  - A step that captures again compares every file but `capture.json`
    byte for byte; `stencils.test.mjs` holds two captures of a 15-entry
    header and of T16 to it.
  - The engine reads a chain by key (`crates/layout`'s markups), so
    neither its reading nor step 8's markup tests changed.

  progress.md, MS3 step 12a.

## D110 — A LilyPond Scheme init function the engine cannot run is ported to Rust beside the type it serves, recorded with its lines

**Status:** accepted (the user's answer 4 at MS3 step 14a's stop point,
2026-10-09) · **Refines:** D67, D108 · **Changes, in MS3 step 14a:**
`crates/music/src/output_def.rs` (`scale_output_def`), its callers in
`book.rs` and the core's `\layout` call

- **What.** When C++ that the engine ports calls a function of LilyPond's
  Scheme init files (`scm/lily/*.scm`, through `Lily::…` of
  `lily-imports.cc`) that the engine's Scheme cannot run, the function is
  ported to Rust beside the type it serves, with the C++ that calls it,
  and recorded with its file and lines: in the Rust doc comment and in
  the step's line counts, among the borrowed lines. The scheme crate does
  not grow the primitives the Scheme would need for this alone. The first
  is `paper.scm`'s `scale-layout` (`:417–436`, 20 lines), which
  `scale_output_def` (`paper-def.cc:99–107`) calls and which needs
  `module-variable` and `variable-ref`, first-class variables the scheme
  crate does not have (*MS2*, *Not provided yet*). It is
  `lily_engine_music::scale_output_def`: a clone of the output definition
  with no parent, as `Output_def`'s copy constructor makes it; for each
  symbol of `dimension-variables`, looked up through the parents, a number
  that the old scope binds, as `module-variable` finds it (the scope and
  what it uses, not the parent), is defined in the clone divided by the
  scale with Scheme's `/` (`Heap::div`); then `cloned` is `#t`.
- **Why.** The step needed the scaled layout of `score.cc:135–142` and
  only this function of the init files to make it. Giving the scheme crate
  first-class variables would add a feature for one 20-line caller, and
  the image's `scale-layout` would then be called from Rust through the
  VM. The port keeps the change inside the crate that owns `OutputDef`,
  and its result is checked against LilyPond's through the probe
  (`ly:grob-default-font`, `tools/compare/grob-calls.ly`).
- **Consequences.**
  - The image's `scale-layout` stays defined but unused by the engine. A
    file that calls it still throws as before, since the scheme crate has
    no `module-variable`.
  - A later port that reaches such a function does the same and records
    it here, with its lines; one that needs the Scheme to run as Scheme
    (user code may redefine it) asks the user first.

  progress.md, MS3 step 14a.

## D111 — Layout depends on the skyline crate from MS3 part 3, and the calls of `skyline.cc` that part 3 makes are ported into it first

**Status:** accepted (the user's answer 4 at MS3 part 3's split,
2026-10-14) · **Amends:** D104 · **Changes, in MS3 part 3:**
`crates/layout/Cargo.toml` (a dependency on `lily_engine_skyline`, step
26), `crates/skyline` (the calls of `skyline.cc` and `skyline-pair.cc`)

- **What.** D104 has layout depend "on the skyline crate from Y2 (part
  4)". It depends on it from part 3:
  - **`crates/layout` depends on `crates/skyline`** (W2's
    `lily_engine_skyline`) from step 26, the first step of part 3 that
    reads a skyline.
  - **The calls of `skyline.cc` and `skyline-pair.cc` that part 3's files
    make go into `crates/skyline`**, followed inside the two files: 43
    functions, 601 lines, `distance`, `padded`, both `internal_distance`s,
    `internal_merge_skyline` and `internal_build_skyline` among them
    (`$LILY_CORPUS/ms3-part3-split/skyline.txt`). W2's `Skyline`,
    `SkylinePair`, `merge`, `from_segments` and `glyph_skylines` are kept
    where they build the same skyline.
  - **They are counted as part 4's lines ported first.** *The shares*
    counts `skyline`, `skyline-pair` and `skyline-scheme` in part 4's row,
    so part 3's split counts the 601 lines as another part's functions,
    as part 2's `borrowed.txt` counted its own. Layout's README §4.1 row
    is charged for them, since D104 already puts `lily_engine_skyline` in
    *Layout and notation*.
  - **The other boundaries hold:** no crate beyond `layout`, `skyline` and
    `svg`; the music crate names no layout type and holds no more of
    layout than D108's slot; the core keeps only the calls behind 08
    §4.2's ABI.
- **Why.** Part 3's files build, merge and measure the distance between
  skylines: `axis-group-interface`, `align-interface`, `system`,
  `separation-item`, the spacing and the accidental placement, 11 files
  in all, and the default skylines and `get_pure_minimum_translations`
  that steps 13 and 14 placed in part 3. `crates/skyline` has `Skyline`
  and `merge`, but no `distance`. Waiting for part 4 would have meant
  porting the skylines into layout and moving them later, or a stand-in
  for them. The other options were a skyline module in `crates/layout`,
  or the skylines ported in part 4 before the rest of part 3 lays out.
- **Consequences.**
  - Step 26 adds the dependency and the calls, and probes them against
    LilyPond 2.26.0's `ly:skyline-*` results. W2's glyph skylines stay
    point for point (`skylines.ly`).
  - Part 4's split takes the 601 lines out of its count, and part 3's
    re-estimate carries them (progress.md, *Part 3*, *The re-estimate*).
  - A skyline call that would need a crate beyond these three stops for
    the user, as D104's stop does.
  - D104's last consequence, that 05 §5's cheaper machinery waits for R1,
    is lifted for part 3 by the user's answer 3 at the same split, which
    progress.md records (*Settled with the user at part 3's split*): a
    skyline cache per glyph and an index of placed skylines may be built
    in `crates/skyline` or layout before R1's answer, each recorded with
    its lines.

  progress.md, MS3 step 24 (*The plan*, *Settled with the user at part
  3's split*).

## D112 — Lily Studio: a Stems workspace, with RoFormer MLX's separation as a uv sidecar

**Status:** accepted (the operator chose option A of the design, 2026-10-14)
· **Refines:** D28, D42, D55 · **Numbered:** after feat/engine's D57–D111, so the branches do not collide

- **What.** Lily Studio takes in RoFormer MLX
  (the separate `roformer-karaoke-mlx` checkout), which splits a song into
  karaoke stems (lead vocals and instrumental, the `becruily` and
  `aufr33-viperx` models) or six (vocals, drums, bass, guitar, piano and
  other, `bs-roformer-sw`) on Apple Silicon. A *Scores | Stems* switch at the
  top of the sidebar picks the workspace. *Scores* is the studio as it was.
  *Stems* lists past separations where Files was. The Separate view spans the
  editor and preview columns: drop a song, pick a model grouped *Karaoke* /
  *All instruments*, a quality and a format, then Separate, with progress and
  Cancel. There is one player per stem, and ticked stems export as a mix.
  Show in Finder is kept. A separation goes on running in Scores, and the
  status line shows it. A stem leads to a score: *New score for bass…* writes
  `bass.ly` from an instrument template beside the stems, and a *Stem* strip
  above the preview's transport plays the stem alone or with the score's
  MIDI. The design, with its mockups and the two other options (a second
  window; a song library as a new app), is the published page "Lily Studio
  Stems".
- **Where the code lives.** `packages/studio/crates/separate`
  (`lily-separate`), with no Tauri in it, is a port of RoFormer's
  `app/src-tauri/src/lib.rs`. It finds the project (`project_root`) and uv
  (`find_uv`) and builds `uv run --quiet --project <root> karaoke-mlx --json
  …` (`Sidecar::command`). It also runs one separation at a time in its own
  process group (`Separator`), and lists `models` and `mix`es stems. Only
  `src-tauri` depends on it. `crates/session` and the web server never run
  it.
- **Commands** (`src-tauri/src/separate.rs`): `separation_status` (the
  project, uv, what is missing, whether one is running), `separation_models`,
  `separate` (answers the stems' folder), `separation_cancel`, `mix_stems`
  (a save panel names the file), `reveal_in_finder`, and for the
  stems-to-score path `new_score_for_stem` and `attach_stem`. Each event karaoke-mlx prints goes to
  the page on the studio's one channel as `{type: "separation", event}`, not
  on RoFormer's `karaoke://event`. A CLI that dies without an `error` event,
  because it was cancelled or crashed, gets one with the end of its stderr
  and `cancelled`, so the page always hears how a separation ended.
- **Security.** The capability stays `core:default` (D42). The page reaches
  no plugin; Show in Finder and the mix's save panel run on the Rust side. The
  stems play through the asset protocol (Tauri's `protocol-asset` feature,
  `assetProtocol.enable`), whose static scope is empty. Before a `done` event
  reaches the page, its folder is allowed with `allow_directory(folder,
  false)`, not recursively. That is narrower than RoFormer's `$HOME/**` and
  `/Volumes/**`. Mixing and Show in Finder take only that folder and the
  files directly in it. The CSP gains `media-src 'self' asset:
  http://asset.localhost`: it starts from `default-src 'none'`, which would
  block every `<audio>`. A song must be an absolute path to a file, and the
  model and format plain words, so nothing the page sends is read as an
  option.
- **The Python.** karaoke-mlx's Python moves into this repository as
  `packages/separate`. Until it does, it stays in RoFormer's checkout, which
  nothing commits to. The root is, in order: `KARAOKE_MLX_ROOT`; a
  `separation.root` setting, which the setup card writes; `packages/separate`
  beside the studio; then RoFormer's checkout. A root that the variable or
  the setting names must hold a `pyproject.toml`, and is never passed over
  for a default. uv is looked for on the studio's search path, then in
  Homebrew's folders, `~/.local/bin` and `~/.cargo/bin`. The CLI runs with
  Homebrew's folders ahead of the search path, where ffmpeg is. Quitting the
  app ends a running separation's process group, which RoFormer's own app
  did not do.
- **Web (D55).** Separation needs the Mac. The page asks the bridge
  `separationAvailable()`, which is the transport's `separation`. The web
  transport's stub (`src/web/separation.ts`) answers `{available: false,
  reason}` and rejects every separation call with *Separating stems needs
  the Mac app.*, without asking the worker. The switch is not drawn on the
  web, as the agents are not. The worker refuses the separation commands
  with the app's others it does not offer, should a page send one, and no
  `separation` event reaches the socket.
- **The renderer's calls** (`src/renderer/bridge.ts`, typed in
  `src/ipc.ts`): `separationStatus`, `separationModels`, `separate`
  (waits for the channel, so no event is missed), `cancelSeparation`,
  `mixStems`, `revealInFinder`, and `onSeparation` for karaoke-mlx's
  `status`, `progress`, `done` and `error` events.
- **Data and identity.** The name stays "Lily Studio", the identifier
  `io.github.velet5.lily-studio`, and the icon the lily. So
  `~/Library/Application Support/Lily Studio`, `~/Documents/Lily Studio`,
  WebKit's local storage and the caches stay where they are, and nothing is
  migrated. The only new file is `separations.json`, the recent
  separations, in Application Support beside the others. Stems go next to
  the song in `<song> (stems)` or `<song> (karaoke)`, as RoFormer writes
  them. RoFormer MLX's own app stays buildable in its repository.
- **Keeping the data in place.** `src-tauri/src/profile.rs` names the data
  folder (`data_folder`: Application Support › `Lily Studio`, the Electron
  studio's, by name and not by identifier). Its tests fail if the identifier,
  the name, the main binary's name or `package.json`'s `productName` changes,
  if an icon the bundle lists is missing, or if `tauri.local.json` overrides
  more than the signing. Another test starts a studio on a profile an earlier
  one left, with the Electron studio's `Local Storage` and a file the studio
  does not know, and finds every file there, byte for byte, and nothing in
  Documents. Moving the data would need its own decision and the user's
  consent at launch; nothing here moves it.
- **The install collision (#1200).** The single-instance plugin's socket is
  `/tmp/io_github_velet5_lily_studio_si.sock`, from the identifier alone (no
  `semver` feature). `npm start` and the installed app share it, so a
  dev build started while Lily Studio is open hands its launch to the open
  one and exits. That is kept: both write the same profile, and a second
  identifier for development would still share Application Support ›
  `Lily Studio`. The studio's README says to quit the app first.
- **The switch** (`WorkspaceSwitch` in `src/renderer/sidebar.ts`) is a
  tablist drawn where `separationAvailable()` says separation runs. Stems'
  two panes lie over the files and over the editor's and the preview's
  columns. The other workspace's panes are made invisible and inert, not
  removed or hidden, so Monaco, the preview's zoom and scroll and the file
  list stay as they were behind Stems. Each launch starts in Scores. Opening
  a score or a folder, New Score and Help › Welcome go back to Scores.
- **The Separate view** (`SeparateView` in `src/renderer/separate.ts`) is
  RoFormer's page in Lily's panes: the song, the model in *Karaoke* / *All
  instruments*, Fast, Balanced or Best (2, 4 or 8 overlapping chunks, Balanced
  first, as RoFormer had them) and WAV, FLAC or MP3 on the left; on the right
  one `<audio>` per stem, one playing at a time, and the ticked stems' *Export
  mix…*. Show in Finder is in the pane's header. The run button says *Make
  karaoke* or *Separate instruments*, and *Cancel* while one runs. Its models
  are asked for when Stems is first shown, not at launch, since that starts
  Python, and again after each separation, which may have downloaded one. A
  missing project or uv shows its reason with *Check again* in place of the
  models. The status line follows a separation in either workspace. The
  bar shows karaoke-mlx's `progress` stages, not its `status` lines, which
  are its log, as RoFormer's app did. The channel's `done` may come after
  the `separate` command has answered, and still shows the stems of the song
  and model it was started with.
- **Choosing the song.** `choose_song` (separate.rs) opens AppKit's panel
  for the formats karaoke-mlx's ffmpeg reads; the web's stub and the worker
  refuse it with the others. Tauri takes files dropped on the window, so the
  page gets no HTML drop: the app's transport passes on Tauri's drag and drop
  events as `FileDrop`, and a song dropped anywhere in the window goes to the
  Separate view and shows Stems. The stems play from the asset protocol's
  URLs (the transport's `fileUrl`, `studio.stemUrl`). A mix saved outside the
  stems' folder is not in the asset scope, so it is exported but not played.
- **From a stem to a score.** #1199 says no transcription code exists, so
  a stem leads to a score written by ear. Each stem's row has *Score…*, or
  *Score… (hard)* for guitar, piano, other, the instrumental and any stem
  karaoke-mlx adds later, which #1199 found the hardest to write down. Its
  menu offers *New score for bass* (no ellipsis: no panel asks anything),
  says what it writes, and has *Show … in Finder*. The page makes the score
  (`stemScore` in `src/renderer/files.ts`): the instrument's staff, clef and
  General MIDI sound (bass: `bass_8`, electric bass; guitar: `treble_8`;
  drums: a DrumStaff; piano: a PianoStaff; vocals: a treble staff and
  words), four bars of rest, `\layout` and `\midi`, titled "<song> —
  <stem>". Its `% Stem: <song> - bass.wav` line names the stem. The vocals'
  `\lyricsto` line starts commented out: lyrics over a tune of rests alone
  warn once `runtime/timing.ly` maps playback. `new_score_for_stem` takes
  the stem, a plain name and the text. The stem must be in a folder
  separated this run. It writes `<name>.ly` beside the stem, or `<name>
  2.ly` and so on, and never writes over a file. Then it opens it as Open
  Score would, so the stems' folder becomes the open folder and Scores is
  shown. When a score is shown, its `% Stem:` line (`stemOfScore`) is
  passed to `attach_stem` with the score. That command takes only a name:
  an audio file directly beside a score the page may open, with no link out
  of the folder. It lets that one file into the asset scope, so the strip
  also works after a restart. The strip (`StemStrip` in
  `src/renderer/player.ts`) has ▶, a slider, the time, *With score* and ✕.
  With score plays the score's MIDI with the stem, each from where it is:
  the user puts the stem where the score's first bar (or start mark)
  begins. Pause pauses both, and the slider moves the stem alone. ✕ hides
  the strip until the score is shown again. The strip is not drawn on the
  web. When transcription exists, a *Transcribe* button fits in the strip,
  and it has what #1199 asked for: an audio file and an instrument name.
- **Not done yet.** The Separations list, the `separation.root` setting and
  its setup card, `separations.json`, and moving the Python. The file list
  shows only scores, not the stems beside them. Folders
  separated in an earlier run are not in the asset scope until a later step
  lets the recent separations in again.
- **Verified.** `crates/separate`'s tests run stand-ins for uv: the root's
  order and refusals, uv's places, the command line, a request's
  arguments, events passed on in order, an `error` event, a silent death
  reported from stderr, one job at a time, and Cancel ending the CLI's own
  child too. They also cover `models` and `mix`. `separate.rs`'s tests cover
  which paths count as inside a separated folder, and the mix's name.
  `test/web.test.ts` checks that the stub rejects each command
  `src-tauri/src/lib.rs` registers, and only those, and that the worker
  refuses them too; crates/server's test asks a worker to separate.
  `workspaceForKey` has unit tests, and the smoke test, in the real window,
  switches to Stems, sees it cover the files and the editor's and the
  preview's columns, sees the Separate view wait for a song, and goes back
  to Scores. `test/separate.test.ts` covers the view's pure parts: which
  files are songs, the model groups and names, the qualities and formats,
  progress and its stages, the stems' names and the mix button, and that the
  panel's extensions are the view's, and the Score… labels.
  `test/files.test.ts` checks each stem's score: its `% Stem:` line read
  back, its instrument, the hard ones, quoting the song in the title, and
  that a line naming another folder is ignored. It also engraves every
  stem's score, and an unknown stem's, through `lily-outcome`, with no
  error or warning and with MIDI. `separate.rs`'s tests cover writing beside
  the stem without writing over a file, refusing names that are not plain,
  and which names `attach_stem` takes.
- **Separated in the app.** Given a song as `LILY_SMOKE_SONG`, the smoke
  test separates a copy of it, in a scratch folder of its own that it
  deletes. `smoke_drop` sends the page the event Tauri sends for a drop from
  the Finder, so the song arrives as a dropped one does. BS-RoFormer SW
  at Fast splits it into six stems. Each must load from the asset protocol
  and last as long as the others, bass and drums must export as a mix that
  plays, and *New score for bass* must open `bass.ly` in Scores with the
  bass in the Stem strip. The run may then take a quarter of an hour longer,
  since a first separation downloads its model. `npm run test:e2e` does the
  same in the installed app when `LILY_E2E_SONG` names a song, with the
  Finder's bare PATH, so RoFormer MLX and uv are found as a user's copy
  finds them. The operator's desktop was in use, so this replaces driving
  the window with UI automation. The test song (3:43) took 55 s.

## D113 — Lily Studio: a stem's score is transcribed from it (lily-transcribe)

**Status:** accepted (the operator approved the design, with a rough draft of
chords for the hard stems and kick, snare and hi-hat for drums, 2026-10-14)
· **Refines:** D112 · **Research:** `docs/research/audio-transcription/`
(#1199)

- **Why.** D112's *New score for bass* wrote four empty bars, titled with the
  song's raw file name. On a real song (3:43) the operator found that no
  help. A score from a stem now holds the stem's notes on the song's own
  tempo, meter and key, from its start to its end.
- **Where the code lives.** `packages/transcribe` (`lily-transcribe`) is a
  uv Python project, not an npm package. It is run as karaoke-mlx is (D112):
  `uv run --quiet --project <root> lily-transcribe --json transcribe <stem>
  --instrument <stem name>`, one JSON event per line (`progress` with a
  stage, then `done` with the transcription, or `error`). crates/separate's
  `Transcriber` runs it, one at a time, in its own process group; separation
  and transcription share that crate's `Job`. The root is
  `LILY_TRANSCRIBE_ROOT`, which must be a project, or `packages/transcribe`
  beside the studio. The command is `transcribe_stem` (separate.rs). It takes
  only a stem in a folder separated this run, and the instrument must be a
  plain word. Its events reach the page as `{type: "transcription", event}`.
  The web stub and the worker refuse it with the other separation commands.
  Quitting ends a running transcription.
- **Dependencies.** Python 3.11, which Basic Pitch 0.4 needs; uv fetches it.
  Basic Pitch 0.4.0 (Spotify, Apache-2.0, a 230 KB model in its wheel, CoreML
  on a Mac) hears the notes. Beat This! 1.1.0 (CPJKU, MIT for code and
  weights) finds beats and downbeats; it brings torch (BSD), and its 77 MB
  checkpoint downloads on the first transcription. madmom's DBN is not used:
  it is for non-commercial use only. `setuptools<81` is pinned because Basic
  Pitch pins resampy below 0.4.3, which still imports `pkg_resources`.
  MuScriptor's weights (CC BY-NC) and YourMT3+ (GPL) were not taken (#1199).
- **The song's grid.** Beat This runs on all the song's stems mixed back
  together, not on the stem: a bass or vocal stem has no drums to keep time
  with. A straight grid is fitted through the beats. It ignores the fills
  that Beat This counts in eighths, and is snapped to a whole number of beats
  per minute when it is within 0.1 of one and fits as well (123.015 measured
  is 123 played to a click). When 80 % of the beats sit on such a grid, the
  song is *steady*; otherwise the beats are kept as found, with extra ones
  dropped and missed ones put back, and the score says its MIDI drifts. The
  downbeats vote for the meter (2, 3 or 4 beats) and for bar 1, which is the
  first bar line at the start or after it. The time before it is the pickup.
- **The song's key and tuning.** Basic Pitch hears every stem but the drums,
  mixed. The key is Temperley's (Kostka–Payne) profile correlated with how
  long each pitch class sounds. Krumhansl and Kessler's profiles left C major
  and C minor nearly equal on the test song, and a spectrum's chroma read it
  as major (every root's fifth harmonic is its major third). The tuning is the
  median of the notes' pitch bends. Each note is re-centred on it, so a
  singer's sharp E-flat is not written as E. The grid, key and tuning are
  kept per song in `~/.cache/lily-transcribe` (`LILY_TRANSCRIBE_HOME`), so
  the song's other stems take seconds.
- **The notes, by family** (`instruments.py`). *Melody* (bass, vocals): one
  note at a time on sixteenths. A note outside the instrument's range is
  dropped, as is one shorter than most of a sixteenth, or an overtone of a
  lower note sounding as it starts (+12, +19, +24, +28, +31 semitones, not
  louder). Of two notes starting together, the stronger stays. A note lasts
  until the next one starts, and a short silence after it (a sixteenth; an
  eighth for a voice) is its release. A voice also joins same-pitch fragments
  and drops notes more than an octave from its middle pitch. *Chords*
  (guitar, piano, other, the instrumental and any later stem): a rough draft
  on eighths. The notes starting together are a chord of up to the
  instrument's voices, lasting until the next. *Drums*: kick (30–150 Hz),
  snare (600 Hz–2.5 kHz, above the kick's overtones) and hi-hat (5–11 kHz),
  each a rise of the band's energy above 1 % of its own loud level. Each peak
  goes to its nearest sixteenth, and is a hit when it is at least 35 % of the
  band's strongest. Toms and cymbals are not told apart.
- **The score** (`stemScore` in files.ts, `src/renderer/notation.ts`). It is
  written as a person would type it: pitches spelled in the key (#1, ♭3, #4,
  ♭6 and ♭7 in major; ♭2, the raised third, sixth and seventh in minor) in
  `\relative` without a start pitch. A note is split at the beat where its
  place asks and tied, also across bar lines; quarters and dotted quarters
  may start on an eighth, as pop's syncopations do. Rests start on multiples
  of their length, and empty bars are whole-bar rests (`R1*8`, with
  `\compressEmptyMeasures`). Bass is in `bass_8`, guitar in `treble_8`, a
  voice in `treble_8` when its middle note is below A3, piano on two staves
  parted at middle C, drums in `\drummode`. A bar number comment marks every
  fourth bar. The title is the song's, from its file name (`artist_-_title`
  as downloads write it gives "Some Artist" and "Some-song"); the
  stem is `instrument`. The `% Stem:` line, the Stem strip, writing beside
  the stems and never over a file are D112's.
- **With score keeps time.** The stem strip plays the score's MIDI and the
  stem each from where it is (D112). The pickup bar's MIDI lasts exactly as
  long as the stem plays before bar 1: a hidden `\once \omit
  Score.MetronomeMark \tempo 64 = N` sets it, and `\tempo 4 = 123` follows at
  bar 1. Started together from their starts, they stay together to the end
  of a steady song. `Score.tempoWholesPerMinute` is not set by hand: 2.24
  takes a moment and 2.26 a rational, and `\tempo` takes only whole numbers
  in 2.24. A tempo that is steady but not whole says how far the MIDI drifts
  by the end.
- **The menu.** *New score for bass* transcribes, then writes and opens the
  score. While it runs, the Score… button says *Transcribing…* and the status
  line names the stage (reading the song, finding the beats, finding the
  key, hearing the notes). *Empty score for bass* writes D112's four empty
  bars. A failure says why and points to it. The hard stems' button says
  *Score… (draft)*.
- **Measured on the test song** (Song C, 3:43, BS-RoFormer SW at
  Fast, the development Mac). Grid: ♩ = 123, 4/4, all 109 downbeats on one bar phase,
  94 % of the beats within 40 ms of the straight grid; bar 1 at 0.21 s. Key
  C minor (0.80). Against pYIN on the bass stem, sixteenth by sixteenth: the
  same pitch in 89 % of the slots where both hear a note (82 % before the
  overtone rule), an octave off in 0.7 %. Most of the rest are slots where
  Basic Pitch hears a fifth or a twelfth above pYIN, and the spectrum does
  not say which is right. The drums give a steady groove: kick on 1, 3, 4 and
  the "and" of 4, snare on 2, the "a" of 2 and the "and" of 3, hi-hat on the
  eighths. In the app, *New score for bass* took 15 to 19 s for a song not
  yet transcribed, and a further stem of it about 10 s.
- **Not done yet.** The vocals are a first draft: vibrato and glides still
  leave fragments and accidentals. No lyrics. The meter and bar 1 are not yet
  shown for the user to confirm (#1199 §4), and a drifting song's MIDI does
  not follow its tempo. Piano has no piano model or hand split beyond middle
  C, guitar no tablature. Like `packages/separate`, an installed app finds
  `packages/transcribe` by the path it was built from, or through
  `LILY_TRANSCRIBE_ROOT`.
- **Verified.** `uv run pytest` in packages/transcribe: the grid (a click
  track with a fill, a tempo between whole numbers, three beats a bar, bar 1
  at the start, a drifting song, cleaned beats), the quantizing (range,
  blips, the stronger of two, overtones, releases, a voice's fragments and
  spread, chords and voices), the key (minor, major, transposed), drums on a
  synthesized rock beat, and the CLI's events with the models replaced,
  including the cache. crates/separate's tests run lily-transcribe's stand-in
  for its arguments, events, answer and failures, and its root. notation's
  tests cover spelling, `\relative`, the pieces of notes and rests, a voice
  with a pickup, ties across bars and whole-bar rests, and drums.
  files.test.ts engraves every stem's transcribed score through lily-outcome
  without warnings, and finds bar 1 of its MIDI at the stem's 0.2 s. The
  scores of the test song's six stems engrave without warnings on LilyPond
  2.24.4 and 2.26.0. With `LILY_SMOKE_SONG`, the smoke test transcribes the
  bass in the real app and checks bass.ly's tempo, notes and bars against
  the stem; on the test song: ♩ = 123, 4/4, C minor, 115 bars for 3:43.

## D114 — Lily Studio: the songs separated before open again

**Status:** proposed · **Refines:** D112, D49

- **Why.** The operator separated the same song on every launch: the stems
  were on disk, but the Stems view only showed those of a separation made in
  this run of the app.
- **What.** Under the settings of the Separate view, *Recent* lists the songs
  separated before, last opened first: the song's name (its folder's,
  without ` (karaoke)` or ` (stems)`), then the kind, how many stems and
  when. A click shows the stems as a separation would: players, the mix,
  Score… and Show in Finder. ✕, on hover, takes one off the list and leaves
  its stems. *Open…* takes a folder of stems made earlier, by this app or
  RoFormer's, and lists it. The song shown is marked; the list is disabled
  while a separation runs.
- **Kept.** `separations.json` beside recent.json (crates/separate's
  `history`): twenty entries, each folder once, with its stems' files, how
  long the separation took and when it was opened. A separation goes on it
  when it is done, after its `done` event; opening one puts it in front. A
  broken file loads what it can. A gone folder stays, dimmed and marked Not
  found, as D49's do; opening it says it is gone.
- **The folder is let in** as a separation's is: the asset scope and the
  folders that mixing, Show in Finder and transcribing take
  (`Stems::allow`). `open_separation` opens only folders on the list, and
  `choose_separation` only the one its panel chose. A folder's stems are
  the files the list kept that are still there, or else its
  `<song> - <stem>.wav|flac|mp3` files, a mix (`- mix`) left out, in the
  view's order (`history::scan`).
- **The web** has none of it: the four commands join D112's in the stub and
  the worker's desktop-only list.
- **Verified.** `history` tests (from a `done` event, order and limit, a
  folder's stems, saving, loading, gone folders); `test/separate.test.ts`:
  `folderSong`, `folderTask`, `pastMeta`; the web tests check the command
  lists. `npm test` in packages/studio passes, the smoke test included.
- **Not done.** No smoke step for the list, and not yet checked by hand in
  the app. The model a song was separated with is not kept, so a karaoke
  folder renamed without its suffix is told by its instrumental stem.

## D115 — Lily Studio: `npm start` without Tauri's dev server

**Status:** accepted · **Refines:** D42

- **Why.** `npm start` opened no window: Lily Studio sat in the Dock, its
  window hidden. With no `devUrl`, `tauri dev` (CLI 2.12) serves
  `frontendDist` from a server of its own on `127.0.0.1:1430` and points the
  webview there. The window's `on_navigation` lets in only `tauri://` and
  `tauri.localhost`, so the first navigation was refused, the page never
  loaded, and the window, shown when the page has loaded, never was. The
  smoke test runs through `cargo run`, which loads the embedded pages, so it
  passed.
- **What.** `npm start` runs `tauri dev --no-dev-server`: the dev build loads
  `dist/web` from the `tauri://` protocol, as the smoke test and the
  release do. The page still never navigates. There is no live reload of the
  page; esbuild did not watch it anyway, so a change to the renderer is seen
  by running `npm start` again.
- **Verified.** By hand: `npm start` shows the window and the score last
  open. Nothing in the tests runs `tauri dev`.

## D116 — Lily Studio: the piano view, the music falling onto a keyboard

**Status:** proposed · **Refines:** D35, D45

- **What.** **Piano** in the transport, and *Source | Piano* in the editor's
  header, put a piano view over the editor: a keyboard along the bottom and
  the notes falling onto it, as piano videos on YouTube show a piece. A note
  touches its key when it sounds and lights the key while it lasts; each
  part has its colour, and a note long and wide enough carries its name (C,
  C#, Eb, F#, Ab, Bb, as those videos spell them, whatever the key). The
  white keys are lettered, with the octave on each C (middle C is C4). The
  stage is dark in both themes. Piano again, or *Source*, brings the editor
  back as it was; opening a file or the welcome screen does too.
- **Keys.** A selector in the header shows *All 88 keys* (A0 to C8) or *The
  score's notes*: whole octaves, from the C under the lowest note to the B
  over the highest. The choice is kept in the window's storage.
- **What falls.** The player's music, so a part the Parts fold mutes is not
  there and a seek or the start mark moves the fall; the drums have no keys
  and are left out. Three seconds of music are shown above the keys. The
  view follows the heard position (D51), redrawn each frame while the music
  plays and only then; Space plays and pauses in it, as in the preview.
- **How.** `src/renderer/piano.ts` draws on a canvas at the screen's pixel
  ratio and redraws when its pane is resized. `ScorePlayer` has the button
  and tells the view of each change; the view reads `midi`, `position` and
  `playing` from it. The editor keeps its model and state behind the view.
- **Not done.** No falling notes in the extension's preview. Notes are not
  spelt from the key signature, which the MIDI carries but midi.js does not
  read. The time shown cannot be zoomed. A hand per staff is not inferred:
  the colour is per MIDI track, which is per staff.
- **Verified.** `piano.test.ts` covers the names, the notes kept, the
  ranges and the keys' layout. In `npm run test:smoke`, Piano, pressed while
  paused, shows the view with notes over the editor, and *Source* brings
  Monaco back. The drawing was looked at in headless Chrome, with stand-in
  notes for two hands, at both ranges; not in the app while playing.

## D117 — Lily Studio: the piano view below the score, its tracks, and a pause that pauses

**Status:** proposed · **Refines:** D116, D35

- **Below the score.** A selector in the piano view's header puts it *Over
  the source*, as D116 has it, or *Below the score*: a strip of the preview
  pane, 38% of its height, between the pages and the transport, with its
  selectors on a bar along its top. There it stays under SVG and PDF alike
  and the source stays in the editor; Piano in the transport shows and
  hides it, and opening a file or the welcome screen leaves it. The editor's
  *Piano* tab puts it over the source again. The choice is kept in the
  window's storage.
- **Tracks.** A *Tracks* button opens a box per part with keys, in its
  colour and with the Parts fold's name for it; an unticked part's notes do
  not fall, though it still sounds (muting is the Parts fold's). A part keeps
  its colour when another is hidden, and *The score's notes* range follows
  the parts shown. The button is marked while a part is hidden. The hidden
  parts are kept per score in the window's storage, by track.
- **Pause.** The transport was drawn again on each tick while playing (every
  100 ms), and its ▶/❚❚ button's text replaced each time. WebKit drops a
  click whose press and release land on either side of such a replacement,
  so ❚❚ seldom paused, while ▶, drawn only on a change, always played. The
  transport and the Stem strip now set a text only when it changes.
- **How.** `index.ts` moves the view's body and its header actions between
  the editor and the `.piano-dock`, and Space in the view toggles once
  where both panes listen. `ScorePlayer` gives the view `rootFile` and
  `parts`; `pianoTracks` in `piano.ts` lists the tracks with their colours.
- **Not done.** The strip's height cannot be dragged. A part is not hidden
  from the pages' marks or the playhead.
- **Verified.** `piano.test.ts` covers the track list. In `npm run
  test:smoke`, *Below the score* shows the strip with the source back in the
  editor, unticking the one track empties the fall, and *Over the source*
  brings the view back over the editor. The pause was not clicked by a
  mouse in a test: the smoke test's `click()` has no press and release.

---

## D118 — Playback position: a variable's places in reading order

**Status:** accepted · **Refines:** D26

- **The fault.** D26 pairs an href drawn as often as it is played with its
  places in order, taking the order of `sourceLinks`, which is the order the
  SVG lists its elements. Between systems that is the reading order; within
  one it is not: in *Song A* the SVG lists the first note of
  `\pE` in bar 5 before the one in bar 1 of the same system. Bar 1's time
  went to bar 5's place and bar 5's time to bar 1's, so the playhead ran back
  to the start of the line at bar 5 and then jumped on, and each jump back
  also split the system in two (the score had 24 systems for its 19).
- **Decision.** `timelineOf` pairs such an href with its places in reading
  order (`readingOrder` in `web/preview.js`): by page, then by row, then from
  left to right. Sorted by vertical centre, a place begins a new row when it
  lies more than three heights (its own or the one above's, the larger)
  below the one above: a notehead is about a staff space high, the same
  staff on the next system at least eight further down, and noteheads of one
  chord or a transposed use stay within the row. If a place has no box the
  SVG's order is kept.
- **Verified.** `player.test.ts` pairs a variable played four times whose
  places the SVG lists out of order; it fails without the change. Run over
  *Song A*'s pages and map (boxes from the SVG's translations),
  the cursor no longer moves left within a system and the score has its 19
  systems.

---

## D119 — Go to definition, and the definition on hover

**Status:** proposed · **Refines:** D21, D29

- **What.** ⌘-click or F12 on a `\name` the score defines (`pCis = { … }`)
  goes to its definition, in both apps; ⌘ held over it underlines it and
  previews the definition. Hovering over it shows the definition as code, up
  to the line where its braces, `<< >>` or Scheme parentheses close (twelve
  lines at most), with the file and line when that is another file. A
  score's own definition is shown before the built-in documentation of the
  same name (D21), since it is the one lilypond uses.
- **Which definition.** The one in effect where the name is used: the
  nearest before it, going into each `\include`d file on the way (relative to
  the including file, eight levels deep at most, which also stops a file that
  includes itself). When none comes before, the first one after it in the
  same file. A definition is `name = …` or `"name" = …` at the start of a
  line, or Scheme's `(define name …)` / `(define (name …) …)`, outside
  comments and strings; `\set name = …` is not one.
- **How.** `@lily/common/definition` finds it, given a way to read and
  resolve included files: the extension reads an open editor's text, else
  the disk; Lily Studio an open model's text, else `read_file`. In Studio a
  definition in another file gets a Monaco model when it is found, so that
  ⌘ held previews it, and going there opens the file as the file list does
  (`registerEditorOpener`).
- **Not done.** A file the score includes does not see the score's
  definitions: in `piano.ily` a name defined in the `main.ly` that includes
  it is not found. lilypond's include path (`-I`) is not searched. Find All
  References and Rename are not offered.
- **Verified.** `test/intellisense/definition.test.ts` in the extension
  covers the name under the cursor, definitions, previews, includes and the
  choice among several; Studio's `files.test.ts` the included file's path.
  Neither app's providers were exercised in a running editor by a test.

## D120 — Playback position: a variable played more often than drawn

**Status:** accepted · **Refines:** D26

- **The fault.** An href drawn in several places and played some other number
  of times took the first of its places within the band of the system playing
  then, else its first place. In *Song D* the guitar's figures are
  variables (`\guitarCIntro`) drawn in bars 1, 3, 5 and 7 and played ten times
  once the volta repeat is unfolded. A system's band is the union of its
  placed moments, which here was the melody staff alone, so no guitar note was
  within it and every one went to bar 1: playing bar 5 lit bar 1's guitar.
  Had the band held the guitar staff, bar 5 would still have gone to bar 1, the
  first place on that system.
- **Decision.** Such an href takes, of its places in the *region* of the
  system playing then, the one whose centre is nearest the cursor's x at that
  time. A system's region is the part of its page nearer to its band than to
  the other systems' on that page (cut halfway between bands), so the staves
  without placed moments still belong to it; another pass through the same
  system overlaps its band and is not a neighbour. With no place in the
  region it is the first place, as before.
- **Verified.** `player.test.ts` in the studio has a variable drawn three times
  below the melody and played four times; without the change all four went
  to the first place. Run over *Song D*'s map and pages (boxes from the
  SVG's translations), the elements more than 8 % of the page width from the
  cursor went from 242 of 1582 to none.

## D121 — A volume for each track: the MIDI Player and the Parts fold

**Status:** accepted · **Refines:** D24, D45

- **What.** The extension's MIDI Player has a **Volume** column in its track
  table, and each row of Lily Studio's Parts fold a slider after the
  instrument. Both go from 0 to 200 % in steps of 5, show the percentage, and
  a double-click puts them back at 100 %. The music changes as the slider is
  dragged, during playback too.
- **How.** midi.js's synthesizer has a bus per track and channel (it had one
  per channel): the panner, then a gain that is the track's volume.
  `Player.setTrackVolume(track, volume)` sets it on the buses that exist,
  smoothed over 20 ms so that a drag does not click, and keeps it for those
  made later; it outlasts `load()`, so a rewritten file or a remix plays on at
  the same volumes. Nothing is reloaded, unlike a mute or a program (D45),
  which change the notes.
- **Kept.** In the MIDI Player, in the webview's state, so a hidden tab keeps
  it; a new tab of the file starts at 100 %. In Studio, as `volume` in percent
  in the part's setup (`playback.json`), saved when the slider is let go; 100
  is not written. The Rust side keeps a whole number up to 200.
- **Verified.** midi.test.ts in the extension: a track's bus starts at its
  volume, a change reaches what sounds, and volumes outlast another load.
  `playbackSetup.test.ts` (`withPart`, `partVolume`) and `playback.rs`'s test
  of what is kept. Not listened to in a running app or editor by a test.
- **Not done.** Export MIDI (D54) writes the file as compiled, without the
  volumes. Studio's piano view does not show them.

## D122 — Lily Studio: ⌘B hides the sidebar; the preview the window's width

**Status:** accepted · **Refines:** D40, D32

- **What.** View › **Toggle Sidebar** (⌘B) hides the sidebar, files, agents
  and the Scores | Stems switch with it, and shows it again as it was. View ›
  **Preview Full Width** (⌥⌘↩), or ⤢ at the right of the preview's header,
  gives the preview the whole width of the window and goes back. ⇧⌘↩ was not
  taken: it is the editor's Insert Line Above. The web's menu bar has the same
  View menu and keys (D55).
- **How.** A hidden sidebar sets `data-sidebar-hidden` on the grid and its
  column to 0; whether it is hidden is remembered in the window's storage
  beside its width. Full width sets `data-preview-full`, which makes the first
  two columns 0 and draws neither the sidebar nor the editor; nothing is
  remembered, so each launch shows the editor. ⌘B in full width goes back to
  everything; Help › Welcome, which is in the editor's place, leaves full
  width; a fold opened for the agent (D41) shows a hidden sidebar.
- **Verified.** `web.test.ts` (`keyCommand`), types and lint. The layout was
  not exercised in a running app by a test.

## D123 — Lily Studio: opens .ly files, and is their default app

**Status:** proposed · **Refines:** D42, D49

- **What.** A double click on a `.ly` file in Finder, *Open With › Lily
  Studio*, or a score dropped on the Dock icon opens it in Lily Studio, at
  launch or while it runs: the score's folder becomes the open folder and the
  editor shows the score, as when Open Score… chose it. The bundle claims
  `.ly`, `.ily` and `.lyi` as documents it edits, with `LSHandlerRank` Owner,
  so a Mac with no other choice opens them in Lily Studio. `.ily` and `.lyi`
  are claimed too, since Open Score already takes them and the editor finds
  their score (D31).
- **How.** `bundle.fileAssociations` in `tauri.conf.json`: *LilyPond score*
  (`.ly`, exported as `org.lilypond.lilypond-source`, the identifier other Mac
  programs such as VocalEasel already use) and *LilyPond include file*
  (`.ily`, `.lyi`, as `org.lilypond.lilypond-include`), both conforming to
  `public.plain-text` with the mime type `text/x-lilypond`; Tauri writes
  `CFBundleDocumentTypes` and `UTExportedTypeDeclarations` from them. macOS
  sends the files as `RunEvent::Opened`. Paths on the command line, and those
  a second launch hands to the first through the single-instance plugin, take
  the same way (`src-tauri/src/opening.rs`). Only existing score files are
  kept. Each opens through `Studio::open_file_at`, Open Score's own path, so
  it goes on the recent list (D49), and the page gets the result as
  `StudioEvent::Opened` and shows it as it shows a dialog's. A file that
  arrives before the page subscribes, as the one that launched the app,
  waits in `Opening` until `subscribe`; one that arrives later also brings
  the window forward.
- **Not done.** No folders: a folder dropped on the Dock icon is not
  claimed. Several files open in turn, and the editor shows the last. The
  web studio (D55) has no such event. Owner is a claim, not a guarantee:
  LaunchServices decides among the apps that claim `.ly`, and the user's own
  *Open With › Change All…* choice wins.
- **Verified.** `opening.rs`'s tests: files wait until the page listens and
  then open in order; arguments are paths against the working directory,
  without the program and flags; only `file:` URLs are files. The
  `Info.plist` of a bundle built with `tauri bundle --debug` has both
  document types with rank Owner and both exported types. `npm run
  test:smoke` passes with the changed `subscribe`. Opening a score from
  Finder, from the Dock or with `open -a` was not tried in a run.

## D124 — Lily Studio: updates from lily.everyday.fail

**Status:** proposed · **Refines:** D37, D38, D42

- **What.** A release build of Lily Studio asks
  `https://lily.everyday.fail/dist/latest.json` for a newer version three
  seconds after launch, and again when *Lily Studio › Check for Updates…* is
  chosen. When there is one, an alert names it and its notes: *Install and
  Relaunch* downloads and installs it, asks to save unsaved edits as closing
  the window does, and relaunches; *Later* leaves it. A Cancel of the save
  question leaves the installed version for the next launch. The check at
  launch says nothing when there is no update or the site cannot be reached;
  the menu's says either.
- **How.** Tauri's updater plugin, set up in `plugins.updater` of
  `tauri.conf.json` with the key's public half and `requireSignedVersion`,
  driven from Rust (`src-tauri/src/updater.rs`); the page cannot reach it
  (the capability is still `core:default`). `npm run dist` and `dist:x64`
  make the update in `scripts/dmg.mjs`, after notarizing and stapling: the
  app in `release/Lily Studio-<version>-<arch>.app.tar.gz`, signed with
  `tauri signer sign --app-version` and the private key in
  `~/.tauri/lily-studio.key` (or `$TAURI_SIGNING_PRIVATE_KEY_PATH`), and
  `release/latest.json`, which keeps the other architecture's entry of the
  same version. Tauri's own `createUpdaterArtifacts` is not used: it archives
  the app before it is notarized. A relaunch is `request_restart`, so
  `RunEvent::Exit` cleans up and the single-instance socket is gone before
  the new process looks for it. `npm run upload` (`scripts/upload.mjs`)
  publishes the version in `latest.json` over rsync, `latest.json` last,
  and reads it back through the public site. The site is a static nginx
  server on the everyday.fail host, with `latest.json` sent as `no-cache`
  because Cloudflare is in front of it. Its home page is
  `website/site/index.html`, published by `npm run upload:site`: the title-page
  draft, offering only what a downloaded app does. So it has no browser and no
  Intel build, which are not out yet, no Stems, which needs a clone of this
  private repository, and no source link or claim to be open source.
- **Not done.** No progress while the update downloads (the app is about
  15 MB). No check while the app stays open, after the one at launch. A debug
  build, `npm start` or the smoke test, has neither the plugin nor the menu
  item: the updater replaces the bundle the program runs from, and theirs is
  in none. `dist:local` makes no update. The notes in `latest.json` are empty
  until written by hand.
- **Verified.** `cargo clippy`. The smoke test fails at the agent's chat
  steps, as it does on the commit before; what comes before them passes.
  An archive made as `dmg.mjs` makes it has `Lily Studio.app/` at its top and no `._` files,
  and its signature verifies with the configured public key and carries
  `version:`. No update was installed from the site in a run.

## D125 — karaoke-mlx's Python in this repository: packages/separate

**Status:** accepted · **Refines:** D112, D113

- **What.** RoFormer MLX's Python, which D112 left in a checkout nothing
  committed to, is `packages/separate`: `src/karaoke_mlx`, its parity tests
  with ZFTurbo's PyTorch reference (MIT) vendored in `tests/reference`,
  `pyproject.toml` and `uv.lock`. It is a uv project like
  `packages/transcribe`, not an npm workspace, and keeps its name,
  `karaoke-mlx`, its CLI and its JSON events, so the studio runs it as
  before. RoFormer's own Tauri app (`app/`) is not taken: Lily Studio's
  Stems is its successor, and its build folder alone is 2.3 GB.
- **Why.** Nobody but the operator could separate a song: the project was on
  their disk only, and a clone of this repository had nothing for
  `KARAOKE_MLX_ROOT` to name.
- **The root.** `KARAOKE_MLX_ROOT`, then `packages/separate` beside the
  studio (`MONOREPO_ROOT`). The default of RoFormer's checkout,
  a fixed path on the author's disk, is gone, and when no project
  is found the error names `packages/separate`. D112's `separation.root`
  setting was never written by a setup card, and still is not. A studio
  built from a clone finds both Python projects by itself. An installed one
  looks where it was built, so on another Mac it is opened with
  `open -a "Lily Studio" --env KARAOKE_MLX_ROOT=… --env
  LILY_TRANSCRIBE_ROOT=…`, as the studio's README says step by step.
- **Verified.** `uv sync` and `uv run pytest -s` in packages/separate (5
  passed, the models downloaded), `uv run karaoke-mlx models`, and a
  separation of an 8 s tone with `--json` from the new place. `cargo test -p
  lily-separate`. The studio itself was not started on it, and the smoke
  test's separation (`LILY_E2E_SONG`) was not run.

## D126 — `layout.tsv`'s `?` is a field whose read did not complete, and the dump reads the Y extent but not the Y offset before breaking

**Status:** accepted (the user's answers at MS3 step 28's session 6,
2026-10-15) · **Amends:** step 25's UNREACHED (`tools/compare/layout.mjs`)
· **Changes, in MS3 step 28:** `crates/layout/src/dump.rs`,
`crates/core/src/compile.rs`, `tools/compare/test/layout.test.mjs`

- **What.**
  - **A field the engine writes as `?` is one whose read did not
    complete:** its layout reached a placeholder (PRIMS' `misc-error` by
    name), as at step 25, or another error (a font no preloaded pack has:
    emmentaler-11/14/26/brace or C059-BdIta on T13, T21, T25, T28, T29
    and `fixtures/grobs.ly`), or a stop for the host (a D74 part's file,
    T22's tab clef markup). `layout.mjs` counts it unreached and does not
    compare it, as before; it does not tell the three apart.
  - **The dump reads the Y extent from step 28** (`ly:grob-extent grob
    grob Y`, as `layout.ly` writes it). **The Y offset stays unread
    (`?`) until breaking (step 33):** reading it runs
    `align-to-ideal-distances` on the unbroken VerticalAlignment, which
    has no system before breaking and says LilyPond's own "programming
    error: vertical alignment called before line breaking" in every
    traced score, and the staves come out at 0.0 with no placeholder
    reached.
  - **A read leaves the grobs and the VM as a read that completed
    would:** no property left `calculation-in-progress` by a callback
    that threw or was cancelled (`%dump-read`), no wait for the host and
    no file asked of it (`compile.rs`). The reads say nothing:
    `trace.log` is what it was without them.
- **Why.** Step 27's probe left "cyclic dependency …
  NoteHead.stencil" programming errors in `trace.log`: a placeholder that
  throws inside a callback leaves the property `calculation-in-progress`
  (`Grob::try_callback` has no unwind; LilyPond's run ends there), and
  the dump goes on to the next grob. Putting the callbacks back removes
  them on all 29 traced scores and the 9 fixtures. The fonts and the
  part's file are not placeholders, but no value can be written for them
  either; the other options were a marker of their own that `layout.mjs`
  counts apart, or failing the score's `layout.tsv`. Reading the Y offset
  now would mean dropping the dump's messages from `trace.log`, or `?` on
  that programming error.
- **Consequences.**
  - Step 28 compares Y extents only (VerticalAxisGroup,
    VerticalAlignment, StaffSymbol and the referencers); the staves' and
    the referencers' Y offsets move to step 33, with X.
  - A `?` no longer proves a placeholder was reached; a step that wants
    to know why reads the field itself.
  - The exact `trace.log` tests (`grobs.test.mjs`, `trace.test.mjs`)
    hold with the dump on.

  progress.md, MS3 step 28.

## D127 — `%host-call` dispatches by its `what` to handlers other crates register, so a layout callback reaches Rust that needs the whole VM

**Status:** accepted (the user's answer at MS3 step 31's session 5,
2026-10-16) · **Refines:** D70, D92 · **Changes, in MS3 step 31:**
`crates/scheme/src/{lily,vm,control,image}.rs`, `crates/layout/src/lib.rs`

- **What.**
  - **A handler is a `HostHandler { what, f }`:** a symbol's name and a
    `HostFn`, D92's `fn(&mut Vm, &[Value])`. `Vm::add_host_handlers`
    adds a crate's handlers; one added later for the same `what` replaces
    the earlier.
  - **`(%host-call what arg …)` calls the handler for `what`, else the
    host** (`Vm::set_host`, the parser's, D92), else it is the misc-error
    "no host to call" as before. The primitive picks the function, and
    the loop calls it with the VM after the primitive returns, as D92's
    host is called.
  - **Handlers are not in the image:** `Extension::hosts` gives them, and
    `Vm::restore` adds every extension's, in the extensions' order.
  - **Layout's callbacks that LilyPond writes in C++ over C++ callees are
    Scheme that checks its argument as `LY_ASSERT_SMOB` or
    `unsmob<Spanner>` does and calls `%host-call` with a `what` of its
    own** (`spacing-spanner-set-springs`,
    `spacing-spanner-calc-common-shortest-duration` first). The handler
    runs the Rust port with the VM as its `Host`.
- **Why.** Sessions 1–4 of MS3 step 31 ported spacing-options,
  -basic, note- and staff-spacing to Rust over `Host`, as their callers in
  LilyPond are C++ (step 30's `spacing_interface.rs` and step 29's
  springs and rods are the same). Their caller, the spacing spanner, is a
  callback: a primitive gets only a `Cx` and cannot call Scheme (D70), and
  reading a grob property may run a callback, so the Rust cannot be a
  primitive. The other options were keeping the two callbacks
  placeholders until a Rust driver (step 33) calls the port, against the
  step's scope, or writing the spacing and everything under it in Scheme
  over `Cx` helpers (D67), redoing sessions 1–4.
- **Consequences.**
  - Steps 32–34's Rust over `Host` (loose columns, breaking, pages) can
    be reached from a callback the same way.
  - A handler's Rust may run the VM again (`Vm::apply` is reentrant); a
    wait for the host it leaves cancels the caller's run, as D92's.
  - The callbacks stay in `(lily)` under LilyPond's names, so the image
    and `PRIMS` count them as other Scheme callbacks (D67).

  progress.md, MS3 step 31.

## D128 — `columns.tsv`: the springs and rods between the columns as they are after `set-springs`, LilyPond's springs read from the smob's memory

**Status:** accepted (the user's answers at MS3 step 31's session 6,
2026-10-16) · **Extends:** D126 · **Changes, in MS3 step 31:**
`tools/compare/{layout.ly,layout.mjs,capture.mjs,core.mjs}`,
`tools/compare/test/layout.test.mjs`, `crates/layout/src/dump.rs`,
`crates/core/src/{compile,lib}.rs`, `crates/core/examples/compile.rs`

- **What.**
  - **A file of its own beside `layout.tsv`, which stays as D126 has
    it:** `columns.tsv`, a line a column,
    `column  spacing-wishes  springs  rods`. A column is named
    `type@columns@break`, its grobs.tsv type and columns (a piece's those
    of its original) and its break direction (-1, 0, 1), in the line and
    in the springs and rods that name it. The wishes are each grob's
    `type@columns@context`; a spring is the other column and its ideal
    distance, minimum distance, inverse stretch and inverse compress
    strengths; a rod the other column and the distance. Each list is in
    the order the column holds it (`spacing-wishes`, `ideal-distances`,
    `minimum-distances`), `|` between entries, `-` for none; numbers are
    `layout.tsv`'s four decimals.
  - **Read right after `set-springs`:** `layout.ly` wraps the
    SpacingSpanner's `springs-and-rods` when the Score's recorder hears
    it. After each call it writes each column of the root System's
    `columns` (unbroken, before breaking) and each column's prebroken
    pieces after it, left then right. The wrapper gives the callback's
    value and reads only object properties: the five's captures are what
    they were, byte for byte, but for `columns.tsv`.
  - **LilyPond 2.26.0 has no Scheme getter for a spring** (it prints as
    `#<Spring>`; `ly:paper-column::print` draws only the ideal distance,
    `%5.2lf`). `layout.ly` reads the four doubles from the smob's data
    word with Guile's `(system foreign)`, as the C++ `Spring` lays them
    out. It reads a spring of known numbers first (1.5, 0.25, 3, 7) and
    fails the file if they do not come back. It does not import the
    modules into the score's (`@` references), so no score's names
    change.
  - **The engine's traced compile writes the same file**
    (`dump::columns_lines`, after `layout_lines`): each SpacingSpanner in
    `all-elements`' order has its `springs-and-rods` read through
    `%dump-read`, and then it writes the columns. The springs and rods
    are `?` (D126's unreached) where the read did not complete; the
    wishes are written whatever happened.
  - **`layout.mjs`' `compareColumns`** pairs columns by name, the nth
    with the nth. Wishes are compared as written, springs and rods entry
    by entry (the same column, numbers to `TOLERANCE`), and `?` is
    counted, not compared. `unbrokenColumns` keeps what the engine has
    before breaking: the unbroken columns, without the springs and rods
    to pieces.
- **Why.** Comparing the springs exactly needs their four numbers, and
  only the memory has them in 2.26.0. The other options were the
  printed ideal distance (two decimals, no strengths) or waiting for the
  columns' X offsets after breaking (step 33). The springs are compared
  before breaking because the engine has nothing after it. New fields in
  `layout.tsv` at `page-post-process` would put LilyPond's broken end
  columns against the engine's unbroken ones (step 30's problem with X),
  with later callbacks' rods mixed in.
- **Consequences.**
  - The memory read is tied to LilyPond 2.26.0's `Spring` and a 64-bit
    smob cell; another build fails loudly on the known spring.
  - The engine makes no prebroken pieces before breaking (step 33): the
    pieces' lines and the entries naming them are LilyPond's only.
    LilyPond also kills the unbroken first column's LeftEdge
    (begin-of-line-visible) in `Item::handle_prebroken_dependencies`, so
    the engine's first spring and rod on `fixtures/path.ly` are
    LilyPond's start-of-line piece's (1.0 more) until step 33.
  - Y1's five's springs and rods are unreached until the callbacks under
    note spacing are ported (`ly:clef::print`, the stems'; steps 37–40).
    Their columns and wishes are LilyPond's now.
  - `capture.mjs` writes `columns.tsv` into every capture. A capture
    made before step 31 has none, and the tests that need it skip.

  progress.md, MS3 step 31.

## D129 — A traced compile makes the breakable items' prebroken pieces before its reads, and writes its one line's columns' X offsets (`line.tsv`)

**Status:** accepted (the user's answer at MS3 step 32's session 6,
2026-10-16) · **Extends:** D126, D128 · **Changes, in MS3 step 32:**
`crates/music/src/{scheme_translator,output_def,book}.rs`,
`crates/layout/src/{item,grob,system,break_substitution,dump}.rs`,
`crates/core/src/compile.rs`, `crates/core/examples/compile.rs`,
`tools/compare/{layout.ly,layout.mjs,capture.mjs}`,
`tools/compare/test/layout.test.mjs`

- **What.**
  - **The pieces, pulled forward from step 33:** `System::pre_processing`'s
    first three scopes (Break items, Handle dependencies, Fix up
    refpoints), with `Item::break_breakable_item` and the item's `clone`
    (the music crate copies the grob's record), `Grob`'s and `Item`'s
    `handle_prebroken_dependencies`, `Item::break_visible`,
    `Grob::fixup_refpoint` and `break-substitution.cc`'s pass by break
    direction. Its `before-line-breaking` and `springs-and-rods` scopes
    are not run: the dump reads the SpacingSpanners' springs (D128).
  - **Made by a traced compile only, before any of its reads,** through
    `%dump-read` (D126's unreached where it does not complete), and the
    Paper_score's breaks found again after. The per-edit compile makes
    none yet.
  - **`layout.tsv`:** a line a live grob of `all-elements`, the pieces
    after the rest, each named by its original's grobs.tsv line as
    `layout.ly` names a piece. An unbroken item its break visibility kills
    (a LeftEdge, begin-of-line-visible) has no line.
  - **`columns.tsv`:** the engine's pieces have their lines and their
    springs and rods; `layout.mjs` compares every line (its
    `unbrokenColumns` is gone).
  - **`line.tsv`, a file of its own:** `system  column  x`, a line a
    column of a system's line, the column named as in `columns.tsv` and
    `x` its offset relative to the system (four decimals). LilyPond's:
    each broken System's `columns` at `page-post-process`, beside
    `layout.tsv`. The engine's: the Paper_score's one line from its first
    break to its last, spaced by `Constrained_breaking::space_line`, its
    columns moved and put on the root System and its loose columns placed
    (`system::place_line`, `break_into_pieces`' part for a line's
    columns), system 0; `x` unreached where the pieces' or the springs'
    read, or the line's, did not complete. `layout.mjs`' `compareLine`
    pairs a column by system and name, the X offset to `TOLERANCE`.
  - **`Output_def::normalize`, borrowed from step 35:** the paper of each
    `Paper_book` that processes scores is normalized where
    `Book::process` normalizes it, in every compile: `line_dimension_interval`
    reads its `line-width`, which nothing set before.
- **Why.** `find_break_indices` finds no break without the pieces, so
  the engine had no line. The user chose making the pieces over a
  stand-in line of unbroken end columns compared but for its last column,
  or deferring the X offsets to step 33. The pieces are made before the
  reads because LilyPond makes them before anything reads their
  originals: made after `layout.tsv`'s Y extents, they took the values
  those reads cached on the originals (an unbroken bar line's width, the
  LeftEdge's), and their springs were not LilyPond's.
- **Consequences.**
  - `fixtures/path.ly`'s `columns.tsv` and `line.tsv` are LilyPond's line
    for line; D128's 1.0 on its first column is gone. The five's
    `columns.tsv` are LilyPond's with their pieces, the springs and rods
    unreached, and so are their lines' X offsets.
  - The pieces of the items of a staff that dies before breaking keep
    their lines (`fixtures/y1-unreached.ly`) until breaking gives the
    broken group its pieces (step 33).
  - The engine writes one line; LilyPond's `line.tsv` has one per system.
    A score LilyPond breaks into several lines is not compared until
    step 33 chooses the breaks and breaks the System.
  - Step 33 keeps `break_into_pieces` (the broken systems and their
    bounds), the pass by system of `break-substitution.cc`,
    `handle_broken_dependencies`, `before-line-breaking`, and making the
    pieces in the per-edit compile. Step 35 keeps the rest of
    `Book::process` (the book's parts).

  progress.md, MS3 step 32.

## D130 — Every compile lays out and breaks the System; a per-edit layout's error or stop for the host ends the layout, not the compile

**Status:** accepted (MS3 step 33's line: "the prebroken pieces made in
the per-edit compile, not only in a traced one"; the rest applies D126's
rules) · **Refines:** D126, D129 · **Changes, in MS3 step 33:**
`crates/core/src/compile.rs`, `crates/layout/src/{paper_score,system,dump,grob_array}.rs`,
`tools/compare/layout.mjs`, `tools/compare/test/layout.test.mjs`,
`tools/bench/test/columns.test.mjs`

- **What.**
  - **Every `\layout` translation is laid out after it,** traced or not,
    as LilyPond's is before its pages: its Paper_score processed
    (`System::pre_processing` whole: the prebroken pieces, then each
    grob's `before-line-breaking` and `springs-and-rods`), then its
    System broken into its lines (`calc_breaking`, `break_into_pieces`,
    the break substitution by system), once per Paper_score whether or not
    it completes. D129's "a traced compile only" ends. Not drawn:
    `get_paper_systems` and `post_processing` stay `Paper_book`'s (steps
    34–35); `ly:paper-score-paper-systems` breaks nothing again.
  - **The first error ends the layout, unreported,** as a translation's
    error is (only a traced compile writes it to `trace.log`); a stop for
    the host is undone and not asked, as D126 has a traced read's. A
    placeholder's `misc-error`, or a file the layout would read, ends the
    layout and not the compile: the error is in neither its stderr nor
    its diagnostics. What the layout says before it, LilyPond's own
    warnings and programming errors, is (below).
  - **A traced compile runs the same parts, each a read of its own**
    (`dump::lay_out`): it pairs `all-elements` with the heard grobs.tsv
    lines first (breaking moves the root's arrays into the broken
    systems'), then the pieces, the rest of `pre_processing`
    (`columns.tsv` after it) and breaking. `layout.tsv` lists each broken
    system's `all-elements` (the root's, pieces after, where breaking did
    not complete), every grob named by its original's line; `line.tsv`
    has a line a column of each broken system, system *k*.
  - **The X and Y offsets (D126's step 33) are read once the System is
    broken, relative to each grob's broken system,** and are `?` where it
    is not. `%dump-read` forgets `get_offset`'s cached 0 when the read
    throws or stops (D126's "as a read that completed would").
    `COMPARED`'s StaffSymbol, VerticalAxisGroup and VerticalAlignment are
    `x`, `y`, `y-extent`.
  - **`GrobArray::remove_duplicates` keeps each grob where it first is,**
    as 2.26.0's `uniquify` (grob.cc:1033–1046) does; it sorted by
    translation and record before (step 10's entry said LilyPond sorts by
    address: 2.26.0 does not sort).
- **Why.** The step's line asks for the pieces in every compile, and
  breaking needs them. LilyPond's run would end at the first placeholder;
  the engine's per-edit compile must still give the parse and translation
  results it gave before, so the layout, unfinished in most scores until
  the print callbacks are ported, may not fail it. `uniquify`'s order is
  the order the broken systems' grobs get `after-line-breaking` and
  `stencil` in, and `layout.tsv`'s line order.
- **Consequences.**
  - `fixtures/path.ly`'s `layout.tsv` is LilyPond's on every type and
    field (43 lines, in its order), natively and in wasm; its
    `columns.tsv` and `line.tsv` as D129 has them.
  - None of the 42 corpus scores completes `pre_processing` yet (each
    stops at a placeholder); their per-edit stderr and diagnostics are
    unchanged, and so are the five's traced outputs. The
    breakable types and the referencers join `COMPARED`'s X and Y when the
    five break (steps 37–40).
  - The layout's messages are LilyPond's in every compile: a score with
    no VerticalAlignment (`fixtures/columns.ly`) says "didn't find a
    vertical alignment in this system" when its System is broken, as
    LilyPond's does, so the skylines probe's driver expects it, as
    `columns-calls.ly` does.
  - Compile time grows by the layout (progress.md, MS3 step 33).

  progress.md, MS3 step 33.

## D131 — The page path's six functions that are in no part of MS3 are ported with it, beside their MS1 and MS2 counterparts

**Status:** accepted (the user's answer, 2026-10-17, to MS3 step 35's stop
point: "Port them in step 35") · **Changes, in MS3 step 35:**
`crates/music/src/{output_def,music,lib}.rs`,
`crates/scheme/src/{module,prims,lily}.rs`,
`crates/layout/src/{paper_book,lib}.rs`

- **What.** `page.scm`'s `make-page` and `page-stencil` and `titling.scm`'s
  title and header/footer procedures, which every engine page runs, call
  six things that are in no part of MS3's split (`parts.sh`' lists) and
  were not in the engine. Each is ported where its counterpart is:
  - `ly:paper-get-number` (`output-def-scheme.cc:179–188`), by
    `ly:output-def-lookup` in music's `output_def.rs`: the variable as a
    real, `scm_to_double`'s error otherwise, unbound included;
  - `ly:module->alist` (`ly-module.cc:54–72`), by the module primitives in
    scheme's `module.rs`: the module's own bindings, in the order of the
    engine's table (LilyPond's is Guile's hash order);
  - `ly:modules-lookup` (`module-scheme.cc:53–71`), beside it: the first
    of the modules that binds the symbol, its own or imported, else the
    default, else `#f`;
  - `ly:make-prob` (`prob-scheme.cc:77–95`), by music's Prob
    (`music.rs`): the immutable properties, then each key and value set
    as `set_property` sets them;
  - `ice9-format` in `(lily)`, as `lily.scm:21` imports `(ice-9 format)`'s
    `format`, which `number-format` calls for every page's number;
  - the `use-paper-size-for-page` option, `#t` as `lily.scm:477` has it,
    which `make-page-stencil` reads to give the page the paper's extent.

  `ly:paper-book-paper` and `ly:paper-book-scopes`
  (`paper-book-scheme.cc`), which the same procedures call, are part 5's
  and step 35's, not this decision's.
- **Why.** Without them no engine page is made: `make-page` is the first
  call of every page, its header and footer read the tagline with
  `ly:modules-lookup` and number the page with `ice9-format`, and the
  titles read the headers with `ly:module->alist` and the page properties
  with `ly:paper-get-number`. They are small and their LilyPond
  counterparts are plain; leaving them for a part of their own would
  leave every page unmade until then.
- **Consequences.**
  - `fixtures/path.ly`'s one page, made through the image's `make-page`
    and `page-stencil`, has LilyPond 2.26.0's properties, configuration,
    head, foot and stencil expression, with D106's fonts (progress.md,
    MS3 step 35).
  - `(ice-9 format)`'s case conversion (`~(`…`~)`) is not in the engine's
    subset: `number-format`'s `roman-lower` and `roman-ish` page numbers
    fail until it is. Arabic numbers, the default, and `roman-upper`
    work.
  - The image's primitive tables grow by these; `PRIMS`, the placeholders,
    does not change.

  progress.md, MS3 step 35.

## D132 — A translation's error ends the run as LilyPond's does, reported at `init.ly`; the engine's own gaps still end only the translation

**Status:** accepted (MS3 step 35's line: "an error of a \layout
translation and a Scheme engraver's finalize error reported in stderr and
diagnostics.json as LilyPond reports them at init.ly, with the driver's
exit 1"; the line between LilyPond's errors and the engine's own is the
user's answer, 2026-10-17, "Exempt the engine's gaps") · **Refines:**
D130 · **Changes, in MS3 step 35:** `crates/core/src/{compile,diag}.rs`,
`crates/core/examples/compile.rs`, `crates/core/tests/engine.rs`,
`tools/compare/fixtures/{translation-error,finalize-error}.ly`,
`tools/compare/test/c0-cases.test.mjs`

- **What.**
  - **An error of a translation ends the run.** `init.ly` runs its book
    handler with `protected-scheme-parsing` off, so LilyPond reports an
    uncaught error of a score's translation, `\layout` or `\midi`, a
    Scheme engraver's `finalize` among them, as Guile's error for that
    expression and exits with 1 at once (`parse-scm.cc:184–191`). The
    core prints what the translation said, then
    `<datadir>/ly/init.ly:66:2: error: Guile signaled an error for the
    expression beginning here`, the excerpt of 2.26.0's line 66 and the
    error's text (`diag.rs`' `ended`), and nothing after it: no other
    translation, no page of that book or the books after it, no playback
    map (LilyPond writes no MIDI file), no unmet expected warnings and no
    `failed files:`. The books before it keep their pages, as LilyPond
    wrote theirs while it parsed. `<datadir>` is the engine's name for
    LilyPond's data directory, as for every file of LilyPond's own.
  - **A `\book` block's,** whose handler the parser calls unprotected,
    ends the run the same way. LilyPond prints Guile's report of an
    uncaught error, whose first line names a frame in Guile's own files
    (`ice-9/boot-9.scm:2058:7: In procedure error:`); the core prints the
    error's text without that frame. `parseStderr` reads no diagnostic
    from either.
  - **The engine's own gaps are not LilyPond's errors:** a placeholder's
    call (`misc-error`, its message "… not in the engine before …") and a
    font the host gave no pack of (`find_otf_font`'s `cannot find font`)
    end the translation unreported and its book's pages, as D130 has the
    layout's, and the compile goes on.
  - **The compile example exits with 1** when stderr has Guile's error
    for an expression, as well as a `fatal error:`: LilyPond's run ends
    with 1 after either, by `failed files:` or at once. `diagnostics.json`
    has the error, so the studio's driver (`outcomeOf`) gives the compile
    `failed`; `driver.ts` does not change.
- **Why.** Steps 16, 18 and 19 found these errors reported by nothing: a
  per-edit compile exited 0 with an empty stderr, the error only in a
  traced compile's `trace.log`. A score's own error must reach the studio
  as LilyPond's does. The engine's gaps would fail scores LilyPond
  compiles: T23 needs `emmentaler-16`, which no build preloads, and T26
  fails without packs, as C1's native run gives none; reported, they would
  lose their `\midi` maps and C1 on the 30.
- **Consequences.**
  - `fixtures/translation-error.ly` and `fixtures/finalize-error.ly`:
    stderr LilyPond 2.26.0's byte for byte (its data directory as
    `<datadir>`), the error at `<datadir>/ly/init.ly` 66:2 in
    `diagnostics.json`, exit 1, no page or playback map, natively and in
    wasm (`c0-cases.test.mjs`).
  - The 42 corpus scores' stderr, `diagnostics.json` and exit are
    unchanged, with the packs and without; C1 on the 30 too.
  - A `\book` block's error: the compile example exits 0 where LilyPond
    exits 1, since its report has no Guile error for an expression; and
    the parser's messages after the block are printed, as all of a
    `\book` block's messages already come after the parse's (D99).
  - Errors of the layout, of `Book::process` and of the pages still end
    them unreported (D130): until the print callbacks are ported most
    stop at a placeholder.

  progress.md, MS3 step 35.

## D133 — Lily Studio: Karaoke, the words with the notes, over a backing track

**Status:** proposed · **Refines:** D26, D112, D116, D117

- **What.** The piano view gets a style, *Keyboard | Karaoke*, kept in the
  window's storage. Karaoke is a karaoke video with a guide: along the top a
  lane, a row per semitone over the notes' range, where the notes run from
  right to left past a line that is now (1.5 s behind it, 4.5 s ahead), the
  one sounding white; below it the words, two phrases at a time, each
  syllable coloured from its start to its end in its singer's colour. The
  rows take turns, so a row changes only once its phrase is sung. Each
  `Lyrics` context is a singer: its colour is that of the track its words are
  sung on, and *Tracks* hides a singer's notes and words together. The
  keys' range choice is hidden in Karaoke. A score without words says how
  to write them.
- **The notes are the score's.** Karaoke draws the music with its muted
  parts, not the player's: muting the tune in *Parts* to sing it leaves its
  notes in the lane (*No guide melody*). The keyboard still shows only what
  plays.
- **The words have a file of their own.** `packages/studio/runtime/words.ly`
  has a performer in each `Lyrics` context that records every syllable: its
  moment, its text, whether a hyphen or an extender follows it, and its line
  (the contexts numbered in the order they first sing); a performer in `Score`
  writes them to `<name>.words.json`, one entry per `\midi` performance, in
  the order of the playback map's. The map gains nothing: its shape is what
  the engine's performers reproduce and its differential tests hold equal to
  LilyPond's, so `timing.ly` stays as it was, and a feature reaches the engine
  by a `.ly` file compiled ahead of the score. `words.ly` needs nothing of
  `timing.ly`'s, so the engine can run it beside its native map. Only the
  studio uses it, so it is not in `packages/common`: the extension keeps
  `timing.ly` alone and never sees the words, and that the studio's compiler
  is a port of the extension's (D42) asks for no change there, the performer
  being the studio's on purpose. `-dinclude-settings` takes one file, so a
  preview compile passes `runtime/settings.ly`, which includes the two; each
  is found beside it, whatever is in the score's folder. `esbuild.mjs` puts
  @lily/common's runtime and the studio's together in `dist/runtime/`.
  crates/engrave reads the first performance's words into the `lyrics` of
  `PlaybackTiming`, so the renderer has them where it has `staves`.
- **A syllable's track** is found from the notes, not from the staff: a
  `Lyrics` context has a MIDI track of its own, so the staves' tracks are not
  numbered by staff. A
  line is sung on the track with a note starting with most of its syllables;
  of two alike, one no line before took. A syllable lasts as long as that
  track's notes until the line's next syllable, so a melisma holds it; a
  skip (`_`, which lilypond hands on as a space) ends it and is not shown. A
  line breaks into phrases at a gap of 0.9 s, or at a word past 40
  characters.
- **A syllable's text** is as the score prints it. Lilypond has made a bare
  word's `_` a space before the words are written, so `la_la` is `la la`, and
  an underscore still there was quoted, is printed, and stays. A `~` is the
  undertie (U+203F), lilypond's own `tied-lyric` as a string. A `\markup`
  prints its `~` as written, and the words file does not tell the two apart,
  so there too it is an undertie.
- **A backing track.** A score may name a backing track beside it in a
  `% Backing:` line, as `% Stem:` names its stem. The Stem strip then has a
  choice, *Backing | Stem*, the backing first; switching keeps the place and
  plays on. *New score for vocals* of a karaoke separation writes the
  instrumental there. A backing track is played as the stem is: with
  *With score* both start together, each from where it is, and the karaoke
  follows the score's clock.
- **Not done.** Nobody is told apart by voice: singers are the score's `Lyrics`
  contexts. A backing track must be the same recording as the stem: one from
  another recording (a karaoke version of the song) is not aligned to it, and
  Song G's karaoke version is at ♩ ≈ 136 where the record is at ≈ 143,
  18 s longer. A drifting tempo drifts the words from the backing as it
  drifts the MIDI from the stem (D113). The extension's preview has no
  karaoke. There is no microphone. The web has the words where the server
  compiles, with this same runtime. The engine's driver (`src/web/engine/`),
  which no page starts yet, reads `<name>.words.json` beside the map as
  `read_words` does, and the engine as it is runs `words.ly` and writes that
  file as LilyPond does, so a score that includes `words.ly` has its words
  there. The driver does not put `words.ly` ahead of a score: `lily_compile`
  takes only the root, and the engine's `worker.test.mjs` holds the driver's
  outputs equal to the native core's, name for name and byte for byte, so that
  has to be asked for, by the page that starts the driver (D141).
- **Verified.** `karaoke.test.ts`: syllables held over a melisma, joined by
  hyphens, a line's track by its notes, phrases at gaps and words, the rows
  taking turns, the colouring, the lane's range; a real compile of two
  staves with two `Lyrics` contexts, whose words have each syllable with its
  hyphen, extender and line, the second singer's notes on track 3; and a real
  score's ties, spaces, skips and quoted underscores, as the map has them and
  as they read.
  `studio_compiler.rs`: the words of two `\score`s reach their entries, the
  first on `PlaybackTiming.lyrics`, the map keeps its three keys, and words
  that cannot be read cost only the words. `accelerated.rs`: the cached and
  warm compiles write the same words file, byte for byte. The engine's
  `trace.test.mjs` holds its map equal to LilyPond's. `server.rs`: a compile on
  the web's server gives the page the words. `engine.test.ts`: the driver takes
  entry 0 of the words beside the map, and words that cannot be read cost only
  the words. `engine-corpus.test.ts`: the built core, through the driver, runs
  `words.ly` and the words reach `PlaybackTiming.lyrics`, words edited in the
  same engine replace them, and a compile that starts again for a font pack
  after its performers ran keeps each performance's words once. By hand, its
  `words.json` is LilyPond's byte for byte, restart or not.
  `files.test.ts`: the `% Backing:` line written and read back.
  `npm run test:smoke`: Karaoke shows its canvas without the range choice,
  and Keyboard brings it back. The drawing was looked at in headless Chrome,
  from a real compile of two singers, at four moments; not in the app while
  playing, and the Backing | Stem choice was not clicked.

---

## D134 — Transcribed vocals have their words

**Status:** proposed · **Refines:** D113, D133

- **What.** *New score for vocals* writes the words heard in the stem into
  `\words`, a syllable a note, and the `\lyricsto` line without its `%`, so the
  score opens with its words and Karaoke (D133) shows them. The status line
  says *hearing the words* between the notes and the score.
- **How** (`packages/transcribe`, `lyrics.py`). For the `vocals` stem alone,
  after the notes: Whisper large-v3-turbo on MLX (`mlx-whisper`, MIT code and
  weights, 1.6 GB on first use; `LILY_TRANSCRIBE_WHISPER` names another)
  hears the words with their times, not conditioned on the text before, as a
  song repeats itself. Pyphen's dictionary for the language Whisper heard
  splits each word, two letters at least to a syllable, and a syllable's time is its share of the word's
  letters. Then a dynamic programme lays the syllables on the notes in order:
  a match costs the seconds between the syllable and its note, a note left
  without one 0.25, a syllable sung on the note before 0.35. Where no match
  survives, as when every syllable is over 0.6 s from every note, each is
  sung on the note nearest it rather than lost. A line break Whisper leaves
  inside a word makes two words in the same time. The transcription gains
  `words`, `[at, text, hyphen]` per note sung to a syllable, and `language`.
  If Whisper fails, as the first download does offline, or its words cannot
  be split or laid, the score has its notes without words, as before, and a
  `warning` event says why. The Rust job puts the warnings in its answer as
  `warnings`, since the page may have that before the events, and they go
  on the status line after *Transcribed the vocals*. Whisper hearing nothing
  is no failure and says nothing.
- **Writing it** (`files.ts`). `voice` says where each note it writes
  starts (`sung`), the notes `\lyricsto` gives a syllable each. A line per
  bar: the syllable, `--` when its word goes on, `_` for a note sung to
  none, up to the last syllable. Two words on one note are joined by `_`,
  which lilypond shows as a space; a syllable with what lilypond would read
  otherwise, a number, is quoted.
- **Not done.** Hyphenation is not syllabification: *began* stays whole. The
  notes come first and the words are laid on them, so words on notes Basic
  Pitch missed share a note, and the alignment does not move notes. Whisper
  is not told the language. Singers are not told apart.
- **Verified.** `test_lyrics.py`: the split and its times, a word with a line
  break in it, a syllable on its nearest note, a note in a break left without
  one, two syllables on one note, syllables far from every note kept.
  `test_cli.py`: the vocals' words laid on their notes with Whisper stood in
  for, none heard for the bass, the notes kept and a warning given when
  hearing, splitting or laying the words fails, none when nothing is sung.
  `separate.rs`: warnings handed on and in the answer. `separate.test.ts`: the
  status line with them. `files.test.ts`: the lines per
  bar, `--`, `_`, a quoted number, the `\lyricsto` line on, and the score
  with words engraves without warnings. On Song G's vocals (3:11):
  Whisper heard 298 words, the whole transcription taking 9 s once the model
  was downloaded; 358 syllables went
  on 280 of the 347 notes, 60 of them sharing a note, each within a median
  0.1 s of the nearest syllable (0.27 s at the 90th percentile), and the
  score engraved without warnings. Not yet heard in the app.

---

## D135 — Karaoke over the record: one ▶, the MIDI in time with it, the whole window

**Status:** proposed · **Refines:** D113, D133, D134

- **Why.** Karaoke played the score's MIDI, a synth singing a transcription,
  while the backing track had a ▶ of its own in the Stem strip; the MIDI of a
  song whose tempo drifts drifted from the record; and the view was a pane.
  The operator called it ugly, and the backing track rubbish: what they
  heard was the MIDI.
- **The MIDI follows the record.** lily-transcribe gives when each bar starts
  (`barTimes`). A drifting song's score gets `songTempo`, a `\tempo 64 = …`
  at each bar beside the staff's music (`<< \music \songTempo >>`), its marks
  omitted, so each bar of MIDI lasts as long as the record's: a millisecond a
  bar at most, from the whole number. A steady song keeps its one tempo.
- **One ▶.** A linked recording in the Stem strip follows the score: ▶,
  pause and a seek of the transport move it. It is set to the score's place
  on its audio clock (`scheduled`), not the place as heard: a recording's
  `currentTime` goes out through the same device, and on Bluetooth the two
  differ by 0.16 s. Measured against what is heard, with 0.12 s allowed, it
  was put back ten times a second and the operator heard it torn. Now a
  backing track is put back when it strays by more than 0.25 s, then left
  alone for 2 s. A seek or ■ of the transport does not wait for those 2 s, or
  for a seek still under way: the user asked for that jump. A mute during
  playback has no need to: reloading the music stops it, which pauses the
  recording, and it is put back as it starts again.
  A backing track, or the music alone, is linked while its score is shown,
  and only then: a new score or ✕ ends it, so the next score's stem plays
  alone until *With score* is pressed. It keeps to the score's place, the
  same timeline. A plain stem does not: *With score* is still D112's, each
  from where it is. It is `lead` from the score when they start, a seek of
  the transport during playback keeps that distance, and it is never put back
  for drifting, which would be a jump in what is being written from by ear.
  While paused, each slider moves its own: a stem put where a start mark
  begins stays there. A stem at its end starts again from its start, and one
  chosen during playback comes in where the score has got to, whatever its
  loading took. The strip's slider moves either recording alone and
  sets its `lead`; a backing track goes back to the score's place at the next
  seek or ■ of the transport.
  In Karaoke with the backing track chosen, the score's MIDI is silent, every
  part at 0 without touching the Parts fold, unless *Melody* is ticked.
- **The whole window.** *Full window* puts Karaoke over the window, with ▶,
  the time and ✕ in a corner (Esc leaves). The stage is a night sky with
  stars that stay put; the lane is a rounded panel along the top third with
  pill-shaped notes, the one sounding white with a glow; the words are 800
  weight, up to 72 px, sung in their singer's colour with a glow. Words sung
  to no notes (a NullVoice, which plays nothing) are pink, as the video's;
  a line counts as a track's only when half its syllables start with its
  notes. A phrase ends after a comma or a full stop once 16 characters
  long. A phrase after a gap of 3 s is counted in by three dots; a long break
  shows a ♪.
- **Song G**, made for the operator beside their stems and not
  committed: the lead's words said to a NullVoice where Whisper heard them in
  the vocals, corrected by the sheet music; the backing singers' five
  choruses heard in the karaoke instrumental (where becruily leaves them),
  their words and notes from the sheet; `songTempo` from the beats. Its MIDI
  lasts 191.5 s for the record's 191.47 s, and the first and last words fall
  within 0.05 s of where Whisper heard them.
- **Not done.** The strip's own ▶ still plays the recording alone when not
  linked. Nothing tells singers apart by voice; here the stems did.
- **Verified.** `files.test.ts`: `songTempo` written and a drifting score's
  MIDI at the bar times given. `karaoke.test.ts`: a NullVoice's words on no
  track, a clause's end, the count-in. `player.test.ts`: the strip on the real
  `Player` over a fake audio clock and element, for the link, the distance,
  seeks, drift, a mute, a recording's end and a choice while it loads. By hand,
  in WebKit and Chrome: `ScorePlayer` and the strip wired as `index.ts` wires
  them, with a real `<audio>` and `AudioContext`, driven through the transport
  and a real mute; the script is not committed. `npm run test:smoke`: Full window
  over the whole window with its controls, and Esc. The drawing looked at in
  headless Chrome at four moments of Song G. Not heard in the app: the
  strip following the transport was not played.

---

## D136 — Lily Studio: *Visual*, not *Piano*

**Status:** proposed · **Refines:** D116, D133

- **What.** The editor's *Source | Piano* tabs and the transport's *Piano*
  button say *Visual*: the view shows the music as karaoke too (D133), and
  *Piano* next to *Source* read as an instrument. Its styles keep their
  names, *Keyboard | Karaoke*. Inside, it is still the piano view
  (`piano.ts`, `.transport-piano`, `data-view="piano"`), which the smoke
  test finds it by.

---

## D137 — Karaoke: the music alone, and the answers on a band of their own

**Status:** proposed · **Refines:** D133, D135 · the band replaced by D139

- **The music alone.** A karaoke separation's instrumental keeps the backing
  singers (becruily). A score may name the music without any voice in a
  `% Music:` line, beside the score as `% Stem:` and `% Backing:` are; it is
  first in the Stem strip's choice, *Music | Backing | Stem*, and follows the
  score and silences its MIDI as a backing track does. It is made by mixing
  an *All instruments* separation's stems but the vocals (`karaoke-mlx mix`).
- **The answers above.** The line with the most syllables is the lead's and
  keeps the two rows taking turns; every other line's phrase, the one being
  sung or the next within 4.5 s, is on a band of its own between the lane
  and the lead's rows, smaller, in its singer's colour.
- **Verified.** `files.test.ts`: the `% Music:` line read. `karaoke.test.ts`:
  the lead line chosen by its syllables. The band looked at in headless
  Chrome on Song G.


## D138 — Karaoke: a singer's line on their voice's track, and whispered words in italic

**Status:** proposed · **Refines:** D133, D137

- **The voice's track.** A singer who says most of their words and sings a
  few (the male voice in *Song E*) has notes under fewer than half
  their syllables, so the track found from the notes was none: their words
  were the colour of words said to no voice. `words.ly` (D133) records each
  syllable's voice (`associatedVoiceContext`, the voice of `\lyricsto`), and
  a line is on the track of the staff that voice played in: the staves with
  notes and the MIDI tracks with notes pair up in order, the Lyrics
  contexts' tracks having none. A DrumStaff has a track and no staff, since
  `timing.ly` adds its performers only to `\Staff`, so the pairing leaves out
  the tracks all on the drums' channel, which lilypond gives no other staff;
  it keeps them when the staves then outnumber the tracks, as a Staff set to
  drums has both. A TabStaff or a RhythmicStaff also has a track and no staff,
  on an ordinary channel the pairing cannot tell from a staff's, so a score
  with one does not pair. `\addlyrics` after a `\new` sings to that context,
  naming it `uniqueContext0` and so on if it has no name, so a line after
  `\new Staff` reports the Staff, not a voice: a staff's id pairs as its voices
  do, and a voice of that name elsewhere comes first. A line whose voice has a
  name of the score's and no track (a NullVoice) is on none: backing answers
  starting with the lead's notes (*Song F*) were taken for the lead's. A
  generated name with no track may be a NullVoice's or a staff group's
  (`\new PianoStaff << … >> \addlyrics`), which the map does not list, and the
  map cannot tell them apart, so the line is found from the notes: a group's
  words stay sung, and a NullVoice to be on no track needs a name. A group the
  score named is taken for a NullVoice. Without a voice or staves to pair, the
  line is found from the notes as before: a track counts once at a syllable
  however many notes it starts there, so a piano's chords do not outrank the
  melody, nor make up the half of the syllables D133 asks of a line.
- **Said in a score.** Words said to no pitch keep their place in the singer's
  voice as notes without a pitch, which play nothing and are drawn as
  crosses or slashes; a note event with no pitch at all plays the one before
  it, a drum's plays nothing in a Voice. A tie does not hold a syllable over
  such notes, a `\melisma` does.
- **Whispered.** A syllable written `\markup \italic` is italic in the words
  (an `\override` of LyricText does not reach the MIDI's contexts, so the
  markup is what `words.ly` can see), and its phrase is drawn italic and
  lighter. Italic starts or stops a phrase.
- **Verified.** `karaoke.test.ts`: a line on its voice's track though most of
  its words are said; staves and tracks paired, with a DrumStaff among them
  and with a Staff set to drums; chords against a melody, and under too few
  syllables; a whispered run its own phrase; a real score's syllables with
  their voices, italic, and tracks, a real band's voice on its track, real
  `\addlyrics` on an unnamed and a named Staff sung beside a named voice, a
  named NullVoice's on no track, and on a staff group, its staves named or not,
  sung.
  *Song E* in headless Chrome: the male voice's words in its colour, his
  notes only where he sings, his spoken line italic; every
  syllable of both singers at its sheet onset.

## D139 — Karaoke: a second singer on a lane and rows of their own

**Status:** proposed · **Refines:** D133, D138 · **Replaces:** D137's band

- **Two halves.** With a second singer the stage is split: the lead's lane
  and two rows of words on top, the other lines' below, each half its own
  lane, rows and count-in. A lane has the notes of its singer's tracks; a
  track no other line is sung on stays with the lead. D137's band showed
  one answer at a time and no notes for it, so a second singer coming in
  (the male voice's first line at 0:52) could not be seen coming.
- **Said on the lane.** A syllable with no note of its track under it is a
  hollow pill across the middle of its singer's lane, dashed when italic; it
  fills as it is said. Spoken lines show when to come in as sung ones do. A
  lead who only says (Song G) gets the pills too. The words are on the
  rows only, never on the lane: a word in a pill read as a second copy.
- **A row for each line below.** When the lower half has two lines (a held
  "Ooh" and the ad-libs over it, *Song F*), each has a row of its own with
  its phrase not yet over, shown from 6 s before it starts: taking turns,
  the long held line kept an answer sung long ago as the next phrase.
- **A full stop ends a phrase.** `.`, `!` and `?` end a phrase at any length;
  a comma, as before, only once it is 16 characters long. Short answers in a
  row (*Song F*'s ad-libs, a second apart) are each a phrase of their own.
- **Verified.** `karaoke.test.ts`: a syllable without its track's note is
  said; the sections' notes, phrases and said syllables. Headless Chrome:
  *Song E* at 0:51–0:53 (the male voice's count-in, then his pills under the female voice's
  lane), the whisper, the bridge; Song G and Song H
  (one singer: as before).

## D140 — Karaoke: Export Video

**Status:** proposed · **Refines:** D133, D135

- **What.** Karaoke's header gets *Export Video*, in the app only. It asks
  where to save `<score> (karaoke).mp4`, beside the score, and writes Karaoke
  from the start to the end as a 1920 × 1080 H.264 video at 30 frames a
  second, with AAC sound. While it runs the button reads *Cancel 34%*; a
  click stops it at once at any step, and the temp files go: while the
  melody renders (the OfflineAudioContext cannot be stopped, so its sound is
  thrown away), while the frames go, and while ffmpeg puts the file
  together (*Cancel 100%*), which the cancel kills.
- **Drawn, not recorded.** The page draws every frame with `drawKaraoke` at
  1280 × 720 scaled by 1.5, the moment set by the frame's number, not by the
  clock, so no frame is dropped and the export takes as long as drawing
  does (an 8 s score: 4 s). Each frame goes to the Rust side as a JPEG, and
  ffmpeg encodes them from stdin into a silent video in the temp directory;
  the next frame is drawn while the last is on its way. Recording the canvas
  with MediaRecorder would take as long as the song and drop frames when
  the machine is busy.
- **The sound is what Karaoke plays.** The backing track while it follows
  the score (D135), passed by path and checked against the asset scope; and
  the score's MIDI at its parts' volumes unless Karaoke silences it,
  rendered on an OfflineAudioContext by midi.js's `Synth` and sent as a WAV
  in 3 MB parts. ffmpeg sums them with `amix … normalize=0`, as the two are
  heard together, and copies the video. The video lasts as long as the
  score, or the backing track when that is longer.
- **ffmpeg** is looked for in Homebrew's folders and on the studio's search
  path, as for separation; without it the export says `brew install ffmpeg`.
- **A failure leaves no file.** The last step writes `.<name>.part.mp4`
  beside the output (`-f mp4`), renamed over the output when ffmpeg
  succeeds and deleted when it fails or is cancelled, so a file that had
  the name is left as it was.
- **Nothing waits behind ffmpeg.** A task of its own owns each ffmpeg: it
  reads its stderr as it goes, keeping the last 8 KB for a failure's
  message, so ffmpeg never stops reading frames because nobody reads what
  it says; and it kills it when told. The export's state is locked only for
  moments, never across a frame's write, so a cancel, or the app's exit,
  kills ffmpeg while a write waits on it, and the write fails.
- **An export the page lost track of is discarded.** The page runs one at
  a time and the app has one window (D123), so an export still running
  when another starts is one the page forgot, as when it reloads mid-export:
  its ffmpeg is killed and its files go, where it used to refuse every
  later export until the app restarted.
- **Verified.** `video.test.ts`: the WAV's header and samples, the length;
  an export run with a fake studio, and cancelled while the melody renders,
  while a frame is on its way and while the file is put together.
  `cargo test`: the ffmpeg arguments, the name, the part file's name; with
  `sh` for ffmpeg, 1 MB on stderr before stdin is read, a kill that ends a
  write nobody reads, a failure's message, a lost export discarded by the
  next, and a cancel in the last step deleting the part file and leaving the
  file that had the name. The smoke test exports the smoke score's karaoke,
  finds `smoke (karaoke).mp4` and no part file; ffprobe on it: h264 1920 ×
  1080 30 fps and stereo AAC, 8 s each, the sound not silent.

## D142 — Karaoke: words 5 s ahead at most, and the top row after a pause

**Status:** proposed · **Refines:** D133, D139

- **What.** A phrase is shown from 5 s before it is sung (`SHOWN_AHEAD`),
  not as soon as the phrase before it is: the rows stay empty through an
  intro or a break, with the ♪ that says the music goes on. The first
  phrase after a pause that left both rows empty, one starting more than
  5 s after every phrase before it has ended, is on the top row; the rows
  take turns from there. Before, a phrase's row was its number's parity,
  so after a break the words could come in on the second row.
- **Why.** Words shown 20 s before they are sung are read as the words
  sung now; a singer looks to the top row for where to come in.
- **Verified.** `karaoke.test.ts`: a pause of 9 s hides the next words
  until 5 s before them and puts them on the top row, the turns going on
  from there; a long phrase keeps the next one hidden until 5 s before it.

## D143 — Karaoke's full window: a double-click and a corner icon

**Status:** proposed · **Refines:** D135

- **What.** The header's *Full window* button is gone. A double-click on
  the karaoke goes into the full window and out again; an icon in the
  karaoke's top right corner, four corners going out, does the same, and in
  the full window it shows them coming in, beside ▶ and the time, in place
  of D135's ✕. Esc still leaves. The corner is faint until the pointer is
  on it, in the pane as in the full window.
- **Why.** The header keeps the choices that change what is drawn; the way
  into the full window belongs on what goes full, as a video player has it.
- **Verified.** The smoke test: in the pane the icon and no ▶; a
  double-click into the full window, the icon out, the icon in, Esc out.
  Headless Chrome on the corner's CSS: the icon in the pane, faint and
  hovered; ▶, the time and the icon in the full window.

## D144 — Work on the apps leaves the engine alone, and extends it through its interface

**Status:** accepted (the operator's answer of 2026-11-01, on reviewing PR 6)
· **Changes:** `AGENTS.md`; every app decision after this one

- **What.**
  - **Work that is not about the engine changes none of its files.** A
    feature of Lily Studio or the extension changes nothing under
    `packages/engine/`: not its crates, its tools or its tests. The engine
    provides an interface for extending it, and the feature is built on that
    interface, in the package that wants it.
  - **The interface today** is LilyPond's own, which G8 holds the engine to:
    - a `.ly` file compiled ahead of the score, as `timing.ly` is:
      `-dinclude-settings` for LilyPond, an `\include` before the score for
      the engine. Its Scheme performers go in by `\consists` and hear the
      score's events;
    - a file that Scheme writes, which comes back as an output of the
      compile. It replaces an engine output of the same name, so it takes a
      name of its own;
    - the worker protocol (D56), through which an app reaches the engine at
      all.
  - **The playback map is the engine's contract, not a place for features.**
    `playback.rs` writes what `timing.ly` writes, and `tools/compare` holds
    both equal to LilyPond's, so a key added to the map changes the engine
    even though `timing.ly` lives in `packages/common`. A feature's data goes
    in a file of its own, from a performer of its own. A differential test is
    not loosened to make room.
  - **Where the interface falls short,** the gap is closed by a general
    interface, as engine work with its own decision and its own branch, never
    by a feature inside the engine.
- **Why.** The engine's gate is that it equals LilyPond, and a feature has no
  LilyPond to be compared with. PR 6 put Karaoke's `lyrics` in the map, so
  LilyPond's map gained a key the engine's lacks, and `trace.test.mjs`
  compares the two. Porting the key to `playback.rs` would put a karaoke
  feature in the engine, and leaving it out of the comparison would weaken
  the gate.
- **Evidence.** Neither is needed. PR 6's performer, moved to a file of its
  own beside an unchanged `timing.ly`, was run on `fixtures/melisma.ly` and on
  a score with `\lyricsto`, `\addlyrics`, `\italic` and `\set associatedVoice`.
  LilyPond 2.26.0 and the native engine, its files unchanged, wrote the same
  words and the same map. `core.wasm` was not tried.

## D145 — A song's repeat is played by the score: `\unfoldRepeats`, and the words in the order sung

**Status:** proposed · **Refines:** D26, D133

- **The fault.** *Song L* repeats from bar 6 with two endings (bars
  26 and 27) and prints its two verses one under the other. Its one `\score`
  had `\layout` and `\midi`, and the `\midi` of a `\repeat volta` plays it once
  with both endings in turn, so the song was 124 s of 204. Karaoke showed the
  two verses together as two singers: each line had its own `\lyricsto`, the
  second on a NullVoice, and both ran through the same bars at once. The file
  prints as it should; what it did not say is how the song is played.
- **Decision.** The score says so, and the studio follows, as D26 has it for a
  repeat unfolded in the MIDI only. A second `\score` has `\unfoldRepeats` and
  `\midi`, and the first keeps `\layout`. Its one `Lyrics` context has all the
  words in the order they are sung, out of the same variables as the printed
  lines, so Karaoke needs no notion of a repeat: a line is a singer (D133), and
  this is one singer. The score's `.ly` is where this is written;
  `packages/vscode/AGENTS.md` says how, for the next transcription.
- **The printed bars.** A performance counts on through a repeat, which puts
  the second time through at bars 27 to 46 and *Play from bar* at numbers the
  page does not have. `\unfolded \volta 2 \set Score.currentBarNumber` keeps
  the printed ones, without changing the print. `barTime` already takes the
  first time a bar is played, and the number's going back is no trouble to
  `barAt`, but the second ending's going from 25 to 27 was: a missing number
  means a bar nothing began in, so `bar 26` showed for the second half of bar
  25. Bars missing from the map now stop at the first number already played:
  26 was, so none is missing between 25 and 27, and a rest that ends a repeat
  is counted up to its first ending and no further. *Rejected:* comparing the
  gap's seconds with the bar before's, which took a rest of two bars after a
  change of meter or tempo for a second ending and hid a bar, and missed a
  second ending after a long bar. Numbers have no tempo or meter.
- **A syllable sung elsewhere than it is printed** is written out, not taken
  from the variable: the second verse's first syllable is printed in bar 5 and
  sung in bar 26, and its link would light bar 5 from page 3 (D118).
- *Rejected:* the studio unfolding every score. A `\midi` of a `\repeat` could
  be unfolded by a `.ly` ahead of the score, but which verse is sung which
  time through would still have to be read out of two `\lyricsto` lines: their
  refrain is on one line only, and each pass's syllables are known only after
  the notes have taken them, so it needs a folded performance beside the
  unfolded one, a map from one to the other, and a rule for the lines. It
  would also change how every score plays, for a thing the score can state.
- **Not done.** Lines of verses under one `\unfoldRepeats \music` are still
  shown as sung by LilyPond: together, the second time through empty. A hyphen
  in a word (`ла -- ла`, `до -- ре -- ми`) is a syllable's to Karaoke,
  which joins them without it. `barAt` still counts bars across a `\set` that
  cuts the numbers with no repeat (2 to 10), shows a first ending of rests as
  its first bar throughout, and does the same for a rest over bars that had
  notes the time before.
- **Verified.** `panel.test.ts`: `barAt` over a repeat with printed numbers,
  and over the maps of compiled scores: rests after a change of meter or tempo,
  after a jump back and at the end of a repeat, second endings after a long
  bar. `karaoke.test.ts`: a real compile through `lily-outcome` of two scores, one
  printed with two lines and one played with the sung words: the map's bars 1,
  2, 3, 2, 4, 5, the syllables at their times, one singer. On the song itself,
  with `lilypond` and the studio's runtime: no warning; each PDF page pixel for
  pixel the old one and each SVG page equal but for its links; `karaoke.ts`
  gives 29 phrases, verse 2 from the end of bar 26. In headless Chrome, over
  the real pages, `timelineOf` takes the playhead from bar 26 on page 3 to bar 6
  on page 1, and the second time from bar 25 to bar 27 on page 3. `barAt` over
  the song's map reads 25, 26, 6 and later 25, 27, 28, with no 26 the second
  time. Not played in the app.

## D146 — Karaoke: a phrase is the original's line

**Status:** proposed · **Refines:** D133, D135, D139

- **Why.** Song G's lead, said to a NullVoice, broke mid-line: a
  said syllable has no notes to hold it, so it lasted 0.5 s and the
  speaker's pauses ("one … night") were taken for 0.9 s gaps; 12 of
  its 16 verse lines are longer than 40 characters and broke at a word;
  and `Waltz?”` did not end its sentence for its closing quote.
- **What.** Between two said syllables a gap ends the phrase only past
  2 s; a phrase breaks at a word only past 60 characters (the longest line,
  55, fits: the row's font shrinks to the width); a stop or a comma
  followed by closing quotes or a bracket counts. The lines themselves
  come from the score's punctuation: lily-karaoke's `said` voice ends each
  line of the original lyrics with its stop and takes the others out.
- **Verified.** `karaoke.test.ts`: a 55-character line one phrase; a said
  pause of 1.5 s inside one and one of 3 s ending it, where a sung pause of
  1.5 s ends its phrase; a stop inside quotes or a bracket. Its real-score
  tests pass with `lily-outcome` built and LilyPond 2.26. Song G: 48
  lead phrases, each ending where a line of the sheet's lyrics does (60
  before, 12 of them mid-line).

## D147 — Karaoke: singers taking turns share the top

**Status:** proposed · **Refines:** D139

- **What.** A line never sung at the same time as the lines on top, no
  phrase of it overlapping one of theirs, joins them: the larger lines are
  tried first. They share the lane and the two rows, the phrases taking
  turns as one line's do, each phrase and note in its singer's colour. A
  line sung at once with them goes below, as D139 has it.
- **Below, a row a line.** With two lines or more below, each of the first
  two has a row of its own, showing its phrase not yet over, at most 5 s
  ahead as D142 has it (`sectionRows`); a row its line leaves empty shows
  a further line's phrase, so a third line is not left out. Taking turns,
  a long held line (a held "Ooh" under the ad-libs, *Song F*) kept an
  answer sung long ago as the next phrase.
- **Why.** *Song H* is sung in turns, her, him and both, each on a
  staff of their own for their colour. By D139 the screen split in two for
  singers who are never heard together: the lower half's rows empty while
  the upper sang, and back.
- **Verified.** `karaoke.test.ts`: three lines taking turns on top, a
  fourth sung over one of them below; below, a row for each of two lines,
  and a third line on the row its line leaves. The five songs' sections:
  *Song E*, *Song F* and Song G split as before, Song I
  one line, Song H's three lines on top. Its frames drawn in
  headless Chrome: her phrases green, his blue, both orange.

## D148 — Part colours a colour-blind singer tells apart, shown before the words are sung

**Status:** proposed · **Refines:** D117, D133, D147

- **What.** The parts' colours (`PART_COLORS`, the piano view's and
  Karaoke's) are Okabe–Ito's and Paul Tol's: yellow `#f0e442`, sky blue
  `#33bbee`, rose `#ee6677`, then olive, green, purple, light blue, mint.
  Words sung to no notes (`WORDS_COLOR`) are light pink `#ffaabb`. A part
  still gets the next colour in the order it first sounds (D117), so the
  first singer is always yellow, the second blue, the third rose. A
  phrase's part not yet sung is its singer's colour dimmed towards the sky
  (`mixed`, 80 % kept), not white; the sung part is the full colour with
  its glow. The next phrase, shown while another is sung, is drawn at 0.9
  opacity, not 0.75. The piano view writes a note's name, on a falling
  note or a key that sounds, dark (`LABEL_COLOR`, `#0b0e14`) and not
  white: at least 5.6:1 on each colour, where white was 1.3:1 on the
  yellow.
- **Why.** With singers taking turns on the same rows (D147), a white
  next phrase did not say who sings it. The old green and orange were one
  colour to the user: their ΔE2000 under deuteranopia (Machado 2009) was
  4.7, and 1.9 tinted pale.
- **Measured.** Of the first three colours, the closest pair has ΔE2000
  23.9 under protanopia, deuteranopia and tritanopia, full or dimmed; the
  first four 14.6, all eight 5.7; the words' pink 14.9 from the first
  three. On the sky's lightest (`#28174e`, with the haze) each full
  colour has a contrast of at least 4.6:1 (WCAG AA); dimmed, the first
  four 3.6:1 at least, 3.1:1 when also shown as the next phrase: AA for
  large text (the rows are 16 px bold at the least and mostly over 24 px).
  Colour is still the only sign of who sings (WCAG 1.4.1).
- **Verified.** `karaoke.test.ts`: `mixed`. Song H's frames in
  headless Chrome: her phrases yellow, his blue, both rose, the next one
  dimmed in its singer's colour.

## D149 — Karaoke starts at the score's `% Start:`

**Status:** proposed · **Refines:** D133, D135, D140, D154

- **What.** A score may say where its karaoke starts, in seconds of the
  music, in a `% Start:` line beside `% Backing:`. While Karaoke is shown,
  ▶ from the stopped music plays from there, as from a start bar (D45),
  which still comes first; and Export Video runs from there to the end, its
  sound cut to match. Below 0 is a silence before the music, a minute at
  most: the time counts down (`-0:04`), the lane and the words move as
  they will, the count-in dots come, and the backing track waits at its
  start until the music reaches 0; ← goes back into it. The video gets the
  same silence in front.
- **Why.** Song I sings first at 42.8 s: a singer waits through an
  intro. *Song F* sings at 0.9 s, before anyone has found the words. A start
  in the score, not in the window's setup, goes with the song and its video.
- **Which start.** lily-karaoke's `check.py` warns when the first word is
  less than 5 s or more than 20 s after the start, and says where: 5 s
  before the words, below 0 if needs be; past a long intro, a bar where the
  music's phrase begins 10–15 s before the words, the bars 4 apart listed
  to listen to (Song I's loop turns every 4 bars: 31.88 s, 10.9 s
  before the words). The five songs: Song I 31.88, *Song F* −4.09,
  *Song J* −3.5; *Song E* (10.6 s), *Song H*
  (14.9 s) and Song G (16.3 s, its band in at 10.6 s) from 0.
- **The parts.** midi.js's `Player.seek` takes a place down to −60 s, and
  plays the notes from 0 after it; `formatTime` counts down below 0. The
  Stem strip pauses a following recording at 0 while the score's clock is
  below it. Export Video draws frames from the start and hands it to
  ffmpeg, which cuts the backing track and the melody before it (`atrim`)
  or delays them by the silence (`adelay`).
- **Verified.** `files.test.ts`: the line read, a minute at most, none
  without a number. `video.test.ts`: the frames from a start past an intro
  and from a silence. The extension's `midi.test.ts`: a silence of 2 s
  before the first note, the position below 0, the countdown's times.
  `cargo test`: the filters for a cut and a silence; real ffmpeg on them:
  10 s of sound from 4 s lasts 6, and 2 s of silence before a tone.
  `npm run test:smoke` passes, its export from 0 as before.
  Not heard in the app: ▶ over a backing track with a silence was not
  played.

## D150 — A sung line glides from note to note

**Status:** proposed (the user asked for portamento, 2026-11-01) · **Refines:** D24

- **What.** `parseMidi` marks a note `legato` when it begins as the note
  before it on its track and channel ends, nothing else of theirs sounding
  or starting with it (a line, not a chord). On choir aahs, voice oohs and
  synth voice (programs 52–54) the synthesizer carries such a note on the
  tone already sounding: the release is called off, the pitch glides to the
  new note in 70 ms (a third of a short note), and a syllable on the same
  pitch dips the level to 55 % for 50 ms so that it is heard as a new one.
  A note after a rest, a seek into a line or any other program starts
  afresh as before.
- **Why.** Karaoke's tune is a syllable a note, many of them a sixteenth
  (0.2 s at ♩=72). Each started from silence with the voice's 80 ms attack
  while the one before released: the line pumped, choppy where the singer
  is smooth (*Song J*, in the author's words: "choppy and poor"). Only voice
  programs, so that strings, brass or a melody on a flute keep their
  articulation.
- **Verified.** `midi.test.ts`: which notes are legato (a line, after a rest,
  into and out of a chord, another track); a sung line of three notes
  starts one oscillator, a piano line three; a pan a note brings mid-line
  still applies. *Song J* v2's MIDI: 186
  of its 196 notes glide, 10 phrases start afresh. Not heard here: no Web
  Audio in Node.

## D151 — Playback suspends its audio context while nothing plays

**Status:** proposed · **Refines:** D24, D51, D135

- **The fault.** Music sometimes started about a bar late, and went on for
  about a bar after a pause. `Player` made one `AudioContext` on the first play
  and never suspended it, so it ran idle for hours.
- **Cause [measured].** In WKWebView, Web Audio is rendered in the WebContent
  process into a ring buffer of about 2 s (`RemoteAudioDestinationProxy`) and
  read in the GPU process (`RemoteAudioDestination::render`). On an underrun the
  reader does not advance, but the frames are still counted, so the writer stays
  ahead for good. The lag is the longest stall of the render thread since the
  destination was created, and JS cannot see it: `outputLatency` and
  `getOutputTimestamp()` do not change, so D51's correction does not reach it.
  At CoreAudio's output in one session it was 0.03 s at 14:50, 0.22–0.29 s at
  15:24–15:31 and 1.61 s at 17:10, on the same Bluetooth amp, and that delay is
  before Bluetooth. Both jumps fell in long idle gaps (32 and 95 minutes), none
  during playback or a gap of 3 minutes. What stalled the thread was not
  isolated.
- **What.** After a pause, ■ or the end of the music, the context is suspended
  once nothing has played for 10 s, and the next ▶ resumes it. No reader runs
  while idle, so an idle stall has nothing to fall behind. `midi.js` is shared,
  so Lily Studio and the extension's webviews both get this.
- **Why 10 s.** Whatever is in the ring buffer stays there across a suspend and
  plays on the next resume, and `Synth.stop()` needs its 100 ms to fade, so the
  grace must outlast the buffer: 2.1 s at the least. Beyond that it is the
  length of a pause that should not restart the device, which costs 11 ms on a
  USB output and more than half a second on Bluetooth. Exposure hardly grows:
  no jump was seen in a gap of 3 minutes, let alone seconds.
- **A slow resume is not a refused one.** `play()` gave up on `resume()` at
  300 ms, which is right while a gesture is awaited, as it never settles then
  (D24), and wrong for a device: Bluetooth took 550 ms to start. It now waits
  300 ms only where a click may be missing. After our own suspend, or on a
  context still `suspended` on a page with
  `navigator.userActivation.hasBeenActive`, it waits up to 5 s. Where the API is
  absent, or the system holds the audio (`interrupted`), it is 300 ms as before.
- **`suspended` means what its comment said:** the last play() was refused, or
  the system took the audio away, and the context is still not running. It was
  the raw state, which our own rest makes `suspended` for most of a session,
  and a ■ or a second ▶ during the wait read as *The sound could not be
  started*.
- **A press is kept.** The wait can be long enough for a second press, so
  `starting` says a play is under way. A second ▶ replaces the first without a
  failure. A seek and `remix()` go on with it. ❚❚, ■ and another score call it
  off.
- **Races.** `play()` cancels the pending suspend, and `sleep()` does nothing
  during a play. A suspend already on its way cannot be cancelled, and the
  context says `running` until it lands, so `asleep` holds its promise and
  `play()` waits for it before resuming: otherwise the suspend landed after the
  start and the `statechange` listener paused the music. That listener only
  pauses while playing. It also rests a context that comes back running with
  nothing to play: a resume that arrived after `play()` gave up, or the system
  giving the audio back. The Stem strip reads the clock only while playing, and
  a linked recording starts when the score does.
- **Bluetooth.** A2DP took 26–36 ms to restart after a short gap and 431 ms after
  18 s, with the link in sniff mode. On the first start that fell before
  `RemoteAudioDestination::start`, but a resume may have its clock running
  first, and `LEAD_IN` is 60 ms. So a resume from rest onto an output of 80 ms
  latency or more (Bluetooth headphones 160 ms, a USB interface 3 ms) waits 450 ms before
  starting. It waits in real time, inside `play()`, not in the lead-in: a longer
  lead-in would start a linked recording that far ahead of the score, beyond
  D135's `DRIFT`, and that recording would lose its start to the same stream.
- *Rejected.* `close()` and a new context: `SharedAudioDestination` reuses one
  destination per (channels, sampleRate) until GC, so the lag stays. Suspending
  at once: stale audio. A longer lead-in, above.
- **Not done.** A lag that already exists is not cleared; a context at another
  sample rate would do that. A stall during playback or the grace can still add
  lag, which lasts until the app restarts. ▶ gives no sign while it waits, up to
  about a second on Bluetooth after a rest.
- **Verified.** `midi.test.ts`: the grace, a play inside it, seeks and reloads,
  a play after it, slow and dead devices, a suspend on its way, ■, ❚❚ and a
  second ▶ during the wait, a context without `suspend`, the wireless wait, the
  300 ms case; each safeguard removed in turn fails a test. `player.test.ts`:
  `ScorePlayer` says nothing on a slow resume and says so on a dead device, a
  mute keeps the press, and the strip goes on across a rest on the real `Player`.
  In system WebKit on macOS 26.5.2, with `midi.js` itself in a WKWebView at about
  −60 dBFS, on a USB output: 13 s after a pause or ■ the GPU process has no audio
  I/O (`kAudioProcessPropertyIsRunningOutput`), `RemoteAudioDestination::stop` is
  logged, and a play inside the grace touches nothing. The next play took 11 ms
  and the HAL read −58.5 dB. A suspend and a play in one turn took 18 ms and
  went on playing. Lag at the HAL: 0.006 s; after a 2 s stall while suspended,
  0.004–0.007 s; after a 1 s stall while running, 1.007 s for good. With 1 s of
  lag, suspending at once and resuming replayed about 1.1 s of music, and
  after the grace nothing (−120 dB). In headless Chrome 156: the same rest,
  resume and race; its autoplay flag did not hold the first play back, so a
  real refusal is tested only by the fake. **Not verified:** the Bluetooth amp
  was off, so the 550 ms, the 450 ms wait and whether `outputLatency` is right
  at once after a resume were never run on Bluetooth. Not played in the app:
  the strip's `<audio>` was not tried after a rest in WebKit.



## D152 — Playback position: an element that draws nothing has no place

**Status:** accepted · **Refines:** D26, D118, D120

- **The fault.** Sometimes the playhead stood from the top of the page to its
  bottom, at its left edge. In *Song K* the tenors' words in
  bar 37 are `_ word __ _ "" _ _`, and the `""` begins with the altos' next word.
  An empty syllable is played (it is in the map) and drawn as an `<a>` with
  nothing in it. Both WebKit and Chrome measure that as a point at the SVG's
  top left corner, which is (0, 0) in fractions of its page. That point joined the
  moment, so its x went to 0. To `systemsOf` that is the music going back left,
  so a new system began at bar 37 beat 4. Its band started at the top of the
  page and held every bar to 39.
- **Decision.** `timelineOf` treats a box with neither width nor height as no
  box. Such an element places no moment, takes no part in a system's band,
  and is not a candidate in D120's nearest place. An href with such an
  element among several keeps its page order instead of D118's reading
  order, as with any element that has no box. The event keeps its element, so
  the empty `<a>` still gets `playing`, which shows nothing. The check is in the
  shared half of `preview.js`, so the extension's preview and Lily Studio
  both get it. A real mark is never a point: a stem or a bar line has a
  height, and an extender has a width.
- **Verified.** `player.test.ts` has a syllable measured as that point
  beginning with a note on the second system. Without the change that moment
  starts a third system, whose band begins at 0. On the
  `lily-studio-server` in headless WebKit, *Song K* played from
  bar 29. The playhead went from top 0.65, height 0.29 of the page to top 0,
  height 0.96, at the left edge, from bar 37 beat 4 to the end of the
  system. With the change it stays at top 0.65, height 0.31, through bar 39.

## D153 — What is shown and what is heard are independent, all on, and the view says what is off

**Status:** accepted · **Refines:** D117, D133, D40

- **The fault.** In *Song K*, Karaoke said *No words: write
  them in \lyricmode…* and its lane stayed empty, and the Keyboard showed
  nothing either, as if stopping the music had lost them. The window's
  storage had the score's tracks 1, 2 and 4 hidden in *Tracks*: the solo,
  the sopranos and altos, and the tenors and basses, every singer. That was
  kept from some earlier day, by track, for good (D117). *Tracks* hides a
  singer's notes and words together (D133), so all that was left was the
  piano, which first plays at 0:20. The only sign was the *Tracks* button's
  colour. The message was wrong too: it told how to write words that the
  score has.
- **Shown and heard apart.** *Tracks* says what the view shows; the *Parts*
  fold says what is heard. The Keyboard used to draw the player's music,
  so a part muted in *Parts* left the fall and the list in *Tracks* as well.
  It now draws the score's music, as Karaoke has since D133: muting never
  hides, and hiding never mutes.
- **All on.** The hidden tracks are kept per score for the run only: a
  score opens with every track shown, and the key D117 kept them under
  (`lily-studio.piano-hidden`) is removed. Muting stays in the score's
  playback setup (D45), as before; that is a choice about the music, with
  *Reset* beside it.
- **The view says what is off.** While a track is hidden or muted, a line
  at the foot of the view names it and where to turn it on: *Not shown:
  Solo, S.A and T.B. Tick them in Tracks to see them.*, *Muted: Piano. Turn
  it On in Parts to hear it.* (`trackNotice` in `piano.ts`). It gives way to
  the view's own empty message, such as *Every track is hidden*. Karaoke
  with words that are all on hidden tracks says *The words are on hidden
  tracks: tick their singers in Tracks.* (`emptyWords` in `karaoke.ts`);
  *No words* is left for a score that has none. Karaoke's *Melody* off over
  a backing track (D135) silences the parts without muting them, so the
  line says nothing of it.
- **The agent's instructions** (D40) gain two lines. Karaoke reads the words
  of the first `\score` with a `\midi` block, so a score split into a
  `\layout` score and a `\midi` score needs its words in the `\midi` one too.
  The words are sung to a named voice with `\lyricsto`, or with `\addlyrics`
  after it: one syllable per note, `--` within a word, `__` over a melisma,
  `_` for a skipped note.
- **Not done.** A muted part's notes are drawn as a sounding one's. Opening
  *Tracks* focuses its first box, so a Space there hides that track instead
  of playing; that is a checkbox's Space and is left alone.
- **Verified.** `piano.test.ts` has the notice's lines, `karaoke.test.ts`
  both of Karaoke's messages, and the agents test the new lines. The fault
  was found by reading the studio's storage and compiling the score: its
  MIDI tracks 1, 2 and 4 are `soloStaff:soloVoice`, `saStaff:saVoice` and
  `tbStaff:tbVoice`.

## D154 — Arrow keys: ← → move the music 5 s, ↑ ↓ its volume

**Status:** proposed · **Refines:** D35, D135

- **What.** While the music plays, or Karaoke is shown, ← and → move it
  5 s back or on, playing on if it played, and ↑ and ↓ make it louder or
  softer by a tenth, from silent to as the file has it. The volume is the
  whole music's: the score's MIDI (midi.js's Player gains `volume` and
  `setVolume`, its synthesizer's master gain, over each track's D121
  volume) and the Stem strip's recording together, so a backing track and
  its melody keep their balance. It is kept in the window's storage. Over
  Karaoke the new volume shows for a moment; elsewhere the status line says
  it. The time on the transport shows where a seek went.
- **Not taken.** An arrow with ⌘, ⌥, ⌃ or ⇧ is the system's. Keys typed
  where arrows mean something already are left alone: text and the editor,
  sliders, selects, lists, menus, tabs and the sidebar's splitters. Export
  Video renders at the parts' volumes, not this one.
- **Verified.** `keys.test.ts`: the keys, modifiers, the volume's steps
  and ends. The extension's `midi.test.ts`: the volume set before the sound
  starts, while it sounds, and kept between 0 and 1. The smoke test, with
  Karaoke shown and the music paused: ← twice to 0:00, → to 0:05, ↓ shows
  "Volume 90 %" over the karaoke, ↑ back to 100 %.

## D155 — A score's audio track: a recording played along with the MIDI, from an offset, at a tempo, and the video's sound chosen

**Status:** proposed (the operator's request of 2026-11-02) · **Refines:**
D45, D121, D133, D135, D149, D154

- **What.** A score may have an audio track: a recording that plays along
  with its MIDI as a track of its own, for karaoke above all but for any
  score. The *Parts* fold has a row for it after the parts: On | Muted, its
  name, *Starts at … s*, *Ends with the MIDI | the audio*, its own volume
  from 0 to 100 % and ✕; without one,
  *Add audio…*. Below *Start at bar*, *Tempo, ♩ a minute* plays the MIDI at
  another tempo, to keep with the recording; its placeholder is the score's
  own.
- **In the score, beside `% Backing:`.** The recording is a line of the
  score, `% Audio: <file beside the score>`, as `% Stem:` and `% Backing:`
  are, so it goes with the score. So does what keeps the two together, which
  is the song's and not the window's (D149's reason): `% Audio offset:` in
  seconds and `% BPM:` in quarter notes a minute, both to the hundredth
  (`-1.25`, `143.5`). The fold writes them to the editor as one undoable
  edit that leaves the cursor and the view where they are, and they are read
  again as the text changes, so a line typed by hand, or an undo, is heard at
  once; the edit is saved as any other. A line given its default (0, the
  score's own tempo, or nothing) is taken out. A new line goes after the
  score's own lines, else after `\version`. *Add audio…* asks for a
  recording from the score's folder; one from elsewhere is copied beside the
  score under a name not taken, and the status line says so. ✕ takes the two
  `% Audio` lines out and leaves the file.
- **The volume, mute and end are the setup's,** as a part's are (D121):
  `audio` in the score's `playback.json`, `{ muted?, volume?, end? }`, 100 %
  and the MIDI's end not written.
  *Play as written* resets them, not the score's lines. The volume goes to
  100 %, not 200: an `<audio>` element plays no louder than its file. The
  whole music's volume (D154), the arrow keys', is over it as over the
  parts. Karaoke's silence of the parts over a backing track (D135) leaves
  the audio track alone.
- **The offset.** The recording's place is the music's less the offset. A
  positive one waits at the recording's start until the music reaches it;
  a negative one is that far into the recording at the music's 0. Past the
  recording's end it is silent. Karaoke's silence before the music (D149)
  counts the same way.
- **Where playback ends.** With the MIDI, as without a recording; or with
  the recording, at its offset plus its length, later or earlier than the
  MIDI. The music the player is given lasts that long (`withEnd`), so the
  transport's time and slider, ← →, the stop and the video all go by it.
  Until the recording's length is known it ends with the MIDI, and it is
  played again from where it was when the length arrives.
- **The video's sound is chosen** (refines D140). Export Video opens a menu,
  *Sound in the video*: a box for each part, the audio track and the backing
  track, ticked as they are heard, and *Export Video…*. Any of them goes in,
  whatever is muted or silenced: a part on its instrument at its volume, the
  audio track at its offset and volume, the backing track as before. What
  was chosen is kept per score for the run. ffmpeg moves each recording to
  the video's start from its own offset (`atrim` or `adelay`), sets its
  volume, sums them with the melody's WAV, and cuts the sound at the
  frames' end (`-t`), so a recording that goes on longer does not lengthen
  the file. The video lasts as long as playback, or the backing track when
  that is longer, as before. Pressed while an export runs, the button still
  cancels it.
- **The tempo** scales the parsed MIDI before anything reads it
  (`atTempo`): every note's time and length, the duration and midi.js's tempo
  map by the score's first tempo over `% BPM:`, so a later `\tempo` keeps its
  proportion and `momentTime` puts the map's moments on the same notes. The
  playhead, the bars, the start mark, the keyboard, Karaoke and Export Video
  all read the scaled music. Changed while playing, the music goes on from
  the same note. midi.js is unchanged, and so is the engine (D144): no
  recompile, the score's `\tempo` and its notation as written.
- **Playing.** `AudioTrack` (`audioTrack.ts`) is an `<audio>` that the
  transport moves as the Stem strip moves a backing track (D135): kept to
  the music's place on its audio clock (`scheduled`), put back at once for
  ▶, a seek or ■, and for a drift past 0.25 s, then left alone for 2 s. It
  is the score's, not the Stem strip's: it needs no separation, and it plays
  while the strip's recording does. The file is let into the asset scope by
  `attach_stem`, which already checks for an audio file beside the score.
- **Not done.** The web has no audio track: it can play no file of the
  user's. A score without `\midi` plays no recording. Export MIDI leaves it
  out and writes the score's own tempo. The video's choice is not kept past
  the run. A
  tempo that drifts against the recording is D135's `songTempo`, not this.
- **Verified.** `files.test.ts`: the three lines read, to the hundredth and
  within their limits, written in place, added after the score's lines or
  `\version`, taken out with their line break, CRLF kept.
  `playbackSetup.test.ts`: a hand-made MIDI with a second tempo scaled to
  ♩ = 60, its moments on the same notes, unchanged at its own tempo; the
  audio volume and mute. `audioTrack.test.ts`, on the real `Player` over a
  fake clock and `<audio>`: a later and an earlier start, a seek, pause and
  ▶, drift, the recording's end, an offset changed while playing, the
  volumes and the mute. `player.test.ts`: the fold's rows, what they write
  to the score and keep in the setup, the music scaled by `bpm`, playback
  ending with a recording that ends later, earlier or is not loaded yet,
  and the video's music of the parts chosen, muted or not.
  `video.test.ts`: the recordings chosen reach ffmpeg at their offsets and
  volumes, cut at the frames' end. `video.rs`: the filter graph for a
  recording delayed or cut and made softer beside the melody, and `-t`;
  real ffmpeg on that graph: a 4.5 s file.
  `playback.rs`: what of `audio` is kept. `separate.rs`: a recording beside
  the score named, one from elsewhere copied under the next free name.
  `npm run test:smoke`: the fold shows *Add audio…* and the score's tempo;
  Export Video opens its menu with the part ticked and exports through it.
  Not heard in the app: no recording was played along with a score.

## D156 — Karaoke and the keyboard together, and Karaoke's notes on a staff

**Status:** proposed (the operator's request of 2026-11-02) · **Refines:**
D116, D133, D139, D140

- **What.** The view's style is *Keyboard | Karaoke | Karaoke and
  keyboard*. The third draws Karaoke over the top 60 % and the keyboard,
  its notes falling, below it, on one canvas; the keys' range choice is
  shown with it, as with the keyboard. Karaoke's lane, alone or with the
  keyboard, has a choice of its own, *Piano roll | Staff*, kept in the
  window's storage as the style is: the bars on a row per semitone as
  before (D133), or the same notes on a staff. Whatever counts Karaoke as
  shown (the arrow keys, its start at `% Start:`, the silence over a backing
  track, the full window, the volume shown over it) counts the third style
  too. Export Video draws what is shown: with the keyboard, the video has
  it.
- **The staff** stays put and the notes run past now from right to left,
  1.5 s behind and 4.5 s ahead, as the bars do; a note's head is on now
  when it starts and is lit, white with a glow, while it sounds; past
  notes are faint, and notes fade out into the clef. Each note has a head,
  stem, flags and dots by its length in whole notes, which the MIDI's
  duration gives through the tempo map (`momentTime`, inverted); the value
  drawn is the one nearest, so a tie is one longer note and a triplet the
  value nearest it. A track's notes starting together with the same value
  share a stem; a second's heads go either side of it. The bar lines are
  the map's bars, numbered above. Words said to no note (D139) are an ✕
  on the middle line. A singer's section (D139) has a staff of its own.
- **The clef** is the score's, from the staff of the track most of the
  section's words are sung on (`staffTracks`, which `voiceTracks` now goes
  through, pairs staves and tracks), with its transposition: a tenor in
  `treble_8` is written an octave up, with the 8 under the clef. When the
  notes do not fit it with three ledger lines, or the score gives no G or
  F clef, it is treble or bass, the nearer the notes' middle first; when
  neither holds them, as when a piano's notes share the lead's lane, a
  grand staff. A staff takes 40 % of its section (55 % as a grand staff),
  where the roll takes 30 %.
- **The key** is not in the map, and the map stays as it is (D144). The
  notes give it: the major or minor key whose Krumhansl–Kessler profile
  their time on each pitch class follows best, the one with fewer
  accidentals of two alike. Its signature follows the clef, and a note
  is spelled in it (`notation.ts`'s `spell`, as transcription spells), its
  accidental printed where the signature does not have it, on every such
  note: accidentals do not carry through a bar.
- **Glyphs.** The clefs and accidentals are Unicode's musical symbols
  (𝄞 𝄢 ♯ ♭ ♮), from Bravura or Noto Music when installed, else the
  system's (Apple Symbols on the Mac), fitted to the staff by their measured
  ink. Emmentaler is not bundled: it is LilyPond's, and no font comes with
  the apps.
- **Not done.** No rests, beams, ties, tuplets or key changes; a chord's
  stem is a track's, so two voices on one track share one. The key is a
  guess, wrong for a modal or chromatic song. Not drawn with real notation
  spacing: time is the horizontal axis, so fast notes crowd.
- **Verified.** `staff.test.ts`: the key of a major and a minor tune, the
  signatures, the accidentals, the steps, the clef taken from the score or
  by range or a grand staff, the values, the lengths through a tempo, the
  tracks' clefs. Looked at in headless Chrome from a real compile of a
  lead in D major, a tenor in `treble_8` and a piano in the bass clef: the
  roll, the staff at two moments, and Karaoke on a staff over the keyboard.
  `npm run test:smoke`: Karaoke and keyboard with the staff shows the keys'
  and the lane's choices and says so on the canvas; Keyboard hides the
  lane's choice again.

## D157 — Karaoke's words have a least size, and a longer phrase wraps

**Status:** proposed (the operator's request of 2026-11-02) · **Refines:**
D133, D146

- **What.** Karaoke's header has *Min text … px*, a number from 8 to 96,
  24 until changed, kept in the window's storage. A phrase is fitted to
  90 % of the width at the row's size at most, as before (D133); when that
  would make it smaller than the least size, it is drawn at the least size
  instead, broken at word ends onto as many lines as it needs, the lines
  as alike in width as they can be (`balancedLines`: the narrowest room
  that needs no more lines than the greedy break), a word is never split.
  A word wider than the room alone is still fitted to it. Each line is
  coloured as it is sung, as the one line was; the count-in dots are over
  the first.
- **The rows** stay at a third and two thirds of the words' area; when a
  wrapped row would touch the other, the two move apart, and the two are
  kept inside their section, up from its foot but never over the lane. A
  size larger than the area holds can still spill over: the box is the
  singer's choice.
- **Why 24 px.** A 60-character phrase (D146) fitted to a 500 px pane was
  about 15 px, too small to sing from at a distance; 24 px wraps it in two.
  Wider panes and the full window fit it at the row's size, as before.
- **Export Video** draws at the least size too, of its 1920 × 1080 frame
  at the device's scale, as the karaoke is shown.
- **Verified.** `karaoke.test.ts`: the breaks at word ends, a word kept
  whole, the evened lines. `piano.test.ts`: the box's number, its range and
  default. Looked at in headless Chrome at 500 px wide and a least size of
  40 px: a phrase on two even lines, the rows moved apart within the
  section. `npm run test:smoke`: the box shown with Karaoke and hidden with
  the keyboard.

## D158 — The audio track waits for its seek before it plays, and is not left at its end

**Status:** accepted (the operator's report of 2026-11-02) · **Refines:** D155

- **The fault.** Now and then the audio track was silent while the MIDI
  played on, after a stop, some changes in the Parts fold, and ▶. The
  system log of the operator's session (23:55 and 00:09 on 2026-11-02, an
  MP3 of 216.74 s) shows why. The recording had played to its end and
  waited there (`follow()` pauses it past its end). ▶ sent it back to the
  music's place and called `play()` in the same moment. WebKit plays an
  `<audio>` on AVFoundation, which, in the approximate time mode it seeks an
  MP3 in, started playing from where the item still was: its end. It
  scheduled its end, and as the seek landed it stopped there by itself
  (`itemfig_ReachedEndGuts: stopping (because ActionAtEnd == Stop)`). Its
  rate fell to 0 with no `pause()` from the page, so the element still
  counted as playing and nothing played it again; WebKit then gave the
  recording a duration of 0.27 s, the place it stopped at, and
  `follow()`'s *past its end* kept it paused from then on. The parameters
  changed had nothing to do with it.
- **What.** `AudioTrack` (`audioTrack.ts`):
  - a `play()` after a seek waits for `seeked`, for 2 s at most, so
    AVFoundation starts from where it was sent;
  - past its end the recording waits at its start, as before its start,
    not at its end, so the next ▶ does not seek away from the end at all;
  - counting as playing with its time still for a second, it has stopped by
    itself: it is paused and started again where the music is;
  - a duration that shrinks below the longest known loads the file again,
    and `follow()` puts it back in place.
- **Not reproduced on demand.** The race is AVFoundation's timing: with the
  old code, three rounds of an MP3 played past its end and then ▶, in the
  real app, all played. The fix is to what the log shows, not to a
  reproduction. With it, the same rounds show the recording waiting at 0
  past its end and playing each time.
- **Not done.** The Stem strip's recording (D135) is played the same way
  and could meet the same race at a backing track's end; it is not
  changed here.
- **Verified.** `audioTrack.test.ts`, on a fake whose seeks land later and
  which stalls as AVFoundation did when played during a seek away from its
  end: ▶ after the end waits for the seek and plays, past its end it waits
  at 0, a recording stopped by itself is started again, a shrunk duration
  loads the file again. The real app, by the smoke runner: an MP3 played to
  its end and ▶ again, three times, before and after the fix.

## D159 — From the recording: a score's tempo and bar 1 found in its audio track

**Status:** proposed (the operator's request of 2026-11-03, step 1 of
`docs/research/audio-tempo/` §6) · **Refines:** D113, D155 · **Research:**
`docs/research/audio-tempo/`

- **What.** In the *Parts* fold, beside *Tempo, ♩ a minute*, a button *From
  the recording* finds the tempo of the score's audio track and where its
  bar 1 is, and writes `% BPM:` and `% Audio offset:` (D155) from them. It is
  shown while the score has an attached recording (`% Audio:`), and never on
  the web. While it runs it says *Listening…*, and the status line names the
  stage (reading it, finding the beats). Both lines are written as **one
  undoable edit** in the editor, by D155's `setScoreLines`: the cursor and
  the view kept, a default value (the score's own tempo, an offset of 0)
  taken out, never written to the file, so one ⌘Z gives back the text as it
  was. Playback follows at once. The status line then says what was found
  and how sure it is: *♩ = 113.76, 4/4, bar 1 at 0.32 s; 99 % of the beats
  on one tempo*, with *heard ♩ = 227.52, taken as 113.76 to match the
  score's 114* when another metrical level was taken than heard, *the
  downbeats heard make 2 beats a bar, not the score's 4* when the meters
  differ, and *the tempo drifts: one tempo keeps it within 0.62 s* for a
  song that is not steady. When nothing is found, nothing is written and the
  status line says why.
- **`lily-transcribe --json tempo <recording> [--score-bpm N]
  [--beats-per-bar M] [--beat Q]`** (`tempo.py`, `cli.py`). Beat This
  (`final0`, no DBN) runs on the recording itself: a karaoke or stems
  separation's file needs no siblings mixed in, since the mix, the
  instrumental and the stems mixed gave the same tempo and bar 1 (§3.1).
  Its beats and downbeats are cached in `~/.cache/lily-transcribe`, keyed by
  the file's path, size and time apart from the songs' analyses, so a
  second run is instant; Basic Pitch and the key are not run.
  - **The tempo keeps its hundredths.** It is `grid.fit_steady`'s least
    squares through the beats on one straight grid, with no snap to a whole
    number: that snap is right for a `\tempo` (D113), which 2.24 takes
    whole, but 0.1 BPM is 0.18 s over 3:30 (§3.1). `transcribe` is
    unchanged.
  - **The level is the score's.** Of the heard tempo's ×½, ×1, ×2, and ×⅔,
    ×3⁄2 for a dotted beat, the one nearest the score's tempo on a log scale
    is taken; 120 without one (§2.2).
  - **The meter is the score's.** Its beats a bar group the beats into bars;
    the downbeats only choose which beat starts one, by a vote over the steps
    the heard and the chosen beats share. Their own vote for the meter
    (`heardBeatsPerBar`) goes wrong where Beat This marks a downbeat every
    two beats, as in Song A's breakdown (§3.1).
  - **Quarter notes.** `--beat` is the score's beat in quarters, so a
    dotted-quarter beat in 6/8 is written ×1.5.
  - **A song that drifts** (under 80 % of the beats on one grid) gets the
    least-squares line through all its beats, cleaned, and its 95th
    percentile; bar 1 is placed by the line through its first 16 beats and
    put on the beat heard there.
  - **No tempo** is an `error`: fewer than 16 beats, or beats that keep no
    tempo, which is under 80 % of beat-to-beat intervals within 15 % of
    their neighbours' median, or one tempo missing them by more than 8
    beats. A vocals stem is that (Song B's: 70 %, 58 s).
  - `done` has `bpm`, `heardBpm` (both quarters a minute, to the hundredth),
    `steady`, `share`, `residualMs` (the 95th percentile of the beats' distance
    from the tempo, on-grid beats for a steady song), `beatsPerBar`,
    `heardBeatsPerBar`, `barOne` (the first bar line at or after the
    start, in seconds), `seconds` (the recording's length) and `took`.
- **`detect_tempo`** (separate.rs) takes the open score and the name its
  `% Audio:` line gives, which must be an audio file beside it and already
  in the asset scope (`attach_stem` puts it there when the track is
  attached), and the score's meter: `{bpm, beatsPerBar, beat}`. It runs the
  subcommand through crates/separate's `Transcriber`, whose one `Job` it
  shares with `transcribe_stem`, so lily-transcribe and its models run once
  at a time (`tempo_args`, `Transcriber::detect_tempo`). Its events reach the
  page as `transcription` events. It writes nothing. The web stub and the
  worker refuse it with the other separation commands. Under the smoke test a
  stand-in answers Song A's values without running lily-transcribe.
- **The page** (`tempo.ts`). The score's meter is the MIDI file's first time
  signature (a compound one, 6/8, 9/8, 12/8, counts dotted beats), 4/4
  without one. Its tempo is the one bar 1 is played at, which chooses the
  level; `% BPM:` stays D155's first tempo, as `atTempo` scales by it, so the
  tempo found is written as found × first ÷ bar 1's. The two differ only when
  a pickup has a tempo of its own, as D113's `\tempo 64 = …`: Song B's
  transcribed `piano.ly`, whose pickup is at ♩ = 118.13 and bar 1 at 88,
  gets `% BPM: 118.4`, which plays bar 1 at 88.2 (88.2 as such would have
  played it at 65.7). The offset is *S* − `barOne` (§5): *S* is when the score's
  bar 1 sounds at the new tempo, the playback map's bar 1 through
  `momentTime` on `atTempo(midi, bpm)` (`barTime`); lilypond's bar 1 begins
  where a `\partial` pickup ends, so *S* is 0 without one and the pickup's
  length with one. Both are rounded with `hundredths`.
- **Why.** Every click-track song keeps with one `% BPM:` and an offset, as
  long as the tempo keeps its hundredths (§4); typed by hand, they were 0.24
  BPM and 75 ms off on Song A. Beat This and `grid.fit_steady` were
  already in lily-transcribe and tested. The score's tempo and meter are a
  better prior than any tracker's: they cure the octave errors that a
  quarter of songs show (§2.2) and the downbeats' meter in breakdowns.
- **Not done.** The bar map, `% Audio bars:`, for a song that drifts (§4,
  step 2): until it, a drifting song is warned of and gets one tempo. Bar 1
  matched past an intro by chroma (§3.4): the recording's first bar line is
  taken as the score's bar 1, so a recording with an intro the score leaves
  out needs *Starts at* by hand; a free-time intro has no bar line. The Rust
  `beat-this` crate, which would need neither uv nor
  `packages/transcribe`. The web, which has no audio track (D155). Stems
  beside a karaoke file are not used for a cleaner beat (§3.3). A score's
  later tempo changes stay in proportion, as `atTempo` keeps them; a written
  ritardando the recording does not play is the bar map's.
- **Verified.** `uv run pytest` in packages/transcribe (`test_tempo.py`,
  `test_cli.py`): a click track at 113.76 found to 0.01 and bar 1 to 10 ms;
  no whole-number snap where `grid.fit` snaps (123.04); a lead-in of half a
  bar; the level for a track heard at ×2 and ×½, and 120 without a score
  tempo; 6/8 heard in dotted quarters and in quarters (×⅔), written in
  quarters; `--beats-per-bar` over a vote a breakdown wins; 3/4; a drifting
  take, not steady, its bar 1 at its first beat; too few beats and beats with
  no tempo are errors; the CLI's `tempo` events with Beat This replaced,
  the recording alone not mixed with its sibling, the cache (another level
  from it, a changed file heard again), compound meter, and error events.
  crates/separate: the arguments (refused when relative, missing, a folder,
  or a number not positive), the events and answer, failures, and a tempo
  refused while a transcription runs. `tempo.test.ts`: the time signature
  read past a text event and running status, the meter (6/8, 12/8, 2/2,
  none), bar 1 with and without a pickup, the tempo at bar 1, the lines
  (−0.32; 0.21 after a quarter pickup; 118.4 for a pickup at a tempo of its
  own), defaults taken out, and both lines one edit whose inverse
  gives back the text exactly, added, changed or taken out, CRLF kept; the
  status line. `player.test.ts`: the button beside the tempo only with a
  recording and `detectTempo`, *Listening…*, the meter asked, one
  `setScoreLines` with both lines, the pickup's offset, defaults, and a
  failure writing nothing. `npm run test:smoke`: the button hidden without
  `% Audio:` and shown with it, the stand-in's answer written to the editor
  as `% BPM: 113.76` (changed) and `% Audio offset: -0.32` (added), one ⌘Z
  giving back the text as it was and the editor clean, the file untouched.
  On the test songs with the CLI (the development Mac, 3.5 and 2.1 s the first
  time, 0.02 s from the cache): Song A's instrumental ♩ 113.76,
  bar 1 at 0.322 s, 99 % on one tempo, 95th percentile 19 ms, so −0.32 for
  the score, which has no pickup (expected −0.33 ± 0.02); at a score tempo
  of 57 and 228 it gave 56.88 and 227.53. Song B's mix ♩ 88.20, bar 1 at
  0.127 s, 95 %. Song B's vocals stem: the error. Through the page's
  code (lily-outcome's compile and map, `tempo.ts`, `withScoreLines`) on
  scratch copies: Song A's score asks at ♩ 114 in 4/4 and gets
  `% BPM: 113.76` and `% Audio offset: -0.32` in place of its −0.25;
  Song B's `piano.ly` against the mix asks at ♩ 88 and gets
  `% BPM: 118.4` and no offset, its pickup already 0.127 s long. Song A warped
  as §3.2: not steady, ♩ 113.56, one tempo within 0.62 s, bar 1 at 0.30 s.
  Not heard in the app: the button was not pressed on a real song in Lily
  Studio, and the detected values were not heard against the recording.

## D160 — Karaoke's words stay where they appeared

**Status:** proposed (the operator's request of 2026-11-03) · **Refines:**
D133, D147, D157

- **Why.** The line being sung moved up and down as the other row's phrase
  came and went: by D157 the two rows moved apart when a wrapped phrase
  would touch the other, and were then kept inside their section by how
  high the phrases shown were, so the line sung jumped whenever the next
  phrase was one line taller or shorter. A singer reads ahead and comes
  back to the line; it must be where it was.
- **What.** A section's two rows are placed once for the section and the
  frame's size (`rowCentres`): at a third and two thirds of the words'
  area, each as high as the section's tallest phrase at the least size, moved
  apart and kept inside the section as D157 has it, but never by the
  phrases shown at the moment. A phrase is drawn centred on its row, at
  its own size, from when it is shown until it is sung. Only a resize, a
  change of the least size or of the tracks shown moves the rows.
- **Below, a phrase keeps its row** (`sectionRows`). By D147 a third line's
  phrase took a row its line left empty, and the row's own line, coming
  back, took the row from it: the phrase moved to the other row, or went
  away while it was sung. Now each phrase is given a row once, ahead of
  the song: the first line's the top one, the second's the bottom one, a
  further line's whichever is free, the other row when its own is held,
  and if both are held it is shown later, when one is let go. Two lines
  below, or one, are shown as before.
- **The cost.** One tall phrase spaces every row of its section apart as
  far as it needs, though most phrases are one line; in a small pane the
  rows may stand further apart than the phrases shown need, and a phrase
  too tall for its section can still spill over (D157).
- **Verified.** `karaoke.test.ts`: frames drawn through a recording 2D
  context at 200 × 220 with a least size of 24 px, where a four-line
  phrase comes in on the top row while the bottom row's is sung, and that
  one's line is at the same height before and after (it moved with the old
  code); a third line's phrase keeps the top row while the first line's
  next phrase waits for the bottom one (it was pushed off before). Not
  looked at in the app while playing.

## D161 — Lily Studio hands a score to GarageBand as a MIDI file and its recordings, and writes no `.band`

**Status:** superseded by D162 (was proposed, research, 2026-11-03; nothing
built) · **Refines:** D54, D155 · **Evidence:**
`docs/research/garageband/README.md` §4–§8

- **What.** *File › Export for GarageBand…* writes a folder,
  `<score> (GarageBand)/`, holding:
  - `<score>.mid`: lilypond's MIDI with each part's name and a program
    change on every track, its tempos at `% BPM:`, a lead-in of a bar less
    the pickup, and no words' tracks or control-track text. Muted parts are
    left out, behind D54's checkbox;
  - a WAV of the `% Audio:` recording and of the song's files that the score
    names (`% Backing:`, `% Music:`, `% Stem:`), each padded or cut so its
    sample 0 is the MIDI's tick 0;
  - `Read me.txt`: open the MIDI file, drop every WAV at once at bar 1, and
    what does not arrive.

  The Mac app then opens the MIDI file in GarageBand
  (`com.apple.garageband10`). The web downloads the `.mid` alone. The
  studio never writes or patches a `.band`. GarageBand makes the project,
  and the user saves it.
- **Why.** Measured in GarageBand 10.4.14 (README §4): this route brings
  every part as a track in order, with its name on its region and its
  program as a patch. It also brings the tempo map to the hundredth, the
  meter, the key and bar 1, and the audio in time across tempo changes. A
  `.band` writer needs records whose links are opaque. A patched `.band` can
  only change values in a project of fixed shape, ships bytes Apple wrote,
  and crashes GarageBand or corrupts the project silently on a mistake,
  since GarageBand checks nothing (§5.4). The format also changed between
  10.2 and 10.4 (§2.7). MIDI and WAV avoid all of it.
- **Not done.**
  - CC 7 and CC 10 are left out: GarageBand takes them as region events,
    not as track settings, and they may override the user's faders
    (untried). The mix is lost.
  - The track headers show the patch, not the part's name.
  - The words and the title are lost.
  - Saving the project as `<score>.band` through Apple Events (§8 stage 4)
    waits until users ask: it needs an entitlement and the user's consent.
  - Renaming the channel strips in a saved `.band` waits until how a track
    points to its strip is known.
  - Export MIDI stays lilypond's bytes (D54).
- **Consequences.** Four stages (README §8): the rewriter in
  `crates/session/src/midi_export.rs` for both builds, the folder and its
  WAVs on the Mac, opening in GarageBand, and the optional save. Each stage
  is checked by hand in GarageBand, since no test can run it.
  `spike/make_import_bundle.py` repeats §4 on a new major version.

## D162 — GarageBand gets a MIDI file and its recordings first; later the studio edits the `.band` GarageBand saved

**Status:** accepted (the operator's request to build it, 2026-11-04; stage
1 built in both builds, stages 2 and 3 in the Mac app, and their export
checked in GarageBand 10.4.14 from its save, the drop and listening left to
the operator; stages 4 and 5 not started; D163 refines stage 1, D164 stage
2, D165 stage 3 and records the check) ·
**Supersedes:** D161 · **Refines:** D54, D155 · **Evidence:**
`docs/research/garageband/README.md` §4–§13

- **What.**
  - **Stages 1 to 4 are D161's, unchanged.** *File › Export for
    GarageBand…* writes `<score> (GarageBand)/` with the rewritten
    `<score>.mid`, the WAVs aligned to its tick 0 and `Read me.txt`. The
    Mac app opens the MIDI file in GarageBand, and, if users ask, has
    GarageBand save `<score>.band` beside the score through Apple Events.
    The web downloads the `.mid` alone.
  - **Stage 5, later: the studio edits that `.band`** on the Mac. It names
    each track header for its part, then adds each WAV as an audio track,
    so the user no longer drops the stems by hand. It edits only the save
    the user's own GarageBand wrote, and ships no project of Apple's. It
    refuses a format it was not tested on (`0x09d0`, header form 2), or a
    project whose links do not check before and after the edit, and then
    leaves GarageBand's save as it was. The code is a `band` module in
    `crates/session`, ported from the research's MIT spikes
    (`patch_band_template.py`, `inspect_band.py --links`,
    `build_band.py`). Other code comes in only if it is MIT or Apache-2.0,
    with its notice; GPL code is read, never copied.
  - **The studio never writes a `.band` from nothing**, nor a `.logicx`.
- **Why.** D161 ruled out a writer because the links between records were
  opaque. README §11 decoded them on 31 projects, and §13 built a
  14-track project from a 2-track one that GarageBand 10.4.14 opened,
  played and saved whole (measured). What still stands against a whole
  writer: GarageBand opens only `ProjectData` it wrote, and refuses
  LogicProFormatWriter's and Logic's own (§12), so any writer starts from
  a GarageBand save, which shipped in the app is Apple's bytes. A new
  track's instrument is copied with its strip, since the plug-in state is
  opaque (§13.5), while the MIDI import gives each part its own patch.
  GarageBand checks nothing, so a mistake crashes it or corrupts the
  project (§5.4). Editing the user's own save keeps the MIDI import's
  sounds, ships nothing of Apple's, and adds only what the MIDI route
  loses: the header names and the placed stems.
- **Not done.**
  - Stage 5 waits for users to ask and for a spike on stage 4's own save
    (README §8): an audio track added to a project that holds none, which
    §13 did not try. If GarageBand refuses it, stage 5 names the headers
    only.
  - A `.band` written whole waits until a track's instrument can be
    chosen (the plug-in state decoded) and a base can be had without
    shipping Apple's bytes.
  - The mix (volume, pan, mute) waits until its fields are read in
    GarageBand's files.
  - CC 7 and CC 10, the words and the title stay lost, and Export MIDI
    stays lilypond's bytes, as in D161.
- **Consequences.** Five stages (README §8), each checked by hand in
  GarageBand. Stage 5's tests that need a GarageBand save read it from a
  path in the environment and skip without it, since a save is Apple's
  bytes and is not committed. Each new GarageBand version gets §13.1's
  open–save–close loop, the read-back with `inspect_band.py --links` and a
  look in `~/Library/Logs/DiagnosticReports/` before stage 5's gate admits
  its format. `spike/make_import_bundle.py` repeats §4 for stages 1 to 4.

## D163 — Export for GarageBand leaves out a staff that plays nothing, as it does the words' tracks

**Status:** accepted (stage 1 of D162, 2026-11-04) · **Refines:** D162

- **What.** Stage 1 of D162 as built. The renderer's `garageBandPlan`
  (`src/renderer/garageBandPlan.ts`) drops every track after the first that
  has no notes: the words' tracks, which D162 drops, and also a staff that
  plays nothing. Each kept part gets its name from `partNames` and the
  Parts fold's program, else the first one written (the piano when none
  is); drums stay on 0, the kit the fold leaves them on.
- **D54's checkbox.** The plan keeps the muted parts. The Mac app's save
  panel (`export_garageband` in `src-tauri/src/commands.rs`) and the web's
  question (`exportQuestion` in `src/web/dialogs.ts`) ask as Export MIDI
  does, and `GarageBandPlan::without_parts` leaves the muted parts out once
  the answer is in. So both builds send the same plan, and the worker's
  `export_garageband` (`crates/server/src/worker/commands.rs`) shares the
  rewrite with the Mac app as `export_midi` shares `without_tracks`.
- **Why.** GarageBand makes the words' tracks, which have no notes, into
  empty piano tracks (README §4.3), and a staff that plays nothing has no
  notes to bring in either (untried). It is not a muted part, so the
  checkbox does not offer it.
- **Until stage 2,** the Mac app writes `<score>.mid` through a save panel,
  and the web downloads it as Export MIDI is downloaded (README §8).
- **Verified.** `midi_export.rs`'s tests against `make_import_bundle.py`'s
  fixture, `garageBandPlan.test.ts`, the smoke test, and
  `crates/server/tests/server.rs`, where the worker's export is the
  fixture's rewrite byte for byte, and with the muted Violin left out a
  track fewer. Not yet opened in GarageBand.

## D164 — Export for GarageBand asks for the folder to write `<score> (GarageBand)` in, and asks again before replacing it

**Status:** accepted (stage 2 of D162, 2026-11-04) · **Refines:** D162,
D163

- **What.** Stage 2 of D162 as built, in the Mac app. *File › Export for
  GarageBand…* (`export_garageband` in `src-tauri/src/commands.rs`) shows
  an open panel for folders, at the score's folder, titled *Export for
  GarageBand*, with D54's checkbox while some parts are muted. In the
  folder chosen it writes `<score> (GarageBand)/`, through
  `garageband_folder::write_folder` (`crates/session`): the rewritten
  `<score>.mid`, a WAV for each recording and `Read me.txt`. When that
  folder is there already, an alert asks *Replace* or *Cancel*, Cancel
  being the default; a folder that holds the score or its audio is never
  replaced. This replaces D163's save panel for `<score>.mid` on the Mac.
  The web still downloads the `.mid` alone.
- **What the renderer sends.** Beside the plan and the muted parts, the
  files the score's lines name beside it (`garageBandAudio` in
  `src/renderer/garageBandPlan.ts`): `% Audio:` with its `% Audio
  offset:` and whether the Parts fold mutes it, and `% Backing:`,
  `% Music:` and `% Stem:`, read from the editor's text, as the player
  reads them. The command refuses a name that is not a file beside the
  score. ffmpeg is `find_ffmpeg`'s, as Export Video's is.
- **What it says.** The status line names the folder, its WAVs, the
  muted parts left out, and each file left out with why: *Exported Song
  (GarageBand) with take.wav and Vocals.wav. Left out Song - drums.flac:
  ffmpeg is not installed (brew install ffmpeg).* The read-me lists them
  too.
- **Why.** The folder's name is the export's: GarageBand's tracks take
  the WAVs' names, and the read-me names the `.mid`. A save panel would
  let the user rename it and would ask about replacing on its own terms,
  which for a folder AppKit does not document. An open panel for the
  place, then our alert, asks once and says what replacing deletes: a
  project the user saved in the folder.
- **Verified.** The smoke test exports twice: without a recording (the
  folder holds `smoke.mid` and `Read me.txt`), then with `% Audio:
  smoke.wav`, replacing the folder without asking, as it answers no
  dialogs, and finding the WAV's 800 frames as they were (no pickup and
  no offset). `garageBandPlan.test.ts` tests what is sent and said. The
  panel and the alert were not seen by eye. Not yet opened in GarageBand.

## D165 — Export for GarageBand opens the `.mid` in GarageBand, else shows the folder; its export checked in GarageBand 10.4.14

**Status:** accepted (stage 3 of D162, 2026-11-04) · **Refines:** D162,
D163, D164 · **Evidence:** `docs/research/garageband/README.md` §8.1

- **What.** Stage 3 of D162 as built, in the Mac app, as D162 has it. Once
  `export_garageband` has written the folder, `show_garageband_export`
  (`src-tauri/src/opening.rs`) asks Launch Services for
  `com.apple.garageband10` (`NSWorkspace`'s
  `URLForApplicationWithBundleIdentifier:`). When GarageBand is found,
  `/usr/bin/open -b com.apple.garageband10` opens `<score>.mid` with it,
  as a new project. When it is not found, or `open` fails, the Finder
  shows the folder. No Apple Events are sent. The smoke test opens
  neither. `show_export` holds the choice, and a unit test covers it.
- **Checked in GarageBand** (README §8.1). §4.1's score was used, with its
  recording and two stems, a FLAC among them. The export was made by the
  studio's own code: `lily-outcome`'s compile, `garageBandPlan` and
  `write_folder`. Its `.mid` is the Rust fixture's rewrite event for event,
  but for one part's name. Its WAVs are the spike's aligned files frame for
  frame. `open -b` made a project of the six parts, which `save document 1
  in` saved and `close saving no` closed. `inspect_band.py` read the save
  as §4.3 read `Lean.mid`'s:
  - no control or words track;
  - each name on its region;
  - each program;
  - the tempos to the hundredth;
  - the meter, the key and the lead-in;
  - every link check held.
- **Found.**
  - The voice arrives as *V*, the name `partsOf` gives it from its track
    when the playback map has no staff for the words or the drums. The
    Parts fold shows the same name, so the export keeps it.
  - `inspect_band.py` took a one-letter name for none. It now reads an
    `MSeq`'s name where it is kept.
- **Not checked.** Screen capture and UI scripting are denied to the
  terminal, so these wait for the operator, with README §8.1's steps:
  - the WAVs dropped at bar 1 and the project listened to;
  - the panel, the alert, GarageBand opening and the Finder fallback, by
    eye;
  - a real recording in place of the synthesized one.

## D166 — Lily Studio imports Guitar Pro files (.gp3, .gp4, .gp5, .gpx) as a score with a Staff and a TabStaff

**Status:** accepted (the operator's request to build it, 2026-11-04; built:
stage 1, stage 2 in four parallel parts, and stage 3, the seven samples
compiled and looked at, 2026-11-04) · **Refines:** D42, D55 · **Evidence:**
`docs/research/guitar-pro/README.md`, `crates/guitarpro/tests/compile_samples.rs`

- **What.**
  - **File › Import Guitar Pro…** picks a `.gp3`, `.gp4`, `.gp5` or `.gpx`
    file, asks where to save a `.ly`, writes the score there and opens it.
  - **Each track by its kind** (README §5.1):
    - a guitar, bass or other fretted instrument becomes a `StaffGroup` of a
      `Staff` and a `TabStaff`. The TabStaff has the track's own tuning as
      `stringTunings`, and the Staff its clef, transposed an octave as
      guitars and basses are written;
    - drums become a `DrumStaff` in `\drummode`, from the General MIDI key
      of each note;
    - any other instrument becomes a `Staff` alone, its notes at the pitches
      the frets give. Guitar Pro stores a piano, voice or strings as frets
      on six strings, so the tab of such a track means nothing.

    A track is fretted when its General MIDI program is 24–39 (guitars and
    basses) or 104–107 (sitar, banjo, shamisen, koto), or its GPX
    instrument is a guitar, bass, banjo or ukulele. It is drums when GP's
    drum flag, channel 10 or GPX's `Percussion` table says so. Otherwise it
    is `Other`. The flags and the tuning cannot tell a piano from a guitar;
    the program can.
  - **A crate of its own**, `packages/studio/crates/guitarpro`
    (`lily-guitarpro`). Its `model` is the song as all the formats can say
    it, `gp345` reads GP3–GP5, `gpx` reads Guitar Pro 6's container and
    its `score.gpif`, and `lilypond` writes the score. `read(bytes,
    extension_hint)` tells the formats apart by their first bytes. It
    depends on neither Tauri nor the file system, and the session crate
    calls it, so the Mac app and the web server's workers (D55) import
    alike. Only its sample tests read files.
  - **The readers are ours** (MIT, as the studio). They are written from
    the research note and the samples' bytes. No code of TuxGuitar,
    PyGuitarPro, alphaTab or another LGPL, MPL or GPL project is copied or
    ported. MIT or Apache-2.0 crates, such as an XML parser for `score.gpif`,
    may be used as dependencies.
- **Why.**
  - Tabs are what guitarists have, and the studio already shows a score,
    plays it and puts it beside a recording. A Staff with its TabStaff
    keeps the fingering the tab gives, which a staff alone loses.
  - A crate of its own keeps the formats' code out of the session crate,
    lets its tests run alone with `cargo test`, and gives the readers and
    the writer one contract, the model. Each of them can be written in
    parallel against it.
  - Our own readers keep the studio MIT. The formats' libraries are LGPL
    (TuxGuitar, PyGuitarPro) or MPL (alphaTab), and none is in Rust.
- **Not imported in the first version.**
  - lyrics, which GP4 and GP5 attach to a track by bar;
  - RSE sounds, the mixer's effects and automations other than the tempo,
    page setup, and fingering numbers;
  - chord diagrams: chord names come in as text above the staff;
  - the tremolo bar, fade-in, rasgueado and wah. Bends come in as LilyPond's
    `\bendAfter` at their peak, and slides, hammers and harmonics as far as
    LilyPond's tab shows them;
  - drums from a `.gpx` until the table from GP6's drum elements to
    General MIDI is written and checked (README §3.8);
  - GP1, GP2 and GP7–GP8's `.gp` (a zip of a newer GPIF), which `sniff`
    refuses by name.
- **Stages.**
  1. **Foundation** (built): the crate with the model, `sniff` and `read`,
     stubs for the two readers and the writer, the research note and its
     spike (`spike/inspect_gp.py`), and the header test on the samples.
  2. **In parallel, against the model** (built): the GP3/4/5 reader (`gp345.rs`),
     the GPX reader (`gpx.rs`), the LilyPond writer (`lilypond.rs`), and the
     studio's wiring: the menu item, the dialogs, the command in the session
     crate and in the web's worker.
  3. **Integration on the samples** (built): each of README §1's seven
     files is imported, compiled by lilypond without errors or warnings,
     and looked at by eye; the web studio's import driven in a browser.
- **How the GP3/4/5 reader reads** (`gp345.rs`).
  - One text encoding is guessed for the whole file from all its strings:
    UTF-8 when every string with a byte ≥ 0x80 is valid UTF-8, else
    Windows-1251 or Windows-1252 by the neighbours of the high bytes: two
    high letters side by side count for 1251, one beside an ASCII letter
    for 1252 (`gp345/text.rs`).
    `gp5-b.gp5` is Windows-1251.
  - GP5 gives a stroke's up speed first and its down speed second, the
    reverse of GP3 and GP4 (README §2.15, from the samples).
  - Volume and pan, 0–16 in the file, become MIDI's 0–127 as value × 8,
    capped at 127.
  - A repeat's end is clamped to at least 2 plays, whatever the file stores.
  - A line of words attached to track 0, which means none, is dropped.
  - Of GP5's slide bits, the lowest set wins: the model keeps one slide.
  - A GP4 tapped harmonic, which stores no fret, is at the fret + 12.
  - GP3's tremolo bar, a single value, is modelled as a dip to it and back.
  - A bar shorter than its time signature is allowed (`gp3-b.gp3`'s bass ends
    on a quarter note); the writer pads it.
- **How the GPX reader reads** (`gpx/`).
  - A drum track's notes become rests of the same length, until a table
    from GP6's `Element`/`Variation` pairs to General MIDI keys is written.
  - A track that is not drums and gives no tuning gets a standard guitar's.
  - Volume and pan are the RSE channel strip's 12th and 13th parameters, an
    inference from the sample, not a documented fact.
  - A repeat may end without a start (`gpx-a.gpx`'s bar 15). The reader keeps
    it so, and the writer's plan plays it from the bar after the last
    repeat's end, or the song's start, as Guitar Pro does.
  - Notes, beats and rhythms are shared by id across tracks, so each is
    copied where it is used, and a note's string is converted from GPX's
    count (from the lowest) to the model's with the track's string count.
  - A container whose decompressed image is above 64 MiB is refused, and so
    is a file whose sharing would copy more than 2 million beats and notes.
- **How the writer writes** (`lilypond.rs`, `lilypond/`).
  - Variable names are camelCase ASCII, Cyrillic transliterated and
    numbers spelt as words (`Acoustic 01` is `acousticOne`); a name taken
    already gets B, C… (`fx`, `fxB`). One variable a voice that has notes
    (`leadVoiceOne`, `leadVoiceTwo`).
  - The TabStaff is tuned to the tuning plus the capo, so it shows Guitar
    Pro's frets, and the capo is named under the instrument name.
  - A fretted track's clef is `bass_8` when its highest string is below G3,
    else `treble_8`.
  - Repeats are written as `\repeat volta` and `\alternative` only when
    unfolding them gives Guitar Pro's playing order; when the marks
    contradict it, the bars are written out in that order, numbered as
    Guitar Pro numbers them, with a comment saying so.
  - A score with repeats has a second `\score` with `\unfoldRepeats` for
    the MIDI (D145). The TabStaff's `Staff_performer` is removed in the
    `\midi`, so each note sounds once.
  - The tempo, section names, segni, codas and jumps go in the first
    track's first voice only.
  - A voice shorter than its bar is padded, one longer is cut at the bar's
    end with a comment; a drum track of rests is written as `R` bars.
  - Bends are `\bendAfter` at their peak, written as a LilyPond number
    (`\bendAfter 3`): Guile reads `#+3\mp` as one symbol.
  - P.M. and let ring are text, once at the start of each run of notes
    that have them; a chord name is printed where it changes; a ghost
    note's softer dynamic is left to its parentheses.
  - The header holds the title, subtitle, artist and album (under the
    title), the composer (the music field, else the artist), the words when
    they are someone else's, `Tab: <transcriber>` and the copyright; the
    instructions and notices are comments above it.
  - Left out: lyrics, the tremolo bar, fade-in, rasgueado and chord
    diagrams. D.C. and D.S. are printed but not played.
- **What the studio does** (`crates/session/src/guitar_pro.rs`, the app's
  `import_guitar_pro`, the web's worker).
  - **File › Import Guitar Pro…** heads the group of the exports in the
    Mac app (after Save All, before Export MIDI…), as a file of another
    program, and follows Upload Scores… on the web. The welcome screen has
    an Import Guitar Pro… button after Open Folder….
  - The file is converted before the save panel opens, so a file that
    cannot be imported is refused without asking where to save it.
  - A drop on the window imports the first Guitar Pro file among the
    dropped ones. A `.gp` (GP7, GP8) or `.gtp` (GP1, GP2) is taken from a
    drop only to be refused with the reason.
  - A name chosen without a score extension gets `.ly` appended (`Song
    v1.2` becomes `Song v1.2.ly`).
  - A file is at most 32 MB in the app and 2 MB on the web, the worker's
    upload limit.
  - A refusal names the file and says why: `<file> is not a Guitar Pro
    file; Lily Studio imports .gp3, .gp4, .gp5 and .gpx.`, `<file> is a
    Guitar Pro 7 or 8 file (.gp); …`, `<file> could not be read: <the
    reader's reason>`, `<file> is too large for a Guitar Pro file (32 MB at
    most).`
- **What integration changed** (stage 3).
  - `\bendAfter` takes a LilyPond number; three samples failed to compile.
  - A score whose first system is too tall for an A4 page (about 10 staff
    spaces a staff, 160 on the page at size 20, a TabStaff 1.5 staves) is
    set at `300 / height` points, never below 11, and after the first system
    a staff shows only where its track plays (`\RemoveEmptyStaves`).
    `gp5-a.gp5`'s 17 staves are set at 14.
  - An instrument name longer than 12 characters is split in two lines at
    the space nearest its middle (`Distortion` / `Guitar`), or it ran past
    the page's left edge.
  - Chord names once where they change, and ghost notes out of the
    dynamics: the GPX printed `A7` on every beat, `gp5-b.gp5` `mf f mf f`.
  - The GPX sample test no longer expects `gp3-a.gp3`'s key to be
    the GPX's: that file leaves the key at C (0) for a song in F.
- **Consequences.**
  - The samples are copyrighted songs and are never committed. Tests read
    them from `GUITAR_PRO_SAMPLES` (unset, none is found) and
    skip what they cannot find, so a run that skipped them has not checked a
    reader. `compile_samples` compiles the seven with lilypond and fails on
    any error or warning; `GUITAR_PRO_OUT` keeps the scores, outside the
    repository.
  - Text in GP3–GP5 has no declared encoding; the reader guesses between
    UTF-8, Windows-1251 and Windows-1252 (README §2.1).
  - What a reader meets that §2 or §3 marks [described] is checked against
    the next file that has it, and the note is updated.
  - The playback map (D26) sees each note twice, from the Staff and the
    TabStaff, with one href, which is drawn twice. Outside a repeat the two
    are paired (D118) and both light; inside a repeat unfolded in the MIDI
    only, D120 takes one place, so the notehead lights and the fret does
    not. Nothing doubles or drifts.
  - A DrumStaff gets no entry in the map's staves, which `timing.ly` lists
    from `Staff` contexts only, while it makes a MIDI track. So every
    import with drums has one stave fewer than tracks, and the Parts panel
    names the parts by their General MIDI instruments, not the tracks.
    Fixing it is a change to `timing.ly`'s playback map, engine work of its
    own (D144), not done here.
  - Notes are spelt from the key alone: `gpx-a.gpx`'s C♯ in F is written D♭.
## D167 — The audio track is kept to the music as heard, and sent ahead by what a seek takes

**Status:** accepted (the operator's report of 2026-11-04) · **Refines:**
D51, D135, D155, D158

- **The fault.** After a while the audio track played with hiccups, evenly,
  every couple of bars. The system log of the operator's session (19:30 and
  22:19 on 2026-11-04, on the THR10II amp over Bluetooth) shows a seek of the
  `<audio>` every 2.1 s, each from 0.32–0.34 s behind the music to where it
  was: `follow()` putting back a drift past `DRIFT`, every `SETTLE_MS`, for
  good. Each seek is a gap in the recording.
- **Why.** AVFoundation's `currentTime` is the recording as heard, not as
  sent: after a seek or a `play()` it holds until the first sample is out,
  the device's latency and some 0.1 s more. Measured with `AVPlayer` on this
  Mac, muted, each output named by its UID: 0.375–0.39 s on the amp, whose
  latency is 11664 frames (0.264 s), 0.10–0.12 s on the built-in speakers,
  0.11–0.135 s on the US-2x2. The track was kept to `scheduled`, the music's
  place on its audio clock, which is the output's latency ahead of what is
  heard (D51). A seek sent it to `scheduled`, where it was heard a hold later,
  so it landed the hold behind: 0.1 s on a wired output, inside `DRIFT`;
  0.33 s on Bluetooth, outside it, so every correction made the next.
  "After a while" is the first drift past `DRIFT`, which starts the loop.
  D135's reason for `scheduled`, that measured against what is heard the
  Stem strip was put back ten times a second on Bluetooth headphones, was this hold too:
  a recording sent to where the music is heard, with 0.12 s allowed, landed
  0.16 s and more behind it, every time.
- **What.** `AudioTrack.follow()` takes the music's place and its `latency`.
  It keeps the recording to the music as heard, the place less the latency,
  and sends it that far ahead, by the latency and `pipeline`: what a seek or
  a `play()` takes beyond it, learned from each one, a second after it, by how
  far the recording is then heard from the music. At first it is 0, so
  the first ▶ is heard some 0.1 s late; every later seek is heard where the
  music is. A recording with a later start is started that far early.
- **The lead-in.** midi.js waits 0.06 s after a `play()` or a seek before
  its first sample, and `scheduled` waits with it; a recording sent then
  moves at once. `Player.clock` is `scheduled` counting up through the
  lead-in to the music's start, and the track is kept to it.
- **Not done.** The Stem strip's backing track (D135) is still kept to
  `scheduled`, and put back the same way, so on Bluetooth it can meet the
  same loop. WebKit's own lag of its audio context (D151) is not seen by
  JS and not counted.
- **Verified.** `audioTrack.test.ts`, on a fake `<audio>` that holds its time
  0.38 s after each seek or `play()` and a context with 0.264 s of output
  latency: 20 s after a 0.4 s stall the recording was put back once and is
  heard within 0.03 s of the music; a seek of the transport, after the first
  ▶ taught it the hold, is heard within 0.03 s; a later start is sent once.
  Against the old `audioTrack.ts` the three fail. The earlier tests' places
  sent during a lead-in are 0.06 s earlier. Not yet heard in the app.

## D168 — Karaoke's staff measures its glyphs from the baseline it draws them on, and leaves room for its clef and signature

**Status:** accepted (the operator's report of 2026-11-06) · **Refines:** D156

- **The fault.** In an exported video of a score with two singers, the
  second singer's treble clef stood two spaces too high, its top cut off by
  the lane, and the signature's G♯ was cut too; the first singer's bass clef
  was right.
- **Why.** `glyph()` measures a symbol's ink once and keeps it, but measured
  it before setting `textBaseline` and `textAlign`, and a canvas measures
  `actualBoundingBox*` from the baseline and alignment set. The words of the
  first section leave the baseline at `middle`, so the 𝄞, first measured in
  the second section's lane, was kept with its ascent short by some 35 % of
  its size, and every frame after drew it that much higher. The lane's room
  above the staff was also a space and a half past the notes' range, while
  treble's G♯ reaches 1.8 spaces over its top line and its clef 1.4: with
  notes under the staff, the G♯ was cut and the clef touched the edge.
- **What.** `glyph()` sets the alphabetic baseline and left alignment before
  it measures. `drawStaff` fits the staff to the notes' range a space and a
  half each way as before, or to what its clef, signature and bar numbers
  reach (`HEADER`: treble 4.2 steps over its top line and 3.6 under its
  bottom, bass 3 and 2.4) when that is more.
- **Verified.** `staff.test.ts`: a treble lane in B major over notes under the
  staff, at a video's 123 px, drawn on a context that measures from the
  baseline set and left at `middle`: the clef's and sharps' ink is inside the
  lane; against the old `staff.ts` the clef's ink starts 43 px above it.
  Drawn in the system WKWebView with the same lane and baseline: the old code
  gives the video's clipped clef, the new a clef on its lines and the sharps
  clear of the edge.

## D169 — Lily is for personal use, so a model it downloads may be non-commercial

**Status:** accepted (the operator's statement of 2026-11-06) · **Refines:**
D113 · **Research:** `docs/research/vocal-alignment/`

- **The fact.** Lily Studio and the extension are for personal,
  non-commercial use. They are given away as is: no payment, no support, no
  advertising. D113 and the research notes (audio-transcription,
  audio-tempo) assumed that "Lily is MIT and could be sold", and on that
  ground alone they left out weights for non-commercial use: madmom's models,
  MuScriptor's, Essentia's TempoCNN.
- **What is allowed now.** The apps may run a model whose weights are
  CC BY-NC or CC BY-NC-SA, on four conditions:
  - The weights are **downloaded on first use** from their own source, as
    karaoke-mlx's models and Whisper are. They are never committed to the
    repository, put into the app bundle or the VSIX, or served from
    lily.everyday.fail.
  - The package that runs them names the model, its licence and its authors
    where it lists its dependencies (its README), so the terms travel with it.
  - The weights are used as published. Fine-tuning them makes an adaptation,
    which ShareAlike would bind; that needs a decision of its own.
  - The **code stays MIT**. Nothing is copied into the source from code or
    text under a non-commercial licence: D2's rule for the CC BY-NC grammar
    and VSLilyPond stands, because the MIT source may be reused by anyone,
    for anything.
- **Still not allowed.** Weights with no licence at all (all rights reserved,
  however freely shared), terms of "research use only", which are narrower
  than personal use, and GPL or AGPL code linked into an app (D56's boundary
  is unchanged).
- **Consequences.** The non-commercial models are back among the candidates
  on licence: MMS_FA for aligning sung words (the best of
  vocal-alignment's spike), GAME and SOME for sung notes, MuScriptor for a
  mix, madmom's models for beats. Each must still win on quality and
  maintenance; madmom, for one, does not install on Python ≥ 3.10.
- **If Lily is ever sold or carries advertising,** every model taken under
  this decision must be replaced first. That is why each is named in its
  package's README.

## D170 — The gateway keeps the engine's hashed files a year and asks again for the rest; the host asks to persist after use; the worker runs the debug core when asked

**Status:** accepted (MS7 step 5, K5; 2026-11-02) · **Refines:** D55, D56, chapter 08 §1.3, §5.1, §5.4 ·
**Changes:** `packages/studio/crates/server/src/gateway.rs`, `packages/studio/src/web/engine/{host,driver,worker,protocol,modules}.ts`,
`packages/studio/esbuild.mjs`

- **What.**
  - **D55's gateway sends `Cache-Control`** under `/engine/`: `public, max-age=31536000, immutable` for a file whose name carries
    its 12 hex digits of SHA-256 (`esbuild.mjs --site`), `no-cache` for the manifest and the licences, which keep their names; a
    miss (404) gets none. Nothing else of the site changes. **And it sends a file's `.br` as it is** to a browser that takes
    brotli, under `/engine/` only, where the engine's build writes each `.br` with the file its hash names; elsewhere a `.br`
    may be older than its file (a stale `dist/site/engine.worker.js.br` of 2026-10-18 was).
  - **`EngineHost` asks the browser to keep the engine's files** (`navigator.storage.persist()`) once, after the engine's first
    finished compile, and not where `persisted()` says the origin is kept: never on a visit that did not use it (08 §5.4).
  - **The debug core** (D262): the manifest's `core.debug`; `EngineHost.start(…, debug)` starts `engine.worker.js?debug`, whose
    driver runs it instead of `core.wasm`, gives it `env.lily_panic`, and reports a trap with the panic's message. It is not
    split, so the driver fetches no split module into it. The page's `?engine=debug` is K6's (MS7 step 6).
  - **`EngineManifest`** gains `core.debug`, `source` (the repository, the commit, `dirty`) and `licenses` (by what they cover);
    `manifestFiles` keeps the debug core in the cache; `esbuild.mjs --site` hashes it and copies the licences under their names.
- **Why.** 08 §5.1's second layer: a browser that keeps no Cache Storage, or one that evicted it, still downloads the core once.
  Without the `.br`, the gateway sent `core.wasm` raw, 2.97 MB where B1 counts 944 KB. `persist()` after use is §5.4's rule.
- **Checked** (progress.md, *MS7 · step 5*): 08 §5.3's visit in Chromium through the gateway behind a counting proxy: the first
  visit fetches what B1 counts, 1,545,900 bytes brotli, each `immutable`; a reload, and a visit with Cache Storage deleted, fetch
  only the manifest (304); with `engine/` answering 503 the compile runs from the cache; `?debug` fetches the debug core once.
  The server's test `the_engine_s_files_are_cached_by_their_names`; the host's and driver's in `test/engine.test.ts`.
- **Not done.** WebKit's second visit (08 §5.3: its test build kept no Cache Storage) and Safari on the iPhone: MS7 step 10.

## D171 — With `?engine=1` the page compiles live edits by the engine; the server's live switch goes off, its texts forgotten first; its other compiles give way while texts are unsaved

**Status:** accepted (MS7 step 6, K6's live half; 2026-11-02) · **Refines:** D36, D55, D56, D170, chapter 08 §7 items 3–4,
chapter 05 §7.2 · **Changes:** `packages/studio/src/web/{live,transport,menubar}.ts`, `packages/studio/src/web/engine/{engine,host,driver,protocol}.ts`,
`packages/studio/src/renderer/{bridge,index}.ts`, `packages/studio/esbuild.mjs`, `packages/studio/renderer/index.html`

- **What.**
  - **`engine.js`** (`src/web/engine/engine.ts`), bundled by `esbuild.mjs --site` and loaded before `app.js` by the site's copy
    of `index.html` (both deferred, so in that order; the app's `dist/web/` page is unchanged), starts `EngineHost` for
    `?engine=1`, or for `?engine=debug` with the debug core (D170), and leaves it as `window.lilyEngine`. The engine's reads wait
    until the transport, in `app.js`, attaches the page. Without either query nothing starts and the page is D55's.
  - **The web transport** (`live.ts`' `EngineLive`) compiles D36's live edits in the page while the engine runs: on `edited`, the
    score (a `.ly` file is its own; any other file is part of the score shown, as `show_score` answered), with every unsaved
    text as UTF-8 and the page the preview shows (05 §7.2: the first page whose bottom is past the pane's middle). Edits of one
    task are one compile; a newer one supersedes (B8). The outcome goes to the renderer as a compile event, `started` and
    `finished`, as the socket's would, its MIDI as base64; a superseded compile says nothing. **A page's cells** (W8) go as a
    new event, `cells` with the score's name, which only the web sends; the renderer gives them to `ScorePreview.replaceCells`
    for the score shown. Files the engine reads come from the server's `download`, as bytes (D102), not `read_file` (08 §7 item 3), which
    answers text and watches the file for the editor; one it holds is read again
    after a save, a reload or another program's change (D34), as the engine keeps every file it was given.
  - **The server's live compiles go off with `set_live`** once the engine has started; **the server forgets the unsaved texts
    first** (`edited` with none), because its switch going off compiles the saved score (D36), whose outcome would replace the
    engine's page. Edits still go to the server, which keeps them as before. Should the engine stop (a `failed` message, or the
    worker's `error`, which the host now takes as failure), the texts are given back and the switch is the user's again, so the
    server takes the live compiles up. The user's own switch, while the engine runs, is the page's: off compiles the score
    shown as saved, on the unsaved texts, as the server did.
  - **The server's other compiles** (a save, D31; a score shown) read no unsaved text once its switch is off, so **while the
    engine has live preview and a text is unsaved, their events are not passed on**: the engine compiles that score instead.
    With nothing unsaved they pass, as the saved files are then what the engine would read. Export PDF and Export MIDI stay the
    server's (08 §7 item 4).
  - **`protocol.ts`:** `ready` carries `about`, the manifest's `source` and `licenses` (`EngineAbout`), which `driver.ts` posts
    and `host.ts` keeps; **Help** gains *Engine Source Code* (the repository at the manifest's commit) and *Engine Licenses*
    (`NOTICE.txt` beside the manifest) once the engine has started (D56). **`host.ts`:** the worker's `onerror` is a failure.
- **Why.** 08 §7's design, with what its text left open found in the building: the server's switch going off compiled the saved
  score over the engine's page (its test found the order), and its saves and `show_score` compiles, which read the unsaved texts
  only while its switch is on, would have done the same. The apps stay MIT and reach the engine only through `src/web/engine`
  (D56): `transport.ts` and `live.ts` import its types, `engine.js` holds the host.
- **Checked** (progress.md, *MS7 · step 6*): `test/web.test.ts`' live preview tests (the hand-over and its order, edits, includes,
  coalescing, re-reads, the switch, a refused and a stopped engine, the server's compiles giving way, cells, the page shown,
  the links); `test/engine.test.ts`' `about`, the worker's error and `engine.js`; the server's test
  `edits_compile_nothing_on_the_server_while_its_live_switch_is_off`, which fails without the texts forgotten first. The page
  driven through D55's server in Chromium and WebKit with `?engine=1`, `?engine=debug` and without.
- **Not done.** The fallback of every compile the engine fails or cannot do to the server, and the host's gaps (MS7 step 7). An
  include no `.ly` reaches but the score shown compiles that score. A file deleted keeps the copy the engine had; `download` gives only `.ly`, `.ily` and `.lyi` files, so an include of
  another kind reads as missing. The engine
  hands its pages over when the compile ends: the visible page first only in the order it lays them out (05 §7.2's item 3 is
  not built, `queue.rs`).

## D172 — What the engine cannot do goes to the server for that revision; offline the page goes on; a file gone is none

**Status:** accepted (MS7 step 7, K6's second half; 2026-11-02) · **Refines:** D36, D55, D171, D208, chapter 08 §7 item 5,
§4.5 · **Changes:** `packages/studio/src/web/{live,transport,connection,overlay}.ts`, `packages/studio/src/web/web.css`,
`packages/studio/src/web/engine/{host,driver,protocol,modules}.ts`, `packages/studio/esbuild.mjs`

- **What.**
  - **The fallback.** A compile the engine fails or cannot do goes to the server for that revision. `host.ts`' `cannotDo` says
    which: the compile did not run (`state: 'error'`: it trapped, or a module of its code could not be fetched), or it ended in
    one of the engine's own errors (`crates/core/src/diag.rs`: the memory cap, a font pack it could not fetch, a text face's
    outlines it could not fetch), or a file it asked for could not be read (the server refused it: `download` gives only `.ly`,
    `.ily` and `.lyi`). A score's own errors are the engine's to show. `live.ts` then gives the server the compile: with live
    preview on and texts unsaved, the texts (`edited`) and its switch on (`set_live`), so that it compiles what they belong to
    (D36, by `\include` chains); otherwise the score as saved (`show_score`). The engine's outcome is not shown; the server's
    events pass on, and once its compile of that score has finished it forgets the texts, then its switch goes off, as at the
    engine's start (D171). **The next edit is the engine's again:** before its compile is sent the turn ends the same way, so a
    late outcome of the server's is not shown over the engine's newer page.
  - **Offline the page goes on.** `connection.ts` says whether a call goes out now (`online`); `readBytes` fails at once
    without a connection, where a call would wait for one. A file the engine holds that cannot be read again keeps the copy the
    engine has, and is read once the connection is back; a compile the engine cannot do while offline shows the engine's
    outcome and goes to the server once it is back (`reconnected`, from `onHello`). **While the engine runs a lost connection
    does not cover the page:** the overlay is a notice at its top (`cover: false`, `role="status"`), *Offline: the preview goes
    on in this page; saving waits until the connection is back*, and calls wait in their queue as before (D55).
  - **A file gone is none to the engine** (`files[path] = null`, `CompileRequest.files` in `protocol.ts`), which `lily_put`
    already reads as no such file, where D171 kept the engine's copy.
  - **`driver.ts`** (I4): a pack or a part the engine asks for that cannot be fetched is put as none (`lily_put` with no data),
    so that the core's diagnostic (D208) says so and the compile goes on; only a split module of the core's code that cannot be
    fetched is a compile that did not run. A trigger's fetch that fails fetches nothing: the engine asks if it needs the module.
    LilyPond's own files (`<datadir>/…`) are the manifest's `file` modules (D263), or none; **the page is never asked for one**.
  - **`modules.ts`'s triggers** (C5, E22): the faces and sizes of a score's text and the outlines its skylines need, which the
    core asks for only once it meets them, each such ask a stop that pays the translation again (D262): the brace's four parts
    by their names (`braces` named no module), figures, fingerings and a volta's number in their Emmentaler sizes, a lyric's, a
    text script's, a tempo's, a dynamic text's, a clef modifier's, a tab's, an ottava's and a markup's faces and outlines,
    `articulate.ly`'s `display` part. Measured in `core.wasm` (`predict.mjs`).
  - **`esbuild.mjs --site`** writes `engine/fonts.css` from the manifest's `webFonts` (D263), with their hashed files, and the
    site's `index.html` links it, so that a page's `<text font-family="LilyPond Serif">` is drawn in the face the engine and
    LilyPond measured (E17); the server's pages name the same families. `font-src 'self'` in D55's CSP allows them.
- **Why.** 08 §7 item 5 and D257's fourth hard item: the web may be no worse than D55's, and the fallback is what makes a score
  the engine cannot do still compile. The engine's own errors are told by their text, which `web.test.ts` checks against
  `diag.rs`, rather than by a new output, so the core's ABI and `diagnostics.json` stay as they are (PROTOCOL §6.2). The
  server's live switch is the one path that compiles the unsaved texts with `\include` chains, so the fallback uses it, ended
  as D171 found it must be. Offline, a notice rather than a cover, as the engine needs nothing of the server to draw what is typed.
- **Checked** (progress.md, *MS7 · step 7*): `test/web.test.ts`' fallback tests (the texts and the switch, the turn's end, a
  newer edit taking it back, `cannotDo` and the core's texts, live preview off, a file that cannot be read, a file gone, offline
  and reconnected); `test/engine.test.ts`' (a split module unfetched, a pack or part put as none, LilyPond's files never asked
  of the page, given again to a new instance, a file gone, the triggers). Driven through D55's server in Chromium and WebKit:
  the engine refused (the manifest answering 503: the server compiles every edit), the fallback (`emmentaler-14` answering 503,
  a grace note typed: the server compiles it, the texts given and forgotten), offline (the server killed: the notice covers
  nothing, the engine shows what is typed, the page reconnects) and the web fonts.
- **Not done.** An include's edit still compiles the score shown (I8); the engine hands its pages over at the compile's end (I7).

## D173 — The engine's music after its pages: performed when wanted, posted as the same compile's outcome; Export MIDI waits for it and writes the Parts fold's instruments; the map only with its MIDI file

**Status:** accepted (MS7 step 8, M7; 2026-11-03; the operator's answer at this step, D264) · **Refines:** D24, D35, D45, D54,
D103, D222, D171, D172, chapter 07 §3.8 · **Changes:** `packages/studio/src/web/{live,transport}.ts`,
`packages/studio/src/web/engine/{driver,host,protocol,worker}.ts`, `packages/studio/src/ipc.ts`,
`packages/studio/src/renderer/{player,playbackSetup,bridge,index}.ts`

- **What.**
  - **The protocol.** The page sends `perform` (a revision) and the worker answers `performed` with a `Performance`: the MIDI
    files, the first's bytes, entry 0 of the map, and what the `\midi` translations said; none when a newer compile stopped it
    or there is nothing to perform. A compile's `finished` outcome holds its pages and says `performing: true`.
  - **`driver.ts`** runs a performance as a compile (`steps`, shared): in steps of `STEP_MS`, its needs answered, the request's
    files given again before `lily_perform` (an instance made since lacks them), a trap a `message`. Only the newest compile
    that finished has one; it is made once and given again if asked again. A newer compile stops it between steps.
  - **G1 (D222): `outcomeOf` and `performanceOf` give the map only with a MIDI file**, as `read_playback` does.
  - **`host.ts`'s `perform()`** asks for the newest compile's, once however often asked; a newer compile resolves it with
    none. `withPerformance` makes the page's outcome whole: the music, and the performers' messages after the page's, as
    LilyPond says them of a score (D264: the parse's are the page's alone; T03's bar check, said by both translations, twice).
  - **`live.ts`: when the music is wanted** (07 §3.8): once the page has been shown for `PERFORM_IDLE_MS` (500 ms) with no
    newer edit; at once while the music plays (the renderer says so, `Transport.playing`); and before Export MIDI
    (`Transport.music`, which resolves once the music is the renderer's). An edit before then performs nothing. The whole
    outcome goes to the renderer as a compile event, as the socket's would. A performance the engine cannot do (`message`, or
    `cannotDo`'s errors) gives the compile to the server (D172); offline, the page keeps the music it has.
  - **The renderer.** `playbackChange` keeps the music for a `performing` outcome of the same score, so the player plays on
    until the music comes; the music then loads, or plays on if its bytes are the same (D24). **Export MIDI** waits for the
    music (`ScorePlayerOptions.music`) and **writes the Parts fold's instruments** (`withPrograms`, D54's *not done*): a part's
    program changes say the program chosen, a channel of it that plays notes with none before is given one at its start (LilyPond
    writes none for a piano), drums keep their kit, every other byte as written; muted parts are left out as before. The app's
    Export MIDI writes them too: the renderer is the same.
  - **`worker.ts`** transfers a copy of a performance's bytes, as the driver keeps them to give again.
- **Why.** M7 and 07 §3.8: the page should not wait for the music, nor typing pay for it. The idle pause stands for "once at
  idle": a score's music is there by the time it is played, without performing every keystroke. Export MIDI must write the
  music of what is shown, so it waits. The instruments are what the user hears in the fold, which D54 left for want of an event
  rewrite; a program change is two bytes, so it is rewritten in place.
- **Checked** (progress.md, *MS7 · step 8*): `engine.test.ts` (the driver's performance in steps, once, stopped by a newer
  compile, of another revision none, its asks, a trap; the host's; `outcomeOf`'s and `performanceOf`'s map; `withPerformance`),
  `web.test.ts` (the pause, an edit before it, playing, Export MIDI's wait, the fallback), `player.test.ts`,
  `playbackSetup.test.ts` (`withPrograms` on a written file and on the extension's `sample.midi`), `engine-corpus.test.ts` (the
  real score of `player.test.ts` by `core.wasm`: the page keeps the music, then plays, every note a link, bar 2 two seconds in;
  the 30 and the cases performed, and `worker.test.mjs`' comparisons).
- **Not done.** The pause and the performance were not timed on a device (step 10's). While the music plays an edit's music
  reloads the player as D45 does, now a performance later than the page.

---

## D174 — The studio's preview inserts changed pages one per frame, the one in view first; the engine is the web's default only in a site built so, `?engine=0` and Help refusing it

**Status:** accepted (MS7 step 9; 2026-11-03; the operator's answers 1 and 4 at R8's split, and at this step: the default
waits for the source, OPEN I7 to R9) · **Refines:** D25, D32, D58, D171, D172, D56 · **Changes:**
`packages/studio/src/renderer/preview.ts`, `packages/common/web/preview.d.ts`, `packages/studio/src/web/engine/engine.ts`,
`packages/studio/src/web/{live,transport}.ts`, `packages/studio/esbuild.mjs`

- **What.**
  - **D58 in `ScorePreview`** (H2, OPEN I3, answer 1). `render()` keeps the reuse by a page's text (a page whose text is
    the one on screen at its place stays, as `replaceCells` may have left it). Of the changed pages it parses and inserts the
    one at the middle of the pane in the outcome's own task, and the others one per `requestAnimationFrame`, outwards from it,
    the page below before the one above (`insertionOrder`, which `preview.js` exports). Until its turn a changed page's old
    element stays; an added page is held by an empty `.preview-page` sized from its viewBox (`pageRatio`), so the scroll
    position holds. `shown` describes the elements on screen (none for a placeholder), so a newer compile reuses only what is
    really there and a placeholder takes no cells. A page that takes a newer compile's cells (W8) while an older render is
    still inserting leaves that render's queue, so the older page is never put over it. A newer compile, or a clear, stops
    the insertion. Each page that goes in
    re-indexes the links and calls `onRender` (the playhead's map, D35). `preview.js` does not change; its `.d.ts` declares
    the two functions.
  - **The default** (answer 4, OPEN I5). engine.js starts the engine for `?engine=1` and `?engine=debug` as before
    (D171), and, **in a site built with `esbuild.mjs --site --engine-default`**, for a page that asks nothing (esbuild defines
    `LILY_ENGINE_DEFAULT`; `engineByDefault`). **`?engine=0` refuses it**: the page compiles on the server as D55's. While the
    engine runs, Help's last item, *Compile on the Server*, opens the page again with `?engine=0`, its other parameters kept
    (`refusedSearch`); the page's `beforeunload` asks about unsaved edits first. The server stays the fallback for everything
    the engine fails or cannot do (D172).
  - **`build:site` does not pass `--engine-default` yet.** The engine's source is not public (`velet5/lily` is private,
    checked 2026-11-03), and D56 says a page that conveys the engine must reach its source. Making it the default is that one
    flag in `packages/studio/package.json`'s `build:site`, once the operator has made the source public.
- **Why.** B7 is a hard item (D257): 09 §4.4 measured one 45 KB page at about 25 ms of a tablet's main thread, so a task may
  parse one page; the engine's pages now land in `ScorePreview`, which replaced them all in one task. The default is a build
  flag rather than a constant so that the gate's web half runs on the very build that will ship, before it ships; a query
  parameter refuses it as `?engine=1` asked for it, and the Help item makes the refusal reachable without knowing it.
- **Checked** (progress.md, *MS7 · step 9*). `preview.test.ts`: the page in view at once and the others one per frame
  outwards, an added page held at its size, a newer compile stopping an older one's insertion and reusing only what is on
  screen, a placeholder taking no cells, a clear inserting nothing more (each fails on 128fee6's `preview.ts`), a page given
  a newer compile's cells during an older insertion left as it is (found at the step's check, fails on 35aeea9's).
  `engine.test.ts`: `engineMode` with and without the default; the tests' build has none. `web.test.ts`: `refusedSearch`.
  **B7 in desktop Chromium** (`$LILY_CORPUS/device-runs/2026-11-03-ms7-step9/b7.mjs`, the studio's `ScorePreview` alone,
  DevTools trace, p50 of 10): four 120 KB pages of the engine changed 50.4–51.6 ms → 25.0–26.5 (7 and 10 of 10 over 50 →
  none); L532, T24 and LilyPond's L532, two pages, 27.1–33.3 → 19.5–21.3; T29's single 322 KB page 35–37 either way (one
  page is all a task holds); none over 50 ms after. **At 4× CPU throttling every task is still over 50 ms** (one page's
  parse 82–113 ms; T29 141–177): the port cannot divide a page.
  **The gate's web half on a `--engine-default` build** (`gate.mjs`, D55's server behind a counting proxy, Chromium and
  WebKit, profiles on disk): no query starts the engine and its edits (shown 279–383 ms) reach no server compile; a reload
  asks the server for `manifest.json` and `fonts.css` only, both 304; Help › *Compile on the Server* opens `?engine=0` with
  no engine and the server compiles the edit; `engine/manifest.json` answering 503: the server compiles; the server killed:
  a notice that covers nothing, the engine shows an edit in 78–94 ms, the page reconnects in 3.4–3.8 s.
- **Not done.** The default is not on (above). B7 on the tablet is step 10's, and the throttled figures say a page's parse
  alone misses Must there: dividing a page's parse (W8's cells as the unit, or OPEN I7's earlier hand-over) is R9's if step
  10 confirms it. WebKit's page sees no entries in Cache Storage after a visit (Chromium 7), though its reload fetches
  nothing but the manifest: step 10's *Cache Storage after a reload* looks at it on the iPhone. The refusal is per URL; a
  remembered one is not built.

---

## D175 — A page's cells go into the studio's preview by parts, a few a task, the page's text taken at once

**Status:** accepted (MS7 step 10, 2026-11-03; the operator's answer to the step's stop on B7: one bounded fix, then
record) · **Refines:** D174, D232 (W8), D257 · **Changes:** `packages/studio/src/renderer/preview.ts`

- **Why.** D257's third hard item, B7 on the tablet, failed through the page at MS7 step 10: the longest main-thread task of an
  edit on the Android tablet was T12 52–56 ms, T24 71–76, T29 E1 104–107, T29 E2 223–239 (T02's under 50). A DevTools trace
  and a CPU profile of the same edits in desktop Chromium at 5× CPU put it in the page: W8's cells were parsed, sanitized,
  copied into the page and its links indexed, all in the worker's message handler (`replaceCells`: the markup's
  `parseFromString` 182 ms, sanitizing about 140, `importNode` 62, `indexLinks` 162 over T29's twelve cell updates), then
  one frame's style, layout and paint of the new cells. `preview.js` is the extension's too, and the operator's answer 1
  kept it unchanged.
- **What.** `ScorePreview.replaceCells` takes the page's new text at once (`replaceCells`, a string operation), so the
  compile's outcome, which follows the cells by a millisecond, finds the page as it will be and leaves it; then, in tasks
  of their own (a MessageChannel's message, `nextTask`): the new cells' markup parsed and sanitized a part a task, a part
  about 32,000 characters (`CELL_PART`; a longer cell is a part alone); then the page's kept cells moved and the new ones
  adopted (`adoptNode`, not copied) in one task; then the links and `onRender` in another, once for cells that come
  together. A page replaced meanwhile (a newer render's whole page, a clear, another score) stops its cells; the cells of
  a newer compile for the same page wait for an older's and go on from them; a page that lacks a cell after all gets its
  new text whole, as before. `preview.js` is unchanged.
- **Checked.** `preview.test.ts`: the outcome right after the cells parses nothing; the cells parsed a part a task, then
  moved in together, then the render's callback once; a page replaced while its cells wait stops them; a newer compile's
  cells wait for an older's. **Desktop Chromium at 5× CPU** (`b7-trace.mjs`): T29's E2 114–117 → 57–60 ms; what is left
  is one frame's style recalculation, layout and paint of the new cells (about 23 ms of style), which no division of the
  script reaches. **On the Android tablet through the page** (`run-b7.sh`, the four × E1–E3 × 11, the longest task of each edit, p50 / max): T12 52–56 → 0 / 0 ms; T24 E1 71–76 → 0 / 57, E2 71–74 → 0 / 0; T29 E1 104–107 → 63 / 72, E2 223–239 → 97 / 116, E3 53–64 → 66 / 83; T02 0 either way (one run of E2 74). **B7 is still over Must on T29, the hard item still failed: recorded, the default waits on it as on the source** (the operator's answer). B6 through the page within 2–5 % of before (the cells go in a few tasks later).
- **Not done.** The frame that styles, lays out and paints a whole edit's new cells is one task; dividing it would show
  a page half old for some frames, or needs smaller pages (B10) or fewer elements a cell. R9.

## D176 — A page's new cells go into the studio's preview hidden, a part a frame, and are shown in one more

**Status:** accepted (MS8 step 2, R9, 2026-11-05; OPEN I3's B7) · **Refines:** D174, D175 · **Changes:**
`packages/studio/src/renderer/preview.ts` (`putCells`, `nextFrame`, `ScorePreviewOptions.nextFrame`),
`packages/studio/test/preview.test.ts`

- **Why.** D175's *Not done*: after its parts were parsed, one frame styled, laid out and painted a whole edit's new cells,
  the longest main-thread task left on the Android tablet (T29 E1 63–72, E2 97–116, E3 66–83 ms against B7's 50, a hard item,
  D257). Showing a page half old for some frames was what D175 would not do.
- **What.** After D175's tasks have parsed and sanitized the new cells a part a task, each part's cells are adopted into the
  page **hidden** (`visibility="hidden"`), each after the cell before it in the page's new order, **one part a frame**
  (`requestAnimationFrame`): a frame styles and lays out one part and paints none of it, and the page on screen is the old
  one whole. **In one more frame** the cells that leave are removed, those that stay are moved where they must (rare: the
  cells keep their order) and given their places, and the new ones are shown. A page replaced meanwhile stops them, and a
  newer compile's cells wait for them, as D175 has it; the links and the render's callback come in a task after.
  `preview.js` is unchanged.
- **Checked.** `preview.test.ts`: the parts parsed a task each, then in hidden a frame each, the page showing its old cells
  until the frame that shows the new ones, a cell kept the same element, a cell that left out of the page.
  **Desktop Chromium at 4× CPU through the studio's page** (MS8 step 2's `run-desk.sh`, T29 × E1–E3 × 11 and B8 × 5,
  D175's build against this one, in turns, the Mac at load 11–32): **the longest main-thread task of each edit p50 0 / max 0
  ms on E1–E3** (D175's 0 / 0, 0 / 51, 0 / 0). Under a DevTools trace (`run-trace.sh`, T29 × E1–E3 × 6) the edits' longest
  frames are **45.0–47.1 ms** (D175's 50.2–57.9), each a hidden part's frame: its script 5.6–6.3 ms, then 22.8–26.3 ms of
  style; a part half as long (16,000 characters a frame) left them the same, so what those frames style is not the part's
  own, and it was taken out again. 4× on this Mac does not reach the tablet's B7 (MS7 step 10's 63–116 ms), which is step
  12's. `studio-page.js` no longer counts hidden cells going in as the preview's change (B6), and counts their
  `visibility` taken off.
- **Not done.** The frame that shows the new cells paints them at once, as it must to show them together. A whole page
  (a render, not cells) still goes in one per frame (D174).

## D177 — The studio's page shows the visible page the engine hands over before its compile's outcome

**Status:** accepted (MS8 step 4, R9, 2026-11-06; OPEN I7, with D269) · **Refines:** D171 (the web's live preview by the
engine), D175 (a page's cells before the outcome) · **Changes:** `packages/studio/src/web/engine/protocol.ts` (`PageWhole`,
`PageUpdate`, `lily_outputs`' doc), `driver.ts` (`steps`' `handed`, `handOver`), `host.ts`, `engine.ts`,
`packages/studio/src/web/live.ts`, `packages/studio/src/renderer/bridge.ts`, `index.ts`, `preview.ts` (`replacePage`),
`packages/studio/test/engine.test.ts`, `packages/studio/test/preview.test.ts`

- **Why.** D269: the core hands the visible page over before the compile's end; the page should show it then.
- **What.** After each `Step.More` the driver reads `lily_outputs`; a page there is posted at once, **by its cells (the
  `cells` message, W8) when it goes by them, else whole (`{ type: 'page', revision, page, svg }`)**, `page` the request's
  `visiblePage` less one. Its cells are not posted again at the end: the outcome's page is the same bytes. A compile
  started again after a stop hands its page over again. The host passes a `page` message on, as `cells`, only for the
  compile it waits for; live.ts and the bridge carry both as one event (`PageUpdate`). **`ScorePreview.replacePage`** puts
  the page whole in place of the one on screen (one page parsed in that task, as D58's page in view), takes it out of a
  render's or cells' insertion, and the outcome, which follows, finds its text and leaves it. A page not on screen yet is
  the outcome's to insert.
- **Checked.** `engine.test.ts`: a page handed over whole is posted before the outcome and nothing else; one handed over
  by its cells posts its cells once; the host passes `page` and `cells` on for the compile it waits for only.
  `preview.test.ts`: a page handed over whole is parsed once and the outcome parses nothing again. Driven in Chromium and
  WebKit through D55's server with `?engine=1` (MS8 step 4's `gate.mjs`).

## D141 — Export PDF on the web page is the engine's: its PDFs downloaded, the server's export when it cannot

**Status:** accepted (MS8 step 6, R9, 2026-11-06; W7, with D271) · **Refines:** D33 (Export PDF), D55 (the web), D171 and
D172 (live preview by the engine, the server for what it cannot do), D264 · **Changes:**
`packages/studio/src/web/engine/{protocol.ts,driver.ts,host.ts,modules.ts}`, `packages/studio/src/web/live.ts`,
`packages/studio/src/web/transport.ts`, `packages/studio/src/renderer/index.ts`, `packages/studio/test/{engine,web}.test.ts`

- **Why.** MS8's gate asks for Export PDF on the web from the engine (README §5); D271 gives the display list.
- **What.** `CompileRequest.pdf`: a compile that also gives the PDFs. The driver sets `lily_pdf` with each compile it
  begins, and after a compile that asked for it hands each `<book>.pdf.list` to **pdf.wasm, in an instance of its own
  dropped after the export with its memory (B4)**, with the OTFs `lily_pdf_fonts` names; the `finished` message carries
  `pdf: { files, warnings, message? }`. The host's `pdf()` is `compile()` with it. **`EngineLive.exportPdf`** sends the
  score as live preview has it (its unsaved texts) as that compile, which is shown as the newest compile like any other;
  a newer edit that supersedes it sends it once more with the newest texts. **Export PDF** (transport.ts) downloads the
  engine's PDFs, named as LilyPond names them, and says "to your downloads" (a name alone in `onExported`); a score with
  errors rejects with the server's own message; **what the engine cannot do — it is not running, `cannotDo`, the module
  or a font not fetched, a list refused, superseded twice — goes to the server's `export_pdf`**, as before. The PDF tab's
  view stays the server's. The prefetch names Schola's pack for "New Century Schoolbook" (E23).
- **Checked.** `engine.test.ts`: a PDF compile's list written with the font the build has and the other left out with
  its warning, the module instantiated once; a later compile gives none; a font not fetched is no PDF, and why; the
  module's input form. `web.test.ts`: Export PDF compiles the texts live preview has and shows that compile; errors
  reject; what the engine cannot do or write is undefined (the server's); superseded once then given up; none before the
  engine runs. **Driven in Chromium and WebKit** through D55's release server with `?engine=1`
  (`$LILY_CORPUS/device-runs/2026-11-06-ms8-step6/pdf.mjs`): T26's text, unsaved, exported by the engine in 201 and 237
  ms, 1 page, Schola embedded, its text by pdf.js, no `export_pdf` sent; a syntax error says the server's message and
  sends nothing; pdf.wasm refused (503) goes to the server's `export_pdf`.

## D200 — The engine's decisions are numbered from D200; the runway plans what is left

**Status:** accepted (the user's answer, 2026-10-18, when the runway was
written) · **Changes:** `docs/DECISIONS.md`,
`docs/research/wasm-engine/runway/`, `progress.md` (MS3 step 35's last
line), `NEXT-SESSION.md`

- **What.**
  - **New decisions of the engine take D200 and up**, in order, on
    `feat/engine`. `main` and the studio's branches keep D124 and up. The
    engine's D113–D119, whose numbers `main` also uses (D113–D123 there
    are the studio's), keep their numbers on `feat/engine` and are cited
    as they are until the merge plan renumbers them (D202). D112 stays
    `feat/stems`'.
  - **The runway** (`docs/research/wasm-engine/runway/`) lists every plan
    left to the end of the roadmap (README §5), in order, with what each
    inherits of the open items, and how a plan is started, run and
    closed. Its `LEDGER.md` replaces `NEXT-SESSION.md` as the pointer for
    the next session; progress.md stays the log, and PLAN-RUN.md and
    IMPLEMENT.md stay the rule books.
- **Why.** `feat/engine` took D113–D119 while `main` took D112–D123 for
  the studio, so the step 35 entry's "next free D120" was already taken on
  `main`; a block of its own keeps the engine's new numbers apart until
  the branches meet. `NEXT-SESSION.md` stopped being kept after MS3 step
  26, and what is left was spread over 25,000 lines of progress.md.
- **Consequences.**
  - The next free D-number on `feat/engine` is D203.
  - Each plan's closing step updates `runway/LEDGER.md` and
    `runway/OPEN.md` with its results.

  runway/README.md.

## D201 — The tablet's first restore gets a step in MS3 part 4

**Status:** accepted (the user's answer, 2026-10-18, under D88) ·
**Refines:** D88 · **Changes:** `runway/PLANS.md` (R2)

- **What.** `lily_start`'s first restore in a fresh worker on the Android
  tablet, 102.9 ms over 24 workers (2.06 of the 50 ms Must; measured by
  hand on 2026-10-14, progress.md after MS3 step 25), gets a step in MS3
  part 4. Its lead is D88's: **a cheaper first restore**, what a fresh
  worker pays over a warm restore of the same image, not a smaller
  image. Part 4's split writes the step and its stop points; part 4's
  closing step measures it again on the tablet, or lists it by hand.
- **Why.** It is a miss of a Must by more than twice at its median, which
  D88 gives a step in the next part; it waited for the user since it was
  measured between steps.
- **Consequences.** Part 4 holds three items outside the proxy: W5, W6's
  Emmentaler shaping and this step; its split estimates them.

  runway/PLANS.md, R2.

## D202 — feat/engine joins main after MS4, before the engine is used behind ?engine=1

**Status:** accepted (the user's answer, 2026-10-18) · **Changes:**
`runway/PLANS.md` (R6)

- **What.** A merge plan (the runway's R6) runs after MS4's close and
  before any work on the studio's page behind `?engine=1` (README §5,
  MS7's K6): `feat/studio-web` (D55) into `main` first, then
  `feat/engine`, resolving `packages/studio/Cargo.toml` and its lock,
  AGENTS.md's package list and `docs/DECISIONS.md`, where the engine's
  D113–D119 are renumbered after `main`'s last and every citation of
  them in the engine's docs and code follows. (Done for the second block at the
  merge of 2026-11-12: the engine's D133–D140, which `main` had used for
  the studio, became D170–D177, and their citations followed; D141 kept
  its number.) Until then every plan works
  in `.worktrees/engine` on `feat/engine` and never touches the main
  checkout. MS6 and MS7 run on a branch from `main` after the merge.
- **Why.** `feat/engine` is 430 commits past `feat/studio-web`'s c4751a8
  and neither is in `main`; the longer they stay apart, the larger the
  merge. MS7 builds on D55, which only `feat/studio-web` holds, and the
  flag needs the studio's page; merging before the flag keeps MS4's
  layout work off the studio's files.
- **Consequences.** R6 is the first plan allowed to edit the main
  checkout, and it asks the user before it starts; IMPLEMENT.md and
  PLAN-RUN.md reach `main` with it.

  runway/PLANS.md, R6.

## D203 — A grob definition's properties are searched by a table in layout's slot

**Status:** accepted (MS3 step 36, under part 3's answer 3) · **Refines:**
D108 · **Changes:** `packages/engine/crates/layout/src/grob.rs`

- **What.** Layout's part of a translation's grobs (D108's slot,
  `grob.rs`' `Grobs`) keeps, for each grob definition its grobs are made
  with (the alist `override.rs`' `updated` cooks, shared by every grob of
  a type made in a context until its stack changes), a table of the
  alist's first entry for each key, sorted by the key. `property_data`
  searches it where `internal_get_property_data` walks the definition
  with `scm_sloppy_assq`; the properties set on a grob are still its
  alist, walked as LilyPond walks them. The table is made the first time
  a grob of the definition asks, each grob keeps its table's number, and
  the slot traces the definitions it has tables of. This is the first
  piece of 05 §5.1's typed slots, built under answer 3 at part 3's split:
  layout's, behind D108's slot, and the music crate names none of it.
- **Why.** Step 36's profile: 94 % of `property_data`'s calls miss the
  grob's own alist and walk its definition; `Heap::assq` was the
  translation's second self frame after the straight-port cuts (4.2 % in
  desktop Chromium), most of it there. The table gives what the walk
  gives: a definition is not changed in place (LilyPond's
  `immutable_property_alist_`; a new stack cooks a new alist, which gets
  its own table), and an entry's value is read when it is asked for.
- **Consequences.** A definition's spine changed in place by Scheme (no
  LilyPond file does it) would not be seen; its entries' values would.
  The properties a grob is given and the per-type slots of 05 §5.1, with
  their generated defaults and callbacks, are left to R1's decision point
  (step 44) and R2.

## D204 — translate.html puts font packs, and the engine times its layout apart from the writer

**Status:** accepted (MS3 step 36) · **Refines:** D105, D130 ·
**Changes:** `packages/engine/crates/core/src/{lib,abi,compile}.rs`,
`packages/engine/crates/core/examples/compile.rs`,
`packages/engine/crates/layout/src/dump.rs`,
`packages/engine/crates/spike/harness/{translate-page.js,translate.html,serve.mjs,measure.mjs}`,
`packages/engine/tools/compare/core.mjs`

- **What.** translate.html puts font packs in each fresh instance after
  `lily_start`, with `lily_put`'s `MODULE`, before anything is timed: by
  default the build manifest's `preload` (D105), as the studio's host
  puts them, and `emmentaler-16`, which T23 needs and no build preloads
  (D132), from `dist/engine/fonts/` as the compile example's `--pack`
  does (`?packs=` names others, `preload` standing for the manifest's;
  `?packs=none` puts none, as before). serve.mjs serves the packs as
  `/scheme/fonts/<name>.pack` and the manifest as `/scheme/manifest.json`.
  The manifest and the host's fetch of packs on demand stay W5's (R2).
  The engine's `Times` (`lsb_times`, the harness's export, not 08 §4.2's
  ABI) gives four more values after its four: of the translations, the
  Paper_scores processed and broken (D130's `lay_out`); the books' pages'
  stencils (`paper_book::output`); the SVG writer; and the live grobs,
  counted after the pages as `layout.tsv` counts them
  (`dump::live_grobs`: each broken system's `all-elements`, else the
  root System's). The layout of *How layout per grob is measured* is the
  first two together. translate.html shows it a score with the median
  of its runs, and µs a live grob only for a score whose pages were made.
  `lsb_times`' translations are unchanged: they still include the
  `lay_out` part.
- **Why.** Step 23's Open (OPEN C5): without a font module T23's and
  T26's `\layout` translations fail in translate.html, and R1 (µs a live
  grob, step 44) needs the layout timed apart from the writer in wasm.
  Keeping the translations' figure as it was keeps the comparison with
  step 23's and session 2's figures.
- **Consequences.** A layout that stops (a placeholder, a font not put)
  counts grobs a whole one would kill; its µs a live grob is not shown.
  Only path.ly lays out whole until step 39. With the packs T12, T29,
  T24 and T07 translate within their visits' spread of the run without
  (desktop Chromium ×0.990–1.019, WebKit ×1.000, native within its
  runs); T23 and T26 take ×1.7–1.9, their layouts now running, which
  moves the 29 summed ×1.014–1.016. A comparison with figures from
  before this decision is made on `?packs=none`.

## D205 — Layout's grob reads are Rust over the Host, callbacks are found by their binding, and the image's reads call the Rust unless the VM waits

**Status:** accepted (MS3 step 46, under R1's stop answer 2) · **Refines:**
D70, D108, D127, D203 · **Changes:**
`packages/engine/crates/layout/src/{grob,staff_symbol_referencer,callbacks,slots,dump,lib}.rs`
and the five callback modules' dispatch, `packages/engine/crates/scheme/src/vm.rs`

- **What.** 05 §5.1's machinery, as R2's first step builds it:
  - **grob.cc's and staff-symbol-referencer.cc's reads are Rust over a
    `Host`:** `internal_get_property` and `try_callback_on_alist`,
    `get_offset`, `relative_coordinate`, `extent`,
    `robust_relative_extent`, the vertical ordering, grob.cc's callbacks
    of the stencil's extents and the parent's positioning, and the
    referencer's functions. The VM is called for a callback that is
    Scheme, for a report, and for a read the traced dump takes over
    (`Grobs::dumping`, set by `dump.rs` around each `%dump-read`, which
    sends the read to `(lily)`'s `%grob-try-callback` and `%grob-offset`
    as the dump replaces them).
  - **The callback table (`callbacks.rs`):** layout's callbacks in Rust,
    by their names in `(lily)` — the `ly:…::` primitives over
    `%host-call` whose only check is a grob (the stem's, flag's,
    accidental's, clef's and ledger line spanner's), grob.cc's four and
    the referencer's — resolved to their bindings once a translation, in
    layout's slot (D108), so that a callback whose data is one of those
    procedures runs its Rust without the VM. A grob's (type, property)
    finds the data as before (its alist, then D203's table); a procedure
    defined by a score under a callback's name is not in the table. The
    pure callbacks, called by `call_pure_function` with three arguments,
    are left out.
  - **The image's reads call the Rust:** `%grob-relative-coordinate`,
    `%grob-extent`, `%grob-robust-relative-extent`, grob.cc's four
    callbacks, the referencer's callback, `%staff-space` and
    `%staff-position` call it over `%host-call`, and keep their Scheme
    for a run the VM has left waiting for the host (`%host-waiting?`, over
    the new `Cx::waiting`). A `%host-call` made then is cancelled (D127),
    and a traced compile's reads are made then once a part's file is
    asked for (T22's `fretted`), where the Scheme alone ran on.
  - **A grob's own properties have slots (`slots.rs`):** the first entry
    of each key of the record's `props`, sorted, kept for the alist they
    were made of and as layout's writes go, made again when it is set
    from elsewhere; the alist stays LilyPond's, for Scheme and the music
    crate. The per-type slots with decoded values and generated defaults
    are not built.
- **Why.** Step 44's profile (05 §8.1): the VM's frames and the alists
  were most of R1's cost, and grob.cc's reads were Scheme only because a
  primitive cannot call Scheme (D70). A table by binding needs no
  generated tables and keeps an override or a score's own procedure
  where LilyPond has it. Keeping the image's Scheme for a waiting run
  keeps every output byte for byte, traced ones included.
- **Consequences.**
  - Natively R1 on the five falls 71.3 → 63.0 µs a live grob (lead 1
    −2.9 %, the slots −1.4 %, the image's reads −7.6 %); outputs of the
    30, M01–M12 and the 20 fixtures unchanged, traced and untraced.
  - The wrapped reads' Scheme and their Rust must change together; the
    Scheme runs only where the VM waits for the host.
  - The music crate names none of it (D108).

  progress.md, MS3 step 46.

## D206 — R1's Must is read on the iPhone and the emulator; the Android tablet is reported beside them

**Status:** accepted (2026-10-23, the user's answer to option 3's question
after MS3 step 46: "3, then 1") · **Refines:** D201, D205 · **Changes:**
`docs/research/wasm-engine/README.md` (risk R1, MS3's budgets and decision
point), `docs/research/wasm-engine/05-layout.md` §9,
`docs/research/wasm-engine/runway/{LEDGER,PLANS}.md`

- **What.** Layout's cost per live grob (R1: Must 120 µs, Goal 40) is
  judged on **the iPhone** (Safari) and **the emulator
  `mother_api36`**, instead of the Android tablet. The tablet keeps being
  measured at each close, its figure and its ratio of Must reported beside
  the two, and its misses are recorded, not stops. The roadmap's decision
  point (R1 over 120 µs at R2's and R3's closes) stops when either of the
  two is over Must. Part 4 goes on to step 47 (Y2) with no further
  machinery step (option 1); R1 is measured again at R2's close.
- **Why.** Step 46 measured 654.0 µs on the tablet (5.45 of Must), 110.4
  on the iPhone (within Must), 184.6 on the emulator; by step 44's floor
  the tablet stays near 155–175 µs even with all of 05 §5.1's machinery,
  so a Must read on it would stop every close without a step that could
  answer it. The iPhone is a phone of the target class; the emulator is
  the Android figure every step has measured since step 23.
- **Consequences.**
  - At step 46 the emulator is at 1.54 of Must, so R2's close stops again
    unless it falls under 120 µs there.
  - Other tablet budgets (D88's translation, D201's first restore) are
    unchanged by this decision.
  - The A15-class Android (OPEN D4) is still the floor B1–B10 are written
    for; R8's gate measures it.

  progress.md, MS3 step 46; LEDGER.md's *History*.

## D207 — A comparison that differs only by E8's `sin` names its lines and checks them without their zero-width buildings

**Status:** accepted (2026-10-23, the user's answer to E8's stop at MS3
step 48: "pin the 2 as E8's") · **Refines:** E8's answer at MS3 step 45
(the `libm` crate's `sin` is kept) · **Changes:**
`packages/engine/tools/bench/test/skylines.test.mjs`

- **What.** Where a check against LilyPond 2.26.0 fails only because the
  `libm` crate's `sin` is an ulp from Apple's (`offset_directed`, E8), the
  test names the lines E8 accounts for, asserts that they are the only
  ones that differ, and compares them with every building of no width (a
  point repeated) left out of both sides, to the check's own tolerance.
  The claim is shown once by a build whose `offset_directed` calls the
  system's `sin`, which gives LilyPond's output byte for byte; that build
  is the session's evidence, not the engine's.
- **Why.** Step 48's probe of skyline-scheme.cc's face gave LilyPond's
  116 lines byte for byte with Apple's `sin`; with the kept one, two
  partial ellipses lost a zero-width building at the arc's top (heights
  1.4e-16 apart), so their point counts differ although every height
  agrees. Step 26 compared its circles and ellipses the same way
  (`tests/skylines.rs`' `same_heights`). Steps 51, 53 and 54 carry the
  same stop.
- **Consequences.**
  - A difference that remains once zero-width buildings are left out is
    not E8's and fails the check.
  - A new line that differs only by `sin` stops for the user, as before:
    the named lines are a list, not a tolerance.

  progress.md, MS3 step 48.

## D208 — The core asks the host for font packs with `Need.Module`, a pack put as none is a diagnostic, and the manifest names every pack

**Status:** accepted (MS3 step 50, W5; the studio test's count by the
user's answer of 2026-10-23 to the step's stop) · **Refines:** D105, D130,
D204 · **Changes:** `packages/engine/crates/core/src/{lib,compile,diag}.rs`,
`packages/engine/crates/core/examples/compile.rs`,
`packages/engine/crates/layout/src/{font,font_select,pango}.rs`,
`packages/engine/scripts/build.mjs`,
`packages/engine/crates/spike/harness/{translate-page.js,serve.mjs}`,
`packages/engine/tools/compare/core.mjs`,
`packages/studio/test/engine-corpus.test.ts`

- **What.**
  - **The core asks for a font of the build's packs that no host gave**
    (an Emmentaler size, `emmentaler-brace`, a text face: layout's
    `font::pack_modules`) as it asks for a file: the compile stops, what
    it made is dropped, `lily_step` gives `Need.Module` for each of the
    font's packs not put yet (the brace's four parts in order), one a
    step, and it is compiled again once the host has put them all, as the
    studio's driver starts it again. It meets the font either **after a
    `\layout` translation, before its layout** (`font_select::want_fonts`:
    the music font each grob of a glyph-drawing interface would select at
    its layout's staff height and its own `font-size`, read without
    callbacks: a staff size, a `\layout`'s, a `font-size` override, a
    grace note), or **when layout loads it** (a markup's, a text face).
  - **A module put as none** (`lily_put`'s data null, as a file the host
    has not) is one the host could not give: the compile running does not
    ask for it again, the font's error ends its layout as before (D130),
    and the compile says so, after the translations' messages:
    `error: cannot find font 'emmentaler-13' (its font pack emmentaler-13
    could not be fetched)`, not fatal. A new compile (another revision or
    root) asks again.
  - **The manifest names every pack** of `fonts/` as a `pack` module,
    copied beside the core as the preloaded are (the studio's `--site`
    build copies no directory): Emmentaler's sizes, the brace's four
    parts, the twelve text faces; `preload` is unchanged (D105).
  - **The harness's hosts answer**: the compile example from `--fonts`
    (the build's `dist/engine/fonts/` by default) and with none under
    `--offline`; `core.mjs`' `compileInWasm` from the manifest's files and
    with none under `offline`; translate.html from `/scheme/fonts/`,
    which `serve.mjs --offline` refuses but for the preloaded packs.
  - **The studio's `engine-corpus.test.ts` counts a pack the driver loads
    on the engine's ask as an answer** (its trail's `packs`, a pack loaded
    once the compile started): its "a compile again after each answer"
    is starts = the page's answers + those packs + 1. The one change to
    the studio's tests before R8, by the user's answer to the step's stop
    (PROTOCOL §6.2); `protocol.ts`, `driver.ts` and `host.ts` are
    unchanged, and every output through the driver is the native core's.
- **Why.** W5 (06 §5.2, §9): a pack is fetched only for a score that
  needs it, and one that cannot be fetched is a diagnostic, not a silent
  stop (E12). 08 §4.2's ABI already has `Need.Module`, and the driver
  loads a manifest's `pack` modules when the core asks
  (`driver.ts:136–145`, `174–189`), so `protocol.ts`, `driver.ts` and
  `host.ts` do not change; only the corpus test's count of restarts did,
  since it counted the page's answers alone. Asking after the
  translation, not only when layout loads a font, is what makes a score
  whose layout stops earlier (T22, T29 before MS4) ask for its staff
  size, and keeps the stop before anything is laid out; the interfaces
  are a list so that grobs whose `font-size` draws nothing (paper
  columns -7.5, slurs and ties -6 for debugging) ask for no pack. On the
  30 the fonts asked are a subset of those LilyPond's pages use.
- **Consequences.**
  - A score that needs packs compiles once more (once for all the packs a
    translation names, once more for each a layout meets later); the
    studio's `modules.ts` triggers fetch most of them before the first
    step, so the driver's restarts are rare.
  - The studio's driver turns a pack it cannot fetch into its own failure
    (`The engine could not compile the score`), not the core's
    diagnostic: putting none is the harness's, until R8 changes the
    driver.
  - Tests that gave no packs now get them fetched as a host would.

  progress.md, MS3 step 50.

## D209 — Font packs of version 3: Emmentaler's packs carry GPOS's `kern` and GSUB's features, the text packs their outlines

**Status:** accepted (MS3 step 51, W6; E7 by the user's answer 3 at part 4's
split, 2026-10-22) · **Refines:** D107, 06 §5.1 and §5.3 (W1's packs) ·
**Changes:** `packages/engine/tools/packs/{build,text,opentype}.mjs`,
`packages/engine/crates/fonts/src/{lib,text}.rs`,
`packages/engine/crates/skyline/src/lib.rs`,
`packages/engine/crates/layout/src/{pango,skylines}.rs`

- **What.** Both pack formats go to version 3, and the readers take
  version 3 only (the packs are built from the OTFs by every build, as
  D107's were):
  - **An Emmentaler pack (`LILP` 3)** ends, after its outlines, with the
    OpenType layout its OTF has: GPOS's `kern` pairs, and GSUB's lookups
    with the features that name them (Emmentaler's `cv47`, `dlig`,
    `ss01` and `tnum`), both as HarfBuzz selects them for Latin text
    (the `latn` script's default language system, or `DFLT`'s). A brace
    part has none (its OTF has neither table).
  - **A text pack (`LILT` 3)** holds each glyph's outline, in the music
    packs' encoding, after its advance; the ink boxes are no longer
    written but read from the outlines as HarfBuzz's CFF extents count
    them (the function that read Emmentaler's for text since MS3 step 8).
    Its GSUB section is written in the same form as the Emmentaler
    packs', with `liga` alone, as before.
  - **The shared form**, after D107's columns: `kern` as LILT 2 had it
    (first glyphs ascending, each with its seconds and x advances); then
    the lookups in the font's lookup order, each a type (1, a single
    substitution: glyphs ascending with their substitutes; 4, a
    ligature substitution: LILT 2's ligatures), then the features by tag,
    each with the positions of its lookups.
  - **Shaping** (`TextFont::shape`) applies the lookups of the features a
    string turns on, all at once in the font's lookup order as HarfBuzz
    does, then `kern`; `liga` and `kern` are on unless turned off, any
    other feature off unless a `font-features` string turns it on
    (`\volta-number`'s `cv47` and `ss01`, `\dynamic`'s kerning,
    `\fingering`'s, the figured bass's `tnum`).
  - **Skylines** read a text face's outlines as they read Emmentaler's
    (`stencil-integral.cc`'s `add_glyph_string_segments` through
    FreeType's unscaled outline), so a glyph string in C059 adds its
    glyphs' shapes, not their boxes.
- **Why.** W6 (E1, E6, A18): LilyPond's `\volta-number`, `\dynamic`,
  `\fingering` and a multi-measure rest's number shape Emmentaler's text
  through HarfBuzz with these features, and its widths, rods and C4
  follow; an Emmentaler pack without them gave `one` for `fattened.one`
  and unkerned `ff`s. E7: the text packs' boxes made text skylines
  boxes, and T10's staff 0.9908 lower than LilyPond's. One encoding for
  both packs keeps one reader. Dropping the ink boxes keeps the text
  packs' growth to the outlines alone, and the boxes stay HarfBuzz's,
  as the Emmentaler faces' have been since step 8.
- **Consequences.**
  - The text packs grow by their outlines (progress.md, MS3 step 51, for
    the sizes against 06 §8's 20 / 12 KB); the three C059 packs the
    manifest preloads are part of the core's download.
  - 06 §5.3's license note no longer holds as written: the text packs
    are the URW fonts' outlines in another encoding, under the fonts'
    AGPL with its exception, as the PDF module's fonts are. The check
    PLANS.md's R9 asks for before W7 ships (GPL, URW's AGPL fonts) now
    covers the text packs too, before R8 ships them on the web.
  - A font the packs do not describe (a TrueType, a CFF2) is still the
    build's error. The URW fonts' Latin text has no other feature HarfBuzz
    turns on by default (no `ccmp`, `locl`, `calt` or `clig`; `fina` is
    the Arabic shaper's), but `frac`, `numr` and `dnom`, which HarfBuzz
    applies around a fraction slash (U+2044), are not in the packs.

  progress.md, MS3 step 51.

## D210 — The engine's `$defaultpaper` names LilyPond's own text families

**Status:** accepted (the user's answer 2 at MS3 part 4's split,
2026-10-22: B9) · **Refines:** D106 · **Changes, in MS3 step 51:**
`packages/engine/crates/parser/tests/support/mod.rs` (the init the image
writer runs), every page's `<text>` and every `utf-8-string`'s description

- **What.** After `declarations-init.ly`, the engine's init sets
  `property-defaults.fonts.serif`, `.sans` and `.typewriter` of
  `$defaultpaper` to `"LilyPond Serif"`, `"LilyPond Sans Serif"` and
  `"LilyPond Monospace"`, as capture.ly's `\paper` does for every
  reference (D106), and in its order: each new entry in front of `fonts`'
  alist, `fonts` in front of the rest (`nested_property_alist`). The
  backend stays `svg` (music strings drawn as paths, the SVG writer's
  primitives); only the families change. A score that sets its own fonts
  keeps them.
- **Why.** Under `--svg`, `paper-defaults-init.ly:170–181` names
  fontconfig's `serif`, `sans` and `monospace`, which are the machine's;
  the engine's metrics were C059's for both names already (layout's
  `pango::FAMILIES`), so only the names the page writes differed from the
  references' (path.ly's pixels: AE 2,669 with `serif`, 0 with D106's
  families). With them the engine's pages are LilyPond's with capture.ly's
  settings, which R3's MS3 gate reads pixel for pixel (W3).
- **Consequences.**
  - The browser draws the page's text in `LilyPond Serif`, which the
    studio must provide as a web font (R8's; until then the browser's
    fallback serif, as with `serif`).
  - The tests' wrappers that set D106's families (`compileD106`) now
    compile the same page as without them.

  progress.md, MS3 step 51.

## D211 — `Lookup::slur` and the Bézier arithmetic it needs come into MS3 with the chord slur

**Status:** accepted (the user's answer to MS3 step 54's stop, 2026-10-23:
port it here) · **Refines:** 05 §5.5, D67 · **Changes, in MS3 step 54:**
`packages/engine/crates/layout/src/lookup.rs`, `bezier.rs`

- **What.** `Lookup::slur` (`lookup.cc:394–458`, solid and dashed) and
  `Lookup::bezier_sandwich` (`:484–516`) are layout's own, no longer
  placeholders that throw, over `bezier.rs`: `bezier-bow.cc`'s
  `slur_shape` and the parts of `bezier.cc` and `flower/polynomial.cc`
  they use (`curve_point`, `polynomial` over the cached Bernstein terms,
  `solve_derivative`, `extent`, `rotate`, `subdivide`, `extract`;
  `differentiate`, `clean`, the linear and quadratic solves). Each is
  rounded as LilyPond's: `Offset`'s operators are functions clang does not
  fuse, `solve_quadric`'s `p * p - q` is one expression it does.
  `Bezier::extract`'s programming errors go to the caller, which gives
  them unlocated.
- **Why.** The split counted `Lookup::slur` as in the engine (its
  placeholder's name), but step 47's arpeggios fixture reaches it through
  `\arpeggioParenthesis` and `\arpeggioParenthesisDashed`
  (`ly:chord-slur::print`, `::width`): without it the fixture's layout
  throws and makes no page. The port is about 250 lines; the chord slurs'
  paths are LilyPond's to the SVG's four decimals.
- **Consequences.**
  - MS4's ties and slurs build on these; `Polynomial::solve_cubic`,
    `solve_point`, `get_other_coordinate`, `minmax`, `dir_at_point` and
    `bezier-bow.cc`'s rest stay MS4's (05 §5.5).
  - A `dash-definition` part that is no list of four numbers reads
    LilyPond's defaults for what it lacks, where Guile's `car` would
    throw.

  progress.md, MS3 step 54.

## D212 — A file's module is the current one while its books are translated, laid out and drawn

**Status:** accepted (the user's answer to MS3 step 54's second stop,
2026-10-23: fix it here) · **Refines:** MS3 step 35's `ly:parser-lookup`
· **Changes, in MS3 step 54:** `packages/engine/crates/core/src/compile.rs`

- **What.** The core's `translate` makes the parse's module current from
  the start of its first translation until its last book's pages are
  written, then restores the module it found.
- **Why.** LilyPond processes a file's books from `init.ly`'s last Scheme
  (`toplevel-book-handler`), while its parser runs: `ly:parser-lookup`
  reads the parser's scopes, and the current module is the file's. The
  engine translated after the parse with another module current, so
  `ly:parser-lookup '$defaultpaper` gave `'()` during layout:
  `\note-by-number` (every `\tempo` with a beat, through
  `format-metronome-markup`) threw, and the score made no page. With
  `Metronome_mark_engraver` in layout, T28, which has made its page since
  step 52, would have lost it.
- **Consequences.** Scheme a translation or a layout runs that reads the
  current module (`ly:parser-lookup`, `defined?`, `module-ref` of
  `(current-module)`) sees the file's definitions, as in LilyPond. Every
  output of the fixtures, the five and the 30 but those step 54 names is
  byte for byte the previous build's.

  progress.md, MS3 step 54.

## D213 — A Scheme engraver of the image that the translation pays most for runs as a layout class of its name

**Status:** accepted (MS3 step 55's line: D88's lead, the image's Scheme
engravers in Rust, settled at part 4's split) · **Refines:** D67, D108,
D127 · **Changes, in MS3 step 55:**
`packages/engine/crates/layout/src/{apply_output_engraver,lib}.rs`,
`packages/engine/crates/music/src/translator.rs`

- **What.**
  - **A translator LilyPond writes in Scheme** (`scheme-engravers.scm`)
    may be ported to a class of layout's of the same name in
    `lily_engine_layout::CLASSES`. A group's `\consists` of the name finds
    the class before `%translator-creator` finds the image's Scheme
    engraver, as it finds layout's classes before the music crate's
    placeholders (D108). The image keeps the Scheme engraver: a
    `\consists` of the procedure itself (`#Apply_output_engraver`),
    `ly:translator-description` and `ly:get-all-translators` still reach
    it, and `\midi`'s translations, which are given no layout classes, are
    unchanged.
  - **The class does what the Scheme does,** in its order: the same
    listeners, acknowledgers and timestep methods, the same calls of the
    user's procedures (`Tx::apply`, D85's broadcasts after them), the
    same errors where the Scheme would throw (its Scheme callees called
    for them).
  - **The first is `Apply_output_engraver`** (2.26.0's `:2641–2677`),
    which `engraver-init.ly` consists in Score, every staff and Voice
    among its contexts, so that each grob is acknowledged by several.
- **Why.** Step 55's profile (D88) put the Scheme translators at 16–30 %
  of T12's, T29's and T24's translation natively, and
  `Apply_output_engraver`'s acknowledger at 7–14 % alone: 43,734 calls in
  T29, each a Scheme call that does nothing without an `\applyOutput`.
  The cost is the call itself, so D127's `%host-call` from the Scheme
  (Rust under the Scheme's own call) would keep it; only a class that no
  Scheme call reaches removes it. A faster VM was the other way, and is
  not this milestone's.
- **Consequences.** Every output of the 30, the five and path.ly is byte
  for byte the previous build's; `crates/core/tests/engine.rs` checks
  `\applyOutput`'s calls against LilyPond 2.26.0's. Each further Scheme
  engraver ported this way is listed in `CLASSES`' comment and progress.md,
  with what it costs in the profile; the image's size is unchanged.

  progress.md, MS3 step 55.

## D214 — D88's translation Must is read on the iPhone and the emulator; the Android tablet is reported beside them

**Status:** accepted (2026-10-23, the user's answer to MS3 step 55's
device stop: "as D206") · **Refines:** D88, D206 · **Changes:**
`docs/research/wasm-engine/runway/LEDGER.md`,
`docs/research/wasm-engine/progress.md`

- **What.** D88's rule for the translations (T12 and T07 against 60 ms,
  T29 and T24 against 250 ms, a step for each over twice) is judged on
  **the iPhone** (Safari) and **the emulator `mother_api36`**,
  as D206 judges R1. The Android tablet keeps being measured at each close,
  its figures and ratios of Must reported beside the two, and its misses
  are recorded with their leads, not stops. Step 56 comes next.
- **Why.** After step 55's three cuts (D213's `Apply_output_engraver`,
  the lengths in Rust, W5's walk) the tablet is at T12 151.7 ms (2.53 of
  Must), T29 650.4 (2.60), T24 512.2 (2.05), T07 130.9 (2.18), ×0.91–0.99
  of the base; the iPhone at 0.38–0.51 of Must and the emulator at
  0.65–0.87 on all four. What is left on the tablet (the image's other
  Scheme engravers, the collector, LilyPond's own `make-unfolded-set`, the
  context path search) is about ×0.85–0.90 natively by the profile, which
  would not bring T12 and T29 under twice there; the tablet runs ≈ 3.0
  times the emulator.
- **Consequences.**
  - D88's translations are within Must on both judged devices at step 55,
    so no D88 step is owed for them; D1's other tablet misses (the first
    restore, D201) are unchanged by this decision, and step 56 reads its
    own on the tablet as its line says.
  - The tablet's misses and their leads stay listed (OPEN C1) for R3's
    split, with the Android tablet's figures at every close.

  progress.md, MS3 step 55; LEDGER.md's *History*.

## D215 — A fresh worker's first restore lists free slots when it reaches them and calls nothing an element

**Status:** accepted (MS3 step 56) · **Refines:** D90, D201 · **Changes:**
`packages/engine/crates/scheme/src/heap.rs`, `image.rs`, `module.rs`,
`regex.rs`, `value.rs`, `packages/engine/crates/core/src/abi.rs`

- **What.** How an image is read and an arena keeps its free slots. The
  image's format, its writer, 08 §4.2's ABI and the studio's driver are
  unchanged, and so is every allocation's index:
  - **A free list holds a chunk as one entry** (`PENDING | chunk`), its
    free slots listed when an allocation reaches it (`Arena::take`), in
    the order a full listing gave them (the lowest index first). A
    restore's and a sweep's `relist` push one entry a chunk, not one a
    free slot (≈ 160,000 of them for `core.image`'s pairs).
  - **A chunk an image left empty has no slots** until the allocator
    opens it (251 of `core.image`'s 829 pair chunks, ≈ 1 MB).
  - **No call an element:** a chunk's slots are made dead at once and
    each live one read into its place; values, instructions, the
    modules' `u32`s and names, a template's children and the symbols'
    flags are read into vectors made first, in plain `while` loops;
    `Value::from_bits` is inlined. At opt-level `z` neither `Vec::push`
    nor `Range::next` was inlined, and Liftoff runs each call in full.
  - **The symbols' names are one text** with each name's end (`Names`),
    read and checked as UTF-8 once, where each name was a `Box<str>` of
    its own (20,015 allocations); the table's hash takes four bytes a
    step, then MurmurHash3's `fmix32` (the hash is the table's alone).
  - **A regex read from an image is compiled when it is first matched**
    (`OnceCell`), as `ly:make-regex` compiled it when it was made.
  - **`lily_start` and `lsb_restore` grow the memory once,** by twice the
    image's length, allocated and freed before the restore, where
    dlmalloc grew it 64 KiB at a time (≈ 130 `memory.grow`s at the
    base); twice is under what `core.image`'s restore takes, so the
    memory after it is what the restore leaves (10,878,976 bytes, the
    base's 12,976,128).
- **Why.** D201's step: `lily_start`'s first restore in a fresh worker on
  the Android tablet was 100.8 ms (48 workers, 2.02 of the 50 ms Must) at
  the base, and a fresh worker's restore runs all of it in Liftoff (V8's
  tiering budget is ≈ 13 MB of executed code a function, more than one
  restore runs), with ≈ 330 functions compiled lazily. What it did that a
  warm restore of the same image does not pay is the free lists, the
  dead slots, the calls an element and the allocations a name.
- **Consequences.**
  - Measured (progress.md, MS3 step 56), medians of 48 fresh workers:
    the tablet 100.8 → 84.0 ms (fast workers 68.8 → 60.6, slow 103.3 →
    88.1), the iPhone 23 → 23, desktop Chromium on the page's
    thread at 4× CPU 50.8 → 42.4, Node 12.99 → 10.56. **The tablet stays
    over Must** (1.68), under twice (D88), and what is left is spread
    over every part: V8's lazy compilation and Liftoff, dlmalloc (≈ 10 %
    of the tablet's profile), the templates.
  - An arena's allocator may list a chunk when it allocates; a free list
    is no longer one slot an entry. Code that takes from a free list
    goes through `Arena::take`.
  - Tried and not kept: the hash tables' index built at once (sorting
    and bulk-building compile lazily too: the first restore was slower);
    the restore split into functions (`wasm-opt -Oz` inlines a function
    of one caller; split with `--no-inline`, the tablet's first restore
    was the same, 84.3 against 83.0 ms).

  progress.md, MS3 step 56.

## D216 — The engine's fused multiply-add is exact without libm's, and the separation items' skylines are a Rust callback

**Status:** accepted (MS3 step 59) · **Refines:** D205 · **Changes:**
`packages/engine/crates/skyline/src/fma.rs`, `building.rs`, `lib.rs`,
`packages/engine/crates/layout/src/geometry.rs`, `axis_group.rs`,
`separation_item.rs`, `skylines.rs`, `callbacks.rs`, `lib.rs`

- **What.**
  - **`lily_engine_skyline::fma`** is the engine's one `a * b + c` rounded
    once, where LilyPond's clang fuses (PROTOCOL §8; the call sites are
    unchanged): `fmadd` on arm64, and elsewhere, wasm among them,
    Dekker's product and Knuth's sum with the low parts added rounded to
    odd (Boldo and Melquiond, IEEE TC 57(4), 2008), which rounds once as
    long as nothing overflows or underflows. Arguments that could (an
    exponent past ±450 for `a` or `b`, past ±900 for `c`, or what is not
    finite) are libm's software `fma`, as before. A debug build checks
    every result against the emulation. Layout's `geometry::fma` is this
    one. The crates still take libm without its `arch` feature.
  - **`%outside-staff-move`** pads the grob's skylines once for each
    horizon padding among `others`, where `Skyline::distance` padded them
    again for each other; the distances are the same.
  - **`ly:separation-item::calc-skylines`** and the boxes it and
    `conditional_skyline` measure are Rust: a callback of D205's table
    under a primitive over `%host-call` (D127), as the clef's are. Its
    pure Y extents still go through the image's `%grob-pure-y-extent`.
- **Why.** OPEN A42 and the user's answer at R2's close: Y2's eight were
  over R1's Must (the iPhone 134.9 µs a live grob, the emulator 224.7),
  and T13's native profile had libm's software `fma` at 17 % of its
  compile. Measured on the eight, the skylines were not the eight's cost
  in wasm (Chromium 179.7 → 177.1 with the first two); the separation
  items' Scheme was (natively 103 of 170 ms of layout under it, its loop
  38 ms of that, `%boxes-skylines` 1.4).
- **Consequences.**
  - Every output of the 30 natively, the traces, `grobs.tsv`,
    `layout.tsv` and the pages in wasm, are the base's byte for byte.
  - R1 on the eight (progress.md, MS3 step 59): native 71.7 → 63.4 µs,
    Chromium 179.7 → 170.6, the iPhone 134.9 → 131.6; still over Must.
  - A callback that LilyPond defines in C++ and the image in Scheme may
    move into the table the same way; its Scheme goes, and a test that
    reaches it through the VM still does, through the primitive.
  - What is left under the separation items is the pure Y extent's
    Scheme (`%grob-pure-y-extent`, `%grob-pure-relative-y-coordinate`;
    31.5 ms self of the 170 natively), a lead for the next step that
    measures R1.

  progress.md, MS3 step 59.

## D217 — `layout.tsv` gives each system a line of its own, and a test gives the engine LilyPond's breaks until it chooses them

**Status:** accepted (MS3 step 60; the recapture approved by the user at
R3's split, answer 5) · **Extends:** D126, D129, D130 · **Changes:**
`packages/engine/tools/compare/{layout.ly,layout.mjs,capture.mjs,core.mjs}`,
`tools/compare/test/layout.test.mjs`,
`tools/compare/fixtures/broken-spanners.ly`,
`packages/engine/crates/layout/src/{paper_score,constrained_breaking,dump}.rs`,
`packages/engine/crates/core/src/{lib,abi}.rs`,
`packages/engine/crates/core/examples/compile.rs`; `$LILY_CORPUS/ref/`

- **What.**
  - **The System's line (OPEN H9).** `layout.ly` writes, before each
    system's grobs, a line of the system itself: grobs.tsv's System line
    for its six fields (the Score's context and `Score_engraver`, which
    the recorder keeps at its finalize), so the systems pair in order as
    a broken grob's copies do; then its index and its page's; `x` and
    `y` its place on its page (the line's `X-offset` and `Y-offset`,
    which page.scm sets, 0 if unset); its extents relative to itself and
    its stencil flag. The engine's traced compile writes it from the
    root System's grobs.tsv line, its seven placed fields unreached: it
    reads no system's place on its page (D126). `layout.mjs` compares it
    as any line; no `COMPARED` holds `System`, and `--all` compares it.
  - **The 42 references and the fixtures in `ref/` recaptured** with
    it: every `layout.tsv` gains its System lines (137 in 52 captures)
    and no other byte of `ref/` changed; `capture.json`, whose `ms` a
    capture always changes, is kept as it was.
  - **Breaks given by a test (`Engine::set_breaks`).** Until step 61's
    breaker chooses them, `calc_breaking` breaks the lines at the breaks
    whose column's `when` (`main grace`, as grobs.tsv writes it) a caller
    gave, each line spaced by `space_line` as `solve` spaces the lines it
    chooses (`ConstrainedBreaking::given_lines`); with none it gives the
    one line, as before. The breaks are a cell of `(lily)`,
    `%given-breaks`, which `paper_score::give_breaks` sets. Given by the
    compile example's `--break <when>`, and in wasm by `lsb_breaks`
    beside `lsb_trace`, the harness's and the tests' (not 08 §4.2's
    ABI); `core.mjs`' `compileInWasm` takes `breaks`. A test takes
    LilyPond's from its capture's `line.tsv` (each system's last column
    but the last system's).
- **Why.** A40's broken spanners and the slices of several systems are
  checked against LilyPond's at LilyPond's breaks before a breaker
  chooses its own, so a difference is the slices', not the breaker's
  (part 5's order). The System's line was H9's, which step 34 left: the
  systems' number and order, and later steps' place on the page, need a
  line to pair.
- **Consequences.**
  - `fixtures/broken-spanners.ly` at LilyPond's breaks: its five
    systems' `grobs.tsv`, `layout.tsv` (689 lines) and `line.tsv` (60)
    LilyPond's on every grob and every reached field, natively and in
    wasm; its page passes C3 and C4 (104 links, |Δ| 0).
  - Every output of the 30 natively is the base's but for the 32 System
    lines the engine's `layout.tsv` gains.
  - The census counts grobs: a test that counts live grobs in a
    `layout.tsv` leaves the System lines aside; the engine's unreached
    counts include the System lines' place (`x`, `y`, `y-extent`) until
    it reads the pages (step 62's T17 reads each System's page and
    offsets).
  - `set_breaks` goes, or stays a test's, when step 61's breaker
    chooses the breaks; the per-edit compile never gives any.

  progress.md, MS3 step 60.

## D218 — Each score's lines are chosen when it is laid out, as `Paper_score::calc_breaking` chooses them, until the page breaker chooses them at the pages

**Status:** accepted (MS3 step 61) · **Extends:** D217 · **Changes:**
`packages/engine/crates/layout/src/{constrained_breaking,page_breaking,paper_score,system,page}.rs`,
`tools/compare/test/layout.test.mjs`

- **What.**
  - **`calc_breaking` is LilyPond's** (`paper-score.cc:108–122`): the
    layout's `system-count`, an exact positive integer, solved into
    that many lines (`Constrained_breaking::solve`), else the best
    number of lines (`best_solution`). A compile still breaks each
    score right after its translation is processed
    (`paper_score::break_systems`, MS3 step 33), before `layout.tsv` is
    written and before the pages; the per-edit compile and the traced
    one alike.
  - **`page-breaking.cc`'s line side is ported beside it**
    (`page_breaking::PageBreaking`): the book's system specs, chunks and
    breaks, each score's `Constrained_breaking` from its chunks'
    starting columns, the configurations of a number of systems among
    the chunks and their compressed line details with their heights,
    and `break_into_pieces` and `systems`. Nothing in a compile calls it
    yet: step 62's `ly:optimal-breaking` drives it, and its
    `break_into_pieces` then breaks the scores at the pages, where
    LilyPond breaks them, in place of `break_systems`' `calc_breaking`.
    The `Page_breaking` that `draw_page` and `make_pages` read
    (`PageBreaking::for_pages`, step 35's) is the same struct without
    its system specs.
  - **`Engine::set_breaks` stays a test's entry** (D217's open
    question): the breaks a caller gives still replace the chosen ones,
    so a test can still check slices at LilyPond's breaks apart from
    the breaker; no compile of the apps gives any.
- **Why.** For a score with no forced page break, LilyPond's
  `Optimal_page_breaking` starts from `set_to_ideal_line_configuration`,
  each chunk's `best_solution`, which `calc_breaking` gives too, and keeps
  it unless the pages are spaced better with more or fewer lines; so the
  lines are LilyPond's wherever its page breaker keeps the ideal ones (T05,
  the one-system scores of the 10, the fixtures) while the page side is
  not ported, and moving the breaking to the pages is one change at step
  62 rather than two.
- **Consequences.**
  - T05 breaks into LilyPond's two systems natively and in wasm, every
    grob, line and System line LilyPond's; `broken-spanners.ly` breaks at
    LilyPond's five without given breaks.
  - Where LilyPond's page breaker chooses otherwise, the lines are the
    ideal ones until step 62: T02 (two lines, LilyPond's three, a
    `\pageBreak` between) and T17 (three, LilyPond's four on two pages,
    `page-spacing-weight`). Where a score's columns are spaced wider than
    LilyPond's (MS4's grobs, R5), a line LilyPond fits may not fit: T08
    (two lines, ragged-right; LilyPond's one) and T25 (two lines, then an
    over-full page warned of twice; LilyPond's one).
  - A score's line breaking warns (`cannot find line breaking that
    satisfies constraints`) when its translation is laid out, where
    LilyPond warns after every score of the book is translated; none of
    the 30 warns it.

  progress.md, MS3 step 61.

## D219 — A book's lines and pages are broken together when its pages are made, by the paper's `page-breaking`, and a traced compile writes `layout.tsv` and `line.tsv` after them

**Status:** accepted (MS3 step 62) · **Extends:** D126, D217, D218 ·
**Changes:**
`packages/engine/crates/layout/src/{optimal_page_breaking,page_spacing,page_breaking,page,paper_book,paper_score,constrained_breaking,dump}.rs`,
`packages/engine/crates/core/src/compile.rs`

- **What.**
  - **`Paper_book::pages` calls the paper's `page-breaking`**
    (`paper-book.cc:769–772`), `ly:optimal-breaking` by default
    (`optimal_page_breaking.rs`: `Optimal_page_breaking::solve` over
    page-breaking.cc's both sides and page-spacing.cc), which breaks each
    score of the book into the lines it chooses (`break_into_pieces`,
    `systems`) and draws them on its pages (`make_pages`). Step 35's
    `one_page` is gone. `ly:optimal-breaking` leaves `PRIMS` (85 → 84),
    Scheme over `%host-call`; `ly:paper-book-pages`, `-systems` and
    `-header` join paper-book-scheme.cc's face.
  - **A compile lays out a translation as far as `Paper_score::process`**;
    its System is broken when its book's pages are made. D218's
    `break_systems` after the translation goes; `Paper_score::
    get_paper_systems` keeps `calc_breaking` for a score the page breaker
    did not break, which no compile reaches. A score is broken once
    (`PaperScore::broken`, set by whichever breaks it first;
    `substituted` once its grobs are substituted).
  - **A traced compile's dump is split at the pages** (D126): before them,
    per translation, the prebroken pieces and `pre_processing` as reads of
    their own and `columns.tsv`; after every book's pages,
    `layout.tsv` and `line.tsv` of each translation in order, as
    `layout.ly` writes them from `page-post-process`: each line's system
    and page counted across the file's books, and each System line's
    place on its page (its line's `X-offset` and `Y-offset`; OPEN H9).
    What the reads after the pages say goes to `trace.log` only, and a
    stop for the host they meet is not asked: LilyPond's `layout.ly`
    reads after the pages' stencils, which have said what drawing says.
    The trace is lent while the pages and those reads run, so that a
    `\score` a markup prints there (`ly:score-embedded-format`) is
    recorded, as it was while a translation was laid out.
  - **`Line_details` of a title's or markup's prob is ported here**
    (`constrained-breaking.cc:576–638`), ahead of step 63's line, since
    the page breaker spaces titles beside systems: without it a title's
    infinite default force made every configuration infinitely bad.
  - **The breaks a test gives (D217) are honoured by the page breaker**,
    at a score's first chunk, in place of its chunks' lines.
- **Why.** LilyPond breaks lines and pages together (T17's
  `page-spacing-weight`, T02's `\pageBreak` between three lines): the
  ideal lines of D218 are only where its page breaker starts. Reading
  `layout.tsv` after the pages is what LilyPond's capture does, so each
  system's page and place can be compared, and a traced page stays the
  untraced one.
- **Consequences.**
  - T17 breaks into LilyPond's four systems on two pages and T02 into
    its three on two, natively and in wasm, every system's page and place
    LilyPond's, their pages C3 and C4 with every delta 0. The 10's other
    outputs and the fixtures' unchanged but the fields now written.
  - T25, whose two lines are wider and taller than LilyPond's three (MS4's
    grobs, OPEN B14), goes on two pages where `one_page` crammed them on
    one with two warnings: the page breaker's choice for those lines.
  - Traced, T29's "crescendo too small" warnings, which only the dump's
    reads of grobs on no page met and LilyPond's stderr lacks, are in
    `trace.log`, not in stderr.
  - The minimum whitespace at a page's top and bottom reads the paper's
    spacing specs once, when the page breaker is made, where LilyPond
    reads them at each call: the same values, one paper.

  progress.md, MS3 step 62.

## D220 — An error of LilyPond's own in `Book::process` or a book's pages ends the run as a translation's does; the engine's gaps still end only that book's pages

**Status:** accepted (the user's answer, 2026-10-24, to MS3 step 64's stop
point (B8): "As D132, gaps exempt") · **Refines:** D130, D132 ·
**Changes, in MS3 step 64:** `packages/engine/crates/core/src/{compile,lib}.rs`,
`packages/engine/crates/core/examples/compile.rs`,
`packages/engine/tools/compare/fixtures/{page-error,book-page-error}.ly`,
`packages/engine/tools/compare/test/c0-cases.test.mjs`

- **What.**
  - **An error of `Book::process`** (`paper_book::process`) that is not
    one of the engine's gaps (D132: a placeholder's `misc-error`, a font
    the host gave no pack of) ends the run before that book: no item of
    it or of the books after it is translated, and after the books before
    it the core prints what D132's `diag::ended` prints, at `init.ly:66:2`
    for the book `init.ly` makes, the error's text for a `\book` block.
  - **An error of a book's pages** (`Paper_book::output`: the page breaker,
    a page's stencil, the paper's `page-post-process`) that is not one of
    the engine's gaps ends the run there: no page of that book or of the
    books after it, the same report after what making that book's pages
    said. LilyPond makes each book's pages before it translates the next;
    the engine translates every book first, so what the later books'
    translations said is taken back (each book's share of the messages is
    counted), and so are their playback maps. The failing book's maps and
    those before it are kept, as `Paper_book::output_aux` writes a book's
    MIDI files before its pages.
  - **No unmet expected warnings and no `failed files:`** after either, as
    after D132's. A translation's error (D132) still drops every playback
    map, as LilyPond writes none then.
  - **The compile example exits with 1** whenever an error ended the run
    (`Engine::ended`), a `\book` block's among them, whose report has no
    Guile error for an expression to find in stderr (D132's exit 0).
  - **The engine's gaps** still end only the book's pages, unreported, as
    D130 has them: until the print callbacks are ported most layouts of
    the 30 stop at a placeholder (R5).
- **Why.** Step 35 left these errors unreported (OPEN B8): a score whose
  header markup or page breaker throws compiled to nothing with exit 0
  and an empty stderr, and a `\book` block's error exited 0. A score's
  own error must reach the studio as LilyPond reports it.
- **Consequences.**
  - `fixtures/page-error.ly` (a header markup throwing as its page is
    drawn): stderr LilyPond's byte for byte, the error at `init.ly` 66:2
    in `diagnostics.json`, exit 1, no page, its playback map kept as
    LilyPond keeps its MIDI file; `fixtures/book-page-error.ly` (a first
    `\book` block's): stderr LilyPond's without Guile's frame, exit 1, no
    page, the second book's warning not printed and its map dropped;
    natively and in wasm (`c0-cases.test.mjs`).
  - The 30's and 42's stderr, `diagnostics.json`, exit and pages
    unchanged (progress.md, MS3 step 64).
  - A score whose pages meet an unbound variable of LilyPond's Scheme that
    the engine lacks now reports it, as it is no placeholder; step 64 found
    `delay` so (D221).

  progress.md, MS3 step 64.

## D221 — Guile's promises are ported, for the labels' `\page-ref` and `\with-link`

**Status:** accepted (the user's answer, 2026-10-24, to MS3 step 64's stop
point (PROTOCOL §6.3): "Port them in step 64") · **Changes, in MS3 step
64:** `packages/engine/crates/scheme/src/{control,prims}.rs`,
`packages/engine/crates/scheme/tests/prims.rs`

- **What.** Guile 3's promises in `(guile)`: `make-promise` of a thunk and
  `promise?` (`promises.c`), a promise a foreign object holding its thunk
  until it is forced, then its value; `force`, which calls the thunk once
  and keeps the first value if the thunk forced its own promise; and
  `delay`, `boot-9.scm`'s macro over `make-promise`. Their type errors are
  Guile's. `crates/svg`'s `delay-stencil-evaluation`, which applied
  `force` where `(guile)` had one, now forces.
- **Why.** Chapter 03 §2.6 counted promises as needed by no file, but
  `define-markup-commands.scm`'s `\page-ref` and `\with-link` and
  `stencil.scm`'s outline whiteout build their stencils with `delay`, to be
  forced once the pages and their labels' page numbers are known: the
  labels (B3) are seen on a page only through them. Without promises a
  score using them failed with `Unbound variable: delay`, reported since
  D220 as the score's own error.
- **Consequences.**
  - `fixtures/page-markers.ly`'s `\page-ref`s print LilyPond's page
    numbers and its `\with-link` LilyPond's link, its pages pixel for pixel
    LilyPond's (progress.md, MS3 step 64).
  - `(guile)` has five more primitives (`make-promise`, `promise?` and
    three of `force`'s); a promise is never in an image, so it needs no
    image format of its own.

  progress.md, MS3 step 64.

## D222 — The driver ties the playback map to a MIDI file, as `read_playback` does, at R8

**Status:** done at MS7 step 8 (D136, D264) · accepted (the user's answer 2 at R4's split, MS5 step 0,
2026-10-24, to runway/PLANS.md R4's G1 question; recorded at MS5 step 7) ·
**Refines:** D103 · **Changes, at R8 (M7):**
`packages/studio/src/web/engine/driver.ts`' `outcomeOf` and
`engine.test.ts`; nothing in MS5

- **What.** D103 left open whether the driver's outcome gives the playback
  map without a MIDI file. It does not, at R8: as the Rust side's
  `read_playback` (`crates/engrave/src/compile_service.rs`) gives
  `timing` only with the first MIDI file's bytes (no MIDI file, no
  timing), `outcomeOf` will give `timing`, entry 0 of the `.timing.json`
  array (D103), only when the outputs hold a `.midi`, beside `midiData`,
  the first of them. MS5 makes the core write what that needs: since MS5
  step 1 each `\midi` performance's `<name>.midi` (then `<name>-1.midi`
  and on, as `write-performances-midis` names them) among the outputs,
  before the `.timing.json`, so the first `.midi` `outcomeOf` finds is
  LilyPond's first, the one `read_playback` reads.
- **Why.** The two sides should give the same outcome for the same
  outputs (D103's reason), and a map without the MIDI file it times
  plays nothing. The change is the driver's, R8's work (M7: the engine in
  the studio), not MS5's: `protocol.ts`, `driver.ts`, `host.ts` and the
  studio's tests changing is a stop point of R4 (PROTOCOL §6.2), and the
  driver already passes the `.midi` as `midiData` unchanged.
- **Consequences.**
  - Until R8 the driver gives `timing` whenever there is a map, and
    `midiData` beside it since MS5 step 1, since every compile of the
    engine writes both (a score without `\midi` is given capture.ly's).
  - R8 changes `outcomeOf` and its tests (`engine.test.ts`: a map with
    no `.midi` gives no `timing`) and compares the two sides' outcomes on
    the corpus. OPEN G1 is R8's.
  - `protocol.ts` and 08 §4.2's ABI are unchanged.

  progress.md, MS5 step 0 (*Settled with the user at R4's split*) and
  step 7.

## D223 — MS4's notation modules are three new crates, `tablature`, `figured-bass` and `chord-names`, which K4 splits from the core; the studio's corpus test is K4's gate

**Status:** accepted (the user's answers 2 and 3 at R5's split, MS4 step 0,
2026-10-25) · **Refines:** D104 · **Changes, in MS4:** the engine's
workspace (`packages/engine/Cargo.toml`), three crates (MS4 steps 16, 17),
`scripts/build.mjs`' `wasm-split` and `scripts/sizes.mjs`' rows (step 20),
`packages/studio/src/web/engine/modules.ts`' triggers and
`packages/studio/test/engine-corpus.test.ts` (steps 20, 22)

- **What.**
  - **Three crates**, each one of 08 §2.4's split modules by the same
    name: `crates/tablature` (`lily_engine_tablature`: tablature's note
    heads and staff symbol, fret diagrams' `Fretboard_engraver`),
    `crates/figured-bass` (`lily_engine_figured_bass`: the figured-bass
    engravers, the continuation, the enclosing bracket) and
    `crates/chord-names` (`lily_engine_chord_names`: chord-name.cc; its
    engraver is the image's Scheme). Each depends on layout and music only,
    and gives its engravers and primitives to the core as layout's
    `CLASSES` and `PRIMS` are given; the core links all three.
  - **K4 (MS4 step 20)** builds the core with names, moves the functions
    reachable only from each crate's entry points into its split module
    with Binaryen's `wasm-split` (08 §2.3), then runs `wasm-opt -Oz` on each;
    the manifest names them as `split`; the driver, which already loads
    split modules and restarts on a placeholder, does not change.
  - **08 §2.4's `ambitus`, `pedals` and `percent` stay in the core** until
    R9, whose engravers they are (OPEN's R9 items); a fourth split module is
    a new decision.
  - **K4's gate is a studio test**: `engine-corpus.test.ts` runs each of
    the 30 through the real driver with only `modulesFor`'s modules and
    fails on a restart, and each module left out once gives a restart and
    the same outputs. `modules.ts`' triggers change only where a score of
    the 30 would restart. `protocol.ts`, `driver.ts`, `host.ts` and the
    studio's other tests stay R5's stop point (PROTOCOL §6.2).
- **Why.** 05 §5.10 puts tablature, figured bass and chord names among the
  notation large in code and rare, 08 §2.3 has a module follow the call graph
  from its own crate, and building them as crates from their first step
  moves no code between crates at K4. The gate (README §5, MS4) is about the
  driver's restarts, which only a test through the driver sees; that test is
  the studio's, and the user approved changing it for K4.
- **Consequences.**
  - `sizes.mjs` charges each crate to a row of its own against 05 §9's
    100 / 40 KB brotli a module.
  - A crate needing more than layout and music, a fourth module, or a
    change to `protocol.ts`, `driver.ts` or `host.ts` stops for the user.
  - S6's `chords` and `fretted` Scheme stays data (08 §2.2's first kind):
    manifest parts at step 20, so the page needs no `<datadir>` files for
    them (OPEN I2).
  - **MS4 step 7a** (2026-10-26, the operator's ask) made `crates/tablature`
    ahead of step 17, with `Tab_note_heads_engraver` and
    `Tab_staff_symbol_engraver`; the core passes its `CLASSES` after
    layout's. It also depends on `crates/scheme`, whose `Value` and
    `Exception` layout's and music's interfaces are written in: "layout and
    music only" read as the engine's crates it builds on above the VM.
    **Confirmed by the operator** (2026-10-26, asked after step 7a): the
    crate kept, the scheme dependency allowed under this decision.

  progress.md, MS4 step 0 (*Settled with the user at R5's split*).

## D224 — W6's rest is built in the core in MS4; text no pack covers is measured by `OffscreenCanvas` at R8, and T20's C4 is judged under README's R11 until then

**Status:** accepted (the user's answer 4 at R5's split, MS4 step 0,
2026-10-25) · **Refines:** D209, D210 · **Changes, in MS4:** the text path
of `crates/fonts` and `crates/layout` (MS4 step 19) and the gate's tests
(steps 18, 22); at R8, the studio's worker

- **What.** MS4 builds W6's rest in the core, over the packs: Pango-style
  runs by script, font fallback through the packs' faces, the missing
  character's name as LilyPond writes it, and the shaping check of every
  text grob of the 30 against LilyPond's. Measuring text that no pack
  covers with `OffscreenCanvas` (06 §5.3) is the worker's, so R8's, with
  the studio's driver (PROTOCOL §6.2 keeps `driver.ts` and `host.ts` until
  R8). Until then **T20's C4 is judged as README's R11 allows**: the grobs
  whose text no pack covers (T20's Hebrew and Japanese lyrics) are compared
  apart and recorded, and the rest of T20 is held to the gate's Δ.
- **Why.** T20 (utf-8.ly) asks for Linux Libertine O and Noto Serif CJK JP
  through fontconfig; no pack holds them, and the core alone cannot
  measure what it has no metrics for. R11 already accepts that C4 may
  differ near such text; a worker change before R8 would stop R5 on the
  studio's files.
- **Consequences.**
  - A score failing C4 only where its Latin, Greek or Cyrillic text is
    placed still stops (PROTOCOL §6.6): only text no pack covers is R11's.
  - R8 adds `OffscreenCanvas` measuring and judges T20 whole.

  progress.md, MS4 step 0 (*Settled with the user at R5's split*).

## D225 — The code rows of `sizes.mjs` are judged by origin: wasm-opt's inlining and its bodies of no name are charged to the code they came from

**Status:** accepted (the user's answer at MS4 step 6a, 2026-10-25, to OPEN
H4's retrace) · **Refines:** D200's budgets as PROTOCOL §4.4 reads them ·
**Changes:** `packages/engine/scripts/sizes.mjs` (MS4 step 6a)

- **What.** `sizes.mjs` gives core.wasm's code by origin beside its code by
  name, and the closes judge each code row (README §4.1's shares, PROTOCOL
  §4.4's twice Must) by origin. From the core as rustc wrote it
  (`target/wasm32-unknown-unknown/wasm-names/`) and both call graphs, read
  with Binaryen's `wasm-dis`: a function keeps its own code and, by their
  sizes before wasm-opt, that of the functions gone from the optimised core
  that it reaches through gone functions only (those wasm-opt inlined into
  it), unless a gone function's body is a kept one's (duplicate
  elimination); a gone function's code is charged to its own row if that is
  an engine crate's, else it stays the holder's, as a generic instance an
  engine crate made does by name. The functions of no name,
  merge-similar-functions' shared bodies, are shared among their callers'
  origins by call site. A row's brotli bytes by origin are estimated at its
  functions' ratio by name. The table by name stays as it was.
- **Why.** wasm-opt -Oz inlines a function of one call site into its
  caller whatever rustc was told (`#[inline(never)]` reaches LLVM only), so
  the driver row by name held the traced compile's dump, layout's
  `font_select` and the music crate's performance: `lily_step` 45,659
  bytes, 25,876 of them other parts' code. By name the row grew 2.05 of its
  brotli Must at MS4 step 6 for `dump::shapes`, code of the layout crate.
  The DWARF line tables of the same build show LLVM's own inlining into the
  core's functions is 656 of their 61,965 bytes, so the call graphs of
  wasm-opt's input and output account for nearly all of it.
- **Consequences.**
  - At MS4 step 6's build the driver row is 105,801 raw / ≈ 42,251 brotli
    by origin (1.32 / 1.41 of Must, under twice) against 154,287 / 61,614
    by name; the layout row 831,877 / ≈ 269,270 (under Must); the music
    row's brotli ≈ 113,117, over its Goal (by name 109,971).
  - The report needs Binaryen's `wasm-dis` beside `wasm-opt` (the
    `WASM_OPT` directory, else the PATH) and the build's rustc output;
    without them it prints the table by name only and says so.
  - OPEN H4 is closed: the bodies of no name are retraced at every build,
    not by rebuilding old cores.

  progress.md, MS4 step 6a.

## D226 — The `libm` crate's `atan` is kept, an ulp from macOS's on about 3 % of arguments

**Status:** accepted (the operator's answer at MS4 step 9, 2026-10-26, the
recommended option) · **Refines:** OPEN E8's answer for `sin` ·
**Changes:** `tools/compare/test/layout.test.mjs`' tie probe (MS4 step 9)

- **What.** `bezier.rs`' `slur_shape` (a tie's and a chord slur's curve)
  keeps the `libm` crate's `atan`. LilyPond 2.26.0 calls macOS's `_atan`
  (`slur_height`, `lilypond-otool.txt`); the two differ by one ulp on
  63,940 of 2,000,000 arguments sampled (half over the ties' widths 0.3 to
  80 through `slur_height`, half over −100 to 100), and neither is correctly
  rounded: of 2,000 of the differing ones the `libm` crate's is the
  correctly rounded value 1,494 times and macOS's 506 (Python's `decimal`
  at 60 digits), and of 2,000 where they agree 26 are both off. No
  correctly rounded `atan` would give macOS's.
- **Why.** macOS's `atan` (libsystem_m) is piecewise polynomials over
  intervals of |x| with a separate path above 2; only its own coefficients
  would give its results, and they are Apple's proprietary code, which the
  GPL engine does not copy (E9's `hypot` was a formula, not a table). The
  difference is far below C5's 0.25 staff spaces and C4's tolerances.
- **Consequences.**
  - A tie's control points (and a chord slur's) may be an ulp from
    LilyPond's in Y where `atan`'s last bit differs: of fixtures/ties.ly's
    82 ties at step 9, one (`ties.ly:64:39`). The tie probe compares to the
    last bit and allows only the ties it names, within 1e-12.
  - A gate that fails only by `atan`'s last bit stops for the user, as
    E8's `sin` does (OPEN E21).

  progress.md, MS4 step 9.

## D227 — T20's lyrics in a font the capturing machine's fontconfig chose are judged under R11 with its Hebrew and Japanese ones

**Status:** accepted (the operator's answer at MS4 step 15, 2026-10-26, the
recommended option) · **Refines:** D224 · **Changes:**
`tools/compare/test/layout.test.mjs` and `grobs.test.mjs` (MS4 step 15),
T20's judging at steps 18, 19 and 22

- **What.** T20 (utf-8.ly) sets `property-defaults.fonts.serif` to
  `"Linux Libertine O, Noto Serif CJK JP, Noto Serif JP, serif"`. None of
  those families is installed on the machine that captured its reference,
  and LilyPond's fontconfig resolved the list to that machine's
  `/System/Library/Fonts/Supplemental/Times New Roman.ttf`
  (`ly:font-config-get-font-file`, MS4 step 15). Its Cyrillic and
  Portuguese lyrics were measured in that font, its Hebrew and Japanese in
  the system's fallbacks. The engine's packs hold neither, so all four
  lines of T20's lyrics, not only the Hebrew and Japanese ones D224 named,
  are compared apart and recorded. The rest of T20 is held to the gate's Δ
  where its line breaking allows, and its grobs.tsv, which no font reaches,
  to LilyPond's every line.
- **Why.** The reference depends on a system font of the capturing machine,
  a non-free font no pack may hold. No part of W6 (runs, fallback through
  the packs) would reach it, so bringing step 19 forward would not change
  T20. Re-capturing with C059 would change a reference (PROTOCOL §6.4) to
  one LilyPond on this machine does not print.
- **Consequences.**
  - At MS4 step 15, T20's lyric grobs are LilyPond's in grobs.tsv (its 185
    lines whole), and its layout.tsv and pages differ from its first
    LyricText on: its widths make other line breaks. It is not in
    layout.test.mjs' lyric test.
  - D224's stop holds for every other score: a Latin, Greek or Cyrillic
    text set in a pack's font that fails C4 only where it is placed still
    stops (PROTOCOL §6.6).
  - Step 19 (W6's rest) and R8 (`OffscreenCanvas`) re-judge T20. A score
    whose text the capturing machine's fontconfig resolves outside the
    packs is judged so too, named in its step's entry.

  progress.md, MS4 step 15.

## D228 — A part a `\layout` translation's grobs name is loaded after the translation, before its layout, and the host asked for its files there

**Status:** accepted (MS4 step 17, 2026-10-26; OPEN A46) · **Refines:** D74,
D126 · **Changes:** `crates/scheme/src/lily.rs` (`%load-stubbed-parts!`),
`crates/core/src/compile.rs` (`load_parts`, the stop after `translate`),
until K4's manifest parts (MS4 step 20)

- **What.** After each `\layout` translation, once its Paper_score is
  rooted, the core calls `(%load-stubbed-parts! definitions)` with the
  distinct definitions of the grobs it made: each part a value of them is
  a stub of (D74) is loaded, as LilyPond's layout finds every file loaded.
  A part whose files the host has not given cancels the run there; the
  compile drops what it made and asks for the part's files with
  `NEEDS` (`FILE`), as a parse's include, then is compiled again. Only a
  definition's own values are looked at, not procedures they call.
- **Why.** The `fretted` part's `tab-note-head::print` and `::handle-ties`
  are first called during a TabStaff's layout, where the core asks the
  host for nothing (D126: a layout's stop is the layout's, which ends
  unreported), so since MS4 step 7a a TabStaff with notes gave no page. A
  layout that asks would break D126 and stop mid-layout; predicting before
  it, as W5 predicts the packs (`want_fonts`), keeps both.
- **Consequences.**
  - T22, fixtures/tab-note-heads.ly and fixtures/tablature.ly lay out
    (MS4 step 17); a score of TabNoteHeads compiles with one more stop the
    first time (`fretted`'s three files), none once the part is loaded.
  - Every other score of the 42 and every fixture: outputs byte for byte;
    their grobs name no stub, or a part already loaded.
  - The call is after the Paper_score is rooted: the Scheme call can
    collect, and before it the Paper_score is held by no root (a first
    version lost T22's System so).
  - At K4's split (MS4 step 20) the parts become the manifest's (D223);
    the stop then asks for a module, not files.

  progress.md, MS4 step 17.

## D229 — Guile's arrays in the engine's Scheme, as LilyPond's Scheme calls them

**Status:** accepted (the operator's answer at MS4 step 17, 2026-10-26, the
recommended option) · **Changes:** `crates/scheme/src/array.rs`,
`crates/scheme/src/reader.rs` (`Array`'s printing),
`crates/scheme/tests/prims.rs`, `tests/image.rs`

- **What.** `make-array`, `array-ref`, `array-set!`, `array->list` and
  `array?` over the reader's `Array` (MS1), as Guile 3.0.11 gives them: an
  array of one dimension from 0 is a vector; bounds a length or `(lower
  upper)`; Guile's errors, which name no procedure (`Value out of range ~S
  to ~S: ~S`, `wrong number of indices, expecting ~A`, `Wrong type
  (expecting array)`, `bad array bound`); an `Array` printed as Guile
  prints it, every lower bound once one is not 0 (`#2@1@0(…)`) and a
  zero-rank array `#0(x)`. Verified by the prims table against `guile`
  and by LilyPond's own Guile.
- **Why.** `translation-functions.scm`'s `determine-frets` makes a
  FretBoard's barres with `(make-array 0 '(0 4) 4)` (`barre-list`); without
  arrays any FretBoard from notes ended its compile (`Unbound variable:
  make-array`). The fixture the step line asks for has them; no score of
  the 42 does. Stand-ins in `(lily)`'s prelude would not be Guile's
  `array?` nor print as it.
- **Consequences.** Strings and bytevectors are arrays to `array?` alone;
  `array-ref` of them, Guile's typed arrays and shared arrays are not
  ported. The image test's expected printing of `'#2@1@0((1 2) (3 4))` is
  Guile's now (`#2@1@0…`, where the engine had printed `#2@1…`).

  progress.md, MS4 step 17.

## D230 — The figured bass stays in the core; K4 splits the tablature and the chord names

**Status:** accepted (the operator's answer at MS4 step 20, 2026-10-27, the
recommended option; amends D223) · **Changes:**
`packages/engine/scripts/split.mjs` (`SPLIT`), `scripts/build.mjs`,
`scripts/sizes.mjs`, `packages/studio/src/web/engine/modules.ts`

- **What.** `wasm-split --multi-split` moves the functions reachable only
  from `crates/tablature` and `crates/chord-names` (the call graph of the
  core with its names, before `wasm-opt`: `split.mjs`) into
  `tablature.wasm` and `chord-names.wasm`, which the manifest names as
  `split`; `crates/figured-bass` stays a crate of its own, linked in the
  core, measured there against 05 §9's module budget. `modules.ts` loses
  the `figured-bass` trigger.
- **Why.** LilyPond's `Staff` consists `Figured_bass_engraver` and
  `Figured_bass_position_engraver` (`ly/engraver-init.ly:91–92`), so every
  score with a staff makes both engravers and calls their class's
  initialiser and timestep methods, all in the crate: split, the module is
  a restart for every one of the 30 (found by the K4 test, the first Staff's
  `Slot::of_class`). Kept in the core it costs ≈ 5.2 KB brotli (the split
  of all three gave a core of 792,356 brotli, the split of two 795,624),
  and no restart. Shells of the two engravers in the core, the figures'
  work in a module, would move code between crates for those 5 KB: not now.
- **Consequences.** K4's gate on the 30 is the tablature's (T22 calls it)
  and the chord names' (T05 loads it by `\chordmode` but makes no
  ChordName; `fixtures/tablature.ly` calls it). The split's exports keep
  functions alive that `wasm-opt` would inline, so the core with two
  modules split is about 500 brotli bytes larger than unsplit; the names
  wasm-split exports them by are shortened (`split.mjs`' `shortenNames`).

  progress.md, MS4 step 20.

## D231 — The engine's D113–D119 are D126–D132

**Status:** accepted (R6, the operator's answers of 2026-10-27; carries out
D200 and D202) · **Changes:** `docs/DECISIONS.md`, progress.md, the runway,
05-layout.md, comments in `packages/engine/`

- **What.** The engine's seven decisions that shared their numbers with
  `main`'s take the numbers after `main`'s last, D125 (D124 the updater,
  D125 `packages/separate`), in the same order:

  | was | is | what |
  |---|---|---|
  | D113 | D126 | `layout.tsv`'s `?`, the Y extent read before breaking |
  | D114 | D127 | `%host-call` dispatches by its `what` |
  | D115 | D128 | `columns.tsv`: the springs and rods |
  | D116 | D129 | the prebroken pieces, `line.tsv` |
  | D117 | D130 | every compile lays out and breaks the System |
  | D118 | D131 | the page path's six functions |
  | D119 | D132 | a translation's error ends the run |

  Every citation of them follows: their headings and cross-references
  here, progress.md, the runway, the chapters and the comments of
  `packages/engine/` (363 in 89 files, comments only), the "next free
  D-number" lines of MS3's entries among them. Left as written: D200's
  and D202's text and the runway's R6 rows (GRAND-PLAN, README, PLANS),
  which name the old numbers to say what is renumbered, and PLANS.md's
  D112–D115, which are `main`'s. D1–D111 and D200 and up keep their
  numbers; D112–D125 are `main`'s.
- **Why.** `feat/engine` and `main` both took D113–D119 (D200); once they
  merge, one number must name one decision. `main` is the branch the merge
  lands on and its numbers are already on `origin/main`, so the
  engine's move (D202).
- **Consequences.** In the engine's docs and code, D113–D125 now mean
  `main`'s decisions; a D113–D119 of the engine met in a commit before
  R6 (its message, or a file as it was) is D126–D132. New decisions of the
  engine still take D200 and up; the next free is D232.
- **In the merged log** (R6's merge of the engine into `main`) the entries
  stand in number order: the engine's D57–D111, `main`'s D112–D125, the
  engine's D126–D132, then D200 and up. The apps' next free number is
  D133, and their entries go before D200; the engine's go at the bottom.

  runway/PLANS.md, R6.

## D232 — R7 adds W8's cell-replacing message to the engine's protocol and the preview; the studio's page stays R8's

**Status:** accepted (the operator's answer 3 at R7's split, MS6 step 0,
2026-10-27) · **Refines:** D223's stop point (PROTOCOL §6.2, §6.8) for R7
· **Changes, in MS6 step 10:** `packages/studio/src/web/engine/protocol.ts`,
`worker.ts`, `packages/common/web/preview.js` and `preview.d.ts`,
`packages/studio/src/renderer/preview.ts`, `packages/studio/test/engine.test.ts`
and the renderer's preview tests

- **What.**
  - **One new message** in `protocol.ts`: the cells of a page the preview
    already shows, replaced by digest (06 §6.4). The engine's pages wrap
    each cell in `<g data-lily-cell="DIGEST">` (W4); a page whose cells all
    changed, or a new page, is still sent whole.
  - **Carried, not otherwise changed:** `worker.ts` sends it from the
    engine's outputs; `driver.ts` and `host.ts` pass it on and change no
    other behaviour.
  - **Handled in the preview:** `packages/common/web/preview.js` (with its
    `.d.ts`) replaces the cells in a page it shows, and the studio's
    renderer `preview.ts` wires it; their tests and the studio's
    `engine.test.ts` change with it. The extension's own use of
    `preview.js` is unchanged.
  - **The studio's page** (H2: D58's port to `ScorePreview`) stays R8's;
    B6's page phase is measured on the engine's harness page.
- **Why.** README §4.3's page phase (50 ms) holds only if the preview
  updates the changed cells, not the page (06 §6.4; 09 §4.4: four pages at
  once took 95–105 ms on the tablet); W8 is MS6's (README §5), and its gate
  measures B6 phase by phase.
- **Consequences.** Any other change to `protocol.ts`, `driver.ts`,
  `host.ts` or a studio test stays a stop point until R8. The message is
  the one R8's page will use.

  progress.md, MS6 step 0 (*Settled with the user at R7's split*).

## D233 — B6 is read on the iPhone and the emulator, the Android tablet beside; R7 attaches the devices at MS6's gate and close only

**Status:** accepted (the operator's answer 5 at R7's split, MS6 step 0,
2026-10-27) · **Refines:** D206 (R1), D214 (D88) · **Changes:**
runway/PLANS.md R7, MS6's step lines 12 and 13

- **What.**
  - **B6** (README §4.3, by phase; T02, T12, T24 and T29 × E1–E3 × 20) is
    judged on **the iPhone** and **the emulator
    `mother_api36`**, as D206 judges R1 and D214 D88; the Android tablet is
    measured and reported beside them, its misses recorded, not stops.
  - **The devices are attached at MS6's gate (step 12) and close (step 13)
    only.** The parts' closes (steps 3, 7, 9, 11) measure natively and on
    desktop Chromium and WebKit, and on the emulator where a step names
    it.
  - B6's decision point (README §5) stops when B6 is over Must on either
    of the two.
- **Why.** The tablet has stayed four to five times R1's Must since D206,
  so a B6 read on it would stop without a lead; the parts' closes judge
  incremental compiles against from-scratch ones, which no device changes,
  and the per-edit phases natively and on the desktop are enough to steer
  the parts.
- **Consequences.** MS6's budgets between steps 1 and 11 are the desktop's
  and native; the first device figures of an incremental compile are step
  12's.

  progress.md, MS6 step 0 (*Settled with the user at R7's split*).

## D234 — Until the re-parse, a compile is one item of S5's undo log, undone after it; a part's load is not logged

**Status:** accepted (MS6 step 2, 2026-10-27) · **Refines:** D74 (parts on
demand), MS4 step 14's options reset (C2.2) · **Changes:** `crates/scheme`'s
heap and slots, `crates/core/src/compile.rs`

- **What.**
  - The Scheme heap's write barrier (R11) is in the accessors that give a
    mutable object (`set_car`, `set_cdr`, `str_mut`, `vector_items_mut`,
    `foreign_mut`) and in the slots' `define`, `set!` and `export`; it logs
    an object older than the current item at its first change in the item,
    a slot at its first change, and `Vm::undo` gives them back, the latest
    first, each slot with a new version. Foreign objects are logged by
    `Foreign::snapshot`, which the Scheme crate's mutable types give (hash
    tables, fluids, promises, GOOPS instances, arrays); ports and the other
    crates' types give none and are not undone.
  - **The core's compile is one item** from its parse to its last output,
    undone when it ends and when it stops for the host, until step 3's
    re-parse makes the parser's toplevel items the items (02 §5.7).
  - **A part a stub loads is not logged** (`%undo-suspend!` and
    `%undo-resume!` around `%load-part!`): it stays loaded after the undo,
    as the image's parts are, and what it allocated is older than what the
    item changes after it (a new epoch). `session-terminate` and
    `ly:reset-all-fonts` still run after each compile for what the log
    does not reach.
- **Why.** A compile's effects on older state outlived it: a stopped
  parse's cached colour lost T27's warning in a fresh engine (OPEN C7), and
  an option or a global a score set stayed for the next compile. With every
  compile undone, a compile in a row starts where a fresh engine's starts,
  which the differential harness asks; a part's load undone would be
  loaded again by every compile.
- **Consequences.** C7 closed and C2.2 settled by the log. The log holds
  some 36,000 heap entries after T29's compile in a row (young objects in
  older chunks' free slots report the chunk's epoch and are logged, as 03
  §5.1 allows); its memory is MS6 step 11's to measure. Compiles in a row
  natively within 5 % of before.

  progress.md, MS6 step 2.

## D235 — A parse keeps segments between restartable boundaries as items of the undo log; an edit's parse does the segments before it again from what undoing them kept

**Status:** accepted (MS6 step 3, 2026-10-27) · **Refines:** D234 (a
compile is one item), D80 (the host's files), D92 (templates) ·
**Changes:** `crates/parser/src/reuse.rs` (new), the parser's lexer, Env and
toplevel loop, `crates/scheme`'s heap and slots (the redo half), the core's
compile

- **What.**
  - **Segments and boundaries.** The core's parse (`parse_again`) runs its
    toplevel items in items of the undo log, one a *segment*: the items
    between two *boundaries*, places at the top of the toplevel loop where
    the lexer alone could start the parse again. A boundary is one when the
    main file is read with nothing pushed, included or waiting, no mode or
    recovery open, nothing unread on Guile's error port, and the lookahead,
    if one was lexed, said nothing, is no `$` form and would be lexed alike
    now (an assignment of music defines after its lookahead, so `\y` after
    `y = { c4 }` is the `y` before; `\language` changes the words). The
    parser's state there is recorded (02 §3.3's: the default duration and
    tremolo, the pitch names' language, `\version`, the file's failure;
    what was said, made and included), with the last byte examined, the
    lexer's position.
  - **The redo half of the log.** `Vm::undo_keeping` undoes an item as
    `Vm::undo` does and keeps what each object and slot it gives back was
    at the item's end; `Vm::redo` puts that back in a later item, through
    the barrier, each slot with a new version. What is kept is a root until
    `Vm::forget_redo`.
  - **The compile.** The parse's segments come first, then the compile's
    own item from the end of the parse to its last output. When the compile
    ends or stops, its item is undone, then the segments the latest first,
    keeping their ends (`Reuse::undo`); so the next compile starts where a
    fresh engine's starts, as under D234. The next parse of the same file
    does again (`Vm::redo`), each in an item of its own, the segments that
    end at a boundary examined before the first byte that differs, and
    parses from the boundary after them in the same module, with the state
    recorded there. A file of another name, an included file the host now
    has otherwise (`Engine::put`), or no boundary before the edit, parse
    from the start.
  - **The file's Env is made outside the segments** (its module, `%parser`):
    the module stays the file's between compiles, and `%parser` is the
    parse's own while it runs. `%parser` is set unlogged
    (`Vm::module_define_unlogged`): each Env gives the one before back
    itself, and an undo giving a template's change back left a parser that
    had been collected (a debug build's `a dead object` after 40 compiles in
    one engine, c1.test.mjs' G8).
  - **The music crate's mutable types are logged** (`Foreign::snapshot` of
    Music, Prob, Score, Book, OutputDef and ContextMod; D234 left them out):
    a translation that changes music a kept segment made (a property set,
    a frozen node thawed) is undone with the compile, so the segment done
    again has its music as its parse made it. Found by the wasm harness:
    T29's `delete-1-2` lost a stem tremolo's beams in the compile that
    stopped for its packs and did its segments again.
- **Why.** 02 §5.7's steps 1 and 2: the work per edit starts at the first
  item the edit can change. Doing the kept items again from what undoing
  them kept, rather than leaving them done, keeps D234's guarantee that a
  compile starts where a fresh engine's does, which the differential
  harness asks, and needs nothing of the translation's effects on the
  parse's objects. The lookahead's check is where a fresh parse and a
  restarted one could lex differently; the harness's edits did not reach
  it, a test does.
- **Consequences.** A compile that stops for a file or a pack parses again
  from the boundary before the stop. A parse after an edit at the top of a
  file parses it all but what D237 takes. 02 §5.7's steps 3 and 4 came in
  the step's second session: D237.

  progress.md, MS6 step 3.

## D236 — A template's `\include` reads the host's files through the VM; `include` is Guile's macro

**Status:** accepted (MS6 step 3, 2026-10-27) · **Refines:** D80, D92 ·
**Changes:** the parser's lexer and Env, `crates/scheme` (`include`, the
file source), the core

- **What.**
  - **The include search still asks one candidate a stop** (OPEN F):
    asking every candidate at one stop asks the host for
    `<datadir>/ly/<name>` beside a score's own file, which the studio's
    driver test (`engine-corpus.test`) asserts it does not: a studio test's
    change, PROTOCOL §6.2's stop point until R8. **The operator's answer
    (2026-10-27): open until R8** (OPEN F).
  - **A template's `\include`** (OPEN F, D92's consequence): the core gives
    the VM a file source (`Vm::set_file_source`) that answers as the root
    parse's include does; a template's parse reads its files from it,
    looked for beside the file the template is in. A file it must ask for
    stops the parse running the template too (`Vm::wait_for_host`, as a
    part's file does).
  - **`include` is Guile's syntax transformer in `(guile)`** (OPEN F): an
    `\include` read again in the `incl` state is looked up, and printed
    `#<syntax-transformer include>` as LilyPond prints it. Expanded, it is
    Guile's error for a file it cannot open (`./name` for a relative name),
    as the engine's Scheme reads no files.
- **Why.** A template's include was an unknown command; the `incl`
  state's lookup printed `#<undefined>`. Each is LilyPond's now, compared
  with LilyPond 2.26.0's stderr.
- **Consequences.** T19's search for `articulate.ly` is still two of its
  three stops; a parse after a stop does its segments before it again
  (D235), so its last parse is 0.07 ms where it was 2.1.

  progress.md, MS6 step 3.

## D237 — An edit's parse takes over the segments after it and the braced blocks before it, where nothing it changed can reach them

**Status:** accepted (MS6 step 3, 2026-10-28) · **Refines:** D235 ·
**Changes:** `crates/parser/src/reuse.rs`, the lexer, `notes.rs`'
`music_list`, `crates/scheme`'s heap (epochs), slots (versions) and
`Vm::module_value`

- **What.**
  - **The segments after an edit** (02 §5.7's step 4). At a boundary of
    the parse that is one of the last parse's, from the line break that
    ends the edit's last line on, the old segments from it are done again
    (`Vm::redo`), not parsed, while each read every variable at the version
    it read it at; their messages (indexes of inputs moved), items and
    included strings are the old parse's; then the parse goes on at the
    boundary after them, in its state there. Only when the edit moved no
    byte and no line after it (a taken-over segment's music keeps its
    places), the parser's state at the boundary is the old one's, and the
    segments parsed again since the start changed no object older than
    them for good (`Vm::changed_since`: a fluid set and given back is
    unchanged) and wrote the variables their old ones wrote, the file's
    alone: an old segment's reads of an object's contents, or of a
    variable it looked for and did not find, are then what they were.
  - **The braced blocks** (02 §5.7's step 3). A `{ … }` or `<< … >>` whose
    parse kept no value, read no form, lexed no string, said nothing and
    logged nothing is recorded with the state it was entered in (the
    lexer's modes, the pitch names, the default duration and tremolo) and
    the state it left. In an item parsed again, the last parse's block at
    the same place, before the edit or past it as a taken-over segment
    would be, entered in the same state, is taken: its music's syntax, the
    lexer after its close, the default duration it left. Such a block
    looked nothing up and ran no Scheme, so it depends on nothing else, and
    its syntax holds no index of the parse it was made in; music is made
    from the syntax afterwards, as for a block parsed, so nothing a music
    function did to it is shared.
  - **What they need of the interpreter.** An object put into an older
    chunk's free slot reports the epoch it was put in (a chunk's `young`
    bits), so an item that only allocates logs nothing. A slot's version is
    one no slot has had (a counter for all), and a redo gives a slot back
    the version it had at the item's end: a read of it then has the version
    it had. `Vm::module_value`, the parser's lookup of a `\name`, records
    the read.
  - **What a boundary examined.** The lexer keeps the furthest byte of the
    main file it or the reader looked at, the end of the text after a form
    whose read failed; a boundary's examined byte is past it, and past the
    byte after (a token's end is known by the byte after it).
- **Why.** E1 on T29 parsed the 23 segments from the edited variable on,
  most of which no edit of it reaches; the guards are each where a fresh
  parse and a taken-over segment could differ: a test for each fails
  without its guard. The examined byte was the lexer's position: a form
  whose read failed left it at the form, and a later edit inside the form
  had its segment done again with the failed read (part 1's seeded run,
  seed 2: T16, T22).
- **Consequences.** An edit that keeps its length (a pitch, most of E1)
  parses the edited item and the items reading what it changed; one that
  moves text parses from it to the end, the blocks before it in its item
  taken. A block with an articulation, a dynamic or a `\name` (most of the
  30's) is parsed again. Measured in progress.md, MS6 step 3.

  progress.md, MS6 step 3.

## D238 — N8's checkpoints are digests kept per compile, and a translation finds its change and convergence from them before it resumes from one

**Status:** accepted (MS6 step 4, 2026-10-28) · **Refines:** 04 §10.1,
§10.2, §10.5, §10.6 · **Changes:** `crates/music/src/checkpoint.rs` (new),
`global.rs`' loop, `iterator.rs` (an iterator made, the iterators'
digests), `translator.rs` (`Group::state`), `frozen.rs`' value digest,
`crates/scheme`'s `Heap::closure_parts`, `crates/core`'s
`Engine::changes`, `set_check_n8`, `n8_wrong` and the compile example's
`--n8`

- **What.**
  - **What a translation keeps** (`Kept`, no Scheme value in it, so it
    outlives the compile's undo, D234): the score's music shape in
    preorder, each node's digest of its kind and own properties without
    `origin` (and without the `length` cached on music that holds music),
    of its subtree, and the moment its iterator was made (a node in a
    simple iterator's music, that iterator's); the state after the first
    `Prepare` (`start`, what the output definition gave the contexts);
    each timestep's moment, the digest of the music whose iterators it
    made (its input) and of the records made at it once the translation
    ends (its output); a checkpoint after the `Prepare` of each timestep
    that starts a bar (the Score's `measurePosition` zero) or is the
    eighth since the last: its moment, the digest of the state there, and
    of the music its iterators have left (its future).
  - **The state's digest:** the contexts in number order with parent,
    children, name, id and properties (a sum, in no order), each
    translator's flags and the Scheme values it holds (`Work::values`), the
    moments translators asked for, and the iterators below the top with
    their starts, contexts, own nodes and how far a sequence is.
  - **A value's digest is of its contents, the same in the next compile:**
    a grob or an audio record as the moment it was made and its place among
    that moment's records, a context by its number, music by its digest, a
    closure by its code (`Heap::closure_parts`: its template's name,
    arguments, instructions without the globals' slots the VM rewrites,
    constants and children) and its free values, an unpure-pure container
    by its procedures, a place in the input not at all, grob properties by
    their alist, any other object as `write` writes it. An audio note's or
    staff's records by their places too.
  - **What a compile finds** (`compare`), against the last compile of the
    same root that ran to its end, translation by translation in order:
    `m_e`, the old start of the first node that differs (from the front
    and from the back of the shapes), or of its nearest ancestor with one;
    the node itself where it holds more or fewer pieces of music and is no
    plain sequential or simultaneous music (a repeat reads its
    alternatives when it starts), or reads its length when it starts and
    that differs (a repeat, an alternative, a tuplet); the element before
    it in a sequence where the changed element's grace time can differ
    (elements added or removed, or grace music in it: the sequence looks
    at it as the one before ends); the start where `start` differs. The
    last checkpoint strictly before `m_e`, to resume from. The first
    checkpoint of the new run past every changed node of both runs whose
    state and future are the old run's at the same moment, to converge
    at. The change list with the score as one partition: the timesteps
    between whose output differs, and the old run's the new one lacks.
  - **Checked against whole runs** (`verify`, the harness's `--n8`): the
    checkpoints and inputs before `m_e`, and from the convergence on every
    timestep's moment, input and output and every checkpoint, equal.
- **Why.** The digests are what N8's resume and splice rest on (step 5's
  rest): they must be shown right on the 30 before any reuse can hide a
  wrong one, as the harness came before S5. Each rule above is one the
  harness's check found missing: a closure's printed number, new with
  each compile (a `\time`'s `ApplyContext`), an unpure-pure container
  printed with its closures, the `length` a reflow changes on every
  container above it, an iterator's whole music in its state (every
  ancestor of an edit then differs from the start), the music left out of
  it (an insert converged early), absolute record numbers, and the
  iterators that look ahead (a repeat's alternatives and length, a
  tuplet's span, a sequence's next grace time).
- **What it is not yet.** Translation still runs from the start: no
  state is kept to resume from and no old record is spliced in (MS6 step
  5's rest). A translator's Rust state outside its Scheme values (a count,
  a record number it holds) is not in the digest; the harness's check is
  what finds a convergence that misses it. A node never iterated (music a
  callback made: `\repeat unfold`'s copies) blocks the convergence.
  `localAlterations` keeps each pitch's last bar, so an edit adding an
  accidental converges only where the same pitches came again.

## D239 — N8's partitions are line contexts merged where they depend on each other, and a partition runs where what it heard, its ancestors' properties or its music differ

**Status:** accepted (MS6 step 6, 2026-10-28) · **Refines:** 04 §10.3,
§10.4, D238 · **Changes:** `crates/music/src/partition.rs` (new),
`checkpoint.rs` (the recording's parts, records digested as each timestep
ends, contexts named by key), `context.rs` (the events each context hears,
the properties each timestep touches), `override.rs`, `global.rs`,
`iterator.rs` (each iterator's digests by context, `\applyContext`),
`translator.rs` (a translator the score gives), `crates/scheme`'s
`Heap::is_image_code`, `crates/core`'s `Engine::kept`, `verify_all` in
the harness and the compile example's `--n8` (`parts` lines)

- **What.**
  - **A partition** is a line context, one whose translators include
    `Axis_group_engraver` (it makes a `VerticalAxisGroup`) or, in a
    `\midi` translation, `Staff_performer`, the topmost of its line, with
    every context made below it. Everything else is the shared level:
    Global, the Score and the groups above line contexts (a `\midi`'s
    Lyrics make a track, so they are a line there too). A context stays in
    the line it was made in.
  - **Merged:** two lines where a context moves from one to the other
    (`\change Staff`), a lyric combine's Lyrics with its voice's line;
    every line into one where a translator is given by the score as a
    procedure or an alist, a Scheme listener is added (`ly:add-listener`),
    an `\applyContext` procedure in a partition is a closure not compiled
    into the image (LilyPond's own procedures, `ly:set-middle-C!`,
    `\time`'s and `\partial`'s, touch their context and the shared level),
    or a context moves between a line and the shared level.
  - **A context's key** (in every N8 digest, D238's context numbers
    replaced): its parent's key, its name, its id and how many contexts of
    that parent, name and id were made before it. A grob or audio record
    is named by its moment, its context's key and its place among the
    records that context made at that moment.
  - **Recorded per part** (part 0 the shared level): per timestep the
    events its contexts heard (each listener's context, a lyric combine's
    Lyrics), the records it made as the timestep ended (with the spanners
    it ended), and the properties of the shared contexts above it (each
    property the timestep set, unset or overrode, digested as it ended,
    summed per context); per checkpoint and at the start its contexts'
    state (properties, translators, iterators by their contexts, and the
    spanners each context made and has not ended, by their places: an
    engraver holds them as record numbers in Rust) and future (music a
    callback made, `\repeat unfold`'s copies, digested by its contents
    where an iterator holds it, not as one value).
  - **The plan** (`plan`), from the checkpoint translation resumes from
    to the convergence: the shared level runs; a partition starts running
    where its state or future at the resumed checkpoint differs (its music
    changed), where the events it heard or its ancestors' properties
    differ from the old run's at that moment, or, at a timestep only one
    run has, where it heard or made anything or the properties changed;
    it is caught up from its own last checkpoint, and stops at a
    checkpoint where its state and future are the old run's. Otherwise its
    old records are replayed. Its work: translators times timesteps.
  - **Checked against whole runs** (`verify_all`, the harness's `--n8`):
    every timestep a partition replays made the old run's records at that
    moment, and every checkpoint it replays has the old run's state there.
- **Why.** 04 §10.7 (b) puts a reflow of a large score under budget only
  if the partitions it does not touch are replayed; the plan says where
  that holds before step 7 replays anything, and the check shows it on
  the 30 as D238's showed the convergence. Each rule is one the check or
  the 30 asked for: the future left out of a replayed checkpoint's
  comparison (the edit lies ahead of it), records digested when made (a
  staff's spanners end where the score does), a changed music's partition
  run from the resumed checkpoint (its iterators' music differs before
  any event does), the shared properties a partition reads only its
  ancestors' (T29's `localAlterations` on StaffGroup and SquareStaff, an
  accidental style's), the open spanners and the callback's music (T04's
  `\noise`).
- **Its cost** (OPEN C11): every `\layout` and `\midi` translation
  records. The grob-property alists' digests are kept for the whole
  translation (the recording traces them, so none is collected and its
  bits reused) and a value its bits hold is not written out: translation
  natively 1.4–1.9 times d1219e0's, against 2.3–4.4 with step 4's
  recording alone.
- **What it is not yet.** Translation still runs whole (MS6 step 7
  replays). A translator's Rust state beyond its open spanners is still
  not digested: T04's `delete-1-9` replays a partition whose records
  differ (OPEN C12, `N8_KNOWN`). The shared properties are its ancestors' as a whole, not
  those a partition reads: where an accidental style keeps
  `localAlterations` on a group, every staff below it runs where the
  edited staff's alterations differ (T24's PianoStaff, whose pedal staff's
  records do change in E2; T29's Orchestra in a reflow).

## D240 — N8's state digest takes each translator's Rust state, and a partition's shared input every write to the shared level in a timestep

**Status:** accepted (MS6 step 5's rest, part 1: OPEN C10 and C12, 2026-10-28) ·
**Refines:** D238, D239 · **Changes:** `crates/music/src/translator.rs`
(`Work::held`, the `Held` trait), the 61 translators with Rust state in
`crates/music`, `crates/layout`, `crates/figured-bass` (and `Beams`,
`BeamingPattern`, `BeamingOptions`, a delimiter's nesting),
`checkpoint.rs` (the digest's sink, the shape's music traced),
`context.rs` and `override.rs` (each write with its value),
`partition.rs` (the writes in the shared row), the harness's `N8_KNOWN`
emptied

- **What.**
  - **A translator's Rust state is in the checkpoint's state digest**
    (`Work::held`, OPEN C12's gap that D238 named): its numbers, flags,
    moments and strings as they are, a record it names by number by its
    place (its moment, its context's key, its rank among that context's
    records there: a grob in a `\layout` translation, an audio record in
    a `\midi` one), a context by its key. A Scheme value it holds stays
    `Work::values`'. A translator with no Rust state keeps the default,
    which gives nothing.
  - **A partition's shared input is every write to the shared level in
    the timestep**, in order, with the value written (a property's value,
    `#<undefined>` for an unset, an override's alist), beside the shared
    properties as the timestep ends. T04's `delete-1-9` (OPEN C12): the
    note deleted from `\m`'s tuplet holds a note of the middle staff over
    1/1, so its `Forbid_line_break_engraver` sets the Score's
    `forbidBreak` there and the Score's columns unset it as the timestep
    ends; SA's and SC's `Clef_engraver` and `Key_engraver` read it
    between and make no Clef and KeySignature at the bar. The property
    was the same as each timestep ended, so the staves were replayed. The
    writes are traced while the timestep runs, so no value is collected
    and its bits taken before they are digested.
  - **The shape's music is kept alive by the recording** (OPEN C10): each
    node is found by its key, the bits of its music, a live music's
    property list or a frozen tree; the recording traces them, so music a
    translation drops (an engraver's `ly:music-set-property!`) is not
    collected and its bits taken by music it makes and found as that node.
- **Why.** Replay rests on the digests: a partition stops running where
  its state is the old run's and replays where its input is. The checks
  (`verify_all`) found the one case where they did not hold on the 30
  (T04) and its cause; the Rust state is the gap D238 named, and the
  convergence and the partitions' stops of step 7 rely on it. C10's two
  edits (T09 `delete-1-3`, T12 `insert-1-10`) do not contradict the
  digests at HEAD, at step 6 or at step 4's commit (823df5f), in every
  full native run of the 312 edits made for this (five) and alone: the
  contradictions step 4's session saw came with its code between its
  runs; what could make the digests depend on the collector (a key's
  bits taken by another object) is closed.
- **Its cost.** The Rust state is digested only at checkpoints; the
  writes to the shared level only where they are made (the shared level's
  properties, few a timestep).

## D241 — N8's snapshots: a recorded translation copied whole at each checkpoint, with a mark in the heap's undo log, and restored in place

**Status:** accepted (MS6 step 5's rest, part 2a, 2026-10-28) · **Refines:**
04 §10.2, §10.4, D238, D240 · **Changes:** `crates/music/src/resume.rs`
(new), `global.rs` (the global loop entered at a snapshot, the check),
`context.rs` (`Arena::snapshot`, the snapshots in the arena, the error
port in `Host`), `translator.rs` (`WorkClone`), `iterator.rs`,
`checkpoint.rs`, `records.rs` (`GrobSlot::clone_slot`), `override.rs`
and layout's `grob_array.rs` (undo-log snapshots), `Clone` on every
translator and the types they hold (`crates/music`, `crates/layout`,
`crates/figured-bass`, `crates/tablature`, the tests' own), layout's
`Grobs`, `crates/scheme`'s `Heap::checkpoint_mark` and
`Vm::error_len`/`cut_errors`, `crates/core`'s `Engine::set_check_n8`

- **What.**
  - **A snapshot** at each checkpoint, where its digest is taken (after
    the timestep's `Prepare`): the arena copied whole (contexts and their
    properties, every translator's `Work` through `WorkClone`, the
    records, the dispatchers, the finalizations, layout's grob slot as
    the translation has filled it, the trace recorder, the playback map,
    N8's recording), the iterators, the timestep's moment and whether its
    iterators run, the error port's length, and a mark in the heap's undo
    log: `Heap::checkpoint_mark` starts the next epoch inside the running
    item, so the first change from there of every object made before it
    is logged. `GrobProperties` and `Grob_array` now give the log a copy
    of themselves, as music does, so their changes are logged too.
  - **A restore** undoes the heap to the mark, cuts the error port back,
    puts the copied arena in place of the translation's arena (the one
    every handle it made names) and the iterators in place of the
    iteration's, and enters the global loop at that timestep's
    processing. The snapshots after it are dropped.
  - **The check** (the harness's `--n8`, `Engine::set_check_n8`): every
    recorded translation is restored at its middle snapshot and at its
    first and run on to its end, each time what N8 keeps of it, its
    record counts and its trace the whole run's; layout and the pages are
    made from the last run, so the harness's layers check the restored
    translation too.
- **Why.** Resume (04 §10.4's step 1) needs the state at a checkpoint,
  and a translation changes almost nothing older than itself in place
  (0–3 heap objects and its globals on the 30, D240's entry): its own
  state and the objects it made are what a snapshot must give back.
  Copying the arena whole is the simplest copy that is right; 04 §10.2's
  shared maps and dirty bits are a cost cut for later (OPEN C11).
- **Its cost.** Every recorded translation takes its snapshots: natively
  T02 10.3 → 10.4 ms, T12 32.3 → 35.0, T24 115.0 → 121.5, T29 128.4 →
  136.6 (the least of 24, `--offline`).
- **What it is not yet.** A restore within the compile that made the
  snapshots only: across compiles the compile's undo gives back what the
  log holds, the old translation is not kept, and its iterators are on
  the old music (part 2b).

## D242 — N8's resume: a translation kept across compiles and resumed in place at its last pure snapshot before `m_e`

**Status:** accepted (MS6 step 5's rest, part 2b, 2026-10-28) · **Refines:**
04 §10.4's step 1, D241 · **Changes:** `crates/music/src/resume.rs`
(`Resumable`, `resume`), `global.rs` (`run_resuming`, the probe of the
first state), `iterator.rs` (`Iteration::rebuild`), `checkpoint.rs` (the
shapes lined up, `Shift`), `context.rs` (the new output definition, the
error port and placed messages where a translation begins), `records.rs`
(`GrobSlot::take_layout`), `performance.rs` and layout's `paper_score.rs`
(undo-log copies, the new definition), layout's `grob.rs`, `crates/scheme`'s
heap (pictures by generation, the kept translations' epochs, `give_back`,
`hold_between`, a slot's own epoch in a chunk it was put into) and `Vm`
(the error port's text), `crates/core`'s compile (the kept translations,
`Engine::resumed_at`) and the compile example's `--n8` (the resumed
snapshot), the harness's diagnostics

- **What.**
  - **Kept:** each translation of a compile that ran to its end is kept
    for the next compile's translation at its place: its object held by
    the heap between compiles, and before the compile is undone its own
    objects' log entries from the compile's item on taken out of the log
    as the compile's generation of pictures, so the undo leaves them as
    they are. A compile that stopped for the host, or ended in an error,
    keeps nothing (it may have resumed and changed the last ones). They
    are passed on only to a compile of the same root whose text has the
    same length: no byte moved, so the places in the input the old
    records hold are the new text's.
  - **Resumed where it can be:** the new translation's first state is
    probed (a translation of the new music made for it and dropped, what
    it said taken back) and must be the old one's (the output definition
    gives its contexts the same); the trace must have begun the same; the
    new music's shape must line up with the old (`differing`'s first and
    last differing nodes, the nodes before and after them in place). The
    snapshot is the last whose moment is before `m_e`, that is *pure*
    (the translation had changed no object older than it for good by
    then, the placed messages' cell apart), and whose iterators the new
    music takes (`Iteration::rebuild`: each iterator's music moved to the
    new node it lines up with; one whose music changed reads its length
    again and must keep its start; a sequence its elements, the old ones
    as far as it has looked; a simultaneous as many children; music the
    shape has not got, a callback's, kept only where nothing above it
    changed); the latest first, the earlier tried where one does not
    rebuild.
  - **The resume:** the old translation's own objects (by the epochs it
    made them in, in each compile it ran in) given back what they held at
    the snapshot (`Heap::give_back`: every later generation's pictures
    and its own from the mark on); the arena the snapshot's, in place, so
    every handle it made still names it; the new compile's output
    definition given to it, to its grobs and to its Paper_score and
    Performance (the old one's module is undone); N8's recording on the
    new shape (each node's start the old node's it lines up with, where
    that started by then); what it said before the snapshot (the error
    port's text, the placed messages with their places in it moved) said
    again; then the global loop from that timestep's processing to the
    end.
  - **A slot's own epoch** in a chunk it was put into after the chunk was
    opened (a chunk's one young epoch was cleared by the next epoch's):
    the epochs a checkpoint starts made the translation's own objects
    report the chunk's older one, so N8 took them for older objects.
- **Why.** 04 §10.4's first step, the translation restored at the
  checkpoint before `m_e` and run on, with the conditions it rests on
  checked rather than assumed. Each rule is one the harness asked for: the
  old output definition's module undone ("cannot create default child
  context", `#<undefined>` in page layout), one translation's give-back
  putting the other's objects back (T02's `\layout` and `\midi` both
  resumed), the probe's and the old run's messages (T15, T26, T29), the
  Paper_score and the Performance changed in place without the log.
- **Its cost and what it gives** (natively, release, the engine's fonts,
  the least of 12 compiles alternating the text and its E1, translation
  ms, the machine loaded by other sessions): T02 17.8 → 16.5, T12 59.9 →
  53.4, T24 205.3 → 153.3, T29 283.7 → 288.0 (T29 resumes only at its
  first snapshot: its later ones do not rebuild). The probe costs a first
  timestep; without convergence and splice a resumed translation runs to
  the end.
- **At most 16 snapshots a translation:** past them every other one its
  compile took but the first is dropped, so they thin out over the score.
  A translation and the one kept for it live at once: T24's 50 snapshots
  of each overran wasm's 256 MiB (a trap in the harness's wasm run),
  natively 264 MB at their peak against 187 with the cap.
- **What it is not yet.** No convergence and no splice (MS6 step 5's
  last part), no replay by partition (step 7); an edit that moves a byte
  runs whole; T29's snapshots after its first do not rebuild; the
  snapshots copy the arena whole (04 §10.2's shared maps not yet).

## D243 — N8's splice: a resumed translation that converges ends as the last compile's run did, each record before the checkpoint the old run's where its contents are the same

**Status:** accepted (MS6 step 5's rest, part 2c, 2026-10-29) · **Refines:**
04 §10.5, D241, D242 · **Changes:** `crates/music/src/resume.rs`
(`Splice`, `lines_up`, `splice`, `ended`), `global.rs` (the loop stops at
a splice; each run's end kept), `checkpoint.rs` (`Recording::converged`,
`splice_tail`, the record digests; `finish` no longer takes the arena's
writes), `partition.rs` (`Tracker::adopt`, `Parts::spliced`),
`trace.rs` and `playback.rs` (their splices), `context.rs` (the arena as
its translation ended, its heap mark, its placed messages, the splice),
`scheme_translator.rs`' `grob_handle` (the old run's handle),
`records.rs`' `GrobSlot` (`same_grob`, `grob_digest`, `put_grob`, layout's
in `grob.rs`), `crates/scheme`'s `Heap::give_back` (the end values kept),
`crates/core`'s `Engine::spliced` and the compile example's `--n8` column

- **What.**
  - **Each recorded translation keeps its end** (`resume::ended`, before
    layout runs on it): its arena copied, the placed messages it said,
    and the heap's mark there. A resume (D242) takes that copy, the
    snapshots after the one it resumed from, and, as `give_back` puts the
    translation's objects back to the snapshot, what each held at that
    end mark (layout's changes after it are not the translation's): the
    splice's material, in the arena so that it is traced.
  - **Convergence** (`Recording::converged`, at each checkpoint of a
    resumed run, as `compare` finds it): past `m_e` and every changed node
    of both runs, the state and future the old run's at the same moment.
  - **Lining up** (`lines_up`, against the old run's snapshot at that
    checkpoint, which must be there): as many grob and audio records, each
    in the same place (type, context and translator, moment), in as many
    contexts, so that the old run's record numbers are this one's. Then,
    record by record: where this run's has the contents the old one's had
    then (N8's digests, layout's grob with it), the old run's as it ended
    is taken, with what that run did to it after; where not, this run's,
    if the old run did nothing to it after but end a spanner or add to a
    staff's items, which are carried over; else no splice. The
    performance's columns must be the same.
  - **The splice:** the arena the old run's as it ended, with this run's
    records where chosen (their interfaces renumbered into the old
    table) and layout's grobs with them; the trace this run's to the
    checkpoint and the old run's after, the Score's grob lines written
    again for the grobs heard by then (their columns from the spliced
    arena); the playback map's events and bars the same way, its JSON
    made again; N8's timesteps and checkpoints this run's to the
    checkpoint and the old run's after, its partitions' rows too, the
    tracker taking the old run's contexts after (`Tracker::adopt`) and
    the music's starts the old run's where this run did not iterate it;
    the objects the resume gave back given their end values again
    (`Heap::redo`, logged), then the arena given this compile's output
    definition as a resume gives it (the Paper_score's end value names the
    last compile's); what the old run wrote to the error port from the
    checkpoint written again, and the placed messages it said after those
    it had said by then (by count: the error port need not grow while a
    translation runs) said again. The loop stops; `Finish` is not sent
    again.
  - **One handle a grob:** a resumed translation that asks a record's
    handle first takes the one the old run made for that number, if it
    did (a handle names a translation and a number): where a record is
    the old run's and one it refers to is this run's, both name the same
    object, as layout compares them.
  - **Checked** by the snapshots' check (D241, the harness's `--n8`):
    the spliced translation's summary (what N8 keeps of it, its records,
    its trace) must be what restoring it at two of this compile's
    snapshots and running on to the end gives.
- **Why.** Translation per edit is under its budget only if the timesteps
  after the convergence are not run (04 §10.7 (a)). The records before the
  checkpoint cannot simply be this run's: the old run changed them after
  it (spanners' bounds, a staff's VerticalAxisGroup's elements, its
  StaffSymbol ended at the end, a beam's stems), and a whole run would
  have done the same; nor the old run's, where the edit changed them.
  Contents compared by digest take the old run's for all but the edited
  records, which the old run must not have touched after.
- **Found.** `finish` took the arena's shared-level writes (C12's), so a
  copy finished for the check (`summary`) left the real one without the
  last timestep's: the old run's kept rows lacked them, and a splice
  carried that over. It reads them now. The check itself hid what layout
  makes of a splice: it lays out the run the check restored last, so
  the harness's native run without `--n8` (`nativeDifferential`'s
  `check: false`) and its wasm run are what found the output definition,
  the two handles and the placed messages said twice.
- **What it is not yet.** A splice saves little yet: few translations
  resume (an edit that moves a byte runs whole; T24 and its E1 compiled
  alternately in one engine resumed and spliced the first time only, not
  yet looked into), the probe, the copy of the old run's arena and the
  lining up cost, and no partition is replayed (step 7). OPEN C13.

## D244 — N8's resume after any edit of the root: the old parse's places moved to the new text, each snapshot lined up by its own run's shape

**Status:** accepted (MS6 step 7, OPEN C13's part, 2026-10-29) · **Refines:**
D242, D243 · **Changes:** `crates/music/src/input.rs` (`Moved`),
`resume.rs` (the snapshot's own shift, the links and the error text
moved, the probe last), `iterator.rs` (`rebuild`: the simultaneous, a
callback's elements, the next element's moment), `checkpoint.rs` and
`partition.rs` (the kept futures unknown), `trace.rs` and `playback.rs`
(`move_links`), `global.rs` (`run_resuming`'s edit and probe),
`crates/scheme`'s `Heap::each_older_foreign_mut`, `crates/core`'s compile
(the kept text, the edit, the places moved), `crates/music/tests/moved.rs`

- **What.**
  - **Any edit of the root resumes** (D242 passed the kept translations
    only to a text of the same length): the engine keeps the text they
    were made from and finds the one span the new text replaced
    (`Moved`: the common prefix and suffix). Before the parse it begins an
    epoch; after it, every `Input` of the file older than that epoch (the
    old parses', which the kept translations' records, events and
    messages hold) is moved to the new text: its offsets past the span
    with the bytes, its line, character and column counted in the new text
    as `Source::counts` counts them. The parse's own places are newer and
    left alone; those of the segments it did again end before the edit.
  - **What the old run wrote with places** is moved with them: the trace's
    grob links and the playback map's hrefs (`file:line:char:column`, in
    every snapshot and the run's end), and the error text it said (each
    `name:line:column` past the edit's lines one line on or back). A
    message on a line the edit changed refuses the resume (the quoted line
    it printed is not the new one's), as does a line number that grew or
    lost a digit (the snapshots' places in the error port would move).
  - **A snapshot is lined up by its own run's shape.** A resumed run keeps
    the snapshots before the one it resumed from, taken by the run before
    it on that run's music; the next compile lined their iterators up with
    the last compile's shape, in whose changed region the edited note
    falls, and `rebuild` kept the older run's note there (OPEN C13: T24's
    E1 after its text after E1 ran its note on music the shape had not
    got, so the compile after it found `m_e` 0 and ran whole). Each
    candidate snapshot's shift is now its recording's shape against the
    new music, for the rebuild and the starts N8 takes over; `m_e` is still
    found against the last compile's run.
  - **A simultaneous iterator rebuilds where its new music has as many
    elements as the music it was made on**, not as many as its children
    now: children that ended are gone at a later snapshot (T29's resumed
    only at its first).
  - **A sequence's elements its callback made** (a volta repeat's), which
    are no node of N8's shape, are made again from the new music where
    the sequence did not change, as many, and the iterators made on the
    old ones are moved to the new ones by place: kept, they ran the old
    parse's music, whose places a delete had collapsed into its span and
    the edit back pushed a byte too far (T10's `string-1-3` after
    `delete-1-2`).
  - **A changed sequence's next element's moment** sums the lengths of
    the elements it has looked at; where one of them changed length (an
    insertion inside the element being played), it is moved by the
    difference and its grace part read again; a sequence whose old
    elements had all been taken and whose new ones go on is not rebuilt
    (T12's `insert-1-10`: the music after the edited voice a quarter
    early).
  - **The checkpoints a resumed run keeps from the old one** have the old
    music's futures: their futures (and their partitions') are unknown
    (0) in the resumed run's recording, so no later compile converges at
    one nor splices a tail that starts among them (T24's `pitch-1-5`
    after a run resumed from `error-1-4`'s: the splice took futures of the
    error's music, which the snapshots' check found).
  - **The probe runs last**: the new translation's first state is probed
    only where a snapshot before `m_e` is there (T29's E2 changes it
    before its first snapshot: the probe was a timestep for nothing).
- **Why.** E2 and E3 move every byte after them, so with D242's rule two of
    B6's three edits never resumed; the places are the only part of the old
    run the new text changes where the music before `m_e` is the same. A
    place is moved in its object, once, unlogged, so that the old run's
    records need not be found and rewritten one by one: nothing but the
    old parses holds those objects, and the kept translations are dropped
    whenever a compile does not resume them.
- **Found.** Offline, every compile asks once for the pack it cannot
  fetch and stops, and a stopped compile keeps nothing: part 2c's figures
  of T24's E1 were the restart's, which had nothing to resume. Translation
  per edit is measured with the engine's fonts (the studio's driver puts
  no module as none).
- **What it gives** (the harness's 312 native edits, seed 1): **356 of
  the 560 translations resume** (84 before), 46 splice (33), every
  compile equal to its fresh one in C0–C5 and N8's checks clean.
  Translation per edit natively (both translations, the engine's fonts,
  the least of 6, from scratch → incremental, load 10–16): T02 E1 9.5 →
  9.0, E2 10.5 → 9.4, E3 9.5 → 5.0; T12 35.1 → 19.3, 33.7 → 29.2, 33.8 →
  11.9; T24 123.1 → 83.5, **E2 112.2 → 91.1**, E3 109.0 → 25.8; T29 124.3
  → 97.9, E2 131.3 → 134.0 (run whole: `m_e` before its first snapshot),
  E3 125.2 → 41.8.
- **What it is not yet.** No partition is replayed (MS6 step 7's replay,
  OPEN C14); the recording's cost stays (OPEN C11); music that is the same
  (E3) resumes at the last snapshot and runs to the end, since no later
  snapshot is there to splice at.

## D245 — N8's partitions record what each writes outside itself; a replayed partition must not have, but for its grobs added to the shared level's grob arrays

**Status:** accepted (MS6 step 7a, 2026-10-29) · **Refines:** D239 ·
**Changes:** `crates/music/src/context.rs` (`Arena::writer`, `wrote`,
`grob_written`, `grob_added`, `quiet`), `translator.rs` (`call_slot`
names the writer; end announcements are writes), `scheme_translator.rs`
(`ly:grob-set-property!`, `ly:engraver-announce-end-grob`),
`checkpoint.rs` (each timestep's writes by place), `partition.rs`
(`Parts::outs`, `Parts::adds`, the plan's `part_plan`, `PartRun::reads_only`),
layout's `grob.rs` (properties, objects, parents) and `grob_array.rs`
(adds, the order, Scheme's arrays), the compile example's `parts` column,
the harness's diagnostics

- **What.**
  - **Every write to a grob during a recorded translation is noted** with
    the context whose translator wrote it (`call_slot` sets the writer):
    a property or object set (`ly:grob-set-property!`, layout's
    `set_on_alist`), a parent, an end announced, a grob array added to
    (with the grob added) or ordered, and a grob array changed from
    Scheme, whose grob is not known.
  - **Each partition's writes outside itself**, per timestep: to a grob of
    the shared level, of another partition, or not known (`Parts::outs`);
    apart, the grobs of its own it added to a shared grob's arrays
    (`Parts::adds`: a column's `spacing-wishes` and `bounded-by-me`, which
    a voice's and a staff's engravers add to every timestep). An add's own
    setting of a new array on the grob is the add (`quiet`).
  - **The plan runs a partition where the old run's partition wrote outside
    itself** (`outs`), since a replay of it would miss the write; its adds
    do not make it run, since the replay adds them again (MS6 step 7b).
    `PartRun::reads_only` keeps step 6's figure (what it heard and read
    only) beside it.
- **Why.** Replay skips a partition's translators. Its own records are the
  old run's, but what its translators did to other grobs is not in them,
  and LilyPond's staves do write outside themselves: in T29 every voice and
  staff adds its spacing grobs to the shared columns at each timestep,
  which alone would run T29's E1 `\layout` 39,319 of its 59,711
  translator-timesteps instead of 15,036. Counted as adds, 16,632. Over the
  harness's 312 edits the other writes cost 84 of 2,922,827.
- **What it is not yet.** Nothing is replayed (MS6 step 7b): the plan is
  still checked against whole runs only.

## D246 — N8's replay: each translator call's effects logged and made again in place of a replayed partition's calls, checked at each timestep; off until a replayed compile is its fresh one's

**Status:** accepted, **off** (MS6 step 7b, 2026-10-30; stopped for the
operator, OPEN C14) · **Refines:** D239, D243, D245 · **Changes:**
`crates/music/src/replay.rs` (new: `Log`, `Effect`, `Op`, `Replay`,
`instead`, `apply`, `resolve`, `kept_value`, `check`, `converged`,
`set_replay`), `translator.rs` (`call_slot` logs and replays a call;
`stay_awake` an effect), `context.rs` (the arena's log and replay; a
property set or unset, a moment asked for, an override, an event sent or
a context made in a call), `scheme_translator.rs` (records made;
`set_record_property`), `global.rs` (`replaying`: a snapshot where a
resume begins, the attempts, the check at each timestep), `resume.rs`
(the log's place in a snapshot; the splice's log; `impure_after`),
`checkpoint.rs` and `partition.rs` (rows and states for the checks; the
checkpoints a replay ran forgotten), `iterator.rs` (the contexts whose
music `rebuild` found changed), layout's `grob.rs` (`n8-write`: a logged
write made again) and `grob_array.rs` (an array as it was), the compile
example's `--replay`

- **What.**
  - **The log.** In a recorded translation every call of a partition's
    translator (`call_slot`) is named by its timestep, its context's key
    and its rank among that context's calls in the timestep; what it did is
    kept as effects: a grob record made, announced (up or locally, its
    start or end), written (`Op`: a property, an object, a parent, a grob
    added to an array or the array ordered, a record's own property), a
    context property set or unset, a moment asked for, the translator kept
    awake. A call that said something, sent an event, made a context,
    overrode a property or changed a grob array of no known grob cannot be
    replayed. Values are kept as they were (lists and vectors copied, a
    grob array copied), since layout changes them after. A snapshot keeps
    where the log was (its length, the timestep and the calls counted), a
    restore cuts it back, a resume starts a new log from the old one's
    there.
  - **Replay.** A resumed run takes a snapshot where it begins and
    replays every partition but those whose music changed (`rebuild`'s
    changed iterators' contexts): a replayed part's translators are not
    called; its iterators and context handlers run; at each of its calls
    the old run's same call's effects are made again, the old run's grobs
    by their numbers here (a grob it copied in, or this run's at the old
    one's place), a grob in a value by this run's handle for it. A part
    that runs switches to replay at a checkpoint where its state and future
    are the old run's.
  - **The check**, at each timestep's end: each replayed part heard what
    the old one did, read the same shared properties, and the old run's
    calls with effects of its contexts were all made. A part that fails
    ends the attempt: the run is restored where it began and run again
    with that part running to the end; after three attempts no part is
    replayed. A replay makes no splice; its snapshots are not resumed from
    and its checkpoints' digests are unknown in another compile.
  - **One handle a grob stays by number** (D243's rule): replay names an
    old run's grob in a value by this run's handle for it rather than
    renumbering the old handle (a handle renumbered in place outlived its
    run in another compile's state: T12's E2 after its E1).
- **Why off.** On the harness the replayed runs are not their fresh
  ones': N8's snapshot check (a run restored where the replay began, run
  without it) finds 78 of the 312 edits differ, and a replayed compile's
  own outputs differ (T02's E1 in every layer; T29's E1 in stderr,
  diagnostics and MIDI). Known: a `\midi` replay makes no audio record (not
  logged); a replayed staff's `localAlterations` miss an entry in the
  trace; T29's `\layout` staves fail the shared check at 5/4, before `m_e`.
  Replay is never passed by a tolerance; until its compiles are their fresh
  ones' it is off (`set_replay`, the compile example's `--replay`), the
  log with it, and translation runs as at D245.

## D247 — N8's replay on where a translation has three partitions: every effect of a call logged, each call counted, a part that fails going back to the last point it holds what it ran to

**Status:** accepted (MS6 step 7c, 2026-10-30; the operator's answer 9) ·
**Refines:** D243, D245, D246 · **Changes:** `crates/music/src/replay.rs`
(`Chunk`, `Point`, `Replay::back`, `PARTITIONS`, `Replayed`; the audio, the
playback map's and `Prepend`'s effects; `Op::Bound`, `Suicide`, `Reset`),
`context.rs` (`prepend_property`, `audio_changed`, `Ranks`, `end_grob`,
`trace_copy`), `translator.rs` (`add_audio`), `global.rs` (`replaying`'s
points, `steps`' snapshots only outside a replay), `checkpoint.rs` (the
`ended` list, `open`, `skip`), `frozen.rs` (`opaque`), `performers.rs`,
`performance.rs`, `dynamic_performer.rs`, `melisma.rs`, `playback.rs`,
layout's `spanner.rs`, `grob.rs`, `grob_array.rs`,
`separating_line_group_engraver.rs`, `accidental_engraver.rs`, the compile
example's `--no-replay` and `--replay-all`, the harness's `flags`

- **What.**
  - **A call's log is whole.** Besides D246's effects: a spanner's bound
    (`Op::Bound`; its parent and the column's `bounded-by-me` are writes of
    their own), `suicide`, a grob array reset (`Separating_line_group_engraver`
    reached into one), a keep-awake logged before its call closes; an audio
    record made and announced, what it is after each change (a staff's items
    one by one), the staff performers counted, the playback map's staff. A
    channel given out is not replayable.
  - **What a call set is kept as the call left it**, not as it was set: a
    translator changes a value in place (a stem's `beaming`, `localAlterations`).
    `localAlterations`' own change (`assoc_prepend_x`) is logged as the change,
    not its value (`Arena::prepend_property`): a staff's alist and the group's
    above it share cells, and the entry a change unlinks from one is gone from
    the other.
  - **A record's interfaces go by symbol**: each run numbers them as it meets
    them. **A grob in a value is translated once** (a handle translated again
    named the wrong grob where the numbers had moved), a grob of no number
    here fails the part, and one found by place must have the old one's type.
  - **Each timestep's calls are counted by context**, and a replayed part's
    must be the old run's: a call the old run did not make at that timestep
    is not one with no effects (a context finalized at another moment).
  - **A part that fails goes back only as far as it must.** Where a part goes
    back to replay the run takes a snapshot (a `Point`, with the replay as it
    stood; two kept past the first); a part that fails goes back to the last
    point at which it held what it ran to, runs past where it failed and may
    go back to replay at a checkpoint where its state and future are the old
    run's, from the next timestep. After four failures it runs to the end;
    after six attempts nothing is replayed. The next compile starts the
    parts that failed running, to the last moment each failed. This is
    step line 7's catch-up from a partition's own checkpoint as far as it can
    be had: a part's translators are not kept while it is replayed, and the
    old run's at a later checkpoint hold its records' numbers, which an edit
    moves.
  - **A replay takes no snapshot and digests no replayed context**: no
    compile resumes from them. With no music changed nothing is replayed.
  - **It is on where a translation has three partitions or more**
    (`PARTITIONS`), and a translation is logged only where the last compile's
    run of it shows that: the first compile of a score logs nothing, nor does
    any compile of a score of fewer (T02, T12, T24 run as with replay off,
    their splices kept). A resumed run's log begins where it resumed if the
    run before it kept none.
  - **What the checks and the recording cost** (C11): `Recording` boxed (it
    moved at every translator call and heard event), each grob's place from a
    cached rank, the grobs ended in a timestep and the open spanners listed,
    not searched, a log's timesteps shared between runs, the log traced once.
  - **An object that prints nothing of itself** in a music's property (a
    `\score` in a markup) is digested by its identity in the shape, and a
    `Score` in the state: its edit was no change (T23's `string-2-2`, seed 2,
    at a020300 too: the old translation resumed on a `Score` whose parse had
    been undone, `no systems found in \score markup`).
- **Why.** The operator's answer 9: finish replay first. Every difference 7b
  left had a cause in the log or the check; the harness finds none now.
- **What it gives.** Every compile equal to its fresh one: the harness's 312
  native edits of seeds 1–3 and the larger run's 912 of seed 2 with
  `--replay-all`, what the replay made laid out (but T24's `string-2-19`, C0,
  OPEN C9, with it off too), and the 102 in wasm. T29's E1 `\layout` calls
  made / replayed 93,748 / 10,920 at the session's start, 23,100 / 107,469 now.
  Translation per edit on T29, on / off (the least of 6): E1 92.5 / 85.5, E2
  130.0 / 121.1, E3 38.3 / 37.7; T02, T12 and T24 run as with it off.
- **What it is not.** A replayed part's iterators, its events' dispatch and
  the shared level's acknowledgements of its grobs all run: calls fall by four
  and the time does not. On the four replay saves nothing and costs T29 up to
  8 %; it stays correct and on as the operator's answer has it, the first thing
  to take off if B6's translation phase needs that (`set_replay`, `ON`).

## D248 — Y7's cells: what was computed after the line breaks kept per line and system, keyed by N8's digests and by what each grob's callbacks read, and given back before `after-line-breaking`

**Status:** accepted (MS6 step 8, part 1, 2026-10-30) · **Refines:** D108,
D243 · **Changes:** `crates/layout/src/cell.rs` (new), `grob.rs` (the reads
and writes noted in D108's slot, `try_callback` and `%grob-try-callback`
entering and leaving a grob, `%grob-enter`, `%grob-leave`), `system.rs`
(`do_break_substitution_and_fixup_refpoints` gives the cells back after its
substitution, before any `after-line-breaking`), `paper_score.rs`
(`PaperScore::cells`), `dump.rs`; `crates/music/src/checkpoint.rs`
(`Kept::grobs`, `GrobDigest`); the core's `compile.rs` and `lib.rs`
(`Engine::set_cells`, `cell_reports`), the compile example's `--no-cells`,
`--check-cells` and `<stem>.cells.tsv`, the harness's `cellsOf`, `COVERED`

- **What a cell is** (05 §6.1): one line (a `VerticalAxisGroup`'s piece) in one
  system: the grobs of the broken system whose ancestors on Y reach that piece,
  and those its `elements` or `vertical-skyline-elements` arrays hold though
  no parent leads there. A bar number, a metronome mark or a volta the line's
  group places is nevertheless written from outside its line (OPEN B18, cause
  not found), so that cell is laid out again. A grob of no line (a `SpanBar`, the system's
  start delimiter) is laid out every time, as are the columns, the break
  alignment and the alignment of the lines, and with it the staff distances,
  which read what the cells hold (05 §6.2's step 5 without a step of its own).
- **What it holds is values, not a way round the code.** Each property written
  to a grob of the cell after the substitution (by a callback of its own line,
  logged) as it was when the pages were made, where the value holds no grob nor
  anything else of a compile's own (`portable`: numbers, pairs, stencils whose
  expressions are such, skylines, fonts), each property removed, and each
  offset and extent; a grob dead at the end is killed again. They are given
  back where `do_break_substitution_and_fixup_refpoints` has substituted, before
  any `after-line-breaking`, and everything after runs as it does from scratch
  and finds them computed. A value not given back (a grob in it, an object) is
  computed when it is read, as LilyPond computes it.
- **Its key** is content, not place: the output definition (each variable of
  it and its parents, the contexts' first state, the records of the system, the
  alignment and the spacing spanner), the line's context, its system's columns
  (each one's place from the first, its X to 2⁻²⁴ of a staff space, its record)
  and break-aligned grobs (their X, extent and record), and each grob's digest
  in order: N8's record digest with its moment, its definition, D108's slot
  and the grobs of its grob arrays (a line's group and its staff symbol by their
  record alone, their arrays being the whole line's). A cell another system or
  another place has kept is found by its key.
- **What it read is noted, not guessed.** While a callback runs for a grob
  (`enter`, `leave`), each grob it reads gives that grob's place and what that
  grob depends on (a range of each line in moment order, D239's line context)
  to the grob running; a callback that writes to another grob gives it its own.
  Not noted: a line's group's callbacks before the breaks (pure heights, every
  compile's) and its offset (the alignment's), the hubs every grob of a line
  reads (its group and staff symbol: a cell holds its own piece of them), the
  pure coordinate's `pure-Y-offset-in-progress` mark, and the exempt grobs.
  A kept cell is reused where every range digests as it did then (sums of the
  records' digests by moment) and the systems its own line's range reaches have
  their columns as they had.
- **Not reused**: a cell whose callbacks ran a procedure of the score's own,
  read where a line is placed (another line's group's offset, the alignment's
  `Y-offset` or `minimum-translations-alist`: cross-staff stems and beams), or
  wrote across a line's edge or were written to from outside their line; and
  every cell after a compile whose pages said something, which a cell reused
  would not say again.
- **The check** (05 §6.3, `--check-cells`): what a cell's callbacks read of an
  exempt grob is listed, and the harness fails on one whose type is not in its
  `COVERED` (columns, break alignment, the system, the alignment, a spacing
  spanner, all in the key) unless it is an object (`-`).
- **Why the quantum.** An edit in one place of a one-system score leaves other
  columns' X a few last bits away (T29's E1: 15 columns by 2 ULPs). A grob of a
  cell reads its column's X anew through its parents; what its callbacks made
  of the old X is that far off, below the 4 decimals any output writes. 2⁻²⁴
  of a staff space keys them as equal; the harness compares every output byte
  for byte against a compile from scratch, and a difference would show there.
- **What is not yet.** Nothing computed before the breaks is reused (the
  springs and rods, a column's width, a stem's direction: OPEN B17), nor a
  system's `Simple_spacer` solution, and line and page breaking run whole
  (step 9).

## D249 — Line breaking's lines kept by content, with the forces and both dynamic programmes found whole

**Status:** accepted (MS6 step 9, part 1, 2026-10-30) · **Refines:** D248 ·
**Changes:** `crates/layout/src/cell.rs` (`LineKeys`, `line_keys`,
`line_digest_of`, `is_line_hub`, the kept lines in `Cells`, `Report::lines`,
`lines_reused`, `lines_wrong`), `constrained_breaking.rs`
(`kept_line_details`); the compile example's `cells.tsv`, the harness's
`cellsOf` and its test; the core's test
`an_edit_fills_again_only_the_lines_it_reaches`

- **What is kept** (05 §6.2's step 2): what `fill_line_details` found of each
  line a breaker weighs, from one break to another (its shape, spacings,
  permissions, penalties, footnotes and refpoints), beside a Paper_score's
  cells, without its column. A line of the next compile with the same key
  takes it, with its own force and last column; one with a new key is filled.
- **Its key** is the line's content: the output definition and the contexts'
  first state (the cells' `settings`), whether it is the score's last line,
  the items whose column it spans and the spanners whose span meets it. An
  item is summed by its rank (prefix sums), a spanner by subtracting those
  that end before the line or begin after it. A grob gives its N8 record
  digest and what its grob arrays hold by their records, not what layout's
  slot held of it as the translation ended: that slot's digest changes with
  an edit elsewhere in its staff (OPEN B19), and all its other values are
  computed from the record and the arrays. A grob that spans a staff or the
  system and holds what its lines have (ledger lines, staff symbol, a line's
  group, the alignment, the spacing spanner, the delimiters, the staff
  grouper) gives its record alone, as a cell's hub does. A piece layout
  made gives its original's, mixed with which piece it is.
- **Checked, not assumed** (05 §6.3): with `--check-cells`, a line taken is
  filled too and compared, and the harness fails on one that differs
  (`lines_wrong`). The differential test on seed 1 (312 edits) has 0 that
  differ; 1,536 of 6,527 lines were taken from the compile before.
- **What is found whole, and why.** The forces: `get_line_forces` costs what
  the columns' descriptions cost (T29 3.3 ms natively, T24 4.4). The line
  breaker's dynamic programme and the page breaker's (with the page spacer),
  together 0.4–2.3 ms natively on the four. Kept and restarted at the first
  changed break or page, they would save less than their noise; 05 §6.2's
  "re-running the DP from there" waits for a figure that asks for it.
- **What it saves** is small: the pure heights `fill_line_details` asked for
  first are asked for by the line's system when it is broken
  (`break_into_pieces`), so T29's E3 gains 7.9 ms in breaking and pays 4.4 of
  them in the pieces (natively, net ≈ 3 of its ≈ 140 ms of layout). T29's 15
  lines all meet the edited measure on E1, through the bar lines whose
  `neighbors` hold it. Per-edit layout is OPEN B17's: a column's
  `horizontal-skylines`, 88 % of `springs-and-rods` (T29 ≈ 130–150 ms).

## D250 — Y7 before the line breaks: what a line's grobs got there given back as one, the line its unit, and a column's skylines by themselves

**Status:** accepted (MS6 step 8, part 2, 2026-10-31) · **Refines:** D248,
D249 · **Closes:** OPEN B17 · **Changes:** `crates/layout/src/cell.rs`
(`before_begin`, `before_end`, `Before`, `KeptBefore`, the columns' row
`COLUMNS`, `Line::records`, `kept_column_skylines`, `keep_column_skylines`,
`said_mark`, `said_since`, `rerunning`, the flags `PURE_Y` and `SAID`),
`system.rs` (`read_before_breaking` between them), `separation_item.rs`,
`grob.rs` (what a callback says marked on its grob), `paper_score.rs` (the
kept values traced), `crates/scheme/src/errors.rs` (`Cx::error_len`); the
compile example's `cells.tsv`, the harness's `cellsOf`; the core's test
`an_edit_lays_out_again_before_the_breaks_only_the_lines_it_reaches`

- **What is kept** (05 §6.1's columns' width descriptors and the lines'
  heights, B17's lead): from the end of the prebroken pieces to the end of
  `read_before_breaking`, every property written to a grob of a line, as it
  is then where the value holds no grob (D248's `portable`), each property
  removed, each offset and extent, its pure height, and the ranges of other
  lines and the break alignments it read. Given back at the start of the next
  compile's `read_before_breaking` to a line whose key and reads are the
  same, and the reads given back with it, so a later compile's reads hold.
- **The line is the unit**, not a value: a callback that runs before the
  breaks writes to the grob that asked as well as to itself (a beam's
  direction on its stems, a collision's shifts), and a value given back alone
  would leave the others to be computed after the breaks, where a broken
  spanner's pieces compute it apart. A line whose callbacks wrote to another
  line, to a column (but for the alignment's translations, a cache whoever
  reads first makes) or were written to from outside, read where a line is
  placed, ran a procedure of the score's own or said something (`SAID`: the
  error port or `(lily)`'s diagnostics grew while its callback ran, and a
  line given back would not say it again) is laid out again each compile.
- **What runs again:** each grob's `before-line-breaking` and
  `springs-and-rods`, read as before, on what was given back: they write the
  columns' springs and rods. What they write to their own grob is not kept
  (it would be written twice: a dynamic spanner's `bound-details`, found by the
  harness on T29), nor what a column's or the break alignment's callbacks
  compute.
- **Its key** is content and nothing an edit elsewhere moves: the output
  definition (D248's `settings`), the line's context, the moments of the
  breakable columns, the line's grobs by their records and grob arrays (D249's
  digest, not D248's `whole`, which holds a column's rank) and how many there
  are. What it read of other lines is checked by the same digests over the
  moments read; what it read of the break alignment by the records of what is
  break-aligned in each column it read (`COLUMNS`); what it read of the
  alignment's pure translations it reads again.
- **A column's `horizontal-skylines`** are in no line: kept by the column's
  record and what its grobs are, checked by what they read and, where they
  read the alignment's pure translations (a column's skyline is relative to
  the system), by the digest of those translations at (0, ∞) and the
  alignment's own pure place. An edit that changes a staff's pure height (T29's
  E1 by 1.06 staff spaces) moves the translations below it, and every column
  is computed again: by then from given-back grobs.
- **A cell's key** (D248) reads the break-aligned grobs' X offset and extent
  computed, not as cached: a column whose skylines were given back has not
  asked for them before the breaks.
- **Checked:** the differential test (each compile against one from scratch,
  byte for byte C0–C5) natively and in wasm, and the larger seeded run; a
  line given back that differed was found grob by grob (a check mode in the
  session's scratch, not kept: each line given back laid out again and
  compared).
- **What it holds** counts against B4: the values kept live on in the heap
  through the next compile, whose collector's threshold doubles them. What a
  compile's cells were made with (its digests, rows, the tracker's
  dependencies, the grobs' kept pure offsets) is freed once its pages are made,
  or the old translation the next compile resumes from would hold it, and the
  harness's one instance reaches the 256 MiB cap: 253 MiB there (OPEN C15).
- **What it saves** (natively, this build and 5dcab78 interleaved, the least of
  12): T29's E1 24 of its 29 lines given back, the pass before the breaks 127.4
  → 43.8 ms, E3 128.5 → 41.5; T24's E1 68.6 → 58.7, E3 78.0 → 19.9. T29's E2
  edits most lines (its token is a syntax error, which changes the settings,
  the breaks and nearly every line's records) and gives back none.

## D251 — 05 §7's queue: the visible page drawn first, and layout's steps each ending at a check

**Status:** accepted (MS6 step 9, part 2, 2026-10-31) · **Changes:**
`crates/layout/src/queue.rs` (new), `page.rs` (the pages prepared in order,
drawn in the queue's, what each says put back in order), `paper_book.rs`,
`system.rs`, `spacing_spanner.rs`, `separation_item.rs`, `axis_group.rs` and
`align.rs` (checks; `%queue-check` in the image's Scheme), `grob.rs` (a
check as a sub-step's callback ends), `lib.rs`; the core's `compile.rs`,
`lib.rs` (`Engine::set_visible_page`, `Times`' steps), `abi.rs`
(`lily_compile`'s `visible_page`, which it ignored), the compile example's
`--visible` and `--time` columns; `crates/scheme/src/heap.rs`
(`collecting_ms`); the core's test
`the_visible_page_is_drawn_first_and_changes_no_output`

- **The visible page** comes with each edit, as 08 §4.2's `lily_compile`
  already took it: 0, the first, unless the host says another (the harness
  and the driver say nothing: their default is the first page, so no
  protocol changes, PROTOCOL §6.2). A book's pages are drawn in the queue's
  order: the visible page, those after it, those before it, and the last
  page last, as it is spaced by the force of the page before it. Each page's
  lines, numbers and footnotes are given first in the pages' order, the labels
  after them, and what each page said while it was drawn is taken off and said
  again in the pages' order, so stderr is LilyPond's whatever the page shown.
  The pages' stencils and SVG stay in order: until the engine returns between
  steps (H3, MS6 step 11) nothing is handed over before the compile ends, and
  a page's stencil reads the labels of every page.
- **A step** ends at a check (`queue::check`): each grob's prebroken pieces,
  `before-line-breaking`, `springs-and-rods`, break, substitution and
  `after-line-breaking`; each line given back; each column's springs; each box
  of a column's skylines, each pure offset and each grob's part of a line's
  heights; each line the alignment places; each outside-staff grob placed;
  the end of each callback that ends one of 05 §7.3's sub-steps of a cell
  (`positioning-done`: collisions, accidentals, ties and dots placed;
  `control-points`: slurs and ties; `positions`: beams; `horizontal-skylines`
  and `vertical-skylines`; `adjacent-pure-heights`); line breaking; each page
  drawn; each grob's stencil; each page's stencil and SVG. A check is where
  B8's cancellation will look (a stop needs no return, as a stop for the host
  unwinds the compile); H3's returns to the host are at the queue's items
  (step 11).
- **Not a sub-step by forcing an order:** reading each line's skylines ahead
  of the page's spacing problem, the order 05 §7.3 names, changed T29's
  vertical layout (its MarkLine 5 staff spaces lower): the order LilyPond
  computes in is kept, and the checks sit where its callbacks end.
- **The collector's pause is its own step:** a step's time leaves out the
  collections in it (`collecting_ms`, every heap's), reported apart (`Times`'
  `collections`, `collect_ms`, `longest_wall_ms`).

## D252 — A grob's pure offset kept from the start of `read_before_breaking` to the break substitution, per columns

**Status:** accepted (MS6 step 9, part 2, 2026-10-31; R1's layout half, T29's
reflow) · **Changes:** `crates/layout/src/unpure.rs`
(`pure_relative_y_coordinate`, `keep_pure_offsets`, `forget_pure_offsets`),
`grob.rs` (`Grob::pure_offsets`), `system.rs`

- LilyPond computes a grob's pure Y offset each time it is asked
  (`Grob::pure_relative_y_coordinate` keeps nothing), and before the breaks it
  is asked again and again: by each column's skylines, each line's heights,
  each side position's supports (T29's E1: 33,860 marks set and taken off,
  ≈ 17,000 computations, most of the pass before the breaks).
- Before the line breaks nothing moves a grob purely: pure callbacks read what
  the translation made and other pure values. So an offset asked for again
  between the same columns is what it was: kept on the grob with the columns
  and an epoch that starts with `read_before_breaking` and ends where the
  break substitution begins (after which callbacks place grobs for real). Not
  kept: an offset whose computation said something (said again where
  computed again, as LilyPond says it), nor one cut short by an error.
- **Checked** by every output against LilyPond's references (the tools'
  layout, C3–C5 and stderr tests on the 30 and the fixtures) and by the
  differential test. **Saves** natively (interleaved with 5dcab78) T29's E2
  before the breaks 151.3 → 132.3 ms; laid out whole (`--no-cells`) T29's pass
  is ≈ 98–105 ms. The compile is not shorter for it on that edit (402.0 → 414.1
  ms, its collections 49 of them): OPEN B22.

## D253 — W4 and W8: a page for a preview is cells placed by height and ordered by content; pages go whole in `finished`, and `cells` comes before it

**Status:** accepted (MS6 step 10, 2026-10-31) · **Builds on:** D232, D248 ·
**Refines:** 06 §6.2–6.4 · **Closes:** OPEN E11

- **What the writer writes.** A compile with a visible page (`lily_compile`'s
  `visible_page`, from 1, `protocol.ts`' `visiblePage`; 0 is none, the
  harness's) writes `<page>.svg` in 06 §6.2's preview form, each glyph a
  `<path>` in place; with 0 it writes the file form, unchanged. Beside a page
  with some but not all of its cells kept comes `<page>.cells`: each cell's
  `digest:y`, in order, on a line, then the markup of those the page lacked.
  `driver.ts` makes of it `protocol.ts`' one message, `PageCells`.
- **`finished` still holds every page whole,** so `cells` is an optimisation
  and `finished` the truth: the preview applies `cells` to a page it shows, and
  `finished` then finds that page's text on screen and leaves it. A page that
  cannot take the cells (not the page the engine compared with) is replaced by
  `finished`. No revision or acknowledgement is needed between them, and
  nothing changes in `CompileOutcome`.
- **Three departures from 06 §6.3–6.4,** each found by measuring T29's E1, which
  sent 26 of 29 cells with the design as written:
  - **A cell is placed, not written, at its height.** `<g data-lily-cell="DIGEST"
    transform="translate(0, Y)">`, its markup relative to its topmost entry. A
    pitch moves the staves below it by a little, every coordinate of theirs in
    page terms; now a moved cell is a changed `y`. `PageCells` therefore carries
    `{ digest, y }`, not digests alone. Each number is rounded twice, within
    0.0002 of a staff space of the file form's (no comparator reads this form).
  - **A cell's text is ordered by layer, then by text**, not in LilyPond's
    order. Its `std::sort` is not stable: an edit shuffles the grobs of a layer
    in lines it did not touch. The file form keeps LilyPond's order. Grobs of
    two cells paint in cell order (from the top of the page down), so only a
    grob drawn over another line shows it, a `whiteout` reaching a staff below.
  - **A cell's digest is of its text,** not of what it was made from, so a page
    is the same bytes whichever entries were reused.
- **What is kept.** An entry (a grob's print stencil, or a markup's primitive)
  by a digest of all a write reads: the expression, its links, its place, the
  scale. Numbers are rounded at 1e-9, as a moved staff changes their last bits,
  except where a write prints them unrounded (`dashed-line`, `output-attributes`):
  the first version rounded those too, and the differential test caught a dash
  of T29 printed from the last compile's sum. 4 MiB at most, nearest the page
  shown first (README §4.5's L); a page beyond it is written again.
- **What R8 inherits.** `outcome.svg` is the preview form when a page is visible:
  an export goes through a compile with `visiblePage` 0, or writes the file form
  otherwise. The page's own use is R8's (D232).

  progress.md, MS6 step 10; `crates/svg/src/preview.rs`.

## D254 — H3: a compile returns between its steps; what it cannot divide is recorded, not split

**Status:** accepted (MS6 step 11, 2026-10-31) · **Builds on:** D241, D251, D253 ·
**Refines:** 05 §7.3, 08 §4.3

No ABI is added, and `protocol.ts`, `driver.ts` and `host.ts` are unchanged
(PROTOCOL §6's stop point 2).

- **The engine returns by holding its own state.** Without threads or stack
  switching (00 §1.1) a wasm call cannot be left and re-entered, so each loop on the
  path keeps its position in a struct and asks `lily_engine_music::returns::due`:
  the global loop between timesteps (`Going`, a replay's attempts in `Replaying`),
  `pre_processing` between grobs (`Processing`), the line details between lines
  (`Filling`, `Finding`), the substitution between grobs (`Substituting`), each
  system and page drawn (`PageDrawing`, `Drawing`, `Solving`), each page's stencil
  (`Output`) and each page written. `compile.rs`' frames are `Running` and `Work`.
  What is rooted stays rooted and the parse's module current between steps, as
  nothing else runs on the VM. Asyncify was not taken: it would instrument a core
  whose checks sit under indirect calls, and native tests could not run it.
- **`Engine::set_returns`:** on in `lily_start`, off natively, so a native compile
  and the tests that assert `DONE` from one `step` stay one call. A traced compile
  and one nested in a markup never return. The paper's `page-breaking` returns only
  if it is the default `ly:optimal-breaking`; anything else may be the user's
  Scheme, which no return can leave, and is one step.
- **A newer edit stops it without a new export.** `driver.ts` already steps and
  checks for a newer request between steps, so `Engine::put` and `Engine::compile`
  stop what is running, by the path a stop for the host takes. `Markup::begin`
  already forgets what a stopped compile wrote.
- **A stopped compile keeps nothing.** It may have resumed and changed the last
  compile's translations (D241), so `keep_translations` takes none and **the next
  compile runs whole.** So fast typing on a long score pays a whole compile after
  each stop. Measured and left for B6's decision and R8 (OPEN B24).
- **`springs-and-rods` is not split.** Its one read of a score's columns is the
  longest thing layout does at once. Running it outside `grob::property` would hide
  its reads from Y7's tracker, and a prepass of the skylines is the kind of reorder
  D251 found moves grobs (T29's MarkLine). OPEN B23 has it with the other stretches.
- **Tests.** `tools/compare/test/differential.test.mjs`: a compile at a budget of 0,
  returning at every point, and first stopped by a newer one at a point that moves
  with the edit, byte for byte the compile from scratch. A return that loses one
  grob was planted and failed in C0, C3 and C4. The deadline is the process's, so
  `crates/core/tests/returns.rs` is a test binary of its own.

  progress.md, MS6 step 11; `crates/music/src/returns.rs`, `tools/bench/b8.mjs`.


## D255 — N8's snapshots bounded: four to a translation, none older than four compiles

**Status:** accepted (MS6 step 12, 2026-10-31) · **Refines:** D241, D242 ·
**Changes:** `crates/music/src/resume.rs` (`KEPT` 16 → 4, `GENERATIONS` 4,
`Resumable::forget_old`), `crates/core/src/compile.rs` (`keep_translations`),
`crates/core/tests/memory.rs` (new)

- **What was wrong.** A resumed run keeps the snapshots before its edit, so the
  earliest of a chain lived for ever; `drop_pictures` drops only generations
  no snapshot needs, so no generation was ever dropped, and every compile's
  pictures and what they hold stayed. **T02 grew 0.7 MiB a compile and T24 2.5,
  natively and in wasm alike, without bound**: at D254's measure of three rounds
  it looked like a high-water mark, and at 41 compiles, about a minute of typing,
  T24 trapped in wasm at 229 MiB. OPEN C15's 3 MiB of slack was this.
- **What.** After a compile a kept translation forgets snapshots older than the
  last four compiles', with their pictures. A resume already takes an edit with
  no snapshot before it as a run whole, which takes them again. And a translation
  keeps four snapshots, not 16: each is a copy of the arena (D241).
- **Measured,** core.wasm in Node, one instance. High-water MiB, then the
  median translation ms and whole engine ms of an edit:

  | `KEPT` / `GENERATIONS` | T02 | T12 | T24 | T29 | T29 text-edit pattern | T24 E1, E3 translation | T24 E3 engine |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | 16 / none (before) | 228 at 240 compiles, climbing | 138 at 48, climbing | **traps at 41 compiles** | 241 | **traps** | — | — |
  | 16 / 8 | 39 | 86 | 212 | 241 | **traps** | 216, 80 | 423 |
  | 6 / 8 | — | — | 135 | 210 | 253 | 259, 77 | 409 |
  | 4 / 8 | 33 | 65 | 129 | 190 | 230 | 230, 146 | 468 |
  | **4 / 4** | **35** | **53** | **121** | **181** | **185** | 265, 219 | 574 |

  So T02, T12 and T24 come inside B4's Must, and T29 stays 70 MiB from the cap in
  the worst pattern seen. **The price:** a resume starts further from the edit
  (T29's E1 translation 300 → 400 ms in that table's host), an E3 runs further
  (T24's 423 → 574 ms whole), and an edit in one place runs its translation whole
  one compile in four. A trap loses the instance, which is worse than any of these;
  the constants are one line each, for B6's decision to move.
- **Not fixed by this.** T29 × 26 and a staff of 1,000 notes still need more than
  the cap (OPEN C15).

## D256 — B6 recorded as a miss; translation's cost per edit is R8's first step, and R8 owns the 26-page score

**Status:** accepted (the operator's answers at MS6's decision point, 2026-11-01) · **Refines:** D88, D233,
R7's answer 6 · **Builds on:** D255

- **The figures.** T02, T12, T24 and T29 × E1–E3 × 20 on the phones, by phase
  against README §4.3 (`$LILY_CORPUS/device-runs/2026-10-31-ms6-step12/b6-sum.txt`).
  Total ms and multiple of Must, E1 / E2 / E3 (E2 at twice the engine's phases, iOS at 0.6):

  | | T02 | T12 | T24 | T29 |
  | --- | --- | --- | --- | --- |
  | iPhone | 58 (0.39) / 66 (0.22) / 36 (0.24) | 230 (1.53) / 227 (0.76) / 131 (0.87) | 591 (1.97) / 688 (1.15) / 326 (1.09) | 648 (2.16) / 991 (1.65) / 329 (1.10) |
  | Emulator, host load ≈ 7–18 | 143 (0.57) / 156 (0.31) / 105 (0.42) | 495 (1.98) / 439 (0.88) / 233 (0.93) | 1,098 (2.20) / 1,287 (1.29) / 543 (1.09) | 1,090 (2.18) / 1,620 (1.62) / 578 (1.16) |

  T02 passes on both. **Translation misses on every score but T02's E2 and E3 on the iPhone, and T02's E2
  on the emulator (its E3 1.10):** on E1 the iPhone T12 4.3, T24 6.9, T29 11.6 times, the emulator 7.0, 7.8, 11.1. Layout
  misses at 1.1–2.7 on T12, T24 and T29. Parse, the SVG writer and the page are
  within Must but for the parse of T29 on the emulator (1.0–1.9) and on the iPhone
  (1.21 on E3) and of T12's E1 on the emulator (1.78), and T29's E2's page (1.0–1.1).
- **Answer 1: recorded; no step in R7.** The misses stand as misses, R7 closes at its
  step 13, and **R8's first step is translation's cost per edit**: OPEN C11, then
  snapshots that share records, so that D255's constants can rise. This takes R7's
  answer 6 as met by a step in the next plan, as D88 says: no one step reaches Must
  (C11 is worth a fifth to a third of translation, T29's E1 is 11.6 times over), and
  R8 is where typing can be measured.
- **Answer 2: R8 owns the 26-page score.** T29 × 26 traps on its first compile at
  241.6 MiB on the iPhone and the emulator, before layout, so README's "B8 with a
  26-page score" is **not passed in wasm**, and is measured only as far as translation
  (OPEN B23, C15). R8 reports an oversized score as a diagnostic, not a dead worker, as
  00 §2.1 intends for the cap, and takes the memory with C11's shared snapshots. MS6's
  B8 holds on the four: 0–19 ms on the iPhone, 0.4–49 ms on the emulator.
- **Answer 3: D255 stays** at four snapshots and four compiles.

## D257 — MS7's gate: four hard items hold the default, the other budgets are measured; the floor is read on a stand-in

**Status:** accepted (the operator's answers 2 and 5 at R8's split, 2026-11-01) · **Refines:** D88, D233,
D256, 00 §1 and §2, README §5's MS7 gate

- **Why.** Three texts disagreed: 00 §2 says a Must miss blocks shipping, IMPLEMENT.md that budgets are
  recorded and never gates, and the grand plan that every budget B1–B10 is met. D256 recorded B6 as a miss
  with no one step reaching Must (T29's E1 translation 11.6 times over on the iPhone), so R8 would not ship
  by the first reading, and would ship anything by the second.
- **What holds `?engine=1` from becoming the default (hard, at MS7 steps 9 and 10):**
  1. **No trap:** a score over the cap is a diagnostic, and the page goes on (D256's answer 2).
  2. **No killed tab** on the Android floor's stand-in.
  3. **B8 and B7 within Must:** B8 on T02, T12, T24 and T29, and on T29 × 26 if MS7 step 2 lets it run; B7
     on the tablet, as MS0's gate reads it.
  4. **The fallback works:** D55's tests with the engine and with it refused, and every compile the engine
     fails or cannot do reaching the server for that revision.
- **What is measured and recorded:** B1–B6 on the references. A miss over twice stops for the operator at
  MS7 step 10 (D88); under twice it is recorded. B9 and B10 stand as they are.
- **The floor (OPEN D4).** No A15-class Android is at hand, so **the Android e-reader stands in** (Snapdragon
  855, the floor's core type, Chromium 111, run once on 2026-10-22). It is recorded as a stand-in: the gate's
  floor item says that it was not the floor, and 00 §1's "Chrome, the last two stable versions" is not met
  on it. The iPhone and the emulator `mother_api36` still decide the references, the Android tablet
  beside them (D206, D233); B7 is the tablet's.
- **Consequences.** A failed hard item stops at step 9 or 10 with options. MS7's gate reads "measured" for
  B1–B6, so MS7 can close with B6 over Must, as MS6 closed. The runway's *Done when* reads the same way.

## D258 — N8 records what a next compile can read, takes its snapshots where one can use them, splices the same music at once, and a splice needs the old run's tail pure; replay is off

**Status:** accepted (MS7 step 1, 2026-11-01; OPEN C11's first half, C13) · **Refines:** D241–D244, D247, D255,
D256 · **Changes:** `crates/music/src/resume.rs` (`Place`, `thin`, `splice_same`, `splice_at`, `converges`,
`pure_since`), `checkpoint.rs` (`Recording::full`, `pass_checkpoint`, the digests of a splice's grobs, `against`
without copies), `partition.rs` (`see_new`), `context.rs` (`noting`, `ResumeBase`, `end_pure`), `global.rs`
(`checkpoint`, a snapshot where a resumed run begins), `replay.rs` (`ON`), `crates/scheme`'s `Globals::written`,
`crates/core`'s `keep_n8`, the compile example's `--chain`, `tools/compare/edits.mjs`' `typing`

- **Why.** D256: translation is the phase over Must. Each of a compile's bars paid for a state digest, a copy of
  the arena dropped at once in most cases, and a mark that logs every older object's first change again, for four
  snapshots kept; the snapshots were spread evenly, so a resume started up to a quarter of the score before its
  edit and had no snapshot near it to converge at; D255's bound ran an edit in one place whole one compile in four.
- **What a compile records.** Only what a next one reads: the shape, the first state, each grob's digests for Y7's
  cells, and a checkpoint's digests where a snapshot lets it be spliced at. The timesteps' digests, the other
  checkpoints', the partitions' rows, what translators hear and write, and `compare` are made under N8's checks or
  with a replay on (`Recording::full`). A checkpoint's digest is taken at the first timestep, where this run takes a
  snapshot and where the old run took one. **What a run does does not depend on it:** a checkpoint with no snapshot
  of the old run is never spliced at, so the harness's `--n8` runs decide as a shipped compile does.
- **Where snapshots are taken** (`Place`). A run from the start takes every `stride`th checkpoint, the stride
  doubling as it thins, not copying what it would drop. A resumed run takes one where it begins, in place of the one it
  resumed from, so the snapshots near an edit are never as old as `GENERATIONS` and **an edit typed in one place no
  longer runs whole one compile in four**; one at the last checkpoint before its edit, which replaces that; and at
  the second and fourth checkpoints past its edit, where the next edit there can splice. `KEPT` and `GENERATIONS`
  stay (D256's answer 3). Past the first checkpoints it takes none: a typed edit needs those, and a far edit runs
  from the nearest, or whole if it is before them all, which spreads them again.
- **The same music splices at once** (`splice_same`): at the snapshot it resumed from, every record the old
  run's as it ended. E3 was the translation run from its last snapshot to its end.
- **A splice needs the old run's tail pure** (`end_pure`). **Found by this step's own review, and missed by all of
  the harness's edits:** a splice leaves out what the old run did after the checkpoint, so a change it made there
  to what is older than the translation, undone with its compile, was never made again: on a score whose translation
  changes a pair's car late and whose layout reads it, the new code read 0 and 1 where a compile from scratch reads
  2. D243's splice had the same gap; near-edit splices made it common. `pure` now covers globals as well as objects
  (`Globals::written`, each change made with logging on): a part's load is not logged, as D234 has it, and does not
  count, or T29, which loads one, would never splice. **That also mends a miss older than this step:** the base
  engine read 0 for a global `set!` on a header edit, resuming past it. `older-*` and `global-*` in
  `differential.test.mjs` hold the four cases.
- **Replay is off** (`ON`), as D247 said it would be if B6's translation phase needed it. A replay saves nothing
  measurable (T29's E1 124.6 → 100.2 ms without it, E2 153.2 → 136.8, E3 46.4 → 44.6, natively), and a replayed
  run neither splices nor can be resumed from, so it costs what the rest of this decision gives. It stays right:
  `--replay-all` turns it on, and the harness runs N8's checks and the laid-out comparison with it.
- **A missing root found on the way, in `stem_tremolo.rs` and `bracket.rs`; no N8 code.** `raw_stencil` rooted its
  beam before `align_to`, which makes a new expression, and read callbacks after: a collection between them left a
  grob's stencil `(#f)` where the polygon was, in the pages only, every layout dump equal. **It was always there:** this
  decision moved when collections run, so the differential's T29 E2 for a preview, natively, after T02 met it. It came
  and went from build to build, and the base passed by luck. `bracket.rs`' `else` branch had the same gap, found by a
  scan for a root followed by a move and a call; `enclosing_bracket.rs`' uses only the extent after, and `beam.rs`' roots
  it next. **No score was found that shows it on its own:** the values in the window are cached by earlier reads, so what
  guards it is the differential (OPEN H15).
- **`splice`'s own cost.** `lines_up` digests only records that differ field by field (those the same have the same
  digests, the heap being one); a splice's grobs keep the old run's digests but its own; the shape is digested
  twice, not three times, in a resume; `Kept` is shared, the old run's end moved, not copied.
- **What it gives.** Translation per edit, the median of 8 in core.wasm in Node, one instance, against 8edff12 (B6's
  phase, ms), E1 / E2 / E3: T02 23.5 → 19.2, 22.5 → 17.0, 9.9 → 6.6; T12 85.5 → 54.6, 84.9 → 47.6, 31.0 → 12.2;
  T24 281.8 → 152.9, 296.9 → 162.7, **220.6 → 27.6**; T29 409.3 → 219.2, 420.7 → 341.7, 118.1 → 55.6: **×0.13–0.82.**
  The worst of an edit's runs, where the whole run one compile in four showed, T24 E3 762.4 → 393.1 whole, T29 E3
  696.9 → 361.9. High water T02 34.6 → 31.2, T12 58.3 → 40.6, T24 115.9 → 91.3, T29 185.5 → 145.9 MiB, fewer marks
  and copies. Natively ×0.35–0.77 (T29 E1 118.3 → 80.4, T24 E3 30.3 → 12.8). `core.wasm` 2,952,297 raw / 937,494
  brotli (+4,411, +2,004). **No edit reaches B6's translation Must**, as D256 said no one step would.
- **What is left, measured.** An edit that changes how many grobs a score makes cannot splice: record numbers move,
  which `lines_up` refuses, and a translator's list of grobs differs for ever after, so its digest never converges
  (T24's and T29's E1, whose raised note gains an accidental; taking `localAlterations` out of the digest changes
  nothing there, though it does block other scores, as MS6 step 4 found). An insertion moves every moment after it
  (E2). T29's E2 finds `m_e` at -2/1, before its first snapshot, and runs whole; why that node is not looked into.

## D259 — A translation's records in rows its snapshots share; a compile near the memory's cap stops with a diagnostic, counted by what the allocator holds; D255's constants stay

**Status:** accepted (MS7 step 2, 2026-11-01; OPEN C11's second half, C15's trap) · **Refines:** D241, D255, D256,
D257's first hard item, D258 · **Changes:** `crates/scheme/src/rows.rs` (new, `Rows`), `heap.rs` (`Gray`, `first_time`,
`collect_soon`, `over_memory`), `control.rs` (`set_room`, `short_of_memory`), `crates/music/src/records.rs`, `iterator.rs`,
`returns.rs` (`short`, `short_by`, `GROB_END`), `global.rs`, `crates/layout/src/grob.rs` (`with_grob` reads,
`with_grob_mut` writes), `item.rs`, `slots.rs`, `constrained_breaking.rs` (`Band`, `Matrix` by column),
`crates/core/src/lib.rs` (`counted`, `RESERVE`, `short_of_memory`), `abi.rs`, `compile.rs` (`give_up`), `diag.rs`
(`over_memory`), `packages/studio/src/web/engine/driver.ts` (`CORE_RESERVE`), `crates/core/tests/room.rs`,
`tools/bench/test/b8.test.mjs`

- **Why.** D256 gives R8 the 26-page score, and D257 makes "no trap" a hard item. T29 × 26 trapped at 254.1 MiB on its
  first compile; a compile that traps loses the instance, and its next edit would run into the same wall.
- **What a snapshot shares.** The grob and audio records, layout's grobs and the iterators are in `Rows`: 64 items to a
  row behind an `Rc`, a copy copying the pointers, a write copying its row (`Rc::make_mut`). A snapshot of 58,866 grobs copies
  about 2.4 MiB natively, N8's recording and the contexts; at 77,196 grobs the records and grobs alone were 51.6. The collector traces a row once however many copies hold it
  (`Tracer::first_time`, a stamp). **A read must not write:** `with_grob` is `&Grob` and `with_grob_mut` the writer, and
  `classify`, `object` and `property_data` read first. As they stood, one engraver's sweep at a translation's end
  un-shared the whole table at a go, the largest burst the trap had.
- **The collector's stack was the second largest burst.** It doubled to 64 MiB in one block on T29 × 26, then kept
  that block for ever. It is now blocks of 64 Ki entries, each going as it empties, and leaves out a value pushed lately
  (`recent`, 4 Ki), as a translation's records push the same definitions and events by the thousand before one is popped:
  under 20 MiB on T29 × 26, natively. **This is not OPEN C16, which this step looked for and did not find:** see below.
- **No one long block.** Line breaking's `lines`, n × n, was 91 MiB in one block on a staff of 609 bars, of which
  only lines that fit are ever written: `Band` keeps each column's written rows. `state` is by column.
- **A compile near the cap stops.** Wasm has no way back from an allocation that fails, so the core asks first.
  **What it asks is what is allocated, not what can be had:** `counted` wraps the allocator and adds each block's true cost
  (dlmalloc's header, rounded to 8, 16 at least). A first version looked for one free block of 32 MiB, and told a
  four-note score it needed more memory: memory that is mostly free can hold no such block. Requested bytes alone leave out those headers; how much was not measured. **Where it asks:** at `returns::due`, so a step returns; at the VM's cancel check, every 4,096
  calls and backward jumps, which reaches into steps that cannot return and goes out as a run cancelled for the host does, past
  every `catch`, the path a part's file already takes; and ahead of what allocates by the grob with no place to stop,
  before finalize (`GROB_END`, 2 KiB) and before layout starts (`GROB_START`, 1 KiB). `RESERVE` is 40 MiB, measured.
  Short, it asks for a collection (`collect_soon`, which gives back the chunks it empties) and stops if still short.
- **What it says.** `error: this score needs more memory than the engine may use (256 MiB)`, no pages; undone as a stop
  for a newer compile, so what the instance holds is what a stop leaves. The driver's outcome is `failed`, which MS7 step 7's fallback reads.
  **The driver's own catch stays as the last resort,** and takes a trap within `RESERVE` of the cap as the same message.
- **D255's constants could rise, and stay.** Snapshots' copies were the reason for 4 and 4; they are nearly free now,
  and more buys nothing: see the table. What holds memory now is each mark's pictures. D256's answer 3 stands.

  | `KEPT` / `GENERATIONS` | T29's high water, MiB | T24 E1, T29 E1, T29 E2, engine ms |
  | --- | --- | --- |
  | **4 / 4** | **125.3** | **654, 552, 1,060** |
  | 8 / 4 | 139.9 | 647, 547, 1,078 |
  | 8 / 8 | 142 | 667, 556, 1,073 |

- **Measured,** `core.wasm` in Node, one instance. `$LILY_CORPUS/device-runs/2026-11-01-ms7-step2/`.

  | | Before | Now |
  | --- | --- | --- |
  | B4: the text, E1–E3 and three rounds more: T02, T12, T24, T29, MiB | 31.4, 41.4, 99.3, 135.3 | **30.4, 35.7, 87.1, 118.8**: all under Must, T29 was over |
  | High water, B6's pattern | 31.2, 40.6, 91.3, 145.9 | **30.1, 36.1, 81.3, 125.6** |
  | Translation per edit on the four | | ×0.88–0.99, the engine ×0.93–0.99, layout ×0.94–1.00 |
  | T29 × 26 | traps at 254 MiB | **the diagnostic at 9.7–10.1 s, 176.5 MiB; the next compile 71–73 ms** |
  | T29 × 8 (README's XL4256) | traps at 255 MiB | **8 pages at 228 MiB, 18.7 s** |
  | A staff of 1,000, 1,500, 2,000 notes | 160 MiB, 249.5, traps at 182.5 | **5 pages at 123 MiB; 11 at 179; 18 at 226** |

  "Before" is 90390a8, each measured there. At the commit, 21 sizes from 1,000 to 16,000 notes and T29 × 3 to × 40, and
  typing near the cap, three runs of 17 compiles and two of 9: **no trap**, the highest 253 MiB, and each next compile in
  the instance gave its page, 15–82 ms after a diagnostic.
- **OPEN C16 was looked for and not found.** `engine.collect()`, then the bytes the process holds, each three edits, E1–E3
  alternating with the text, 240 compiles of T02 and 72–180 of T24: at this commit T02 18, T24 49–53; at 90390a8 T02 18, T24 56–60; at
  90390a8 with `KEPT` 16 and `GENERATIONS` 8, T02 18, T24 66–73; at 49aac65, MS6 step 12's own commit, with those
  constants, T02 21–22, T24 94–113. No step of 44 MiB in any. The stack reached 1 MiB on T02 and 16 on T24 at the most, so it
  cannot be T02's 22 → 65. Whatever that was, this measure does not show it. a4f9054's message says otherwise, and is wrong.
- **What this is not.** T29 × 26 does not run: natively it peaks at 954 MiB before this decision, of which snapshots are
  about 140. It wants layout's memory halved first (OPEN C19). The guard is measured, not proved: `RESERVE` and the two `GROB_`
  constants are what the scan needed, a Rust loop that allocates more than 40 MiB between two checks would trap, and
  so would a block larger than any free piece (OPEN C22); the driver's catch is what stands behind them. A score near the cap may fit
  from scratch and not as an edit (OPEN C20), and a diagnosed compile takes as long as it took to get there (OPEN C21).


## D260 — What Y7 reads of a line's hubs stands apart from its ranges; a cell carries the marks its group moves; a column is made again from its boxes when the lines move

**Status:** accepted (MS7 step 3, 2026-11-01; OPEN B18, B19, B21; B22 by measurement) · **Refines:** D248, D249, D250,
D252 · **Changes:** `crates/layout/src/cell.rs` (`Dep::hubs`, `Line::hubs`, `Range::hubs`, `carried`, `settle_marks`,
`marks_key`, `staves`, `outside`, `inside`, `Report::skylines_moved`), `separation_item.rs` (`KeptBoxes`,
`skylines_again`), `unpure.rs` (`translations_read`, `offsets_to`, `coordinate_from`, `steady_height`), `dump.rs`
(`column_skylines`, a new trace `skylines.tsv`, in no layer), `align.rs`, `side_position.rs`, `grob.rs`,
`crates/music/src/checkpoint.rs` (`GrobDigest::whole`), `crates/core/src/compile.rs`, `crates/core/tests/cells.rs` (new),
the compile example's `cells.tsv` and the harness's `cellsOf`

- **Why.** B6's layout phase is over Must on the phones (D256). Probing what kept things from being reused found the
  leads OPEN named were mostly not the causes, so the step followed the measurements:
- **A hub's read is no range.** A hub sits at its line's start. Reading one added its place to a range kept as one hull
  a line, so every reader depended on all the line before it, and every column on any edit earlier in the score. On
  T02, T12 and T24 that, not the translations B21 named, was why columns missed. What is read of a hub is now
  `Line::hubs`, the sum of the line's hubs' records. A hub's own place left a cell's range for the same reason, and a
  system's columns are checked only past its own, which the key holds and its neighbour shares at the edge.
- **`LedgerLineSpanner` is a hub.** It spans the staff, so its array held the edited note and put it in every system's
  key, as line breaking's keys had already ruled out (`is_line_hub`). Each system's heads are in that cell's key.
- **The translations are charged to no one** (`outside`, `inside`). `%align-pure-child-y-translation` is a cache whoever
  asks first makes. Run as that grob, it took in every line, and so did all that read the grob: one `Accidental` or
  `NoteCollision` depended on the whole score. `PURE_Y` is what the asker depends on, and it stays.
- **`GrobDigest::whole` names no grob.** It held references by number, which a grob added before them moves (OPEN B19,
  whose guess this confirms in part: an accidental an edit adds renumbers what follows). A cell's digest now takes the
  parents, bounds and objects by their records.
- **A cell carries the marks its group moves** (B18's cause found). A bar number or tempo mark joins a line in its
  `after-line-breaking`, after `reuse`, so what its group wrote to it read as a write across lines, and the cell was
  never kept. The compile before says which line took each mark (`Cells::marks`), and that cell holds it, last among its
  grobs. **Three things keep that right:** a mark is carried only if it passed no staff (`extremal`: a dead staff above
  is another line, which the cell could not see come to life); `after-line-breaking` is left out of what is given back,
  as the move's result is `#t` and the parent is the compile's; and its height on Y is not given back, as the move
  flushes it and, with one kept, its parents'. A digest of the staves (`staves`) is in the key of a cell with marks.
- **A column moved by the lines is made again** (B21, its lead as OPEN gave it). `KeptBoxes` keeps each box but where its
  line is put: its width, its height, the offsets up to its line's group. With the translations changed, a column whose
  key and ranges hold is made from those at the group's pure coordinate now, added as `pure_relative_y_coordinate` adds
  it (`offset + 0.0 + above`), bit for bit. A value that read a translation (`translations_read`, kept with each offset
  and height) is no box's: such a column, one with a bar number among others, is computed as before.
- **The boxes are one block a column, and at most `BOXES` (16,384, ≈ 1.5 MiB) a compile.** Kept one allocation a box, they
  took T29 × 8, which runs within a few MiB of the cap, from 8 pages to the memory diagnostic: a from-scratch output
  changed, found by OPEN C22's scan and nothing else, as no test holds a score that near. A score that large gets no
  boxes past the budget, its columns computed as before, as they are for what they exist for: an edit in an ordinary
  score. What is kept for an edit costs a first compile too, so near the cap it must be bounded.
- **B22's lead is not built, by measurement.** `%align-minimum-translations` is 0.4–5.4 ms a compile on the four (15 once
  on T24), so porting it saves at most that. T29's E2 is a syntax error that shifts all the music after it by an eighth: nothing
  can be reused, and its cost is `adjacent_pure_heights`, 106–152 ms of ≈ 240 (inclusive, nested), 30 % of it in the VM.
- **Figures and what was verified:** progress.md's *MS7 · step 3*.
- **`skylines.tsv` traces each column's skylines,** every number round-trip, so that a column can be held against its
  compile from scratch; `crates/core/tests/cells.rs` compares it byte for byte. **The harness counts how many columns are
  off, each edit and in its total (`skylinesOff`), and is not gated on it, as it is not zero and was not before this
  decision (OPEN B27):** on the four's 12 edits cc80fc5 has 6, 9 and 1 off (T02's E1, T29's E1 and E3), this has 1, 9 and 1, the
  same nine on T29 with the same values, and **no column is wrong here that was right there;** on T29's E1, with 35 made from
  their boxes, every row is cc80fc5's. No page and no other trace differs on those edits.
- **A check inside the compile was built first and removed: it was the check that was wrong.** It computed a given-back
  column again and compared. A given-back line's grobs hold what they ended with (dots placed by their column), which a
  fresh compile has not computed when it asks, so that computation is no reference. And the seeded run first quoted for it
  had not passed `--check-cells`, so its "0 wrong" meant nothing. **A figure from a check needs the run that turned it on.**
- **Guards taken out one at a time** against `cells.rs`: `extremal` and the move left out each fail tests. **Three fail
  none:** `staves` (on the score written for it every key changes anyway), the height left out of a mark's cell, and a box
  refused for an offset that read a line. They stay, each reasoned above, none shown necessary.
- **A read of another line's hub now checks that line's hubs' records, not what the line holds.** The old hull took in
  the part of the line before the reader by accident, never all of it, so such a read was never fully covered, and it
  covers less now. The differential is what stands behind it; a value that depends on another line's content through its
  hub alone would show there and is not otherwise guarded (OPEN B25).
- **Not this decision's doing, found by its test:** OPEN B26.

## D261 — A compile's steps divide what a return could not: a collection, a spacing read, a line's heights, a page's spacing problem; a stop leaves what the last compile kept

**Status:** accepted (MS7 step 4, 2026-11-02; OPEN B20, B24 closed, B23 narrowed) · **Refines:** D251, D254, D258, D259 ·
**Changes:** `crates/scheme/src/heap.rs` (a collection in parts, `Collecting`, `set_deferring`, `give_back`'s `given`),
`vm.rs` (`begin_steps`, `go_on_steps`, `abandon_steps`, `begin_collecting`, `go_on_collecting`), `crates/layout/src/`
`spacing_spanner.rs` (`Spacing`), `spacing_determine_loose_columns.rs` (`Pruning`), `axis_group.rs` (`Heights`),
`system.rs` (`Scope::LineHeights`, `PaperSystem`, `Placing`), `page.rs`, `queue.rs`, `grob.rs` (`OpenRead`),
`page_layout_problem.rs` (a check between systems), `crates/music/src/resume.rs` (`Rc<Snapshot>`, `resumed_from`,
`Snapshot::moved`, `Resumable::stopped`), `context.rs`, `global.rs`, `input.rs` (`Moved::moves`, `where_is`, `put_back`), `returns.rs` (`time_up`),
`crates/core/src/compile.rs` (`Stage::Ended`, `collected_by`, `stopped_at`, `stop_running`), `crates/core/tests/returns.rs`, the compile example's
`--collect-steps` and `--stop-moved`, the harness's `--steps`

- **Why.** B8 is a hard item (D257), and typing is a stopped compile after a stopped compile. In `core.wasm` the longest step
  was 224 ms on T24 and 205 on T29, an edit arriving at a random moment waited 39 and 47 ms on average, and the compile after
  a stop ran whole: 850 ms where the edit alone takes 350.
- **Most of OPEN's picture was wrong again, so the step followed a probe.** On the four the collector was not the longest
  step: at most 20 ms natively, where one read took 80. The long reads were one thing: `adjacent-pure-heights`, a line's pure
  height at every measure, computed once and paid for by whichever read came first, a column's skylines on T24, a
  `MultiMeasureRest`'s rods on T29; and `%page-layout-problem`, one call of Scheme.
- **A collection goes in steps of its own, with no barrier and no incremental mark.** OPEN B20 said a return cannot divide a
  collection. It can: nothing runs on the heap between two `lily_step`s, so what has been marked stays true. A compile in steps
  collects at a step's start, as long as the step's budget, and a step may be only that; a newer edit drops a marking halfway
  (the marks cleared, the collection's number spent, as `Rows` are stamped with it) and finishes a sweep, which has freed things.
  A safe point still collects if memory is short, or if a step has run on for `DEFERRED`, 4 MiB past the threshold.
- **A read is opened and run by its own loop.** `Spacing` is `set_springs` column by column, `Heights` is
  `adjacent_pure_heights` by grob and measure, `PaperSystem` a system's stencils by grob, each with `OpenRead` doing around it
  what `try_callback` does. Each is the one implementation, so a read from Scheme runs the same code whole.
- **Each line's heights are read ahead of `springs-and-rods`,** from the top line down, as a scope of `Processing`: this does
  force an order, which D251 found moved T29's marks when it was skylines. Pure heights, top down, moved nothing on the 30
  or M01–M12. **Bottom up changed a float's last digit on T29's E1, so the order is not free, and it is held by the differential
  alone.** A line's marks read the staff below (OPEN B28), which bottom up would have paid for. **Not on a score of more than
  32,768 grobs** (`LINE_HEIGHTS_GROBS`; T29 has 5,119, T29 × 8 35,272): what the read ahead holds took T29 × 8 over the cap
  on most runs, and such a score's steps are long anyway (B23). There LilyPond's own order stands, as before this decision.
- **A call of Scheme can return from inside.** The VM's frames are its own, so `Vm::begin_steps` can leave them on its
  stacks, rooted, and go on: `%queue-check` asks it to (`Cx::yield_step`) if nothing in Rust is under it, as in the spacing
  problem's systems and staves, and a call inside another is an ordinary one. A stop drops the frames.
- **A stop leaves what the last compile kept (B24).** OPEN's lead, keeping them until the first resume writes, would have
  done nothing: a resume writes within the compile's first step, so no edit arrives before it. So a resume writes nothing it
  cannot take back. The old arena stays whole beside the new one (`resumed_from`, where the collector reaches it), its snapshots
  shared by `Rc`; what the run takes of it with links in it is moved in copies (`Snapshot::moved`), only where they hold links;
  each object it gives back is pictured (`given`), and each of the old parse's places the edit moves kept as five numbers beside
  it, so that after the compile's undo `Heap::put_given_back` and the compile put them back. Pictured whole, the places cost
  T29 7 MiB of B4. So a stop leaves the kept translations exactly as they were, of the text they were made from, `resume_text`
  unmoved, and **the next edit is an edit of that text,** however many were stopped between. A stopped parse's objects stay
  of its text: what the parser keeps of them is before the next edit's first byte, so the move stops at the epoch the first
  stopped parse began in (`stopped_at`). **A first design moved the kept run forward at each stop, and failed:** `Moved` is one
  span, so a stopped text two places from the kept one could not be moved back. A stop for the host, or for memory, keeps nothing.
- **What the near-cap scan caught, as at D260, four times.** T29 × 8 fits by a MiB. Waiting for a step's end to twice the
  threshold grew the arenas, whose free slots count as used for good, so the wait is bounded at 4 MiB and past `DEFERRING_ROOM`
  a compile collects at safe points as it did; an epoch begun before every parse retired the free slots its parse would have
  taken, so it begins one only where there are translations to move; and the heights read ahead, as above. **When a
  collection comes is now the clock's, so a score this near the cap may fit on one run and not the next:** each fix was
  checked on four runs or more. Returns for time look at the clock alone (`time_up`): `due` also
  says memory is short, and asking it by the grob spent the 64 asks the memory's check waits for a collection with.
- **An older bug this step's test found, not fixed here (OPEN B31):** an edit in two places whose first is not music leaves
  the music between them in `Moved`'s one span, and a resume carries wrong places. Links only, no stop in it, at 5c6ec4d too.
- **What it costs.** Compile times 0.95–1.05 of the base's in `core.wasm`; B4 T24 100.8 MiB, from 87.6; `core.wasm` +12,543 raw. The rest in progress.md's *MS7 · step 4*.
- **Tests:** `crates/core/tests/returns.rs`, stops throughout a compile in one engine, by moved text, twice in a row, late and
  then the same text, with a collection at every step, in a parked call, and in a marking; the harness's in-steps tests, and a
  new one stopped with another text. Each of 15 guards was taken out in turn: 10 fail `returns.rs`, 2 more the harness, 3 nothing
  (OPEN B30).

## D262 — A text pack holds its metrics and ink boxes, its outlines a pack of their own a skyline asks for; the shipped core has no replay; core-debug and the licences beside it

**Status:** accepted (MS7 step 5; E14 by the operator's answer 3 at R8's split, E15 by answer 4; 2026-11-02) · **Refines:** D209,
D208, D56, D258, chapter 06 §5.3, 08 §1.3 · **Changes:** `packages/engine/tools/packs/text.mjs`,
`packages/engine/crates/fonts/src/text.rs`, `packages/engine/crates/layout/src/{font,pango,skylines,cell}.rs`,
`packages/engine/crates/core/src/{compile,diag,abi}.rs`, `packages/engine/crates/music/src/{replay,resume,context}.rs`,
`packages/engine/scripts/{build,sizes}.mjs`, `packages/engine/licenses/`

- **What.**
  - **A text pack (`LILT` 4) holds what layout measures with** (D209's fields) **and each glyph's ink box** (x, y min as zigzag,
    width and height), the box `text.mjs`' `inkBox` reads from the outline as crates/fonts' `ink_box` does. **Its outlines are a
    pack of their own** (`LILO` 1: the face's PostScript name, the glyph count, each outline), the module `<face>.outlines` of
    the manifest, on demand for all twelve faces. `TextFont::add_outlines` refuses one of another face, another count, or whose
    outline of a glyph does not draw the ink box the pack gave it. Outlines given before their face wait for it.
  - **A skyline asks for them.** `add_glyph_string_segments`, meeting a glyph that draws something in a face whose outlines no
    host gave, notes it on the face (`TextPack::wants_outlines`) and adds the glyph's kerned box meanwhile. A compile in steps
    stops at the next return (`Engine::stop_for_packs`, what `give_up` does, then `NEEDS`), one in one call at its end as W5's
    fonts do (D208); it is compiled again once the host has put them. Outlines the host could not give leave the boxes, and the
    compile warns: `the outlines of font 'C059-Roman' could not be fetched (font pack C059-Roman.outlines): its text is spaced
    by its glyphs' boxes`.
  - **The shipped core has no replay and none of N8's or Y7's checks:** `replay::on`, `resume::checking` and `cell::checking`
    are false in wasm, where nothing sets them (D258 turned replay off; the checks are the native harness's), and replay's entry
    points return at once when off. Natively nothing changes.
  - **`core-debug.wasm`** (08 §1.3): the core unsplit, built on stable with `panic = "abort"` and the `debug` feature, whose
    panic hook passes the message to `env.lily_panic` before the trap; its names kept; the manifest's `core.debug`; no budget.
  - **The manifest names the engine's source** (`source`: the repository, the commit, `dirty`), and **the licences** are served
    beside the core under their names (`licenses`): `NOTICE.txt` (what is under which), the GPL, LilyPond's licence with
    Emmentaler's font exception and the OFL, URW's licence with its exception and the AGPL. `packages/engine/licenses/` holds
    them; URW's two were read from `ArtifexSoftware/urw-base35-fonts` (master, 3c0ba3b), since LilyPond's install ships none.
- **Why.** B1 was 1.07 of Must, the three C059 packs 148 KB of it, and 29 of the 30 hold text: the operator chose all outlines
  on demand (answer 3). A skyline is the outlines' only reader (D209); measuring, widths and the SVG need none. The ink boxes
  move into the pack because a face measures text before its outlines come. Replay and the checks were 21 KB raw of the music row
  the page never runs.
- **The licence, read.** URW's file says the fonts are under the AGPL version 3 with an exception for PostScript and PDF
  documents that embed them: what D56 and D209 say. The text packs are the fonts in another encoding, so they are the AGPL's,
  served with its text and their source; the SVG pages name the fonts and embed none; the exception matters to W7's PDF (R9).
  The engine's GPL-3.0-or-later and the AGPL combine (GPL §13). Whether the fonts' source must be the OTFs themselves on the
  site, not a link, goes with OPEN I5 (step 9).
- **Measured** (progress.md, *MS7 · step 5*): the download 1,507,045 (1.005 of Must) with no outlines, **1,545,900 (1.031)
  with T02's**, which asks for `C059-Roman.outlines` alone; from 1,623,457 (1.08). Each metric pack 13.1–13.3 KB brotli
  (B2's Must 20). The music row 487,324 / 174,907 (1.16 / 1.09), from 508,372 / 182,637. 32 of the 95 scores and fixtures ask
  for outlines (18 of the 30, none of M01–M12), 15 of the 30 for Roman's. T02's first compile in `core.wasm` 156 ms on demand against 87 with its outlines given
  (the restart, OPEN C5).
- **Tests:** `crates/fonts`' unit tests and `tests/text.rs` (every face's outlines check its ink boxes);
  `crates/core/tests/engine.rs`' `a_text_face_s_outlines_are_asked_for_when_a_skyline_needs_one` (in steps and in one call,
  given early, offline). From scratch, the 42 and the fixtures natively traced, 1,270 files byte for byte against the base;
  in `core.wasm` 95 of 95 equal on demand and with every outlines pack given first.

## D263 — Every part a module, LilyPond's ly/ files the manifest's, an include's candidates at one stop, the text families as web fonts

**Status:** accepted (MS7 step 7; 2026-11-02; E2 by the operator's answer that session) · **Refines:** D74, D89, D208, D210,
D223, D236, D262 · **Changes:** `packages/engine/crates/core/src/lib.rs` (`PART_MODULES`), `packages/engine/crates/parser/src/lexer.rs`,
`packages/engine/scripts/build.mjs`, the tests that name what the core asks for (`crates/core/tests/engine.rs`,
`tools/bench/test/core.test.mjs`, `tools/compare/test/pages.test.mjs`)

- **What.**
  - **I2: every part of the image is a module** (`PART_MODULES`, 7): `display`, `diagrams`, `partcombine`, `modal` and `qr` beside
    `chords` and `fretted`, each written by the build (`<part>.part`) and named by the manifest as `part`. A page needs none of
    LilyPond's `scm/` files. **LilyPond's `ly/` files** (the 62 of 2.26.0) are copied beside the core as `ly-<name>`, each the
    manifest's module `ly/<name>` of the new kind `file`, which the studio's driver gives the engine as the file
    `<datadir>/ly/<name>` (D135); `modulesFor`'s `\include` trigger fetches it with the core.
  - **OPEN F: an include's candidates at one stop.** When the first candidate the host must be asked for is met, the lexer asks
    the ones after it too, up to one the host has, and the parse stops once: a file in LilyPond's `ly/` costs one parse more,
    not one a directory, and a nested include found beside the score one, not two. **The host is asked for `<datadir>/ly/<name>`
    beside a score's own file**, which the studio's driver answers itself; the operator's answer of 2026-10-27 left this open
    until R8 for that reason. No output changes: the same files are found in the same order.
  - **E17: the text families as web fonts.** The build copies the twelve faces of `LilyPond Serif` (C059), `LilyPond Sans Serif`
    (Nimbus Sans) and `LilyPond Monospace` (Nimbus Mono PS) beside the core as LilyPond ships them, and the manifest names them
    (`webFonts`: family, weight, style, file), as LilyPond's fontconfig maps its three families (D210); the studio's site writes
    their `@font-face` (D135). They are not the engine's download (B1): a browser fetches a face when a page draws text in it.
    The OTFs are the fonts' source, which OPEN I5 asked of the AGPL fonts.
  - **E2: deferred to R9 by the operator** (2026-11-02, asked at this step as PROTOCOL §6.2's stop: measuring text no pack covers
    with `OffscreenCanvas` makes the core ask its host for widths, past 08 §4.2's calls). T20's 77 lyric strings stay compared
    apart (D224, D227); the browser draws them with its own fonts, spaced as the core's fallback spaces them.
- **Why.** The page has none of LilyPond's files, so whatever the core would ask of `<datadir>` must come with the engine; the
  parts were already modules for two of seven. One stop for an include's candidates is the search's half of D89, which only a
  host that cannot answer `<datadir>` itself would pay for; the studio's driver can now. The web fonts make the page draw what the
  engine measured, which until now the browser drew in its default serif.
- **Checked:** `crates/core/tests/engine.rs` (the includes' asks and parses, T05's and T29's parts as modules, every page of a
  part given first the same); `tools/bench/test/core.test.mjs` (T01, T03, T19, T21's asks; T05's and T29's parts, natively and
  in wasm); the full suite. The manifest 3,221 → 7,626 bytes raw, 585 → 1,352 brotli (every visit fetches it, D133). Pages from scratch unchanged (the differential and the 30's
  gates in the full run).

## D264 — A compile for a page leaves its `\midi`s to `lily_perform`, which performs them whole after the page and keeps nothing

**Status:** accepted (MS7 step 8, M7; 2026-11-03; the operator's answer at this step to PROTOCOL §6.2's stop: *grow the ABI:
`lily_perform`*, the recommended of three) · **Refines:** D222, D241, D254, D261, chapter 07 §3.8, 08 §4.2 · **Changes:**
`packages/engine/crates/core/src/{compile,lib,abi}.rs`, `crates/core/examples/compile.rs`, `tools/compare/core.mjs`,
`tools/compare/differential.mjs`

- **What.**
  - **`lily_compile` with a page visible (`visiblePage` > 0) leaves its `\midi` definitions out** (`Engine::set_performs`): it
    translates the `\layout`s and writes the pages, and no MIDI file, playback map or performer's message. With no page (the
    harness's 0) it translates all, as before.
  - **`lily_perform(revision, root)`**, the ABI's one new export: the root parsed again (the parser's reuse makes it cheap), its
    `\midi` translations alone, **whole** (07 §3.8: no resume), and the books' MIDI files and map written as a compile writes them;
    `stderr` and `diagnostics.json` hold what those translations said, which LilyPond prints after the `\layout`s' (the parse's
    messages, `failed files:` and the unmet expected warnings are the page's). No `\layout` is translated, no page made.
    `lily_step` runs it in steps and a newer `lily_put` or `lily_compile` stops it, as any compile. A compile a translation's
    error ended performs nothing (LilyPond writes no MIDI file then, D132).
  - **A performance keeps nothing, ended or stopped:** N8's translations, layout's cells and the writer's markup stay as the
    compile before it left them (`leave_kept`, as a stopped compile leaves them, B24, D261), and a stopped performance moves no
    epoch (its parse is of their text). A compile resumes no translation made with other definitions (`kept_defs`).
  - The compile example's `--perform`, `compileInWasm`'s `perform`, and the wasm differential with a preview perform after each
    compile.
- **Why.** M7: the performance is 2–10 % of an edit's compile in `core.wasm` (T02 1.6–4.3 ms, T12 3–7, T24 7–28, T29 24–75),
  paid before the page. The operator chose a new export over a flag on `lily_compile` or leaving it inline. Whole, as 07 §3.8
  designed it: its translations kept for a resume would be the page's compiles' to keep, which the page's compiles no longer run.
- **Measured** (`$LILY_CORPUS/device-runs/2026-11-03-ms7-step8/`, `core.wasm`, medians of 5): **the page's compile ×0.85–0.98**
  (T02 E1 85 → 81 ms, E3 41 → 35; T12 E1 245 → 230; T24 E1 836 → 711, E2 897 → 810; T29 E1 734 → 673, E2 1,203 → 1,095); **the
  performance after it, whole, 5–6 ms (T02), 15–16 (T12), 39–40 (T24), 69–102 (T29)**.
- **Checked:** `crates/core/tests/engine.rs` (its MIDI file and map the whole compile's byte for byte, the page's messages then
  its own the whole compile's, nothing after an ended run; five edits with performances ended and stopped between them, each
  resumed and each page and performance a fresh engine's); `worker.test.mjs` (the 30's 60 MIDI files and maps after the page
  those of the compile with its `\midi`s; the extension's sample's `sample.midi`, LilyPond's, byte for byte; C0 on T03 and the
  cases with the performance's messages after the page's; C1 on the 30 by the performance's map); the wasm differential with a
  preview, performances between the compiles, equal in C0–C5.
- **Not done.** Multi-score files' messages: the performers' come after all the `\layout`s', where LilyPond interleaves them by
  score. An expected warning a performer would meet is unmet in the page's compile. A multi-book run a `\layout`'s error ended
  performs nothing, where LilyPond writes the books' before it.

## D265 — R8 closes with MS7's gate passed but for the default and run 2's typed edits: both recorded, both R9's first

**Status:** accepted (MS7 step 11, R8's close; 2026-11-04; the operator's answer at the close, *close, gate partial*, the
recommended of three) · **Refines:** D257, D137, D138, PLANS.md R8's gate and exit, the runway's *Done when*

- **What.**
  - **MS7 closes** with its gate read item by item: D55's tests with the engine and with it refused, the page driven end to
    end in Chromium and WebKit, a second visit asking only the manifest, rendering going on with the network dropped, no trap,
    no killed tab on the stand-in and the fallback working: **passed**; B1–B6 **measured and recorded** (D257); **two hard
    items failed** on T29 alone and are recorded as failed, not met: **B7 on the Android tablet** (T29's page 63–116 ms after
    D138, against 50) and **B8 through the page** (a newer edit waiting out T29's parse: 28–190 ms on the emulator, 69–74 on
    the Android e-reader, 49–80 on the tablet).
  - **The engine is not the web's default at R8's close.** `esbuild.mjs --site --engine-default` (D137) is built and driven and
    stays out of `build:site`. Three things hold it: the engine's source public at each shipped commit (OPEN I5, the operator's),
    B7 on T29 (OPEN I3) and B8 on T29 (OPEN B23).
  - **R9 takes them right after its first step (the typed edits, below):** T29's parse divided by its segments and `create_top` made lazily (B23), a page's rendering
    divided past one frame of the whole edit's cells (I3), then the soundness items the default waits on (B25–B27, B29–B31, C18,
    H15), then the flag in `build:site` once the source is public and the gate's web half again on the shipped build. MS8's
    own work (W7, Y8, P12) follows.
  - **The full runs, as they ran:** run 1 all green; **run 2, with the gate's larger differential (`LILY_DIFFERENTIAL=30
    LILY_DIFFERENTIAL_SEED=2`), green but `test:tools` 301 of 305.** The four failures are the typed-edit tests at 32 edits a
    score, a size MS7 step 1's `typing` had never run at: T29's `type-21-pitch` and `type-22-again` (one `stroke-dasharray` in
    its 16th digit, OPEN B29) and, for a preview, T26's `type-31-pitch` (a cell's digest, OPEN B32); every seeded edit 912 of
    912 equal. Naming them in the harness's KNOWN was tried (the operator's first answer) and showed N8's checks contradicted on
    four more typed edits (OPEN C15) and the preview's page check behind them; **the operator's second answer: take the change
    back and record run 2 as failed.** No test names them. **R9's first step fixes them, with run 2's size in its suite**,
    before the default's items.
  - **LEDGER.md names R9's split** as the next action, as PLANS.md R8's exit says; R8 is *closed*, not *open*, and no R8b is made.
- **Why.** The operator's answer at step 10 already said the default waits on B7 and B8 as it waits on the source, and that R9
  divides T29's parse and a page's rendering. Holding R8 open for them would put MS8-sized engine work (the parse by segments)
  into a plan whose estimate it was never in; a separate R8b would split one decision (the default) from the work that decides
  it. What ships today is unchanged: `?engine=1` on the web, the server by default.
- **Consequence.** The grand plan's *Done when* for this chunk ("every budget B1–B10 met", "the suite green") is not met as
  written, and the close says so: two hard items fail on T29, and run 2's `test:tools` is 301 of 305. MS7's summary in
  progress.md gives each gate item and each run its verdict.

## D266 — What prints a number unrounded is reused only for the same bits; N8's shape in time order and its records' interfaces by name

**Status:** accepted (MS8 step 1, R9; 2026-11-05) · **Refines:** D248 (*Why the quantum*), D253 (an entry's digest), N8's
shape and record digests (MS6 steps 4–7) · **Changes:** `crates/layout/src/cell.rs` (`KeptCell::exact`, `Now::exact`,
`prints_exact`), `crates/svg/src/preview.rs` (`Sum`, the place's digest), `crates/music/src/checkpoint.rs` (`own_digest`'s
children, `grob_digest`'s interfaces), `tools/compare/test/differential.test.mjs` (`N8_KNOWN` less T26's `insert-2-23`)

- **What.**
  - **A Y7 cell whose kept values hold a `dashed-line` or `output-attributes` expression is reused only where its system's
    columns' X (and the break-aligned grobs' X and extents) are the same bit for bit**, beside the key's 2⁻²⁴. Every other cell
    keeps D248's quantum.
  - **A preview entry's digest sums its numbers bit for bit, and its place as it is printed** (`Fixed`, four decimals), or bit
    for bit where the entry translates, rotates or scales what it holds before the place is printed. D253's 10⁻⁹ rounding is
    gone.
  - **N8's shape puts a node's `element` before its other music:** a repeat's body before its alternatives, in the order they
    are iterated, which the walk from the front takes for time.
  - **A grob record's digest sums its interfaces' names,** not the numbers its translation gave them as it first met them.
- **Why.** Run 2's larger differential at R8's close (D265; OPEN B29, B32, C15). D248 keyed a column's X to 2⁻²⁴ as "below the
  4 decimals any output writes"; `stroke-dasharray` is written with Guile's `~a`, so T29's dotted `\moltocr` line, given back
  from a compile whose column was 3·10⁻¹⁴ away, printed its 16th digit otherwise. D253's rounded entry digest took a box's old
  text whose fourth decimal, at its boundary, was another (T26). Under `\relative` a pitch in a repeat's body moves the
  alternatives an octave; the shape held them first, so `m_e` was the alternatives' start, after the body's changed note
  (T10). A staff's records at 0 "differed" when another staff's noteheads came first and the interfaces were numbered
  otherwise (T04), which resume and replay already map by symbol. Each was a key or digest that named less, or other, than
  what it stood for; none changed what a compile from scratch makes.
- **Cost.** T29's 32 typed edits reuse 341 cells of 896 against 342; the preview takes 24,012 of 51,576 entries against
  24,454 (T26 3,208 of 5,768 against 3,389). The shape's order and the interfaces' names change no compile's output.
- **Left.** N8_KNOWN's T04 `error-2-9` (its `\midi`'s audio records at 0 of a staff the edit did not touch) and T09
  `delete-2-30` (`)` after a `\grace` block), each compile equal to its fresh one.

## D267 — A compile's parse returns between its segments; a line of marks' read and a `\score`'s one Scheme call stay whole

**Status:** accepted (MS8 step 2, R9, 2026-11-05; OPEN B23 narrowed, B28 measured) · **Refines:** D235 (the segments),
D254, D261 · **Changes:** `crates/parser/src/reuse.rs` (`Parsing`, `ParseStep`, `parse_on`, `Parsing::stop`,
`Segments::paused`, the stop in `segment_boundary`), `crates/parser/src/lib.rs` (`parse_with`'s paused parse, `Ending`),
`crates/core/src/compile.rs` (`Parsing`, `Engine::parse_on`, `stop_parsing`), `crates/core/src/lib.rs`
(`Engine::parsing`, `running`, the stage `parsing`), `crates/core/tests/returns.rs`

- **Why.** B8 is a hard item (D257), and at R8's close a newer edit 20 ms into T29's compile waited out its whole parse,
  one step (OPEN B23): through the page the emulator 28–190 ms, the e-reader 69–74, the tablet 49–80; in `core.wasm` T29 × 8's
  parse 333 ms and T29 × 26's 1,130 were one step each.
- **What.**
  - **In a compile that returns, the parse stops at the first boundary between its segments (D235) after the step's time is
    spent** (`time_up`), and the next step goes on from there: a parser made again on the lexer at that place with what had
    been said, made and included, the parser's state as the boundary recorded it, in the same module, as a parse started
    again there after an edit is (02 §5.7); the segments' items stay in the undo log, and the old segments it may still take
    over stay with it. The stage between its steps is `parsing`. A native compile, a traced one and a nested one never
    stop, so they are one call as before, and the 42 compile byte for byte as before natively.
  - **A newer edit stops it as it stops a compile under way:** what it parsed is left to the next parse as a parse that
    ended at that boundary, undone and kept for doing again (`Parsing::stop`, `Reuse::undo`), so the next parse may do those
    segments again rather than parse them; its objects are of its text, so only older ones move to the next (`stopped_at`,
    D261). No collection runs between a parse's steps.
  - **Only a compile that returns asks the deadline** (`parse_again`'s `returns`, the engine's `returns && !trace`): the
    deadline is the process's, so a parse that asked it whatever its compile stopped when a returning engine on another
    thread had set one, and its `step` gave `MORE` to a caller that wanted one call (`engine.rs`'s
    `the_visible_page_is_drawn_first_and_changes_no_output`, with no outputs, in the suite's first full run), as layout's
    loops never do (`Cx::returning`).
- **Measured** (`$LILY_CORPUS/device-runs/2026-11-05-ms8-step2/`, `b8ab.sh`: `tools/bench/b8.mjs` with 712f5c2's
  `core.wasm` and this one in turns, the Mac at load 12–32). **A newer edit 20 ms into the compile waits T29 4.8–8.6 ms
  (712f5c2 33.7–41.4), T29 × 8 8.0 (436.4), T29 × 26 9.5 (1,198.0).** An edit's compile stopped 20 ms in: T29 17.7–19.2
  (16.2–18.4), T29 × 26 53.8 (1,329.2). The whole compile's time within the load's noise (T29 3,157–3,411 ms against
  3,230–3,515); `core.wasm` +2,764 bytes raw.
- **Not divided, measured:**
  - **A `\score` item is one segment,** and its `scorify-music` walks the whole music in Scheme under the parser's frames,
    where D261's returns from inside a call cannot reach: natively T29 10 ms, T29 × 8 161; in `core.wasm` a newer edit 200 ms
    into T29 × 8 waits 211–223 ms, into T29 × 26 1,052–1,067. The lead: the toplevel handlers' call made after the item, in
    steps of the VM's own (`Vm::begin_steps`).
  - **`create_top`:** T29 × 8 283–300 ms natively, its music lengths (`ly:music-length` through the unfolded repeats'
    elements, in Scheme), not made lazy; T29 × 8's longest step in `core.wasm` is 1.3 s.
  - **B28, a line of marks' read, stays whole** (natively 46 ms of a 52 ms step on T29; its longest in `core.wasm` 148–177
    ms): the MarkLine's first mark reads the 27 lines below it, each whole, top down. Reading such a line (`staff-affinity`
    DOWN) after the lines below it, or holding its read at its first outside-staff grob while they are read, takes T29's
    longest step natively to 22 ms with every line's heights bit for bit the same, **but moves T29's dotted `\moltocr` line
    from LilyPond's `stroke-dasharray` 2.9384833592448927 to …945**: another pure value read on the way is not the same in
    another order (B27's frame). LilyPond's order is the one that gives LilyPond's bits, so neither was taken.
- **Tests.** `crates/core/tests/returns.rs`: a parse of 15 segments returns at each at a budget of 0 and writes what the one
  call writes; another text's parse stopped early, in the middle and late, by an edit before where it stopped, one after,
  and the text before it, each then the whole compile's; a segment the stopped parse ran defines a variable in `(lily)`,
  which the next compile warns of unless the stop undoes it (the test fails when `Parsing::stop` is left out). The harness's
  in-steps differential (a budget of 0, and stopped by a newer compile) now stops in the parse too.

## D268 — A column reads a grob where it read it first; an edit in several places moves its places by its lines; collections forced at procedure entries

**Status:** accepted (MS8 step 3, R9, 2026-11-05; OPEN B27 narrowed, B31 closed, H15 answered by a mode and a sweep) ·
**Refines:** D250, D260 (a column's skylines before the line breaks), D244 (`Moved`), D258 · **Changes:**
`crates/layout/src/separation_item.rs` (`Place`, `kept_place`, `Place::extent`, `boxes`), `crates/layout/src/cell.rs`
(`Noted`, `note_place`, `notes_places`, `moved_since_read`, `given_place`, `Before::first_place`, `Report::before_moved`,
`before_places`), `crates/music/src/input.rs` (`Moved`'s blocks, `same_lines`, `Moved::exact`), `crates/core/src/compile.rs`
(no resume after an edit `Moved` cannot follow), `crates/scheme/src/heap.rs` and `vm.rs` (`set_collect_every`,
`Heap::collection_forced`), `crates/core/examples/compile.rs` (`--collect-every`, the cells line's two counts),
`tools/compare/differential.mjs`, `tools/compare/test/differential.test.mjs`

- **Why.** Three of the soundness items the default waits on (D265). **B27:** a column's skylines computed on a line given
  back, or made again from its kept boxes, could be off from scratch (on the four's 12 edits 1, 9 and 1 columns, no page
  moved), and the harness counted them without a gate. **B31:** `Moved` was one span from the first byte changed to the
  last, so an edit in two places (a comment added above, a note changed below) left the places of the music kept between
  them where they were: the page's links off by the lines the first place added. **H15:** a value Rust holds unrooted across
  a call into Scheme is swept only if a collection falls in that window, which timing decides.
- **What.**
  - **B27's cause, found:** `Separation_item::boxes` reads an item's pure Y, then its X; reading a dot's X runs its
    `DotColumn`'s positioning, which puts a dot read on a staff line into a space. A compile from scratch has the dot's box
    where it was read; a line given back holds the dot where it ended, and the kept boxes were taken after the X, so they
    held it there too. **Now the place a box was read at is taken before its X** (`kept_place`, for the kept boxes and for
    the note below), and **while the columns' skylines are computed before the line breaks, where each reads a line's grob
    on Y is noted** (`note_place`); at the end, a grob not where it was first read is kept with that place
    (`moved_since_read`, `Before::first_place`), and **a column computed on its line given back reads it there**
    (`given_place`, `Place::extent`: the offsets up to the common refpoint if it is on the way to the line's group, else up
    to the group and the group's pure coordinate). A grob read in two places by the columns keeps its line from being kept
    (`before_moved`; none on the 912). A place that does not stay with its line is not compared, as before.
  - **B27's gate:** E1–E3 on the four have no column off from scratch (`differential.test.mjs`, beside T29's moved columns);
    the seeded edits count them (`skylinesOff`). **Seed 2's 912 have one edit with 2 columns off, T23's `pitch-2-19`, the
    same at 809d938:** the bar line before a dotted note reads its neighbours' pure heights (`account-for-span-bar`), and in
    the incremental compile the next column's dots have been put by then where from scratch they have not; no page differs.
    At seed 1 T23's `pitch-1-9` has 2 and T25's `duration-1-10` 4, each the same at 809d938. **Both causes fixed after
    (2026-11-06):** a column's skylines taken from the last compile skip what computing them wrote to other lines' grobs (a
    dot put by its column, which T23's bar line reads), so `keep_column_skylines` keeps the lines written since the column
    began (`Tracker::crossed`, `KeptSkylines::wrote`) and a column is taken only where each of them is given back; and
    `stem.rs`' `cache_pure_height` now marks a beam's stem height that read the translations as moving (T25's cross-staff
    stem kept as steady). The harness then gates every edit on no column off.
  - **B31:** `Moved` aligns the span's lines (Myers' greedy diff, `same_lines`): a place in a block of lines the edit left
    as they were moves with the block, one in a change as far into what replaced it, and a message on such a line moves
    with it (`said`). A side of one line is only searched; **an edit that changes more than 256 lines in several places is
    not followed (`Moved::exact`), and the compile after it resumes no translation**, so no place of kept music is left
    where it was. The diff keeps only each round's diagonals: at 256 lines, half a megabyte at most.
  - **B31, two edits on one line:** inside each change of lines `Moved` matches its bytes too (up to 4,096 a side; a
    larger or heavier change is one replaced whole, as before).
  - **B26:** a mark that joins a line's group given back without it (a staff above died again) takes away the group's
    `Y-extent`, `vertical-skylines` and extent given back, so they are computed with it as from scratch, and that cell is
    not kept (`Given`, `carried`, `keep_cells` in `cell.rs`).
  - **C18:** `lines_up` takes the old run's digests with each object the resume gave back as it was at `then`
    (`Heap::with_held_at`, from its first picture at or after `then`), and refuses a splice where an object older than the
    snapshot resumed from digests otherwise now than then (`resume.rs`' `Old`, `Snapshot::epoch`, `Splice::since`).
  - **B25:** a line's grob reading another line's group or ledger lines (the hubs that line's grobs make) depends on
    that whole line, a staff symbol and a column's read of a line's place on records alone (`Tracker::holds`,
    `Dep::contents`, `Range::content` in `cell.rs`): with `\RemoveEmptyStaves` a staff's spacing reads whether the next
    staff lives.
  - **B30:** each of D261's guards and `DEFERRING_ROOM` has a test in `returns.rs` that fails without it (`given`'s tracing
    in a debug build only).
  - **H15:** `set_collect_every(n)` makes every `n`th procedure entry of the process's VMs a collection (the compile
    example's `--collect-every`); nothing sets it in wasm. Each window that calls into Scheme at least `n` times is then
    swept there.
- **Measured.** E1–E3 on the four: 12 of 12 equal, no column off (was 11 off); lines given back before the breaks T29's E1
  24 of 29 (one stricter guard tried first, a line not kept when a grob moved after a column read it, took T29's E1 to
  19, its layout 52 to 89 ms natively, and was not kept). Seed 2's 912 natively: all equal in C0–C5, 608 grobs kept where
  first read, 0 lines refused. **H15:** the 42 (the 30 and M01–M12) at every 50th entry and at every 7th, and T02 at every
  entry (507 s against 0.36), each byte for byte as without (`$LILY_CORPUS/device-runs/2026-11-05-ms8-step3/h15/`).
- **Tests.** `crates/core/tests/cells.rs`: `dots_moved_after_their_column_read_them_are_read_where_they_were` (a dotted
  note on a line above an edit, and a staff moved below a high note; fails with the place kept after the X, and with
  `given_place` left out) and `an_edit_in_two_places_moves_the_places_between_them` (fails with one span);
  `crates/music/tests/moved.rs`: the two places' blocks, links and messages, and an edit too large to follow;
  `crates/core/tests/collect.rs`: a score through D258's two windows compiled with collections at every 97th and 211th
  entry, each as without (at those strides it does not find D258's stem tremolo window taken out: only every entry is
  sure to, which the sweep runs).

## D269 — A preview's compile in steps hands its visible page over as soon as it is written

**Status:** accepted (MS8 step 4, R9, 2026-11-06; OPEN I7 closed by the operator's answer 3 at R9's split, PROTOCOL §6.2) ·
**Refines:** D251 (the visible page drawn first), D253 (a page sent by its cells), D254 (`lily_step`) · **Changes:**
`crates/core/src/compile.rs` (`Work::handed`, `Work::hand_over`, `Cx::visible`, `Work::on`, `Engine::go_on`,
`Engine::step`), `crates/core/src/abi.rs` (`lily_outputs`' doc), `crates/svg/src/preview.rs` (`Markup::peek`,
`Markup::cells`), `crates/core/tests/engine.rs`, `tools/compare/core.mjs`

- **Why.** 05 §7.2's item 3: the engine handed every page over at the compile's end, so the page the preview shows waited
  for the pages after it and for the compile's own end (OPEN I7; the operator's answer 3 at R9's split: the ABI grows by an
  output before `Step.Done`, with a decision).
- **What.** In a compile for a preview (`visiblePage` > 0) that returns, **the step that writes the visible page returns
  `MORE` at once, and `lily_outputs` / `lily_output` then give that page: `<page>.svg`, and `<page>.cells` when it goes by
  its cells, named and made as the outputs at the compile's end will hold them**, the same bytes (`Markup::peek` gives the
  cells `Markup::page` gives, its report left alone). They are the host's until its next call, which clears them; after any
  other `MORE` the outputs are empty, as they always were. No export, argument or `Step` value is added: a host that reads
  no outputs after `MORE` sees what it saw before. The page is counted over the books as `visible_page` is (the writer's
  index, `Markup::mark`). A compile stopped after it for a file or a pack (`NEEDS`) is started again and hands it over
  again; an error in a later page of its book leaves the outputs at the end without it, and the host shows those.
  A compile that does not return (natively, traced) or is not a preview's hands nothing over.
- **Measured** (core.wasm, steps of 10 ms as the driver steps, E1–E3 after each score's text, median of 7, the Mac at load
  15–19; `$LILY_CORPUS/device-runs/2026-11-06-ms8-step4/handed.jsonl`): **the page comes 1–13 ms before the compile's end**
  (T02 1.0–2.5 of 35–83 ms, T12 2.3–2.6 of 114–248, T24 5.3–13.1 of 348–788, T29 5.5–8.6 of 369–1,093), on every run. The
  writer is the last thing a compile does, and its end (the kept translations, N8's records, the cells) is short. **Not
  more:** on a score of one page (T12, T29) the page is the whole layout, so nothing earlier is possible; on a score of
  several, what the page still waits for is the other pages' drawing and stencils, made before any page is written
  (`paper_book::Output`: the breaker draws the visible page first, then the others, then `%page-stencil` for each). Handing
  it over when it is drawn means its stencil and its writing inside the breaker's steps: the lead, not built.
- **Checked.** `engine.rs`' `the_visible_page_is_handed_over_before_the_compile_ends` (four pages, the second shown: handed
  over once, whole on the first compile and by its cells after an edit on it, each the end's bytes; nothing with no
  preview; fails without the hand-over); `tools/compare/core.mjs` checks every page handed over against the end's bytes, so
  the wasm differential for a preview (seed 2's edits) checks it on every edit.

## D270 — W7's PDF: a crate of its own, pdf.wasm, writing the core's display list with music as XObjects and text as subset URW CID fonts

**Status:** accepted (MS8 step 5, R9, 2026-11-06; the operator's answer 5 at R9's split, the licences read again first) ·
**Refines:** D56 (the licence), D209 and D262 (the URW fonts and their source), D5 (no point-and-click in exports) ·
**Changes:** `packages/engine/crates/pdf/` (new: `list.rs`, `cff.rs`, `lib.rs`, `stencil.rs`, `module.rs`,
`tests/pdf.rs`), `packages/engine/Cargo.toml`, `crates/core/{Cargo.toml,src/lib.rs,src/compile.rs,examples/compile.rs}`,
`scripts/build.mjs`, `scripts/sizes.mjs`, `tools/compare/test/pdf.test.mjs`, `licenses/NOTICE.txt`, 06 §7

- **The licences, read again before building (answer 5).** URW's `LICENSE` and `COPYING` at
  `ArtifexSoftware/urw-base35-fonts` master (3c0ba3b, 2023-05-03, the commit D262 read) are byte for byte
  `packages/engine/licenses/URW-LICENSE.txt` and `URW-COPYING.txt`: the fonts under the AGPL version 3 with the exception
  "to include these font programs in a Postscript or PDF file that consists of a document that contains text to be
  displayed or printed using this font, regardless of the conditions or license applying to the document itself". The
  OTFs LilyPond 2.26.0 ships say "Copyright 2014 by (URW)++". The engine's `LICENSE` is the GPL version 3; LilyPond's
  licence keeps Emmentaler's font exception. **What D56 and D209 say, so nothing stops.** A PDF the module writes embeds
  subsets of the URW programs in a document that displays text in them (the exception) and draws Emmentaler's glyphs as
  outlines (its font exception, as the SVG pages do); the module itself is the engine's, GPL-3.0-or-later. **E5's five
  placeholders** (`ly:otf-font-table-data`, `ly:get-font-format`, `ly:has-glyph-names?`, `ly:get-cff-offset`,
  `ly:extract-subfont-from-collection`) are called only by `framework-ps.scm`'s font embedding, which the engine does not
  run: they stay placeholders that fail by name, as before, and the PDF reads the OTFs in Rust instead.
- **What.** `lily-engine-pdf`, 06 §7.3's design:
  - **A display list** (`list.rs`, `Document`): a book's pages, each primitive with its position resolved in staff spaces,
    y up; the music glyphs' outlines once each; the text fonts by PostScript name; the Info entries. Its bytes (`LILD` 1)
    are what crosses from the core to the module.
  - **The walk** (`stencils`, `stencil.rs`): a page's stencil through `crates/svg`'s `interpret`, each primitive read as
    `output-svg.scm` reads it; text is the `glyph-string`s under each `utf-8-string`, which the walk gives when no
    procedure takes the string, as output-ps.scm draws it: glyph ids and advances as the core shaped them, each glyph's
    characters from its cluster; a `glyph-string` in a music font is drawn as outlines, as SVG's is. The Info entries are
    `handle-metadata`'s (framework-ps.scm), each `pdf…` field before its own, through `markup->string`.
  - **The writer** (`lib.rs`): PDF 1.7, every stream deflated (`miniz_oxide` 0.9, the crate's one new dependency, 06
    §7.2's probes'), no object streams; each page at its scale with the SVG page group's round caps and joins; a stroke of
    no width draws nothing, as SVG's; `round-filled-box` the box inside half its blot stroked by the blot; music glyphs as
    form XObjects, each once, drawn with `Do`; `url-link` as a Link annotation; no point-and-click (D5). **Text:** a Type 0
    font, `Identity-H`, over a `CIDFontType0` whose `FontFile3` is the font's CFF subset, its `W` the font's advances, the
    core's advances set against them in `TJ`; a ToUnicode map from each glyph id to its characters. A run in a font the
    host did not give is left out with a warning (06 §7.3's gap of other scripts).
  - **Our own CFF subsetter** (`cff.rs`, 06 §7.3): the URW fonts are name-keyed CFFs, so a subset **keeps every glyph's
    id**: the charstrings no run draws become one `endchar`, the subroutines no kept charstring calls (a walk of Type 2
    charstrings counting stems for `hintmask`) one `return`; the strings, the charset and the DICTs are copied, their
    offsets written again. A name-keyed CFF in a CIDFont has its glyph ids for CIDs (PDF 2.0 §9.7.4.2), so the core's glyph
    ids are the text's codes. A `seac` accent would need its base and accent kept: none of the 12 URW fonts has one (tested),
    and a subset that meets one refuses.
  - **pdf.wasm** (`module.rs`, feature `module`): the crate alone as a cdylib (`cargo rustc --crate-type cdylib`, so the
    rlib stays `no_std` for the core), with its own memory, exports `lily_pdf_input`, `lily_pdf_write`, `lily_pdf_output`,
    `lily_pdf_warnings` and their lengths, no imports; built by `build.mjs` into `dist/engine/pdf.wasm`, **not in the
    manifest**: the host gets nothing to export with until MS8 step 6.
  - **The core** gives each book's display list as `<book>.pdf.list` when `Engine::set_pdf` is on, walking each page beside
    the SVG writer, **natively only** (`cfg(not(target_arch = "wasm32"))`): core.wasm does not change. The ABI's call, its
    decision, and how the walk reaches core.wasm (in it, or a K4 split module) are MS8 step 6's (PROTOCOL §6.2).
- **Measured** (`$LILY_CORPUS/device-runs/2026-11-06-ms8-step5/`): **pdf.wasm 87,645 bytes raw, 35,439 with brotli** (B2's
  PDF module: Must 500, Goal 100 KB; 06 §7.2's `pdfmin` probe was 52 KB without subsetting). The engine's PDFs against
  LilyPond's: **T02 24,500 (43.3 %), T20 16,085 (12.9 %), T24 65,694 (29.0 %), T29 64,933 (20.6 %)**, all inside Goal's
  110 %; pages LilyPond's; a C059 subset of 7 glyphs 10.8–12.4 KB before deflate.
- **Checked.** `crates/pdf/tests/pdf.rs` (the list's bytes; a page of each primitive, its objects and cross-references,
  the glyph once, the run's codes and ToUnicode map; the 12 URW fonts subset and read again with their ids, kept
  charstrings, fewer subroutines, no `seac`); `tools/compare/test/pdf.test.mjs` on T02, T20, T24 and T29: pdf.wasm writes
  the native PDF byte for byte; pages by pdf.js equal LilyPond's PDF's and the SVG pages'; each page rasterized by pdf.js
  against the engine's SVG by rsvg-convert, both without text, no dark pixel without ink within a pixel on the other side
  (0 of 6,790–212,821 on every page; a page moved 3 pixels fails); every `<tspan>` of the SVG in the PDF's extracted text;
  the Info's Title and Composer LilyPond's; each file within 150 %; no warning.

## D271 — Export PDF on the web: `lily_pdf` gives the display list, the walk in core.wasm, pdf.wasm and the OTFs in the manifest, TeX Gyre Schola for "New Century Schoolbook"

**Status:** accepted (MS8 step 6, R9, 2026-11-06; the ABI's call answered at R9's split, MS8's stop points; **the operator's
answer at this step: TeX Gyre Schola embedded in PDFs**, amending answer 5 for this alias) · **Refines:** D270 (W7's
module), D264 (the ABI's calls), D262 and D263 (the text faces, their outlines and web fonts), D227 (fonts no pack held),
D209 (the licences) · **Changes:** `packages/engine/crates/core/{Cargo.toml,src/abi.rs,src/lib.rs,src/compile.rs,examples/compile.rs}`,
`crates/pdf/src/module.rs`, `crates/layout/src/pango.rs`, `tools/packs/text.mjs`, `scripts/build.mjs`, `scripts/sizes.mjs`,
`licenses/{NOTICE.txt,TEX-GYRE-LICENSE.txt,LPPL-1.3c.txt}`, `tools/compare/core.mjs`, the tests (`crates/fonts/tests/text.rs`,
`crates/layout/tests/markups.rs`, `crates/pdf/tests/pdf.rs`, `tools/compare/test/pdf.test.mjs`); with D141

- **The ABI's call: `lily_pdf(on)`**, a setting as `lsb_trace` is: the compiles from it on give each book's display list,
  `<book>.pdf.list`, among their outputs, named as LilyPond names the book's PDF; a new instance has it off; a performance
  gives none. A setting rather than a compile of its own: the host's Export PDF is a compile like any other (with a
  preview, so that N8 and the preview's cells go on from it), and a stop's restart (`begin`) sets it again with the
  compile. One call past 08 §4.2's, which MS8's stop points answered at R9's split ("Export PDF's call for the display
  list … takes a decision at step 6").
- **The walk is in core.wasm** (`cfg(not(target_arch = "wasm32"))` gone): **+19,705 bytes raw** (core.wasm 3,019,040 →
  3,038,745; 3,039,089 with this step's whole build) and **+5,949 brotli on the core's download** (1,520,244 →
  1,526,193, 1.017 of B1's Must, which R8's close left over it). A K4 split module would save those ≈ 6 KB but is a module
  boundary (PROTOCOL §6.1–§6.2) and a restart or a fetch before every export; not taken. The walk runs only with
  `lily_pdf` on.
- **pdf.wasm's `lily_pdf_fonts`**: with a display list alone as its input, the PostScript names of its text fonts, one a
  line, as the output; the host fetches those and gives them with the list to `lily_pdf_write` (D270's form).
- **The manifest** names pdf.wasm as `pdf` (kind `wasm`) and each text face's OTF as `<PostScript name>.otf` (kind
  `font`): the files the web fonts are (D263), fetched by the worker only for an export, kept in Cache Storage as every
  module is. A font the build has not is none, and the writer leaves its runs out with a warning.
- **E23: TeX Gyre Schola's four styles are text faces** (`TeXGyreSchola-Regular` … `-BoldItalic`, packs and outlines named
  by PostScript name, from LilyPond's `texgyreschola-*.otf`), the family fontconfig's metric alias gives **"New Century
  Schoolbook"** (and "TeX Gyre Schola"); a glyph string names LilyPond's file, `texgyreschola-regular.otf`. **T26's 22
  strings are LilyPond's now** (the shaping check's 1,504 strings: only T20's 77 apart, D224); Schola's digits have C059
  Roman's advances and ink, so its pages do not move. The packs are 14.4–14.7 KB brotli each, outlines 29.6–33.6 KB,
  on demand; the studio fetches Regular's with the score that names the family. The web fonts name Schola "New Century
  Schoolbook", so the page draws T26's digits in it.
- **The licence (the operator's answer):** TeX Gyre Schola 2.005, "Copyright 2006, 2009 for TeX Gyre extensions by B.
  Jackowski and J.M. Nowacki", under the **GUST Font License**, an instance of the LPPL 1.3c, which lets the fonts be
  distributed unmodified and embedded: its text (CTAN's `fonts/tex-gyre/doc/GUST-FONT-LICENSE.txt`) and the LPPL 1.3c's are
  served beside the module (`gust`, `lppl` in the manifest's `licenses`), and NOTICE.txt names the packs, the OTFs and the
  PDFs' subsets. None of the four OTFs has a `seac`, and each subsets as the URW fonts do (tested).
- **Measured.** pdf.wasm 87,905 raw, 35,441 brotli. **T26's PDF 30,245 bytes, 40.5 % of LilyPond's 74,702**, Schola
  embedded; the other four as D270's. core.wasm's lists equal the native compile's byte for byte, for a preview's compile
  and the file form's (`pdf.test.mjs`).

## D272 — A `\score`'s `scorify-music` in the VM's steps, create_top's lists asked ahead, a line of marks held while the lines below it are read

**Status:** accepted (MS8 step 3a, R9, 2026-11-09; **the operator's answers at the step's stop**: B8 made to hold on T29
itself, with LilyPond's bits; what stays over 50 ms on T29 × 8 and × 26 recorded in OPEN past R9; the three divided as
recommended) · **Refines:** D267 (the parse in steps), D261 (the returns), D254 · **Changes:**
`crates/scheme/src/{vm.rs,control.rs}` (`Vm::begin_steps_due`), `crates/parser/src/{lib.rs,reuse.rs,recover.rs,output_def.rs,function.rs}`
(`ScoreBody`, `InScore`, `Parser::scorify_in_steps`, `go_on_score`, `Parsing::stop`), `crates/music/src/{length.rs,iterator.rs,global.rs,returns.rs}`
(`Asked`, `Iteration::ask_ahead`, `Iteration::mid`), `crates/layout/src/{system.rs,axis_group.rs,align.rs,grob.rs}` (`Held`, `Heights::holding`,
`Translations::fresh`, `Grob::pure_fresh`), `crates/core/src/compile.rs`, `crates/core/tests/returns.rs`

- **Why.** B8 is a hard item (D257). After D267 a newer edit still waited out three things that were each one step
  (OPEN B23, B28). The first was a `\score` item's `scorify-music`, one Scheme call from inside the parser's frames (T29 × 8
  374–388 ms in core.wasm). The second was `create_top`, whose cost is the `elements-callback`s of the `\repeat`s (165
  calls in T29 × 8's, 800–920 ms). The third was T29's line of marks reading the lines below it nested in one callback
  (144 ms in core.wasm, the longest step on T29). Step 2's two orders of that read each moved T29's `\moltocr`
  `stroke-dasharray` (D267).
- **A `\score`'s `scorify-music` is a call in the VM's steps.**
  - **The VM's tick check:** `Vm::begin_steps_due` gives a call in steps a clock. At the VM's cancel check (every 4,096
    calls and backward jumps), once the clock says the step's time is spent, the call returns to the host at the next
    primitive's value given outside any dynamic extent, as `%queue-check`'s returns do (D261). This suits LilyPond's own
    Scheme, which asks no `%queue-check`.
  - **Where the parse stops:** the call is made only for a toplevel `\score` whose music is its first item, in a compile
    that returns, where the parser's state there is a boundary's (D267's quiet state). Holding nothing but the call's
    music between steps, it stops inside the score block. The lexer is at the music's lookahead, and the item's segment
    stays open.
  - **Going on:** the next step goes on with the call, then with the block's items in LilyPond's order (the `\layout`
    after the music parsed after `scorify-music`), then the toplevel item's end.
  - **A newer edit** drops the call (`Vm::abandon_steps`) and undoes the open item's writes before the stopped parse is
    left to the next one (`Parsing::stop`).
  - Any other `\score` calls it whole, as before.
- **create_top's lists are asked ahead.**
  - **Asked in steps:** a translation's start looks at its music before `create_top`, one music a check (`Asked::on`).
    It calls the `elements-callback` of each music whose callback is one of LilyPond's own `make-unfolded-set`,
    `make-volta-set` or `make-percent-set`, once, and keeps the list. `make-tremolo-set` can warn, so it is called where
    LilyPond calls it.
  - **Used by create_top:** the music's start and length are computed from that list natively (`Hosted::elements`),
    and its iterator takes the same list (`calc_elements`); the lists go when `create_top` ends.
  - **Why the outputs stay the same:** the three callbacks make new music and say nothing, so one list each is what
    LilyPond's several calls made. T29 × 8's create_top makes 22 calls where it made 165, and its step is 119 ms natively
    where it was 351.
- **A line of marks is held while the lines below it are read** (`system.rs`, `Held`).
  - **The hold:** in the read of the lines' heights ahead of `springs-and-rods` (D261), a line of `staff-affinity` DOWN
    with lines below it is held before its first outside-staff measure. The hold is taken only where its alignment had
    not kept the translations between that measure's columns. The lines below it are then read in steps of their own,
    in the order LilyPond's nested read takes them, the held reads resumed last held first.
  - **What a resumed line does again:** LilyPond's nested read had asked two things before the lines were read and
    wrote them after, and the resumed line makes them again.
    - The alignment's translations between those columns are made again once (`Translations::fresh`) and consed over
      those an inner line of marks had kept.
    - Each line whose read began while it was held makes its first part-of-line height again (`Grob::pure_fresh`). Its
      cache can only hold what was read while the line's heights were in progress.
  - **Without these two, the hold moved T29's dash to …945; with them** every value is LilyPond's: T29 at every mode
    and step budget tried (0.05–10 ms, preview or not) has `2.9384833592448927`, and corpus.tsv's 82 scores (the 42,
    Y01–Y40) compile byte for byte as on f61fb58.
  - **Measured:** T29's longest native step 47 → about 20 ms.
- **A timestep's parts are steps of their own.** With the three above, T29's longest step in core.wasm was its first
  timestep, which makes every context: 58–81 ms under load, about 10 ms natively. Its parts are init and checkpoint
  2–3 ms, the iterators' events 3, then the translators' `OneTimeStep` and finalizations 4. The global loop now also
  returns after a timestep's checkpoint and after its iterators' events (`Iteration::mid`), where D254 returned only
  between timesteps. It goes on there, entering the timestep at its events as a resumed translation enters one, and does
  a part before it may return again.
  - **What stays the same:** the order of everything is unchanged, and a stop there leaves what a stop between
    timesteps leaves, the timestep's snapshot taken at its checkpoint.
  - **Checked:** corpus.tsv's 82 compile in steps of 1 ms and of 0.05 ms byte for byte as f61fb58 compiles them whole.
- **Not divided (OPEN, past R9, the operator's answer):** T29 × 8's and × 26's other steps over 50 ms in core.wasm. These
  are create's iterators themselves, the translation's end, line breaking's start, substitution and drawing, the
  checkpoints' digests per timestep, and on × 8 B28's read itself, nested elsewhere since the read ahead is off there
  for memory.

## D273 — `syntax-case` is a split module on demand; a procedure transformer is evaluated where it is defined and renames its templates as one expansion

**Status:** accepted (MS8 step 11, R9, 2026-11-11) · **Refines:** D60, D223 (K4's split) · **Changes:**
`crates/scheme/src/{syntax_case.rs,expand.rs,syntax_rules.rs,vm.rs,prims.rs,lily.rs}`, `scripts/{split.mjs,sizes.mjs}`,
`crates/core/src/lib.rs` (`PART_MODULES`), `crates/parser/tests/support/mod.rs` (`MODULE_FILES`)

- **What.**
  - **A procedure transformer expands.** `define-syntax` (and `let-syntax`, `letrec-syntax`) of anything but
    `syntax-rules` evaluates the transformer where it is defined, at toplevel in the module, as psyntax does at
    expansion; D60's refusal is gone. Where the name is one of `(lily)`'s native macros the native one stays and the
    transformer is not evaluated, as before. A use calls the procedure with the form. The templates it instantiates in
    that call rename their symbols as one expansion of `syntax-rules` does: each symbol once, an alias in the macro's
    module (`Transcription`).
  - **A syntax object is the datum.** An identifier a macro introduced is the expander's alias (D60's renaming).
    - `syntax-case` matches at run time with `syntax-rules`' matcher, its pattern variables bound to fresh variables
      that only `syntax` reads, and fails with psyntax's `source expression failed to match any pattern`.
    - `syntax`, `quasisyntax` and `with-syntax` expand as psyntax's do, with its ellipsis checks.
    - `datum->syntax` gives the datum the context's identifier's renaming: none for the user's, an alias for an
      expansion's.
    - Also: `syntax->datum`, `identifier?`, `bound-identifier=?` (`eq?`), `free-identifier=?` (the same binding, or
      the same name where neither is bound), `generate-temporaries` and `syntax-violation`.
    - A syntax error a transformer throws with no place is placed by its subform, else its form, where the source has
      it, as psyntax takes it from their source properties.
  - **The part is a split module.** Its code is the scheme crate's module `syntax_case`. The expander reaches it only
    through `HOOKS`' pointers, and Scheme through its primitives, both in the function table. `split.mjs` splits a
    module of a crate by the path its functions' names hold (`SPLIT_PATHS`). So wasm-split moves it into
    `syntax-case.wasm`, which the manifest names `split` and the studio's driver loads when a placeholder is first
    called (08 §2.2's third kind). 54 functions, 13,221 bytes raw, 5,471 brotli, against README §4.2's 40 / 20 KB.
  - **`(lily accreg)` loads on use.** `diagrams`' data holds `accreg.scm` after the part's own files
    (`PART_MODULES`); the image's `%parts` does not, and a module hook loads the file when a `use-modules` names the
    module (`%load-module-source`), as Guile finds it on its load path. Harp pedals do not fetch the macro's part.
- **Why.** README §4.2 budgets `syntax-case` as a split module, and 03 §5.5 puts it on demand. The regression score that
  uses it is `accreg.ly` (corpus.tsv's Y84), through `define-register-set`. psyntax's syntax objects and wraps would
  have cost the expander a second representation of identifiers. The engine's aliases already give `syntax-rules` its
  hygiene, and one expansion's renaming is psyntax's mark for what these macros do.
- **Consequences.**
  - `tests/macros.rs` holds 25 programs of `syntax-case` against guile 3.0.11.
  - `tail.test.mjs` holds a macro, its failed match and its `syntax-violation`, each placed, against LilyPond's stderr.
  - `free-identifier=?` of two identifiers of one name, unbound, bound where neither is, is true (psyntax compares
    their bindings).
  - A `#'` outside any transformer renames as an expansion of the current module.
  - A score that calls a `syntax-case` form in a page restarts its compile once to load the module, as the notation
    modules do (08 §4.4).

## D274 — LilyPond's own Scheme prints as Guile's compiled code: its procedures keep their formals, and the music types carry `display-methods` before the `display` part loads

**Status:** accepted (MS8 step 11, R9, 2026-11-11) · **Refines:** D65, D263 · **Changes:**
`crates/scheme/src/{compile.rs,heap.rs,image.rs,module.rs,lily.rs}`, `crates/music/src/{music.rs,frozen.rs,dispatcher.rs}`,
`crates/parser/tests/support/mod.rs` (`display_methods`, `DISPLAY_AFTER`)

- **What.**
  - **A Prob prints as LilyPond's** (`Prob::print_smob`): ` >` and a newline end music and stream events.
    - A stream event is `#<Prob: Stream_event C++: Stream_event` and its two lists. The mutable list holds what was set
      on it after it was made, the newest first. The immutable list holds `class` and what it was made with: an event
      of music, the music's properties.
  - **Procedures of LilyPond's own Scheme print their formals.** The compiler keeps a procedure's formals as written
    (`Template::names`) as `Globals::named` says, so `breathe::midi-length` prints `(len context)`, as Guile's compiled
    `.go` code does.
    - While the image loads `scm/lily/`'s files: a procedure a toplevel form defines (`toplevel`).
    - While `%load-text` loads a part's or a module's file at run time: every named procedure (`#t`), so the
      `display` part's methods print theirs.
    - A score's Scheme and the `ly/` files' print `a`, `b`, as Guile's evaluator names them. So do the image's
      internal procedures (named `let`s, internal `define`s), which nothing prints. **By the operator's answer at step
      11's push** the image keeps no more: every named procedure's formals cost it 11,584 brotli, the toplevel ones'
      5,933.
  - **`display-methods` before the part.** Where LilyPond's `music-functions.scm` loads `(lily display-lily)`, the
    image gives each music type the methods `define-music-display-methods.scm` defines, read from its source
    (`define-display-method` and its post-event and span-event forms one `method`, `define-extra-display-method` a
    `new-method` before them).
    - Each is a stub that prints as the compiled method does, `#<procedure method (note)>`.
    - Called, a stub loads the `display` part and calls the method at its index. The part's own definitions then set the
      list in place.
    - They are in `%music-properties` and `music-name-to-property-table` alike, which `make-music` and the part share.
- **Why.** OPEN C6: T15's Scheme engraver prints its events and their music, the one difference left in its stderr
  (D65), and OPEN F's `write` of music (MS8 step 10) is the same text. LilyPond prints what its compiled Scheme made with
  real names, and `display-lily.scm` is loaded with `music-functions.scm`, so every music object carries its methods.
  The engine keeps the `display` part on demand (D263), so the stubs give the text without the part.
- **Consequences.**
  - T15's stderr is LilyPond's byte for byte; c2.test.mjs and layout.test.mjs compare it whole.
  - Music printed after the `display` part loaded prints the part's own methods, which `%load-text` compiled with
    their names, as the stubs printed.
  - An anonymous procedure of LilyPond's still prints the engine's number where LilyPond prints its address and file.
  - The image's format is 3. The image is 501,484 brotli, 10,841 over step 10's; 5,933 of that is the formals and
    1,311 the stubs.


## D275 — A layout's error ends the run as a translation's does; a traced compile's processing keeps its error on the System

**Status:** accepted (MS8 step 11a, R9, 2026-11-12, by the operator's answer at step 12: "fix B33 first") · **Refines:**
D132, D130 · **Changes:** `crates/core/src/compile.rs` (`processing`, `laid`, the traced branch),
`crates/layout/src/dump.rs` (`Dumped::thrown`, `keep_thrown`, `lay_out`), `crates/core/tests/engine.rs`,
`tools/compare/test/tail.test.mjs`

- **What.**
  - **An error while a `\layout`'s Paper_score is processed ends the run** where LilyPond's ends, as D132 has a
    translation's: a grob's `before-line-breaking`, its prebroken pieces or `springs-and-rods` throwing in
    `Processing::on` (a per-edit compile's processing in steps) is reported at `init.ly` with Guile's text for a
    toplevel book, and as Guile's text without its frame for a `\book` block's (D132); no translation, page or playback
    map after it; the books before it keep their pages.
  - **The engine's own gaps stay unreported** (`engines_own`: a placeholder's call, a font not given): the book is
    left without its layout and the compile goes on, as before (D130).
  - **A traced compile does the same.** Its layout runs through `dump::lay_out`'s reads, whose `%dump-read` catches
    every throw and gives `#f`. The host's handlers that run the processing (`dump-prebroken-pieces`,
    `dump-pre-processing`) keep its error as `(key . args)` on the System's object `%dump-thrown` before it is
    caught, and `lay_out` takes it, rooted, as `Dumped::thrown` for the core to end the run with. The symbol is
    interned only then and `%dump-read` is unchanged, so the image is byte for byte as before: a change to
    `%dump-read`'s handler had cost the image 2,931–3,043 brotli for the indices it moved.
- **Why.** OPEN B33 (MS8 step 7's rest): such an error left its book without pages, stderr empty and the exit status 0,
  where LilyPond prints Guile's error and exits with 1. Found by `jump-unaligned.ly` (Y10) through the engine's `iota`;
  the operator's answer at R9's close put it before the close.
- **Consequences.**
  - `tail.test.mjs`' `layout-error` is LilyPond's stderr byte for byte; `engine.rs`' test checks both paths, a book
    before it and the engine's own call.
  - No score of the corpus nor Y01–Y90 throws in its layout: every output as before.
  - LilyPond's `ice-9/eval.scm:155:9:` frame before a `\book` block's text is still left out (D132).

## D276 — From the singer aligns a voice to the recording

In the Mac app, Parts offers **From the singer** on an eligible lyric voice
when the score has a recording. Studio separates the lead vocals, aligns
the syllables with MMS_FA, checks the pitch with pYIN, and marks differences
in the score. The singer's timing applies to that voice during playback and
karaoke. Other parts keep the score's timing. Low-confidence notes keep their
written timing. The model weights download on first use under D169.
