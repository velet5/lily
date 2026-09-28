//! `\include` graph → root resolution (DECISIONS D10, D18), from
//! src/compile/rootFile.ts.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

use crate::paths;

/// Immutable editor texts by path, captured together before any asynchronous work.
pub type SourceBuffers = HashMap<PathBuf, String>;

/// One alternation, scanned left to right, so that an `\include` inside a
/// comment or a string is skipped and a `%` inside a string starts no comment.
/// Only the first alternative captures.
static TOKEN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"\\include\s*"((?:[^"\\]|\\[\s\S])*)"|\\include(?-u:\b)|%\{[\s\S]*?(?:%\}|$)|%[^\n]*|"(?:[^"\\]|\\[\s\S])*(?:"|$)"#,
    )
    .expect("valid regex")
});
static ESCAPE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\\([\s\S])").expect("valid regex"));

/// One `\include` of a source text. Offsets are bytes into the text: `start`
/// is at the opening quote of the name (or the backslash when there is no
/// literal name) and `end` after the token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncludeToken {
    /// The name as written, unescaped; `None` for a name computed in Scheme.
    pub name: Option<String>,
    pub start: usize,
    pub end: usize,
}

/// The `\include`s of `source`. `\include` takes a string literal in
/// practice; a name computed in Scheme is not seen.
pub fn include_tokens(source: &str) -> Vec<IncludeToken> {
    TOKEN
        .captures_iter(source)
        .filter_map(|captures| {
            let whole = captures.get(0)?;
            if !whole.as_str().starts_with("\\include") {
                return None;
            }
            Some(IncludeToken {
                name: captures
                    .get(1)
                    .map(|name| ESCAPE.replace_all(name.as_str(), "$1").into_owned()),
                start: whole.start() + whole.as_str().find('"').unwrap_or(0),
                end: whole.end(),
            })
        })
        .collect()
}

/// The file names `source` includes, as written.
pub fn parse_includes(source: &str) -> Vec<String> {
    include_tokens(source)
        .into_iter()
        .filter_map(|token| token.name)
        .collect()
}

/// Directories given with `-I dir`, `-Idir`, `--include dir` or
/// `--include=dir` in the extra arguments, resolved against the root file's directory.
pub fn include_dirs_from_args(args: &[String], root_dir: &Path) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut index = 0;
    while index < args.len() {
        let arg = args[index].as_str();
        let dir: Option<&str> = if arg == "-I" || arg == "--include" {
            index += 1;
            args.get(index).map(String::as_str)
        } else if let Some(dir) = arg.strip_prefix("--include=") {
            Some(dir)
        } else {
            arg.strip_prefix("-I")
        };
        if let Some(dir) = dir.filter(|dir| !dir.is_empty()) {
            dirs.push(paths::resolve_from(root_dir, dir));
        }
        index += 1;
    }
    dirs
}

#[derive(Debug, Clone, Default)]
pub struct IncludeOptions {
    /// Extra search directories, see `include_dirs_from_args`.
    pub include_dirs: Vec<PathBuf>,
    pub buffers: Option<SourceBuffers>,
    /// Treat a root with a computed include as reaching everything.
    pub conservative: bool,
}

/// `include_closure`, and the places where includes that were not found would be.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IncludeGraph {
    /// As `include_closure` returns them.
    pub files: HashSet<PathBuf>,
    /// For each name that resolves nowhere, every path lilypond would look for
    /// it at, absolute: a file created at one of them joins the score. Library
    /// names such as `english.ly` are among them.
    pub missing: Vec<PathBuf>,
}

/// Every file `root_file` reaches through `\include`, itself included, as
/// canonical paths. A name is looked up the way lilypond 2.26 does it
/// [verified]: the including file's directory, the root's directory, then the
/// `-I` directories. Every hit counts, not just the first: a false edge costs
/// one recompile, a missing one leaves a stale preview. Names that resolve
/// nowhere (`english.ly` and the rest of lilypond's own library) are not part
/// of the answer.
pub async fn include_closure(root_file: &Path, options: &IncludeOptions) -> HashSet<PathBuf> {
    include_graph(root_file, options).await.files
}

pub async fn include_graph(root_file: &Path, options: &IncludeOptions) -> IncludeGraph {
    let buffers = canonical_buffers(options.buffers.as_ref()).await;
    let root = canonical(root_file).await;
    let root_dir = paths::dirname(&root);
    let mut seen: HashSet<PathBuf> = HashSet::from([root.clone()]);
    let mut missing: Vec<PathBuf> = Vec::new();
    let mut queue = VecDeque::from([root]);
    while let Some(file) = queue.pop_front() {
        let source = match buffers.get(&file) {
            Some(text) => text.clone(),
            None => match tokio::fs::read_to_string(&file).await {
                Ok(text) => text,
                Err(_) => continue,
            },
        };
        let mut dirs: Vec<PathBuf> = Vec::new();
        for dir in [paths::dirname(&file), root_dir.clone()]
            .into_iter()
            .chain(options.include_dirs.iter().cloned())
        {
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
        for name in parse_includes(&source) {
            let mut candidates = Vec::new();
            let mut found = false;
            for dir in &dirs {
                let candidate = paths::resolve_from(dir, &name);
                let real = canonical(&candidate).await;
                let target = if buffers.contains_key(&real) {
                    Some(real)
                } else {
                    existing(&candidate).await
                };
                candidates.push(candidate);
                let Some(target) = target else { continue };
                found = true;
                if seen.insert(target.clone()) {
                    queue.push_back(target);
                }
            }
            if !found {
                for candidate in candidates {
                    if !missing.contains(&candidate) {
                        missing.push(candidate);
                    }
                }
            }
        }
    }
    IncludeGraph {
        files: seen,
        missing,
    }
}

/// Those of `roots` that compile `file`: the file itself, or a root whose
/// includes reach it. Order of `roots` is kept.
pub async fn roots_including(
    file: &Path,
    roots: &[PathBuf],
    options_for: impl Fn(&Path) -> IncludeOptions,
) -> Vec<PathBuf> {
    let target = canonical(file).await;
    let mut reached = Vec::new();
    for root in roots {
        let options = options_for(root);
        let closure = include_closure(root, &options).await;
        if closure.contains(&target) {
            reached.push(root.clone());
            continue;
        }
        if options.conservative {
            for source in &closure {
                let text = match options.buffers.as_ref().and_then(|b| b.get(source)) {
                    Some(text) => text.clone(),
                    None => tokio::fs::read_to_string(source).await.unwrap_or_default(),
                };
                if include_tokens(&text).iter().any(|t| t.name.is_none())
                    || text.contains("ly:parser-include")
                {
                    reached.push(root.clone());
                    break;
                }
            }
        }
    }
    reached
}

/// Symlinks and, on case-insensitive volumes, spelling must not hide a match.
pub(crate) async fn canonical(file: &Path) -> PathBuf {
    match existing(file).await {
        Some(real) => real,
        None => paths::resolve(file),
    }
}

async fn existing(file: &Path) -> Option<PathBuf> {
    let real = tokio::fs::canonicalize(file).await.ok()?;
    tokio::fs::metadata(&real)
        .await
        .ok()?
        .is_file()
        .then_some(real)
}

/// Editors may open a symlink while a literal include uses the real path.
pub async fn canonical_buffers(buffers: Option<&SourceBuffers>) -> SourceBuffers {
    let mut result = SourceBuffers::new();
    for (file, text) in buffers.into_iter().flatten() {
        result.insert(canonical(file).await, text.clone());
    }
    result
}
