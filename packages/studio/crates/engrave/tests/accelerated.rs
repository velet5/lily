//! From test/compile/live.test.ts: unsaved snapshots, the glyph cache and the
//! warm worker, with the runtime files of runtime/.

mod common;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use common::{Scratch, fixtures};
use lily_engrave::compiler::Engine;
use lily_engrave::{
    Acceleration, CompileRequest, CompileResult, CompileService, CompileServiceOptions,
    SourceBuffers, parse_stderr,
};

fn service(s: &Scratch) -> CompileService {
    CompileService::new(CompileServiceOptions {
        tmp_root: Some(s.path.clone()),
        runtime_dir: Some(common::runtime()),
        search_path: common::search_path(),
    })
}

fn request(root_file: &Path, acceleration: Acceleration) -> CompileRequest {
    CompileRequest {
        root_file: root_file.to_path_buf(),
        acceleration: Some(acceleration),
        ..Default::default()
    }
}

async fn content(files: &[PathBuf]) -> Vec<Vec<u8>> {
    let mut contents = Vec::new();
    for file in files {
        contents.push(tokio::fs::read(file).await.expect("read"));
    }
    contents
}

fn outputs(result: &CompileResult) -> Vec<PathBuf> {
    result.pages.iter().chain(&result.midi).cloned().collect()
}

async fn compile(service: &CompileService, request: CompileRequest) -> CompileResult {
    service.compile(request).await.expect("compiled")
}

/// The accelerated runs of `root_file` give the ordinary run's output, byte for byte.
async fn same_as_plain(service: &CompileService, root_file: &Path, check_stdout: bool) {
    let plain = compile(service, request(root_file, Acceleration::Off)).await;
    assert!(plain.ok, "{}", plain.stderr);
    assert_eq!(plain.stderr, "");
    let reference = content(&outputs(&plain)).await;
    for acceleration in [Acceleration::Cache, Acceleration::Auto, Acceleration::Auto] {
        let fast = compile(service, request(root_file, acceleration)).await;
        assert!(fast.ok, "{}", fast.stderr);
        assert_eq!(fast.stderr, "");
        let expected = if acceleration == Acceleration::Auto {
            Engine::Warm
        } else {
            Engine::Cache
        };
        assert_eq!(fast.engine, Some(expected), "{:?}", fast.fallback);
        if check_stdout {
            assert_eq!(fast.stdout, plain.stdout);
        }
        assert!(
            content(&outputs(&fast)).await == reference,
            "{} differs with {acceleration:?}",
            root_file.display()
        );
    }
}

#[tokio::test]
async fn snapshot_paths_preserve_ordinary_output_for_cyrillic_and_uri_reserved_filenames() {
    if common::lilypond("snapshot paths").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-live-");
    let service = service(&s);
    let text =
        "\\version \"2.26.0\"\n\\score { \\new Staff { c'4 d' e' f' } \\layout {} \\midi {} }\n";
    let root_file = s.write("Как молоды #?&'()!~.ly", text).await;
    let disk = compile(&service, request(&root_file, Acceleration::Off)).await;
    assert!(disk.ok, "{}", disk.stderr);
    assert_eq!(disk.stderr, "");
    let reference = content(&outputs(&disk)).await;
    let buffers: SourceBuffers = [(root_file.clone(), text.to_owned())].into_iter().collect();
    let snapshot = compile(
        &service,
        CompileRequest {
            buffers: Some(buffers),
            ..request(&root_file, Acceleration::Auto)
        },
    )
    .await;
    assert!(snapshot.ok, "{}", snapshot.stderr);
    assert_eq!(
        snapshot.engine,
        Some(Engine::Warm),
        "{:?}",
        snapshot.fallback
    );
    assert!(content(&outputs(&snapshot)).await == reference);
    service.dispose().await;
}

#[tokio::test]
async fn cache_and_isolated_warm_worker_preserve_svg_links_and_midi() {
    if common::lilypond("fixtures").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-live-");
    let service = service(&s);
    for fixture in [
        "simple.ly",
        "hello.ly",
        "pages.ly",
        "../e2e/workspace/score.ly",
    ] {
        same_as_plain(
            &service,
            &lily_engrave::paths::resolve(fixtures().join(fixture)),
            false,
        )
        .await;
    }
    service.dispose().await;
}

