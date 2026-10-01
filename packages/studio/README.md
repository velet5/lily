# Lily Studio

A small Mac app for LilyPond scores aimed at people who do not program: the
files of a folder on the left, the text in the middle, the engraved score on the
right, and nothing to configure. It is a Tauri app
with a Rust port of the [VS Code extension](../vscode)'s compiler and error
parser, shares its grammar, preview and player (`packages/common`), and needs
LilyPond installed in the same way.

- **First launch.** A welcome screen offers a sample score (Ode to Joy, saved
  in *Documents › Lily Studio*), new scores from templates, and opening files.
  If LilyPond cannot be found, a setup guide opens: download it, move it to
  Applications, and show the studio where it is. *Help › Set Up LilyPond…*
  brings it back.
- **Editing.** Open a score and it is engraved right away; switch files and the
  preview switches with them. Save with <kbd>⌘S</kbd>, or just type: the score
  follows as you type (*Live preview* in the status line). Click a note to find it in the
  text. The SVG/PDF switch shows the printable PDF, and *Export PDF* saves it
  next to the score. ▶ plays the music and marks the notes as they sound;
  *Parts* mutes a part or plays it on another instrument, and *File › Export
  MIDI…* saves the music, with or without the muted parts.
- **Mistakes** are underlined, and a note above the score explains the first
  one in plain words, for example *“\stacato” is not a LilyPond command*.
  Click it to go there.

## Build and install

It needs Node and a Rust toolchain (`rustup`). Run `npm install` once at the
repository's root (an npm workspace), then in `packages/studio`:

```sh
npm start              # run from the sources
npm test               # Rust and renderer unit tests, then the window's smoke test
npm run dist           # release/Lily Studio-<version>-<arch>.dmg, signed and notarized
npm run dist:x64       # the same for Intel Macs (rustup target add x86_64-apple-darwin once)
npm run dist:local     # the same DMG, ad-hoc signed, for a Mac without the certificate
npm run test:e2e       # build the DMG, install the app from it, launch it
```

Open the DMG and drag Lily Studio to Applications. The app is signed with a
Developer ID and notarized by Apple, so it opens without a warning. A
`dist:local` build is not: on another Mac, open it the first time with
right-click › Open.

`npm run dist` needs the Developer ID Application certificate in the login
keychain and a notarization profile named `lily-notary`, stored once with
`xcrun notarytool store-credentials lily-notary --apple-id <id> --team-id <team>`.

## Development

`npm run lint:rust` runs `cargo fmt` and `clippy`. The Rust side is a Cargo
workspace here: `crates/engrave` (compiling, live preview, files, settings),
`crates/agents` (Claude Code and Codex) and `src-tauri` (the app). The page is
`renderer/` and `src/renderer/`. `docs/DECISIONS.md` at the repository's root
records the studio's decisions from D28 on.

## License

MIT; the text is in the `LICENSE` file at the repository's root.
