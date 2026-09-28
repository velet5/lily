//! `lily-studio --smoke-test` (DECISIONS D42): a scratch folder with two scores,
//! an include, a file that is no score and a stand-in for Claude Code; the
//! window is opened on it and src/renderer/smoke.ts is loaded into the page to
//! drive it. The `smoke_*` commands answer only in this mode: files on disk as
//! another program sees them, the menu, and the report at the end.
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::state::{Studio, StudioEvent};

/// Answers as `claude -p --output-format stream-json` does, and says whether it was resumed.
const FAKE_AGENT: &str = r#"#!/bin/sh
case " $* " in *" --version "*) echo "9.9.9 (Claude Code)"; exit 0;; esac
resumed=no
for arg in "$@"; do [ "$arg" = "--resume" ] && resumed=yes; done
case "$*" in *"The user has selected"*) resumed="$resumed, with a selection";; esac
case "$*" in *"--add-dir"*) resumed="$resumed, with an image";; esac
echo '{"type":"system","subtype":"init","session_id":"smoke-session"}'
printf '%s\n' '\version "2.24.0"' '{ a4 b c d }' > agent.ly
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"'"$PWD"'/agent.ly"}}]}}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"Wrote agent.ly (resumed: '$resumed')"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"done"}'
"#;

/// How long the whole run may take before it fails.
pub const TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SmokeFolder {
    pub folder: PathBuf,
    pub score: PathBuf,
    /// The stand-in for Claude Code: stream-json out, agent.ly written, no network.
    #[serde(skip)]
    pub agent: PathBuf,
    /// The settings and chats of this run, apart from the user's.
    #[serde(skip)]
    pub profile: PathBuf,
}

/// Writes the scratch folder and a private profile.
pub fn prepare() -> std::io::Result<SmokeFolder> {
    let temp = std::env::temp_dir().canonicalize()?;
    let folder = make_temp(&temp, "lily-studio-smoke-")?;
    let profile = make_temp(&temp, "lily-studio-smoke-profile-")?;
    let score = folder.join("smoke.ly");
    std::fs::write(&score, "\\version \"2.24.0\"\n{ c4 d e f }\n")?;
    std::fs::create_dir(folder.join("parts"))?;
    std::fs::write(folder.join("parts/melody.ily"), "melody = { g1 }\n")?;
    std::fs::write(folder.join("notes.txt"), "not a score\n")?;
    std::fs::write(folder.join("second.ly"), "\\version \"2.24.0\"\n{ g'1 }\n")?;
    let agent = folder.join(".agent/claude");
    std::fs::create_dir(folder.join(".agent"))?;
    std::fs::write(&agent, FAKE_AGENT)?;
    std::fs::set_permissions(&agent, std::fs::Permissions::from_mode(0o755))?;
    Ok(SmokeFolder {
        folder,
        score,
        agent,
        profile,
    })
}

fn make_temp(parent: &Path, prefix: &str) -> std::io::Result<PathBuf> {
    for n in 0u32.. {
        let candidate = parent.join(format!("{prefix}{}-{n}", std::process::id()));
        match std::fs::create_dir(&candidate) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    unreachable!("some name is free")
}

/// Deletes the folder and the profile.
pub fn clean(smoke: &SmokeFolder) {
    let _ = std::fs::remove_dir_all(&smoke.folder);
    let _ = std::fs::remove_dir_all(&smoke.profile);
}

/// Loads the driver into the page; runs once the page has loaded.
/// Runs before the page's own scripts. WebKit runs no animation frames in a
/// hidden window, and the editor, the PDF tab and the playhead draw in them;
/// here they come from a timer at 60 per second instead.
pub const FRAMES: &str = r#"(() => {
  let next = 1
  const timers = new Map()
  window.requestAnimationFrame = (callback) => {
    const id = next++
    timers.set(id, setTimeout(() => { timers.delete(id); callback(performance.now()) }, 16))
    return id
  }
  window.cancelAnimationFrame = (id) => { clearTimeout(timers.get(id)); timers.delete(id) }
})()"#;

/// The page's errors and warnings go to stderr, where they explain a failed run.
pub const LOAD_DRIVER: &str = r#"(() => {
  const log = (level, message) => window.__TAURI_INTERNALS__.invoke('smoke_log', { level, message: String(message) })
  window.addEventListener('error', (event) => log('error', event.error?.stack ?? event.message))
  window.addEventListener('unhandledrejection', (event) => log('error', event.reason?.stack ?? event.reason))
  for (const level of ['warn', 'error']) {
    const original = console[level].bind(console)
    console[level] = (...args) => { original(...args); log(level, args.map((a) => a?.stack ?? a).join(' ')) }
  }
  const script = Object.assign(document.createElement('script'), { src: 'smoke.js' })
  script.onerror = () => log('error', 'smoke.js did not load')
  document.head.append(script)
})()"#;

fn smoke(studio: &Studio) -> Result<&SmokeFolder, String> {
    studio
        .smoke
        .as_ref()
        .ok_or_else(|| "Only in the smoke test.".to_string())
}

#[tauri::command]
pub fn smoke_folder(studio: State<'_, std::sync::Arc<Studio>>) -> Result<SmokeFolder, String> {
    smoke(&studio).cloned()
}

/// A file's text, or null when it is missing; a PDF reads as its lossy text.
#[tauri::command]
pub async fn smoke_read(
    studio: State<'_, std::sync::Arc<Studio>>,
    file: PathBuf,
) -> Result<Option<String>, String> {
    smoke(&studio)?;
    Ok(tokio::fs::read(&file)
        .await
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned()))
}

/// Writes as another program would: not through the studio.
#[tauri::command]
pub async fn smoke_write(
    studio: State<'_, std::sync::Arc<Studio>>,
    file: PathBuf,
    text: String,
) -> Result<(), String> {
    smoke(&studio)?;
    tokio::fs::write(&file, text)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn smoke_list(
    studio: State<'_, std::sync::Arc<Studio>>,
    dir: PathBuf,
) -> Result<Vec<String>, String> {
    smoke(&studio)?;
    let mut names = Vec::new();
    let mut entries = tokio::fs::read_dir(&dir)
        .await
        .map_err(|error| error.to_string())?;
    while let Ok(Some(entry)) = entries.next_entry().await {
        names.push(entry.file_name().to_string_lossy().into_owned());
    }
    Ok(names)
}

/// As a click in the application menu.
#[tauri::command]
pub fn smoke_menu(
    studio: State<'_, std::sync::Arc<Studio>>,
    command: String,
) -> Result<(), String> {
    smoke(&studio)?;
    studio.send(StudioEvent::Command { command });
    Ok(())
}

/// A warning or an error of the page.
#[tauri::command]
pub fn smoke_log(
    studio: State<'_, std::sync::Arc<Studio>>,
    level: String,
    message: String,
) -> Result<(), String> {
    smoke(&studio)?;
    eprintln!("page {level}: {message}");
    Ok(())
}

/// Prints the report and ends the run.
#[tauri::command]
pub fn smoke_done(
    app: AppHandle,
    studio: State<'_, std::sync::Arc<Studio>>,
    ok: bool,
    report: String,
) -> Result<(), String> {
    smoke(&studio)?;
    println!("{report}");
    app.exit(if ok { 0 } else { 1 });
    Ok(())
}
