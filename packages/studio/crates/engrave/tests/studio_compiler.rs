//! From studio/test/compileService.test.ts, pdfExport.test.ts, the
//! StudioCompiler parts of liveCompile.test.ts, and the compiles of
//! lilypondSetup.test.ts and preview.test.ts.

mod common;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use common::{Scratch, listing};
use futures::FutureExt;
use futures::future::BoxFuture;
use lily_engrave::compile_service::{PdfState, from_result};
use lily_engrave::{
    Acceleration, Access, CompileError, CompileEvent, CompileRequest, CompileResult,
    CompileService, CompileServiceOptions, CompileState, Compiler, ExportRequest, ExportResult,
    LilyPondNotFound, SourceBuffers, StudioCompiler, StudioCompilerOptions, parse_text_edit, span,
    templates,
};
use tokio::sync::oneshot;

type Answer = Arc<dyn Fn(&CompileRequest) -> Result<CompileResult, CompileError> + Send + Sync>;
type ExportAnswer = Arc<
    dyn Fn(&ExportRequest) -> Result<(Option<String>, CompileResult), CompileError> + Send + Sync,
>;

/// A CompileService stand-in: answers compiles with `answer`, and writes the
/// export's `score.pdf` with the bytes `export` gives, as lilypond would.
struct StandIn {
    requests: Mutex<Vec<CompileRequest>>,
    exports: Mutex<Vec<ExportRequest>>,
    answer: Answer,
    export: ExportAnswer,
}

fn ok(request: &CompileRequest) -> CompileResult {
    CompileResult {
        root_file: request.root_file.clone(),
        ok: true,
        exit_code: Some(0),
        duration_ms: 5,
        ..Default::default()
    }
}

impl StandIn {
    fn new(
        answer: impl Fn(&CompileRequest) -> Result<CompileResult, CompileError> + Send + Sync + 'static,
    ) -> Arc<StandIn> {
        Arc::new(StandIn {
            requests: Mutex::default(),
            exports: Mutex::default(),
            answer: Arc::new(answer),
            export: Arc::new(|request| Ok((Some("%PDF-1".into()), ok(&request.request)))),
        })
    }

    fn exporting(
        export: impl Fn(&ExportRequest) -> Result<(Option<String>, CompileResult), CompileError>
        + Send
        + Sync
        + 'static,
    ) -> Arc<StandIn> {
        Arc::new(StandIn {
            requests: Mutex::default(),
            exports: Mutex::default(),
            answer: Arc::new(|request| Ok(ok(request))),
            export: Arc::new(export),
        })
    }

    fn roots(&self) -> Vec<PathBuf> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|r| r.root_file.clone())
            .collect()
    }
}

impl Compiler for StandIn {
    fn compile(
        &self,
        request: CompileRequest,
    ) -> BoxFuture<'static, Result<CompileResult, CompileError>> {
        let answer = (self.answer)(&request);
        self.requests.lock().unwrap().push(request);
        async move { answer }.boxed()
    }

    fn export(
        &self,
        request: ExportRequest,
    ) -> BoxFuture<'static, Result<ExportResult, CompileError>> {
        self.exports.lock().unwrap().push(request.clone());
        let reply = (self.export)(&request);
        async move {
            let (bytes, result) = reply?;
            let mut exported = Vec::new();
            if let Some(bytes) = bytes {
                let stem = lily_engrave::paths::stem(&request.request.root_file);
                let file = request
                    .target_dir
                    .clone()
                    .unwrap_or_default()
                    .join(format!("{stem}.pdf"));
                tokio::fs::write(&file, bytes).await?;
                exported.push(file);
            }
            Ok(ExportResult {
                result: CompileResult {
                    duration_ms: 3,
                    ..result
                },
                exported,
            })
        }
        .boxed()
    }

    fn dispose(&self) -> BoxFuture<'static, ()> {
        async {}.boxed()
    }
}

type Events = Arc<Mutex<Vec<CompileEvent>>>;

