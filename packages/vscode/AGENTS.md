# AGENTS.md

Instructions for coding agents (Codex and others) on writing LilyPond scores
with a compile-and-fix loop. It ships with the extension and does not depend on
anything else, so it can be copied into the `AGENTS.md` of any score repository.
Work on this repository is described in the `AGENTS.md` at its root.

## Writing and fixing LilyPond scores

Never hand back a `.ly` file you have not compiled. `lily-check` runs the same
compile and the same error parser as the editor and reports the result as JSON.

```sh
npm run build                                     # once, in packages/vscode of a checkout; the installed extension has dist/ already
node dist/lily-check.js compile score.ly --json
```

Exit code `0`: compiled. `1`: lilypond reported errors. `2`: lilypond did not run
(file missing, lilypond not installed); `error.code` and `error.message` say why,
and the fix is not in the score.

```json
{
  "ok": false,
  "rootFile": "/abs/score.ly",
  "exitCode": 1,
  "errorCount": 1,
  "warningCount": 0,
  "diagnostics": [
    {
      "file": "/abs/parts/violin.ily",
      "line": 12,
      "column": 9,
      "severity": "error",
      "message": "unknown command: `\\stacato'",
      "source": "  c4-. d \\stacato e",
      "token": "\\stacato"
    }
  ],
  "pages": ["/tmp/lily-check/score-1a2b3c4d/score.svg"],
  "midi": [],
  "outputDir": "/tmp/lily-check/score-1a2b3c4d",
  "durationMs": 430
}
```

### The loop

1. Edit the score.
2. Compile the **root** file, the one with `\score` or `\book`, even when the
   edit was in a file it `\include`s. Diagnostics name the file they are in.
3. `ok: true` and no warning you caused: done. Otherwise fix the **first** error
   and compile again. One mistake usually produces several messages (an unknown
   command is followed by `string outside of text script`, a missing brace by
   `unexpected end of input`), so do not fix them all from one report.
4. Stop after about five rounds without progress and say what is left.

### Reading a diagnostic

- `line` and `column` are 1-based, as lilypond prints them. The column counts a
  tab as a jump to the next multiple of 8, so do not index with it: `source` is
  the line and `token` is the thing in it that lilypond points at.
- A diagnostic without `column` concerns the whole line, or, at line 1 of the
  root file, the whole run.
- `warning: bar check failed` means the durations before that `|` do not fill the
  bar. Recount the bar; do not delete the bar check.
- `warning: no \version statement found` is fixed by making the `\version "…"`
  line that the message suggests the first line of the file.
- `cannot find file` for an `\include` that exists means its directory is not on
  the search path: pass it with `-I`.
- `pages` of a failed run show whatever lilypond could still engrave. Do not
  present them as the result.
- If `stderr` is present, lilypond failed without a message that could be
  parsed; read it as it is.

### Options

- `-I <dir>` (repeatable) adds an `\include` directory, relative to where you run
  the command. Anything after `--` goes to lilypond as is.
- `--out-dir <dir>` chooses where the SVG pages go. The default is a directory
  per score under the system temp directory, emptied on every run. Nothing is
  ever written next to the source.
- `--lilypond <path>` or `$LILYPOND_PATH` selects the executable.
- Without `--json` the same report is printed as `file:line:col: severity:
  message` lines.

### As an MCP tool

`node dist/lily-check.js mcp` serves the same check on stdio as the tool
`lilypond_compile`, with the arguments `file` (absolute path of the root file),
and optionally `extraArgs` and `outDir`. The result is the JSON above. Register it
with Codex once, with absolute paths:

```sh
codex mcp add lily -- node /abs/path/to/dist/lily-check.js mcp
```

which writes to `~/.codex/config.toml`:

```toml
[mcp_servers.lily]
command = "node"
args = ["/abs/path/to/dist/lily-check.js", "mcp"]
```

When the tool is available, prefer it to the shell command; the loop is the same.
