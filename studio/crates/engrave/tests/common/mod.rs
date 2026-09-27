//! Shared by the integration tests: scratch directories, the repository's
//! fixtures and runtime, and whether lilypond is installed.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use lily_engrave::SearchPath;
use lily_engrave::locate::{LocateOptions, locate_lilypond};

/// The repository root: studio/crates/engrave/../../..
pub fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("the repository")
}

pub fn fixtures() -> PathBuf {
    repo().join("test/fixtures")
}

pub fn runtime() -> PathBuf {
    repo().join("runtime")
}

/// A fresh directory, by its real path: the temp directory is a symlink on
/// macOS and include graphs are canonical.
pub struct Scratch {
    _dir: tempfile::TempDir,
    pub path: PathBuf,
}

impl Scratch {
    pub fn new(prefix: &str) -> Scratch {
        let dir = tempfile::Builder::new()
            .prefix(prefix)
            .tempdir()
            .expect("a temp dir");
        let path = dir.path().canonicalize().expect("its real path");
        Scratch { _dir: dir, path }
    }

    pub fn at(&self, relative: &str) -> PathBuf {
        self.path.join(relative)
    }

    pub async fn write(&self, relative: &str, text: &str) -> PathBuf {
        let file = self.at(relative);
        tokio::fs::create_dir_all(file.parent().expect("a parent"))
            .await
            .expect("mkdir");
        tokio::fs::write(&file, text).await.expect("write");
        file
    }
}

pub fn search_path() -> SearchPath {
    SearchPath::from_env()
}

/// The installed lilypond, or `None` after saying the test is skipped.
pub async fn lilypond(test: &str) -> Option<PathBuf> {
    let configured = std::env::var("LILYPOND_PATH").ok();
    match locate_lilypond(&LocateOptions {
        configured_path: configured,
        path: search_path().get(),
        well_known_dirs: None,
    })
    .await
    {
        Ok(found) => Some(found.path),
        Err(_) => {
            eprintln!("skipped {test}: lilypond is not installed");
            None
        }
    }
}

pub async fn exists(path: &Path) -> bool {
    tokio::fs::metadata(path).await.is_ok()
}

pub async fn listing(dir: &Path) -> Vec<String> {
    let mut names = Vec::new();
    let mut entries = tokio::fs::read_dir(dir).await.expect("readdir");
    while let Some(entry) = entries.next_entry().await.expect("entry") {
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    names.sort();
    names
}

pub async fn sleep(ms: u64) {
    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
}
