# Changelog

## Unreleased

- **Faster unsaved previews.** Guarded classic SVG glyph caching and an isolated
  warm parent on supported LilyPond 2.26.0 installations; ordinary fallback.
  Unsaved root/include snapshots preserve source navigation and diagnostic
  positions. A bounded debounce and one pending revision prevent starvation.
  Unchanged SVG pages and link indexes are reused; zoom, themes and MIDI remain.
  Font-data caching further reduces SVG generation for dense scores. Saved and
  unsaved previews now share page hashes for Cyrillic and other escaped filenames.

- **MIDI playback.** ▶, ■ and a seek slider in the preview toolbar play the
  score's `\midi` output through a built-in Web Audio synthesizer: General
  MIDI instruments, drums, dynamics, tempo changes and the sustain pedal.
  <kbd>Space</kbd> in the preview plays or pauses. **Play or Pause MIDI** and
  **Stop MIDI** in the Command Palette and the `…` menus.
- **MIDI player** for `.mid` and `.midi` files: click one in the Explorer to
  see its tracks and instruments and play it. **Export MIDI** now offers *Play*.

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
