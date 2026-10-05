//! The commands behind src/renderer/bridge.ts (DECISIONS D42), one per call,
//! as main.ts's IPC handlers were: file access (D29), compiling (D31, D33,
//! D36, D39), point-and-click (D32), changes on disk (D34), LilyPond's setup
//! and the sample (D37), the agents (D40), each score's playback setup (D45),
//! Export MIDI (D54) and the recent list (D49). Every path from the page is
//! checked against what the user opened; only the window "main" may call.
//! What a command does once the user has chosen is crates/session's (D55),
//! shared with the web server; the native dialogs are the app's.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;

use lily_agents::{AGENTS, AgentId, AgentStatus, ChatInfo, ChatMessage, Decision, OpenChat};
use lily_engrave::setup::{self, DetectOptions, LilyPondState};
use lily_engrave::{FolderListing, LilyPondStatus, PdfOutcome, SourceLocation};
use lily_session::ops::score_extensions;
use lily_session::{
    MutedPart, Opened, RecentAnswer, Shown, Studio, StudioEvent, TemplateInfo, lock, midi_export,
};
use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Channel;
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;

use crate::dialogs::{self, Alert, Open, Save, Saved};
use crate::smoke::Smoke;

type Studios<'a> = State<'a, Arc<Studio>>;
type Answer<T> = Result<T, String>;

#[tauri::command]
pub fn subscribe(studio: Studios<'_>, channel: Channel<StudioEvent>) {
    studio.subscribe(move |event| {
        if let Err(error) = channel.send(event) {
            eprintln!("studio channel: {error}");
        }
    });
}

#[tauri::command]
pub fn templates() -> Vec<TemplateInfo> {
    lily_session::templates()
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
        Some(folder) => Some(studio.open_folder_at(&folder, None).await),
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
    Ok(match chosen {
        Some(file) => Some(studio.open_file_at(&file).await),
        None => None,
    })
}

#[tauri::command]
pub async fn list_folder(studio: Studios<'_>) -> Answer<Option<FolderListing>> {
    Ok(studio.list_folder().await)
}

#[tauri::command]
pub async fn read_file(studio: Studios<'_>, file: Value) -> Answer<String> {
    studio.read_file(&file).await
}

#[tauri::command]
pub async fn save_file(studio: Studios<'_>, file: Value, text: String) -> Answer<()> {
    studio.save_file(&file, &text).await
}

#[tauri::command]
pub async fn new_score(
    app: AppHandle,
    studio: Studios<'_>,
    template: String,
) -> Answer<Option<Opened>> {
    if lily_engrave::templates::template(&template).is_none() {
        return Err(format!("Unknown template: {template}"));
    }
    let suggested = studio.new_score_suggestion().await;
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
            checkbox: None,
        },
    )
    .await?;
    match chosen {
        Some(chosen) => studio.create_score(&chosen, &template).await.map(Some),
        None => Ok(None),
    }
}

/// The score `file` belongs to, with its last result; the compile that
/// brings it up to date follows on the channel (D39).
#[tauri::command]
pub async fn show_score(studio: Studios<'_>, file: Value) -> Answer<Option<Shown>> {
    studio.show_score(&file).await
}

#[tauri::command]
pub fn set_dirty(window: WebviewWindow, studio: Studios<'_>, dirty: bool) {
    studio.dirty.store(dirty, Ordering::SeqCst);
    dialogs::set_edited(&window, dirty);
}

#[tauri::command]
pub fn reveal_source(studio: Studios<'_>, href: Value) -> Answer<Option<SourceLocation>> {
    studio.reveal_source(&href)
}

#[tauri::command]
pub async fn compile_pdf(studio: Studios<'_>, root_file: Value) -> Answer<Option<PdfOutcome>> {
    studio.compile_pdf(&root_file).await
}

#[tauri::command]
pub async fn export_pdf(studio: Studios<'_>, root_file: Value) -> Answer<Vec<PathBuf>> {
    studio.export_pdf(&root_file).await
}

