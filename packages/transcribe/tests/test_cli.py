"""The command line's JSON events, with stand-ins for the two models."""

import json
import subprocess
from pathlib import Path

import numpy as np
import pytest

from lily_transcribe import audio, cli


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

    monkeypatch.setattr(cli, "track_beats", beats)
    monkeypatch.setattr(cli, "notes_of", notes)
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
    assert done["notes"] == [[0, 4, [36]], [4, 4, [43]], [8, 8, [39]]]
    # The beats come from the bass, drums and vocals mixed, not the mix exported beside them.
    assert calls["seconds"] == pytest.approx(8.0, abs=0.01)


def test_the_songs_beats_and_key_are_kept_for_its_other_stems(folder, capsys):
    stems, calls = folder
    run(capsys, "transcribe", str(stems / "song - bass.wav"), "--instrument", "bass")
    events = run(capsys, "transcribe", str(stems / "song - vocals.wav"), "--instrument", "vocals")
    assert calls["beats"] == 1
    assert [event.get("stage") for event in events[:-1]] == ["notes"]


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
