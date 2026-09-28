//! Reading point-and-click links (DECISIONS D7, D19, D32), from
//! src/preview/pointAndClick.ts. LilyPond wraps what a piece of input produced
//! in `<a xlink:href="textedit://PATH:LINE:CHAR:COLUMN">`.

use std::path::PathBuf;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

use crate::paths;
use crate::snapshot::decode_uri_component;
use crate::span::js_trim;

/// A place in a source file, in the numbers LilyPond prints.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SourceLocation {
    /// Absolute and decoded.
    pub file: PathBuf,
    /// 1-based.
    pub line: u64,
    /// 0-based, in code points, tabs not expanded: the `CHAR` field.
    pub char: u64,
}

static TEXTEDIT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?s)^textedit://(.+):(\d+):(\d+):\d+$").expect("valid regex"));
static DRIVE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^/[A-Za-z]:[\\/]").expect("valid regex"));

/// JavaScript's `Number.MAX_SAFE_INTEGER`.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// Reads a `textedit:` link. The numbers are taken from the right, because a
/// Windows path has a colon of its own; `COLUMN`, the tab-expanded form of
/// `CHAR`, is not needed.
pub fn parse_text_edit(href: &str) -> Option<SourceLocation> {
    let captures = TEXTEDIT.captures(js_trim(href))?;
    let mut file = decode_uri_component(&captures[1]).ok()?;
    // `/C:/scores/a.ly` when the link was written with three slashes.
    if DRIVE.is_match(&file) {
        file.remove(0);
    }
    let line = safe_integer(&captures[2])?;
    let char = safe_integer(&captures[3])?;
    if !file.starts_with('/') || file.contains('\0') || line < 1 {
        return None;
    }
    Some(SourceLocation {
        file: paths::normalize(&file),
        line,
        char,
    })
}

fn safe_integer(digits: &str) -> Option<u64> {
    digits
        .parse::<u64>()
        .ok()
        .filter(|n| *n <= MAX_SAFE_INTEGER)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn location(file: &str, line: u64, char: u64) -> Option<SourceLocation> {
        Some(SourceLocation {
            file: PathBuf::from(file),
            line,
            char,
        })
    }

    // The hrefs are verbatim 2.26 output.
    #[test]
    fn reads_file_line_and_char() {
        assert_eq!(
            parse_text_edit("textedit:///scores/song.ly:12:4:5"),
            location("/scores/song.ly", 12, 4)
        );
        let json = serde_json::to_value(location("/scores/song.ly", 12, 4)).unwrap_or_default();
        assert_eq!(
            json,
            serde_json::json!({ "file": "/scores/song.ly", "line": 12, "char": 4 })
        );
    }

    #[test]
    fn the_path_is_percent_decoded() {
        assert_eq!(
            parse_text_edit("textedit:///tmp/odd%20dir/a%26b%20%27q%27%20%c3%a9%23%25.ly:3:11:12"),
            location("/tmp/odd dir/a&b 'q' é#%.ly", 3, 11)
        );
    }

    #[test]
    fn the_numbers_are_taken_from_the_right() {
        assert_eq!(
            parse_text_edit("textedit:///scores/a:1:2/b.ly:3:4:5"),
            location("/scores/a:1:2/b.ly", 3, 4)
        );
    }

    #[test]
    fn a_path_through_dotdot_is_spelled_plainly() {
        assert_eq!(
            parse_text_edit("textedit:///scores/parts/../lib/a.ily:1:0:1").map(|l| l.file),
            Some(PathBuf::from("/scores/lib/a.ily"))
        );
    }

    #[test]
    fn anything_else_is_not_a_location() {
        for href in [
            "https://lilypond.org",
            "textedit://relative/song.ly:1:2:3",
            "textedit:///scores/song.ly:1:2",
            "textedit:///scores/song.ly:0:2:3",
            "textedit:///scores/song.ly:1:-2:3",
            "textedit:///scores/%zz.ly:1:2:3",
            "textedit:///scores/a%00.ly:1:2:3",
            "textedit:///scores/song.ly:99999999999999999999:2:3",
        ] {
            assert_eq!(parse_text_edit(href), None, "{href}");
        }
    }
}
