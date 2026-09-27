//! Compile on save and live for Lily Studio (DECISIONS D31, D33, D35, D36):
//! finds the score a saved file
//! belongs to, compiles it with a `CompileService` and parses lilypond's
//! stderr. Every compile of a score waits in a `LiveQueue` and reads the
//! unsaved texts live preview passes in `buffers` (D36). The PDF tab's compile
//! and Export PDF are here too (D33).

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use base64::Engine as _;
use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use serde::{Serialize, Serializer};

use crate::compiler::{
    Acceleration, CompileError, CompileRequest, CompileResult, CompileService, ExportFormat,
    ExportRequest, ExportResult,
};
use crate::live::LiveTarget;
use crate::live_queue::LiveQueue;
use crate::parse::{LyDiagnostic, LySeverity, parse_stderr};
use crate::paths;
use crate::root_file::{IncludeOptions, SourceBuffers, roots_including};

/// How a compile ended (D31). `no-root`: a saved include that no score in
/// the folder includes, so nothing ran. `no-lilypond` and `error`: lilypond
/// did not run, and `message` says why.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CompileState {
    Ok,
    Failed,
    NoRoot,
    NoLilypond,
    Error,
}

/// Where the notes of the MIDI are on the pages (D26), passed through as
/// `runtime/timing.ly` wrote them.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PlaybackTiming {
    pub events: Vec<serde_json::Value>,
    pub bars: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileOutcome {
    pub state: CompileState,
    /// The score that was compiled; for `no-root`, the saved file.
    pub root_file: PathBuf,
    /// Absolute files, 1-based lines and columns.
    pub diagnostics: Vec<LyDiagnostic>,
    pub error_count: usize,
    pub warning_count: usize,
    /// SVG pages of the run, in order; valid until the next compile of `root_file`.
    pub pages: Vec<PathBuf>,
    /// The text of `pages`, read before the event was sent; the preview shows it (D32).
    pub svg: Vec<String>,
    pub midi: Vec<PathBuf>,
    /// The bytes of the first of `midi`, read with the pages: the music the
    /// preview plays (D35). Base64 on the wire.
    #[serde(
        skip_serializing_if = "Option::is_none",
        serialize_with = "base64_option"
    )]
    pub midi_data: Option<Vec<u8>>,
    /// Where the notes of `midi_data` are on the pages (D26), when the map was written.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timing: Option<PlaybackTiming>,
    pub duration_ms: u64,
    /// Why lilypond did not run, or the end of its output when it failed
    /// without a parsable error.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PdfState {
    Ok,
    Failed,
    NoLilypond,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PdfFile {
    pub name: String,
    /// Base64 on the wire.
    #[serde(serialize_with = "base64_bytes")]
    pub data: Arc<[u8]>,
}

/// A score's PDF for the PDF tab (D33). `failed`: lilypond reported errors,
/// and `files` holds whatever it still wrote. `no-lilypond` and `error`: it
/// did not run, and `message` says why.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfOutcome {
    pub state: PdfState,
    pub root_file: PathBuf,
    /// The PDFs lilypond wrote, one per book, named as it names them.
    pub files: Vec<PdfFile>,
    pub error_count: usize,
    pub duration_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum CompileEvent {
    Started { root_file: PathBuf },
    Finished { outcome: Box<CompileOutcome> },
}

fn base64_bytes<S: Serializer>(data: &Arc<[u8]>, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&base64::engine::general_purpose::STANDARD.encode(data))
}

fn base64_option<S: Serializer>(data: &Option<Vec<u8>>, serializer: S) -> Result<S::Ok, S::Error> {
    match data {
        Some(data) => {
            serializer.serialize_str(&base64::engine::general_purpose::STANDARD.encode(data))
        }
        None => serializer.serialize_none(),
    }
}

/// The part of `CompileService` used here; tests pass a stand-in.
pub trait Compiler: Send + Sync + 'static {
    fn compile(
        &self,
        request: CompileRequest,
    ) -> BoxFuture<'static, Result<CompileResult, CompileError>>;
    fn export(
        &self,
        request: ExportRequest,
    ) -> BoxFuture<'static, Result<ExportResult, CompileError>>;
    fn dispose(&self) -> BoxFuture<'static, ()>;
}

