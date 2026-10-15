"""Decoding a stem, and the song it came from, through ffmpeg."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import numpy as np

# What karaoke-mlx writes, and what Lily Studio offers as a song.
AUDIO_EXTENSIONS = {".wav", ".flac", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".aiff", ".aif"}


def ffmpeg() -> str:
    for candidate in (shutil.which("ffmpeg"), "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"):
        if candidate and Path(candidate).exists():
            return candidate
    raise RuntimeError("ffmpeg was not found. Install it with `brew install ffmpeg`.")


def load(path: str | Path, sample_rate: int = 22050) -> np.ndarray:
    """Any audio file as float32 mono samples at `sample_rate`."""
    command = [ffmpeg(), "-v", "error", "-nostdin", "-i", str(path), "-f", "f32le", "-ac", "1", "-ar", str(sample_rate), "-"]
    done = subprocess.run(command, capture_output=True)
    if done.returncode != 0:
        raise RuntimeError(f"{Path(path).name} could not be read: {done.stderr.decode(errors='replace').strip()}")
    return np.frombuffer(done.stdout, dtype=np.float32).copy()


def save_wav(path: Path, samples: np.ndarray, sample_rate: int) -> None:
    """Mono float samples as a 32-bit float WAV, which Basic Pitch reads."""
    command = [ffmpeg(), "-v", "error", "-nostdin", "-y", "-f", "f32le", "-ac", "1", "-ar", str(sample_rate), "-i", "-", "-c:a", "pcm_f32le", str(path)]
    done = subprocess.run(command, input=np.ascontiguousarray(samples, dtype=np.float32).tobytes(), capture_output=True)
    if done.returncode != 0:
        raise RuntimeError(f"{path.name} could not be written: {done.stderr.decode(errors='replace').strip()}")


def siblings(stem: Path) -> list[Path]:
    """The stems separated with `stem`, itself included.

    karaoke-mlx names them `<song> - <stem>.<ext>` in one folder; a mix
    exported beside them (`<song> - mix.<ext>`) is not one.
    """
    song, dash, _ = stem.stem.rpartition(" - ")
    if not dash:
        return [stem]
    found = sorted(
        path
        for path in stem.parent.iterdir()
        if path.is_file()
        and path.suffix.lower() in AUDIO_EXTENSIONS
        and path.stem.startswith(f"{song} - ")
        and path.stem != f"{song} - mix"
    )
    # One of each stem: the separation may have been written as WAV and again as MP3.
    by_name: dict[str, Path] = {}
    for path in found:
        by_name.setdefault(path.stem, path)
    if stem.stem in by_name:
        by_name[stem.stem] = stem
    return list(by_name.values()) or [stem]


def mix(stems: list[Path], sample_rate: int = 22050) -> np.ndarray:
    """The stems summed back into the song, mono."""
    tracks = [load(path, sample_rate) for path in stems]
    length = max(len(track) for track in tracks)
    total = np.zeros(length, dtype=np.float32)
    for track in tracks:
        total[: len(track)] += track
    return total
