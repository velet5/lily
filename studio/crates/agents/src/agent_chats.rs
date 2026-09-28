//! The agent chats behind the sidebar (DECISIONS D40): a message starts one
//! turn of the chat's agent in the chat's folder, and what the agent says and
//! does is kept in the chat and sent to the renderer as it happens. No Tauri
//! here; the app gives it the store, the agents' status and the window to
//! send to.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::mpsc;

use crate::agents::{
    AgentEvent, AgentId, AgentRun, AgentState, AgentStatus, BoxFuture, ChatEntry, Env, Permission,
    PromptContext, Role, RunOptions, Selection, TurnOptions, agent_args, agent_label,
    agent_out_dir, run_agent, spellings, turn_prompt,
};
use crate::chats::{Chat, ChatStore, ChatSummary};
use crate::js;

/// What the renderer sends with a message.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", try_from = "Value")]
pub struct ChatMessage {
    pub text: String,
    /// The chat to continue; a new one is started without it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
    /// The agent of a new chat.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentId>,
    /// The file in the editor, and the lines selected in it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<Selection>,
    /// What the agent may do in this turn; `Edit` when not given (D43).
    #[serde(default)]
    pub permission: Permission,
}

/// A JavaScript number that `Number.isInteger` accepts.
fn integer(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_number()?;
    number.as_i64().or_else(|| {
        let float = number.as_f64()?;
        (float.fract() == 0.0 && float.abs() < 9.2e18).then_some(float as i64)
    })
}

impl ChatMessage {
    /// A message from the renderer, checked field by field: an optional field
    /// that is not what it should be is left out, and only a missing text is
    /// an error.
    pub fn from_value(value: Value) -> Result<ChatMessage, String> {
        let empty = serde_json::Map::new();
        let message = value.as_object().unwrap_or(&empty);
        let optional = |name: &str| message.get(name).and_then(Value::as_str).map(str::to_owned);
        let text = optional("text").ok_or("Expected the text of a message.")?;
        let selection = message
            .get("selection")
            .and_then(Value::as_object)
            .and_then(|selection| {
                Some(Selection {
                    start_line: integer(selection.get("startLine"))?,
                    end_line: integer(selection.get("endLine"))?,
                    text: selection.get("text")?.as_str()?.to_owned(),
                })
            });
        Ok(ChatMessage {
            text,
            chat_id: optional("chatId"),
            agent: message
                .get("agent")
                .and_then(Value::as_str)
                .and_then(AgentId::parse),
            file: optional("file"),
            selection,
            permission: message
                .get("permission")
                .and_then(Value::as_str)
                .and_then(Permission::parse)
                .unwrap_or_default(),
        })
    }
}

impl TryFrom<Value> for ChatMessage {
    type Error = String;

    fn try_from(value: Value) -> Result<ChatMessage, String> {
        ChatMessage::from_value(value)
    }
}

/// What the renderer hears about a chat while a turn runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum ChatEvent {
    Entry { chat_id: String, entry: ChatEntry },
    Running { chat_id: String, running: bool },
}

/// A chat in the list, and whether its agent is working.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatInfo {
    #[serde(flatten)]
    pub chat: ChatSummary,
    pub running: bool,
}

/// An open chat, and whether its agent is working.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpenChat {
    #[serde(flatten)]
    pub chat: Chat,
    pub running: bool,
}

pub type EmitFn = Arc<dyn Fn(ChatEvent) + Send + Sync>;
pub type StatusFn = Arc<dyn Fn(AgentId) -> BoxFuture<AgentStatus> + Send + Sync>;
pub type LilypondFn = Arc<dyn Fn() -> BoxFuture<Option<String>> + Send + Sync>;
pub type EnvFn = Arc<dyn Fn() -> BoxFuture<Env> + Send + Sync>;

#[derive(Clone)]
pub struct AgentChatsOptions {
    pub store: ChatStore,
    pub emit: EmitFn,
    /// The agent's executable and model, as the setup found them.
    pub status: StatusFn,
    /// The LilyPond the agent should check its edits with.
    pub lilypond: LilypondFn,
    pub env: EnvFn,
}

