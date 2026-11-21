"""The command line's JSON events, with stand-ins for the two models."""

import json
import subprocess
from pathlib import Path

import numpy as np
import pytest

from lily_transcribe import audio, cli, lyrics


@pytest.fixture
def folder(tmp_path, monkeypatch):
    """A separated song's folder: its stems, the cache beside it, and the models replaced."""
    monkeypatch.setenv("LILY_TRANSCRIBE_HOME", str(tmp_path / "cache"))
    stems = tmp_path / "song (stems)"
    stems.mkdir()
    rate = cli.SAMPLE_RATE
    tone = np.sin(2 * np.pi * 65.4 * np.arange(rate * 8) / rate).astype(np.float32) * 0.3
    for name in ("bass", "drums", "vocals"):
        audio.save_wav(stems / f"song - {name}.wav", tone, rate)
    (stems / "song - mix.wav").write_bytes((stems / "song - bass.wav").read_bytes())
    calls = {"beats": 0}

    def beats(samples, sample_rate):
        calls["beats"] += 1
        calls["seconds"] = len(samples) / sample_rate
        times = 0.25 + np.arange(16) * 0.5
        return times, times[::4]

    def notes(samples, low=21, high=108, onset=0.5, frame=0.3):
        return [(0.25, 0.75, 36, 0.8, 0.0), (0.75, 1.25, 43, 0.8, 0.0), (1.25, 2.25, 39, 0.8, 0.0)]

    def words(stem):
        calls["words"] = calls.get("words", 0) + 1
        return [lyrics.Word("la", 0.25, 0.5), lyrics.Word("lantern", 0.75, 1.5)], "en"

    monkeypatch.setattr(cli, "track_beats", beats)
    monkeypatch.setattr(cli, "notes_of", notes)
    monkeypatch.setattr(lyrics, "hear", words)
    return stems, calls


def run(capsys, *args):
    with pytest.raises(SystemExit) if "--fail" in args else _nothing():
        cli.main(["--json", *[arg for arg in args if arg != "--fail"]])
    return [json.loads(line) for line in capsys.readouterr().out.splitlines()]


class _nothing:
    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False


def test_a_stem_is_transcribed_on_the_songs_grid(folder, capsys):
    stems, calls = folder
    events = run(capsys, "transcribe", str(stems / "song - bass.wav"), "--instrument", "bass")
    assert [event["event"] for event in events] == ["progress"] * 4 + ["done"]
    assert [event.get("stage") for event in events[:4]] == ["decode", "beats", "key", "notes"]
    done = events[-1]["transcription"]
    assert done["stem"] == "bass"
    assert done["family"] == "melody"
    assert done["bpm"] == 120.0
    assert done["beatsPerBar"] == 4
    assert done["barOne"] == pytest.approx(0.25)
    assert done["pickup"] == 2
    assert done["bars"] == 4
    assert done["barTimes"] == [0.25, 2.25, 4.25, 6.25, 8.25]
    assert done["notes"] == [[0, 4, [36]], [4, 4, [43]], [8, 8, [39]]]
    # The beats come from the bass, drums and vocals mixed, not the mix exported beside them.
    assert calls["seconds"] == pytest.approx(8.0, abs=0.01)


def test_the_songs_beats_and_key_are_kept_for_its_other_stems(folder, capsys):
    stems, calls = folder
    run(capsys, "transcribe", str(stems / "song - bass.wav"), "--instrument", "bass")
    events = run(capsys, "transcribe", str(stems / "song - vocals.wav"), "--instrument", "vocals")
    assert calls["beats"] == 1
    assert [event.get("stage") for event in events[:-1]] == ["notes", "words"]


def test_vocals_have_their_words_laid_on_their_notes(folder, capsys):
    stems, calls = folder
    events = run(capsys, "transcribe", str(stems / "song - vocals.wav"), "--instrument", "vocals")
    done = events[-1]["transcription"]
    assert done["notes"] == [[0, 4, [36]], [4, 4, [43]], [8, 8, [39]]]
    # A syllable a note, from bar 1 at 0.25 s: la, lan-, tern.
    assert done["words"] == [[0, "la", False], [4, "lan", True], [8, "tern", False]]
    assert done["language"] == "en"
    assert not [event for event in events if event["event"] == "warning"]
    # The bass has none, and no Whisper is run for it.
    run(capsys, "transcribe", str(stems / "song - bass.wav"), "--instrument", "bass")
    assert calls["words"] == 1


