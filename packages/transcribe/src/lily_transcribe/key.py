"""The song's key, from the notes Basic Pitch hears in all its stems but the
drums. Taken from the song rather than from one stem, every stem's score of a
song is in the same key.

The notes, not the spectrum: a spectrum's overtones put a major third over
every root, and a minor song then reads as major. Temperley's profiles (from
the Kostka–Payne corpus) are used, not Krumhansl and Kessler's, which weigh
the tonic and dominant so much that major and minor come out nearly equal.
"""

from __future__ import annotations

from collections.abc import Iterable

import numpy as np

MAJOR = np.array([0.748, 0.060, 0.488, 0.082, 0.670, 0.460, 0.096, 0.715, 0.104, 0.366, 0.057, 0.400])
MINOR = np.array([0.712, 0.084, 0.474, 0.618, 0.049, 0.460, 0.105, 0.747, 0.404, 0.068, 0.244, 0.191])


def profile(events: Iterable[tuple[float, float, int, float]]) -> np.ndarray:
    """How long each pitch class sounds, C first, weighted by loudness."""
    weights = np.zeros(12)
    for start, end, pitch, amplitude in events:
        weights[pitch % 12] += max(0.0, end - start) * amplitude
    return weights


def from_profile(weights: np.ndarray) -> tuple[int, str, float]:
    """(tonic pitch class, "major" or "minor", correlation) for a 12-bin profile starting at C."""
    best = (0, "major", -2.0)
    if not np.any(weights):
        return 0, "major", 0.0
    for tonic in range(12):
        rolled = np.roll(weights, -tonic)
        for mode, shape in (("major", MAJOR), ("minor", MINOR)):
            r = float(np.corrcoef(rolled, shape)[0, 1])
            if r > best[2]:
                best = (tonic, mode, r)
    return best


def detect(events: Iterable[tuple[float, float, int, float]]) -> tuple[int, str, float]:
    return from_profile(profile(events))
