//! What the studio's commands share (DECISIONS D42): the open folder and what
//! the page may touch (D29), the settings (D37), the compiler with live
//! preview (D31, D36), the watch on the files behind them (D34), the agent
//! chats (D40), and the channel everything the Rust side starts itself goes
//! to the page on.
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use futures::FutureExt;
use lily_agents::{
    AgentChats, AgentChatsOptions, AgentId, AgentStatus, ChatEvent, ChatStore, DetectAgentOptions,
};
use lily_engrave::setup::{self, AgentSettings, DetectOptions};
use lily_engrave::{
    Acceleration, Access, CompileEvent, CompileOutcome, CompileService, CompileServiceOptions,
    CompileState, FileChange, LilyPondStatus, LiveCompile, LiveOptions, LiveTexts, ScoreWatcher,
    SearchPath, Settings, StudioCompiler, StudioCompilerOptions,
};
use serde::Serialize;
use tauri::ipc::Channel;

use crate::smoke::SmokeFolder;

/// What the page hears without asking, as src/renderer/bridge.ts reads it.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum StudioEvent {
    /// A menu item, or the close guard, asks for a renderer command.
    Command { command: String },
    /// A compile started or finished (D31).
    Compile { event: CompileEvent },
    /// Files changed on disk by another program (D34).
    FilesChanged { changes: Vec<FileChange> },
    /// A chat got an entry, or its agent started or stopped (D40).
    Chat { event: ChatEvent },
}

/// The last finished outcomes kept, so switching back to a score shows it at once (D39).
const KEPT_OUTCOMES: usize = 8;

pub struct Studio {
    pub access: Mutex<Access>,
    pub settings: Mutex<Settings>,
    pub settings_file: PathBuf,
    /// Where the sample goes: Documents › Lily Studio (D37).
    pub documents: PathBuf,
    /// The PATH every lilypond and agent runs with; never the process's own.
    pub search_path: SearchPath,
    pub compiler: StudioCompiler,
    /// Unsaved edits compile after a pause in typing, while the status line's switch is on (D36).
    pub live: LiveCompile,
    /// Another program changed a file: the page reloads it, and the score compiles again (D34).
    pub watcher: ScoreWatcher,
    pub chats: AgentChats,
    /// The last finished outcome of each score, newest last (D39).
    outcomes: Mutex<VecDeque<CompileOutcome>>,
    /// The LilyPond found last; agents check their edits with it (D40).
    pub lilypond_binary: Mutex<Option<String>>,
    /// The last compile found no LilyPond; the setup compiles again once it is ready (D37).
    pub waiting_for_lilypond: AtomicBool,
    /// Whether the page reports unsaved changes; guards closing the window.
    pub dirty: AtomicBool,
    channel: Mutex<Option<Channel<StudioEvent>>>,
    pub smoke: Option<SmokeFolder>,
}

pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub struct Paths {
    /// Where settings.json and chats.json are kept.
    pub data: PathBuf,
    pub documents: PathBuf,
    /// runtime/ from the extension, bundled as a resource.
    pub runtime: PathBuf,
}

