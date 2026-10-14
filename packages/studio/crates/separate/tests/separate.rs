//! lily-separate against stand-ins for uv: shell scripts that record the
//! arguments they were given and print what karaoke-mlx would.
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use lily_separate::{
    ROOT_VARIABLE, Request, RootSource, Separator, Sidecar, find_uv, mix, models, project_root,
    uv_candidates,
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
    let pid_file = dir.join("child.pid");
    for _ in 0..200 {
        if std::fs::read_to_string(&pid_file).is_ok_and(|text| text.ends_with('\n')) {
            break;
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
