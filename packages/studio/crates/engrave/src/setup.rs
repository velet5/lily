//! First-run LilyPond detection and the guided setup behind it (DECISIONS
//! D37). Finds lilypond as the
//! extension does (`locate`, D9), asks it for its version, and keeps the one a
//! user chose in the studio's settings file.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::Duration;

use futures::future::BoxFuture;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::process::Command;

use crate::locate::{BinarySource, LocateOptions, locate_lilypond};

/// The oldest LilyPond the templates and the sample compile with.
pub const MINIMUM_VERSION: &str = "2.24.0";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LilyPondState {
    Ready,
    Missing,
    TooOld,
    Broken,
}

/// What the welcome screen and the setup say about LilyPond. `ready`: found
/// and new enough. `missing`: not found, or the chosen path is not lilypond.
/// `too-old` and `broken`: found, but older than MINIMUM_VERSION, or it did
/// not answer `--version`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LilyPondStatus {
    pub state: LilyPondState,
    /// The executable, when one was found.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<BinarySource>,
    /// The path chosen in the setup, when there is one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chosen: Option<String>,
    /// One or two sentences for someone who has never used a terminal.
    pub message: String,
}

/// The pages the setup may open; the app opens nothing else.
pub const SETUP_LINKS: &[(&str, &str)] = &[
    ("download", "https://lilypond.org/download.html"),
    (
        "learn",
        "https://lilypond.org/doc/v2.24/Documentation/learning/",
    ),
    // How to install the agents of the sidebar (D40).
    (
        "claude",
        "https://docs.claude.com/en/docs/claude-code/setup",
    ),
    ("codex", "https://developers.openai.com/codex/cli"),
];

/// The address of the setup link called `name`.
pub fn setup_link(name: &str) -> Option<&'static str> {
    SETUP_LINKS
        .iter()
        .find(|(key, _)| *key == name)
        .map(|(_, url)| *url)
}

pub type VersionFn =
    Box<dyn Fn(PathBuf) -> BoxFuture<'static, Result<String, String>> + Send + Sync>;

#[derive(Default)]
pub struct DetectOptions {
    /// A path chosen in the setup, or `$LILYPOND_PATH`; else PATH and the usual places.
    pub configured_path: Option<String>,
    /// The `PATH` to search and to run `--version` with.
    pub path: String,
    /// Overrides `locate`'s install directories (tests pass their own).
    pub well_known_dirs: Option<Vec<PathBuf>>,
    /// Runs `lilypond --version`; tests pass a stand-in.
    pub version: Option<VersionFn>,
}

pub async fn detect_lilypond(options: DetectOptions) -> LilyPondStatus {
    let chosen = options
        .configured_path
        .as_deref()
        .map(crate::span::js_trim)
        .filter(|c| !c.is_empty())
        .map(str::to_owned);
    let located = locate_lilypond(&LocateOptions {
        configured_path: chosen.clone(),
        path: options.path.clone(),
        well_known_dirs: options.well_known_dirs.clone(),
    })
    .await;
    let binary = match located {
        Ok(binary) => binary,
        Err(_) => {
            let message = match &chosen {
                Some(chosen) => format!(
                    "The LilyPond you chose ({chosen}) could not be found any more. Choose it again, or install LilyPond."
                ),
                None => "LilyPond, the program that engraves your music, is not installed on this Mac yet.".to_owned(),
            };
            return LilyPondStatus {
                state: LilyPondState::Missing,
                path: None,
                version: None,
                source: None,
                chosen,
                message,
            };
        }
    };
    let shown = binary.path.display().to_string();
    let found = |state, version: Option<String>, message: String| LilyPondStatus {
        state,
        path: Some(binary.path.clone()),
        version,
        source: Some(binary.source),
        chosen: chosen.clone(),
        message,
    };
    let output = match &options.version {
        Some(version) => version(binary.path.clone()).await,
        None => run_version(&binary.path, &options.path).await,
    };
    let Ok(output) = output else {
        return found(
            LilyPondState::Broken,
            None,
            format!(
                "LilyPond was found at {shown}, but it did not start. Installing it again usually helps."
            ),
        );
    };
    let Some(version) = parse_version(&output) else {
        return found(
            LilyPondState::Broken,
            None,
            format!("The program at {shown} does not seem to be LilyPond."),
        );
    };
    if compare_versions(&version, MINIMUM_VERSION) < 0 {
        let message = format!(
            "LilyPond {version} is installed, but Lily Studio needs {MINIMUM_VERSION} or newer. Install the latest version."
        );
        return found(LilyPondState::TooOld, Some(version), message);
    }
    let message = format!("LilyPond {version} is ready.");
    found(LilyPondState::Ready, Some(version), message)
}

