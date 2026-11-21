//! lily-separate against stand-ins for uv: shell scripts that record the
//! arguments they were given and print what karaoke-mlx would.
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use lily_separate::{
    LISTENING, ROOT_VARIABLE, Request, RootSource, SUNG_MODEL, ScoreMeter, Separator, Sidecar,
    TRANSCRIBE_VARIABLE, Transcriber, check_sung, find_uv, mix, models, project_root, separating,
    sung_args, tempo_args, transcribe_args, transcribe_root, uv_candidates, vocals_request,
    vocals_stem,
};
use serde_json::{Value, json};
use tempfile::TempDir;

fn scratch() -> (TempDir, PathBuf) {
    let dir = tempfile::Builder::new()
        .prefix("lily-studio-separate-")
        .tempdir()
        .expect("a temp dir");
    let real = dir.path().canonicalize().expect("its real path");
    (dir, real)
}

fn project(dir: &Path) -> PathBuf {
    std::fs::create_dir_all(dir).expect("the folder is made");
    std::fs::write(
        dir.join("pyproject.toml"),
        "[project]\nname = \"karaoke-mlx\"\n",
    )
    .expect("pyproject.toml is written");
    dir.to_path_buf()
}

/// A stand-in for uv: writes its arguments, one a line, to `uv.args`
/// beside itself, then runs `body`.
fn fake_uv(dir: &Path, body: &str) -> Sidecar {
    let uv = dir.join("uv");
    std::fs::write(
        &uv,
        format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$(dirname \"$0\")/uv.args\"\n{body}\n"),
    )
    .expect("the script is written");
    std::fs::set_permissions(&uv, std::fs::Permissions::from_mode(0o755))
        .expect("it is executable");
    Sidecar {
        uv,
        root: project(&dir.join("project")),
        search_path: "/usr/bin:/bin".into(),
    }
}

fn recorded_args(dir: &Path) -> Vec<String> {
    std::fs::read_to_string(dir.join("uv.args"))
        .expect("uv was run")
        .lines()
        .map(str::to_owned)
        .collect()
}

fn song(dir: &Path) -> PathBuf {
    let song = dir.join("song.mp3");
    std::fs::write(&song, b"ID3").expect("the song is written");
    song
}

fn request(input: PathBuf) -> Request {
    Request {
        input,
        model: "becruily".into(),
        overlap: Some(2),
        format: "wav".into(),
    }
}

/// Collects the events a separation hands on.
#[derive(Clone, Default)]
struct Heard(Arc<Mutex<Vec<Value>>>);

impl Heard {
    fn sink(&self) -> impl Fn(Value) + Send + Sync + use<> {
        let heard = self.0.clone();
        move |event| heard.lock().unwrap().push(event)
    }

    fn events(&self) -> Vec<Value> {
        self.0.lock().unwrap().clone()
    }
}

fn alive(pid: i32) -> bool {
    // SAFETY: signal 0 only asks whether the process exists.
    unsafe { libc::kill(pid, 0) == 0 }
}

// ---------------------------------------------------------------------------
// project_root

#[test]
fn the_variable_names_the_root_before_the_setting_and_the_defaults() {
    let (_dir, dir) = scratch();
    let named = project(&dir.join("named"));
    let setting = project(&dir.join("setting"));
    let fallback = project(&dir.join("fallback"));
    let root = project_root(
        Some(named.clone().into()),
        Some(&setting),
        std::slice::from_ref(&fallback),
    )
    .expect("a root");
    assert_eq!(root.path, named);
    assert_eq!(root.source, RootSource::Variable);
}

#[test]
fn a_variable_that_names_no_project_is_an_error_not_a_fallback() {
    let (_dir, dir) = scratch();
    let fallback = project(&dir.join("fallback"));
    let error =
        project_root(Some(dir.join("nowhere").into()), None, &[fallback]).expect_err("no fallback");
    assert!(error.contains(ROOT_VARIABLE), "{error}");
    assert!(error.contains("pyproject.toml"), "{error}");
}

#[test]
fn an_empty_variable_is_unset_and_the_setting_comes_next() {
    let (_dir, dir) = scratch();
    let setting = project(&dir.join("setting"));
    let root = project_root(Some("".into()), Some(&setting), &[]).expect("a root");
    assert_eq!(root.path, setting);
    assert_eq!(root.source, RootSource::Setting);
}

#[test]
fn the_first_default_that_is_a_project_is_taken() {
    let (_dir, dir) = scratch();
    let second = project(&dir.join("second"));
    let root = project_root(None, None, &[dir.join("first"), second.clone()]).expect("a root");
    assert_eq!(root.path, second);
    assert_eq!(root.source, RootSource::Default);
}

#[test]
fn no_project_anywhere_says_how_to_name_one() {
    let (_dir, dir) = scratch();
    let error = project_root(None, None, &[dir.join("first")]).expect_err("none");
    assert!(error.contains(ROOT_VARIABLE), "{error}");
}

