//! Stem separation (DECISIONS D112): RoFormer MLX's `karaoke-mlx` CLI, run
//! with uv as a sidecar the way RoFormer's own app (its
//! `app/src-tauri/src/lib.rs`) runs it. `uv run karaoke-mlx --json …` runs in
//! the project's root and prints one JSON event per line on stdout. This crate
//! finds the project (`project_root`) and uv (`find_uv`), and builds the
//! command line (`Sidecar::command`). Its `Separator` runs one separation at a
//! time; Cancel and quitting end it through its process group. Its
//! `Transcriber` runs lily-transcribe (`packages/transcribe`, D113) the same
//! way, to turn a stem into notes. Its `history` keeps the songs separated
//! before (D114). Only src-tauri depends on it, and the web
//! server never links it (D55).
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;

pub mod history;

/// Names the project's root, ahead of the setting and the defaults.
pub const ROOT_VARIABLE: &str = "KARAOKE_MLX_ROOT";

/// Where the project goes once its Python moves into this repository (D112).
pub const MONOREPO_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../separate");

/// RoFormer MLX's own checkout, where the Python is until then.
pub const CHECKOUT_ROOT: &str = "/Volumes/T5/Workspace/roformer-karaoke-mlx";

/// How many of stderr's last lines a failure reports.
const STDERR_TAIL: usize = 6;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RootSource {
    /// `KARAOKE_MLX_ROOT`.
    Variable,
    /// The folder the user chose in the setup.
    Setting,
    /// The first of `default_roots` that holds the project.
    Default,
}

/// The folder holding RoFormer MLX's `pyproject.toml`, and what named it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProjectRoot {
    pub path: PathBuf,
    pub source: RootSource,
}

pub fn is_project(dir: &Path) -> bool {
    dir.join("pyproject.toml").is_file()
}

/// The places looked in when neither the variable nor the setting names one.
pub fn default_roots() -> Vec<PathBuf> {
    vec![PathBuf::from(MONOREPO_ROOT), PathBuf::from(CHECKOUT_ROOT)]
}

/// The project to run: `KARAOKE_MLX_ROOT`, then the setting, then the first
/// of `defaults` that is a project. A folder that the variable or the setting
/// names must be a project. A missing one is an error, so the app never falls
/// back to a default without saying so.
pub fn project_root(
    variable: Option<OsString>,
    setting: Option<&Path>,
    defaults: &[PathBuf],
) -> Result<ProjectRoot, String> {
    let named = variable
        .filter(|value| !value.is_empty())
        .map(|value| (PathBuf::from(value), RootSource::Variable))
        .or_else(|| setting.map(|path| (path.to_path_buf(), RootSource::Setting)));
    if let Some((path, source)) = named {
        if !is_project(&path) {
            let named_by = match source {
                RootSource::Variable => ROOT_VARIABLE,
                _ => "The separation setting",
            };
            return Err(format!(
                "{named_by} names {}, which has no pyproject.toml.",
                path.display()
            ));
        }
        return Ok(ProjectRoot { path, source });
    }
    defaults
        .iter()
        .find(|path| is_project(path))
        .map(|path| ProjectRoot {
            path: path.canonicalize().unwrap_or_else(|_| path.clone()),
            source: RootSource::Default,
        })
        .ok_or_else(|| format!("RoFormer MLX was not found. Set {ROOT_VARIABLE} to its folder."))
}

/// The first of `uv_candidates` that exists.
pub fn find_uv(search_path: &str, home: Option<&Path>) -> Result<PathBuf, String> {
    uv_candidates(search_path, home)
        .into_iter()
        .find(|uv| uv.is_file())
        .ok_or_else(|| "uv was not found. Install it with `brew install uv`.".into())
}

/// uv on `search_path`, then where Homebrew and uv's installer put it. An
/// app opened from Finder starts with a bare `PATH`.
pub fn uv_candidates(search_path: &str, home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::split_paths(search_path)
        .filter(|dir| !dir.as_os_str().is_empty())
        .collect();
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    if let Some(home) = home {
        dirs.push(home.join(".local/bin"));
        dirs.push(home.join(".cargo/bin"));
    }
    dirs.into_iter().map(|dir| dir.join("uv")).collect()
}

/// How to run the CLI: which uv, which project, and the `PATH` it gets.
#[derive(Clone, Debug)]
pub struct Sidecar {
    pub uv: PathBuf,
    pub root: PathBuf,
    /// The studio's search path; ffmpeg is looked for there, after Homebrew's.
    pub search_path: String,
}

