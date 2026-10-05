//! The studio's commands without their dialogs (DECISIONS D42, D55), as
//! src-tauri/src/commands.rs and the web worker call them once the user has
//! chosen: file access (D29), compiling (D31, D33, D36, D39), point-and-click
//! (D32), the sample (D37), each score's playback setup (D45) and the recent
//! list (D49). A path from the page is checked against what it may touch
//! before anything reads or writes it.
use std::path::{Path, PathBuf};
use std::sync::Arc;

use lily_engrave::files::{self, SCORE_EXTENSIONS};
use lily_engrave::templates::{SAMPLE, TEMPLATES, template};
use lily_engrave::{
    CompileOutcome, FolderListing, PdfOutcome, SourceLocation, parse_text_edit, paths,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::recent::{self, Listed, RecentKind};
use crate::studio::{Studio, lock};

type Answer<T> = Result<T, String>;

/// A folder was opened, or a file whose folder becomes the open folder.
#[derive(Serialize)]
pub struct Opened {
    pub listing: FolderListing,
    /// The file to show in the editor, if one was chosen.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file: Option<PathBuf>,
}

/// A template of New Score, without its text.
#[derive(Serialize)]
pub struct TemplateInfo {
    id: &'static str,
    label: &'static str,
}

pub fn templates() -> Vec<TemplateInfo> {
    TEMPLATES
        .iter()
        .map(|t| TemplateInfo {
            id: t.id,
            label: t.label,
        })
        .collect()
}

/// The extensions of a score, without the dot, as panels take them.
pub fn score_extensions() -> Vec<String> {
    SCORE_EXTENSIONS
        .iter()
        .map(|e| e.trim_start_matches('.').to_string())
        .collect()
}

/// The score the editor now shows, and its last result if one is kept (D39).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shown {
    root_file: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    kept: Option<CompileOutcome>,
}

/// A part muted in the Parts fold (D45): its MIDI track, and what the fold calls it.
#[derive(Deserialize)]
pub struct MutedPart {
    pub track: usize,
    pub name: String,
}

/// The recent list (D49) for the welcome screen, and the home directory it shortens to `~`.
#[derive(Serialize)]
pub struct RecentAnswer {
    #[serde(skip_serializing_if = "Option::is_none")]
    home: Option<PathBuf>,
    entries: Vec<Listed>,
}

fn parent_of(file: &Path) -> PathBuf {
    file.parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("/"))
}

impl Studio {
    /// `path` as the page may use it, or why not.
    pub fn check(&self, file: &Value) -> Answer<PathBuf> {
        lock(&self.access).check_value(file)
    }

    /// Every open ends here, so each goes on the recent list (D49): the file
    /// when one was chosen, else the folder.
    pub async fn open_folder_at(&self, folder: &Path, file: Option<PathBuf>) -> Opened {
        let folder = paths::resolve(folder);
        lock(&self.access).folder = Some(folder.clone());
        let added = match &file {
            Some(file) => self.recent.add(file, RecentKind::File).await,
            None => self.recent.add(&folder, RecentKind::Folder).await,
        };
        // The open itself went well; a list that could not be saved only loses this entry.
        if let Err(error) = added {
            eprintln!("{error}");
        }
        Opened {
            listing: files::list_folder(&folder).await,
            file,
        }
    }

    /// Opens a chosen score: its folder becomes the open folder.
    pub async fn open_file_at(&self, file: &Path) -> Opened {
        let file = paths::resolve(file);
        lock(&self.access).allow_file(&file);
        let folder = parent_of(&file);
        self.open_folder_at(&folder, Some(file)).await
    }

    pub async fn list_folder(&self) -> Option<FolderListing> {
        let folder = lock(&self.access).folder.clone();
        match folder {
            Some(folder) => Some(files::list_folder(&folder).await),
            None => None,
        }
    }

    pub async fn read_file(&self, file: &Value) -> Answer<String> {
        let allowed = self.check(file)?;
        let text = files::read_score(&allowed)
            .await
            .map_err(|error| error.to_string())?;
        // The editor keeps the file open when another folder is opened; it must
        // still be able to save it then.
        lock(&self.access).allow_file(&allowed);
        // Watched from now on, from what the editor shows.
        self.watcher.open(&allowed, &text).await;
        Ok(text)
    }

    pub async fn save_file(&self, file: &Value, text: &str) -> Answer<()> {
        let allowed = self.check(file)?;
        self.watcher.writing(&allowed, text).await;
        files::write_score(&allowed, text)
            .await
            .map_err(|error| error.to_string())?;
        // The save is done; the compile reports on the sink when it ends.
        let compiler = self.compiler.clone();
        self.spawn(async move { compiler.saved(&allowed).await });
        Ok(())
    }

