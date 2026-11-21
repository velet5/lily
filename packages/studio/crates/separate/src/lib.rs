//! Stem separation (DECISIONS D112, D125): `karaoke-mlx` in packages/separate, run
//! with uv as a sidecar the way RoFormer's own app (its
//! `app/src-tauri/src/lib.rs`) runs it. `uv run karaoke-mlx --json …` runs in
//! the project's root and prints one JSON event per line on stdout. This crate
//! finds the project (`project_root`) and uv (`find_uv`), and builds the
//! command line (`Sidecar::command`). Its `Separator` runs one separation at a
//! time; Cancel and quitting end it through its process group. Its
//! `Transcriber` runs lily-transcribe (`packages/transcribe`, D113) the same
//! way, to turn a stem into notes, to find a score's tempo and bar 1 in
//! its recording (D159), and to find where the singer of that recording sings
//! a voice's notes, from its lead vocals stem (D276). Its `history` keeps the
//! songs separated before (D114). Only src-tauri depends on it, and the web
//! server never links it (D55).
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::process::Command;

pub mod history;

/// Names the project's root, ahead of the setting and the defaults.
pub const ROOT_VARIABLE: &str = "KARAOKE_MLX_ROOT";

/// `packages/separate` beside the studio (D125).
pub const MONOREPO_ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../separate");

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
    vec![PathBuf::from(MONOREPO_ROOT)]
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
        .ok_or_else(|| {
            format!(
                "Lily Studio's separation was not found. Set {ROOT_VARIABLE} to packages/separate."
            )
        })
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
        tool_path(&self.search_path)
    }
}

