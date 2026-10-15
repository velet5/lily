"""The key from the notes heard."""

from lily_transcribe import key

C_MINOR = [0, 2, 3, 5, 7, 8, 10]
C_MAJOR = [0, 2, 4, 5, 7, 9, 11]


def notes(pitches, tonic_weight=3.0):
    return [(0.0, tonic_weight if pitch % 12 == pitches[0] % 12 else 1.0, 48 + pitch, 1.0) for pitch in pitches]


def test_a_minor_song_is_minor_though_its_tonic_and_dominant_lead():
    tonic, mode, fit = key.detect(notes(C_MINOR))
    assert (tonic, mode) == (0, "minor")
    assert fit > 0.7


def test_major_and_transposed():
    assert key.detect(notes(C_MAJOR))[:2] == (0, "major")
    assert key.detect(notes([pitch + 7 for pitch in C_MAJOR]))[:2] == (7, "major")
    assert key.detect(notes([pitch + 9 for pitch in C_MINOR]))[:2] == (9, "minor")


def test_no_notes_is_c_major():
    assert key.detect([]) == (0, "major", 0.0)