impl Studio {
    /// Builds the studio. Its parts call each other back, so they reach it
    /// through a cell that is filled once everything exists.
    pub async fn new(paths: Paths, smoke: Option<SmokeFolder>) -> Arc<Studio> {
        let cell: Arc<OnceLock<Arc<Studio>>> = Arc::new(OnceLock::new());
        let settings_file = paths.data.join("settings.json");
        let mut settings = setup::read_settings(&settings_file).await;
        if let Some(smoke) = &smoke {
            // A stand-in for Claude Code that answers and edits without a network (D40).
            let claude = AgentSettings {
                path: Some(smoke.agent.to_string_lossy().into_owned()),
                model: None,
            };
            settings.agents = Some(setup::AgentsSettings {
                claude: Some(claude),
                codex: None,
            });
        }
        // An app opened from the Finder has a bare PATH; lilypond's own helpers (gs) need more.
        let search_path = SearchPath::new(setup::search_path(
            std::env::var("PATH").ok().as_deref(),
            None,
        ));

        let service = CompileService::new(CompileServiceOptions {
            tmp_root: None,
            runtime_dir: Some(paths.runtime),
            search_path: search_path.clone(),
        });
        let texts = LiveTexts::new(true);
        let mut options = StudioCompilerOptions::new(
            Arc::new(service),
            {
                let cell = cell.clone();
                move || {
                    let folder = cell
                        .get()
                        .and_then(|studio| lock(&studio.access).folder.clone());
                    async move {
                        match folder {
                            Some(folder) => lily_engrave::files::list_folder(&folder)
                                .await
                                .files
                                .into_iter()
                                .map(|f| f.path)
                                .collect(),
                            None => Vec::new(),
                        }
                    }
                    .boxed()
                }
            },
            {
                let cell = cell.clone();
                move |event| {
                    if let Some(studio) = cell.get() {
                        studio.compiled(event);
                    }
                }
            },
        );
        options.buffers = Some(texts.reader());
        options.acceleration = Acceleration::Auto;
        options.lilypond_path = Some({
            let cell = cell.clone();
            Arc::new(move || cell.get().and_then(|studio| studio.lilypond_path()))
        });
        let compiler = StudioCompiler::new(options);
        let live = LiveCompile::new(Arc::new(compiler.clone()), texts, LiveOptions::default());

        let watcher = ScoreWatcher::new({
            let cell = cell.clone();
            move |changes, score| {
                if let Some(studio) = cell.get() {
                    studio.changed_on_disk(changes, score);
                }
            }
        });

        let chats = AgentChats::new(AgentChatsOptions::new(
            ChatStore::new(paths.data.join("chats.json")),
            {
                let cell = cell.clone();
                move |event| {
                    if let Some(studio) = cell.get() {
                        studio.send(StudioEvent::Chat { event });
                    }
                }
            },
            {
                let cell = cell.clone();
                move |agent| {
                    let studio = cell.get().cloned();
                    async move {
                        match studio {
                            Some(studio) => studio.detect_agent(agent).await,
                            None => {
                                lily_agents::detect_agent(agent, DetectAgentOptions::default())
                                    .await
                            }
                        }
                    }
                }
            },
            {
                let cell = cell.clone();
                move || {
                    let studio = cell.get().cloned();
                    async move {
                        let studio = studio?;
                        let known = lock(&studio.lilypond_binary).clone();
                        match known {
                            Some(binary) => Some(binary),
                            None => studio
                                .lilypond_status()
                                .await
                                .path
                                .map(|p| p.to_string_lossy().into_owned()),
                        }
                    }
                }
            },
            {
                let cell = cell.clone();
                move || {
                    let studio = cell.get().cloned();
                    async move {
                        let path = match &studio {
                            Some(studio) => studio.agent_search_path().await,
                            None => String::new(),
                        };
                        lily_agents::agent_env(&path, &lily_agents::process_env())
                    }
                }
            },
        ));

        let mut access = Access::new();
        if let Some(smoke) = &smoke {
            access.folder = Some(smoke.folder.clone());
        }
        let studio = Arc::new(Studio {
            access: Mutex::new(access),
            settings: Mutex::new(settings),
            settings_file,
            documents: paths.documents,
            search_path,
            compiler,
            live,
            watcher,
            chats,
            outcomes: Mutex::new(VecDeque::new()),
            lilypond_binary: Mutex::new(None),
            waiting_for_lilypond: AtomicBool::new(false),
            dirty: AtomicBool::new(false),
            channel: Mutex::new(None),
            smoke,
        });
        let _ = cell.set(studio.clone());
        studio
    }

    /// The page's channel; everything sent before it subscribed is dropped.
    pub fn subscribe(&self, channel: Channel<StudioEvent>) {
        *lock(&self.channel) = Some(channel);
    }

    pub fn send(&self, event: StudioEvent) {
        if let Some(channel) = lock(&self.channel).as_ref()
            && let Err(error) = channel.send(event)
        {
            eprintln!("studio channel: {error}");
        }
    }

    fn compiled(self: &Arc<Self>, event: CompileEvent) {
        if let CompileEvent::Finished { outcome } = &event {
            if outcome.state != CompileState::NoRoot {
                let mut outcomes = lock(&self.outcomes);
                outcomes.retain(|kept| kept.root_file != outcome.root_file);
                outcomes.push_back((**outcome).clone());
                while outcomes.len() > KEPT_OUTCOMES {
                    outcomes.pop_front();
                }
                drop(outcomes);
                // A compile may have added or removed an include: watch the score as it is now.
                let watcher = self.watcher.clone();
                let root = outcome.root_file.clone();
                tauri::async_runtime::spawn(async move { watcher.watch_score(&root).await });
            }
            self.waiting_for_lilypond
                .store(outcome.state == CompileState::NoLilypond, Ordering::SeqCst);
        }
        self.send(StudioEvent::Compile { event });
    }