impl Sidecar {
    /// `uv run --quiet --project <root> karaoke-mlx --json <args>`, run in the root.
    pub fn command<I, S>(&self, args: I) -> Command
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.program("karaoke-mlx", args)
    }

    /// `uv run --quiet --project <root> <program> --json <args>`, run in the root.
    pub fn program<I, S>(&self, program: &str, args: I) -> Command
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        let mut command = Command::new(&self.uv);
        command
            .arg("run")
            .arg("--quiet")
            .arg("--project")
            .arg(&self.root)
            .arg(program)
            .arg("--json")
            .args(args)
            .current_dir(&self.root)
            .env("PATH", self.child_path())
            .stdin(Stdio::null());
        command
    }

    /// Homebrew's folders first, where ffmpeg is, then the studio's search path.
    pub fn child_path(&self) -> String {
        let brew = "/opt/homebrew/bin:/usr/local/bin";
        if self.search_path.is_empty() {
            brew.to_string()
        } else {
            format!("{brew}:{}", self.search_path)
        }
    }
}

/// One separation as the page asks for it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    /// The song: an absolute path to a file.
    pub input: PathBuf,
    /// A model id from `models`, such as `becruily` or `bs-roformer-sw`.
    pub model: String,
    /// Chunks overlapping each sample; the model's own when absent.
    #[serde(default)]
    pub overlap: Option<u32>,
    /// `wav`, `flac` or `mp3`.
    pub format: String,
}

impl Request {
    /// The `separate` subcommand's arguments. The song must be an absolute
    /// path to a file, and the model and format plain words. None of them
    /// can then be read as an option.
    pub fn args(&self) -> Result<Vec<OsString>, String> {
        if !self.input.is_absolute() || !self.input.is_file() {
            return Err(format!("{} is not a song file.", self.input.display()));
        }
        let mut args: Vec<OsString> = vec!["separate".into(), self.input.clone().into()];
        args.extend(["--model".into(), word("model", &self.model)?.into()]);
        if let Some(overlap) = self.overlap {
            args.extend(["--overlap".into(), overlap.to_string().into()]);
        }
        args.extend(["--format".into(), word("format", &self.format)?.into()]);
        Ok(args)
    }
}

fn word<'a>(what: &str, value: &'a str) -> Result<&'a str, String> {
    let plain = value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'));
    if value.is_empty() || value.starts_with('-') || !plain {
        return Err(format!("Unknown {what}: {value}"));
    }
    Ok(value)
}

/// The running CLI: its process group, and whether Cancel ended it.
struct Running {
    pid: Option<u32>,
    cancelled: bool,
}

/// What a job's messages call it.
struct Kind {
    program: &'static str,
    busy: &'static str,
    failed: &'static str,
}

const SEPARATION: Kind = Kind {
    program: "karaoke-mlx",
    busy: "A separation is already running.",
    failed: "The separation failed.",
};

const TRANSCRIPTION: Kind = Kind {
    program: TRANSCRIBE_PROGRAM,
    busy: "A transcription is already running.",
    failed: "The transcription failed.",
};

/// One run of a CLI at a time, in its own process group, which Cancel and
/// quitting end.
#[derive(Default)]
struct Job {
    slot: Mutex<Option<Running>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Empties the job slot however a run ends. Dropped before its child was
/// reaped, as when the caller stops waiting, it ends the child's group.
struct Release<'a>(&'a Mutex<Option<Running>>);

impl Drop for Release<'_> {
    fn drop(&mut self) {
        if let Some(Running { pid: Some(pid), .. }) = lock(self.0).take() {
            terminate(pid);
        }
    }
}

/// SIGTERM to `pid`'s process group, or to `pid` alone when it has none.
fn terminate(pid: u32) {
    let Ok(pid) = libc::pid_t::try_from(pid) else {
        return;
    };
    // SAFETY: kill(2) takes plain integers; a negative pid names the group.
    unsafe {
        if libc::kill(-pid, libc::SIGTERM) != 0 {
            libc::kill(pid, libc::SIGTERM);
        }
    }
}

impl Job {
    fn is_running(&self) -> bool {
        lock(&self.slot).is_some()
    }

