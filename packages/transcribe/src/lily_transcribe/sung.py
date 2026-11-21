"""A voice's sung times from its vocals stem (DECISIONS D276).

Lily Studio's *From the singer* compares a voice of the score with the lead
vocals stem of its `% Audio:` recording, and *Keep the sung times* writes
what this finds as `% Audio sung` lines. The voice comes as `voice.json`,
which the studio's renderer writes:

    {"bpm": 113.76,
     "notes": [{"start": 30.657, "length": 0.527, "pitch": 59, "syllable": "We"}, …]}

`bpm` is the score's `% BPM:` in quarter notes a minute; each note, in the
order played (a chord's notes share a start), has its grid start and length in
seconds on the recording's timeline, its MIDI pitch, and the syllable that
starts on it, if one does, with the full stop that ends a phrase.

- **Words.** Each phrase is force-aligned in its own window, its first note
  − 0.6 s to its last note's end + 0.6 s, by MMS_FA with `<star>` between
  the syllables. Each syllable gets its first letter's onset (the consonant, when it
  is one), its vowel's onset, and a score: the mean of its letters' frame
  probabilities.
- **Pitch.** pYIN's f0 says whether each note is sung as written (its voiced
  frames' median within 75 cents, in the singer's octave), and where the
  voice crosses into a note's pitch on a leap of 2 semitones or more, or
  inside a melisma.
- **A note's arrival** is its syllable's vowel less MMS_FA's measured lag,
  or, inside a melisma, its pitch crossing; it is null unless the syllable is
  outside the song's least confident quarter.
- **A note moves** by its arrival's distance from the grid only when that is
  more than 50 ms and at most τ (a 16th at `bpm`), and, where a crossing
  also fires on a syllable's note, the two agree within 50 ms. Otherwise its
  shift is 0: the grid.
- **A phrase is not sung** when every syllable of it scores below FLOOR;
  its notes keep the grid and are not checked for pitch.
"""

from __future__ import annotations

import contextlib
import functools
import hashlib
import json
import math
import re
import sys
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol

import numpy as np

from . import audio

# MMS_FA's and pYIN's rate.
RATE = 16000
# pYIN's frames: 10 ms.
HOP = 160
FRAME = HOP / RATE
# Seconds of stem around a phrase's notes that its alignment sees.
PAD = 0.6
# Estimated delay of MMS_FA's sung vowel onsets on the reference recording.
LAG = 0.072
# The bar no method was shown to meet: a smaller move is not claimed, and a
# crossing must agree with the vowel within it.
BAR = 0.050
# A phrase whose syllables all score below this is not in the stem. The
# spike's intro, which the lead stem lacks, scored 0.001–0.007; the least
# sure phrase sung, 0.04 at its best syllable.
FLOOR = 0.02
# The share of the song's syllables, least confident first, that keep the grid.
DROP = 0.25
# A note is sung as written when its f0's median is this near, in semitones.
AS_WRITTEN = 0.75
# Too few voiced frames, or too small a share of the note, tell no pitch.
FEWEST_FRAMES = 5
FEWEST_SHARE = 0.3
# A stem voiced in less than this share of its frames has no voice in it.
FEWEST_VOICED = 0.01
# Pitch crossings: on a syllable's note, only on a leap this wide; within
# this long a rest of the note before; searched this far from the grid; held
# this long.
LEAP = 2
NO_REST = 0.02
SEARCH = 0.3
HOLD = 0.05
# Notes this close start together: a chord.
TOGETHER = 0.001
ENDINGS = (".", "!", "?", "…")
VOWELS = "aeiou"
# Bump when what is kept per stem changes.
CACHE_VERSION = 1


class Reporter(Protocol):
    def progress(self, stage: str) -> None: ...
    def warning(self, message: str) -> None: ...


@dataclass
class Note:
    start: float
    length: float
    pitch: int
    syllable: str | None = None


@dataclass
class Onset:
    """The notes that start together: one, or a chord's."""

    notes: list[int]
    start: float
    end: float
    pitches: list[int]
    syllable: str | None
    phrase: int | None = None


@dataclass
class Phrase:
    onsets: list[int] = field(default_factory=list)
    # The onsets with a syllable, in order.
    syllables: list[int] = field(default_factory=list)


