//! Stem separation's commands (DECISIONS D112), RoFormer MLX's app's
//! project_root, find_uv, list_models, separate, mix_stems and cancel, run
//! through crates/separate, and the open panel that chooses a song. Each event goes to the page on the studio's one
//! channel as a `separation` event. Before a `done` event is passed on, its
//! folder is let into the asset protocol's scope, which starts empty, so the
//! page can play the stems. Mixing and Show in Finder take only files in a
//! folder separated in this run of the app. The web server has none of this
//! (D55).
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use lily_separate::{ProjectRoot, ROOT_VARIABLE, Request, Separator, Sidecar};
use lily_session::{Studio, StudioEvent, lock};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::dialogs::{self, Open, Save};
use crate::smoke::Smoke;

type Answer<T> = Result<T, String>;

/// The one separation that may run, and the folders it wrote this run.
#[derive(Default)]
pub struct Stems {
    pub separator: Separator,
    folders: Mutex<Vec<PathBuf>>,
}

impl Stems {
    /// `folder` may be played from and shown from now on.
    fn allow(&self, app: &AppHandle, folder: &Path) -> Answer<()> {
        let folder = folder
            .canonicalize()
            .map_err(|error| format!("{}: {error}", folder.display()))?;
        app.asset_protocol_scope()
            .allow_directory(&folder, false)
            .map_err(|error| error.to_string())?;
        let mut folders = lock(&self.folders);
        if !folders.contains(&folder) {
            folders.push(folder);
        }
        Ok(())
    }

    /// `path`, real, when it is in a folder separated this run.
    fn check(&self, path: &Path) -> Answer<PathBuf> {
        inside(&lock(&self.folders), path)
            .ok_or_else(|| format!("{} is not in a separated folder.", path.display()))
    }
}

/// What the setup needs to say: where the project is, where uv is, and what is missing.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SeparationStatus {
    #[serde(skip_serializing_if = "Option::is_none")]
    root: Option<ProjectRoot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    uv: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    problem: Option<String>,
    running: bool,
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn project_root() -> Answer<ProjectRoot> {
    lily_separate::project_root(
        std::env::var_os(ROOT_VARIABLE),
        None,
        &lily_separate::default_roots(),
    )
}

/// How to run karaoke-mlx now. Looked up on each call, so a project or a
/// uv installed while the app runs is found.
fn sidecar(studio: &Studio) -> Answer<Sidecar> {
    let root = project_root()?;
    let search_path = studio.search_path.get();
    let uv = lily_separate::find_uv(&search_path, home().as_deref())?;
    Ok(Sidecar {
        uv,
        root: root.path,
        search_path,
    })
}

#[tauri::command]
pub fn separation_status(
    studio: State<'_, Arc<Studio>>,
    stems: State<'_, Stems>,
) -> SeparationStatus {
    let root = project_root();
    let uv = lily_separate::find_uv(&studio.search_path.get(), home().as_deref());
    let problem = root.as_ref().err().or(uv.as_ref().err()).cloned();
    SeparationStatus {
        root: root.ok(),
        uv: uv.ok(),
        problem,
        running: stems.separator.is_running(),
    }
}

/// What the open panel offers as a song: what ffmpeg decodes for karaoke-mlx,
/// as RoFormer's app offered.
const SONG_EXTENSIONS: &[&str] = &[
    "mp3", "m4a", "aac", "flac", "wav", "ogg", "opus", "aiff", "aif", "wma", "mp4", "mkv", "webm",
];

/// Asks for a song to separate; None when the panel is cancelled.
#[tauri::command]
pub async fn choose_song(app: AppHandle) -> Answer<Option<PathBuf>> {
    dialogs::open(
        &app,
        Open {
            title: "Choose a Song".into(),
            prompt: Some("Choose".into()),
            files: true,
            extensions: SONG_EXTENSIONS.iter().map(|ext| ext.to_string()).collect(),
            directory: home().map(|home| home.join("Music")),
            ..Open::default()
        },
    )
    .await
}

#[tauri::command]
pub async fn separation_models(studio: State<'_, Arc<Studio>>) -> Answer<Value> {
    lily_separate::models(&sidecar(&studio)?).await
}

/// Separates `request`'s song next to it, in `<song> (karaoke)` or
/// `<song> (stems)`; answers that folder once it is done.
#[tauri::command]
pub async fn separate(
    app: AppHandle,
    studio: State<'_, Arc<Studio>>,
    stems: State<'_, Stems>,
    request: Request,
) -> Answer<PathBuf> {
    let sidecar = sidecar(&studio)?;
    let studio = studio.inner().clone();
    let stems = stems.inner();
    stems
        .separator
        .separate(&sidecar, &request, |event| {
            if let Some(folder) = done_folder(&event)
                && let Err(error) = stems.allow(&app, &folder)
            {
                eprintln!("separation: the stems cannot be played: {error}");
            }
            studio.send(StudioEvent::Separation { event });
        })
        .await
}

