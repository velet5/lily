//! The worker's commands (DECISIONS D55): the app's, as crates/session has
//! them, with what the app's panels chose passed by the page's dialogs
//! instead (src/web/dialogs.ts): a folder or a score to open, where a new
//! score goes. Added for a browser, which has no Finder: listing a folder of
//! the workspace, making a folder, uploading a score and downloading a file.
//! Every path is checked to be inside the user's scores first; the agents
//! (D40), choosing a LilyPond and separating stems (D112) are not offered.
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::Engine as _;
use lily_engrave::files::{self, is_score_file};
use lily_engrave::setup::{self, LilyPondState, MINIMUM_VERSION};
use lily_engrave::{LilyPondStatus, paths};
use lily_session::{MutedPart, Studio, midi_export, templates};
use serde::Serialize;
use serde_json::{Value, json};

type Answer = Result<Value, String>;

/// An uploaded score is text; anything bigger is not one.
pub const MAX_UPLOAD: usize = 2 * 1024 * 1024;
/// PDFs of long scores grow large; the socket carries a download in one message.
pub const MAX_DOWNLOAD: u64 = 48 * 1024 * 1024;
/// Entries listed by `browse` at most.
const MAX_ENTRIES: usize = 1000;
/// What `download` gives: scores, and the PDFs and MIDI files written next to them.
const DOWNLOADS: &[&str] = &[".ly", ".ily", ".lyi", ".pdf", ".mid", ".midi"];
/// Commands of the app the web does not offer.
const DESKTOP_ONLY: &[&str] = &[
    "agent_status",
    "choose_agent",
    "set_agent_model",
    "chat_list",
    "chat_get",
    "chat_send",
    "chat_image",
    "chat_answer",
    "chat_stop",
    "chat_delete",
    "choose_lilypond",
    "confirm_reload",
    // Separating stems runs uv on the Mac (D112); the page does not ask.
    "separation_status",
    "separation_models",
    "choose_song",
    "separate",
    "separation_cancel",
    "mix_stems",
    "reveal_in_finder",
];

pub struct Worker {
    studio: Arc<Studio>,
    /// The user's workspace, resolved.
    scores: PathBuf,
}

fn json(value: impl Serialize) -> Answer {
    serde_json::to_value(value).map_err(|error| error.to_string())
}

fn arg<'a>(args: &'a Value, key: &str) -> &'a Value {
    args.get(key).unwrap_or(&Value::Null)
}

fn string(args: &Value, key: &str) -> Result<String, String> {
    arg(args, key)
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("Expected {key}."))
}

fn flag(args: &Value, key: &str) -> bool {
    arg(args, key).as_bool().unwrap_or(false)
}

/// A name for a new file or folder: no separators, not hidden, not too long.
fn check_name(name: &str) -> Result<(), String> {
    let name_ok = !name.trim().is_empty()
        && name.len() <= 200
        && !name.starts_with('.')
        && !name
            .chars()
            .any(|c| c == '/' || c == '\\' || c.is_control());
    if name_ok {
        Ok(())
    } else {
        Err(format!(
            "“{name}” cannot be used as a name: it may not start with a dot or contain a slash."
        ))
    }
}

fn base64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

#[derive(Serialize)]
struct Entry {
    name: String,
    path: PathBuf,
}

/// A folder of the workspace as the page's file dialogs show it.
#[derive(Serialize)]
struct Listing {
    root: PathBuf,
    dir: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent: Option<PathBuf>,
    folders: Vec<Entry>,
    files: Vec<Entry>,
    truncated: bool,
}

/// What `status` says to someone who cannot install LilyPond themselves.
fn hosted_status(status: LilyPondStatus) -> LilyPondStatus {
    let message = match status.state {
        LilyPondState::Ready => return status,
        LilyPondState::Missing => {
            "This server has no LilyPond, so it cannot engrave scores yet. Let whoever runs it know.".to_string()
        }
        LilyPondState::TooOld => format!(
            "This server has LilyPond {}, and Lily Studio needs {MINIMUM_VERSION} or newer. Let whoever runs it know.",
            status.version.as_deref().unwrap_or("of an older version")
        ),
        LilyPondState::Broken => {
            "This server's LilyPond does not start. Let whoever runs it know.".to_string()
        }
    };
    LilyPondStatus { message, ..status }
}

impl Worker {
    pub fn new(studio: Arc<Studio>, scores: PathBuf) -> Worker {
        Worker { studio, scores }
    }

    /// The commands that must run in the order they came, answered before
    /// the next line is read; None for the others.
    pub fn call_in_order(&self, command: &str, args: &Value) -> Option<Answer> {
        Some(match command {
            "edited" => {
                let text = arg(args, "text").as_str().map(str::to_owned);
                self.studio.edited(arg(args, "file"), text);
                Ok(Value::Null)
            }
            "set_live" => {
                self.studio.set_live(flag(args, "on"));
                Ok(Value::Null)
            }
            // The page guards its own tab against closing with unsaved changes.
            "set_dirty" => Ok(Value::Null),
            _ => return None,
        })
    }