impl Compiler for CompileService {
    fn compile(
        &self,
        request: CompileRequest,
    ) -> BoxFuture<'static, Result<CompileResult, CompileError>> {
        let service = self.clone();
        async move { CompileService::compile(&service, request).await }.boxed()
    }

    fn export(
        &self,
        request: ExportRequest,
    ) -> BoxFuture<'static, Result<ExportResult, CompileError>> {
        let service = self.clone();
        async move { CompileService::export(&service, request).await }.boxed()
    }

    fn dispose(&self) -> BoxFuture<'static, ()> {
        let service = self.clone();
        async move { CompileService::dispose(&service).await }.boxed()
    }
}

pub type Candidates = Arc<dyn Fn() -> BoxFuture<'static, Vec<PathBuf>> + Send + Sync>;
pub type Emit = Arc<dyn Fn(CompileEvent) + Send + Sync>;
pub type LilyPondPath = Arc<dyn Fn() -> Option<String> + Send + Sync>;
pub type Buffers = Arc<dyn Fn() -> SourceBuffers + Send + Sync>;

pub struct StudioCompilerOptions {
    pub compiler: Arc<dyn Compiler>,
    /// The `.ly` files that may include a saved `.ily`: the open folder's.
    pub candidates: Candidates,
    pub emit: Emit,
    /// The chosen lilypond, asked on every compile: the setup may change it
    /// (D37). `None`, or a `None` answer, means `PATH`, then well-known directories.
    pub lilypond_path: Option<LilyPondPath>,
    /// Parent of the PDF compiles' private directories. Defaults to the OS temp dir.
    pub tmp_root: Option<PathBuf>,
    /// The unsaved texts to compile instead of the files on disk (D36), read
    /// when a compile starts. None by default; see `LiveTexts::reader`.
    pub buffers: Option<Buffers>,
    /// For the SVG compiles, as `lily.preview.acceleration` (D25). Defaults to off.
    pub acceleration: Acceleration,
}

impl StudioCompilerOptions {
    pub fn new(
        compiler: Arc<dyn Compiler>,
        candidates: impl Fn() -> BoxFuture<'static, Vec<PathBuf>> + Send + Sync + 'static,
        emit: impl Fn(CompileEvent) + Send + Sync + 'static,
    ) -> Self {
        Self {
            compiler,
            candidates: Arc::new(candidates),
            emit: Arc::new(emit),
            lilypond_path: None,
            tmp_root: None,
            buffers: None,
            acceleration: Acceleration::Off,
        }
    }
}

/// Lines of stderr kept for a run that failed without a parsable error.
const TAIL_LINES: usize = 12;

type PdfFuture = Shared<BoxFuture<'static, Option<PdfOutcome>>>;

/// Tells the PDF compiles of a score apart.
static NEXT_PDF: AtomicU64 = AtomicU64::new(0);

struct Inner {
    options: StudioCompilerOptions,
    /// The score compiled last; preferred when an include belongs to several.
    last: Mutex<Option<PathBuf>>,
    /// The PDF of each score since its last compile, or the PDF compile running
    /// for it; a compile of the score drops it, as the sources changed.
    pdfs: Mutex<HashMap<PathBuf, (u64, PdfFuture)>>,
    /// One running and one waiting compile per score (D25): a newer request
    /// replaces the waiting one, and never kills a run about to finish.
    queue: LiveQueue<PathBuf, Option<CompileOutcome>, ()>,
}

/// Lily Studio's compiles. A cheap handle: clones share everything.
#[derive(Clone)]
pub struct StudioCompiler(Arc<Inner>);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl StudioCompiler {
    pub fn new(options: StudioCompilerOptions) -> Self {
        Self(Arc::new(Inner {
            options,
            last: Mutex::new(None),
            pdfs: Mutex::default(),
            queue: LiveQueue::new(),
        }))
    }

    /// The score compiled last, or asked for last.
    pub fn current(&self) -> Option<PathBuf> {
        lock(&self.0.last).clone()
    }

    /// Compiles the score `file` belongs to, after it was written. Resolves
    /// with the outcome that was emitted, or `None` when a newer compile of the
    /// same score took over; that one reports instead.
    pub async fn saved(&self, file: &Path) -> Option<CompileOutcome> {
        let file = paths::resolve(file);
        let Some(root_file) = self.root_for(&file).await else {
            let outcome = empty(CompileState::NoRoot, file);
            (self.0.options.emit)(CompileEvent::Finished {
                outcome: Box::new(outcome.clone()),
            });
            return Some(outcome);
        };
        self.compile(&root_file).await
    }