fn studio(compiler: Arc<dyn Compiler>, candidates: Vec<PathBuf>) -> (StudioCompiler, Events) {
    let events: Events = Arc::default();
    let sink = events.clone();
    let options = StudioCompilerOptions::new(
        compiler,
        move || {
            let candidates = candidates.clone();
            async move { candidates }.boxed()
        },
        move |event| sink.lock().unwrap().push(event),
    );
    (StudioCompiler::new(options), events)
}

async fn folder() -> Scratch {
    let s = Scratch::new("lily-studio-compile-");
    s.write("solo.ly", "\\version \"2.24.0\"\n{ c4 }\n").await;
    s.write(
        "song.ly",
        "\\version \"2.24.0\"\n\\include \"parts/melody.ily\"\n{ \\melody }\n",
    )
    .await;
    s.write("parts/melody.ily", "melody = { g1 }\n").await;
    s.write("parts/unused.ily", "unused = { a1 }\n").await;
    s
}

fn candidates(s: &Scratch) -> Vec<PathBuf> {
    ["solo.ly", "song.ly", "parts/melody.ily", "parts/unused.ily"]
        .map(|f| s.at(f))
        .to_vec()
}

fn kinds(events: &Events) -> Vec<&'static str> {
    events
        .lock()
        .unwrap()
        .iter()
        .map(|e| match e {
            CompileEvent::Started { .. } => "started",
            CompileEvent::Finished { .. } => "finished",
        })
        .collect()
}

#[tokio::test]
async fn a_saved_ly_file_compiles_itself_and_reports_parsed_diagnostics() {
    let s = folder().await;
    let song = s.at("song.ly");
    let stderr = format!(
        "{0}:3:4: error: unknown command: `\\melodyy'\n{{ \\melodyy }}\n   \nparts/melody.ily:1:10: warning: bar check failed\nfatal error: failed files: \"{0}\"\n",
        song.display()
    );
    let compiler = StandIn::new(move |r| {
        Ok(CompileResult {
            ok: false,
            exit_code: Some(1),
            stderr: stderr.clone(),
            ..ok(r)
        })
    });
    let (studio, events) = studio(compiler.clone(), candidates(&s));
    let outcome = studio.saved(&song).await.expect("an outcome");
    assert_eq!(compiler.roots(), std::slice::from_ref(&song));
    assert_eq!(
        compiler.requests.lock().unwrap()[0].acceleration,
        Some(Acceleration::Off)
    );
    assert_eq!(outcome.state, CompileState::Failed);
    assert_eq!((outcome.error_count, outcome.warning_count), (1, 1));
    // Relative paths are resolved against the score's directory; the summary line is dropped.
    let summary: Vec<_> = outcome
        .diagnostics
        .iter()
        .map(|d| (d.file.clone(), d.line, d.column))
        .collect();
    assert_eq!(
        summary,
        [
            (song.clone(), 3, Some(4)),
            (s.at("parts/melody.ily"), 1, Some(10))
        ]
    );
    assert_eq!(outcome.message, None);
    assert_eq!(
        *events.lock().unwrap(),
        [
            CompileEvent::Started { root_file: song },
            CompileEvent::Finished {
                outcome: Box::new(outcome)
            }
        ]
    );
}