    pub async fn call(&self, command: &str, args: Value) -> Answer {
        let studio = &self.studio;
        let args = &args;
        match command {
            "templates" => json(templates()),
            "list_folder" => json(studio.list_folder().await),
            "read_file" => json(studio.read_file(arg(args, "file")).await?),
            "save_file" => {
                let text = string(args, "text")?;
                json(studio.save_file(arg(args, "file"), &text).await?)
            }
            "show_score" => json(studio.show_score(arg(args, "file")).await?),
            "reveal_source" => json(studio.reveal_source(arg(args, "href"))?),
            "compile_pdf" => json(studio.compile_pdf(arg(args, "rootFile")).await?),
            "export_pdf" => json(studio.export_pdf(arg(args, "rootFile")).await?),
            "lilypond_status" => json(hosted_status(studio.lilypond_status().await)),
            // The page opens it; only the setup's own pages.
            "open_link" => arg(args, "link")
                .as_str()
                .and_then(setup::setup_link)
                .map(|url| Value::String(url.into()))
                .ok_or_else(|| format!("Unknown link: {}", arg(args, "link"))),
            "open_sample" => json(studio.open_sample().await?),
            "playback_setup" => json(studio.playback.get(&string(args, "rootFile")?).await),
            "set_playback_setup" => json(
                studio
                    .playback
                    .set(&string(args, "rootFile")?, arg(args, "setup"))
                    .await?,
            ),
            "recent_list" => json(studio.recent_list(Some(self.scores.clone())).await),
            "open_recent" => json(
                studio
                    .open_recent(&string(args, "path")?, Some(&self.scores))
                    .await?,
            ),
            "forget_recent" => json(studio.recent.remove(&string(args, "path")?).await?),
            "clear_recent" => json(studio.recent.clear().await?),
            "open_folder" => {
                let folder = self.folder(args, "path").await?;
                json(studio.open_folder_at(&folder, None).await)
            }
            "open_file" => {
                let file = self.inside(args, "path")?;
                if !is_score_file(&file) || !is_file(&file).await {
                    return Err(format!("{} is not a score.", paths::basename(&file)));
                }
                json(studio.open_file_at(&file).await)
            }
            "new_score" => self.new_score(args).await,
            "browse" => self.browse(args).await,
            "create_folder" => self.create_folder(args).await,
            "upload" => self.upload(args).await,
            "download" => self.download(args).await,
            "export_midi" => self.export_midi(args),
            _ if DESKTOP_ONLY.contains(&command) => Err(format!(
                "{command} is part of the Lily Studio app, not of Lily Studio on the web."
            )),
            _ => Err(format!("Unknown command: {command}")),
        }
    }

    /// The path `args[key]` names, if it is inside the user's scores.
    fn inside(&self, args: &Value, key: &str) -> Result<PathBuf, String> {
        let path = string(args, key)?;
        if !path.starts_with('/') {
            return Err("Expected an absolute path.".into());
        }
        let resolved = paths::resolve(&path);
        if !files::is_inside(&self.scores, &resolved) {
            return Err(format!("{path} is outside your scores."));
        }
        Ok(resolved)
    }

    /// A folder inside the user's scores; the workspace itself when not given.
    async fn folder(&self, args: &Value, key: &str) -> Result<PathBuf, String> {
        let folder = match arg(args, key) {
            Value::Null => self.scores.clone(),
            _ => self.inside(args, key)?,
        };
        if !is_dir(&folder).await {
            return Err(format!("{} is not a folder.", paths::basename(&folder)));
        }
        Ok(folder)
    }

