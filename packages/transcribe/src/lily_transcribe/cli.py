"""``lily-transcribe`` command line (DECISIONS D113).

    lily-transcribe --json transcribe <stem> --instrument bass

With ``--json`` every line on stdout is one JSON event, which is how Lily
Studio drives it, as it drives karaoke-mlx:

    {"event": "progress", "stage": "decode|beats|key|notes"}
    {"event": "done", "transcription": {...}, "seconds": 12.3}
    {"event": "error", "message": "..."}

The transcription is what Lily Studio writes a score from: the tempo, whether
one tempo fits the song, the meter, where bar 1 starts, the key, the song's
length in bars and the notes, each `[at, length, [pitches]]` in sixteenths
from bar 1.
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

from . import audio, drums, grid, key, quantize
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

    def progress(self, stage: str) -> None:
        self.emit("progress", stage=stage)


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
    return {
        "stem": name,
        "family": kind.family,
        "seconds": round(seconds, 3),
        "bpm": round(beat_grid.bpm, 3),
        "steady": beat_grid.steady,
        "beatsPerBar": beat_grid.beats_per_bar,
        "barOne": round(beat_grid.bar_one, 4),
        "pickup": beat_grid.pickup,
        "bars": bars,
        "key": analysis["key"],
        "notes": [[at, length, pitches] for at, length, pitches in notes],
    }


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="lily-transcribe", description="Transcribe a stem for a LilyPond score.")
    parser.add_argument("--json", action="store_true", help="print JSON events on stdout")
    commands = parser.add_subparsers(dest="command", required=True)
    one = commands.add_parser("transcribe", help="transcribe one stem")
    one.add_argument("stem", type=Path)
    one.add_argument("--instrument", required=True, help="the stem's name: bass, vocals, drums, guitar, piano, other…")
    args = parser.parse_args(argv)
    out = Reporter(args.json)
    began = time.monotonic()
    try:
        if not args.stem.is_file():
            raise RuntimeError(f"{args.stem} is not a file.")
        result = transcribe(args.stem, args.instrument, out)
    except Exception as error:  # every failure ends with an error event
        if not args.json:
            raise
        out.emit("error", message=str(error) or type(error).__name__)
        sys.exit(1)
    if args.json:
        out.emit("done", transcription=result, seconds=round(time.monotonic() - began, 2))
    else:
        json.dump(result, sys.stdout, indent=1)
        print()


if __name__ == "__main__":
    main()
