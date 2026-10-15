"""Notes in seconds onto the grid: melodies, chords, and what is dropped."""

from dataclasses import replace

import numpy as np

from lily_transcribe import grid, quantize
from lily_transcribe.instruments import instrument

# ♩ = 120 from bar 1 at 0: a sixteenth is 0.125 s.
GRID = grid.Grid(120.0, True, 4, 0.0, np.array([0.0, 0.5]))
S = 0.125


def test_a_melody_is_snapped_to_sixteenths_one_note_at_a_time():
    events = [
        (0.01, 0.49, 36, 0.8),  # a quarter, a little early and short
        (0.26, 0.40, 36, 0.3),  # a later onset cuts the first; a sixteenth is not drawn out
        (0.50, 0.62, 43, 0.7),  # a sixteenth
        (0.75, 0.76, 40, 0.9),  # a blip
        (1.00, 1.50, 20, 0.9),  # below a bass's range
    ]
    assert quantize.melody(GRID, events, instrument("bass"), 0, 64) == [
        (0, 2, [36]),
        (2, 1, [36]),
        (4, 1, [43]),
    ]


def test_two_notes_starting_together_keep_the_stronger():
    events = [(0.0, 0.5, 36, 0.4), (0.0, 0.5, 38, 0.9)]
    assert quantize.melody(GRID, events, instrument("bass"), 0, 16) == [(0, 4, [38])]


def test_an_overtone_of_a_sounding_note_is_not_a_note():
    # A C2 sprouts its twelfth, G3, a moment after it starts.
    events = [(0.0, 1.0, 36, 0.8), (0.3, 0.9, 55, 0.6), (1.0, 1.5, 55, 0.6)]
    assert quantize.melody(GRID, events, instrument("bass"), 0, 64) == [(0, 8, [36]), (8, 4, [55])]


def test_a_short_silence_after_a_note_is_its_release():
    events = [(0.0, 0.4, 36, 0.8), (0.5, 0.75, 38, 0.8), (1.5, 2.0, 41, 0.8)]
    assert quantize.melody(GRID, events, instrument("bass"), 0, 64) == [(0, 4, [36]), (4, 2, [38]), (12, 4, [41])]


def test_a_voice_joins_its_fragments_and_drops_what_is_far_from_its_line():
    events = [(0.0, 0.25, 62, 0.8), (0.375, 0.75, 62, 0.8), (0.75, 1.0, 64, 0.8), (1.0, 1.25, 40, 0.9)]
    assert quantize.melody(GRID, events, instrument("vocals"), 0, 64) == [(0, 6, [62]), (6, 2, [64])]


def test_notes_are_kept_between_start_and_end():
    events = [(-0.3, 0.2, 36, 0.8), (7.9, 9.0, 38, 0.8)]
    assert quantize.melody(GRID, events, instrument("bass"), -2, 64) == [(-2, 4, [36]), (63, 1, [38])]


def test_chords_are_a_draft_on_eighths_with_the_instruments_voices():
    events = [(0.0, 0.5, 60, 0.9), (0.02, 0.5, 64, 0.8), (0.01, 0.5, 67, 0.7), (0.26, 1.0, 72, 0.9)]
    guitar = quantize.chords(GRID, events, instrument("guitar"), 0, 64)
    assert guitar == [(0, 2, [60, 64, 67]), (2, 6, [72])]
    two = quantize.chords(GRID, events[:3], replace(instrument("other"), voices=2), 0, 64)
    assert two == [(0, 4, [60, 64])]