@dataclass
class Span:
    """A token's first frame in the path, and the mean probability of its frames."""

    start: int
    score: float


@dataclass
class Syllable:
    start: float
    vowel: float
    consonant: float | None
    score: float


def read_voice(path: Path) -> tuple[float, list[Note]]:
    """`voice.json`'s tempo and notes, checked."""
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError) as error:
        raise ValueError(f"{path.name} could not be read: {error}") from None
    bpm = data.get("bpm") if isinstance(data, dict) else None
    raw = data.get("notes") if isinstance(data, dict) else None
    if not isinstance(bpm, (int, float)) or not bpm > 0:
        raise ValueError(f"{path.name} has no tempo: its bpm must be a number above 0.")
    if not isinstance(raw, list) or not raw:
        raise ValueError(f"{path.name} has no notes.")
    notes = []
    for number, item in enumerate(raw):
        try:
            note = Note(float(item["start"]), float(item["length"]), int(item["pitch"]), item.get("syllable"))
        except (KeyError, TypeError, ValueError):
            raise ValueError(f"Note {number} of {path.name} needs a start, a length and a pitch.") from None
        if not (math.isfinite(note.start) and math.isfinite(note.length) and note.length > 0):
            raise ValueError(f"Note {number} of {path.name} needs a finite start and a length above 0.")
        if note.syllable is not None and not isinstance(note.syllable, str):
            raise ValueError(f"Note {number} of {path.name} has a syllable that is not text.")
        if notes and note.start < notes[-1].start - TOGETHER:
            raise ValueError(f"The notes of {path.name} are not in the order played: note {number} starts before the one before it.")
        notes.append(note)
    if not any(note.syllable and note.syllable.strip() for note in notes):
        raise ValueError(f"{path.name} has no words to align.")
    return float(bpm), notes


def onsets_of(notes: list[Note]) -> list[Onset]:
    found: list[Onset] = []
    for index, note in enumerate(notes):
        if found and abs(note.start - found[-1].start) < TOGETHER:
            onset = found[-1]
            onset.notes.append(index)
            onset.pitches.append(note.pitch)
            onset.end = max(onset.end, note.start + note.length)
            onset.syllable = onset.syllable or note.syllable
        else:
            found.append(Onset([index], note.start, note.start + note.length, [note.pitch], note.syllable))
    return found


def phrases_of(onsets: list[Onset]) -> list[Phrase]:
    """The phrases, cut at the words' full stops. A melisma's notes are its
    syllable's phrase's; the notes before the first syllable are in none."""
    phrases: list[Phrase] = []
    ended = True
    for index, onset in enumerate(onsets):
        text = (onset.syllable or "").strip()
        if text and ended:
            phrases.append(Phrase())
        if phrases:
            onset.phrase = len(phrases) - 1
            phrases[-1].onsets.append(index)
            if text:
                phrases[-1].syllables.append(index)
                ended = text.endswith(ENDINGS)
    return phrases


def letters(text: str) -> str:
    """A syllable as MMS_FA reads it: lower-case Latin letters and apostrophes, accents taken off."""
    plain = unicodedata.normalize("NFKD", text.lower())
    return re.sub(r"[^a-z']", "", "".join(c for c in plain if not unicodedata.combining(c)))


@functools.cache
def labels() -> tuple[str, ...]:
    from torchaudio.pipelines import MMS_FA

    return tuple(MMS_FA.get_labels(star="*"))


@functools.cache
def _model():
    from torchaudio.pipelines import MMS_FA

    # The first run downloads the weights (1.18 GB); its progress is not an event.
    with contextlib.redirect_stdout(sys.stderr):
        return MMS_FA.get_model(with_star=True).eval()


def emission(samples: np.ndarray) -> np.ndarray:
    """MMS_FA's log-probabilities of its labels, a frame a row, for mono samples at RATE."""
    import torch

    with torch.inference_mode():
        frames, _ = _model()(torch.from_numpy(np.ascontiguousarray(samples, dtype=np.float32))[None])
        return torch.log_softmax(frames, -1)[0].numpy()


