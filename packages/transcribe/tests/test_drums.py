"""Kick, snare and hi-hat found in a synthesized drum loop."""

import numpy as np

from lily_transcribe import drums, grid

RATE = 22050
GRID = grid.Grid(120.0, True, 4, 0.0, np.array([0.0, 0.5]))


def hit(kind: str, rng) -> np.ndarray:
    t = np.arange(int(0.12 * RATE)) / RATE
    # Three milliseconds to sound, as a drum's skin or a cymbal takes; an
    # instant start would sound in every band.
    attack = np.minimum(1.0, t / 0.003)
    if kind == "kick":
        return np.sin(2 * np.pi * 60 * t) * np.exp(-t * 30) * attack
    noise = rng.standard_normal(len(t))
    spectrum = np.fft.rfft(noise)
    frequencies = np.fft.rfftfreq(len(t), 1 / RATE)
    low, high = (800, 2000) if kind == "snare" else (7000, 10000)
    spectrum[(frequencies < low) | (frequencies > high)] = 0
    return np.fft.irfft(spectrum, len(t)) / 3 * np.exp(-t * (40 if kind == "snare" else 80)) * attack


def test_a_rock_beat_is_kick_on_one_and_three_snare_on_two_and_four_hats_on_eighths():
    rng = np.random.default_rng(1)
    samples = np.zeros(RATE * 9)
    for bar in range(4):
        for sixteenth in range(16):
            at = int((bar * 2.0 + sixteenth * 0.125) * RATE)
            kinds = (["kick"] if sixteenth in (0, 8) else []) + (["snare"] if sixteenth in (4, 12) else []) + (["hat"] if sixteenth % 2 == 0 else [])
            for kind in kinds:
                sound = hit(kind, rng)
                samples[at : at + len(sound)] += sound
    found = drums.hits(samples, RATE, GRID, 0, 64)
    bar = [(at, pitches) for at, _, pitches in found if 16 <= at < 32]
    assert bar == [
        (16, [drums.KICK, drums.HIHAT]),
        (18, [drums.HIHAT]),
        (20, [drums.SNARE, drums.HIHAT]),
        (22, [drums.HIHAT]),
        (24, [drums.KICK, drums.HIHAT]),
        (26, [drums.HIHAT]),
        (28, [drums.SNARE, drums.HIHAT]),
        (30, [drums.HIHAT]),
    ]
    # Each lasts until the next hit.
    assert all(length == 2 for at, length, _ in found if 16 <= at < 30)


def test_silence_has_no_hits():
    assert drums.hits(np.zeros(RATE * 4), RATE, GRID, 0, 32) == []
