"""The beat grid: tempo, meter and bar 1 from Beat This's beats and downbeats."""

import numpy as np
import pytest

from lily_transcribe import grid


def steady(bpm: float, start: float, count: int, jitter: float = 0.0, seed: int = 0) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return start + np.arange(count) * 60.0 / bpm + rng.uniform(-jitter, jitter, count)


def test_a_click_track_song_is_one_whole_tempo_with_its_fills_ignored():
    beats = steady(123.0, 0.21, 400, jitter=0.015)
    # A fill that Beat This counts in eighths.
    fill = beats[100:104] + 30 / 123.0
    found = grid.fit(np.sort(np.concatenate([beats, fill])), beats[::4])
    assert found.steady
    assert found.bpm == 123.0
    assert found.beats_per_bar == 4
    assert found.bar_one == pytest.approx(0.21, abs=0.01)
    assert found.pickup == 2
    # Bar 2 starts 16 sixteenths after bar 1.
    assert found.position(found.bar_one + 4 * 60 / 123.0) == pytest.approx(16.0)
    assert found.seconds(16) == pytest.approx(found.bar_one + 4 * 60 / 123.0)


def test_a_tempo_between_whole_numbers_is_kept():
    found = grid.fit(steady(122.6, 0.5, 300), steady(122.6, 0.5, 300)[::4])
    assert found.bpm == pytest.approx(122.6, abs=0.01)


def test_the_downbeats_say_where_bar_one_is_and_the_meter():
    beats = steady(100.0, 0.0, 120)
    # Three beats a bar, starting on the second beat found.
    found = grid.fit(beats, beats[1::3])
    assert found.beats_per_bar == 3
    assert found.bar_one == pytest.approx(0.6)
    assert found.pickup == 4


def test_a_bar_line_at_the_start_is_no_pickup():
    beats = steady(120.0, 0.01, 200)
    found = grid.fit(beats, beats[::4])
    assert found.pickup == 0


def test_a_song_that_drifts_follows_its_beats():
    # Slowing from 120 to 100 over the song.
    intervals = np.linspace(0.5, 0.6, 200)
    beats = 0.3 + np.concatenate([[0.0], np.cumsum(intervals)])
    found = grid.fit(beats, beats[::4])
    assert not found.steady
    assert found.bar_one == pytest.approx(0.3)
    # Each beat found is four sixteenths after the one before.
    assert found.position(beats[40]) == pytest.approx(160.0)
    assert found.seconds(160.0) == pytest.approx(beats[40])


def test_clean_beats_drops_extra_ones_and_fills_missed_ones():
    beats = np.array([0.0, 0.5, 0.75, 1.0, 1.5, 2.5, 3.0])
    assert grid.clean_beats(beats) == pytest.approx([0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0])


def test_too_few_beats_is_an_error():
    with pytest.raises(ValueError):
        grid.fit(np.array([0.0, 0.5]), np.array([0.0]))