    /// Runs `command`, and hands each JSON event it prints to `on_event` as
    /// it comes. It answers the `done` event. A CLI that dies without an
    /// `error` event, because it was cancelled or crashed, gets one from
    /// here, so the page always hears how it ended.
    async fn run(
        &self,
        kind: &Kind,
        mut command: Command,
        on_event: impl Fn(Value) + Send + Sync,
    ) -> Result<Value, String> {
        let mut child = {
            let mut slot = lock(&self.slot);
            if slot.is_some() {
                return Err(kind.busy.into());
            }
            let child = command
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                // Its own process group, so Cancel reaches uv and the Python it starts.
                .process_group(0)
                .spawn()
                .map_err(|error| format!("uv did not start: {error}"))?;
            *slot = Some(Running {
                pid: child.id(),
                cancelled: false,
            });
            child
        };
        let _release = Release(&self.slot);
        let stdout = child.stdout.take().expect("stdout is piped");
        let mut stderr = child.stderr.take().expect("stderr is piped");
        let stderr = tokio::spawn(async move {
            let mut text = String::new();
            let _ = stderr.read_to_string(&mut text).await;
            text
        });

        let mut last = None;
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if matches!(event["event"].as_str(), Some("done" | "error")) {
                last = Some(event.clone());
            }
            on_event(event);
        }
        let status = child.wait().await;
        let cancelled = {
            let mut slot = lock(&self.slot);
            let running = slot.as_mut().expect("the slot is held until Release");
            // Reaped: its pid may be another process's from now on.
            running.pid = None;
            running.cancelled
        };
        let stderr = stderr.await.unwrap_or_default();

        match last {
            Some(event) if event["event"] == "done" => Ok(event),
            Some(event) => Err(event["message"].as_str().unwrap_or(kind.failed).to_string()),
            None => {
                let message = if cancelled {
                    "Cancelled.".to_string()
                } else {
                    failure(kind.program, &stderr, status.ok())
                };
                on_event(json!({ "event": "error", "message": message, "cancelled": cancelled }));
                Err(message)
            }
        }
    }

    /// Ends the running CLI and everything it started: SIGTERM to its
    /// process group. False when none is running.
    fn cancel(&self) -> bool {
        let mut slot = lock(&self.slot);
        let Some(running) = slot.as_mut() else {
            return false;
        };
        running.cancelled = true;
        if let Some(pid) = running.pid {
            terminate(pid);
        }
        true
    }
}

/// One separation at a time, as in RoFormer's app.
#[derive(Default)]
pub struct Separator {
    job: Job,
}

impl Separator {
    pub fn is_running(&self) -> bool {
        self.job.is_running()
    }

    /// Runs `request`, and hands each of the CLI's events to `on_event` as it
    /// comes. It answers the folder the stems went to.
    pub async fn separate(
        &self,
        sidecar: &Sidecar,
        request: &Request,
        on_event: impl Fn(Value) + Send + Sync,
    ) -> Result<PathBuf, String> {
        let args = request.args()?;
        let done = self
            .job
            .run(&SEPARATION, sidecar.command(&args), on_event)
            .await?;
        done["folder"]
            .as_str()
            .map(PathBuf::from)
            .ok_or_else(|| "The separation finished without its folder.".to_string())
    }

    /// Ends the running separation and everything it started. False when
    /// none is running.
    pub fn cancel(&self) -> bool {
        self.job.cancel()
    }
}

// ---- Transcription (D113) ----
// lily-transcribe, this repository's `packages/transcribe`, turns a stem into
// notes on the song's beat grid. It runs as karaoke-mlx does: uv in its own
// project, one JSON event per line, one run at a time.

/// The CLI's name in `packages/transcribe`'s pyproject.toml.
pub const TRANSCRIBE_PROGRAM: &str = "lily-transcribe";

/// Names lily-transcribe's project, ahead of the default.
pub const TRANSCRIBE_VARIABLE: &str = "LILY_TRANSCRIBE_ROOT";

/// `packages/transcribe` beside the studio.
pub const TRANSCRIBE_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../transcribe");

/// lily-transcribe's project: `LILY_TRANSCRIBE_ROOT`, which must be one, or `default`.
pub fn transcribe_root(variable: Option<OsString>, default: &Path) -> Result<PathBuf, String> {
    match variable.filter(|value| !value.is_empty()) {
        Some(value) => {
            let path = PathBuf::from(value);
            if is_project(&path) {
                Ok(path)
            } else {
                Err(format!(
                    "{TRANSCRIBE_VARIABLE} names {}, which has no pyproject.toml.",
                    path.display()
                ))
            }
        }
        None if is_project(default) => Ok(default
            .canonicalize()
            .unwrap_or_else(|_| default.to_path_buf())),
        None => Err(format!(
            "Lily Studio's transcriber was not found at {}. Set {TRANSCRIBE_VARIABLE} to packages/transcribe.",
            default.display()
        )),
    }
}

