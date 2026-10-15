"""The beat grid: where the beats and bar lines of a song fall.

Beat This finds beats and downbeats in the whole mix, not in the stem: a bass
or vocal stem has no drums to keep time with. A song recorded to a click is
one tempo from end to end, so a straight grid is fitted through the beats,
at a whole number of beats per minute when the song is that close to one.
It ignores the fills that Beat This counts in eighths, and the score's MIDI
then keeps time with the stem to the end. A song that drifts keeps the beats
as they were found, cleaned up. The downbeats vote for the meter and for
where bar 1 starts; positions are counted in sixteenths from there.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

import numpy as np

# A beat this close to the straight grid is on it.
TOLERANCE = 0.04
# This share of the beats on one straight grid makes the song steady.
STEADY = 0.8
# A tempo this close to a whole number of beats per minute is that number.
WHOLE_TEMPO = 0.1
# A bar line closer than this to the start is the start: no pickup.
NO_LEAD = 0.03
SIXTEENTHS_PER_BEAT = 4


@dataclass
class Grid:
    """Beats per minute, whether one tempo fits the song, the meter, and where bar 1 starts."""

    bpm: float
    steady: bool
    beats_per_bar: int
    # Seconds from the start of the audio to bar 1's first beat.
    bar_one: float
    # The beats, in seconds, that positions are read from; a steady grid
    # holds two of them, and extends them.
    beats: np.ndarray

    @property
    def beat(self) -> float:
        return 60.0 / self.bpm

    def position(self, seconds: float | np.ndarray) -> float | np.ndarray:
        """Sixteenths from bar 1, negative before it; not rounded."""
        if self.steady:
            beats = (np.asarray(seconds) - self.bar_one) / self.beat
        else:
            beats = _beat_index(self.beats, self.beat, seconds) - _beat_index(self.beats, self.beat, self.bar_one)
        result = beats * SIXTEENTHS_PER_BEAT
        return float(result) if np.ndim(result) == 0 else result

    def seconds(self, position: float | np.ndarray) -> float | np.ndarray:
        """The time of a position in sixteenths from bar 1."""
        beats = np.asarray(position, dtype=float) / SIXTEENTHS_PER_BEAT
        if self.steady:
            result = self.bar_one + beats * self.beat
        else:
            start = _beat_index(self.beats, self.beat, self.bar_one)
            result = _beat_time(self.beats, self.beat, beats + start)
        return float(result) if np.ndim(result) == 0 else result

    @property
    def pickup(self) -> int:
        """Sixteenths before bar 1: the lead-in from the start of the audio, rounded."""
        if self.bar_one < NO_LEAD:
            return 0
        return max(1, round(self.bar_one / self.beat * SIXTEENTHS_PER_BEAT))


def _beat_index(beats: np.ndarray, beat: float, seconds) -> np.ndarray:
    """Fractional beat numbers of `seconds`, extended past both ends at `beat`."""
    seconds = np.asarray(seconds, dtype=float)
    index = np.interp(seconds, beats, np.arange(len(beats), dtype=float))
    index = np.where(seconds < beats[0], (seconds - beats[0]) / beat, index)
    return np.where(seconds > beats[-1], len(beats) - 1 + (seconds - beats[-1]) / beat, index)


def _beat_time(beats: np.ndarray, beat: float, index) -> np.ndarray:
    index = np.asarray(index, dtype=float)
    seconds = np.interp(index, np.arange(len(beats), dtype=float), beats)
    seconds = np.where(index < 0, beats[0] + index * beat, seconds)
    return np.where(index > len(beats) - 1, beats[-1] + (index - len(beats) + 1) * beat, seconds)


def fit_steady(beats: np.ndarray) -> tuple[float, float, float]:
    """The straight grid through the most beats: (seconds per beat, phase, share on it)."""
    median = float(np.median(np.diff(beats)))
    best = (0.0, median, 0.0)
    for period in np.linspace(median * 0.97, median * 1.03, 601):
        phase = np.angle(np.mean(np.exp(2j * np.pi * beats / period))) * period / (2 * np.pi)
        deviation = (beats - phase + period / 2) % period - period / 2
        share = float(np.mean(np.abs(deviation) < TOLERANCE))
        if share > best[0]:
            best = (share, period, phase)
    _, period, phase = best
    # Least squares through the beats on that grid, for the tempo to the millisecond.
    number = np.round((beats - phase) / period)
    on = np.abs(beats - (phase + number * period)) < TOLERANCE
    if on.sum() >= 2 and len(set(number[on])) >= 2:
        period, phase = np.linalg.lstsq(np.vstack([number[on], np.ones(on.sum())]).T, beats[on], rcond=None)[0]
    number = np.round((beats - phase) / period)
    share = float(np.mean(np.abs(beats - (phase + number * period)) < TOLERANCE))
    return float(period), float(phase), share


def whole_tempo(beats: np.ndarray, period: float, phase: float, share: float) -> tuple[float, float, float]:
    """The grid at the nearest whole tempo, when it is that close and fits as well.

    A song recorded to a click is at a whole number of beats per minute, and
    123.015 is 123 measured in frames of 20 ms. A score's \\tempo is a whole
    number, so the score's MIDI then keeps time with the stem exactly.
    """
    bpm = 60.0 / period
    whole = round(bpm)
    if whole <= 0 or abs(bpm - whole) > WHOLE_TEMPO:
        return period, phase, share
    period_whole = 60.0 / whole
    # The phase that fits most beats at the whole tempo: their circular mean.
    on = np.abs(beats - (phase + np.round((beats - phase) / period) * period)) < TOLERANCE
    angles = 2 * np.pi * beats[on] / period_whole
    phase_whole = float(np.angle(np.mean(np.exp(1j * angles))) * period_whole / (2 * np.pi))
    number = np.round((beats - phase_whole) / period_whole)
    share_whole = float(np.mean(np.abs(beats - (phase_whole + number * period_whole)) < TOLERANCE))
    if share_whole < share - 0.02:
        return period, phase, share
    return period_whole, phase_whole, share_whole


def clean_beats(beats: np.ndarray) -> np.ndarray:
    """Beat This's beats without the extra ones of a fill, and with the missed ones put back."""
    median = float(np.median(np.diff(beats)))
    kept = [float(beats[0])]
    for time in beats[1:]:
        if time - kept[-1] >= 0.6 * median:
            kept.append(float(time))
    filled = [kept[0]]
    for time in kept[1:]:
        gap = time - filled[-1]
        missing = round(gap / median) - 1
        filled.extend(filled[-1] + gap * (step + 1) / (missing + 1) for step in range(max(0, missing)))
        filled.append(time)
    return np.array(filled)


