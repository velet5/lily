"""What each of karaoke-mlx's stems is, for transcribing it.

Its range drops what the instrument cannot sound, such as the kick drum's
thud under a separated bass. Its family says how it is quantized: one note
at a time on sixteenths, chords on eighths as a draft, or drum hits.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Family = Literal["melody", "chords", "drums"]


@dataclass(frozen=True)
class Instrument:
    family: Family
    # The sounding range, as MIDI note numbers.
    low: int = 0
    high: int = 127
    # Notes that may sound at once.
    voices: int = 1
    # Same-pitch fragments this close, in sixteenths, are one note (a voice's vibrato splits them).
    join: int = 0
    # A silence this short, in sixteenths, after a note is its release, not a rest.
    legato: int = 1
    # Semitones a note may be from the line's middle pitch; a voice's stem keeps
    # bleed and breath far below it. None keeps the whole range.
    spread: int | None = None
    # Basic Pitch's thresholds: a lower frame threshold holds a sung note longer.
    onset: float = 0.5
    frame: float = 0.3


INSTRUMENTS: dict[str, Instrument] = {
    # Bass guitar, B0 (five strings) to G4.
    "bass": Instrument("melody", 23, 67),
    # Lead vocals, C2 to C6.
    "vocals": Instrument("melody", 36, 84, join=1, legato=2, spread=12, onset=0.6, frame=0.2),
    "drums": Instrument("drums"),
    "guitar": Instrument("chords", 40, 88, voices=6),
    "piano": Instrument("chords", 21, 108, voices=8),
    "other": Instrument("chords", 28, 100, voices=4),
    "instrumental": Instrument("chords", 28, 100, voices=6),
}

# A stem karaoke-mlx adds later is written as chords, as the hard ones are.
DEFAULT = Instrument("chords", 21, 108, voices=6)


def instrument(name: str) -> Instrument:
    return INSTRUMENTS.get(name, DEFAULT)
