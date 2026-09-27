//! Owns LilyPond processes, including the acceleration helpers (DECISIONS D3,
//! D15, D25), from src/compile/compiler.ts.

use std::collections::HashMap;
use std::ffi::CString;
use std::fmt;
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use regex::Regex;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::watch;

use crate::accelerator::{Accelerator, ProcessResult};
use crate::collate::{Sensitivity, compare};
use crate::locate::{LilyPondNotFound, LocateOptions, locate_lilypond};
use crate::paths;
use crate::root_file::SourceBuffers;
use crate::search_path::SearchPath;
use crate::snapshot::{SnapshotError, SourceSnapshot};

/// `lily.preview.acceleration` (D25).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Acceleration {
    #[default]
    Off,
    Cache,
    Auto,
}

/// How a run was made.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Spawn,
    Cache,
    Warm,
}

#[derive(Debug, Clone, Default)]
pub struct CompileRequest {
    /// The real .ly root; optional editor texts are materialized in a private snapshot.
    pub root_file: PathBuf,
    /// The chosen lilypond; empty means PATH, then well-known directories.
    pub lilypond_path: Option<String>,
    /// Passed through verbatim, before `-o`.
    pub extra_args: Vec<String>,
    pub buffers: Option<SourceBuffers>,
    /// `None` is not `Off`: as in the TypeScript, it still allows the glyph cache.
    pub acceleration: Option<Acceleration>,
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Default)]
pub struct CompileResult {
    /// Absolute path that was compiled.
    pub root_file: PathBuf,
    /// Exit code 0. A failed run may still have pages (ARCHITECTURE §3.3).
    pub ok: bool,
    /// Superseded or cancelled; carries no pages and must never be rendered.
    pub cancelled: bool,
    pub exit_code: Option<i32>,
    /// Absolute SVG paths in page order.
    pub pages: Vec<PathBuf>,
    /// Absolute paths of any MIDI files the score produced, in the order lilypond wrote them.
    pub midi: Vec<PathBuf>,
    /// The playback map that `runtime/timing.ly` wrote (D26): a JSON array with
    /// one entry per file of `midi`. Only in preview compiles with a runtime
    /// directory, and only when the score has a `\midi` block.
    pub timing: Option<PathBuf>,
    pub stdout: String,
    /// Raw and unmodified; messages are forced to English.
    pub stderr: String,
    /// This run's private directory. Already deleted when `cancelled`.
    pub output_dir: Option<PathBuf>,
    pub duration_ms: u64,
    pub snapshot: Option<Arc<SourceSnapshot>>,
    pub snapshot_ms: Option<u64>,
    pub engine: Option<Engine>,
    pub fallback: Option<String>,
}

/// What an export writes into the user's folder (D5, D20).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Pdf,
    Midi,
}

impl ExportFormat {
    fn format_args(self) -> Vec<String> {
        match self {
            // Links to the author's file paths have no place in a PDF that is handed on.
            Self::Pdf => vec!["--pdf".into(), "-dno-point-and-click".into()],
            // No pages at all; a \midi block still writes its file [verified on 2.26].
            Self::Midi => vec!["-dno-print-pages".into()],
        }
    }