@pytest.mark.parametrize("step", ["hear", "syllables", "align"])
def test_the_notes_outlive_a_failure_in_the_words(folder, capsys, monkeypatch, step):
    stems, _ = folder

    def fail(*_):
        raise RuntimeError("no words today")

    monkeypatch.setattr(lyrics, step, fail)
    events = run(capsys, "transcribe", str(stems / "song - vocals.wav"), "--instrument", "vocals")
    assert events[-1]["event"] == "done"
    done = events[-1]["transcription"]
    assert done["notes"] == [[0, 4, [36]], [4, 4, [43]], [8, 8, [39]]]
    assert "words" not in done
    assert "language" not in done
    # Said before the end, so a failure does not pass for a song with no vocals.
    assert events[-2] == {"event": "warning", "message": "The words could not be made: no words today"}


def test_a_failure_without_a_message_still_says_what_failed(folder, capsys, monkeypatch):
    stems, _ = folder

    def fail(_):
        raise ConnectionError

    monkeypatch.setattr(lyrics, "hear", fail)
    events = run(capsys, "transcribe", str(stems / "song - vocals.wav"), "--instrument", "vocals")
    assert events[-2] == {"event": "warning", "message": "The words could not be made: ConnectionError"}


def test_a_song_with_nothing_sung_is_no_failure(folder, capsys, monkeypatch):
    stems, _ = folder
    monkeypatch.setattr(lyrics, "hear", lambda _: ([], "en"))
    events = run(capsys, "transcribe", str(stems / "song - vocals.wav"), "--instrument", "vocals")
    assert events[-1]["event"] == "done"
    assert not [event for event in events if event["event"] == "warning"]


def test_a_warning_goes_to_stderr_without_json(folder, capsys, monkeypatch):
    stems, _ = folder

    def fail(_):
        raise RuntimeError("no words today")

    monkeypatch.setattr(lyrics, "hear", fail)
    cli.main(["transcribe", str(stems / "song - vocals.wav"), "--instrument", "vocals"])
    captured = capsys.readouterr()
    assert "The words could not be made: no words today" in captured.err
    assert json.loads(captured.out)["stem"] == "vocals"


def test_a_line_break_inside_a_word_costs_neither_the_words_nor_the_notes(folder, capsys, monkeypatch):
    stems, _ = folder
    monkeypatch.setattr(lyrics, "hear", lambda _: ([lyrics.Word("oh\nyeah", 0.25, 1.25)], "en"))
    events = run(capsys, "transcribe", str(stems / "song - vocals.wav"), "--instrument", "vocals")
    assert events[-1]["transcription"]["words"] == [[0, "oh", False], [4, "yeah", False]]


def test_a_failure_is_an_error_event(folder, capsys):
    stems, _ = folder
    events = run(capsys, "transcribe", str(stems / "missing.wav"), "--instrument", "bass", "--fail")
    assert events == [{"event": "error", "message": f"{stems / 'missing.wav'} is not a file."}]


def test_siblings_are_the_songs_stems_and_not_its_mix(folder):
    stems, _ = folder
    names = [path.name for path in audio.siblings(stems / "song - bass.wav")]
    assert names == ["song - bass.wav", "song - drums.wav", "song - vocals.wav"]


def test_the_command_runs_with_uv(tmp_path):
    done = subprocess.run(["uv", "run", "lily-transcribe", "--help"], cwd=Path(__file__).parent.parent, capture_output=True, text=True)
    assert done.returncode == 0
    assert "transcribe" in done.stdout


# ---- tempo (D159) ----


@pytest.fixture
def recording(tmp_path, monkeypatch):
    """A score's recording at ♩ = 113.76 from 0.33 s, with Beat This replaced; it counts the runs."""
    monkeypatch.setenv("LILY_TRANSCRIBE_HOME", str(tmp_path / "cache"))
    rate = cli.SAMPLE_RATE
    path = tmp_path / "song - instrumental.wav"
    audio.save_wav(path, np.zeros(rate * 30, dtype=np.float32), rate)
    # Siblings that must not be mixed in: the recording is enough (§3.1).
    audio.save_wav(tmp_path / "song - vocals.wav", np.zeros(rate * 60, dtype=np.float32), rate)
    calls = {"beats": 0}

    def beats(samples, sample_rate):
        calls["beats"] += 1
        calls["seconds"] = len(samples) / sample_rate
        times = 0.33 + np.arange(56) * 60 / 113.76
        return times, times[::4]

    monkeypatch.setattr(cli, "track_beats", beats)
    return path, calls


