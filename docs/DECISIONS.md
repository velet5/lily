# Decision log

Short records of the choices that shape the extension. Context and evidence are
in [ARCHITECTURE.md](ARCHITECTURE.md); gap numbers (G1…) refer to its section 2.
Add new entries at the bottom; supersede rather than rewrite.

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
  [LIVE-PREVIEW-IMPLEMENTATION.md](LIVE-PREVIEW-IMPLEMENTATION.md).
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
  paired up in order; drawn once, it is that place every time (a repeat
  unfolded in the MIDI only); anything else takes the place on the system
  playing then. A *moment* is the events that begin together: its x is the
  leftmost centre of their elements, its extent their union. A *system* ends
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

**Status:** proposed · **Refines:** D1, D12

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