impl AgentChatsOptions {
    /// The options from plain closures, boxed.
    pub fn new<E, S, SF, L, LF, V, VF>(
        store: ChatStore,
        emit: E,
        status: S,
        lilypond: L,
        env: V,
    ) -> AgentChatsOptions
    where
        E: Fn(ChatEvent) + Send + Sync + 'static,
        S: Fn(AgentId) -> SF + Send + Sync + 'static,
        SF: Future<Output = AgentStatus> + Send + 'static,
        L: Fn() -> LF + Send + Sync + 'static,
        LF: Future<Output = Option<String>> + Send + 'static,
        V: Fn() -> VF + Send + Sync + 'static,
        VF: Future<Output = Env> + Send + 'static,
    {
        AgentChatsOptions {
            store,
            emit: Arc::new(emit),
            status: Arc::new(move |agent| Box::pin(status(agent))),
            lilypond: Arc::new(move || Box::pin(lilypond())),
            env: Arc::new(move || Box::pin(env())),
        }
    }
}

/// A longer selection is cut; the agent can read the file itself.
const MAX_SELECTION: usize = 4_000;

struct Inner {
    options: AgentChatsOptions,
    runs: Mutex<HashMap<String, AgentRun>>,
}

/// The chats and their running turns. Clones share them.
#[derive(Clone)]
pub struct AgentChats {
    inner: Arc<Inner>,
}

impl AgentChats {
    pub fn new(options: AgentChatsOptions) -> AgentChats {
        AgentChats {
            inner: Arc::new(Inner {
                options,
                runs: Mutex::new(HashMap::new()),
            }),
        }
    }

    fn runs(&self) -> MutexGuard<'_, HashMap<String, AgentRun>> {
        // A panic elsewhere does not make the map wrong.
        self.inner
            .runs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn is_running(&self, chat_id: &str) -> bool {
        self.runs().contains_key(chat_id)
    }

    pub async fn list(&self, folder: &str) -> Vec<ChatInfo> {
        let chats = self.inner.options.store.list(folder).await;
        chats
            .into_iter()
            .map(|chat| {
                let running = self.is_running(&chat.id);
                ChatInfo { chat, running }
            })
            .collect()
    }

    /// The chat `chat_id` of `folder`; `None` for another folder's.
    pub async fn get(&self, chat_id: &str, folder: &str) -> Option<OpenChat> {
        let chat = self
            .inner
            .options
            .store
            .get(chat_id)
            .await
            .filter(|chat| chat.folder == folder)?;
        let running = self.is_running(&chat.id);
        Some(OpenChat { chat, running })
    }