    async fn browse(&self, args: &Value) -> Answer {
        let dir = self.folder(args, "dir").await?;
        let mut reader = tokio::fs::read_dir(&dir)
            .await
            .map_err(|error| format!("{}: {error}", dir.display()))?;
        let mut folders = Vec::new();
        let mut scores = Vec::new();
        let mut truncated = false;
        while let Ok(Some(entry)) = reader.next_entry().await {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') {
                continue;
            }
            if folders.len() + scores.len() >= MAX_ENTRIES {
                truncated = true;
                break;
            }
            let path = dir.join(&name);
            // Followed, as the file list follows them.
            match tokio::fs::metadata(&path).await {
                Ok(meta) if meta.is_dir() => folders.push(Entry { name, path }),
                Ok(meta) if meta.is_file() && is_score_file(&name) => {
                    scores.push(Entry { name, path })
                }
                _ => {}
            }
        }
        let by_name = |a: &Entry, b: &Entry| a.name.to_lowercase().cmp(&b.name.to_lowercase());
        folders.sort_by(by_name);
        scores.sort_by(by_name);
        let parent = (dir != self.scores)
            .then(|| dir.parent().map(Path::to_path_buf))
            .flatten();
        json(Listing {
            root: self.scores.clone(),
            dir,
            parent,
            folders,
            files: scores,
            truncated,
        })
    }

    async fn create_folder(&self, args: &Value) -> Answer {
        let parent = self.folder(args, "parent").await?;
        let name = string(args, "name")?;
        check_name(&name)?;
        let folder = parent.join(name.trim());
        tokio::fs::create_dir(&folder)
            .await
            .map_err(|error| match error.kind() {
                std::io::ErrorKind::AlreadyExists => {
                    format!("There is a {} here already.", name.trim())
                }
                _ => format!("{name}: {error}"),
            })?;
        json(folder)
    }

    /// A new score at `path`, `.ly` added when it has no score extension. A
    /// file there is replaced only with `replace`; else the answer is
    /// `{"exists": true}` and the page asks.
    async fn new_score(&self, args: &Value) -> Answer {
        let template = string(args, "template")?;
        if lily_engrave::templates::template(&template).is_none() {
            return Err(format!("Unknown template: {template}"));
        }
        let chosen = self.inside(args, "path")?;
        check_name(&paths::basename(&chosen))?;
        let file = if is_score_file(&chosen) {
            chosen
        } else {
            chosen.with_extension("ly")
        };
        if !is_dir(&paths::dirname(&file)).await {
            return Err("That folder is gone.".into());
        }
        if exists(&file).await && !flag(args, "replace") {
            return Ok(json!({ "exists": true }));
        }
        json(self.studio.create_score(&file, &template).await?)
    }

    /// Writes an uploaded score into `dir`; as `new_score`, an existing one
    /// is replaced only with `replace`. Answers with its path.
    async fn upload(&self, args: &Value) -> Answer {
        let dir = self.folder(args, "dir").await?;
        let name = string(args, "name")?;
        check_name(&name)?;
        if !is_score_file(&name) {
            return Err(format!(
                "{name} is not a LilyPond file: only .ly, .ily and .lyi files can be uploaded."
            ));
        }
        let data = base64::engine::general_purpose::STANDARD
            .decode(string(args, "data")?)
            .map_err(|error| format!("{name} could not be read: {error}"))?;
        if data.len() > MAX_UPLOAD {
            return Err(format!(
                "{name} is too large for a score ({} MB at most).",
                MAX_UPLOAD / 1024 / 1024
            ));
        }
        let file = dir.join(&name);
        if exists(&file).await && !flag(args, "replace") {
            return Ok(json!({ "exists": true }));
        }
        tokio::fs::write(&file, &data)
            .await
            .map_err(|error| format!("{name} could not be written: {error}"))?;
        Ok(json!({ "path": file }))
    }

    /// A file of the workspace for the browser to save: its name and bytes.
    async fn download(&self, args: &Value) -> Answer {
        let file = self.inside(args, "file")?;
        let name = paths::basename(&file);
        if !DOWNLOADS.contains(&paths::extension_lower(&file).as_str()) {
            return Err(format!("{name} cannot be downloaded."));
        }
        let meta = tokio::fs::metadata(&file)
            .await
            .map_err(|error| format!("{name}: {error}"))?;
        if !meta.is_file() || meta.len() > MAX_DOWNLOAD {
            return Err(format!("{name} cannot be downloaded."));
        }
        let data = tokio::fs::read(&file)
            .await
            .map_err(|error| format!("{name}: {error}"))?;
        Ok(json!({ "name": name, "data": base64(&data) }))
    }

    /// Export MIDI (D54) for the browser to save: the music the transport
    /// plays, without the muted parts when `leaveOut`.
    fn export_midi(&self, args: &Value) -> Answer {
        let root = self.studio.check(arg(args, "rootFile"))?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(string(args, "midi")?)
            .map_err(|error| format!("The MIDI could not be exported: {error}"))?;
        let muted: Vec<MutedPart> = serde_json::from_value(arg(args, "muted").clone())
            .map_err(|error| format!("Expected the muted parts: {error}"))?;
        let tracks: Vec<usize> = if flag(args, "leaveOut") {
            muted.iter().map(|part| part.track).collect()
        } else {
            Vec::new()
        };
        let out = midi_export::without_tracks(&bytes, &tracks)?;
        Ok(json!({
            "name": midi_export::suggested_name(&root),
            "data": base64(&out),
            "leftOut": tracks.len(),
        }))
    }
}

async fn exists(path: &Path) -> bool {
    tokio::fs::symlink_metadata(path).await.is_ok()
}

async fn is_dir(path: &Path) -> bool {
    tokio::fs::metadata(path).await.is_ok_and(|m| m.is_dir())
}

async fn is_file(path: &Path) -> bool {
    tokio::fs::metadata(path).await.is_ok_and(|m| m.is_file())
}