#[tokio::test]
async fn a_saved_include_compiles_the_score_that_includes_it() {
    let s = folder().await;
    let compiler = StandIn::new(|r| Ok(ok(r)));
    let (studio, events) = studio(compiler.clone(), candidates(&s));
    let outcome = studio
        .saved(&s.at("parts/melody.ily"))
        .await
        .expect("an outcome");
    assert_eq!(compiler.roots(), [s.at("song.ly")]);
    assert_eq!(outcome.state, CompileState::Ok);
    assert_eq!(events.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn the_score_compiled_last_is_preferred_for_a_shared_include() {
    let s = folder().await;
    s.write(
        "other.ly",
        "\\version \"2.24.0\"\n\\include \"parts/melody.ily\"\n{ \\melody }\n",
    )
    .await;
    let compiler = StandIn::new(|r| Ok(ok(r)));
    let (studio, _) = studio(compiler.clone(), candidates(&s));
    studio.saved(&s.at("other.ly")).await;
    studio.saved(&s.at("parts/melody.ily")).await;
    assert_eq!(compiler.roots(), [s.at("other.ly"), s.at("other.ly")]);
}

#[tokio::test]
async fn an_include_that_no_score_reaches_compiles_nothing() {
    let s = folder().await;
    let compiler = StandIn::new(|r| Ok(ok(r)));
    let (studio, events) = studio(compiler.clone(), candidates(&s));
    let outcome = studio
        .saved(&s.at("parts/unused.ily"))
        .await
        .expect("an outcome");
    assert!(compiler.roots().is_empty());
    assert_eq!(outcome.state, CompileState::NoRoot);
    assert_eq!(outcome.root_file, s.at("parts/unused.ily"));
    assert_eq!(
        *events.lock().unwrap(),
        [CompileEvent::Finished {
            outcome: Box::new(outcome)
        }]
    );
}

#[tokio::test]
async fn a_superseded_compile_reports_nothing() {
    let s = folder().await;
    let (studio, events) = studio(
        StandIn::new(|r| {
            Ok(CompileResult {
                cancelled: true,
                ..ok(r)
            })
        }),
        candidates(&s),
    );
    assert_eq!(studio.saved(&s.at("solo.ly")).await, None);
    assert_eq!(kinds(&events), ["started"]);
}

#[tokio::test]
async fn a_missing_lilypond_and_a_failed_start_are_told_apart() {
    let s = folder().await;
    let (missing, _) = studio(
        StandIn::new(|_| {
            Err(CompileError::NotFound(LilyPondNotFound::new(
                "LilyPond was not found.",
                None,
            )))
        }),
        candidates(&s),
    );
    let outcome = missing.saved(&s.at("solo.ly")).await.expect("an outcome");
    assert_eq!(outcome.state, CompileState::NoLilypond);
    assert_eq!(outcome.message.as_deref(), Some("LilyPond was not found."));
    let (broken, _) = studio(
        StandIn::new(|_| Err(CompileError::Io(std::io::Error::other("spawn EACCES")))),
        candidates(&s),
    );
    assert_eq!(
        broken
            .saved(&s.at("solo.ly"))
            .await
            .expect("an outcome")
            .state,
        CompileState::Error
    );
}

#[tokio::test]
async fn a_failure_without_a_parsable_error_keeps_the_end_of_stderr() {
    let s = folder().await;
    let (studio, _) = studio(
        StandIn::new(|r| {
            Ok(CompileResult {
                ok: false,
                exit_code: Some(1),
                stderr: "Backtrace:\nIn procedure car: Wrong type\n".into(),
                ..ok(r)
            })
        }),
        candidates(&s),
    );
    let outcome = studio.saved(&s.at("solo.ly")).await.expect("an outcome");
    assert_eq!(outcome.state, CompileState::Failed);
    assert_eq!(
        outcome.message.as_deref(),
        Some("Backtrace:\nIn procedure car: Wrong type")
    );
    let silent = from_result(&CompileResult {
        root_file: s.at("solo.ly"),
        exit_code: None,
        ..Default::default()
    });
    assert_eq!(
        silent.message.as_deref(),
        Some("lilypond exited with code null")
    );
}

#[tokio::test]
async fn events_serialize_as_the_typescript_shapes() {
    let started = serde_json::to_value(CompileEvent::Started {
        root_file: "/s/a.ly".into(),
    })
    .unwrap();
    assert_eq!(
        started,
        serde_json::json!({ "kind": "started", "rootFile": "/s/a.ly" })
    );
    let mut outcome = from_result(&CompileResult {
        root_file: "/s/a.ly".into(),
        ok: true,
        duration_ms: 7,
        ..Default::default()
    });
    outcome.midi_data = Some(b"MThd".to_vec());
    let finished = serde_json::to_value(CompileEvent::Finished {
        outcome: Box::new(outcome),
    })
    .unwrap();
    assert_eq!(
        finished,
        serde_json::json!({ "kind": "finished", "outcome": {
            "state": "ok", "rootFile": "/s/a.ly", "diagnostics": [], "errorCount": 0, "warningCount": 0,
            "pages": [], "svg": [], "midi": [], "midiData": "TVRoZA==", "durationMs": 7,
        }})
    );
    let missing = from_result(&CompileResult {
        root_file: "/s/a.ly".into(),
        ..Default::default()
    });
    assert_eq!(serde_json::to_value(missing.state).unwrap(), "failed");
    assert_eq!(
        serde_json::to_value(CompileState::NoLilypond).unwrap(),
        "no-lilypond"
    );
    assert_eq!(
        serde_json::to_value(CompileState::NoRoot).unwrap(),
        "no-root"
    );
}

fn service() -> CompileService {
    CompileService::new(CompileServiceOptions {
        search_path: common::search_path(),
        ..Default::default()
    })
}

#[tokio::test]
async fn a_score_with_a_mistake_yields_its_error_in_the_included_file() {
    if common::lilypond("studio compile").await.is_none() {
        return;
    }
    let s = folder().await;
    let melody = s
        .write("real/parts/tune.ily", "tune = { c4 d \\stacato e f }\n")
        .await;
    s.write(
        "real/score.ly",
        "\\version \"2.24.0\"\n\\include \"parts/tune.ily\"\n{ \\tune }\n",
    )
    .await;
    let (studio, _) = studio(
        Arc::new(service()),
        vec![s.at("real/score.ly"), melody.clone()],
    );
    let outcome = studio.saved(&melody).await.expect("an outcome");
    assert_eq!(outcome.state, CompileState::Failed);
    let first = &outcome.diagnostics[0];
    assert_eq!((first.file.clone(), first.line), (melody.clone(), 1));
    assert!(first.message.contains("stacato"));
    s.write("real/parts/tune.ily", "tune = { c4 d e f }\n")
        .await;
    let fixed = studio.saved(&melody).await.expect("an outcome");
    assert_eq!(fixed.state, CompileState::Ok);
    assert_eq!(fixed.error_count, 0);
    assert!(!fixed.pages.is_empty());
    studio.dispose().await;
}

// liveCompile.test.ts: StudioCompiler with live buffers.

#[tokio::test]
async fn compiles_wait_for_the_running_one_a_newer_request_replaces_the_waiting_one() {
    struct Held {
        requests: Mutex<Vec<CompileRequest>>,
        releases: Mutex<Vec<oneshot::Sender<()>>>,
    }
    impl Compiler for Held {
        fn compile(
            &self,
            request: CompileRequest,
        ) -> BoxFuture<'static, Result<CompileResult, CompileError>> {
            let (release, released) = oneshot::channel();
            self.releases.lock().unwrap().push(release);
            let result = ok(&request);
            self.requests.lock().unwrap().push(request);
            async move {
                let _ = released.await;
                Ok(result)
            }
            .boxed()
        }
        fn export(
            &self,
            _: ExportRequest,
        ) -> BoxFuture<'static, Result<ExportResult, CompileError>> {
            async { Err(CompileError::Io(std::io::Error::other("no export here"))) }.boxed()
        }
        fn dispose(&self) -> BoxFuture<'static, ()> {
            async {}.boxed()
        }
    }
    let held = Arc::new(Held {
        requests: Mutex::default(),
        releases: Mutex::default(),
    });
    let text = Arc::new(Mutex::new("{ c }".to_owned()));
    let events: Events = Arc::default();
    let sink = events.clone();
    let mut options = StudioCompilerOptions::new(
        held.clone(),
        || async { Vec::new() }.boxed(),
        move |e| sink.lock().unwrap().push(e),
    );
    let current = text.clone();
    options.buffers = Some(Arc::new(move || {
        [(
            PathBuf::from("/s/score.ly"),
            current.lock().unwrap().clone(),
        )]
        .into_iter()
        .collect()
    }));
    options.acceleration = Acceleration::Auto;
    let studio = StudioCompiler::new(options);
    let score = Path::new("/s/score.ly");
    let first = tokio::spawn(studio.compile(score));
    common::sleep(20).await;
    *text.lock().unwrap() = "{ c d }".into();
    let replaced = tokio::spawn(studio.compile(score));
    *text.lock().unwrap() = "{ c d e }".into();
    let second = tokio::spawn(studio.compile(score));
    common::sleep(20).await;
    assert_eq!(
        held.requests.lock().unwrap().len(),
        1,
        "nothing more starts while one runs"
    );
    let release = held.releases.lock().unwrap().remove(0);
    release.send(()).unwrap();
    assert_eq!(
        first.await.unwrap().map(|o| o.state),
        Some(CompileState::Ok)
    );
    common::sleep(20).await;
    assert_eq!(held.requests.lock().unwrap().len(), 2);
    let release = held.releases.lock().unwrap().remove(0);
    release.send(()).unwrap();
    // The waiting request that was replaced resolves with its successor's outcome.
    let (replaced, second) = (replaced.await.unwrap(), second.await.unwrap());
    assert!(second.is_some());
    assert_eq!(replaced, second);
    let requests = held.requests.lock().unwrap();
    let texts: Vec<_> = requests
        .iter()
        .map(|r| r.buffers.as_ref().and_then(|b| b.get(score)).cloned())
        .collect();
    assert_eq!(
        texts,
        [Some("{ c }".to_owned()), Some("{ c d e }".to_owned())]
    );
    assert!(
        requests
            .iter()
            .all(|r| r.acceleration == Some(Acceleration::Auto))
    );
    assert_eq!(
        kinds(&events),
        ["started", "finished", "started", "finished"]
    );
}