    fn matches(self, name: &str) -> bool {
        let lower = name.to_lowercase();
        match self {
            Self::Pdf => lower.ends_with(".pdf"),
            Self::Midi => lower.ends_with(".mid") || lower.ends_with(".midi"),
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::Midi => "midi",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ExportRequest {
    pub request: CompileRequest,
    pub format: ExportFormat,
    /// Where the files go. Defaults to the root file's directory.
    pub target_dir: Option<PathBuf>,
}

/// `pages`, `midi` and `output_dir` are empty: the run's directory is gone already.
#[derive(Debug, Clone, Default)]
pub struct ExportResult {
    pub result: CompileResult,
    /// Absolute paths of the files written, named as lilypond names them.
    pub exported: Vec<PathBuf>,
}

/// Why a compile did not run.
#[derive(Debug)]
pub enum CompileError {
    NotFound(LilyPondNotFound),
    /// The root file is unreadable, lilypond could not be started, or a file
    /// could not be written.
    Io(std::io::Error),
}

impl fmt::Display for CompileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound(error) => write!(f, "{error}"),
            Self::Io(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for CompileError {}

impl From<std::io::Error> for CompileError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<LilyPondNotFound> for CompileError {
    fn from(error: LilyPondNotFound) -> Self {
        Self::NotFound(error)
    }
}

#[derive(Debug, Clone, Default)]
pub struct CompileServiceOptions {
    /// Parent of the per-run directories. Defaults to the OS temp dir.
    pub tmp_root: Option<PathBuf>,
    /// Where `timing.ly`, `worker.scm` and `glyph-cache.scm` are.
    pub runtime_dir: Option<PathBuf>,
    /// The `PATH` lilypond is looked for on and runs with.
    pub search_path: SearchPath,
}

struct Run {
    cancelled: watch::Sender<bool>,
    stop: Mutex<Option<Box<dyn FnOnce() + Send>>>,
    output_dir: Mutex<Option<PathBuf>>,
}

impl Run {
    fn cancelled(&self) -> bool {
        *self.cancelled.borrow()
    }

    fn output_dir(&self) -> Option<PathBuf> {
        lock(&self.output_dir).clone()
    }
}

struct RunMode {
    /// Slot in `live`; a new run kills the one that holds it.
    key: String,
    /// What lilypond is to write.
    format_args: Vec<String>,
    /// Keep the output directory as the root's current one, or delete it with the run.
    keep: bool,
    /// Copy what the export wrote there, while the run's directory still exists.
    export: Option<(ExportFormat, PathBuf)>,
}

struct Inner {
    tmp_root: PathBuf,
    runtime_dir: Option<PathBuf>,
    search_path: SearchPath,
    accelerator: Accelerator,
    /// In-flight run per key; at most one each.
    live: Mutex<HashMap<String, Arc<Run>>>,
    /// Output directory of the last completed run per root file.
    kept: Mutex<HashMap<String, PathBuf>>,
}

/// Compiles scores into private temporary directories. Clones share the runs.
#[derive(Clone)]
pub struct CompileService(Arc<Inner>);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl CompileService {
    pub fn new(options: CompileServiceOptions) -> Self {
        Self(Arc::new(Inner {
            tmp_root: options.tmp_root.unwrap_or_else(std::env::temp_dir),
            accelerator: Accelerator::new(options.runtime_dir.clone(), options.search_path.clone()),
            runtime_dir: options.runtime_dir,
            search_path: options.search_path,
            live: Mutex::default(),
            kept: Mutex::default(),
        }))
    }

    /// Compiles `root_file` to SVG in a fresh temp directory. A run still in
    /// flight for the same file is killed and resolves with `cancelled: true`.
    ///
    /// Fails only when the root file is unreadable or lilypond cannot be
    /// located (`CompileError::NotFound`) or started; compile errors resolve
    /// with `ok: false` and the raw stderr.
    ///
    /// The previous completed run's directory for this file is deleted once
    /// this one completes, so read `pages` before the next result arrives.
    pub async fn compile(&self, request: CompileRequest) -> Result<CompileResult, CompileError> {
        let mut format_args = vec!["--svg".to_owned(), "-dpoint-and-click".to_owned()];
        // Where every note of the MIDI is on the page (D26); an export has no use for it.
        if let Some(runtime_dir) = &self.0.runtime_dir {
            format_args.push(format!(
                "-dinclude-settings={}",
                runtime_dir.join("timing.ly").display()
            ));
        }
        let mode = RunMode {
            key: run_key(&paths::resolve(&request.root_file)),
            format_args,
            keep: true,
            export: None,
        };
        Ok(self.run(&request, mode).await?.0)
    }

    /// Compiles `root_file` once more, for `format`, and copies what that wrote
    /// into `target_dir`, replacing files of the same name. The run has its own
    /// temp directory and its own slot: it neither supersedes a preview compile
    /// nor touches the kept pages, only an export of the same file and format
    /// in flight. Fails like `compile()`, and when a file cannot be written.
    pub async fn export(&self, request: ExportRequest) -> Result<ExportResult, CompileError> {
        let root_file = paths::resolve(&request.request.root_file);
        let target_dir = paths::resolve(
            request
                .target_dir
                .as_deref()
                .unwrap_or(&paths::dirname(&root_file)),
        );
        let mode = RunMode {
            key: export_key(&root_file, request.format),
            format_args: request.format.format_args(),
            keep: false,
            export: Some((request.format, target_dir)),
        };
        let (mut result, exported) = self.run(&request.request, mode).await?;
        result.pages.clear();
        result.midi.clear();
        result.output_dir = None;
        Ok(ExportResult { result, exported })
    }

    async fn run(
        &self,
        request: &CompileRequest,
        mode: RunMode,
    ) -> Result<(CompileResult, Vec<PathBuf>), CompileError> {
        let started = Instant::now();
        let root_file = paths::resolve(&request.root_file);
        let key = mode.key.clone();

        let run = Arc::new(Run {
            cancelled: watch::Sender::new(false),
            stop: Mutex::new(None),
            output_dir: Mutex::new(None),
        });
        let previous = lock(&self.0.live).insert(key.clone(), run.clone());
        if let Some(previous) = previous {
            kill(&previous);
        }

        let mut keep_output = false;
        let mut exported = Vec::new();
        let outcome = self
            .run_inner(
                request,
                &mode,
                &run,
                &root_file,
                started,
                &mut keep_output,
                &mut exported,
            )
            .await;

        // As the TypeScript's `finally`.
        {
            let mut live = lock(&self.0.live);
            if live
                .get(&key)
                .is_some_and(|current| Arc::ptr_eq(current, &run))
            {
                live.remove(&key);
            }
        }
        let output_dir = run.output_dir();
        if keep_output && output_dir.is_some() {
            let previous = output_dir.and_then(|dir| lock(&self.0.kept).insert(key, dir));
            remove_dir(previous.as_deref()).await;
        } else {
            remove_dir(output_dir.as_deref()).await;
        }
        outcome.map(|result| (result, exported))
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_inner(
        &self,
        request: &CompileRequest,
        mode: &RunMode,
        run: &Arc<Run>,
        root_file: &Path,
        started: Instant,
        keep_output: &mut bool,
        exported: &mut Vec<PathBuf>,
    ) -> Result<CompileResult, CompileError> {
        let result = |partial: CompileResult| -> CompileResult {
            CompileResult {
                root_file: root_file.to_path_buf(),
                duration_ms: started.elapsed().as_millis() as u64,
                ..partial
            }
        };
        let cancelled = || {
            result(CompileResult {
                cancelled: true,
                ..CompileResult::default()
            })
        };
        let with_output = |partial: CompileResult| CompileResult {
            output_dir: run.output_dir(),
            ..partial
        };

        // Checked here because a missing source directory, being the child's
        // cwd, would otherwise be reported as a failure to start lilypond.
        if !request
            .buffers
            .as_ref()
            .is_some_and(|b| b.contains_key(root_file))
        {
            readable(root_file)?;
        }
        let binary = locate_lilypond(&LocateOptions {
            configured_path: request.lilypond_path.clone(),
            path: self.0.search_path.get(),
            well_known_dirs: None,
        })
        .await?;
        if run.cancelled() {
            return Ok(cancelled());
        }

        // lilypond does not create the directory part of -o; it must exist.
        let output_dir = make_temp_dir(&self.0.tmp_root, "lily-")?;
        *lock(&run.output_dir) = Some(output_dir.clone());
        if run.cancelled() {
            return Ok(cancelled());
        }

        let snapshot_start = Instant::now();
        let mut snapshot: Option<Arc<SourceSnapshot>> = None;
        if let Some(buffers) = request
            .buffers
            .as_ref()
            .filter(|b| mode.keep && !b.is_empty())
        {
            match SourceSnapshot::create(
                root_file,
                buffers,
                &output_dir.join("sources"),
                &request.extra_args,
            )
            .await
            {
                Ok(created) => snapshot = Some(Arc::new(created)),
                // An unsupported/incomplete include is an editing diagnostic,
                // not a failure-to-start notification on every keystroke.
                Err(SnapshotError::Unavailable(message)) => {
                    return Ok(result(CompileResult {
                        stderr: format!("fatal error: {message}\n"),
                        output_dir: None,
                        cancelled: run.cancelled(),
                        ..CompileResult::default()
                    }));
                }
                Err(SnapshotError::Io(error)) => return Err(error.into()),
            }
        }
        let snapshot_ms = snapshot_start.elapsed().as_millis() as u64;
        if run.cancelled() {
            return Ok(cancelled());
        }
        let source = snapshot
            .as_ref()
            .map_or_else(|| root_file.to_path_buf(), |s| s.root_file.clone());
        let base = paths::stem(root_file);
        let extra = &request.extra_args;
        let timeout_ms =
            request
                .timeout_ms
                .unwrap_or(if mode.keep && request.acceleration.is_some() {
                    60000
                } else {
                    0
                });
        // Arbitrary -e/options may initialize fonts before the fork, change the
        // backend or replace its functions. Keep that entire path ordinary.
        let safe_args = extra.iter().enumerate().all(|(i, arg)| {
            let previous = i.checked_sub(1).map(|p| extra[p].as_str());
            arg == "-I"
                || arg == "--include"
                || arg.starts_with("--include=")
                || arg.starts_with("-I")
                || previous == Some("-I")
                || previous == Some("--include")
        });
        let accelerator = &self.0.accelerator;
        let identity = if mode.keep && request.acceleration != Some(Acceleration::Off) && safe_args
        {
            accelerator.identity(&binary.path).await?
        } else {
            String::new()
        };
        let accelerated =
            !identity.is_empty() && accelerator.supported(&binary.path, &identity).await;
        let mut common = vec!["--loglevel=WARNING".to_owned()];
        common.extend(mode.format_args.iter().cloned());
        common.extend(extra.iter().cloned());
        let cwd = paths::dirname(root_file);
        let output_base = output_dir.join(&base);
        let ordinary = |cache: bool| {
            let mut args = common.clone();
            if cache {
                args.extend(accelerator.cache_args());
            }
            args.push("-o".to_owned());
            args.push(output_base.to_string_lossy().into_owned());
            args.push(source.to_string_lossy().into_owned());
            self.spawn(run, &binary.path, args, &cwd, timeout_ms)
        };
        let mut engine = Engine::Spawn;
        let mut fallback: Option<String> = None;
        let mut exit: Option<ProcessResult> = None;
        if run.cancelled() {
            return Ok(cancelled());
        }
        let unix = cfg!(any(target_os = "macos", target_os = "linux"));
        if accelerated && request.acceleration == Some(Acceleration::Auto) && unix {
            let mut args = common.clone();
            args.extend(accelerator.cache_args());
            args.push("-o".to_owned());
            args.push(base.clone());
            if let Some(worker) = accelerator.worker(root_file, &identity, &binary.path, &args) {
                {
                    let (accelerator, worker, root) =
                        (accelerator.clone(), worker.clone(), root_file.to_path_buf());
                    *lock(&run.stop) =
                        Some(Box::new(move || accelerator.release(&root, Some(&worker))));
                }
                let answer = worker.run(&source, &output_dir, timeout_ms).await;
                *lock(&run.stop) = None;
                match answer {
                    Ok(answer) => {
                        exit = Some(answer);
                        engine = Engine::Warm;
                    }
                    Err(error) => {
                        accelerator.failed_worker(root_file, &worker);
                        if run.cancelled() {
                            return Ok(cancelled());
                        }
                        fallback = Some(error);
                        // A failed worker may have written partial pages. Never collect them.
                        clear_output(&output_dir).await?;
                    }
                }
            }
        } else {
            accelerator.release(root_file, None);
        }
        let mut exit = match exit {
            Some(exit) => exit,
            None => {
                let cache = accelerated && fallback.is_none();
                let exit = ordinary(cache).await?;
                engine = if cache { Engine::Cache } else { Engine::Spawn };
                exit
            }
        };
        // Optimization errors must never prevent a normal compiler result.
        // Syntax errors are retried too; this costs time while a score is incomplete.
        if !run.cancelled() && engine != Engine::Spawn && exit.exit_code != Some(0) {
            fallback.get_or_insert_with(|| {
                "Accelerated compile failed; retried with ordinary LilyPond.".to_owned()
            });
            clear_output(&output_dir).await?;
            exit = ordinary(false).await?;
            engine = Engine::Spawn;
        }
        let exited = |partial: CompileResult| CompileResult {
            exit_code: exit.exit_code,
            stdout: exit.stdout.clone(),
            stderr: exit.stderr.clone(),
            ..partial
        };
        if run.cancelled() {
            return Ok(result(exited(CompileResult {
                cancelled: true,
                ..CompileResult::default()
            })));
        }

        let produced = read_names(&output_dir).await?;
        if let Some((format, target_dir)) = &mode.export {
            let mut names: Vec<&String> = produced
                .iter()
                .filter(|name| format.matches(name))
                .collect();
            names.sort();
            tokio::fs::create_dir_all(target_dir).await?;
            for name in &names {
                tokio::fs::copy(output_dir.join(name), target_dir.join(name)).await?;
            }
            *exported = names.iter().map(|name| target_dir.join(name)).collect();
        }
        // Re-checked after the last await: from here to the bookkeeping in
        // `run` nothing yields, so a superseded or disposed run is never kept.
        if run.cancelled() {
            return Ok(result(exited(CompileResult {
                cancelled: true,
                ..CompileResult::default()
            })));
        }
        let timing_name = format!("{base}.timing.json");
        let timing = produced
            .contains(&timing_name)
            .then(|| output_dir.join(&timing_name));
        let pages: Vec<PathBuf> = order_pages(&produced, &base)
            .into_iter()
            .map(|n| output_dir.join(n))
            .collect();
        if let Some(snapshot) = &snapshot {
            // The map links to the snapshot's files just as the pages do.
            for file in pages.iter().chain(timing.iter()) {
                let text = tokio::fs::read_to_string(file).await?;
                tokio::fs::write(file, snapshot.links(&text)).await?;
            }
        }
        if run.cancelled() {
            return Ok(result(exited(CompileResult {
                cancelled: true,
                ..CompileResult::default()
            })));
        }
        *keep_output = mode.keep;
        let midi = order_outputs(&produced, &base, &MIDI)
            .into_iter()
            .map(|n| output_dir.join(n))
            .collect();
        Ok(result(with_output(exited(CompileResult {
            snapshot,
            snapshot_ms: Some(snapshot_ms),
            engine: Some(engine),
            fallback,
            ok: exit.exit_code == Some(0),
            pages,
            midi,
            timing,
            ..CompileResult::default()
        }))))
    }

    /// Kills the in-flight compile for `root_file`, or every run, exports too, when `None`.
    pub fn cancel(&self, root_file: Option<&Path>) {
        match root_file {
            None => {
                let runs: Vec<Arc<Run>> = lock(&self.0.live).values().cloned().collect();
                for run in runs {
                    kill(&run);
                }
            }
            Some(root_file) => self.kill_key(&run_key(&paths::resolve(root_file))),
        }
    }

    /// Kills the export of `root_file` to `format`, if one is running.
    pub fn cancel_export(&self, root_file: &Path, format: ExportFormat) {
        self.kill_key(&export_key(&paths::resolve(root_file), format));
    }

    fn kill_key(&self, key: &str) {
        let run = lock(&self.0.live).get(key).cloned();
        if let Some(run) = run {
            kill(&run);
        }
    }

    /// Deletes the kept output of `root_file`, e.g. when its preview closes (D5).
    pub async fn release(&self, root_file: &Path) {
        self.cancel(Some(root_file));
        let root_file = paths::resolve(root_file);
        self.0.accelerator.release(&root_file, None);
        let dir = lock(&self.0.kept).remove(&run_key(&root_file));
        remove_dir(dir.as_deref()).await;
    }

    /// Kills every run and deletes every kept output directory.
    pub async fn dispose(&self) {
        self.cancel(None);
        self.0.accelerator.dispose();
        let dirs: Vec<PathBuf> = lock(&self.0.kept).drain().map(|(_, dir)| dir).collect();
        for dir in dirs {
            remove_dir(Some(&dir)).await;
        }
    }

    /// Runs lilypond, killed when the run is cancelled or `timeout_ms` (when
    /// not 0) passes. Fails only when it cannot be started.
    async fn spawn(
        &self,
        run: &Run,
        command: &Path,
        args: Vec<String>,
        cwd: &Path,
        timeout_ms: u64,
    ) -> std::io::Result<ProcessResult> {
        // cwd is the source directory so relative \include keeps working.
        let mut child = Command::new(command)
            .args(&args)
            .current_dir(cwd)
            .env("PATH", self.0.search_path.get())
            // lilypond translates the `error:` / `warning:` keywords with the
            // user's locale (`Fehler:` under de_DE). LANGUAGE overrides only the
            // message catalogue, so stderr stays parseable while the locale's
            // UTF-8 handling of paths is kept.
            .env("LANGUAGE", "en")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| spawn_error(command, error))?;
        let mut stdout = child.stdout.take();
        let mut stderr = child.stderr.take();
        let mut cancel = run.cancelled.subscribe();
        let wait = async {
            let timer = async {
                if timeout_ms > 0 {
                    tokio::time::sleep(Duration::from_millis(timeout_ms)).await;
                } else {
                    std::future::pending::<()>().await;
                }
            };
            tokio::select! {
                status = child.wait() => (status, false),
                () = until_cancelled(&mut cancel) => {
                    let _ = child.start_kill();
                    (child.wait().await, false)
                }
                () = timer => {
                    let _ = child.start_kill();
                    (child.wait().await, true)
                }
            }
        };
        let (out, err, (status, timed_out)) =
            tokio::join!(read_all(stdout.as_mut()), read_all(stderr.as_mut()), wait);
        let status = status?;
        let mut stderr = String::from_utf8_lossy(&err).into_owned();
        if timed_out {
            stderr.push_str("\nfatal error: LilyPond compile timed out.\n");
        }
        Ok(ProcessResult {
            exit_code: status.code(),
            stdout: String::from_utf8_lossy(&out).into_owned(),
            stderr,
        })
    }
}

async fn read_all<R: AsyncRead + Unpin>(pipe: Option<&mut R>) -> Vec<u8> {
    let mut bytes = Vec::new();
    if let Some(pipe) = pipe {
        let _ = pipe.read_to_end(&mut bytes).await;
    }
    bytes
}

async fn until_cancelled(cancel: &mut watch::Receiver<bool>) {
    if cancel.wait_for(|cancelled| *cancelled).await.is_err() {
        std::future::pending::<()>().await;
    }
}

fn kill(run: &Run) {
    if run.cancelled() {
        return;
    }
    run.cancelled.send_replace(true);
    // Nothing to flush: the run's directory is discarded anyway.
    let stop = lock(&run.stop).take();
    if let Some(stop) = stop {
        stop();
    }
}

static SVG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.svg$").expect("valid regex"));
static MIDI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.midi?$").expect("valid regex"));

/// Page files of one run, in reading order. One page is `<base>.svg`, several
/// are `<base>-1.svg`, `<base>-2.svg`, …; `\bookOutputSuffix` and
/// `\bookOutputName` add other stems. Numbers sort numerically, so `-10` follows `-9`.
pub fn order_pages(file_names: &[String], base: &str) -> Vec<String> {
    order_outputs(file_names, base, &SVG)
}

/// The files of one run with an `extension`, in the order lilypond wrote
/// them: `<base>`, then `<base>-1`, `<base>-2`, …, then other stems. MIDI
/// files are named like pages, one per `\midi` block (ARCHITECTURE §3.3).
pub fn order_outputs(file_names: &[String], base: &str, extension: &Regex) -> Vec<String> {
    let foreign = |name: &str| !name.starts_with(base);
    let suffix = |name: &str| {
        let stem = extension.replace(name, "").into_owned();
        if foreign(name) {
            stem
        } else {
            stem[base.len().min(stem.len())..].to_owned()
        }
    };
    let mut names: Vec<String> = file_names
        .iter()
        .filter(|name| extension.is_match(name))
        .cloned()
        .collect();
    names.sort_by(|a, b| {
        foreign(a)
            .cmp(&foreign(b))
            .then_with(|| compare(&suffix(a), &suffix(b), Sensitivity::Variant))
    });
    names
}

/// The `MIDI` pattern of `order_outputs`.
pub fn midi_pattern() -> &'static Regex {
    &MIDI
}

fn run_key(root_file: &Path) -> String {
    root_file.to_string_lossy().into_owned()
}

/// NUL cannot occur in a path, so an export never shares a slot with a compile.
fn export_key(root_file: &Path, format: ExportFormat) -> String {
    format!("{}\0{}", run_key(root_file), format.name())
}

/// `access(file, R_OK)`, with the path in the error.
fn readable(file: &Path) -> std::io::Result<()> {
    if crate::locate::access(file, libc::R_OK) {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    let (code, description) = describe(&error);
    Err(std::io::Error::new(
        error.kind(),
        format!("{code}: {description}, access '{}'", file.display()),
    ))
}

/// Node's spelling of an OS error: its code and libuv's lower-case description.
fn describe(error: &std::io::Error) -> (String, String) {
    let code = match error.raw_os_error() {
        Some(libc::ENOENT) => "ENOENT".to_owned(),
        Some(libc::EACCES) => "EACCES".to_owned(),
        Some(libc::EPERM) => "EPERM".to_owned(),
        Some(libc::ENOTDIR) => "ENOTDIR".to_owned(),
        Some(libc::EISDIR) => "EISDIR".to_owned(),
        Some(libc::ELOOP) => "ELOOP".to_owned(),
        Some(libc::ENAMETOOLONG) => "ENAMETOOLONG".to_owned(),
        Some(other) => format!("E{other}"),
        None => "EUNKNOWN".to_owned(),
    };
    let text = error.to_string();
    let text = text.split(" (os error").next().unwrap_or(&text);
    let mut chars = text.chars();
    let description = chars
        .next()
        .map(|first| first.to_lowercase().chain(chars).collect())
        .unwrap_or_default();
    (code, description)
}

/// A failure to start `command`, spelled as Node spells it.
fn spawn_error(command: &Path, error: std::io::Error) -> std::io::Error {
    let (code, _) = describe(&error);
    std::io::Error::new(error.kind(), format!("spawn {} {code}", command.display()))
}

/// `mkdtemp(<parent>/<prefix>XXXXXX)`.
pub(crate) fn make_temp_dir(parent: &Path, prefix: &str) -> std::io::Result<PathBuf> {
    let mut template = parent
        .join(format!("{prefix}XXXXXX"))
        .into_os_string()
        .into_vec();
    template.push(0);
    let template_c = CString::from_vec_with_nul(template).map_err(std::io::Error::other)?;
    let raw = template_c.into_raw();
    // SAFETY: `raw` is a writable NUL-terminated buffer that mkdtemp fills in
    // place; it is taken back into a CString right after.
    let made = unsafe { libc::mkdtemp(raw) };
    // SAFETY: `raw` came from `CString::into_raw` and its length is unchanged.
    let template_c = unsafe { CString::from_raw(raw) };
    if made.is_null() {
        return Err(std::io::Error::last_os_error());
    }
    Ok(PathBuf::from(std::ffi::OsStr::from_bytes(
        template_c.as_bytes(),
    )))
}

async fn read_names(dir: &Path) -> std::io::Result<Vec<String>> {
    let mut entries = tokio::fs::read_dir(dir).await?;
    let mut names = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    Ok(names)
}

/// Empties a run's directory, except the snapshot's sources.
async fn clear_output(dir: &Path) -> std::io::Result<()> {
    for name in read_names(dir).await? {
        if name == "sources" {
            continue;
        }
        let path = dir.join(&name);
        let removed = match tokio::fs::symlink_metadata(&path).await {
            Ok(meta) if meta.is_dir() => tokio::fs::remove_dir_all(&path).await,
            Ok(_) => tokio::fs::remove_file(&path).await,
            Err(error) => Err(error),
        };
        if let Err(error) = removed
            && error.kind() != std::io::ErrorKind::NotFound
        {
            return Err(error);
        }
    }
    Ok(())
}

pub(crate) async fn remove_dir(dir: Option<&Path>) {
    let Some(dir) = dir else { return };
    for _ in 0..4 {
        match tokio::fs::remove_dir_all(dir).await {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            _ => return,
        }
    }
}