static VERSION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)LilyPond\s+(\d+\.\d+(?:\.\d+)?)").expect("valid regex"));

/// `GNU LilyPond 2.26.0 (running Guile 3.0)` → `2.26.0`.
pub fn parse_version(output: &str) -> Option<String> {
    VERSION.captures(output).map(|c| c[1].to_owned())
}

/// Negative, zero or positive, as `a` is older than, equal to or newer than `b`.
pub fn compare_versions(a: &str, b: &str) -> i64 {
    let parse = |v: &str| {
        v.split('.')
            .map(|p| p.parse::<i64>().unwrap_or(0))
            .collect::<Vec<_>>()
    };
    let (pa, pb) = (parse(a), parse(b));
    for i in 0..pa.len().max(pb.len()) {
        let diff = pa.get(i).copied().unwrap_or(0) - pb.get(i).copied().unwrap_or(0);
        if diff != 0 {
            return diff;
        }
    }
    0
}

/// `lilypond --version`, with English messages and `path` as `PATH`.
pub async fn run_version(binary: &Path, path: &str) -> Result<String, String> {
    let mut command = Command::new(binary);
    command
        .arg("--version")
        .env("PATH", path)
        .env("LANGUAGE", "en")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(20), command.output())
        .await
        .map_err(|_| "timed out".to_owned())?
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!("lilypond --version exited with {}", output.status));
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// What the setup's Choose LilyPond… dialog returned, as a path `locate`
/// understands: an app bundle becomes the `bin` directory inside it. An
/// executable, an install directory or its `bin` directory pass as they are.
pub fn choice_path(chosen: &str) -> String {
    let lower = chosen.to_lowercase();
    if lower.ends_with(".app") || lower.ends_with(".app/") {
        crate::paths::normalize(Path::new(chosen).join("Contents/Resources/bin"))
            .to_string_lossy()
            .into_owned()
    } else {
        chosen.to_owned()
    }
}

/// The PATH for lilypond's children (gs for PDFs, among others). An app
/// opened from the Finder gets only `/usr/bin:/bin:/usr/sbin:/sbin`, so the
/// directories of Homebrew and MacPorts are added, and the found binary's own.
pub fn search_path(current: Option<&str>, binary_dir: Option<&str>) -> String {
    let extra: &[&str] = if cfg!(target_os = "macos") {
        &["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"]
    } else {
        &[]
    };
    let mut dirs: Vec<&str> = Vec::new();
    for dir in binary_dir
        .into_iter()
        .chain(current.unwrap_or("").split(':'))
        .chain(extra.iter().copied())
    {
        if !dir.is_empty() && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs.join(":")
}

/// One agent's choices in the setup (D40): where it is, and which model it uses.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentsSettings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude: Option<AgentSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex: Option<AgentSettings>,
}

/// The studio's settings: userData/settings.json. The chosen LilyPond, and the agents' choices.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lilypond_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agents: Option<AgentsSettings>,
}

fn non_empty_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

fn agent_settings(value: Option<&Value>) -> Option<AgentSettings> {
    let value = value?.as_object()?;
    let settings = AgentSettings {
        path: non_empty_string(value.get("path")),
        model: non_empty_string(value.get("model")),
    };
    (settings.path.is_some() || settings.model.is_some()).then_some(settings)
}

/// The settings in `file`; missing or damaged, none: start again from nothing.
pub async fn read_settings(file: &Path) -> Settings {
    let Ok(text) = tokio::fs::read_to_string(file).await else {
        return Settings::default();
    };
    let Ok(Value::Object(value)) = serde_json::from_str::<Value>(&text) else {
        return Settings::default();
    };
    let mut settings = Settings {
        lilypond_path: non_empty_string(value.get("lilypondPath")),
        agents: None,
    };
    if let Some(agents) = value.get("agents").and_then(Value::as_object) {
        let claude = agent_settings(agents.get("claude"));
        let codex = agent_settings(agents.get("codex"));
        if claude.is_some() || codex.is_some() {
            settings.agents = Some(AgentsSettings { claude, codex });
        }
    }
    settings
}

pub async fn write_settings(file: &Path, settings: &Settings) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(std::io::Error::other)?;
    tokio::fs::write(file, format!("{text}\n")).await
}