    /// The last finished outcome of `root`, if one is kept.
    pub fn kept(&self, root: &Path) -> Option<CompileOutcome> {
        lock(&self.outcomes)
            .iter()
            .find(|kept| kept.root_file == root)
            .cloned()
    }

    fn changed_on_disk(self: &Arc<Self>, changes: Vec<FileChange>, score: bool) {
        // Only files the page may open; an include outside the folder just recompiles.
        let visible: Vec<FileChange> = {
            let access = lock(&self.access);
            changes
                .into_iter()
                .filter(|change| access.allows(&change.file))
                .collect()
        };
        if !visible.is_empty() {
            self.send(StudioEvent::FilesChanged { changes: visible });
        }
        if score && let Some(root) = self.watcher.score() {
            drop(self.compiler.compile(&root));
        }
    }

    /// The chosen LilyPond, or `$LILYPOND_PATH`.
    pub fn lilypond_path(&self) -> Option<String> {
        lock(&self.settings)
            .lilypond_path
            .clone()
            .or_else(|| std::env::var("LILYPOND_PATH").ok())
    }

    /// Looks for LilyPond as a compile would, and applies what it found.
    pub async fn lilypond_status(self: &Arc<Self>) -> LilyPondStatus {
        let status = setup::detect_lilypond(DetectOptions {
            configured_path: self.lilypond_path(),
            path: self.search_path.get(),
            ..DetectOptions::default()
        })
        .await;
        self.found(status)
    }

    /// Puts the found lilypond's directory on the search path, and compiles
    /// again the score that found none. The compile reads the settings, so a
    /// choice is saved first.
    pub fn found(self: &Arc<Self>, status: LilyPondStatus) -> LilyPondStatus {
        if let Some(dir) = status.path.as_deref().and_then(Path::parent) {
            let current = self.search_path.get();
            self.search_path
                .set(setup::search_path(Some(&current), dir.to_str()));
        }
        let ready = status.state == setup::LilyPondState::Ready;
        *lock(&self.lilypond_binary) = if ready {
            status
                .path
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned())
        } else {
            None
        };
        if ready
            && self.waiting_for_lilypond.load(Ordering::SeqCst)
            && let Some(current) = self.compiler.current()
        {
            drop(self.compiler.compile(&current));
        }
        status
    }

    /// The PATH the agents run with, from the login shell (D40).
    pub async fn agent_search_path(&self) -> String {
        let login = lily_agents::login_shell_path().await;
        lily_agents::agent_path(&login, Some(&self.search_path.get()), None)
    }

    pub fn agent_settings(&self, agent: AgentId) -> AgentSettings {
        let settings = lock(&self.settings);
        let agents = settings.agents.as_ref();
        match agent {
            AgentId::Claude => agents.and_then(|a| a.claude.clone()),
            AgentId::Codex => agents.and_then(|a| a.codex.clone()),
        }
        .unwrap_or_default()
    }

    /// Changes one agent's settings and saves them all.
    pub async fn set_agent_settings(
        &self,
        agent: AgentId,
        change: impl FnOnce(&mut AgentSettings),
    ) -> Result<(), String> {
        let settings = {
            let mut settings = lock(&self.settings);
            let agents = settings.agents.get_or_insert_with(Default::default);
            let slot = match agent {
                AgentId::Claude => &mut agents.claude,
                AgentId::Codex => &mut agents.codex,
            };
            let mut value = slot.take().unwrap_or_default();
            change(&mut value);
            *slot = (value.path.is_some() || value.model.is_some()).then_some(value);
            settings.clone()
        };
        self.save_settings(&settings).await
    }

    pub async fn save_settings(&self, settings: &Settings) -> Result<(), String> {
        setup::write_settings(&self.settings_file, settings)
            .await
            .map_err(|error| error.to_string())
    }

    pub async fn detect_agent(&self, agent: AgentId) -> AgentStatus {
        let AgentSettings { path, model } = self.agent_settings(agent);
        lily_agents::detect_agent(
            agent,
            DetectAgentOptions {
                configured_path: path,
                model,
                path_value: self.agent_search_path().await,
                ..Default::default()
            },
        )
        .await
    }

    /// Stops lilypond and the agents, and deletes the pages in the temp directory.
    pub async fn dispose(&self) {
        self.watcher.dispose();
        self.live.dispose();
        self.chats.dispose();
        self.compiler.dispose().await;
    }
}