#[tokio::test]
async fn multiple_books_sizes_tablature_drums_ligatures_and_music_glyphs_in_markup_match() {
    if common::lilypond("varied").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-live-");
    let service = service(&s);
    let root_file = s
        .write(
            "varied.ly",
            r#"\version "2.26.0"
#(set-global-staff-size 18)
\header { title = "office — ffi Áλ" tagline = ##f }
\book {
  \bookOutputSuffix "guitar"
  \markup { \musicglyph "accidentals.sharp" \fontsize #5 \musicglyph "noteheads.s0" }
  \score { << \new Staff \relative c' { c4 d e f } \new TabStaff \relative c' { c4 d e f } >> \layout {} \midi {} }
}
\book {
  \bookOutputSuffix "drums"
  \score { \new DrumStaff \drummode { bd4 sn hh cymc } \layout {} \midi {} }
}
"#,
        )
        .await;
    same_as_plain(&service, &root_file, false).await;
    service.dispose().await;
}

#[tokio::test]
async fn font_data_caching_preserves_glyph_string_advances_spaces_offsets_and_size_changes() {
    if common::lilypond("glyph positions").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-live-");
    let service = service(&s);
    let root_file = s
        .write(
            "glyph-positions.ly",
            r#"\version "2.26.0"
#(let* ((module (resolve-module '(lily output-svg)))
        (render (module-ref module 'cache-font)))
   (for-each
     (lambda (font-name)
       (let ((font (ly:find-file font-name)))
         (for-each
           (lambda (size)
             (module-set! module 'next-horiz-adv 0.0)
             (for-each
               (lambda (glyph)
                 (display (render font size glyph)))
               '((1.5 0 0.25 0.5 "f") (0.75 0 0 0 "space")
                 (1.5 0 -0.5 0 "f") (1.0 0 0 0 "p")))
             (unless (= (module-ref module 'next-horiz-adv) 4.75)
               (ly:error "Glyph advance was lost"))
             (display (render font size "noteheads.s2")))
           '(4.0 6.0 4.0))))
     '("emmentaler-20.svg" "emmentaler-26.svg" "emmentaler-20.svg"))
   (module-set! module 'next-horiz-adv 0.0))
\markup { \dynamic "sff p" \fontsize #4 \dynamic "sff p" }
\score { { c'4\pp d'\sfz e'\ff f'\p } \layout {} \midi {} }
"#,
        )
        .await;
    same_as_plain(&service, &root_file, true).await;
    service.dispose().await;
}

/// `encodeURI`: what lilypond leaves of a plain path.
fn encode_uri(path: &Path) -> String {
    let mut encoded = String::new();
    for byte in path.to_string_lossy().bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'();/?:@&=+$,#".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

#[tokio::test]
async fn unsaved_root_and_nested_absolute_includes_map_links_and_diagnostic_columns_to_real_sources()
 {
    if common::lilypond("unsaved includes").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-live-");
    let service = service(&s);
    let root_file = s.at("unicode space λ.ly");
    let part = s.at("part.ily");
    let nested = s.at("nested.ily");
    let root = format!(
        "\\version \"2.26.0\"\n\\include {} {{ \\music c'4 }}\n",
        serde_json::to_string(&part).unwrap()
    );
    tokio::fs::write(&root_file, &root).await.unwrap();
    tokio::fs::write(&part, "music = { d'4 }\n").await.unwrap();
    tokio::fs::write(&nested, "music = { e'4 }\n")
        .await
        .unwrap();
    let mut buffers: SourceBuffers = [
        (root_file.clone(), root.clone()),
        (part.clone(), "\\include \"nested.ily\"\n".to_owned()),
        (nested.clone(), "music = { f'4 }\n".to_owned()),
    ]
    .into_iter()
    .collect();
    let result = compile(
        &service,
        CompileRequest {
            buffers: Some(buffers.clone()),
            ..request(&root_file, Acceleration::Auto)
        },
    )
    .await;
    assert!(result.ok, "{}", result.stderr);
    assert_eq!(result.stderr, "");
    let svg = tokio::fs::read_to_string(&result.pages[0]).await.unwrap();
    assert!(
        !svg.contains("/sources/"),
        "snapshot paths must not reach the viewer"
    );
    assert!(
        svg.contains(&format!("textedit://{}:1:10:11", encode_uri(&nested))),
        "{}",
        &svg[svg.len().saturating_sub(2000)..]
    );
    let note = root.split('\n').nth(1).unwrap().find("c'4").unwrap();
    let encoded_root = regex::Regex::new("%[0-9A-F]{2}")
        .unwrap()
        .replace_all(&encode_uri(&root_file), |c: &regex::Captures<'_>| {
            c[0].to_lowercase()
        })
        .into_owned();
    assert!(svg.contains(&format!("textedit://{encoded_root}:2:{note}:{}", note + 1)));
    assert_eq!(
        tokio::fs::read_to_string(&part).await.unwrap(),
        "music = { d'4 }\n",
        "never save editors"
    );
    buffers.insert(root_file.clone(), root.replace("c'4", "\\stacato c'4"));
    let bad = compile(
        &service,
        CompileRequest {
            buffers: Some(buffers),
            ..request(&root_file, Acceleration::Auto)
        },
    )
    .await;
    assert!(!bad.ok);
    let snapshot = bad.snapshot.clone().expect("a snapshot");
    let diagnostics: Vec<_> = parse_stderr(&bad.stderr, &root_file, None)
        .iter()
        .map(|d| snapshot.diagnostic(d))
        .collect();
    assert!(
        diagnostics.iter().any(|d| d.file == root_file
            && d.column == Some(note as u32 + 1)
            && d.message.contains("stacato")),
        "{diagnostics:?}"
    );
    service.dispose().await;
}

#[tokio::test]
async fn scheme_mutation_cannot_leak_between_forked_requests() {
    if common::lilypond("isolation").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-live-");
    let service = service(&s);
    let root_file = s
        .write("isolated.ly", "\\version \"2.26.0\"\n#(module-define! (resolve-module '(lily)) 'preview-test-leak 42)\n{ c1 }\n")
        .await;
    let first = compile(&service, request(&root_file, Acceleration::Auto)).await;
    assert!(first.ok, "{}", first.stderr);
    assert_eq!(first.engine, Some(Engine::Warm), "{:?}", first.fallback);
    s.write(
        "isolated.ly",
        "\\version \"2.26.0\"\n#(if (module-defined? (resolve-module '(lily)) 'preview-test-leak) (ly:error \"leaked state\"))\n{ c1 }\n",
    )
    .await;
    let second = compile(&service, request(&root_file, Acceleration::Auto)).await;
    assert!(second.ok, "{}", second.stderr);
    assert_eq!(second.engine, Some(Engine::Warm), "{:?}", second.fallback);
    service.dispose().await;
}

#[tokio::test]
async fn computed_includes_with_dirty_buffers_fail_explicitly_custom_options_use_ordinary_spawning()
{
    if common::lilypond("computed includes").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-live-");
    let service = service(&s);
    let text = "\\version \"2.26.0\"\n\\include #(string-append \"part\" \".ily\")\n{ \\music }\n";
    let root_file = s.write("computed.ly", text).await;
    let buffers: SourceBuffers = [(root_file.clone(), text.to_owned())].into_iter().collect();
    let unavailable = compile(
        &service,
        CompileRequest {
            root_file: root_file.clone(),
            buffers: Some(buffers),
            ..Default::default()
        },
    )
    .await;
    assert!(!unavailable.ok);
    assert!(
        unavailable.stderr.contains("computed"),
        "{}",
        unavailable.stderr
    );
    s.write("part.ily", "music = { c'1 }\n").await;
    let result = compile(
        &service,
        CompileRequest {
            extra_args: vec!["-dno-point-and-click".into()],
            ..request(&root_file, Acceleration::Auto)
        },
    )
    .await;
    assert!(result.ok, "{}", result.stderr);
    assert_eq!(result.engine, Some(Engine::Spawn));
    service.dispose().await;
}

#[tokio::test]
async fn a_crashing_score_falls_back_and_cannot_poison_later_requests() {
    if common::lilypond("crash").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-live-");
    let service = service(&s);
    let root_file = s
        .write("crash.ly", "\\version \"2.26.0\"\n#(primitive-exit 7)\n")
        .await;
    let crash = compile(&service, request(&root_file, Acceleration::Auto)).await;
    assert!(!crash.ok);
    assert_eq!(crash.engine, Some(Engine::Spawn));
    assert!(
        crash
            .fallback
            .as_deref()
            .unwrap_or("")
            .contains("Warm compiler failed"),
        "{:?}",
        crash.fallback
    );
    s.write("crash.ly", "\\version \"2.26.0\"\n{ c1 }\n").await;
    let recovered = compile(&service, request(&root_file, Acceleration::Auto)).await;
    assert!(recovered.ok, "{}", recovered.stderr);
    assert_eq!(
        recovered.engine,
        Some(Engine::Cache),
        "failed worker configurations stay disabled"
    );
    service.dispose().await;
}

#[tokio::test]
async fn warm_cancellation_kills_the_child_and_a_subsequent_request_starts_cleanly() {
    if common::lilypond("warm cancel").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-live-");
    let service = service(&s);
    let root_file = s.write("cancel.ly", "\\version \"2.26.0\"\n{ c1 }\n").await;
    assert_eq!(
        compile(&service, request(&root_file, Acceleration::Auto))
            .await
            .engine,
        Some(Engine::Warm)
    );
    s.write("cancel.ly", "\\version \"2.26.0\"\n#(sleep 30)\n{ c1 }\n")
        .await;
    let running = tokio::spawn({
        let (service, root_file) = (service.clone(), root_file.clone());
        async move {
            service
                .compile(request(&root_file, Acceleration::Auto))
                .await
        }
    });
    common::sleep(100).await;
    service.cancel(Some(&root_file));
    let result = tokio::time::timeout(Duration::from_secs(10), running)
        .await
        .expect("in time")
        .unwrap()
        .expect("compiled");
    assert!(result.cancelled);
    assert!(result.pages.is_empty());
    s.write("cancel.ly", "\\version \"2.26.0\"\n{ d1 }\n").await;
    let recovered = compile(
        &service,
        CompileRequest {
            extra_args: vec!["-I".into(), s.path.display().to_string()],
            ..request(&root_file, Acceleration::Auto)
        },
    )
    .await;
    assert!(recovered.ok, "{}", recovered.stderr);
    assert_eq!(
        recovered.engine,
        Some(Engine::Warm),
        "{:?}",
        recovered.fallback
    );
    service.dispose().await;
}

#[tokio::test]
async fn worker_and_fallback_timeouts_are_bounded_and_subsequent_compiles_recover() {
    if common::lilypond("timeouts").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-live-");
    let service = service(&s);
    let root_file = s
        .write("timeout.ly", "\\version \"2.26.0\"\n{ c1 }\n")
        .await;
    compile(&service, request(&root_file, Acceleration::Auto)).await;
    s.write("timeout.ly", "\\version \"2.26.0\"\n#(sleep 30)\n{ c1 }\n")
        .await;
    let start = Instant::now();
    let result = compile(
        &service,
        CompileRequest {
            timeout_ms: Some(100),
            ..request(&root_file, Acceleration::Auto)
        },
    )
    .await;
    assert!(!result.ok);
    assert!(result.stderr.contains("timed out"), "{}", result.stderr);
    assert!(start.elapsed() < Duration::from_secs(5));
    s.write("timeout.ly", "\\version \"2.26.0\"\n{ c1 }\n")
        .await;
    let recovered = compile(&service, request(&root_file, Acceleration::Auto)).await;
    assert!(recovered.ok, "{}", recovered.stderr);
    service.dispose().await;
}

#[tokio::test]
async fn dirty_includes_reached_through_a_symlink_and_relative_include_dirs_retain_their_search_paths()
 {
    if common::lilypond("symlinked includes").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-live-");
    let service = service(&s);
    let part = s.write("library/notes.ily", "music = { c'1 }\n").await;
    let alias = s.at("linked-library");
    std::os::unix::fs::symlink(s.at("library"), &alias).unwrap();
    let root_file = s
        .write(
            "search.ly",
            "\\version \"2.26.0\"\n\\include \"notes.ily\"\n{ \\music }\n",
        )
        .await;
    let buffers: SourceBuffers = [(alias.join("notes.ily"), "music = { d'1 }\n".to_owned())]
        .into_iter()
        .collect();
    let result = compile(
        &service,
        CompileRequest {
            buffers: Some(buffers),
            extra_args: vec!["-I".into(), "library".into()],
            ..request(&root_file, Acceleration::Auto)
        },
    )
    .await;
    assert!(result.ok, "{}", result.stderr);
    assert_eq!(result.engine, Some(Engine::Warm), "{:?}", result.fallback);
    assert_eq!(
        result
            .snapshot
            .as_ref()
            .and_then(|s| s.sources.get(&part))
            .map(String::as_str),
        Some("music = { d'1 }\n")
    );
    service.dispose().await;
}

#[tokio::test]
async fn a_score_replacing_the_backend_hook_retains_its_override_in_cached_and_warm_runs() {
    if common::lilypond("override").await.is_none() {
        return;
    }
    let s = Scratch::new("lily-live-");
    let service = service(&s);
    let root_file = s
        .write(
            "override.ly",
            r#"\version "2.26.0"
#(let* ((m (resolve-module '(lily output-svg)))
        (original (module-ref m 'cache-font)))
   (module-set! m 'cache-font
     (lambda (font size glyph)
       (original font size (if (equal? glyph "noteheads.s2") "noteheads.s0" glyph)))))
{ c'4 d' e' f' }
"#,
        )
        .await;
    let plain = compile(&service, request(&root_file, Acceleration::Off)).await;
    assert!(plain.ok, "{}", plain.stderr);
    let reference = content(&plain.pages).await;
    for acceleration in [Acceleration::Cache, Acceleration::Auto] {
        let result = compile(&service, request(&root_file, acceleration)).await;
        assert!(result.ok, "{}", result.stderr);
        assert_eq!(result.stderr, "");
        assert!(content(&result.pages).await == reference);
    }
    service.dispose().await;
}

#[tokio::test]
async fn unknown_versions_spawn_normally_and_replacing_the_configured_binary_invalidates_the_probe()
{
    let Some(binary) = common::lilypond("probe").await else {
        return;
    };
    let s = Scratch::new("lily-live-");
    let service = service(&s);
    let wrapper = s.at("version-wrapper");
    let root_file = s
        .write("version.ly", "\\version \"2.26.0\"\n{ c1 }\n")
        .await;
    let quote = |p: &Path| format!("'{}'", p.display().to_string().replace('\'', "'\\''"));
    let write_wrapper = |text: String| {
        let wrapper = wrapper.clone();
        async move {
            tokio::fs::write(&wrapper, text).await.unwrap();
            tokio::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o700))
                .await
                .unwrap();
        }
    };
    write_wrapper(format!(
        "#!/bin/sh\nif [ \"$1\" = \"--loglevel=ERROR\" ]; then\n  printf '2.99.0\\n/unknown/backend.scm\\n'\nelse\n  exec {} \"$@\"\nfi\n",
        quote(&binary)
    ))
    .await;
    let with_wrapper = || CompileRequest {
        lilypond_path: Some(wrapper.display().to_string()),
        ..request(&root_file, Acceleration::Auto)
    };
    let ordinary = compile(&service, with_wrapper()).await;
    assert!(ordinary.ok, "{}", ordinary.stderr);
    assert_eq!(ordinary.engine, Some(Engine::Spawn));
    // A different size makes a different identity, as a replaced binary does.
    write_wrapper(format!("#!/bin/sh\nexec {} \"$@\"\n", quote(&binary))).await;
    let accelerated = compile(&service, with_wrapper()).await;
    assert!(accelerated.ok, "{}", accelerated.stderr);
    assert_eq!(
        accelerated.engine,
        Some(Engine::Warm),
        "{:?}",
        accelerated.fallback
    );
    service.dispose().await;
}