#[tokio::test]
async fn unsaved_texts_engrave_and_their_errors_and_links_name_the_real_files() {
    if common::lilypond("live compile").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-studio-live-");
    let score = s
        .write(
            "real/score.ly",
            "\\version \"2.24.0\"\n\\include \"parts/tune.ily\"\n{ \\tune }\n",
        )
        .await;
    let tune = s
        .write("real/parts/tune.ily", "tune = { c4 d e f }\n")
        .await;
    let buffers: Arc<Mutex<SourceBuffers>> = Arc::new(Mutex::new(
        [(tune.clone(), "tune = { c4 d \\stacato e f }\n".to_owned())]
            .into_iter()
            .collect(),
    ));
    let (compiler, _) = {
        let mut options = StudioCompilerOptions::new(
            Arc::new(service()),
            || async { Vec::new() }.boxed(),
            |_| {},
        );
        let reader = buffers.clone();
        options.buffers = Some(Arc::new(move || reader.lock().unwrap().clone()));
        (StudioCompiler::new(options), ())
    };
    let failed = compiler.compile(&score).await.expect("an outcome");
    assert_eq!(failed.state, CompileState::Failed);
    let first = &failed.diagnostics[0];
    assert_eq!((first.file.clone(), first.line), (tune.clone(), 1));
    assert!(first.message.contains("stacato"));
    // The unsaved score adds a note; the page links to the real score, not the snapshot.
    *buffers.lock().unwrap() = [(
        score.clone(),
        "\\version \"2.24.0\"\n\\include \"parts/tune.ily\"\n{ \\tune g4 }\n".to_owned(),
    )]
    .into_iter()
    .collect();
    let fixed = compiler.compile(&score).await.expect("an outcome");
    assert_eq!(fixed.state, CompileState::Ok);
    let svg = fixed.svg.join("");
    assert!(
        svg.contains(&format!("textedit://{}:3:", score.display())),
        "a link to the unsaved note in score.ly"
    );
    assert!(
        svg.contains(&format!("textedit://{}:1:", tune.display())),
        "links to the include on disk"
    );
    assert!(!svg.contains("/sources/"), "no link to the snapshot");
    // The disk was never written.
    assert_eq!(
        tokio::fs::read_to_string(&tune).await.unwrap(),
        "tune = { c4 d e f }\n"
    );
    compiler.dispose().await;
}

