//! The commands behind src/renderer/bridge.ts (DECISIONS D42), one per call,
//! as main.ts's IPC handlers were: file access (D29), compiling (D31, D33,
//! D36, D39), point-and-click (D32), changes on disk (D34), LilyPond's setup
//! and the sample (D37), and the agents (D40). Every path from the page is
//! checked against what the user opened; only the window "main" may call.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;

use lily_agents::{AGENTS, AgentId, AgentStatus, ChatInfo, ChatMessage, OpenChat};
use lily_engrave::files::{self, SCORE_EXTENSIONS};
use lily_engrave::setup::{self, DetectOptions, LilyPondState};
use lily_engrave::templates::{SAMPLE, TEMPLATES, template};
use lily_engrave::{
    CompileOutcome, FolderListing, LilyPondStatus, PdfOutcome, SourceLocation, parse_text_edit,
};
use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

use crate::dialogs::{self, Alert, Open, Save};
use crate::state::{Studio, StudioEvent, lock};

type Studios<'a> = State<'a, Arc<Studio>>;
type Answer<T> = Result<T, String>;

/// A folder was opened, or a file whose folder becomes the open folder.
#[derive(Serialize)]
pub struct Opened {
    listing: FolderListing,
    /// The file to show in the editor, if one was chosen.
    #[serde(skip_serializing_if = "Option::is_none")]
    file: Option<PathBuf>,
}

/// A template of New Score, without its text.
#[derive(Serialize)]
pub struct TemplateInfo {
    id: &'static str,
    label: &'static str,
}

/// The score the editor now shows, and its last result if one is kept (D39).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shown {
    root_file: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    kept: Option<CompileOutcome>,
}

fn score_extensions() -> Vec<String> {
    SCORE_EXTENSIONS
        .iter()
        .map(|e| e.trim_start_matches('.').to_string())
        .collect()
}

async fn open_folder_at(studio: &Studio, folder: &Path, file: Option<PathBuf>) -> Opened {
    let folder = lily_engrave::paths::resolve(folder);
    lock(&studio.access).folder = Some(folder.clone());
    Opened {
        listing: files::list_folder(&folder).await,
        file,
    }
}

fn check(studio: &Studio, file: &Value) -> Answer<PathBuf> {
    lock(&studio.access).check_value(file)
}

#[tauri::command]
pub fn subscribe(studio: Studios<'_>, channel: Channel<StudioEvent>) {
    studio.subscribe(channel);
}

#[tauri::command]
pub fn templates() -> Vec<TemplateInfo> {
    TEMPLATES
        .iter()
        .map(|t| TemplateInfo {
            id: t.id,
            label: t.label,
        })
        .collect()
}

#[tauri::command]
pub async fn open_folder(app: AppHandle, studio: Studios<'_>) -> Answer<Option<Opened>> {
    let directory = lock(&studio.access).folder.clone();
    let chosen = dialogs::open(
        &app,
        Open {
            title: "Open Folder".into(),
            directories: true,
            create_directories: true,
            directory,
            ..Open::default()
        },
    )
    .await?;
    Ok(match chosen {
        Some(folder) => Some(open_folder_at(&studio, &folder, None).await),
        None => None,
    })
}

#[tauri::command]
pub async fn open_file(app: AppHandle, studio: Studios<'_>) -> Answer<Option<Opened>> {
    let directory = lock(&studio.access).folder.clone();
    let chosen = dialogs::open(
        &app,
        Open {
            title: "Open Score".into(),
            files: true,
            extensions: score_extensions(),
            directory,
            ..Open::default()
        },
    )
    .await?;
    let Some(file) = chosen else { return Ok(None) };
    let file = lily_engrave::paths::resolve(&file);
    lock(&studio.access).allow_file(&file);
    let folder = file
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("/"));
    Ok(Some(open_folder_at(&studio, &folder, Some(file)).await))
}

