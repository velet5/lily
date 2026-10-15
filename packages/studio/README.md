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
  MIDI…* saves the music, with or without the muted parts. *Piano* shows it
  falling onto a keyboard where the source is, as piano videos do.
- **Mistakes** are underlined, and a note above the score explains the first
  one in plain words, for example *“\stacato” is not a LilyPond command*.
  Click it to go there.
- **Stems.** The *Scores | Stems* switch at the top of the sidebar opens the
  Stems workspace, which splits a song into stems on Apple Silicon with
  RoFormer MLX. Drop a song on the window, or click to choose one. Then pick a
  model: *Karaoke* gives lead vocals and instrumental, and *All instruments*
  gives vocals, drums, bass, guitar, piano and other. Choose Fast, Balanced or
  Best and WAV, FLAC or MP3, and press *Make karaoke* or *Separate
  instruments*. Each stem gets a player. Ticked stems export as one mix, and
  *Show in Finder* opens the stems' folder, `<song> (stems)` or
  `<song> (karaoke)` next to the song. Songs separated before are listed
  under *Recent*, below the settings: a click shows their stems again
  without separating, and *Open…* takes a folder of stems made earlier, by
  this app or RoFormer's. A stem's *Score… › New score for
  bass* transcribes it: `bass.ly`, beside the stems, has the bass line's
  notes in the song's key, tempo and meter, from the first bar to the last,
  and opens in Scores. Vocals get their tune; guitar, piano and the rest a
  rough draft of their chords (*Score… (draft)*); drums their kick, snare
  and hi-hat. The stem then plays above the preview's transport, alone or
  *With score*, in time with the score's MIDI, so what the transcription got
  wrong is heard and fixed. *Empty score for bass* writes four empty bars to
  fill in by ear instead.

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

`npm start` and an installed Lily Studio are one app to macOS: the same name,
bundle identifier and data folder. Only one runs at a time, so `npm start`
while Lily Studio is open only brings the open one forward. Quit it first.
Either one keeps its settings, recent files and chats in *Application Support ›
Lily Studio*, and installing a new DMG leaves them there.

`npm run dist` needs the Developer ID Application certificate in the login
keychain and a notarization profile named `lily-notary`, stored once with
`xcrun notarytool store-credentials lily-notary --apple-id <id> --team-id <team>`.

## Stems

Stems runs RoFormer MLX's `karaoke-mlx` with [uv](https://docs.astral.sh/uv/),
as RoFormer's own app does (DECISIONS D112), and transcribes a stem with this
repository's `packages/transcribe` the same way (D113). It needs an Apple Silicon Mac, uv
and ffmpeg (`brew install uv ffmpeg`), and RoFormer MLX's project. The studio
looks for the project in `KARAOKE_MLX_ROOT`, then in `packages/separate` of
this repository, where its Python is to move, then in RoFormer MLX's checkout,
`/Volumes/T5/Workspace/roformer-karaoke-mlx`. When it finds no project or no
uv, Stems says which, with *Check again*. Run `uv sync` in the project once,
so the first separation does not wait for it. Each model downloads on its
first separation (0.7 to 1.7 GB, into `~/.cache/karaoke-mlx`).

Transcribing uses Spotify's Basic Pitch for the notes and CPJKU's Beat This!
for the beats, with Python 3.11 and torch. Run `uv sync` in
`packages/transcribe` once too; the first transcription downloads Beat This's
model (77 MB). `LILY_TRANSCRIBE_ROOT` names another copy of the project.

The web has no Stems: separating needs the Mac app.

## On the web

`lily-studio-server` serves the same studio to browsers, for many users. It
has no agents. Each user signs in and works in their own *My Scores*. Scores
are uploaded and downloaded through the menu bar, and engraved on the
server. Each user's work runs in its own [bubblewrap](https://github.com/containers/bubblewrap)
sandbox, because a score can run programs (DECISIONS D55).

```sh
npm run serve          # on a Mac, for development: no sandbox, sign-up on, http://127.0.0.1:8080
npm run build:site     # dist/site/ and a release build of lily-studio-server
```

On a Linux server, with `lilypond` and `bubblewrap` installed:

```sh
lily-studio-server user add ada --data /srv/lily     # asks for a password
lily-studio-server serve --data /srv/lily --site dist/site --runtime dist/runtime \
  --listen 127.0.0.1:8080 --secure-cookies
```

Put a proxy that terminates HTTPS in front of it, and forward the Host
header and WebSocket upgrades. `--signup` lets anyone create an account.
`lily-studio-server serve --help` lists the rest. The `Dockerfile` builds an
image with LilyPond and bubblewrap, and its first lines say how to run it.

## Development

`npm run lint:rust` runs `cargo fmt` and `clippy`. The Rust side is a Cargo
workspace here: `crates/engrave` (compiling, live preview, files, settings),
`crates/agents` (Claude Code and Codex), `crates/session` (the main process
without a window, shared by the app and the server), `crates/server` (the
web), `crates/separate` (running karaoke-mlx and lily-transcribe, for the
app alone) and
`src-tauri` (the app). The page is `renderer/` and `src/renderer/`;
`src/web/` is what the web adds to it. `docs/DECISIONS.md` at the repository's root
records the studio's decisions from D28 on.

The smoke test separates a song too when it is given one. It drops the song
on the window, splits it into six stems with BS-RoFormer SW at Fast, plays
each, exports a mix, and transcribes the bass into a score, whose tempo,
notes and bars it checks. That takes about a minute and a half on an M1 Max:

```sh
LILY_SMOKE_SONG=~/Music/song.mp3 npm run test:smoke   # a copy of the song, in a scratch folder
LILY_E2E_SONG=~/Music/song.mp3 npm run test:e2e       # the same, in the installed app
```

## License

MIT; the text is in the `LICENSE` file at the repository's root.