// pdfExport.test.ts: the PDF tab and Export PDF (DECISIONS D33).

async fn score_folder(s: &Scratch, name: &str) -> PathBuf {
    s.write(
        &format!("{name}/score.ly"),
        "\\version \"2.24.0\"\n{ c4 }\n",
    )
    .await
}

fn pdf_studio(s: &Scratch, compiler: Arc<StandIn>) -> StudioCompiler {
    let mut options = StudioCompilerOptions::new(compiler, || async { Vec::new() }.boxed(), |_| {});
    options.tmp_root = Some(s.at("tmp"));
    StudioCompiler::new(options)
}

async fn pdf_scratch() -> Scratch {
    let s = Scratch::new("lily-studio-pdf-test-");
    tokio::fs::create_dir_all(s.at("tmp")).await.unwrap();
    s
}

fn text(data: &[u8]) -> String {
    String::from_utf8_lossy(data).into_owned()
}

fn counter() -> Arc<Mutex<u32>> {
    Arc::default()
}

#[tokio::test]
async fn a_pdf_is_compiled_into_a_private_directory_that_is_gone_afterwards() {
    let s = pdf_scratch().await;
    let score = score_folder(&s, "private").await;
    let compiler = StandIn::new(|r| Ok(ok(r)));
    let studio = pdf_studio(&s, compiler.clone());
    let outcome = studio.pdf(&score).await.expect("an outcome");
    assert_eq!(outcome.state, PdfState::Ok);
    assert_eq!(
        outcome
            .files
            .iter()
            .map(|f| (f.name.clone(), text(&f.data)))
            .collect::<Vec<_>>(),
        [("score.pdf".into(), "%PDF-1".into())]
    );
    let exports = compiler.exports.lock().unwrap().clone();
    assert_eq!(exports[0].format, lily_engrave::ExportFormat::Pdf);
    assert_eq!(exports[0].request.acceleration, Some(Acceleration::Off));
    assert_ne!(
        exports[0].target_dir.as_deref().and_then(Path::parent),
        score.parent()
    );
    assert_eq!(listing(&s.at("tmp")).await, Vec::<String>::new());
    // Nothing next to the score until Export PDF is asked for.
    assert_eq!(listing(score.parent().unwrap()).await, ["score.ly"]);
    let json = serde_json::to_value(&outcome).unwrap();
    assert_eq!(json["files"][0]["data"], "JVBERi0x");
    assert_eq!(json["rootFile"], score.display().to_string());
    assert!(json.get("message").is_none());
}