def viterbi(log_probs: np.ndarray, tokens: list[int], blank: int = 0) -> np.ndarray | None:
    """The most likely CTC path of `tokens` through the frames: a label a frame, or None when too few frames.

    torchaudio 2.11's `forced_align` returns worse paths than this one on
    simple cases (a token after another can lose its first frame to it), so
    the path is found here.
    """
    frames = len(log_probs)
    states = 2 * len(tokens) + 1
    labels_of = np.full(states, blank)
    labels_of[1::2] = tokens
    # A token may follow the one two states back, past a blank, unless it repeats it.
    skip = np.zeros(states, dtype=bool)
    skip[3::2] = np.asarray(tokens[1:]) != np.asarray(tokens[:-1])
    score = np.full(states, -np.inf)
    score[0] = log_probs[0, blank]
    score[1] = log_probs[0, tokens[0]]
    back = np.zeros((frames, states), dtype=np.int8)
    for t in range(1, frames):
        stay = score
        step = np.concatenate([[-np.inf], score[:-1]])
        jump = np.where(skip, np.concatenate([[-np.inf, -np.inf], score[:-2]]), -np.inf)
        moves = np.stack([stay, step, jump])
        back[t] = np.argmax(moves, axis=0)
        score = moves.max(axis=0) + log_probs[t, labels_of]
    # It ends on the last token or the blank after it.
    last = states - 1 if score[-1] >= score[-2] else states - 2
    if not np.isfinite(score[last]):
        return None
    path = np.empty(frames, dtype=np.int64)
    for t in range(frames - 1, -1, -1):
        path[t] = labels_of[last]
        last -= back[t, last]
    return path


def align(log_probs: np.ndarray, seconds: float, start: float, syllables: list[str]) -> list[Syllable | None]:
    """The syllables force-aligned to a window's emission, `<star>` between
    them: each one's times on the stem's timeline and its score, or None for
    one with no letters MMS_FA reads, or for all when the window is too short."""
    index = {label: number for number, label in enumerate(labels())}
    tokens: list[int] = []
    owners: list[int | None] = []
    spelled = [[c for c in letters(text) if c in index] for text in syllables]
    for number, chars in enumerate(spelled):
        if not chars:
            continue
        tokens.append(index["*"])
        owners.append(None)
        for c in chars:
            tokens.append(index[c])
            owners.append(number)
    found: list[Syllable | None] = [None] * len(syllables)
    if not tokens:
        return found
    tokens.append(index["*"])
    owners.append(None)
    path = viterbi(log_probs, tokens)
    if path is None:  # fewer frames than the letters need
        return found
    probabilities = np.exp(log_probs[np.arange(len(path)), path])
    # A token's frames, run by run: CTC puts a blank between a token and its repeat.
    edges = np.flatnonzero(np.diff(path, prepend=-1, append=-1))
    spans = [
        Span(int(first), float(np.mean(probabilities[first:end])))
        for first, end in zip(edges[:-1], edges[1:])
        if path[first] != 0
    ]
    if len(spans) != len(tokens):
        return found
    per_second = len(log_probs) / seconds
    for number, chars in enumerate(spelled):
        mine = [span for span, owner in zip(spans, owners) if owner == number]
        if not mine:
            continue
        # The vowel: the first a e i o u, else a y ("my"); "young"'s y is its consonant.
        vowel = next((span for c, span in zip(chars, mine) if c in VOWELS), None) or next(
            (span for c, span in zip(chars, mine) if c == "y"), mine[0]
        )
        onset = start + mine[0].start / per_second
        found[number] = Syllable(
            start=onset,
            vowel=start + vowel.start / per_second,
            consonant=onset if chars[0] not in VOWELS else None,
            score=float(np.mean([span.score for span in mine])),
        )
    return found


def pitch_track(samples: np.ndarray) -> np.ndarray:
    """pYIN's f0 of mono samples at RATE, in MIDI pitch, a frame each HOP; NaN where unvoiced."""
    import librosa

    f0, voiced, _ = librosa.pyin(samples, fmin=70, fmax=1000, sr=RATE, frame_length=1024, hop_length=HOP)
    return np.where(voiced & np.isfinite(f0) & (f0 > 0), 69 + 12 * np.log2(np.where(f0 > 0, f0, 1) / 440), np.nan)


def _smooth(midi: np.ndarray) -> np.ndarray:
    """A 3-frame median, NaN kept where unvoiced (pitch_changes.py's)."""
    filled = np.pad(np.nan_to_num(midi), 1, mode="edge")
    median = np.median(np.stack([filled[:-2], filled[1:-1], filled[2:]]), axis=0)
    return np.where(np.isfinite(midi), median, np.nan)