    /// Where New Score's panel starts: `Untitled.ly` in the open folder, or
    /// in Documents when none is open.
    pub async fn new_score_suggestion(&self) -> PathBuf {
        let folder = lock(&self.access).folder.clone();
        files::unused_name(
            folder.as_deref().unwrap_or(&self.documents),
            "Untitled",
            ".ly",
        )
        .await
    }

    /// Writes a new score from `template` at `chosen`, `.ly` added when it has
    /// no score extension, and opens it. A score outside the open folder
    /// brings its own folder along.
    pub async fn create_score(&self, chosen: &Path, template_id: &str) -> Answer<Opened> {
        let template =
            template(template_id).ok_or_else(|| format!("Unknown template: {template_id}"))?;
        let file = if files::is_score_file(chosen) {
            chosen.to_path_buf()
        } else {
            chosen.with_extension("ly")
        };
        files::create_from_template(&file, template.id).await?;
        let file = paths::resolve(&file);
        let folder = {
            let mut access = lock(&self.access);
            access.allow_file(&file);
            access.folder.clone()
        };
        let folder = match folder {
            Some(folder) if files::is_inside(&folder, &file) => folder,
            _ => parent_of(&file),
        };
        Ok(self.open_folder_at(&folder, Some(file)).await)
    }

    /// The score `file` belongs to, with its last result; the compile that
    /// brings it up to date follows on the sink (D39).
    pub async fn show_score(&self, file: &Value) -> Answer<Option<Shown>> {
        let allowed = self.check(file)?;
        let Some(root_file) = self.compiler.root_for(&allowed).await else {
            return Ok(None);
        };
        let kept = self.kept(&root_file);
        // Always compiled too: an include may have changed while another score was shown.
        drop(self.compiler.compile(&root_file));
        Ok(Some(Shown { root_file, kept }))
    }

    pub fn reveal_source(&self, href: &Value) -> Answer<Option<SourceLocation>> {
        let Some(mut location) = href.as_str().and_then(parse_text_edit) else {
            return Ok(None);
        };
        // A note from a file the studio may not open (lilypond's own ly/ files) goes nowhere.
        location.file = lock(&self.access).check(&location.file.to_string_lossy())?;
        Ok(Some(location))
    }

    pub async fn compile_pdf(&self, root_file: &Value) -> Answer<Option<PdfOutcome>> {
        let allowed = self.check(root_file)?;
        Ok(self.compiler.pdf(&allowed).await)
    }

    pub async fn export_pdf(&self, root_file: &Value) -> Answer<Vec<PathBuf>> {
        let allowed = self.check(root_file)?;
        self.compiler.export_pdf(&allowed).await
    }

    /// The unsaved text of a file after an edit, or None after a save (D36).
    /// Synchronous, so the host applies edits in the order the page sent them.
    pub fn edited(&self, file: &Value, text: Option<String>) {
        if let Ok(allowed) = self.check(file) {
            let _entered = self.runtime().enter();
            self.live.edited(allowed, text);
        }
    }

    pub fn set_live(&self, on: bool) {
        let _entered = self.runtime().enter();
        self.live.set_enabled(on);
    }

    /// Opens the sample score, writing it first when it is not there. An
    /// edited sample is the user's now: it is opened, never written over.
    pub async fn open_sample(&self) -> Answer<Opened> {
        let folder = self.sample_folder.clone();
        let file = folder.join(SAMPLE.name);
        tokio::fs::create_dir_all(&folder)
            .await
            .map_err(|error| error.to_string())?;
        let created = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&file)
            .await;
        match created {
            Ok(_) => tokio::fs::write(&file, SAMPLE.text)
                .await
                .map_err(|error| error.to_string())?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.to_string()),
        }
        lock(&self.access).allow_file(&file);
        Ok(self.open_folder_at(&folder, Some(file)).await)
    }

    /// The recent list, with the directory shown as `~`.
    pub async fn recent_list(&self, home: Option<PathBuf>) -> RecentAnswer {
        RecentAnswer {
            home,
            entries: self.recent.listed().await,
        }
    }

    /// Opens an entry of the recent list; only those, so the page cannot name
    /// any other path. One that is gone, or outside the workspace, rejects
    /// with where it was.
    pub async fn open_recent(self: &Arc<Self>, path: &str, home: Option<&Path>) -> Answer<Opened> {
        let entry = self
            .recent
            .find(path)
            .await
            .ok_or_else(|| format!("{path} is not on the recent list."))?;
        let target = PathBuf::from(&entry.path);
        if !lock(&self.access).within_root(&target) || !entry.kind.exists_at(&target).await {
            return Err(recent::missing_message(&entry, home));
        }
        Ok(match entry.kind {
            RecentKind::Folder => self.open_folder_at(&target, None).await,
            RecentKind::File => self.open_file_at(&target).await,
        })
    }
}
