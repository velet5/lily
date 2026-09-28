//! A private copy of a score's unsaved texts (DECISIONS D25), from
//! src/compile/snapshot.ts: the root and its literal include closure are
//! written into the run directory with every include rewritten to the copy,
//! and diagnostics and `textedit:` links are mapped back to the real files.
//!
//! Offsets are bytes of UTF-8 here where the TypeScript counted UTF-16 units;
//! both are converted from and to lilypond's numbers (code points for `CHAR`,
//! tab-expanded code points for the column) the same way.

use std::collections::HashMap;
use std::fmt;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::LazyLock;

use regex::{Captures, Regex};

use crate::parse::LyDiagnostic;
use crate::paths;
use crate::root_file::{SourceBuffers, canonical_buffers, include_dirs_from_args, include_tokens};
use crate::span::{char_to_byte, column_to_byte};

#[derive(Debug, Clone)]
struct Replacement {
    start: usize,
    end: usize,
    text: String,
}

#[derive(Debug, Clone)]
struct Source {
    file: PathBuf,
    encoded_file: String,
    text: String,
    generated: String,
    replacements: Vec<Replacement>,
}

/// Why a snapshot could not be made.
#[derive(Debug)]
pub enum SnapshotError {
    /// The sources include files in a way a snapshot cannot follow; an editing
    /// diagnostic, not a failure to start.
    Unavailable(String),
    Io(std::io::Error),
}

impl fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable(message) => f.write_str(message),
            Self::Io(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for SnapshotError {}

static SCHEME_INCLUDE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"ly:(?:parser-include-string|parser-include-file|parse-file)(?-u:\b)")
        .expect("valid regex")
});
static LINK: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"textedit://([^"<>]+):(\d+):(\d+):(\d+)"#).expect("valid regex"));

#[derive(Debug, Default)]
pub struct SourceSnapshot {
    /// The text each real file had in the snapshot, by its resolved path.
    pub sources: HashMap<PathBuf, String>,
    files: HashMap<PathBuf, Source>,
    /// The snapshot's copy of the root, which lilypond compiles.
    pub root_file: PathBuf,
}

struct Visit<'a> {
    snapshot: SourceSnapshot,
    buffers: &'a SourceBuffers,
    real_buffers: SourceBuffers,
    dirs: Vec<PathBuf>,
    directory: PathBuf,
    visited: HashMap<PathBuf, PathBuf>,
    dirty: bool,
}

type VisitFuture<'b> = Pin<Box<dyn Future<Output = Result<PathBuf, SnapshotError>> + Send + 'b>>;

impl Visit<'_> {
    fn visit(&mut self, file: PathBuf) -> VisitFuture<'_> {
        Box::pin(async move {
            let file = paths::resolve(&file);
            let real = tokio::fs::canonicalize(&file)
                .await
                .unwrap_or_else(|_| file.clone());
            if let Some(previous) = self.visited.get(&real) {
                return Ok(previous.clone());
            }
            let text = match self
                .buffers
                .get(&file)
                .or_else(|| self.real_buffers.get(&real))
            {
                Some(text) => text.clone(),
                None => tokio::fs::read_to_string(&file)
                    .await
                    .map_err(SnapshotError::Io)?,
            };
            let target = self
                .directory
                .join(self.visited.len().to_string())
                .join(paths::basename(&file));
            self.visited.insert(real, target.clone()); // before recursing: includes may be cyclic
            self.snapshot.sources.insert(file.clone(), text.clone());
            let mut replacements = Vec::new();
            for token in include_tokens(&text) {
                let Some(name) = token.name else {
                    if self.dirty {
                        return Err(SnapshotError::Unavailable(format!(
                            "Cannot snapshot a computed \\include in {}. Use literal include paths for unsaved preview.",
                            file.display()
                        )));
                    }
                    continue;
                };
                let mut included = None;
                for dir in std::iter::once(paths::dirname(&file)).chain(self.dirs.iter().cloned()) {
                    let candidate = paths::resolve_from(&dir, &name);
                    if self.buffers.contains_key(&candidate)
                        || tokio::fs::metadata(&candidate)
                            .await
                            .is_ok_and(|m| m.is_file())
                    {
                        included = Some(candidate);
                        break;
                    }
                }
                // LilyPond's own library remains on its standard search path.
                if let Some(included) = included {
                    let copy = self.visit(included).await?;
                    let quoted = serde_json::to_string(&copy.to_string_lossy())
                        .map_err(|e| SnapshotError::Io(e.into()))?;
                    replacements.push(Replacement {
                        start: token.start,
                        end: token.end,
                        text: quoted,
                    });
                }
            }
            if self.dirty && SCHEME_INCLUDE.is_match(&text) {
                return Err(SnapshotError::Unavailable(format!(
                    "Cannot snapshot Scheme-generated includes in {}. Use literal include paths for unsaved preview.",
                    file.display()
                )));
            }
            let mut generated = text.clone();
            for r in replacements.iter().rev() {
                generated.replace_range(r.start..r.end, &r.text);
            }
            if let Some(parent) = target.parent() {
                tokio::fs::create_dir_all(parent)
                    .await
                    .map_err(SnapshotError::Io)?;
            }
            tokio::fs::write(&target, &generated)
                .await
                .map_err(SnapshotError::Io)?;
            let encoded_file = encode_source_path(&file.to_string_lossy());
            self.snapshot.files.insert(
                target.clone(),
                Source {
                    file,
                    encoded_file,
                    text,
                    generated,
                    replacements,
                },
            );
            Ok(target)
        })
    }
}