def meter_and_phase(numbers: np.ndarray) -> tuple[int, int]:
    """Beats per bar, from the downbeats' spacing, and which beat number mod it they fall on."""
    numbers = np.unique(numbers.astype(int))
    if len(numbers) < 2:
        return 4, int(numbers[0]) % 4 if len(numbers) else 0
    spacing = Counter(int(gap) for gap in np.diff(numbers) if 2 <= gap <= 4)
    beats_per_bar = spacing.most_common(1)[0][0] if spacing else 4
    phase = Counter(int(number) % beats_per_bar for number in numbers).most_common(1)[0][0]
    return beats_per_bar, phase


def fit(beats: np.ndarray, downbeats: np.ndarray) -> Grid:
    """The grid of a song from Beat This's beats and downbeats, in seconds."""
    beats = np.asarray(beats, dtype=float)
    downbeats = np.asarray(downbeats, dtype=float)
    if len(beats) < 4:
        raise ValueError("Too few beats were found to tell the tempo.")
    period, phase, share = fit_steady(beats)
    period, phase, share = whole_tempo(beats, period, phase, share)
    if share >= STEADY:
        number = np.round((downbeats - phase) / period)
        on = np.abs(downbeats - (phase + number * period)) < TOLERANCE
        beats_per_bar, bar_phase = meter_and_phase(number[on])
        # The first bar line at the start or after it.
        first = phase + bar_phase * period
        bar = period * beats_per_bar
        bar_one = first - np.floor((first + NO_LEAD) / bar) * bar
        return Grid(60.0 / period, True, beats_per_bar, float(bar_one), np.array([phase, phase + period]))
    cleaned = clean_beats(beats)
    beat = float(np.median(np.diff(cleaned)))
    number = np.round(_beat_index(cleaned, beat, downbeats))
    beats_per_bar, bar_phase = meter_and_phase(number)
    # The first beat number on bar_phase whose time is at the start or after it.
    first = bar_phase - beats_per_bar * np.ceil((bar_phase - _beat_index(cleaned, beat, -NO_LEAD)) / beats_per_bar)
    while _beat_time(cleaned, beat, first) < -NO_LEAD:
        first += beats_per_bar
    return Grid(60.0 / beat, False, beats_per_bar, float(_beat_time(cleaned, beat, first)), cleaned)
