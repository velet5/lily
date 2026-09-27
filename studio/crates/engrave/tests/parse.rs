//! From test/diagnostics/parse.test.ts. Every stderr sample below is verbatim
//! LilyPond 2.26 output (LANGUAGE=en, --loglevel=WARNING), with only the
//! directory replaced.

mod common;

use std::path::{Path, PathBuf};

use lily_engrave::parse::{LyDiagnostic, LySeverity, parse_stderr};
use lily_engrave::{CompileRequest, CompileService, CompileServiceOptions};

fn root() -> PathBuf {
    PathBuf::from("/scores/root.ly")
}

fn parse(stderr: &str) -> Vec<LyDiagnostic> {
    parse_stderr(stderr, &root(), None)
}

fn d(
    file: &Path,
    line: u32,
    column: Option<u32>,
    severity: LySeverity,
    message: &str,
) -> LyDiagnostic {
    LyDiagnostic {
        file: file.to_path_buf(),
        line,
        column,
        severity,
        message: message.to_owned(),
    }
}

use LySeverity::{Error, Warning};

#[test]
fn located_errors_context_lines_are_skipped_the_closing_summary_is_dropped() {
    let r = root().display().to_string();
    let stderr = [
        format!("{r}:3:12: error: unknown command: `\\foo'"),
        "\tc4 ".into(),
        "           \\foo d".into(),
        format!("{r}:3:12: error: string outside of text script or \\lyricmode"),
        "\tc4 ".into(),
        "           \\foo d".into(),
        format!("{r}:4:5: error: not a note name: ♪"),
        "  é ".into(),
        "    ♪ \\bar \"x\" c4 \\baz".into(),
        format!("fatal error: failed files: \"{r}\""),
        String::new(),
    ]
    .join("\n");
    assert_eq!(
        parse(&stderr),
        vec![
            d(&root(), 3, Some(12), Error, "unknown command: `\\foo'"),
            d(
                &root(),
                3,
                Some(12),
                Error,
                "string outside of text script or \\lyricmode"
            ),
            d(&root(), 4, Some(5), Error, "not a note name: ♪"),
        ]
    );
}

#[test]
fn warnings_and_identical_entries_reported_once() {
    let r = root().display().to_string();
    let warning = [
        format!("{r}:2:20: warning: bar check failed at: 1/4"),
        "{ \\time 4/4 c2. c2 ".into(),
        "                   | c1 }".into(),
    ];
    let twice = [warning.clone(), warning].concat().join("\n");
    assert_eq!(
        parse(&twice),
        vec![d(&root(), 2, Some(20), Warning, "bar check failed at: 1/4")]
    );
}

#[test]
fn a_line_only_location_keeps_its_multi_line_message() {
    let r = root().display().to_string();
    let stderr = [
        format!("{r}:1: warning: no \\version statement found, please add"),
        String::new(),
        "\\version \"2.26.0\"".into(),
        String::new(),
        "for future compatibility".into(),
        String::new(),
    ]
    .join("\n");
    assert_eq!(
        parse(&stderr),
        vec![d(
            &root(),
            1,
            None,
            Warning,
            "no \\version statement found, please add\n\\version \"2.26.0\"\nfor future compatibility"
        )]
    );
}

#[test]
fn message_text_before_and_after_the_context_lines_is_kept() {
    let r = root().display().to_string();
    let stderr = [
        format!("{r}:4:10: error: cannot find file: `missing.ily'"),
        "(search path: `/scores:/usr/share/lilypond/2.26.0/ly:')".into(),
        "\\include ".into(),
        "         \"missing.ily\"".into(),
        format!("{r}:2:2: error: Guile signaled an error for the expression beginning here"),
        "#".into(),
        " (display (car 5))".into(),
        "In procedure car: Wrong type (expecting pair): 5".into(),
    ]
    .join("\n");
    assert_eq!(
        parse(&stderr)
            .into_iter()
            .map(|d| d.message)
            .collect::<Vec<_>>(),
        vec![
            "cannot find file: `missing.ily'\n(search path: `/scores:/usr/share/lilypond/2.26.0/ly:')",
            "Guile signaled an error for the expression beginning here\nIn procedure car: Wrong type (expecting pair): 5",
        ]
    );
}

