//! Pure functions from lilypond's stderr to editor-independent diagnostics
//! (DECISIONS D6, D16), from src/diagnostics/parse.ts.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::paths;
use crate::span::{display_width, js_trim};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LySeverity {
    Error,
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct LyDiagnostic {
    /// Absolute path; the root file for messages that carry no location.
    pub file: PathBuf,
    /// 1-based; 1 for messages that carry no location.
    pub line: u32,
    /// As lilypond prints it: 1-based, counted in code points with tabs
    /// advancing to the next multiple of 8. Convert with
    /// `span::column_to_character`. Absent when the message names only a line,
    /// or no location at all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub column: Option<u32>,
    pub severity: LySeverity,
    /// Without the severity keyword; continuation lines are joined with `\n`.
    pub message: String,
}

// JavaScript's `.`: anything but a line terminator.
const ANY: &str = r"[^\n\r  ]";
const KEYWORDS: &str = "fatal error|programming error|error|warning";

// Tried first, so that a bare message quoting a location is not read as located.
static BARE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("^({KEYWORDS}): ({ANY}*)$")).expect("valid regex"));
// The lazy path stops at the first `:LINE[:COL]: keyword:`; the colon of a
// Windows drive letter is not followed by digits and is skipped.
static LOCATED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"^({ANY}+?):(\d+)(?::(\d+))?: ({KEYWORDS}): ({ANY}*)$"
    ))
    .expect("valid regex")
});

struct Header {
    file: Option<String>,
    line: Option<u32>,
    column: Option<u32>,
    keyword: String,
    message: String,
}

/// Parses the stderr of a run made with English messages (`LANGUAGE=en`,
/// D15). Messages without a location go to `root_file`; relative paths
/// resolve against `cwd`, which defaults to the root's directory. Order of
/// first appearance is kept; identical entries are reported once.
pub fn parse_stderr(stderr: &str, root_file: &Path, cwd: Option<&Path>) -> Vec<LyDiagnostic> {
    let root_file = paths::resolve(root_file);
    let cwd = cwd.map_or_else(|| paths::dirname(&root_file), Path::to_path_buf);
    let lines: Vec<&str> = stderr
        .split('\n')
        .map(|line| line.strip_suffix('\r').unwrap_or(line))
        .collect();

    let mut diagnostics: Vec<LyDiagnostic> = Vec::new();
    let mut index = 0;
    while index < lines.len() {
        let header = parse_header(lines[index]);
        index += 1;
        // Anything before the first message (Guile notes, backtraces) stays in
        // the raw output only.
        let Some(header) = header else { continue };

        let mut block: Vec<&str> = Vec::new();
        while index < lines.len() && parse_header(lines[index]).is_none() {
            block.push(lines[index]);
            index += 1;
        }

        // Text parsed by Scheme is located in `<included string>` or
        // `<string>`, which is no file: the message goes to the root and names
        // where it was.
        let in_string = header
            .file
            .as_deref()
            .is_some_and(|f| f.len() >= 2 && f.starts_with('<') && f.ends_with('>'));
        let show = |n: Option<u32>| n.map_or_else(|| "undefined".to_owned(), |n| n.to_string());
        let origin = format!(
            "(in {}, line {}, column {})",
            header.file.as_deref().unwrap_or("undefined"),
            show(header.line),
            show(header.column)
        );
        let mut parts: Vec<&str> = vec![&header.message];
        parts.extend(continuation(&block, header.column));
        parts.push(if in_string { &origin } else { "" });
        let message = parts
            .into_iter()
            .map(js_trim)
            // "continuing, cross fingers" follows every programming error.
            .filter(|line| !line.is_empty() && *line != "continuing, cross fingers")
            .collect::<Vec<_>>()
            .join("\n");
        let located = header.file.is_some() && !in_string;
        let diagnostic = LyDiagnostic {
            file: match (&header.file, located) {
                (Some(file), true) => paths::resolve_from(&cwd, file),
                _ => root_file.clone(),
            },
            line: if located {
                header.line.unwrap_or(1).max(1)
            } else {
                1
            },
            column: if located {
                header.column.map(|c| c.max(1))
            } else {
                None
            },
            severity: if header.keyword == "error" || header.keyword == "fatal error" {
                LySeverity::Error
            } else {
                LySeverity::Warning
            },
            // A programming error is a lilypond bug the run survived; say so.
            message: if header.keyword == "programming error" {
                format!("programming error: {message}")
            } else {
                message
            },
        };
        if !diagnostics.contains(&diagnostic) {
            diagnostics.push(diagnostic);
        }
    }

    // `fatal error: failed files: "…"` closes every failed run. Next to the
    // errors that caused it, it is noise; alone, it is the only sign of the failure.
    let is_summary =
        |d: &LyDiagnostic| d.column.is_none() && d.message.starts_with("failed files: ");
    let has_cause = diagnostics
        .iter()
        .any(|d| d.severity == LySeverity::Error && !is_summary(d));
    if has_cause {
        diagnostics.retain(|d| !is_summary(d));
    }
    diagnostics
}

fn parse_header(line: &str) -> Option<Header> {
    if let Some(bare) = BARE.captures(line) {
        return Some(Header {
            file: None,
            line: None,
            column: None,
            keyword: bare[1].to_owned(),
            message: bare[2].to_owned(),
        });
    }
    let located = LOCATED.captures(line)?;
    Some(Header {
        file: Some(located[1].to_owned()),
        line: Some(number(&located[2])),
        column: located.get(3).map(|c| number(c.as_str())),
        keyword: located[4].to_owned(),
        message: located[5].to_owned(),
    })
}

fn number(digits: &str) -> u32 {
    digits.parse().unwrap_or(u32::MAX)
}

/// The lines of a message block that belong to the message. A message with a
/// column is followed by two context lines: the source line up to the column,
/// then the rest of it indented to the column. Message text can come before
/// them (`(search path: …)`) and after them (Guile's `In procedure car: …`).
fn continuation<'a>(block: &[&'a str], column: Option<u32>) -> Vec<&'a str> {
    // Column 0 would ask for an indent of -1, which no line has.
    let Some(indent) = column.and_then(|c| (c as usize).checked_sub(1)) else {
        return block.to_vec();
    };
    for index in 0..block.len().saturating_sub(1) {
        let rest = block[index + 1];
        // The first `indent` UTF-16 units are whitespace: whitespace is never astral.
        let blank = rest
            .chars()
            .take(indent)
            .filter(|c| crate::span::is_js_space(*c))
            .count()
            == indent;
        if display_width(block[index]) == indent && blank {
            let mut lines = block[..index].to_vec();
            lines.extend_from_slice(&block[index + 2..]);
            return lines;
        }
    }
    block.to_vec()
}
