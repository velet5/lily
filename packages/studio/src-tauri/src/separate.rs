//! Stem separation's commands (DECISIONS D112), RoFormer MLX's app's
//! project_root, find_uv, list_models, separate, mix_stems and cancel, run
//! through crates/separate, and the open panel that chooses a song. Each event goes to the page on the studio's one
//! channel as a `separation` event. Before a `done` event is passed on, its
//! folder is let into the asset protocol's scope, which starts empty, so the
//! page can play the stems. Mixing and Show in Finder take only files in a
//! folder separated in this run of the app. A stem leads to a score: one is
//! written beside it, and a score's stem, the file its `% Stem:` line names
//! beside it, may be played under the preview. The web server has none of
//! this (D55).
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use lily_engrave::files::unused_name;
use lily_separate::{ProjectRoot, ROOT_VARIABLE, Request, Separator, Sidecar};
use lily_session::{Opened, Studio, StudioEvent, lock};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;
use tokio::io::AsyncWriteExt;

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

/// Writes `text`, the score the page made for `stem` (files.ts's
/// `stemScore`), beside the stem as `<name>.ly`, or `<name> 2.ly` and so on
/// when that is taken, and opens it: the stems' folder becomes the open
/// folder. No panel asks where; nothing is written over.
#[tauri::command]
pub async fn new_score_for_stem(
    studio: State<'_, Arc<Studio>>,
    stems: State<'_, Stems>,
    stem: PathBuf,
    name: String,
    text: String,
) -> Answer<Opened> {
    let stem = stems.check(&stem)?;
    let folder = stem
        .parent()
        .filter(|_| stem.is_file())
        .ok_or_else(|| format!("{} is not a stem.", stem.display()))?;
    let file = write_new_score(folder, &name, &text).await?;
    Ok(studio.open_file_at(&file).await)
}

/// The stem `stem`, as a score's `% Stem:` line names it (files.ts's
/// `stemOfScore`): an audio file beside `score`, which the page has open. It
/// may be played from now on, alone: the asset scope lets in that file, not
/// its folder.
#[tauri::command]
pub fn attach_stem(
    app: AppHandle,
    studio: State<'_, Arc<Studio>>,
    score: Value,
    stem: String,
) -> Answer<PathBuf> {
    let score = studio.check(&score)?;
    let stem = stem_beside(&score, &stem)?;
    app.asset_protocol_scope()
        .allow_file(&stem)
        .map_err(|error| error.to_string())?;
    Ok(stem)
}

/// `<name>.ly` in `folder`, or the first of `<name> 2.ly`… that is free,
/// created with `text`. `name` is a word of the stem's, as the page made it.
async fn write_new_score(folder: &Path, name: &str, text: &str) -> Answer<PathBuf> {
    let plain = !name.is_empty()
        && !name.starts_with([' ', '-'])
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '-'));
    if !plain {
        return Err(format!("“{name}” cannot name a score."));
    }
    loop {
        let file = unused_name(folder, name, ".ly").await;
        // Another program may take the name between the look and the write.
        let created = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file)
            .await;
        match created {
            Ok(mut handle) => {
                handle
                    .write_all(text.as_bytes())
                    .await
                    .map_err(|error| format!("{}: {error}", file.display()))?;
                return Ok(file);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(format!("{}: {error}", file.display())),
        }
    }
}

/// The real path of the audio file `name` beside `score`, by name only: no
/// other folder, and no link out of this one.
fn stem_beside(score: &Path, name: &str) -> Answer<PathBuf> {
    let refused = || format!("{name} is not a stem beside {}.", score.display());
    if name.is_empty() || name.contains(['/', '\\']) || name == "." || name == ".." {
        return Err(refused());
    }
    let folder = score
        .parent()
        .and_then(|folder| folder.canonicalize().ok())
        .ok_or_else(refused)?;
    let stem = folder.join(name).canonicalize().map_err(|_| refused())?;
    let audio = stem
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| SONG_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()));
    if !audio || !stem.is_file() || stem.parent() != Some(folder.as_path()) {
        return Err(refused());
    }
    Ok(stem)
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

    #[tokio::test]
    async fn a_stems_score_is_written_beside_it_and_never_over_a_file() {
        let scratch = tempfile::tempdir().unwrap();
        let folder = scratch.path();
        std::fs::write(folder.join("bass.ly"), "mine").unwrap();

        let file = write_new_score(folder, "bass", "\\version").await.unwrap();
        assert_eq!(file, folder.join("bass 2.ly"));
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "\\version");
        assert_eq!(
            std::fs::read_to_string(folder.join("bass.ly")).unwrap(),
            "mine"
        );

        for name in ["", "../bass", "a/b", ".hidden", "-x", " bass", "bass\n"] {
            assert!(write_new_score(folder, name, "").await.is_err(), "{name:?}");
        }
    }

    #[test]
    fn a_scores_stem_is_an_audio_file_beside_it() {
        let scratch = tempfile::tempdir().unwrap();
        let dir = scratch.path().canonicalize().unwrap();
        let folder = dir.join("song (stems)");
        std::fs::create_dir_all(folder.join("nested")).unwrap();
        let score = folder.join("bass.ly");
        std::fs::write(&score, "").unwrap();
        let stem = folder.join("song - bass.wav");
        std::fs::write(&stem, b"RIFF").unwrap();
        std::fs::write(folder.join("notes.txt"), "").unwrap();
        std::fs::write(dir.join("song.mp3"), b"ID3").unwrap();
        std::fs::write(folder.join("nested").join("a.wav"), b"RIFF").unwrap();

        assert_eq!(stem_beside(&score, "song - bass.wav"), Ok(stem));
        for name in [
            "",
            "..",
            "../song.mp3",
            "nested/a.wav",
            "nested",
            "notes.txt",
            "missing.wav",
        ] {
            assert!(stem_beside(&score, name).is_err(), "{name:?}");
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(dir.join("song.mp3"), folder.join("out.mp3")).unwrap();
            assert!(
                stem_beside(&score, "out.mp3").is_err(),
                "a link out of the folder"
            );
        }
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
