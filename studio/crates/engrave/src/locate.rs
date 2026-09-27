//! Resolves the lilypond executable (DECISIONS D9), from src/compile/locate.ts:
//! explicit setting → `PATH` → well-known install directories. Called on every
//! compile rather than cached, so a settings change or a fresh install is
//! picked up without a restart. `PATH` is the app's `SearchPath`, not the
//! process environment.

use std::ffi::CString;
use std::fmt;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::paths;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BinarySource {
    Setting,
    Path,
    WellKnown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocatedBinary {
    /// Absolute path of the executable.
    pub path: PathBuf,
    pub source: BinarySource,
}

#[derive(Debug, Clone, Default)]
pub struct LocateOptions {
    /// The chosen path; empty or `None` means "not configured".
    pub configured_path: Option<String>,
    /// The `PATH` to search, `:`-separated.
    pub path: String,
    /// Overrides the built-in install directories (tests pass `Some(vec![])`).
    pub well_known_dirs: Option<Vec<PathBuf>>,
}

/// lilypond could not be found; the one error `locate_lilypond` returns.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LilyPondNotFound {
    pub message: String,
    /// The configured value that failed to resolve; `None` when nothing was configured.
    pub configured_path: Option<String>,
}

impl LilyPondNotFound {
    pub fn new(message: impl Into<String>, configured_path: Option<String>) -> Self {
        Self {
            message: message.into(),
            configured_path,
        }
    }
}

impl fmt::Display for LilyPondNotFound {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for LilyPondNotFound {}

pub async fn locate_lilypond(options: &LocateOptions) -> Result<LocatedBinary, LilyPondNotFound> {
    let configured = options
        .configured_path
        .as_deref()
        .map(crate::span::js_trim)
        .unwrap_or("");

    // A configured value that does not resolve is an error, not a reason to
    // fall back: silently compiling with a different binary would hide the mistake.
    if !configured.is_empty() {
        if let Some(found) = resolve_configured(configured, &options.path).await {
            return Ok(LocatedBinary {
                path: found,
                source: BinarySource::Setting,
            });
        }
        return Err(LilyPondNotFound::new(
            format!("The configured LilyPond path \"{configured}\" is not an executable file."),
            Some(configured.to_owned()),
        ));
    }

    if let Some(found) = find_in_dirs(&path_dirs(&options.path), "lilypond").await {
        return Ok(LocatedBinary {
            path: found,
            source: BinarySource::Path,
        });
    }

    let well_known = options
        .well_known_dirs
        .clone()
        .unwrap_or_else(default_install_dirs);
    if let Some(found) = find_in_dirs(&well_known, "lilypond").await {
        return Ok(LocatedBinary {
            path: found,
            source: BinarySource::WellKnown,
        });
    }

    Err(LilyPondNotFound::new(
        "LilyPond was not found on PATH or in the usual install locations.",
        None,
    ))
}

/// The setting may be an executable, an install or `bin` directory, or a bare command name.
async fn resolve_configured(configured: &str, path: &str) -> Option<PathBuf> {
    let expanded = expand_home(configured);
    let is_bare_name = !expanded.starts_with('/') && !expanded.contains(['/', '\\']);
    if is_bare_name {
        return find_in_dirs(&path_dirs(path), &expanded).await;
    }
    let target = paths::resolve(&expanded);
    if is_directory(&target).await {
        return find_in_dirs(&[target.clone(), target.join("bin")], "lilypond").await;
    }
    find_in_dirs(&[paths::dirname(&target)], &paths::basename(&target)).await
}

async fn find_in_dirs(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    for dir in dirs {
        let file = dir.join(name);
        if is_executable_file(&file).await {
            return Some(file);
        }
    }
    None
}

fn path_dirs(path: &str) -> Vec<PathBuf> {
    path.split(':')
        .filter(|dir| !dir.is_empty())
        .map(PathBuf::from)
        .collect()
}

/// Where lilypond usually is when `PATH` does not say.
pub fn default_install_dirs() -> Vec<PathBuf> {
    if cfg!(target_os = "macos") {
        // An app started from the Dock does not see the shell's PATH additions.
        [
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/opt/local/bin",
            "/Applications/LilyPond.app/Contents/Resources/bin",
        ]
        .into_iter()
        .map(PathBuf::from)
        .collect()
    } else {
        vec![
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
            home_dir().join(".local").join("bin"),
        ]
    }
}

fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn expand_home(value: &str) -> String {
    if value == "~" {
        return home_dir().to_string_lossy().into_owned();
    }
    if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        return home_dir().join(rest).to_string_lossy().into_owned();
    }
    value.to_owned()
}

async fn is_directory(target: &Path) -> bool {
    tokio::fs::metadata(target).await.is_ok_and(|m| m.is_dir())
}

pub(crate) async fn is_executable_file(file: &Path) -> bool {
    if !tokio::fs::metadata(file).await.is_ok_and(|m| m.is_file()) {
        return false;
    }
    access(file, libc::X_OK)
}

/// `access(2)`: whether the real user may use `file` in `mode`.
pub(crate) fn access(file: &Path, mode: libc::c_int) -> bool {
    let Ok(path) = CString::new(file.as_os_str().as_bytes()) else {
        return false;
    };
    // SAFETY: `path` is a valid NUL-terminated string that outlives the call.
    unsafe { libc::access(path.as_ptr(), mode) == 0 }
}
