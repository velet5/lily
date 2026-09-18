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
`data/lilypond-data.json`, which is committed and shipped. Completion is
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
  `lily.preview.openToSide`, palette only until step 9.
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
  the floating −/Fit/+ group, `+` `-` `0`, Ctrl/Cmd+wheel (also a trackpad
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
  after a window reload (it would need a compile at startup). No panel icon.
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

## Out of scope

MIDI keyboard input, MIDI playback, and `python-ly` formatting. Revisit only
after step 12.
