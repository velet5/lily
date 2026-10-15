"""Notes in seconds to notes on the grid.

A note is `(at, length, pitches)`: where it starts and how long it lasts, in
sixteenths from bar 1, and the MIDI pitches sounding, one for a melody and
several for a chord. Basic Pitch's notes come in as `(start, end, pitch,
amplitude)` in seconds.
"""

from __future__ import annotations

from collections.abc import Iterable

from .grid import Grid
from .instruments import Instrument

Note = tuple[int, int, list[int]]
Event = tuple[float, float, int, float]

# A note shorter than this share of the grid's step is a blip, not a note.
BLIP = 0.6
# Semitones from a note to its 2nd, 3rd, 4th, 5th and 6th harmonics.
OVERTONES = {12, 19, 24, 28, 31}
# An overtone starts with its note or after it, up to this many seconds early,
# and is not this much louder than it.
OVERTONE_LEAD = 0.05
OVERTONE_LOUDER = 1.2


def _snap(grid: Grid, events: Iterable[Event], instrument: Instrument, step: int, start: int, end: int) -> list[list]:
    """Events in range, snapped to `step` sixteenths, between `start` and `end`: [at, until, pitch, weight]."""
    snapped = []
    for begin, finish, pitch, amplitude in events:
        if not instrument.low <= pitch <= instrument.high:
            continue
        a, b = grid.position(begin) / step, grid.position(finish) / step
        at, until = round(a) * step, round(b) * step
        if until <= at:
            if b - a < BLIP:
                continue
            until = at + step
        at, until = max(at, start), min(until, end)
        if until > at:
            snapped.append([at, until, int(pitch), float(amplitude) * (b - a)])
    snapped.sort(key=lambda note: (note[0], -note[3]))
    return snapped


def without_overtones(events: Iterable[Event]) -> list[Event]:
    """The notes that are not an overtone of a lower one sounding as they start.

    A low note's harmonics (an octave, a twelfth, two octaves… above it) are
    heard as notes of their own, and in one line they would cut it short: a
    separated bass's C2 sprouts a G3 a moment after it starts.
    """
    events = sorted(events)
    kept = []
    for note in events:
        start, _, pitch, amplitude = note
        under = (
            other
            for other in events
            if other is not note
            and other[0] - OVERTONE_LEAD <= start < other[1] - OVERTONE_LEAD
            and pitch - other[2] in OVERTONES
            and amplitude < OVERTONE_LOUDER * other[3]
        )
        if next(under, None) is None:
            kept.append(note)
    return kept


def within_spread(events: list[Event], spread: int | None) -> list[Event]:
    """The notes within `spread` semitones of the line's middle pitch, weighted by length and loudness."""
    if spread is None or not events:
        return events
    weighted = sorted((pitch, (end - start) * amplitude) for start, end, pitch, amplitude in events)
    total = sum(weight for _, weight in weighted)
    running = 0.0
    middle = weighted[-1][0]
    for pitch, weight in weighted:
        running += weight
        if running >= total / 2:
            middle = pitch
            break
    return [event for event in events if abs(event[2] - middle) <= spread]


def melody(grid: Grid, events: Iterable[Event], instrument: Instrument, start: int, end: int) -> list[Note]:
    """One note at a time on sixteenths: of two at once, the stronger, and a note ends where the next begins."""
    line: list[list] = []
    heard = within_spread(without_overtones(events), instrument.spread)
    # Sorted by onset, the stronger first: of two starting together, the first stays.
    for note in _snap(grid, heard, instrument, 1, start, end):
        if line and note[0] == line[-1][0]:
            continue
        if line and line[-1][1] > note[0]:
            line[-1][1] = note[0]
        line.append(note)
    # A short silence after a note of an eighth or more is its release, not a rest to write.
    for note, after in zip(line, line[1:]):
        if after[0] - note[1] <= instrument.legato and note[1] - note[0] >= 2:
            note[1] = after[0]
    if instrument.join:
        joined: list[list] = []
        for note in line:
            last = joined[-1] if joined else None
            if last and last[2] == note[2] and note[0] - last[1] <= instrument.join:
                last[1] = note[1]
            else:
                joined.append(note)
        line = joined
    return [(at, until - at, [pitch]) for at, until, pitch, _ in line]


def chords(grid: Grid, events: Iterable[Event], instrument: Instrument, start: int, end: int) -> list[Note]:
    """A rough draft on eighths: the notes starting together are a chord, which lasts until the next."""
    groups: dict[int, list[list]] = {}
    for note in _snap(grid, events, instrument, 2, start, end):
        groups.setdefault(note[0], []).append(note)
    onsets = sorted(groups)
    result: list[Note] = []
    for index, at in enumerate(onsets):
        notes = sorted(groups[at], key=lambda note: -note[3])[: instrument.voices]
        until = max(note[1] for note in notes)
        if index + 1 < len(onsets):
            until = min(until, onsets[index + 1])
        result.append((at, until - at, sorted({note[2] for note in notes})))
    return result