    /// A `.ly` file is its own score. An include belongs to the scores whose
    /// `\include` chains reach it (D10, D18): the last compiled score first,
    /// then the folder's `.ly` files in list order.
    pub async fn root_for(&self, file: &Path) -> Option<PathBuf> {
        if paths::extension_lower(file) == ".ly" {
            return Some(file.to_path_buf());
        }
        let candidates = (self.0.options.candidates)().await;
        let mut roots: Vec<PathBuf> = self.current().into_iter().collect();
        for candidate in candidates
            .into_iter()
            .filter(|f| paths::extension_lower(f) == ".ly")
        {
            if !roots.contains(&candidate) {
                roots.push(candidate);
            }
        }
        // An unreadable file reaches nothing; the others still count.
        let buffers = self.0.options.buffers.as_ref().map(|buffers| buffers());
        let reached = roots_including(file, &roots, |_| IncludeOptions {
            buffers: buffers.clone(),
            ..IncludeOptions::default()
        })
        .await;
        reached.into_iter().next()
    }

    /// Compiles `root_file` once the compile of it that is running has been
    /// reported. Queued at the call (the returned future need not be polled
    /// for it to run); resolves `None` when a newer request replaced this one
    /// before it started, or the run was cancelled; that one reports instead.
    pub fn compile(
        &self,
        root_file: &Path,
    ) -> impl Future<Output = Option<CompileOutcome>> + Send + 'static {
        let root_file = root_file.to_path_buf();
        *lock(&self.0.last) = Some(root_file.clone());
        let this = self.clone();
        let root = root_file.clone();
        let queued = self
            .0
            .queue
            .request(root_file, move || async move { Ok(this.run(&root).await) });
        async move { queued.await.ok().flatten().flatten() }
    }

    async fn run(&self, root_file: &Path) -> Option<CompileOutcome> {
        lock(&self.0.pdfs).remove(root_file);
        let options = &self.0.options;
        // Taken now, not when asked: the texts as they are when lilypond starts.
        let buffers = options.buffers.as_ref().map(|buffers| buffers());
        (options.emit)(CompileEvent::Started {
            root_file: root_file.to_path_buf(),
        });
        let request = CompileRequest {
            root_file: root_file.to_path_buf(),
            lilypond_path: self.lilypond_path(),
            buffers: buffers.filter(|b| !b.is_empty()),
            acceleration: Some(options.acceleration),
            ..CompileRequest::default()
        };
        let outcome = match options.compiler.compile(request).await {
            Ok(result) if result.cancelled => return None,
            Ok(result) => {
                let mut outcome = from_result(&result);
                outcome.svg = read_pages(&result.pages).await;
                let (midi_data, timing) = read_playback(&result).await;
                outcome.midi_data = midi_data;
                outcome.timing = timing;
                outcome
            }
            Err(error) => {
                let state = if matches!(error, CompileError::NotFound(_)) {
                    CompileState::NoLilypond
                } else {
                    CompileState::Error
                };
                CompileOutcome {
                    message: Some(error.to_string()),
                    ..empty(state, root_file.to_path_buf())
                }
            }
        };
        (options.emit)(CompileEvent::Finished {
            outcome: Box::new(outcome.clone()),
        });
        Some(outcome)
    }

    /// The PDF of `root_file` for the PDF tab: compiled once more with `--pdf`
    /// into a private directory that is deleted at once, so nothing is written
    /// next to the score. Kept until the score compiles again. Resolves `None`
    /// when a newer PDF compile of the score took over.
    pub fn pdf(
        &self,
        root_file: &Path,
    ) -> impl Future<Output = Option<PdfOutcome>> + Send + 'static {
        let root_file = root_file.to_path_buf();
        let mut pdfs = lock(&self.0.pdfs);
        if let Some((_, kept)) = pdfs.get(&root_file) {
            return kept.clone();
        }
        let id = NEXT_PDF.fetch_add(1, Ordering::Relaxed);
        let this = self.clone();
        let root = root_file.clone();
        let pending: PdfFuture = async move {
            let outcome = this.compile_pdf(&root).await;
            // Only a PDF that engraved is kept; anything else is tried again when asked.
            if outcome.as_ref().is_none_or(|o| o.state != PdfState::Ok) {
                let mut pdfs = lock(&this.0.pdfs);
                if pdfs.get(&root).is_some_and(|(kept, _)| *kept == id) {
                    pdfs.remove(&root);
                }
            }
            outcome
        }
        .boxed()
        .shared();
        pdfs.insert(root_file, (id, pending.clone()));
        drop(pdfs);
        // It runs whether or not anyone waits for it, as the promise did.
        tokio::spawn(pending.clone());
        pending
    }

    /// Export PDF: writes the PDF of `root_file` into the score's directory,
    /// replacing files of the same name, and resolves with their paths. Only
    /// when asked, and only a PDF that engraved without errors.
    pub async fn export_pdf(&self, root_file: &Path) -> Result<Vec<PathBuf>, String> {
        let mut outcome = self.pdf(root_file).await;
        // Superseded by a PDF compile of newer sources: wait for that one.
        if outcome.is_none() {
            outcome = self.pdf(root_file).await;
        }
        let Some(outcome) = outcome else {
            return Err("The PDF was not engraved; try again.".to_owned());
        };
        if outcome.state != PdfState::Ok || outcome.files.is_empty() {
            return Err(outcome.message.clone().unwrap_or_else(|| {
                "The score has errors, so there is no PDF to export. Fix them first.".to_owned()
            }));
        }
        let dir = paths::dirname(root_file);
        let mut written = Vec::new();
        for file in &outcome.files {
            let target = dir.join(&file.name);
            tokio::fs::write(&target, &file.data)
                .await
                .map_err(|e| format!("{e}, open '{}'", target.display()))?;
            written.push(target);
        }
        Ok(written)
    }

    async fn compile_pdf(&self, root_file: &Path) -> Option<PdfOutcome> {
        let tmp_root = self
            .0
            .options
            .tmp_root
            .clone()
            .unwrap_or_else(std::env::temp_dir);
        let failed = |error: CompileError| {
            let state = if matches!(error, CompileError::NotFound(_)) {
                PdfState::NoLilypond
            } else {
                PdfState::Error
            };
            Some(PdfOutcome {
                state,
                root_file: root_file.to_path_buf(),
                files: Vec::new(),
                error_count: 0,
                duration_ms: 0,
                message: Some(error.to_string()),
            })
        };
        let target_dir = match crate::compiler::make_temp_dir(&tmp_root, "lily-studio-pdf-") {
            Ok(dir) => dir,
            Err(error) => return failed(error.into()),
        };
        let outcome = async {
            let request = ExportRequest {
                request: CompileRequest {
                    root_file: root_file.to_path_buf(),
                    lilypond_path: self.lilypond_path(),
                    acceleration: Some(Acceleration::Off),
                    ..CompileRequest::default()
                },
                format: ExportFormat::Pdf,
                target_dir: Some(target_dir.clone()),
            };
            let exported = match self.0.options.compiler.export(request).await {
                Ok(exported) => exported,
                Err(error) => return failed(error),
            };
            if exported.result.cancelled {
                return None;
            }
            let mut files = Vec::new();
            for file in &exported.exported {
                match tokio::fs::read(file).await {
                    Ok(data) => files.push(PdfFile {
                        name: paths::basename(file),
                        data: data.into(),
                    }),
                    Err(error) => return failed(error.into()),
                }
            }
            let summary = from_result(&exported.result);
            Some(PdfOutcome {
                state: if summary.state == CompileState::Ok {
                    PdfState::Ok
                } else {
                    PdfState::Failed
                },
                root_file: root_file.to_path_buf(),
                files,
                error_count: summary.error_count,
                duration_ms: exported.result.duration_ms,
                message: summary.message,
            })
        }
        .await;
        let _ = tokio::fs::remove_dir_all(&target_dir).await;
        outcome
    }

    fn lilypond_path(&self) -> Option<String> {
        self.0
            .options
            .lilypond_path
            .as_ref()
            .and_then(|path| path())
    }

    pub async fn dispose(&self) {
        self.0.options.compiler.dispose().await;
    }
}

