"""A voice's sung times (DECISIONS D276), with stand-ins for MMS_FA and pYIN.

The stand-in stem is a ramp, each sample its own index, so the stand-in
MMS_FA knows where in the song each phrase's window starts. It hears each
letter of a sung syllable for two of its 20 ms frames, from the syllable's
consonant on. The stand-in pYIN hears what the test says was sung.
"""

import itertools
import json

import numpy as np
import pytest

from lily_transcribe import audio, sung

STEM_SECONDS = 9.0
FRAMES_PER_SECOND = 50
SAMPLES_PER_FRAME = sung.RATE // FRAMES_PER_SECOND

# bpm 120: τ, a 16th, is 125 ms.
VOICE = {
    "bpm": 120,
    "notes": [
        # 0: the intro, which the stem does not sing.
        {"start": 1.0, "length": 0.5, "pitch": 60, "syllable": "Oh."},
        # 1–6: on time; 108 ms late; 208 ms late (more than τ); 52 ms early but
        # its pitch crossing 152 ms later; a melisma's note 70 ms late; on time.
        {"start": 4.0, "length": 0.5, "pitch": 60, "syllable": "la"},
        {"start": 4.5, "length": 0.5, "pitch": 62, "syllable": "lo"},
        {"start": 5.0, "length": 0.5, "pitch": 64, "syllable": "li"},
        {"start": 5.5, "length": 0.25, "pitch": 66, "syllable": "lu"},
        {"start": 5.75, "length": 0.25, "pitch": 67},
        {"start": 6.0, "length": 0.5, "pitch": 67, "syllable": "le."},
        # 7–8: sung a whole tone high; 88 ms late, but too weakly heard to move.
        {"start": 7.0, "length": 0.5, "pitch": 60, "syllable": "oh"},
        {"start": 7.5, "length": 0.5, "pitch": 59, "syllable": "no."},
    ],
}

# (time, letter, probability): each letter for two frames.
HEARD_WORDS = [
    (4.04, "l", 1.0), (4.08, "a", 1.0),
    (4.64, "l", 1.0), (4.68, "o", 1.0),
    (5.24, "l", 1.0), (5.28, "i", 1.0),
    (5.48, "l", 1.0), (5.52, "u", 1.0),
    (6.04, "l", 1.0), (6.08, "e", 1.0),
    (7.08, "o", 1.0), (7.12, "h", 1.0),
    (7.62, "n", 0.3), (7.66, "o", 0.3),
]

# (from, to, MIDI pitch): the singer an octave above the score.
HEARD_PITCH = [
    (3.9, 4.61, 72),
    (4.61, 5.21, 74),
    (5.21, 5.60, 76),
    (5.60, 5.82, 78),
    (5.82, 6.5, 79),
    (6.9, 7.5, 74),
    (7.5, 8.0, 71),
]


def stand_in_emission(heard=HEARD_WORDS):
    labels = sung.labels()

    def emission(samples):
        start = samples[0] / sung.RATE
        frames = len(samples) // SAMPLES_PER_FRAME
        probs = np.full((frames, len(labels)), 1e-4)
        # Blank, and the <star> that takes what is not a syllable's.
        probs[:, 0] = 1.0
        probs[:, labels.index("*")] = 0.1
        for time, letter, probability in heard:
            k = round((time - start) * FRAMES_PER_SECOND)
            if 0 <= k and k + 2 <= frames:
                probs[k : k + 2, 0] = max(1.0 - probability, 1e-4)
                probs[k : k + 2, labels.index("*")] = 1e-4
                probs[k : k + 2, labels.index(letter)] = probability
        probs /= probs.sum(axis=1, keepdims=True)
        return np.log(probs).astype(np.float32)

    return emission


