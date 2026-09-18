# Changelog

## 0.1.0 — 2026-09-18

First packaged release.

- **Language support** for `.ly` and `.ily`: a TextMate grammar written for this
  extension (commands, pitches, durations, strings, comments, lyrics, markup,
  embedded Scheme), comment toggling, bracket pairs and snippets.
- **Side-by-side SVG preview** (`Ctrl/⌘+K V`): every page, theme or paper
  colours, fit-width and zoom, page navigation, zoom and scroll kept across
  refreshes.
- **Refresh on save**, debounced, with stale compiles cancelled; saving an
  included file refreshes the score that includes it.
- **Score ↔ source**: click a note to go to its source; the note under the
  cursor is marked in the preview.
- **Diagnostics** from the same compile: Problems panel, token-wide squiggles,
  output channel and a status bar item.
- **Toolbar and commands**: compile, refresh, zoom, pages, PDF and MIDI export,
  in the editor title, the preview, the Explorer and the Command Palette.
- **Completion and hover** generated from LilyPond 2.26.0: commands, contexts,
  layout objects and properties.
- **`lily-check`**, a headless compile CLI and MCP server for coding agents,
  shipped in the extension as `dist/lily-check.js`.
- Compiles run in a temporary directory; nothing is written next to the sources
  except explicit exports.

Requires LilyPond 2.24 or newer. Developed and tested with 2.26.0 on macOS;
Windows is untested.