impl LiveTarget for StudioCompiler {
    fn current(&self) -> Option<PathBuf> {
        StudioCompiler::current(self)
    }

    fn root_for(&self, file: PathBuf) -> BoxFuture<'static, Option<PathBuf>> {
        let this = self.clone();
        async move { this.root_for(&file).await }.boxed()
    }

    fn compile(&self, root: PathBuf) -> BoxFuture<'static, Option<CompileOutcome>> {
        StudioCompiler::compile(self, &root).boxed()
    }
}

/// The text of the pages for the preview, read now: the run's directory is
/// emptied when the next compile of the score ends. A page that is gone
/// already leaves none.
async fn read_pages(pages: &[PathBuf]) -> Vec<String> {
    let mut texts = Vec::new();
    for page in pages {
        match tokio::fs::read_to_string(page).await {
            Ok(text) => texts.push(text),
            Err(_) => return Vec::new(),
        }
    }
    texts
}

/// The music the preview plays (D35), read now for the same reason as the
/// pages: the first MIDI file of the run, as the extension's preview plays
/// (D24), and its entry of the playback map (D26). A map that cannot be read
/// only costs the playhead.
async fn read_playback(result: &CompileResult) -> (Option<Vec<u8>>, Option<PlaybackTiming>) {
    let Some(first) = result.midi.first() else {
        return (None, None);
    };
    let Ok(midi_data) = tokio::fs::read(first).await else {
        return (None, None);
    };
    let timing = match &result.timing {
        Some(file) => read_timing(file, 0).await,
        None => None,
    };
    (Some(midi_data), timing)
}

