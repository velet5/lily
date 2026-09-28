//! The agent chats of the sidebar (DECISIONS D40), kept in `userData/chats.json`
//! as `{"chats":[…]}`. A chat belongs to the folder its agent works in: an
//! agent's session can be continued only from there. No Tauri here.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use tokio::sync::Mutex;

use crate::agents::{AgentId, ChatEntry, Role};
use crate::js;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    pub id: String,
    pub agent: AgentId,
    pub folder: String,
    /// The start of the first message.
    pub title: String,
    /// The agent's own session, known after the first turn started.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// Milliseconds since the epoch, as JavaScript's `Date.now()`.
    pub created: i64,
    pub updated: i64,
    pub entries: Vec<ChatEntry>,
    /// What the user allowed Claude Code for the rest of the chat (D52): its
    /// rules, and directories outside the folder.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_tools: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub allowed_dirs: Vec<String>,
}

/// A chat in the list, without its entries.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSummary {
    pub id: String,
    pub agent: AgentId,
    pub folder: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub created: i64,
    pub updated: i64,
}

impl From<&Chat> for ChatSummary {
    fn from(chat: &Chat) -> ChatSummary {
        ChatSummary {
            id: chat.id.clone(),
            agent: chat.agent,
            folder: chat.folder.clone(),
            title: chat.title.clone(),
            session_id: chat.session_id.clone(),
            created: chat.created,
            updated: chat.updated,
        }
    }
}

/// The most chats kept; the oldest go first.
pub const MAX_CHATS: usize = 200;
const MAX_TITLE: usize = 60;

/// The first line of a message, cut at 60 UTF-16 units as the TypeScript's
/// `.length` counted them.
pub fn chat_title(text: &str) -> String {
    let line = js::one_line(text);
    if line.is_empty() {
        "New chat".to_owned()
    } else {
        js::ellipsis(line, MAX_TITLE)
    }
}

/// Now, in JavaScript's milliseconds.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

/// A JavaScript number as a timestamp; fractions are dropped.
fn timestamp(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_number()?;
    number
        .as_i64()
        .or_else(|| number.as_f64().map(|float| float as i64))
}

/// A chat as the TypeScript's `validChat` accepted it; `None` for anything else.
fn valid_chat(value: &Value) -> Option<Chat> {
    let chat = value.as_object()?;
    let text = |name: &str| chat.get(name).and_then(Value::as_str).map(str::to_owned);
    let session_id = match chat.get("sessionId") {
        None => None,
        Some(Value::String(id)) => Some(id.clone()),
        Some(_) => return None,
    };
    let entries = chat
        .get("entries")?
        .as_array()?
        .iter()
        .map(|entry| {
            let entry = entry.as_object()?;
            let role = Role::parse(entry.get("role")?.as_str()?)?;
            let images = match entry.get("images") {
                Some(Value::Array(images)) => images
                    .iter()
                    .filter_map(|image| image.as_str().map(str::to_owned))
                    .collect(),
                _ => Vec::new(),
            };
            Some(ChatEntry {
                role,
                text: entry.get("text")?.as_str()?.to_owned(),
                images,
            })
        })
        .collect::<Option<Vec<_>>>()?;
    let strings = |name: &str| -> Vec<String> {
        match chat.get(name) {
            Some(Value::Array(values)) => values
                .iter()
                .filter_map(|value| value.as_str().map(str::to_owned))
                .collect(),
            _ => Vec::new(),
        }
    };
    Some(Chat {
        id: text("id")?,
        agent: AgentId::parse(chat.get("agent")?.as_str()?)?,
        folder: text("folder")?,
        title: text("title")?,
        session_id,
        created: timestamp(chat.get("created"))?,
        updated: timestamp(chat.get("updated"))?,
        entries,
        allowed_tools: strings("allowedTools"),
        allowed_dirs: strings("allowedDirs"),
    })
}

/// The chats of a chats.json's text; none when it is missing or damaged.
fn parse_chats(text: &str) -> Vec<Chat> {
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    match value.get("chats").and_then(Value::as_array) {
        Some(chats) => chats.iter().filter_map(valid_chat).collect(),
        None => Vec::new(),
    }
}

struct Chats {
    loaded: bool,
    chats: Vec<Chat>,
}

struct Inner {
    file: PathBuf,
    state: Mutex<Chats>,
    /// Held while writing, so writes go one at a time.
    writing: Mutex<()>,
}

/// The chats in one JSON file, loaded on first use. Clones share the store.
#[derive(Clone)]
pub struct ChatStore {
    inner: Arc<Inner>,
}

impl ChatStore {
    pub fn new(file: impl Into<PathBuf>) -> ChatStore {
        ChatStore {
            inner: Arc::new(Inner {
                file: file.into(),
                state: Mutex::new(Chats {
                    loaded: false,
                    chats: Vec::new(),
                }),
                writing: Mutex::new(()),
            }),
        }
    }

