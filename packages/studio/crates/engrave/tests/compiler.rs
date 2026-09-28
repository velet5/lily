//! From test/compile/compiler.test.ts: locating lilypond, page order and the
//! compile service against the real binary.

mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use common::{Scratch, exists, fixtures, listing, sleep};
use lily_engrave::compiler::{midi_pattern, order_outputs, order_pages};
use lily_engrave::locate::{BinarySource, LocateOptions, LocatedBinary, locate_lilypond};
use lily_engrave::{
    CompileError, CompileRequest, CompileService, CompileServiceOptions, ExportFormat,
    ExportRequest, SearchPath,
};

async fn fake_executable(dir: &Path, name: &str) -> PathBuf {
    tokio::fs::create_dir_all(dir).await.expect("mkdir");
    let file = dir.join(name);
    tokio::fs::write(&file, "#!/bin/sh\nexit 0\n")
        .await
        .expect("write");
    tokio::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755))
        .await
        .expect("chmod");
    file
}

fn nowhere(path: &str) -> LocateOptions {
    LocateOptions {
        configured_path: None,
        path: path.to_owned(),
        well_known_dirs: Some(vec![]),
    }
}

#[tokio::test]
async fn finds_lilypond_on_path_skipping_entries_that_are_not_executable_files() {
    let s = Scratch::new("path-");
    tokio::fs::create_dir_all(s.at("a/lilypond")).await.unwrap(); // a directory
    s.write("b/lilypond", "").await; // not executable
    tokio::fs::set_permissions(s.at("b/lilypond"), std::fs::Permissions::from_mode(0o644))
        .await
        .unwrap();
    let real = fake_executable(&s.at("c"), "lilypond").await;
    let path = ["a", "b", "c"]
        .map(|d| s.at(d).display().to_string())
        .join(":");
    assert_eq!(
        locate_lilypond(&nowhere(&path)).await,
        Ok(LocatedBinary {
            path: real,
            source: BinarySource::Path
        })
    );
}

#[tokio::test]
async fn the_setting_wins_over_path_and_may_name_the_file_its_directory_or_the_install_root() {
    let s = Scratch::new("setting-");
    let on_path = fake_executable(&s.at("on-path"), "lilypond").await;
    let custom = fake_executable(&s.at("custom install/bin"), "lilypond").await;
    for configured in [
        custom.clone(),
        s.at("custom install/bin"),
        s.at("custom install"),
    ] {
        let options = LocateOptions {
            configured_path: Some(configured.display().to_string()),
            ..nowhere(&on_path.parent().unwrap().display().to_string())
        };
        assert_eq!(
            locate_lilypond(&options).await,
            Ok(LocatedBinary {
                path: custom.clone(),
                source: BinarySource::Setting
            }),
            "{}",
            configured.display()
        );
    }
}

#[tokio::test]
async fn a_bare_command_name_in_the_setting_is_looked_up_on_path() {
    let s = Scratch::new("bare-");
    let versioned = fake_executable(&s.path, "lilypond-2.24").await;
    let options = LocateOptions {
        configured_path: Some(" lilypond-2.24 ".into()),
        ..nowhere(&s.path.display().to_string())
    };
    assert_eq!(
        locate_lilypond(&options).await,
        Ok(LocatedBinary {
            path: versioned,
            source: BinarySource::Setting
        })
    );
}

#[tokio::test]
async fn a_setting_that_does_not_resolve_is_an_error_not_a_silent_fallback_to_path() {
    let s = Scratch::new("broken-");
    fake_executable(&s.path, "lilypond").await;
    let configured = s.at("missing/lilypond").display().to_string();
    let options = LocateOptions {
        configured_path: Some(configured.clone()),
        ..nowhere(&s.path.display().to_string())
    };
    let error = locate_lilypond(&options).await.expect_err("not found");
    assert_eq!(error.configured_path, Some(configured));
}