/// Entry `index` of the playback map `runtime/timing.ly` writes, when it has
/// events and bars; `None` when the file cannot be read or parsed.
pub async fn read_timing(file: &Path, index: usize) -> Option<PlaybackTiming> {
    let text = tokio::fs::read_to_string(file).await.ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&text).ok()?;
    let entry = parsed.as_array()?.get(index)?;
    let events = entry.get("events")?.as_array()?.clone();
    let bars = entry.get("bars")?.as_array()?.clone();
    Some(PlaybackTiming { events, bars })
}

fn empty(state: CompileState, root_file: PathBuf) -> CompileOutcome {
    CompileOutcome {
        state,
        root_file,
        diagnostics: Vec::new(),
        error_count: 0,
        warning_count: 0,
        pages: Vec::new(),
        svg: Vec::new(),
        midi: Vec::new(),
        midi_data: None,
        timing: None,
        duration_ms: 0,
        message: None,
    }
}

/// The outcome of a finished run, without the page texts and the music.
pub fn from_result(result: &CompileResult) -> CompileOutcome {
    // A compile of unsaved texts names the snapshot's files (D25); the markers need the real ones.
    let diagnostics: Vec<LyDiagnostic> = parse_stderr(&result.stderr, &result.root_file, None)
        .into_iter()
        .map(|d| {
            result
                .snapshot
                .as_ref()
                .map_or_else(|| d.clone(), |s| s.diagnostic(&d))
        })
        .collect();
    let error_count = diagnostics
        .iter()
        .filter(|d| d.severity == LySeverity::Error)
        .count();
    let mut outcome = CompileOutcome {
        state: if result.ok {
            CompileState::Ok
        } else {
            CompileState::Failed
        },
        root_file: result.root_file.clone(),
        warning_count: diagnostics.len() - error_count,
        diagnostics,
        error_count,
        pages: result.pages.clone(),
        midi: result.midi.clone(),
        duration_ms: result.duration_ms,
        ..empty(CompileState::Ok, PathBuf::new())
    };
    // A crash or a Guile backtrace: nothing parsed, so show how the output ends.
    if !result.ok && error_count == 0 {
        let lines: Vec<&str> = result
            .stderr
            .trim_end_matches(crate::span::is_js_space)
            .split('\n')
            .map(|l| l.strip_suffix('\r').unwrap_or(l))
            .collect();
        let tail = lines[lines.len().saturating_sub(TAIL_LINES)..].join("\n");
        outcome.message = Some(if tail.is_empty() {
            let code = result
                .exit_code
                .map_or_else(|| "null".to_owned(), |c| c.to_string());
            format!("lilypond exited with code {code}")
        } else {
            tail
        });
    }
    outcome
}