/// A place in an original file, in lilypond's numbers.
struct Location {
    file: PathBuf,
    line: usize,
    char: usize,
    column: usize,
}

impl SourceSnapshot {
    /// Copies `root` and what it includes into `directory`, taking the texts of
    /// `buffers` in place of the files on disk. `args` are the extra lilypond
    /// arguments, for their `-I` directories.
    pub async fn create(
        root: &Path,
        buffers: &SourceBuffers,
        directory: &Path,
        args: &[String],
    ) -> Result<SourceSnapshot, SnapshotError> {
        let root_dir = paths::dirname(root);
        let mut dirs = vec![root_dir.clone()];
        dirs.extend(include_dirs_from_args(args, &root_dir));
        let mut visit = Visit {
            snapshot: SourceSnapshot::default(),
            buffers,
            real_buffers: canonical_buffers(Some(buffers)).await,
            dirs,
            directory: directory.to_path_buf(),
            visited: HashMap::new(),
            dirty: !buffers.is_empty(),
        };
        let root_copy = visit.visit(root.to_path_buf()).await?;
        visit.snapshot.root_file = root_copy;
        Ok(visit.snapshot)
    }

    /// `byte` of `line` (1-based) of the generated text of `file` → the original.
    fn location(&self, source: &Source, line: usize, byte: usize) -> Location {
        let offset = source
            .generated
            .split('\n')
            .take(line.saturating_sub(1))
            .map(|l| l.len() + 1)
            .sum::<usize>()
            + byte;
        let mut delta: isize = 0;
        let mut original = offset;
        for r in &source.replacements {
            let start = (r.start as isize + delta) as usize;
            if offset < start {
                break;
            }
            if offset < start + r.text.len() {
                original = r.start;
                break;
            }
            delta += r.text.len() as isize - (r.end - r.start) as isize;
            original = (offset as isize - delta) as usize;
        }
        let mut original = original.min(source.text.len());
        while !source.text.is_char_boundary(original) {
            original -= 1;
        }
        let before = &source.text[..original];
        let prefix = before.rsplit('\n').next().unwrap_or("");
        Location {
            file: source.file.clone(),
            line: before.split('\n').count(),
            char: prefix.chars().count(),
            column: visual_column(prefix),
        }
    }

    /// `d`, which names the snapshot's files, as it concerns the real ones.
    pub fn diagnostic(&self, d: &LyDiagnostic) -> LyDiagnostic {
        let Some(source) = self.files.get(&paths::normalize(&d.file)) else {
            return d.clone();
        };
        if source.replacements.is_empty() {
            return LyDiagnostic {
                file: source.file.clone(),
                ..d.clone()
            };
        }
        let line = source
            .generated
            .split('\n')
            .nth((d.line as usize).saturating_sub(1))
            .unwrap_or("");
        let loc = self.location(
            source,
            d.line as usize,
            column_to_byte(line, d.column.unwrap_or(1) as usize),
        );
        LyDiagnostic {
            file: loc.file,
            line: loc.line as u32,
            column: d.column.map(|_| loc.column as u32),
            ..d.clone()
        }
    }