    /// Sends `message` in `folder`; gives its chat's id once the turn has started.
    pub async fn send(&self, message: ChatMessage, folder: &str) -> Result<String, String> {
        let options = &self.inner.options;
        let store = &options.store;
        let text = js::trim(&message.text).to_owned();
        if text.is_empty() {
            return Err("Write a message first.".to_owned());
        }
        let chat = match &message.chat_id {
            Some(chat_id) => {
                let found = self
                    .get(chat_id, folder)
                    .await
                    .ok_or("This chat belongs to another folder.")?;
                if found.running {
                    return Err(format!(
                        "{} is still working on the last message.",
                        agent_label(found.chat.agent)
                    ));
                }
                found.chat
            }
            None => {
                let agent = message.agent.ok_or("Choose an agent first.")?;
                store.create(agent, folder, &text).await
            }
        };
        let chat_id = chat.id.clone();
        add(
            store,
            &options.emit,
            &chat_id,
            ChatEntry::new(Role::User, text.clone()),
        )
        .await;

        let status = (options.status)(chat.agent).await;
        let binary = match status.path.as_deref() {
            Some(path) if status.state == AgentState::Ready && !path.is_empty() => path.to_owned(),
            _ => {
                let text = format!("{} Open Agent setup below to set it up.", status.message);
                add(
                    store,
                    &options.emit,
                    &chat_id,
                    ChatEntry::new(Role::Error, text),
                )
                .await;
                return Ok(chat_id);
            }
        };
        let lilypond = (options.lilypond)()
            .await
            .filter(|lilypond| !lilypond.is_empty());
        tokio::fs::create_dir_all(agent_out_dir())
            .await
            .map_err(|error| error.to_string())?;
        let file = message
            .file
            .filter(|file| !file.is_empty() && js::is_inside(folder, file));
        let selection = file
            .as_ref()
            .and(message.selection)
            .map(|selection| Selection {
                text: js::prefix(&selection.text, MAX_SELECTION).to_owned(),
                ..selection
            });
        let prompt = turn_prompt(
            &text,
            &PromptContext {
                folder: folder.to_owned(),
                file,
                selection,
                lilypond: lilypond.clone(),
                first: chat.session_id.is_none(),
                read_only: message.permission == Permission::Read,
            },
        );
        let args = agent_args(
            chat.agent,
            &TurnOptions {
                prompt,
                session_id: chat.session_id.clone(),
                model: status.model.clone(),
                lilypond,
                permission: message.permission,
            },
        );
        // Entries are kept in the order they came, each after the one before:
        // the run hands its events to one task that keeps and sends them.
        let (events, mut received) = mpsc::unbounded_channel::<AgentEvent>();
        let run = run_agent(RunOptions {
            id: chat.agent,
            binary,
            args,
            cwd: folder.to_owned(),
            roots: Some(spellings(folder).await),
            env: (options.env)().await,
            on_event: Box::new(move |event| {
                let _ = events.send(event);
            }),
        });
        self.runs().insert(chat_id.clone(), run.clone());
        (options.emit)(ChatEvent::Running {
            chat_id: chat_id.clone(),
            running: true,
        });
        let chats = self.clone();
        let id = chat_id.clone();
        tokio::spawn(async move {
            let options = &chats.inner.options;
            // The channel closes when the run is over and has delivered everything.
            while let Some(event) = received.recv().await {
                match event {
                    AgentEvent::Session(session) => options.store.set_session(&id, &session).await,
                    AgentEvent::Entry(entry) => {
                        add(&options.store, &options.emit, &id, entry).await
                    }
                    AgentEvent::Done { .. } => {}
                }
            }
            run.done().await;
            {
                let mut runs = chats.runs();
                if runs.get(&id).is_some_and(|current| current.same(&run)) {
                    runs.remove(&id);
                }
            }
            (options.emit)(ChatEvent::Running {
                chat_id: id,
                running: false,
            });
        });
        Ok(chat_id)
    }

    pub fn stop(&self, chat_id: &str) {
        let run = self.runs().get(chat_id).cloned();
        if let Some(run) = run {
            run.stop();
        }
    }

    /// Waits for the turn of `chat_id`, if one is running (tests).
    pub async fn settled(&self, chat_id: &str) {
        let Some(run) = self.runs().get(chat_id).cloned() else {
            return;
        };
        run.done().await;
        while self.is_running(chat_id) {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    pub async fn delete(&self, chat_id: &str, folder: &str) {
        if self.get(chat_id, folder).await.is_none() {
            return;
        }
        self.stop(chat_id);
        self.inner.options.store.delete(chat_id).await;
    }

    /// Stops every running turn.
    pub fn dispose(&self) {
        let runs: Vec<AgentRun> = self.runs().values().cloned().collect();
        for run in runs {
            run.stop();
        }
    }
}

/// Keeps `entry` in the chat, then tells the renderer.
async fn add(store: &ChatStore, emit: &EmitFn, chat_id: &str, entry: ChatEntry) {
    store.append(chat_id, entry.clone()).await;
    emit(ChatEvent::Entry {
        chat_id: chat_id.to_owned(),
        entry,
    });
}