#[test]
fn column_1_and_end_of_input_context_lines() {
    let r = root().display().to_string();
    let stderr = [
        format!("{r}:5:1: error: unknown command: `\\fod'"),
        String::new(),
        "\\fod".into(),
        format!("{r}:5:5: error: syntax error, unexpected end of input, expecting '.' or '='"),
        "\\fod".into(),
        "    ".into(),
    ]
    .join("\n");
    assert_eq!(
        parse(&stderr)
            .into_iter()
            .map(|d| (d.column, d.message))
            .collect::<Vec<_>>(),
        vec![
            (Some(1), "unknown command: `\\fod'".to_owned()),
            (
                Some(5),
                "syntax error, unexpected end of input, expecting '.' or '='".to_owned()
            ),
        ]
    );
}

#[test]
fn errors_in_an_included_file_with_a_space_in_its_path() {
    let include = PathBuf::from("/scores/sub dir/inc.ily");
    let stderr = format!(
        "{}:1:13: error: unknown command: `\\qux'\ntune = {{ c4 \n            \\qux d }}",
        include.display()
    );
    assert_eq!(
        parse(&stderr),
        vec![d(&include, 1, Some(13), Error, "unknown command: `\\qux'")]
    );
}

#[test]
fn relative_paths_resolve_against_cwd_which_defaults_to_the_root_directory() {
    let stderr = "parts/inc.ily:1:1: error: boom\n\nx";
    assert_eq!(
        parse(stderr)[0].file,
        PathBuf::from("/scores/parts/inc.ily")
    );
    let elsewhere = PathBuf::from("/elsewhere");
    assert_eq!(
        parse_stderr(stderr, &root(), Some(&elsewhere))[0].file,
        PathBuf::from("/elsewhere/parts/inc.ily")
    );
}

#[test]
fn a_windows_drive_letter_is_part_of_the_path() {
    let diagnostics = parse("C:\\scores\\a b.ly:3:4: error: boom\r\n{ c\r\n   \\x }\r\n");
    let diagnostic = &diagnostics[0];
    assert_eq!((diagnostic.line, diagnostic.column), (3, Some(4)));
    assert_eq!(diagnostic.message, "boom");
    assert!(diagnostic.file.to_string_lossy().ends_with("a b.ly"));
}

#[test]
fn messages_without_a_location_attach_to_line_1_of_the_root_file() {
    let stderr = "warning: ignoring unsupported formats (pdf)\nfatal error: unable to change directory to: `missing-dir'";
    assert_eq!(
        parse(stderr),
        vec![
            d(
                &root(),
                1,
                None,
                Warning,
                "ignoring unsupported formats (pdf)"
            ),
            d(
                &root(),
                1,
                None,
                Error,
                "unable to change directory to: `missing-dir'"
            ),
        ]
    );
}

#[test]
fn a_location_inside_a_string_parsed_by_scheme_goes_to_the_root_with_its_origin() {
    let stderr = [
        "<included string>:1:6: error: unknown command: `\\nope'".to_owned(),
        "{ c4 ".into(),
        "     \\nope }".into(),
        "<string>:1:1: error: unknown command: `\\nada'".into(),
        String::new(),
        "\\nada".into(),
        format!("fatal error: failed files: \"{}\"", root().display()),
    ]
    .join("\n");
    assert_eq!(
        parse(&stderr),
        vec![
            d(
                &root(),
                1,
                None,
                Error,
                "unknown command: `\\nope'\n(in <included string>, line 1, column 6)"
            ),
            d(
                &root(),
                1,
                None,
                Error,
                "unknown command: `\\nada'\n(in <string>, line 1, column 1)"
            ),
        ]
    );
}

#[test]
fn failed_files_is_kept_when_it_is_the_only_sign_of_the_failure() {
    let r = root().display().to_string();
    let stderr =
        format!("{r}:2:3: warning: something odd\n{{ \n  c }}\nfatal error: failed files: \"{r}\"");
    assert_eq!(
        parse(&stderr)
            .into_iter()
            .map(|d| (d.severity, d.message))
            .collect::<Vec<_>>(),
        vec![
            (Warning, "something odd".to_owned()),
            (Error, format!("failed files: \"{r}\""))
        ]
    );
}

#[test]
fn a_programming_error_is_a_labelled_warning() {
    let stderr =
        "programming error: bounds of this piece aren’t breakable\ncontinuing, cross fingers";
    assert_eq!(
        parse(stderr),
        vec![d(
            &root(),
            1,
            None,
            Warning,
            "programming error: bounds of this piece aren’t breakable"
        )]
    );
}

#[test]
fn output_that_holds_no_message_yields_nothing() {
    assert_eq!(parse(""), vec![]);
    assert_eq!(
        parse(";;; note: auto-compilation is enabled\nBacktrace:\n  1 (primitive-load \"x\")\n"),
        vec![]
    );
}