    /// Rewrites the textedit links of `text` (an SVG page, or the playback map
    /// of D26) to the real files. Normalize before hashing: temporary paths
    /// never become page identities.
    pub fn links(&self, text: &str) -> String {
        LINK.replace_all(text, |captures: &Captures<'_>| {
            let link = &captures[0];
            let (line, char, column) = (&captures[2], &captures[3], &captures[4]);
            let Ok(file) = decode_uri_component(&captures[1]) else {
                return link.to_owned();
            };
            let Some(source) = self.files.get(&paths::normalize(&file)) else {
                return link.to_owned();
            };
            // Most source files contain no rewritten includes. Keep LilyPond's
            // exact positions and avoid rescanning the whole source for every printed note.
            if source.replacements.is_empty() {
                return format!("textedit://{}:{line}:{char}:{column}", source.encoded_file);
            }
            let line_number: usize = line.parse().unwrap_or(usize::MAX);
            let generated_line = source
                .generated
                .split('\n')
                .nth(line_number.saturating_sub(1))
                .unwrap_or("");
            let byte = char_to_byte(generated_line, char.parse().unwrap_or(usize::MAX));
            let loc = self.location(source, line_number, byte);
            format!(
                "textedit://{}:{}:{}:{}",
                source.encoded_file, loc.line, loc.char, loc.column
            )
        })
        .into_owned()
    }
}

/// Matches ly:string-percent-encode, including lowercase UTF-8 hex. Otherwise
/// a save invalidates identical pages for non-ASCII filenames; # and ? also
/// need escaping so they cannot become URI fragments or queries.
pub(crate) fn encode_source_path(file: &str) -> String {
    let mut encoded = String::with_capacity(file.len());
    for byte in file.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/' | b':') {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02x}"));
        }
    }
    encoded
}

/// `decodeURIComponent`: fails on a malformed escape or bytes that are not UTF-8.
pub(crate) fn decode_uri_component(text: &str) -> Result<String, ()> {
    let bytes = text.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes
                .get(index + 1..index + 3)
                .filter(|h| h.iter().all(u8::is_ascii_hexdigit))
                .ok_or(())?;
            let hex = std::str::from_utf8(hex).map_err(|_| ())?;
            decoded.push(u8::from_str_radix(hex, 16).map_err(|_| ())?);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(decoded).map_err(|_| ())
}

fn visual_column(text: &str) -> usize {
    crate::span::display_width(text) + 1
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_encoding_matches_lilypond() {
        assert_eq!(
            encode_source_path("/tmp/Как #?&'()!~.ly"),
            "/tmp/%d0%9a%d0%b0%d0%ba%20%23%3f%26%27%28%29%21%7e.ly"
        );
        assert_eq!(decode_uri_component("/a%20b%c3%a9").as_deref(), Ok("/a bé"));
        assert!(decode_uri_component("%zz").is_err());
        assert!(decode_uri_component("%c3").is_err());
        assert!(decode_uri_component("%2").is_err());
    }
}

#[cfg(test)]
mod snapshot_tests {
    use super::*;
    use crate::parse::LySeverity;

    #[tokio::test]
    async fn copies_rewrites_and_maps_back() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let base = dir.path().canonicalize().expect("real");
        let root = base.join("λ root.ly");
        let part = base.join("part.ily");
        tokio::fs::write(&part, "music = { d'4 }\n")
            .await
            .expect("write");
        let text = "\\version \"2.26.0\"\n\t\\include \"part.ily\" { \\music c'4 }\n";
        let buffers: SourceBuffers = [(root.clone(), text.to_owned())].into_iter().collect();
        let snapshot = SourceSnapshot::create(&root, &buffers, &base.join("sources"), &[])
            .await
            .expect("a snapshot");