/// Homebrew's folders, where ffmpeg is, then `search_path`.
pub fn tool_path(search_path: &str) -> String {
    let brew = "/opt/homebrew/bin:/usr/local/bin";
    if search_path.is_empty() {
        brew.to_string()
    } else {
        format!("{brew}:{search_path}")
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

/// What a run of lily-transcribe says when one is running already.
pub const LISTENING: &str = "Lily Studio is already transcribing or listening to a recording.";

const TEMPO: Kind = Kind {
    program: TRANSCRIBE_PROGRAM,
    busy: LISTENING,
    failed: "The tempo could not be found.",
};

const SUNG: Kind = Kind {
    program: TRANSCRIBE_PROGRAM,
    busy: LISTENING,
    failed: "The sung times could not be found.",
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
    /// it comes. It answers the `done` event, with the messages of any
    /// `warning` events in its `warnings`: the page may have that answer
    /// before the events. A CLI that dies without an `error` event, because
    /// it was cancelled or crashed, gets one from here, so the page always
    /// hears how it ended.
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
        let mut warnings = Vec::new();
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match event["event"].as_str() {
                Some("done" | "error") => last = Some(event.clone()),
                Some("warning") => warnings.extend(event["message"].as_str().map(Value::from)),
                _ => {}
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
            Some(mut event) if event["event"] == "done" => {
                if !warnings.is_empty() {
                    event["warnings"] = Value::Array(warnings);
                }
                Ok(event)
            }
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

/// What a score tells lily-transcribe's `tempo` (D159): its tempo in quarter
/// notes a minute, which chooses the metrical level, its beats per bar, and its
/// beat in quarter notes (1.5 for 6/8's dotted quarter).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoreMeter {
    #[serde(default)]
    pub bpm: Option<f64>,
    #[serde(default)]
    pub beats_per_bar: Option<u32>,
    #[serde(default)]
    pub beat: Option<f64>,
}

/// `tempo <recording> [--score-bpm N] [--beats-per-bar M] [--beat Q]`: the
/// recording must be an absolute path to a file, and each number positive and
/// finite, so none is read as an option.
pub fn tempo_args(recording: &Path, meter: &ScoreMeter) -> Result<Vec<OsString>, String> {
    if !recording.is_absolute() || !recording.is_file() {
        return Err(format!("{} is not a recording.", recording.display()));
    }
    let positive = |what: &str, value: f64| {
        if value.is_finite() && value > 0.0 {
            Ok(value.to_string())
        } else {
            Err(format!(
                "The score's {what} is not a positive number: {value}"
            ))
        }
    };
    let mut args: Vec<OsString> = vec!["tempo".into(), recording.into()];
    if let Some(bpm) = meter.bpm {
        args.extend(["--score-bpm".into(), positive("tempo", bpm)?.into()]);
    }
    if let Some(beats) = meter.beats_per_bar.filter(|beats| *beats > 0) {
        args.extend(["--beats-per-bar".into(), beats.to_string().into()]);
    }
    if let Some(beat) = meter.beat {
        args.extend(["--beat".into(), positive("beat", beat)?.into()]);
    }
    Ok(args)
}

// ---- From the singer (D276) ----
// lily-transcribe's `sung` aligns a voice of the score with the lead vocals
// stem of the score's recording. The stem is the one karaoke-mlx's karaoke
// model writes beside the recording; the page writes the voice's notes, which
// go to the CLI as a voice.json of their own.

/// The karaoke model that separates the lead vocals stem used by `sung`.
pub const SUNG_MODEL: &str = "becruily";

/// What karaoke-mlx may have written a stem as, the first found first.
const STEM_FORMATS: &[&str] = &["wav", "flac", "mp3"];

/// The lead vocals stem of `recording`, as karaoke-mlx's karaoke models write
/// it beside the recording: `<song> (karaoke)/<song> - vocals.wav`, or `.flac`
/// or `.mp3`. None when there is none yet.
pub fn vocals_stem(recording: &Path) -> Option<PathBuf> {
    let song = recording.file_stem()?.to_string_lossy();
    let folder = recording.parent()?.join(format!("{song} (karaoke)"));
    STEM_FORMATS
        .iter()
        .map(|format| folder.join(format!("{song} - vocals.{format}")))
        .find(|stem| stem.is_file())
}

/// The separation that writes `recording`'s lead vocals stem where
/// `vocals_stem` finds it: SUNG_MODEL, into WAV, with the model's own overlap.
pub fn vocals_request(recording: &Path) -> Request {
    Request {
        input: recording.to_path_buf(),
        model: SUNG_MODEL.into(),
        overlap: None,
        format: "wav".into(),
    }
}

/// A separation's event as the `sung` job hands it on, as one of lily-transcribe's:
/// its progress as the stage `separate`, with a `value` while it separates,
/// and its warnings. Its `done` and `error` are not passed on, since the job
/// goes on, or answers its error, after it.
pub fn separating(event: &Value) -> Option<Value> {
    match event["event"].as_str()? {
        "progress" => {
            let mut progress = json!({ "event": "progress", "stage": "separate" });
            if event["stage"] == "separate"
                && let Some(value) = event["value"].as_f64()
            {
                progress["value"] = value.into();
            }
            Some(progress)
        }
        "warning" => Some(event.clone()),
        _ => None,
    }
}

/// Whether the page's voice can be sent to `sung`, before a stem is separated
/// for it: a name for `--voice`, and a voice.json with the score's tempo and
/// at least one note. lily-transcribe checks each note.
pub fn check_sung(voice: &str, notes: &Value) -> Result<(), String> {
    voice_name(voice)?;
    if !notes["bpm"]
        .as_f64()
        .is_some_and(|bpm| bpm.is_finite() && bpm > 0.0)
    {
        return Err(format!("The score has no tempo to compare {voice} on."));
    }
    if !notes["notes"]
        .as_array()
        .is_some_and(|notes| !notes.is_empty())
    {
        return Err(format!("{voice} has no notes to compare."));
    }
    Ok(())
}

/// A voice's name, as the score's `Voice` has it: any text but blank or a control character.
fn voice_name(voice: &str) -> Result<&str, String> {
    if voice.trim().is_empty() || voice.chars().any(char::is_control) {
        return Err(format!("{voice:?} cannot name a voice."));
    }
    Ok(voice)
}

/// `sung <stem> <voice.json> --voice=<name>`: both paths absolute files, and
/// the name in the option's own word, so a name that starts with `-` is not
/// read as an option.
pub fn sung_args(stem: &Path, notes: &Path, voice: &str) -> Result<Vec<OsString>, String> {
    if !stem.is_absolute() || !stem.is_file() {
        return Err(format!("{} is not a stem.", stem.display()));
    }
    if !notes.is_absolute() || !notes.is_file() {
        return Err(format!("{} is not a voice's notes.", notes.display()));
    }
    let mut option = OsString::from("--voice=");
    option.push(voice_name(voice)?);
    Ok(vec!["sung".into(), stem.into(), notes.into(), option])
}

/// A voice.json in the temp folder, deleted when it is dropped.
struct VoiceFile(PathBuf);

impl VoiceFile {
    async fn write(notes: &Value) -> Result<VoiceFile, String> {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let number = NEXT.fetch_add(1, Ordering::Relaxed);
        let path =
            std::env::temp_dir().join(format!("lily-sung-{}-{number}.json", std::process::id()));
        let text = serde_json::to_vec(notes).map_err(|error| error.to_string())?;
        let file = VoiceFile(path);
        tokio::fs::write(&file.0, text)
            .await
            .map_err(|error| format!("The voice's notes could not be written: {error}"))?;
        Ok(file)
    }
}

impl Drop for VoiceFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// One transcription, one tempo found, or one voice's sung times found, at a
/// time: all run lily-transcribe and its models.
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
    /// `on_event`. It answers the transcription, with `warnings` when the
    /// CLI gave any (D134).
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
            Value::Object(mut transcription) => {
                if let Value::Array(warnings) = done["warnings"].take() {
                    transcription.insert("warnings".into(), warnings.into());
                }
                Ok(Value::Object(transcription))
            }
            _ => Err("The transcription finished without its notes.".into()),
        }
    }

    /// Finds the tempo and bar 1 of `recording`, a score's `% Audio:` file,
    /// at the metrical level and meter of the score (D159), handing each event
    /// to `on_event`. It answers the `done` event's fields: `bpm`,
    /// `heardBpm`, `steady`, `share`, `residualMs`, `beatsPerBar`,
    /// `heardBeatsPerBar`, `barOne`, `seconds`.
    pub async fn detect_tempo(
        &self,
        sidecar: &Sidecar,
        recording: &Path,
        meter: &ScoreMeter,
        on_event: impl Fn(Value) + Send + Sync,
    ) -> Result<Value, String> {
        let args = tempo_args(recording, meter)?;
        let mut done = self
            .job
            .run(&TEMPO, sidecar.program(TRANSCRIBE_PROGRAM, &args), on_event)
            .await?;
        if !done["bpm"].is_number() || !done["barOne"].is_number() {
            return Err("lily-transcribe finished without the tempo.".into());
        }
        if let Value::Object(fields) = &mut done {
            fields.remove("event");
        }
        Ok(done)
    }

    /// From the singer (D276): where the singer of `stem`, a score's lead
    /// vocals stem, sings each note of `voice`, whose notes the page gives as
    /// voice.json's `notes` (with the score's `bpm`), handing each event to
    /// `on_event`. It answers the `done` event's fields: `voice`, `notes`,
    /// `phrases`, `lag`, `tau`, `octave` and `took`, and `warnings` when the
    /// CLI gave any. The notes are written to a file of their own for the run.
    pub async fn sung(
        &self,
        sidecar: &Sidecar,
        stem: &Path,
        voice: &str,
        notes: &Value,
        on_event: impl Fn(Value) + Send + Sync,
    ) -> Result<Value, String> {
        check_sung(voice, notes)?;
        let file = VoiceFile::write(notes).await?;
        let args = sung_args(stem, &file.0, voice)?;
        let mut done = self
            .job
            .run(&SUNG, sidecar.program(TRANSCRIBE_PROGRAM, &args), on_event)
            .await?;
        drop(file);
        if !done["notes"].is_array() {
            return Err("lily-transcribe finished without the sung times.".into());
        }
        if let Value::Object(fields) = &mut done {
            fields.remove("event");
        }
        Ok(done)
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