#[tokio::test]
async fn falls_back_to_well_known_directories_then_reports_not_found() {
    let s = Scratch::new("known-");
    let real = fake_executable(&s.path, "lilypond").await;
    let options = LocateOptions {
        well_known_dirs: Some(vec![s.path.clone()]),
        ..nowhere("")
    };
    assert_eq!(
        locate_lilypond(&options).await,
        Ok(LocatedBinary {
            path: real,
            source: BinarySource::WellKnown
        })
    );
    let error = locate_lilypond(&nowhere("")).await.expect_err("not found");
    assert_eq!(error.configured_path, None);
}

fn names(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

#[test]
fn sorts_page_numbers_numerically_and_ignores_non_svg_output() {
    let produced = names(&[
        "score-10.svg",
        "score-2.svg",
        "score.midi",
        "score-1.svg",
        "score-9.svg",
    ]);
    assert_eq!(
        order_pages(&produced, "score"),
        names(&["score-1.svg", "score-2.svg", "score-9.svg", "score-10.svg"])
    );
}

#[test]
fn midi_files_are_ordered_as_lilypond_wrote_them() {
    let produced = names(&[
        "score-2.midi",
        "score-1.midi",
        "score.svg",
        "score.midi",
        "score-10.midi",
        "score-alto.midi",
    ]);
    assert_eq!(
        order_outputs(&produced, "score", midi_pattern()),
        names(&[
            "score.midi",
            "score-1.midi",
            "score-2.midi",
            "score-10.midi",
            "score-alto.midi"
        ])
    );
}

#[test]
fn keeps_a_base_name_that_itself_ends_in_a_number_intact() {
    assert_eq!(
        order_pages(&names(&["etude-2-2.svg", "etude-2-1.svg"]), "etude-2"),
        names(&["etude-2-1.svg", "etude-2-2.svg"])
    );
    assert_eq!(
        order_pages(&names(&["etude-2.svg"]), "etude-2"),
        names(&["etude-2.svg"])
    );
}

#[test]
fn places_suffixed_and_renamed_books_after_the_main_book() {
    let produced = names(&[
        "other.svg",
        "score-alto-2.svg",
        "score-alto-1.svg",
        "score-2.svg",
        "score-1.svg",
    ]);
    assert_eq!(
        order_pages(&produced, "score"),
        names(&[
            "score-1.svg",
            "score-2.svg",
            "score-alto-1.svg",
            "score-alto-2.svg",
            "other.svg"
        ])
    );
}

fn service(tmp_root: &Path) -> CompileService {
    CompileService::new(CompileServiceOptions {
        tmp_root: Some(tmp_root.to_path_buf()),
        runtime_dir: None,
        search_path: common::search_path(),
    })
}

fn request(root_file: &Path) -> CompileRequest {
    CompileRequest {
        root_file: root_file.to_path_buf(),
        ..Default::default()
    }
}

async fn source(s: &Scratch, name: &str, body: &str) -> PathBuf {
    let dir = tempfile::Builder::new()
        .prefix("src-")
        .tempdir_in(&s.path)
        .expect("dir")
        .keep();
    let file = dir.join(name);
    tokio::fs::write(&file, format!("\\version \"2.24.0\"\n{body}\n"))
        .await
        .expect("write");
    file
}

// About 30 s of work, so the run is certainly alive when killed.
const SLOW_BODY: &str = "{ \\repeat unfold 400 { c'8 d' e' f' g' a' b' c'' } }";

async fn read(file: &Path) -> String {
    tokio::fs::read_to_string(file).await.expect("read")
}

#[tokio::test]
async fn compiles_a_score_into_one_svg_page_with_point_and_click_links() {
    if common::lilypond("compile").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-test-");
    let service = service(&s.path);
    let root_file = fixtures().join("simple.ly");
    let before = listing(&fixtures()).await;
    let result = service
        .compile(request(&root_file))
        .await
        .expect("compiled");
    assert!(result.ok, "{}", result.stderr);
    assert!(!result.cancelled);
    assert_eq!(result.exit_code, Some(0));
    assert_eq!(result.root_file, root_file);
    assert_eq!(result.stderr, "");
    assert!(result.midi.is_empty());
    let output_dir = result.output_dir.clone().expect("an output dir");
    assert!(
        output_dir.starts_with(&s.path),
        "output belongs under the temp root"
    );
    assert_eq!(result.pages, vec![output_dir.join("simple.svg")]);
    let svg = read(&result.pages[0]).await;
    assert!(svg.contains("<svg"));
    assert!(
        svg.contains(&format!("textedit://{}:5:", root_file.display())),
        "links point at the source on disk"
    );
    assert!(
        svg.contains("currentColor"),
        "the classic backend, not cairo"
    );
    assert_eq!(
        listing(&fixtures()).await,
        before,
        "nothing written beside the source"
    );
    service.dispose().await;
}

#[tokio::test]
async fn resolves_a_relative_include_against_the_source_directory() {
    if common::lilypond("include").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-test-");
    let service = service(&s.path);
    let result = service
        .compile(request(&fixtures().join("hello.ly")))
        .await
        .expect("compiled");
    assert!(result.ok, "{}", result.stderr);
    assert!(read(&result.pages[0]).await.contains(&format!(
        "textedit://{}:",
        fixtures().join("melody.ily").display()
    )));
    service.dispose().await;
}

#[tokio::test]
async fn a_preview_compile_with_the_runtime_maps_every_note_of_the_midi_to_its_link_on_the_pages() {
    if common::lilypond("timing").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-test-");
    let mapped = CompileService::new(CompileServiceOptions {
        tmp_root: Some(s.path.clone()),
        runtime_dir: Some(common::runtime()),
        search_path: common::search_path(),
    });
    let score = common::extension_tests().join("e2e/workspace/score.ly");
    // A dirty buffer makes it a snapshot compile, whose links must name the real file.
    let buffers = [(score.clone(), read(&score).await)].into_iter().collect();
    let result = mapped
        .compile(CompileRequest {
            buffers: Some(buffers),
            acceleration: Some(lily_engrave::Acceleration::Off),
            ..request(&score)
        })
        .await
        .expect("compiled");
    assert!(result.ok, "{}", result.stderr);
    assert_eq!(result.midi.len(), 1);
    let timing = result.timing.clone().expect("a playback map");
    let map: serde_json::Value = serde_json::from_str(&read(&timing).await).expect("JSON");
    let map = &map[0];
    let events = map["events"].as_array().expect("events");
    let mut pages = Vec::new();
    for page in &result.pages {
        pages.push(read(page).await);
    }
    // Two staves and the lyrics, eight bars of 3/4; every event is drawn somewhere.
    assert!(events.len() > 30, "{}", events.len());
    let encoded = score.display().to_string().replace(' ', "%20");
    for event in events {
        let href = event["href"].as_str().expect("href");
        assert!(
            pages
                .iter()
                .any(|p| p.contains(&format!("xlink:href=\"{href}\""))),
            "{href} is not on a page"
        );
        assert!(href.contains(&encoded), "{href}");
    }
    let lengths: Vec<f64> = events
        .iter()
        .map(|e| e["length"].as_f64().unwrap_or(-1.0))
        .collect();
    assert!(
        lengths.contains(&0.25) && lengths.contains(&0.75) && lengths.contains(&0.0),
        "{lengths:?}"
    );
    assert_eq!(
        map["bars"].as_array().expect("bars")[..3],
        [
            serde_json::json!({"at": 0, "number": 1}),
            serde_json::json!({"at": 0.75, "number": 2}),
            serde_json::json!({"at": 1.5, "number": 3})
        ]
    );
    assert_eq!(events[0]["at"], serde_json::json!(0));
    // An export needs no map, and a service without a runtime gets none.
    let target_dir = s.at("mapped");
    let exported = mapped
        .export(ExportRequest {
            request: request(&score),
            format: ExportFormat::Midi,
            target_dir: Some(target_dir.clone()),
        })
        .await
        .expect("exported");
    assert_eq!(exported.result.timing, None);
    assert_eq!(listing(&target_dir).await, ["score.midi"]);
    let plain = service(&s.path);
    assert_eq!(
        plain
            .compile(request(&score))
            .await
            .expect("compiled")
            .timing,
        None
    );
    mapped.dispose().await;
    plain.dispose().await;
}

#[tokio::test]
async fn returns_several_pages_in_order_plus_midi() {
    if common::lilypond("pages").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-test-");
    let service = service(&s.path);
    let pages: Vec<String> = (1..=11)
        .map(|n| format!("\\markup \"page {n}\" \\pageBreak"))
        .collect();
    let root_file = source(
        &s,
        "multi page.ly",
        &format!("{}\n\\score {{ {{ c'1 }} \\midi {{ }} }}", pages.join("\n")),
    )
    .await;
    let result = service
        .compile(request(&root_file))
        .await
        .expect("compiled");
    assert!(result.ok, "{}", result.stderr);
    let names: Vec<String> = result
        .pages
        .iter()
        .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    assert_eq!(
        names,
        (1..=11)
            .map(|n| format!("multi page-{n}.svg"))
            .collect::<Vec<_>>()
    );
    assert_eq!(
        result.midi,
        vec![result.output_dir.clone().unwrap().join("multi page.midi")]
    );
    service.dispose().await;
}

#[tokio::test]
async fn a_failing_score_reports_raw_english_stderr_and_still_returns_its_page() {
    if common::lilypond("failing").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-test-");
    let service = service(&s.path);
    let root_file = source(&s, "bad.ly", "{ c'4 \\foo d' }").await;
    let result = service
        .compile(request(&root_file))
        .await
        .expect("compiled");
    assert!(!result.ok);
    assert!(!result.cancelled);
    assert_eq!(result.exit_code, Some(1));
    assert!(
        result.stderr.contains(&format!(
            "{}:2:7: error: unknown command: `\\foo'",
            root_file.display()
        )),
        "{}",
        result.stderr
    );
    assert!(
        result
            .stderr
            .lines()
            .any(|l| l.starts_with("fatal error: failed files"))
    );
    assert_eq!(result.pages.len(), 1);
    service.dispose().await;
}

#[tokio::test]
async fn passes_extra_arguments_through_one_per_item() {
    if common::lilypond("extra args").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-test-");
    let service = service(&s.path);
    let library = s.write("my library/shared.ily", "tune = { c'1 }\n").await;
    let library = library.parent().unwrap().to_path_buf();
    let root_file = source(
        &s,
        "uses-library.ly",
        "\\include \"shared.ily\"\n{ \\tune }",
    )
    .await;
    let without = service
        .compile(request(&root_file))
        .await
        .expect("compiled");
    assert!(!without.ok);
    let result = service
        .compile(CompileRequest {
            extra_args: vec![
                format!("--include={}", library.display()),
                "-dno-point-and-click".into(),
            ],
            ..request(&root_file)
        })
        .await
        .expect("compiled");
    assert!(result.ok, "{}", result.stderr);
    assert!(!read(&result.pages[0]).await.contains("textedit:"));
    service.dispose().await;
}

#[tokio::test]
async fn a_newer_compile_of_the_same_file_supersedes_the_one_in_flight() {
    if common::lilypond("supersede").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-test-");
    let tmp_root = s.at("runs");
    tokio::fs::create_dir_all(&tmp_root).await.unwrap();
    let service = service(&tmp_root);
    let root_file = source(&s, "edited.ly", SLOW_BODY).await;
    let first = tokio::spawn({
        let (service, root_file) = (service.clone(), root_file.clone());
        async move { service.compile(request(&root_file)).await }
    });
    sleep(400).await; // let lilypond start
    tokio::fs::write(&root_file, "\\version \"2.24.0\"\n{ c'1 }\n")
        .await
        .unwrap();
    let second = tokio::spawn({
        let (service, root_file) = (service.clone(), root_file.clone());
        async move { service.compile(request(&root_file)).await }
    });
    tokio::task::yield_now().await;
    let third = service.compile(request(&root_file));
    let started = Instant::now();
    let c = third.await.expect("compiled");
    let (a, b) = (
        first.await.unwrap().expect("compiled"),
        second.await.unwrap().expect("compiled"),
    );
    assert!(started.elapsed() < Duration::from_secs(15));
    for stale in [&a, &b] {
        assert!(stale.cancelled);
        assert!(!stale.ok);
        assert!(stale.pages.is_empty());
        assert_eq!(stale.output_dir, None);
    }
    assert!(!c.cancelled);
    assert!(c.ok, "{}", c.stderr);
    assert_eq!(c.pages.len(), 1);
    let kept = c.output_dir.clone().unwrap();
    assert_eq!(
        listing(&tmp_root).await,
        [kept.file_name().unwrap().to_string_lossy().into_owned()],
        "only the winning run keeps a directory"
    );
    service.dispose().await;
}

#[tokio::test]
async fn cancel_kills_the_run_promptly_and_removes_its_directory() {
    if common::lilypond("cancel").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-test-");
    let tmp_root = s.at("runs");
    tokio::fs::create_dir_all(&tmp_root).await.unwrap();
    let service = service(&tmp_root);
    let root_file = source(&s, "slow.ly", SLOW_BODY).await;
    let other = tokio::spawn({
        let service = service.clone();
        async move {
            service
                .compile(request(&fixtures().join("simple.ly")))
                .await
        }
    });
    let pending = tokio::spawn({
        let (service, root_file) = (service.clone(), root_file.clone());
        async move { service.compile(request(&root_file)).await }
    });
    sleep(400).await;
    let run_dirs = listing(&tmp_root).await;
    let cancelled_at = Instant::now();
    service.cancel(Some(&root_file));
    let result = pending.await.unwrap().expect("compiled");
    assert!(result.cancelled);
    assert!(
        cancelled_at.elapsed() < Duration::from_secs(1),
        "resolved right after the kill"
    );
    assert!(
        other.await.unwrap().expect("compiled").ok,
        "runs of other files are left alone"
    );
    let remaining = listing(&tmp_root).await;
    assert!(
        run_dirs.iter().any(|d| !remaining.contains(d)),
        "the killed run left no directory"
    );
    service.dispose().await;
}

#[tokio::test]
async fn keeps_one_output_directory_per_file_and_deletes_them_on_release_and_dispose() {
    if common::lilypond("kept").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-test-");
    let own = service(&s.path);
    let root_file = fixtures().join("simple.ly");
    let first = own.compile(request(&root_file)).await.expect("compiled");
    assert!(exists(&first.pages[0]).await);
    let second = own.compile(request(&root_file)).await.expect("compiled");
    assert_ne!(
        second.output_dir, first.output_dir,
        "every run gets a fresh directory"
    );
    assert!(
        !exists(first.output_dir.as_ref().unwrap()).await,
        "the replaced run is deleted"
    );
    assert!(exists(&second.pages[0]).await);
    let hello = own
        .compile(request(&fixtures().join("hello.ly")))
        .await
        .expect("compiled");
    own.release(&root_file).await;
    assert!(!exists(second.output_dir.as_ref().unwrap()).await);
    assert!(exists(hello.output_dir.as_ref().unwrap()).await);
    own.dispose().await;
    assert!(!exists(hello.output_dir.as_ref().unwrap()).await);
}

#[tokio::test]
async fn dispose_kills_runs_in_flight_and_leaves_the_temp_root_empty() {
    if common::lilypond("dispose").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-test-");
    let own_root = s.at("disposed");
    tokio::fs::create_dir_all(&own_root).await.unwrap();
    let own = service(&own_root);
    own.compile(request(&fixtures().join("simple.ly")))
        .await
        .expect("compiled");
    let slow = source(&s, "slow.ly", SLOW_BODY).await;
    let pending = tokio::spawn({
        let own = own.clone();
        async move { own.compile(request(&slow)).await }
    });
    sleep(400).await;
    own.dispose().await;
    assert!(pending.await.unwrap().expect("compiled").cancelled);
    assert_eq!(listing(&own_root).await, Vec::<String>::new());
}

#[tokio::test]
async fn export_writes_the_pdf_next_to_the_source_and_nothing_else() {
    if common::lilypond("export pdf").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-test-");
    let service = service(&s.path);
    let root_file = source(
        &s,
        "hymn.ly",
        "\\score { { c'4 d' } \\layout { } \\midi { } }",
    )
    .await;
    let dir = root_file.parent().unwrap().to_path_buf();
    let result = service
        .export(ExportRequest {
            request: request(&root_file),
            format: ExportFormat::Pdf,
            target_dir: None,
        })
        .await
        .expect("exported");
    assert!(result.result.ok);
    assert_eq!(result.exported, vec![dir.join("hymn.pdf")]);
    assert_eq!(listing(&dir).await, ["hymn.ly", "hymn.pdf"]);
    let bytes = tokio::fs::read(&result.exported[0]).await.unwrap();
    assert_eq!(&bytes[..5], b"%PDF-");
    // Point-and-click would put the author's absolute paths into the file.
    assert!(!bytes.windows(8).any(|w| w == b"textedit"));
    assert!(
        result.result.pages.is_empty()
            && result.result.midi.is_empty()
            && result.result.output_dir.is_none()
    );
    service.dispose().await;
}

#[tokio::test]
async fn export_writes_midi_without_pages_one_file_per_book_into_a_directory_of_choice() {
    if common::lilypond("export midi").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-test-");
    let service = service(&s.path);
    let score = "\\score { { c'4 } \\layout { } \\midi { } }";
    let root_file = source(
        &s,
        "parts.ly",
        &format!("\\book {{ {score} }}\n\\book {{ \\bookOutputSuffix \"alto\" {score} }}"),
    )
    .await;
    let dir = root_file.parent().unwrap().to_path_buf();
    let target_dir = dir.join("out/midi");
    let result = service
        .export(ExportRequest {
            request: request(&root_file),
            format: ExportFormat::Midi,
            target_dir: Some(target_dir.clone()),
        })
        .await
        .expect("exported");
    assert_eq!(
        result.exported,
        vec![
            target_dir.join("parts-alto.midi"),
            target_dir.join("parts.midi")
        ]
    );
    assert_eq!(
        &tokio::fs::read(&result.exported[1]).await.unwrap()[..4],
        b"MThd"
    );
    assert_eq!(listing(&dir).await, ["out", "parts.ly"]);
    service.dispose().await;
}

#[tokio::test]
async fn a_score_without_midi_exports_nothing_and_a_broken_one_reports_why() {
    if common::lilypond("export nothing").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-test-");
    let service = service(&s.path);
    let target_dir = s.at("silent");
    let silent = service
        .export(ExportRequest {
            request: request(&fixtures().join("simple.ly")),
            format: ExportFormat::Midi,
            target_dir: Some(target_dir),
        })
        .await
        .expect("exported");
    assert!(silent.result.ok);
    assert!(silent.exported.is_empty());
    let broken = source(&s, "broken.ly", "{ c4 \\nonsense }").await;
    let broken = service
        .export(ExportRequest {
            request: request(&broken),
            format: ExportFormat::Midi,
            target_dir: None,
        })
        .await
        .expect("exported");
    assert!(!broken.result.ok);
    assert!(
        broken
            .result
            .stderr
            .contains("error: unknown command: `\\nonsense'")
    );
    service.dispose().await;
}

#[tokio::test]
async fn an_export_leaves_the_preview_compile_and_its_kept_pages_alone() {
    if common::lilypond("export alongside").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-test-");
    let runs = s.at("export");
    tokio::fs::create_dir_all(&runs).await.unwrap();
    let own = service(&runs);
    let root_file = source(&s, "both.ly", "{ c4 }").await;
    let kept = own.compile(request(&root_file)).await.expect("compiled");
    let (compiled, exported) = tokio::join!(
        own.compile(request(&root_file)),
        own.export(ExportRequest {
            request: request(&root_file),
            format: ExportFormat::Pdf,
            target_dir: None
        })
    );
    let (compiled, exported) = (compiled.expect("compiled"), exported.expect("exported"));
    assert!(!compiled.cancelled && !exported.result.cancelled);
    assert!(
        !exists(kept.output_dir.as_ref().unwrap()).await,
        "replaced by the second compile only"
    );
    assert!(exists(&compiled.pages[0]).await);
    let output_dir = compiled.output_dir.clone().unwrap();
    assert_eq!(
        listing(&runs).await,
        [output_dir
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned()]
    );
    own.dispose().await;
}

#[tokio::test]
async fn cancel_export_kills_the_export_and_writes_nothing() {
    if common::lilypond("cancel export").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-test-");
    let service = service(&s.path);
    let root_file = source(&s, "slow-export.ly", SLOW_BODY).await;
    let running = tokio::spawn({
        let (service, root_file) = (service.clone(), root_file.clone());
        async move {
            service
                .export(ExportRequest {
                    request: request(&root_file),
                    format: ExportFormat::Pdf,
                    target_dir: None,
                })
                .await
        }
    });
    sleep(300).await;
    service.cancel_export(&root_file, ExportFormat::Pdf);
    let result = tokio::time::timeout(Duration::from_secs(15), running)
        .await
        .expect("in time")
        .unwrap()
        .expect("exported");
    assert!(result.result.cancelled);
    assert!(result.exported.is_empty());
    assert_eq!(
        listing(root_file.parent().unwrap()).await,
        ["slow-export.ly"]
    );
    service.dispose().await;
}

#[tokio::test]
async fn fails_with_the_file_error_when_the_root_file_does_not_exist() {
    let s = Scratch::new("lily-test-");
    let service = service(&s.path);
    let root_file = s.at("no-such-dir/score.ly");
    match service.compile(request(&root_file)).await {
        Err(CompileError::Io(error)) => {
            assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
            assert_eq!(
                error.to_string(),
                format!(
                    "ENOENT: no such file or directory, access '{}'",
                    root_file.display()
                )
            );
        }
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn fails_with_lilypond_not_found_when_the_configured_binary_is_missing() {
    let s = Scratch::new("lily-test-");
    let service = service(&s.path);
    let missing = s.at("no-such-dir/lilypond").display().to_string();
    let result = service
        .compile(CompileRequest {
            lilypond_path: Some(missing),
            ..request(&fixtures().join("simple.ly"))
        })
        .await;
    assert!(
        matches!(result, Err(CompileError::NotFound(_))),
        "{result:?}"
    );
}

#[tokio::test]
async fn lilypond_is_looked_for_on_the_search_path_given() {
    let s = Scratch::new("lily-test-");
    let service = CompileService::new(CompileServiceOptions {
        tmp_root: Some(s.path.clone()),
        runtime_dir: None,
        search_path: SearchPath::new(""),
    });
    let result = service
        .compile(request(&fixtures().join("simple.ly")))
        .await;
    // Only the well-known directories are left; on this machine they may hold lilypond.
    match result {
        Ok(result) => assert!(result.ok),
        Err(error) => assert!(matches!(error, CompileError::NotFound(_))),
    }
    service.dispose().await;
}
