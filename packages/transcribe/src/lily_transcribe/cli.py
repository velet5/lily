"""``lily-transcribe`` command line (DECISIONS D113, D159).

    lily-transcribe --json transcribe <stem> --instrument bass
    lily-transcribe --json tempo <recording> [--score-bpm 114] [--beats-per-bar 4] [--beat 1]
    lily-transcribe --json sung <stem> <voice.json> --voice lead

With ``--json`` every line on stdout is one JSON event, which is how Lily
Studio drives it, as it drives karaoke-mlx:

    {"event": "progress", "stage": "decode|beats|key|notes|words"}
    {"event": "warning", "message": "..."}
    {"event": "done", "transcription": {...}, "seconds": 12.3}
    {"event": "error", "message": "..."}

The transcription is what Lily Studio writes a score from: the tempo, whether
one tempo fits the song, the meter, where bar 1 starts, the key, the song's
length in bars and the notes, each `[at, length, [pitches]]` in sixteenths
from bar 1, and when each bar starts in the stem. For vocals it has the words too (D134), `[at, text, hyphen]` for
each note sung to a syllable, and the language they are in. A `warning` says
what the run could not do and goes on without.

`tempo` finds a score's tempo and bar 1 in its recording (D159), for Lily
Studio's *From the recording*. Its stages are `decode` and `beats`, and its
`done` has `{bpm, heardBpm, steady, share, residualMs, beatsPerBar,
heardBeatsPerBar, barOne, seconds}`: the tempo in quarter notes a minute to
the hundredth, at the metrical level nearest `--score-bpm` (120 without one),
the tempo as heard, whether one tempo fits, the share of the beats on it,
the 95th percentile of their distance from it in milliseconds, the meter
taken (`--beats-per-bar`, or the downbeats' vote) and the downbeats' own,
the first bar line at or after the start in seconds, and the recording's
length in seconds; `took` is how long the run took. A recording without a
beat to find ends in `error`.

`sung` compares a voice of the score with the vocals stem of its recording
(D276), for Lily Studio's *From the singer*; `voice.json` is the voice's
notes as the studio plays them (`sung.py` says how). Its stages are
`decode`, `pitch` and `words`, and its `done` has `{voice, notes, phrases,
lag, tau, octave, took}`: per note, in voice.json's order, `shift` (whole
milliseconds from the grid, 0 for the grid), `arrival` (seconds, or null
without confident evidence), the syllable's `consonant` and `vowel`
(seconds, or null) and `score`, `asWritten` (true, false, or null when it
cannot be told) and `heard` (the MIDI pitch sung, in the score's octave, or
null); per phrase its `first` and `last` note and whether it is `sung`
(null when none of its syllables could be aligned); MMS_FA's `lag` and the
16th `tau` in seconds, and the singer's `octave` from the score in
semitones. A stem with no voice in it ends in `error`.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import math
import os
import sys
import tempfile
import time
from pathlib import Path

import numpy as np

from . import audio, drums, grid, key, lyrics, quantize, sung, tempo
from .instruments import instrument

SAMPLE_RATE = 22050
# Bump when what is kept per song changes.
CACHE_VERSION = 2
# Basic Pitch hears A0 to C8. A limit past either end leaves it no notes, so
# only a narrower range is passed, a little wider than the instrument's.
LOWEST, HIGHEST = 21, 108
# Basic Pitch bends a note in steps of a third of a semitone.
BEND_STEPS = 3
FREQUENCY_MARGIN = 0.94


class Reporter:
    def __init__(self, as_json: bool):
        self.as_json = as_json

    def emit(self, event: str, **data) -> None:
        if self.as_json:
            print(json.dumps({"event": event, **data}), flush=True)
        elif event == "progress":
            print(f"{data['stage']}…", file=sys.stderr, flush=True)
        elif event == "warning":
            print(data["message"], file=sys.stderr, flush=True)

    def progress(self, stage: str) -> None:
        self.emit("progress", stage=stage)

    def warning(self, message: str) -> None:
        self.emit("warning", message=message)


def cache_dir() -> Path:
    home = os.environ.get("LILY_TRANSCRIBE_HOME")
    return Path(home) if home else Path.home() / ".cache" / "lily-transcribe"


def song_key(stems: list[Path]) -> str:
    """Names the song's beats and key in the cache: its stems' names, sizes and times."""
    digest = hashlib.sha256(f"v{CACHE_VERSION}".encode())
    for path in stems:
        info = path.stat()
        digest.update(f"\0{path.resolve()}\0{info.st_size}\0{info.st_mtime_ns}".encode())
    return digest.hexdigest()[:32]


def song_analysis(stems: list[Path], out: Reporter) -> dict:
    """Beats, downbeats and key of the song the stems came from, from the cache when it has them."""
    cached = cache_dir() / f"{song_key(stems)}.json"
    with contextlib.suppress(OSError, ValueError):
        return json.loads(cached.read_text())
    out.progress("decode")
    mix = audio.mix(stems, SAMPLE_RATE)
    out.progress("beats")
    beats, downbeats = track_beats(mix, SAMPLE_RATE)
    out.progress("key")
    pitched = [path for path in stems if not path.stem.endswith(" - drums")] or stems
    heard = notes_of(audio.mix(pitched, SAMPLE_RATE))
    offset = tuning(heard)
    tonic, mode, fit = key.detect(retune(heard, offset))
    analysis = {
        "beats": [round(float(t), 4) for t in beats],
        "downbeats": [round(float(t), 4) for t in downbeats],
        "tuning": round(offset, 3),
        "key": {"tonic": tonic, "mode": mode, "fit": round(fit, 3)},
    }
    with contextlib.suppress(OSError):
        cached.parent.mkdir(parents=True, exist_ok=True)
        cached.write_text(json.dumps(analysis))
    return analysis


def beats_key(recording: Path) -> str:
    """Names a recording's beats in the cache: its name, size and time, apart from the songs' analyses."""
    info = recording.stat()
    digest = hashlib.sha256(f"beats v{CACHE_VERSION}\0{recording.resolve()}\0{info.st_size}\0{info.st_mtime_ns}".encode())
    return digest.hexdigest()[:32]


def recording_beats(recording: Path, out: Reporter) -> dict:
    """Beats and downbeats of one recording, as it is, and its length: from the cache when it has them.

    No siblings are mixed in: a karaoke or stems separation's file gives the
    same tempo and bar 1 as the song mixed back (docs/research/audio-tempo §3.1).
    """
    cached = cache_dir() / f"{beats_key(recording)}.json"
    with contextlib.suppress(OSError, ValueError):
        return json.loads(cached.read_text())
    out.progress("decode")
    samples = audio.load(recording, SAMPLE_RATE)
    out.progress("beats")
    beats, downbeats = track_beats(samples, SAMPLE_RATE)
    found = {
        "beats": [round(float(t), 4) for t in beats],
        "downbeats": [round(float(t), 4) for t in downbeats],
        "seconds": round(len(samples) / SAMPLE_RATE, 3),
    }
    with contextlib.suppress(OSError):
        cached.parent.mkdir(parents=True, exist_ok=True)
        cached.write_text(json.dumps(found))
    return found


def detect_tempo(recording: Path, score_bpm: float | None, beats_per_bar: int | None, beat: float, out: Reporter) -> dict:
    found = recording_beats(recording, out)
    result = tempo.detect(np.array(found["beats"]), np.array(found["downbeats"]), score_bpm, beats_per_bar, beat)
    return {
        "bpm": round(result.bpm, 2),
        "heardBpm": round(result.heard_bpm, 2),
        "steady": result.steady,
        "share": round(result.share, 3),
        "residualMs": round(result.residual * 1000, 1),
        "beatsPerBar": result.beats_per_bar,
        "heardBeatsPerBar": result.heard_beats_per_bar,
        "barOne": round(result.bar_one, 3),
        "seconds": found["seconds"],
    }


def track_beats(samples: np.ndarray, sample_rate: int) -> tuple[np.ndarray, np.ndarray]:
    import torch
    from beat_this.inference import Audio2Beats

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    # Without the DBN: madmom's is for non-commercial use only.
    with contextlib.redirect_stdout(sys.stderr):
        return Audio2Beats(checkpoint_path="final0", device=device, dbn=False)(samples, sample_rate)


def _hertz(pitch: int) -> float:
    return 440.0 * 2 ** ((pitch - 69) / 12)


Heard = tuple[float, float, int, float, float]


def notes_of(
    samples: np.ndarray, low: int = LOWEST, high: int = HIGHEST, onset: float = 0.5, frame: float = 0.3
) -> list[Heard]:
    """Basic Pitch's notes from `low` to `high` in mono samples at SAMPLE_RATE:
    (start, end, MIDI pitch, amplitude, mean bend in semitones)."""
    from basic_pitch import ICASSP_2022_MODEL_PATH
    from basic_pitch.inference import predict

    with tempfile.TemporaryDirectory() as folder:
        wav = Path(folder) / "audio.wav"
        audio.save_wav(wav, samples, SAMPLE_RATE)
        with contextlib.redirect_stdout(sys.stderr):
            _, _, events = predict(
                wav,
                ICASSP_2022_MODEL_PATH,
                onset_threshold=onset,
                frame_threshold=frame,
                minimum_frequency=_hertz(low) * FREQUENCY_MARGIN if low > LOWEST else None,
                maximum_frequency=_hertz(high) / FREQUENCY_MARGIN if high < HIGHEST else None,
            )
    return [
        (float(start), float(end), int(pitch), float(amplitude), float(np.mean(bends)) / BEND_STEPS if bends else 0.0)
        for start, end, pitch, amplitude, bends in events
    ]


def tuning(heard: list[Heard]) -> float:
    """How far, in semitones, the song's notes sit from Basic Pitch's: the median bend, weighted by length and loudness."""
    weighted = sorted((bend, (end - start) * amplitude) for start, end, _, amplitude, bend in heard)
    total = sum(weight for _, weight in weighted)
    running = 0.0
    for bend, weight in weighted:
        running += weight
        if running >= total / 2:
            return bend
    return 0.0


def retune(heard: list[Heard], offset: float) -> list[tuple[float, float, int, float]]:
    """The notes with each pitch where it was sung or played, against the song's own tuning.

    A singer's E-flat, sharp by a quarter tone in a song itself a third of a
    semitone sharp, is heard as an E; its bend says it is an E-flat.
    """
    return [(start, end, round(pitch + bend - offset), amplitude) for start, end, pitch, amplitude, bend in heard]


def transcribe(stem: Path, name: str, out: Reporter) -> dict:
    kind = instrument(name)
    stems = audio.siblings(stem)
    analysis = song_analysis(stems, out)
    beat_grid = grid.fit(np.array(analysis["beats"]), np.array(analysis["downbeats"]))
    out.progress("notes")
    samples = audio.load(stem, SAMPLE_RATE)
    seconds = len(samples) / SAMPLE_RATE
    bar = beat_grid.beats_per_bar * grid.SIXTEENTHS_PER_BEAT
    start = -beat_grid.pickup
    bars = max(1, math.ceil(beat_grid.position(seconds) / bar))
    end = bars * bar
    if kind.family == "drums":
        notes = drums.hits(samples, SAMPLE_RATE, beat_grid, start, end)
    else:
        events = retune(notes_of(samples, kind.low, kind.high, kind.onset, kind.frame), analysis["tuning"])
        shape = quantize.melody if kind.family == "melody" else quantize.chords
        notes = shape(beat_grid, events, kind, start, end)
    result = {
        "stem": name,
        "family": kind.family,
        "seconds": round(seconds, 3),
        "bpm": round(beat_grid.bpm, 3),
        "steady": beat_grid.steady,
        "beatsPerBar": beat_grid.beats_per_bar,
        "barOne": round(beat_grid.bar_one, 4),
        "pickup": beat_grid.pickup,
        "bars": bars,
        # When each bar starts, and the last ends, in seconds: a drifting song's MIDI follows them (D135).
        "barTimes": [round(float(beat_grid.seconds(number * bar)), 4) for number in range(bars + 1)],
        "key": analysis["key"],
        "notes": [[at, length, pitches] for at, length, pitches in notes],
    }
    if name == "vocals" and notes:
        out.progress("words")
        try:
            words, language = lyrics.hear(stem)
            onsets = [float(beat_grid.seconds(at)) for at, _, _ in notes]
            laid = lyrics.align(lyrics.syllables(words, language), onsets)
        except Exception as error:  # the notes are worth having without the words
            out.warning(f"The words could not be made: {str(error) or type(error).__name__}")
        else:
            result["words"] = [[notes[index][0], text, hyphen] for index, text, hyphen in laid]
            result["language"] = language
    return result


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="lily-transcribe", description="Transcribe a stem for a LilyPond score.")
    parser.add_argument("--json", action="store_true", help="print JSON events on stdout")
    commands = parser.add_subparsers(dest="command", required=True)
    one = commands.add_parser("transcribe", help="transcribe one stem")
    one.add_argument("stem", type=Path)
    one.add_argument("--instrument", required=True, help="the stem's name: bass, vocals, drums, guitar, piano, other…")
    beat = commands.add_parser("tempo", help="a score's tempo and bar 1 from its recording")
    beat.add_argument("recording", type=Path)
    beat.add_argument("--score-bpm", type=float, help="the score's tempo in quarter notes a minute, which chooses the metrical level (120)")
    beat.add_argument("--beats-per-bar", type=int, help="the score's meter, which groups the beats into bars (the downbeats' vote)")
    beat.add_argument("--beat", type=float, default=1.0, help="the score's beat in quarter notes: 1.5 for 6/8's dotted quarter (1)")
    sing = commands.add_parser("sung", help="a voice's sung times from its vocals stem")
    sing.add_argument("stem", type=Path, help="the lead vocals stem of the score's recording")
    sing.add_argument("notes", type=Path, metavar="voice.json", help="the voice's notes, as the studio plays them")
    sing.add_argument("--voice", required=True, help="the voice's name, as the score's Voice has it")
    args = parser.parse_args(argv)
    out = Reporter(args.json)
    began = time.monotonic()
    try:
        paths = [args.recording] if args.command == "tempo" else [args.stem, args.notes] if args.command == "sung" else [args.stem]
        for path in paths:
            if not path.is_file():
                raise RuntimeError(f"{path} is not a file.")
        if args.command == "transcribe":
            result = transcribe(args.stem, args.instrument, out)
        elif args.command == "sung":
            result = sung.sung(args.stem, args.notes, args.voice, cache_dir(), out)
        else:
            if not args.beat > 0:
                raise RuntimeError("--beat must be more than 0.")
            result = detect_tempo(args.recording, args.score_bpm, args.beats_per_bar, args.beat, out)
    except Exception as error:  # every failure ends with an error event
        if not args.json:
            raise
        out.emit("error", message=str(error) or type(error).__name__)
        sys.exit(1)
    if args.json and args.command in ("tempo", "sung"):
        out.emit("done", **result, took=round(time.monotonic() - began, 2))
    elif args.json:
        out.emit("done", transcription=result, seconds=round(time.monotonic() - began, 2))
    else:
        json.dump(result, sys.stdout, indent=1)
        print()


if __name__ == "__main__":
    main()