def test_the_tempo_of_a_recording_is_found_and_its_beats_kept(recording, capsys):
    path, calls = recording
    events = run(capsys, "tempo", str(path), "--score-bpm", "114", "--beats-per-bar", "4")
    assert [event.get("stage") for event in events[:-1]] == ["decode", "beats"]
    done = events[-1]
    assert done["event"] == "done"
    assert done["bpm"] == 113.76
    assert done["heardBpm"] == 113.76
    assert done["steady"] is True
    assert done["share"] == 1.0
    assert done["residualMs"] < 1
    assert done["beatsPerBar"] == 4
    assert done["heardBeatsPerBar"] == 4
    assert done["barOne"] == pytest.approx(0.33, abs=0.001)
    assert done["seconds"] == pytest.approx(30.0)
    assert "took" in done
    # The recording alone, not mixed with the vocals beside it.
    assert calls["seconds"] == pytest.approx(30.0, abs=0.01)
    # From the cache the second time, and at another level for another score.
    events = run(capsys, "tempo", str(path), "--score-bpm", "57")
    assert calls["beats"] == 1
    assert [event["event"] for event in events] == ["done"]
    assert events[0]["bpm"] == 56.88
    assert events[0]["heardBpm"] == 113.76


def test_a_changed_recording_is_heard_again(recording, capsys):
    path, calls = recording
    run(capsys, "tempo", str(path))
    audio.save_wav(path, np.zeros(cli.SAMPLE_RATE * 31, dtype=np.float32), cli.SAMPLE_RATE)
    run(capsys, "tempo", str(path))
    assert calls["beats"] == 2


def test_the_tempo_in_compound_meter_is_in_quarters(recording, capsys):
    path, _ = recording
    events = run(capsys, "tempo", str(path), "--score-bpm", "170", "--beats-per-bar", "2", "--beat", "1.5")
    # Dotted quarters at 113.76 are ♩ = 170.64.
    assert events[-1]["bpm"] == 170.64


def test_a_recording_without_a_beat_is_an_error_event(recording, capsys, monkeypatch):
    path, _ = recording
    monkeypatch.setattr(cli, "track_beats", lambda samples, rate: (np.array([1.0, 2.5, 3.1]), np.array([1.0])))
    events = run(capsys, "tempo", str(path), "--fail")
    assert events[-1]["event"] == "error"
    assert events[-1]["message"].startswith("Too few beats were found to tell the tempo")


def test_a_missing_recording_is_an_error_event(tmp_path, capsys):
    events = run(capsys, "tempo", str(tmp_path / "missing.mp3"), "--fail")
    assert events == [{"event": "error", "message": f"{tmp_path / 'missing.mp3'} is not a file."}]


def test_the_beats_of_a_recording_are_not_a_songs_analysis(recording, folder):
    path, _ = recording
    assert cli.beats_key(path) != cli.song_key([path])


# ---- sung (D276) ----


def test_a_voices_sung_times_are_one_done_event_and_kept(tmp_path, monkeypatch, capsys):
    from test_sung import make_singer

    stem, notes, calls = make_singer(tmp_path, monkeypatch)
    events = run(capsys, "sung", str(stem), str(notes), "--voice", "lead")
    assert [event.get("stage") for event in events[:-1]] == ["decode", "pitch", "words"]
    done = events[-1]
    assert done["event"] == "done"
    assert done["voice"] == "lead"
    assert len(done["notes"]) == 9
    assert set(done["notes"][0]) == {"shift", "arrival", "consonant", "vowel", "score", "asWritten", "heard"}
    assert [phrase["sung"] for phrase in done["phrases"]] == [False, True, True]
    assert (done["lag"], done["tau"], done["octave"]) == (0.072, 0.125, 12)
    assert "took" in done
    # From the cache the second time: no stage, no model.
    again = run(capsys, "sung", str(stem), str(notes), "--voice", "lead")
    assert [event["event"] for event in again] == ["done"]
    assert calls == {"load": 1, "words": 3, "pitch": 1}


def test_a_stem_with_no_voice_is_an_error_event(tmp_path, monkeypatch, capsys):
    from test_sung import make_singer

    stem, notes, _ = make_singer(tmp_path, monkeypatch, pitch=[])
    events = run(capsys, "sung", str(stem), str(notes), "--voice", "lead", "--fail")
    assert events[-1] == {"event": "error", "message": "There is no voice in song - vocals.wav: pYIN hears a pitch in 0% of it."}


def test_a_missing_voice_is_an_error_event(tmp_path, monkeypatch, capsys):
    from test_sung import make_singer

    stem, notes, _ = make_singer(tmp_path, monkeypatch)
    notes.unlink()
    events = run(capsys, "sung", str(stem), str(notes), "--voice", "lead", "--fail")
    assert events == [{"event": "error", "message": f"{notes} is not a file."}]


def test_the_sung_times_go_to_stdout_without_json(tmp_path, monkeypatch, capsys):
    from test_sung import make_singer

    stem, notes, _ = make_singer(tmp_path, monkeypatch)
    cli.main(["sung", str(stem), str(notes), "--voice", "lead"])
    assert json.loads(capsys.readouterr().out)["voice"] == "lead"