/// Ends the running separation; false when none was running.
#[tauri::command]
pub fn separation_cancel(stems: State<'_, Stems>) -> bool {
    stems.separator.cancel()
}

/// Mixes `files`, stems of one separation, into a file a save panel names;
/// None when the panel is cancelled.
#[tauri::command]
pub async fn mix_stems(
    app: AppHandle,
    studio: State<'_, Arc<Studio>>,
    stems: State<'_, Stems>,
    smoke: State<'_, Smoke>,
    files: Vec<PathBuf>,
) -> Answer<Option<PathBuf>> {
    let files = files
        .iter()
        .map(|file| stems.check(file))
        .collect::<Answer<Vec<_>>>()?;
    let folder = files
        .first()
        .and_then(|file| file.parent())
        .map(Path::to_path_buf)
        .ok_or("No stems to mix.")?;
    let name = mix_name(&folder);
    let output = match &smoke.0 {
        // The smoke test answers no panels: it takes the suggestion.
        Some(_) => Some(folder.join(name)),
        None => {
            dialogs::save(
                &app,
                Save {
                    title: "Export Mix".into(),
                    prompt: Some("Export".into()),
                    directory: Some(folder),
                    name: Some(name),
                    extensions: vec!["wav".into(), "flac".into(), "mp3".into()],
                    checkbox: None,
                },
            )
            .await?
        }
    };
    let Some(output) = output else {
        return Ok(None);
    };
    lily_separate::mix(&sidecar(&studio)?, &files, &output)
        .await
        .map(Some)
}

/// Shows `path`, a separated folder or a file in one, in the Finder.
#[tauri::command]
pub fn reveal_in_finder(app: AppHandle, stems: State<'_, Stems>, path: PathBuf) -> Answer<()> {
    let path = stems.check(&path)?;
    app.opener()
        .reveal_item_in_dir(path)
        .map_err(|error| error.to_string())
}

/// The folder of a `done` event, the one the stems were written to.
fn done_folder(event: &Value) -> Option<PathBuf> {
    (event["event"] == "done")
        .then(|| event["folder"].as_str())
        .flatten()
        .map(PathBuf::from)
}

/// `path`, real, when it is one of `folders` or directly in one. Separated
/// folders are flat, as their asset scope is.
fn inside(folders: &[PathBuf], path: &Path) -> Option<PathBuf> {
    let real = path.canonicalize().ok()?;
    let parent = real.parent()?;
    folders
        .iter()
        .any(|folder| *folder == real || folder == parent)
        .then_some(real)
}

/// `<song> - mix.wav` for the folder `<song> (stems)` or `<song> (karaoke)`.
fn mix_name(folder: &Path) -> String {
    let name = folder
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let song = name
        .strip_suffix(" (stems)")
        .or_else(|| name.strip_suffix(" (karaoke)"))
        .unwrap_or(&name);
    format!("{song} - mix.wav")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_a_done_event_names_a_folder() {
        let done = json!({ "event": "done", "folder": "/s/song (stems)", "outputs": [] });
        assert_eq!(done_folder(&done), Some(PathBuf::from("/s/song (stems)")));
        assert_eq!(
            done_folder(&json!({ "event": "progress", "value": 1.0 })),
            None
        );
        assert_eq!(done_folder(&json!({ "event": "done" })), None);
    }

    #[test]
    fn a_path_is_inside_only_when_it_is_a_separated_folder_or_directly_in_one() {
        let scratch = tempfile::tempdir().unwrap();
        let dir = scratch.path().canonicalize().unwrap();
        let folder = dir.join("song (stems)");
        let nested = folder.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        let stem = folder.join("song - bass.wav");
        std::fs::write(&stem, b"RIFF").unwrap();
        std::fs::write(dir.join("song.mp3"), b"ID3").unwrap();
        let folders = vec![folder.clone()];

        assert_eq!(inside(&folders, &folder), Some(folder.clone()));
        assert_eq!(inside(&folders, &stem), Some(stem.clone()));
        assert_eq!(inside(&folders, &folder.join("..").join("song.mp3")), None);
        assert_eq!(inside(&folders, &nested), Some(nested.clone()));
        assert_eq!(inside(&folders, &nested.join("missing.wav")), None);
        assert_eq!(inside(&[], &stem), None);
    }

    #[test]
    fn the_mix_is_named_after_the_song() {
        assert_eq!(mix_name(Path::new("/s/tekila (stems)")), "tekila - mix.wav");
        assert_eq!(
            mix_name(Path::new("/s/tekila (karaoke)")),
            "tekila - mix.wav"
        );
        assert_eq!(mix_name(Path::new("/s/elsewhere")), "elsewhere - mix.wav");
    }
}