// ---------------------------------------------------------------------------
// find_uv

#[test]
fn uv_is_looked_for_on_the_search_path_then_homebrew_then_home() {
    let candidates = uv_candidates("/a::/b", Some(Path::new("/Users/me")));
    let expected: Vec<PathBuf> = [
        "/a/uv",
        "/b/uv",
        "/opt/homebrew/bin/uv",
        "/usr/local/bin/uv",
        "/Users/me/.local/bin/uv",
        "/Users/me/.cargo/bin/uv",
    ]
    .map(PathBuf::from)
    .to_vec();
    assert_eq!(candidates, expected);
}

#[test]
fn uv_on_the_search_path_wins() {
    let (_dir, dir) = scratch();
    let sidecar = fake_uv(&dir, "exit 0");
    let found = find_uv(&dir.to_string_lossy(), None).expect("uv");
    assert_eq!(found, sidecar.uv);
}

// ---------------------------------------------------------------------------
// The command line

#[test]
fn the_cli_runs_with_uv_in_the_project_with_homebrew_on_its_path() {
    let sidecar = Sidecar {
        uv: "/opt/homebrew/bin/uv".into(),
        root: "/songs/karaoke-mlx".into(),
        search_path: "/usr/bin:/bin".into(),
    };
    let command = sidecar.command(["models"]);
    let command = command.as_std();
    assert_eq!(command.get_program(), "/opt/homebrew/bin/uv");
    let args: Vec<_> = command.get_args().collect();
    assert_eq!(
        args,
        [
            "run",
            "--quiet",
            "--project",
            "/songs/karaoke-mlx",
            "karaoke-mlx",
            "--json",
            "models"
        ]
    );
    assert_eq!(
        command.get_current_dir(),
        Some(Path::new("/songs/karaoke-mlx"))
    );
    let path = command
        .get_envs()
        .find(|(key, _)| *key == "PATH")
        .and_then(|(_, value)| value);
    assert_eq!(
        path.and_then(|p| p.to_str()),
        Some("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
    );
}

#[test]
fn a_request_is_the_separate_subcommand_with_the_model_overlap_and_format() {
    let (_dir, dir) = scratch();
    let input = song(&dir);
    let args = request(input.clone()).args().expect("args");
    let expected: Vec<std::ffi::OsString> = vec![
        "separate".into(),
        input.into(),
        "--model".into(),
        "becruily".into(),
        "--overlap".into(),
        "2".into(),
        "--format".into(),
        "wav".into(),
    ];
    assert_eq!(args, expected);

    let mut without_overlap = request(song(&dir));
    without_overlap.overlap = None;
    let args = without_overlap.args().expect("args");
    assert!(!args.iter().any(|arg| arg == "--overlap"));
}

#[test]
fn a_request_refuses_what_could_be_read_as_an_option_or_is_not_a_song() {
    let (_dir, dir) = scratch();
    assert!(request("song.mp3".into()).args().is_err(), "relative");
    assert!(request(dir.join("missing.mp3")).args().is_err(), "missing");
    assert!(request(dir.clone()).args().is_err(), "a folder");
    let mut flag = request(song(&dir));
    flag.model = "--output=/etc".into();
    assert!(flag.args().is_err(), "an option for a model");
    let mut shell = request(song(&dir));
    shell.format = "wav; rm -rf ~".into();
    assert!(shell.args().is_err(), "not a plain word");
}

// ---------------------------------------------------------------------------
// Separator

#[tokio::test]
async fn a_separation_hands_on_each_event_and_answers_the_folder() {
    let (_dir, dir) = scratch();
    let sidecar = fake_uv(
        &dir,
        r#"echo '{"event": "status", "message": "separating"}'
echo 'not json, ignored'
echo '{"event": "progress", "stage": "separate", "value": 0.5}'
echo '{"event": "done", "outputs": [{"stem": "vocals", "path": "/s/song (karaoke)/song - vocals.wav"}], "folder": "/s/song (karaoke)", "seconds": 1.5}'"#,
    );
    let input = song(&dir);
    let heard = Heard::default();
    let separator = Separator::default();
    let folder = separator
        .separate(&sidecar, &request(input.clone()), heard.sink())
        .await
        .expect("separated");
    assert_eq!(folder, PathBuf::from("/s/song (karaoke)"));
    let kinds: Vec<_> = heard
        .events()
        .iter()
        .map(|event| event["event"].as_str().unwrap_or_default().to_owned())
        .collect();
    assert_eq!(kinds, ["status", "progress", "done"]);
    let args = recorded_args(&dir);
    assert_eq!(
        &args[..6],
        [
            "run",
            "--quiet",
            "--project",
            &sidecar.root.to_string_lossy(),
            "karaoke-mlx",
            "--json"
        ]
    );
    assert_eq!(
        args[6..8],
        ["separate".to_string(), input.to_string_lossy().into_owned()]
    );
    assert!(!separator.is_running());
}

#[tokio::test]
async fn an_error_event_is_the_answer_and_is_not_repeated() {
    let (_dir, dir) = scratch();
    let sidecar = fake_uv(
        &dir,
        r#"echo '{"event": "error", "message": "ffmpeg not found"}'
exit 1"#,
    );
    let heard = Heard::default();
    let error = Separator::default()
        .separate(&sidecar, &request(song(&dir)), heard.sink())
        .await
        .expect_err("failed");
    assert_eq!(error, "ffmpeg not found");
    assert_eq!(heard.events().len(), 1);
}

#[tokio::test]
async fn a_cli_that_dies_silently_is_reported_with_the_end_of_its_stderr() {
    let (_dir, dir) = scratch();
    let sidecar = fake_uv(
        &dir,
        r#"for n in 1 2 3 4 5 6 7 8; do echo "line $n" >&2; done
exit 2"#,
    );
    let heard = Heard::default();
    let error = Separator::default()
        .separate(&sidecar, &request(song(&dir)), heard.sink())
        .await
        .expect_err("failed");
    assert_eq!(error, "line 3\nline 4\nline 5\nline 6\nline 7\nline 8");
    assert_eq!(
        heard.events(),
        [json!({ "event": "error", "message": error, "cancelled": false })]
    );
}

#[tokio::test]
async fn one_separation_at_a_time_and_cancel_ends_its_whole_group() {
    let (_dir, dir) = scratch();
    // Like uv starting Python: a child of its own that Cancel must reach too.
    let sidecar = fake_uv(
        &dir,
        r#"echo '{"event": "status", "message": "loading"}'
sleep 30 &
echo $! > "$(dirname "$0")/child.pid"
wait"#,
    );
    let separator = Arc::new(Separator::default());
    let heard = Heard::default();
    let running = tokio::spawn({
        let separator = separator.clone();
        let sidecar = sidecar.clone();
        let input = song(&dir);
        let sink = heard.sink();
        async move { separator.separate(&sidecar, &request(input), sink).await }
    });
    // Up to 20 s: a loaded machine (the whole workspace's tests at once) is slow to start it.
    let pid_file = dir.join("child.pid");
    for _ in 0..800 {
        if std::fs::read_to_string(&pid_file).is_ok_and(|text| text.ends_with('\n')) {
            break;
        }
        if running.is_finished() {
            panic!(
                "the separation ended before its child started: {:?}",
                running.await
            );
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let child: i32 = std::fs::read_to_string(&pid_file)
        .expect("the script started its child")
        .trim()
        .parse()
        .expect("a pid");
    assert!(separator.is_running());

    let busy = separator
        .separate(&sidecar, &request(song(&dir)), |_| {})
        .await
        .expect_err("busy");
    assert_eq!(busy, "A separation is already running.");

    assert!(separator.cancel());
    let answer = tokio::time::timeout(Duration::from_secs(10), running)
        .await
        .expect("cancel ends it")
        .expect("the task ran");
    assert_eq!(answer, Err("Cancelled.".to_string()));
    let last = heard.events().pop().expect("an event");
    assert_eq!(
        last,
        json!({ "event": "error", "message": "Cancelled.", "cancelled": true })
    );
    for _ in 0..200 {
        if !alive(child) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert!(!alive(child), "the CLI's own child was ended too");
    assert!(!separator.is_running());
    assert!(!separator.cancel(), "nothing left to cancel");
}

// ---------------------------------------------------------------------------
// models and mix

#[tokio::test]
async fn models_are_the_clis_list() {
    let (_dir, dir) = scratch();
    let sidecar = fake_uv(
        &dir,
        r#"echo '[{"id": "becruily", "task": "karaoke", "stems": ["vocals", "instrumental"]}, {"id": "bs-roformer-sw", "task": "stems", "stems": ["vocals", "drums", "bass", "guitar", "piano", "other"]}]'"#,
    );
    let listed = models(&sidecar).await.expect("models");
    assert_eq!(listed[0]["id"], "becruily");
    assert_eq!(listed[1]["stems"].as_array().map(Vec::len), Some(6));
    assert_eq!(recorded_args(&dir)[6], "models");
}

#[tokio::test]
async fn models_that_fail_say_why() {
    let (_dir, dir) = scratch();
    let sidecar = fake_uv(&dir, "echo 'No module named mlx' >&2\nexit 1");
    assert_eq!(
        models(&sidecar).await.expect_err("failed"),
        "No module named mlx"
    );
}

#[tokio::test]
async fn mix_sums_the_stems_into_the_output() {
    let (_dir, dir) = scratch();
    let sidecar = fake_uv(
        &dir,
        r#"echo '{"event": "progress", "stage": "mix", "value": 1.0}'
echo '{"event": "done", "outputs": [{"stem": "mix", "path": "/s/mix.wav"}], "folder": "/s"}'"#,
    );
    let stems = [
        PathBuf::from("/s/song - drums.wav"),
        PathBuf::from("/s/song - bass.wav"),
    ];
    let written = mix(&sidecar, &stems, Path::new("/s/mix.wav"))
        .await
        .expect("mixed");
    assert_eq!(written, PathBuf::from("/s/mix.wav"));
    assert_eq!(
        recorded_args(&dir)[6..],
        [
            "mix",
            "--output",
            "/s/mix.wav",
            "/s/song - drums.wav",
            "/s/song - bass.wav"
        ]
    );
}

#[tokio::test]
async fn mix_refuses_relative_paths_and_nothing_to_mix() {
    let sidecar = Sidecar {
        uv: "/nonexistent/uv".into(),
        root: "/nonexistent".into(),
        search_path: String::new(),
    };
    assert!(mix(&sidecar, &[], Path::new("/s/mix.wav")).await.is_err());
    assert!(
        mix(&sidecar, &["drums.wav".into()], Path::new("/s/mix.wav"))
            .await
            .is_err()
    );
    assert!(
        mix(&sidecar, &["/s/drums.wav".into()], Path::new("mix.wav"))
            .await
            .is_err()
    );
}

// ---------------------------------------------------------------------------
// Transcriber (D113)

#[test]
fn the_transcriber_is_the_variables_project_or_the_default() {
    let (_dir, dir) = scratch();
    let named = project(&dir.join("named"));
    let default = project(&dir.join("packages/transcribe"));
    assert_eq!(
        transcribe_root(Some(named.clone().into()), &default),
        Ok(named)
    );
    assert_eq!(
        transcribe_root(Some("".into()), &default),
        Ok(default.clone())
    );
    assert_eq!(transcribe_root(None, &default), Ok(default));
    let error = transcribe_root(Some(dir.join("nothing").into()), &dir).expect_err("not a project");
    assert!(error.starts_with(TRANSCRIBE_VARIABLE), "{error}");
    let error = transcribe_root(None, &dir.join("missing")).expect_err("no default");
    assert!(error.contains(TRANSCRIBE_VARIABLE), "{error}");
}

#[test]
fn a_transcription_refuses_what_could_be_read_as_an_option_or_is_not_a_stem() {
    let (_dir, dir) = scratch();
    let stem = song(&dir);
    assert_eq!(
        transcribe_args(&stem, "bass").expect("args"),
        [
            std::ffi::OsString::from("transcribe"),
            stem.clone().into(),
            "--instrument".into(),
            "bass".into()
        ]
    );
    assert!(
        transcribe_args(Path::new("song.mp3"), "bass").is_err(),
        "relative"
    );
    assert!(
        transcribe_args(&dir.join("missing.wav"), "bass").is_err(),
        "missing"
    );
    assert!(transcribe_args(&dir, "bass").is_err(), "a folder");
    assert!(transcribe_args(&stem, "--help").is_err(), "an option");
    assert!(
        transcribe_args(&stem, "bass guitar").is_err(),
        "not a plain word"
    );
}

#[tokio::test]
async fn a_transcription_hands_on_each_event_and_answers_the_notes() {
    let (_dir, dir) = scratch();
    let sidecar = fake_uv(
        &dir,
        r#"echo '{"event": "progress", "stage": "beats"}'
echo 'Predicting MIDI for /tmp/audio.wav...'
echo '{"event": "done", "transcription": {"stem": "bass", "bpm": 123.015, "notes": [[0, 4, [36]]]}, "seconds": 9.5}'"#,
    );
    let stem = song(&dir);
    let heard = Heard::default();
    let transcriber = Transcriber::default();
    let transcription = transcriber
        .transcribe(&sidecar, &stem, "bass", heard.sink())
        .await
        .expect("transcribed");
    assert_eq!(
        transcription,
        json!({"stem": "bass", "bpm": 123.015, "notes": [[0, 4, [36]]]})
    );
    let kinds: Vec<_> = heard
        .events()
        .iter()
        .map(|event| event["event"].as_str().unwrap_or_default().to_owned())
        .collect();
    assert_eq!(kinds, ["progress", "done"]);
    assert_eq!(
        recorded_args(&dir),
        [
            "run",
            "--quiet",
            "--project",
            &sidecar.root.to_string_lossy(),
            "lily-transcribe",
            "--json",
            "transcribe",
            &stem.to_string_lossy(),
            "--instrument",
            "bass"
        ]
    );
    assert!(!transcriber.is_running());
}

#[tokio::test]
async fn a_transcriptions_warnings_are_in_its_answer_and_handed_on() {
    let (_dir, dir) = scratch();
    let sidecar = fake_uv(
        &dir,
        r#"echo '{"event": "progress", "stage": "words"}'
echo '{"event": "warning", "message": "The words could not be made: offline"}'
echo '{"event": "done", "transcription": {"stem": "vocals", "notes": []}, "seconds": 9.5}'"#,
    );
    let heard = Heard::default();
    let transcription = Transcriber::default()
        .transcribe(&sidecar, &song(&dir), "vocals", heard.sink())
        .await
        .expect("the notes are kept");
    // In the answer, which comes by another way than the events, and may come first.
    assert_eq!(
        transcription,
        json!({
            "stem": "vocals",
            "notes": [],
            "warnings": ["The words could not be made: offline"]
        })
    );
    let kinds: Vec<_> = heard
        .events()
        .iter()
        .map(|event| event["event"].as_str().unwrap_or_default().to_owned())
        .collect();
    assert_eq!(kinds, ["progress", "warning", "done"]);
}

#[tokio::test]
async fn a_warning_with_nothing_to_say_is_not_in_the_answer() {
    let (_dir, dir) = scratch();
    let sidecar = fake_uv(
        &dir,
        r#"echo '{"event": "warning"}'
echo '{"event": "done", "transcription": {"stem": "vocals", "notes": []}, "seconds": 9.5}'"#,
    );
    let transcription = Transcriber::default()
        .transcribe(&sidecar, &song(&dir), "vocals", |_| {})
        .await
        .expect("the notes are kept");
    assert_eq!(transcription, json!({"stem": "vocals", "notes": []}));
}

#[tokio::test]
async fn a_transcription_that_fails_says_why() {
    let (_dir, dir) = scratch();
    let sidecar = fake_uv(
        &dir,
        r#"echo '{"event": "error", "message": "Too few beats were found to tell the tempo."}'
exit 1"#,
    );
    let error = Transcriber::default()
        .transcribe(&sidecar, &song(&dir), "bass", |_| {})
        .await
        .expect_err("failed");
    assert_eq!(error, "Too few beats were found to tell the tempo.");

    let silent = fake_uv(&dir, "exit 3");
    let error = Transcriber::default()
        .transcribe(&silent, &song(&dir), "bass", |_| {})
        .await
        .expect_err("died");
    assert!(
        error.starts_with("lily-transcribe ended without a result"),
        "{error}"
    );

    let empty = fake_uv(&dir, r#"echo '{"event": "done", "seconds": 1}'"#);
    let error = Transcriber::default()
        .transcribe(&empty, &song(&dir), "bass", |_| {})
        .await
        .expect_err("no notes");
    assert_eq!(error, "The transcription finished without its notes.");
}

// The tempo of a score's recording (D159)

fn meter(bpm: Option<f64>, beats_per_bar: Option<u32>, beat: Option<f64>) -> ScoreMeter {
    ScoreMeter {
        bpm,
        beats_per_bar,
        beat,
    }
}

#[test]
fn a_tempo_request_names_the_recording_and_the_scores_meter() {
    let (_dir, dir) = scratch();
    let recording = song(&dir);
    let strings = |args: Vec<std::ffi::OsString>| -> Vec<String> {
        args.into_iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    };
    let path = recording.to_string_lossy().into_owned();
    assert_eq!(
        strings(tempo_args(&recording, &meter(Some(114.0), Some(4), Some(1.5))).expect("args")),
        [
            "tempo",
            &path,
            "--score-bpm",
            "114",
            "--beats-per-bar",
            "4",
            "--beat",
            "1.5"
        ]
    );
    assert_eq!(
        strings(tempo_args(&recording, &ScoreMeter::default()).expect("args")),
        ["tempo", &path]
    );
    // No meter is no option, rather than a zero.
    assert_eq!(
        strings(tempo_args(&recording, &meter(None, Some(0), None)).expect("args")),
        ["tempo", &path]
    );
    assert!(
        tempo_args(Path::new("song.mp3"), &ScoreMeter::default()).is_err(),
        "relative"
    );
    assert!(
        tempo_args(&dir.join("missing.mp3"), &ScoreMeter::default()).is_err(),
        "missing"
    );
    assert!(
        tempo_args(&dir, &ScoreMeter::default()).is_err(),
        "a folder"
    );
    for bad in [-114.0, 0.0, f64::NAN, f64::INFINITY] {
        assert!(
            tempo_args(&recording, &meter(Some(bad), None, None)).is_err(),
            "tempo {bad}"
        );
        assert!(
            tempo_args(&recording, &meter(None, None, Some(bad))).is_err(),
            "beat {bad}"
        );
    }
}

#[tokio::test]
async fn a_tempo_hands_on_each_event_and_answers_what_was_found() {
    let (_dir, dir) = scratch();
    let sidecar = fake_uv(
        &dir,
        r#"echo '{"event": "progress", "stage": "decode"}'
echo '{"event": "progress", "stage": "beats"}'
echo '{"event": "done", "bpm": 113.76, "heardBpm": 113.76, "steady": true, "share": 0.99, "residualMs": 19.2, "beatsPerBar": 4, "heardBeatsPerBar": 4, "barOne": 0.322, "seconds": 216.7, "took": 3.5}'"#,
    );
    let recording = song(&dir);
    let heard = Heard::default();
    let transcriber = Transcriber::default();
    let found = transcriber
        .detect_tempo(
            &sidecar,
            &recording,
            &meter(Some(114.0), Some(4), None),
            heard.sink(),
        )
        .await
        .expect("found");
    assert_eq!(
        found,
        json!({"bpm": 113.76, "heardBpm": 113.76, "steady": true, "share": 0.99, "residualMs": 19.2, "beatsPerBar": 4, "heardBeatsPerBar": 4, "barOne": 0.322, "seconds": 216.7, "took": 3.5})
    );
    let stages: Vec<_> = heard
        .events()
        .iter()
        .map(|event| {
            event["stage"]
                .as_str()
                .unwrap_or(event["event"].as_str().unwrap_or_default())
                .to_owned()
        })
        .collect();
    assert_eq!(stages, ["decode", "beats", "done"]);
    assert_eq!(
        recorded_args(&dir),
        [
            "run",
            "--quiet",
            "--project",
            &sidecar.root.to_string_lossy(),
            "lily-transcribe",
            "--json",
            "tempo",
            &recording.to_string_lossy(),
            "--score-bpm",
            "114",
            "--beats-per-bar",
            "4"
        ]
    );
    assert!(!transcriber.is_running());
}

#[tokio::test]
async fn a_tempo_not_found_says_why() {
    let (_dir, dir) = scratch();
    let sidecar = fake_uv(
        &dir,
        r#"echo '{"event": "error", "message": "Too few beats were found to tell the tempo: 3."}'
exit 1"#,
    );
    let heard = Heard::default();
    let error = Transcriber::default()
        .detect_tempo(&sidecar, &song(&dir), &ScoreMeter::default(), heard.sink())
        .await
        .expect_err("failed");
    assert_eq!(error, "Too few beats were found to tell the tempo: 3.");
    // The page hears it as an event too, once.
    assert_eq!(heard.events().len(), 1);

    let silent = fake_uv(&dir, "exit 3");
    let error = Transcriber::default()
        .detect_tempo(&silent, &song(&dir), &ScoreMeter::default(), |_| {})
        .await
        .expect_err("died");
    assert!(
        error.starts_with("lily-transcribe ended without a result"),
        "{error}"
    );

    let empty = fake_uv(&dir, r#"echo '{"event": "done", "took": 1}'"#);
    let error = Transcriber::default()
        .detect_tempo(&empty, &song(&dir), &ScoreMeter::default(), |_| {})
        .await
        .expect_err("no tempo");
    assert_eq!(error, "lily-transcribe finished without the tempo.");
}

#[tokio::test]
async fn a_tempo_waits_for_no_transcription_and_says_so() {
    let (_dir, dir) = scratch();
    let sidecar = fake_uv(
        &dir,
        r#"sleep 5
echo '{"event": "done", "transcription": {"stem": "bass", "notes": []}, "seconds": 5}'"#,
    );
    let transcriber = Arc::new(Transcriber::default());
    let running = {
        let transcriber = transcriber.clone();
        let sidecar = sidecar.clone();
        let stem = song(&dir);
        tokio::spawn(async move {
            transcriber
                .transcribe(&sidecar, &stem, "bass", |_| {})
                .await
        })
    };
    let started = std::time::Instant::now();
    while !transcriber.is_running() && started.elapsed() < Duration::from_secs(5) {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let error = transcriber
        .detect_tempo(&sidecar, &song(&dir), &ScoreMeter::default(), |_| {})
        .await
        .expect_err("busy");
    assert_eq!(
        error,
        "Lily Studio is already transcribing or listening to a recording."
    );
    assert!(transcriber.cancel());
    assert!(running.await.expect("joined").is_err());
}

// A voice's sung times, from the lead vocals stem of the score's recording (D276)

fn strings(args: Vec<std::ffi::OsString>) -> Vec<String> {
    args.into_iter()
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect()
}

fn voice() -> Value {
    json!({ "bpm": 113.76, "notes": [
        { "start": 9.81, "length": 0.26, "pitch": 57, "syllable": "Ba" },
        { "start": 10.07, "length": 0.53, "pitch": 59, "syllable": "by." },
    ]})
}

#[test]
fn a_recordings_vocals_stem_is_the_karaoke_models_beside_it() {
    let (_dir, dir) = scratch();
    let recording = song(&dir);
    assert_eq!(vocals_stem(&recording), None, "not separated yet");

    let folder = dir.join("song (karaoke)");
    std::fs::create_dir_all(&folder).unwrap();
    std::fs::write(folder.join("song - instrumental.wav"), b"RIFF").unwrap();
    assert_eq!(vocals_stem(&recording), None, "only the instrumental");
    // A separation into another format is found too, WAV first.
    std::fs::write(folder.join("song - vocals.mp3"), b"ID3").unwrap();
    assert_eq!(
        vocals_stem(&recording),
        Some(folder.join("song - vocals.mp3"))
    );
    std::fs::write(folder.join("song - vocals.wav"), b"RIFF").unwrap();
    assert_eq!(
        vocals_stem(&recording),
        Some(folder.join("song - vocals.wav"))
    );
    // A stems model's folder is not the lead's.
    let (_other, other) = scratch();
    let recording = song(&other);
    std::fs::create_dir_all(other.join("song (stems)")).unwrap();
    std::fs::write(other.join("song (stems)/song - vocals.wav"), b"RIFF").unwrap();
    assert_eq!(vocals_stem(&recording), None);

    // What separates it is the karaoke model, into WAV, beside the recording.
    let request = vocals_request(&recording);
    assert_eq!(request.model, SUNG_MODEL);
    assert_eq!(
        strings(request.args().expect("args")),
        [
            "separate",
            &recording.to_string_lossy(),
            "--model",
            "becruily",
            "--format",
            "wav"
        ]
    );
}

#[test]
fn a_separation_for_the_sung_times_is_heard_as_their_progress() {
    assert_eq!(
        separating(&json!({ "event": "progress", "stage": "load", "value": 0.0 })),
        Some(json!({ "event": "progress", "stage": "separate" }))
    );
    assert_eq!(
        separating(&json!({ "event": "progress", "stage": "separate", "value": 0.25 })),
        Some(json!({ "event": "progress", "stage": "separate", "value": 0.25 }))
    );
    let warning = json!({ "event": "warning", "message": "slow" });
    assert_eq!(separating(&warning), Some(warning));
    // The job goes on after the separation, or fails with its error.
    for event in [
        json!({ "event": "done", "folder": "/s/song (karaoke)", "outputs": [] }),
        json!({ "event": "error", "message": "no ffmpeg" }),
        json!({ "event": "status", "message": "separating" }),
        json!({}),
    ] {
        assert_eq!(separating(&event), None, "{event}");
    }
}

#[test]
fn a_sung_request_names_the_stem_the_notes_and_the_voice() {
    let (_dir, dir) = scratch();
    let stem = song(&dir);
    let notes = dir.join("voice.json");
    std::fs::write(&notes, "{}").unwrap();
    let path = |path: &Path| path.to_string_lossy().into_owned();
    assert_eq!(
        strings(sung_args(&stem, &notes, "lead").expect("args")),
        ["sung", &path(&stem), &path(&notes), "--voice=lead"]
    );
    // A name the score allows, though it looks like an option, stays the option's.
    assert_eq!(
        strings(sung_args(&stem, &notes, "-x Соло").expect("args"))[3],
        "--voice=-x Соло"
    );
    for name in ["", "  ", "le\nad", "a\tb"] {
        assert!(sung_args(&stem, &notes, name).is_err(), "{name:?}");
    }
    assert!(
        sung_args(Path::new("song.mp3"), &notes, "lead").is_err(),
        "relative"
    );
    assert!(
        sung_args(&dir.join("missing.wav"), &notes, "lead").is_err(),
        "missing"
    );
    assert!(sung_args(&stem, &dir, "lead").is_err(), "a folder");
}

#[test]
fn a_voice_with_no_tempo_or_notes_is_not_sent() {
    assert_eq!(check_sung("lead", &voice()), Ok(()));
    assert!(check_sung("", &voice()).is_err());
    for notes in [
        json!({ "bpm": 114, "notes": [] }),
        json!({ "bpm": 114 }),
        json!({ "bpm": 0, "notes": [{}] }),
        json!({ "bpm": "114", "notes": [{}] }),
        json!({ "notes": [{}] }),
        json!([]),
    ] {
        assert!(check_sung("lead", &notes).is_err(), "{notes}");
    }
}

#[tokio::test]
async fn sung_times_hand_on_each_event_and_answer_what_was_found() {
    let (_dir, dir) = scratch();
    // The stand-in keeps the voice.json it was given, which is gone after the run.
    let sidecar = fake_uv(
        &dir,
        r#"cp "$9" "$(dirname "$0")/voice.json"
echo '{"event": "progress", "stage": "decode"}'
echo '{"event": "progress", "stage": "pitch"}'
echo '{"event": "warning", "message": "Words with no Latin letters are not aligned yet."}'
echo '{"event": "progress", "stage": "words"}'
echo '{"event": "done", "voice": "lead", "notes": [{"shift": 62, "arrival": 9.872, "consonant": 9.75, "vowel": 9.944, "score": 0.41, "asWritten": true, "heard": 57}, {"shift": 0, "arrival": null, "consonant": null, "vowel": null, "score": null, "asWritten": null, "heard": null}], "phrases": [{"first": 0, "last": 1, "sung": true}], "lag": 0.072, "tau": 0.132, "octave": 0, "took": 2.1}'"#,
    );
    let stem = song(&dir);
    let heard = Heard::default();
    let transcriber = Transcriber::default();
    let found = transcriber
        .sung(&sidecar, &stem, "lead", &voice(), heard.sink())
        .await
        .expect("found");
    assert_eq!(found["voice"], "lead");
    assert_eq!(found["notes"][0]["shift"], 62);
    assert_eq!(found["notes"][1]["arrival"], Value::Null);
    assert_eq!(
        found["phrases"],
        json!([{ "first": 0, "last": 1, "sung": true }])
    );
    assert_eq!(found["tau"], 0.132);
    assert_eq!(
        found["warnings"],
        json!(["Words with no Latin letters are not aligned yet."])
    );
    assert_eq!(found.get("event"), None);
    let stages: Vec<_> = heard
        .events()
        .iter()
        .map(|event| {
            event["stage"]
                .as_str()
                .unwrap_or(event["event"].as_str().unwrap_or_default())
                .to_owned()
        })
        .collect();
    assert_eq!(stages, ["decode", "pitch", "warning", "words", "done"]);

    let args = recorded_args(&dir);
    let notes = PathBuf::from(&args[8]);
    assert_eq!(
        args,
        [
            "run",
            "--quiet",
            "--project",
            &sidecar.root.to_string_lossy(),
            "lily-transcribe",
            "--json",
            "sung",
            &stem.to_string_lossy(),
            &notes.to_string_lossy(),
            "--voice=lead"
        ]
    );
    // The page's notes, as they were sent, in a file of the run's own.
    let sent: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("voice.json")).unwrap()).unwrap();
    assert_eq!(sent, voice());
    assert!(notes.is_absolute());
    assert!(!notes.exists(), "the voice.json is deleted after the run");
    assert!(!transcriber.is_running());
}

#[tokio::test]
async fn sung_times_not_found_say_why() {
    let (_dir, dir) = scratch();
    let sidecar = fake_uv(
        &dir,
        r#"echo '{"event": "error", "message": "The stem has no voice in it."}'
exit 1"#,
    );
    let heard = Heard::default();
    let error = Transcriber::default()
        .sung(&sidecar, &song(&dir), "lead", &voice(), heard.sink())
        .await
        .expect_err("failed");
    assert_eq!(error, "The stem has no voice in it.");
    assert_eq!(heard.events().len(), 1);

    let silent = fake_uv(&dir, "exit 3");
    let error = Transcriber::default()
        .sung(&silent, &song(&dir), "lead", &voice(), |_| {})
        .await
        .expect_err("died");
    assert!(
        error.starts_with("lily-transcribe ended without a result"),
        "{error}"
    );

    let empty = fake_uv(&dir, r#"echo '{"event": "done", "took": 1}'"#);
    let error = Transcriber::default()
        .sung(&empty, &song(&dir), "lead", &voice(), |_| {})
        .await
        .expect_err("no times");
    assert_eq!(error, "lily-transcribe finished without the sung times.");

    // A voice with nothing to align never starts the CLI.
    let (_unrun, unrun) = scratch();
    let never = fake_uv(&unrun, "exit 0");
    let error = Transcriber::default()
        .sung(
            &never,
            &song(&unrun),
            "lead",
            &json!({ "bpm": 114, "notes": [] }),
            |_| {},
        )
        .await
        .expect_err("no notes");
    assert_eq!(error, "lead has no notes to compare.");
    assert!(!unrun.join("uv.args").exists());
}

#[tokio::test]
async fn sung_times_wait_for_no_tempo_and_say_so() {
    let (_dir, dir) = scratch();
    let sidecar = fake_uv(
        &dir,
        r#"sleep 5
echo '{"event": "done", "bpm": 114, "barOne": 0.3}'"#,
    );
    let transcriber = Arc::new(Transcriber::default());
    let running = {
        let transcriber = transcriber.clone();
        let sidecar = sidecar.clone();
        let recording = song(&dir);
        tokio::spawn(async move {
            transcriber
                .detect_tempo(&sidecar, &recording, &ScoreMeter::default(), |_| {})
                .await
        })
    };
    let started = std::time::Instant::now();
    while !transcriber.is_running() && started.elapsed() < Duration::from_secs(5) {
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let error = transcriber
        .sung(&sidecar, &song(&dir), "lead", &voice(), |_| {})
        .await
        .expect_err("busy");
    assert_eq!(error, LISTENING);
    assert!(transcriber.cancel());
    assert!(running.await.expect("joined").is_err());
}