/// `transcribe <stem> --instrument <name>`: the stem must be an absolute path
/// to a file, and the instrument a plain word, so neither is read as an option.
pub fn transcribe_args(stem: &Path, instrument: &str) -> Result<Vec<OsString>, String> {
    if !stem.is_absolute() || !stem.is_file() {
        return Err(format!("{} is not a stem.", stem.display()));
    }
    Ok(vec![
        "transcribe".into(),
        stem.into(),
        "--instrument".into(),
        word("instrument", instrument)?.into(),
    ])
}

/// One transcription at a time.
#[derive(Default)]
pub struct Transcriber {
    job: Job,
}

impl Transcriber {
    pub fn is_running(&self) -> bool {
        self.job.is_running()
    }

    /// Transcribes `stem` as `instrument` (`bass`, `vocals`…) with the
    /// lily-transcribe project `sidecar` names, handing each event to
    /// `on_event`. It answers the transcription.
    pub async fn transcribe(
        &self,
        sidecar: &Sidecar,
        stem: &Path,
        instrument: &str,
        on_event: impl Fn(Value) + Send + Sync,
    ) -> Result<Value, String> {
        let args = transcribe_args(stem, instrument)?;
        let mut done = self
            .job
            .run(
                &TRANSCRIPTION,
                sidecar.program(TRANSCRIBE_PROGRAM, &args),
                on_event,
            )
            .await?;
        match done["transcription"].take() {
            Value::Object(transcription) => Ok(Value::Object(transcription)),
            _ => Err("The transcription finished without its notes.".into()),
        }
    }

    /// Ends the running transcription. False when none is running.
    pub fn cancel(&self) -> bool {
        self.job.cancel()
    }
}

/// The models the CLI knows, as `karaoke-mlx --json models` lists them: id,
/// title, task (`karaoke` or not), stems, size, installed, default.
pub async fn models(sidecar: &Sidecar) -> Result<Value, String> {
    let output = sidecar
        .command(["models"])
        .output()
        .await
        .map_err(|error| format!("uv did not start: {error}"))?;
    if !output.status.success() {
        return Err(failure(
            SEPARATION.program,
            &String::from_utf8_lossy(&output.stderr),
            Some(output.status),
        ));
    }
    serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("karaoke-mlx listed its models unreadably: {error}"))
}

/// Sums `stems` into `output`, in the format of its extension; answers the
/// file written. Every path must be absolute.
pub async fn mix(sidecar: &Sidecar, stems: &[PathBuf], output: &Path) -> Result<PathBuf, String> {
    if stems.is_empty() {
        return Err("No stems to mix.".into());
    }
    if let Some(path) = stems
        .iter()
        .map(PathBuf::as_path)
        .chain([output])
        .find(|path| !path.is_absolute())
    {
        return Err(format!("{} is not an absolute path.", path.display()));
    }
    let mut args: Vec<&OsStr> = vec!["mix".as_ref(), "--output".as_ref(), output.as_os_str()];
    args.extend(stems.iter().map(|stem| stem.as_os_str()));
    let result = sidecar
        .command(args)
        .output()
        .await
        .map_err(|error| format!("uv did not start: {error}"))?;
    let last = String::from_utf8_lossy(&result.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .next_back();
    match last {
        Some(event) if event["event"] == "done" => Ok(event["outputs"][0]["path"]
            .as_str()
            .map(PathBuf::from)
            .unwrap_or_else(|| output.to_path_buf())),
        Some(event) if event["event"] == "error" => Err(event["message"]
            .as_str()
            .unwrap_or("The mix failed.")
            .to_string()),
        _ => Err(failure(
            SEPARATION.program,
            &String::from_utf8_lossy(&result.stderr),
            Some(result.status),
        )),
    }
}

/// What a CLI that printed no `error` event died of: stderr's last lines, or its exit status.
fn failure(program: &str, stderr: &str, status: Option<std::process::ExitStatus>) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    let tail = lines[lines.len().saturating_sub(STDERR_TAIL)..].join("\n");
    match status {
        _ if !tail.is_empty() => tail,
        Some(status) => format!("{program} ended without a result ({status})."),
        None => format!("{program} ended without a result."),
    }
}
