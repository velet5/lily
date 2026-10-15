# lily-transcribe

Lily Studio's transcription of a stem (DECISIONS D113): the notes, beats,
meter and key that *New score for bass* writes a score from. Lily Studio runs
it with [uv](https://docs.astral.sh/uv/) as a sidecar, as it runs RoFormer
MLX's separation (D112).

```sh
uv sync                    # once; installs Python 3.11, Basic Pitch, Beat This and torch
uv run lily-transcribe transcribe "song (stems)/song - bass.wav" --instrument bass
uv run pytest
```

- Notes: [Basic Pitch](https://github.com/spotify/basic-pitch) (Apache-2.0).
- Beats and downbeats, from all the song's stems mixed back together:
  [Beat This!](https://github.com/CPJKU/beat_this) (MIT, code and weights),
  without madmom's DBN, which is for non-commercial use only. Its checkpoint
  (77 MB) downloads on the first transcription.
- Kick, snare and hi-hat, the key, the grid and the quantizing: this package.

The beats and key of a song are kept in `~/.cache/lily-transcribe`
(`LILY_TRANSCRIBE_HOME`), so the song's other stems are quicker.