#[tauri::command]
pub async fn list_folder(studio: Studios<'_>) -> Answer<Option<FolderListing>> {
    let folder = lock(&studio.access).folder.clone();
    Ok(match folder {
        Some(folder) => Some(files::list_folder(&folder).await),
        None => None,
    })
}

#[tauri::command]
pub async fn read_file(studio: Studios<'_>, file: Value) -> Answer<String> {
    let allowed = check(&studio, &file)?;
    let text = files::read_score(&allowed)
        .await
        .map_err(|error| error.to_string())?;
    // The editor keeps the file open when another folder is opened; it must
    // still be able to save it then.
    lock(&studio.access).allow_file(&allowed);
    // Watched from now on, from what the editor shows.
    studio.watcher.open(&allowed, &text).await;
    Ok(text)
}

#[tauri::command]
pub async fn save_file(studio: Studios<'_>, file: Value, text: String) -> Answer<()> {
    let allowed = check(&studio, &file)?;
    studio.watcher.writing(&allowed, &text).await;
    files::write_score(&allowed, &text)
        .await
        .map_err(|error| error.to_string())?;
    // The save is done; the compile reports on the channel when it ends.
    let compiler = studio.compiler.clone();
    tauri::async_runtime::spawn(async move { compiler.saved(&allowed).await });
    Ok(())
}

#[tauri::command]
pub async fn new_score(
    app: AppHandle,
    studio: Studios<'_>,
    template: String,
) -> Answer<Option<Opened>> {
    let template =
        self::template(&template).ok_or_else(|| format!("Unknown template: {template}"))?;
    let folder = lock(&studio.access).folder.clone();
    let suggested = files::unused_name(
        folder.as_deref().unwrap_or(&studio.documents),
        "Untitled",
        ".ly",
    )
    .await;
    let chosen = dialogs::save(
        &app,
        Save {
            title: "New Score".into(),
            prompt: Some("Create".into()),
            directory: suggested.parent().map(Path::to_path_buf),
            name: suggested
                .file_name()
                .map(|n| n.to_string_lossy().into_owned()),
            extensions: score_extensions(),
        },
    )
    .await?;
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let file = if files::is_score_file(&chosen) {
        chosen
    } else {
        chosen.with_extension("ly")
    };
    files::create_from_template(&file, template.id).await?;
    let file = lily_engrave::paths::resolve(&file);
    lock(&studio.access).allow_file(&file);
    // A score saved outside the open folder brings its own folder along.
    let folder = match folder {
        Some(folder) if files::is_inside(&folder, &file) => folder,
        _ => file
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("/")),
    };
    Ok(Some(open_folder_at(&studio, &folder, Some(file)).await))
}

/// The score `file` belongs to, with its last result; the compile that
/// brings it up to date follows on the channel (D39).
#[tauri::command]
pub async fn show_score(studio: Studios<'_>, file: Value) -> Answer<Option<Shown>> {
    let allowed = check(&studio, &file)?;
    let Some(root_file) = studio.compiler.root_for(&allowed).await else {
        return Ok(None);
    };
    let kept = studio.kept(&root_file);
    // Always compiled too: an include may have changed while another score was shown.
    drop(studio.compiler.compile(&root_file));
    Ok(Some(Shown { root_file, kept }))
}

#[tauri::command]
pub fn set_dirty(window: WebviewWindow, studio: Studios<'_>, dirty: bool) {
    studio.dirty.store(dirty, Ordering::SeqCst);
    dialogs::set_edited(&window, dirty);
}

#[tauri::command]
pub fn reveal_source(studio: Studios<'_>, href: Value) -> Answer<Option<SourceLocation>> {
    let Some(mut location) = href.as_str().and_then(parse_text_edit) else {
        return Ok(None);
    };
    // A note from a file the studio may not open (lilypond's own ly/ files) goes nowhere.
    location.file = lock(&studio.access).check(&location.file.to_string_lossy())?;
    Ok(Some(location))
}

