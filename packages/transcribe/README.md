# lily-transcribe

Lily Studio's transcription of a stem (DECISIONS D113): the notes, beats,
meter and key that *New score for bass* writes a score from. Lily Studio runs
it with [uv](https://docs.astral.sh/uv/) as a sidecar, as it runs RoFormer
MLX's separation (D112).

```sh
uv sync                    # once; installs Python 3.11, Basic Pitch, Beat This and torch
uv run lily-transcribe transcribe "song (stems)/song - bass.wav" --instrument bass
uv run lily-transcribe tempo "song - instrumental.mp3" --score-bpm 114 --beats-per-bar 4
uv run lily-transcribe sung "song - vocals.wav" voice.json --voice lead
uv run pytest
```

- Notes: [Basic Pitch](https://github.com/spotify/basic-pitch) (Apache-2.0).
- Beats and downbeats, from all the song's stems mixed back together:
  [Beat This!](https://github.com/CPJKU/beat_this) (MIT, code and weights),
  without madmom's DBN, which is for non-commercial use only. Its checkpoint
  (77 MB) downloads on the first transcription.
- Kick, snare and hi-hat, the key, the grid and the quantizing: this package.
- Words, for vocals (D134): Whisper large-v3-turbo on MLX
  ([mlx-whisper](https://github.com/ml-explore/mlx-examples), MIT, code and
  weights) hears them with their times; [Pyphen](https://github.com/Kozea/Pyphen)'s
  hyphenation dictionaries split them into syllables; this package lays the
  syllables on the notes. The model (1.6 GB) downloads on the first vocals;
  `LILY_TRANSCRIBE_WHISPER` names another.

`tempo` (D159) is Lily Studio's *From the recording*: a score's tempo and
bar 1 from its `% Audio:` recording, for its `% BPM:` and `% Audio offset:`.
Beat This runs on the recording itself, with nothing mixed in. The tempo is a
straight line through the beats, kept to the hundredth (no snap to a whole
number, which is for a `\tempo`), at the metrical level (×½, ×1, ×2, and ×⅔,
×3⁄2 for a dotted beat) nearest `--score-bpm` (120 without one), in quarter
notes a minute: `--beat 1.5` says the score counts 6/8's dotted quarters.
`--beats-per-bar` groups the beats into the score's bars; the downbeats only
choose which beat starts one. `done` has `bpm`, `heardBpm`, `steady`, `share`
(of the beats on one tempo), `residualMs` (their 95th percentile from it),
`beatsPerBar`, `heardBeatsPerBar`, `barOne` (the first bar line at or after
the start, in seconds) and `seconds` (the recording's length). A recording
with too few beats, or beats that keep no tempo, as a voice alone, ends in
`error`.

`sung` (D276) is Lily Studio's *From the singer*: where the singer of a
score's recording sings each note of one voice, from the lead vocals stem
karaoke-mlx separates. `voice.json`, which the studio writes, has the score's
`bpm` and the voice's notes in the order played, each with its grid `start`
and `length` in seconds on the recording's timeline, its MIDI `pitch`, and
the `syllable` that starts on it, if one does. Each phrase, cut at the
words' full stops, is force-aligned in its own window (its notes ± 0.6 s),
with `<star>` between the syllables, for each syllable's consonant, vowel
and score; pYIN's f0 says whether each note is sung as written, in the
singer's octave, and where the voice crosses into a new pitch on a leap or
inside a melisma. A note's arrival is its vowel less the aligner's measured
lag (72 ms), or its crossing inside a melisma, and is null when its syllable
is in the song's least confident quarter. A note moves only when its arrival
is more than 50 ms and at most a 16th from the grid, and a crossing on the
same note agrees within 50 ms; else its `shift` is 0. A phrase whose
syllables all score below 0.02 is not sung, and its notes are not checked.
`done` has, per note, `shift` (ms), `arrival`, `consonant`, `vowel`, `score`,
`asWritten` and `heard`; per phrase `first`, `last` and `sung`; and `lag`,
`tau` (the 16th), `octave` and `took`. A stem with no voice in it ends in
`error`. Words with no Latin letters (Russian) are not aligned yet: their
notes keep the grid, and a `warning` says so.

- Words, for `sung`: MMS_FA, the forced-alignment model of Meta AI's
  [Massively Multilingual Speech](https://github.com/facebookresearch/fairseq/tree/main/examples/mms)
  (Pratap et al., 2023), through torchaudio's `MMS_FA` pipeline (BSD-2);
  the path through its frames is this package's own CTC Viterbi, as
  torchaudio 2.11's `forced_align` returns worse paths on some inputs. Its
  weights are
  [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/), for
  non-commercial use only, which Lily is (D169): they are not in this
  package and download (1.18 GB) to `~/.cache/torch/hub` on the first
  `sung`.
- Pitch, for `sung`: [pYIN](https://librosa.org/doc/main/generated/librosa.pyin.html)
  (Mauch and Dixon, 2014) in librosa (ISC), with no model.

The beats and key of a song are kept in `~/.cache/lily-transcribe`
(`LILY_TRANSCRIBE_HOME`), so the song's other stems are quicker; so are a
recording's beats, so `tempo` is instant the second time, and a stem's f0
and each phrase window's MMS_FA emission, so `sung` again on the same score
is instant and an edit re-aligns only the phrases it moved.