#[test]
fn serializes_as_the_typescript_shape() {
    let json = serde_json::to_value(parse("warning: odd\n/scores/a.ly:2:3: error: bad"))
        .unwrap_or_default();
    assert_eq!(
        json,
        serde_json::json!([
            { "file": "/scores/root.ly", "line": 1, "severity": "warning", "message": "odd" },
            { "file": "/scores/a.ly", "line": 2, "column": 3, "severity": "error", "message": "bad" },
        ])
    );
}

/// What lilypond underlines, as diagnosticSpan (span.ts) finds it; enough of
/// it to check the columns against the real binary.
fn token_at(line: &str, column: Option<u32>) -> String {
    let Some(column) = column else {
        return line.trim().to_owned();
    };
    let start = lily_engrave::span::column_to_character(line, column as usize);
    let units: Vec<u16> = line.encode_utf16().collect();
    let rest = String::from_utf16_lossy(&units[start.min(units.len())..]);
    if rest.starts_with('(') {
        let before = String::from_utf16_lossy(&units[..start]);
        let mut depth = 0;
        let mut end = rest.len();
        for (index, char) in rest.char_indices() {
            if char == '(' {
                depth += 1;
            } else if char == ')' {
                depth -= 1;
                if depth == 0 {
                    end = index + 1;
                    break;
                }
            }
        }
        let hash = if before.ends_with('#') { "#" } else { "" };
        return format!("{hash}{}", &rest[..end]);
    }
    if let Some(command) = rest.strip_prefix('\\') {
        let name: String = command
            .chars()
            .take_while(|c| c.is_alphabetic() || *c == '-')
            .collect();
        return format!("\\{name}");
    }
    let word: String = rest
        .chars()
        .take_while(|c| c.is_alphanumeric() || "_.',!?-".contains(*c))
        .collect();
    if word.is_empty() {
        rest.chars().take(1).collect()
    } else {
        word
    }
}

#[tokio::test]
async fn stderr_of_a_failing_compile_maps_back_onto_the_source_text() {
    if common::lilypond("parse against the real binary")
        .await
        .is_none()
    {
        return;
    }
    let scratch = common::Scratch::new("lily-test-");
    let service = CompileService::new(CompileServiceOptions {
        tmp_root: Some(scratch.path.clone()),
        search_path: common::search_path(),
        ..Default::default()
    });
    let source = [
        "{",
        "\tc4 \\foo d",
        "  é 𝄞 \\bar \"|\" c4\t\\baz",
        "}",
        "#(car 5)",
        "",
    ]
    .join("\n");
    let root_file = scratch.write("süß dir/bad.ly", &source).await;

    let result = service
        .compile(CompileRequest {
            root_file: root_file.clone(),
            ..Default::default()
        })
        .await
        .expect("compiled");
    let diagnostics = parse_stderr(&result.stderr, &root_file, None);
    let lines: Vec<&str> = source.split('\n').collect();
    let found: Vec<String> = diagnostics
        .iter()
        .map(|d| {
            assert_eq!(d.file, root_file);
            let line = lines[d.line as usize - 1];
            let severity = if d.severity == Error {
                "error"
            } else {
                "warning"
            };
            format!(
                "{} {severity} {} | {}",
                d.line,
                token_at(line, d.column),
                d.message.split('\n').next().unwrap_or("")
            )
        })
        .collect();
    assert!(!result.ok);
    for expected in [
        "2 error \\foo | unknown command: `\\foo'",
        "3 error é | not a note name: é",
        "3 error 𝄞 | not a note name: 𝄞",
        "3 error \\baz | unknown command: `\\baz'",
        "5 error #(car 5) | Guile signaled an error for the expression beginning here",
    ] {
        assert!(
            found.iter().any(|f| f == expected),
            "{expected}\n  not in\n{}",
            found.join("\n")
        );
    }
    assert!(found.iter().any(|f| f.starts_with("1 warning ")
        && f.ends_with("| no \\version statement found, please add")));
    assert!(
        diagnostics
            .iter()
            .any(|d| d.message.contains("In procedure car")),
        "{}",
        found.join("\n")
    );
    assert!(
        !diagnostics
            .iter()
            .any(|d| d.message.contains("failed files")),
        "{}",
        found.join("\n")
    );
    // Nothing but messages and their context: no source excerpt leaked into a message.
    assert!(
        !diagnostics.iter().any(|d| d.message.contains("\\bar")),
        "{}",
        found.join("\n")
    );
    service.dispose().await;
}