#[tauri::command]
pub async fn compile_pdf(studio: Studios<'_>, root_file: Value) -> Answer<Option<PdfOutcome>> {
    let allowed = check(&studio, &root_file)?;
    Ok(studio.compiler.pdf(&allowed).await)
}

#[tauri::command]
pub async fn export_pdf(studio: Studios<'_>, root_file: Value) -> Answer<Vec<PathBuf>> {
    let allowed = check(&studio, &root_file)?;
    studio.compiler.export_pdf(&allowed).await
}

#[tauri::command]
pub async fn confirm_reload(app: AppHandle, studio: Studios<'_>, file: Value) -> Answer<bool> {
    let allowed = check(&studio, &file)?;
    // The smoke test does not answer dialogs; it keeps the edits.
    if studio.smoke.is_some() {
        return Ok(false);
    }
    let name = allowed
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let answer = dialogs::alert(
        &app,
        Alert {
            message: format!("{name} was changed by another program."),
            detail: "Reload it and lose the changes you have not saved, or keep your changes? Saving them will replace the other version."
                .into(),
            // The first is the default: keeping is the safe answer.
            buttons: vec!["Keep My Changes".into(), "Reload".into()],
        },
    )
    .await?;
    Ok(answer == 1)
}

// Synchronous, as the next is: Tauri runs those in order on the main thread,
// as the page sent them, where async ones may overtake each other and an older
// text would replace a newer one. They enter the Tokio runtime that live
// preview's timers run on.
#[tauri::command]
pub fn edited(studio: Studios<'_>, file: Value, text: Option<String>) {
    if let Ok(allowed) = check(&studio, &file) {
        let runtime = tauri::async_runtime::handle();
        let _entered = runtime.inner().enter();
        studio.live.edited(allowed, text);
    }
}

#[tauri::command]
pub fn set_live(studio: Studios<'_>, on: bool) {
    let runtime = tauri::async_runtime::handle();
    let _entered = runtime.inner().enter();
    studio.live.set_enabled(on);
}

#[tauri::command]
pub async fn lilypond_status(studio: Studios<'_>) -> Answer<LilyPondStatus> {
    Ok(studio.inner().lilypond_status().await)
}

#[tauri::command]
pub async fn choose_lilypond(
    app: AppHandle,
    studio: Studios<'_>,
) -> Answer<Option<LilyPondStatus>> {
    let chosen = dialogs::open(
        &app,
        Open {
            title: "Choose LilyPond".into(),
            message: Some("Choose the LilyPond folder you downloaded, or the lilypond program in its bin folder.".into()),
            prompt: Some("Choose".into()),
            files: true,
            directories: true,
            directory: Some(PathBuf::from("/Applications")),
            ..Open::default()
        },
    )
    .await?;
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    let chosen = chosen.to_string_lossy().into_owned();
    let configured = setup::choice_path(&chosen);
    let status = setup::detect_lilypond(DetectOptions {
        configured_path: Some(configured.clone()),
        path: studio.search_path.get(),
        ..DetectOptions::default()
    })
    .await;
    if status.state == LilyPondState::Missing {
        return Ok(Some(LilyPondStatus {
            message: format!(
                "There is no LilyPond in {chosen}. Choose the folder you downloaded from lilypond.org, or the lilypond program inside its bin folder."
            ),
            ..status
        }));
    }
    // Kept even when too old or broken, so the message stays about this one.
    let settings = {
        let mut settings = lock(&studio.settings);
        settings.lilypond_path = Some(configured);
        settings.clone()
    };
    studio.save_settings(&settings).await?;
    Ok(Some(studio.inner().found(status)))
}