        let root_copy = base.join("sources/0/λ root.ly");
        let part_copy = base.join("sources/1/part.ily");
        assert_eq!(snapshot.root_file, root_copy);
        assert_eq!(snapshot.sources.get(&root).map(String::as_str), Some(text));
        assert_eq!(
            tokio::fs::read_to_string(&part_copy).await.expect("copied"),
            "music = { d'4 }\n"
        );
        let generated = tokio::fs::read_to_string(&root_copy).await.expect("copied");
        let quoted = serde_json::to_string(&part_copy.to_string_lossy()).expect("json");
        assert_eq!(
            generated,
            format!("\\version \"2.26.0\"\n\t\\include {quoted} {{ \\music c'4 }}\n")
        );

        // `c'4` after the rewritten include, as lilypond sees it in the copy.
        let line = generated.split('\n').nth(1).expect("line 2");
        let char = line[..line.find("c'4").expect("c'4")].chars().count();
        let column = crate::span::display_width(&line[..line.find("c'4").expect("c'4")]) + 1;
        let original = text.split('\n').nth(1).expect("line 2");
        let real_char = original[..original.find("c'4").expect("c'4")]
            .chars()
            .count();
        let real_column =
            crate::span::display_width(&original[..original.find("c'4").expect("c'4")]) + 1;

        let d = LyDiagnostic {
            file: root_copy.clone(),
            line: 2,
            column: Some(column as u32),
            severity: LySeverity::Error,
            message: "x".into(),
        };
        let mapped = snapshot.diagnostic(&d);
        assert_eq!(
            (mapped.file, mapped.line, mapped.column),
            (root.clone(), 2, Some(real_column as u32))
        );
        // Inside the rewritten include: the include itself.
        let at_include = snapshot.diagnostic(&LyDiagnostic {
            column: Some(20),
            ..d.clone()
        });
        assert_eq!(
            at_include.column,
            Some(crate::span::display_width("\t\\include ") as u32 + 1)
        );
        // A file without rewritten includes keeps lilypond's numbers.
        let in_part = snapshot.diagnostic(&LyDiagnostic {
            file: part_copy.clone(),
            ..d.clone()
        });
        assert_eq!(
            (in_part.file, in_part.column),
            (part.clone(), Some(column as u32))
        );

        let encoded_copy = encode_source_path(&root_copy.to_string_lossy());
        let svg = format!(
            "<a xlink:href=\"textedit://{encoded_copy}:2:{char}:{column}\"></a><a xlink:href=\"textedit://{}:1:10:11\"></a><a xlink:href=\"textedit:///elsewhere.ly:1:2:3\"></a>",
            encode_source_path(&part_copy.to_string_lossy())
        );
        let expected = format!(
            "<a xlink:href=\"textedit://{}:2:{real_char}:{real_column}\"></a><a xlink:href=\"textedit://{}:1:10:11\"></a><a xlink:href=\"textedit:///elsewhere.ly:1:2:3\"></a>",
            encode_source_path(&root.to_string_lossy()),
            encode_source_path(&part.to_string_lossy())
        );
        assert_eq!(snapshot.links(&svg), expected);
    }

    #[tokio::test]
    async fn computed_includes_cannot_be_snapshotted_with_unsaved_texts() {
        let dir = tempfile::tempdir().expect("a temp dir");
        let root = dir.path().join("computed.ly");
        let text = "\\include #(string-append \"a\" \".ily\")\n";
        let buffers: SourceBuffers = [(root.clone(), text.to_owned())].into_iter().collect();
        let error = SourceSnapshot::create(&root, &buffers, &dir.path().join("sources"), &[])
            .await
            .expect_err("computed");
        assert!(
            matches!(error, SnapshotError::Unavailable(ref m) if m.contains("computed \\include")),
            "{error}"
        );
        let scheme: SourceBuffers = [(
            root.clone(),
            "#(ly:parser-include-string \"{ c }\")\n".to_owned(),
        )]
        .into_iter()
        .collect();
        let error = SourceSnapshot::create(&root, &scheme, &dir.path().join("sources"), &[])
            .await
            .expect_err("scheme");
        assert!(error.to_string().contains("Scheme-generated includes"));
    }
}