def crossing(midi: np.ndarray, before: float, pitch: float, grid: float) -> float | None:
    """Where the f0 crosses from `before` to `pitch` near `grid` and stays over for HOLD, in seconds."""
    first = max(0, int(math.floor((grid - SEARCH) / FRAME)))
    last = min(len(midi), int(math.ceil((grid + SEARCH) / FRAME)))
    segment = _smooth(midi)[first:last]
    middle = (before + pitch) / 2
    with np.errstate(invalid="ignore"):
        over = (segment > middle) if pitch > before else (segment < middle)
    over &= np.isfinite(segment)
    hold = max(1, math.ceil(HOLD / FRAME - 1e-6))
    for k in range(len(segment) - hold + 1):
        if over[k : k + hold].all():
            return (first + k) * FRAME
    return None


def sung_pitch(midi: np.ndarray, start: float, end: float) -> float | None:
    """The median f0 of a note's voiced frames, or None when too few are voiced to tell."""
    first = int(round((start + min(0.05, (end - start) / 4)) / FRAME))
    last = min(len(midi), int(round(end / FRAME)))
    frames = midi[max(0, first) : max(first, last)]
    voiced = frames[np.isfinite(frames)]
    if len(voiced) < FEWEST_FRAMES or len(voiced) < FEWEST_SHARE * len(frames):
        return None
    return float(np.median(voiced))


def _stem_key(stem: Path, *extra: str) -> str:
    info = stem.stat()
    digest = hashlib.sha256(f"sung v{CACHE_VERSION}\0{stem.resolve()}\0{info.st_size}\0{info.st_mtime_ns}".encode())
    for part in extra:
        digest.update(f"\0{part}".encode())
    return digest.hexdigest()[:32]


def _cached(path: Path, make: Callable[[], np.ndarray]) -> np.ndarray:
    with contextlib.suppress(OSError, ValueError):
        return np.load(path, allow_pickle=False)
    found = make()
    with contextlib.suppress(OSError):
        path.parent.mkdir(parents=True, exist_ok=True)
        np.save(path, found, allow_pickle=False)
    return found


def _round(value: float | None, places: int = 3) -> float | None:
    return None if value is None else round(value, places)