#[tauri::command]
pub fn open_link(app: AppHandle, link: Value) -> Answer<()> {
    // Only the setup's own pages; the page cannot name any other address.
    let url = link
        .as_str()
        .and_then(setup::setup_link)
        .ok_or_else(|| format!("Unknown link: {link}"))?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn open_sample(studio: Studios<'_>) -> Answer<Opened> {
    let folder = studio.documents.join("Lily Studio");
    let file = folder.join(SAMPLE.name);
    tokio::fs::create_dir_all(&folder)
        .await
        .map_err(|error| error.to_string())?;
    // An edited sample is the user's now: it is opened, never written over.
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
    lock(&studio.access).allow_file(&file);
    Ok(open_folder_at(&studio, &folder, Some(file)).await)
}

#[tauri::command]
pub async fn agent_status(studio: Studios<'_>) -> Answer<Vec<AgentStatus>> {
    let mut statuses = Vec::new();
    for agent in AGENTS.iter() {
        statuses.push(studio.detect_agent(agent.id).await);
    }
    Ok(statuses)
}

fn agent_id(agent: &Value) -> Answer<AgentId> {
    agent
        .as_str()
        .and_then(AgentId::parse)
        .ok_or_else(|| format!("Unknown agent: {agent}"))
}

#[tauri::command]
pub async fn choose_agent(
    app: AppHandle,
    studio: Studios<'_>,
    agent: Value,
) -> Answer<Option<AgentStatus>> {
    let id = agent_id(&agent)?;
    let info = lily_agents::agents::agent(id);
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let chosen = dialogs::open(
        &app,
        Open {
            title: format!("Choose {}", info.label),
            message: Some(format!(
                "Choose the {0} program. In Terminal, `which {0}` prints where it is.",
                info.command
            )),
            prompt: Some("Choose".into()),
            files: true,
            hidden_files: true,
            directory: Some(home.join(".local").join("bin")),
            ..Open::default()
        },
    )
    .await?;
    let Some(chosen) = chosen else {
        return Ok(None);
    };
    studio
        .set_agent_settings(id, |settings| {
            settings.path = Some(chosen.to_string_lossy().into_owned())
        })
        .await?;
    Ok(Some(studio.detect_agent(id).await))
}

#[tauri::command]
pub async fn set_agent_model(studio: Studios<'_>, agent: Value, model: String) -> Answer<()> {
    let id = agent_id(&agent)?;
    let trimmed = model.trim().to_string();
    studio
        .set_agent_settings(id, |settings| {
            settings.model = (!trimmed.is_empty()).then_some(trimmed)
        })
        .await
}

/// The open folder: chats belong to it, and its agent works in it.
fn chat_folder(studio: &Studio) -> Answer<String> {
    lock(&studio.access)
        .folder
        .as_ref()
        .map(|folder| folder.to_string_lossy().into_owned())
        .ok_or_else(|| "Open a score or a folder first; the agent works on its files.".to_string())
}

#[tauri::command]
pub async fn chat_list(studio: Studios<'_>) -> Answer<Vec<ChatInfo>> {
    Ok(match chat_folder(&studio) {
        Ok(folder) => studio.chats.list(&folder).await,
        Err(_) => Vec::new(),
    })
}

#[tauri::command]
pub async fn chat_get(studio: Studios<'_>, chat_id: Value) -> Answer<Option<OpenChat>> {
    let (Some(chat_id), Ok(folder)) = (chat_id.as_str(), chat_folder(&studio)) else {
        return Ok(None);
    };
    Ok(studio.chats.get(chat_id, &folder).await)
}

#[tauri::command]
pub async fn chat_send(studio: Studios<'_>, message: Value) -> Answer<String> {
    let message = ChatMessage::from_value(message)?;
    let folder = chat_folder(&studio)?;
    studio.chats.send(message, &folder).await
}

#[tauri::command]
pub fn chat_stop(studio: Studios<'_>, chat_id: Value) {
    if let Some(chat_id) = chat_id.as_str() {
        studio.chats.stop(chat_id);
    }
}

#[tauri::command]
pub async fn chat_delete(studio: Studios<'_>, chat_id: Value) -> Answer<()> {
    let Some(chat_id) = chat_id.as_str() else {
        return Ok(());
    };
    let folder = chat_folder(&studio)?;
    studio.chats.delete(chat_id, &folder).await;
    Ok(())
}