#[tokio::test]
async fn the_pdf_is_kept_until_the_score_compiles_again() {
    let s = pdf_scratch().await;
    let score = score_folder(&s, "kept").await;
    let version = counter();
    let compiler = StandIn::exporting(move |r| {
        let mut v = version.lock().unwrap();
        *v += 1;
        Ok((Some(format!("%PDF-{v}")), ok(&r.request)))
    });
    let studio = pdf_studio(&s, compiler.clone());
    let first = studio.pdf(&score).await;
    assert_eq!(studio.pdf(&score).await, first);
    assert_eq!(compiler.exports.lock().unwrap().len(), 1);
    studio.compile(&score).await;
    assert_eq!(
        text(&studio.pdf(&score).await.expect("an outcome").files[0].data),
        "%PDF-2"
    );
    assert_eq!(compiler.exports.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn a_pdf_with_errors_shows_what_was_written_but_is_not_kept() {
    let s = pdf_scratch().await;
    let score = score_folder(&s, "failed").await;
    let stderr = format!(
        "{}:2:3: error: unknown command: `\\stacato'\n",
        score.display()
    );
    let compiler = StandIn::exporting(move |r| {
        Ok((
            Some("%PDF-partial".into()),
            CompileResult {
                ok: false,
                exit_code: Some(1),
                stderr: stderr.clone(),
                ..ok(&r.request)
            },
        ))
    });
    let studio = pdf_studio(&s, compiler.clone());
    let outcome = studio.pdf(&score).await.expect("an outcome");
    assert_eq!(outcome.state, PdfState::Failed);
    assert_eq!(outcome.error_count, 1);
    assert_eq!(outcome.files.len(), 1);
    studio.pdf(&score).await;
    assert_eq!(compiler.exports.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn lilypond_that_cannot_run_is_reported_not_thrown() {
    let s = pdf_scratch().await;
    let score = score_folder(&s, "missing").await;
    let compiler = StandIn::exporting(|_| {
        Err(CompileError::NotFound(LilyPondNotFound::new(
            "LilyPond was not found.",
            None,
        )))
    });
    let outcome = pdf_studio(&s, compiler)
        .pdf(&score)
        .await
        .expect("an outcome");
    assert_eq!(outcome.state, PdfState::NoLilypond);
    assert_eq!(outcome.message.as_deref(), Some("LilyPond was not found."));
    assert!(outcome.files.is_empty());
}

#[tokio::test]
async fn a_superseded_pdf_compile_resolves_none() {
    let s = pdf_scratch().await;
    let score = score_folder(&s, "cancelled").await;
    let compiler = StandIn::exporting(|r| {
        Ok((
            None,
            CompileResult {
                cancelled: true,
                ..ok(&r.request)
            },
        ))
    });
    assert_eq!(pdf_studio(&s, compiler).pdf(&score).await, None);
}

#[tokio::test]
async fn export_writes_the_pdf_on_screen_next_to_the_score_without_compiling_again() {
    let s = pdf_scratch().await;
    let score = score_folder(&s, "export").await;
    let compiler = StandIn::new(|r| Ok(ok(r)));
    let studio = pdf_studio(&s, compiler.clone());
    studio.pdf(&score).await;
    let dir = score.parent().unwrap();
    assert_eq!(
        studio.export_pdf(&score).await,
        Ok(vec![dir.join("score.pdf")])
    );
    assert_eq!(compiler.exports.lock().unwrap().len(), 1);
    assert_eq!(listing(dir).await, ["score.ly", "score.pdf"]);
    assert_eq!(
        tokio::fs::read_to_string(dir.join("score.pdf"))
            .await
            .unwrap(),
        "%PDF-1"
    );
}

#[tokio::test]
async fn export_compiles_first_when_the_score_changed_since_and_replaces_the_old_file() {
    let s = pdf_scratch().await;
    let score = score_folder(&s, "export-again").await;
    let version = counter();
    let compiler = StandIn::exporting(move |r| {
        let mut v = version.lock().unwrap();
        *v += 1;
        Ok((Some(format!("%PDF-{v}")), ok(&r.request)))
    });
    let studio = pdf_studio(&s, compiler.clone());
    studio.export_pdf(&score).await.expect("exported");
    studio.compile(&score).await;
    studio.export_pdf(&score).await.expect("exported");
    assert_eq!(compiler.exports.lock().unwrap().len(), 2);
    assert_eq!(
        tokio::fs::read_to_string(score.parent().unwrap().join("score.pdf"))
            .await
            .unwrap(),
        "%PDF-2"
    );
}

#[tokio::test]
async fn export_refuses_a_score_with_errors_and_writes_nothing() {
    let s = pdf_scratch().await;
    let score = score_folder(&s, "export-failed").await;
    let stderr = format!("{}:2:3: error: oops\n", score.display());
    let compiler = StandIn::exporting(move |r| {
        Ok((
            Some("%PDF-partial".into()),
            CompileResult {
                ok: false,
                exit_code: Some(1),
                stderr: stderr.clone(),
                ..ok(&r.request)
            },
        ))
    });
    let error = pdf_studio(&s, compiler)
        .export_pdf(&score)
        .await
        .expect_err("refused");
    assert!(error.contains("has errors"), "{error}");
    assert_eq!(listing(score.parent().unwrap()).await, ["score.ly"]);
}

#[tokio::test]
async fn a_real_score_gives_a_pdf_on_screen_and_one_next_to_it_only_when_exported() {
    if common::lilypond("pdf").await.is_none() {
        return;
    }
    let s = pdf_scratch().await;
    let score = score_folder(&s, "real").await;
    let (studio, _) = studio(Arc::new(service()), vec![]);
    let outcome = studio.pdf(&score).await.expect("an outcome");
    assert_eq!(outcome.state, PdfState::Ok, "{:?}", outcome.message);
    assert_eq!(
        outcome
            .files
            .iter()
            .map(|f| f.name.as_str())
            .collect::<Vec<_>>(),
        ["score.pdf"]
    );
    assert_eq!(&outcome.files[0].data[..5], b"%PDF-");
    let dir = score.parent().unwrap();
    assert_eq!(listing(dir).await, ["score.ly"]);
    studio.export_pdf(&score).await.expect("exported");
    assert_eq!(listing(dir).await, ["score.ly", "score.pdf"]);
    assert_eq!(
        &tokio::fs::read(dir.join("score.pdf")).await.unwrap()[..5],
        b"%PDF-"
    );
    studio.dispose().await;
}

// lilypondSetup.test.ts: the sample score.

#[tokio::test]
async fn the_sample_score_engraves_without_a_warning_with_music_to_play() {
    if common::lilypond("sample").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-studio-setup-");
    let score = s
        .write(templates::SAMPLE.name, templates::SAMPLE.text)
        .await;
    let (studio, _) = studio(Arc::new(service()), vec![]);
    let outcome = studio.compile(&score).await.expect("an outcome");
    assert_eq!(outcome.state, CompileState::Ok, "{:?}", outcome.message);
    assert!(outcome.diagnostics.is_empty());
    assert!(
        !outcome.svg.is_empty() && outcome.midi_data.is_some(),
        "pages and MIDI"
    );
    studio.dispose().await;
}

#[tokio::test]
async fn the_playback_map_comes_with_the_music_when_there_is_a_runtime() {
    if common::lilypond("timing").await.is_none() {
        return;
    }
    let service = CompileService::new(CompileServiceOptions {
        runtime_dir: Some(common::runtime()),
        search_path: common::search_path(),
        ..Default::default()
    });
    let (studio, _) = studio(Arc::new(service), vec![]);
    let outcome = studio
        .compile(&common::repo().join("test/e2e/workspace/score.ly"))
        .await
        .expect("an outcome");
    assert_eq!(outcome.state, CompileState::Ok);
    let timing = outcome.timing.clone().expect("a playback map");
    assert!(timing.events.len() > 30 && !timing.bars.is_empty());
    let json = serde_json::to_value(&outcome).unwrap();
    assert!(
        json["midiData"]
            .as_str()
            .is_some_and(|m| m.starts_with("TVRoZA"))
    );
    assert!(json["timing"]["events"].is_array() && json["timing"]["bars"].is_array());
    studio.dispose().await;
}

// preview.test.ts: click-to-source with lilypond.

#[tokio::test]
async fn a_notes_link_leads_to_its_place_in_the_included_file() {
    if common::lilypond("click to source").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-studio-preview-");
    // A tab and an astral character before the note: CHAR counts code points.
    let include = s
        .write("parts/tune.ily", "tune = {\n\t%{𝄞%} fis'4 g\n}\n")
        .await;
    let score = s
        .write(
            "song.ly",
            "\\version \"2.24.0\"\n\\include \"parts/tune.ily\"\n{ \\tune }\n",
        )
        .await;
    let (studio, _) = studio(Arc::new(service()), vec![]);
    let result = studio.compile(&score).await.expect("an outcome");
    assert_eq!(result.state, CompileState::Ok, "{:?}", result.message);
    let svg = result.svg.join("\n");
    let hrefs: Vec<String> = regex::Regex::new(r#"href="(textedit:[^"]*)""#)
        .unwrap()
        .captures_iter(&svg)
        .map(|c| c[1].to_owned())
        .collect();
    assert!(!hrefs.is_empty(), "the pages carry point-and-click links");
    // As the app answers a click: parsed, then checked against the open folder.
    let mut access = Access::new();
    access.folder = Some(s.path.clone());
    let line = "\t%{𝄞%} fis'4 g";
    let fis = hrefs
        .iter()
        .filter_map(|href| parse_text_edit(href))
        .find(|l| {
            let file = access.check(&l.file.to_string_lossy()).expect("allowed");
            let units: Vec<u16> = line.encode_utf16().collect();
            let at = span::char_to_character(line, l.char as usize);
            file == include
                && l.line == 2
                && String::from_utf16_lossy(&units[at..]).starts_with("fis")
        });
    assert!(fis.is_some(), "a link to fis in {hrefs:?}");
    // A file outside the open folder is refused.
    access.folder = Some(s.at("elsewhere"));
    assert!(
        access
            .check(&include.to_string_lossy())
            .expect_err("refused")
            .contains("outside the open folder")
    );
    studio.dispose().await;
}
