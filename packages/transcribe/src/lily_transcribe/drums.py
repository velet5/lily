"""Kick, snare and hi-hat in a drums stem, on the grid's sixteenths.

Each drum is a band of the spectrum where it is loud and the others are
quiet: the kick below 150 Hz, the snare from 600 Hz to 2.5 kHz (above the
kick's overtones, below the cymbals), the hi-hat above 5 kHz. A hit is a
jump in a band's energy at a sixteenth, strong against the song's own
strongest. Toms, cymbals and ghost notes are not told apart.
"""

from __future__ import annotations

import numpy as np

from .grid import Grid
from .quantize import Note

# General MIDI's percussion numbers, which the score names bd, sn and hh.
KICK, SNARE, HIHAT = 36, 38, 42
BANDS = {KICK: (30.0, 150.0), SNARE: (600.0, 2500.0), HIHAT: (5000.0, 11000.0)}
# A band's energy is measured above this share of its loud level (its 95th percentile).
FLOOR = 0.01
# A hit is at least this share of the band's strongest (its 98th percentile).
SHARE = 0.35
# How far from a sixteenth a hit may land, in seconds.
WINDOW = 0.035
# The longest a hit is written, in sixteenths; a quarter, then rests.
LONGEST = 4


def band_flux(samples: np.ndarray, sample_rate: int, hop: int = 256, size: int = 2048) -> tuple[np.ndarray, dict[int, np.ndarray]]:
    """Frame times, and each band's rise in log energy at each frame."""
    padded = np.pad(samples, (size // 2, size // 2))
    frames = np.lib.stride_tricks.sliding_window_view(padded, size)[::hop] * np.hanning(size)
    power = np.abs(np.fft.rfft(frames, axis=1)) ** 2
    frequencies = np.fft.rfftfreq(size, 1 / sample_rate)
    times = np.arange(len(power)) * hop / sample_rate
    flux = {}
    for drum, (low, high) in BANDS.items():
        band = power[:, (frequencies >= low) & (frequencies < high)].sum(axis=1)
        # Against the band's own loud hits: what leaks in from another drum is far below them.
        floor = FLOOR * np.percentile(band, 95) + 1e-12
        energy = np.log(band + floor)
        rise = np.maximum(0.0, energy[2:] - energy[:-2])
        flux[drum] = np.concatenate([[0.0, 0.0], rise])
    return times, flux


def hits(samples: np.ndarray, sample_rate: int, grid: Grid, start: int, end: int) -> list[Note]:
    """The drums struck at each sixteenth from `start` to `end`, each lasting until the next (a quarter at most)."""
    times, flux = band_flux(samples, sample_rate)
    struck: dict[int, list[int]] = {}
    for drum, rise in flux.items():
        # Each peak of the band's rise goes to its nearest sixteenth, so one hit is not heard in two.
        peaks = np.flatnonzero((rise[1:-1] > 0) & (rise[1:-1] >= rise[:-2]) & (rise[1:-1] > rise[2:])) + 1
        cells = np.round(np.asarray(grid.position(times[peaks]), dtype=float)).astype(int)
        near = np.abs(np.asarray(grid.seconds(cells)) - times[peaks]) <= WINDOW
        inside = near & (cells >= start) & (cells < end)
        strength: dict[int, float] = {}
        for cell, value in zip(cells[inside], rise[peaks][inside]):
            strength[int(cell)] = max(strength.get(int(cell), 0.0), float(value))
        if not strength:
            continue
        top = np.percentile(list(strength.values()) + [0.0] * (end - start - len(strength)), 98)
        for cell, value in strength.items():
            if top > 0 and value > SHARE * top:
                struck.setdefault(cell, []).append(drum)
    onsets = sorted(struck)
    notes: list[Note] = []
    for index, at in enumerate(onsets):
        until = onsets[index + 1] if index + 1 < len(onsets) else end
        notes.append((at, min(until - at, LONGEST), sorted(struck[at])))
    return notes
