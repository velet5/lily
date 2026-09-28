//! File access for Lily Studio (DECISIONS D29), from studio/src/files.ts. The
//! renderer never names a path the user has not picked: it may read and write
//! only files inside the folder opened with a dialog, or a file chosen with one.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::collate::{Sensitivity, compare};
use crate::paths;
use crate::templates::template;

/// Extensions shown in the file list and accepted by the open dialog.
pub const SCORE_EXTENSIONS: &[&str] = &[".ly", ".ily", ".lyi"];

/// Directories the file list does not descend into.
const SKIPPED_DIRECTORIES: &[&str] = &["node_modules", "out", "dist"];
const MAX_DEPTH: usize = 4;
const MAX_FILES: usize = 500;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScoreFile {
    /// Absolute path.
    pub path: PathBuf,
    /// Relative to the folder, with `/` as separator, for display and sorting.
    pub relative: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FolderListing {
    pub folder: PathBuf,
    pub name: String,
    pub files: Vec<ScoreFile>,
    /// True when MAX_FILES was reached and the list is cut short.
    pub truncated: bool,
}

pub fn is_score_file(file: impl AsRef<Path>) -> bool {
    SCORE_EXTENSIONS.contains(&paths::extension_lower(file).as_str())
}

/// The LilyPond files under `folder`, at most MAX_DEPTH directories down,
/// skipping hidden entries and build output. Files of a directory come before
/// its subdirectories; both sorted by name, case-insensitively.
pub async fn list_folder(folder: &Path) -> FolderListing {
    let root = paths::resolve(folder);
    let mut files = Vec::new();
    let mut truncated = false;
    walk(&root, &root, 0, &mut files, &mut truncated).await;
    let name = paths::basename(&root);
    let name = if name.is_empty() {
        root.to_string_lossy().into_owned()
    } else {
        name
    };
    FolderListing {
        folder: root,
        name,
        files,
        truncated,
    }
}

fn walk<'a>(
    root: &'a Path,
    directory: &'a Path,
    depth: usize,
    files: &'a mut Vec<ScoreFile>,
    truncated: &'a mut bool,
) -> futures::future::BoxFuture<'a, ()> {
    Box::pin(async move {
        let Ok(mut reader) = tokio::fs::read_dir(directory).await else {
            return; // Unreadable subdirectories are left out, not reported.
        };
        let mut scores = Vec::new();
        let mut directories = Vec::new();
        while let Ok(Some(entry)) = reader.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            let Ok(kind) = entry.file_type().await else {
                continue;
            };
            if kind.is_file() && is_score_file(&name) {
                scores.push(name);
            } else if kind.is_dir() && !SKIPPED_DIRECTORIES.contains(&name.as_str()) {
                directories.push(name);
            }
        }
        let by_name = |a: &String, b: &String| compare(a, b, Sensitivity::Base);
        scores.sort_by(by_name);
        directories.sort_by(by_name);
        for name in scores {
            if files.len() >= MAX_FILES {
                *truncated = true;
                return;
            }
            let absolute = directory.join(&name);
            let relative = paths::relative(root, &absolute);
            files.push(ScoreFile {
                path: absolute,
                relative,
            });
        }
        if depth >= MAX_DEPTH {
            return;
        }
        for name in directories {
            walk(root, &directory.join(&name), depth + 1, files, truncated).await;
            if *truncated {
                return;
            }
        }
    })
}

/// True when `file` is `folder` itself or lies somewhere below it.
pub fn is_inside(folder: impl AsRef<Path>, file: impl AsRef<Path>) -> bool {
    let relative = paths::relative(folder, file);
    relative.is_empty() || (!relative.starts_with("..") && !relative.starts_with('/'))
}

/// What the renderer may touch: the open folder and single files the user
/// picked in a dialog. Every command that takes a path asks `check` first.
#[derive(Debug, Clone, Default)]
pub struct Access {
    pub folder: Option<PathBuf>,
    picked: HashSet<PathBuf>,
}

impl Access {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn allow_file(&mut self, file: impl AsRef<Path>) {
        self.picked.insert(paths::resolve(file));
    }

    pub fn allows(&self, file: impl AsRef<Path>) -> bool {
        let absolute = paths::resolve(file);
        self.picked.contains(&absolute)
            || self
                .folder
                .as_ref()
                .is_some_and(|folder| is_inside(folder, &absolute))
    }

    /// The resolved path, or why the renderer may not use it.
    pub fn check(&self, file: &str) -> Result<PathBuf, String> {
        if !file.starts_with('/') {
            return Err("Expected an absolute path.".to_owned());
        }
        if !is_score_file(file) {
            return Err(format!("Not a LilyPond file: {}", paths::basename(file)));
        }
        if !self.allows(file) {
            return Err(format!("{file} is outside the open folder."));
        }
        Ok(paths::resolve(file))
    }

    /// `check` of a value straight from the renderer, which may not be a string.
    pub fn check_value(&self, file: &Value) -> Result<PathBuf, String> {
        match file {
            Value::String(file) => self.check(file),
            _ => Err("Expected an absolute path.".to_owned()),
        }
    }
}

pub async fn read_score(file: &Path) -> std::io::Result<String> {
    tokio::fs::read_to_string(file).await
}

pub async fn write_score(file: &Path, text: &str) -> std::io::Result<()> {
    tokio::fs::write(file, text).await
}

/// Writes a new score from a template. An existing file is replaced: the save
/// dialog that chose `file` has already asked about that.
pub async fn create_from_template(file: &Path, template_id: &str) -> Result<(), String> {
    let Some(template) = template(template_id) else {
        return Err(format!("Unknown template: {template_id}"));
    };
    tokio::fs::write(file, template.text)
        .await
        .map_err(|e| e.to_string())
}

/// `Untitled.ly`, or `Untitled 2.ly` and so on when that exists in `folder`.
pub async fn unused_name(folder: &Path, base: &str, extension: &str) -> PathBuf {
    let mut n = 1;
    loop {
        let name = if n == 1 {
            format!("{base}{extension}")
        } else {
            format!("{base} {n}{extension}")
        };
        let candidate = folder.join(name);
        if tokio::fs::metadata(&candidate).await.is_err() {
            return candidate;
        }
        n += 1;
    }
}
