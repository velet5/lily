# AGENTS.md

Instructions for coding agents working on this repository. How to write LilyPond
scores with the compile-and-fix loop of `lily-check` is in
[packages/vscode/AGENTS.md](packages/vscode/AGENTS.md), which ships with the
extension.

## Layout

An npm workspace of three packages (DECISIONS D53):

- `packages/common` (`@lily/common`): what both apps use. `src/span.ts` and
  `src/types.ts` import neither `vscode` nor Node (Lily Studio's renderer
  bundles them); `src/textedit.ts` may use Node. `web/preview.js` and
  `web/midi.js` are plain scripts with `.d.ts` files beside them. Also the
  TextMate grammar, the language configuration and lilypond's `runtime/`
  files. No build step: the apps bundle or copy what they import.
- `packages/vscode` (`lily`): the VS Code extension and `lily-check`. Read
  `packages/vscode/docs/ARCHITECTURE.md` §3 for its layout.
- `packages/studio` (`lily-studio`): Lily Studio, a Tauri app whose Rust side
  is a Cargo workspace in that directory (D42).

`docs/DECISIONS.md` records the decisions of all three; read it before changing
a convention and record new ones there.

## Commands

`npm install` once at the root. From the root:

```sh
npm run check-types     # tsc in every package
npm run lint            # oxlint over the repository; warnings fail
npm run test:grammar    # TextMate grammar snapshots (packages/common)
npm run build           # the extension and the studio
npm test                # grammar, then the extension's and the studio's tests
```

In `packages/vscode`:

```sh
npm run build           # esbuild → dist/extension.js, dist/lily-check.js; copies packages/common into dist/
npm run test:unit       # node --test; tests in subdirectories of test/
npm test                # types, lint, unit, then the extension-host tests
npm run test:e2e        # packages the VSIX and runs a sample score through it
```

In `packages/studio`: `npm start`, `npm test` (Rust, renderer and smoke
tests), `npm run lint:rust`; its README has the rest.

## Rules

- Something belongs in `packages/common` only if both apps use it. Import it
  as `@lily/common/…`, never by a relative path into another package.
- Nothing under `packages/common`, `src/compile/`, `src/intellisense/` (except
  `provider.ts`), `src/diagnostics/parse.ts` or `tools/` of the extension may
  import `vscode`.
- A VSIX holds only `packages/vscode`: a file the extension needs at run time
  is copied into `dist/` by its `esbuild.mjs` if it is in `packages/common`,
  and let into the VSIX in `.vscodeignore` either way; only
  `npm run test:e2e` notices when it is not.
- Lily Studio's compiler and error parser are a Rust port of the extension's
  (D42); a change to one must be made in the other.
- `packages/vscode/data/completions.json` is generated (`npm run
  gen:completions`); do not edit it.
- Tests that need lilypond skip themselves when it is not installed; a run with
  skipped tests has not verified a change to compiling or parsing.
