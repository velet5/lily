# Lily

[LilyPond](https://lilypond.org) tools, in one repository:

- **[Lily for VS Code](packages/vscode)**: highlighting, a live SVG preview,
  MIDI playback, errors in the Problems panel, completion and hover, and
  `lily-check`, a headless checker for coding agents.
- **[Lily Studio](packages/studio)**: a small Mac app for LilyPond scores, for
  people who do not program.
- **[packages/common](packages/common)**: what the two share: the grammar, the
  preview and MIDI player scripts, lilypond's runtime files, and the types and
  spans of diagnostics.

## Development

An npm workspace; each package's README has its own commands.

```sh
npm install            # once, for all packages
npm run check-types    # tsc in every package
npm run lint           # oxlint, warnings fail
npm test               # grammar snapshots, the extension's tests, the studio's tests
```

[AGENTS.md](AGENTS.md) describes the layout and its rules, and
[docs/DECISIONS.md](docs/DECISIONS.md) records why things are as they are.

## License

MIT; the text is in the [LICENSE](LICENSE) file.