def stand_in_pitch(heard=HEARD_PITCH):
    def pitch_track(samples):
        times = np.arange(len(samples) // sung.HOP + 1) * sung.FRAME
        midi = np.full(len(times), np.nan)
        for start, end, pitch in heard:
            midi[(times >= start - 1e-9) & (times < end - 1e-9)] = pitch
        return midi

    return pitch_track


def make_singer(tmp_path, monkeypatch, voice=VOICE, words=HEARD_WORDS, pitch=HEARD_PITCH):
    """The stem and voice.json, the cache beside them, the models replaced; counts their runs."""
    monkeypatch.setenv("LILY_TRANSCRIBE_HOME", str(tmp_path / "cache"))
    stem = tmp_path / "song - vocals.wav"
    stem.write_bytes(b"a stand-in stem")
    notes = tmp_path / "voice.json"
    notes.write_text(json.dumps(voice))
    calls = {"load": 0, "words": 0, "pitch": 0}
    ramp = np.arange(int(STEM_SECONDS * sung.RATE), dtype=np.float32)
    emission, pitch_track = stand_in_emission(words), stand_in_pitch(pitch)

    def load(path, sample_rate):
        assert sample_rate == sung.RATE
        calls["load"] += 1
        return ramp

    def counted_emission(samples):
        calls["words"] += 1
        return emission(samples)

    def counted_pitch(samples):
        calls["pitch"] += 1
        return pitch_track(samples)

    monkeypatch.setattr(audio, "load", load)
    monkeypatch.setattr(sung, "emission", counted_emission)
    monkeypatch.setattr(sung, "pitch_track", counted_pitch)
    return stem, notes, calls


class Heard:
    def __init__(self):
        self.stages, self.warnings = [], []

    def progress(self, stage):
        self.stages.append(stage)

    def warning(self, message):
        self.warnings.append(message)


def run(tmp_path, stem, notes, voice="lead"):
    heard = Heard()
    return sung.sung(stem, notes, voice, tmp_path / "cache", heard), heard


def test_each_note_moves_only_on_confident_evidence_within_a_16th(tmp_path, monkeypatch):
    stem, notes, _ = make_singer(tmp_path, monkeypatch)
    result, heard = run(tmp_path, stem, notes)
    assert heard.stages == ["decode", "pitch", "words"]
    assert heard.warnings == []
    assert result["voice"] == "lead"
    assert result["lag"] == sung.LAG
    assert result["tau"] == 0.125
    assert result["octave"] == 12
    shifts = [note["shift"] for note in result["notes"]]
    # The intro is not sung; la is 8 ms from the grid, less than the 50 ms
    # claimed; lo is 108 ms late, its crossing agreeing; li is further than τ;
    # lu's crossing disagrees; the melisma's note arrives at its crossing;
    # no. is in the song's least confident quarter.
    assert shifts[0] == 0
    assert shifts[1] == 0
    assert shifts[2] == pytest.approx(108, abs=1)
    assert shifts[3] == 0
    assert shifts[4] == 0
    assert shifts[5] == pytest.approx(70, abs=1)
    assert shifts[6:] == [0, 0, 0]


def test_an_arrival_is_the_vowel_less_the_lag_or_a_melismas_crossing(tmp_path, monkeypatch):
    stem, notes, _ = make_singer(tmp_path, monkeypatch)
    result, _ = run(tmp_path, stem, notes)
    found = result["notes"]
    assert found[1]["consonant"] == pytest.approx(4.04, abs=0.002)
    assert found[1]["vowel"] == pytest.approx(4.08, abs=0.002)
    assert found[1]["arrival"] == pytest.approx(4.08 - sung.LAG, abs=0.002)
    # Further from the grid than τ: kept to show, not to move.
    assert found[3]["arrival"] == pytest.approx(5.208, abs=0.002)
    assert found[5]["arrival"] == pytest.approx(5.82, abs=0.002)
    assert found[5]["consonant"] is None and found[5]["vowel"] is None and found[5]["score"] is None
    # A syllable that starts on its vowel has no consonant.
    assert found[7]["consonant"] is None
    assert found[7]["vowel"] == pytest.approx(7.08, abs=0.002)
    # Too weakly heard to say when it arrives, though its times are given.
    assert found[8]["arrival"] is None
    assert found[8]["vowel"] == pytest.approx(7.66, abs=0.002)
    assert found[8]["score"] < found[7]["score"]
    # The intro is aligned somewhere, with a score of nothing.
    assert found[0]["arrival"] is None
    assert found[0]["score"] < sung.FLOOR


def test_a_phrase_the_stem_does_not_sing_is_flagged_and_keeps_the_grid(tmp_path, monkeypatch):
    stem, notes, _ = make_singer(tmp_path, monkeypatch)
    result, _ = run(tmp_path, stem, notes)
    assert result["phrases"] == [
        {"first": 0, "last": 0, "sung": False},
        {"first": 1, "last": 6, "sung": True},
        {"first": 7, "last": 8, "sung": True},
    ]
    assert result["notes"][0]["asWritten"] is None
    assert result["notes"][0]["heard"] is None


def test_a_pitch_is_checked_in_the_singers_octave(tmp_path, monkeypatch):
    stem, notes, _ = make_singer(tmp_path, monkeypatch)
    result, _ = run(tmp_path, stem, notes)
    found = result["notes"]
    assert [note["asWritten"] for note in found[1:]] == [True, True, True, True, True, True, False, True]
    assert [note["heard"] for note in found[1:]] == [60, 62, 64, 66, 67, 67, 62, 59]


# Two more phrases for every short song: one weakly heard and one not
# sung, so that the song's least confident quarter is theirs.
QUIET = (
    [{"start": 6.0, "length": 0.5, "pitch": 60, "syllable": "le."}, {"start": 7.0, "length": 0.5, "pitch": 60, "syllable": "li."}],
    [(6.04, "l", 0.3), (6.08, "e", 0.3)],
)


def test_a_note_never_moves_to_or_before_the_one_before_it(tmp_path, monkeypatch):
    voice = {
        "bpm": 60,  # τ is 250 ms
        "notes": [
            {"start": 4.0, "length": 0.2, "pitch": 60, "syllable": "la"},
            {"start": 4.2, "length": 0.3, "pitch": 60, "syllable": "lo."},
            *QUIET[0],
        ],
    }
    # la is sung 352 ms early, more than τ, so it keeps the grid; lo 212 ms
    # early, within τ, but that is before la's grid time.
    words = [(3.68, "l", 1.0), (3.72, "a", 1.0), (4.02, "l", 1.0), (4.06, "o", 1.0), *QUIET[1]]
    stem, notes, _ = make_singer(tmp_path, monkeypatch, voice, words, [(3.5, 7.6, 60)])
    result, _ = run(tmp_path, stem, notes)
    la, lo = result["notes"][:2]
    assert la["arrival"] == pytest.approx(3.648, abs=0.002)
    assert lo["arrival"] == pytest.approx(3.988, abs=0.002)
    assert la["shift"] == lo["shift"] == 0


def test_a_chords_notes_move_together_and_only_the_one_sung_is_judged(tmp_path, monkeypatch):
    voice = {
        "bpm": 120,
        "notes": [
            {"start": 4.0, "length": 0.5, "pitch": 60, "syllable": "la"},
            {"start": 4.5, "length": 0.5, "pitch": 62, "syllable": "lo."},
            {"start": 4.5, "length": 0.5, "pitch": 66},
            *QUIET[0],
        ],
    }
    words = [(4.04, "l", 1.0), (4.08, "a", 1.0), (4.64, "l", 1.0), (4.68, "o", 1.0), *QUIET[1]]
    stem, notes, _ = make_singer(tmp_path, monkeypatch, voice, words, [(3.9, 4.61, 60), (4.61, 5.0, 62), (5.9, 7.5, 60)])
    result, _ = run(tmp_path, stem, notes)
    found = result["notes"]
    assert found[1]["shift"] == found[2]["shift"] == pytest.approx(108, abs=1)
    assert found[1]["asWritten"] is True
    assert found[2]["asWritten"] is None
    assert result["phrases"][0] == {"first": 0, "last": 2, "sung": True}


def test_words_without_latin_letters_keep_the_grid_and_say_so(tmp_path, monkeypatch):
    voice = {
        "bpm": 120,
        "notes": [
            {"start": 4.0, "length": 0.5, "pitch": 60, "syllable": "Смерть."},
            {"start": 6.0, "length": 0.5, "pitch": 60, "syllable": "le."},
        ],
    }
    stem, notes, _ = make_singer(tmp_path, monkeypatch, voice, [(6.04, "l", 1.0), (6.08, "e", 1.0)], [(3.9, 6.6, 60)])
    result, heard = run(tmp_path, stem, notes)
    assert result["phrases"][0]["sung"] is None
    assert result["notes"][0]["shift"] == 0
    assert result["notes"][0]["asWritten"] is None
    assert heard.warnings == [
        "1 of lead's syllables were not aligned: MMS_FA reads Latin letters only (Russian is not yet aligned), "
        "or a phrase was too short for its letters. Their notes keep the grid."
    ]


def test_a_stem_with_no_voice_is_an_error(tmp_path, monkeypatch):
    stem, notes, _ = make_singer(tmp_path, monkeypatch, pitch=[])
    with pytest.raises(ValueError, match="There is no voice in song - vocals.wav"):
        run(tmp_path, stem, notes)


def test_the_stems_pitch_and_each_windows_emission_are_kept(tmp_path, monkeypatch):
    stem, notes, calls = make_singer(tmp_path, monkeypatch)
    first, _ = run(tmp_path, stem, notes)
    assert calls == {"load": 1, "words": 3, "pitch": 1}
    again, heard = run(tmp_path, stem, notes)
    assert heard.stages == []
    assert calls == {"load": 1, "words": 3, "pitch": 1}
    assert again == first
    # A phrase moved is a new window; the others are kept.
    moved = json.loads(notes.read_text())
    moved["notes"][0]["start"] = 1.5
    notes.write_text(json.dumps(moved))
    run(tmp_path, stem, notes)
    assert calls == {"load": 2, "words": 4, "pitch": 1}


# ---- the parts ----


@pytest.mark.parametrize(
    "voice, message",
    [
        ({"notes": [{"start": 0, "length": 1, "pitch": 60, "syllable": "la"}]}, "has no tempo"),
        ({"bpm": 120, "notes": []}, "has no notes"),
        ({"bpm": 120, "notes": [{"start": 0, "pitch": 60}]}, "Note 0 of voice.json needs a start, a length and a pitch"),
        ({"bpm": 120, "notes": [{"start": 0, "length": 0, "pitch": 60}]}, "a length above 0"),
        (
            {"bpm": 120, "notes": [{"start": 1, "length": 1, "pitch": 60}, {"start": 0, "length": 1, "pitch": 60}]},
            "not in the order played",
        ),
        ({"bpm": 120, "notes": [{"start": 0, "length": 1, "pitch": 60}]}, "has no words to align"),
    ],
)
def test_a_voice_that_cannot_be_read_says_why(tmp_path, voice, message):
    path = tmp_path / "voice.json"
    path.write_text(json.dumps(voice))
    with pytest.raises(ValueError, match=message):
        sung.read_voice(path)


def test_phrases_end_at_full_stops_and_hold_their_melismas():
    notes = [
        sung.Note(0.0, 0.5, 55),
        sung.Note(1.0, 0.5, 60, "Oh"),
        sung.Note(1.5, 0.5, 62),
        sung.Note(1.5, 0.5, 65),
        sung.Note(2.0, 0.5, 64, "yeah!"),
        sung.Note(2.5, 0.5, 62),
        sung.Note(3.0, 0.5, 60, "So"),
    ]
    onsets = sung.onsets_of(notes)
    assert [onset.notes for onset in onsets] == [[0], [1], [2, 3], [4], [5], [6]]
    phrases = sung.phrases_of(onsets)
    assert [phrase.onsets for phrase in phrases] == [[1, 2, 3, 4], [5]]
    assert [phrase.syllables for phrase in phrases] == [[1, 3], [5]]
    assert onsets[0].phrase is None


def test_letters_are_what_mms_fa_reads():
    assert sung.letters("Ba-") == "ba"
    assert sung.letters("we've") == "we've"
    assert sung.letters("Naïve,") == "naive"
    assert sung.letters("Смерть") == ""


def emission_of(heard, seconds):
    frames = int(seconds * FRAMES_PER_SECOND)
    return stand_in_emission(heard)(np.arange(frames * SAMPLES_PER_FRAME, dtype=np.float32)), frames / FRAMES_PER_SECOND


def test_a_syllables_consonant_and_vowel_are_its_letters():
    heard = [(0.2, "y", 1.0), (0.24, "o", 1.0), (0.28, "u", 1.0), (0.6, "m", 1.0), (0.64, "y", 1.0), (1.0, "a", 1.0), (1.04, "n", 1.0)]
    log_probs, seconds = emission_of(heard, 2.0)
    found = sung.align(log_probs, seconds, 10.0, ["you", "my", "an", "—"])
    you, my, an, dash = found
    assert (you.consonant, you.vowel) == (pytest.approx(10.2), pytest.approx(10.24))
    assert (my.consonant, my.vowel) == (pytest.approx(10.6), pytest.approx(10.64))
    assert an.consonant is None and an.vowel == pytest.approx(11.0)
    assert you.score > 0.9
    assert dash is None


def collapse(path):
    """A CTC path's tokens: runs merged, blanks dropped."""
    return [int(label) for k, label in enumerate(path) if label != 0 and (k == 0 or path[k - 1] != label)]


def best_by_brute_force(log_probs, tokens):
    best = -np.inf
    for path in itertools.product(range(log_probs.shape[1]), repeat=len(log_probs)):
        if collapse(path) == tokens:
            best = max(best, float(log_probs[np.arange(len(path)), path].sum()))
    return best


@pytest.mark.parametrize("tokens", [[1, 2, 1], [3, 2, 3], [1, 2, 3], [2, 2], [1]])
def test_the_path_is_the_most_likely(tokens):
    # torchaudio 2.11's forced_align gives [3, 2, 3] here a path 7 nats worse than this one.
    probs = np.array([[0.9, 0.0001, 0.0001, 0.09]] * 2 + [[0.0001, 0.0001, 0.997, 0.0001]] * 2 + [[0.9, 0.09, 0.0001, 0.01]] * 2)
    log_probs = np.log(probs / probs.sum(axis=1, keepdims=True))
    path = sung.viterbi(log_probs, tokens)
    assert collapse(path) == tokens
    assert log_probs[np.arange(len(path)), path].sum() == pytest.approx(best_by_brute_force(log_probs, tokens))


def test_a_path_needs_a_frame_a_token_and_one_between_repeats():
    log_probs = np.log(np.full((3, 3), 1 / 3))
    assert sung.viterbi(log_probs, [1, 2, 1]) is not None
    assert sung.viterbi(log_probs, [1, 1, 2]) is None
    assert sung.viterbi(log_probs, [1, 2, 1, 2]) is None


def test_a_window_too_short_for_its_letters_aligns_nothing():
    log_probs, seconds = emission_of([], 0.1)
    assert sung.align(log_probs, seconds, 0.0, ["extraordinary", "la"]) == [None, None]


def test_a_crossing_is_where_the_voice_holds_the_new_pitch():
    midi = np.full(200, 60.0)
    midi[100:] = 64
    midi[96:98] = 64  # a slide that does not hold
    assert sung.crossing(midi, 60, 64, 1.05) == pytest.approx(1.0)
    # Falling, the slide now after the crossing, which it holds only from 1.04 s.
    assert sung.crossing(midi[::-1].copy(), 64, 60, 1.0) == pytest.approx(1.04)
    assert sung.crossing(np.full(200, 60.0), 60, 64, 1.0) is None


def test_a_pitch_needs_enough_voiced_frames():
    midi = np.full(100, np.nan)
    midi[20:23] = 60
    assert sung.sung_pitch(midi, 0.15, 0.5) is None
    midi[20:40] = 60.4
    assert sung.sung_pitch(midi, 0.15, 0.5) == pytest.approx(60.4)


def test_pyin_hears_a_sung_pitch():
    tone = np.sin(2 * np.pi * 220.0 * np.arange(sung.RATE) / sung.RATE).astype(np.float32) * 0.5
    midi = sung.pitch_track(tone)
    assert np.nanmedian(midi) == pytest.approx(57.0, abs=0.1)
    assert np.mean(np.isfinite(midi)) > 0.8