#[tauri::command]
pub async fn confirm_reload(
    app: AppHandle,
    studio: Studios<'_>,
    smoke: State<'_, Smoke>,
    file: Value,
) -> Answer<bool> {
    let allowed = studio.check(&file)?;
    // The smoke test does not answer dialogs; it keeps the edits.
    if smoke.0.is_some() {
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
// text would replace a newer one.
#[tauri::command]
pub fn edited(studio: Studios<'_>, file: Value, text: Option<String>) {
    studio.edited(&file, text);
}

#[tauri::command]
pub fn set_live(studio: Studios<'_>, on: bool) {
    studio.set_live(on);
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
    studio.open_sample().await
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
            directory: Some(home().unwrap_or_default().join(".local").join("bin")),
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

/// A pasted image of a chat (D46), as base64; null for a file that is not one.
#[tauri::command]
pub async fn chat_image(studio: Studios<'_>, file: String) -> Answer<Option<String>> {
    use base64::Engine as _;
    let bytes = studio.chats.image(&file).await;
    Ok(bytes.map(|bytes| base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// Answers what the agent of `chat_id` asked to be allowed (D52):
/// `allow`, `always` or `deny`.
#[tauri::command]
pub async fn chat_answer(
    studio: Studios<'_>,
    chat_id: Value,
    ask_id: Value,
    decision: Value,
) -> Answer<()> {
    let (Some(chat_id), Some(ask_id), Some(decision)) = (
        chat_id.as_str(),
        ask_id.as_str(),
        decision.as_str().and_then(Decision::parse),
    ) else {
        return Err("Expected a chat, a question and an answer.".to_string());
    };
    let folder = chat_folder(&studio)?;
    studio
        .chats
        .answer(chat_id, ask_id, decision, &folder)
        .await
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

/// The playback setup kept for `root_file` (D45); null when there is none.
/// The path is only a key: nothing is read from it.
#[tauri::command]
pub async fn playback_setup(studio: Studios<'_>, root_file: String) -> Answer<Option<Value>> {
    Ok(studio.playback.get(&root_file).await)
}

/// Keeps the playback setup of `root_file`; null or an empty one forgets it.
#[tauri::command]
pub async fn set_playback_setup(
    studio: Studios<'_>,
    root_file: String,
    setup: Value,
) -> Answer<()> {
    studio.playback.set(&root_file, &setup).await
}

/// Where Export MIDI wrote, and how many muted parts it left out.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportedMidi {
    file: PathBuf,
    left_out: usize,
}

/// Writes `midi`, the music the transport of `root_file` plays, where the
/// user chooses (D54); null when the panel was cancelled. While some parts
/// are muted, and not all of them, the panel's checkbox leaves them out.
#[tauri::command]
pub async fn export_midi(
    app: AppHandle,
    studio: Studios<'_>,
    smoke: State<'_, Smoke>,
    root_file: Value,
    midi: String,
    muted: Vec<MutedPart>,
) -> Answer<Option<ExportedMidi>> {
    use base64::Engine as _;
    let allowed = studio.check(&root_file)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(midi)
        .map_err(|error| format!("The MIDI could not be exported: {error}"))?;
    // Read before the panel, so a file that is not MIDI is not asked about.
    midi_export::without_tracks(&bytes, &[])?;
    let names: Vec<String> = muted.iter().map(|part| part.name.clone()).collect();
    let checkbox = (!names.is_empty()).then(|| (midi_export::checkbox_title(&names), true));
    let directory = allowed.parent().map(Path::to_path_buf);
    let name = midi_export::suggested_name(&allowed);
    let saved = match (&smoke.0, directory) {
        // The smoke test answers no panels: it takes the suggestion, as it is checked.
        (Some(_), Some(directory)) => Some(Saved {
            path: directory.join(name),
            checked: checkbox.is_some(),
        }),
        (_, directory) => {
            dialogs::save_checking(
                &app,
                Save {
                    title: "Export MIDI".into(),
                    prompt: Some("Export".into()),
                    directory,
                    name: Some(name),
                    extensions: vec!["mid".into(), "midi".into()],
                    checkbox,
                },
            )
            .await?
        }
    };
    let Some(Saved { path, checked }) = saved else {
        return Ok(None);
    };
    let tracks: Vec<usize> = if checked {
        muted.iter().map(|part| part.track).collect()
    } else {
        Vec::new()
    };
    let out = midi_export::without_tracks(&bytes, &tracks)?;
    tokio::fs::write(&path, out)
        .await
        .map_err(|error| format!("{} could not be written: {error}", path.display()))?;
    Ok(Some(ExportedMidi {
        file: path,
        left_out: tracks.len(),
    }))
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

#[tauri::command]
pub async fn recent_list(studio: Studios<'_>) -> Answer<RecentAnswer> {
    Ok(studio.recent_list(home()).await)
}

/// Opens an entry of the recent list; only those, so the page cannot name
/// any other path. One that is gone rejects with where it was.
#[tauri::command]
pub async fn open_recent(studio: Studios<'_>, path: String) -> Answer<Opened> {
    studio.inner().open_recent(&path, home().as_deref()).await
}

#[tauri::command]
pub async fn forget_recent(studio: Studios<'_>, path: String) -> Answer<()> {
    studio.recent.remove(&path).await
}

#[tauri::command]
pub async fn clear_recent(studio: Studios<'_>) -> Answer<()> {
    studio.recent.clear().await
}