    pub fn file(&self) -> &Path {
        &self.inner.file
    }

    /// The chats, loaded from the file the first time.
    async fn chats(&self) -> tokio::sync::MutexGuard<'_, Chats> {
        let mut state = self.inner.state.lock().await;
        if !state.loaded {
            // Missing or damaged: start again from nothing.
            state.chats = match tokio::fs::read_to_string(&self.inner.file).await {
                Ok(text) => parse_chats(&text),
                Err(_) => Vec::new(),
            };
            state.loaded = true;
        }
        state
    }

    /// The chats of `folder`, newest first.
    pub async fn list(&self, folder: &str) -> Vec<ChatSummary> {
        let state = self.chats().await;
        let mut chats: Vec<&Chat> = state
            .chats
            .iter()
            .filter(|chat| chat.folder == folder)
            .collect();
        chats.sort_by_key(|chat| std::cmp::Reverse(chat.updated));
        chats.into_iter().map(ChatSummary::from).collect()
    }

    pub async fn get(&self, id: &str) -> Option<Chat> {
        self.chats()
            .await
            .chats
            .iter()
            .find(|chat| chat.id == id)
            .cloned()
    }

    pub async fn create(&self, agent: AgentId, folder: &str, text: &str) -> Chat {
        self.create_at(agent, folder, text, now_ms()).await
    }

    pub async fn create_at(&self, agent: AgentId, folder: &str, text: &str, now: i64) -> Chat {
        let chat = Chat {
            id: uuid::Uuid::new_v4().to_string(),
            agent,
            folder: folder.to_owned(),
            title: chat_title(text),
            session_id: None,
            created: now,
            updated: now,
            entries: Vec::new(),
            allowed_tools: Vec::new(),
            allowed_dirs: Vec::new(),
        };
        {
            let mut state = self.chats().await;
            state.chats.push(chat.clone());
            if state.chats.len() > MAX_CHATS {
                state.chats.sort_by_key(|chat| chat.updated);
                let excess = state.chats.len() - MAX_CHATS;
                state.chats.drain(..excess);
            }
        }
        self.save().await;
        chat
    }

    pub async fn append(&self, id: &str, entry: ChatEntry) {
        self.append_at(id, entry, now_ms()).await;
    }

    pub async fn append_at(&self, id: &str, entry: ChatEntry, now: i64) {
        {
            let mut state = self.chats().await;
            let Some(chat) = state.chats.iter_mut().find(|chat| chat.id == id) else {
                return;
            };
            chat.entries.push(entry);
            chat.updated = now;
        }
        self.save().await;
    }

    pub async fn set_session(&self, id: &str, session_id: &str) {
        {
            let mut state = self.chats().await;
            let Some(chat) = state.chats.iter_mut().find(|chat| chat.id == id) else {
                return;
            };
            if chat.session_id.as_deref() == Some(session_id) {
                return;
            }
            chat.session_id = Some(session_id.to_owned());
        }
        self.save().await;
    }

    /// Adds `tools` and `dirs` to what the chat allows, each once.
    pub async fn allow(&self, id: &str, tools: &[String], dirs: &[String]) {
        {
            let mut state = self.chats().await;
            let Some(chat) = state.chats.iter_mut().find(|chat| chat.id == id) else {
                return;
            };
            for (list, new) in [
                (&mut chat.allowed_tools, tools),
                (&mut chat.allowed_dirs, dirs),
            ] {
                for item in new {
                    if !list.contains(item) {
                        list.push(item.clone());
                    }
                }
            }
        }
        self.save().await;
    }

    pub async fn delete(&self, id: &str) {
        self.chats().await.chats.retain(|chat| chat.id != id);
        self.save().await;
    }

    /// Writes one at a time, the newest state each time, through a temp file.
    /// A failure is reported on stderr and otherwise ignored, as before.
    async fn save(&self) {
        let _writing = self.inner.writing.lock().await;
        let text = {
            let state = self.inner.state.lock().await;
            let mut document = Map::new();
            document.insert(
                "chats".to_owned(),
                serde_json::to_value(&state.chats).unwrap_or(Value::Array(Vec::new())),
            );
            format!("{}\n", Value::Object(document))
        };
        if let Err(error) = self.write(&text).await {
            eprintln!("chats.json: {error}");
        }
    }

    async fn write(&self, text: &str) -> std::io::Result<()> {
        let file = &self.inner.file;
        if let Some(dir) = file.parent().filter(|dir| !dir.as_os_str().is_empty()) {
            tokio::fs::create_dir_all(dir).await?;
        }
        let mut temp = file.as_os_str().to_owned();
        temp.push(".tmp");
        tokio::fs::write(&temp, text).await?;
        tokio::fs::rename(&temp, file).await
    }
}