def sung(stem: Path, voice_json: Path, voice: str, cache: Path, out: Reporter) -> dict:
    """The `done` of `lily-transcribe sung`: per note its shift from the grid
    and what was heard, per phrase whether it is sung."""
    bpm, notes = read_voice(voice_json)
    tau = 15.0 / bpm
    onsets = onsets_of(notes)
    phrases = phrases_of(onsets)

    samples: np.ndarray | None = None

    def stem_samples() -> np.ndarray:
        nonlocal samples
        if samples is None:
            out.progress("decode")
            samples = audio.load(stem, RATE)
        return samples

    def track() -> np.ndarray:
        decoded = stem_samples()
        out.progress("pitch")
        return pitch_track(decoded).astype(np.float32)

    folder = cache / "sung"
    midi = _cached(folder / f"{_stem_key(stem, 'pyin')}.npy", track)
    voiced = float(np.mean(np.isfinite(midi))) if len(midi) else 0.0
    if voiced < FEWEST_VOICED:
        raise ValueError(f"There is no voice in {stem.name}: pYIN hears a pitch in {voiced:.0%} of it.")

    # Words, phrase by phrase.
    found: dict[int, Syllable] = {}
    unread = 0
    told = False
    for phrase in phrases:
        last = max(onsets[index].end for index in phrase.onsets)
        start = max(0.0, onsets[phrase.onsets[0]].start - PAD)
        end = last + PAD
        texts = [onsets[index].syllable or "" for index in phrase.syllables]
        if not any(letters(text) for text in texts):
            unread += len(texts)
            continue

        def window(start=start, end=end) -> np.ndarray:
            nonlocal told
            decoded = stem_samples()
            if not told:
                out.progress("words")
                told = True
            cut = decoded[int(start * RATE) : int(end * RATE)]
            # Past the stem's end the window is silence, so it is always as long as asked.
            return emission(np.pad(cut, (0, int(end * RATE) - int(start * RATE) - len(cut))))

        log_probs = _cached(folder / f"{_stem_key(stem, 'mms_fa', f'{start:.3f}', f'{end:.3f}')}.npy", window)
        seconds = (int(end * RATE) - int(start * RATE)) / RATE
        for index, syllable in zip(phrase.syllables, align(log_probs, seconds, start, texts)):
            if syllable is None:
                unread += 1
            else:
                found[index] = syllable
    if unread:
        out.warning(
            f"{unread} of {voice}'s syllables were not aligned: MMS_FA reads Latin letters only "
            "(Russian is not yet aligned), or a phrase was too short for its letters. Their notes keep the grid."
        )

    scores = [syllable.score for syllable in found.values()]
    cut = float(np.quantile(scores, DROP)) if scores else math.inf
    sung_phrases: list[bool | None] = []
    for phrase in phrases:
        mine = [found[index].score for index in phrase.syllables if index in found]
        sung_phrases.append(max(mine) >= FLOOR if mine else None)

    def in_sung(onset: Onset) -> bool:
        return onset.phrase is not None and sung_phrases[onset.phrase] is True

    # The singer's octave against the score, from the single notes sung.
    heard_at: dict[int, float | None] = {}
    differences = []
    for onset in onsets:
        if not in_sung(onset):
            continue
        for index in onset.notes:
            note = notes[index]
            heard_at[index] = sung_pitch(midi, note.start, note.start + note.length)
        if len(onset.notes) == 1 and heard_at[onset.notes[0]] is not None:
            differences.append(heard_at[onset.notes[0]] - onset.pitches[0])
    octave = 12 * round(float(np.median(differences)) / 12) if differences else 0

    result_notes: list[dict] = [{} for _ in notes]
    owner: int | None = None
    previous_sung = -math.inf
    for number, onset in enumerate(onsets):
        if onset.syllable and onset.syllable.strip():
            owner = number
        syllable = found.get(number)
        # The voice crosses into this note's pitch: on a leap from a single
        # note it follows without a rest, or on any step inside a melisma.
        cross = None
        before = onsets[number - 1] if number else None
        if (
            in_sung(onset)
            and before is not None
            and len(onset.pitches) == 1
            and len(before.pitches) == 1
            and onset.start - before.end <= NO_REST
        ):
            step = abs(onset.pitches[0] - before.pitches[0])
            if step >= (LEAP if onset.syllable else 1):
                cross = crossing(midi, before.pitches[0] + octave, onset.pitches[0] + octave, onset.start)
        arrival = None
        if in_sung(onset):
            if syllable is not None:
                if syllable.score >= cut:
                    arrival = syllable.vowel - LAG
            elif not onset.syllable and owner is not None and onset.phrase == onsets[owner].phrase:
                ruling = found.get(owner)
                if ruling is not None and ruling.score >= cut:
                    arrival = cross
        shift = 0
        if arrival is not None:
            distance = arrival - onset.start
            agrees = cross is None or syllable is None or abs(cross - arrival) <= BAR
            if BAR < abs(distance) <= tau and agrees and arrival > previous_sung:
                shift = round(distance * 1000)
        previous_sung = onset.start + shift / 1000
        for index in onset.notes:
            heard = heard_at.get(index)
            as_written = None
            if heard is not None:
                heard -= octave
                if abs(heard - notes[index].pitch) <= AS_WRITTEN:
                    as_written = True
                elif not any(abs(heard - pitch) <= AS_WRITTEN for pitch in onset.pitches):
                    as_written = False
                # Else another note of the chord is the one sung, and one f0 says nothing of this one.
            result_notes[index] = {
                "shift": shift,
                "arrival": _round(arrival),
                "consonant": _round(syllable.consonant) if syllable else None,
                "vowel": _round(syllable.vowel) if syllable else None,
                "score": _round(syllable.score) if syllable else None,
                "asWritten": as_written,
                "heard": None if heard is None else round(heard),
            }

    return {
        "voice": voice,
        "notes": result_notes,
        "phrases": [
            {
                "first": onsets[phrase.onsets[0]].notes[0],
                "last": onsets[phrase.onsets[-1]].notes[-1],
                "sung": sung_phrases[number],
            }
            for number, phrase in enumerate(phrases)
        ],
        "lag": LAG,
        "tau": round(tau, 3),
        "octave": octave,
    }
